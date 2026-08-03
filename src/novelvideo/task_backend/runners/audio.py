"""Celery runner for project audio generation."""

from __future__ import annotations

import asyncio
from typing import Any

from novelvideo.project_context import ProjectContext
from novelvideo.task_backend.cancel import await_envelope_with_cancel_watch
from novelvideo.task_backend.registry import register_project_task_runner
from novelvideo.task_state import get_task_manager

INDEXTTS2_AUDIO_TASK_TYPE = "audio_generation_indextts2"


def run_indextts2_audio(envelope: dict[str, Any], ctx: ProjectContext) -> dict[str, Any] | None:
    return asyncio.run(
        await_envelope_with_cancel_watch(
            _run_indextts2_audio(envelope, ctx),
            envelope,
            task_type=INDEXTTS2_AUDIO_TASK_TYPE,
        )
    )


async def _run_indextts2_audio(
    envelope: dict[str, Any],
    ctx: ProjectContext,
) -> dict[str, Any] | None:
    from novelvideo.audio.indextts2_beat_audio_task import (
        run_indextts2_beat_audio_generation,
    )
    from novelvideo.sqlite_store import SQLiteStore

    payload = envelope.get("payload") or {}
    episode = int(envelope.get("episode") or payload.get("episode") or 0)
    mode = str(payload.get("mode") or "sync_changed")
    beat_numbers = payload.get("beat_numbers")
    if beat_numbers:
        beat_numbers = [int(value) for value in beat_numbers]
    manager = get_task_manager()

    store = SQLiteStore(
        ctx.owner_project_label,
        output_dir=str(ctx.output_dir),
        state_dir=str(ctx.state_dir),
    )
    await store.initialize()

    async def on_progress(done: int, total: int, current: str) -> None:
        manager.update_progress_for_project(
            ctx,
            INDEXTTS2_AUDIO_TASK_TYPE,
            episode,
            progress=(done / total) if total else 0.0,
            current_task=current,
            logs=[current],
        )

    def on_log(message: str) -> None:
        manager.update_progress_for_project(
            ctx,
            INDEXTTS2_AUDIO_TASK_TYPE,
            episode,
            logs=[message],
        )

    try:
        result = await run_indextts2_beat_audio_generation(
            store=store,
            username=ctx.owner_username,
            project=ctx.project_name,
            episode=episode,
            beat_numbers=beat_numbers,
            mode=mode,
            progress_callback=on_progress,
            log_callback=on_log,
        )
        skipped = (
            result.skipped_existing
            + result.skipped_empty
            + result.skipped_manual
            + result.skipped_silence
            + result.skipped_non_dialogue
        )
        return {
            "generated": result.generated,
            "total": result.total_targets,
            "skipped": skipped,
            "failed": len(result.failed),
            "generated_beats": list(result.generated_beats),
            "indextts2_detail": result.to_dict(),
            "billing_outcome": {
                "requested_units": result.total_targets,
                "delivered_units": result.generated,
                "failed_units": max(result.total_targets - result.generated, 0),
                "result_refs": [f"beat:{value}" for value in result.generated_beats],
            },
        }
    finally:
        await store.close()


register_project_task_runner(INDEXTTS2_AUDIO_TASK_TYPE, run_indextts2_audio)
