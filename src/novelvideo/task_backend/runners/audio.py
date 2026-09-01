"""Celery runner for project audio generation."""

from __future__ import annotations

import asyncio
from typing import Any

from novelvideo.egress_context import (
    TRUSTED_EGRESS_CONTEXT_KEY,
    TrustedEgressContext,
    TrustedRunnerEnvelope,
)
from novelvideo.project_context import ProjectContext
from novelvideo.task_backend.cancel import await_envelope_with_cancel_watch
from novelvideo.task_backend.envelope import InvalidTaskEnvelope
from novelvideo.task_backend.registry import register_project_task_runner
from novelvideo.task_state import get_task_manager

INDEXTTS2_AUDIO_TASK_TYPE = "audio_generation_indextts2"
SYSTEM_VOICE_SETUP_TASK_TYPE = "system_voice_setup"


def run_system_voice_setup(envelope: dict[str, Any], ctx: ProjectContext) -> dict[str, Any]:
    return asyncio.run(
        await_envelope_with_cancel_watch(
            _run_system_voice_setup(envelope, ctx),
            envelope,
            task_type=SYSTEM_VOICE_SETUP_TASK_TYPE,
        )
    )


async def _run_system_voice_setup(
    envelope: dict[str, Any],
    ctx: ProjectContext,
) -> dict[str, Any]:
    from novelvideo.audio.system_voice_setup import prepare_missing_system_voices
    from novelvideo.sqlite_store import SQLiteStore

    payload = envelope.get("payload") or {}
    episode = int(envelope.get("episode") or payload.get("episode") or 0)
    manager = get_task_manager()
    store = SQLiteStore(
        ctx.owner_project_label,
        output_dir=str(ctx.output_dir),
        state_dir=str(ctx.state_dir),
    )
    await store.initialize()
    # ``prepare_missing_system_voices`` reads characters from SQLite and then
    # persists the selected voice through ``update_character``.  The latter
    # resolves characters from the store's in-memory index, so a fresh task
    # worker must hydrate that index before attempting the update.
    await store.load_graph_state()
    manager.update_progress_for_project(
        ctx,
        SYSTEM_VOICE_SETUP_TASK_TYPE,
        episode,
        progress=0.05,
        current_task="正在匹配系统声线",
        logs=["开始准备缺失的系统声线"],
    )
    try:
        result = await prepare_missing_system_voices(
            store=store,
            username=ctx.owner_username,
            project=ctx.project_name,
            project_dir=ctx.output_dir,
            episode=episode,
        )
        if not result.get("ready"):
            errors = list(result.get("remaining_errors") or [])
            detail = "；".join(str(error) for error in errors[:5])
            raise RuntimeError(detail or "系统声线准备后仍有缺失项")
        manager.update_progress_for_project(
            ctx,
            SYSTEM_VOICE_SETUP_TASK_TYPE,
            episode,
            progress=1.0,
            current_task="系统声线准备完成",
            logs=[f"已准备 {int(result.get('prepared_count') or 0)} 项系统声线"],
        )
        return result
    finally:
        await store.close()


def _extract_trusted_egress_context(
    envelope: dict[str, Any],
) -> TrustedEgressContext | None:
    if type(envelope) is TrustedRunnerEnvelope:
        context = envelope.get(TRUSTED_EGRESS_CONTEXT_KEY)
        if type(context) is not TrustedEgressContext:
            raise InvalidTaskEnvelope() from None
        return context
    if type(envelope) is not dict or TRUSTED_EGRESS_CONTEXT_KEY in envelope:
        raise InvalidTaskEnvelope() from None
    return None


def run_indextts2_audio(
    envelope: dict[str, Any], ctx: ProjectContext
) -> dict[str, Any] | None:
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
        generation_kwargs: dict[str, Any] = {
            "store": store,
            "username": ctx.owner_username,
            "project": ctx.project_name,
            "episode": episode,
            "beat_numbers": beat_numbers,
            "mode": mode,
            "progress_callback": on_progress,
            "log_callback": on_log,
        }
        egress_context = _extract_trusted_egress_context(envelope)
        if egress_context is not None:
            generation_kwargs["egress_context"] = egress_context
        result = await run_indextts2_beat_audio_generation(
            **generation_kwargs,
        )
        if result.generated == 0 and result.failed:
            raise RuntimeError(
                "音频生成失败：没有生成可用结果；"
                f"最后错误：{result.failed[-1]}"
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
        }
    finally:
        await store.close()


register_project_task_runner(INDEXTTS2_AUDIO_TASK_TYPE, run_indextts2_audio)
register_project_task_runner(SYSTEM_VOICE_SETUP_TASK_TYPE, run_system_voice_setup)
