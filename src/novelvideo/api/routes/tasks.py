"""任务列表/状态/终止端点。"""

import asyncio
import json
import logging
from dataclasses import asdict
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, Query, Request
from sse_starlette.sse import EventSourceResponse

from novelvideo.api.auth import (
    get_api_user,
    get_api_user_or_query,
    verify_credential_for_request,
)
from novelvideo.ports import get_project_access, get_task_backend
from novelvideo.project_context import ProjectContext, resolve_project_context
from novelvideo.task_backend.limits import (
    project_lane_effective_active_limit,
    project_user_lane_active_limit,
)
from novelvideo.task_backend.queues import QUEUE_KINDS
from novelvideo.task_identity import project_task_state_key, task_state_key
from novelvideo.task_state import TaskState, get_task_manager, parse_task_timestamp
from novelvideo.utils.static_urls import project_static_url

logger = logging.getLogger("novelvideo.api.tasks")

router = APIRouter()

_SSE_REVERIFY_INTERVAL_S = 30.0
_TASK_NOT_FOUND_GRACE_S = 10.0
_TASK_TYPE_LABELS = {
    "ingest_fast": "快速导入",
    "build_characters": "构建角色",
    "build_scenes": "构建场景",
    "build_props": "构建道具",
    "build_episodes": "规划剧集",
    "identity_planner": "规划身份",
    "script_writer": "生成剧本",
    "beat_video_prompt": "生成提示词",
    "literal_script_writer": "生成解说稿",
    "director_notes": "导演说明",
    "episode_scene_planner": "规划场景",
    "episode_prop_planner": "规划道具",
    "character_portrait": "角色定妆",
    "identity_image": "身份定妆",
    "scene_reference_asset": "场景参考图",
    "prop_reference_asset": "道具参考图",
    "sketch_generation": "生成草图",
    "sketch_regen": "重生成草图",
    "mainline_sketch_from_context": "生成草图",
    "mainline_frame_from_context": "渲染分镜",
    "selected_regen": "重生成选区",
    "grid_regenerate": "重生成网格",
    "single_video": "生成单镜视频",
    "global_optimize_video": "全局优化视频",
    "compose_episode": "合成剧集",
    "audio_generation": "生成音频",
    "indextts2_audio_generation": "生成音频",
    "audio_generation_indextts2": "生成音频",
    "freezone_video_gen": "自由区视频",
    "stage_asset": "场景资产",
    "freezone_gen": "虾画生成",
    "freezone_edit": "虾画编辑",
    "freezone_mask_edit": "局部编辑",
    "freezone_extract": "视频抽帧",
    "freezone_analyze": "视频分析",
    "freezone_video_story": "视频解读",
    "freezone_video_erase": "视频擦除",
    "freezone_video_upscale": "视频放大",
    "freezone_audio_separate": "音频分离",
    "freezone_video_compose": "视频合成",
    "freezone_text_translate": "字幕翻译",
    "freezone_story_script": "生成故事脚本",
    "freezone_script_to_video_plan": "脚本转视频计划",
    "freezone_audio_speech": "生成语音",
    "freezone_audio_eleven_music": "生成音乐",
    "freezone_image_to_3gs": "图片转世界",
    "freezone_image_reverse_prompt": "图片反推提示词",
    "batch_prop_ref": "批量道具参考图",
}
_STAGE_ASSET_STEP_LABELS = {
    "pano_from_master": "Master 生成全景",
    "pano_from_text": "文生全景",
    "pano_sharp": "全景转 SOG",
    "single_face_sharp": "单面转 SOG",
    "voxel_world_from_360": "全景转体素",
    "scene_360": "生成 360 全景",
    "upload_package": "上传场景包",
    "splat_collision": "生成碰撞体",
}


def _effective_task_status(t: TaskState) -> str:
    if (
        t.status in {"submitting", "queued", "running"}
        and t.progress >= 1.0
        and str(t.current_task or "").strip().lower() in {"完成", "completed", "done"}
    ):
        return "completed"
    return t.status


def _serialize_task_timestamp(value: str) -> str:
    parsed = parse_task_timestamp(value)
    if parsed is None:
        return str(value or "")
    return parsed.isoformat().replace("+00:00", "Z")


async def _sse_token_still_valid(request: Request, last_check: float) -> tuple[bool, float]:
    now = asyncio.get_event_loop().time()
    if now - last_check < _SSE_REVERIFY_INTERVAL_S:
        return True, last_check
    try:
        user = await verify_credential_for_request(request)
    except Exception:
        logger.debug("SSE credential recheck failed", exc_info=True)
        return True, last_check
    return (user is not None), now


def _is_result_path_key(key: str) -> bool:
    lowered = str(key or "").lower()
    if lowered in {"path", "paths"}:
        return True
    return lowered.endswith("_path") or lowered.endswith("_paths")


def _url_key_for_path_key(key: str) -> str:
    if key == "path":
        return "url"
    if key == "paths":
        return "urls"
    if key.endswith("_paths"):
        return f"{key[:-6]}_urls"
    if key.endswith("_path"):
        return f"{key[:-5]}_url"
    return "url"


def _is_public_url_value(value: str) -> bool:
    lowered = value.strip().lower()
    return (
        lowered.startswith("/static/")
        or lowered.startswith("http://")
        or lowered.startswith("https://")
        or lowered.startswith("blob:")
        or lowered.startswith("data:")
    )


def _project_static_url_for_abs_path(ctx: ProjectContext, value: str) -> str | None:
    raw = str(value or "").strip()
    if not raw or _is_public_url_value(raw):
        return None
    path = Path(raw)
    if not path.is_absolute():
        return None
    try:
        resolved = path.resolve()
        rel = resolved.relative_to(Path(ctx.output_dir).resolve()).as_posix()
    except (OSError, ValueError):
        return None
    return project_static_url(ctx.project_id, rel, local_path=resolved)


def _is_local_abs_path_value(value: str) -> bool:
    raw = str(value or "").strip()
    return bool(raw) and not _is_public_url_value(raw) and Path(raw).is_absolute()


def _sanitize_task_result_for_client(value: Any, *, ctx: ProjectContext | None) -> Any:
    if ctx is None:
        return value
    if isinstance(value, list):
        return [_sanitize_task_result_for_client(item, ctx=ctx) for item in value]
    if not isinstance(value, dict):
        return value

    sanitized: dict[str, Any] = {}
    for key, item in value.items():
        key_text = str(key)
        if _is_result_path_key(key_text):
            url_key = _url_key_for_path_key(key_text)
            if isinstance(item, str):
                url = _project_static_url_for_abs_path(ctx, item)
                if url:
                    sanitized.setdefault(url_key, url)
                    continue
            if isinstance(item, list):
                urls = [
                    url
                    for url in (
                        _project_static_url_for_abs_path(ctx, path)
                        for path in item
                        if isinstance(path, str)
                    )
                    if url
                ]
                if urls:
                    sanitized.setdefault(url_key, urls)
                    continue
            if isinstance(item, str) and _is_local_abs_path_value(item):
                continue
            if isinstance(item, list) and any(
                isinstance(path, str) and _is_local_abs_path_value(path) for path in item
            ):
                continue
        sanitized[key_text] = _sanitize_task_result_for_client(item, ctx=ctx)
    return sanitized


def _serialize_task(t: TaskState, *, ctx: ProjectContext | None = None) -> dict:
    metadata = t.metadata if isinstance(t.metadata, dict) else {}
    if t.project_id:
        key = project_task_state_key(
            task_type=t.task_type,
            project_id=t.project_id,
            episode=t.episode,
            beat_num=t.beat_num,
            scope=t.scope,
        )
    else:
        key = task_state_key(
            task_type=t.task_type,
            username=t.username,
            project=t.project,
            episode=t.episode,
            beat_num=t.beat_num,
            scope=t.scope,
        )
    task_type_label = _TASK_TYPE_LABELS.get(t.task_type, t.task_type)
    metadata_display_name = str(metadata.get("display_name") or "").strip()
    episode_label = f" · ep{t.episode}" if t.episode else ""
    display_name = metadata_display_name or f"{task_type_label}{episode_label}"
    if t.task_type == "stage_asset":
        scene_name = str(metadata.get("scene_name") or "").strip()
        step = str(metadata.get("step") or "").strip()
        step_label = _STAGE_ASSET_STEP_LABELS.get(step, step)
        display_parts = [task_type_label]
        if scene_name:
            display_parts.append(scene_name)
        if step_label:
            display_parts.append(step_label)
        display_name = " · ".join(display_parts)
    payload = asdict(t)
    for field in ("created_at", "updated_at", "completed_at", "expires_at"):
        payload[field] = _serialize_task_timestamp(payload.get(field, ""))
    payload["result"] = _sanitize_task_result_for_client(payload.get("result"), ctx=ctx)
    payload["status"] = _effective_task_status(t)
    return {
        **payload,
        "error_code": metadata.get("error_code"),
        "task_key": key,
        "task_type_label": task_type_label,
        "display_name": display_name,
    }


def _remaining(limit: int | None, active: int) -> int | None:
    if limit is None:
        return None
    return max(limit - active, 0)


@router.get("/projects/{project}/tasks")
async def list_project_tasks(project: str, user: dict = Depends(get_api_user)):
    """列出单个项目的任务。生产多节点路径由 OpenResty 路由到项目 home node。"""
    ctx = await resolve_project_context(user=user, project_id=project, required_role="viewer")
    mgr = get_task_manager()
    tasks = mgr.list_tasks_for_project(ctx)
    tasks.sort(key=lambda task: task.updated_at or task.created_at or "", reverse=True)
    return {"ok": True, "data": [_serialize_task(t, ctx=ctx) for t in tasks]}


@router.get("/projects/{project}/tasks/limits")
async def get_project_task_limits(project: str, user: dict = Depends(get_api_user)):
    """查询单个项目各队列的项目池和当前用户额度。"""
    ctx = await resolve_project_context(user=user, project_id=project, required_role="viewer")
    mgr = get_task_manager()
    eligible_user_count = await get_project_access().count_project_task_eligible_users(
        project_id=ctx.project_id,
        owner_type=ctx.owner_type,
        owner_id=ctx.owner_id,
    )
    data = {}
    for queue_kind in sorted(QUEUE_KINDS):
        limit = project_lane_effective_active_limit(
            queue_kind,
            eligible_user_count=eligible_user_count,
        )
        active = mgr.count_active_tasks_for_project_lane(ctx, queue_kind)
        user_limit = project_user_lane_active_limit(queue_kind)
        user_active = mgr.count_active_tasks_for_project_user_lane(ctx, queue_kind)
        data[queue_kind] = {
            "limit": limit,
            "active": active,
            "remaining": _remaining(limit, active),
            "user_limit": user_limit,
            "user_active": user_active,
            "user_remaining": _remaining(user_limit, user_active),
        }
    return {"ok": True, "data": data}


@router.delete("/projects/{project}/tasks/completed")
async def clear_project_completed_tasks(project: str, user: dict = Depends(get_api_user)):
    """删除单个项目的已完成任务记录。"""
    ctx = await resolve_project_context(user=user, project_id=project, required_role="editor")
    mgr = get_task_manager()
    deleted = 0
    for t in mgr.list_tasks_for_project(ctx):
        if _effective_task_status(t) == "completed":
            mgr.delete_task_for_project(
                ctx,
                t.task_type,
                t.episode,
                beat_num=t.beat_num,
                scope=t.scope,
            )
            deleted += 1
    return {"ok": True, "data": {"deleted": deleted}}


@router.get("/projects/{project}/tasks/{task_type}/{episode}")
async def get_project_task(
    project: str,
    task_type: str,
    episode: int,
    beat_num: int = Query(None, description="Beat 编号（single_video 等按 beat 区分的任务需要）"),
    scope: str | None = Query(None, description="任务作用域（mode_key、grid_index 等）"),
    user: dict = Depends(get_api_user),
):
    """查询单个项目内指定任务的状态。"""
    ctx = await resolve_project_context(user=user, project_id=project, required_role="viewer")
    mgr = get_task_manager()
    task = mgr.get_task_for_project(ctx, task_type, episode, beat_num=beat_num, scope=scope)
    if not task:
        return {"ok": True, "data": None, "message": "Task not found"}
    return {"ok": True, "data": _serialize_task(task, ctx=ctx)}


@router.get("/projects/{project}/tasks/stream")
async def stream_project_tasks(
    project: str,
    request: Request,
    interval: float = Query(2.0, ge=0.5, le=10.0),
    heartbeat_sec: float = Query(15.0, ge=1.0, le=60.0),
    snapshot: bool = Query(
        True,
        description=(
            "If false, skip initial task_updated burst on connect "
            "(client has already hydrated via GET project tasks)."
        ),
    ),
    user: dict = Depends(get_api_user_or_query),
):
    """项目级 SSE 任务流。OpenResty 可按 project_id 路由到 home node。"""
    ctx = await resolve_project_context(user=user, project_id=project, required_role="viewer")

    async def event_generator():
        mgr = get_task_manager()
        last: dict[str, tuple[str, float, str]] = {}
        last_heartbeat = asyncio.get_event_loop().time()
        last_auth_check = last_heartbeat

        for t in mgr.list_tasks_for_project(ctx):
            payload = _serialize_task(t, ctx=ctx)
            key = payload["task_key"]
            last[key] = (t.status, round(t.progress, 3), t.updated_at)
            if snapshot:
                yield {
                    "event": "task_updated",
                    "data": json.dumps(payload, ensure_ascii=False),
                }

        yield {
            "event": "heartbeat",
            "data": json.dumps({"ts": last_heartbeat}, ensure_ascii=False),
        }

        while True:
            tasks = mgr.list_tasks_for_project(ctx)
            seen: set[str] = set()
            for t in tasks:
                payload = _serialize_task(t, ctx=ctx)
                key = payload["task_key"]
                seen.add(key)
                fp = (t.status, round(t.progress, 3), t.updated_at)
                if last.get(key) != fp:
                    yield {
                        "event": "task_updated",
                        "data": json.dumps(payload, ensure_ascii=False),
                    }
                    last[key] = fp

            for key in list(last.keys()):
                if key not in seen:
                    yield {
                        "event": "deleted",
                        "data": json.dumps({"task_key": key}, ensure_ascii=False),
                    }
                    del last[key]

            now = asyncio.get_event_loop().time()
            if now - last_heartbeat >= heartbeat_sec:
                yield {
                    "event": "heartbeat",
                    "data": json.dumps({"ts": now}, ensure_ascii=False),
                }
                last_heartbeat = now

            still_valid, last_auth_check = await _sse_token_still_valid(request, last_auth_check)
            if not still_valid:
                yield {
                    "event": "auth_revoked",
                    "data": json.dumps({"reason": "credential revoked or expired"}),
                }
                return

            await asyncio.sleep(interval)

    return EventSourceResponse(event_generator())


@router.get("/projects/{project}/tasks/{task_type}/{episode}/stream")
async def stream_project_task(
    project: str,
    task_type: str,
    episode: int,
    request: Request,
    beat_num: int = Query(None),
    scope: str | None = Query(None),
    interval: float = Query(2.0, ge=0.5, le=10.0),
    user: dict = Depends(get_api_user_or_query),
):
    """项目级单任务 SSE 端点。"""
    ctx = await resolve_project_context(user=user, project_id=project, required_role="viewer")

    async def event_generator():
        last_progress = -1.0
        last_task = ""
        last_auth_check = asyncio.get_event_loop().time()
        not_found_deadline = None
        while True:
            still_valid, last_auth_check = await _sse_token_still_valid(request, last_auth_check)
            if not still_valid:
                yield {
                    "event": "auth_revoked",
                    "data": json.dumps({"reason": "credential revoked or expired"}),
                }
                return

            mgr = get_task_manager()
            task = mgr.get_task_for_project(ctx, task_type, episode, beat_num=beat_num, scope=scope)

            if not task:
                import time

                now = time.monotonic()
                if not_found_deadline is None:
                    not_found_deadline = now + _TASK_NOT_FOUND_GRACE_S
                if now < not_found_deadline:
                    await asyncio.sleep(interval)
                    continue
                yield {
                    "event": "error",
                    "data": json.dumps({"error": "Task not found"}, ensure_ascii=False),
                }
                return
            not_found_deadline = None

            effective_status = _effective_task_status(task)
            changed = (task.progress != last_progress) or (task.current_task != last_task)
            is_terminal = effective_status in ("completed", "failed", "cancelled")

            if changed or is_terminal:
                payload = {
                    "status": effective_status,
                    "progress": round(task.progress, 3),
                    "current_task": task.current_task,
                    "logs": task.logs[-100:],
                }
                if is_terminal:
                    payload["result"] = task.result
                    payload["error"] = task.error
                    if isinstance(task.metadata, dict):
                        payload["error_code"] = task.metadata.get("error_code")

                yield {
                    "event": effective_status,
                    "data": json.dumps(payload, ensure_ascii=False),
                }
                last_progress = task.progress
                last_task = task.current_task

            if is_terminal:
                return

            await asyncio.sleep(interval)

    return EventSourceResponse(event_generator())


@router.delete("/projects/{project}/tasks/{task_type}/{episode}")
async def cancel_project_task_route(
    project: str,
    task_type: str,
    episode: int,
    beat_num: int = Query(None, description="Beat 编号（single_video 等按 beat 区分的任务需要）"),
    scope: str | None = Query(None, description="任务作用域（mode_key、grid_index 等）"),
    user: dict = Depends(get_api_user),
):
    """终止单个项目内指定任务。项目任务后端通路；Ray 已废弃。

    没有 Ray fallback 判断 — 当前 runner 实现是 Celery，task_states 里有 task
    就直接走 cancel_project_task(设 Redis 取消 flag + Celery revoke + 标 status)。
    旧版这里有非 Celery backend fallback,每次 task 找不到都会连接旧任务
    backend 产生噪音日志,已删。

    **Mid-flight cooperative cancel 的范围限制**:`cancel_project_task` 会:
      1. 设 Redis cancel flag(等 runner watcher poll)
      2. Celery revoke(terminate=True)(发 SIGTERM 给 worker)
      3. 把 task_state 标 cancelled(UI 看到任务消失)
    其中 (1) 真正中断**已经在 await 外部 API 的 task** 只对**有 watcher 的 runner**
    生效。当前只有 `runners/freezone.py:_run_freezone_gen/edit_async` 用了
    `_await_with_cancel_watch` —— 其他 runner(sketch/render/video/audio 等)
    revoke 后 SIGTERM 不能立即打断 asyncio `await`,会等当前 step 跑完才退出。
    用户体感是"UI 显示已取消,但后端浪费一段算力"。
    扩到其他 runner 是后续 cleanup,加 `_await_with_cancel_watch` 包裹即可。
    """
    ctx = await resolve_project_context(user=user, project_id=project, required_role="editor")
    logger.info(
        "[%s] EP%d cancel_project_task: type=%s, beat=%s, scope=%s",
        project,
        episode,
        task_type,
        beat_num,
        scope,
    )
    mgr = get_task_manager()
    task = mgr.get_task_for_project(ctx, task_type, episode, beat_num=beat_num, scope=scope)
    if not task:
        logger.warning(
            "[%s] cancel_project_task: task not found (type=%s episode=%s beat=%s scope=%s)",
            project,
            task_type,
            episode,
            beat_num,
            scope,
        )
        return {"ok": False, "error": "Task not found"}
    await get_task_backend().cancel_project_task(ctx, task)
    return {"ok": True, "message": "Task cancelled"}
