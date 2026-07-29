"""流水线聚合状态端点。"""

from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, Query
from starlette.concurrency import run_in_threadpool

from novelvideo.api.auth import get_api_user
from novelvideo.api.deps import get_sqlite_store, resolve_project_scope
from novelvideo.sqlite_store import SQLiteStore
from novelvideo.task_state import get_task_manager
from novelvideo.utils.path_resolver import compute_identity_path, compute_portrait_path

router = APIRouter()


_STEP_MAP = {
    "ingest": ("ingest_fast", "小说摄入"),
    "configure": (None, "配置项目"),
    "characters": ("build_characters", "角色提取"),
    "episodes": ("build_episodes", "分集规划"),
    "portraits": (None, "肖像生成"),
    "identity_plan": (None, "身份规划"),
    "identity_images": (None, "身份图生成"),
    "script": ("script_writer", "脚本生成"),
    "sketches": ("sketch_generation", "草图生成"),
    "coloring": (None, "配色+身份/道具检测"),
    "global_optimize": ("global_optimize_video", "全局视频优化"),
    "first_frames": ("selected_regen", "首帧生成"),
    "tts": (None, "TTS 配音"),
    "video": ("single_video", "视频生成"),
    "compose": ("compose_episode", "合成导出"),
    "done": (None, "全部完成"),
}


def _all_or_empty(items: list[bool]) -> bool:
    return bool(items) and all(items)


def _user_has_configured(username: str, project: str) -> bool:
    from novelvideo.project_config import load_project_config

    config = load_project_config(username, project)
    return bool(config.get("ethnicity") or config.get("narration_style"))


def _file_series_complete(directory: Path, suffix: str, count: int) -> bool:
    if count <= 0:
        return False
    return all((directory / f"beat_{i + 1:02d}.{suffix}").exists() for i in range(count))


def _beat_file_series_complete(directory: Path, suffix: str, beats: list[dict]) -> bool:
    beat_numbers = [
        int(beat.get("beat_number", 0) or 0)
        for beat in beats
        if int(beat.get("beat_number", 0) or 0) > 0
    ]
    if not beat_numbers:
        return False
    return all((directory / f"beat_{beat_num:02d}.{suffix}").exists() for beat_num in beat_numbers)


def _beat_has_script_content(beat: dict) -> bool:
    return bool(
        str(beat.get("narration_segment") or "").strip()
        or str(beat.get("narration") or "").strip()
        or str(beat.get("visual_description") or "").strip()
    )


@router.get("/projects/{project}/pipeline/status")
async def pipeline_status(
    project: str,
    episode: Optional[int] = Query(None, description="指定集数，不传则自动检测最新活跃集"),
    user: dict = Depends(get_api_user),
    store: SQLiteStore = Depends(get_sqlite_store),
):
    resolved = await resolve_project_scope(project, user, required_role="viewer")
    username = resolved.username
    project_name = resolved.project_name
    project_dir = resolved.project_dir
    mgr = get_task_manager()

    characters = store.get_all_characters()
    episodes = store.get_all_episodes()
    main_chars = [c for c in characters if getattr(c, "is_main", False)]

    ingest_task = (
        await run_in_threadpool(
            mgr.get_task_for_project,
            resolved.ctx,
            "ingest_fast",
            0,
        )
        if resolved.ctx
        else await run_in_threadpool(
            mgr.get_task,
            "ingest_fast",
            username,
            project_name,
            0,
        )
    )
    ingested = (
        bool(ingest_task and ingest_task.status == "completed")
        or bool(characters)
        or bool(episodes)
    )
    configured = _user_has_configured(username, project_name)
    portraits_done = bool(main_chars) and all(
        bool(compute_portrait_path(project_dir, c.name)) for c in main_chars
    )

    global_status = {
        "ingested": ingested,
        "configured": configured,
        "characters": len(characters),
        "episodes": len(episodes),
        "portraits_done": portraits_done,
    }

    if not (ingested and configured and characters and episodes and portraits_done):
        if not ingested:
            next_step = "ingest"
        elif not configured:
            next_step = "configure"
        elif not characters:
            next_step = "characters"
        elif not episodes:
            next_step = "episodes"
        else:
            next_step = "portraits"
        task_type, step_name = _STEP_MAP[next_step]
        return {
            "ok": True,
            "data": {
                "project": project,
                "global": global_status,
                "current_episode": None,
                "episode_status": None,
                "next_step": task_type or next_step,
                "next_step_name": step_name,
            },
        }

    target_ep = episode
    if target_ep is None:
        unfinished = [
            ep.number
            for ep in sorted(episodes, key=lambda item: getattr(item, "number", 0))
            if not (project_dir / "videos" / "episodes" / f"ep{ep.number:03d}_final.mp4").exists()
        ]
        target_ep = unfinished[0] if unfinished else max((ep.number for ep in episodes), default=1)

    target_episode = store.get_episode(target_ep)
    identity_ids = set(getattr(target_episode, "identity_ids", []) or [])
    has_identity_plan = bool(identity_ids)
    has_identity_images = has_identity_plan
    if has_identity_plan:
        for char in main_chars:
            for ident in getattr(char, "identities", []) or []:
                if ident.identity_id not in identity_ids:
                    continue
                if not compute_identity_path(project_dir, char.name, ident.identity_name):
                    has_identity_images = False

    beats = await store.get_beats_as_dicts(target_ep)
    has_script = _all_or_empty([_beat_has_script_content(b) for b in beats])

    grids_dir = project_dir / "grids" / f"ep{target_ep:03d}"
    sketches_dir = project_dir / "sketches" / f"ep{target_ep:03d}"
    has_sketches = bool(list(grids_dir.glob("*.png"))) or bool(list(sketches_dir.glob("*.png")))

    has_coloring = has_sketches and _all_or_empty(
        [
            b.get("detected_identities") is not None or b.get("detected_props") is not None
            for b in beats
        ]
    )
    has_global_optimize = _all_or_empty(
        [bool(b.get("video_mode")) and bool(b.get("video_prompt")) for b in beats]
    )

    episode_status = {
        "identity_plan": has_identity_plan,
        "identity_images": has_identity_images,
        "script": has_script,
        "sketches": has_sketches,
        "coloring": has_coloring,
        "global_optimize": has_global_optimize,
        "first_frames": _beat_file_series_complete(
            project_dir / "frames" / f"ep{target_ep:03d}", "png", beats
        ),
        "tts": _beat_file_series_complete(
            project_dir / "audio" / f"ep{target_ep:03d}", "mp3", beats
        ),
        "video": _beat_file_series_complete(
            project_dir / "videos" / "beats" / f"ep{target_ep:03d}", "mp4", beats
        ),
    }

    next_step = "done"
    for key in (
        "identity_plan",
        "identity_images",
        "script",
        "sketches",
        "coloring",
        "global_optimize",
        "first_frames",
        "tts",
        "video",
    ):
        if not episode_status[key]:
            next_step = key
            break
    if (
        next_step == "done"
        and not (project_dir / "videos" / "episodes" / f"ep{target_ep:03d}_final.mp4").exists()
    ):
        next_step = "compose"

    task_type, step_name = _STEP_MAP[next_step]
    return {
        "ok": True,
        "data": {
            "project": project,
            "global": global_status,
            "current_episode": target_ep,
            "episode_status": episode_status,
            "next_step": task_type or next_step,
            "next_step_name": step_name,
        },
    }
