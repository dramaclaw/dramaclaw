"""Durable index and recovery sweeper for server workflows with cross-process locking."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import tempfile
import time
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator

import portalocker
from fastapi import HTTPException

from novelvideo import config
from novelvideo.freezone import workflow_runs as store
from novelvideo.project_context import ProjectContext

logger = logging.getLogger(__name__)
_INDEX_LOCK_TIMEOUT_SECONDS = 30.0
_INDEX_LOCK_RETRY_INTERVAL_SECONDS = 0.02
SERVER_WORKFLOW_DELIVERY_GRACE_SECONDS = 3600


def _path() -> Path:
    return Path(config.STATE_DIR) / "server_workflow_runs.json"


@contextmanager
def _index_lock() -> Iterator[None]:
    """Serialize index reads and read-modify-write transactions."""
    # Host-level lock, like the other file locks here; leave the lock file in place.
    # Separate opens also exclude other threads, so no threading lock is needed.
    lock_path = _path().with_name("server_workflow_runs.json.lock")
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    deadline = time.monotonic() + _INDEX_LOCK_TIMEOUT_SECONDS
    with lock_path.open("a+", encoding="utf-8") as lock_file:
        while True:
            try:
                portalocker.lock(lock_file, portalocker.LOCK_EX | portalocker.LOCK_NB)
                break
            except portalocker.exceptions.AlreadyLocked as exc:
                if time.monotonic() >= deadline:
                    raise TimeoutError("server workflow index lock busy") from exc
                time.sleep(_INDEX_LOCK_RETRY_INTERVAL_SECONDS)
        try:
            yield
        finally:
            portalocker.unlock(lock_file)


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
    with _index_lock():
        entries = [entry for entry in _read() if entry["run_id"] != run_id]
        entries.append(dict(project_id=project_id, state_dir=str(state_dir), canvas_id=canvas_id,
                            run_id=run_id, requester=requester))
        _write(entries)


def list_server_workflow_runs() -> list[dict]:
    with _index_lock():
        return _read()


def unregister_server_workflow_run(run_id: str) -> None:
    with _index_lock():
        entries = _read()
        remaining = [entry for entry in entries if entry["run_id"] != run_id]
        if len(remaining) != len(entries):
            _write(remaining)


async def enqueue_server_workflow_drive(
    ctx: ProjectContext, *, canvas_id: str, run_id: str, attempt: int, enqueue=None,
) -> None:
    from novelvideo.task_backend.client import enqueue_project_task

    enqueue = enqueue or enqueue_project_task
    await enqueue(
        ctx, task_type="freezone_workflow_drive", product_surface="freezone_assistant",
        queue_kind="default", scope=f"{run_id}:d{attempt}",
        payload={"canvas_id": canvas_id, "run_id": run_id, "drive_attempt": attempt},
    )


async def sweep_server_workflow_runs(*, now: datetime | None = None, enqueue=None) -> list[dict]:
    from novelvideo.project_context import resolve_project_context
    from novelvideo.api.freezone_server_workflow_host import clear_server_generation_markers
    from novelvideo.task_state import get_task_manager
    from novelvideo.api.routes.freezone import maintain_server_workflow_canvas
    from novelvideo.freezone.agent_product_operations import (
        PENDING_STATUSES,
        read_agent_product_operation,
    )

    current = now or datetime.now(timezone.utc)
    results = []
    for entry in await asyncio.to_thread(list_server_workflow_runs):
        run_id = entry["run_id"]
        scope = dict(project_dir=Path(entry["state_dir"]), canvas_id=entry["canvas_id"],
                     run_id=run_id)
        try:
            run = await asyncio.to_thread(store.read_workflow_run, **scope)
            if run is None:
                await asyncio.to_thread(unregister_server_workflow_run, run_id)
                results.append(dict(run_id=run_id, action="unregistered"))
                continue
            terminal = run["status"] != "running"
            if terminal:
                expiry = run.get("lease_expires_at")
                expires = datetime.fromisoformat(expiry.replace("Z", "+00:00")) if expiry else None
                if run.get("runner_id") and expires and expires > current:
                    results.append(dict(run_id=run_id, action="skipped"))
                    continue
            else:
                attempt = await asyncio.to_thread(
                    store.mark_server_workflow_drive_enqueued, **scope, now=current,
                )
                if attempt is None:
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
                if not terminal:
                    runner_id = f"sweep:{uuid.uuid4().hex}"
                    acquired = await asyncio.to_thread(
                        store.acquire_server_workflow_run, **scope, runner_id=runner_id,
                        now=current,
                    )
                    if acquired is not None and acquired["acquired"]:
                        await asyncio.to_thread(
                            store.update_workflow_run, **scope, status="failed",
                            owner_kind="server", runner_id=runner_id, now=current,
                        )
                await asyncio.to_thread(unregister_server_workflow_run, run_id)
                results.append(dict(run_id=run_id, action="unregistered" if terminal else "failed"))
                continue
            try:
                # Fail tasks of a dead process first, so the next drive does not wait on them.
                await asyncio.to_thread(get_task_manager().sweep_stale_tasks_for_project, ctx)
            except Exception:
                logger.warning("Server workflow task sweep skipped run_id=%s", run_id,
                               exc_info=True)
            if terminal:
                try:
                    await maintain_server_workflow_canvas(ctx, entry["canvas_id"])
                except Exception:
                    logger.warning("Server workflow delivery deferred run_id=%s", run_id,
                                   exc_info=True)
                run = await asyncio.to_thread(store.read_workflow_run, **scope)
                pending = 0
                for action in (run or {}).get("actions", []):
                    operation_id = action.get("product_operation_id")
                    if operation_id:
                        operation = await asyncio.to_thread(
                            read_agent_product_operation,
                            project_dir=Path(entry["state_dir"]), operation_id=operation_id,
                        )
                        if operation and operation["status"] in PENDING_STATUSES:
                            pending += 1
                ended_at = (run or {}).get("completed_at") or (run or {}).get("updated_at")
                awaiting_delivery = pending and ended_at and (
                    current - datetime.fromisoformat(ended_at.replace("Z", "+00:00"))
                ).total_seconds() < SERVER_WORKFLOW_DELIVERY_GRACE_SECONDS
                await clear_server_generation_markers(
                    ctx=ctx, canvas_id=entry["canvas_id"], run_id=run_id,
                )
                if awaiting_delivery:
                    results.append(dict(run_id=run_id, action="awaiting_delivery"))
                    continue
                if pending:
                    logger.warning("Server workflow delivery grace expired run_id=%s pending=%s",
                                   run_id, pending)
                await asyncio.to_thread(unregister_server_workflow_run, run_id)
                results.append(dict(run_id=run_id, action="unregistered"))
            else:
                try:
                    await enqueue_server_workflow_drive(
                        ctx, canvas_id=entry["canvas_id"], run_id=run_id, attempt=attempt,
                        enqueue=enqueue,
                    )
                except Exception as exc:
                    try:
                        await asyncio.to_thread(
                            store.record_server_workflow_drive_enqueue_failed,
                            **scope, attempt=attempt, error_kind=type(exc).__name__,
                        )
                    except Exception:
                        logger.warning(
                            "Server workflow enqueue failure recording deferred run_id=%s", run_id,
                        )
                    logger.warning("Server workflow enqueue deferred run_id=%s", run_id)
                    results.append(dict(run_id=run_id, action="skipped"))
                else:
                    try:
                        await asyncio.to_thread(
                            store.acknowledge_server_workflow_drive, **scope, attempt=attempt,
                        )
                    except Exception:
                        logger.warning("Server workflow drive acknowledgement deferred run_id=%s",
                                       run_id)
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
