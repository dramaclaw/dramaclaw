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


def run_system_voice_setup(
    envelope: dict[str, Any], ctx: ProjectContext
) -> dict[str, Any]:
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
        # 与 runners/freezone.py 的 _call_freezone_leaf 同理：只有组织任务携带受信任的
        # 组织出网身份走网关；平台与本地任务保持无组织上下文的直连语义，否则
        # IndexTTS2FalClient.generate 会把非组织身份判为 ORG_EGRESS_DENIED。
        if egress_context is not None and egress_context.is_organization:
            generation_kwargs["egress_context"] = egress_context
        result = await run_indextts2_beat_audio_generation(
            **generation_kwargs,
        )
        if result.generated == 0 and result.failed:
            raise RuntimeError(
                f"音频生成失败：没有生成可用结果；最后错误：{result.failed[-1]}"
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


VOICE_DESIGN_TASK_TYPE = "voice_design"


def run_voice_design(envelope: dict[str, Any], ctx: ProjectContext) -> dict[str, Any]:
    return asyncio.run(
        await_envelope_with_cancel_watch(
            _run_voice_design(envelope, ctx),
            envelope,
            task_type=VOICE_DESIGN_TASK_TYPE,
        )
    )


async def _run_voice_design(
    envelope: dict[str, Any], ctx: ProjectContext
) -> dict[str, Any]:
    import os
    from dataclasses import asdict

    from novelvideo.audio.voice_design_service import (
        VoiceDesignError,
        ensure_voice_design_enabled,
        generate_voice_design,
        resolve_voice_design_config,
    )
    from novelvideo.audio.voice_design_storage import (
        CandidateStorageError,
        VoiceDesignStorage,
    )
    from novelvideo.project_context import require_project_home_node

    require_project_home_node(ctx, operation="voice design")
    context = _extract_trusted_egress_context(envelope)
    if (
        context is None
        or context.project_id != ctx.project_id
        or context.requester_user_id != ctx.requester_user_id
    ):
        raise InvalidTaskEnvelope()
    storage = VoiceDesignStorage(ctx)
    payload = envelope.get("payload") or {}
    candidate_id = str(payload.get("candidate_id") or "")
    record = storage.get(candidate_id)
    if record is None:
        raise VoiceDesignError("candidate_not_found")
    if record["status"] != "generating" or record.get("claimed"):
        return record
    try:
        daily_limit = ensure_voice_design_enabled()
        record = storage.claim(
            candidate_id,
            daily_limit=daily_limit,
            channel_key=context.credential.credential_id,
            channel_daily_limit=int(os.environ["VOICE_DESIGN_CHANNEL_DAILY_LIMIT"]),
        )
        if record is None:
            return storage.get(candidate_id) or {}
        config = await resolve_voice_design_config(
            user_id=ctx.requester_user_id, project_id=ctx.project_id
        )
        snapshot = (payload.get("billing") or {}).get("voice_design_config")
        if snapshot != asdict(config):
            raise VoiceDesignError("voice_design_unavailable")
        audio = await generate_voice_design(
            request=record,
            output_path=storage.output_path(candidate_id),
            egress_context=context,
            model_config=config,
        )
        return storage.complete(
            candidate_id, duration_seconds=audio.duration_seconds, sha256=audio.sha256
        )
    except (VoiceDesignError, CandidateStorageError) as exc:
        if getattr(exc, "unknown", False):
            storage.mark_unknown(candidate_id)
        else:
            storage.fail(candidate_id, exc.code)
        raise
    except BaseException:
        storage.mark_unknown(candidate_id)
        raise


register_project_task_runner(VOICE_DESIGN_TASK_TYPE, run_voice_design)
