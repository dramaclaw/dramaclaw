"""分集列表 & 规划 & 身份端点。"""

import logging
from fastapi import APIRouter, Depends

from novelvideo.api.auth import get_api_user
from novelvideo.api.chapter_preview import build_chapter_preview
from novelvideo.api.deps import (
    make_cognee_store,
    make_cognee_store_for_context,
    make_sqlite_store,
    make_sqlite_store_for_context,
    make_static_url_for_context,
    resolve_project_scope,
)
from novelvideo.api.schemas import EpisodePlanRequest, EpisodeUpdate, InsertManualShotRequest
from novelvideo.ports import get_task_backend, get_usage_meter
from novelvideo.task_identity import project_task_state_key

logger = logging.getLogger("novelvideo.api.episodes")

router = APIRouter()
AssetCompiler = None

_EPISODE_ASSET_PLANNER_TASKS = {
    "scene": ("episode_scene_planner", "场景"),
    "prop": ("episode_prop_planner", "道具"),
}


def _dump_episode_items(items):
    data = []
    for item in items or []:
        if hasattr(item, "model_dump"):
            data.append(item.model_dump())
        elif isinstance(item, dict):
            data.append(dict(item))
    return data


def _episode_detail_payload(ep, episode_num: int) -> dict:
    content_summary = getattr(ep, "content_summary", "") or getattr(ep, "summary", "") or ""
    return {
        "number": getattr(ep, "number", episode_num),
        "title": getattr(ep, "title", "") or "",
        "summary": content_summary,
        "raw_content": getattr(ep, "raw_content", "") or "",
        "beat_source_text": getattr(ep, "beat_source_text", "") or "",
        "content_summary": content_summary,
        "character_names": list(getattr(ep, "character_names", []) or []),
        "key_events": list(getattr(ep, "key_events", []) or []),
        "cliffhanger": getattr(ep, "cliffhanger", "") or "",
        "identity_ids": list(getattr(ep, "identity_ids", []) or []),
        "identity_default_map": dict(getattr(ep, "identity_default_map", {}) or {}),
        "scene_menu": _dump_episode_items(getattr(ep, "scene_menu", []) or []),
        "prop_menu": _dump_episode_items(getattr(ep, "prop_menu", []) or []),
    }


def _asset_compiler_cls():
    global AssetCompiler
    if AssetCompiler is None:
        from novelvideo.agents.asset_compiler import AssetCompiler as LoadedAssetCompiler

        AssetCompiler = LoadedAssetCompiler
    return AssetCompiler


def _episode_asset_task_scope(asset_kind: str, episode_num: int) -> str:
    return f"{asset_kind}_run_ep{int(episode_num):03d}"


def _find_episode(episodes, episode_num: int):
    for ep in episodes or []:
        if getattr(ep, "number", None) == episode_num:
            return ep
    return None


async def _plan_episode_assets(
    project: str,
    episode_num: int,
    asset_kind: str,
    user: dict,
):
    resolved = await resolve_project_scope(project, user, required_role="editor")
    await get_usage_meter().set_project_llm_usage_context(
        username=resolved.username,
        project_name=resolved.project_name,
        resource_kind="script",
    )

    store = (
        await make_cognee_store_for_context(resolved.ctx)
        if resolved.ctx
        else await make_cognee_store(resolved.username, resolved.project_name)
    )
    if store is None:
        return {"ok": False, "error": "CogneeStore initialization failed"}

    await store.load_graph_state()
    episode = _find_episode(store.get_all_episodes(), episode_num)
    if episode is None:
        return {"ok": False, "error": f"Episode {episode_num} not found"}

    logs: list[str] = []

    def log_fn(message: str) -> None:
        logs.append(message)

    compiler = _asset_compiler_cls()(store)
    try:
        if asset_kind == "scene":
            scene_menu, new_count = await compiler.compile_episode_scenes(episode, on_log=log_fn)
            episode = _find_episode(store.get_all_episodes(), episode_num) or episode
            scene_menu_data = _dump_episode_items(scene_menu)
            return {
                "ok": True,
                "data": {
                    "kind": "scene",
                    "total_count": len(scene_menu_data),
                    "new_count": new_count,
                    "scene_menu": scene_menu_data,
                    "episode": _episode_detail_payload(episode, episode_num),
                    "logs": logs,
                },
            }

        if asset_kind == "prop":
            from novelvideo.services.prop_promotion_service import (
                promote_episode_props_to_global,
            )

            prop_menu = await compiler.compile_episode_props(episode, on_log=log_fn)
            promoted_props = await promote_episode_props_to_global(store, prop_menu)
            episode = _find_episode(store.get_all_episodes(), episode_num) or episode
            prop_menu_data = _dump_episode_items(prop_menu)
            return {
                "ok": True,
                "data": {
                    "kind": "prop",
                    "total_count": len(prop_menu_data),
                    "auto_promoted_props": promoted_props,
                    "prop_menu": prop_menu_data,
                    "episode": _episode_detail_payload(episode, episode_num),
                    "logs": logs,
                },
            }
    except ValueError as e:
        return {"ok": False, "error": str(e)}

    return {"ok": False, "error": f"Unknown asset planning kind: {asset_kind}"}


async def _enqueue_episode_asset_planner(
    project: str,
    episode_num: int,
    asset_kind: str,
    user: dict,
) -> dict:
    task_info = _EPISODE_ASSET_PLANNER_TASKS.get(asset_kind)
    if task_info is None:
        return {"ok": False, "error": f"Unknown asset planning kind: {asset_kind}"}
    task_type, label = task_info
    resolved = await resolve_project_scope(project, user, required_role="editor")
    if resolved.ctx is None:
        return await _plan_episode_assets(
            project=project,
            episode_num=episode_num,
            asset_kind=asset_kind,
            user=user,
        )
    task_scope = _episode_asset_task_scope(asset_kind, episode_num)
    queued = await get_task_backend().enqueue_project_task(
        resolved.ctx,
        task_type=task_type,
        queue_kind="default",
        episode=episode_num,
        scope=task_scope,
        payload={"episode": episode_num, "asset_kind": asset_kind},
    )
    return {
        "ok": True,
        "task_type": task_type,
        "scope": task_scope,
        "task_id": queued.task_state.task_id,
        "task_key": project_task_state_key(
            task_type,
            resolved.ctx.project_id,
            episode_num,
            scope=task_scope,
        ),
        "backend": queued.backend,
        "queue": queued.queue,
        "data": {"target_episode": episode_num, "asset_kind": asset_kind},
        "message": f"第 {episode_num} 集{label}规划已进入队列",
    }


@router.get("/projects/{project}/episodes")
async def list_episodes(project: str, user: dict = Depends(get_api_user)):
    """获取项目分集列表。"""
    resolved = await resolve_project_scope(project, user, required_role="viewer")

    store = (
        await make_sqlite_store_for_context(resolved.ctx)
        if resolved.ctx
        else await make_sqlite_store(resolved.username, resolved.project_name)
    )
    episodes = store.get_all_episodes()

    data = []
    for ep in episodes:
        data.append(
            {
                "number": ep.number if hasattr(ep, "number") else 0,
                "title": ep.title if hasattr(ep, "title") else "",
                "summary": (getattr(ep, "content_summary", "") or getattr(ep, "summary", "") or ""),
                "identity_ids": list(getattr(ep, "identity_ids", []) or []),
                "key_events": list(getattr(ep, "key_events", []) or []),
                "scene_menu": _dump_episode_items(getattr(ep, "scene_menu", []) or []),
                "prop_menu": _dump_episode_items(getattr(ep, "prop_menu", []) or []),
            }
        )

    return {"ok": True, "data": data}


@router.post("/projects/{project}/episodes/plan")
async def plan_episodes(project: str, body: EpisodePlanRequest, user: dict = Depends(get_api_user)):
    """规划分集。"""
    logger.info(
        "[%s] plan_episodes: target=%d, mode=%s",
        project,
        body.target_episodes,
        body.planning_mode,
    )
    resolved = await resolve_project_scope(project, user, required_role="editor")
    ctx = resolved.ctx
    output_dir = resolved.output_dir
    state_dir = resolved.state_dir

    config = {
        "target_episodes": body.target_episodes,
        "planning_mode": body.planning_mode,
    }

    if ctx is not None:
        queued = await get_task_backend().enqueue_project_task(
            ctx,
            task_type="build_episodes",
            queue_kind="default",
            episode=0,
            payload={"config": config, "output_dir": output_dir, "state_dir": state_dir},
        )
        return {
            "ok": True,
            "task_type": "build_episodes",
            "task_id": queued.task_state.task_id,
            "task_key": project_task_state_key("build_episodes", ctx.project_id, 0),
            "backend": queued.backend,
            "queue": queued.queue,
            "message": f"分集规划任务已进入队列 (目标 {body.target_episodes} 集)",
        }

    return {"ok": False, "error": "分集规划需要 project context"}


@router.get("/projects/{project}/episodes/{episode_num}")
async def get_episode_detail(project: str, episode_num: int, user: dict = Depends(get_api_user)):
    """获取指定集的完整详情。"""
    resolved = await resolve_project_scope(project, user, required_role="viewer")

    store = (
        await make_sqlite_store_for_context(resolved.ctx)
        if resolved.ctx
        else await make_sqlite_store(resolved.username, resolved.project_name)
    )
    episode = store.get_episode(episode_num)
    if episode is None:
        return {"ok": False, "error": f"Episode {episode_num} not found"}

    return {"ok": True, "data": _episode_detail_payload(episode, episode_num)}


@router.get("/projects/{project}/episodes/{episode_num}/beats")
async def get_beats(project: str, episode_num: int, user: dict = Depends(get_api_user)):
    """获取指定集数的 beats。"""
    resolved = await resolve_project_scope(project, user, required_role="viewer")
    project_dir = resolved.project_dir

    # 从图谱读取 beats（统一数据源）
    store = (
        await make_sqlite_store_for_context(resolved.ctx)
        if resolved.ctx
        else await make_sqlite_store(resolved.username, resolved.project_name)
    )
    beats = await store.get_beats_as_dicts(episode_num)

    # 为每个 beat 附加 sketch_url / frame_url / video_url / audio_url.
    # Asset files are named by beat_number. Do not use enumerate index here:
    # manually inserted shots can have sparse/non-display-order beat numbers.
    sketches_dir = project_dir / "sketches" / f"ep{episode_num:03d}"
    frames_dir = project_dir / "frames" / f"ep{episode_num:03d}"
    videos_dir = project_dir / "videos" / "beats" / f"ep{episode_num:03d}"
    audio_dir = project_dir / "audio" / f"ep{episode_num:03d}"
    # 收集已存在的音频，循环后并发探测时长，供前端时长控件做默认值/下限（视频时长须 >= 音频）。
    audio_duration_jobs: list[tuple[dict, str]] = []
    for beat in beats:
        beat["audio_duration_seconds"] = None
        beat_num = int(beat.get("beat_number", 0) or 0)
        if beat_num <= 0:
            beat["sketch_url"] = ""
            beat["frame_url"] = ""
            beat["video_url"] = ""
            beat["audio_url"] = ""
            continue
        # sketch
        sketch_file = f"beat_{beat_num:02d}.png"
        if (sketches_dir / sketch_file).exists():
            rel = f"sketches/ep{episode_num:03d}/{sketch_file}"
            beat["sketch_url"] = make_static_url_for_context(
                resolved.ctx,
                rel,
                local_path=sketches_dir / sketch_file,
            )
        else:
            beat["sketch_url"] = ""
        # frame
        frame_file = f"beat_{beat_num:02d}.png"
        if (frames_dir / frame_file).exists():
            rel = f"frames/ep{episode_num:03d}/{frame_file}"
            beat["frame_url"] = make_static_url_for_context(
                resolved.ctx, rel, local_path=frames_dir / frame_file
            )
        else:
            beat["frame_url"] = ""
        # video
        video_file = f"beat_{beat_num:02d}.mp4"
        if (videos_dir / video_file).exists():
            rel = f"videos/beats/ep{episode_num:03d}/{video_file}"
            beat["video_url"] = make_static_url_for_context(
                resolved.ctx, rel, local_path=videos_dir / video_file
            )
        else:
            beat["video_url"] = ""
        # audio
        audio_file = f"beat_{beat_num:02d}.mp3"
        if (audio_dir / audio_file).exists():
            rel = f"audio/ep{episode_num:03d}/{audio_file}"
            beat["audio_url"] = make_static_url_for_context(
                resolved.ctx, rel, local_path=audio_dir / audio_file
            )
            audio_duration_jobs.append((beat, str(audio_dir / audio_file)))
        else:
            beat["audio_url"] = ""

    if audio_duration_jobs:
        import asyncio

        from novelvideo.utils.media_io import get_audio_duration_async

        durations = await asyncio.gather(
            *(get_audio_duration_async(path) for _, path in audio_duration_jobs),
            return_exceptions=True,
        )
        for (beat, _), value in zip(audio_duration_jobs, durations):
            if isinstance(value, (int, float)) and value > 0:
                beat["audio_duration_seconds"] = float(value)

    return {"ok": True, "data": beats}


@router.delete("/projects/{project}/episodes/{episode_num}/beats/{beat_number}/manual-shot")
async def delete_manual_shot_route(
    project: str,
    episode_num: int,
    beat_number: int,
    user: dict = Depends(get_api_user),
):
    """删除手工插入的 beat。普通主流程 beat 不允许从这里删。"""
    resolved = await resolve_project_scope(project, user, required_role="editor")

    from novelvideo.manual_shots import delete_manual_shot

    store = (
        await make_sqlite_store_for_context(resolved.ctx)
        if resolved.ctx
        else await make_sqlite_store(resolved.username, resolved.project_name)
    )
    logger.info("[%s] EP%d delete_manual_shot beat=%d", project, episode_num, beat_number)
    try:
        beats = await delete_manual_shot(
            store,
            episode_number=episode_num,
            beat_number=beat_number,
        )
    except ValueError as e:
        return {"ok": False, "error": str(e)}

    return {"ok": True, "data": {"beats": beats}}


@router.post("/projects/{project}/episodes/{episode_num}/beats/insert-manual")
async def insert_manual_shot_route(
    project: str,
    episode_num: int,
    body: InsertManualShotRequest,
    user: dict = Depends(get_api_user),
):
    """插入手工 beat；after_beat_number=None 表示插到第一张前。"""
    resolved = await resolve_project_scope(project, user, required_role="editor")

    visual_description = (body.visual_description or "").strip()
    if not visual_description:
        return {"ok": False, "error": "visual_description 不能为空"}

    from novelvideo.manual_shots import insert_manual_shot

    store = (
        await make_sqlite_store_for_context(resolved.ctx)
        if resolved.ctx
        else await make_sqlite_store(resolved.username, resolved.project_name)
    )
    scene_ref = body.scene_ref.model_dump(exclude_none=True) if body.scene_ref else None
    logger.info(
        "[%s] EP%d insert_manual_shot: after=%s, has_scene_ref=%s",
        project,
        episode_num,
        body.after_beat_number,
        bool(scene_ref),
    )
    try:
        new_beat = await insert_manual_shot(
            store,
            episode_number=episode_num,
            after_beat_number=body.after_beat_number,
            visual_description=visual_description,
            duration_seconds=body.duration_seconds,
            scene_ref=scene_ref,
            time_of_day=body.time_of_day,
            detected_identities=body.detected_identities,
            detected_props=body.detected_props,
            audio_type=body.audio_type,
            speaker=body.speaker,
            narration_segment=body.narration_segment,
        )
    except ValueError as e:
        return {"ok": False, "error": str(e)}

    return {"ok": True, "data": new_beat}


@router.post("/projects/{project}/episodes/{episode_num}/identities/plan")
async def plan_episode_identities(
    project: str, episode_num: int, user: dict = Depends(get_api_user)
):
    """规划单集角色身份。"""
    logger.info("[%s] EP%d plan_episode_identities", project, episode_num)
    resolved = await resolve_project_scope(project, user, required_role="editor")
    if resolved.ctx is not None:
        queued = await get_task_backend().enqueue_project_task(
            resolved.ctx,
            task_type="identity_planner",
            queue_kind="default",
            episode=episode_num,
            payload={"episode": episode_num},
        )
        return {
            "ok": True,
            "task_type": "identity_planner",
            "task_id": queued.task_state.task_id,
            "task_key": project_task_state_key(
                "identity_planner", resolved.ctx.project_id, episode_num
            ),
            "backend": queued.backend,
            "queue": queued.queue,
            "data": {"target_episode": episode_num},
            "message": f"第 {episode_num} 集身份规划已进入队列",
        }

    await get_usage_meter().set_project_llm_usage_context(
        username=resolved.username,
        project_name=resolved.project_name,
        resource_kind="portrait",
    )

    store = (
        await make_cognee_store_for_context(resolved.ctx)
        if resolved.ctx
        else await make_cognee_store(resolved.username, resolved.project_name)
    )
    await store.load_graph_state()
    episodes = store.get_all_episodes()

    episode = None
    for ep in episodes:
        if ep.number == episode_num:
            episode = ep
            break

    if episode is None:
        return {"ok": False, "error": f"Episode {episode_num} not found"}

    from novelvideo.agents.identity_planner import IdentityPlanner

    planner = IdentityPlanner(store)
    logs = []
    new_count, resolved_count = await planner.plan_single_episode(
        episode, on_log=lambda msg: logs.append(msg)
    )
    episode = _find_episode(store.get_all_episodes(), episode_num) or episode

    # 收集身份信息
    characters = store.get_all_characters()
    identities = []
    for c in characters:
        if not hasattr(c, "identities"):
            continue
        for ident in c.identities:
            if hasattr(ident, "identity_id") and ident.identity_id in (episode.identity_ids or []):
                identity_name = (
                    ident.identity_id.split("_", 1)[-1]
                    if "_" in ident.identity_id
                    else ident.identity_id
                )
                appearance_details = (
                    ident.appearance_details if hasattr(ident, "appearance_details") else ""
                )
                identities.append(
                    {
                        "character_name": c.name,
                        "identity_id": ident.identity_id,
                        "identity_name": identity_name,
                        "appearance_details": appearance_details,
                    }
                )

    return {
        "ok": True,
        "task_type": "identity_planner",
        "data": {"target_episode": episode_num},
        "message": f"第 {episode_num} 集身份规划任务已启动",
    }


@router.post("/projects/{project}/episodes/{episode_num}/identities/plan-async")
async def plan_episode_identities_async(
    project: str, episode_num: int, user: dict = Depends(get_api_user)
):
    """兼容 1.0/旧前端的异步身份规划入口。"""
    return await plan_episode_identities(project=project, episode_num=episode_num, user=user)


@router.post("/projects/{project}/episodes/{episode_num}/scenes/plan")
async def plan_episode_scenes(project: str, episode_num: int, user: dict = Depends(get_api_user)):
    """规划单集场景菜单。"""
    logger.info("[%s] EP%d plan_episode_scenes", project, episode_num)
    return await _enqueue_episode_asset_planner(
        project=project,
        episode_num=episode_num,
        asset_kind="scene",
        user=user,
    )


@router.post("/projects/{project}/episodes/{episode_num}/props/plan")
async def plan_episode_props(project: str, episode_num: int, user: dict = Depends(get_api_user)):
    """规划单集道具菜单。"""
    logger.info("[%s] EP%d plan_episode_props", project, episode_num)
    return await _enqueue_episode_asset_planner(
        project=project,
        episode_num=episode_num,
        asset_kind="prop",
        user=user,
    )


@router.patch("/projects/{project}/episodes/{episode_num}")
async def update_episode(
    project: str,
    episode_num: int,
    body: EpisodeUpdate,
    user: dict = Depends(get_api_user),
):
    """编辑指定集的元数据。"""
    resolved = await resolve_project_scope(project, user, required_role="editor")

    store = (
        await make_sqlite_store_for_context(resolved.ctx)
        if resolved.ctx
        else await make_sqlite_store(resolved.username, resolved.project_name)
    )

    # 确认集数存在
    episode = store.get_episode(episode_num)
    if episode is None:
        return {"ok": False, "error": f"Episode {episode_num} not found"}

    updates = body.model_dump(exclude_none=True)
    if not updates:
        return {"ok": True, "data": {"message": "No fields to update"}}

    await store.update_episode(episode_num, **updates)

    # 返回更新后的集信息
    ep = store.get_episode(episode_num)
    return {"ok": True, "data": _episode_detail_payload(ep, episode_num)}


@router.get("/projects/{project}/chapters")
async def detect_chapters(project: str, user: dict = Depends(get_api_user)):
    """检测已上传小说的章节结构。"""
    resolved = await resolve_project_scope(project, user, required_role="viewer")

    store = (
        await make_sqlite_store_for_context(resolved.ctx)
        if resolved.ctx
        else await make_sqlite_store(resolved.username, resolved.project_name)
    )
    novel_text = store.load_novel_content()
    if not novel_text:
        return {"ok": False, "error": "No novel file found. Upload a novel first."}

    return {
        "ok": True,
        "data": build_chapter_preview(novel_text),
    }
