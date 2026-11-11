"""Durable single-process index and recovery sweeper for server workflows."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import tempfile
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path

from fastapi import HTTPException

from novelvideo import config
from novelvideo.freezone import workflow_runs as store

logger = logging.getLogger(__name__)
_LOCK = threading.Lock()


def _path() -> Path:
    return Path(config.STATE_DIR) / "server_workflow_runs.json"


def _read() -> list[dict]:
    path = _path()
    try:
        entries = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(entries, list) or any(
            not isinstance(entry, dict)
            or not all(entry.get(key) for key in (
                "project_id", "state_dir", "canvas_id", "run_id", "requester",
            ))
            or not isinstance(entry["requester"], dict)
            for entry in entries
        ):
            raise ValueError("invalid server workflow index")
        return entries
    except FileNotFoundError:
        return []
    except (ValueError, OSError):
        logger.exception("Cannot read server workflow index; treating it as empty")
        return []


def _write(entries: list[dict]) -> None:
    path = _path()
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent,
                                         delete=False) as stream:
            temporary = stream.name
            json.dump(entries, stream, ensure_ascii=False)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if temporary is not None and os.path.exists(temporary):
            os.unlink(temporary)


def register_server_workflow_run(
    *, project_id: str, state_dir: str | Path, canvas_id: str, run_id: str, requester: dict,
) -> None:
    with _LOCK:
        entries = [entry for entry in _read() if entry["run_id"] != run_id]
        entries.append(dict(project_id=project_id, state_dir=str(state_dir), canvas_id=canvas_id,
                            run_id=run_id, requester=requester))
        _write(entries)


def list_server_workflow_runs() -> list[dict]:
    with _LOCK:
        return _read()


def unregister_server_workflow_run(run_id: str) -> None:
    with _LOCK:
        entries = _read()
        remaining = [entry for entry in entries if entry["run_id"] != run_id]
        if len(remaining) != len(entries):
            _write(remaining)


async def sweep_server_workflow_runs(*, now: datetime | None = None, enqueue=None) -> list[dict]:
    from novelvideo.project_context import resolve_project_context
    from novelvideo.task_backend.client import enqueue_project_task

    current = now or datetime.now(timezone.utc)
    enqueue = enqueue or enqueue_project_task
    results = []
    for entry in await asyncio.to_thread(list_server_workflow_runs):
        run_id = entry["run_id"]
        scope = dict(project_dir=Path(entry["state_dir"]), canvas_id=entry["canvas_id"],
                     run_id=run_id)
        try:
            run = await asyncio.to_thread(store.read_workflow_run, **scope)
            if run is None or run["status"] != "running":
                await asyncio.to_thread(unregister_server_workflow_run, run_id)
                results.append(dict(run_id=run_id, action="unregistered"))
                continue
            generation = await asyncio.to_thread(
                store.mark_server_workflow_drive_enqueued, **scope, now=current,
            )
            if generation is None:
                results.append(dict(run_id=run_id, action="skipped"))
                continue
            requester = entry["requester"]
            try:
                ctx = await resolve_project_context(
                    user={"id": requester["user_id"], "username": requester["username"]},
                    project_id=entry["project_id"], required_role="editor",
                )
            except HTTPException as exc:
                if exc.status_code not in {403, 404}:
                    raise
                runner_id = f"sweep:{uuid.uuid4().hex}"
                acquired = await asyncio.to_thread(
                    store.acquire_server_workflow_run, **scope, runner_id=runner_id, now=current,
                )
                if acquired is not None and acquired["acquired"]:
                    await asyncio.to_thread(
                        store.update_workflow_run, **scope, status="failed", owner_kind="server",
                        runner_id=runner_id, now=current,
                    )
                await asyncio.to_thread(unregister_server_workflow_run, run_id)
                results.append(dict(run_id=run_id, action="failed"))
                continue
            await enqueue(
                ctx, task_type="freezone_workflow_drive", product_surface="freezone_assistant",
                queue_kind="default", scope=f"{run_id}:d{generation}",
                payload={"canvas_id": entry["canvas_id"], "run_id": run_id},
            )
            results.append(dict(run_id=run_id, action="enqueued"))
        except Exception:
            logger.exception("Server workflow recovery deferred run_id=%s", run_id)
            results.append(dict(run_id=run_id, action="skipped"))
    return results


async def run_server_workflow_sweeper(interval_seconds: float = 30.0) -> None:
    while True:
        try:
            await sweep_server_workflow_runs()
        except Exception:
            logger.exception("Server workflow sweeper failed")
        await asyncio.sleep(interval_seconds)
