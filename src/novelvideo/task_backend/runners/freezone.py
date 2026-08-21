"""Celery runners for Image Freezone jobs."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Any

from novelvideo.egress_context import (
    TRUSTED_EGRESS_CONTEXT_KEY,
    TrustedEgressContext,
    TrustedRunnerEnvelope,
)
from novelvideo.project_context import ProjectContext
from novelvideo.task_backend.cancel import (
    await_envelope_with_cancel_watch,
    await_with_cancel_watch as _await_with_cancel_watch,
)
from novelvideo.task_backend.registry import register_project_task_runner
from novelvideo.task_backend.envelope import InvalidTaskEnvelope
from novelvideo.task_backend.projection import read_projection
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


class LeafEgress(Enum):
    """leaf 会不会出网。这是分发判据本身，与它的签名长什么样无关。"""

    LOCAL = "local"
    """纯本地：ffmpeg/subprocess，不出网、不取凭证。组织一律放行。"""

    NETWORK = "network"
    """出网：必须声明并接收 `egress_context`，由本函数注入。"""

    DENIED = "denied"
    """已知出网但尚未声明契约：组织下拒。与「未列入表」同待遇，列出来只为留证据。"""


@dataclass(frozen=True, slots=True)
class LeafEgressRule:
    module: str
    egress: LeafEgress
    eg_id: str


# 键是**调用点显式给出的名字**，不是函数对象：19 个调用点的 import 都在 runner
# 函数体内，测试替换掉的是那个局部名，模块级建的对象表必然查不中；`leaf.__name__`
# 同理（假 leaf 叫别的名字）。名字由调用点提供，替身也就盖不住分类。
FREEZONE_LEAF_EGRESS: dict[str, LeafEgressRule] = {
    # EG-20a `tool.local.restricted`（egress-inventory.md:54，`service/local`）
    "run_freezone_extract_frames": LeafEgressRule(
        "novelvideo.freezone.jobs", LeafEgress.LOCAL, "EG-20a"
    ),
    "run_freezone_video_upscale": LeafEgressRule(
        "novelvideo.freezone.jobs", LeafEgress.LOCAL, "EG-20a"
    ),
    "run_freezone_video_compose": LeafEgressRule(
        "novelvideo.freezone.jobs", LeafEgress.LOCAL, "EG-20a"
    ),
    "run_freezone_video_erase": LeafEgressRule(
        "novelvideo.freezone.jobs", LeafEgress.LOCAL, "EG-20a"
    ),
    "run_freezone_audio_separate": LeafEgressRule(
        "novelvideo.freezone.jobs", LeafEgress.LOCAL, "EG-20a"
    ),
    # EG-18b `freezone.image.generate`（:52，`gateway-routed`）
    "run_freezone_gen": LeafEgressRule(
        "novelvideo.freezone.jobs", LeafEgress.NETWORK, "EG-18b"
    ),
    "run_freezone_edit": LeafEgressRule(
        "novelvideo.freezone.jobs", LeafEgress.NETWORK, "EG-18b"
    ),
    "run_freezone_mask_edit": LeafEgressRule(
        "novelvideo.freezone.jobs", LeafEgress.NETWORK, "EG-18b"
    ),
    "run_freezone_analyze_shots": LeafEgressRule(
        "novelvideo.freezone.jobs", LeafEgress.NETWORK, "EG-18b"
    ),
    "reverse_prompt_from_image": LeafEgressRule(
        "novelvideo.freezone.image_node", LeafEgress.NETWORK, "EG-18b"
    ),
    # EG-18a `freezone.text.generate` / `.structured`（:51，`gateway-routed`）
    "translate_freezone_text": LeafEgressRule(
        "novelvideo.freezone.text_node", LeafEgress.NETWORK, "EG-18a"
    ),
    "generate_freezone_text": LeafEgressRule(
        "novelvideo.freezone.text_node", LeafEgress.NETWORK, "EG-18a"
    ),
    "generate_freezone_story_script": LeafEgressRule(
        "novelvideo.freezone.text_node", LeafEgress.NETWORK, "EG-18a"
    ),
    "generate_freezone_story_script_with_vision": LeafEgressRule(
        "novelvideo.freezone.text_node", LeafEgress.NETWORK, "EG-18a"
    ),
    # EG-15a `audio.tts.gateway`（:46，`gateway-routed`）
    "generate_freezone_audio_speech": LeafEgressRule(
        "novelvideo.freezone.audio_node", LeafEgress.NETWORK, "EG-15a"
    ),
    # 音乐与语音是同一个出网点的两个一跳调用方：都经 `_write_newapi_audio_speech`，
    # claim 的 capability 也都是 `audio.tts.gateway`（`audio_node.py:558`）。
    "generate_freezone_audio_eleven_music": LeafEgressRule(
        "novelvideo.freezone.audio_node", LeafEgress.NETWORK, "EG-15a"
    ),
    # EG-09a/09b：经 NanoBananaGridGenerator 出图，newapi 走网关，其余 provider 在
    # `nanobanana_grid.py:141` 对组织抛 ORG_EGRESS_DENIED。
    "convert_control_frame_to_sketch": LeafEgressRule(
        "novelvideo.director_world.control_frame_to_sketch",
        LeafEgress.NETWORK,
        "EG-09a",
    ),
}


def _call_freezone_leaf(
    envelope: dict[str, Any],
    leaf,
    leaf_name: str,
    /,
    **kwargs: Any,
):
    """按 leaf 是否出网分发。`leaf_name` 必填——漏传是 TypeError，不是静默放行。"""

    context = _extract_trusted_egress_context(envelope)
    rule = FREEZONE_LEAF_EGRESS.get(leaf_name)
    if rule is not None:
        if rule.egress is LeafEgress.LOCAL:
            return leaf(**kwargs)
        if rule.egress is LeafEgress.NETWORK:
            # 组织任务必须携带受信任的组织身份以走网关；平台与个人任务
            # 保持无组织上下文的既有直连语义，不能误触发组织出网闸门。
            if context is not None and context.is_organization:
                return leaf(egress_context=context, **kwargs)
            return leaf(**kwargs)
    # 未分类与 DENIED 同待遇：默认 fail-closed。
    if context is not None and context.is_organization:
        raise InvalidTaskEnvelope() from None
    return leaf(**kwargs)


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


async def _run_freezone_gen_async(
    envelope: dict[str, Any], ctx: ProjectContext
) -> dict[str, Any]:
    from novelvideo.api.deps import make_static_url_for_context
    from novelvideo.freezone.jobs import ensure_freezone_dirs, run_freezone_gen

    payload = envelope.get("payload") or {}
    task_type = str(envelope.get("task_type") or "freezone_gen")
    job_id = str(payload["job_id"])
    project_dir = Path(str(payload.get("project_dir") or ctx.output_dir))
    ensure_freezone_dirs(project_dir)
    _update(ctx, task_type, job_id, 0.1, "调用图像生成器...")
    out_path = await _await_with_cancel_watch(
        _call_freezone_leaf(
            envelope,
            run_freezone_gen,
            "run_freezone_gen",
            project_dir=project_dir,
            job_id=job_id,
            prompt=str(payload.get("prompt") or ""),
            aspect_ratio=str(payload.get("aspect_ratio") or "1:1"),
            image_size=str(payload.get("image_size") or "2K"),
            reference_paths=payload.get("reference_paths") or None,
            provider=payload.get("provider"),
            model=payload.get("model"),
            quality=payload.get("quality"),
            model_params=payload.get("model_params") or None,
            request_schema=payload.get("request_schema") or None,
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
        _call_freezone_leaf(
            envelope,
            run_freezone_edit,
            "run_freezone_edit",
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
            model_params=payload.get("model_params") or None,
            request_schema=payload.get("request_schema") or None,
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
    out_path = await _call_freezone_leaf(
        envelope,
        run_freezone_mask_edit,
        "run_freezone_mask_edit",
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
    from novelvideo.freezone.jobs import (
        ensure_freezone_dirs,
        run_freezone_extract_frames,
    )

    payload = envelope.get("payload") or {}
    job_id = str(payload["job_id"])
    project_dir = Path(str(payload.get("project_dir") or ctx.output_dir))
    ensure_freezone_dirs(project_dir)
    _update(ctx, "freezone_extract", job_id, 0.1, "ffmpeg 抽帧中...")
    frame_paths = await _call_freezone_leaf(
        envelope,
        run_freezone_extract_frames,
        "run_freezone_extract_frames",
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
    from novelvideo.freezone.jobs import (
        ensure_freezone_dirs,
        run_freezone_analyze_shots,
    )

    payload = envelope.get("payload") or {}
    job_id = str(payload["job_id"])
    project_dir = Path(str(payload.get("project_dir") or ctx.output_dir))
    ensure_freezone_dirs(project_dir)
    frame_paths = [str(path) for path in payload.get("frame_paths") or []]
    _update(
        ctx, "freezone_analyze", job_id, 0.1, f"Vision 分析 {len(frame_paths)} 帧..."
    )
    result = await _call_freezone_leaf(
        envelope,
        run_freezone_analyze_shots,
        "run_freezone_analyze_shots",
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
    frame_paths = await _call_freezone_leaf(
        envelope,
        run_freezone_extract_frames,
        "run_freezone_extract_frames",
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
    result = await _call_freezone_leaf(
        envelope,
        run_freezone_analyze_shots,
        "run_freezone_analyze_shots",
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
    return _run_cancellable(
        envelope, _run_mainline_sketch_from_context_async(envelope, ctx)
    )


def run_mainline_frame_from_context(
    envelope: dict[str, Any], ctx: ProjectContext
) -> dict[str, Any]:
    return _run_cancellable(
        envelope, _run_mainline_frame_from_context_async(envelope, ctx)
    )


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
    rel = grid_paths.get(beat_num) or (
        next(iter(grid_paths.values())) if grid_paths else ""
    )
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
    from novelvideo.director_world.control_frame_to_sketch import (
        convert_control_frame_to_sketch,
    )
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
        _call_freezone_leaf(
            envelope,
            convert_control_frame_to_sketch,
            "convert_control_frame_to_sketch",
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
            projection=read_projection(payload),
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
    return _run_cancellable(
        envelope, _run_mainline_director_control_sketch_async(envelope, ctx)
    )


def run_freezone_mask_edit(
    envelope: dict[str, Any], ctx: ProjectContext
) -> dict[str, Any]:
    return _run_cancellable(envelope, _run_freezone_mask_edit_async(envelope, ctx))


def run_freezone_extract(
    envelope: dict[str, Any], ctx: ProjectContext
) -> dict[str, Any]:
    return _run_cancellable(envelope, _run_freezone_extract_async(envelope, ctx))


def run_freezone_analyze(
    envelope: dict[str, Any], ctx: ProjectContext
) -> dict[str, Any]:
    return _run_cancellable(envelope, _run_freezone_analyze_async(envelope, ctx))


def run_freezone_video_story(
    envelope: dict[str, Any], ctx: ProjectContext
) -> dict[str, Any]:
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
    output_path, meta = await _call_freezone_leaf(
        envelope,
        run_freezone_video_erase,
        "run_freezone_video_erase",
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
    from novelvideo.freezone.jobs import (
        ensure_freezone_dirs,
        run_freezone_video_upscale,
    )

    payload = envelope.get("payload") or {}
    job_id = str(payload["job_id"])
    project_dir = Path(str(payload.get("project_dir") or ctx.output_dir))
    ensure_freezone_dirs(project_dir)
    _update(ctx, "freezone_video_upscale", job_id, 0.1, "开始视频高清处理...")
    output_path, meta = await _call_freezone_leaf(
        envelope,
        run_freezone_video_upscale,
        "run_freezone_video_upscale",
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
    from novelvideo.freezone.jobs import (
        ensure_freezone_dirs,
        run_freezone_audio_separate,
    )

    payload = envelope.get("payload") or {}
    job_id = str(payload["job_id"])
    project_dir = Path(str(payload.get("project_dir") or ctx.output_dir))
    ensure_freezone_dirs(project_dir)
    _update(ctx, "freezone_audio_separate", job_id, 0.1, "开始音视频分离...")
    outputs = await _call_freezone_leaf(
        envelope,
        run_freezone_audio_separate,
        "run_freezone_audio_separate",
        project_dir=project_dir,
        job_id=job_id,
        source_path=str(payload["source_path"]),
    )
    audio_path = outputs.get("audio_path")
    mute_video_path = outputs.get("mute_video_path")
    audio_rel = audio_path.relative_to(project_dir).as_posix() if audio_path else ""
    mute_rel = (
        mute_video_path.relative_to(project_dir).as_posix() if mute_video_path else ""
    )
    response = {
        "job_id": job_id,
        "audio_url": make_static_url_for_context(ctx, audio_rel) if audio_rel else None,
        "mute_video_url": (
            make_static_url_for_context(ctx, mute_rel) if mute_rel else None
        ),
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
    from novelvideo.freezone.jobs import (
        ensure_freezone_dirs,
        run_freezone_video_compose,
    )

    payload = envelope.get("payload") or {}
    job_id = str(payload["job_id"])
    project_dir = Path(str(payload.get("project_dir") or ctx.output_dir))
    ensure_freezone_dirs(project_dir)
    _update(ctx, "freezone_video_compose", job_id, 0.1, "开始合成视频时间线...")
    output_path = await _call_freezone_leaf(
        envelope,
        run_freezone_video_compose,
        "run_freezone_video_compose",
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


def run_freezone_video_erase(
    envelope: dict[str, Any], ctx: ProjectContext
) -> dict[str, Any]:
    return _run_cancellable(envelope, _run_freezone_video_erase_async(envelope, ctx))


def run_freezone_video_upscale(
    envelope: dict[str, Any], ctx: ProjectContext
) -> dict[str, Any]:
    return _run_cancellable(envelope, _run_freezone_video_upscale_async(envelope, ctx))


def run_freezone_audio_separate(
    envelope: dict[str, Any], ctx: ProjectContext
) -> dict[str, Any]:
    return _run_cancellable(envelope, _run_freezone_audio_separate_async(envelope, ctx))


def run_freezone_video_compose(
    envelope: dict[str, Any], ctx: ProjectContext
) -> dict[str, Any]:
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
    translated_text, source_language, target_language = await _call_freezone_leaf(
        envelope,
        translate_freezone_text,
        "translate_freezone_text",
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


async def _run_freezone_text_generate_async(
    envelope: dict[str, Any],
    ctx: ProjectContext,
) -> dict[str, Any]:
    from novelvideo.api.deps import make_static_url_for_context
    from novelvideo.freezone.jobs import ensure_freezone_dirs
    from novelvideo.freezone.paths import outputs_dir
    from novelvideo.freezone.text_node import generate_freezone_text

    payload = envelope.get("payload") or {}
    job_id = str(payload["job_id"])
    project_dir = Path(str(payload.get("project_dir") or ctx.output_dir))
    ensure_freezone_dirs(project_dir)
    prompt = str(payload.get("prompt") or "").strip()
    _update(ctx, "freezone_text_generate", job_id, 0.1, "开始生成文本...")
    model, generated_text = await _call_freezone_leaf(
        envelope,
        generate_freezone_text,
        "generate_freezone_text",
        prompt=prompt,
    )
    data = {"generated_text": generated_text, "model": model}
    out = outputs_dir(project_dir, "freezone_text_generate") / f"{job_id}.json"
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
        task_type="freezone_text_generate",
        job_id=job_id,
        media_type="text",
        input_preview=prompt[:240],
        prompt=prompt,
        model=model,
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
    from novelvideo.freezone.jobs import (
        ensure_freezone_dirs,
        run_freezone_extract_frames,
    )
    from novelvideo.freezone.paths import outputs_dir
    from novelvideo.freezone.text_node import (
        bind_story_script_assets,
        generate_freezone_story_script,
        generate_freezone_story_script_with_vision,
    )

    payload = envelope.get("payload") or {}
    job_id = str(payload["job_id"])
    project_dir = Path(str(payload.get("project_dir") or ctx.output_dir))
    ensure_freezone_dirs(project_dir)

    source_text = str(payload.get("source_text") or "")
    prompt = str(payload.get("prompt") or "")
    character_refs = list(payload.get("character_refs") or [])
    character_image_paths = [
        str(path) for path in payload.get("character_image_paths") or []
    ]
    video_path = str(payload.get("video_path") or "")
    duration_sec = payload.get("duration_sec")

    frame_paths: list[Path] = []
    frame_urls: list[str] = []
    if video_path:
        _update(ctx, "freezone_story_script", job_id, 0.1, "ffmpeg 抽取关键帧...")
        frame_paths = await _call_freezone_leaf(
            envelope,
            run_freezone_extract_frames,
            "run_freezone_extract_frames",
            project_dir=project_dir,
            job_id=job_id,
            video_path=Path(video_path),
            max_frames=int(payload.get("max_frames") or 20),
            scene_threshold=float(payload.get("scene_threshold") or 0.3),
        )
        frame_urls = [
            make_static_url_for_context(ctx, path.relative_to(project_dir).as_posix())
            for path in frame_paths
        ]

    if frame_paths or character_image_paths:
        _update(
            ctx,
            "freezone_story_script",
            job_id,
            0.55,
            (
                f"视觉模型解析 {len(frame_paths)} 帧为分镜脚本..."
                if frame_paths
                else "视觉模型读取角色参考图生成故事脚本..."
            ),
        )
        data = await _call_freezone_leaf(
            envelope,
            generate_freezone_story_script_with_vision,
            "generate_freezone_story_script_with_vision",
            frame_paths=[str(path) for path in frame_paths],
            character_image_paths=character_image_paths,
            source_text=source_text,
            prompt=prompt,
            duration_sec=float(duration_sec) if duration_sec else None,
            character_refs=character_refs,
        )
    else:
        _update(ctx, "freezone_story_script", job_id, 0.1, "开始生成故事脚本...")
        data = await _call_freezone_leaf(
            envelope,
            generate_freezone_story_script,
            "generate_freezone_story_script",
            source_text=source_text,
            prompt=prompt,
            model=str(payload.get("model") or ""),
            character_refs=character_refs,
        )

    bind_story_script_assets(data, frame_urls=frame_urls, character_refs=character_refs)
    out = outputs_dir(project_dir, "freezone_story_script") / f"{job_id}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    import json

    payload_data = data.model_dump()
    out.write_text(
        json.dumps(payload_data, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    rel = out.relative_to(project_dir).as_posix()
    result = {
        "job_id": job_id,
        "output_format": "json",
        "output_path": str(out),
        "output_url": make_static_url_for_context(ctx, rel),
        **payload_data,
    }
    if frame_urls:
        result["frame_urls"] = frame_urls
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
    prompt = await _call_freezone_leaf(
        envelope,
        reverse_prompt_from_image,
        "reverse_prompt_from_image",
        image_path=source_path,
        instruction=str(payload.get("instruction") or ""),
    )
    out = outputs_dir(project_dir, "freezone_image_reverse_prompt") / f"{job_id}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    import json

    out.write_text(
        json.dumps({"prompt": prompt}, ensure_ascii=False, indent=2), encoding="utf-8"
    )
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


def run_freezone_text_translate(
    envelope: dict[str, Any], ctx: ProjectContext
) -> dict[str, Any]:
    return _run_cancellable(envelope, _run_freezone_text_translate_async(envelope, ctx))


def run_freezone_text_generate(
    envelope: dict[str, Any], ctx: ProjectContext
) -> dict[str, Any]:
    return _run_cancellable(envelope, _run_freezone_text_generate_async(envelope, ctx))


def run_freezone_story_script(
    envelope: dict[str, Any], ctx: ProjectContext
) -> dict[str, Any]:
    return _run_cancellable(envelope, _run_freezone_story_script_async(envelope, ctx))


def run_freezone_image_reverse_prompt(
    envelope: dict[str, Any],
    ctx: ProjectContext,
) -> dict[str, Any]:
    return _run_cancellable(
        envelope, _run_freezone_image_reverse_prompt_async(envelope, ctx)
    )


async def _run_freezone_audio_speech_async(
    envelope: dict[str, Any],
    ctx: ProjectContext,
) -> dict[str, Any]:
    from novelvideo.api.deps import (
        make_sqlite_store_for_context,
        make_static_url_for_context,
    )
    from novelvideo.freezone.audio_node import generate_freezone_audio_speech
    from novelvideo.freezone.jobs import ensure_freezone_dirs

    payload = envelope.get("payload") or {}
    job_id = str(payload["job_id"])
    project_dir = Path(str(payload.get("project_dir") or ctx.output_dir))
    ensure_freezone_dirs(project_dir)
    _update(ctx, "freezone_audio_speech", job_id, 0.1, "开始文本生成语音...")
    # 音色所需的项目态已在投递时定型放进 payload 时，这里不再回头开项目 SQLite
    # —— 那一步经 `api/deps.py` 的 `require_project_home_node` 把本任务钉在
    # 存放该项目的那台机器上。payload 里没有投射时行为逐字不变。
    projection = read_projection(payload)
    store = None if projection is not None else await make_sqlite_store_for_context(ctx)
    try:
        result = await _call_freezone_leaf(
            envelope,
            generate_freezone_audio_speech,
            "generate_freezone_audio_speech",
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
            projection=projection,
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


def run_freezone_audio_speech(
    envelope: dict[str, Any], ctx: ProjectContext
) -> dict[str, Any]:
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
    result = await _call_freezone_leaf(
        envelope,
        generate_freezone_audio_eleven_music,
        "generate_freezone_audio_eleven_music",
        project_dir=project_dir,
        job_id=job_id,
        prompt=str(payload.get("input") or ""),
        model=str(payload.get("model") or "LingShan-MU-11"),
        response_format=str(payload.get("response_format") or "mp3"),
        music_length_ms=int(payload.get("music_length_ms") or 30_000),
        force_instrumental=bool(payload.get("force_instrumental", True)),
        respect_sections_durations=bool(
            payload.get("respect_sections_durations", True)
        ),
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
    return _run_cancellable(
        envelope, _run_freezone_audio_eleven_music_async(envelope, ctx)
    )


register_project_task_runner("freezone_gen", run_freezone_gen, requires_home_node=False)
register_project_task_runner("freezone_edit", run_freezone_edit, requires_home_node=False)
register_project_task_runner(
    "mainline_sketch_from_context",
    run_mainline_sketch_from_context,
    requires_home_node=False,
)
register_project_task_runner(
    "mainline_frame_from_context",
    run_mainline_frame_from_context,
    requires_home_node=False,
)
register_project_task_runner(
    "mainline_director_control_sketch",
    run_mainline_director_control_sketch,
    requires_home_node=False,
)
register_project_task_runner(
    "freezone_mask_edit", run_freezone_mask_edit, requires_home_node=False
)
register_project_task_runner(
    "freezone_extract", run_freezone_extract, requires_home_node=False
)
register_project_task_runner(
    "freezone_analyze", run_freezone_analyze, requires_home_node=False
)
register_project_task_runner(
    "freezone_video_story", run_freezone_video_story, requires_home_node=False
)
register_project_task_runner(
    "freezone_video_erase", run_freezone_video_erase, requires_home_node=False
)
register_project_task_runner(
    "freezone_video_upscale", run_freezone_video_upscale, requires_home_node=False
)
register_project_task_runner(
    "freezone_audio_separate", run_freezone_audio_separate, requires_home_node=False
)
register_project_task_runner(
    "freezone_video_compose", run_freezone_video_compose, requires_home_node=False
)
register_project_task_runner(
    "freezone_text_translate", run_freezone_text_translate, requires_home_node=False
)
register_project_task_runner(
    "freezone_text_generate", run_freezone_text_generate, requires_home_node=False
)
register_project_task_runner(
    "freezone_story_script", run_freezone_story_script, requires_home_node=False
)
register_project_task_runner(
    "freezone_image_reverse_prompt",
    run_freezone_image_reverse_prompt,
    requires_home_node=False,
)
register_project_task_runner(
    "freezone_audio_speech",
    run_freezone_audio_speech,
    requires_home_node=False,
)
register_project_task_runner(
    "freezone_audio_eleven_music",
    run_freezone_audio_eleven_music,
    requires_home_node=False,
)
