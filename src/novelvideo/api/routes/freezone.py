"""Freezone REST 接口。

所有接口统一挂在 `/api/v1/projects/{project}/freezone/*` 下，并沿用
SuperTale 现有鉴权约定（`Depends(get_api_user)`）。
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import hashlib
import json
import logging
import os
import re
import shutil
import uuid
from pathlib import Path
from typing import Annotated, Awaitable, Callable, Literal, Optional
from urllib.parse import quote, unquote, urlencode, urlsplit

from fastapi import APIRouter, Body, Depends, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse

from novelvideo.api.auth import get_api_user
from novelvideo.api.deps import (
    make_cognee_store_for_context,
    make_sqlite_store,
    make_sqlite_store_for_context,
    make_static_url_for_context,
)
from novelvideo.api.schemas import (
    CanvasPayload,
    CreateIdentityAssetRequest,
    FreezoneAnalyzeShotsRequest,
    FreezoneAnalyzeVideoStoryRequest,
    FreezoneAudioMusicRequest,
    FreezoneAudioSeparateRequest,
    FreezoneAudioSpeechRequest,
    FreezoneCharacterMultiViewRequest,
    FreezoneEditRequest,
    FreezoneExtractFramesRequest,
    FreezoneFrameFromContextRequest,
    FreezoneGenRequest,
    FreezoneImageCameraConfig,
    FreezoneImageReversePromptRequest,
    FreezoneImageStyleConfig,
    FreezoneImageTo3GSRequest,
    FreezoneImageToVideoRequest,
    FreezoneJobAcceptedResponse,
    FreezoneKeyframeVideoRequest,
    FreezoneMarkDetectRequest,
    FreezoneMarkDetectResponse,
    FreezoneOutpaintRequest,
    FreezoneRedrawRequest,
    FreezoneRelightRequest,
    FreezoneScene360Request,
    FreezoneSketchFromContextRequest,
    FreezoneStageAssetAcceptedResponse,
    FreezoneStoryScriptGenerateRequest,
    FreezoneTemplateEditRequest,
    FreezoneTextTranslateRequest,
    FreezoneThreeDViewerScreenshotRequest,
    FreezoneUpscaleRequest,
    FreezoneVideoCharacterLibraryItemRequest,
    FreezoneVideoComposeRequest,
    FreezoneVideoEraseRequest,
    FreezoneVideoGenRequest,
    FreezoneVideoOmniGenRequest,
    FreezoneVideoUpscaleRequest,
    ImpactRequest,
    PresetCanvasRequest,
    ProjectionPresetCanvasRequest,
    ProjectionRemoveRequest,
    ProjectionStatusRequest,
    PushRequest,
)
from novelvideo.config import IMAGE_GENERATION_SELECTIONS, image_generation_selection_options
from novelvideo.director_world import DirectorWorldService
from novelvideo.director_world.staging_prop_ai import generate_ai_staging_prop
from novelvideo.freezone import canvas_store
from novelvideo.freezone.audio_node import (
    create_user_audio_voice,
    freezone_audio_eleven_music_output_path,
    freezone_audio_speech_output_path,
    generate_freezone_audio_speech,
    list_user_audio_voices,
    resolve_user_audio_voice,
)
from novelvideo.freezone.canvas_lock import CanvasLockBusy
from novelvideo.freezone.canvas_static_urls import (
    migrate_canvas_static_urls_in_memory,
    sanitize_project_local_paths_in_memory,
)
from novelvideo.freezone.history import (
    append_generation_history,
    build_node_history_record,
    read_canvas_generation_history,
    read_generation_history,
)
from novelvideo.freezone.image_node import (
    reverse_prompt_from_image,
)
from novelvideo.freezone.mark_node import detect_freezone_mark
from novelvideo.freezone.paths import (
    CANVAS_ID_RE,
    canvases_dir,
    freezone_root,
    output_path_for_job,
    outputs_dir,
    resolve_static_url_to_path,
    safe_upload_filename,
    uploads_dir,
)
from novelvideo.freezone.presets import (
    build_asset_preset_context,
    build_beat_preset_context,
    build_canvas_payload_from_context,
    build_episode_preset_context,
    canvas_id_for_preset,
    preset_key_for_request,
)
from novelvideo.freezone.route_helpers import (
    FREEZONE_DEFAULT_IMAGE_MODEL,
)
from novelvideo.freezone.route_helpers import (
    accepted_job_response as _accepted_job_response,
)
from novelvideo.freezone.route_helpers import (
    build_erase_prompt as _build_erase_prompt,
)
from novelvideo.freezone.route_helpers import (
    build_multi_view_prompt as _build_multi_view_prompt,
)
from novelvideo.freezone.route_helpers import (
    build_outpaint_prompt as _build_outpaint_prompt,
)
from novelvideo.freezone.route_helpers import (
    build_redraw_prompt as _build_redraw_prompt,
)
from novelvideo.freezone.route_helpers import (
    build_relight_prompt as _build_relight_prompt,
)
from novelvideo.freezone.route_helpers import (
    build_scene_360_prompt as _build_scene_360_prompt,
)
from novelvideo.freezone.route_helpers import (
    build_template_edit_prompt as _build_template_edit_prompt,
)
from novelvideo.freezone.route_helpers import (
    build_upscale_prompt as _build_upscale_prompt,
)
from novelvideo.freezone.route_helpers import (
    get_freezone_image_camera_options as _get_freezone_image_camera_options,
)
from novelvideo.freezone.route_helpers import (
    get_freezone_image_style_templates as _get_freezone_image_style_templates,
)
from novelvideo.freezone.route_helpers import (
    infer_scene_id_from_master_path as _infer_scene_id_from_master_path,
)
from novelvideo.freezone.route_helpers import (
    load_video_character_items_by_ids as _load_video_character_items_by_ids,
)
from novelvideo.freezone.route_helpers import (
    merge_prompt_with_style_and_camera as _merge_prompt_with_style_and_camera,
)
from novelvideo.freezone.route_helpers import (
    new_freezone_job_id as _new_job_id,
)
from novelvideo.freezone.route_helpers import (
    prepare_padded_outpaint_base as _prepare_padded_outpaint_base,
)
from novelvideo.freezone.route_helpers import (
    resolve_freezone_image_provider as _resolve_freezone_image_provider,
)
from novelvideo.freezone.route_helpers import (
    resolve_outpaint_aspect_ratio as _resolve_outpaint_aspect_ratio,
)
from novelvideo.freezone.route_helpers import (
    resolve_url_list as _resolve_url_list,
)
from novelvideo.freezone.route_helpers import (
    split_provider_and_model as _split_provider_and_model,
)
from novelvideo.freezone.route_helpers import (
    template_edit_aspect_ratio as _template_edit_aspect_ratio,
)
from novelvideo.freezone.skill_registry import (
    ResolvedSkillInput,
    SkillDefinition,
    SkillErrorEnvelope,
    SkillInputAcceptSpec,
    SkillRunOutput,
    SkillRunRequest,
    SkillRunResponse,
    SkillRunResult,
    find_skill,
    list_skills,
)
from novelvideo.freezone.slots import (
    IdentityTarget,
    PushTarget,
    backup_slot_if_exists,
    compute_slot_impact,
    is_global_asset_slot,
    record_slot_stale_marks,
    slot_target_path,
    sync_slot_after_write,
    validate_source_for_slot,
)
from novelvideo.freezone.text_node import (
    generate_freezone_story_script,
    translate_freezone_text,
)
from novelvideo.freezone.video_node import (
    add_video_character_library_item,
    build_freezone_image_to_video_prompt,
    build_freezone_keyframe_video_prompt,
    build_freezone_omni_video_prompt,
    build_freezone_video_prompt,
    delete_video_character_library_item,
    get_freezone_video_model_options,
    get_video_camera_template,
    get_video_camera_templates,
    is_freezone_happyhorse_backend,
    is_freezone_seedance2_backend,
    load_video_character_library,
    normalize_freezone_seedance2_scene_optimize,
    normalize_video_aspect_ratio,
    normalize_video_duration_for_backend,
    normalize_video_resolution_for_backend,
    resolve_freezone_video_backend,
    summarize_omni_reference_counts,
    validate_omni_reference_limits,
)
from novelvideo.models import CharacterIdentity, beat_scene_id
from novelvideo.project_config import (
    load_effective_narration_style_for_voice,
    load_narrator_reference_audio,
)
from novelvideo.project_context import (
    ProjectContext,
    require_project_home_node,
    resolve_project_context,
)
from novelvideo.seedance2_i2v.voice_clone import resolve_character_voice
from novelvideo.ports import get_task_backend
from novelvideo.task_backend.limits import ProjectTaskLimitExceeded, ProjectUserTaskLimitExceeded
from novelvideo.task_identity import (
    project_task_state_key,
    selection_scope,
    task_config_scope,
    task_state_key,
)
from novelvideo.task_state import get_task_manager
from novelvideo.utils.background_anchor import copy_to_beat_selected_background
from novelvideo.utils.path_resolver import (
    PathResolver,
    canonical_beat_director_env_only_path,
    canonical_beat_selected_background_path,
    canonical_identity_costume_path,
    canonical_identity_path,
    canonical_identity_portrait_path,
    canonical_portrait_path,
    canonical_prop_reference_path,
    canonical_scene_360_path,
    canonical_scene_master_path,
    canonical_scene_reverse_master_path,
)
from novelvideo.utils.static_urls import project_static_url


async def _resolve_freezone_project(
    project: str,
    user: dict,
    *,
    required_role: str = "editor",
) -> tuple[ProjectContext, str, str, Path, str]:
    ctx = await resolve_project_context(
        user=user,
        project_id=project,
        required_role=required_role,
    )
    require_project_home_node(ctx, operation="access freezone project files")
    return ctx, ctx.owner_username, ctx.project_name, Path(ctx.output_dir), str(ctx.output_dir)


def _raise_project_context_required(task_type: str) -> None:
    raise HTTPException(
        503,
        f"Project context required for {task_type}.",
    )


def _raise_if_task_limit_exception(exc: RuntimeError) -> None:
    if isinstance(exc, (ProjectTaskLimitExceeded, ProjectUserTaskLimitExceeded)):
        raise exc


def _handle_task_start_runtime_error(message: str, exc: RuntimeError) -> None:
    _raise_if_task_limit_exception(exc)
    logger.warning("%s: %s", message, exc, exc_info=True)


async def _start_or_enqueue_freezone_video_gen(
    *,
    ctx: ProjectContext | None,
    username: str,
    project: str,
    project_dir: Path,
    output_dir: str,
    job_id: str,
    prompt: str,
    reference_items: list[dict],
    aspect_ratio: str,
    resolution: str,
    duration_seconds: int,
    generate_audio: bool,
    human_review: bool,
    scene_optimize: str | None,
    backend: str,
    last_frame_path: str | None = None,
    canvas_id: str | None = None,
    node_id: str | None = None,
) -> dict:
    payload = {
        "job_id": job_id,
        "canvas_id": canvas_id or "",
        "node_id": node_id or "",
        "prompt": prompt,
        "reference_items": reference_items,
        "aspect_ratio": aspect_ratio,
        "resolution": resolution,
        "duration_seconds": duration_seconds,
        "generate_audio": generate_audio,
        "human_review": human_review,
        "scene_optimize": normalize_freezone_seedance2_scene_optimize(backend, scene_optimize),
        "backend": backend,
        "last_frame_path": last_frame_path,
        "project_dir": str(project_dir),
    }
    if ctx is not None:
        queued = await get_task_backend().enqueue_project_task(
            ctx,
            task_type="freezone_video_gen",
            queue_kind="video",
            episode=0,
            scope=job_id,
            payload=payload,
        )
        return {
            "ok": True,
            "data": {
                "task_type": "freezone_video_gen",
                "job_id": job_id,
                "task_id": queued.task_state.task_id,
                "task_key": project_task_state_key(
                    "freezone_video_gen", ctx.project_id, 0, scope=job_id
                ),
                "backend": queued.backend,
                "queue": queued.queue,
            },
        }

    _raise_project_context_required("freezone_video_gen")


async def _start_or_enqueue_freezone_image_to_3gs(
    *,
    ctx: ProjectContext | None,
    username: str,
    project: str,
    project_dir: Path,
    job_id: str,
    scene_id: str,
    source_path: Path,
    source_kind: str,
    params: dict,
    canvas_id: str | None = None,
    node_id: str | None = None,
) -> dict:
    task_type = "freezone_image_to_3gs"
    payload = {
        "job_id": job_id,
        "scene_id": scene_id,
        "source_path": str(source_path),
        "source_kind": source_kind,
        "params": params,
        "project_dir": str(project_dir),
        "canvas_id": canvas_id or "",
        "node_id": node_id or "",
    }
    if ctx is not None:
        queued = await get_task_backend().enqueue_project_task(
            ctx,
            task_type=task_type,
            queue_kind="world",
            episode=0,
            scope=job_id,
            payload=payload,
        )
        return {
            "task_id": queued.task_state.task_id,
            "task_key": project_task_state_key(task_type, ctx.project_id, 0, scope=job_id),
            "backend": queued.backend,
            "queue": queued.queue,
        }

    _raise_project_context_required(task_type)


async def _start_or_enqueue_freezone_gen_job(
    *,
    ctx: ProjectContext | None,
    username: str,
    project: str,
    project_dir: Path,
    output_dir: str,
    prompt: str,
    aspect_ratio: str,
    image_size: str,
    reference_urls: list[str],
    camera: FreezoneImageCameraConfig | None,
    style: FreezoneImageStyleConfig | None,
    provider: str | None,
    model: str | None,
    quality: str | None,
    canvas_id: str | None = None,
    node_id: str | None = None,
    task_display: dict[str, str] | None = None,
) -> dict:
    reference_paths = _resolve_url_list(project_dir, reference_urls)
    for path_text in reference_paths:
        if not Path(path_text).exists():
            raise HTTPException(404, f"reference file not found: {path_text}")
    job_id = _new_job_id()
    resolved_provider, resolved_model = _split_provider_and_model(provider, model)
    normalized_provider = _resolve_freezone_image_provider(resolved_provider)
    prompt_text = _merge_prompt_with_style_and_camera(prompt, style, camera)
    display_payload = {
        "task_family": "freezone_canvas",
        "task_label": "自由生成图片",
        "display_name": "自由生成图片",
        **(task_display or {}),
    }
    if ctx is not None:
        queued = await get_task_backend().enqueue_project_task(
            ctx,
            task_type="freezone_gen",
            queue_kind="default",
            episode=0,
            scope=job_id,
            payload={
                "job_id": job_id,
                "project_dir": str(project_dir),
                "prompt": prompt_text,
                "aspect_ratio": aspect_ratio,
                "image_size": image_size,
                "reference_paths": reference_paths,
                "provider": normalized_provider,
                "model": resolved_model,
                "quality": quality,
                "canvas_id": canvas_id or "",
                "node_id": node_id or "",
                **display_payload,
            },
        )
        return {
            "ok": True,
            "data": {
                "task_type": "freezone_gen",
                "job_id": job_id,
                "task_id": queued.task_state.task_id,
                "task_key": project_task_state_key("freezone_gen", ctx.project_id, 0, scope=job_id),
                "backend": queued.backend,
                "queue": queued.queue,
            },
        }

    _raise_project_context_required("freezone_gen")


async def _load_freezone_beat_context(
    *,
    ctx: ProjectContext | None,
    username: str,
    project: str,
    episode: int,
    beat: int,
) -> dict:
    store = (
        await make_sqlite_store_for_context(ctx)
        if ctx is not None
        else make_sqlite_store(username, project)
    )
    beats = await store.get_beats_as_dicts(int(episode))
    for row in beats:
        if int(row.get("beat_number") or 0) == int(beat):
            return row
    raise HTTPException(404, f"beat not found: ep={episode} beat={beat}")


def _scene_ref_label(beat: dict) -> str:
    scene_ref = beat.get("scene_ref")
    if isinstance(scene_ref, dict):
        return str(scene_ref.get("name") or scene_ref.get("scene_name") or "").strip()
    if scene_ref:
        return str(scene_ref).strip()
    return ""


async def _collect_mainline_typed_reference_urls(
    *,
    ctx: ProjectContext,
    username: str,
    project_name: str,
    project_dir: Path,
    beat: dict,
    include_identities: bool = True,
    include_props: bool = True,
    include_scene_master: bool = False,
    include_scene_reverse: bool = False,
) -> list[str]:
    """Auto-inject mainline-authoritative reference images for typed actions.

    Design contract: mainline canvas projection = DB live mirror. Whatever
    references this beat declares (detected_identities / detected_props /
    scene_ref) should be passed to the LLM as visual references, not just
    mentioned in the prompt text. Source of truth is the DB; this helper
    derives URLs from canonical asset paths so the LLM "sees" the same set
    of refs the canvas projects visually (identity nodes / prop nodes /
    scene nodes connected to the mainline skill node).

    Without this, prior behavior was:
      - prompt text included "角色身份: A, B" but no PNG was uploaded,
      - LLM had no visual anchor for identity / prop -> identity drift,
      - users found this surprising ("我标了 detected_identities 为什么没用").
    """
    from novelvideo.freezone.presets import _identity_character, _identity_name

    refs: list[str] = []

    store = await make_sqlite_store_for_context(ctx)

    if include_identities:
        known_character_names: list[str] = []
        character_age_by_name: dict[str, str] = {}
        identity_age_by_id: dict[str, str] = {}
        try:
            characters = await store.list_characters()  # type: ignore[attr-defined]
            for c in characters or []:
                name = getattr(c, "name", None) or (c.get("name") if isinstance(c, dict) else None)
                if not name:
                    continue
                name = str(name)
                known_character_names.append(name)
                # 记录 character 默认 age_group + 每个 identity 自己的 age_group,
                # 用于判定 age variant(identity.age_group ≠ character.age_group 即变体)。
                char_age = str(
                    getattr(c, "age_group", "")
                    or (c.get("age_group") if isinstance(c, dict) else "")
                    or ""
                ).strip()
                if char_age:
                    character_age_by_name[name] = char_age
                identities_iter = (
                    getattr(c, "identities", None)
                    or (c.get("identities") if isinstance(c, dict) else None)
                    or []
                )
                for ident in identities_iter:
                    ident_id = str(
                        getattr(ident, "identity_id", "")
                        or (ident.get("identity_id") if isinstance(ident, dict) else "")
                        or ""
                    ).strip()
                    ident_age = str(
                        getattr(ident, "age_group", "")
                        or (ident.get("age_group") if isinstance(ident, dict) else "")
                        or ""
                    ).strip()
                    if ident_id and ident_age:
                        identity_age_by_id[ident_id] = ident_age
        except Exception:
            pass

        for identity_id in beat.get("detected_identities") or []:
            identity_id = str(identity_id or "").strip()
            if not identity_id:
                continue
            character = _identity_character(identity_id, known_character_names)
            identity_name = _identity_name(identity_id, character)
            path = canonical_identity_path(project_dir, character, identity_name)
            if not path.exists() or not path.is_file():
                # Age variant identity (identity.age_group ≠ character.age_group)
                # 缺自己的 canonical 时,**不** fallback 到主 character portrait —
                # 主 portrait 通常是 youth 形态,中年/老年变体拿它当 reference 会
                # 触发 identity drift (LLM 看到 youth 脸 → 产出 youth-like)。
                # 跟 presets.py:4229 age-variant fallback 规则保持一致。
                identity_age = identity_age_by_id.get(identity_id, "")
                char_age = character_age_by_name.get(character, "")
                is_age_variant = bool(identity_age and identity_age != char_age)
                if is_age_variant:
                    continue  # 这次 inject 跳过这个 identity ref;LLM 靠 prompt 文字解析
                # fallback to character portrait so LLM at least has a face
                path = canonical_portrait_path(project_dir, character)
            if path.exists() and path.is_file():
                try:
                    rel = path.relative_to(project_dir).as_posix()
                except ValueError:
                    continue
                url = make_static_url_for_context(ctx, rel, local_path=path)
                if url:
                    refs.append(url)

    if include_props:
        for prop_id in beat.get("detected_props") or []:
            prop_id = str(prop_id or "").strip()
            if not prop_id:
                continue
            path = canonical_prop_reference_path(project_dir, prop_id)
            if path.exists() and path.is_file():
                try:
                    rel = path.relative_to(project_dir).as_posix()
                except ValueError:
                    continue
                url = make_static_url_for_context(ctx, rel, local_path=path)
                if url:
                    refs.append(url)

    if include_scene_master or include_scene_reverse:
        scene_name = ""
        scene_ref = beat.get("scene_ref")
        if isinstance(scene_ref, dict):
            scene_name = str(
                scene_ref.get("scene_id")
                or scene_ref.get("name")
                or scene_ref.get("scene_name")
                or ""
            ).strip()
        elif scene_ref:
            scene_name = str(scene_ref).strip()
        if scene_name:
            scene_paths: list[Path] = []
            if include_scene_master:
                scene_paths.append(canonical_scene_master_path(project_dir, scene_name))
            if include_scene_reverse:
                scene_paths.append(canonical_scene_reverse_master_path(project_dir, scene_name))
            for p in scene_paths:
                if p.exists() and p.is_file():
                    try:
                        rel = p.relative_to(project_dir).as_posix()
                    except ValueError:
                        continue
                    url = make_static_url_for_context(ctx, rel, local_path=p)
                    if url:
                        refs.append(url)

    return refs


def _skill_beat_context_as_prompt_beat(input_item: ResolvedSkillInput | None) -> dict:
    beat_context = (input_item.beat_context if input_item else None) or {}
    scene_id = (
        beat_context.get("scene_id")
        or beat_context.get("sceneId")
        or beat_context.get("scene_name")
        or beat_context.get("sceneName")
        or ""
    )
    scene_ref = {"scene_id": scene_id, "name": scene_id} if scene_id else None
    visual_description = (
        beat_context.get("visual_description")
        or beat_context.get("visualDescription")
        or beat_context.get("content")
        or ""
    )
    detected_identities = (
        beat_context.get("detected_identities") or beat_context.get("detectedIdentities") or []
    )
    if str(beat_context.get("source") or "").strip().lower() == "standalone":
        visual_description = _standalone_beat_context_prompt_visual_description(
            str(visual_description or ""), beat_context
        )
        identity_map = _standalone_beat_context_prompt_identity_map(beat_context)
        detected_identities = [
            identity_map.get(str(item).strip(), str(item).strip())
            for item in detected_identities
            if str(item).strip()
        ]

    return {
        "episode_number": beat_context.get("episode") or beat_context.get("episode_number"),
        "beat_number": beat_context.get("beat") or beat_context.get("beat_number"),
        "scene_ref": scene_ref,
        "visual_description": visual_description,
        "narration_segment": (
            beat_context.get("narration_segment") or beat_context.get("narrationSegment") or ""
        ),
        "detected_identities": detected_identities,
        "detected_props": beat_context.get("detected_props")
        or beat_context.get("detectedProps")
        or [],
    }


def _is_standalone_beat_context_input(input_item: ResolvedSkillInput | None) -> bool:
    beat_context = (input_item.beat_context if input_item else None) or {}
    source = str(beat_context.get("source") or "").strip().lower()
    return source == "standalone"


def _list_text_values(value: object) -> list[str]:
    if not isinstance(value, list):
        return []
    return [str(item).strip() for item in value if str(item).strip()]


def _standalone_beat_context_sketch_colors(beat_context: dict) -> dict[str, str]:
    value = beat_context.get("sketch_colors") or beat_context.get("sketchColors") or {}
    return dict(value) if isinstance(value, dict) else {}


def _standalone_beat_context_prop_marker_colors(beat_context: dict) -> dict[str, str]:
    value = beat_context.get("prop_marker_colors") or beat_context.get("propMarkerColors") or {}
    return dict(value) if isinstance(value, dict) else {}


def _standalone_identity_prompt_parts(identity_name: str) -> tuple[str, str, str]:
    identity_name = identity_name.strip()
    if "_" in identity_name:
        char_name, suffix = identity_name.split("_", 1)
        char_name = char_name.strip()
        suffix = suffix.strip()
        if char_name and suffix:
            return char_name, suffix, identity_name
    return identity_name, identity_name, f"{identity_name}_{identity_name}"


def _standalone_beat_context_prompt_identity_map(beat_context: dict) -> dict[str, str]:
    identity_names = _list_text_values(
        beat_context.get("detected_identities") or beat_context.get("detectedIdentities")
    )
    return {
        identity_name: _standalone_identity_prompt_parts(identity_name)[2]
        for identity_name in identity_names
    }


def _standalone_beat_context_prompt_visual_description(
    visual_description: str, beat_context: dict
) -> str:
    identity_map = _standalone_beat_context_prompt_identity_map(beat_context)
    if not identity_map:
        return visual_description

    def replace_marker(match: re.Match) -> str:
        marker = str(match.group(1) or "").strip()
        return "{{" + identity_map.get(marker, marker) + "}}"

    return re.sub(r"\{\{([^}]+)\}\}", replace_marker, visual_description)


def _standalone_beat_context_character_map(beat_context: dict) -> dict[str, dict]:
    sketch_colors = _standalone_beat_context_sketch_colors(beat_context)
    identity_names = _list_text_values(
        beat_context.get("detected_identities") or beat_context.get("detectedIdentities")
    )
    character_map: dict[str, dict] = {}
    for identity_name in identity_names:
        char_name, suffix, _prompt_identity_id = _standalone_identity_prompt_parts(identity_name)
        entry = character_map.setdefault(
            char_name,
            {
                "base_prompt": char_name,
                "reference_mode": "prompt_only",
                "sketch_color": "",
                "identity_appearances": {},
                "identity_sketch_colors": {},
            },
        )
        color = sketch_colors.get(identity_name) or sketch_colors.get(char_name) or ""
        entry["identity_appearances"][suffix] = identity_name
        if color:
            entry["identity_sketch_colors"][suffix] = color
            entry["sketch_color"] = entry["sketch_color"] or color
    return character_map


def _standalone_beat_context_unified_sketch_prompt(
    *,
    input_item: ResolvedSkillInput | None,
    project_dir: Path,
    reference_path: str,
    reference_role: str,
    aspect_ratio: str,
    provider: str | None = None,
    model: str | None = None,
) -> str:
    from novelvideo.generators.prompt_builder import (
        PromptMode,
        UnifiedPromptBuilder,
        create_prompt_context,
    )
    from novelvideo.utils.asset_resolver import ResolvedAssetRef

    beat_context = (input_item.beat_context if input_item else None) or {}
    beat_payload = dict(_skill_beat_context_as_prompt_beat(input_item))

    is_director_combined = reference_role == "director_combined"
    scene_id = _first_text_value(
        beat_context, ("scene_id", "sceneId", "scene_name", "sceneName", "title", "name")
    )
    ref = ResolvedAssetRef(
        asset_type="scene",
        base_id=scene_id or "Canvas Beat Context",
        variant_id=reference_role,
        image_paths=[reference_path] if reference_path else [],
        text_description="" if is_director_combined else scene_id,
        source_level="director_image" if is_director_combined else "selected_background_image",
    )
    ctx = create_prompt_context(
        mode=PromptMode.SKETCH,
        beats=[beat_payload],
        rows=1,
        cols=1,
        character_map=_standalone_beat_context_character_map(beat_context),
        aspect_ratio=aspect_ratio,
        scene_refs={1: [ref]},
        sketch_colors=_standalone_beat_context_sketch_colors(beat_context),
        prop_marker_colors=_standalone_beat_context_prop_marker_colors(beat_context),
        project_dir=str(project_dir),
        image_provider=provider or "",
        image_model=model or "",
    )
    return UnifiedPromptBuilder(ctx).build()


def _beat_by_number(beats: list[dict], beat_number: int) -> dict:
    for beat in beats:
        try:
            if int(beat.get("beat_number") or 0) == int(beat_number):
                return beat
        except (TypeError, ValueError):
            continue
    raise HTTPException(404, f"beat not found: {beat_number}")


def _normalize_mainline_skill_aspect_ratio(value: object) -> str:
    raw = str(value or "").strip()
    if raw in {"16:9", "16-9", "landscape"}:
        return "16:9"
    if raw in {"", "2:3", "2-3", "portrait"}:
        return "2:3"
    _raise_skill_error(
        422,
        code="skill_parameter_aspect_ratio_invalid",
        category="validation",
        message="aspect_ratio must be '2:3' or '16:9'",
        user_action_hint="Choose 2:3 or 16:9 before running the skill.",
    )


def _normalize_mainline_frame_quality(value: object) -> str:
    raw = str(value or "").strip().lower()
    if not raw:
        return "medium"
    if raw in {"low", "medium", "high"}:
        return raw
    _raise_skill_error(
        422,
        code="skill_parameter_quality_invalid",
        category="validation",
        message="quality must be low, medium, or high",
        user_action_hint="Choose low, medium, or high before running the skill.",
    )


def _mainline_mode_key_for_aspect(aspect_ratio: object, *, is_sketch: bool) -> str:
    normalized = _normalize_mainline_skill_aspect_ratio(aspect_ratio)
    if normalized == "16:9":
        return "1x1_16-9_sketch" if is_sketch else "1x1_16-9"
    return "1x1_2-3_sketch" if is_sketch else "1x1_2-3"


def _mainline_skill_aspect_ratio_from_image(path: str | Path) -> str:
    from PIL import Image

    try:
        with Image.open(path) as image:
            width, height = image.size
    except Exception:
        return "2:3"
    if width <= 0 or height <= 0:
        return "2:3"
    ratio = width / height
    portrait_delta = abs(ratio - (2 / 3))
    landscape_delta = abs(ratio - (16 / 9))
    return "16:9" if landscape_delta < portrait_delta else "2:3"


def _skill_run_parameters(body: SkillRunRequest) -> dict[str, object]:
    return dict(body.parameters if isinstance(body.parameters, dict) else {})


def _skill_background_reference_mode(parameters: dict[str, object]) -> str:
    value = str(parameters.get("background_reference_mode") or "").strip()
    if value in {"material_only", "scene_anchor"}:
        return value
    legacy_repair_value = parameters.get("repair_background_perspective")
    if legacy_repair_value is False:
        return "scene_anchor"
    return "material_only"


async def _mainline_single_beat_config(
    *,
    ctx: ProjectContext,
    username: str,
    project_name: str,
    episode: int,
    beat: int,
    mode_key: str,
    aspect_ratio: str,
    is_sketch: bool,
) -> dict:
    from novelvideo.api.routes.generation import (
        _build_character_map,
        _episode_from_store_or_none,
        _resolve_render_bool_setting,
        _resolve_render_image_selection,
        _resolve_sketch_image_selection,
        _runtime_prop_menu_with_global_props,
    )
    from novelvideo.project_config import load_project_config

    store = await make_sqlite_store_for_context(ctx)
    beats = await store.get_beats_as_dicts(int(episode))
    if not beats:
        raise HTTPException(404, f"No beats found for episode {episode}")
    selected_beat = _beat_by_number(beats, int(beat))
    project_config = load_project_config(username, project_name)
    episode_obj = _episode_from_store_or_none(store, int(episode))
    prop_menu = await _runtime_prop_menu_with_global_props(store, episode_obj, beats)
    sketch_colors = (
        store.get_sketch_colors(int(episode)) or {} if hasattr(store, "get_sketch_colors") else {}
    )
    if is_sketch:
        character_map = (
            await _build_character_map(
                store,
                beats,
                username,
                project_name,
                episode_num=int(episode),
                use_detected_identities=False,
            )
            if hasattr(store, "get_all_characters")
            else {}
        )
        image_selection = _resolve_sketch_image_selection(project_config, None)
        return {
            "beats": beats,
            "character_map": character_map,
            "style": project_config.get("visual_style", "chinese_period_drama"),
            "ethnicity": project_config.get("ethnicity", "Chinese"),
            "model": None,
            "image_generation_selection": image_selection,
            "sketch_colors": sketch_colors,
            "prop_menu": prop_menu,
            "direct_sketch_beats": True,
            "beat_numbers": [int(beat)],
            "mode_key": mode_key,
            "aspect_ratio": aspect_ratio,
        }

    character_map = (
        await _build_character_map(
            store,
            [selected_beat],
            username,
            project_name,
            episode_num=int(episode),
            use_detected_identities=True,
        )
        if hasattr(store, "get_all_characters")
        else {}
    )
    image_selection = _resolve_render_image_selection(project_config, None)
    return {
        "beats": beats,
        "character_map": character_map,
        "style": project_config.get("visual_style", "chinese_period_drama"),
        "ethnicity": project_config.get("ethnicity", "Chinese"),
        "model": None,
        "image_generation_selection": image_selection,
        "selected_beat_numbers": [int(beat)],
        "sketch_colors": sketch_colors,
        "prop_menu": prop_menu,
        "sketch_aspect_padding": _resolve_render_bool_setting(
            project_config,
            "sketch_aspect_padding",
            None,
            True,
        ),
        "mode_key": mode_key,
        "aspect_ratio": aspect_ratio,
    }


async def _start_or_enqueue_mainline_sketch_from_context_job(
    *,
    ctx: ProjectContext,
    username: str,
    project_name: str,
    project_dir: Path,
    episode: int,
    beat: int,
    beat_payload: dict | None,
    background_url: str,
    aspect_ratio: str = "2:3",
    canvas_id: str | None = None,
    node_id: str | None = None,
    task_display: dict[str, str] | None = None,
) -> dict:
    task_type = "mainline_sketch_from_context"
    mode_key = _mainline_mode_key_for_aspect(aspect_ratio, is_sketch=True)
    base_paths = _resolve_url_list(project_dir, [background_url])
    if not base_paths:
        raise HTTPException(400, "background_url is required")
    for path_text in base_paths:
        if not Path(path_text).exists():
            raise HTTPException(404, f"base file not found: {path_text}")
    config = await _mainline_single_beat_config(
        ctx=ctx,
        username=username,
        project_name=project_name,
        episode=int(episode),
        beat=int(beat),
        mode_key=mode_key,
        aspect_ratio=_normalize_mainline_skill_aspect_ratio(aspect_ratio),
        is_sketch=True,
    )
    effective_beat = dict(beat_payload or {})
    if effective_beat:
        effective_beat["episode_number"] = int(episode)
        effective_beat["beat_number"] = int(beat)
        config["beats"] = [effective_beat]
    config["promote_direct_sketch"] = False
    scene_ref = (effective_beat.get("scene_ref") or {}) if effective_beat else {}
    scene_id = str(scene_ref.get("scene_id") or scene_ref.get("name") or "").strip()
    config["canvas_scene_refs"] = [
        {
            "beat_number": int(beat),
            "image_path": base_paths[0],
            "base_id": scene_id or "canvas background",
            "label": str((task_display or {}).get("source_label") or "背景"),
            "source_level": "selected_background_image",
        }
    ]
    job_id = _new_job_id()
    display_payload = {
        "task_family": "mainline_skill",
        "task_label": "生成草图",
        "display_name": "生成草图",
        **(task_display or {}),
    }
    if ctx is not None:
        queued = await get_task_backend().enqueue_project_task(
            ctx,
            task_type=task_type,
            queue_kind="default",
            episode=int(episode),
            beat_num=int(beat),
            scope=job_id,
            payload={
                "job_id": job_id,
                "episode": int(episode),
                "beat_num": int(beat),
                "output_dir": str(project_dir),
                "config": config,
                "canvas_id": canvas_id or "",
                "node_id": node_id or "",
                **display_payload,
            },
        )
        return _project_job_response(
            task_type=task_type,
            ctx=ctx,
            job_id=job_id,
            backend=queued.backend,
            queue=queued.queue,
            task_id=queued.task_state.task_id,
            episode=int(episode),
            beat_num=int(beat),
            scope=job_id,
        )

    _raise_project_context_required(task_type)


async def _start_or_enqueue_mainline_frame_from_context_job(
    *,
    ctx: ProjectContext,
    username: str,
    project_name: str,
    project_dir: Path,
    episode: int,
    beat: int,
    beat_payload: dict | None,
    sketch_url: str,
    reference_urls: list[str],
    extra_reference_urls: list[str] | None = None,
    identity_references: list[dict] | None = None,
    prop_references: list[dict] | None = None,
    aspect_ratio: str = "2:3",
    quality: str = "medium",
    background_reference_mode: str = "material_only",
    canvas_id: str | None = None,
    node_id: str | None = None,
    task_display: dict[str, str] | None = None,
) -> dict:
    task_type = "mainline_frame_from_context"
    sketch_paths = _resolve_url_list(project_dir, [sketch_url])
    if not sketch_paths:
        raise HTTPException(400, "sketch_url is required")
    for path_text in sketch_paths:
        if not Path(path_text).exists():
            raise HTTPException(404, f"sketch file not found: {path_text}")
    inferred_aspect_ratio = _mainline_skill_aspect_ratio_from_image(sketch_paths[0])
    mode_key = _mainline_mode_key_for_aspect(inferred_aspect_ratio, is_sketch=False)
    reference_paths = _resolve_url_list(project_dir, reference_urls)
    extra_reference_paths = _resolve_url_list(project_dir, extra_reference_urls or [])
    resolved_identity_refs: list[dict] = []
    for item in identity_references or []:
        image_paths = _resolve_url_list(project_dir, [str(item.get("image_url") or "")])
        if image_paths:
            resolved_identity_refs.append({**item, "image_path": image_paths[0]})
    resolved_prop_refs: list[dict] = []
    for item in prop_references or []:
        image_paths = _resolve_url_list(project_dir, [str(item.get("image_url") or "")])
        if image_paths:
            resolved_prop_refs.append({**item, "image_path": image_paths[0]})
    for path_text in [
        *reference_paths,
        *extra_reference_paths,
        *[str(item["image_path"]) for item in resolved_identity_refs],
        *[str(item["image_path"]) for item in resolved_prop_refs],
    ]:
        if not Path(path_text).exists():
            raise HTTPException(404, f"reference file not found: {path_text}")
    config = await _mainline_single_beat_config(
        ctx=ctx,
        username=username,
        project_name=project_name,
        episode=int(episode),
        beat=int(beat),
        mode_key=mode_key,
        aspect_ratio=inferred_aspect_ratio,
        is_sketch=False,
    )
    effective_beat = dict(beat_payload or {})
    if effective_beat:
        effective_beat["episode_number"] = int(episode)
        effective_beat["beat_number"] = int(beat)
        config["beats"] = [effective_beat]
    config["promote_selected_regen"] = False
    config["image_quality"] = _normalize_mainline_frame_quality(quality)
    config["canvas_sketch_paths"] = {str(int(beat)): sketch_paths[0]}
    canvas_refs: list[dict] = []
    scene_ref = (effective_beat.get("scene_ref") or {}) if effective_beat else {}
    scene_id = str(scene_ref.get("scene_id") or scene_ref.get("name") or "").strip()
    if reference_paths:
        background_ref = {
            "beat_number": int(beat),
            "image_path": reference_paths[0],
            "base_id": scene_id or "canvas background",
            "label": "背景",
            "source_level": "selected_background_image",
        }
        if background_reference_mode == "material_only":
            background_ref["reference_mode"] = "material_only"
        canvas_refs.append(background_ref)
    generic_ref_index = 1
    for item in resolved_identity_refs:
        identity_id = str(item.get("identity_id") or "").strip()
        if identity_id:
            config.setdefault("canvas_identity_refs", []).append(
                {
                    "beat_number": int(beat),
                    "identity_id": identity_id,
                    "image_path": item["image_path"],
                    "reference_mode": (
                        "portrait_only"
                        if str(item.get("slot_kind") or "") == "portrait"
                        else "composite"
                    ),
                }
            )
            continue
        canvas_refs.append(
            {
                "beat_number": int(beat),
                "image_path": item["image_path"],
                "base_id": f"canvas reference {generic_ref_index}",
                "label": f"画布参考 {generic_ref_index}",
                "source_level": "canvas_reference_image",
            }
        )
        generic_ref_index += 1
    for item in resolved_prop_refs:
        prop_id = str(item.get("prop_id") or "").strip()
        if prop_id:
            config.setdefault("canvas_prop_refs", []).append(
                {
                    "beat_number": int(beat),
                    "prop_id": prop_id,
                    "image_path": item["image_path"],
                    "source_level": "canvas_prop_reference_image",
                }
            )
            continue
        canvas_refs.append(
            {
                "beat_number": int(beat),
                "image_path": item["image_path"],
                "base_id": f"canvas reference {generic_ref_index}",
                "label": f"画布参考 {generic_ref_index}",
                "source_level": "canvas_reference_image",
            }
        )
        generic_ref_index += 1
    for path_text in extra_reference_paths:
        canvas_refs.append(
            {
                "beat_number": int(beat),
                "image_path": path_text,
                "base_id": f"canvas reference {generic_ref_index}",
                "label": f"画布参考 {generic_ref_index}",
                "source_level": "canvas_reference_image",
            }
        )
        generic_ref_index += 1
    if canvas_refs:
        config["canvas_scene_refs"] = canvas_refs
    job_id = _new_job_id()
    display_payload = {
        "task_family": "mainline_skill",
        "task_label": "渲染分镜",
        "display_name": "渲染分镜",
        **(task_display or {}),
    }
    if ctx is not None:
        queued = await get_task_backend().enqueue_project_task(
            ctx,
            task_type=task_type,
            queue_kind="default",
            episode=int(episode),
            beat_num=int(beat),
            scope=job_id,
            payload={
                "job_id": job_id,
                "episode": int(episode),
                "beat_num": int(beat),
                "output_dir": str(project_dir),
                "mode_key": mode_key,
                "config": config,
                "canvas_id": canvas_id or "",
                "node_id": node_id or "",
                **display_payload,
            },
        )
        return _project_job_response(
            task_type=task_type,
            ctx=ctx,
            job_id=job_id,
            backend=queued.backend,
            queue=queued.queue,
            task_id=queued.task_state.task_id,
            episode=int(episode),
            beat_num=int(beat),
            scope=job_id,
        )

    _raise_project_context_required(task_type)


def _standalone_beat_context_frame_config(
    *,
    username: str,
    project_name: str,
    beat_payload: dict | None,
    mode_key: str,
    aspect_ratio: str,
    quality: str,
) -> dict:
    from novelvideo.api.routes.generation import (
        _resolve_render_bool_setting,
        _resolve_render_image_selection,
    )
    from novelvideo.project_config import load_project_config

    project_config = load_project_config(username, project_name)
    beat = dict(beat_payload or {})
    beat.pop("_source_beat_context", None)
    if beat:
        beat["episode_number"] = 0
        beat["beat_number"] = 0
        beat["panel_index"] = 0
    return {
        "standalone_beat_context": True,
        "beats": [beat] if beat else [],
        "character_map": _standalone_beat_context_character_map(
            (beat_payload or {}).get("_source_beat_context") or {}
        ),
        "style": project_config.get("visual_style", "chinese_period_drama"),
        "ethnicity": project_config.get("ethnicity", "Chinese"),
        "model": None,
        "image_generation_selection": _resolve_render_image_selection(project_config, None),
        "selected_panel_indices": [0],
        "sketch_colors": _standalone_beat_context_sketch_colors(
            (beat_payload or {}).get("_source_beat_context") or {}
        ),
        "prop_marker_colors": _standalone_beat_context_prop_marker_colors(
            (beat_payload or {}).get("_source_beat_context") or {}
        ),
        "prop_menu": [
            {"prop_id": prop_id, "name": prop_id}
            for prop_id in _list_text_values(
                ((beat_payload or {}).get("_source_beat_context") or {}).get("detected_props")
            )
        ],
        "sketch_aspect_padding": _resolve_render_bool_setting(
            project_config,
            "sketch_aspect_padding",
            None,
            True,
        ),
        "mode_key": mode_key,
        "aspect_ratio": aspect_ratio,
        "promote_selected_regen": False,
        "image_quality": _normalize_mainline_frame_quality(quality),
    }


async def _start_or_enqueue_standalone_frame_from_context_job(
    *,
    ctx: ProjectContext,
    username: str,
    project_name: str,
    project_dir: Path,
    beat_input: ResolvedSkillInput,
    sketch_url: str,
    reference_urls: list[str],
    extra_reference_urls: list[str] | None = None,
    identity_references: list[dict] | None = None,
    prop_references: list[dict] | None = None,
    quality: str = "medium",
    background_reference_mode: str = "material_only",
    canvas_id: str | None = None,
    node_id: str | None = None,
    task_display: dict[str, str] | None = None,
) -> dict:
    task_type = "mainline_frame_from_context"
    sketch_paths = _resolve_url_list(project_dir, [sketch_url])
    if not sketch_paths:
        raise HTTPException(400, "sketch_url is required")
    for path_text in sketch_paths:
        if not Path(path_text).exists():
            raise HTTPException(404, f"sketch file not found: {path_text}")
    inferred_aspect_ratio = _mainline_skill_aspect_ratio_from_image(sketch_paths[0])
    mode_key = _mainline_mode_key_for_aspect(inferred_aspect_ratio, is_sketch=False)
    reference_paths = _resolve_url_list(project_dir, reference_urls)
    extra_reference_paths = _resolve_url_list(project_dir, extra_reference_urls or [])
    resolved_identity_refs: list[dict] = []
    for item in identity_references or []:
        image_paths = _resolve_url_list(project_dir, [str(item.get("image_url") or "")])
        if image_paths:
            resolved_identity_refs.append({**item, "image_path": image_paths[0]})
    resolved_prop_refs: list[dict] = []
    for item in prop_references or []:
        image_paths = _resolve_url_list(project_dir, [str(item.get("image_url") or "")])
        if image_paths:
            resolved_prop_refs.append({**item, "image_path": image_paths[0]})
    for path_text in [
        *reference_paths,
        *extra_reference_paths,
        *[str(item["image_path"]) for item in resolved_identity_refs],
        *[str(item["image_path"]) for item in resolved_prop_refs],
    ]:
        if not Path(path_text).exists():
            raise HTTPException(404, f"reference file not found: {path_text}")
    source_beat_context = dict((beat_input.beat_context if beat_input else None) or {})
    beat_payload = {
        **_skill_beat_context_as_prompt_beat(beat_input),
        "_source_beat_context": source_beat_context,
    }
    config = _standalone_beat_context_frame_config(
        username=username,
        project_name=project_name,
        beat_payload=beat_payload,
        mode_key=mode_key,
        aspect_ratio=inferred_aspect_ratio,
        quality=quality,
    )
    config["canvas_sketch_paths"] = {"0": sketch_paths[0]}
    canvas_refs: list[dict] = []
    scene_ref = beat_payload.get("scene_ref") or {}
    scene_id = str(scene_ref.get("scene_id") or scene_ref.get("name") or "").strip()
    if reference_paths:
        background_ref = {
            "panel_index": 0,
            "image_path": reference_paths[0],
            "base_id": scene_id or "canvas background",
            "label": "背景",
            "source_level": "selected_background_image",
        }
        if background_reference_mode == "material_only":
            background_ref["reference_mode"] = "material_only"
        canvas_refs.append(background_ref)
    generic_ref_index = 1
    for item in resolved_identity_refs:
        identity_id = str(item.get("identity_id") or "").strip()
        if identity_id:
            config.setdefault("canvas_identity_refs", []).append(
                {
                    "panel_index": 0,
                    "identity_id": identity_id,
                    "image_path": item["image_path"],
                    "reference_mode": (
                        "portrait_only"
                        if str(item.get("slot_kind") or "") == "portrait"
                        else "composite"
                    ),
                }
            )
            continue
        canvas_refs.append(
            {
                "panel_index": 0,
                "image_path": item["image_path"],
                "base_id": f"canvas reference {generic_ref_index}",
                "label": f"画布参考 {generic_ref_index}",
                "source_level": "canvas_reference_image",
            }
        )
        generic_ref_index += 1
    for item in resolved_prop_refs:
        prop_id = str(item.get("prop_id") or "").strip()
        if prop_id:
            config.setdefault("canvas_prop_refs", []).append(
                {
                    "panel_index": 0,
                    "prop_id": prop_id,
                    "image_path": item["image_path"],
                    "source_level": "canvas_prop_reference_image",
                }
            )
            continue
        canvas_refs.append(
            {
                "panel_index": 0,
                "image_path": item["image_path"],
                "base_id": f"canvas reference {generic_ref_index}",
                "label": f"画布参考 {generic_ref_index}",
                "source_level": "canvas_reference_image",
            }
        )
        generic_ref_index += 1
    for path_text in extra_reference_paths:
        canvas_refs.append(
            {
                "panel_index": 0,
                "image_path": path_text,
                "base_id": f"canvas reference {generic_ref_index}",
                "label": f"画布参考 {generic_ref_index}",
                "source_level": "canvas_reference_image",
            }
        )
        generic_ref_index += 1
    if canvas_refs:
        config["canvas_scene_refs"] = canvas_refs
    job_id = _new_job_id()
    display_payload = {
        "task_family": "mainline_skill",
        "task_label": "渲染分镜",
        "display_name": "渲染分镜",
        **(task_display or {}),
    }
    if ctx is not None:
        queued = await get_task_backend().enqueue_project_task(
            ctx,
            task_type=task_type,
            queue_kind="default",
            episode=0,
            scope=job_id,
            payload={
                "job_id": job_id,
                "episode": 0,
                "output_dir": str(project_dir),
                "mode_key": mode_key,
                "config": config,
                "canvas_id": canvas_id or "",
                "node_id": node_id or "",
                **display_payload,
            },
        )
        return _project_job_response(
            task_type=task_type,
            ctx=ctx,
            job_id=job_id,
            backend=queued.backend,
            queue=queued.queue,
            task_id=queued.task_state.task_id,
            episode=0,
            scope=job_id,
        )

    _raise_project_context_required(task_type)


async def _start_or_enqueue_mainline_direct_sketch_task(
    *,
    ctx: ProjectContext,
    username: str,
    project_name: str,
    project_dir: Path,
    episode: int,
    beat: int,
    canvas_id: str | None = None,
    node_id: str | None = None,
    task_display: dict[str, str] | None = None,
) -> dict:
    from novelvideo.api.routes.generation import _director_control_scope

    task_type = "sketch_generation"
    scope = _director_control_scope(int(episode), int(beat))
    queued = await get_task_backend().enqueue_project_task(
        ctx,
        task_type=task_type,
        queue_kind="default",
        episode=int(episode),
        beat_num=int(beat),
        scope=scope,
        payload={
            "task_kind": "director_control_to_sketch",
            "episode": int(episode),
            "beat_num": int(beat),
            "output_dir": str(project_dir),
            "state_dir": str(ctx.state_dir),
            "canvas_id": canvas_id or "",
            "node_id": node_id or "",
            "task_family": "mainline_skill",
            "task_label": "导演合成图转草图",
            "display_name": f"导演合成图转草图 · EP{episode} / Beat {beat}",
            "source_label": "导演合成图",
            "target_label": "当前草图",
            **(task_display or {}),
        },
    )
    return _project_job_response(
        task_type=task_type,
        ctx=ctx,
        job_id=scope,
        backend=queued.backend,
        queue=queued.queue,
        task_id=queued.task_state.task_id,
        episode=int(episode),
        beat_num=int(beat),
        scope=scope,
    )


async def _start_or_enqueue_mainline_director_control_sketch_job(
    *,
    ctx: ProjectContext,
    project_dir: Path,
    episode: int,
    beat: int,
    director_combined_url: str,
    aspect_ratio: str = "2:3",
    canvas_id: str | None,
    node_id: str | None,
    task_display: dict[str, str] | None = None,
) -> dict:
    task_type = "mainline_director_control_sketch"
    source_paths = _resolve_url_list(project_dir, [director_combined_url])
    if not source_paths:
        raise HTTPException(400, "director_combined_url is required")
    source_path = Path(source_paths[0])
    if not source_path.exists() or not source_path.is_file():
        raise HTTPException(404, f"director combined file not found: {source_path}")
    job_id = _new_job_id()
    queued = await get_task_backend().enqueue_project_task(
        ctx,
        task_type=task_type,
        queue_kind="default",
        episode=int(episode),
        beat_num=int(beat),
        scope=job_id,
        payload={
            "job_id": job_id,
            "episode": int(episode),
            "beat_num": int(beat),
            "project_dir": str(project_dir),
            "state_dir": str(ctx.state_dir),
            "control_frame_path": str(source_path),
            "mode_key": _mainline_mode_key_for_aspect(aspect_ratio, is_sketch=True),
            "aspect_ratio": _normalize_mainline_skill_aspect_ratio(aspect_ratio),
            "canvas_id": canvas_id or "",
            "node_id": node_id or "",
            "task_family": "mainline_skill",
            "task_label": "导演合成图转草图",
            "display_name": f"导演合成图转草图 · EP{episode} / Beat {beat}",
            "source_label": "导演合成图",
            "target_label": "当前草图候选",
            **(task_display or {}),
        },
    )
    return _project_job_response(
        task_type=task_type,
        ctx=ctx,
        job_id=job_id,
        backend=queued.backend,
        queue=queued.queue,
        task_id=queued.task_state.task_id,
        episode=int(episode),
        beat_num=int(beat),
        scope=job_id,
    )


async def _start_or_enqueue_mainline_beat_sketch_task(
    *,
    ctx: ProjectContext,
    username: str,
    project_name: str,
    project_dir: Path,
    episode: int,
    beat: int,
    canvas_id: str | None,
    node_id: str | None,
    task_display: dict[str, str] | None = None,
) -> dict:
    task_type = "sketch_generation"
    mode_key = "1x1_2-3_sketch"
    scope = selection_scope(mode_key, [int(beat)])
    config = await _mainline_single_beat_config(
        ctx=ctx,
        username=username,
        project_name=project_name,
        episode=int(episode),
        beat=int(beat),
        mode_key=mode_key,
        aspect_ratio="2:3",
        is_sketch=True,
    )
    queued = await get_task_backend().enqueue_project_task(
        ctx,
        task_type=task_type,
        queue_kind="default",
        episode=int(episode),
        scope=scope,
        payload={
            "episode": int(episode),
            "output_dir": str(project_dir),
            "config": config,
            "canvas_id": canvas_id or "",
            "node_id": node_id or "",
            "task_family": "mainline_skill",
            "task_label": "生成草图",
            "display_name": f"生成草图 · EP{episode} / Beat {beat}",
            "source_label": "Beat 上下文",
            "target_label": "当前草图",
            **(task_display or {}),
        },
    )
    return _project_job_response(
        task_type=task_type,
        ctx=ctx,
        job_id=scope,
        backend=queued.backend,
        queue=queued.queue,
        task_id=queued.task_state.task_id,
        episode=int(episode),
        scope=scope,
    )


async def _start_or_enqueue_mainline_scene_360_candidate_job(
    *,
    ctx: ProjectContext,
    project_dir: Path,
    scene_id: str,
    description: str | None,
    master_url: str,
    reverse_url: str | None,
    model: str | None,
    image_size: str | None,
    quality: str | None,
    canvas_id: str | None,
    node_id: str | None,
    task_display: dict[str, str] | None = None,
) -> dict:
    return await _start_or_enqueue_mainline_scene_360_task(
        ctx=ctx,
        project_dir=project_dir,
        scene_id=scene_id,
        description=description,
        master_url=master_url,
        reverse_url=reverse_url,
        model=model,
        image_size=image_size,
        quality=quality,
        canvas_id=canvas_id,
        node_id=node_id,
        auto_commit=False,
        task_display=task_display,
    )


async def _start_or_enqueue_mainline_scene_360_task(
    *,
    ctx: ProjectContext,
    project_dir: Path,
    scene_id: str,
    description: str | None = None,
    master_url: str,
    reverse_url: str | None,
    model: str | None,
    image_size: str | None,
    quality: str | None,
    canvas_id: str | None,
    node_id: str | None,
    auto_commit: bool = True,
    task_display: dict[str, str] | None = None,
) -> dict:
    task_type = "stage_asset"
    step = "pano_from_master"
    master_paths = _resolve_url_list(project_dir, [master_url])
    if not master_paths:
        raise HTTPException(400, "master_url is required")
    for path_text in master_paths:
        if not Path(path_text).exists():
            raise HTTPException(404, f"master file not found: {path_text}")
    reverse_paths = _resolve_url_list(project_dir, [reverse_url] if reverse_url else [])
    for path_text in reverse_paths:
        if not Path(path_text).exists():
            raise HTTPException(404, f"reverse master file not found: {path_text}")
    job_id = (
        task_config_scope("stage_asset", {"scene": scene_id, "step": step})
        if auto_commit
        else _new_job_id()
    )
    artifact_dir = outputs_dir(project_dir, "mainline_scene_360") / job_id
    resolved_provider, resolved_model = _split_provider_and_model(
        "newapi",
        model or FREEZONE_DEFAULT_IMAGE_MODEL,
    )
    queued = await get_task_backend().enqueue_project_task(
        ctx,
        task_type=task_type,
        queue_kind="world",
        episode=0,
        scope=job_id,
        payload={
            "scene_name": scene_id,
            "step": step,
            "params": {
                "description": (description or "").strip() or _build_scene_360_prompt(scene_id),
                "provider": resolved_provider or "newapi",
                "model": resolved_model or model or FREEZONE_DEFAULT_IMAGE_MODEL,
                "image_size": image_size or MAINLINE_SCENE_360_IMAGE_SIZE,
                "quality": quality or "medium",
                "master_path": master_paths[0],
                "reverse_master_path": reverse_paths[0] if reverse_paths else "",
                "artifact_dir": str(artifact_dir) if not auto_commit else "",
                "update_manifest": auto_commit,
            },
            "project_dir": str(project_dir),
            "canvas_id": canvas_id or "",
            "node_id": node_id or "",
            "task_family": "mainline_skill",
            "task_label": "生成 360 全景",
            "display_name": f"生成 360 全景 · {scene_id}",
            "source_label": "场景 Master + Reverse",
            "target_label": "360 全景",
            **(task_display or {}),
        },
    )
    return _project_job_response(
        task_type=task_type,
        ctx=ctx,
        job_id=job_id,
        backend=queued.backend,
        queue=queued.queue,
        task_id=queued.task_state.task_id,
        scope=job_id,
    )


async def _start_or_enqueue_freezone_edit_job(
    *,
    ctx: ProjectContext | None,
    username: str,
    project: str,
    project_dir: Path,
    output_dir: str,
    prompt: str,
    base_url: str,
    extra_reference_urls: list[str],
    aspect_ratio: str,
    image_size: str,
    camera: FreezoneImageCameraConfig | None,
    style: FreezoneImageStyleConfig | None,
    provider: str | None,
    model: str | None,
    quality: str | None,
    canvas_id: str | None = None,
    node_id: str | None = None,
    task_display: dict[str, str] | None = None,
) -> dict:
    base_paths = _resolve_url_list(project_dir, [base_url])
    if not base_paths:
        raise HTTPException(400, "base_url is required")
    for path_text in base_paths:
        if not Path(path_text).exists():
            raise HTTPException(404, f"base file not found: {path_text}")
    extra_paths = _resolve_url_list(project_dir, extra_reference_urls)
    for path_text in extra_paths:
        if not Path(path_text).exists():
            raise HTTPException(404, f"reference file not found: {path_text}")
    resolved_aspect_ratio = (
        _resolve_outpaint_aspect_ratio(Path(base_paths[0]), "original")
        if str(aspect_ratio or "").strip().lower() == "original"
        else aspect_ratio
    )
    job_id = _new_job_id()
    resolved_provider, resolved_model = _split_provider_and_model(provider, model)
    normalized_provider = _resolve_freezone_image_provider(resolved_provider)
    prompt_text = _merge_prompt_with_style_and_camera(prompt, style, camera)
    display_payload = {
        "task_family": "freezone_canvas",
        "task_label": "编辑图片",
        "display_name": "编辑图片",
        **(task_display or {}),
    }
    if ctx is not None:
        queued = await get_task_backend().enqueue_project_task(
            ctx,
            task_type="freezone_edit",
            queue_kind="default",
            episode=0,
            scope=job_id,
            payload={
                "job_id": job_id,
                "project_dir": str(project_dir),
                "prompt": prompt_text,
                "base_path": base_paths[0],
                "extra_reference_paths": extra_paths,
                "aspect_ratio": resolved_aspect_ratio,
                "image_size": image_size,
                "provider": normalized_provider,
                "model": resolved_model,
                "quality": quality,
                "canvas_id": canvas_id or "",
                "node_id": node_id or "",
                **display_payload,
            },
        )
        return {
            "ok": True,
            "data": {
                "task_type": "freezone_edit",
                "job_id": job_id,
                "task_id": queued.task_state.task_id,
                "task_key": project_task_state_key(
                    "freezone_edit", ctx.project_id, 0, scope=job_id
                ),
                "backend": queued.backend,
                "queue": queued.queue,
            },
        }

    _raise_project_context_required("freezone_edit")


def _project_job_response(
    *,
    task_type: str,
    ctx: ProjectContext,
    job_id: str,
    backend: str,
    queue: str | None,
    task_id: str | None,
    episode: int = 0,
    beat_num: int | None = None,
    scope: str | None = None,
) -> dict:
    task_scope = scope or job_id
    data = {
        "task_type": task_type,
        "job_id": job_id,
        "task_key": project_task_state_key(
            task_type,
            ctx.project_id,
            int(episode),
            beat_num=beat_num,
            scope=task_scope,
        ),
        "task_episode": int(episode),
        "task_scope": task_scope,
        "backend": backend,
        "queue": queue,
    }
    if beat_num is not None:
        data["task_beat_num"] = int(beat_num)
    if task_id:
        data["task_id"] = task_id
    return {"ok": True, "data": data}


async def _start_or_enqueue_freezone_edit_path(
    *,
    ctx: ProjectContext | None,
    username: str,
    project: str,
    project_dir: Path,
    output_dir: str,
    job_id: str,
    prompt: str,
    base_path: Path,
    extra_reference_paths: list[str],
    aspect_ratio: str,
    image_size: str,
    provider: str | None,
    model: str | None,
    quality: str | None,
) -> dict:
    task_type = "freezone_edit"
    if ctx is not None:
        queued = await get_task_backend().enqueue_project_task(
            ctx,
            task_type=task_type,
            queue_kind="default",
            episode=0,
            scope=job_id,
            payload={
                "job_id": job_id,
                "project_dir": str(project_dir),
                "prompt": prompt,
                "base_path": str(base_path),
                "extra_reference_paths": extra_reference_paths,
                "aspect_ratio": aspect_ratio,
                "image_size": image_size,
                "provider": provider,
                "model": model,
                "quality": quality,
            },
        )
        return _project_job_response(
            task_type=task_type,
            ctx=ctx,
            job_id=job_id,
            backend=queued.backend,
            queue=queued.queue,
            task_id=queued.task_state.task_id,
        )

    _raise_project_context_required(task_type)


async def _start_or_enqueue_freezone_mask_edit_path(
    *,
    ctx: ProjectContext | None,
    username: str,
    project: str,
    project_dir: Path,
    output_dir: str,
    job_id: str,
    base_path: Path,
    mask_path: Path,
    prompt: str,
    aspect_ratio: str,
    image_size: str,
    quality: str,
    provider: str,
    model: str | None,
) -> dict:
    task_type = "freezone_mask_edit"
    if ctx is not None:
        queued = await get_task_backend().enqueue_project_task(
            ctx,
            task_type=task_type,
            queue_kind="default",
            episode=0,
            scope=job_id,
            payload={
                "job_id": job_id,
                "project_dir": str(project_dir),
                "base_path": str(base_path),
                "mask_path": str(mask_path),
                "prompt": prompt,
                "aspect_ratio": aspect_ratio,
                "image_size": image_size,
                "quality": quality,
                "provider": provider,
                "model": model,
            },
        )
        return _project_job_response(
            task_type=task_type,
            ctx=ctx,
            job_id=job_id,
            backend=queued.backend,
            queue=queued.queue,
            task_id=queued.task_state.task_id,
        )

    _raise_project_context_required(task_type)


async def _enqueue_or_start_freezone_video_analysis(
    *,
    ctx: ProjectContext | None,
    username: str,
    project: str,
    project_dir: Path,
    output_dir: str,
    task_type: Literal["freezone_extract", "freezone_analyze", "freezone_video_story"],
    job_id: str,
    payload: dict,
) -> dict:
    if ctx is not None:
        queued = await get_task_backend().enqueue_project_task(
            ctx,
            task_type=task_type,
            queue_kind="ffmpeg" if task_type != "freezone_analyze" else "default",
            episode=0,
            scope=job_id,
            payload={"job_id": job_id, "project_dir": str(project_dir), **payload},
        )
        return _project_job_response(
            task_type=task_type,
            ctx=ctx,
            job_id=job_id,
            backend=queued.backend,
            queue=queued.queue,
            task_id=queued.task_state.task_id,
        )

    _raise_project_context_required(task_type)


async def _enqueue_or_start_freezone_media_job(
    *,
    ctx: ProjectContext | None,
    username: str,
    project: str,
    project_dir: Path,
    task_type: Literal[
        "freezone_video_erase",
        "freezone_video_upscale",
        "freezone_audio_separate",
        "freezone_video_compose",
        "freezone_audio_eleven_music",
    ],
    job_id: str,
    payload: dict,
    queue_kind: str = "ffmpeg",
) -> dict:
    if ctx is not None:
        queued = await get_task_backend().enqueue_project_task(
            ctx,
            task_type=task_type,
            queue_kind=queue_kind,
            episode=0,
            scope=job_id,
            payload={"job_id": job_id, "project_dir": str(project_dir), **payload},
        )
        return _project_job_response(
            task_type=task_type,
            ctx=ctx,
            job_id=job_id,
            backend=queued.backend,
            queue=queued.queue,
            task_id=queued.task_state.task_id,
        )

    return _accepted_job_response(
        task_type=task_type,
        username=username,
        project=project,
        job_id=job_id,
    )


async def _enqueue_freezone_background_job(
    *,
    ctx: ProjectContext,
    project_dir: Path,
    task_type: str,
    job_id: str,
    payload: dict,
    queue_kind: str = "default",
) -> dict:
    queued = await get_task_backend().enqueue_project_task(
        ctx,
        task_type=task_type,
        queue_kind=queue_kind,
        episode=0,
        scope=job_id,
        payload={"job_id": job_id, "project_dir": str(project_dir), **payload},
    )
    return _project_job_response(
        task_type=task_type,
        ctx=ctx,
        job_id=job_id,
        backend=queued.backend,
        queue=queued.queue,
        task_id=queued.task_state.task_id,
    )


logger = logging.getLogger("novelvideo.api.freezone")

router = APIRouter()

FrameReviewReviewer = Callable[[str], str | Awaitable[str]]
_agent_review_frame_reviewer: FrameReviewReviewer | None = None

TAG_FREEZONE_BOOTSTRAP = "freezone-bootstrap"
TAG_FREEZONE_MEDIA = "freezone-media"
TAG_FREEZONE_AUDIO = "freezone-audio"
TAG_FREEZONE_IMAGE = "freezone-image"
TAG_FREEZONE_VIDEO = "freezone-video"
TAG_FREEZONE_TEXT = "freezone-text"
TAG_FREEZONE_CANVAS = "freezone-canvas"
TAG_FREEZONE_ASSETS = "freezone-assets"

TAG_FREEZONE_COMMIT = "freezone-commit"
TAG_FREEZONE_JOBS = "freezone-jobs"
TAG_FREEZONE_SKILLS = "freezone-skills"

CANVAS_EVENT_SCHEMA_VERSION = "canvas_event.v1"
MAINLINE_SKETCH_IMAGE_SIZE = "1K"
MAINLINE_SKETCH_IMAGE_QUALITY = "low"
MAINLINE_FRAME_IMAGE_SIZE = "1K"
MAINLINE_SCENE_360_IMAGE_SIZE = "2K"
_SKILL_RUN_ID_RE = re.compile(r"^[a-zA-Z0-9_.:\-]{1,128}$")


def _canvas_events_dir(project_dir: Path) -> Path:
    return freezone_root(project_dir) / "_canvas_events"


def _canvas_event_log_path(project_dir: Path, canvas_id: str | None) -> Path:
    event_canvas_id = (canvas_id or "").strip() or "_project"
    if not CANVAS_ID_RE.match(event_canvas_id):
        digest = hashlib.sha256(event_canvas_id.encode("utf-8")).hexdigest()[:16]
        event_canvas_id = f"canvas_{digest}"
    return _canvas_events_dir(project_dir) / f"{event_canvas_id}.jsonl"


def _canvas_event_actor(user: dict) -> dict:
    return {
        "kind": "user",
        "id": str(user.get("id") or user.get("username") or "unknown"),
        "username": str(user.get("username") or ""),
    }


def _append_canvas_event(
    *,
    project_dir: Path,
    project_id: str,
    canvas_id: str | None,
    event_type: str,
    actor: dict,
    payload: dict,
) -> None:
    path = _canvas_event_log_path(project_dir, canvas_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    record = {
        "schema_version": CANVAS_EVENT_SCHEMA_VERSION,
        "event_id": uuid.uuid4().hex,
        "project_id": project_id,
        "canvas_id": (canvas_id or "").strip() or "_project",
        "event_type": event_type,
        "actor": actor,
        "created_at": canvas_store.utc_now_iso(),
        "payload": payload,
    }
    with path.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(record, ensure_ascii=False, sort_keys=True) + "\n")


def _skill_runs_dir(project_dir: Path) -> Path:
    return freezone_root(project_dir) / "_skill_runs"


def _skill_run_metadata_path(project_dir: Path, run_id: str) -> Path:
    if not _SKILL_RUN_ID_RE.match(run_id):
        raise HTTPException(404, "skill run not found")
    return _skill_runs_dir(project_dir) / f"{run_id}.json"


def _write_skill_run_metadata(project_dir: Path, run_id: str, metadata: dict) -> None:
    path = _skill_run_metadata_path(project_dir, run_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")


def _read_skill_run_metadata(project_dir: Path, run_id: str) -> dict:
    path = _skill_run_metadata_path(project_dir, run_id)
    if not path.exists():
        raise HTTPException(404, "skill run not found")
    return json.loads(path.read_text(encoding="utf-8"))


def _skill_error_envelope(
    *,
    code: str,
    category: str,
    message: str,
    retryable: bool = False,
    user_action_hint: str | None = None,
) -> dict:
    return SkillErrorEnvelope(
        code=code,
        category=category,
        message=message,
        retryable=retryable,
        user_action_hint=user_action_hint,
    ).model_dump(mode="json")


def _raise_skill_error(
    status_code: int,
    *,
    code: str,
    category: str,
    message: str,
    retryable: bool = False,
    user_action_hint: str | None = None,
) -> None:
    raise HTTPException(
        status_code,
        _skill_error_envelope(
            code=code,
            category=category,
            message=message,
            retryable=retryable,
            user_action_hint=user_action_hint,
        ),
    )


def _skill_run_idempotency_dir(project_dir: Path) -> Path:
    return freezone_root(project_dir) / "_skill_run_idempotency"


def _skill_run_idempotency_record_path(
    project_dir: Path,
    skill_id: str,
    idempotency_key: str,
) -> Path:
    digest = hashlib.sha256(f"{skill_id}\0{idempotency_key}".encode("utf-8")).hexdigest()
    return _skill_run_idempotency_dir(project_dir) / f"{digest}.json"


def _skill_run_request_hash(body: SkillRunRequest) -> str:
    payload = body.model_dump(
        mode="json",
        exclude={"idempotency_key"},
    )
    encoded = json.dumps(
        payload,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _read_skill_run_idempotency_record(
    project_dir: Path,
    skill_id: str,
    idempotency_key: str,
) -> dict | None:
    path = _skill_run_idempotency_record_path(project_dir, skill_id, idempotency_key)
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def _write_skill_run_idempotency_record(
    project_dir: Path,
    skill_id: str,
    idempotency_key: str,
    request_hash: str,
    response: SkillRunResponse,
) -> None:
    path = _skill_run_idempotency_record_path(project_dir, skill_id, idempotency_key)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(
            {
                "skill_id": skill_id,
                "idempotency_key": idempotency_key,
                "request_hash": request_hash,
                "response": response.model_dump(mode="json"),
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )


def _idempotent_skill_run_response(
    project_dir: Path,
    skill_id: str,
    body: SkillRunRequest,
) -> tuple[str | None, SkillRunResponse | None]:
    idempotency_key = (body.idempotency_key or "").strip()
    if not idempotency_key:
        return None, None
    request_hash = _skill_run_request_hash(body)
    record = _read_skill_run_idempotency_record(project_dir, skill_id, idempotency_key)
    if record is None:
        return request_hash, None
    if record.get("request_hash") != request_hash:
        _raise_skill_error(
            409,
            code="skill_run_idempotency_conflict",
            category="conflict",
            message="idempotency key reused with different skill run request",
            user_action_hint="Retry with a new idempotency key for a changed request.",
        )
    response = record.get("response")
    if not isinstance(response, dict):
        _raise_skill_error(
            500,
            code="skill_run_idempotency_record_invalid",
            category="runtime",
            message="invalid skill run idempotency record",
            retryable=True,
            user_action_hint="Retry the skill run or contact support if this repeats.",
        )
    return request_hash, SkillRunResponse(**response)


def _persist_skill_run_idempotency_response(
    project_dir: Path,
    skill_id: str,
    body: SkillRunRequest,
    request_hash: str | None,
    response: SkillRunResponse,
) -> None:
    idempotency_key = (body.idempotency_key or "").strip()
    if not idempotency_key or not request_hash:
        return
    _write_skill_run_idempotency_record(
        project_dir,
        skill_id,
        idempotency_key,
        request_hash,
        response,
    )


def _input_extra(input_item: ResolvedSkillInput, field: str):
    return getattr(input_item, field, None) or input_item.model_extra.get(field)


def _dict_extra(input_item: ResolvedSkillInput, field: str) -> dict:
    value = _input_extra(input_item, field)
    return value if isinstance(value, dict) else {}


def _input_mainline_contexts(input_item: ResolvedSkillInput) -> list[dict]:
    contexts = _input_extra(input_item, "mainline_context")
    if not isinstance(contexts, list):
        return []
    return [context for context in contexts if isinstance(context, dict)]


def _first_text_value(source: dict, keys: tuple[str, ...]) -> str:
    for key in keys:
        value = str(source.get(key) or "").strip()
        if value:
            return value
    return ""


def _inferred_slot_target_from_input(input_item: ResolvedSkillInput) -> dict | None:
    if input_item.slot_target:
        return input_item.slot_target
    for context in _input_mainline_contexts(input_item):
        kind = str(context.get("kind") or "").strip()
        role = str(context.get("role") or "").strip()
        scene_id = _first_text_value(context, ("sceneId", "scene_id", "scene"))
        if kind == "scene" and scene_id and role in {"scene_master", "scene_reverse_master"}:
            return {"kind": role, "scene_id": scene_id}
        identity_id = _first_text_value(
            context,
            ("identityId", "identity_id", "character"),
        )
        if kind == "identity" and identity_id:
            return {
                "kind": "portrait" if role == "portrait" else "identity",
                "identity_id": identity_id,
            }
        prop_id = _first_text_value(context, ("propId", "prop_id"))
        if kind == "prop" and prop_id:
            return {"kind": "prop", "prop_id": prop_id}
        if kind in {"sketch", "frame", "selected_background", "director_combined"}:
            try:
                episode = int(context.get("episode") or 0)
                beat = int(context.get("beat") or 0)
            except (TypeError, ValueError):
                episode = 0
                beat = 0
            if episode > 0 and beat > 0:
                return {"kind": kind, "episode": episode, "beat": beat}

    source = _dict_extra(input_item, "freezone_source") or _dict_extra(
        input_item,
        "__freezone_source",
    )
    role = str(source.get("role") or "").strip()
    meta = source.get("meta") if isinstance(source.get("meta"), dict) else {}
    scene_id = _first_text_value(meta, ("scene_id", "scene", "scene_name", "name"))
    if scene_id and role in {"scene_master", "scene_reverse_master"}:
        return {"kind": role, "scene_id": scene_id}
    identity_id = _first_text_value(meta, ("identity_id", "identityId", "character"))
    if identity_id and role in {"identity", "portrait"}:
        return {"kind": role, "identity_id": identity_id}
    prop_id = _first_text_value(meta, ("prop_id", "propId"))
    if prop_id and role == "prop":
        return {"kind": "prop", "prop_id": prop_id}
    return None


def _reference_target_for_input(input_item: ResolvedSkillInput | None) -> dict | None:
    if input_item is None:
        return None
    reference_target = _dict_extra(input_item, "reference_target")
    if reference_target:
        return reference_target
    return _slot_target_for_input(input_item)


def _slot_target_for_input(input_item: ResolvedSkillInput | None) -> dict | None:
    if input_item is None:
        return None
    inferred = _inferred_slot_target_from_input(input_item)
    if inferred and not input_item.slot_target:
        input_item.slot_target = inferred
    return inferred


def _canvas_reference_from_input(input_item: ResolvedSkillInput, role: str) -> dict:
    reference_target = _reference_target_for_input(input_item) or {}
    return {
        "role": role,
        "image_url": _required_image_url(input_item, role),
        "slot_kind": str(reference_target.get("kind") or ""),
        "identity_id": str(reference_target.get("identity_id") or "").strip(),
        "prop_id": str(reference_target.get("prop_id") or "").strip(),
    }


def _canvas_references_from_inputs(
    grouped: dict[str, list[ResolvedSkillInput]],
    role: str,
) -> list[dict]:
    return [
        _canvas_reference_from_input(input_item, role) for input_item in grouped.get(role) or []
    ]


def _string_id_set(value: object) -> set[str]:
    if isinstance(value, (list, tuple, set)):
        items = value
    elif value is None:
        return set()
    else:
        items = [value]
    out: set[str] = set()
    for item in items:
        if isinstance(item, dict):
            text = (
                item.get("identity_id")
                or item.get("identityId")
                or item.get("prop_id")
                or item.get("propId")
                or item.get("id")
            )
        else:
            text = item
        text = str(text or "").strip()
        if text:
            out.add(text)
    return out


def _detected_reference_ids_from_beat_context_data(data: dict, role: str) -> set[str] | None:
    if role == "identity":
        snake_key = "detected_identities"
        camel_key = "detectedIdentities"
    elif role == "prop":
        snake_key = "detected_props"
        camel_key = "detectedProps"
    else:
        return None

    edit_fields = data.get("beat_edit_fields")
    if isinstance(edit_fields, dict) and snake_key in edit_fields:
        return _string_id_set(edit_fields.get(snake_key))

    snapshot = data.get("snapshot")
    if isinstance(snapshot, dict) and camel_key in snapshot:
        return _string_id_set(snapshot.get(camel_key))

    for key in (snake_key, camel_key):
        if key in data:
            return _string_id_set(data.get(key))

    contexts = data.get("mainline_context")
    if isinstance(contexts, list):
        for item in contexts:
            if isinstance(item, dict) and item.get("kind") == "beat" and camel_key in item:
                return _string_id_set(item.get(camel_key))
    return None


def _detected_reference_ids_from_skill_input(
    input_item: ResolvedSkillInput | None,
    role: str,
) -> set[str] | None:
    beat_context = (input_item.beat_context if input_item else None) or {}
    if not isinstance(beat_context, dict):
        return None
    return _detected_reference_ids_from_beat_context_data(beat_context, role)


def _reference_id_from_edge(edge: dict, role: str) -> str:
    data = edge.get("data") if isinstance(edge.get("data"), dict) else {}
    target = data.get("reference_target")
    if isinstance(target, dict):
        if role == "identity":
            value = target.get("identity_id") or target.get("identityId")
        else:
            value = target.get("prop_id") or target.get("propId")
        value = str(value or "").strip()
        if value:
            return value
    handle = str(edge.get("targetHandle") or "")
    prefix = f"{role}:"
    if handle.startswith(prefix):
        return handle[len(prefix) :].strip()
    return ""


def _reference_id_from_canvas_reference(item: dict, role: str) -> str:
    if role == "identity":
        return str(item.get("identity_id") or "").strip()
    if role == "prop":
        return str(item.get("prop_id") or "").strip()
    return ""


def _reference_id_from_node(node: dict, role: str) -> str:
    data = node.get("data") if isinstance(node.get("data"), dict) else {}
    source = data.get("__freezone_source")
    meta = (
        source.get("meta")
        if isinstance(source, dict) and isinstance(source.get("meta"), dict)
        else {}
    )
    if role == "identity":
        value = _first_text_value(meta, ("identity_id", "identityId", "character"))
    elif role == "prop":
        value = _first_text_value(meta, ("prop_id", "propId"))
    else:
        return ""
    if value:
        return value

    contexts = data.get("mainline_context")
    if isinstance(contexts, list):
        for context in contexts:
            if not isinstance(context, dict):
                continue
            kind = str(context.get("kind") or "").strip()
            if role == "identity" and kind == "identity":
                value = _first_text_value(context, ("identityId", "identity_id", "character"))
            elif role == "prop" and kind == "prop":
                value = _first_text_value(context, ("propId", "prop_id"))
            else:
                value = ""
            if value:
                return value
    return ""


def _reference_target_for_role(role: str, ref_id: str) -> dict:
    if role == "identity":
        return {"kind": "identity", "identity_id": ref_id}
    return {"kind": "prop", "prop_id": ref_id}


def _synced_reference_edge_id(
    *,
    source_id: str,
    target_id: str,
    role: str,
    ref_id: str,
    existing_ids: set[str],
) -> str:
    digest = hashlib.sha256(f"{source_id}\0{target_id}\0{role}\0{ref_id}".encode("utf-8"))
    base_id = f"edge_{role}_{digest.hexdigest()[:16]}"
    edge_id = base_id
    suffix = 2
    while edge_id in existing_ids:
        edge_id = f"{base_id}_{suffix}"
        suffix += 1
    existing_ids.add(edge_id)
    return edge_id


def _synced_reference_edge(
    *,
    source_id: str,
    target_id: str,
    role: str,
    ref_id: str,
    existing_ids: set[str],
) -> dict:
    label = "Identity" if role == "identity" else "Prop"
    return {
        "id": _synced_reference_edge_id(
            source_id=source_id,
            target_id=target_id,
            role=role,
            ref_id=ref_id,
            existing_ids=existing_ids,
        ),
        "source": source_id,
        "target": target_id,
        "targetHandle": f"{role}:{ref_id}",
        "data": {
            "edgeKind": "role_binding",
            "role": role,
            "label": label,
            "reference_target": _reference_target_for_role(role, ref_id),
        },
    }


def _filter_canvas_references_by_beat_context(
    items: list[dict],
    beat_input: ResolvedSkillInput | None,
    role: str,
) -> list[dict]:
    allowed = _detected_reference_ids_from_skill_input(beat_input, role)
    if allowed is None:
        return items
    return [
        item
        for item in items
        if not (ref_id := _reference_id_from_canvas_reference(item, role)) or ref_id in allowed
    ]


def _sync_frame_context_reference_edges(payload: dict) -> None:
    nodes = [node for node in payload.get("nodes") or [] if isinstance(node, dict)]
    edges = [edge for edge in payload.get("edges") or [] if isinstance(edge, dict)]
    node_by_id = {str(node.get("id")): node for node in nodes if node.get("id")}
    frame_skill_ids = {
        node_id
        for node_id, node in node_by_id.items()
        if ((node.get("data") if isinstance(node.get("data"), dict) else {}) or {}).get("skill_id")
        == "freezone.frame_from_context"
    }
    if not frame_skill_ids:
        return

    allowed_by_skill: dict[str, dict[str, set[str] | None]] = {}
    for edge in edges:
        data = edge.get("data") if isinstance(edge.get("data"), dict) else {}
        if data.get("role") != "beat_context":
            continue
        skill_id = str(edge.get("target") or "")
        if skill_id not in frame_skill_ids:
            continue
        context_node = node_by_id.get(str(edge.get("source") or ""))
        context_data = (
            context_node.get("data")
            if context_node and isinstance(context_node.get("data"), dict)
            else {}
        )
        allowed_by_skill[skill_id] = {
            "identity": _detected_reference_ids_from_beat_context_data(context_data, "identity"),
            "prop": _detected_reference_ids_from_beat_context_data(context_data, "prop"),
        }
    if not allowed_by_skill:
        return

    pruned_edges: list[dict] = []
    for edge in edges:
        target = str(edge.get("target") or "")
        data = edge.get("data") if isinstance(edge.get("data"), dict) else {}
        role = str(data.get("role") or "")
        allowed = allowed_by_skill.get(target, {}).get(role)
        if role in {"identity", "prop"} and allowed is not None:
            ref_id = _reference_id_from_edge(edge, role)
            if ref_id and ref_id not in allowed:
                continue
        pruned_edges.append(edge)

    source_by_role_ref: dict[str, dict[str, str]] = {"identity": {}, "prop": {}}
    for node in nodes:
        source_id = str(node.get("id") or "").strip()
        if not source_id:
            continue
        for role in ("identity", "prop"):
            ref_id = _reference_id_from_node(node, role)
            if ref_id:
                source_by_role_ref[role].setdefault(ref_id, source_id)

    existing_ids = {str(edge.get("id") or "") for edge in pruned_edges if edge.get("id")}
    existing_refs_by_skill_role: dict[tuple[str, str], set[str]] = {}
    for edge in pruned_edges:
        target = str(edge.get("target") or "")
        data = edge.get("data") if isinstance(edge.get("data"), dict) else {}
        role = str(data.get("role") or "")
        if role not in {"identity", "prop"}:
            continue
        ref_id = _reference_id_from_edge(edge, role)
        if ref_id:
            existing_refs_by_skill_role.setdefault((target, role), set()).add(ref_id)

    for skill_id, allowed_by_role in allowed_by_skill.items():
        for role in ("identity", "prop"):
            allowed = allowed_by_role.get(role)
            if allowed is None:
                continue
            existing_refs = existing_refs_by_skill_role.setdefault((skill_id, role), set())
            for ref_id in sorted(allowed):
                if ref_id in existing_refs:
                    continue
                source_id = source_by_role_ref[role].get(ref_id)
                if not source_id:
                    continue
                pruned_edges.append(
                    _synced_reference_edge(
                        source_id=source_id,
                        target_id=skill_id,
                        role=role,
                        ref_id=ref_id,
                        existing_ids=existing_ids,
                    )
                )
                existing_refs.add(ref_id)
    payload["edges"] = pruned_edges


def _input_media_kind(input_item: ResolvedSkillInput) -> str:
    media_kind = str(input_item.media_kind or "").strip()
    if media_kind:
        return media_kind
    if input_item.image_url:
        return "image"
    if input_item.text:
        return "text"
    return ""


def _validate_skill_input_accepts(
    *,
    input_item: ResolvedSkillInput,
    input_spec_role: str,
    accepts: SkillInputAcceptSpec,
) -> None:
    if accepts.node_types and input_item.node_type not in accepts.node_types:
        _raise_skill_error(
            422,
            code="skill_input_node_type_rejected",
            category="validation",
            message=(
                f"input role {input_spec_role!r} does not accept "
                f"node_type {input_item.node_type!r}"
            ),
            user_action_hint="Connect a node type accepted by this skill input.",
        )
    for field in accepts.has_field:
        if _input_extra(input_item, field) in (None, "", [], {}):
            _raise_skill_error(
                422,
                code="skill_input_missing_field",
                category="validation",
                message=f"input role {input_spec_role!r} missing field {field!r}",
                user_action_hint="Use a source node that includes the required field.",
            )
    if accepts.media_kinds:
        media_kind = _input_media_kind(input_item)
        if media_kind not in accepts.media_kinds:
            _raise_skill_error(
                422,
                code="skill_input_media_kind_rejected",
                category="validation",
                message=f"input role {input_spec_role!r} does not accept media kind {media_kind!r}",
                user_action_hint="Connect media whose type matches this skill input.",
            )
    provenance_required = bool(accepts.canonical_slot_kinds or accepts.candidate_origin_skill_ids)
    if provenance_required:
        slot_target = _slot_target_for_input(input_item) or {}
        candidate_origin = input_item.candidate_origin or {}
        slot_kind = str(slot_target.get("kind") or "")
        origin_skill_id = str(candidate_origin.get("skill_id") or "")
        has_slot_match = bool(
            accepts.canonical_slot_kinds and slot_kind in accepts.canonical_slot_kinds
        )
        has_candidate_match = bool(
            accepts.candidate_origin_skill_ids
            and origin_skill_id in accepts.candidate_origin_skill_ids
        )
        has_plain_media_match = bool(accepts.media_kinds and _input_media_kind(input_item))
        if not (has_slot_match or has_candidate_match or has_plain_media_match):
            _raise_skill_error(
                422,
                code="skill_input_origin_rejected",
                category="validation",
                message=(
                    f"input role {input_spec_role!r} does not match "
                    "accepted slot/candidate origins"
                ),
                user_action_hint="Connect a canonical slot or candidate produced by an accepted skill.",
            )


def _normalize_skill_input_url_scope(
    input_item: ResolvedSkillInput,
    *,
    project: str,
    ctx: ProjectContext | None,
    username: str,
    project_name: str,
) -> None:
    image_url = (input_item.image_url or "").strip()
    if not image_url:
        return
    parsed = urlsplit(image_url)
    path = parsed.path or image_url
    if parsed.scheme in {"http", "https"}:
        allowed_hosts = {"static.local", "localhost", "127.0.0.1"}
        if parsed.hostname not in allowed_hosts:
            _raise_skill_error(
                422,
                code="skill_input_external_url_rejected",
                category="validation",
                message="external image URLs are not accepted for skill runs",
                user_action_hint="Use media stored in the current project before running the skill.",
            )
        if not (path.startswith("/static/") or path.startswith("/api/v1/projects/")):
            _raise_skill_error(
                422,
                code="skill_input_external_url_rejected",
                category="validation",
                message="external image URLs are not accepted for skill runs",
                user_action_hint="Use media stored in the current project before running the skill.",
            )
    elif parsed.scheme:
        _raise_skill_error(
            422,
            code="skill_input_external_url_rejected",
            category="validation",
            message="external image URLs are not accepted for skill runs",
            user_action_hint="Use media stored in the current project before running the skill.",
        )
    if path.startswith("/api/v1/projects/"):
        parts = path.split("/", 6)
        if len(parts) < 7 or parts[5] != "media":
            _raise_skill_error(
                422,
                code="skill_input_media_url_unsupported",
                category="validation",
                message="unsupported project API media URL",
                user_action_hint="Use a project media URL returned by the SuperTale API.",
            )
        url_project = unquote(parts[4])
        if url_project != project:
            _raise_skill_error(
                422,
                code="skill_input_wrong_project_url",
                category="validation",
                message="project media URL does not match current project",
                user_action_hint="Use media from the same project as the canvas.",
            )
        media_path = unquote(parts[6]).lstrip("/")
        if not media_path:
            _raise_skill_error(
                422,
                code="skill_input_media_path_missing",
                category="validation",
                message="project media URL missing media path",
                user_action_hint="Use a complete project media URL.",
            )
        input_item.image_url = f"/{media_path}"
        return
    if path.startswith("/static/"):
        parts = path.split("/", 4)
        if len(parts) < 5:
            _raise_skill_error(
                422,
                code="skill_input_static_url_unsupported",
                category="validation",
                message="unsupported static URL",
                user_action_hint="Use a static URL generated for this project.",
            )
        if parts[2] == "projects":
            static_project = unquote(parts[3])
            if static_project != project:
                _raise_skill_error(
                    422,
                    code="skill_input_wrong_project_url",
                    category="validation",
                    message="project static URL does not match current project",
                    user_action_hint="Use media from the same project as the canvas.",
                )
            return
        static_owner = unquote(parts[2])
        static_project = unquote(parts[3])
        expected_owner = ctx.owner_username if ctx is not None else username
        expected_project = ctx.project_name if ctx is not None else project_name
        if static_owner != expected_owner or static_project != expected_project:
            _raise_skill_error(
                422,
                code="skill_input_wrong_project_url",
                category="validation",
                message="static URL does not match current project",
                user_action_hint="Use media from the same project as the canvas.",
            )
        return
    if path.startswith("/api/"):
        _raise_skill_error(
            422,
            code="skill_input_media_url_unsupported",
            category="validation",
            message="unsupported project API media URL",
            user_action_hint="Use a project media URL returned by the SuperTale API.",
        )


def _group_and_validate_skill_inputs(
    skill: SkillDefinition,
    resolved_inputs: list[ResolvedSkillInput],
    *,
    project: str,
    ctx: ProjectContext | None,
    username: str,
    project_name: str,
) -> dict[str, list[ResolvedSkillInput]]:
    specs_by_role = {item.role: item for item in skill.inputs}
    grouped: dict[str, list[ResolvedSkillInput]] = {}
    for input_item in resolved_inputs:
        spec = specs_by_role.get(input_item.role)
        if spec is None:
            _raise_skill_error(
                422,
                code="skill_input_unknown_role",
                category="validation",
                message=f"unknown input role {input_item.role!r}",
                user_action_hint="Reconnect the input to one of the skill node's listed handles.",
            )
        _normalize_skill_input_url_scope(
            input_item,
            project=project,
            ctx=ctx,
            username=username,
            project_name=project_name,
        )
        _validate_skill_input_accepts(
            input_item=input_item,
            input_spec_role=spec.role,
            accepts=spec.accepts,
        )
        if input_item.role == "beat_context" and not _is_standalone_beat_context_input(input_item):
            _episode_and_beat_from_input(input_item)
        grouped.setdefault(input_item.role, []).append(input_item)
    for spec in skill.inputs:
        items = grouped.get(spec.role, [])
        if spec.required and not items:
            _raise_skill_error(
                422,
                code="skill_input_missing_required",
                category="validation",
                message=f"missing required input role {spec.role!r}",
                user_action_hint="Connect the missing input role before running the skill.",
            )
        if spec.cardinality == "single" and len(items) > 1:
            _raise_skill_error(
                422,
                code="skill_input_cardinality_exceeded",
                category="validation",
                message=f"input role {spec.role!r} accepts only one value",
                user_action_hint="Remove extra edges from this single-value input role.",
            )
    return grouped


def _single_input(
    grouped: dict[str, list[ResolvedSkillInput]], role: str
) -> ResolvedSkillInput | None:
    items = grouped.get(role) or []
    return items[0] if items else None


def _required_input(grouped: dict[str, list[ResolvedSkillInput]], role: str) -> ResolvedSkillInput:
    input_item = _single_input(grouped, role)
    if input_item is None:
        _raise_skill_error(
            422,
            code="skill_input_missing_required",
            category="validation",
            message=f"missing required input role {role!r}",
            user_action_hint="Connect the missing input role before running the skill.",
        )
    return input_item


def _required_image_url(input_item: ResolvedSkillInput, role: str) -> str:
    image_url = (input_item.image_url or "").strip()
    if not image_url:
        _raise_skill_error(
            422,
            code="skill_input_missing_field",
            category="validation",
            message=f"input role {role!r} missing field 'image_url'",
            user_action_hint="Connect an image node that has a concrete project media URL.",
        )
    return image_url


def _input_image_urls(grouped: dict[str, list[ResolvedSkillInput]], role: str) -> list[str]:
    urls: list[str] = []
    for input_item in grouped.get(role) or []:
        urls.append(_required_image_url(input_item, role))
    return urls


def _episode_and_beat_from_input(input_item: ResolvedSkillInput | None) -> tuple[int, int]:
    beat_context = (input_item.beat_context if input_item else None) or {}
    try:
        episode = int(beat_context.get("episode") or beat_context.get("episode_number") or 0)
        beat = int(beat_context.get("beat") or beat_context.get("beat_number") or 0)
    except (TypeError, ValueError):
        _raise_skill_error(
            422,
            code="skill_input_beat_context_invalid",
            category="validation",
            message="beat_context must include numeric episode and beat",
            user_action_hint="Connect a Beat Context node with episode and beat values.",
        )
    if episode <= 0 or beat <= 0:
        _raise_skill_error(
            422,
            code="skill_input_beat_context_invalid",
            category="validation",
            message="beat_context must include positive episode and beat",
            user_action_hint="Connect a Beat Context node with positive episode and beat values.",
        )
    return episode, beat


def _slot_target_from_inputs(grouped: dict[str, list[ResolvedSkillInput]]) -> dict | None:
    beat_item = _single_input(grouped, "beat_context")
    beat_target = _slot_target_for_input(beat_item)
    if beat_target:
        return beat_target
    if beat_item and not _is_standalone_beat_context_input(beat_item):
        episode, beat = _episode_and_beat_from_input(beat_item)
        return {"episode": episode, "beat": beat}
    for role in ("sketch", "frame", "scene_master", "background"):
        item = _single_input(grouped, role)
        slot_target = _slot_target_for_input(item)
        if slot_target:
            return slot_target
    return None


def _skill_output_slot_target(
    _skill_id: str,
    output_role: str,
    grouped: dict[str, list[ResolvedSkillInput]],
) -> dict | None:
    beat_item = _single_input(grouped, "beat_context")
    if _is_standalone_beat_context_input(beat_item):
        return None
    if output_role == "current_sketch_candidate":
        if beat_item:
            episode, beat = _episode_and_beat_from_input(beat_item)
            return {"kind": "sketch", "episode": episode, "beat": beat}
    if output_role == "current_frame_candidate":
        if beat_item:
            episode, beat = _episode_and_beat_from_input(beat_item)
            return {"kind": "frame", "episode": episode, "beat": beat}
    if output_role == "selected_background":
        if beat_item:
            episode, beat = _episode_and_beat_from_input(beat_item)
            return {"kind": "selected_background", "episode": episode, "beat": beat}
    if output_role == "director_combined":
        if beat_item:
            episode, beat = _episode_and_beat_from_input(beat_item)
            return {"kind": "director_render", "episode": episode, "beat": beat}
    if output_role == "scene_360_candidate":
        scene_master = _single_input(grouped, "scene_master")
        scene_master_slot = _slot_target_for_input(scene_master)
        scene_id = (
            scene_master_slot.get("scene_id") if isinstance(scene_master_slot, dict) else None
        )
        if scene_id:
            return {"kind": "scene_director_pano_360", "scene_id": scene_id}
    return _slot_target_from_inputs(grouped)


def _skill_node_is_preset_managed(
    *,
    project_dir: Path,
    ctx: ProjectContext | None,
    canvas_id: str | None,
    skill_node_id: str | None,
) -> bool:
    canvas = (canvas_id or "").strip()
    node_id = (skill_node_id or "").strip()
    if not canvas or not node_id or not CANVAS_ID_RE.match(canvas):
        return False
    canvas_project_dir = _canvas_state_project_dir(ctx, project_dir)
    try:
        payload = canvas_store.read_canvas(canvas_project_dir, canvas)
    except Exception:
        logger.exception("failed to inspect canvas node for skill auto-commit")
        return False
    if not isinstance(payload, dict):
        return False
    for node in payload.get("nodes") or []:
        if isinstance(node, dict) and str(node.get("id") or "") == node_id:
            return _is_preset_managed_canvas_node(node)
    return False


def _skill_output_metadata(
    skill: SkillDefinition,
    grouped: dict[str, list[ResolvedSkillInput]],
    *,
    auto_commit: bool = False,
) -> dict:
    output = skill.outputs[0]
    slot_target = _skill_output_slot_target(skill.id, output.role, grouped)
    return {
        "role": output.role,
        "media_type": output.media_type,
        "node_type": output.node_type,
        "pushable": output.pushable,
        "slot_target": slot_target,
        "auto_commit": bool(auto_commit),
    }


def _skill_run_status_from_task_status(status: str | None) -> str:
    if status == "completed":
        return "done"
    if status in {"failed", "cancelled"}:
        return status
    return status or "unknown"


def _project_path_from_rel(project_dir: Path, rel_path: str) -> Path | None:
    rel = str(rel_path or "").strip().lstrip("/")
    if not rel:
        return None
    candidate = (project_dir / rel).resolve()
    try:
        candidate.relative_to(project_dir.resolve())
    except ValueError:
        return None
    return candidate


def _director_control_bundle_from_input(input_item: ResolvedSkillInput | None) -> dict:
    if not input_item:
        return {}
    return _dict_extra(input_item, "director_control_bundle")


def _copy_director_control_bundle_to_mainline(
    *,
    ctx: ProjectContext,
    project_dir: Path,
    bundle: dict,
    fallback_combined_path: Path,
    target_dir: Path,
) -> dict | None:
    rel_paths = bundle.get("rel_paths")
    rel_paths = rel_paths if isinstance(rel_paths, dict) else {}
    source_paths = {
        "combined": _project_path_from_rel(project_dir, str(rel_paths.get("combined") or ""))
        or fallback_combined_path,
        "env_only": _project_path_from_rel(project_dir, str(rel_paths.get("env_only") or "")),
        "frame_meta": _project_path_from_rel(project_dir, str(rel_paths.get("frame_meta") or "")),
    }
    if not all(path and path.exists() and path.is_file() for path in source_paths.values()):
        return None

    target_dir.mkdir(parents=True, exist_ok=True)
    filenames = {
        "combined": "combined.png",
        "env_only": "env_only.png",
        "frame_meta": "frame_meta.json",
    }
    paths: dict[str, str] = {}
    next_rel_paths: dict[str, str] = {}
    urls: dict[str, str] = {}
    for kind, filename in filenames.items():
        source_path = source_paths[kind]
        if not source_path:
            return None
        target_path = target_dir / filename
        if source_path.resolve() != target_path.resolve():
            shutil.copyfile(source_path, target_path)
        rel = target_path.relative_to(project_dir).as_posix()
        paths[kind] = str(target_path)
        next_rel_paths[kind] = rel
        urls[kind] = make_static_url_for_context(ctx, rel, local_path=target_path)

    frame_meta_value = bundle.get("frame_meta")
    if not isinstance(frame_meta_value, dict):
        try:
            frame_meta_value = json.loads(
                (target_dir / "frame_meta.json").read_text(encoding="utf-8")
            )
        except (OSError, json.JSONDecodeError):
            frame_meta_value = None

    next_bundle = {
        "schema_version": "director_control_bundle_v1",
        "dir": str(target_dir),
        "paths": paths,
        "rel_paths": next_rel_paths,
        "urls": urls,
    }
    if isinstance(bundle.get("source"), dict):
        next_bundle["source"] = bundle["source"]
    if isinstance(frame_meta_value, dict):
        next_bundle["frame_meta"] = frame_meta_value
    return next_bundle


def _extract_result_image_url(result: dict | None) -> str | None:
    if not isinstance(result, dict):
        return None
    for key in ("image_url", "output_url", "url"):
        value = result.get(key)
        if isinstance(value, str) and value:
            return value
    return None


def _static_url_for_skill_output_path(
    *,
    output_path: str,
    project_dir: Path,
    ctx: ProjectContext,
    username: str,
    project_name: str,
) -> str | None:
    raw_path = str(output_path or "").strip()
    if not raw_path:
        return None
    path = Path(raw_path)
    if not path.is_absolute():
        path = project_dir / raw_path.lstrip("/")
    try:
        resolved = path.resolve()
        rel = resolved.relative_to(project_dir.resolve()).as_posix()
    except ValueError:
        return None
    if not resolved.exists() or not resolved.is_file():
        return None
    return make_static_url_for_context(ctx, rel, local_path=resolved)


def _static_url_for_task_result_path(
    *,
    task_result: dict | None,
    project_dir: Path,
    ctx: ProjectContext,
    username: str,
    project_name: str,
) -> str | None:
    if not isinstance(task_result, dict):
        return None
    for key in ("output_path", "pano_path"):
        image_url = _static_url_for_skill_output_path(
            output_path=str(task_result.get(key) or ""),
            project_dir=project_dir,
            ctx=ctx,
            username=username,
            project_name=project_name,
        )
        if image_url:
            return image_url
    return None


def _static_url_for_skill_slot_target(
    *,
    output_metadata: dict,
    project_dir: Path,
    ctx: ProjectContext,
) -> str | None:
    target = _parse_skill_output_push_target(output_metadata)
    if target is None:
        return None
    target_path = slot_target_path(project_dir, target)
    if not target_path.exists() or not target_path.is_file():
        return None
    rel = target_path.relative_to(project_dir).as_posix()
    return make_static_url_for_context(ctx, rel, local_path=target_path)


def _normalize_task_result_outputs(
    *,
    task_result: dict | None,
    output_metadata: dict,
    project_dir: Path,
    ctx: ProjectContext | None,
    username: str,
    project_name: str,
) -> list[SkillRunOutput]:
    if not isinstance(task_result, dict):
        return []
    raw_outputs = task_result.get("outputs")
    if not isinstance(raw_outputs, list):
        return []
    outputs: list[SkillRunOutput] = []
    for raw_output in raw_outputs:
        if not isinstance(raw_output, dict):
            continue
        item = {**output_metadata, **raw_output}
        output_path = str(item.get("output_path") or "").strip()
        if output_path and not item.get("image_url"):
            image_url = _static_url_for_skill_output_path(
                output_path=output_path,
                project_dir=project_dir,
                ctx=ctx,
                username=username,
                project_name=project_name,
            )
            if image_url:
                item["image_url"] = image_url
        outputs.append(SkillRunOutput(**item))
    return outputs


def _skill_output_path_for_job(project_dir: Path, task_type: str, job_id: str) -> Path | None:
    out = output_path_for_job(project_dir, task_type, job_id)
    if out.exists():
        return out
    for suffix in (".webp", ".mp4", ".mov", ".webm"):
        candidate = out.with_suffix(suffix)
        if candidate.exists():
            return candidate
    return None


def _scene_id_from_scene_master_input(scene_master: ResolvedSkillInput | None) -> str:
    scene_master_slot = _slot_target_for_input(scene_master)
    scene_id = scene_master_slot.get("scene_id") if isinstance(scene_master_slot, dict) else None
    if scene_id:
        return str(scene_id)
    _raise_skill_error(
        422,
        code="skill_scene_master_missing_scene_id",
        category="validation",
        message="scene_master input must include slot_target.scene_id",
        user_action_hint="Connect a scene master node that belongs to a mainline scene.",
    )


def _scene_prompt_from_input(scene_input: ResolvedSkillInput | None) -> str:
    if scene_input is None:
        return ""
    return str(scene_input.text or _input_extra(scene_input, "content") or "").strip()


async def _run_set_selected_background_skill(
    *,
    project: str,
    project_dir: Path,
    ctx: ProjectContext,
    username: str,
    project_name: str,
    skill: SkillDefinition,
    grouped: dict[str, list[ResolvedSkillInput]],
    body: SkillRunRequest,
    user: dict,
    idempotency_request_hash: str,
    auto_commit: bool,
) -> SkillRunResponse:
    beat_input = _single_input(grouped, "beat_context")
    source = _single_input(grouped, "source_image")
    is_standalone_beat_context = _is_standalone_beat_context_input(beat_input)
    if is_standalone_beat_context:
        auto_commit = False
        episode = beat = None
    else:
        episode, beat = _episode_and_beat_from_input(beat_input)
    source_url = (source.image_url if source else "") or ""
    if not source_url:
        _raise_skill_error(
            422,
            code="skill_input_missing_field",
            category="validation",
            message="source_image must include image_url",
            user_action_hint="Connect an image source before running the skill.",
        )
    try:
        source_path = resolve_static_url_to_path(source_url, project_dir)
    except ValueError as exc:
        _raise_skill_error(
            422,
            code="skill_input_media_url_unsupported",
            category="validation",
            message=str(exc),
            user_action_hint="Use media stored in the current project.",
        )
    if not source_path.exists() or not source_path.is_file():
        _raise_skill_error(
            404,
            code="skill_input_media_missing",
            category="not_found",
            message="source image file not found",
            user_action_hint="Refresh the canvas or choose an existing image.",
        )

    committed = False
    if auto_commit:
        selected_path = copy_to_beat_selected_background(
            project_dir,
            int(episode or 0),
            int(beat or 0),
            source_path,
        )
        store = await make_sqlite_store_for_context(ctx)
        try:
            beats = await store.get_beats_as_dicts(int(episode))
            target = next(
                (item for item in beats if int(item.get("beat_number") or 0) == int(beat)),
                None,
            )
            if not target:
                _raise_skill_error(
                    404,
                    code="skill_beat_not_found",
                    category="not_found",
                    message=f"beat not found: ep{episode} beat{beat}",
                    user_action_hint="Reconnect a valid Beat Context node.",
                )
            scene_ref = dict(target.get("scene_ref") or {})
            scene_id = beat_scene_id(target)
            if scene_id:
                scene_ref["scene_id"] = scene_id
            scene_ref["render_anchor_id"] = "selected_background"
            scene_ref["render_anchor_source_id"] = "skill_source_image"
            scene_ref.pop("render_anchor_path", None)
            await store.update_beat_asset(
                episode_number=int(episode or 0),
                beat_number=int(beat or 0),
                scene_ref=scene_ref,
            )
            committed = True
        finally:
            close = getattr(store, "close", None)
            if close:
                await close()
        rel = selected_path.relative_to(project_dir).as_posix()
        image_url = make_static_url_for_context(ctx, rel, local_path=selected_path)
    else:
        rel = source_path.relative_to(project_dir).as_posix()
        image_url = make_static_url_for_context(ctx, rel, local_path=source_path)
    output = _skill_output_metadata(skill, grouped, auto_commit=auto_commit)
    output["image_url"] = image_url
    if not auto_commit:
        output["pushable"] = True
    if committed:
        output["pushable"] = False
        output["committed"] = True
        output["committed_slot_url"] = image_url
    run_id = f"freezone.set_selected_background:{_new_job_id()}"
    _write_skill_run_metadata(
        project_dir,
        run_id,
        {
            "run_id": run_id,
            "skill_id": skill.id,
            "status": "completed",
            "outputs": [output],
            "canvas_id": body.canvas_id,
            "skill_node_id": body.skill_node_id,
        },
    )
    response = SkillRunResponse(run_id=run_id, status="completed")
    _append_canvas_event(
        project_dir=project_dir,
        project_id=project,
        canvas_id=body.canvas_id,
        event_type="skill.run_completed",
        actor=_canvas_event_actor(user),
        payload={
            "skill_id": skill.id,
            "skill_node_id": body.skill_node_id,
            "run_id": run_id,
            "status": response.status,
            "output_count": 1,
        },
    )
    _persist_skill_run_idempotency_response(
        project_dir,
        skill.id,
        body,
        idempotency_request_hash,
        response,
    )
    return response


async def _run_set_director_combined_skill(
    *,
    project: str,
    project_dir: Path,
    ctx: ProjectContext,
    skill: SkillDefinition,
    grouped: dict[str, list[ResolvedSkillInput]],
    body: SkillRunRequest,
    user: dict,
    idempotency_request_hash: str,
    auto_commit: bool,
) -> SkillRunResponse:
    beat_input = _single_input(grouped, "beat_context")
    source = _single_input(grouped, "source_image")
    is_standalone_beat_context = _is_standalone_beat_context_input(beat_input)
    if is_standalone_beat_context:
        auto_commit = False
        episode = beat = None
    else:
        episode, beat = _episode_and_beat_from_input(beat_input)
    source_url = (source.image_url if source else "") or ""
    if not source_url:
        _raise_skill_error(
            422,
            code="skill_input_missing_field",
            category="validation",
            message="source_image must include image_url",
            user_action_hint="Connect an image source before running the skill, or use 3GS capture.",
        )
    try:
        source_path = resolve_static_url_to_path(source_url, project_dir)
    except ValueError as exc:
        _raise_skill_error(
            422,
            code="skill_input_media_url_unsupported",
            category="validation",
            message=str(exc),
            user_action_hint="Use media stored in the current project.",
        )
    if not source_path.exists() or not source_path.is_file():
        _raise_skill_error(
            404,
            code="skill_input_media_missing",
            category="not_found",
            message="source image file not found",
            user_action_hint="Refresh the canvas or choose an existing image.",
        )

    committed = False
    director_bundle: dict | None = None
    if auto_commit:
        target_path = PathResolver(str(project_dir), int(episode or 0)).director_render(
            int(beat or 0)
        )
        source_bundle = _director_control_bundle_from_input(source)
        if source_bundle:
            director_bundle = _copy_director_control_bundle_to_mainline(
                ctx=ctx,
                project_dir=project_dir,
                bundle=source_bundle,
                fallback_combined_path=source_path,
                target_dir=target_path.parent,
            )
        if not director_bundle:
            target_path.parent.mkdir(parents=True, exist_ok=True)
            if source_path.resolve() != target_path.resolve():
                shutil.copyfile(source_path, target_path)
        committed = True
        rel = target_path.relative_to(project_dir).as_posix()
        image_url = make_static_url_for_context(ctx, rel, local_path=target_path)
    else:
        rel = source_path.relative_to(project_dir).as_posix()
        image_url = make_static_url_for_context(ctx, rel, local_path=source_path)
        source_bundle = _director_control_bundle_from_input(source)
        if source_bundle:
            director_bundle = source_bundle

    output = _skill_output_metadata(skill, grouped, auto_commit=auto_commit)
    output["image_url"] = image_url
    output["label"] = skill.outputs[0].label
    if director_bundle:
        output["director_control_bundle"] = director_bundle
    if not is_standalone_beat_context:
        output["mainline_context"] = [
            {
                "kind": "director_combined",
                "episode": int(episode or 0),
                "beat": int(beat or 0),
                "role": "director_combined",
                "sourceUrl": image_url,
            }
        ]
    if committed:
        output["pushable"] = False
        output["committed"] = True
        output["committed_slot_url"] = image_url
    run_id = f"freezone.set_director_combined:{_new_job_id()}"
    _write_skill_run_metadata(
        project_dir,
        run_id,
        {
            "run_id": run_id,
            "skill_id": skill.id,
            "status": "completed",
            "outputs": [output],
            "canvas_id": body.canvas_id,
            "skill_node_id": body.skill_node_id,
        },
    )
    response = SkillRunResponse(run_id=run_id, status="completed")
    _append_canvas_event(
        project_dir=project_dir,
        project_id=project,
        canvas_id=body.canvas_id,
        event_type="skill.run_completed",
        actor=_canvas_event_actor(user),
        payload={
            "skill_id": skill.id,
            "skill_node_id": body.skill_node_id,
            "run_id": run_id,
            "status": response.status,
            "output_count": 1,
        },
    )
    _persist_skill_run_idempotency_response(
        project_dir,
        skill.id,
        body,
        idempotency_request_hash,
        response,
    )
    return response


def _parse_skill_output_push_target(output: dict) -> PushTarget | None:
    if output.get("pushable") is not True:
        return None
    if output.get("auto_commit") is not True:
        return None
    slot_target = output.get("slot_target")
    if not isinstance(slot_target, dict) or not slot_target.get("kind"):
        return None
    try:
        return PushRequest(source_url="skill-output", target=slot_target).target
    except Exception as exc:
        logger.warning("invalid skill output slot_target ignored: %s", exc)
        return None


def _copy_skill_output_to_slot(
    *,
    project_dir: Path,
    ctx: ProjectContext,
    source_path: Path,
    target: PushTarget,
) -> tuple[Path, str, Path | None, dict]:
    validate_source_for_slot(source_path, target)
    target_path = slot_target_path(project_dir, target)
    if target.kind == "scene_3gs_custom_scene":
        target_path = target_path.with_suffix(source_path.suffix.lower())
    target_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        same_file = source_path.resolve() == target_path.resolve()
    except OSError:
        same_file = False

    should_match_existing_size = (
        target_path.exists()
        and not same_file
        and target.kind in {"frame", "sketch", "director_render"}
        and source_path.suffix.lower() in {".png", ".jpg", ".jpeg", ".webp"}
        and target_path.suffix.lower() in {".png", ".jpg", ".jpeg", ".webp"}
    )
    backup = None if same_file else backup_slot_if_exists(target_path)
    if same_file:
        image_adaptation = {"adapted": False, "same_file": True}
    elif should_match_existing_size:
        image_adaptation = _copy_image_matching_existing_target(source_path, target_path)
    else:
        image_adaptation = {"adapted": False}
        shutil.copy2(source_path, target_path)
    sync_slot_after_write(project_dir, target, target_path)
    rel = target_path.relative_to(project_dir).as_posix()
    return (
        target_path,
        make_static_url_for_context(ctx, rel, local_path=target_path),
        backup,
        image_adaptation,
    )


async def _finalize_skill_run_outputs(
    *,
    project: str,
    project_dir: Path,
    ctx: ProjectContext,
    metadata: dict,
    outputs: list[dict],
    user: dict,
) -> list[dict]:
    finalized: list[dict] = []
    changed = False
    for output in outputs:
        item = dict(output)
        target = _parse_skill_output_push_target(item)
        image_url = str(item.get("image_url") or "").strip()
        if target is not None and image_url:
            try:
                source_path = resolve_static_url_to_path(image_url, project_dir)
                if not source_path.exists() or not source_path.is_file():
                    raise FileNotFoundError(source_path)
                target_path, target_url, backup, image_adaptation = _copy_skill_output_to_slot(
                    project_dir=project_dir,
                    ctx=ctx,
                    source_path=source_path,
                    target=target,
                )
                item["image_url"] = target_url
                item["pushable"] = False
                item["committed"] = True
                item["committed_slot_url"] = target_url
                item["target_path"] = str(target_path)
                item["backup"] = str(backup) if backup else None
                item["image_adaptation"] = image_adaptation
                changed = True
                _append_canvas_event(
                    project_dir=project_dir,
                    project_id=project,
                    canvas_id=metadata.get("canvas_id"),
                    event_type="skill.output_committed",
                    actor=_canvas_event_actor(user),
                    payload={
                        "skill_id": metadata.get("skill_id"),
                        "skill_node_id": metadata.get("skill_node_id"),
                        "run_id": metadata.get("run_id"),
                        "role": item.get("role"),
                        "target": target.model_dump(mode="json"),
                        "target_url": target_url,
                    },
                )
            except Exception as exc:
                logger.exception("skill output auto-commit failed")
                _raise_skill_error(
                    500,
                    code="skill_output_auto_commit_failed",
                    category="runtime",
                    message=f"skill output auto-commit failed: {exc}",
                    retryable=True,
                    user_action_hint="Retry the skill run. If this repeats, inspect the canonical slot target.",
                )
        finalized.append(item)

    if outputs and (changed or metadata.get("status") != "completed"):
        metadata["status"] = "completed"
        metadata["outputs"] = finalized
        _write_skill_run_metadata(project_dir, str(metadata.get("run_id") or ""), metadata)
        _append_canvas_event(
            project_dir=project_dir,
            project_id=project,
            canvas_id=metadata.get("canvas_id"),
            event_type="skill.run_completed",
            actor=_canvas_event_actor(user),
            payload={
                "skill_id": metadata.get("skill_id"),
                "skill_node_id": metadata.get("skill_node_id"),
                "run_id": metadata.get("run_id"),
                "status": "completed",
                "output_count": len(finalized),
            },
        )
    return finalized


def _deterministic_frame_review(
    body: SkillRunRequest, grouped: dict[str, list[ResolvedSkillInput]]
) -> str:
    beat_input = _single_input(grouped, "beat_context")
    if _is_standalone_beat_context_input(beat_input):
        episode = beat = None
    else:
        episode, beat = _episode_and_beat_from_input(beat_input)
    frame = _single_input(grouped, "frame")
    frame_label = frame.node_id if frame else "frame"
    target_label = (
        "Canvas Beat Context"
        if episode is None or beat is None
        else f"Episode {episode}, Beat {beat}"
    )
    return (
        f"{target_label} frame review for {frame_label}: "
        "deterministic backend check completed. Verify composition, continuity, "
        "identity consistency, and whether visible details match the beat context."
    )


def _build_frame_review_prompt(
    body: SkillRunRequest, grouped: dict[str, list[ResolvedSkillInput]]
) -> str:
    beat_input = _single_input(grouped, "beat_context")
    if _is_standalone_beat_context_input(beat_input):
        episode = beat = None
    else:
        episode, beat = _episode_and_beat_from_input(beat_input)
    beat_context = (beat_input.beat_context if beat_input else None) or {}
    frame = _single_input(grouped, "frame")
    frame_details = {
        "node_id": frame.node_id if frame else "",
        "node_type": frame.node_type if frame else "",
        "image_url": frame.image_url if frame else "",
        "slot_target": frame.slot_target if frame else None,
        "candidate_origin": frame.candidate_origin if frame else None,
    }
    return "\n".join(
        [
            "Review this generated frame against the beat context.",
            "Return a concise production note covering composition, continuity, "
            "identity consistency, and mismatches.",
            f"Episode: {json.dumps(episode)}",
            f"Beat: {json.dumps(beat)}",
            f"Skill node: {body.skill_node_id}",
            f"Canvas: {body.canvas_id}",
            f"Beat context: {json.dumps(beat_context, ensure_ascii=False, sort_keys=True)}",
            f"Frame: {json.dumps(frame_details, ensure_ascii=False, sort_keys=True)}",
        ]
    )


async def _review_frame_text(
    body: SkillRunRequest, grouped: dict[str, list[ResolvedSkillInput]]
) -> str:
    reviewer = _agent_review_frame_reviewer
    if reviewer is None:
        return _deterministic_frame_review(body, grouped)

    prompt = _build_frame_review_prompt(body, grouped)
    try:
        review = reviewer(prompt)
        if hasattr(review, "__await__"):
            review = await review
    except Exception:
        logger.exception("agent.review_frame reviewer failed; using deterministic fallback")
        return _deterministic_frame_review(body, grouped)

    if isinstance(review, str) and review.strip():
        return review.strip()
    return _deterministic_frame_review(body, grouped)


@router.get("/freezone/skills", tags=[TAG_FREEZONE_SKILLS])
async def freezone_skills(user: dict = Depends(get_api_user)):
    return {"ok": True, "data": [skill.model_dump(mode="json") for skill in list_skills()]}


# ============================================================
# 图片处理：上传
# ============================================================


@router.post("/projects/{project}/freezone/upload", tags=[TAG_FREEZONE_MEDIA])
async def freezone_upload(
    project: str,
    file: Annotated[UploadFile, File()],
    user: dict = Depends(get_api_user),
):
    """把外部资源上传保存到 `freezone/_uploads/`。"""
    ctx, username, project_name, project_dir, _output_dir = await _resolve_freezone_project(
        project, user
    )
    target_dir = uploads_dir(project_dir)
    target_dir.mkdir(parents=True, exist_ok=True)
    filename = safe_upload_filename(file.filename)
    target = target_dir / filename
    contents = await file.read()
    target.write_bytes(contents)
    rel = target.relative_to(project_dir).as_posix()
    return {
        "ok": True,
        "data": {
            "url": (make_static_url_for_context(ctx, rel, local_path=target)),
            "filename": filename,
            "size": len(contents),
        },
    }


@router.post("/projects/{project}/freezone/three-d-viewer/screenshot", tags=[TAG_FREEZONE_MEDIA])
async def freezone_three_d_viewer_screenshot(
    project: str,
    body: FreezoneThreeDViewerScreenshotRequest,
    user: dict = Depends(get_api_user),
):
    """保存内置 3D viewer 普通截图到 Freezone 输出目录。"""

    ctx, username, project_name, project_dir, _output_dir = await _resolve_freezone_project(
        project, user
    )
    prefix = "data:image/png;base64,"
    data_url = (body.data_url or "").strip()
    if not data_url.startswith(prefix):
        raise HTTPException(400, "expected PNG data URL")
    try:
        payload = base64.b64decode(data_url[len(prefix) :], validate=True)
    except (binascii.Error, ValueError) as exc:
        raise HTTPException(400, "invalid PNG data URL") from exc
    if not payload.startswith(b"\x89PNG\r\n\x1a\n"):
        raise HTTPException(400, "screenshot payload is not PNG")
    if len(payload) > 20 * 1024 * 1024:
        raise HTTPException(413, "screenshot is too large")

    job_id = _new_job_id()
    out = output_path_for_job(project_dir, "three_d_viewer", job_id)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(payload)
    rel_path = out.relative_to(project_dir).as_posix()
    label = (body.label or "3D viewer screenshot").strip() or "3D viewer screenshot"
    return {
        "ok": True,
        "data": {
            "id": job_id,
            "label": label,
            "node_id": body.node_id,
            "rel_path": rel_path,
            "url": (make_static_url_for_context(ctx, rel_path, local_path=out)),
            "media_type": "image",
            "size": len(payload),
        },
    }


@router.post(
    "/projects/{project}/freezone/gen",
    response_model=FreezoneJobAcceptedResponse,
    tags=[TAG_FREEZONE_IMAGE],
)
async def freezone_gen(
    project: str,
    body: FreezoneGenRequest,
    user: dict = Depends(get_api_user),
):
    """图片处理：启动文生图任务，返回可供 SSE 追踪的 `task_key`。"""
    ctx, username, project_name, project_dir, output_dir = await _resolve_freezone_project(
        project, user
    )
    return await _start_or_enqueue_freezone_gen_job(
        ctx=ctx,
        username=username,
        project=project_name,
        project_dir=project_dir,
        output_dir=output_dir,
        prompt=body.prompt,
        aspect_ratio=body.aspect_ratio,
        image_size=body.image_size,
        reference_urls=list(body.reference_urls or []),
        camera=body.camera,
        style=body.style,
        provider=body.provider,
        model=body.model,
        quality=body.quality,
        canvas_id=body.canvas_id or None,
        node_id=body.node_id or None,
    )


@router.post(
    "/projects/{project}/freezone/sketch-from-context",
    response_model=FreezoneJobAcceptedResponse,
    tags=[TAG_FREEZONE_IMAGE],
)
async def freezone_sketch_from_context(
    project: str,
    body: FreezoneSketchFromContextRequest,
    user: dict = Depends(get_api_user),
):
    """主线上下文：从 Beat / 背景 / 导演合成图生成草图候选。"""
    ctx, username, project_name, project_dir, _output_dir = await _resolve_freezone_project(
        project, user
    )
    beat = await _load_freezone_beat_context(
        ctx=ctx,
        username=username,
        project=project_name,
        episode=body.episode,
        beat=body.beat,
    )
    source_url = (body.source_url or "").strip()
    source_label = {
        "beat": "Beat 上下文",
        "selected_background": "当前背景",
        "director_combined": "导演合成图",
        "background_candidate": "背景候选",
    }.get(body.source_kind, "输入参考")
    task_display = {
        "task_family": "mainline_skill",
        "task_label": "生成草图",
        "display_name": f"生成草图 · EP{body.episode} / Beat {body.beat}",
        "source_label": source_label,
        "target_label": "当前草图",
        "skill_id": "freezone.sketch_from_context",
    }
    if body.source_kind == "director_combined":
        if not source_url:
            raise HTTPException(400, "source_url is required for director_combined")
        return await _start_or_enqueue_mainline_director_control_sketch_job(
            ctx=ctx,
            project_dir=project_dir,
            episode=body.episode,
            beat=body.beat,
            director_combined_url=source_url,
            aspect_ratio=body.aspect_ratio,
            canvas_id=body.canvas_id or None,
            node_id=body.node_id or None,
            task_display={
                **task_display,
                "skill_id": "freezone.sketch_from_director_combined",
                "source_label": "导演合成图",
            },
        )
    if source_url:
        return await _start_or_enqueue_mainline_sketch_from_context_job(
            ctx=ctx,
            username=username,
            project_name=project_name,
            project_dir=project_dir,
            episode=body.episode,
            beat=body.beat,
            beat_payload=beat,
            background_url=source_url,
            aspect_ratio=body.aspect_ratio,
            canvas_id=body.canvas_id or None,
            node_id=body.node_id or None,
            task_display=task_display,
        )
    return await _start_or_enqueue_mainline_beat_sketch_task(
        ctx=ctx,
        username=username,
        project_name=project_name,
        project_dir=project_dir,
        episode=body.episode,
        beat=body.beat,
        canvas_id=body.canvas_id or None,
        node_id=body.node_id or None,
        task_display=task_display,
    )


@router.post(
    "/projects/{project}/freezone/frame-from-context",
    response_model=FreezoneJobAcceptedResponse,
    tags=[TAG_FREEZONE_IMAGE],
)
async def freezone_frame_from_context(
    project: str,
    body: FreezoneFrameFromContextRequest,
    user: dict = Depends(get_api_user),
):
    """主线上下文：从草图和可选背景生成分镜候选。"""
    ctx, username, project_name, project_dir, _output_dir = await _resolve_freezone_project(
        project, user
    )
    beat = await _load_freezone_beat_context(
        ctx=ctx,
        username=username,
        project=project_name,
        episode=body.episode,
        beat=body.beat,
    )
    return await _start_or_enqueue_mainline_frame_from_context_job(
        ctx=ctx,
        username=username,
        project_name=project_name,
        project_dir=project_dir,
        episode=body.episode,
        beat=body.beat,
        beat_payload=beat,
        sketch_url=body.sketch_url,
        reference_urls=[body.background_url] if body.background_url else [],
        extra_reference_urls=[*body.identity_urls, *body.prop_urls],
        identity_references=[],
        prop_references=[],
        aspect_ratio=body.aspect_ratio,
        quality=body.quality,
        canvas_id=body.canvas_id or None,
        node_id=body.node_id or None,
        task_display={
            "task_family": "mainline_skill",
            "task_label": "渲染分镜",
            "display_name": f"渲染分镜 · EP{body.episode} / Beat {body.beat}",
            "source_label": "草图 + 背景 + 身份/道具",
            "target_label": "当前分镜",
            "skill_id": "freezone.frame_from_context",
        },
    )


@router.post(
    "/projects/{project}/freezone/scene-360",
    response_model=FreezoneJobAcceptedResponse,
    tags=[TAG_FREEZONE_IMAGE],
)
async def freezone_scene_360(
    project: str,
    body: FreezoneScene360Request,
    user: dict = Depends(get_api_user),
):
    """图片处理：基于场景 master 源图生成 2:1 的 360 全景候选图。"""
    ctx, _username, _project_name, project_dir, _output_dir = await _resolve_freezone_project(
        project, user
    )
    base_paths = _resolve_url_list(project_dir, [body.reference_url])
    if not base_paths:
        raise HTTPException(400, "reference_url is required")
    base_path = Path(base_paths[0])
    scene_id = _infer_scene_id_from_master_path(base_path, project_dir)
    if not scene_id:
        raise HTTPException(400, "could not infer scene_id from reference_url")
    kwargs = {
        "ctx": ctx,
        "project_dir": project_dir,
        "scene_id": scene_id,
        "description": None,
        "master_url": body.reference_url,
        "reverse_url": body.reverse_reference_url,
        "model": body.model or FREEZONE_DEFAULT_IMAGE_MODEL,
        "image_size": MAINLINE_SCENE_360_IMAGE_SIZE,
        "quality": body.quality,
        "canvas_id": body.canvas_id or None,
        "node_id": body.node_id or None,
        "task_display": {
            "task_family": "mainline_skill",
            "task_label": "生成 360 全景",
            "display_name": f"生成 360 全景 · {scene_id or '场景'}",
            "source_label": "Master + Reverse",
            "target_label": "360 全景",
            "skill_id": "freezone.scene_360",
        },
    }
    if body.mode == "commit":
        return await _start_or_enqueue_mainline_scene_360_task(
            **kwargs,
            auto_commit=True,
        )
    return await _start_or_enqueue_mainline_scene_360_candidate_job(**kwargs)


async def _run_ai_staging_prop(request: dict[str, object]) -> dict[str, object]:
    return await asyncio.to_thread(generate_ai_staging_prop, request)


@router.post("/projects/{project}/freezone/ai-staging-prop", tags=[TAG_FREEZONE_SKILLS])
async def freezone_ai_staging_prop(
    project: str,
    request: dict[str, object] = Body(default_factory=dict),
    user: dict = Depends(get_api_user),
):
    await _resolve_freezone_project(project, user, required_role="editor")
    try:
        result = await _run_ai_staging_prop(request)
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    if not result.get("ok"):
        raise HTTPException(
            status_code=502, detail=str(result.get("error") or "AI staging prop failed")
        )
    return {"ok": True, "data": result}


@router.post(
    "/projects/{project}/freezone/skills/{skill_id}/run",
    response_model=SkillRunResponse,
    tags=[TAG_FREEZONE_SKILLS],
)
async def freezone_skill_run(
    project: str,
    skill_id: str,
    body: SkillRunRequest,
    user: dict = Depends(get_api_user),
):
    skill = find_skill(skill_id)
    if skill is None:
        _raise_skill_error(
            404,
            code="skill_not_found",
            category="not_found",
            message="skill not found",
            user_action_hint="Refresh the skill registry and try again.",
        )
    ctx, username, project_name, project_dir, _output_dir = await _resolve_freezone_project(
        project, user
    )
    idempotency_request_hash, idempotent_response = _idempotent_skill_run_response(
        project_dir,
        skill_id,
        body,
    )
    if idempotent_response is not None:
        return idempotent_response
    grouped = _group_and_validate_skill_inputs(
        skill,
        body.resolved_inputs,
        project=project,
        ctx=ctx,
        username=username,
        project_name=project_name,
    )
    auto_commit = _skill_node_is_preset_managed(
        project_dir=project_dir,
        ctx=ctx,
        canvas_id=body.canvas_id,
        skill_node_id=body.skill_node_id,
    )
    if _is_standalone_beat_context_input(_single_input(grouped, "beat_context")):
        auto_commit = False

    if skill_id in {"freezone.sketch_from_context", "freezone.sketch_from_director_combined"}:
        parameters = _skill_run_parameters(body)
        aspect_ratio = _normalize_mainline_skill_aspect_ratio(parameters.get("aspect_ratio"))
        beat_input = _required_input(grouped, "beat_context")
        is_standalone_beat_context = _is_standalone_beat_context_input(beat_input)
        if is_standalone_beat_context:
            if skill_id == "freezone.sketch_from_director_combined":
                reference_role = "director_combined"
                reference_input = _required_input(grouped, reference_role)
                source_label = "导演合成图"
            else:
                reference_role = "background"
                reference_input = _required_input(grouped, reference_role)
                source_label = "背景"
            reference_url = _required_image_url(reference_input, reference_role)
            reference_paths = _resolve_url_list(project_dir, [reference_url])
            model = str(parameters.get("model") or FREEZONE_DEFAULT_IMAGE_MODEL)
            accepted = await _start_or_enqueue_freezone_gen_job(
                ctx=ctx,
                username=username,
                project=project_name,
                project_dir=project_dir,
                output_dir=str(_output_dir),
                prompt=_standalone_beat_context_unified_sketch_prompt(
                    input_item=beat_input,
                    project_dir=project_dir,
                    reference_path=reference_paths[0] if reference_paths else "",
                    reference_role=reference_role,
                    aspect_ratio=aspect_ratio,
                    provider=None,
                    model=model,
                ),
                aspect_ratio=aspect_ratio,
                image_size=str(parameters.get("image_size") or "2K"),
                reference_urls=[reference_url],
                camera=None,
                style=None,
                provider=None,
                model=model,
                quality=str(parameters.get("quality") or "medium"),
                canvas_id=body.canvas_id,
                node_id=body.skill_node_id,
                task_display={
                    "task_label": "生成草图",
                    "display_name": "生成草图",
                    "source_label": source_label,
                    "target_label": "草图候选",
                    "skill_id": skill_id,
                },
            )
        else:
            episode, beat = _episode_and_beat_from_input(beat_input)
            if skill_id == "freezone.sketch_from_director_combined":
                director_combined = _required_input(grouped, "director_combined")
                accepted = await _start_or_enqueue_mainline_director_control_sketch_job(
                    ctx=ctx,
                    project_dir=project_dir,
                    episode=episode,
                    beat=beat,
                    director_combined_url=_required_image_url(
                        director_combined,
                        "director_combined",
                    ),
                    aspect_ratio=aspect_ratio,
                    canvas_id=body.canvas_id,
                    node_id=body.skill_node_id,
                    task_display={
                        "task_family": "mainline_skill",
                        "task_label": "导演合成图转草图",
                        "display_name": f"导演合成图转草图 · EP{episode} / Beat {beat}",
                        "source_label": "导演合成图",
                        "target_label": "当前草图候选",
                        "skill_id": skill_id,
                    },
                )
            else:
                background = _required_input(grouped, "background")
                accepted = await _start_or_enqueue_mainline_sketch_from_context_job(
                    ctx=ctx,
                    username=username,
                    project_name=project_name,
                    project_dir=project_dir,
                    episode=episode,
                    beat=beat,
                    beat_payload=_skill_beat_context_as_prompt_beat(beat_input),
                    background_url=_required_image_url(background, "background"),
                    aspect_ratio=aspect_ratio,
                    canvas_id=body.canvas_id,
                    node_id=body.skill_node_id,
                    task_display={
                        "task_family": "mainline_skill",
                        "task_label": "生成草图",
                        "display_name": f"生成草图 · EP{episode} / Beat {beat}",
                        "source_label": "背景",
                        "target_label": "当前草图",
                        "skill_id": skill_id,
                    },
                )
    elif skill_id == "freezone.frame_from_context":
        parameters = _skill_run_parameters(body)
        quality = _normalize_mainline_frame_quality(parameters.get("quality"))
        background_reference_mode = _skill_background_reference_mode(parameters)
        beat_input = _required_input(grouped, "beat_context")
        sketch = _required_input(grouped, "sketch")
        background = _single_input(grouped, "background")
        identity_references = _filter_canvas_references_by_beat_context(
            _canvas_references_from_inputs(grouped, "identity"),
            beat_input,
            "identity",
        )
        prop_references = _filter_canvas_references_by_beat_context(
            _canvas_references_from_inputs(grouped, "prop"),
            beat_input,
            "prop",
        )
        if _is_standalone_beat_context_input(beat_input):
            accepted = await _start_or_enqueue_standalone_frame_from_context_job(
                ctx=ctx,
                username=username,
                project_name=project_name,
                project_dir=project_dir,
                beat_input=beat_input,
                sketch_url=_required_image_url(sketch, "sketch"),
                reference_urls=(
                    [_required_image_url(background, "background")] if background else []
                ),
                extra_reference_urls=[],
                identity_references=identity_references,
                prop_references=prop_references,
                quality=quality,
                background_reference_mode=background_reference_mode,
                canvas_id=body.canvas_id,
                node_id=body.skill_node_id,
                task_display={
                    "task_family": "mainline_skill",
                    "task_label": "渲染分镜",
                    "display_name": "渲染分镜",
                    "source_label": "草图 + 背景 + 身份/道具",
                    "target_label": "分镜候选",
                    "skill_id": "freezone.frame_from_context",
                },
            )
        else:
            episode, beat = _episode_and_beat_from_input(beat_input)
            accepted = await _start_or_enqueue_mainline_frame_from_context_job(
                ctx=ctx,
                username=username,
                project_name=project_name,
                project_dir=project_dir,
                episode=episode,
                beat=beat,
                beat_payload=_skill_beat_context_as_prompt_beat(beat_input),
                sketch_url=_required_image_url(sketch, "sketch"),
                reference_urls=(
                    [_required_image_url(background, "background")] if background else []
                ),
                extra_reference_urls=[],
                identity_references=identity_references,
                prop_references=prop_references,
                quality=quality,
                background_reference_mode=background_reference_mode,
                canvas_id=body.canvas_id,
                node_id=body.skill_node_id,
                task_display={
                    "task_family": "mainline_skill",
                    "task_label": "渲染分镜",
                    "display_name": f"渲染分镜 · EP{episode} / Beat {beat}",
                    "source_label": "草图 + 背景 + 身份/道具",
                    "target_label": "当前分镜",
                    "skill_id": "freezone.frame_from_context",
                },
            )
    elif skill_id == "freezone.scene_360":
        scene_prompt = _scene_prompt_from_input(_single_input(grouped, "scene"))
        scene_master = _required_input(grouped, "scene_master")
        scene_reverse = _single_input(grouped, "scene_reverse_master")
        scene_id = _scene_id_from_scene_master_input(scene_master)
        description = _build_scene_360_prompt(scene_id)
        if scene_prompt:
            description = f"{description}\n\n场景提示词：{scene_prompt}"
        if auto_commit:
            accepted = await _start_or_enqueue_mainline_scene_360_task(
                ctx=ctx,
                project_dir=project_dir,
                scene_id=scene_id,
                description=description,
                master_url=_required_image_url(scene_master, "scene_master"),
                reverse_url=(
                    _required_image_url(scene_reverse, "scene_reverse_master")
                    if scene_reverse
                    else None
                ),
                model=None,
                image_size=MAINLINE_SCENE_360_IMAGE_SIZE,
                quality=None,
                canvas_id=body.canvas_id,
                node_id=body.skill_node_id,
                auto_commit=True,
                task_display={"skill_id": "freezone.scene_360"},
            )
        else:
            accepted = await _start_or_enqueue_mainline_scene_360_candidate_job(
                ctx=ctx,
                project_dir=project_dir,
                scene_id=str(scene_id),
                description=description,
                master_url=_required_image_url(scene_master, "scene_master"),
                reverse_url=(
                    _required_image_url(scene_reverse, "scene_reverse_master")
                    if scene_reverse
                    else None
                ),
                model=None,
                image_size=MAINLINE_SCENE_360_IMAGE_SIZE,
                quality=None,
                canvas_id=body.canvas_id,
                node_id=body.skill_node_id,
                task_display={"skill_id": "freezone.scene_360"},
            )
    elif skill_id == "freezone.set_selected_background":
        return await _run_set_selected_background_skill(
            project=project,
            project_dir=project_dir,
            ctx=ctx,
            username=username,
            project_name=project_name,
            skill=skill,
            grouped=grouped,
            body=body,
            user=user,
            idempotency_request_hash=idempotency_request_hash,
            auto_commit=auto_commit,
        )
    elif skill_id == "freezone.set_director_combined":
        return await _run_set_director_combined_skill(
            project=project,
            project_dir=project_dir,
            ctx=ctx,
            skill=skill,
            grouped=grouped,
            body=body,
            user=user,
            idempotency_request_hash=idempotency_request_hash,
            auto_commit=auto_commit,
        )
    elif skill_id == "agent.review_frame":
        run_id = f"agent.review_frame:{_new_job_id()}"
        output = _skill_output_metadata(skill, grouped)
        output["text"] = await _review_frame_text(body, grouped)
        _write_skill_run_metadata(
            project_dir,
            run_id,
            {
                "run_id": run_id,
                "skill_id": skill_id,
                "status": "completed",
                "outputs": [output],
                "canvas_id": body.canvas_id,
                "skill_node_id": body.skill_node_id,
            },
        )
        response = SkillRunResponse(run_id=run_id, status="completed")
        _append_canvas_event(
            project_dir=project_dir,
            project_id=project,
            canvas_id=body.canvas_id,
            event_type="skill.run_completed",
            actor=_canvas_event_actor(user),
            payload={
                "skill_id": skill_id,
                "skill_node_id": body.skill_node_id,
                "run_id": run_id,
                "status": response.status,
                "output_count": 1,
            },
        )
        _persist_skill_run_idempotency_response(
            project_dir,
            skill_id,
            body,
            idempotency_request_hash,
            response,
        )
        return response
    else:
        _raise_skill_error(
            501,
            code="skill_provider_not_runnable",
            category="unsupported",
            message="skill provider is not runnable",
            user_action_hint="Use a runnable skill provider or wait for its runtime integration.",
        )

    data = accepted.get("data") if isinstance(accepted, dict) else None
    if not isinstance(data, dict):
        _raise_skill_error(
            500,
            code="skill_run_metadata_missing",
            category="runtime",
            message="skill run did not return task metadata",
            retryable=True,
            user_action_hint="Retry the skill run. If this repeats, inspect the skill dispatcher.",
        )
    task_type = str(data.get("task_type") or "")
    job_id = str(data.get("job_id") or "")
    if not task_type or not job_id:
        _raise_skill_error(
            500,
            code="skill_run_metadata_incomplete",
            category="runtime",
            message="skill run missing task_type/job_id",
            retryable=True,
            user_action_hint="Retry the skill run. If this repeats, inspect the skill dispatcher.",
        )
    run_id = f"{task_type}:{job_id}"
    _write_skill_run_metadata(
        project_dir,
        run_id,
        {
            "run_id": run_id,
            "skill_id": skill_id,
            "status": "queued",
            "task_type": task_type,
            "job_id": job_id,
            "task_key": data.get("task_key"),
            "task_episode": data.get("task_episode", 0),
            "task_beat_num": data.get("task_beat_num"),
            "task_scope": data.get("task_scope") or job_id,
            "canvas_id": body.canvas_id,
            "skill_node_id": body.skill_node_id,
            "output": _skill_output_metadata(skill, grouped, auto_commit=auto_commit),
        },
    )
    response = SkillRunResponse(
        run_id=run_id,
        status="queued",
        task_key=data.get("task_key"),
        task_type=task_type,
        job_id=job_id,
    )
    _append_canvas_event(
        project_dir=project_dir,
        project_id=project,
        canvas_id=body.canvas_id,
        event_type="skill.run_requested",
        actor=_canvas_event_actor(user),
        payload={
            "skill_id": skill_id,
            "skill_node_id": body.skill_node_id,
            "run_id": run_id,
            "status": response.status,
            "task_type": task_type,
            "job_id": job_id,
        },
    )
    _persist_skill_run_idempotency_response(
        project_dir,
        skill_id,
        body,
        idempotency_request_hash,
        response,
    )
    return response


@router.post(
    "/projects/{project}/freezone/multi-view",
    response_model=FreezoneJobAcceptedResponse,
    tags=[TAG_FREEZONE_IMAGE],
)
async def freezone_multi_view(
    project: str,
    body: FreezoneCharacterMultiViewRequest,
    user: dict = Depends(get_api_user),
):
    """图片处理：基于单张源图做多角度重构 / 机位重定位。"""
    ctx, username, project_name, project_dir, output_dir = await _resolve_freezone_project(
        project, user
    )
    return await _start_or_enqueue_freezone_edit_job(
        ctx=ctx,
        username=username,
        project=project_name,
        project_dir=project_dir,
        output_dir=output_dir,
        prompt=_build_multi_view_prompt(body),
        base_url=body.source_url,
        extra_reference_urls=[],
        aspect_ratio="16:9",
        image_size=body.image_size or "2K",
        camera=body.camera,
        style=body.style,
        provider=None,
        model=body.model or FREEZONE_DEFAULT_IMAGE_MODEL,
        quality=body.quality or "medium",
    )


@router.post(
    "/projects/{project}/freezone/relight",
    response_model=FreezoneJobAcceptedResponse,
    tags=[TAG_FREEZONE_IMAGE],
)
async def freezone_relight(
    project: str,
    body: FreezoneRelightRequest,
    user: dict = Depends(get_api_user),
):
    """图片处理：打光。基于源图和打光参考图的光照重塑接口。"""
    ctx, username, project_name, project_dir, output_dir = await _resolve_freezone_project(
        project, user
    )
    return await _start_or_enqueue_freezone_edit_job(
        ctx=ctx,
        username=username,
        project=project_name,
        project_dir=project_dir,
        output_dir=output_dir,
        prompt=_build_relight_prompt(body),
        base_url=body.source_url,
        extra_reference_urls=[body.lighting_reference_url] if body.lighting_reference_url else [],
        aspect_ratio="16:9",
        image_size=body.image_size or "2K",
        camera=None,
        style=None,
        provider=None,
        model=body.model or FREEZONE_DEFAULT_IMAGE_MODEL,
        quality=body.quality or "medium",
    )


@router.post(
    "/projects/{project}/freezone/template-edit",
    response_model=FreezoneJobAcceptedResponse,
    tags=[TAG_FREEZONE_IMAGE],
)
async def freezone_template_edit(
    project: str,
    body: FreezoneTemplateEditRequest,
    user: dict = Depends(get_api_user),
):
    """图片处理：九宫格下拉菜单统一编辑接口。"""
    ctx, username, project_name, project_dir, output_dir = await _resolve_freezone_project(
        project, user
    )
    return await _start_or_enqueue_freezone_edit_job(
        ctx=ctx,
        username=username,
        project=project_name,
        project_dir=project_dir,
        output_dir=output_dir,
        prompt=_build_template_edit_prompt(body),
        base_url=body.source_url,
        extra_reference_urls=[],
        aspect_ratio=_template_edit_aspect_ratio(body.mode),
        image_size=body.image_size or "2K",
        camera=body.camera,
        style=body.style,
        provider=None,
        model=body.model or FREEZONE_DEFAULT_IMAGE_MODEL,
        quality=body.quality or "medium",
    )


@router.get("/projects/{project}/freezone/image/camera-options", tags=[TAG_FREEZONE_IMAGE])
async def freezone_image_camera_options(
    project: str,
    user: dict = Depends(get_api_user),
):
    """图片处理：返回摄像机参数选项列表。"""
    await _resolve_freezone_project(project, user, required_role="viewer")
    return {"ok": True, "data": _get_freezone_image_camera_options()}


@router.get("/projects/{project}/freezone/image/style-templates", tags=[TAG_FREEZONE_IMAGE])
async def freezone_image_style_templates(
    project: str,
    user: dict = Depends(get_api_user),
):
    """图片处理：返回内置风格模板列表。"""
    await _resolve_freezone_project(project, user, required_role="viewer")
    return {"ok": True, "data": _get_freezone_image_style_templates()}


def _freezone_not_implemented(endpoint: str) -> None:
    raise HTTPException(
        status_code=501,
        detail=(
            f"{endpoint} is reserved in the API surface but not implemented yet. "
            "Keep using the existing image routes or frontend-local tools for now."
        ),
    )


@router.post(
    "/projects/{project}/freezone/image-to-3gs",
    response_model=FreezoneStageAssetAcceptedResponse,
    tags=[TAG_FREEZONE_IMAGE],
)
async def freezone_image_to_3gs(
    project: str,
    body: FreezoneImageTo3GSRequest,
    user: dict = Depends(get_api_user),
):
    """图片处理：把 Freezone 图片节点作为 SHARP 输入，生成 Freezone 3GS PLY。"""
    ctx, username, project_name, project_dir, _output_dir = await _resolve_freezone_project(
        project, user
    )

    try:
        source_path = resolve_static_url_to_path(body.source_url, project_dir)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    if not source_path.exists():
        raise HTTPException(404, f"source not found: {source_path}")
    if source_path.suffix.lower() not in {".png", ".jpg", ".jpeg", ".webp"}:
        raise HTTPException(400, f"source must be an image: {source_path}")

    scene_id = _infer_image_to_3gs_scene_id(source_path, project_dir)
    source_kind = body.source_kind
    step = "pano_sharp" if source_kind == "pano" else "single_face_sharp"
    job_id = _new_job_id()
    if source_kind == "pano":
        params = {
            "pano_path": str(source_path),
            "depth_source": "da2",
            "depth_device": "auto",
            "device": "auto",
            "face_size": 768,
            "internal_size": 1536,
            "max_gaussians_per_face": 1_000_000,
            "timeout_seconds": 1800,
            "source_url": body.source_url,
        }
    else:
        params = {
            "image_path": str(source_path),
            "source_kind": source_kind,
            "face_name": "front",
            "depth_meters": 8.0,
            "device": "auto",
            "face_size": 768,
            "internal_size": 1536,
            "max_gaussians_per_face": 1_000_000,
            "timeout_seconds": 1800,
            "source_url": body.source_url,
        }
    try:
        task_data = await _start_or_enqueue_freezone_image_to_3gs(
            ctx=ctx,
            username=username,
            project=project_name,
            project_dir=project_dir,
            job_id=job_id,
            scene_id=scene_id,
            source_path=source_path,
            source_kind=source_kind,
            params=params,
            canvas_id=body.canvas_id or None,
            node_id=body.node_id or None,
        )
    except RuntimeError as exc:
        _handle_task_start_runtime_error("failed to start image-to-3gs task", exc)
        raise HTTPException(503, f"failed to start image-to-3gs task: {exc}") from exc

    return {
        "ok": True,
        "data": {
            "task_type": "freezone_image_to_3gs",
            "job_id": job_id,
            "scope": job_id,
            "scene_id": scene_id,
            "step": step,
            **task_data,
        },
    }


@router.post("/projects/{project}/freezone/upscale", tags=[TAG_FREEZONE_IMAGE])
async def freezone_upscale(
    project: str,
    body: FreezoneUpscaleRequest,
    user: dict = Depends(get_api_user),
):
    """图片处理：高清放大接口。"""
    ctx, username, project_name, project_dir, output_dir = await _resolve_freezone_project(
        project, user
    )

    try:
        source_path = resolve_static_url_to_path(body.source_url, project_dir)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    if not source_path.exists():
        raise HTTPException(404, f"source not found: {source_path}")

    job_id = _new_job_id()
    resolved_aspect_ratio = _resolve_outpaint_aspect_ratio(source_path, "original")
    resolved_provider, resolved_model = _split_provider_and_model(
        None,
        body.model or FREEZONE_DEFAULT_IMAGE_MODEL,
    )
    provider = _resolve_freezone_image_provider(resolved_provider, strict=False)

    try:
        return await _start_or_enqueue_freezone_edit_path(
            ctx=ctx,
            username=username,
            project=project_name,
            project_dir=project_dir,
            output_dir=output_dir,
            job_id=job_id,
            prompt=_merge_prompt_with_style_and_camera(
                _build_upscale_prompt(), body.style, body.camera
            ),
            base_path=source_path,
            extra_reference_paths=[],
            aspect_ratio=resolved_aspect_ratio,
            image_size=body.image_size,
            provider=provider,
            model=resolved_model,
            quality=body.quality or "medium",
        )
    except RuntimeError as e:
        _handle_task_start_runtime_error("failed to start upscale task", e)
        raise HTTPException(503, f"failed to start upscale task: {e}") from e


@router.post(
    "/projects/{project}/freezone/outpaint",
    response_model=FreezoneJobAcceptedResponse,
    tags=[TAG_FREEZONE_IMAGE],
)
async def freezone_outpaint(
    project: str,
    body: FreezoneOutpaintRequest,
    user: dict = Depends(get_api_user),
):
    """图片处理：扩图接口。

    做法是先把原图补白到目标宽高比，再复用现有图片编辑任务，
    让模型去生成新暴露出来的外部区域，而不是简单拉伸原图。
    """
    ctx, username, project_name, project_dir, output_dir = await _resolve_freezone_project(
        project, user
    )

    try:
        source_path = resolve_static_url_to_path(body.source_url, project_dir)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    if not source_path.exists():
        raise HTTPException(404, f"source not found: {source_path}")
    if body.num_images != 1:
        raise HTTPException(400, "outpaint currently supports only num_images = 1")

    resolved_aspect_ratio = _resolve_outpaint_aspect_ratio(
        source_path,
        body.target_aspect_ratio,
    )
    padded_base_path = _prepare_padded_outpaint_base(
        source_path=source_path,
        project_dir=project_dir,
        target_aspect_ratio=resolved_aspect_ratio,
    )
    job_id = _new_job_id()
    resolved_provider, resolved_model = _split_provider_and_model(
        None,
        body.model or FREEZONE_DEFAULT_IMAGE_MODEL,
    )
    provider = _resolve_freezone_image_provider(resolved_provider, strict=False)

    try:
        return await _start_or_enqueue_freezone_edit_path(
            ctx=ctx,
            username=username,
            project=project_name,
            project_dir=project_dir,
            output_dir=output_dir,
            job_id=job_id,
            prompt=_merge_prompt_with_style_and_camera(
                _build_outpaint_prompt(), body.style, body.camera
            ),
            base_path=padded_base_path,
            extra_reference_paths=[],
            aspect_ratio=resolved_aspect_ratio,
            image_size=body.image_size,
            provider=provider,
            model=resolved_model,
            quality=body.quality or "medium",
        )
    except RuntimeError as e:
        _handle_task_start_runtime_error("failed to start outpaint task", e)
        raise HTTPException(503, f"failed to start outpaint task: {e}") from e


@router.post(
    "/projects/{project}/freezone/redraw",
    response_model=FreezoneJobAcceptedResponse,
    tags=[TAG_FREEZONE_IMAGE],
)
async def freezone_redraw(
    project: str,
    body: FreezoneRedrawRequest,
    user: dict = Depends(get_api_user),
):
    """图片处理：重绘接口。"""
    ctx, username, project_name, project_dir, output_dir = await _resolve_freezone_project(
        project, user
    )

    try:
        source_path = resolve_static_url_to_path(body.source_url, project_dir)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    if not source_path.exists():
        raise HTTPException(404, f"source not found: {source_path}")

    if body.num_images != 1:
        raise HTTPException(400, "num_images is currently limited to 1")

    job_id = _new_job_id()
    resolved_aspect_ratio = _resolve_outpaint_aspect_ratio(source_path, body.aspect_ratio)
    resolved_provider, resolved_model = _split_provider_and_model(
        None,
        body.model or FREEZONE_DEFAULT_IMAGE_MODEL,
    )
    provider = _resolve_freezone_image_provider(resolved_provider, strict=False)

    if body.mask_url:
        try:
            mask_path = resolve_static_url_to_path(body.mask_url, project_dir)
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        if not mask_path.exists():
            raise HTTPException(404, f"mask not found: {mask_path}")

        try:
            return await _start_or_enqueue_freezone_mask_edit_path(
                ctx=ctx,
                username=username,
                project=project_name,
                project_dir=project_dir,
                output_dir=output_dir,
                job_id=job_id,
                base_path=source_path,
                mask_path=mask_path,
                prompt=_merge_prompt_with_style_and_camera(
                    (
                        _build_redraw_prompt(body.prompt)
                        if body.prompt.strip()
                        else _build_erase_prompt()
                    ),
                    body.style,
                    body.camera,
                ),
                aspect_ratio=resolved_aspect_ratio,
                image_size=body.image_size,
                quality=body.quality or "medium",
                provider=provider,
                model=resolved_model,
            )
        except RuntimeError as e:
            _handle_task_start_runtime_error("failed to start masked redraw task", e)
            raise HTTPException(503, f"failed to start masked redraw task: {e}") from e

    try:
        return await _start_or_enqueue_freezone_edit_path(
            ctx=ctx,
            username=username,
            project=project_name,
            project_dir=project_dir,
            output_dir=output_dir,
            job_id=job_id,
            prompt=_merge_prompt_with_style_and_camera(
                _build_redraw_prompt(body.prompt), body.style, body.camera
            ),
            base_path=source_path,
            extra_reference_paths=[],
            aspect_ratio=resolved_aspect_ratio,
            image_size=body.image_size,
            provider=provider,
            model=resolved_model,
            quality=body.quality or "medium",
        )
    except RuntimeError as e:
        _handle_task_start_runtime_error("failed to start redraw task", e)
        raise HTTPException(503, f"failed to start redraw task: {e}") from e


# ============================================================
# 视频处理：抽帧 / 镜头分析
# ============================================================


@router.post("/projects/{project}/freezone/extract-frames", tags=[TAG_FREEZONE_VIDEO])
async def freezone_extract_frames(
    project: str,
    body: FreezoneExtractFramesRequest,
    user: dict = Depends(get_api_user),
):
    """视频处理：从视频中抽取关键帧，返回任务 `task_key`。"""
    ctx, username, project_name, project_dir, output_dir = await _resolve_freezone_project(
        project, user
    )

    try:
        video_path = resolve_static_url_to_path(body.video_url, project_dir)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    if not video_path.exists():
        raise HTTPException(404, f"video not found: {video_path}")

    job_id = _new_job_id()
    return await _enqueue_or_start_freezone_video_analysis(
        ctx=ctx,
        username=username,
        project=project_name,
        project_dir=project_dir,
        output_dir=output_dir,
        task_type="freezone_extract",
        job_id=job_id,
        payload={
            "video_path": str(video_path),
            "max_frames": body.max_frames,
            "scene_threshold": body.scene_threshold,
        },
    )


@router.post("/projects/{project}/freezone/analyze-shots", tags=[TAG_FREEZONE_VIDEO])
async def freezone_analyze_shots(
    project: str,
    body: FreezoneAnalyzeShotsRequest,
    user: dict = Depends(get_api_user),
):
    """视频处理：分析一组关键帧的镜头内容，返回任务 `task_key`。"""
    ctx, username, project_name, project_dir, output_dir = await _resolve_freezone_project(
        project, user
    )

    if not body.frame_urls:
        raise HTTPException(400, "frame_urls is required (non-empty)")

    frame_paths: list[str] = []
    for url in body.frame_urls:
        try:
            p = resolve_static_url_to_path(url, project_dir)
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        if not p.exists():
            raise HTTPException(404, f"frame not found: {p}")
        frame_paths.append(str(p))

    job_id = _new_job_id()
    return await _enqueue_or_start_freezone_video_analysis(
        ctx=ctx,
        username=username,
        project=project_name,
        project_dir=project_dir,
        output_dir=output_dir,
        task_type="freezone_analyze",
        job_id=job_id,
        payload={
            "frame_paths": frame_paths,
            "provider": body.provider,
            "model": body.model,
            "analysis_mode": body.analysis_mode,
            "duration_sec": body.duration_sec,
        },
    )


@router.post("/projects/{project}/freezone/analyze-video-story", tags=[TAG_FREEZONE_VIDEO])
async def freezone_analyze_video_story(
    project: str,
    body: FreezoneAnalyzeVideoStoryRequest,
    user: dict = Depends(get_api_user),
):
    """视频处理：抽帧并解析视频故事，返回任务 `task_key`。"""
    ctx, username, project_name, project_dir, output_dir = await _resolve_freezone_project(
        project, user
    )

    try:
        video_path = resolve_static_url_to_path(body.video_url, project_dir)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    if not video_path.exists():
        raise HTTPException(404, f"video not found: {video_path}")

    job_id = _new_job_id()
    return await _enqueue_or_start_freezone_video_analysis(
        ctx=ctx,
        username=username,
        project=project_name,
        project_dir=project_dir,
        output_dir=output_dir,
        task_type="freezone_video_story",
        job_id=job_id,
        payload={
            "video_path": str(video_path),
            "max_frames": body.max_frames,
            "scene_threshold": body.scene_threshold,
            "duration_sec": body.duration_sec,
        },
    )


# ============================================================
# 文本工具：中英互译
# ============================================================


def _text_translate_output_path(project_dir: Path, job_id: str) -> Path:
    return outputs_dir(project_dir, "freezone_text_translate") / f"{job_id}.json"


def _freezone_history_preview(text: str, limit: int = 240) -> str:
    compact = " ".join(str(text or "").split())
    if len(compact) <= limit:
        return compact
    return compact[: limit - 3] + "..."


def _record_freezone_node_history(
    *,
    ctx: ProjectContext | None = None,
    project_dir: Path,
    canvas_id: str | None,
    node_id: str | None,
    task_type: str,
    username: str,
    project: str,
    job_id: str,
    status: str,
    media_type: str,
    result: dict | None = None,
    error: str | None = None,
    prompt: str | None = None,
    **extra,
) -> dict | None:
    if not node_id:
        return None
    try:
        task_key = (
            project_task_state_key(task_type, ctx.project_id, 0, scope=job_id)
            if ctx is not None
            else task_state_key(task_type, username, project, episode=0, scope=job_id)
        )
        return append_generation_history(
            project_dir=project_dir,
            canvas_id=canvas_id or "default",
            node_id=node_id,
            record=build_node_history_record(
                task_type=task_type,
                job_id=job_id,
                task_key=task_key,
                status=status,
                media_type=media_type,
                result=result,
                error=error,
                prompt=prompt,
                extra=extra,
            ),
        )
    except Exception as exc:
        logger.warning("failed to record freezone node history: %s", exc)
        return None


def _start_freezone_text_translate_task(
    *,
    username: str,
    project: str,
    project_dir: Path,
    job_id: str,
    text: str,
    node_type: Literal["generic", "image", "video", "audio", "text"],
    canvas_id: str | None = None,
    node_id: str | None = None,
) -> None:
    task_type = "freezone_text_translate"
    task_manager = get_task_manager()
    metadata = {
        "job_id": job_id,
        "canvas_id": canvas_id or "",
        "node_id": node_id or "",
        "node_type": node_type,
    }
    task_manager.create_task(
        task_type,
        username,
        project,
        episode=0,
        scope=job_id,
        status="starting",
        metadata=metadata,
    )

    async def _runner() -> None:
        logs = ["开始翻译文本"]
        try:
            task_manager.update_progress(
                task_type,
                username,
                project,
                episode=0,
                scope=job_id,
                progress=0.1,
                current_task="translating_text",
                logs=logs,
            )
            translated_text, source_language, target_language = await translate_freezone_text(
                text=text,
                node_type=node_type,
            )
            payload = {
                "translated_text": translated_text,
                "source_language": source_language,
                "target_language": target_language,
                "node_type": node_type,
            }
            out = _text_translate_output_path(project_dir, job_id)
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
            history_record = _record_freezone_node_history(
                project_dir=project_dir,
                canvas_id=canvas_id,
                node_id=node_id,
                task_type=task_type,
                username=username,
                project=project,
                job_id=job_id,
                status="completed",
                media_type="text",
                node_type=node_type,
                input_preview=_freezone_history_preview(text),
                prompt=text,
                result={"output_format": "json", **payload},
            )
            result = {"output_format": "json"}
            if history_record:
                result["generation_history_record"] = history_record
            task_manager.complete_task(
                task_type,
                username,
                project,
                episode=0,
                scope=job_id,
                result=result,
                current_task="completed",
                logs=["文本翻译完成"],
                metadata=metadata,
            )
        except Exception as exc:
            _record_freezone_node_history(
                project_dir=project_dir,
                canvas_id=canvas_id,
                node_id=node_id,
                task_type=task_type,
                username=username,
                project=project,
                job_id=job_id,
                status="failed",
                media_type="text",
                node_type=node_type,
                input_preview=_freezone_history_preview(text),
                prompt=text,
                error=str(exc),
            )
            task_manager.fail_task(
                task_type,
                username,
                project,
                episode=0,
                scope=job_id,
                error=str(exc),
                current_task="failed",
                logs=[f"错误: {exc}"],
                metadata=metadata,
            )

    asyncio.create_task(_runner())


@router.post(
    "/projects/{project}/freezone/text/translate",
    response_model=FreezoneJobAcceptedResponse,
    tags=[TAG_FREEZONE_TEXT],
)
async def freezone_text_translate(
    project: str,
    body: FreezoneTextTranslateRequest,
    user: dict = Depends(get_api_user),
):
    """文本工具：中英文互译，供各类节点编写提示词时直接调用。"""
    ctx, username, project_name, project_dir, _output_dir = await _resolve_freezone_project(
        project, user
    )

    if not body.text.strip():
        raise HTTPException(400, "text is required")

    try:
        job_id = _new_job_id()
        if ctx is not None:
            return await _enqueue_freezone_background_job(
                ctx=ctx,
                project_dir=project_dir,
                task_type="freezone_text_translate",
                job_id=job_id,
                payload={
                    "text": body.text,
                    "node_type": body.node_type,
                    "canvas_id": body.canvas_id or "",
                    "node_id": body.node_id or "",
                },
            )
        _start_freezone_text_translate_task(
            username=username,
            project=project_name,
            project_dir=project_dir,
            job_id=job_id,
            text=body.text,
            node_type=body.node_type,
            canvas_id=body.canvas_id or None,
            node_id=body.node_id or None,
        )
    except RuntimeError as exc:
        _handle_task_start_runtime_error("failed to start text translate task", exc)
        raise HTTPException(503, f"failed to start text translate task: {exc}") from exc

    return _accepted_job_response(
        task_type="freezone_text_translate",
        username=username,
        project=project_name,
        job_id=job_id,
    )


def _read_freezone_text_file(path: Path) -> str:
    """读取 Freezone 文本节点的源文本文件。"""
    for encoding in ("utf-8", "utf-8-sig", "gb18030"):
        try:
            return path.read_text(encoding=encoding)
        except UnicodeDecodeError:
            continue
    raise HTTPException(400, f"unsupported text encoding: {path.name}")


def _story_script_output_path(project_dir: Path, job_id: str) -> Path:
    return outputs_dir(project_dir, "freezone_story_script") / f"{job_id}.json"


def _image_reverse_prompt_output_path(project_dir: Path, job_id: str) -> Path:
    return outputs_dir(project_dir, "freezone_image_reverse_prompt") / f"{job_id}.json"


def _video_compose_output_path(project_dir: Path, job_id: str) -> Path:
    return outputs_dir(project_dir, "freezone_video_compose") / f"{job_id}.mp4"


def _video_erase_output_path(project_dir: Path, job_id: str) -> Path:
    return outputs_dir(project_dir, "freezone_video_erase") / f"{job_id}.mp4"


def _video_upscale_output_path(project_dir: Path, job_id: str) -> Path:
    return outputs_dir(project_dir, "freezone_video_upscale") / f"{job_id}.mp4"


def _audio_separate_audio_output_path(project_dir: Path, job_id: str) -> Path:
    return outputs_dir(project_dir, "freezone_audio_separate") / f"{job_id}.m4a"


def _audio_separate_mute_video_output_path(project_dir: Path, job_id: str) -> Path:
    return outputs_dir(project_dir, "freezone_audio_separate") / f"{job_id}_mute.mp4"


def _public_freezone_video_story_result(result: dict) -> dict:
    return {
        key: value for key, value in result.items() if key not in {"output_path", "frame_paths"}
    }


def _infer_image_to_3gs_scene_id(source_path: Path, project_dir: Path) -> str:
    """Best-effort label for Freezone image→3GS jobs; it no longer controls output path."""
    try:
        parts = source_path.resolve().relative_to(project_dir.resolve()).parts
    except ValueError:
        parts = source_path.parts
    for marker in ("scenes", "director_worlds"):
        if marker in parts:
            idx = parts.index(marker)
            if idx + 1 < len(parts):
                return str(parts[idx + 1]).strip()
    return source_path.stem or "freezone"


def _copy_image_matching_existing_target(source_path: Path, target: Path) -> dict:
    """Copy image to target, preserving the existing target canvas size when present.

    Freezone outputs may use a model-friendly ratio such as 2:3, while legacy
    NovelVideo beat sketches are often trimmed grid cells like 233x383.  On push
    back, keep the whole source image and letterbox it into the existing target
    dimensions instead of cropping.
    """
    if not target.exists():
        shutil.copy2(source_path, target)
        return {"adapted": False}

    from PIL import Image, ImageOps

    with Image.open(target) as target_img:
        target_size = target_img.size
        target_mode = target_img.mode
    with Image.open(source_path) as source_img:
        source = ImageOps.exif_transpose(source_img)
        source_size = source.size
        if source_size == target_size:
            shutil.copy2(source_path, target)
            return {
                "adapted": False,
                "source_size": list(source_size),
                "target_size": list(target_size),
            }

        if target_mode in {"RGBA", "LA"}:
            canvas_mode = "RGBA"
            background = (255, 255, 255, 0)
            source = source.convert("RGBA")
        else:
            canvas_mode = "RGB"
            background = (255, 255, 255)
            source = source.convert("RGB")

        fitted = ImageOps.contain(source, target_size, Image.Resampling.LANCZOS)
        canvas = Image.new(canvas_mode, target_size, background)
        offset = (
            (target_size[0] - fitted.size[0]) // 2,
            (target_size[1] - fitted.size[1]) // 2,
        )
        canvas.paste(fitted, offset, fitted if fitted.mode == "RGBA" else None)
        save_kwargs = {"format": "PNG"} if target.suffix.lower() == ".png" else {}
        canvas.save(target, **save_kwargs)
        return {
            "adapted": True,
            "source_size": list(source_size),
            "target_size": list(target_size),
            "fitted_size": list(fitted.size),
        }


def _start_freezone_video_compose_task(
    *,
    username: str,
    project: str,
    project_dir: Path,
    job_id: str,
    body: FreezoneVideoComposeRequest,
    resolved_tracks: list[dict],
) -> None:
    task_type = "freezone_video_compose"
    task_manager = get_task_manager()
    task_manager.create_task(
        task_type, username, project, episode=0, scope=job_id, status="starting"
    )

    async def _runner() -> None:
        try:
            task_manager.update_progress(
                task_type,
                username,
                project,
                episode=0,
                scope=job_id,
                progress=0.05,
                current_task="validating_timeline",
                logs=["开始合成视频时间线"],
            )
            from novelvideo.freezone.jobs import run_freezone_video_compose

            output_path = await run_freezone_video_compose(
                project_dir=project_dir,
                job_id=job_id,
                title=body.title,
                canvas_id=body.canvas_id,
                resolution=body.resolution,
                fps=body.fps,
                background_color=body.background_color,
                keep_original_audio=body.keep_original_audio,
                tracks=resolved_tracks,
            )
            task_manager.complete_task(
                task_type,
                username,
                project,
                episode=0,
                scope=job_id,
                result={"output_format": "mp4", "output_path": str(output_path)},
                current_task="completed",
                logs=["视频合成完成"],
            )
        except Exception as exc:
            task_manager.fail_task(
                task_type,
                username,
                project,
                episode=0,
                scope=job_id,
                error=str(exc),
                current_task="failed",
                logs=[f"错误: {exc}"],
            )

    asyncio.create_task(_runner())


def _start_freezone_video_erase_task(
    *,
    username: str,
    project: str,
    project_dir: Path,
    job_id: str,
    source_path: Path,
    body: FreezoneVideoEraseRequest,
) -> None:
    task_type = "freezone_video_erase"
    task_manager = get_task_manager()
    task_manager.create_task(
        task_type, username, project, episode=0, scope=job_id, status="starting"
    )

    async def _runner() -> None:
        try:
            task_manager.update_progress(
                task_type,
                username,
                project,
                episode=0,
                scope=job_id,
                progress=0.05,
                current_task="analyzing_video",
                logs=["开始视频擦除处理"],
            )
            from novelvideo.freezone.jobs import run_freezone_video_erase

            output_path, meta = await run_freezone_video_erase(
                project_dir=project_dir,
                job_id=job_id,
                source_path=str(source_path),
                mode=body.mode,
                box_x=body.box_x,
                box_y=body.box_y,
                box_width=body.box_width,
                box_height=body.box_height,
            )
            task_manager.complete_task(
                task_type,
                username,
                project,
                episode=0,
                scope=job_id,
                result={
                    "output_format": "mp4",
                    "output_path": str(output_path),
                    "meta": meta,
                },
                current_task="completed",
                logs=["视频擦除完成"],
            )
        except Exception as exc:
            task_manager.fail_task(
                task_type,
                username,
                project,
                episode=0,
                scope=job_id,
                error=str(exc),
                current_task="failed",
                logs=[f"错误: {exc}"],
            )

    asyncio.create_task(_runner())


def _start_freezone_video_upscale_task(
    *,
    username: str,
    project: str,
    project_id: str,
    project_dir: Path,
    job_id: str,
    source_path: Path,
    body: FreezoneVideoUpscaleRequest,
) -> None:
    task_type = "freezone_video_upscale"
    task_manager = get_task_manager()
    task_manager.create_task(
        task_type,
        username,
        project,
        episode=0,
        scope=job_id,
        status="starting",
    )

    async def _runner() -> None:
        try:
            task_manager.update_progress(
                task_type,
                username,
                project,
                episode=0,
                scope=job_id,
                progress=0.05,
                current_task="upscaling_video",
                logs=["开始视频高清处理"],
            )
            from novelvideo.freezone.jobs import run_freezone_video_upscale

            output_path, meta = await run_freezone_video_upscale(
                project_dir=project_dir,
                job_id=job_id,
                source_path=str(source_path),
                resolution=body.resolution,
                frame_interpolation=body.frame_interpolation,
                denoise_strength=body.denoise_strength,
            )
            rel = output_path.relative_to(project_dir).as_posix()
            task_manager.complete_task(
                task_type,
                username,
                project,
                episode=0,
                scope=job_id,
                result={
                    "output_format": "mp4",
                    "output_url": project_static_url(project_id, rel, local_path=output_path),
                    "meta": meta,
                },
                current_task="completed",
                logs=["视频高清处理完成"],
            )
        except Exception as exc:
            task_manager.fail_task(
                task_type,
                username,
                project,
                episode=0,
                scope=job_id,
                error=str(exc),
                current_task="failed",
                logs=[f"错误: {exc}"],
            )

    asyncio.create_task(_runner())


def _start_freezone_audio_separate_task(
    *,
    username: str,
    project: str,
    project_dir: Path,
    job_id: str,
    source_path: Path,
    target_episode: int | None = None,
    target_beat: int | None = None,
) -> None:
    task_type = "freezone_audio_separate"
    task_manager = get_task_manager()
    task_manager.create_task(
        task_type, username, project, episode=0, scope=job_id, status="starting"
    )

    async def _runner() -> None:
        try:
            task_manager.update_progress(
                task_type,
                username,
                project,
                episode=0,
                scope=job_id,
                progress=0.05,
                current_task="separating_audio_video",
                logs=["开始音视频分离"],
            )
            from novelvideo.freezone.jobs import run_freezone_audio_separate

            outputs = await run_freezone_audio_separate(
                project_dir=project_dir,
                job_id=job_id,
                source_path=str(source_path),
            )
            result = {"job_id": job_id}
            if target_episode and target_beat and outputs.get("audio_path"):
                result["pushable"] = True
                result["slot_target"] = {
                    "kind": "beat_audio",
                    "episode": int(target_episode),
                    "beat": int(target_beat),
                }
            task_manager.complete_task(
                task_type,
                username,
                project,
                episode=0,
                scope=job_id,
                result=result,
                current_task="completed",
                logs=["音视频分离完成"],
            )
        except Exception as exc:
            task_manager.fail_task(
                task_type,
                username,
                project,
                episode=0,
                scope=job_id,
                error=str(exc),
                current_task="failed",
                logs=[f"错误: {exc}"],
            )

    asyncio.create_task(_runner())


def _start_freezone_audio_speech_task(
    *,
    username: str,
    project: str,
    account_voice_username: str | None,
    project_id: str,
    project_dir: Path,
    job_id: str,
    body: FreezoneAudioSpeechRequest,
) -> None:
    task_type = "freezone_audio_speech"
    task_manager = get_task_manager()
    task_manager.create_task(
        task_type, username, project, episode=0, scope=job_id, status="starting"
    )

    async def _runner() -> None:
        store = None
        try:
            task_manager.update_progress(
                task_type,
                username,
                project,
                episode=0,
                scope=job_id,
                progress=0.05,
                current_task="preparing_audio_speech",
                logs=["开始文本生成语音"],
            )
            task_manager.update_progress(
                task_type,
                username,
                project,
                episode=0,
                scope=job_id,
                progress=0.2,
                current_task="calling_tts_provider",
                logs=["正在调用 TTS 服务"],
            )
            store = await make_sqlite_store(username, project)
            result = await generate_freezone_audio_speech(
                store=store,
                username=username,
                project=project,
                account_voice_username=account_voice_username,
                project_dir=project_dir,
                job_id=job_id,
                text=body.text,
                emotion_prompt=body.emotion_prompt,
                voice_ref=body.voice_ref.model_dump() if body.voice_ref else None,
            )
            rel = result.audio_path.relative_to(project_dir).as_posix()
            audio_url = project_static_url(project_id, rel, local_path=result.audio_path)
            result_payload = {
                "url": audio_url,
                "audio_url": audio_url,
                "audio_size": result.audio_path.stat().st_size,
                "duration_ms": result.duration_ms,
                "mime_type": result.mime_type,
                "model": result.model,
                "voice_source": result.voice_source,
                "voice_sha256": result.voice_sha256,
            }
            if body.target_episode and body.target_beat:
                result_payload["pushable"] = True
                result_payload["slot_target"] = {
                    "kind": "beat_audio",
                    "episode": int(body.target_episode),
                    "beat": int(body.target_beat),
                }
            task_manager.complete_task(
                task_type,
                username,
                project,
                episode=0,
                scope=job_id,
                result=result_payload,
                current_task="completed",
                logs=["文本生成语音完成"],
            )
        except Exception as exc:
            task_manager.fail_task(
                task_type,
                username,
                project,
                episode=0,
                scope=job_id,
                error=str(exc),
                current_task="failed",
                logs=[f"错误: {exc}"],
            )
        finally:
            close = getattr(store, "close", None) if store is not None else None
            if close:
                await close()

    asyncio.create_task(_runner())


FREEZONE_AUDIO_AGE_GROUP_LABELS = {
    "child": "幼年",
    "youth": "青年",
    "middle": "中年",
    "elder": "老年",
}


def _freezone_audio_ref_payload(
    *,
    username: str,
    project: str,
    project_id: str,
    project_dir: Path,
    scope: str,
    label: str,
    path: str,
    sha256: str = "",
    updated_at: str = "",
    character_name: str = "",
    identity_id: str = "",
    identity_name: str = "",
    slot: str = "",
    age_group: str = "",
) -> dict:
    rel_path = str(path or "").strip()
    abs_path = Path(rel_path)
    if rel_path and not abs_path.is_absolute():
        abs_path = project_dir / rel_path

    exists = bool(rel_path and abs_path.exists())
    url = ""
    if exists:
        try:
            rel = abs_path.relative_to(project_dir).as_posix()
            url = project_static_url(project_id, rel, local_path=abs_path)
        except ValueError:
            url = ""

    return {
        "scope": scope,
        "label": label,
        "path": rel_path,
        "url": url,
        "exists": exists and bool(url),
        "sha256": str(sha256 or ""),
        "updated_at": str(updated_at or ""),
        "character_name": character_name,
        "identity_id": identity_id,
        "identity_name": identity_name,
        "slot": slot,
        "age_group": age_group,
    }


def _user_voice_media_url(project: str, voice_id: str) -> str:
    safe_project = str(project or "").strip()
    safe_voice_id = str(voice_id or "").strip()
    return f"/api/v1/projects/{safe_project}/freezone/audio/voices/{safe_voice_id}/media"


def _attach_user_voice_media_urls(project: str, voices: list[dict]) -> list[dict]:
    out: list[dict] = []
    for item in voices:
        voice = dict(item)
        voice_id = str(voice.get("voice_id") or "").strip()
        if voice_id and voice.get("exists"):
            voice["url"] = _user_voice_media_url(project, voice_id)
        else:
            voice["url"] = ""
        out.append(voice)
    return out


def _freezone_character_audio_refs(
    *,
    username: str,
    project: str,
    project_id: str,
    project_dir: Path,
    character,
) -> dict:
    character_name = str(getattr(character, "name", "") or "")
    voices = [
        _freezone_audio_ref_payload(
            username=username,
            project=project,
            project_id=project_id,
            project_dir=project_dir,
            scope="character_default",
            label=f"{character_name} · 默认声线",
            path=str(getattr(character, "reference_audio_path", "") or ""),
            sha256=str(getattr(character, "reference_audio_sha256", "") or ""),
            updated_at=str(getattr(character, "reference_audio_updated_at", "") or ""),
            character_name=character_name,
            slot="default",
            age_group=str(getattr(character, "age_group", "") or ""),
        )
    ]

    samples = getattr(character, "voice_samples_by_age_group", None) or {}
    if isinstance(samples, dict):
        for slot, slot_label in FREEZONE_AUDIO_AGE_GROUP_LABELS.items():
            entry = samples.get(slot)
            if not isinstance(entry, dict):
                entry = {}
            voices.append(
                _freezone_audio_ref_payload(
                    username=username,
                    project=project,
                    project_id=project_id,
                    project_dir=project_dir,
                    scope="character_age_group",
                    label=f"{character_name} · {slot_label}声线",
                    path=str(entry.get("path", "") or ""),
                    sha256=str(entry.get("sha256", "") or ""),
                    updated_at=str(entry.get("updated_at", "") or ""),
                    character_name=character_name,
                    slot=slot,
                    age_group=slot,
                )
            )

    identities = []
    for identity in list(getattr(character, "identities", None) or []):
        identity_id = str(getattr(identity, "identity_id", "") or "")
        identity_name = str(getattr(identity, "identity_name", "") or "")
        age_group = str(getattr(identity, "age_group", "") or "")
        direct = _freezone_audio_ref_payload(
            username=username,
            project=project,
            project_id=project_id,
            project_dir=project_dir,
            scope="identity",
            label=f"{character_name} · {identity_name or identity_id}声线",
            path=str(getattr(identity, "reference_audio_path", "") or ""),
            sha256=str(getattr(identity, "reference_audio_sha256", "") or ""),
            updated_at=str(getattr(identity, "reference_audio_updated_at", "") or ""),
            character_name=character_name,
            identity_id=identity_id,
            identity_name=identity_name,
            age_group=age_group,
        )
        resolved = resolve_character_voice(
            project_dir=project_dir,
            character=character,
            identity=identity,
        )
        resolved_path = ""
        if resolved.audio_path is not None:
            try:
                resolved_path = resolved.audio_path.relative_to(project_dir).as_posix()
            except ValueError:
                resolved_path = str(resolved.audio_path)
        direct["resolved"] = (
            _freezone_audio_ref_payload(
                username=username,
                project=project,
                project_id=project_id,
                project_dir=project_dir,
                scope="identity_resolved",
                label=f"{character_name} · {identity_name or identity_id}实际声线",
                path=resolved_path,
                sha256=resolved.sha256,
                character_name=character_name,
                identity_id=identity_id,
                identity_name=identity_name,
                slot=resolved.tier or "",
                age_group=age_group,
            )
            if resolved.audio_path is not None
            else None
        )
        identities.append(direct)

    available_count = sum(1 for item in voices if item["exists"])
    for item in identities:
        if item["exists"]:
            available_count += 1
        resolved = item.get("resolved")
        if isinstance(resolved, dict) and resolved.get("exists"):
            available_count += 1

    return {
        "character_name": character_name,
        "is_main": bool(getattr(character, "is_main", False)),
        "age_group": str(getattr(character, "age_group", "") or ""),
        "voices": voices,
        "identities": identities,
        "available_count": available_count,
    }


@router.get(
    "/projects/{project}/freezone/audio/references",
    tags=[TAG_FREEZONE_AUDIO],
)
async def freezone_audio_references(
    project: str,
    user: dict = Depends(get_api_user),
):
    """获取 Freezone 音频节点可用的账号级音色、项目解说人与角色参考音频。"""
    ctx, username, project_name, project_dir, _output_dir = await _resolve_freezone_project(
        project, user, required_role="viewer"
    )
    narrator_descriptor = load_narrator_reference_audio(username, project_name)
    narration_style = load_effective_narration_style_for_voice(username, project_name)
    requester_username = ctx.requester_username or username
    user_voices = _attach_user_voice_media_urls(
        project,
        list_user_audio_voices(requester_username),
    )

    store = (
        await make_sqlite_store_for_context(ctx)
        if ctx is not None
        else await make_sqlite_store(username, project_name)
    )
    try:
        characters = list(await store.list_characters())
    finally:
        close = getattr(store, "close", None)
        if close:
            await close()

    narrator = _freezone_audio_ref_payload(
        username=username,
        project=project_name,
        project_id=ctx.project_id,
        project_dir=project_dir,
        scope="project_narrator",
        label="项目解说人声线",
        path=narrator_descriptor.get("path", ""),
        sha256=narrator_descriptor.get("sha256", ""),
        updated_at=narrator_descriptor.get("updated_at", ""),
    )
    character_payloads = [
        _freezone_character_audio_refs(
            username=username,
            project=project_name,
            project_id=ctx.project_id,
            project_dir=project_dir,
            character=character,
        )
        for character in characters
    ]
    available = [narrator] if narrator["exists"] else []
    available.extend(item for item in user_voices if item["exists"])
    for character in character_payloads:
        available.extend(item for item in character["voices"] if item["exists"])
        for item in character["identities"]:
            if item["exists"]:
                available.append(item)
            resolved = item.get("resolved")
            if isinstance(resolved, dict) and resolved.get("exists"):
                available.append(resolved)

    return {
        "ok": True,
        "data": {
            "narration_style": narration_style,
            "narrator": narrator,
            "characters": character_payloads,
            "user_voices": user_voices,
            "available": available,
        },
    }


@router.post(
    "/projects/{project}/freezone/audio/voices",
    tags=[TAG_FREEZONE_AUDIO],
)
async def create_freezone_audio_voice(
    project: str,
    file: Annotated[UploadFile, File(description="参考音频文件，支持 mp3/wav/m4a/aac/ogg/webm")],
    name: Annotated[str, Form(description="音色名称，用于音色选择弹窗展示")] = "",
    user: dict = Depends(get_api_user),
):
    """创建账号级“我的音色”。

    这个接口不会写入项目解说人、角色默认声线、年龄段声线或身份声线；
    它只把参考音频保存到账号级 Freezone 音色库。生成音频时传
    `voice_ref={"scope":"user_custom","voice_id":"..."}` 即可使用。
    """
    ctx, username, _project_name, _project_dir, _output_dir = await _resolve_freezone_project(
        project, user
    )
    username = ctx.requester_username if ctx is not None and ctx.requester_username else username
    content = await file.read()
    try:
        voice = create_user_audio_voice(
            username=username,
            name=name or Path(file.filename or "").stem,
            filename=file.filename,
            content=content,
            mime_type=file.content_type or "",
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    voice = _attach_user_voice_media_urls(project, [voice])[0]

    return {"ok": True, "data": voice}


@router.get(
    "/projects/{project}/freezone/audio/voices/{voice_id}/media",
    tags=[TAG_FREEZONE_AUDIO],
)
async def get_freezone_audio_voice_media(
    project: str,
    voice_id: str,
    user: dict = Depends(get_api_user),
):
    ctx, username, _project_name, _project_dir, _output_dir = await _resolve_freezone_project(
        project, user, required_role="viewer"
    )
    username = ctx.requester_username if ctx is not None and ctx.requester_username else username
    try:
        resolved = resolve_user_audio_voice(username, voice_id)
    except RuntimeError as exc:
        raise HTTPException(404, str(exc)) from exc
    return FileResponse(path=str(resolved.audio_path))


def _start_freezone_story_script_task(
    *,
    username: str,
    project: str,
    project_dir: Path,
    job_id: str,
    source_text: str,
    prompt: str,
    model: str,
    canvas_id: str | None = None,
    node_id: str | None = None,
) -> None:
    task_type = "freezone_story_script"
    task_manager = get_task_manager()
    metadata = {
        "job_id": job_id,
        "canvas_id": canvas_id or "",
        "node_id": node_id or "",
        "model": model,
    }
    task_manager.create_task(
        task_type,
        username,
        project,
        episode=0,
        scope=job_id,
        status="starting",
        metadata=metadata,
    )

    async def _runner() -> None:
        logs = ["开始生成故事脚本"]
        try:
            task_manager.update_progress(
                task_type,
                username,
                project,
                episode=0,
                scope=job_id,
                progress=0.1,
                current_task="generating_story_script",
                logs=logs,
            )
            data = await generate_freezone_story_script(
                source_text=source_text,
                prompt=prompt,
                model=model,
            )
            out = _story_script_output_path(project_dir, job_id)
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_text(
                json.dumps(data.model_dump(), ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
            data_payload = data.model_dump()
            history_record = _record_freezone_node_history(
                project_dir=project_dir,
                canvas_id=canvas_id,
                node_id=node_id,
                task_type=task_type,
                username=username,
                project=project,
                job_id=job_id,
                status="completed",
                media_type="text",
                model=model,
                prompt=prompt,
                source_text_preview=_freezone_history_preview(source_text),
                row_count=len(data_payload.get("rows") or []),
                result={"output_format": "json", **data_payload},
            )
            result = {"output_format": "json"}
            if history_record:
                result["generation_history_record"] = history_record
            task_manager.complete_task(
                task_type,
                username,
                project,
                episode=0,
                scope=job_id,
                result=result,
                current_task="completed",
                logs=["故事脚本生成完成"],
                metadata=metadata,
            )
        except Exception as exc:
            _record_freezone_node_history(
                project_dir=project_dir,
                canvas_id=canvas_id,
                node_id=node_id,
                task_type=task_type,
                username=username,
                project=project,
                job_id=job_id,
                status="failed",
                media_type="text",
                model=model,
                prompt=prompt,
                source_text_preview=_freezone_history_preview(source_text),
                error=str(exc),
            )
            task_manager.fail_task(
                task_type,
                username,
                project,
                episode=0,
                scope=job_id,
                error=str(exc),
                current_task="failed",
                logs=[f"错误: {exc}"],
                metadata=metadata,
            )

    asyncio.create_task(_runner())


@router.post(
    "/projects/{project}/freezone/text/story-script",
    response_model=FreezoneJobAcceptedResponse,
    tags=[TAG_FREEZONE_TEXT],
)
async def freezone_story_script_generate(
    project: str,
    body: FreezoneStoryScriptGenerateRequest,
    user: dict = Depends(get_api_user),
):
    """文本工具：根据上传剧本内容生成结构化故事脚本表。"""
    ctx, username, project_name, project_dir, _output_dir = await _resolve_freezone_project(
        project, user
    )

    source_text = body.source_text.strip()
    if not source_text and body.source_url:
        try:
            source_path = resolve_static_url_to_path(body.source_url, project_dir)
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        if not source_path.exists():
            raise HTTPException(404, f"source not found: {source_path}")
        source_text = _read_freezone_text_file(source_path).strip()

    if not source_text:
        raise HTTPException(400, "source_text or source_url is required")

    try:
        job_id = _new_job_id()
        if ctx is not None:
            return await _enqueue_freezone_background_job(
                ctx=ctx,
                project_dir=project_dir,
                task_type="freezone_story_script",
                job_id=job_id,
                payload={
                    "source_text": source_text,
                    "prompt": body.prompt,
                    "model": body.model,
                    "canvas_id": body.canvas_id or "",
                    "node_id": body.node_id or "",
                },
            )
        _start_freezone_story_script_task(
            username=username,
            project=project_name,
            project_dir=project_dir,
            job_id=job_id,
            source_text=source_text,
            prompt=body.prompt,
            model=body.model,
            canvas_id=body.canvas_id or None,
            node_id=body.node_id or None,
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    except RuntimeError as exc:
        _handle_task_start_runtime_error("failed to start story script task", exc)
        raise HTTPException(503, f"failed to start story script task: {exc}") from exc

    return _accepted_job_response(
        task_type="freezone_story_script",
        username=username,
        project=project_name,
        job_id=job_id,
    )


def _start_freezone_image_reverse_prompt_task(
    *,
    username: str,
    project: str,
    project_dir: Path,
    job_id: str,
    source_path: Path,
    canvas_id: str | None = None,
    node_id: str | None = None,
) -> None:
    task_type = "freezone_image_reverse_prompt"
    task_manager = get_task_manager()
    metadata = {
        "job_id": job_id,
        "canvas_id": canvas_id or "",
        "node_id": node_id or "",
        "source_path": str(source_path),
    }
    task_manager.create_task(
        task_type,
        username,
        project,
        episode=0,
        scope=job_id,
        status="starting",
        metadata=metadata,
    )

    async def _runner() -> None:
        logs = ["开始反推图片提示词"]
        try:
            task_manager.update_progress(
                task_type,
                username,
                project,
                episode=0,
                scope=job_id,
                progress=0.1,
                current_task="reverse_prompting_image",
                logs=logs,
            )
            prompt = await reverse_prompt_from_image(image_path=source_path)
            out = _image_reverse_prompt_output_path(project_dir, job_id)
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_text(
                json.dumps({"prompt": prompt}, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
            history_record = _record_freezone_node_history(
                project_dir=project_dir,
                canvas_id=canvas_id,
                node_id=node_id,
                task_type=task_type,
                username=username,
                project=project,
                job_id=job_id,
                status="completed",
                media_type="text",
                source_path=str(source_path),
                result={"output_format": "json", "prompt": prompt},
            )
            result = {"output_format": "json"}
            if history_record:
                result["generation_history_record"] = history_record
            task_manager.complete_task(
                task_type,
                username,
                project,
                episode=0,
                scope=job_id,
                result=result,
                current_task="completed",
                logs=["图片提示词反推完成"],
                metadata=metadata,
            )
        except Exception as exc:
            _record_freezone_node_history(
                project_dir=project_dir,
                canvas_id=canvas_id,
                node_id=node_id,
                task_type=task_type,
                username=username,
                project=project,
                job_id=job_id,
                status="failed",
                media_type="text",
                source_path=str(source_path),
                error=str(exc),
            )
            task_manager.fail_task(
                task_type,
                username,
                project,
                episode=0,
                scope=job_id,
                error=str(exc),
                current_task="failed",
                logs=[f"错误: {exc}"],
                metadata=metadata,
            )

    asyncio.create_task(_runner())


# ============================================================
# 视频处理：文生视频 / 运镜模板 / 角色库
# ============================================================


@router.get("/projects/{project}/freezone/video/camera-templates", tags=[TAG_FREEZONE_VIDEO])
async def freezone_video_camera_templates(
    project: str,
    user: dict = Depends(get_api_user),
):
    """视频处理：返回文生视频运镜模板库。"""
    await _resolve_freezone_project(project, user, required_role="viewer")
    return {"ok": True, "data": get_video_camera_templates()}


@router.get("/projects/{project}/freezone/video/models", tags=[TAG_FREEZONE_VIDEO])
async def freezone_video_models(
    project: str,
    user: dict = Depends(get_api_user),
):
    """视频处理：返回和 NovelVideo 视频模型下拉一致的可见模型。"""
    await _resolve_freezone_project(project, user, required_role="viewer")
    return {"ok": True, "data": get_freezone_video_model_options()}


@router.get("/projects/{project}/freezone/image/models", tags=[TAG_FREEZONE_IMAGE])
async def freezone_image_models(
    project: str,
    user: dict = Depends(get_api_user),
):
    """图片处理：返回和 NovelVideo 图片模型下拉一致的可见模型。"""
    await _resolve_freezone_project(project, user, required_role="viewer")
    options = image_generation_selection_options()
    data = []
    for key, label in options.items():
        entry = IMAGE_GENERATION_SELECTIONS.get(key, {})
        data.append(
            {
                "id": key,
                "providerId": entry.get("provider", "newapi"),
                "provider": entry.get("provider", "newapi"),
                "apiModel": key,
                "api_model": key,
                "label": label,
            }
        )
    return {"ok": True, "data": data}


@router.post(
    "/projects/{project}/freezone/marks/detect",
    response_model=FreezoneMarkDetectResponse,
    tags=[TAG_FREEZONE_IMAGE],
)
async def freezone_mark_detect(
    project: str,
    body: FreezoneMarkDetectRequest,
    user: dict = Depends(get_api_user),
):
    """图片处理：识别单张图片中点击点或框选区域的局部元素标记。"""
    _ctx, _username, _project_name, project_dir, _output_dir = await _resolve_freezone_project(
        project, user
    )
    source_paths = _resolve_url_list(project_dir, [body.source_url])
    if not source_paths:
        raise HTTPException(400, "source_url is required")

    has_point = body.point_x is not None and body.point_y is not None
    has_box = all(
        value is not None for value in [body.box_x, body.box_y, body.box_width, body.box_height]
    )
    if not (has_point or has_box):
        raise HTTPException(400, "point or box selection is required")

    try:
        result = await detect_freezone_mark(
            image_path=Path(source_paths[0]),
            point_x=body.point_x,
            point_y=body.point_y,
            box_x=body.box_x,
            box_y=body.box_y,
            box_width=body.box_width,
            box_height=body.box_height,
        )
    except Exception as exc:
        raise HTTPException(500, f"mark detect failed: {exc}") from exc

    return {
        "ok": True,
        "data": {
            "mark": {
                "label": result["label"],
                "source_url": body.source_url,
                "point_x": body.point_x,
                "point_y": body.point_y,
                "box_x": body.box_x,
                "box_y": body.box_y,
                "box_width": body.box_width,
                "box_height": body.box_height,
                "note": result.get("note", ""),
            },
            "provider": result["provider"],
            "model": result["model"],
        },
    }


@router.post(
    "/projects/{project}/freezone/image/reverse-prompt",
    response_model=FreezoneJobAcceptedResponse,
    tags=[TAG_FREEZONE_IMAGE],
)
async def freezone_image_reverse_prompt(
    project: str,
    body: FreezoneImageReversePromptRequest,
    user: dict = Depends(get_api_user),
):
    """图片处理：异步反推图片提示词。"""
    ctx, username, project_name, project_dir, _output_dir = await _resolve_freezone_project(
        project, user
    )
    source_paths = _resolve_url_list(project_dir, [body.source_url])
    if not source_paths:
        raise HTTPException(400, "source_url is required")
    source_path = Path(source_paths[0])
    if not source_path.exists():
        raise HTTPException(404, f"source not found: {source_path}")

    try:
        job_id = _new_job_id()
        if ctx is not None:
            return await _enqueue_freezone_background_job(
                ctx=ctx,
                project_dir=project_dir,
                task_type="freezone_image_reverse_prompt",
                job_id=job_id,
                payload={
                    "source_path": str(source_path),
                    "canvas_id": body.canvas_id or "",
                    "node_id": body.node_id or "",
                },
            )
        _start_freezone_image_reverse_prompt_task(
            username=username,
            project=project_name,
            project_dir=project_dir,
            job_id=job_id,
            source_path=source_path,
            canvas_id=body.canvas_id or None,
            node_id=body.node_id or None,
        )
    except RuntimeError as exc:
        _handle_task_start_runtime_error("reverse prompt failed", exc)
        raise HTTPException(500, f"reverse prompt failed: {exc}") from exc

    return _accepted_job_response(
        task_type="freezone_image_reverse_prompt",
        username=username,
        project=project_name,
        job_id=job_id,
    )


@router.get("/projects/{project}/freezone/video/character-library", tags=[TAG_FREEZONE_VIDEO])
async def freezone_video_character_library(
    project: str,
    user: dict = Depends(get_api_user),
):
    """视频处理：获取文生视频角色素材库。"""
    _ctx, _username, _project_name, project_dir, _output_dir = await _resolve_freezone_project(
        project, user, required_role="viewer"
    )
    return {"ok": True, "data": load_video_character_library(project_dir)}


@router.post("/projects/{project}/freezone/video/character-library", tags=[TAG_FREEZONE_VIDEO])
async def freezone_add_video_character_library_item(
    project: str,
    body: FreezoneVideoCharacterLibraryItemRequest,
    user: dict = Depends(get_api_user),
):
    """视频处理：把上传好的角色参考图登记到视频角色库。"""
    ctx, _username, _project_name, project_dir, _output_dir = await _resolve_freezone_project(
        project, user
    )

    if not body.name.strip():
        raise HTTPException(400, "name is required")
    if not body.image_urls:
        raise HTTPException(400, "image_urls is required (non-empty)")

    for url in body.image_urls:
        try:
            path = resolve_static_url_to_path(url, project_dir)
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        if not path.exists():
            raise HTTPException(404, f"character image not found: {path}")

    item = add_video_character_library_item(
        project_dir,
        name=body.name,
        image_urls=body.image_urls,
    )
    return {"ok": True, "data": item}


@router.delete(
    "/projects/{project}/freezone/video/character-library/{item_id}", tags=[TAG_FREEZONE_VIDEO]
)
async def freezone_delete_video_character_library_item(
    project: str,
    item_id: str,
    user: dict = Depends(get_api_user),
):
    """视频处理：删除角色素材库条目。"""
    _ctx, _username, _project_name, project_dir, _output_dir = await _resolve_freezone_project(
        project, user
    )
    deleted = delete_video_character_library_item(project_dir, item_id)
    if not deleted:
        raise HTTPException(404, f"video character library item not found: {item_id}")
    return {"ok": True, "data": {"id": item_id, "deleted": True}}


@router.post("/projects/{project}/freezone/video/gen", tags=[TAG_FREEZONE_VIDEO])
async def freezone_video_gen(
    project: str,
    body: FreezoneVideoGenRequest,
    user: dict = Depends(get_api_user),
):
    """视频处理：文生视频。

    `model` 可选，前端应优先使用 `/api/v1/projects/{project}/freezone/video/models`
    返回的模型名称列表作为入参。

    运镜通过模板库和补充提示词控制，角色库通过已上传的人物参考图提供身份一致性。
    """
    ctx, username, project_name, project_dir, output_dir = await _resolve_freezone_project(
        project, user
    )

    if not body.prompt.strip():
        raise HTTPException(400, "prompt is required")
    if body.camera_template_id and not get_video_camera_template(body.camera_template_id):
        raise HTTPException(400, f"unknown camera_template_id: {body.camera_template_id}")
    try:
        backend = resolve_freezone_video_backend(body.model)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc

    character_items = _load_video_character_items_by_ids(project_dir, body.character_ids)
    character_names = [str(item.get("name") or "") for item in character_items]
    character_reference_urls: list[str] = []
    for item in character_items:
        for url in item.get("image_urls") or []:
            if isinstance(url, str) and url:
                character_reference_urls.append(url)

    character_reference_paths = _resolve_url_list(project_dir, character_reference_urls)
    reference_items = [
        {"type": "image", "path": path, "role": "角色参考"} for path in character_reference_paths
    ]
    final_prompt = build_freezone_video_prompt(
        user_prompt=body.prompt,
        camera_template_id=body.camera_template_id,
        character_names=character_names,
        marks=[item.model_dump() for item in body.marks],
    )
    job_id = _new_job_id()

    try:
        return await _start_or_enqueue_freezone_video_gen(
            ctx=ctx,
            username=username,
            project=project_name,
            project_dir=project_dir,
            output_dir=output_dir,
            job_id=job_id,
            prompt=final_prompt,
            reference_items=reference_items,
            aspect_ratio=normalize_video_aspect_ratio(body.aspect_ratio),
            resolution=normalize_video_resolution_for_backend(backend, body.resolution),
            duration_seconds=normalize_video_duration_for_backend(backend, body.duration_seconds),
            generate_audio=body.generate_audio,
            human_review=body.human_review,
            scene_optimize=body.scene_optimize,
            backend=backend,
            canvas_id=body.canvas_id or None,
            node_id=body.node_id or None,
        )
    except RuntimeError as exc:
        _handle_task_start_runtime_error("failed to start freezone video gen task", exc)
        raise HTTPException(503, f"failed to start freezone video gen task: {exc}") from exc


@router.post("/projects/{project}/freezone/video/i2v", tags=[TAG_FREEZONE_VIDEO])
async def freezone_video_i2v(
    project: str,
    body: FreezoneImageToVideoRequest,
    user: dict = Depends(get_api_user),
):
    """视频处理：图片参考视频。

    统一承接：
    - 单图首帧图生视频
    - 多图图片参考视频
    """
    ctx, username, project_name, project_dir, output_dir = await _resolve_freezone_project(
        project, user
    )

    if body.camera_template_id and not get_video_camera_template(body.camera_template_id):
        raise HTTPException(400, f"unknown camera_template_id: {body.camera_template_id}")
    try:
        backend = resolve_freezone_video_backend(body.model)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc

    if not body.image_urls:
        raise HTTPException(400, "image_urls is required")
    if len(body.image_urls) > 9:
        raise HTTPException(400, "image_urls count must be <= 9")

    source_paths = _resolve_url_list(project_dir, list(body.image_urls))
    if not source_paths:
        raise HTTPException(400, "at least one valid image_url is required")
    if len(source_paths) != len(body.image_urls):
        raise HTTPException(400, "some image_urls could not be resolved")
    if (
        len(source_paths) > 1
        and not is_freezone_seedance2_backend(backend)
        and not is_freezone_happyhorse_backend(backend)
    ):
        raise HTTPException(
            400,
            "multiple image references currently only support Seedance 2.0 or HappyHorse models",
        )

    reference_items = []
    for idx, path in enumerate(source_paths):
        role = "首帧" if idx == 0 else "图片参考"
        reference_items.append({"type": "image", "path": path, "role": role})
    final_prompt = build_freezone_image_to_video_prompt(
        user_prompt=body.prompt,
        camera_template_id=body.camera_template_id,
        marks=[item.model_dump() for item in body.marks],
        reference_image_count=len(source_paths),
    )
    job_id = _new_job_id()

    try:
        return await _start_or_enqueue_freezone_video_gen(
            ctx=ctx,
            username=username,
            project=project_name,
            project_dir=project_dir,
            output_dir=output_dir,
            job_id=job_id,
            prompt=final_prompt,
            reference_items=reference_items,
            aspect_ratio=normalize_video_aspect_ratio(body.aspect_ratio),
            resolution=normalize_video_resolution_for_backend(backend, body.resolution),
            duration_seconds=normalize_video_duration_for_backend(backend, body.duration_seconds),
            generate_audio=body.generate_audio,
            human_review=body.human_review,
            scene_optimize=body.scene_optimize,
            backend=backend,
            canvas_id=body.canvas_id or None,
            node_id=body.node_id or None,
        )
    except RuntimeError as exc:
        _handle_task_start_runtime_error("failed to start freezone image-to-video task", exc)
        raise HTTPException(503, f"failed to start freezone image-to-video task: {exc}") from exc


@router.post("/projects/{project}/freezone/video/keyframes", tags=[TAG_FREEZONE_VIDEO])
async def freezone_video_keyframes(
    project: str,
    body: FreezoneKeyframeVideoRequest,
    user: dict = Depends(get_api_user),
):
    """视频处理：首尾帧视频。

    接受首帧和尾帧图片；至少需要提供一个。
    """
    ctx, username, project_name, project_dir, output_dir = await _resolve_freezone_project(
        project, user
    )

    if body.camera_template_id and not get_video_camera_template(body.camera_template_id):
        raise HTTPException(400, f"unknown camera_template_id: {body.camera_template_id}")
    if not (body.first_frame_url or body.last_frame_url):
        raise HTTPException(400, "first_frame_url or last_frame_url is required")
    try:
        backend = resolve_freezone_video_backend(body.model)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc

    first_paths = _resolve_url_list(
        project_dir, [body.first_frame_url] if body.first_frame_url else []
    )
    last_paths = _resolve_url_list(
        project_dir, [body.last_frame_url] if body.last_frame_url else []
    )
    first_path = first_paths[0] if first_paths else ""
    last_path = last_paths[0] if last_paths else ""

    # 只有尾帧时，退化为单帧起始参考；仍保留尾帧语义在 prompt 中。
    primary_first_path = first_path or last_path
    reference_items = [
        {"type": "image", "path": primary_first_path, "role": "首帧" if first_path else "尾帧参考"}
    ]
    if is_freezone_seedance2_backend(backend) and last_path and first_path:
        reference_items.append({"type": "image", "path": last_path, "role": "尾帧"})

    final_prompt = build_freezone_keyframe_video_prompt(
        user_prompt=body.prompt,
        camera_template_id=body.camera_template_id,
        marks=[item.model_dump() for item in body.marks],
        has_first_frame=bool(first_path),
        has_last_frame=bool(last_path),
    )
    job_id = _new_job_id()

    try:
        return await _start_or_enqueue_freezone_video_gen(
            ctx=ctx,
            username=username,
            project=project_name,
            project_dir=project_dir,
            output_dir=output_dir,
            job_id=job_id,
            prompt=final_prompt,
            reference_items=reference_items,
            aspect_ratio=normalize_video_aspect_ratio(body.aspect_ratio),
            resolution=normalize_video_resolution_for_backend(backend, body.resolution),
            duration_seconds=normalize_video_duration_for_backend(backend, body.duration_seconds),
            generate_audio=body.generate_audio,
            human_review=body.human_review,
            scene_optimize=body.scene_optimize,
            backend=backend,
            last_frame_path=last_path or None,
            canvas_id=body.canvas_id or None,
            node_id=body.node_id or None,
        )
    except RuntimeError as exc:
        _handle_task_start_runtime_error("failed to start freezone keyframe video task", exc)
        raise HTTPException(503, f"failed to start freezone keyframe video task: {exc}") from exc


@router.post("/projects/{project}/freezone/video/omni-gen", tags=[TAG_FREEZONE_VIDEO])
async def freezone_video_omni_gen(
    project: str,
    body: FreezoneVideoOmniGenRequest,
    user: dict = Depends(get_api_user),
):
    """视频处理：全能参考文生视频。

    支持文本、图像、视频、音频混合输入，当前默认走 Seedance 2.0。
    """
    ctx, username, project_name, project_dir, output_dir = await _resolve_freezone_project(
        project, user
    )

    if not body.prompt.strip():
        raise HTTPException(400, "prompt is required")
    if body.camera_template_id and not get_video_camera_template(body.camera_template_id):
        raise HTTPException(400, f"unknown camera_template_id: {body.camera_template_id}")
    try:
        backend = resolve_freezone_video_backend(body.model)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    is_happyhorse = is_freezone_happyhorse_backend(backend)
    if not is_freezone_seedance2_backend(backend) and not is_happyhorse:
        raise HTTPException(
            400, "omni video currently only supports Seedance 2.0 or HappyHorse models"
        )

    raw_reference_items = [item.model_dump() for item in body.references]
    try:
        validate_omni_reference_limits(raw_reference_items)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    if is_happyhorse:
        image_count = sum(1 for item in raw_reference_items if item.get("type") == "image")
        video_count = sum(1 for item in raw_reference_items if item.get("type") == "video")
        audio_count = sum(1 for item in raw_reference_items if item.get("type") == "audio")
        if audio_count:
            raise HTTPException(400, "HappyHorse video does not support audio references")
        if video_count > 1:
            raise HTTPException(400, "HappyHorse video edit supports at most one video reference")
        if video_count and image_count > 5:
            raise HTTPException(400, "HappyHorse video edit supports at most 5 reference images")

    reference_items: list[dict[str, str]] = []
    for item in raw_reference_items:
        path_list = _resolve_url_list(project_dir, [str(item.get("url") or "")])
        if not path_list:
            raise HTTPException(400, "reference url is required")
        reference_items.append(
            {
                "type": str(item.get("type") or "image"),
                "path": path_list[0],
                "role": str(item.get("role") or ""),
            }
        )

    final_prompt = build_freezone_omni_video_prompt(
        user_prompt=body.prompt,
        theme=body.theme,
        camera_template_id=body.camera_template_id,
        marks=[item.model_dump() for item in body.marks],
    )
    job_id = _new_job_id()

    try:
        response = await _start_or_enqueue_freezone_video_gen(
            ctx=ctx,
            username=username,
            project=project_name,
            project_dir=project_dir,
            output_dir=output_dir,
            job_id=job_id,
            prompt=final_prompt,
            reference_items=reference_items,
            aspect_ratio=normalize_video_aspect_ratio(body.aspect_ratio),
            resolution=normalize_video_resolution_for_backend(backend, body.resolution),
            duration_seconds=normalize_video_duration_for_backend(backend, body.duration_seconds),
            generate_audio=body.generate_audio,
            human_review=body.human_review,
            scene_optimize=body.scene_optimize,
            backend=backend,
            canvas_id=body.canvas_id or None,
            node_id=body.node_id or None,
        )
    except RuntimeError as exc:
        _handle_task_start_runtime_error("failed to start freezone omni video gen task", exc)
        raise HTTPException(503, f"failed to start freezone omni video gen task: {exc}") from exc

    counts = summarize_omni_reference_counts(raw_reference_items)
    return {
        **response,
        "meta": counts,
    }


@router.post(
    "/projects/{project}/freezone/video/erase",
    response_model=FreezoneJobAcceptedResponse,
    tags=[TAG_FREEZONE_VIDEO],
)
async def freezone_video_erase(
    project: str,
    body: FreezoneVideoEraseRequest,
    user: dict = Depends(get_api_user),
):
    """视频处理：智能去字幕 / 框选擦除。

    当前为稳定的一期实现：
    - `smart_subtitle`：自动估计底部字幕区域后执行视频擦除
    - `box`：按前端传入的固定框执行区域擦除
    """
    ctx, username, project_name, project_dir, _output_dir = await _resolve_freezone_project(
        project, user
    )

    try:
        source_path = resolve_static_url_to_path(body.source_url, project_dir)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    if not source_path.exists():
        raise HTTPException(404, f"video source not found: {source_path}")
    if body.mode == "box" and None in {body.box_x, body.box_y, body.box_width, body.box_height}:
        raise HTTPException(400, "box mode requires box_x, box_y, box_width and box_height")

    try:
        job_id = _new_job_id()
        if ctx is not None:
            return await _enqueue_or_start_freezone_media_job(
                ctx=ctx,
                username=username,
                project=project_name,
                project_dir=project_dir,
                task_type="freezone_video_erase",
                job_id=job_id,
                payload={
                    "source_path": str(source_path),
                    "mode": body.mode,
                    "box_x": body.box_x,
                    "box_y": body.box_y,
                    "box_width": body.box_width,
                    "box_height": body.box_height,
                },
            )
        _start_freezone_video_erase_task(
            username=username,
            project=project_name,
            project_dir=project_dir,
            job_id=job_id,
            source_path=source_path,
            body=body,
        )
    except RuntimeError as exc:
        _handle_task_start_runtime_error("failed to start freezone video erase task", exc)
        raise HTTPException(503, f"failed to start freezone video erase task: {exc}") from exc

    return _accepted_job_response(
        task_type="freezone_video_erase",
        username=username,
        project=project_name,
        job_id=job_id,
    )


@router.post(
    "/projects/{project}/freezone/video/upscale",
    response_model=FreezoneJobAcceptedResponse,
    tags=[TAG_FREEZONE_VIDEO],
)
async def freezone_video_upscale(
    project: str,
    body: FreezoneVideoUpscaleRequest,
    user: dict = Depends(get_api_user),
):
    """视频处理：基础版高清增强。

    当前实现使用 ffmpeg 做传统缩放、轻度降噪和锐化：
    - 保持原始画面比例
    - 按 `resolution` 对长边缩放
    - 保留原视频音轨
    """
    ctx, username, project_name, project_dir, _output_dir = await _resolve_freezone_project(
        project, user
    )

    try:
        source_path = resolve_static_url_to_path(body.source_url, project_dir)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    if not source_path.exists():
        raise HTTPException(404, f"video source not found: {source_path}")

    try:
        job_id = _new_job_id()
        if ctx is not None:
            return await _enqueue_or_start_freezone_media_job(
                ctx=ctx,
                username=username,
                project=project_name,
                project_dir=project_dir,
                task_type="freezone_video_upscale",
                job_id=job_id,
                payload={
                    "source_path": str(source_path),
                    "resolution": body.resolution,
                    "frame_interpolation": body.frame_interpolation,
                    "denoise_strength": body.denoise_strength,
                },
            )
        _start_freezone_video_upscale_task(
            username=username,
            project=project_name,
            project_id=ctx.project_id,
            project_dir=project_dir,
            job_id=job_id,
            source_path=source_path,
            body=body,
        )
    except RuntimeError as exc:
        _handle_task_start_runtime_error("failed to start freezone video upscale task", exc)
        raise HTTPException(
            503,
            f"failed to start freezone video upscale task: {exc}",
        ) from exc

    return _accepted_job_response(
        task_type="freezone_video_upscale",
        username=username,
        project=project_name,
        job_id=job_id,
    )


@router.post(
    "/projects/{project}/freezone/video/audio-separate",
    response_model=FreezoneJobAcceptedResponse,
    tags=[TAG_FREEZONE_VIDEO],
)
async def freezone_audio_separate(
    project: str,
    body: FreezoneAudioSeparateRequest,
    user: dict = Depends(get_api_user),
):
    """视频处理：音视频分离。

    当前轻量版会同时产出：
    - 提取出的纯音频
    - 去掉音轨后的无声视频
    """
    ctx, username, project_name, project_dir, _output_dir = await _resolve_freezone_project(
        project, user
    )

    try:
        source_path = resolve_static_url_to_path(body.source_url, project_dir)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    if not source_path.exists():
        raise HTTPException(404, f"video source not found: {source_path}")

    try:
        job_id = _new_job_id()
        if ctx is not None:
            return await _enqueue_or_start_freezone_media_job(
                ctx=ctx,
                username=username,
                project=project_name,
                project_dir=project_dir,
                task_type="freezone_audio_separate",
                job_id=job_id,
                payload={
                    "source_path": str(source_path),
                    "target_episode": body.target_episode,
                    "target_beat": body.target_beat,
                },
            )
        _start_freezone_audio_separate_task(
            username=username,
            project=project_name,
            project_dir=project_dir,
            job_id=job_id,
            source_path=source_path,
            target_episode=body.target_episode,
            target_beat=body.target_beat,
        )
    except RuntimeError as exc:
        _handle_task_start_runtime_error("failed to start freezone audio separate task", exc)
        raise HTTPException(503, f"failed to start freezone audio separate task: {exc}") from exc

    return _accepted_job_response(
        task_type="freezone_audio_separate",
        username=username,
        project=project_name,
        job_id=job_id,
    )


@router.post(
    "/projects/{project}/freezone/audio/speech",
    response_model=FreezoneJobAcceptedResponse,
    tags=[TAG_FREEZONE_AUDIO],
)
async def freezone_audio_speech(
    project: str,
    body: FreezoneAudioSpeechRequest,
    user: dict = Depends(get_api_user),
):
    """Freezone 音频节点：文本生成语音。"""
    ctx, username, project_name, project_dir, _output_dir = await _resolve_freezone_project(
        project, user
    )
    account_voice_username = (
        ctx.requester_username if ctx is not None and ctx.requester_username else username
    )

    if not body.text.strip():
        raise HTTPException(400, "text is required")
    if len(body.text) > 10_000:
        raise HTTPException(400, "text must be <= 10000 characters")

    try:
        job_id = _new_job_id()
        if ctx is not None:
            return await _enqueue_freezone_background_job(
                ctx=ctx,
                project_dir=project_dir,
                task_type="freezone_audio_speech",
                job_id=job_id,
                payload={
                    "text": body.text,
                    "emotion_prompt": body.emotion_prompt,
                    "voice_ref": body.voice_ref.model_dump() if body.voice_ref else None,
                    "account_voice_username": account_voice_username,
                    "target_episode": body.target_episode,
                    "target_beat": body.target_beat,
                },
            )
        _start_freezone_audio_speech_task(
            username=username,
            project=project_name,
            account_voice_username=account_voice_username,
            project_id=ctx.project_id,
            project_dir=project_dir,
            job_id=job_id,
            body=body,
        )
    except RuntimeError as exc:
        _handle_task_start_runtime_error("failed to start freezone audio speech task", exc)
        raise HTTPException(503, f"failed to start freezone audio speech task: {exc}") from exc

    return _accepted_job_response(
        task_type="freezone_audio_speech",
        username=username,
        project=project_name,
        job_id=job_id,
    )


@router.post(
    "/projects/{project}/freezone/audio/eleven-music",
    response_model=FreezoneJobAcceptedResponse,
    tags=[TAG_FREEZONE_AUDIO],
)
async def freezone_audio_eleven_music(
    project: str,
    body: FreezoneAudioMusicRequest,
    user: dict = Depends(get_api_user),
):
    """Freezone 音频节点：文本生成音乐。"""
    ctx, username, project_name, project_dir, _output_dir = await _resolve_freezone_project(
        project, user
    )

    prompt = body.input.strip()
    if not prompt:
        raise HTTPException(400, "input is required")
    if len(prompt) > 4100:
        raise HTTPException(400, "input must be <= 4100 characters")

    try:
        job_id = _new_job_id()
        if ctx is not None:
            return await _enqueue_freezone_background_job(
                ctx=ctx,
                project_dir=project_dir,
                task_type="freezone_audio_eleven_music",
                job_id=job_id,
                payload={
                    "input": prompt,
                    "model": body.model,
                    "response_format": body.response_format,
                    "music_length_ms": body.music_length_ms,
                    "force_instrumental": body.force_instrumental,
                    "respect_sections_durations": body.respect_sections_durations,
                    "output_format": body.output_format,
                },
            )
        _raise_project_context_required("freezone_audio_eleven_music")
    except RuntimeError as exc:
        _handle_task_start_runtime_error("failed to start freezone audio music task", exc)
        raise HTTPException(503, f"failed to start freezone audio music task: {exc}") from exc

    return _accepted_job_response(
        task_type="freezone_audio_eleven_music",
        username=username,
        project=project_name,
        job_id=job_id,
    )


@router.post(
    "/projects/{project}/freezone/video/compose",
    response_model=FreezoneJobAcceptedResponse,
    tags=[TAG_FREEZONE_VIDEO],
)
async def freezone_video_compose(
    project: str,
    body: FreezoneVideoComposeRequest,
    user: dict = Depends(get_api_user),
):
    """视频处理：按时间线描述异步导出成片。

    当前为 MVP 版本：
    - 支持顺序视频片段裁剪与拼接
    - 支持时间线空隙自动补黑场
    - 支持附加音频轨混音
    - 暂不支持重叠视频轨、转场和复杂特效
    """
    ctx, username, project_name, project_dir, _output_dir = await _resolve_freezone_project(
        project, user
    )

    if not body.tracks:
        raise HTTPException(400, "tracks is required")

    resolved_tracks: list[dict] = []
    has_video_item = False
    for track in body.tracks:
        if not track.items:
            continue

        resolved_items: list[dict] = []
        for item in track.items:
            if item.source_end <= item.source_start:
                raise HTTPException(
                    400,
                    (
                        f"compose item {item.item_id} has invalid source range: "
                        "source_end must be > source_start"
                    ),
                )
            try:
                source_path = resolve_static_url_to_path(item.source_url, project_dir)
            except ValueError as exc:
                raise HTTPException(400, str(exc)) from exc
            if not source_path.exists():
                raise HTTPException(404, f"compose source not found: {source_path}")

            resolved_item = item.model_dump()
            resolved_item["source_path"] = str(source_path)
            resolved_items.append(resolved_item)

        if not resolved_items:
            continue

        if track.kind == "video":
            has_video_item = True
        resolved_track = track.model_dump()
        resolved_track["items"] = resolved_items
        resolved_tracks.append(resolved_track)

    if not resolved_tracks:
        raise HTTPException(400, "tracks must contain at least one media item")
    if not has_video_item:
        raise HTTPException(400, "video compose requires at least one video item")

    try:
        job_id = _new_job_id()
        if ctx is not None:
            return await _enqueue_or_start_freezone_media_job(
                ctx=ctx,
                username=username,
                project=project_name,
                project_dir=project_dir,
                task_type="freezone_video_compose",
                job_id=job_id,
                payload={
                    "title": body.title,
                    "canvas_id": body.canvas_id,
                    "resolution": body.resolution,
                    "fps": body.fps,
                    "background_color": body.background_color,
                    "keep_original_audio": body.keep_original_audio,
                    "tracks": resolved_tracks,
                },
            )
        _start_freezone_video_compose_task(
            username=username,
            project=project_name,
            project_dir=project_dir,
            job_id=job_id,
            body=body,
            resolved_tracks=resolved_tracks,
        )
    except RuntimeError as exc:
        _handle_task_start_runtime_error("failed to start freezone video compose task", exc)
        raise HTTPException(503, f"failed to start freezone video compose task: {exc}") from exc

    return _accepted_job_response(
        task_type="freezone_video_compose",
        username=username,
        project=project_name,
        job_id=job_id,
    )


@router.post(
    "/projects/{project}/freezone/edit",
    response_model=FreezoneJobAcceptedResponse,
    tags=[TAG_FREEZONE_IMAGE],
)
async def freezone_edit(
    project: str,
    body: FreezoneEditRequest,
    user: dict = Depends(get_api_user),
):
    """图片处理：启动图生图 / 图编辑任务，返回 `task_key`。"""
    ctx, username, project_name, project_dir, output_dir = await _resolve_freezone_project(
        project, user
    )
    return await _start_or_enqueue_freezone_edit_job(
        ctx=ctx,
        username=username,
        project=project_name,
        project_dir=project_dir,
        output_dir=output_dir,
        prompt=body.prompt,
        base_url=body.base_url,
        extra_reference_urls=list(body.extra_reference_urls or []),
        aspect_ratio=body.aspect_ratio,
        image_size=body.image_size,
        camera=body.camera,
        style=body.style,
        provider=body.provider,
        model=body.model,
        quality=body.quality,
        canvas_id=body.canvas_id or None,
        node_id=body.node_id or None,
    )


@router.get(
    "/projects/{project}/freezone/jobs/{task_type}/{job_id}/result", tags=[TAG_FREEZONE_JOBS]
)
async def freezone_job_result(
    project: str,
    task_type: Literal[
        "freezone_gen",
        "freezone_edit",
        "freezone_upscale",
        "freezone_extract",
        "freezone_analyze",
        "freezone_video_story",
        "freezone_video_gen",
        "freezone_mask_edit",
        "freezone_video_erase",
        "freezone_video_upscale",
        "freezone_audio_separate",
        "freezone_audio_speech",
        "freezone_audio_eleven_music",
        "freezone_video_compose",
        "freezone_image_reverse_prompt",
        "freezone_image_to_3gs",
        "freezone_text_translate",
        "freezone_story_script",
    ],
    job_id: str,
    user: dict = Depends(get_api_user),
):
    """任务完成后，通过这个接口解析最终产物 URL。

    前端通过 `/projects/{project_id}/tasks/stream` 的 SSE 知道任务是否完成；
    这个接口只负责把 `(task_type, job_id)` 翻译成实际的 `/static/...` URL。
    """
    ctx, username, project_name, project_dir, _output_dir = await _resolve_freezone_project(
        project, user, required_role="viewer"
    )
    task = (
        get_task_manager().get_task_for_project(ctx, task_type, 0, scope=job_id)
        if ctx is not None
        else get_task_manager().get_task(task_type, username, project_name, 0, scope=job_id)
    )
    if task_type == "freezone_image_to_3gs":
        if task is not None:
            if task.status == "failed":
                return {
                    "ok": False,
                    "error": task.error or "job failed",
                    "status": task.status,
                    "logs": task.logs[-10:],
                }
            if task.status in {"pending", "starting", "running"}:
                return {
                    "ok": False,
                    "info": "job result not yet available",
                    "status": task.status,
                    "current_task": task.current_task,
                }
            if isinstance(task.result, dict):
                data = (
                    migrate_canvas_static_urls_in_memory(
                        task.result,
                        project_id=ctx.project_id,
                        owner_username=ctx.owner_username,
                        project_name=ctx.project_name,
                        project_dir=project_dir,
                    )
                    or task.result
                )
                splat_url = (
                    data.get("splat_url")
                    or data.get("ply_url")
                    or data.get("output_url")
                    or data.get("url")
                )
                for key in ("ply_path", "sog_path"):
                    value = data.get(key)
                    if isinstance(value, str) and value.startswith(str(project_dir)):
                        try:
                            rel = Path(value).relative_to(project_dir).as_posix()
                        except ValueError:
                            continue
                        splat_url = make_static_url_for_context(ctx, rel, local_path=value)
                        data[key] = splat_url
                if splat_url:
                    data.setdefault("output_url", splat_url)
                    data.setdefault("url", splat_url)
                    data.setdefault("ply_url", splat_url)
                    data.setdefault("splat_url", splat_url)
                    data.setdefault("media_type", "file")
                return {"ok": True, "data": data}

        artifact_dir = outputs_dir(project_dir, "freezone_image_to_3gs") / job_id
        candidates = sorted(artifact_dir.glob("*.sog")) or sorted(artifact_dir.glob("*.ply"))
        if candidates:
            out = candidates[0]
            rel = out.relative_to(project_dir).as_posix()
            url = make_static_url_for_context(ctx, rel, local_path=out)
            suffix = out.suffix.lower().lstrip(".")
            return {
                "ok": True,
                "data": {
                    "url": url,
                    "output_url": url,
                    "ply_url": url,
                    "splat_url": url,
                    "ply_path": url,
                    "splat_format": suffix if suffix in {"ply", "sog"} else "unknown",
                    "media_type": "file",
                    "size": out.stat().st_size,
                },
            }
        return {"ok": False, "info": "job result not yet on disk", "status": "unknown"}

    out = output_path_for_job(project_dir, task_type, job_id)
    if task_type == "freezone_image_reverse_prompt":
        out = _image_reverse_prompt_output_path(project_dir, job_id)
    if task_type == "freezone_video_erase":
        out = _video_erase_output_path(project_dir, job_id)
    if task_type == "freezone_video_upscale":
        out = _video_upscale_output_path(project_dir, job_id)
    if task_type == "freezone_audio_separate":
        audio_out = _audio_separate_audio_output_path(project_dir, job_id)
        mute_video_out = _audio_separate_mute_video_output_path(project_dir, job_id)
        if not mute_video_out.exists():
            if task is not None:
                if task.status == "failed":
                    return {
                        "ok": False,
                        "error": task.error or "job failed",
                        "status": task.status,
                        "logs": task.logs[-10:],
                    }
                if task.status in {"pending", "starting", "running"}:
                    return {
                        "ok": False,
                        "info": "job result not yet on disk",
                        "status": task.status,
                        "current_task": task.current_task,
                    }
            return {"ok": False, "info": "job result not yet on disk", "status": "unknown"}
        audio_rel = audio_out.relative_to(project_dir).as_posix() if audio_out.exists() else None
        mute_rel = mute_video_out.relative_to(project_dir).as_posix()
        task_result = getattr(task, "result", None) if task is not None else None
        push_metadata = {}
        if isinstance(task_result, dict):
            if task_result.get("pushable"):
                push_metadata["pushable"] = True
            if isinstance(task_result.get("slot_target"), dict):
                push_metadata["slot_target"] = task_result["slot_target"]
        return {
            "ok": True,
            "data": {
                "audio_url": make_static_url_for_context(ctx, audio_rel) if audio_rel else None,
                "audio_size": audio_out.stat().st_size if audio_out.exists() else 0,
                "mute_video_url": make_static_url_for_context(ctx, mute_rel),
                "mute_video_size": mute_video_out.stat().st_size,
                **push_metadata,
            },
        }
    if task_type == "freezone_audio_speech":
        out = freezone_audio_speech_output_path(project_dir, job_id)
    if task_type == "freezone_audio_eleven_music":
        out = freezone_audio_eleven_music_output_path(project_dir, job_id)
    if task_type == "freezone_video_compose":
        out = _video_compose_output_path(project_dir, job_id)
    if task_type == "freezone_text_translate":
        out = _text_translate_output_path(project_dir, job_id)
    if task_type == "freezone_story_script":
        out = _story_script_output_path(project_dir, job_id)
    if task_type in {"freezone_analyze", "freezone_video_story"}:
        if task is not None:
            if task.status == "failed":
                return {
                    "ok": False,
                    "error": task.error or "job failed",
                    "status": task.status,
                    "logs": task.logs[-10:],
                }
            if task.status != "completed":
                return {
                    "ok": False,
                    "info": "job result not yet available",
                    "status": task.status,
                    "current_task": task.current_task,
                }
        task_result = getattr(task, "result", None) if task is not None else None
        if isinstance(task_result, dict):
            if task_type == "freezone_video_story":
                task_result = _public_freezone_video_story_result(task_result)
            return {"ok": True, "data": task_result}
        analysis_out = outputs_dir(project_dir, "freezone_analyze") / job_id / "analysis.json"
        if analysis_out.exists():
            data = json.loads(analysis_out.read_text(encoding="utf-8"))
            if task_type == "freezone_video_story" and isinstance(data, dict):
                data = _public_freezone_video_story_result(data)
            return {"ok": True, "data": data}
    if not out.exists():
        for suffix in (".webp", ".mp4", ".mov", ".webm"):
            candidate = out.with_suffix(suffix)
            if candidate.exists():
                out = candidate
                break
    if not out.exists():
        if task is not None:
            if task.status == "failed":
                return {
                    "ok": False,
                    "error": task.error or "job failed",
                    "status": task.status,
                    "logs": task.logs[-10:],
                }
            if task.status in {"pending", "starting", "running"}:
                return {
                    "ok": False,
                    "info": "job result not yet on disk",
                    "status": task.status,
                    "current_task": task.current_task,
                }
        return {"ok": False, "info": "job result not yet on disk", "status": "unknown"}
    if task_type in {
        "freezone_image_reverse_prompt",
        "freezone_text_translate",
        "freezone_story_script",
    }:
        return {"ok": True, "data": json.loads(out.read_text(encoding="utf-8"))}
    rel = out.relative_to(project_dir).as_posix()
    task_result = getattr(task, "result", None) if task is not None else None
    push_metadata = {}
    if isinstance(task_result, dict):
        if task_result.get("pushable"):
            push_metadata["pushable"] = True
        if isinstance(task_result.get("slot_target"), dict):
            push_metadata["slot_target"] = task_result["slot_target"]
    return {
        "ok": True,
        "data": {
            "url": make_static_url_for_context(ctx, rel, local_path=out),
            "size": out.stat().st_size,
            **push_metadata,
        },
    }


@router.get(
    "/projects/{project}/freezone/skills/runs/{run_id}/result",
    response_model=SkillRunResult,
    tags=[TAG_FREEZONE_SKILLS],
)
async def freezone_skill_run_result(
    project: str,
    run_id: str,
    user: dict = Depends(get_api_user),
):
    ctx, username, project_name, project_dir, _output_dir = await _resolve_freezone_project(
        project, user, required_role="viewer"
    )
    metadata = _read_skill_run_metadata(project_dir, run_id)
    if isinstance(metadata.get("outputs"), list):
        return SkillRunResult(
            run_id=run_id,
            status="done" if metadata.get("status") == "completed" else str(metadata.get("status")),
            outputs=[SkillRunOutput(**item) for item in metadata["outputs"]],
            task_key=metadata.get("task_key"),
            task_type=metadata.get("task_type"),
            job_id=metadata.get("job_id"),
        )

    task_type = str(metadata.get("task_type") or "")
    job_id = str(metadata.get("job_id") or "")
    if not task_type or not job_id:
        _raise_skill_error(
            500,
            code="skill_run_metadata_incomplete",
            category="runtime",
            message="skill run metadata missing task_type/job_id",
            retryable=True,
            user_action_hint="Retry the skill run. If this repeats, inspect stored run metadata.",
        )
    try:
        task_episode = int(metadata.get("task_episode") or 0)
    except (TypeError, ValueError):
        task_episode = 0
    task_scope = str(metadata.get("task_scope") or job_id)
    task_beat_num_raw = metadata.get("task_beat_num")
    try:
        task_beat_num = int(task_beat_num_raw) if task_beat_num_raw is not None else None
    except (TypeError, ValueError):
        task_beat_num = None
    task = (
        get_task_manager().get_task_for_project(
            ctx,
            task_type,
            task_episode,
            beat_num=task_beat_num,
            scope=task_scope,
        )
        if ctx is not None
        else get_task_manager().get_task(
            task_type,
            username,
            project_name,
            task_episode,
            beat_num=task_beat_num,
            scope=task_scope,
        )
    )
    task_status = getattr(task, "status", None)
    if task is not None and task_status == "failed":
        return SkillRunResult(
            run_id=run_id,
            status="failed",
            outputs=[],
            task_key=metadata.get("task_key"),
            task_type=task_type,
            job_id=job_id,
            error=SkillErrorEnvelope(
                code="skill_run_failed",
                category="runtime",
                message=task.error or "job failed",
                retryable=False,
                user_action_hint="Review the failed job logs before retrying.",
            ),
        )
    if task_status != "completed":
        return SkillRunResult(
            run_id=run_id,
            status=_skill_run_status_from_task_status(task_status),
            outputs=[],
            task_key=metadata.get("task_key"),
            task_type=task_type,
            job_id=job_id,
        )
    task_result = getattr(task, "result", None) if task is not None else None
    output_metadata = dict(metadata.get("output") or {})
    nested_outputs = _normalize_task_result_outputs(
        task_result=task_result,
        output_metadata=output_metadata,
        project_dir=project_dir,
        ctx=ctx,
        username=username,
        project_name=project_name,
    )
    if nested_outputs:
        finalized_outputs = await _finalize_skill_run_outputs(
            project=project,
            project_dir=project_dir,
            ctx=ctx,
            metadata=metadata,
            outputs=[item.model_dump(mode="json") for item in nested_outputs],
            user=user,
        )
        return SkillRunResult(
            run_id=run_id,
            status="done",
            outputs=[SkillRunOutput(**item) for item in finalized_outputs],
            task_key=metadata.get("task_key"),
            task_type=task_type,
            job_id=job_id,
        )
    image_url = _extract_result_image_url(task_result)
    if not image_url:
        image_url = _static_url_for_task_result_path(
            task_result=task_result,
            project_dir=project_dir,
            ctx=ctx,
            username=username,
            project_name=project_name,
        )
    if not image_url and getattr(task, "status", None) == "completed":
        image_url = _static_url_for_skill_slot_target(
            output_metadata=output_metadata,
            project_dir=project_dir,
            ctx=ctx,
        )
    out = _skill_output_path_for_job(project_dir, task_type, job_id)
    if not image_url and out is not None:
        rel = out.relative_to(project_dir).as_posix()
        image_url = make_static_url_for_context(ctx, rel, local_path=out)
    if image_url:
        finalized_outputs = await _finalize_skill_run_outputs(
            project=project,
            project_dir=project_dir,
            ctx=ctx,
            metadata=metadata,
            outputs=[{**output_metadata, "image_url": image_url}],
            user=user,
        )
        return SkillRunResult(
            run_id=run_id,
            status="done",
            outputs=[SkillRunOutput(**item) for item in finalized_outputs],
            task_key=metadata.get("task_key"),
            task_type=task_type,
            job_id=job_id,
        )
    return SkillRunResult(
        run_id=run_id,
        status=_skill_run_status_from_task_status(task_status),
        outputs=[],
        task_key=metadata.get("task_key"),
        task_type=task_type,
        job_id=job_id,
    )


# ============================================================
# 画布（F5）
# ============================================================


def _default_push_target_for_preset(body: PresetCanvasRequest) -> dict:
    if body.scope == "episode":
        return {"kind": "manual", "episode": body.episode}
    if body.scope == "beat":
        slot = body.primary_slot or "render"
        kind = "director_render" if slot == "render" else slot
        return {
            "kind": kind,
            "episode": body.episode,
            "beat": body.beat,
        }
    if body.scope == "asset" and body.asset_kind in {"identity", "portrait", "character"}:
        if body.asset_kind in {"portrait", "character"}:
            return {"kind": "portrait", "character": body.character}
        return {
            "kind": "identity",
            "character": body.character,
            "identity_id": body.identity_id,
        }
    if body.scope == "asset" and body.asset_kind in {
        "scene",
        "scene_master",
        "scene_reverse_master",
        "scene_spatial_layout",
        "scene_360",
        "scene_director_pano_360",
        "scene_3gs_active_ply",
        "scene_3gs_master_ply",
        "scene_3gs_reverse_ply",
        "scene_3gs_pano_ply",
        "scene_3gs_custom_scene",
        "scene_3gs_collision_glb",
    }:
        scene_id = body.asset_id or body.identity_id or body.character
        scene_kind = "scene_master" if body.asset_kind == "scene" else body.asset_kind
        return {"kind": scene_kind, "scene_id": scene_id}
    if body.scope == "asset" and body.asset_kind in {"prop", "prop_ref"}:
        prop_id = body.asset_id or body.identity_id or body.character
        return {"kind": "prop_ref", "prop_id": prop_id}
    return {"kind": "manual"}


def _latest_preset_canvas(project_dir: Path, preset_key: str) -> str | None:
    return canvas_store.latest_preset_canvas(project_dir, preset_key)


def _canonical_preset_canvas(
    project_dir: Path,
    *,
    preset_key: str,
    canvas_id: str,
) -> str | None:
    payload = canvas_store.read_canvas(project_dir, canvas_id)
    if not isinstance(payload, dict):
        return None
    preset = (payload.get("metadata") or {}).get("preset")
    if isinstance(preset, dict) and preset.get("preset_key") == preset_key:
        return canvas_id
    return None


def _preset_key_from_canvas_metadata(metadata: dict | None) -> str | None:
    if not isinstance(metadata, dict):
        return None
    preset = metadata.get("preset")
    if not isinstance(preset, dict):
        return None
    existing = preset.get("preset_key")
    if isinstance(existing, str) and existing.strip():
        return existing.strip()
    scope = preset.get("scope")
    if not isinstance(scope, str) or not scope:
        return None
    try:
        return preset_key_for_request(
            scope=scope,
            episode=preset.get("episode") if isinstance(preset.get("episode"), int) else None,
            beat=preset.get("beat") if isinstance(preset.get("beat"), int) else None,
            primary_slot=(
                preset.get("primary_slot") if isinstance(preset.get("primary_slot"), str) else None
            ),
            asset_kind=(
                preset.get("asset_kind") if isinstance(preset.get("asset_kind"), str) else None
            ),
            character=(
                preset.get("character") if isinstance(preset.get("character"), str) else None
            ),
            identity_id=(
                preset.get("identity_id") if isinstance(preset.get("identity_id"), str) else None
            ),
            asset_id=(preset.get("asset_id") if isinstance(preset.get("asset_id"), str) else None),
        )
    except ValueError:
        return None


def _canvas_state_project_dir(ctx: ProjectContext | None, output_project_dir: Path) -> Path:
    if ctx is not None:
        return Path(ctx.state_dir)
    return output_project_dir


def _canvas_actor_id(user: dict) -> str:
    return str(user.get("id") or user.get("user_id") or user.get("username") or "")


def _canvas_scope_from_payload(canvas_id: str, payload: dict) -> str:
    raw_scope = payload.get("canvas_scope")
    if raw_scope in {"default", "episode", "beat", "asset"}:
        return raw_scope
    preset = (payload.get("metadata") or {}).get("preset") if isinstance(payload, dict) else None
    preset_scope = preset.get("scope") if isinstance(preset, dict) else None
    if preset_scope in {"episode", "beat", "asset"}:
        return preset_scope
    return "default"


def _merge_canvas_metadata(existing: dict | None, incoming: dict) -> None:
    existing_meta = existing.get("metadata") if isinstance(existing, dict) else None
    incoming_meta = incoming.get("metadata")
    if isinstance(existing_meta, dict) and isinstance(incoming_meta, dict):
        incoming["metadata"] = {**existing_meta, **incoming_meta}
    elif isinstance(existing_meta, dict) and incoming_meta is None:
        incoming["metadata"] = existing_meta


def _prepare_canvas_payload_for_write(
    *,
    project_id: str,
    canvas_id: str,
    body: CanvasPayload | None,
    raw_payload: dict | None = None,
    existing: dict | None = None,
    user: dict,
) -> dict:
    now = canvas_store.utc_now_iso()
    actor_id = _canvas_actor_id(user)
    payload = (
        body.model_dump(
            exclude={"base_revision", "client_save_id", "allow_empty_overwrite"},
            exclude_none=True,
        )
        if body is not None
        else dict(raw_payload or {})
    )
    payload.setdefault("nodes", [])
    payload.setdefault("edges", [])
    payload.setdefault("viewport", None)
    if "metadata" not in payload:
        payload["metadata"] = None
    _merge_canvas_metadata(existing, payload)
    _sync_frame_context_reference_edges(payload)

    current_revision = existing.get("revision") if isinstance(existing, dict) else None
    if not isinstance(current_revision, int):
        current_revision = None
    payload["schema_version"] = 2
    payload["canvas_id"] = canvas_id
    payload["project_id"] = project_id
    payload["canvas_scope"] = _canvas_scope_from_payload(canvas_id, payload)
    payload["owner_principal_type"] = (
        payload.get("owner_principal_type")
        or (existing or {}).get("owner_principal_type")
        or "user"
    )
    payload["owner_principal_id"] = (
        payload.get("owner_principal_id") or (existing or {}).get("owner_principal_id") or actor_id
    )
    payload["access_model"] = (
        payload.get("access_model") or (existing or {}).get("access_model") or "project_role"
    )
    payload["min_project_role"] = (
        payload.get("min_project_role") or (existing or {}).get("min_project_role") or "editor"
    )
    payload["created_by"] = (
        (existing or {}).get("created_by") or payload.get("created_by") or actor_id
    )
    payload["created_at"] = (existing or {}).get("created_at") or payload.get("created_at") or now
    payload["updated_by"] = actor_id
    payload["updated_at"] = now
    payload["revision"] = (current_revision + 1) if current_revision is not None else 1
    payload.pop("base_revision", None)
    return payload


async def _refresh_preset_canvas_payload_on_read(
    *,
    ctx: ProjectContext,
    username: str,
    project_name: str,
    project_dir: Path,
    payload: dict,
) -> dict:
    metadata = payload.get("metadata") if isinstance(payload.get("metadata"), dict) else {}
    preset = metadata.get("preset") if isinstance(metadata.get("preset"), dict) else {}
    if preset.get("scope") != "beat":
        return payload

    try:
        episode = int(preset.get("episode") or 0)
        beat = int(preset.get("beat") or 0)
    except (TypeError, ValueError):
        return payload
    if episode <= 0 or beat <= 0:
        return payload

    primary_slot = str(preset.get("primary_slot") or "").strip() or "render"
    store = await make_sqlite_store_for_context(ctx)
    try:
        context = await build_beat_preset_context(
            project_id=ctx.project_id,
            username=username,
            project=project_name,
            project_dir=project_dir,
            store=store,
            episode=episode,
            beat=beat,
            primary_slot=primary_slot,
        )
    except Exception as exc:  # noqa: BLE001 - stale canvas is better than failed read
        logger.warning(
            "failed to refresh beat preset canvas from mainline: ep=%s beat=%s: %s",
            episode,
            beat,
            exc,
        )
        return payload
    finally:
        close = getattr(store, "close", None)
        if close:
            result = close()
            if asyncio.iscoroutine(result):
                await result

    fresh_payload = build_canvas_payload_from_context(
        context=context,
        preset_key=str(preset.get("preset_key") or ""),
        default_push_target={
            "kind": "sketch" if primary_slot == "sketch" else "frame",
            "episode": episode,
            "beat": beat,
        },
        created_at=str(preset.get("created_at") or canvas_store.utc_now_iso()),
    )
    merged = _merge_restored_preset_canvas(fresh_payload, payload)
    for key in (
        "schema_version",
        "canvas_id",
        "project_id",
        "canvas_scope",
        "owner_principal_type",
        "owner_principal_id",
        "access_model",
        "min_project_role",
        "created_by",
        "created_at",
        "updated_by",
        "updated_at",
        "revision",
    ):
        if key in payload:
            merged[key] = payload[key]
    _stamp_canvas_mainline_context_project_id(merged, ctx.project_id)
    _sync_frame_context_reference_edges(merged)
    return merged


def _stamp_canvas_mainline_context_project_id(payload: dict, project_id: str) -> None:
    def stamp_contexts(value) -> None:
        if isinstance(value, list):
            for item in value:
                if isinstance(item, dict) and item.get("kind") and not item.get("projectId"):
                    item["projectId"] = project_id

    stamp_contexts(payload.get("mainline_context"))
    metadata = payload.get("metadata")
    if isinstance(metadata, dict):
        for ref in metadata.get("references") or []:
            if isinstance(ref, dict):
                stamp_contexts(ref.get("mainline_context"))
    for node in payload.get("nodes") or []:
        if not isinstance(node, dict):
            continue
        data = node.get("data")
        if isinstance(data, dict):
            stamp_contexts(data.get("mainline_context"))


def _raise_canvas_store_http(exc: Exception) -> None:
    if isinstance(exc, canvas_store.CanvasCorruptError):
        raise HTTPException(500, str(exc)) from exc
    if isinstance(exc, canvas_store.CanvasBaseRevisionRequired):
        raise HTTPException(409, str(exc)) from exc
    if isinstance(exc, canvas_store.CanvasRevisionConflict):
        raise HTTPException(
            409,
            {
                "code": "canvas_revision_conflict",
                "error": "canvas revision conflict",
                "current_revision": exc.current_revision,
                "base_revision": exc.base_revision,
            },
        ) from exc
    if isinstance(exc, canvas_store.CanvasIdempotencyConflict):
        raise HTTPException(
            409,
            {
                "code": "canvas_idempotency_conflict",
                "client_save_id": exc.client_save_id,
            },
        ) from exc
    if isinstance(exc, canvas_store.CanvasInvalidHistoryId):
        raise HTTPException(400, str(exc)) from exc
    if isinstance(exc, canvas_store.CanvasHistoryNotFound):
        raise HTTPException(404, str(exc)) from exc
    if isinstance(exc, canvas_store.DangerousEmptyCanvasOverwrite):
        raise HTTPException(
            400,
            {
                "code": "dangerous_empty_canvas_overwrite",
                "old_nodes": exc.old_nodes,
                "new_nodes": exc.new_nodes,
                "save_source": exc.save_source,
            },
        ) from exc
    if isinstance(exc, CanvasLockBusy):
        raise HTTPException(
            503,
            {"code": "canvas_lock_busy", "canvas_id": exc.canvas_id},
            headers={"Retry-After": "1"},
        ) from exc
    raise exc


def _merge_restored_preset_canvas(new_payload: dict, existing_payload: dict | None) -> dict:
    """Restore preset-managed graph while preserving user experiment nodes.

    Preset restore should refresh protected mainline context/workflow/artifact
    nodes from current DB facts, but it must not discard free side experiments
    or already-produced candidates on the same canvas.
    """
    if not isinstance(existing_payload, dict):
        return new_payload

    new_nodes = [n for n in new_payload.get("nodes") or [] if isinstance(n, dict)]
    new_edges = [e for e in new_payload.get("edges") or [] if isinstance(e, dict)]
    new_node_ids = {str(n.get("id")) for n in new_nodes if n.get("id")}
    new_edge_ids = {str(e.get("id")) for e in new_edges if e.get("id")}

    preserved_nodes: list[dict] = []
    for node in existing_payload.get("nodes") or []:
        if not isinstance(node, dict):
            continue
        node_id = str(node.get("id") or "")
        if not node_id:
            preserved_nodes.append(node)
            continue
        if node_id in new_node_ids:
            continue
        if _is_preset_managed_canvas_node(node):
            continue
        preserved_nodes.append(node)

    final_node_ids = new_node_ids | {str(n.get("id")) for n in preserved_nodes if n.get("id")}
    # preset-managed 节点之间的 edge 归 preset 管 — 旧 preset emit 过、新 preset
    # 不 emit 了的(比如 edge 方向反转、删了 workflow trigger 等)就该消失。
    # 不然旧 edge 会跟新 edge 共存,画布出现重复/交叉连线 (X 形)。
    preset_managed_node_ids = {
        str(n.get("id"))
        for n in [*new_nodes, *preserved_nodes]
        if n.get("id") and _is_preset_managed_canvas_node(n)
    }
    preserved_edges: list[dict] = []
    for edge in existing_payload.get("edges") or []:
        if not isinstance(edge, dict):
            continue
        edge_id = str(edge.get("id") or "")
        if edge_id and edge_id in new_edge_ids:
            continue
        source = str(edge.get("source") or "")
        target = str(edge.get("target") or "")
        if not source or not target:
            continue
        if source not in final_node_ids or target not in final_node_ids:
            continue
        edge_data = edge.get("data") if isinstance(edge.get("data"), dict) else {}
        # Edges between two preset-managed nodes normally belong to the preset
        # layer, including legacy edges emitted before explicit edge flags
        # existed. User-created role-binding edges are the exception: they carry
        # edgeKind=role_binding and must survive refresh.
        if (
            source in preset_managed_node_ids
            and target in preset_managed_node_ids
            and isinstance(edge_data, dict)
            and edge_data.get("edgeKind") != "role_binding"
        ):
            continue
        preserved_edges.append(edge)

    new_payload["nodes"] = [*new_nodes, *preserved_nodes]
    new_payload["edges"] = [*new_edges, *preserved_edges]
    new_payload["viewport"] = existing_payload.get("viewport") or new_payload.get("viewport")
    return new_payload


def _node_projection_key(node: dict) -> str | None:
    data = node.get("data") if isinstance(node.get("data"), dict) else {}
    value = data.get("projection_key")
    return value if isinstance(value, str) and value else None


def _edge_projection_key(edge: dict) -> str | None:
    data = edge.get("data") if isinstance(edge.get("data"), dict) else {}
    value = data.get("projection_key")
    return value if isinstance(value, str) and value else None


def _is_replaceable_projection_node(node: dict, projection_key: str) -> bool:
    data = node.get("data") if isinstance(node.get("data"), dict) else {}
    if data.get("user_spawned") is True:
        return False
    return data.get("preset_managed") is True and data.get("projection_key") == projection_key


def _is_replaceable_projection_edge(edge: dict, projection_key: str) -> bool:
    data = edge.get("data") if isinstance(edge.get("data"), dict) else {}
    if data.get("user_spawned") is True:
        return False
    return data.get("preset_managed") is True and data.get("projection_key") == projection_key


def _archive_projection_node(node: dict) -> dict:
    archived = dict(node)
    data = dict(archived.get("data") if isinstance(archived.get("data"), dict) else {})
    projection_key = data.get("projection_key")
    data.pop("preset_managed", None)
    data.pop("projection_key", None)
    if isinstance(projection_key, str) and projection_key:
        data["source_projection_key"] = projection_key
    data["projection_archived"] = True
    data["user_spawned"] = True
    archived["data"] = data
    return archived


def _user_owned_projection_node(node: dict) -> dict:
    """Return a user-owned node with projection management fields removed."""
    data = node.get("data") if isinstance(node.get("data"), dict) else {}
    if not isinstance(data, dict) or data.get("user_spawned") is not True:
        return node
    projection_key = data.get("projection_key")
    if not projection_key and data.get("preset_managed") is not True:
        return node
    cleaned = dict(node)
    next_data = dict(data)
    next_data.pop("preset_managed", None)
    next_data.pop("projection_key", None)
    if isinstance(projection_key, str) and projection_key:
        next_data.setdefault("source_projection_key", projection_key)
    cleaned["data"] = next_data
    return cleaned


def _merge_projected_preset_canvas(
    *,
    incoming_payload: dict,
    existing_payload: dict | None,
    projection_key: str,
) -> dict:
    """Refresh one projected preset subgraph without deleting user work.

    Only backend-owned nodes/edges matching ``projection_key`` are replaceable.
    User-spawned nodes, ordinary nodes, other projections, and user edges are
    preserved. If a user edge still points at an old preset node that the new
    projection no longer emits, the old node is archived into user-owned data
    instead of leaving a dangling edge.
    """
    if not isinstance(existing_payload, dict):
        return incoming_payload

    incoming_nodes = [
        node for node in incoming_payload.get("nodes") or [] if isinstance(node, dict)
    ]
    incoming_edges = [
        edge for edge in incoming_payload.get("edges") or [] if isinstance(edge, dict)
    ]
    incoming_node_ids = {
        node.get("id") for node in incoming_nodes if isinstance(node.get("id"), str)
    }

    existing_nodes = [
        node for node in existing_payload.get("nodes") or [] if isinstance(node, dict)
    ]
    existing_edges = [
        edge for edge in existing_payload.get("edges") or [] if isinstance(edge, dict)
    ]

    user_edge_endpoints: set[str] = set()
    for edge in existing_edges:
        if _is_replaceable_projection_edge(edge, projection_key):
            continue
        source = edge.get("source")
        target = edge.get("target")
        if isinstance(source, str):
            user_edge_endpoints.add(source)
        if isinstance(target, str):
            user_edge_endpoints.add(target)

    merged_nodes: list[dict] = []
    existing_replaceable_nodes_by_id = {
        node.get("id"): node
        for node in existing_nodes
        if isinstance(node.get("id"), str) and _is_replaceable_projection_node(node, projection_key)
    }
    next_incoming_nodes: list[dict] = []
    for node in incoming_nodes:
        node_id = node.get("id")
        existing_node = existing_replaceable_nodes_by_id.get(node_id)
        if isinstance(existing_node, dict) and node.get("type") == existing_node.get("type"):
            updated_node = dict(node)
            for layout_key in ("position", "style", "width", "height", "parentId", "extent"):
                if layout_key in existing_node:
                    value = existing_node[layout_key]
                    updated_node[layout_key] = dict(value) if isinstance(value, dict) else value
            next_incoming_nodes.append(updated_node)
            continue
        next_incoming_nodes.append(node)

    for node in existing_nodes:
        node_id = node.get("id")
        if not _is_replaceable_projection_node(node, projection_key):
            merged_nodes.append(_user_owned_projection_node(node))
            continue
        if node_id in incoming_node_ids:
            continue
        if isinstance(node_id, str) and node_id in user_edge_endpoints:
            merged_nodes.append(_archive_projection_node(node))
    merged_nodes.extend(next_incoming_nodes)

    final_node_ids = {node.get("id") for node in merged_nodes if isinstance(node.get("id"), str)}
    merged_edges: list[dict] = []
    for edge in existing_edges:
        if _is_replaceable_projection_edge(edge, projection_key):
            continue
        source = edge.get("source")
        target = edge.get("target")
        if isinstance(source, str) and source not in final_node_ids:
            continue
        if isinstance(target, str) and target not in final_node_ids:
            continue
        merged_edges.append(edge)
    merged_edges.extend(incoming_edges)

    merged = dict(existing_payload)
    merged["nodes"] = merged_nodes
    merged["edges"] = merged_edges
    metadata = dict(
        existing_payload.get("metadata")
        if isinstance(existing_payload.get("metadata"), dict)
        else {}
    )
    incoming_metadata = (
        incoming_payload.get("metadata")
        if isinstance(incoming_payload.get("metadata"), dict)
        else {}
    )
    projections = dict(
        metadata.get("projections") if isinstance(metadata.get("projections"), dict) else {}
    )
    incoming_projections = (
        incoming_metadata.get("projections")
        if isinstance(incoming_metadata.get("projections"), dict)
        else {}
    )
    if projection_key in incoming_projections:
        projections[projection_key] = incoming_projections[projection_key]
    metadata["projections"] = projections
    metadata["last_projection_key"] = projection_key
    merged["metadata"] = metadata
    return merged


def _remove_projected_preset_canvas(
    *,
    existing_payload: dict,
    projection_key: str,
) -> dict:
    """Remove one projected preset subgraph while preserving user work.

    Matching preset-managed projection nodes/edges are removed. User-spawned
    nodes are preserved even if they carry the same projection_key as
    provenance; edges dangling after projection removal are dropped.
    """
    if not isinstance(existing_payload, dict):
        return existing_payload

    existing_nodes = [
        node for node in existing_payload.get("nodes") or [] if isinstance(node, dict)
    ]
    existing_edges = [
        edge for edge in existing_payload.get("edges") or [] if isinstance(edge, dict)
    ]

    kept_nodes = [
        _user_owned_projection_node(node)
        for node in existing_nodes
        if not _is_replaceable_projection_node(node, projection_key)
    ]
    kept_node_ids = {node.get("id") for node in kept_nodes if isinstance(node.get("id"), str)}

    kept_edges: list[dict] = []
    for edge in existing_edges:
        if _is_replaceable_projection_edge(edge, projection_key):
            continue
        source = edge.get("source")
        target = edge.get("target")
        if isinstance(source, str) and source not in kept_node_ids:
            continue
        if isinstance(target, str) and target not in kept_node_ids:
            continue
        kept_edges.append(edge)

    merged = dict(existing_payload)
    merged["nodes"] = kept_nodes
    merged["edges"] = kept_edges
    metadata = dict(
        existing_payload.get("metadata")
        if isinstance(existing_payload.get("metadata"), dict)
        else {}
    )
    projections = dict(
        metadata.get("projections") if isinstance(metadata.get("projections"), dict) else {}
    )
    projections.pop(projection_key, None)
    metadata["projections"] = projections
    if metadata.get("last_projection_key") == projection_key:
        metadata.pop("last_projection_key", None)
    merged["metadata"] = metadata
    return merged


def _is_preset_managed_canvas_node(node: dict) -> bool:
    """Decide whether a restored canvas node is preset-managed.

    Current protocol is intentionally strict: only explicit
    `data.preset_managed === True` gives preset ownership. Pre-release
    heuristic fields such as workflow_kind, __freezone_source, mainline_role,
    artifact_role, or mainline_context are treated as user data unless the
    explicit ownership flag is present.
    """
    data = node.get("data") if isinstance(node.get("data"), dict) else {}
    if not isinstance(data, dict):
        return False
    return data.get("preset_managed") is True


_PRESET_FACTS_SIGNATURE_OMIT_KEYS = {
    "created_at",
    "createdAt",
    "dragging",
    "measured",
    "position",
    "revision",
    "resizing",
    "selected",
    "updated_at",
    "updatedAt",
}


def _canonical_preset_facts_value(value):
    if isinstance(value, dict):
        return {
            key: _canonical_preset_facts_value(raw_value)
            for key, raw_value in sorted(value.items())
            if key not in _PRESET_FACTS_SIGNATURE_OMIT_KEYS
            and not (isinstance(key, str) and key.startswith("__runtime"))
        }
    if isinstance(value, list):
        return [_canonical_preset_facts_value(item) for item in value]
    return value


def _preset_facts_signature(payload: dict) -> str:
    nodes = [
        node
        for node in payload.get("nodes") or []
        if isinstance(node, dict) and _is_preset_managed_canvas_node(node)
    ]
    preset_node_ids = {str(node.get("id")) for node in nodes if node.get("id")}
    edges: list[dict] = []
    for edge in payload.get("edges") or []:
        if not isinstance(edge, dict):
            continue
        data = edge.get("data") if isinstance(edge.get("data"), dict) else {}
        source = str(edge.get("source") or "")
        target = str(edge.get("target") or "")
        if (
            data.get("preset_managed") is True
            or source in preset_node_ids
            or target in preset_node_ids
        ):
            edges.append(edge)
    canonical = {
        "nodes": sorted(
            (_canonical_preset_facts_value(node) for node in nodes),
            key=lambda node: str(node.get("id") or "") if isinstance(node, dict) else "",
        ),
        "edges": sorted(
            (_canonical_preset_facts_value(edge) for edge in edges),
            key=lambda edge: (
                str(edge.get("source") or "") if isinstance(edge, dict) else "",
                str(edge.get("target") or "") if isinstance(edge, dict) else "",
                str(edge.get("id") or "") if isinstance(edge, dict) else "",
            ),
        ),
    }
    return canvas_store.canvas_request_hash(canonical)


def _stamp_preset_facts_signature(payload: dict, signature: str) -> None:
    metadata = payload.setdefault("metadata", {})
    if not isinstance(metadata, dict):
        metadata = {}
        payload["metadata"] = metadata
    preset = metadata.setdefault("preset", {})
    if not isinstance(preset, dict):
        preset = {}
        metadata["preset"] = preset
    preset["facts_signature"] = signature


def _stamp_projection_key(payload: dict, projection_key: str) -> None:
    nodes = [
        node
        for node in payload.get("nodes") or []
        if isinstance(node, dict) and _is_preset_managed_canvas_node(node)
    ]
    preset_node_ids = {str(node.get("id")) for node in nodes if node.get("id")}
    for node in nodes:
        data = node.setdefault("data", {})
        if isinstance(data, dict):
            data["preset_managed"] = True
            data["projection_key"] = projection_key
    for edge in payload.get("edges") or []:
        if not isinstance(edge, dict):
            continue
        source = str(edge.get("source") or "")
        target = str(edge.get("target") or "")
        data = edge.setdefault("data", {})
        if not isinstance(data, dict):
            data = {}
            edge["data"] = data
        if (
            data.get("preset_managed") is True
            or source in preset_node_ids
            or target in preset_node_ids
        ):
            data["preset_managed"] = True
            data["projection_key"] = projection_key


def _projection_group_id(projection_key: str) -> str:
    slug = re.sub(r"[^A-Za-z0-9]+", "_", projection_key).strip("_").lower()
    if not slug:
        slug = canvas_store.canvas_request_hash({"projection_key": projection_key})[:12]
    if len(slug) > 48:
        digest = canvas_store.canvas_request_hash({"projection_key": projection_key})[:12]
        slug = f"{slug[:35]}_{digest}"
    return f"projection_group_{slug}"


def _projection_group_label(body: ProjectionPresetCanvasRequest) -> str:
    if body.scope == "beat" and body.episode is not None and body.beat is not None:
        return f"EP{body.episode}/B{body.beat}"
    if body.scope == "episode" and body.episode is not None:
        return f"EP{body.episode}"
    if body.scope == "asset":
        if body.character:
            return str(body.character)
        if body.asset_id:
            return str(body.asset_id)
        if body.identity_id:
            return str(body.identity_id)
        if body.asset_kind:
            return str(body.asset_kind)
    return body.projection_key


def _node_display_size(node: dict) -> tuple[float, float]:
    style = node.get("style") if isinstance(node.get("style"), dict) else {}
    raw_width = node.get("width") or style.get("width")
    raw_height = node.get("height") or style.get("height")
    try:
        width = float(raw_width)
    except (TypeError, ValueError):
        width = 320.0
    try:
        height = float(raw_height)
    except (TypeError, ValueError):
        height = 180.0
    return max(1.0, width), max(1.0, height)


def _wrap_projection_payload_in_group(
    payload: dict,
    *,
    projection_key: str,
    label: str,
) -> dict:
    nodes = [node for node in payload.get("nodes") or [] if isinstance(node, dict)]
    child_nodes = [
        node
        for node in nodes
        if node.get("type") != "groupNode" and _is_replaceable_projection_node(node, projection_key)
    ]
    if not child_nodes:
        return payload

    bounds = {
        "min_x": float("inf"),
        "min_y": float("inf"),
        "max_x": float("-inf"),
        "max_y": float("-inf"),
    }
    for node in child_nodes:
        position = node.get("position") if isinstance(node.get("position"), dict) else {}
        try:
            x = float(position.get("x") or 0)
        except (TypeError, ValueError):
            x = 0.0
        try:
            y = float(position.get("y") or 0)
        except (TypeError, ValueError):
            y = 0.0
        width, height = _node_display_size(node)
        bounds["min_x"] = min(bounds["min_x"], x)
        bounds["min_y"] = min(bounds["min_y"], y)
        bounds["max_x"] = max(bounds["max_x"], x + width)
        bounds["max_y"] = max(bounds["max_y"], y + height)

    if not all(
        map(lambda value: value != float("inf") and value != float("-inf"), bounds.values())
    ):
        return payload

    side_padding = 20
    top_padding = 34
    bottom_padding = 20
    group_x = round(bounds["min_x"] - side_padding)
    group_y = round(bounds["min_y"] - top_padding)
    group_width = round(max(220, bounds["max_x"] - bounds["min_x"] + side_padding * 2))
    group_height = round(max(140, bounds["max_y"] - bounds["min_y"] + top_padding + bottom_padding))
    group_id = _projection_group_id(projection_key)
    group_node = {
        "id": group_id,
        "type": "groupNode",
        "position": {"x": group_x, "y": group_y},
        "style": {"width": group_width, "height": group_height},
        "data": {
            "label": label,
            "displayName": label,
            "preset_managed": True,
            "projection_key": projection_key,
        },
    }

    child_ids = {str(node.get("id")) for node in child_nodes if node.get("id")}
    next_nodes: list[dict] = []
    inserted_group = False
    for node in nodes:
        if not inserted_group and str(node.get("id") or "") in child_ids:
            next_nodes.append(group_node)
            inserted_group = True
        if str(node.get("id") or "") not in child_ids:
            if node.get("id") != group_id:
                next_nodes.append(node)
            continue
        updated = dict(node)
        position = updated.get("position") if isinstance(updated.get("position"), dict) else {}
        try:
            x = float(position.get("x") or 0)
        except (TypeError, ValueError):
            x = 0.0
        try:
            y = float(position.get("y") or 0)
        except (TypeError, ValueError):
            y = 0.0
        updated["parentId"] = group_id
        updated["extent"] = "parent"
        updated["position"] = {
            "x": round(x - group_x),
            "y": round(y - group_y),
        }
        next_nodes.append(updated)

    if not inserted_group:
        next_nodes.insert(0, group_node)
    payload["nodes"] = next_nodes
    return payload


def _stamp_projection_metadata(
    payload: dict,
    *,
    projection_key: str,
    preset_key: str,
    body: ProjectionPresetCanvasRequest,
    facts_signature: str,
) -> None:
    metadata = payload.setdefault("metadata", {})
    if not isinstance(metadata, dict):
        metadata = {}
        payload["metadata"] = metadata
    metadata.pop("preset", None)
    projections = metadata.setdefault("projections", {})
    if not isinstance(projections, dict):
        projections = {}
        metadata["projections"] = projections
    projections[projection_key] = {
        "projection_key": projection_key,
        "preset_key": preset_key,
        "scope": body.scope,
        "request": body.model_dump(
            exclude={"base_revision", "force_refresh"},
            exclude_none=True,
        ),
        "facts_signature": facts_signature,
        "last_synced_at": canvas_store.utc_now_iso(),
    }
    metadata["last_projection_key"] = projection_key


def _projection_facts_signature_from_payload(
    payload: dict | None,
    projection_key: str,
) -> str:
    if not isinstance(payload, dict):
        return ""
    metadata = payload.get("metadata")
    if not isinstance(metadata, dict):
        return ""
    projections = metadata.get("projections")
    if not isinstance(projections, dict):
        return ""
    projection = projections.get(projection_key)
    if not isinstance(projection, dict):
        return ""
    signature = projection.get("facts_signature")
    return signature if isinstance(signature, str) else ""


def _preset_facts_signature_from_payload(payload: dict | None) -> str:
    if not isinstance(payload, dict):
        return ""
    preset = (payload.get("metadata") or {}).get("preset")
    if not isinstance(preset, dict):
        return ""
    signature = preset.get("facts_signature")
    return signature if isinstance(signature, str) else ""


async def _build_canvas_payload_for_preset_request(
    *,
    ctx: ProjectContext | None,
    username: str,
    project_name: str,
    project_dir: Path,
    body: PresetCanvasRequest | ProjectionPresetCanvasRequest,
    preset_key: str,
) -> dict:
    if body.scope == "blank":
        return {
            "nodes": [],
            "edges": [],
            "viewport": None,
            "metadata": {
                "preset": {
                    "preset_key": preset_key,
                    "scope": "blank",
                    "created_at": canvas_store.utc_now_iso(),
                }
            },
        }
    if body.scope == "episode":
        if body.episode is None:
            raise HTTPException(400, "episode preset requires episode")
        store = (
            await make_sqlite_store_for_context(ctx)
            if ctx is not None
            else await make_sqlite_store(username, project_name)
        )
        try:
            context = await build_episode_preset_context(
                project_id=ctx.project_id,
                username=username,
                project=project_name,
                project_dir=project_dir,
                store=store,
                episode=body.episode,
            )
        finally:
            close = getattr(store, "close", None)
            if close:
                await close()
        return build_canvas_payload_from_context(
            context=context,
            preset_key=preset_key,
            default_push_target=_default_push_target_for_preset(body),
            created_at=canvas_store.utc_now_iso(),
        )
    if body.scope == "beat":
        if body.episode is None or body.beat is None:
            raise HTTPException(400, "beat preset requires episode and beat")
        store = (
            await make_sqlite_store_for_context(ctx)
            if ctx is not None
            else await make_sqlite_store(username, project_name)
        )
        try:
            context = await build_beat_preset_context(
                project_id=ctx.project_id,
                username=username,
                project=project_name,
                project_dir=project_dir,
                store=store,
                episode=body.episode,
                beat=body.beat,
                primary_slot=body.primary_slot,
            )
        except ValueError as exc:
            raise HTTPException(404, str(exc)) from exc
        finally:
            close = getattr(store, "close", None)
            if close:
                await close()
        return build_canvas_payload_from_context(
            context=context,
            preset_key=preset_key,
            default_push_target=_default_push_target_for_preset(body),
            created_at=canvas_store.utc_now_iso(),
        )
    if body.scope == "asset":
        if not body.asset_kind:
            raise HTTPException(400, "asset preset requires asset_kind")
        store = (
            await make_sqlite_store_for_context(ctx)
            if ctx is not None
            else await make_sqlite_store(username, project_name)
        )
        try:
            context = await build_asset_preset_context(
                project_id=ctx.project_id,
                username=username,
                project=project_name,
                project_dir=project_dir,
                store=store,
                asset_kind=body.asset_kind,
                character=body.character,
                identity_id=body.identity_id,
                asset_id=body.asset_id,
            )
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        finally:
            close = getattr(store, "close", None)
            if close:
                await close()
        payload = build_canvas_payload_from_context(
            context=context,
            preset_key=preset_key,
            default_push_target=_default_push_target_for_preset(body),
            created_at=canvas_store.utc_now_iso(),
        )
        preset_meta = payload.setdefault("metadata", {}).setdefault("preset", {})
        preset_meta.update(
            {
                "asset_kind": body.asset_kind,
                "character": body.character,
                "identity_id": body.identity_id,
                "asset_id": body.asset_id,
            }
        )
        return payload
    raise HTTPException(400, f"unsupported preset scope: {body.scope}")


async def _build_projection_payload_for_request(
    *,
    ctx: ProjectContext | None,
    username: str,
    project_name: str,
    project_dir: Path,
    body: ProjectionPresetCanvasRequest,
) -> tuple[dict, str, str]:
    try:
        preset_key = preset_key_for_request(
            scope=body.scope,
            episode=body.episode,
            beat=body.beat,
            primary_slot=body.primary_slot,
            asset_kind=body.asset_kind,
            character=body.character,
            identity_id=body.identity_id,
            asset_id=body.asset_id,
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc

    payload = await _build_canvas_payload_for_preset_request(
        ctx=ctx,
        username=username,
        project_name=project_name,
        project_dir=project_dir,
        body=body,
        preset_key=preset_key,
    )
    _stamp_projection_key(payload, body.projection_key)
    _wrap_projection_payload_in_group(
        payload,
        projection_key=body.projection_key,
        label=_projection_group_label(body),
    )
    incoming_facts_signature = _preset_facts_signature(payload)
    _stamp_projection_metadata(
        payload,
        projection_key=body.projection_key,
        preset_key=preset_key,
        body=body,
        facts_signature=incoming_facts_signature,
    )
    return payload, preset_key, incoming_facts_signature


@router.post("/projects/{project}/freezone/canvases:from-preset", tags=[TAG_FREEZONE_CANVAS])
async def create_canvas_from_preset(
    project: str,
    body: PresetCanvasRequest,
    user: dict = Depends(get_api_user),
):
    """根据项目上下文创建一个预填充画布。

    这不是会话资源，而是一个无状态工厂接口。
    如果项目里已有相同 preset 的画布，会复用最近更新的那张，避免同一主线入口
    不断生成副本。
    """
    ctx, username, project_name, project_dir, _output_dir = await _resolve_freezone_project(
        project, user
    )
    canvas_project_dir = _canvas_state_project_dir(ctx, project_dir)

    try:
        preset_key = preset_key_for_request(
            scope=body.scope,
            episode=body.episode,
            beat=body.beat,
            primary_slot=body.primary_slot,
            asset_kind=body.asset_kind,
            character=body.character,
            identity_id=body.identity_id,
            asset_id=body.asset_id,
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc

    canonical_canvas_id = canvas_id_for_preset(preset_key)
    overwrite_canvas_id = (
        str(body.canvas_id or "").strip()
        if body.overwrite_existing and str(body.canvas_id or "").strip()
        else ""
    )
    existing = None
    if not overwrite_canvas_id:
        existing = _canonical_preset_canvas(
            canvas_project_dir,
            preset_key=preset_key,
            canvas_id=canonical_canvas_id,
        )
        if existing is None:
            existing = _latest_preset_canvas(canvas_project_dir, preset_key)
    if existing:
        return {
            "ok": True,
            "data": {
                "canvas_id": existing,
                "reused": True,
                "url": f"/?p={project}&canvas={existing}",
            },
        }
    if overwrite_canvas_id:
        existing_payload = canvas_store.read_canvas(canvas_project_dir, overwrite_canvas_id)
        if not isinstance(existing_payload, dict):
            raise HTTPException(404, "canvas not found")
        existing_preset_key = _preset_key_from_canvas_metadata(
            existing_payload.get("metadata")
            if isinstance(existing_payload.get("metadata"), dict)
            else None
        )
        if existing_preset_key != preset_key:
            raise HTTPException(
                400,
                "canvas preset_key does not match requested preset",
            )

    if body.scope == "blank":
        payload = {
            "nodes": [],
            "edges": [],
            "viewport": None,
            "metadata": {
                "preset": {
                    "preset_key": preset_key,
                    "scope": "blank",
                    "created_at": canvas_store.utc_now_iso(),
                }
            },
        }
    elif body.scope == "episode":
        if body.episode is None:
            raise HTTPException(400, "episode preset requires episode")
        store = (
            await make_sqlite_store_for_context(ctx)
            if ctx is not None
            else await make_sqlite_store(username, project_name)
        )
        try:
            context = await build_episode_preset_context(
                project_id=ctx.project_id,
                username=username,
                project=project_name,
                project_dir=project_dir,
                store=store,
                episode=body.episode,
            )
        finally:
            close = getattr(store, "close", None)
            if close:
                await close()
        payload = build_canvas_payload_from_context(
            context=context,
            preset_key=preset_key,
            default_push_target=_default_push_target_for_preset(body),
            created_at=canvas_store.utc_now_iso(),
        )
    elif body.scope == "beat":
        if body.episode is None or body.beat is None:
            raise HTTPException(400, "beat preset requires episode and beat")
        store = (
            await make_sqlite_store_for_context(ctx)
            if ctx is not None
            else await make_sqlite_store(username, project_name)
        )
        try:
            context = await build_beat_preset_context(
                project_id=ctx.project_id,
                username=username,
                project=project_name,
                project_dir=project_dir,
                store=store,
                episode=body.episode,
                beat=body.beat,
                primary_slot=body.primary_slot,
            )
        except ValueError as exc:
            raise HTTPException(404, str(exc)) from exc
        finally:
            close = getattr(store, "close", None)
            if close:
                await close()
        payload = build_canvas_payload_from_context(
            context=context,
            preset_key=preset_key,
            default_push_target=_default_push_target_for_preset(body),
            created_at=canvas_store.utc_now_iso(),
        )
    elif body.scope == "asset":
        if not body.asset_kind:
            raise HTTPException(400, "asset preset requires asset_kind")
        store = (
            await make_sqlite_store_for_context(ctx)
            if ctx is not None
            else await make_sqlite_store(username, project_name)
        )
        try:
            context = await build_asset_preset_context(
                project_id=ctx.project_id,
                username=username,
                project=project_name,
                project_dir=project_dir,
                store=store,
                asset_kind=body.asset_kind,
                character=body.character,
                identity_id=body.identity_id,
                asset_id=body.asset_id,
            )
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        finally:
            close = getattr(store, "close", None)
            if close:
                await close()
        payload = build_canvas_payload_from_context(
            context=context,
            preset_key=preset_key,
            default_push_target=_default_push_target_for_preset(body),
            created_at=canvas_store.utc_now_iso(),
        )
        preset_meta = payload.setdefault("metadata", {}).setdefault("preset", {})
        preset_meta.update(
            {
                "asset_kind": body.asset_kind,
                "character": body.character,
                "identity_id": body.identity_id,
                "asset_id": body.asset_id,
            }
        )
    else:
        raise HTTPException(400, f"unsupported preset scope: {body.scope}")

    incoming_facts_signature = _preset_facts_signature(payload)
    _stamp_preset_facts_signature(payload, incoming_facts_signature)
    canvas_id = overwrite_canvas_id or canonical_canvas_id

    def build_payload(existing_payload: dict | None) -> dict:
        raw_payload = (
            _merge_restored_preset_canvas(payload, existing_payload)
            if overwrite_canvas_id
            else payload
        )
        _stamp_preset_facts_signature(raw_payload, incoming_facts_signature)
        prepared = _prepare_canvas_payload_for_write(
            project_id=project,
            canvas_id=canvas_id,
            body=None,
            raw_payload=raw_payload,
            existing=existing_payload,
            user=user,
        )
        _stamp_canvas_mainline_context_project_id(prepared, project)
        return prepared

    # Plan §10 — replays of the same preset request (network retry, double
    # click) must not bump revision twice or duplicate history entries. Mint
    # a stable client_save_id + request_hash from the preset inputs so the
    # second call hits save_canvas's idempotency cache instead of producing
    # a revision_conflict. We deliberately exclude volatile fields like
    # ``metadata.preset.created_at`` — they're stamped per-call inside
    # ``build_canvas_payload_from_context`` and would otherwise defeat the
    # whole point of the key.
    preset_stable_hash = canvas_store.canvas_request_hash(
        {
            "scope": body.scope,
            "episode": body.episode,
            "beat": body.beat,
            "primary_slot": body.primary_slot,
            "asset_kind": body.asset_kind,
            "character": body.character,
            "identity_id": body.identity_id,
            "asset_id": body.asset_id,
            "canvas_id": overwrite_canvas_id,
            "base_revision": body.base_revision,
        }
    )
    preset_client_save_id = f"from-preset:{canvas_id}:{preset_stable_hash}"

    def skip_if_same_preset_facts(existing_payload: dict | None) -> dict | None:
        if not overwrite_canvas_id:
            return None
        if _preset_facts_signature_from_payload(existing_payload) != incoming_facts_signature:
            return None
        revision = existing_payload.get("revision") if isinstance(existing_payload, dict) else None
        updated_at = (
            existing_payload.get("updated_at") if isinstance(existing_payload, dict) else None
        )
        return {
            "saved": False,
            "revision": revision if isinstance(revision, int) else None,
            "updated_at": updated_at if isinstance(updated_at, str) else None,
            "client_save_id": None,
            "noop_reason": "preset_facts_unchanged",
        }

    try:
        saved_canvas = canvas_store.save_canvas(
            canvas_project_dir,
            canvas_id,
            base_revision=body.base_revision,
            client_save_id=preset_client_save_id,
            request_hash=preset_stable_hash,
            build_payload=build_payload,
            skip_if=skip_if_same_preset_facts,
            enforce_revision=True,
            save_source="from_preset",
            allow_empty_overwrite=True,
        )
    except (
        canvas_store.CanvasBaseRevisionRequired,
        canvas_store.CanvasRevisionConflict,
    ) as exc:
        _append_canvas_event(
            project_dir=canvas_project_dir,
            project_id=project,
            canvas_id=canvas_id,
            event_type="canvas.preset_refresh.conflict",
            actor=_canvas_event_actor(user),
            payload={
                "scope": body.scope,
                "preset_key": preset_key,
                "base_revision": body.base_revision,
                "error": str(exc),
            },
        )
        _raise_canvas_store_http(exc)
    except (canvas_store.CanvasStoreError, CanvasLockBusy) as exc:
        _raise_canvas_store_http(exc)
    payload = saved_canvas.payload
    _append_canvas_event(
        project_dir=canvas_project_dir,
        project_id=project,
        canvas_id=canvas_id,
        event_type="canvas.preset_emitted",
        actor=_canvas_event_actor(user),
        payload={
            "scope": body.scope,
            "preset_key": preset_key,
            "revision": payload.get("revision"),
            "node_count": len(payload.get("nodes") or []),
            "edge_count": len(payload.get("edges") or []),
            "overwrote_existing": bool(overwrite_canvas_id),
            "backup_path": (
                canvas_store.relative_project_path(canvas_project_dir, saved_canvas.backup_path)
                if saved_canvas.backup_path
                else None
            ),
            "preset_facts_unchanged": (
                isinstance(saved_canvas.response_cache, dict)
                and saved_canvas.response_cache.get("noop_reason") == "preset_facts_unchanged"
            ),
        },
    )
    return {
        "ok": True,
        "data": {
            "canvas_id": canvas_id,
            "reused": False,
            "url": f"/?p={project}&canvas={canvas_id}",
        },
    }


@router.post(
    "/projects/{project}/freezone/projections:build-from-preset",
    tags=[TAG_FREEZONE_CANVAS],
)
async def build_projection_from_preset(
    project: str,
    body: ProjectionPresetCanvasRequest,
    user: dict = Depends(get_api_user),
):
    ctx, username, project_name, project_dir, _output_dir = await _resolve_freezone_project(
        project, user
    )
    payload, _preset_key, facts_signature = await _build_projection_payload_for_request(
        ctx=ctx,
        username=username,
        project_name=project_name,
        project_dir=project_dir,
        body=body,
    )
    metadata = payload.get("metadata")
    return {
        "ok": True,
        "data": {
            "projection_key": body.projection_key,
            "facts_signature": facts_signature,
            "nodes": payload.get("nodes") or [],
            "edges": payload.get("edges") or [],
            "metadata": metadata if isinstance(metadata, dict) else None,
        },
    }


@router.post(
    "/projects/{project}/freezone/canvases/{canvas_id}/projections:from-preset",
    tags=[TAG_FREEZONE_CANVAS],
)
async def project_canvas_from_preset(
    project: str,
    canvas_id: str,
    body: ProjectionPresetCanvasRequest,
    user: dict = Depends(get_api_user),
):
    if not CANVAS_ID_RE.match(canvas_id):
        raise HTTPException(400, "invalid canvas_id")
    ctx, username, project_name, project_dir, _output_dir = await _resolve_freezone_project(
        project, user
    )
    canvas_project_dir = _canvas_state_project_dir(ctx, project_dir)

    payload, preset_key, incoming_facts_signature = await _build_projection_payload_for_request(
        ctx=ctx,
        username=username,
        project_name=project_name,
        project_dir=project_dir,
        body=body,
    )

    def skip_if_same_projection_facts(existing_payload: dict | None) -> dict | None:
        if body.force_refresh:
            return None
        if (
            _projection_facts_signature_from_payload(existing_payload, body.projection_key)
            != incoming_facts_signature
        ):
            return None
        revision = existing_payload.get("revision") if isinstance(existing_payload, dict) else None
        updated_at = (
            existing_payload.get("updated_at") if isinstance(existing_payload, dict) else None
        )
        return {
            "saved": False,
            "revision": revision if isinstance(revision, int) else None,
            "updated_at": updated_at if isinstance(updated_at, str) else None,
            "client_save_id": None,
            "noop_reason": "projection_facts_unchanged",
        }

    def build_payload(existing_payload: dict | None) -> dict:
        raw_payload = _merge_projected_preset_canvas(
            incoming_payload=payload,
            existing_payload=existing_payload,
            projection_key=body.projection_key,
        )
        _stamp_projection_metadata(
            raw_payload,
            projection_key=body.projection_key,
            preset_key=preset_key,
            body=body,
            facts_signature=incoming_facts_signature,
        )
        prepared = _prepare_canvas_payload_for_write(
            project_id=project,
            canvas_id=canvas_id,
            body=None,
            raw_payload=raw_payload,
            existing=existing_payload,
            user=user,
        )
        _stamp_canvas_mainline_context_project_id(prepared, project)
        return prepared

    projection_stable_hash = canvas_store.canvas_request_hash(
        {
            "projection_key": body.projection_key,
            "scope": body.scope,
            "episode": body.episode,
            "beat": body.beat,
            "primary_slot": body.primary_slot,
            "asset_kind": body.asset_kind,
            "character": body.character,
            "identity_id": body.identity_id,
            "asset_id": body.asset_id,
            "canvas_id": canvas_id,
            "base_revision": body.base_revision,
            "force_refresh": body.force_refresh,
        }
    )
    projection_client_save_id = f"projection:{canvas_id}:{projection_stable_hash}"

    try:
        saved_canvas = canvas_store.save_canvas(
            canvas_project_dir,
            canvas_id,
            base_revision=body.base_revision,
            client_save_id=projection_client_save_id,
            request_hash=projection_stable_hash,
            build_payload=build_payload,
            skip_if=skip_if_same_projection_facts,
            enforce_revision=True,
            save_source="from_preset",
            allow_empty_overwrite=True,
        )
    except (
        canvas_store.CanvasBaseRevisionRequired,
        canvas_store.CanvasRevisionConflict,
    ) as exc:
        _append_canvas_event(
            project_dir=canvas_project_dir,
            project_id=project,
            canvas_id=canvas_id,
            event_type="canvas.projection_refresh.conflict",
            actor=_canvas_event_actor(user),
            payload={
                "scope": body.scope,
                "preset_key": preset_key,
                "projection_key": body.projection_key,
                "base_revision": body.base_revision,
                "error": str(exc),
            },
        )
        _raise_canvas_store_http(exc)
    except (canvas_store.CanvasStoreError, CanvasLockBusy) as exc:
        _raise_canvas_store_http(exc)

    response_cache = (
        saved_canvas.response_cache if isinstance(saved_canvas.response_cache, dict) else {}
    )
    payload = saved_canvas.payload
    revision = payload.get("revision")
    no_op = response_cache.get("noop_reason") == "projection_facts_unchanged"
    saved = response_cache.get("saved")
    _append_canvas_event(
        project_dir=canvas_project_dir,
        project_id=project,
        canvas_id=canvas_id,
        event_type="canvas.projection_emitted",
        actor=_canvas_event_actor(user),
        payload={
            "scope": body.scope,
            "preset_key": preset_key,
            "projection_key": body.projection_key,
            "revision": revision,
            "node_count": len(payload.get("nodes") or []),
            "edge_count": len(payload.get("edges") or []),
            "backup_path": (
                canvas_store.relative_project_path(canvas_project_dir, saved_canvas.backup_path)
                if saved_canvas.backup_path
                else None
            ),
            "projection_facts_unchanged": no_op,
        },
    )
    return {
        "ok": True,
        "data": {
            "canvas_id": canvas_id,
            "projection_key": body.projection_key,
            "revision": revision if isinstance(revision, int) else None,
            "saved": bool(saved) if isinstance(saved, bool) else True,
            "no_op": no_op,
        },
    }


@router.post(
    "/projects/{project}/freezone/canvases/{canvas_id}/projections:remove",
    tags=[TAG_FREEZONE_CANVAS],
)
async def remove_canvas_projection(
    project: str,
    canvas_id: str,
    body: ProjectionRemoveRequest,
    user: dict = Depends(get_api_user),
):
    if not CANVAS_ID_RE.match(canvas_id):
        raise HTTPException(400, "invalid canvas_id")
    ctx, _username, _project_name, project_dir, _output_dir = await _resolve_freezone_project(
        project, user
    )
    canvas_project_dir = _canvas_state_project_dir(ctx, project_dir)

    def skip_if_projection_missing(existing_payload: dict | None) -> dict | None:
        if not isinstance(existing_payload, dict):
            return None
        metadata = existing_payload.get("metadata") if isinstance(existing_payload, dict) else None
        projections = metadata.get("projections") if isinstance(metadata, dict) else None
        if isinstance(projections, dict) and body.projection_key in projections:
            return None
        revision = existing_payload.get("revision") if isinstance(existing_payload, dict) else None
        updated_at = (
            existing_payload.get("updated_at") if isinstance(existing_payload, dict) else None
        )
        return {
            "saved": False,
            "revision": revision if isinstance(revision, int) else None,
            "updated_at": updated_at if isinstance(updated_at, str) else None,
            "client_save_id": None,
            "noop_reason": "projection_missing",
        }

    def build_payload(existing_payload: dict | None) -> dict:
        if not isinstance(existing_payload, dict):
            raise HTTPException(404, "canvas not found")
        raw_payload = _remove_projected_preset_canvas(
            existing_payload=existing_payload,
            projection_key=body.projection_key,
        )
        prepared = _prepare_canvas_payload_for_write(
            project_id=project,
            canvas_id=canvas_id,
            body=None,
            raw_payload=raw_payload,
            existing=existing_payload,
            user=user,
        )
        _stamp_canvas_mainline_context_project_id(prepared, project)
        return prepared

    remove_stable_hash = canvas_store.canvas_request_hash(
        {
            "projection_key": body.projection_key,
            "canvas_id": canvas_id,
            "base_revision": body.base_revision,
        }
    )
    remove_client_save_id = f"projection-remove:{canvas_id}:{remove_stable_hash}"

    try:
        saved_canvas = canvas_store.save_canvas(
            canvas_project_dir,
            canvas_id,
            base_revision=body.base_revision,
            client_save_id=remove_client_save_id,
            request_hash=remove_stable_hash,
            build_payload=build_payload,
            skip_if=skip_if_projection_missing,
            enforce_revision=True,
            save_source="projection_remove",
            allow_empty_overwrite=True,
        )
    except (
        canvas_store.CanvasBaseRevisionRequired,
        canvas_store.CanvasRevisionConflict,
    ) as exc:
        _append_canvas_event(
            project_dir=canvas_project_dir,
            project_id=project,
            canvas_id=canvas_id,
            event_type="canvas.projection_remove.conflict",
            actor=_canvas_event_actor(user),
            payload={
                "projection_key": body.projection_key,
                "base_revision": body.base_revision,
                "error": str(exc),
            },
        )
        _raise_canvas_store_http(exc)
    except (canvas_store.CanvasStoreError, CanvasLockBusy) as exc:
        _raise_canvas_store_http(exc)

    payload = saved_canvas.payload
    response_cache = (
        saved_canvas.response_cache if isinstance(saved_canvas.response_cache, dict) else {}
    )
    revision = payload.get("revision")
    no_op = response_cache.get("noop_reason") == "projection_missing"
    _append_canvas_event(
        project_dir=canvas_project_dir,
        project_id=project,
        canvas_id=canvas_id,
        event_type="canvas.projection_removed",
        actor=_canvas_event_actor(user),
        payload={
            "projection_key": body.projection_key,
            "revision": revision,
            "node_count": len(payload.get("nodes") or []),
            "edge_count": len(payload.get("edges") or []),
            "projection_missing": no_op,
        },
    )
    return {
        "ok": True,
        "data": {
            "canvas_id": canvas_id,
            "projection_key": body.projection_key,
            "revision": revision if isinstance(revision, int) else None,
            "saved": not no_op,
            "no_op": no_op,
        },
    }


@router.post(
    "/projects/{project}/freezone/canvases/{canvas_id}/projections:status",
    tags=[TAG_FREEZONE_CANVAS],
)
async def projection_status(
    project: str,
    canvas_id: str,
    body: ProjectionStatusRequest,
    user: dict = Depends(get_api_user),
):
    if not CANVAS_ID_RE.match(canvas_id):
        raise HTTPException(400, "invalid canvas_id")
    ctx, username, project_name, project_dir, _output_dir = await _resolve_freezone_project(
        project, user, required_role="viewer"
    )
    canvas_project_dir = _canvas_state_project_dir(ctx, project_dir)
    existing = canvas_store.read_canvas(canvas_project_dir, canvas_id)
    if not isinstance(existing, dict):
        raise HTTPException(404, "canvas not found")
    metadata = existing.get("metadata")
    projections = metadata.get("projections") if isinstance(metadata, dict) else None
    if not isinstance(projections, dict):
        return {
            "ok": True,
            "data": {
                "canvas_id": canvas_id,
                "revision": existing.get("revision"),
                "projections": [],
            },
        }

    requested_keys = set(body.projection_keys or [])
    keys = [
        key
        for key in sorted(projections.keys())
        if isinstance(key, str) and (not requested_keys or key in requested_keys)
    ]
    statuses: list[dict] = []
    for projection_key in keys:
        projection = projections.get(projection_key)
        if not isinstance(projection, dict):
            continue
        request = projection.get("request")
        if not isinstance(request, dict):
            continue
        try:
            request_body = ProjectionPresetCanvasRequest(
                **{**request, "projection_key": projection_key, "base_revision": 0}
            )
            preset_key = preset_key_for_request(
                scope=request_body.scope,
                episode=request_body.episode,
                beat=request_body.beat,
                primary_slot=request_body.primary_slot,
                asset_kind=request_body.asset_kind,
                character=request_body.character,
                identity_id=request_body.identity_id,
                asset_id=request_body.asset_id,
            )
            payload = await _build_canvas_payload_for_preset_request(
                ctx=ctx,
                username=username,
                project_name=project_name,
                project_dir=project_dir,
                body=request_body,
                preset_key=preset_key,
            )
            _stamp_projection_key(payload, projection_key)
            _wrap_projection_payload_in_group(
                payload,
                projection_key=projection_key,
                label=_projection_group_label(request_body),
            )
            current_signature = _preset_facts_signature(payload)
        except Exception as exc:
            statuses.append(
                {
                    "projection_key": projection_key,
                    "stale": False,
                    "error": str(exc),
                }
            )
            continue
        stored_signature = projection.get("facts_signature")
        stored_signature = stored_signature if isinstance(stored_signature, str) else ""
        statuses.append(
            {
                "projection_key": projection_key,
                "scope": request_body.scope,
                "episode": request_body.episode,
                "beat": request_body.beat,
                "asset_kind": request_body.asset_kind,
                "asset_id": request_body.asset_id,
                "stored_facts_signature": stored_signature,
                "current_facts_signature": current_signature,
                "stale": stored_signature != current_signature,
            }
        )

    return {
        "ok": True,
        "data": {
            "canvas_id": canvas_id,
            "revision": existing.get("revision"),
            "projections": statuses,
        },
    }


@router.get("/projects/{project}/freezone/canvases", tags=[TAG_FREEZONE_CANVAS])
async def list_canvases(project: str, user: dict = Depends(get_api_user)):
    ctx, _username, _project_name, project_dir, _output_dir = await _resolve_freezone_project(
        project, user, required_role="viewer"
    )
    canvas_project_dir = _canvas_state_project_dir(ctx, project_dir)
    try:
        canvas_store.ensure_default_canvas(
            canvas_project_dir,
            project_id=ctx.project_id,
            actor_id=_canvas_actor_id(user),
        )
        return {"ok": True, "data": canvas_store.list_canvases(canvas_project_dir)}
    except (canvas_store.CanvasStoreError, CanvasLockBusy) as exc:
        _raise_canvas_store_http(exc)


@router.get("/projects/{project}/freezone/canvases/{canvas_id}", tags=[TAG_FREEZONE_CANVAS])
async def get_canvas(project: str, canvas_id: str, user: dict = Depends(get_api_user)):
    if not CANVAS_ID_RE.match(canvas_id):
        raise HTTPException(400, "invalid canvas_id")
    ctx, username, project_name, project_dir, _output_dir = await _resolve_freezone_project(
        project, user, required_role="viewer"
    )
    canvas_project_dir = _canvas_state_project_dir(ctx, project_dir)
    try:
        if canvas_id == "default":
            canvas_store.ensure_default_canvas(
                canvas_project_dir,
                project_id=ctx.project_id,
                actor_id=_canvas_actor_id(user),
            )
        payload = canvas_store.read_canvas(canvas_project_dir, canvas_id)
    except (canvas_store.CanvasStoreError, CanvasLockBusy) as exc:
        _raise_canvas_store_http(exc)
    if payload is None:
        return {
            "ok": True,
            "data": {"nodes": [], "edges": [], "viewport": None},
        }
    refreshed_payload = await _refresh_preset_canvas_payload_on_read(
        ctx=ctx,
        username=username,
        project_name=project_name,
        project_dir=project_dir,
        payload=payload,
    )
    migrated_payload = migrate_canvas_static_urls_in_memory(
        refreshed_payload or {"nodes": [], "edges": []},
        project_id=ctx.project_id,
        owner_username=ctx.owner_username,
        project_name=ctx.project_name,
        project_dir=project_dir,
    )
    return {"ok": True, "data": migrated_payload or {"nodes": [], "edges": []}}


@router.get(
    "/projects/{project}/freezone/canvases/{canvas_id}/history",
    tags=[TAG_FREEZONE_CANVAS],
)
async def list_canvas_history(
    project: str,
    canvas_id: str,
    user: dict = Depends(get_api_user),
):
    if not CANVAS_ID_RE.match(canvas_id):
        raise HTTPException(400, "invalid canvas_id")
    ctx, _username, _project_name, project_dir, _output_dir = await _resolve_freezone_project(
        project, user, required_role="viewer"
    )
    canvas_project_dir = _canvas_state_project_dir(ctx, project_dir)
    try:
        return {"ok": True, "data": canvas_store.list_canvas_history(canvas_project_dir, canvas_id)}
    except canvas_store.CanvasStoreError as exc:
        _raise_canvas_store_http(exc)


@router.post(
    "/projects/{project}/freezone/canvases/{canvas_id}/restore",
    tags=[TAG_FREEZONE_CANVAS],
)
async def restore_canvas_history(
    project: str,
    canvas_id: str,
    body: dict = Body(...),
    user: dict = Depends(get_api_user),
):
    if not CANVAS_ID_RE.match(canvas_id):
        raise HTTPException(400, "invalid canvas_id")
    history_id = str(body.get("history_id") or "").strip()
    base_revision = body.get("base_revision")
    ctx, _username, _project_name, project_dir, _output_dir = await _resolve_freezone_project(
        project, user
    )
    canvas_project_dir = _canvas_state_project_dir(ctx, project_dir)

    def build_payload(existing: dict | None, history_payload: dict) -> dict:
        prepared = _prepare_canvas_payload_for_write(
            project_id=project,
            canvas_id=canvas_id,
            body=None,
            raw_payload=history_payload,
            existing=existing,
            user=user,
        )
        _stamp_canvas_mainline_context_project_id(prepared, project)
        return prepared

    try:
        restored_canvas = canvas_store.restore_canvas_version(
            canvas_project_dir,
            canvas_id,
            history_id=history_id,
            base_revision=base_revision,
            build_payload=build_payload,
        )
    except (canvas_store.CanvasStoreError, CanvasLockBusy) as exc:
        _raise_canvas_store_http(exc)
    payload = restored_canvas.payload
    restored_from_revision = restored_canvas.history_payload.get("revision")
    _append_canvas_event(
        project_dir=canvas_project_dir,
        project_id=project,
        canvas_id=canvas_id,
        event_type="canvas.restored",
        actor=_canvas_event_actor(user),
        payload={
            "revision": payload.get("revision"),
            "base_revision": base_revision,
            "restored_from_revision": restored_from_revision,
            "history_id": history_id,
            "node_count": len(payload.get("nodes") or []),
            "edge_count": len(payload.get("edges") or []),
            "backup_path": canvas_store.relative_project_path(
                canvas_project_dir,
                restored_canvas.backup_path,
            ),
        },
    )
    return {
        "ok": True,
        "data": {
            "restored": True,
            "revision": payload["revision"],
            "restored_from_revision": restored_from_revision,
        },
    }


@router.get(
    "/projects/{project}/freezone/canvases/{canvas_id}/nodes/{node_id}/generation-history",
    tags=[TAG_FREEZONE_CANVAS],
)
async def get_node_generation_history(
    project: str,
    canvas_id: str,
    node_id: str,
    limit: int = Query(100, ge=1, le=500),
    user: dict = Depends(get_api_user),
):
    """Return backend-side generation attempts recorded for one canvas node."""
    if not CANVAS_ID_RE.match(canvas_id):
        raise HTTPException(400, "invalid canvas_id")
    ctx, _username, _project_name, project_dir, _output_dir = await _resolve_freezone_project(
        project,
        user,
        required_role="viewer",
    )
    try:
        records = read_generation_history(
            project_dir=project_dir,
            canvas_id=canvas_id,
            node_id=node_id,
            limit=limit,
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    records = [
        sanitize_project_local_paths_in_memory(
            migrate_canvas_static_urls_in_memory(
                record,
                project_id=ctx.project_id,
                owner_username=ctx.owner_username,
                project_name=ctx.project_name,
                project_dir=project_dir,
            )
            or record,
            project_id=ctx.project_id,
            project_dir=project_dir,
        )
        or record
        for record in records
    ]
    return {"ok": True, "data": {"records": records}}


@router.get(
    "/projects/{project}/freezone/canvases/{canvas_id}/generation-history",
    tags=[TAG_FREEZONE_CANVAS],
)
async def get_canvas_generation_history(
    project: str,
    canvas_id: str,
    limit: int = Query(500, ge=1, le=2000),
    user: dict = Depends(get_api_user),
):
    """Return every node's recorded generation attempts for a whole canvas.

    Aggregates across all nodes (newest first), including nodes that were deleted
    from the canvas — their history files persist, so their past attempts stay
    recoverable in the history browser.
    """
    if not CANVAS_ID_RE.match(canvas_id):
        raise HTTPException(400, "invalid canvas_id")
    ctx, _username, _project_name, project_dir, _output_dir = await _resolve_freezone_project(
        project,
        user,
        required_role="viewer",
    )
    try:
        records = read_canvas_generation_history(
            project_dir=project_dir,
            canvas_id=canvas_id,
            limit=limit,
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    records = [
        sanitize_project_local_paths_in_memory(
            migrate_canvas_static_urls_in_memory(
                record,
                project_id=ctx.project_id,
                owner_username=ctx.owner_username,
                project_name=ctx.project_name,
                project_dir=project_dir,
            )
            or record,
            project_id=ctx.project_id,
            project_dir=project_dir,
        )
        or record
        for record in records
    ]
    return {"ok": True, "data": {"records": records}}


@router.put("/projects/{project}/freezone/canvases/{canvas_id}", tags=[TAG_FREEZONE_CANVAS])
async def put_canvas(
    project: str,
    canvas_id: str,
    body: CanvasPayload,
    user: dict = Depends(get_api_user),
):
    if not CANVAS_ID_RE.match(canvas_id):
        raise HTTPException(400, "invalid canvas_id")
    ctx, _username, _project_name, project_dir, _output_dir = await _resolve_freezone_project(
        project, user
    )
    canvas_project_dir = _canvas_state_project_dir(ctx, project_dir)

    def build_payload(existing: dict | None) -> dict:
        prepared = _prepare_canvas_payload_for_write(
            project_id=project,
            canvas_id=canvas_id,
            body=body,
            existing=existing,
            user=user,
        )
        _stamp_canvas_mainline_context_project_id(prepared, project)
        return prepared

    try:
        saved_canvas = canvas_store.save_canvas(
            canvas_project_dir,
            canvas_id,
            base_revision=body.base_revision,
            build_payload=build_payload,
            client_save_id=body.client_save_id,
            request_hash=canvas_store.canvas_request_hash(
                body.model_dump(
                    exclude={"client_save_id"},
                    exclude_none=True,
                )
            ),
            save_source=body.save_source,
            allow_empty_overwrite=body.allow_empty_overwrite,
        )
    except (canvas_store.CanvasStoreError, CanvasLockBusy) as exc:
        _raise_canvas_store_http(exc)
    payload = saved_canvas.payload
    if not saved_canvas.idempotent:
        _append_canvas_event(
            project_dir=canvas_project_dir,
            project_id=project,
            canvas_id=canvas_id,
            event_type="canvas.saved",
            actor=_canvas_event_actor(user),
            payload={
                "revision": payload.get("revision"),
                "base_revision": body.base_revision,
                "node_count": len(payload.get("nodes") or []),
                "edge_count": len(payload.get("edges") or []),
                "client_save_id": body.client_save_id,
                "save_source": body.save_source,
                "backup_path": canvas_store.relative_project_path(
                    canvas_project_dir,
                    saved_canvas.backup_path,
                ),
            },
        )
    response_data = saved_canvas.response_cache or {
        "saved": True,
        "revision": payload.get("revision"),
        "updated_at": payload.get("updated_at"),
        "client_save_id": body.client_save_id,
    }
    return {"ok": True, "data": response_data}


@router.delete("/projects/{project}/freezone/canvases/{canvas_id}", tags=[TAG_FREEZONE_CANVAS])
async def delete_canvas(project: str, canvas_id: str, user: dict = Depends(get_api_user)):
    if not CANVAS_ID_RE.match(canvas_id):
        raise HTTPException(400, "invalid canvas_id")
    ctx, _username, _project_name, project_dir, _output_dir = await _resolve_freezone_project(
        project, user
    )
    canvas_project_dir = _canvas_state_project_dir(ctx, project_dir)
    try:
        deleted_canvas = canvas_store.soft_delete_canvas(
            canvas_project_dir,
            canvas_id,
            deleted_by=_canvas_actor_id(user),
        )
    except (canvas_store.CanvasStoreError, CanvasLockBusy) as exc:
        _raise_canvas_store_http(exc)
    existing = deleted_canvas.existing
    _append_canvas_event(
        project_dir=canvas_project_dir,
        project_id=project,
        canvas_id=canvas_id,
        event_type="canvas.deleted",
        actor=_canvas_event_actor(user),
        payload={
            "revision": existing.get("revision") if isinstance(existing, dict) else None,
            "deleted_path": canvas_store.relative_project_path(
                canvas_project_dir,
                deleted_canvas.deleted_path,
            ),
        },
    )
    return {"ok": True, "data": {"deleted": True}}


# ============================================================
# Commit 到 canonical slot（Freezone → Slot）
# ============================================================


def _asset_record_from_path(
    *,
    username: str,
    project: str,
    project_dir: Path,
    project_id: str,
    tab: str,
    kind: str,
    role: str,
    label: str,
    abs_path: Path,
    sublabel: str = "",
    aspect_ratio: str = "1:1",
    meta: dict | None = None,
) -> dict:
    rel_path = abs_path.relative_to(project_dir).as_posix()
    exists = abs_path.exists()
    suffix = abs_path.suffix.lower()
    if suffix in {".png", ".jpg", ".jpeg", ".webp"}:
        media_type = "image"
    elif suffix in {".mp4", ".mov", ".webm"}:
        media_type = "video"
    elif suffix in {".mp3", ".m4a", ".wav", ".aac", ".flac", ".ogg"}:
        media_type = "audio"
    elif suffix in {".json", ".txt", ".md"}:
        media_type = "text"
    else:
        media_type = "file"
    if exists and not project_id:
        raise ValueError("project_id is required for freezone asset static URLs")
    url = project_static_url(project_id, rel_path, local_path=abs_path) if exists else None
    slot_target = _slot_target_for_asset_record(kind=kind, role=role, meta=meta or {})
    record = {
        "id": f"{kind}:{role}:{rel_path}",
        "tab": tab,
        "kind": kind,
        "role": role,
        "label": label,
        "sublabel": sublabel,
        "rel_path": rel_path,
        "url": url,
        "exists": exists,
        "media_type": media_type,
        "aspect_ratio": aspect_ratio,
        "meta": meta or {},
    }
    if slot_target is not None:
        record["slot_target"] = slot_target
        record["pushable"] = bool(exists)
    director_control_bundle = _director_control_bundle_from_combined_ref(
        role=role,
        rel_path=rel_path,
        url=url,
    )
    if director_control_bundle is not None:
        record["director_control_bundle"] = director_control_bundle
    contexts = _mainline_context_for_asset_record(
        project_id=project_id,
        kind=kind,
        role=role,
        label=label,
        source_url=url,
        meta=meta or {},
    )
    if contexts:
        record["mainline_context"] = contexts
    history_links = _character_asset_history_links(project_id, role, meta or {})
    if history_links is not None:
        record.update(history_links)
    return record


def _asset_record_from_optional_project_path(
    *,
    username: str,
    project: str,
    project_dir: Path,
    project_id: str,
    tab: str,
    kind: str,
    role: str,
    label: str,
    stored_path: str,
    sublabel: str = "",
    aspect_ratio: str = "1:1",
    meta: dict | None = None,
) -> dict | None:
    raw = str(stored_path or "").strip()
    if not raw:
        return None
    abs_path = Path(raw)
    if not abs_path.is_absolute():
        abs_path = project_dir / raw
    try:
        abs_path.relative_to(project_dir)
    except ValueError:
        return None
    return _asset_record_from_path(
        username=username,
        project=project,
        project_dir=project_dir,
        project_id=project_id,
        tab=tab,
        kind=kind,
        role=role,
        label=label,
        sublabel=sublabel,
        abs_path=abs_path,
        aspect_ratio=aspect_ratio,
        meta=meta,
    )


def _character_asset_history_links(project_id: str, role: str, meta: dict) -> dict | None:
    character = str(meta.get("character") or "").strip()
    if not character:
        return None

    asset_kind = ""
    if role == "character_identity":
        asset_kind = "identity"
    elif role == "identity_costume":
        asset_kind = "identity_costume"
    elif role == "identity_portrait":
        asset_kind = "identity_portrait"
    elif role in {"character_portrait", "character_reference"}:
        asset_kind = "portrait"
    if not asset_kind:
        return None

    query = {"kind": asset_kind}
    identity_id = str(meta.get("identity_id") or "").strip()
    if asset_kind != "portrait":
        if not identity_id:
            return None
        query["identity_id"] = identity_id

    base = f"/api/v1/projects/{quote(project_id, safe='')}/characters/{quote(character, safe='')}"
    return {
        "history_url": f"{base}/asset-history?{urlencode(query)}",
        "restore_url": f"{base}/asset-history/restore",
    }


def _compact_mainline_context(data: dict) -> dict:
    return {key: value for key, value in data.items() if value not in (None, "", [])}


def _slot_target_for_asset_record(*, kind: str, role: str, meta: dict) -> dict | None:
    episode = meta.get("episode")
    beat = meta.get("beat")
    if role == "current_sketch" and episode and beat:
        return {"kind": "sketch", "episode": episode, "beat": beat}
    if role == "current_frame" and episode and beat:
        return {"kind": "frame", "episode": episode, "beat": beat}
    if role == "director_combined" and episode and beat:
        return {"kind": "director_render", "episode": episode, "beat": beat}
    if role == "current_video" and episode and beat:
        return {"kind": "video", "episode": episode, "beat": beat}
    if role == "current_audio" and episode and beat:
        return {"kind": "beat_audio", "episode": episode, "beat": beat}

    character = meta.get("character")
    identity_id = meta.get("identity_id")
    if role == "character_identity" and character and identity_id:
        return {"kind": "identity", "character": character, "identity_id": identity_id}
    if role == "identity_costume" and character and identity_id:
        return {"kind": "identity_costume", "character": character, "identity_id": identity_id}
    if role == "identity_portrait" and character and identity_id:
        return {"kind": "identity_portrait", "character": character, "identity_id": identity_id}
    if role in {"character_portrait", "character_reference"} and character:
        return {"kind": "portrait", "character": character}

    prop_id = meta.get("prop_id")
    if (kind == "prop" or role.startswith("prop_")) and prop_id:
        return {"kind": "prop_ref", "prop_id": prop_id}

    scene_id = meta.get("scene_id") or meta.get("scene")
    if (
        role
        in {
            "scene_master",
            "scene_360",
            "scene_reverse_master",
            "scene_spatial_layout",
            "scene_director_pano_360",
            "scene_3gs_active_ply",
            "scene_3gs_master_ply",
            "scene_3gs_reverse_ply",
            "scene_3gs_pano_ply",
            "scene_3gs_custom_scene",
            "scene_3gs_collision_glb",
        }
        and scene_id
    ):
        return {"kind": role, "scene_id": scene_id}

    return None


def _mainline_context_for_asset_record(
    *,
    project_id: str,
    kind: str,
    role: str,
    label: str,
    source_url: str | None,
    meta: dict,
) -> list[dict]:
    def base(context_kind: str, **extra) -> dict:
        return _compact_mainline_context(
            {
                "kind": context_kind,
                "projectId": project_id,
                "episode": meta.get("episode"),
                "beat": meta.get("beat"),
                "character": meta.get("character"),
                "identityId": meta.get("identity_id"),
                "sceneId": meta.get("scene_id") or meta.get("scene"),
                "propId": meta.get("prop_id"),
                "voiceId": meta.get("voice_id") or meta.get("slot"),
                "markerColor": meta.get("marker_color"),
                "visualDescription": meta.get("visual_description"),
                "narrationSegment": meta.get("narration_segment"),
                "detectedIdentities": meta.get("detected_identities"),
                "detectedProps": meta.get("detected_props"),
                "sketchColors": meta.get("sketch_colors"),
                "propMarkerColors": meta.get("prop_marker_colors"),
                "role": role,
                "label": label,
                "sourceUrl": source_url,
                **extra,
            }
        )

    if role in {
        "character_identity",
        "character_portrait",
        "identity_portrait",
        "identity_costume",
    }:
        return [base("identity")]
    if role in {"character_voice", "character_age_group_voice", "identity_voice"}:
        return [base("voice", audioRole="character_voice")]
    if kind == "scene" or role.startswith("scene_"):
        return [base("scene", plyKind=meta.get("ply_kind"))]
    if kind == "prop" or role.startswith("prop_"):
        return [base("prop")]
    if role == "current_sketch":
        return [base("sketch")]
    if role == "current_frame":
        return [base("frame")]
    if role == "current_video":
        return [base("video")]
    if role == "current_audio":
        return [base("audio", audioRole="beat_audio")]
    if role == "director_combined":
        return [base("director_combined")]
    if role == "selected_background":
        return [base("selected_background")]
    return []


def _tab_for_beat_context_ref(kind: str, role: str) -> str:
    if kind == "director":
        return "director"
    if kind in {"identity", "portrait"} or role.startswith("character_"):
        return "characters"
    if kind == "scene" or role.startswith("scene_"):
        return "scenes"
    if kind == "prop" or role.startswith("prop_"):
        return "props"
    return "beat"


def _is_beat_director_control_path(rel_path: str) -> bool:
    normalized = str(rel_path or "")
    return normalized.startswith("director_control_frames/ep") or normalized.startswith(
        "freezone/director_control_frames/ep"
    )


def _is_mainline_beat_director_control_ref(role: str, rel_path: str) -> bool:
    if role != "director_combined":
        return False
    normalized = str(rel_path or "")
    return _is_beat_director_control_path(normalized) and normalized.endswith("/combined.png")


def _director_control_bundle_from_combined_ref(
    *,
    role: str,
    rel_path: str | None,
    url: str | None,
) -> dict | None:
    if role != "director_combined":
        return None
    rel = str(rel_path or "").strip()
    combined_url = str(url or "").strip()
    combined_url_path = combined_url.split("?", 1)[0]
    if not rel.endswith("/combined.png") or not combined_url_path.endswith("/combined.png"):
        return None
    rel_base = rel[: -len("/combined.png")]
    url_base = combined_url_path[: -len("/combined.png")]
    return {
        "schema_version": "director_control_bundle_v1",
        "rel_paths": {
            "combined": f"{rel_base}/combined.png",
            "env_only": f"{rel_base}/env_only.png",
            "frame_meta": f"{rel_base}/frame_meta.json",
        },
        "urls": {
            "combined": f"{url_base}/combined.png",
            "env_only": f"{url_base}/env_only.png",
            "frame_meta": f"{url_base}/frame_meta.json",
        },
    }


def _is_mainline_beat_selected_background_ref(role: str, rel_path: str) -> bool:
    if role != "selected_background":
        return False
    normalized = str(rel_path or "")
    return _is_beat_director_control_path(normalized) and normalized.endswith(
        "/selected_background.png"
    )


def _is_beat_context_metadata_ref(kind: str, role: str, rel_path: str) -> bool:
    if role == "director_blocking":
        return True
    if role == "director_color_ref":
        return True
    if rel_path.startswith("director_blockings/"):
        return True
    return kind == "director" and rel_path.endswith(".json")


def _beat_context_asset_from_ref(
    *,
    ref: dict,
    project_id: str,
    episode: int,
    beat: int,
    beat_facts: dict | None = None,
) -> dict | None:
    rel_path = str(ref.get("rel_path") or "")
    kind = str(ref.get("kind") or "reference")
    role = str(ref.get("role") or "reference")
    if rel_path.startswith("freezone/") and not (
        _is_mainline_beat_director_control_ref(role, rel_path)
        or _is_mainline_beat_selected_background_ref(role, rel_path)
    ):
        return None
    if _is_beat_director_control_path(rel_path) and not (
        _is_mainline_beat_director_control_ref(role, rel_path)
        or _is_mainline_beat_selected_background_ref(role, rel_path)
    ):
        return None
    url = ref.get("url")
    exists = bool(ref.get("exists"))
    if _is_beat_context_metadata_ref(kind, role, rel_path):
        return None
    if role not in {
        "current_sketch",
        "current_frame",
        "current_video",
        "current_audio",
        "director_combined",
        "selected_background",
    }:
        return None
    label = str(ref.get("label") or role or kind)
    meta = ref.get("meta") if isinstance(ref.get("meta"), dict) else {}
    merged_meta = {
        **meta,
        **(beat_facts or {}),
        "episode": int(episode),
        "beat": int(beat),
    }
    record = {
        "id": f"beat:{int(episode):03d}:{int(beat):03d}:{kind}:{role}:{rel_path or label}",
        "tab": _tab_for_beat_context_ref(kind, role),
        "kind": kind,
        "role": role,
        "label": label,
        "sublabel": f"EP{int(episode)} / Beat {int(beat)}",
        "rel_path": rel_path or None,
        "url": url if exists else None,
        "exists": exists,
        "media_type": str(ref.get("media_type") or "image"),
        "aspect_ratio": str(ref.get("aspect_ratio") or "1:1"),
        "meta": merged_meta,
    }
    slot_target = _slot_target_for_asset_record(kind=kind, role=role, meta=merged_meta)
    if slot_target is not None:
        record["slot_target"] = slot_target
        record["pushable"] = bool(exists)
    director_control_bundle = _director_control_bundle_from_combined_ref(
        role=role,
        rel_path=rel_path,
        url=url if exists else None,
    )
    if director_control_bundle is not None:
        record["director_control_bundle"] = director_control_bundle
    contexts = _mainline_context_for_asset_record(
        project_id=project_id,
        kind=kind,
        role=role,
        label=label,
        source_url=url if exists else None,
        meta=merged_meta,
    )
    if contexts:
        record["mainline_context"] = contexts
    return record


def _is_freezone_scene_library_role(role: str) -> bool:
    """Return whether a scene role should be exposed by /freezone/assets.

    This mirrors Assets > Scenes: concrete master/reverse/pano images and
    concrete 3D source packages are library assets. Deprecated sketch-pano
    slots, active aliases, and collision helpers stay internal.
    """

    return role in {
        "scene_master",
        "scene_reverse_master",
        "scene_director_pano_360",
        "scene_3gs_master_ply",
        "scene_3gs_reverse_ply",
        "scene_3gs_pano_ply",
        "scene_3gs_custom_scene",
    }


DIRECTOR_CAPTURE_FILES: tuple[tuple[str, str, str], ...] = (
    ("combined.png", "director_combined", "3GS 导演合成图"),
    ("selected_background.png", "selected_background", "selected background"),
    ("env_only.png", "director_env", "3GS environment plate"),
    ("env_actor_only.png", "director_env_actor", "3GS actor blocking plate"),
    ("actor_overlay_black.png", "actor_overlay", "actor overlay"),
    ("actor_mask.png", "actor_mask", "actor mask"),
    ("prop_staging_overlay.png", "prop_staging_overlay", "prop/staging overlay"),
    ("prop_staging_mask.png", "prop_staging_mask", "prop/staging mask"),
    ("frame_meta.json", "frame_meta", "3GS frame metadata"),
)


def _freezone_director_control_frames_dir(project_dir: Path) -> Path:
    return freezone_root(project_dir) / "director_control_frames"


def _freezone_director_capture_base(project_dir: Path, episode: int, beat: int) -> tuple[Path, str]:
    ep_dir = f"ep{int(episode):03d}"
    beat_dir = f"beat_{int(beat):02d}"
    base_dir = _freezone_director_control_frames_dir(project_dir) / ep_dir / beat_dir
    return base_dir, base_dir.relative_to(project_dir).as_posix()


def _director_capture_file_payload(
    *,
    ctx: ProjectContext,
    project_dir: Path,
    episode: int,
    beat: int,
) -> list[dict]:
    base_dir, base_rel = _freezone_director_capture_base(project_dir, episode, beat)
    out: list[dict] = []
    for filename, role, label in DIRECTOR_CAPTURE_FILES:
        rel_path = f"{base_rel}/{filename}"
        path = base_dir / filename
        exists = path.exists()
        out.append(
            {
                "filename": filename,
                "role": role,
                "label": label,
                "rel_path": rel_path,
                "exists": exists,
                "url": (
                    make_static_url_for_context(ctx, rel_path, local_path=path) if exists else None
                ),
                "media_type": (
                    "image"
                    if Path(filename).suffix.lower() in {".png", ".jpg", ".jpeg", ".webp"}
                    else "json"
                ),
                "size": path.stat().st_size if exists else 0,
                "modified_at": (
                    canvas_store.timestamp_utc_iso(path.stat().st_mtime) if exists else None
                ),
            }
        )
    return out


async def _beat_for_capture(
    username: str,
    project: str,
    episode: int,
    beat: int,
    ctx: ProjectContext | None = None,
) -> dict:
    store = (
        await make_sqlite_store_for_context(ctx)
        if ctx
        else await make_sqlite_store(username, project)
    )
    try:
        beats = await store.get_beats_as_dicts(episode)
    finally:
        close = getattr(store, "close", None)
        if close:
            await close()
    target = next((b for b in beats if int(b.get("beat_number") or -1) == int(beat)), None)
    if not target:
        raise HTTPException(404, f"beat not found: ep{episode} beat{beat}")
    return target


async def _persist_freezone_selected_background_scene_ref(
    *,
    ctx: ProjectContext,
    episode: int,
    beat: int,
) -> None:
    """Mark a Freezone-committed image as the Beat's render background slot."""
    store = await make_sqlite_store_for_context(ctx)
    try:
        beats = await store.get_beats_as_dicts(int(episode))
        target = next(
            (item for item in beats if int(item.get("beat_number") or 0) == int(beat)),
            None,
        )
        if not target:
            raise HTTPException(404, f"beat not found: ep{episode} beat{beat}")

        scene_ref = dict(target.get("scene_ref") or {})
        scene_id = beat_scene_id(target)
        if scene_id:
            scene_ref["scene_id"] = scene_id
        scene_ref["render_anchor_id"] = "selected_background"
        scene_ref["render_anchor_source_id"] = "freezone_commit"
        scene_ref.pop("render_anchor_path", None)
        await store.update_beat_asset(
            episode_number=int(episode),
            beat_number=int(beat),
            scene_ref=scene_ref,
        )
    finally:
        close = getattr(store, "close", None)
        if close:
            await close()


@router.post("/projects/{project}/freezone/impact", tags=[TAG_FREEZONE_COMMIT])
async def freezone_impact(
    project: str,
    body: ImpactRequest,
    user: dict = Depends(get_api_user),
):
    ctx, username, project_name, _project_dir, _output_dir = await _resolve_freezone_project(
        project, user, required_role="viewer"
    )
    impacted = await compute_slot_impact(username, project_name, body.target)
    return {
        "ok": True,
        "data": {
            "target": body.target.model_dump(),
            "affected_beats": impacted,
            "affected_count": len(impacted),
        },
    }


def _sync_env_only_to_selected_background(project_dir: Path, episode: int, beat: int) -> bool:
    """Lazy mirror env_only.png → selected_background.png if env_only is newer.

    Why mirror at all:
      PlayCanvas editor writes env_only.png / actor_overlay_black.png /
      actor_mask.png / combined.png directly via /@fs proxy when the user
      exports. There is no SuperTale write route to hook into, so we cannot
      guarantee selected_background.png is updated at write time without
      touching PlayCanvas.

    Trigger:
      Called from the explicit POST sync route (NOT GET manifest — GET must
      stay side-effect-free per REST hygiene + "Push is canonical write
      boundary" architectural rule).

    Cost: 2 stat() calls + (when stale) one file copy. Idempotent — if mtimes
    already match, no copy. Returns True when a copy actually happened.
    Failure is silent (logged) — never block the calling route.
    """
    try:
        env_only_path = canonical_beat_director_env_only_path(project_dir, int(episode), int(beat))
        if not env_only_path.is_file():
            return False
        selected_path = canonical_beat_selected_background_path(
            project_dir, int(episode), int(beat)
        )
        env_mtime = env_only_path.stat().st_mtime
        # If selected_background.png doesn't exist OR env_only is newer, mirror it.
        if not selected_path.exists() or env_mtime > selected_path.stat().st_mtime:
            selected_path.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(env_only_path, selected_path)
            # Preserve mtime so the next check sees them as in-sync.
            os.utime(selected_path, (env_mtime, env_mtime))
            logger.info(
                "[director-capture] mirrored env_only → selected_background ep=%s beat=%s",
                episode,
                beat,
            )
            return True
        return False
    except Exception as exc:  # noqa: BLE001 — never block calling route
        logger.warning("[director-capture] env_only mirror failed: %s", exc)
        return False


@router.get("/projects/{project}/freezone/director-capture", tags=[TAG_FREEZONE_ASSETS])
async def freezone_director_capture_manifest(
    project: str,
    episode: int,
    beat: int,
    canvas_id: Optional[str] = None,
    node_id: Optional[str] = None,
    user: dict = Depends(get_api_user),
):
    """返回某个 beat 当前的 3GS director capture 状态。

    这是 Freezone 和 PlayCanvas 3GS 导演台之间的桥接接口：
    调用方可以先打开 `editor_url`，在导演台里导出控制帧，
    然后再次调用这个接口，把导出的文件转成画布节点使用。

    Pure read — no side effects. Callers that need the env_only.png →
    selected_background.png mirror (e.g. frontend right after the user
    returns from director stage) should POST
    `/projects/{project}/freezone/director-capture/sync-background` first.
    """
    ctx, username, project_name, project_dir, _output_dir = await _resolve_freezone_project(
        project, user, required_role="viewer"
    )
    beat_data = await _beat_for_capture(
        username,
        project_name,
        int(episode),
        int(beat),
        ctx=ctx,
    )
    scene_name = beat_scene_id(beat_data)
    files = _director_capture_file_payload(
        ctx=ctx,
        project_dir=project_dir,
        episode=int(episode),
        beat=int(beat),
    )
    editor_url = None
    can_open_stage = False
    if scene_name:
        try:
            service = DirectorWorldService(project_dir)
            editor_url = service.make_3gs_editor_url(
                episode=int(episode),
                scene_id=scene_name,
                slate_beat=int(beat),
                user=username,
                project=project_name,
                control_frames_dir=_freezone_director_control_frames_dir(project_dir),
            )
            if editor_url:
                extra = {
                    "freezone_project": project,
                    "freezone_canvas": canvas_id or "",
                    "freezone_capture_node": node_id or "director_capture",
                    "return_to_freezone": "1",
                }
                separator = "&" if "?" in editor_url else "?"
                editor_url = f"{editor_url}{separator}{urlencode(extra)}"
                can_open_stage = True
        except Exception as exc:
            logger.warning("failed to build 3GS director stage url: %s", exc)

    return {
        "ok": True,
        "data": {
            "project": project,
            "episode": int(episode),
            "beat": int(beat),
            "scene_id": scene_name,
            "canvas_id": canvas_id,
            "node_id": node_id or "director_capture",
            "capture_dir": _freezone_director_capture_base(project_dir, int(episode), int(beat))[
                0
            ].as_posix(),
            "editor_url": editor_url,
            "can_open_stage": can_open_stage,
            "files": files,
            "existing_count": sum(1 for item in files if item.get("exists")),
        },
    }


@router.post(
    "/projects/{project}/freezone/director-capture/sync-background",
    tags=[TAG_FREEZONE_ASSETS],
)
async def freezone_director_capture_sync_background(
    project: str,
    episode: int,
    beat: int,
    user: dict = Depends(get_api_user),
):
    """Mirror env_only.png → selected_background.png (idempotent).

    Use this **after** the user returns from the 3GS director stage (where
    PlayCanvas writes env_only.png directly via /@fs proxy). Frontend should
    call this before re-rendering canvases that consume
    selected_background.png.

    Why POST + editor permission:
      The GET manifest route used to do this as a side effect; that
      violates the "Push / explicit action is canonical write boundary"
      architectural rule (GET should be safe + idempotent). Splitting the
      mirror into its own POST keeps reads pure and surfaces the write
      intent in the call.

    Idempotent — if env_only.png is missing OR already older-than /
    equal-to selected_background.png, no copy happens (returns synced=False).
    """
    _ctx, _username, _project_name, project_dir, _output_dir = await _resolve_freezone_project(
        project, user, required_role="editor"
    )
    synced = _sync_env_only_to_selected_background(project_dir, int(episode), int(beat))
    return {"ok": True, "data": {"synced": synced, "episode": int(episode), "beat": int(beat)}}


@router.get(
    "/projects/{project}/freezone/scene-assets-for-beat",
    tags=[TAG_FREEZONE_ASSETS],
)
async def freezone_scene_assets_for_beat(
    project: str,
    episode: int,
    beat: int,
    user: dict = Depends(get_api_user),
):
    """Lazy thumbnail/source pool for a beat's "selected_background" slot.

    Drag-in / popover use case: when the user spawns a `selected_background`
    slot node (via drag from another canvas, or by clicking "选源" on the
    node's popover), the frontend needs to enumerate the scene's available
    source assets (`scene_master.png` / `scene_reverse_master.png` /
    pano 360 / 3GS PLY) so the user can pick which one to crop into the
    canonical `selected_background.png`.

    Why lazy: we deliberately do NOT store these URLs in the slot node's
    `data` (that would denormalize + go stale when scene assets re-render).
    The node only carries `{scene_id, episode, beat}`; this route resolves
    those to current canonical URLs on demand.

    Each `*_url` may be null if the underlying canonical file doesn't exist
    yet (e.g. user hasn't run scene-master generation). Caller renders only
    the available sources.
    """
    ctx, username, project_name, project_dir, _output_dir = await _resolve_freezone_project(
        project, user, required_role="viewer"
    )
    beat_data = await _beat_for_capture(
        username,
        project_name,
        int(episode),
        int(beat),
        ctx=ctx,
    )
    scene_name = beat_scene_id(beat_data)

    def _resolve(path: Path | None) -> str | None:
        if path is None or not path.is_file():
            return None
        try:
            rel = path.relative_to(project_dir).as_posix()
        except ValueError:
            return None
        return make_static_url_for_context(ctx, rel, local_path=path)

    master_url: str | None = None
    reverse_url: str | None = None
    director_env_only_url: str | None = None
    pano_360_url: str | None = None
    ply_url: str | None = None
    director_env_only_url = _resolve(
        canonical_beat_director_env_only_path(project_dir, int(episode), int(beat))
    )
    if scene_name:
        master_url = _resolve(canonical_scene_master_path(project_dir, scene_name))
        reverse_url = _resolve(canonical_scene_reverse_master_path(project_dir, scene_name))
        # scene_director_pano_360 lives under director_worlds/<scene>/v1 —
        # `stage_manifest.resolve_pano_path` already encodes that.
        try:
            from novelvideo.director_world import stage_manifest

            pano_360_url = _resolve(stage_manifest.resolve_pano_path(project_dir, scene_name))
            ply_url = _resolve(stage_manifest.resolve_ply_path(project_dir, scene_name))
        except Exception as exc:  # noqa: BLE001 — manifest issues should not 500 the listing
            logger.warning("scene-assets-for-beat: stage_manifest lookup failed: %s", exc)

    return {
        "ok": True,
        "data": {
            "project": project,
            "episode": int(episode),
            "beat": int(beat),
            "scene_id": scene_name,
            "master_url": master_url,
            "reverse_url": reverse_url,
            "director_env_only_url": director_env_only_url,
            "pano_360_url": pano_360_url,
            "ply_url": ply_url,
        },
    }


@router.post("/projects/{project}/freezone/push", tags=[TAG_FREEZONE_COMMIT])
async def freezone_push(project: str, body: PushRequest, user: dict = Depends(get_api_user)):
    """把 Freezone candidate 媒体写回主流程 canonical slot。

    源文件通常来自 `freezone/_outputs/`，也允许来自同项目作用域内的其他静态资源。
    写入前会自动备份已有目标文件。
    """
    ctx, username, project_name, project_dir, _output_dir = await _resolve_freezone_project(
        project, user
    )

    try:
        source_path = resolve_static_url_to_path(body.source_url, project_dir)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    if not source_path.exists():
        raise HTTPException(404, f"source file not found: {source_path}")
    validate_source_for_slot(source_path, body.target)

    target = slot_target_path(project_dir, body.target)
    if body.target.kind == "scene_3gs_custom_scene":
        target = target.with_suffix(source_path.suffix.lower())
    target.parent.mkdir(parents=True, exist_ok=True)
    same_file = False
    try:
        same_file = source_path.resolve() == target.resolve()
    except OSError:
        same_file = False
    should_match_existing_size = (
        target.exists()
        and not same_file
        and body.target.kind in {"frame", "sketch", "director_render"}
        and source_path.suffix.lower() in {".png", ".jpg", ".jpeg", ".webp"}
        and target.suffix.lower() in {".png", ".jpg", ".jpeg", ".webp"}
    )
    backup = None if same_file else backup_slot_if_exists(target)
    if same_file:
        image_adaptation = {"adapted": False, "same_file": True}
    elif should_match_existing_size:
        image_adaptation = _copy_image_matching_existing_target(source_path, target)
    else:
        image_adaptation = {"adapted": False}
        shutil.copy2(source_path, target)
    sync_slot_after_write(project_dir, body.target, target)
    if body.target.kind == "selected_background":
        await _persist_freezone_selected_background_scene_ref(
            ctx=ctx,
            episode=body.target.episode,
            beat=body.target.beat,
        )
    impacted: list[dict] = []
    stale_marked = 0
    if body.mark_stale and is_global_asset_slot(body.target):
        impacted = await compute_slot_impact(username, project_name, body.target)
        stale_marked = record_slot_stale_marks(
            project_dir,
            target=body.target,
            impacted=impacted,
            source_url=body.source_url,
        )

    if body.target.kind in {"identity", "identity_costume", "identity_portrait"}:
        # F5 收尾逻辑：尽量提示 cognee_store 刷新 identity 记录。
        # 磁盘文件才是真正的数据源，这里只是 best-effort 同步。
        try:
            store = await make_cognee_store_for_context(ctx)
            character = body.target.character
            identity_id = body.target.identity_id
            if body.target.kind == "identity_costume":
                try:
                    await store.update_character_identity(
                        character,
                        identity_id,
                        costume_image=str(target),
                    )
                except AttributeError:
                    logger.info(
                        "cognee_store.update_character_identity not available; "
                        "skipping costume metadata sync (file is updated)"
                    )
            if body.target.kind == "identity_portrait":
                try:
                    await store.update_character_identity(
                        character,
                        identity_id,
                        portrait_image=str(target),
                    )
                except AttributeError:
                    logger.info(
                        "cognee_store.update_character_identity not available; "
                        "skipping identity portrait metadata sync (file is updated)"
                    )
            try:
                await store.touch_identity(character, identity_id)  # type: ignore[attr-defined]
            except AttributeError:
                logger.info(
                    "cognee_store.touch_identity not available; "
                    "skipping metadata sync (file is updated)"
                )
        except Exception as exc:
            logger.warning("identity cognee sync best-effort failed: %s", exc)

    rel = target.relative_to(project_dir).as_posix()
    _append_canvas_event(
        project_dir=project_dir,
        project_id=project,
        canvas_id=None,
        event_type="canvas.push_committed",
        actor=_canvas_event_actor(user),
        payload={
            "source_url": body.source_url,
            "target": body.target.model_dump(mode="json"),
            "target_path": str(target),
            "target_url": make_static_url_for_context(ctx, rel, local_path=target),
            "backup": str(backup) if backup else None,
            "stale_marked": stale_marked,
            "affected_count": len(impacted),
        },
    )
    return {
        "ok": True,
        "data": {
            "target_path": str(target),
            "target_url": make_static_url_for_context(ctx, rel, local_path=target),
            "backup": str(backup) if backup else None,
            "image_adaptation": image_adaptation,
            "stale_marked": stale_marked,
            "affected_count": len(impacted),
        },
    }


@router.get("/projects/{project}/freezone/assets", tags=[TAG_FREEZONE_ASSETS])
async def list_freezone_assets(
    project: str,
    user: dict = Depends(get_api_user),
):
    """列出当前项目作用域下可供 Freezone 使用的 canonical assets。

    SQLiteStore 负责项目事实数据，PathResolver 负责磁盘路径解析。
    返回里同时保留 `exists` 和 `url`，这样调用方可以区分：
    “这是一个已知资产概念” 和 “这是一个当前可直接引用的文件”。
    """
    ctx, username, project_name, project_dir, _output_dir = await _resolve_freezone_project(
        project, user, required_role="viewer"
    )
    store = await make_sqlite_store_for_context(ctx)

    assets: list[dict] = []

    try:
        for character in store.get_all_characters():
            portrait_path = canonical_portrait_path(project_dir, character.name)
            assets.append(
                _asset_record_from_path(
                    username=username,
                    project=project_name,
                    project_dir=project_dir,
                    project_id=project,
                    tab="characters",
                    kind="portrait",
                    role="character_portrait",
                    label=f"{character.name} / portrait",
                    sublabel=character.name,
                    abs_path=portrait_path,
                    aspect_ratio="1:1",
                    meta={"character": character.name},
                )
            )
            default_voice = _asset_record_from_optional_project_path(
                username=username,
                project=project_name,
                project_dir=project_dir,
                project_id=project,
                tab="characters",
                kind="audio",
                role="character_voice",
                label=f"{character.name} / 默认声线",
                sublabel=character.name,
                stored_path=str(getattr(character, "reference_audio_path", "") or ""),
                meta={
                    "character": character.name,
                    "scope": "character_default",
                    "slot": "default",
                    "age_group": str(getattr(character, "age_group", "") or ""),
                    "sha256": str(getattr(character, "reference_audio_sha256", "") or ""),
                    "updated_at": str(getattr(character, "reference_audio_updated_at", "") or ""),
                },
            )
            if default_voice is not None:
                assets.append(default_voice)

            voice_samples = getattr(character, "voice_samples_by_age_group", None) or {}
            if isinstance(voice_samples, dict):
                for slot, slot_label in FREEZONE_AUDIO_AGE_GROUP_LABELS.items():
                    entry = voice_samples.get(slot)
                    if not isinstance(entry, dict):
                        continue
                    age_voice = _asset_record_from_optional_project_path(
                        username=username,
                        project=project_name,
                        project_dir=project_dir,
                        project_id=project,
                        tab="characters",
                        kind="audio",
                        role="character_age_group_voice",
                        label=f"{character.name} / {slot_label}声线",
                        sublabel=character.name,
                        stored_path=str(entry.get("path", "") or ""),
                        meta={
                            "character": character.name,
                            "scope": "character_age_group",
                            "slot": slot,
                            "age_group": slot,
                            "sha256": str(entry.get("sha256", "") or ""),
                            "updated_at": str(entry.get("updated_at", "") or ""),
                        },
                    )
                    if age_voice is not None:
                        assets.append(age_voice)

            for identity in character.identities or []:
                identity_name = (
                    getattr(identity, "identity_name", "")
                    or getattr(identity, "identity_id", "")
                    or "identity"
                )
                identity_id = (
                    getattr(identity, "identity_id", "") or f"{character.name}_{identity_name}"
                )
                identity_path = canonical_identity_path(project_dir, character.name, identity_name)
                assets.append(
                    _asset_record_from_path(
                        username=username,
                        project=project_name,
                        project_dir=project_dir,
                        project_id=project,
                        tab="characters",
                        kind="identity",
                        role="character_identity",
                        label=f"{character.name} / {identity_name}",
                        sublabel=character.name,
                        abs_path=identity_path,
                        aspect_ratio="1:1",
                        meta={"character": character.name, "identity_id": identity_id},
                    )
                )
                identity_costume_path = canonical_identity_costume_path(
                    project_dir,
                    character.name,
                    identity_name,
                )
                assets.append(
                    _asset_record_from_path(
                        username=username,
                        project=project_name,
                        project_dir=project_dir,
                        project_id=project,
                        tab="characters",
                        kind="identity_costume",
                        role="identity_costume",
                        label=f"{character.name} / {identity_name} costume",
                        sublabel=character.name,
                        abs_path=identity_costume_path,
                        aspect_ratio="3:4",
                        meta={
                            "character": character.name,
                            "identity_id": identity_id,
                            "identity_name": identity_name,
                        },
                    )
                )
                identity_portrait_path = canonical_identity_portrait_path(
                    project_dir,
                    character.name,
                    identity_name,
                )
                assets.append(
                    _asset_record_from_path(
                        username=username,
                        project=project_name,
                        project_dir=project_dir,
                        project_id=project,
                        tab="characters",
                        kind="identity_portrait",
                        role="identity_portrait",
                        label=f"{character.name} / {identity_name} portrait",
                        sublabel=character.name,
                        abs_path=identity_portrait_path,
                        aspect_ratio="3:4",
                        meta={
                            "character": character.name,
                            "identity_id": identity_id,
                            "identity_name": identity_name,
                        },
                    )
                )
                identity_voice = _asset_record_from_optional_project_path(
                    username=username,
                    project=project_name,
                    project_dir=project_dir,
                    project_id=project,
                    tab="characters",
                    kind="audio",
                    role="identity_voice",
                    label=f"{character.name} / {identity_name}声线",
                    sublabel=character.name,
                    stored_path=str(getattr(identity, "reference_audio_path", "") or ""),
                    meta={
                        "character": character.name,
                        "identity_id": identity_id,
                        "identity_name": identity_name,
                        "scope": "identity",
                        "age_group": str(getattr(identity, "age_group", "") or ""),
                        "sha256": str(getattr(identity, "reference_audio_sha256", "") or ""),
                        "updated_at": str(
                            getattr(identity, "reference_audio_updated_at", "") or ""
                        ),
                    },
                )
                if identity_voice is not None:
                    assets.append(identity_voice)

        for scene in await store.list_scenes():
            scene_name = scene.name
            director_pano_path = None
            stage_manifest_module = None
            try:
                from novelvideo.director_world import stage_manifest

                stage_manifest_module = stage_manifest
                director_pano_path = stage_manifest_module.resolve_pano_path(
                    project_dir, scene_name
                )
            except Exception:
                director_pano_path = None
            for kind, role, label, path, aspect in [
                (
                    "scene",
                    "scene_master",
                    f"{scene_name} / master",
                    canonical_scene_master_path(project_dir, scene_name),
                    "16:9",
                ),
                (
                    "scene",
                    "scene_reverse_master",
                    f"{scene_name} / reverse master",
                    canonical_scene_reverse_master_path(project_dir, scene_name),
                    "16:9",
                ),
                (
                    "scene",
                    "scene_director_pano_360",
                    f"{scene_name} / director pano 360",
                    director_pano_path,
                    "2:1",
                ),
            ]:
                if path is None or not _is_freezone_scene_library_role(role):
                    continue
                assets.append(
                    _asset_record_from_path(
                        username=username,
                        project=project_name,
                        project_dir=project_dir,
                        project_id=project,
                        tab="scenes",
                        kind=kind,
                        role=role,
                        label=label,
                        sublabel=scene_name,
                        abs_path=path,
                        aspect_ratio=aspect,
                        meta={
                            "scene": scene_name,
                            "scene_id": scene_name,
                            "scene_type": scene.scene_type,
                        },
                    )
                )
            if stage_manifest_module is not None:
                seen_stage_asset_paths: set[str] = set()
                for ply_kind, role, label in [
                    ("master", "scene_3gs_master_ply", f"{scene_name} / 3D 世界（正面）"),
                    ("reverse", "scene_3gs_reverse_ply", f"{scene_name} / 3D 世界（背面）"),
                    ("pano", "scene_3gs_pano_ply", f"{scene_name} / 3D 世界（360）"),
                    ("custom", "scene_3gs_custom_scene", f"{scene_name} / 3D 世界（自定义）"),
                ]:
                    ply_path = stage_manifest_module.resolve_ply_path(
                        project_dir,
                        scene_name,
                        ply_kind=ply_kind,
                    )
                    if ply_path is None or not _is_freezone_scene_library_role(role):
                        continue
                    rel = ply_path.relative_to(project_dir).as_posix()
                    if rel in seen_stage_asset_paths:
                        continue
                    seen_stage_asset_paths.add(rel)
                    assets.append(
                        _asset_record_from_path(
                            username=username,
                            project=project_name,
                            project_dir=project_dir,
                            project_id=project,
                            tab="scenes",
                            kind="scene",
                            role=role,
                            label=label,
                            sublabel=scene_name,
                            abs_path=ply_path,
                            aspect_ratio="1:1",
                            meta={
                                "scene": scene_name,
                                "scene_id": scene_name,
                                "scene_type": scene.scene_type,
                                "ply_kind": ply_kind,
                            },
                        )
                    )
        for prop in await store.list_props():
            prop_name = prop.name
            assets.append(
                _asset_record_from_path(
                    username=username,
                    project=project_name,
                    project_dir=project_dir,
                    project_id=project,
                    tab="props",
                    kind="prop",
                    role="prop_reference",
                    label=f"{prop_name} / reference",
                    sublabel=prop.prop_type or "object",
                    abs_path=canonical_prop_reference_path(project_dir, prop_name),
                    aspect_ratio="1:1",
                    meta={"prop_id": prop_name, "prop_type": prop.prop_type},
                )
            )
    finally:
        close = getattr(store, "close", None)
        if close:
            await close()

    return {"ok": True, "data": assets}


@router.get("/projects/{project}/freezone/assets/beat-context", tags=[TAG_FREEZONE_ASSETS])
async def list_freezone_beat_context_assets(
    project: str,
    episode: Optional[int] = None,
    beat: Optional[int] = None,
    user: dict = Depends(get_api_user),
):
    """列出 default/project 画布可用的 novelvideo Beat 上下文资产。

    这个接口只聚合 novelvideo canonical 产物，不扫描 `freezone/_uploads`
    或 `freezone/_outputs`。用于 default 画布展示全局 Beat 资源；具体 Beat
    预设画布仍可继续读取 canvas `metadata.references`。
    """
    ctx, username, project_name, project_dir, _output_dir = await _resolve_freezone_project(
        project, user, required_role="viewer"
    )
    store = await make_sqlite_store_for_context(ctx)

    requested_episode = int(episode) if episode is not None else None
    requested_beat = int(beat) if beat is not None else None
    if requested_episode is None and requested_beat is not None:
        raise HTTPException(400, "episode is required when beat is provided")

    flat_assets: list[dict] = []
    episode_groups: list[dict] = []
    try:
        if requested_episode is not None:
            episode_numbers = [requested_episode]
        else:
            episode_numbers = sorted(
                {
                    int(getattr(ep, "number", 0) or 0)
                    for ep in getattr(store, "_episodes", {}).values()
                    if int(getattr(ep, "number", 0) or 0) > 0
                }
            )
            if not episode_numbers:
                try:
                    visual_beats = await store.list_visual_beats()
                except Exception:
                    visual_beats = []
                episode_numbers = sorted(
                    {
                        int(getattr(item, "episode_number", 0) or 0)
                        for item in visual_beats
                        if int(getattr(item, "episode_number", 0) or 0) > 0
                    }
                )

        for ep_num in episode_numbers:
            try:
                beats = await store.get_beats_as_dicts(ep_num)
            except Exception as exc:
                logger.warning("failed to load beats for asset context ep%s: %s", ep_num, exc)
                beats = []
            beat_numbers = sorted(
                {
                    int(item.get("beat_number") or 0)
                    for item in beats
                    if int(item.get("beat_number") or 0) > 0
                }
            )
            if requested_beat is not None:
                beat_numbers = [num for num in beat_numbers if num == requested_beat]

            beat_groups: list[dict] = []
            for beat_num in beat_numbers:
                try:
                    context = await build_beat_preset_context(
                        project_id=ctx.project_id,
                        username=username,
                        project=project_name,
                        project_dir=project_dir,
                        store=store,
                        episode=ep_num,
                        beat=beat_num,
                        primary_slot="render",
                    )
                    context = (
                        migrate_canvas_static_urls_in_memory(
                            context,
                            project_id=ctx.project_id,
                            owner_username=username,
                            project_name=project_name,
                            project_dir=project_dir,
                        )
                        or context
                    )
                except Exception as exc:
                    logger.warning(
                        "failed to build beat context assets for ep%s beat%s: %s",
                        ep_num,
                        beat_num,
                        exc,
                    )
                    continue

                beat_data = context.get("beat_data") if isinstance(context, dict) else {}
                refs = context.get("refs") if isinstance(context, dict) else []
                beat_facts = {
                    "visual_description": str((beat_data or {}).get("visual_description") or ""),
                    "narration_segment": str((beat_data or {}).get("narration_segment") or ""),
                    "scene_id": beat_scene_id(beat_data or {}),
                    "detected_identities": (beat_data or {}).get("detected_identities") or [],
                    "detected_props": (beat_data or {}).get("detected_props") or [],
                    "sketch_colors": (
                        (context.get("sketch_context") or {}).get("sketch_colors") or {}
                    ),
                    "prop_marker_colors": (
                        (context.get("sketch_context") or {}).get("prop_marker_colors") or {}
                    ),
                }
                assets = [
                    asset
                    for ref in refs
                    if isinstance(ref, dict)
                    for asset in [
                        _beat_context_asset_from_ref(
                            ref=ref,
                            project_id=project,
                            episode=ep_num,
                            beat=beat_num,
                            beat_facts=beat_facts,
                        )
                    ]
                    if asset is not None
                ]
                existing_assets = [
                    asset for asset in assets if asset.get("exists") and asset.get("url")
                ]
                flat_assets.extend(existing_assets)
                beat_groups.append(
                    {
                        "episode": ep_num,
                        "beat": beat_num,
                        "label": f"EP{ep_num} / Beat {beat_num}",
                        "scene_id": beat_facts["scene_id"],
                        "detected_identities": beat_facts["detected_identities"],
                        "detected_props": beat_facts["detected_props"],
                        "sketch_colors": beat_facts["sketch_colors"],
                        "prop_marker_colors": beat_facts["prop_marker_colors"],
                        "visual_description": str(
                            (beat_data or {}).get("visual_description") or ""
                        ),
                        "narration_segment": str((beat_data or {}).get("narration_segment") or ""),
                        "assets": assets,
                        "asset_count": len(existing_assets),
                    }
                )

            if beat_groups:
                episode_groups.append({"episode": ep_num, "beats": beat_groups})
    finally:
        close = getattr(store, "close", None)
        if close:
            await close()

    return {
        "ok": True,
        "data": {
            "scope": {
                "episode": requested_episode,
                "beat": requested_beat,
            },
            "episodes": episode_groups,
            "assets": flat_assets,
        },
    }


@router.post("/projects/{project}/freezone/assets/identities", tags=[TAG_FREEZONE_ASSETS])
async def freezone_create_identity_asset(
    project: str,
    body: CreateIdentityAssetRequest,
    user: dict = Depends(get_api_user),
):
    """从选中的 Freezone 图片创建一个新的角色 identity。

    这个接口故意和 `/freezone/push` 分开：
    `push` 是覆盖已有 canonical slot，
    这里则是新建一个全新的 identity slot，并注册进项目存储。
    """
    ctx, username, _project_name, project_dir, _output_dir = await _resolve_freezone_project(
        project, user
    )

    character = body.character.strip()
    identity_name = body.identity_name.strip()
    if not character:
        raise HTTPException(400, "character is required")
    if not identity_name:
        raise HTTPException(400, "identity_name is required")

    try:
        source_path = resolve_static_url_to_path(body.source_url, project_dir)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    if not source_path.exists():
        raise HTTPException(404, f"source file not found: {source_path}")

    store = await make_sqlite_store_for_context(ctx)
    try:
        char = store.get_character(character)
        if not char:
            raise HTTPException(404, f"character not found: {character}")
        identity = CharacterIdentity(
            identity_id=f"{character}_{identity_name}",
            character_name=character,
            identity_name=identity_name,
            appearance_details=body.appearance_details.strip(),
            face_prompt=body.face_prompt.strip(),
            age_group=body.age_group.strip(),
            source="freezone",
        )
        if any(existing.identity_id == identity.identity_id for existing in char.identities):
            raise HTTPException(409, f"identity already exists: {identity.identity_id}")
        target = slot_target_path(
            project_dir,
            IdentityTarget(
                character=character,
                identity_id=identity.identity_id,
            ),
        )
        if target.exists():
            raise HTTPException(409, f"identity image already exists: {identity.identity_id}")
        target.parent.mkdir(parents=True, exist_ok=True)
        try:
            from PIL import Image

            with Image.open(source_path) as img:
                img.convert("RGB").save(target, format="PNG")
        except Exception:
            shutil.copy2(source_path, target)
        try:
            await store.add_character_identity(character, identity)
        except Exception:
            try:
                target.unlink(missing_ok=True)
            except Exception:
                logger.warning("failed to rollback copied identity image: %s", target)
            raise
    except HTTPException:
        raise
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc
    finally:
        close = getattr(store, "close", None)
        if close:
            await close()

    rel = target.relative_to(project_dir).as_posix()
    return {
        "ok": True,
        "data": {
            "character": character,
            "identity_id": identity.identity_id,
            "identity_name": identity.identity_name,
            "target_path": str(target),
            "target_url": make_static_url_for_context(ctx, rel, local_path=target),
        },
    }


@router.post("/projects/{project}/freezone/init", tags=[TAG_FREEZONE_BOOTSTRAP])
async def init_freezone(project: str, user: dict = Depends(get_api_user)):
    """懒创建 Freezone 目录树，可重复调用且幂等。"""
    ctx, _username, _project_name, project_dir, _output_dir = await _resolve_freezone_project(
        project, user
    )
    canvas_project_dir = _canvas_state_project_dir(ctx, project_dir)
    freezone_root(project_dir).mkdir(parents=True, exist_ok=True)
    uploads_dir(project_dir).mkdir(parents=True, exist_ok=True)
    canvases_dir(canvas_project_dir).mkdir(parents=True, exist_ok=True)
    try:
        default_canvas = canvas_store.ensure_default_canvas(
            canvas_project_dir,
            project_id=ctx.project_id,
            actor_id=_canvas_actor_id(user),
        )
    except (canvas_store.CanvasStoreError, CanvasLockBusy) as exc:
        _raise_canvas_store_http(exc)
    return {
        "ok": True,
        "data": {
            "freezone_dir": str(freezone_root(project_dir)),
            "default_canvas": {
                "canvas_id": "default",
                "created": default_canvas.created,
                "revision": default_canvas.payload.get("revision"),
            },
        },
    }
