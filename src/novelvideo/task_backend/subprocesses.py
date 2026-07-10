"""Killable subprocess helpers for inline project task runners."""

from __future__ import annotations

import asyncio
import contextlib
import contextvars
import os
import signal
import subprocess
import threading
import time
from collections.abc import Iterator, Sequence
from typing import Any

from novelvideo.task_backend.cancel import TaskCancelled, TaskTimedOut, is_cancel_requested

_TASK_PROCESS_SCOPE: contextvars.ContextVar[dict[str, Any] | None] = contextvars.ContextVar(
    "project_task_subprocess_scope",
    default=None,
)
_REGISTRY_LOCK = threading.Lock()
_PROCESSES_BY_TASK: dict[str, set[subprocess.Popen]] = {}
_CANCEL_KILLED_PROCS: set[int] = set()


@contextlib.contextmanager
def project_task_subprocess_context(
    *,
    project_id: str,
    task_type: str,
    episode: int,
    task_id: str,
    beat_num: int | None = None,
    scope: str | None = None,
    deadline_monotonic: float | None = None,
    timeout_seconds: int | None = None,
) -> Iterator[None]:
    token = _TASK_PROCESS_SCOPE.set(
        {
            "project_id": project_id,
            "task_type": task_type,
            "episode": episode,
            "task_id": task_id,
            "beat_num": beat_num,
            "scope": scope,
            "deadline_monotonic": deadline_monotonic,
            "timeout_seconds": timeout_seconds,
        }
    )
    try:
        yield
    finally:
        _TASK_PROCESS_SCOPE.reset(token)


def active_subprocess_count(task_id: str | None = None) -> int:
    with _REGISTRY_LOCK:
        if task_id is not None:
            return sum(1 for proc in _PROCESSES_BY_TASK.get(task_id, set()) if proc.poll() is None)
        return sum(
            1
            for processes in _PROCESSES_BY_TASK.values()
            for proc in processes
            if proc.poll() is None
        )


def _register_process(task_id: str, proc: subprocess.Popen) -> None:
    if not task_id:
        return
    with _REGISTRY_LOCK:
        _PROCESSES_BY_TASK.setdefault(task_id, set()).add(proc)


def _unregister_process(task_id: str, proc: subprocess.Popen) -> None:
    if not task_id:
        return
    with _REGISTRY_LOCK:
        processes = _PROCESSES_BY_TASK.get(task_id)
        if not processes:
            return
        processes.discard(proc)
        if not processes:
            _PROCESSES_BY_TASK.pop(task_id, None)
        _CANCEL_KILLED_PROCS.discard(id(proc))


def _mark_cancel_killed(proc: subprocess.Popen) -> None:
    with _REGISTRY_LOCK:
        _CANCEL_KILLED_PROCS.add(id(proc))


def _consume_cancel_killed(proc: subprocess.Popen) -> bool:
    with _REGISTRY_LOCK:
        proc_id = id(proc)
        if proc_id not in _CANCEL_KILLED_PROCS:
            return False
        _CANCEL_KILLED_PROCS.discard(proc_id)
        return True


def _kill_process_group(proc: subprocess.Popen) -> None:
    if proc.poll() is not None:
        return
    if os.name == "nt":
        # Windows 没有 killpg;taskkill /T 按父子关系终止整棵进程树,
        # 对齐 POSIX 进程组语义(cancel/deadline 必须连孙进程一起杀)。
        with contextlib.suppress(Exception):
            subprocess.run(
                ["taskkill", "/PID", str(proc.pid), "/T", "/F"],
                capture_output=True,
                check=False,
                timeout=15,
            )
        if proc.poll() is None:
            with contextlib.suppress(Exception):
                proc.kill()
        return
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except ProcessLookupError:
        return
    except Exception:
        with contextlib.suppress(Exception):
            proc.kill()


def kill_task_processes(task_id: str) -> int:
    with _REGISTRY_LOCK:
        processes = list(_PROCESSES_BY_TASK.get(task_id, set()))
    killed = 0
    for proc in processes:
        if proc.poll() is None:
            _mark_cancel_killed(proc)
            _kill_process_group(proc)
            killed += 1
    return killed


def _scope_from_envelope(envelope: dict[str, Any] | None) -> dict[str, Any]:
    if envelope is None:
        return dict(_TASK_PROCESS_SCOPE.get() or {})
    payload = envelope.get("payload") or {}
    return {
        "project_id": str(envelope.get("project_id") or ""),
        "task_type": str(envelope.get("task_type") or ""),
        "episode": int(envelope.get("episode") or payload.get("episode") or 0),
        "task_id": str(envelope.get("__run_task_id") or ""),
        "beat_num": envelope.get("beat_num"),
        "scope": envelope.get("scope") or None,
        "deadline_monotonic": envelope.get("__deadline_monotonic"),
        "timeout_seconds": envelope.get("__timeout_seconds"),
    }


def _optional_float(value: Any) -> float | None:
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _optional_int(value: Any) -> int | None:
    if value is None or value == "":
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _cancel_requested_sync(scope: dict[str, Any]) -> bool:
    task_id = str(scope.get("task_id") or "")
    if not task_id:
        return False
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        try:
            return bool(
                asyncio.run(
                    is_cancel_requested(
                        project_id=str(scope.get("project_id") or ""),
                        task_type=str(scope.get("task_type") or ""),
                        episode=int(scope.get("episode") or 0),
                        task_id=task_id,
                        beat_num=scope.get("beat_num"),
                        scope=scope.get("scope"),
                    )
                )
            )
        except Exception:
            return False
    return False


def _deadline_for(scope: dict[str, Any], timeout: int | float | None) -> float | None:
    deadlines: list[float] = []
    scope_deadline = _optional_float(scope.get("deadline_monotonic"))
    if scope_deadline is not None:
        deadlines.append(scope_deadline)
    if timeout is not None:
        deadlines.append(time.monotonic() + max(float(timeout), 0.001))
    if not deadlines:
        return None
    return min(deadlines)


def run_project_subprocess(
    args: Sequence[str],
    *,
    envelope: dict[str, Any] | None = None,
    timeout: int | float | None = None,
    capture_output: bool = False,
    text: bool = False,
    check: bool = False,
    cwd: str | os.PathLike[str] | None = None,
    env: dict[str, str] | None = None,
    poll_seconds: float = 0.1,
) -> subprocess.CompletedProcess:
    """Run a subprocess in its own process group and kill it on cancel/deadline."""
    scope = _scope_from_envelope(envelope)
    task_id = str(scope.get("task_id") or "")
    deadline = _deadline_for(scope, timeout)
    timeout_seconds = _optional_int(scope.get("timeout_seconds"))

    stdout = subprocess.PIPE if capture_output else None
    stderr = subprocess.PIPE if capture_output else None
    proc = subprocess.Popen(
        list(args),
        cwd=cwd,
        env=env,
        stdout=stdout,
        stderr=stderr,
        text=text,
        start_new_session=True,
    )
    _register_process(task_id, proc)
    try:
        while True:
            remaining = None if deadline is None else deadline - time.monotonic()
            if remaining is not None and remaining <= 0:
                _kill_process_group(proc)
                with contextlib.suppress(Exception):
                    proc.communicate(timeout=1)
                raise TaskTimedOut(timeout_seconds=timeout_seconds or int(timeout or 30 * 60))
            if _cancel_requested_sync(scope):
                _kill_process_group(proc)
                with contextlib.suppress(Exception):
                    proc.communicate(timeout=1)
                raise TaskCancelled()
            wait_for = poll_seconds if remaining is None else min(poll_seconds, max(remaining, 0.001))
            try:
                out, err = proc.communicate(timeout=wait_for)
                completed = subprocess.CompletedProcess(list(args), proc.returncode, out, err)
                if _consume_cancel_killed(proc):
                    raise TaskCancelled()
                if deadline is not None and time.monotonic() >= deadline:
                    raise TaskTimedOut(timeout_seconds=timeout_seconds or int(timeout or 30 * 60))
                if check and completed.returncode != 0:
                    raise subprocess.CalledProcessError(
                        completed.returncode,
                        completed.args,
                        output=completed.stdout,
                        stderr=completed.stderr,
                    )
                return completed
            except subprocess.TimeoutExpired:
                continue
    finally:
        _unregister_process(task_id, proc)
