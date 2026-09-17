"""Project-owned publication storage and a rebuildable public-ID index."""

from __future__ import annotations

import asyncio
import json
import logging
import re
from pathlib import Path

from novelvideo.interactive_story.publication import PublicationError, PublicationStore
from novelvideo.ports import get_project_registry
from novelvideo.project_context import is_record_home_node
from novelvideo.utils.async_ops import (
    call_blocking,
    metadata_io_limiter,
    run_sync_bounded,
    wait_for_task_completion,
)

logger = logging.getLogger(__name__)


def project_store(project_id: str, state_dir: Path) -> PublicationStore:
    store = PublicationStore(
        Path(state_dir) / "publications",
        project_id=project_id,
        index_root=PublicationStore().root,
    )
    with store.locked():
        for path in store.root.glob("*/work.json"):
            work = json.loads(path.read_text())
            if work.get("project_id") != project_id:
                raise PublicationError("publication_data_invalid", 500)
            store.index_work(work)
    return store


async def public_store(public_id: str) -> PublicationStore:
    if not re.fullmatch(r"[a-f0-9]{32}", public_id):
        raise PublicationError("not_found", 404)
    root = PublicationStore().root
    index = root / "index" / f"{public_id}.json"
    if not index.exists():
        raise PublicationError("not_found", 404)
    project_id = json.loads(index.read_text())["project_id"]
    record = await get_project_registry().get_project(project_id)
    if record is None or record.status == "deleted" or record.purged_at:
        raise PublicationError("unavailable", 410)
    if not is_record_home_node(record):
        raise PublicationError("unavailable", 503)
    store = PublicationStore(
        Path(record.state_dir) / "publications", project_id=record.id, index_root=root
    )
    if store.read(public_id).get("project_id") != record.id:
        raise PublicationError("not_found", 404)
    return store


async def recover_project_publications():
    root = PublicationStore().root
    registry = get_project_registry()
    ids = set()
    for path in root.glob("index/*.json"):
        value = json.loads(path.read_text())
        if value.get("project_id"):
            ids.add(value["project_id"])
    # CE's local registry also lets us rebuild missing public-ID indexes.
    from novelvideo.shared.runtime_env import is_ce_effective

    if is_ce_effective():
        for record in await registry.list_accessible_projects([("user", "local")]):
            ids.add(record.id)
    for project_id in ids:
        record = await registry.get_project(project_id)
        if record is None or record.purged_at or not is_record_home_node(record):
            continue
        if not Path(record.state_dir).is_dir():
            continue
        try:
            store = await call_blocking(
                project_store, record.id, Path(record.state_dir)
            )
            if record.status == "deleted":
                await call_blocking(_unlist, store)
            await call_blocking(store.recover)
        except Exception:
            logger.exception("Publication recovery failed for project %s", project_id)


def _unlist(store):
    with store.locked():
        store.unlist_all()


async def invoke_active(store, operation, *args):
    """Check the authoritative project status inside the mutation's file lock."""
    loop = asyncio.get_running_loop()
    registry = get_project_registry()

    def check_project():
        record = asyncio.run_coroutine_threadsafe(
            registry.get_project(store.project_id), loop
        ).result()
        if record is None or record.status == "deleted" or record.purged_at:
            raise PublicationError("unavailable", 410)
        if not is_record_home_node(record):
            raise PublicationError("unavailable", 503)

    def execute():
        store.check_project = check_project
        try:
            return operation(*args)
        finally:
            store.check_project = None

    return await run_sync_bounded(execute, limiter=metadata_io_limiter())


async def delete_project_and_unlist(project_id, state_dir, registry):
    """Compensate unlisting if the registry update fails, under the copy lock."""
    loop = asyncio.get_running_loop()

    def commit():
        return asyncio.run_coroutine_threadsafe(
            registry.update_project_status(project_id, "deleted"), loop
        ).result()

    def execute():
        # Missing project data must not prevent removing its registry entry.
        if not Path(state_dir).is_dir():
            return commit()
        store = PublicationStore(
            Path(state_dir) / "publications",
            project_id=project_id,
            index_root=PublicationStore().root,
        )
        with store.locked():
            previous = store.unlist_all()
            try:
                record = commit()
            except BaseException:
                store.restore_listings(previous)
                raise
            if record is None:
                store.restore_listings(previous)
            return record

    return await run_sync_bounded(execute, limiter=metadata_io_limiter())


async def detach_project_publications(record, detach, restore, *, validate, **kwargs):
    """Only coordinate in-flight copies; directory ownership/removal stays with projects."""

    def execute():
        if not Path(record.state_dir).is_dir():
            return detach(record, **kwargs)
        # Validate before opening the store: its lock may create publications/.
        validate(record)
        store = PublicationStore(
            Path(record.state_dir) / "publications",
            project_id=record.id,
            index_root=PublicationStore().root,
        )
        with store.locked():
            return detach(record, **kwargs)

    task = asyncio.create_task(call_blocking(execute))
    quarantined, cancellation = await wait_for_task_completion(task)
    if cancellation is not None:
        rollback = asyncio.create_task(call_blocking(restore, quarantined))
        await wait_for_task_completion(rollback, cancellation)
        raise cancellation
    return quarantined
