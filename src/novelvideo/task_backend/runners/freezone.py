"""Celery runners for Image Freezone jobs."""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

from novelvideo.project_context import ProjectContext
from novelvideo.task_backend.cancel import (
    await_envelope_with_cancel_watch,
    await_with_cancel_watch as _await_with_cancel_watch,
)
from novelvideo.task_backend.registry import register_project_task_runner
from novelvideo.task_identity import project_task_state_key
from novelvideo.task_state import get_task_manager


def _run_cancellable(
    envelope: dict[str, Any],
    coro,
    *,
    task_type: str | None = None,
) -> dict[str, Any]:
    return asyncio.run(
        await_envelope_with_cancel_watch(
            coro,
            envelope,
            task_type=task_type or str(envelope.get("task_type") or ""),
        )
    )


def _update(
    ctx: ProjectContext,
    task_type: str,
    scope: str,
    progress: float,
    current_task: str,
    *,
    episode: int = 0,
) -> None:
    get_task_manager().update_progress_for_project(
        ctx,
        task_type,
        int(episode),
        scope=scope,
        progress=progress,
        current_task=current_task,
        logs=[current_task],
    )


def _append_node_history(
    *,
    ctx: ProjectContext,
    project_dir: Path,
    payload: dict[str, Any],
    task_type: str,
    job_id: str,
    media_type: str,
    result: dict[str, Any],
    error: str | None = None,
    episode: int = 0,
    beat_num: int | None = None,
    scope: str | None = None,
    **extra: Any,
) -> dict[str, Any] | None:
    node_id = str(payload.get("node_id") or "").strip()
    if not node_id:
        return None
    from novelvideo.freezone.history import (
        append_generation_history,
        build_node_history_record,
    )

    # Text/audio nodes carry the user text under "input"; image nodes use "prompt".
    record = build_node_history_record(
        task_type=task_type,
        job_id=job_id,
        task_key=project_task_state_key(
            task_type,
            ctx.project_id,
            int(episode),
            beat_num=beat_num,
            scope=scope or job_id,
        ),
        status="failed" if error else "completed",
        media_type=media_type,
        result=result,
        error=error,
        prompt=payload.get("prompt") or payload.get("input"),
        extra=extra,
    )

    return append_generation_history(
        project_dir=project_dir,
        canvas_id=str(payload.get("canvas_id") or "default"),
        node_id=node_id,
        record=record,
    )


def _history_model_mode_extra(payload: dict) -> dict:
    """记忆包：把生成请求里的注册表 model id / 生成模式映射到历史记录顶层字段。

    仅非空时写入，缺省省略（向后兼容，还原时回退默认）。
    """
    extra: dict[str, str] = {}
    model_id = payload.get("model_id")
    if model_id:
        extra["model"] = str(model_id)
    gen_mode = payload.get("gen_mode")
    if gen_mode:
        extra["gen_mode"] = str(gen_mode)
    return extra


async def _run_freezone_gen_async(envelope: dict[str, Any], ctx: ProjectContext) -> dict[str, Any]:
    from novelvideo.api.deps import make_static_url_for_context
    from novelvideo.freezone.jobs import ensure_freezone_dirs, run_freezone_gen

    payload = envelope.get("payload") or {}
    task_type = str(envelope.get("task_type") or "freezone_gen")
    job_id = str(payload["job_id"])
    project_dir = Path(str(payload.get("project_dir") or ctx.output_dir))
    ensure_freezone_dirs(project_dir)
    _update(ctx, task_type, job_id, 0.1, "调用图像生成器...")
    out_path = await _await_with_cancel_watch(
        run_freezone_gen(
            project_dir=project_dir,
            job_id=job_id,
            prompt=str(payload.get("prompt") or ""),
            aspect_ratio=str(payload.get("aspect_ratio") or "1:1"),
            image_size=str(payload.get("image_size") or "2K"),
            reference_paths=payload.get("reference_paths") or None,
            provider=payload.get("provider"),
            model=payload.get("model"),
            quality=payload.get("quality"),
            output_task_type=task_type,
        ),
        project_id=ctx.project_id,
        task_type=task_type,
        episode=0,
        task_id=str(envelope.get("__run_task_id") or ""),
        scope=job_id,
    )
    rel = out_path.relative_to(project_dir).as_posix()
    result = {
        "job_id": job_id,
        "output_path": str(out_path),
        "output_url": make_static_url_for_context(ctx, rel),
    }
    history_record = _append_node_history(
        ctx=ctx,
        project_dir=project_dir,
        payload=payload,
        task_type=task_type,
        job_id=job_id,
        media_type="image",
        result=result,
        **_history_model_mode_extra(payload),
    )
    if history_record:
        result["generation_history_record"] = history_record
    return result


async def _run_freezone_edit_async(
    envelope: dict[str, Any],
    ctx: ProjectContext,
) -> dict[str, Any]:
    from novelvideo.api.deps import make_static_url_for_context
    from novelvideo.freezone.jobs import ensure_freezone_dirs, run_freezone_edit

    payload = envelope.get("payload") or {}
    task_type = str(envelope.get("task_type") or "freezone_edit")
    job_id = str(payload["job_id"])
    project_dir = Path(str(payload.get("project_dir") or ctx.output_dir))
    ensure_freezone_dirs(project_dir)
    _update(ctx, task_type, job_id, 0.1, "调用图像编辑器...")
    out_path = await _await_with_cancel_watch(
        run_freezone_edit(
            project_dir=project_dir,
            job_id=job_id,
            prompt=str(payload.get("prompt") or ""),
            base_path=str(payload["base_path"]),
            extra_reference_paths=payload.get("extra_reference_paths") or None,
            aspect_ratio=str(payload.get("aspect_ratio") or "1:1"),
            image_size=str(payload.get("image_size") or "2K"),
            provider=payload.get("provider"),
            model=payload.get("model"),
            quality=payload.get("quality"),
            output_task_type=task_type,
        ),
        project_id=ctx.project_id,
        task_type=task_type,
        episode=0,
        task_id=str(envelope.get("__run_task_id") or ""),
        scope=job_id,
    )
    rel = out_path.relative_to(project_dir).as_posix()
    result = {
        "job_id": job_id,
        "output_path": str(out_path),
        "output_url": make_static_url_for_context(ctx, rel),
    }
    history_record = _append_node_history(
        ctx=ctx,
        project_dir=project_dir,
        payload=payload,
        task_type=task_type,
        job_id=job_id,
        media_type="image",
        result=result,
        **_history_model_mode_extra(payload),
    )
    if history_record:
        result["generation_history_record"] = history_record
    return result


async def _run_freezone_mask_edit_async(
    envelope: dict[str, Any],
    ctx: ProjectContext,
) -> dict[str, Any]:
    from novelvideo.api.deps import make_static_url_for_context
    from novelvideo.freezone.jobs import ensure_freezone_dirs, run_freezone_mask_edit

    payload = envelope.get("payload") or {}
    job_id = str(payload["job_id"])
    project_dir = Path(str(payload.get("project_dir") or ctx.output_dir))
    ensure_freezone_dirs(project_dir)
    provider = str(payload.get("provider") or "newapi")
    _update(ctx, "freezone_mask_edit", job_id, 0.1, f"调用 {provider} 图片擦除...")
    out_path = await run_freezone_mask_edit(
        project_dir=project_dir,
        job_id=job_id,
        base_path=str(payload["base_path"]),
        mask_path=str(payload["mask_path"]),
        prompt=str(payload.get("prompt") or ""),
        aspect_ratio=str(payload.get("aspect_ratio") or "1:1"),
        image_size=str(payload.get("image_size") or "2K"),
        quality=str(payload.get("quality") or "medium"),
        provider=provider,
        model=str(payload.get("model") or ""),
    )
    rel = out_path.relative_to(project_dir).as_posix()
    return {
        "job_id": job_id,
        "output_path": str(out_path),
        "output_url": make_static_url_for_context(ctx, rel),
    }


async def _run_freezone_extract_async(
    envelope: dict[str, Any],
    ctx: ProjectContext,
) -> dict[str, Any]:
    from novelvideo.api.deps import make_static_url_for_context
    from novelvideo.freezone.jobs import ensure_freezone_dirs, run_freezone_extract_frames

    payload = envelope.get("payload") or {}
    job_id = str(payload["job_id"])
    project_dir = Path(str(payload.get("project_dir") or ctx.output_dir))
    ensure_freezone_dirs(project_dir)
    _update(ctx, "freezone_extract", job_id, 0.1, "ffmpeg 抽帧中...")
    frame_paths = await run_freezone_extract_frames(
        project_dir=project_dir,
        job_id=job_id,
        video_path=Path(str(payload["video_path"])),
        max_frames=int(payload.get("max_frames") or 20),
        scene_threshold=float(payload.get("scene_threshold") or 0.3),
    )
    return {
        "job_id": job_id,
        "frame_count": len(frame_paths),
        "frame_urls": [
            make_static_url_for_context(ctx, path.relative_to(project_dir).as_posix())
            for path in frame_paths
        ],
        "frame_paths": [str(path) for path in frame_paths],
    }


async def _run_freezone_analyze_async(
    envelope: dict[str, Any],
    ctx: ProjectContext,
) -> dict[str, Any]:
    from novelvideo.api.deps import make_static_url_for_context
    from novelvideo.freezone.jobs import ensure_freezone_dirs, run_freezone_analyze_shots

    payload = envelope.get("payload") or {}
    job_id = str(payload["job_id"])
    project_dir = Path(str(payload.get("project_dir") or ctx.output_dir))
    ensure_freezone_dirs(project_dir)
    frame_paths = [str(path) for path in payload.get("frame_paths") or []]
    _update(ctx, "freezone_analyze", job_id, 0.1, f"Vision 分析 {len(frame_paths)} 帧...")
    result = await run_freezone_analyze_shots(
        project_dir=project_dir,
        job_id=job_id,
        frame_paths=frame_paths,
        provider=payload.get("provider"),
        model=payload.get("model"),
        analysis_mode=str(payload.get("analysis_mode") or "shots"),
        duration_sec=payload.get("duration_sec"),
    )
    output_path = Path(str(result["output_path"]))
    return {
        "job_id": job_id,
        "output_path": str(output_path),
        "output_url": make_static_url_for_context(
            ctx,
            output_path.relative_to(project_dir).as_posix(),
        ),
        "model": result.get("model"),
        "analysis_mode": result.get("analysis_mode"),
        "frame_count": result.get("frame_count"),
        "analyses": result.get("analyses"),
        "video_story": result.get("video_story"),
    }


async def _run_freezone_video_story_async(
    envelope: dict[str, Any],
    ctx: ProjectContext,
) -> dict[str, Any]:
    from novelvideo.api.deps import make_static_url_for_context
    from novelvideo.freezone.jobs import (
        ensure_freezone_dirs,
        run_freezone_analyze_shots,
        run_freezone_extract_frames,
    )

    payload = envelope.get("payload") or {}
    job_id = str(payload["job_id"])
    project_dir = Path(str(payload.get("project_dir") or ctx.output_dir))
    ensure_freezone_dirs(project_dir)
    _update(ctx, "freezone_video_story", job_id, 0.1, "ffmpeg 抽取关键帧...")
    frame_paths = await run_freezone_extract_frames(
        project_dir=project_dir,
        job_id=job_id,
        video_path=Path(str(payload["video_path"])),
        max_frames=int(payload.get("max_frames") or 20),
        scene_threshold=float(payload.get("scene_threshold") or 0.3),
    )
    frame_urls = [
        make_static_url_for_context(ctx, path.relative_to(project_dir).as_posix())
        for path in frame_paths
    ]
    _update(
        ctx,
        "freezone_video_story",
        job_id,
        0.55,
        f"Vision 解析 {len(frame_paths)} 帧为视频故事...",
    )
    result = await run_freezone_analyze_shots(
        project_dir=project_dir,
        job_id=job_id,
        frame_paths=[str(path) for path in frame_paths],
        provider=payload.get("provider"),
        model=payload.get("model"),
        analysis_mode="video_story",
        duration_sec=payload.get("duration_sec"),
    )
    output_path = Path(str(result["output_path"]))
    return {
        "job_id": job_id,
        "output_url": make_static_url_for_context(
            ctx,
            output_path.relative_to(project_dir).as_posix(),
        ),
        "model": result.get("model"),
        "analysis_mode": "video_story",
        "frame_count": len(frame_paths),
        "frame_urls": frame_urls,
        "analyses": result.get("analyses"),
        "video_story": result.get("video_story"),
    }


def run_freezone_gen(envelope: dict[str, Any], ctx: ProjectContext) -> dict[str, Any]:
    return _run_cancellable(envelope, _run_freezone_gen_async(envelope, ctx))


def run_freezone_edit(envelope: dict[str, Any], ctx: ProjectContext) -> dict[str, Any]:
    return _run_cancellable(envelope, _run_freezone_edit_async(envelope, ctx))


def run_mainline_sketch_from_context(
    envelope: dict[str, Any], ctx: ProjectContext
) -> dict[str, Any]:
    return _run_cancellable(envelope, _run_mainline_sketch_from_context_async(envelope, ctx))


def run_mainline_frame_from_context(
    envelope: dict[str, Any], ctx: ProjectContext
) -> dict[str, Any]:
    return _run_cancellable(envelope, _run_mainline_frame_from_context_async(envelope, ctx))


async def _run_mainline_sketch_from_context_async(
    envelope: dict[str, Any],
    ctx: ProjectContext,
) -> dict[str, Any]:
    from novelvideo.api.deps import make_static_url_for_context
    from novelvideo.task_backend.runners.sketch import _run_sketch_generation_async

    payload = envelope.get("payload") or {}
    task_type = str(envelope.get("task_type") or "mainline_sketch_from_context")
    job_id = str(payload["job_id"])
    episode = int(envelope.get("episode") or payload.get("episode") or 0)
    beat_num = int(envelope.get("beat_num") or payload.get("beat_num") or 0)
    scope = str(envelope.get("scope") or job_id)
    project_dir = Path(
        str(payload.get("output_dir") or payload.get("project_dir") or ctx.output_dir)
    )

    result = await _run_sketch_generation_async(envelope, ctx)
    out_path = Path(str(result.get("sketch_path") or ""))
    if not out_path.exists():
        raise FileNotFoundError(f"mainline sketch output missing: {out_path}")
    rel = out_path.relative_to(project_dir).as_posix()
    response = {
        **result,
        "job_id": job_id,
        "output_path": str(out_path),
        "output_url": make_static_url_for_context(ctx, rel, local_path=out_path),
        "media_type": "image",
    }
    history_record = _append_node_history(
        ctx=ctx,
        project_dir=project_dir,
        payload=payload,
        task_type=task_type,
        job_id=job_id,
        media_type="image",
        result=response,
        episode=episode,
        beat_num=beat_num,
        scope=scope,
    )
    if history_record:
        response["generation_history_record"] = history_record
    return response


async def _run_mainline_frame_from_context_async(
    envelope: dict[str, Any],
    ctx: ProjectContext,
) -> dict[str, Any]:
    from novelvideo.api.deps import make_static_url_for_context
    from novelvideo.task_backend.runners.render import _run_selected_regen_async

    payload = envelope.get("payload") or {}
    task_type = str(envelope.get("task_type") or "mainline_frame_from_context")
    job_id = str(payload["job_id"])
    episode = int(envelope.get("episode") or payload.get("episode") or 0)
    beat_num = int(envelope.get("beat_num") or payload.get("beat_num") or 0)
    scope = str(envelope.get("scope") or job_id)
    project_dir = Path(
        str(payload.get("output_dir") or payload.get("project_dir") or ctx.output_dir)
    )

    result = await _run_selected_regen_async(envelope, ctx, is_sketch=False)
    # Single-beat skill run (1x1): one grid → one rel path under project_dir.
    grid_paths = result.get("grid_paths") or {}
    rel = grid_paths.get(beat_num) or (next(iter(grid_paths.values())) if grid_paths else "")
    if not rel:
        grid_results = result.get("grid_results") or []
        rel = str(grid_results[0].get("rel_path") or "") if grid_results else ""
    if not rel:
        raise FileNotFoundError("mainline frame output missing (no grid path)")
    out_path = (project_dir / rel).resolve()
    if not out_path.exists():
        raise FileNotFoundError(f"mainline frame output missing: {out_path}")
    rel = out_path.relative_to(project_dir).as_posix()
    response = {
        **result,
        "job_id": job_id,
        "output_path": str(out_path),
        "output_url": make_static_url_for_context(ctx, rel, local_path=out_path),
        "media_type": "image",
    }
    history_record = _append_node_history(
        ctx=ctx,
        project_dir=project_dir,
        payload=payload,
        task_type=task_type,
        job_id=job_id,
        media_type="image",
        result=response,
        episode=episode,
        beat_num=beat_num,
        scope=scope,
    )
    if history_record:
        response["generation_history_record"] = history_record
    return response


async def _run_mainline_director_control_sketch_async(
    envelope: dict[str, Any],
    ctx: ProjectContext,
) -> dict[str, Any]:
    from novelvideo.api.deps import make_static_url_for_context
    from novelvideo.director_world.control_frame_to_sketch import convert_control_frame_to_sketch
    from novelvideo.freezone.paths import output_path_for_job

    payload = envelope.get("payload") or {}
    task_type = str(envelope.get("task_type") or "mainline_director_control_sketch")
    job_id = str(payload["job_id"])
    episode = int(envelope.get("episode") or payload.get("episode") or 0)
    beat_num = int(envelope.get("beat_num") or payload.get("beat_num") or 0)
    scope = str(envelope.get("scope") or job_id)
    project_dir = Path(str(payload.get("project_dir") or ctx.output_dir))
    state_dir = str(payload.get("state_dir") or ctx.state_dir)
    output_path = output_path_for_job(project_dir, task_type, job_id)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    _update(
        ctx,
        task_type,
        scope,
        0.05,
        f"开始 Beat {beat_num} 导演合成图转草图候选...",
        episode=episode,
    )
    result = await _await_with_cancel_watch(
        convert_control_frame_to_sketch(
            user=ctx.owner_username,
            project=ctx.project_name,
            episode=episode,
            beat=beat_num,
            mode_key=str(payload.get("mode_key") or ""),
            aspect_ratio=str(payload.get("aspect_ratio") or ""),
            output_dir=project_dir,
            state_dir=state_dir,
            control_frame_path=payload.get("control_frame_path") or None,
            require_control_frame_path=True,
            candidate_output_path=output_path,
            promote=False,
        ),
        project_id=ctx.project_id,
        task_type=task_type,
        episode=episode,
        task_id=str(envelope.get("__run_task_id") or ""),
        beat_num=beat_num,
        scope=scope,
    )
    out_path = Path(str(result.get("output_path") or output_path))
    rel = out_path.relative_to(project_dir).as_posix()
    response = {
        **result,
        "job_id": job_id,
        "output_path": str(out_path),
        "output_url": make_static_url_for_context(ctx, rel, local_path=out_path),
        "media_type": "image",
    }
    history_record = _append_node_history(
        ctx=ctx,
        project_dir=project_dir,
        payload=payload,
        task_type=task_type,
        job_id=job_id,
        media_type="image",
        result=response,
        episode=episode,
        beat_num=beat_num,
        scope=scope,
    )
    if history_record:
        response["generation_history_record"] = history_record
    _update(ctx, task_type, scope, 1.0, "导演合成图草图候选已生成", episode=episode)
    return response


def run_mainline_director_control_sketch(
    envelope: dict[str, Any], ctx: ProjectContext
) -> dict[str, Any]:
    return _run_cancellable(envelope, _run_mainline_director_control_sketch_async(envelope, ctx))


def run_freezone_mask_edit(envelope: dict[str, Any], ctx: ProjectContext) -> dict[str, Any]:
    return _run_cancellable(envelope, _run_freezone_mask_edit_async(envelope, ctx))


def run_freezone_extract(envelope: dict[str, Any], ctx: ProjectContext) -> dict[str, Any]:
    return _run_cancellable(envelope, _run_freezone_extract_async(envelope, ctx))


def run_freezone_analyze(envelope: dict[str, Any], ctx: ProjectContext) -> dict[str, Any]:
    return _run_cancellable(envelope, _run_freezone_analyze_async(envelope, ctx))


def run_freezone_video_story(envelope: dict[str, Any], ctx: ProjectContext) -> dict[str, Any]:
    return _run_cancellable(envelope, _run_freezone_video_story_async(envelope, ctx))


async def _run_freezone_video_erase_async(
    envelope: dict[str, Any],
    ctx: ProjectContext,
) -> dict[str, Any]:
    from novelvideo.api.deps import make_static_url_for_context
    from novelvideo.freezone.jobs import ensure_freezone_dirs, run_freezone_video_erase

    payload = envelope.get("payload") or {}
    job_id = str(payload["job_id"])
    project_dir = Path(str(payload.get("project_dir") or ctx.output_dir))
    ensure_freezone_dirs(project_dir)
    _update(ctx, "freezone_video_erase", job_id, 0.1, "开始视频擦除处理...")
    output_path, meta = await run_freezone_video_erase(
        project_dir=project_dir,
        job_id=job_id,
        source_path=str(payload["source_path"]),
        mode=str(payload.get("mode") or "smart_subtitle"),
        box_x=payload.get("box_x"),
        box_y=payload.get("box_y"),
        box_width=payload.get("box_width"),
        box_height=payload.get("box_height"),
    )
    rel = output_path.relative_to(project_dir).as_posix()
    return {
        "job_id": job_id,
        "output_format": "mp4",
        "output_path": str(output_path),
        "output_url": make_static_url_for_context(ctx, rel),
        "meta": meta,
    }


async def _run_freezone_video_upscale_async(
    envelope: dict[str, Any],
    ctx: ProjectContext,
) -> dict[str, Any]:
    from novelvideo.api.deps import make_static_url_for_context
    from novelvideo.freezone.jobs import ensure_freezone_dirs, run_freezone_video_upscale

    payload = envelope.get("payload") or {}
    job_id = str(payload["job_id"])
    project_dir = Path(str(payload.get("project_dir") or ctx.output_dir))
    ensure_freezone_dirs(project_dir)
    _update(ctx, "freezone_video_upscale", job_id, 0.1, "开始视频高清处理...")
    output_path, meta = await run_freezone_video_upscale(
        project_dir=project_dir,
        job_id=job_id,
        source_path=str(payload["source_path"]),
        resolution=str(payload.get("resolution") or "1080p"),
        frame_interpolation=str(payload.get("frame_interpolation") or "none"),
        denoise_strength=str(payload.get("denoise_strength") or "1x"),
    )
    rel = output_path.relative_to(project_dir).as_posix()
    return {
        "job_id": job_id,
        "output_format": "mp4",
        "output_path": str(output_path),
        "output_url": make_static_url_for_context(ctx, rel),
        "meta": meta,
    }


async def _run_freezone_audio_separate_async(
    envelope: dict[str, Any],
    ctx: ProjectContext,
) -> dict[str, Any]:
    from novelvideo.api.deps import make_static_url_for_context
    from novelvideo.freezone.jobs import ensure_freezone_dirs, run_freezone_audio_separate

    payload = envelope.get("payload") or {}
    job_id = str(payload["job_id"])
    project_dir = Path(str(payload.get("project_dir") or ctx.output_dir))
    ensure_freezone_dirs(project_dir)
    _update(ctx, "freezone_audio_separate", job_id, 0.1, "开始音视频分离...")
    outputs = await run_freezone_audio_separate(
        project_dir=project_dir,
        job_id=job_id,
        source_path=str(payload["source_path"]),
    )
    audio_path = outputs.get("audio_path")
    mute_video_path = outputs.get("mute_video_path")
    audio_rel = audio_path.relative_to(project_dir).as_posix() if audio_path else ""
    mute_rel = mute_video_path.relative_to(project_dir).as_posix() if mute_video_path else ""
    response = {
        "job_id": job_id,
        "audio_url": make_static_url_for_context(ctx, audio_rel) if audio_rel else None,
        "mute_video_url": make_static_url_for_context(ctx, mute_rel) if mute_rel else None,
    }
    target_episode = payload.get("target_episode")
    target_beat = payload.get("target_beat")
    if audio_path and target_episode and target_beat:
        response["pushable"] = True
        response["slot_target"] = {
            "kind": "beat_audio",
            "episode": int(target_episode),
            "beat": int(target_beat),
        }
    return response


async def _run_freezone_video_compose_async(
    envelope: dict[str, Any],
    ctx: ProjectContext,
) -> dict[str, Any]:
    from novelvideo.api.deps import make_static_url_for_context
    from novelvideo.freezone.jobs import ensure_freezone_dirs, run_freezone_video_compose

    payload = envelope.get("payload") or {}
    job_id = str(payload["job_id"])
    project_dir = Path(str(payload.get("project_dir") or ctx.output_dir))
    ensure_freezone_dirs(project_dir)
    _update(ctx, "freezone_video_compose", job_id, 0.1, "开始合成视频时间线...")
    output_path = await run_freezone_video_compose(
        project_dir=project_dir,
        job_id=job_id,
        title=str(payload.get("title") or ""),
        canvas_id=str(payload.get("canvas_id") or ""),
        resolution=str(payload.get("resolution") or "1080p"),
        fps=int(payload.get("fps") or 30),
        background_color=str(payload.get("background_color") or "#000000"),
        keep_original_audio=bool(payload.get("keep_original_audio", True)),
        tracks=list(payload.get("tracks") or []),
    )
    rel = output_path.relative_to(project_dir).as_posix()
    return {
        "job_id": job_id,
        "output_format": "mp4",
        "output_path": str(output_path),
        "output_url": make_static_url_for_context(ctx, rel),
    }


def run_freezone_video_erase(envelope: dict[str, Any], ctx: ProjectContext) -> dict[str, Any]:
    return _run_cancellable(envelope, _run_freezone_video_erase_async(envelope, ctx))


def run_freezone_video_upscale(envelope: dict[str, Any], ctx: ProjectContext) -> dict[str, Any]:
    return _run_cancellable(envelope, _run_freezone_video_upscale_async(envelope, ctx))


def run_freezone_audio_separate(envelope: dict[str, Any], ctx: ProjectContext) -> dict[str, Any]:
    return _run_cancellable(envelope, _run_freezone_audio_separate_async(envelope, ctx))


def run_freezone_video_compose(envelope: dict[str, Any], ctx: ProjectContext) -> dict[str, Any]:
    return _run_cancellable(envelope, _run_freezone_video_compose_async(envelope, ctx))


async def _run_freezone_text_translate_async(
    envelope: dict[str, Any],
    ctx: ProjectContext,
) -> dict[str, Any]:
    from novelvideo.api.deps import make_static_url_for_context
    from novelvideo.freezone.jobs import ensure_freezone_dirs
    from novelvideo.freezone.paths import outputs_dir
    from novelvideo.freezone.text_node import translate_freezone_text

    payload = envelope.get("payload") or {}
    job_id = str(payload["job_id"])
    project_dir = Path(str(payload.get("project_dir") or ctx.output_dir))
    ensure_freezone_dirs(project_dir)
    node_type = str(payload.get("node_type") or "generic")
    _update(ctx, "freezone_text_translate", job_id, 0.1, "开始翻译文本...")
    translated_text, source_language, target_language = await translate_freezone_text(
        text=str(payload.get("text") or ""),
        node_type=node_type,
    )
    data = {
        "translated_text": translated_text,
        "source_language": source_language,
        "target_language": target_language,
        "node_type": node_type,
    }
    out = outputs_dir(project_dir, "freezone_text_translate") / f"{job_id}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    import json

    out.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    rel = out.relative_to(project_dir).as_posix()
    result = {
        "job_id": job_id,
        "output_format": "json",
        "output_path": str(out),
        "output_url": make_static_url_for_context(ctx, rel),
        **data,
    }
    history_record = _append_node_history(
        ctx=ctx,
        project_dir=project_dir,
        payload=payload,
        task_type="freezone_text_translate",
        job_id=job_id,
        media_type="text",
        node_type=node_type,
        input_preview=str(payload.get("text") or "")[:240],
        result=result,
    )
    if history_record:
        result["generation_history_record"] = history_record
    return result


async def _run_freezone_story_script_async(
    envelope: dict[str, Any],
    ctx: ProjectContext,
) -> dict[str, Any]:
    from novelvideo.api.deps import make_static_url_for_context
    from novelvideo.freezone.jobs import ensure_freezone_dirs
    from novelvideo.freezone.paths import outputs_dir
    from novelvideo.freezone.text_node import generate_freezone_story_script

    payload = envelope.get("payload") or {}
    job_id = str(payload["job_id"])
    project_dir = Path(str(payload.get("project_dir") or ctx.output_dir))
    ensure_freezone_dirs(project_dir)
    _update(ctx, "freezone_story_script", job_id, 0.1, "开始生成故事脚本...")
    data = await generate_freezone_story_script(
        source_text=str(payload.get("source_text") or ""),
        prompt=str(payload.get("prompt") or ""),
        model=str(payload.get("model") or ""),
    )
    out = outputs_dir(project_dir, "freezone_story_script") / f"{job_id}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    import json

    payload_data = data.model_dump()
    out.write_text(json.dumps(payload_data, ensure_ascii=False, indent=2), encoding="utf-8")
    rel = out.relative_to(project_dir).as_posix()
    result = {
        "job_id": job_id,
        "output_format": "json",
        "output_path": str(out),
        "output_url": make_static_url_for_context(ctx, rel),
        **payload_data,
    }
    history_record = _append_node_history(
        ctx=ctx,
        project_dir=project_dir,
        payload=payload,
        task_type="freezone_story_script",
        job_id=job_id,
        media_type="text",
        model=str(payload.get("model") or ""),
        source_text_preview=str(payload.get("source_text") or "")[:240],
        row_count=len(payload_data.get("rows") or []),
        result=result,
    )
    if history_record:
        result["generation_history_record"] = history_record
    return result


async def _run_freezone_image_reverse_prompt_async(
    envelope: dict[str, Any],
    ctx: ProjectContext,
) -> dict[str, Any]:
    from novelvideo.api.deps import make_static_url_for_context
    from novelvideo.freezone.image_node import reverse_prompt_from_image
    from novelvideo.freezone.jobs import ensure_freezone_dirs
    from novelvideo.freezone.paths import outputs_dir

    payload = envelope.get("payload") or {}
    job_id = str(payload["job_id"])
    project_dir = Path(str(payload.get("project_dir") or ctx.output_dir))
    ensure_freezone_dirs(project_dir)
    source_path = Path(str(payload["source_path"]))
    _update(ctx, "freezone_image_reverse_prompt", job_id, 0.1, "开始反推图片提示词...")
    prompt = await reverse_prompt_from_image(image_path=source_path)
    out = outputs_dir(project_dir, "freezone_image_reverse_prompt") / f"{job_id}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    import json

    out.write_text(json.dumps({"prompt": prompt}, ensure_ascii=False, indent=2), encoding="utf-8")
    rel = out.relative_to(project_dir).as_posix()
    result = {
        "job_id": job_id,
        "output_format": "json",
        "output_path": str(out),
        "output_url": make_static_url_for_context(ctx, rel),
        "prompt": prompt,
    }
    history_record = _append_node_history(
        ctx=ctx,
        project_dir=project_dir,
        payload=payload,
        task_type="freezone_image_reverse_prompt",
        job_id=job_id,
        media_type="text",
        source_path=str(source_path),
        result=result,
    )
    if history_record:
        result["generation_history_record"] = history_record
    return result


def run_freezone_text_translate(envelope: dict[str, Any], ctx: ProjectContext) -> dict[str, Any]:
    return _run_cancellable(envelope, _run_freezone_text_translate_async(envelope, ctx))


def run_freezone_story_script(envelope: dict[str, Any], ctx: ProjectContext) -> dict[str, Any]:
    return _run_cancellable(envelope, _run_freezone_story_script_async(envelope, ctx))


def run_freezone_image_reverse_prompt(
    envelope: dict[str, Any],
    ctx: ProjectContext,
) -> dict[str, Any]:
    return _run_cancellable(envelope, _run_freezone_image_reverse_prompt_async(envelope, ctx))


async def _run_freezone_audio_speech_async(
    envelope: dict[str, Any],
    ctx: ProjectContext,
) -> dict[str, Any]:
    from novelvideo.api.deps import make_sqlite_store_for_context, make_static_url_for_context
    from novelvideo.freezone.audio_node import generate_freezone_audio_speech
    from novelvideo.freezone.jobs import ensure_freezone_dirs

    payload = envelope.get("payload") or {}
    job_id = str(payload["job_id"])
    project_dir = Path(str(payload.get("project_dir") or ctx.output_dir))
    ensure_freezone_dirs(project_dir)
    _update(ctx, "freezone_audio_speech", job_id, 0.1, "开始文本生成语音...")
    store = await make_sqlite_store_for_context(ctx)
    try:
        result = await generate_freezone_audio_speech(
            store=store,
            username=ctx.owner_username,
            project=ctx.project_name,
            account_voice_username=str(
                payload.get("account_voice_username")
                or ctx.requester_username
                or ctx.owner_username
            ),
            project_dir=project_dir,
            job_id=job_id,
            text=str(payload.get("text") or ""),
            emotion_prompt=str(payload.get("emotion_prompt") or ""),
            voice_ref=payload.get("voice_ref"),
        )
    finally:
        close = getattr(store, "close", None)
        if close:
            await close()
    rel = result.audio_path.relative_to(project_dir).as_posix()
    audio_url = make_static_url_for_context(ctx, rel)
    response = {
        "job_id": job_id,
        "url": audio_url,
        "audio_url": audio_url,
        "audio_size": result.audio_path.stat().st_size,
        "duration_ms": result.duration_ms,
        "mime_type": result.mime_type,
        "model": result.model,
        "voice_source": result.voice_source,
        "voice_sha256": result.voice_sha256,
    }
    target_episode = payload.get("target_episode")
    target_beat = payload.get("target_beat")
    if target_episode and target_beat:
        response["pushable"] = True
        response["slot_target"] = {
            "kind": "beat_audio",
            "episode": int(target_episode),
            "beat": int(target_beat),
        }
    return response


def run_freezone_audio_speech(envelope: dict[str, Any], ctx: ProjectContext) -> dict[str, Any]:
    return _run_cancellable(envelope, _run_freezone_audio_speech_async(envelope, ctx))


async def _run_freezone_audio_eleven_music_async(
    envelope: dict[str, Any],
    ctx: ProjectContext,
) -> dict[str, Any]:
    from novelvideo.api.deps import make_static_url_for_context
    from novelvideo.freezone.audio_node import generate_freezone_audio_eleven_music
    from novelvideo.freezone.jobs import ensure_freezone_dirs

    payload = envelope.get("payload") or {}
    job_id = str(payload["job_id"])
    project_dir = Path(str(payload.get("project_dir") or ctx.output_dir))
    ensure_freezone_dirs(project_dir)
    _update(ctx, "freezone_audio_eleven_music", job_id, 0.1, "开始文本生成音乐...")
    result = await generate_freezone_audio_eleven_music(
        project_dir=project_dir,
        job_id=job_id,
        prompt=str(payload.get("input") or ""),
        model=str(payload.get("model") or "LingShan-MU-11"),
        response_format=str(payload.get("response_format") or "mp3"),
        music_length_ms=int(payload.get("music_length_ms") or 30_000),
        force_instrumental=bool(payload.get("force_instrumental", True)),
        respect_sections_durations=bool(payload.get("respect_sections_durations", True)),
        output_format=str(payload.get("output_format") or "mp3_44100_128"),
    )
    rel = result.audio_path.relative_to(project_dir).as_posix()
    audio_url = make_static_url_for_context(ctx, rel)
    return {
        "job_id": job_id,
        "url": audio_url,
        "audio_url": audio_url,
        "audio_size": result.audio_path.stat().st_size,
        "duration_ms": result.duration_ms,
        "mime_type": result.mime_type,
        "model": result.model,
    }


def run_freezone_audio_eleven_music(
    envelope: dict[str, Any],
    ctx: ProjectContext,
) -> dict[str, Any]:
    return _run_cancellable(envelope, _run_freezone_audio_eleven_music_async(envelope, ctx))


register_project_task_runner("freezone_gen", run_freezone_gen)
register_project_task_runner("freezone_edit", run_freezone_edit)
register_project_task_runner("mainline_sketch_from_context", run_mainline_sketch_from_context)
register_project_task_runner("mainline_frame_from_context", run_mainline_frame_from_context)
register_project_task_runner(
    "mainline_director_control_sketch",
    run_mainline_director_control_sketch,
)
register_project_task_runner("freezone_mask_edit", run_freezone_mask_edit)
register_project_task_runner("freezone_extract", run_freezone_extract)
register_project_task_runner("freezone_analyze", run_freezone_analyze)
register_project_task_runner("freezone_video_story", run_freezone_video_story)
register_project_task_runner("freezone_video_erase", run_freezone_video_erase)
register_project_task_runner("freezone_video_upscale", run_freezone_video_upscale)
register_project_task_runner("freezone_audio_separate", run_freezone_audio_separate)
register_project_task_runner("freezone_video_compose", run_freezone_video_compose)
register_project_task_runner("freezone_text_translate", run_freezone_text_translate)
register_project_task_runner("freezone_story_script", run_freezone_story_script)
register_project_task_runner(
    "freezone_image_reverse_prompt",
    run_freezone_image_reverse_prompt,
)
register_project_task_runner("freezone_audio_speech", run_freezone_audio_speech)
register_project_task_runner("freezone_audio_eleven_music", run_freezone_audio_eleven_music)
