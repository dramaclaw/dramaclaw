from __future__ import annotations

import json
import os
import sqlite3
from pathlib import Path
from urllib.parse import urlencode, urlparse

from novelvideo.utils.path_resolver import PathResolver
from novelvideo.director_world.paths import fs_url

from .paths import (
    actor_state_registry_path,
    blockings_dir,
    shape_hint_registry_path,
    shape_hints_dir,
    scene_gaussian_splat_collision_glb_path,
    scene_gaussian_splat_ply_path,
    session_id,
    session_target_name,
    states_dir,
    world_path,
)

DEFAULT_DIRECTOR_VIEWER_ORIGIN = "http://127.0.0.1:9024"
DIRECTOR_STAGE_PATH = "/app/viewer/supertale_director_stage.html"
PLAYCANVAS_3GS_STAGE_PATH = "/app/viewer/supertale_playcanvas_3gs_stage.html"
DEFAULT_DIRECTOR_EDITOR_URL = f"{DEFAULT_DIRECTOR_VIEWER_ORIGIN}{DIRECTOR_STAGE_PATH}"
DEFAULT_PLAYCANVAS_3GS_STAGE_URL = f"{DEFAULT_DIRECTOR_VIEWER_ORIGIN}{PLAYCANVAS_3GS_STAGE_PATH}"


def _configured_director_viewer_origin() -> str:
    for env_name in ("DIRECTOR_VIEWER_URL", "VITE_DIRECTOR_VIEWER_URL"):
        raw = str(os.environ.get(env_name) or "").strip()
        if not raw:
            continue
        parsed = urlparse(raw if "://" in raw else f"http://{raw}")
        if parsed.scheme in {"http", "https"} and parsed.netloc:
            return f"{parsed.scheme}://{parsed.netloc}"
    return DEFAULT_DIRECTOR_VIEWER_ORIGIN


def _director_viewer_url(path: str) -> str:
    return f"{_configured_director_viewer_origin()}{path}"


def _db_path_for(user: str, project: str) -> Path:
    from novelvideo.config import STATE_DIR

    return Path(STATE_DIR).resolve() / user / project / "data.db"


def _scene_beat_numbers(user: str, project: str, episode: int, scene_id: str) -> list[int]:
    db = _db_path_for(user, project)
    if not db.exists():
        return []
    target = str(scene_id or "").strip()
    if not target:
        return []
    try:
        with sqlite3.connect(f"file:{db}?mode=ro", uri=True) as conn:
            cur = conn.execute(
                "SELECT beat_number, scene_ref_json FROM beats "
                "WHERE episode_number=? "
                "ORDER BY COALESCE(shot_order, beat_number * 10), beat_number",
                (int(episode),),
            )
            rows = cur.fetchall()
    except sqlite3.DatabaseError:
        return []
    out: list[int] = []
    for bn, scene_ref in rows:
        if not scene_ref:
            continue
        try:
            ref = json.loads(scene_ref)
        except json.JSONDecodeError:
            continue
        name = ""
        if isinstance(ref, dict):
            name = str(ref.get("scene_id") or ref.get("base_id") or "").strip()
        elif isinstance(ref, str):
            name = ref.strip()
        if name == target:
            try:
                out.append(int(bn))
            except (TypeError, ValueError):
                continue
    return out


def _add_scene_3gs_ply_params(params: dict[str, str], project_dir: Path, scene_id: str) -> None:
    from . import stage_manifest

    for kind, param_name in (
        ("master", "scene_3gs_master_ply_fs"),
        ("reverse", "scene_3gs_reverse_ply_fs"),
        ("custom", "scene_3gs_custom_fs"),
        ("pano", "scene_3gs_pano_ply_fs"),
    ):
        kind_ply = stage_manifest.resolve_ply_path(project_dir, scene_id, ply_kind=kind)
        if kind_ply is not None:
            params[param_name] = fs_url(kind_ply)


class DirectorWorldService:
    """Build canonical DirectorWorld paths and scene-mode editor URLs."""

    def __init__(
        self,
        project_dir: Path,
        editor_url: str | None = None,
        playcanvas_3gs_url: str | None = None,
    ):
        self.project_dir = Path(project_dir)
        self.editor_url = editor_url or _director_viewer_url(DIRECTOR_STAGE_PATH)
        self.playcanvas_3gs_url = playcanvas_3gs_url or _director_viewer_url(
            PLAYCANVAS_3GS_STAGE_PATH
        )

    def world_path(self, scene_id: str) -> Path:
        return world_path(self.project_dir, scene_id)

    def blockings_dir(self, episode: int) -> Path:
        return blockings_dir(self.project_dir, episode)

    def session_id(self, *, user: str, project: str, episode: int, scene_id: str) -> str:
        return session_id(user, project, episode, scene_id)

    def session_target_name(self, *, user: str, project: str, episode: int, scene_id: str) -> str:
        return session_target_name(
            self.session_id(
                user=user,
                project=project,
                episode=episode,
                scene_id=scene_id,
            )
        )

    def make_editor_url(
        self,
        *,
        episode: int,
        scene_id: str,
        user: str,
        project: str,
        slate_beat: int | None = None,
        world_url: str = "",
        beat_nav_fs: str = "",
    ) -> str:
        world = self.world_path(scene_id)
        blockings = self.blockings_dir(episode)
        control_frames_dir = self.project_dir / "director_control_frames"
        params = {
            "scene_id": scene_id,
            "display_name": scene_id,
            "scope": "scene",
            "episode": str(int(episode)),
            "session_id": self.session_id(
                user=user,
                project=project,
                episode=episode,
                scene_id=scene_id,
            ),
            "save_fs": fs_url(world),
            "world_fs": fs_url(world),
            "regen_world_fs": fs_url(world),
            "blockings_dir_fs": fs_url(blockings),
            "control_frames_dir_fs": fs_url(control_frames_dir),
            "sketch_mode_key": "1x1_2-3_sketch",
            "sketch_aspect_ratio": "2:3",
            "shape_hint_registry_fs": fs_url(shape_hint_registry_path()),
            "shape_hints_dir_fs": fs_url(shape_hints_dir()),
            "actor_state_registry_fs": fs_url(actor_state_registry_path()),
            "actor_states_dir_fs": fs_url(states_dir()),
        }
        scene_3gs_ply = scene_gaussian_splat_ply_path(self.project_dir, scene_id)
        if scene_3gs_ply:
            params["scene_3gs_ply_fs"] = fs_url(scene_3gs_ply)
        _add_scene_3gs_ply_params(params, self.project_dir, scene_id)
        scene_collision_glb = scene_gaussian_splat_collision_glb_path(
            self.project_dir,
            scene_id,
            scene_3gs_ply,
        )
        if scene_collision_glb:
            params["scene_collision_glb_fs"] = fs_url(scene_collision_glb)
        if slate_beat is not None:
            params["slate_beat"] = str(int(slate_beat))
        beats = _scene_beat_numbers(user, project, episode, scene_id)
        if beats:
            params["slate_beats"] = ",".join(str(b) for b in beats)
        if beat_nav_fs:
            params["beat_nav_fs"] = beat_nav_fs
        if world_url:
            params["world"] = world_url
        return f"{self.editor_url}?{urlencode(params)}"

    def make_3gs_editor_url(
        self,
        *,
        episode: int,
        scene_id: str,
        user: str,
        project: str,
        slate_beat: int | None = None,
        beat_nav_fs: str = "",
        control_frames_dir: Path | None = None,
    ) -> str | None:
        """Build PlayCanvas 3GS stage URL. Returns None when manifest / PLY not ready.

        Carries beat-level context (blockings_dir_fs / control_frames_dir_fs)
        so the new stage can load + save current beat state and dump control frames
        once Sprint B2 / C wire up.
        """
        from . import stage_manifest

        manifest = stage_manifest.load_manifest(self.project_dir, scene_id)
        if not manifest:
            return None
        ply_path = stage_manifest.resolve_ply_path(self.project_dir, scene_id)
        if ply_path is None:
            return None
        collision_path = stage_manifest.resolve_collision_glb_path(self.project_dir, scene_id)

        blockings = self.blockings_dir(episode)
        control_frames_dir = control_frames_dir or (self.project_dir / "director_control_frames")

        params: dict[str, str] = {
            "scene_id": scene_id,
            "display_name": scene_id,
            "scope": "beat" if slate_beat is not None else "scene_viewer",
            "episode": str(int(episode)),
            "session_id": self.session_id(
                user=user,
                project=project,
                episode=episode,
                scene_id=scene_id,
            ),
            "user": user,
            "project": project,
            # 资产
            "scene_3gs_ply_fs": fs_url(ply_path),
            "ply_source": "master",
            # beat 级状态：让 PlayCanvas 能 load/save 当前 beat
            "blockings_dir_fs": fs_url(blockings),
            # 控制图保存目标（Sprint C 用，PlayCanvas 拼具体 .png 文件名）
            "control_frames_dir_fs": fs_url(control_frames_dir),
            "sketch_mode_key": "1x1_2-3_sketch",
            "sketch_aspect_ratio": "2:3",
            # 给 stage 用：shape_hint / actor_state registry 沿用 voxel stage 的位置
            "shape_hint_registry_fs": fs_url(shape_hint_registry_path()),
            "shape_hints_dir_fs": fs_url(shape_hints_dir()),
            "actor_state_registry_fs": fs_url(actor_state_registry_path()),
            "actor_states_dir_fs": fs_url(states_dir()),
        }
        _add_scene_3gs_ply_params(params, self.project_dir, scene_id)
        if collision_path is not None:
            params["scene_collision_glb_fs"] = fs_url(collision_path)
        if slate_beat is not None:
            params["slate_beat"] = str(int(slate_beat))
            params["beat"] = str(int(slate_beat))  # 兼容 PlayCanvas 已有 beat 参数
            sketch_ref = PathResolver(str(self.project_dir), int(episode)).sketch(int(slate_beat))
            if sketch_ref.exists():
                params["beat_sketch_ref_fs"] = fs_url(sketch_ref)
                params["beat_sketch_ref_label"] = f"Beat {int(slate_beat)} 自由草图"
        beats = _scene_beat_numbers(user, project, episode, scene_id)
        if beats:
            params["slate_beats"] = ",".join(str(b) for b in beats)
        if beat_nav_fs:
            params["beat_nav_fs"] = beat_nav_fs
        return f"{self.playcanvas_3gs_url}?{urlencode(params)}"
