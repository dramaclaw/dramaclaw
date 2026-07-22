"""Backend-neutral project task execution core."""

from __future__ import annotations

import asyncio
import logging
import os
import time
from typing import Any

from novelvideo.ports import get_usage_meter
from novelvideo.shared.billing_errors import (
    INSUFFICIENT_CREDITS_MESSAGE,
    insufficient_credits_payload,
    is_insufficient_credits_error,
)
from novelvideo.task_backend.cancel import TaskCancelled, TaskTimedOut, is_cancel_requested
from novelvideo.task_backend.registry import get_project_task_runner
from novelvideo.task_backend.subprocesses import project_task_subprocess_context
from novelvideo.task_state import project_task_run_context

logger = logging.getLogger(__name__)

_PROJECT_TASK_RESOURCE_KINDS = {
    "ingest_fast": "ingest",
    "build_characters": "script",
    "build_scenes": "script",
    "build_props": "script",
    "build_episodes": "script",
    "script_writer": "script",
    "beat_video_prompt": "script",
    "identity_planner": "portrait",
    "episode_scene_planner": "script",
    "episode_prop_planner": "script",
    "character_portrait": "portrait",
    "identity_image": "portrait",
    "scene_reference_asset": "render",
    "prop_reference_asset": "render",
    "batch_prop_ref": "render",
    "stage_asset": "render",
    "freezone_image_to_3gs": "render",
    "sketch_generation": "sketch",
    "sketch_regen": "sketch",
    "mainline_sketch_from_context": "sketch",
    "mainline_frame_from_context": "render",
    "sketch_edit_execute": "sketch",
    "action_sketch": "sketch",
    "selected_regen": "render",
    "grid_regenerate": "render",
    "single_video": "video",
    "compose_episode": "video",
    "global_optimize_video": "script",
    "audio_generation": "tts",
    "indextts2_audio_generation": "tts",
    "audio_generation_indextts2": "tts",
    "freezone_video_gen": "video",
    "freezone_analyze": "video",
    "freezone_video_story": "video",
    "freezone_image_reverse_prompt": "script",
    "freezone_story_script": "script",
}


def _resource_kind_for_task(task_type: str) -> str:
    return _PROJECT_TASK_RESOURCE_KINDS.get(task_type, "")


def _metrics_user_id_for_project_context(ctx: Any) -> str:
    requester_user_id = str(getattr(ctx, "requester_user_id", "") or "").strip()
    if requester_user_id:
        return requester_user_id
    return str(getattr(ctx, "owner_id", "") or "").strip()


def _positive_int(value: Any) -> int | None:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed > 0 else None


def _episode_ref(episode: int) -> str:
    return f"ep{episode:03d}" if episode > 0 else "project"


def _beat_ref(episode: int, beat_num: int, *, scope: Any = None) -> str:
    ref = f"{_episode_ref(episode)}:beat{beat_num:03d}"
    clean_scope = str(scope or "").strip()
    return f"{ref}:{clean_scope}" if clean_scope else ref


def _int_list(value: Any) -> list[int]:
    if value is None:
        return []
    if isinstance(value, (str, bytes)):
        values: list[Any] = [value]
    else:
        try:
            values = list(value)
        except TypeError:
            values = [value]
    out: list[int] = []
    for item in values:
        parsed = _positive_int(item)
        if parsed is not None and parsed not in out:
            out.append(parsed)
    return out


def _beat_numbers_from_result(result: Any) -> list[int]:
    if not isinstance(result, dict):
        return []
    for key in ("beat_numbers", "updated_beats", "generated_beats"):
        beats = _int_list(result.get(key))
        if beats:
            return beats
    beat_num = _positive_int(result.get("beat_num") or result.get("beat"))
    if beat_num:
        return [beat_num]
    items = result.get("items")
    if isinstance(items, list):
        beats: list[int] = []
        for item in items:
            if not isinstance(item, dict):
                continue
            for key in ("beat_num", "beat"):
                parsed = _positive_int(item.get(key))
                if parsed is not None and parsed not in beats:
                    beats.append(parsed)
        return beats
    return []


def _resource_refs_for_task_success(
    *,
    task_type: str,
    episode: int,
    beat_num: Any = None,
    scope: Any = None,
    result: Any = None,
) -> list[str]:
    kind = _resource_kind_for_task(task_type)
    if not kind:
        return []
    if kind == "ingest":
        return []
    if kind == "script":
        return [_episode_ref(episode)]

    explicit_beat = _positive_int(beat_num)
    if explicit_beat is not None:
        return [_beat_ref(episode, explicit_beat, scope=scope)]

    beats = _beat_numbers_from_result(result)
    if beats:
        return [_beat_ref(episode, beat, scope=scope) for beat in beats]

    clean_scope = str(scope or "").strip()
    if clean_scope:
        return [f"{_episode_ref(episode)}:{clean_scope}"]
    return [f"{_episode_ref(episode)}:{task_type}"]


def _clean_billing_metadata(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        return {}
    cleaned: dict[str, Any] = {}
    for key, item in value.items():
        clean_key = str(key or "").strip()
        if not clean_key or item is None:
            continue
        if isinstance(item, str):
            clean_item = item.strip()
            if not clean_item:
                continue
            cleaned[clean_key] = clean_item
        else:
            cleaned[clean_key] = item
    return cleaned


def _set_project_task_metrics_context(
    ctx: Any,
    task_type: str,
    billing_metadata: dict[str, Any] | None = None,
) -> None:
    billing_user_id = _metrics_user_id_for_project_context(ctx)
    context_metadata = {
        "billing_user_id": billing_user_id,
        "requester_user_id": str(getattr(ctx, "requester_user_id", "") or "").strip(),
        "project_owner_id": str(getattr(ctx, "owner_id", "") or "").strip(),
        "billing_task_type": task_type,
    }
    context_metadata.update(_clean_billing_metadata(billing_metadata))
    get_usage_meter().set_llm_usage_context(
        billing_user_id,
        project_id=str(getattr(ctx, "project_id", "") or ""),
        resource_kind=_resource_kind_for_task(task_type),
        billing_metadata={key: value for key, value in context_metadata.items() if value},
    )


def _clear_project_task_metrics_context() -> None:
    get_usage_meter().clear_llm_usage_context()


def _feature_credit_reservation_id(metadata: dict[str, Any]) -> str:
    return str(
        metadata.get("feature_credit_reservation_id")
        or metadata.get("feature_credit_charge_id")
        or ""
    ).strip()


async def _confirm_feature_credit_reservation(
    reservation_id: str,
    *,
    metadata: dict[str, Any] | None = None,
) -> None:
    if not reservation_id:
        return
    try:
        await get_usage_meter().confirm_feature_credit_reservation(
            reservation_id,
            metadata=metadata,
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("feature credit confirmation failed: %s", exc)


async def _refund_feature_credit_reservation(
    reservation_id: str,
    *,
    metadata: dict[str, Any] | None = None,
) -> None:
    if not reservation_id:
        return
    try:
        await get_usage_meter().refund_feature_credit_reservation(
            reservation_id,
            metadata=metadata,
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("feature credit refund failed: %s", exc)


async def _emit_project_task_metrics(
    ctx: Any,
    task_type: str,
    *,
    episode: int,
    beat_num: Any = None,
    scope: Any = None,
    result: Any = None,
    outcome: str = "success",
) -> None:
    try:
        usage_meter = get_usage_meter()
        user_id = _metrics_user_id_for_project_context(ctx)
        project_id = str(getattr(ctx, "project_id", "") or "")
        kind = _resource_kind_for_task(task_type)
        clean_outcome = "failed" if outcome == "failed" else "success"

        if task_type == "ingest_fast":
            model = os.environ.get("COGNEE_LLM_MODEL", "").strip()
            if clean_outcome == "success":
                await usage_meter.bump_content_counter(
                    user_id=user_id,
                    metric="ingests_completed",
                    value=1,
                    model=model,
                    project_id=project_id,
                    resource_kind="ingest",
                )
            await usage_meter.log_resource_attempts(
                user_id=user_id,
                project_id=project_id,
                kind="ingest",
                refs=[f"project:{project_id}"],
                outcome=clean_outcome,
                model=model,
            )
            return

        if clean_outcome == "success" and task_type == "script_writer":
            beats = _positive_int((result or {}).get("beats") if isinstance(result, dict) else None)
            await usage_meter.bump_content_counter(
                user_id=user_id,
                metric="scripts_written",
                value=1,
                project_id=project_id,
            )
            if beats:
                await usage_meter.bump_content_counter(
                    user_id=user_id,
                    metric="beats_written",
                    value=beats,
                    project_id=project_id,
                )

        refs = _resource_refs_for_task_success(
            task_type=task_type,
            episode=episode,
            beat_num=beat_num,
            scope=scope,
            result=result,
        )
        if not refs or not kind:
            return
        model = ""
        if isinstance(result, dict):
            model = str(result.get("model") or "").strip()
        await usage_meter.log_resource_attempts(
            user_id=user_id,
            project_id=project_id,
            kind=kind,
            refs=refs,
            outcome=clean_outcome,
            model=model,
        )
    except Exception as exc:  # noqa: BLE001
        logger.debug("project task metrics emit failed: %s", exc)


def _project_task_timeout_seconds() -> int:
    raw_value = os.environ.get("ST_PROJECT_TASK_TIMEOUT_S")
    if raw_value:
        try:
            return int(raw_value)
        except ValueError:
            logger.warning("Invalid ST_PROJECT_TASK_TIMEOUT_S=%r; using default", raw_value)
    return 30 * 60


def _project_task_failure_for_exception(exc: BaseException) -> tuple[str, dict[str, Any], bool]:
    from novelvideo.novel_source import NovelImportRequiredError

    if isinstance(exc, NovelImportRequiredError):
        return str(exc), {"error_code": exc.error_code}, True

    if isinstance(exc, TaskTimedOut):
        timeout_seconds = int(getattr(exc, "timeout_seconds", None) or 30 * 60)
        timeout_minutes = max(round(timeout_seconds / 60), 1)
        return (
            f"任务超过 {timeout_minutes} 分钟未完成，已自动放弃",
            {"error_code": "TASK_TIMEOUT", "timeout_seconds": timeout_seconds},
            True,
        )

    try:
        from celery.exceptions import SoftTimeLimitExceeded

        if isinstance(exc, SoftTimeLimitExceeded):
            timeout_seconds = _project_task_timeout_seconds()
            timeout_minutes = max(round(timeout_seconds / 60), 1)
            return (
                f"任务超过 {timeout_minutes} 分钟未完成，已自动放弃",
                {"error_code": "TASK_TIMEOUT", "timeout_seconds": timeout_seconds},
                True,
            )
    except Exception:
        pass

    if is_insufficient_credits_error(exc):
        return INSUFFICIENT_CREDITS_MESSAGE, insufficient_credits_payload(exc), True

    try:
        from novelvideo.director_world.pano_sharp import Sharp3DUnavailable

        if isinstance(exc, Sharp3DUnavailable):
            return str(exc), {"error_code": exc.error_code}, True
    except Exception:
        pass

    try:
        from novelvideo.director_world.block_world_builder import BlockWorldUnavailable

        if isinstance(exc, BlockWorldUnavailable):
            return str(exc), {"error_code": exc.error_code}, True
    except Exception:
        pass

    try:
        from novelvideo.shared.provider_errors import (
            content_moderation_payload,
            is_content_moderation_error,
        )

        if is_content_moderation_error(exc):
            payload = content_moderation_payload(exc)
            return str(payload.get("message") or ""), payload, True
    except Exception:
        pass

    if not isinstance(exc, Exception):
        raise exc
    from novelvideo.utils.error_redaction import safe_exception_message

    return safe_exception_message(exc), {}, False


def _completion_metadata_with_provider_task_id(
    metadata: dict[str, Any],
    result: Any,
) -> dict[str, Any]:
    completion_metadata = dict(metadata)
    if isinstance(result, dict):
        provider_task_id = (
            result.get("provider_task_id")
            or result.get("huimeng_task_id")
            or result.get("newapi_task_id")
        )
        if provider_task_id:
            completion_metadata["provider_task_id"] = str(provider_task_id)
    return completion_metadata


def _ensure_builtin_runners_registered() -> None:
    from novelvideo.task_backend.runners import (  # noqa: F401
        audio,
        character_image,
        episode_assets,
        freezone,
        graph_build,
        identity,
        ingest,
        prop_reference,
        render,
        scene_reference,
        script,
        sketch,
        sketch_edit_execute,
        stage_asset,
        video,
    )


def run_project_task_core_sync(
    envelope: dict[str, Any],
    ctx: Any,
    manager: Any,
    *,
    run_task_id: str,
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    task_type = str(envelope["task_type"])
    episode = int(envelope.get("episode") or 0)
    beat_num = envelope.get("beat_num")
    scope = envelope.get("scope")
    billing_metadata = _clean_billing_metadata(envelope.get("billing_metadata"))
    run_metadata = {**dict(metadata or {}), **billing_metadata}
    feature_reservation_id = _feature_credit_reservation_id(run_metadata)
    timeout_seconds = _project_task_timeout_seconds()
    deadline_monotonic = time.monotonic() + timeout_seconds if timeout_seconds > 0 else None

    _clear_project_task_metrics_context()

    if asyncio.run(
        is_cancel_requested(
            project_id=str(envelope["project_id"]),
            task_type=task_type,
            episode=episode,
            task_id=run_task_id,
            beat_num=beat_num,
            scope=scope,
        )
    ):
        asyncio.run(
            _refund_feature_credit_reservation(
                feature_reservation_id,
                metadata={"source": "task_cancelled_before_start"},
            )
        )
        manager.update_progress_for_project(
            ctx,
            task_type,
            episode,
            beat_num=beat_num,
            scope=scope,
            progress=0.0,
            current_task="任务已取消",
            metadata=run_metadata,
            status="cancelled",
            expected_task_id=run_task_id,
        )
        return {"cancelled": True}

    try:
        with project_task_run_context(run_task_id), project_task_subprocess_context(
            project_id=str(envelope["project_id"]),
            task_type=task_type,
            episode=episode,
            task_id=run_task_id,
            beat_num=beat_num,
            scope=scope,
            deadline_monotonic=deadline_monotonic,
            timeout_seconds=timeout_seconds,
        ):
            _set_project_task_metrics_context(
                ctx,
                task_type,
                billing_metadata=billing_metadata,
            )
            manager.update_progress_for_project(
                ctx,
                task_type,
                episode,
                beat_num=beat_num,
                scope=scope,
                progress=0.01,
                current_task="任务已开始",
                metadata=run_metadata,
            )

            _ensure_builtin_runners_registered()
            runner = get_project_task_runner(task_type)
            if runner is None:
                error = f"No project task runner registered for task_type={task_type}"
                asyncio.run(
                    _refund_feature_credit_reservation(
                        feature_reservation_id,
                        metadata={"source": "task_runner_missing", "error": error},
                    )
                )
                manager.fail_task_for_project(
                    ctx,
                    task_type,
                    episode,
                    beat_num=beat_num,
                    scope=scope,
                    error=error,
                    metadata=run_metadata,
                    expected_task_id=run_task_id,
                )
                raise RuntimeError(error)

            try:
                envelope = {**envelope, "__run_task_id": run_task_id}
                if deadline_monotonic is not None:
                    envelope["__deadline_monotonic"] = deadline_monotonic
                    envelope["__timeout_seconds"] = timeout_seconds
                result = runner(envelope, ctx)
            except BaseException as exc:
                if isinstance(exc, TaskCancelled):
                    asyncio.run(
                        _refund_feature_credit_reservation(
                            feature_reservation_id,
                            metadata={"source": "task_cancelled"},
                        )
                    )
                    manager.update_progress_for_project(
                        ctx,
                        task_type,
                        episode,
                        beat_num=beat_num,
                        scope=scope,
                        progress=0.0,
                        current_task="任务已取消",
                        metadata=run_metadata,
                        status="cancelled",
                        expected_task_id=run_task_id,
                    )
                    return {"cancelled": True}
                error, failure_payload, handled = _project_task_failure_for_exception(exc)
                asyncio.run(
                    _refund_feature_credit_reservation(
                        feature_reservation_id,
                        metadata={
                            "source": "task_failed",
                            "error": error,
                            **failure_payload,
                        },
                    )
                )
                manager.fail_task_for_project(
                    ctx,
                    task_type,
                    episode,
                    beat_num=beat_num,
                    scope=scope,
                    error=error,
                    metadata={**run_metadata, **failure_payload},
                    expected_task_id=run_task_id,
                )
                asyncio.run(
                    _emit_project_task_metrics(
                        ctx,
                        task_type,
                        episode=episode,
                        beat_num=beat_num,
                        scope=scope,
                        outcome="failed",
                    )
                )
                if handled:
                    return {"failed": True, **failure_payload}
                raise

            asyncio.run(
                _emit_project_task_metrics(
                    ctx,
                    task_type,
                    episode=episode,
                    beat_num=beat_num,
                    scope=scope,
                    result=result,
                )
            )
            asyncio.run(
                _confirm_feature_credit_reservation(
                    feature_reservation_id,
                    metadata={"source": "task_completed"},
                )
            )
            manager.complete_task_for_project(
                ctx,
                task_type,
                episode,
                beat_num=beat_num,
                scope=scope,
                result=result or {"ok": True},
                current_task="完成",
                logs=["完成"],
                metadata=_completion_metadata_with_provider_task_id(run_metadata, result),
                expected_task_id=run_task_id,
            )
        return result or {"ok": True}
    finally:
        _clear_project_task_metrics_context()
