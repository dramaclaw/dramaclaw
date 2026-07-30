"""Celery runner for fast novel ingest."""

from __future__ import annotations

import asyncio
from typing import Any

from novelvideo.project_context import ProjectContext
from novelvideo.task_backend.cancel import await_envelope_with_cancel_watch
from novelvideo.task_backend.registry import register_project_task_runner
from novelvideo.task_state import get_task_manager


def run_ingest_fast(envelope: dict[str, Any], ctx: ProjectContext) -> dict[str, Any] | None:
    return asyncio.run(
        await_envelope_with_cancel_watch(
            _run_ingest_fast(envelope, ctx),
            envelope,
            task_type="ingest_fast",
        )
    )


async def _run_ingest_fast(envelope: dict[str, Any], ctx: ProjectContext) -> dict[str, Any]:
    from novelvideo.cognee import CogneeStore

    payload = envelope.get("payload") or {}
    novel_path = str(payload["novel_path"])
    config = dict(payload.get("config") or {})
    manager = get_task_manager()

    store = CogneeStore(
        ctx.owner_project_label,
        output_dir=str(ctx.output_dir),
        state_dir=str(ctx.state_dir),
    )
    await store.initialize()

    def update(progress: float, task: str) -> None:
        manager.update_progress_for_project(
            ctx,
            "ingest_fast",
            0,
            progress=progress,
            current_task=task,
            logs=[task],
        )

    try:
        result = await store.ingest_novel_fast(
            novel_path,
            rebuild=bool(config.get("rebuild", False)),
            spine_template=str(config.get("spine_template") or "").strip() or None,
            on_progress=update,
            on_log=lambda message: update(0.0, message),
        )
        return result
    finally:
        await store.close()


register_project_task_runner("ingest_fast", run_ingest_fast)
