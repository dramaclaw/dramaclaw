"""Persisted, bounded knowledge-graph previews.

The API must not open the embedded Cognee/Ladybug database merely to render the
ingest page.  Import workers materialize this sidecar after a successful graph
build; legacy projects materialize it once on first access.
"""

from __future__ import annotations

import asyncio
import errno
import json
import os
import uuid
from pathlib import Path
from typing import Any, IO

try:
    import fcntl
except ImportError:  # pragma: no cover - production images are Linux
    fcntl = None


GRAPH_PREVIEW_FILENAME = "graph-preview.json"
GRAPH_PREVIEW_SCHEMA_VERSION = 1


def graph_preview_path(state_dir: str | Path) -> Path:
    return Path(state_dir) / GRAPH_PREVIEW_FILENAME


def graph_preview_lock_path(state_dir: str | Path) -> Path:
    return graph_preview_path(state_dir).with_suffix(".json.lock")


def empty_graph_preview() -> dict[str, Any]:
    return {
        "schema_version": GRAPH_PREVIEW_SCHEMA_VERSION,
        "nodes": [],
        "edges": [],
        "total_nodes": 0,
        "total_edges": 0,
        "truncated": False,
    }


def load_graph_preview(state_dir: str | Path) -> dict[str, Any] | None:
    path = graph_preview_path(state_dir)
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, OSError, json.JSONDecodeError):
        return None
    if not isinstance(payload, dict):
        return None
    if not isinstance(payload.get("nodes"), list) or not isinstance(
        payload.get("edges"), list
    ):
        return None
    return payload


def write_graph_preview(state_dir: str | Path, snapshot: dict[str, Any]) -> Path:
    path = graph_preview_path(state_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        **snapshot,
        "schema_version": GRAPH_PREVIEW_SCHEMA_VERSION,
    }
    tmp = path.with_name(f".{path.name}.{os.getpid()}.{uuid.uuid4().hex}.tmp")
    try:
        with tmp.open("w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, path)
        try:
            directory_fd = os.open(str(path.parent), os.O_RDONLY)
        except OSError:
            directory_fd = None
        if directory_fd is not None:
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
    finally:
        tmp.unlink(missing_ok=True)
    return path


def delete_graph_preview(state_dir: str | Path) -> None:
    graph_preview_path(state_dir).unlink(missing_ok=True)


def acquire_graph_preview_lock(
    state_dir: str | Path,
    *,
    shared: bool = False,
) -> IO[str]:
    """Acquire the cross-process project graph lock.

    The filename is retained for compatibility. Cooperating Ladybug readers
    and mutations use this lock, including legacy preview materialization.
    """

    path = graph_preview_lock_path(state_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    handle = path.open("a+", encoding="utf-8")
    if fcntl is not None:
        operation = fcntl.LOCK_SH if shared else fcntl.LOCK_EX
        fcntl.flock(handle.fileno(), operation)
    return handle


async def acquire_graph_preview_lock_async(
    state_dir: str | Path,
    *,
    shared: bool = False,
) -> IO[str]:
    """Acquire the project graph lock without blocking the event loop."""

    path = graph_preview_lock_path(state_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    handle = path.open("a+", encoding="utf-8")
    if fcntl is None:
        return handle

    try:
        while True:
            try:
                operation = fcntl.LOCK_SH if shared else fcntl.LOCK_EX
                fcntl.flock(handle.fileno(), operation | fcntl.LOCK_NB)
                return handle
            except OSError as exc:
                if exc.errno not in (errno.EACCES, errno.EAGAIN):
                    raise
                await asyncio.sleep(0.05)
    except BaseException:
        handle.close()
        raise


def release_graph_preview_lock(handle: IO[str]) -> None:
    try:
        if fcntl is not None:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
    finally:
        handle.close()
