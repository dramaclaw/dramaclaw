from __future__ import annotations

import re
from pathlib import Path


def safe_name(value: str) -> str:
    safe = re.sub(r"[/\\:*?\"<>|]+", "_", str(value or "").strip())
    safe = safe.strip().strip(".")
    return safe or "scene"


def safe_token(value: str) -> str:
    safe = re.sub(r"[^0-9A-Za-z_\-\u4e00-\u9fff]+", "_", str(value or "").strip())
    return safe.strip("_") or "scene"


def world_path(project_dir: Path, scene_id: str) -> Path:
    return Path(project_dir) / "director_worlds" / safe_name(scene_id) / "world.json"


def scene_assets_dir(project_dir: Path, scene_id: str) -> Path:
    return Path(project_dir) / "assets" / "scenes" / safe_name(scene_id)


def scene_gaussian_splat_ply_path(project_dir: Path, scene_id: str) -> Path | None:
    # 1. Prefer stage_manifest.json (new 3GS pipeline).
    from . import stage_manifest

    manifest_ply = stage_manifest.resolve_ply_path(project_dir, scene_id)
    if manifest_ply is not None:
        return manifest_ply

    # 2. Legacy fallback: scan assets/scenes/<scene>/ for old layouts.
    scene_dir = scene_assets_dir(project_dir, scene_id)
    preferred = [
        scene_dir / "pano_sharp_from_gpt_image2_360_da2_mps_512_ds500k" / "pano_sharp_merged.sog",
        scene_dir / "pano_sharp_da2_mps_6faces_512_ds500k" / "pano_sharp_merged.sog",
        scene_dir / "pano_sharp_from_gpt_image2_360_da2_mps_512_ds500k" / "pano_sharp_merged.ply",
        scene_dir / "pano_sharp_da2_mps_6faces_512_ds500k" / "pano_sharp_merged.ply",
    ]
    for path in preferred:
        if path.exists():
            return path
    if not scene_dir.exists():
        return None
    candidates = sorted(
        [*scene_dir.glob("**/pano_sharp_merged.sog"), *scene_dir.glob("**/pano_sharp_merged.ply")],
        key=lambda path: path.stat().st_mtime,
        reverse=True,
    )
    return candidates[0] if candidates else None


def scene_gaussian_splat_collision_glb_path(
    project_dir: Path,
    scene_id: str,
    splat_path: Path | None = None,
) -> Path | None:
    # 1. Prefer stage_manifest.json (new 3GS pipeline).
    from . import stage_manifest

    manifest_glb = stage_manifest.resolve_collision_glb_path(project_dir, scene_id)
    if manifest_glb is not None:
        return manifest_glb

    # 2. Legacy: sibling of splat_path.
    if splat_path:
        sibling = Path(splat_path).with_name("scene.collision.glb")
        if sibling.exists():
            return sibling
        sibling_named = Path(splat_path).with_suffix(".collision.glb")
        if sibling_named.exists():
            return sibling_named
    # 3. Legacy fallback: scan assets/scenes/<scene>/.
    scene_dir = scene_assets_dir(project_dir, scene_id)
    if not scene_dir.exists():
        return None
    candidates = sorted(
        scene_dir.glob("**/*.collision.glb"),
        key=lambda path: path.stat().st_mtime,
        reverse=True,
    )
    return candidates[0] if candidates else None


def blockings_dir(project_dir: Path, episode: int) -> Path:
    return Path(project_dir) / "director_blockings" / f"ep{int(episode):03d}"


def beat_blocking_path(project_dir: Path, episode: int, beat_num: int) -> Path:
    return blockings_dir(project_dir, episode) / f"beat_{int(beat_num):02d}.json"


def package_dir() -> Path:
    return Path(__file__).resolve().parent


def shape_hints_dir() -> Path:
    return package_dir() / "shape_hints"


def shape_hint_registry_path() -> Path:
    return shape_hints_dir() / "registry.json"


def states_dir() -> Path:
    return package_dir() / "states"


def actor_state_registry_path() -> Path:
    return states_dir() / "registry.json"


def director_ref_dir(project_dir: Path, episode: int, beat_num: int) -> Path:
    return (
        Path(project_dir)
        / "assets"
        / "director_refs"
        / f"ep{int(episode):03d}"
        / f"beat_{int(beat_num):02d}"
    )


def director_blocking_ref_path(project_dir: Path, episode: int, beat_num: int) -> Path:
    return director_ref_dir(project_dir, episode, beat_num) / "director_blocking_ref.png"


def session_id(user: str, project: str, episode: int, scene_id: str) -> str:
    user_part = safe_token(user or "user")
    project_part = safe_token(project or "project")
    return f"dir_{user_part}_{project_part}_ep{int(episode):03d}_{safe_token(scene_id)}"


def session_target_name(value: str) -> str:
    return f"ai_director_{safe_token(value)}"


def fs_url(path: Path) -> str:
    """Vite /@fs URL:posix 化并保证根斜杠(Windows 盘符 C:/ 前需补 /)。"""
    posix = Path(path).resolve().as_posix()
    if not posix.startswith("/"):
        posix = "/" + posix
    return f"/@fs{posix}"
