# SPDX-License-Identifier: Elastic-2.0
# Copyright (c) 2026 ClaymoreLab
"""Bounded, synchronous pool of isolated canvas computation workers."""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path
import selectors
import shutil
import subprocess
import threading
import time
from typing import Any
import uuid

from novelvideo.freezone.agent_canvas_metrics import count, observe
from novelvideo.task_backend.subprocesses import (
    RestrictedSubprocessPolicy,
    _has_network_argument,
)

logger = logging.getLogger(__name__)


class CanvasCoreError(RuntimeError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


class _WorkerError(CanvasCoreError):
    """A valid worker response; the process remains usable."""


def _log_failure(op: str, error: CanvasCoreError) -> None:
    level = logging.WARNING if error.code == "invalid_request" else logging.ERROR
    logger.log(level, "canvas_core op=%s failed: %s: %s", op, error.code, error)


class _Child:
    def __init__(self, process: subprocess.Popen):
        self.process = process
        self.calls = 0

    def close(self) -> None:
        process = self.process
        if process.poll() is None:
            try:
                process.kill()
            except ProcessLookupError:
                pass
        process.wait()
        for stream in (process.stdin, process.stdout):
            if stream is not None:
                stream.close()


def _drain_stderr(process: subprocess.Popen) -> None:
    assert process.stderr is not None
    with process.stderr:
        while line := process.stderr.readline(2048):
            logger.warning(
                "canvas_core stderr: %s", line.decode("utf-8", errors="replace").rstrip()
            )
            while line and not line.endswith(b"\n"):
                line = process.stderr.readline(2048)


class CanvasCorePool:
    def __init__(
        self,
        bundle_path: str | Path,
        *,
        size: int = 2,
        call_timeout_seconds: float = 15,
        max_old_space_mb: int = 512,
        max_calls_per_child: int = 500,
    ):
        if min(size, call_timeout_seconds, max_old_space_mb, max_calls_per_child) <= 0:
            raise ValueError("canvas core pool limits must be positive")
        self.bundle_path = Path(bundle_path).resolve()
        self.size = size
        self.call_timeout_seconds = call_timeout_seconds
        self.max_old_space_mb = max_old_space_mb
        self.max_calls_per_child = max_calls_per_child
        self._condition = threading.Condition()
        self._idle: list[_Child] = []
        self._children: set[_Child] = set()
        self._total = 0
        self._closed = False

    def spawn_spec(self) -> tuple[list[str], Path, dict[str, str]]:
        node = shutil.which("node")
        if node is None or not self.bundle_path.is_file():
            raise CanvasCoreError(
                "canvas_core_unavailable", "Node or canvas core bundle unavailable"
            )
        command = [
            node,
            "--permission",
            f"--allow-fs-read={self.bundle_path}",
            "--no-experimental-fetch",
            "--no-experimental-websocket",
            f"--max-old-space-size={self.max_old_space_mb}",
            str(self.bundle_path),
        ]
        policy = RestrictedSubprocessPolicy(tuple(command), self.bundle_path.parent, {})
        assert not _has_network_argument(policy.command)
        return list(policy.command), policy.cwd, dict(policy.env)

    def _spawn(self) -> _Child:
        command, cwd, env = self.spawn_spec()
        try:
            process = subprocess.Popen(
                command,
                cwd=cwd,
                env=env,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                bufsize=0,
            )
        except OSError as exc:
            raise CanvasCoreError("canvas_core_unavailable", "Cannot launch canvas core") from exc
        threading.Thread(target=_drain_stderr, args=(process,), daemon=True).start()
        return _Child(process)

    def _acquire(self, timeout_seconds: float) -> _Child:
        deadline = time.monotonic() + timeout_seconds
        with self._condition:
            while True:
                if self._closed:
                    raise CanvasCoreError("canvas_core_unavailable", "Canvas core pool is closed")
                if self._idle:
                    return self._idle.pop()
                if self._total < self.size:
                    self._total += 1
                    break
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise CanvasCoreError("canvas_core_busy", "Canvas core pool is busy")
                self._condition.wait(remaining)
        try:
            child = self._spawn()
        except BaseException:
            with self._condition:
                self._total -= 1
                self._condition.notify_all()
            raise
        with self._condition:
            closed = self._closed
            if not closed:
                self._children.add(child)
        if closed:
            child.close()
            with self._condition:
                self._total -= 1
                self._condition.notify_all()
            raise CanvasCoreError("canvas_core_unavailable", "Canvas core pool is closed")
        return child

    def _release(self, child: _Child, *, discard: bool) -> None:
        with self._condition:
            discard = discard or self._closed
            if not discard:
                self._idle.append(child)
                self._condition.notify_all()
                return
        # Retiring a process must not hold the pool mutex.
        child.close()
        with self._condition:
            self._children.discard(child)
            self._total -= 1
            self._condition.notify_all()

    def _exchange(self, child: _Child, op: str, payload: dict, timeout_seconds: float) -> Any:
        process = child.process
        assert process.stdin is not None and process.stdout is not None
        request_id = str(uuid.uuid4())
        request = (json.dumps({"id": request_id, "op": op, "payload": payload}) + "\n").encode()
        deadline = time.monotonic() + timeout_seconds
        write_fd, read_fd = process.stdin.fileno(), process.stdout.fileno()
        os.set_blocking(write_fd, False)
        os.set_blocking(read_fd, False)
        response = bytearray()
        with selectors.DefaultSelector() as selector:
            selector.register(write_fd, selectors.EVENT_WRITE)
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0 or not selector.select(remaining):
                    raise CanvasCoreError("canvas_core_timeout", "Canvas core call timed out")
                if request:
                    sent = os.write(write_fd, request)
                    request = request[sent:]
                    if not request:
                        selector.unregister(write_fd)
                        selector.register(read_fd, selectors.EVENT_READ)
                else:
                    chunk = os.read(read_fd, 65536)
                    if not chunk:
                        raise CanvasCoreError("canvas_core_crashed", "Canvas core exited")
                    response.extend(chunk)
                    if b"\n" in chunk:
                        break
        try:
            message = json.loads(response)
            if not isinstance(message, dict) or message.get("id") != request_id:
                raise ValueError("response id mismatch")
            if message.get("ok") is True and "result" in message:
                return message["result"]
            error = message.get("error")
            if (
                message.get("ok") is not False
                or not isinstance(error, dict)
                or not isinstance(error.get("code"), str)
                or not isinstance(error.get("message"), str)
            ):
                raise ValueError("invalid response")
        except (ValueError, UnicodeError) as exc:
            raise CanvasCoreError("canvas_core_protocol", "Invalid canvas core response") from exc
        raise _WorkerError(error["code"], error["message"])

    def call(self, op: str, payload: dict) -> dict:
        return self._call(op, payload, any_result=False)

    def call_value(self, op: str, payload: dict) -> Any:
        """Like ``call``, but the worker result may be any JSON value (null, bool, ...)."""
        return self._call(op, payload, any_result=True)

    def _call(self, op: str, payload: dict, *, any_result: bool) -> Any:
        started = time.monotonic()
        timeout_seconds = self.call_timeout_seconds
        child = None
        discard = True
        try:
            child = self._acquire(timeout_seconds)
            try:
                result = self._exchange(child, op, payload, timeout_seconds)
            except _WorkerError:
                child.calls += 1
                discard = child.calls >= self.max_calls_per_child
                raise
            except (OSError, ValueError) as exc:
                raise CanvasCoreError("canvas_core_crashed", "Canvas core pipe closed") from exc
            if not any_result and not isinstance(result, dict):
                raise CanvasCoreError("canvas_core_protocol", "Invalid canvas core response")
            child.calls += 1
            discard = child.calls >= self.max_calls_per_child
            return result
        except CanvasCoreError as exc:
            count(f"canvas_core.{op}.error.{exc.code}")
            _log_failure(op, exc)
            raise
        finally:
            if child is not None:
                self._release(child, discard=discard)
            observe(f"canvas_core.{op}.ms", (time.monotonic() - started) * 1000)

    def warm(self) -> None:
        children = []
        try:
            for _ in range(self.size):
                child = self._acquire(self.call_timeout_seconds)
                children.append(child)
                try:
                    self._exchange(child, "ping", {}, self.call_timeout_seconds)
                except (OSError, ValueError) as exc:
                    raise CanvasCoreError("canvas_core_crashed", "Canvas core pipe closed") from exc
                child.calls += 1
        except BaseException as exc:
            if isinstance(exc, CanvasCoreError):
                _log_failure("ping", exc)
            for child in children:
                self._release(child, discard=True)
            raise
        else:
            for child in children:
                self._release(child, discard=child.calls >= self.max_calls_per_child)

    def close(self) -> None:
        with self._condition:
            self._closed = True
            children = list(self._children)
            self._condition.notify_all()
        # Kill active workers to wake callers; each owner closes its own pipes.
        for child in children:
            try:
                child.process.kill()
            except ProcessLookupError:
                pass
        with self._condition:
            idle, self._idle = self._idle, []
        for child in idle:
            self._release(child, discard=True)


_pool: CanvasCorePool | None = None
_pool_lock = threading.Lock()


def get_canvas_core_pool() -> CanvasCorePool:
    global _pool
    with _pool_lock:
        if _pool is None or _pool._closed:
            default = Path(__file__).resolve().parents[3] / (
                "frontend/dist-canvas-server/canvas-core-worker.mjs"
            )
            _pool = CanvasCorePool(os.environ.get("DRAMACLAW_CANVAS_CORE_BUNDLE", str(default)))
        return _pool
