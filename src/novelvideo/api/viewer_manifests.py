"""Typed viewer manifests for in-product 360 and 3GS viewers."""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any, Literal

from novelvideo.api.deps import make_static_url_for_context
from novelvideo.api.schemas import (
    DirectorPaletteActor,
    DirectorPaletteProp,
    DirectorStageManifest,
    DirectorStagePalette,
    DirectorStageSource,
    DirectorStageSourceOption,
    PanoSphereCorrection,
    PanoViewerCorrection,
    PanoViewerManifest,
    PanoViewerSource,
    ViewerBeatContextManifest,
)
from novelvideo.director_world.paths import fs_url, blockings_dir
from novelvideo.director_world import stage_manifest
from novelvideo.generators.episode_optimizer import (
    BRIDGMAN_CHARACTER_PALETTE,
    PROP_MARKER_PALETTE,
)
from novelvideo.models import real_detected_identities, real_detected_props
from novelvideo.project_context import ProjectContext

_ANONYMOUS_COLORS = [hex_code for hex_code, _name in BRIDGMAN_CHARACTER_PALETTE]
_ANONYMOUS_PROP_COLORS = [hex_code for hex_code, _name in PROP_MARKER_PALETTE]

_ACTOR_COLORS = ["#38bdf8", "#f97316", "#22c55e", "#e879f9", "#facc15", "#fb7185"]
_PROP_COLORS = ["#a78bfa", "#2dd4bf", "#f472b6", "#84cc16", "#60a5fa", "#fb923c"]


def _splat_format(path: Path | None) -> Literal["ply", "sog", "splat", "ksplat", "unknown"]:
    suffix = path.suffix.lower().lstrip(".") if path is not None else ""
    if suffix in {"ply", "sog", "splat", "ksplat"}:
        return suffix  # type: ignore[return-value]
    return "unknown"


def asset_url(
    *,
    ctx: ProjectContext,
    project_dir: Path,
    path: Path | None,
) -> str:
    if path is None or not path.exists():
        return ""
    try:
        rel_path = path.relative_to(project_dir).as_posix()
    except ValueError:
        return ""
    return make_static_url_for_context(ctx, rel_path, local_path=path)


def _beat_context(
    *,
    episode_num: int | None,
    beat_num: int | None,
    beat: dict[str, Any] | None,
) -> ViewerBeatContextManifest | None:
    if episode_num is None or beat_num is None:
        return None
    beat = beat or {}
    return ViewerBeatContextManifest(
        episode=int(episode_num),
        beat=int(beat_num),
        visual_description=str(
            beat.get("visual_description") or beat.get("visual") or beat.get("description") or ""
        ).strip()
        or None,
        detected_identities=real_detected_identities(beat.get("detected_identities")),
        detected_props=real_detected_props(beat.get("detected_props")),
    )


def _pano_correction(project_dir: Path, scene_name: str) -> PanoViewerCorrection:
    raw = stage_manifest.get_pano_correction(project_dir, scene_name)
    sphere = raw.get("sphere_correction_deg") if isinstance(raw, dict) else {}
    sphere = sphere if isinstance(sphere, dict) else {}
    return PanoViewerCorrection(
        front_yaw_deg=float(raw.get("front_yaw_deg") or 0) if isinstance(raw, dict) else 0.0,
        sphere_correction_deg=PanoSphereCorrection(
            roll=float(sphere.get("roll") or 0),
            pitch=float(sphere.get("pitch") or 0),
            yaw=float(sphere.get("yaw") or 0),
        ),
    )


def build_pano_viewer_manifest(
    *,
    ctx: ProjectContext,
    project_dir: Path,
    scene_name: str,
    mode: Literal["scene", "beat"],
    episode_num: int | None = None,
    beat_num: int | None = None,
    beat: dict[str, Any] | None = None,
) -> PanoViewerManifest | None:
    pano_path = stage_manifest.resolve_pano_path(project_dir, scene_name)
    pano_url = asset_url(
        ctx=ctx,
        project_dir=project_dir,
        path=pano_path,
    )
    if pano_path is None or not pano_url:
        return None

    allowed = ["view", "download", "canvas_screenshot_node"]
    if mode == "beat":
        allowed = ["view", "download", "beat_selected_background"]

    return PanoViewerManifest(
        mode=mode,
        project=ctx.project_id,
        scene_id=scene_name,
        display_name=scene_name,
        source=PanoViewerSource(
            slot_kind="scene_director_pano_360",
            url=pano_url,
            fs=fs_url(pano_path),
        ),
        correction=_pano_correction(project_dir, scene_name),
        beat_context=_beat_context(episode_num=episode_num, beat_num=beat_num, beat=beat),
        allowed_destinations=allowed,
    )


def _active_source_kind(
    *,
    project_dir: Path,
    scene_name: str,
    active_path: Path,
) -> Literal["master", "reverse", "pano", "uploaded", "custom"]:
    for kind, source_kind in (
        ("custom", "custom"),
        ("pano", "pano"),
        ("master", "master"),
        ("reverse", "reverse"),
    ):
        kind_path = stage_manifest.resolve_ply_path(project_dir, scene_name, ply_kind=kind)
        if kind_path is not None and kind_path.resolve() == active_path.resolve():
            return source_kind  # type: ignore[return-value]
    manifest = stage_manifest.load_manifest(project_dir, scene_name) or {}
    source = str(manifest.get("source") or "")
    if source.startswith("uploaded_"):
        return "uploaded"
    return "custom"


def _director_source_options(
    *,
    ctx: ProjectContext,
    project_dir: Path,
    scene_name: str,
    active_path: Path,
) -> list[DirectorStageSourceOption]:
    options: list[DirectorStageSourceOption] = []

    def add(kind: str, label: str, path: Path | None, current: bool = False) -> None:
        if path is None:
            return
        url = asset_url(
            ctx=ctx,
            project_dir=project_dir,
            path=path,
        )
        if not url:
            return
        options.append(
            DirectorStageSourceOption(
                kind=kind,  # type: ignore[arg-type]
                label=label,
                source_type="sog",
                ply_url=url,
                splat_url=url,
                splat_format=_splat_format(path),
                fs=fs_url(path),
                current=current or path.resolve() == active_path.resolve(),
            )
        )

    add("active", "active", active_path, True)
    for kind, label in (
        ("master", "master"),
        ("reverse", "reverse"),
        ("pano", "pano"),
        ("uploaded", "uploaded"),
        ("custom", "custom"),
    ):
        if kind == "uploaded":
            manifest = stage_manifest.load_manifest(project_dir, scene_name) or {}
            if not str(manifest.get("source") or "").startswith("uploaded_"):
                continue
            path = stage_manifest.resolve_ply_path(project_dir, scene_name, ply_kind="custom")
        else:
            path = stage_manifest.resolve_ply_path(project_dir, scene_name, ply_kind=kind)
        add(kind, label, path)

    pano_path = stage_manifest.resolve_pano_path(project_dir, scene_name)
    pano_url = asset_url(ctx=ctx, project_dir=project_dir, path=pano_path)
    if pano_path is not None and pano_url:
        options.append(
            DirectorStageSourceOption(
                kind="pano",
                label="360 图",
                source_type="pano360",
                pano_url=pano_url,
                slot_kind="scene_director_pano_360",
                fs=fs_url(pano_path),
            )
        )
    return options


def _director_palette(
    beat_context: ViewerBeatContextManifest | None,
    *,
    sketch_colors: dict[str, str] | None = None,
    prop_marker_colors: dict[str, str] | None = None,
) -> DirectorStagePalette:
    if beat_context is None:
        return DirectorStagePalette(
            anonymous_colors=list(_ANONYMOUS_COLORS),
            anonymous_prop_colors=list(_ANONYMOUS_PROP_COLORS),
        )
    palette_identities = list((sketch_colors or {}).keys()) or beat_context.detected_identities
    palette_props = list((prop_marker_colors or {}).keys()) or beat_context.detected_props
    return DirectorStagePalette(
        actors=[
            DirectorPaletteActor(
                identity_id=identity_id,
                label=identity_id,
                color=_marker_hex(
                    (sketch_colors or {}).get(identity_id),
                    _ACTOR_COLORS[index % len(_ACTOR_COLORS)],
                ),
            )
            for index, identity_id in enumerate(palette_identities)
        ],
        props=[
            DirectorPaletteProp(
                prop_id=prop_id,
                label=prop_id,
                color=_marker_hex(
                    (prop_marker_colors or {}).get(prop_id),
                    _PROP_COLORS[index % len(_PROP_COLORS)],
                ),
            )
            for index, prop_id in enumerate(palette_props)
        ],
        anonymous_colors=[],
        anonymous_prop_colors=list(_ANONYMOUS_PROP_COLORS),
    )


def default_director_stage_palette() -> DirectorStagePalette:
    return _director_palette(None)


def _marker_hex(value: str | None, fallback: str) -> str:
    token = str(value or "").strip().split(" ", 1)[0]
    if re.fullmatch(r"#[0-9a-fA-F]{6}", token):
        return token
    return fallback


def build_director_stage_manifest(
    *,
    ctx: ProjectContext,
    project_dir: Path,
    scene_name: str,
    mode: Literal["scene", "beat"],
    episode_num: int | None = None,
    beat_num: int | None = None,
    beat: dict[str, Any] | None = None,
    sketch_colors: dict[str, str] | None = None,
    prop_marker_colors: dict[str, str] | None = None,
) -> DirectorStageManifest | None:
    scene_world = (
        stage_manifest.get_scene_director_world(project_dir, scene_name)
        if mode == "scene"
        else {"active_source_id": "", "scene": None, "scenes_by_source_id": {}}
    )
    has_saved_scene_world = bool(
        scene_world["active_source_id"]
        or scene_world["scene"]
        or scene_world["scenes_by_source_id"]
    )
    active_path = stage_manifest.resolve_ply_path(project_dir, scene_name)
    ply_url = asset_url(
        ctx=ctx,
        project_dir=project_dir,
        path=active_path,
    )
    collision_path = stage_manifest.resolve_collision_glb_path(project_dir, scene_name)
    collision_url = asset_url(
        ctx=ctx,
        project_dir=project_dir,
        path=collision_path,
    )
    pano_path = stage_manifest.resolve_pano_path(project_dir, scene_name)
    pano_url = asset_url(ctx=ctx, project_dir=project_dir, path=pano_path)
    beat_context = _beat_context(episode_num=episode_num, beat_num=beat_num, beat=beat)
    allowed = ["view", "download", "canvas_screenshot_node"]
    if mode == "beat":
        allowed = [
            "view",
            "download",
            "canvas_screenshot_node",
            "beat_director_combined",
            "beat_director_env_only",
            "beat_selected_background",
        ]

    beat_episode = int(episode_num) if mode == "beat" and episode_num is not None else None
    slate_beat = int(beat_num) if mode == "beat" and beat_num is not None else None
    palette = _director_palette(
        beat_context,
        sketch_colors=sketch_colors,
        prop_marker_colors=prop_marker_colors,
    )

    if active_path is None or not ply_url:
        if pano_path is None or not pano_url:
            if not has_saved_scene_world:
                return None
            return DirectorStageManifest(
                mode=mode,
                project=ctx.project_id,
                scene_id=scene_name,
                display_name=scene_name,
                active_source_id=scene_world["active_source_id"] or None,
                scene=scene_world["scene"],
                scenes_by_source_id=scene_world["scenes_by_source_id"],
                source=DirectorStageSource(
                    source_type="sog",
                    ply_url="",
                    splat_url="",
                    splat_format="unknown",
                    source_kind="custom",
                ),
                source_options=[],
                source_orientation_mode="supersplat_auto",
                blockings_dir_fs=(
                    fs_url(blockings_dir(project_dir, beat_episode))
                    if beat_episode is not None
                    else None
                ),
                control_frames_dir_fs=(
                    fs_url((project_dir / 'director_control_frames'))
                    if beat_episode is not None
                    else None
                ),
                slate_beat=slate_beat,
                beat_context=beat_context,
                palette=palette,
                allowed_destinations=allowed,
            )
        return DirectorStageManifest(
            mode=mode,
            project=ctx.project_id,
            scene_id=scene_name,
            display_name=scene_name,
            active_source_id=scene_world["active_source_id"] or f"scene-pano:{scene_name}",
            scene=scene_world["scene"],
            scenes_by_source_id=scene_world["scenes_by_source_id"],
            source=DirectorStageSource(
                source_type="pano360",
                ply_url="",
                splat_url="",
                pano_url=pano_url,
                slot_kind="scene_director_pano_360",
                source_kind="pano",
            ),
            source_options=[
                DirectorStageSourceOption(
                    kind="pano",
                    label="360 图",
                    source_type="pano360",
                    pano_url=pano_url,
                    slot_kind="scene_director_pano_360",
                    fs=fs_url(pano_path),
                    current=True,
                )
            ],
            source_orientation_mode="supersplat_auto",
            blockings_dir_fs=(
                fs_url(blockings_dir(project_dir, beat_episode))
                if beat_episode is not None
                else None
            ),
            control_frames_dir_fs=(
                fs_url((project_dir / 'director_control_frames'))
                if beat_episode is not None
                else None
            ),
            slate_beat=slate_beat,
            beat_context=beat_context,
            palette=palette,
            allowed_destinations=allowed,
        )

    return DirectorStageManifest(
        mode=mode,
        project=ctx.project_id,
        scene_id=scene_name,
        display_name=scene_name,
        active_source_id=scene_world["active_source_id"] or None,
        scene=scene_world["scene"],
        scenes_by_source_id=scene_world["scenes_by_source_id"],
        source=DirectorStageSource(
            source_type="sog",
            ply_url=ply_url,
            splat_url=ply_url,
            splat_format=_splat_format(active_path),
            collision_glb_url=collision_url or None,
            source_kind=_active_source_kind(
                project_dir=project_dir,
                scene_name=scene_name,
                active_path=active_path,
            ),
        ),
        source_options=_director_source_options(
            ctx=ctx,
            project_dir=project_dir,
            scene_name=scene_name,
            active_path=active_path,
        ),
        source_orientation_mode="supersplat_auto",
        blockings_dir_fs=(
            fs_url(blockings_dir(project_dir, beat_episode))
            if beat_episode is not None
            else None
        ),
        control_frames_dir_fs=(
            fs_url((project_dir / 'director_control_frames'))
            if beat_episode is not None
            else None
        ),
        slate_beat=slate_beat,
        beat_context=beat_context,
        palette=palette,
        allowed_destinations=allowed,
    )
