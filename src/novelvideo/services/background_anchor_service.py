"""Shared Render background-anchor workflow.

Both the React API and NiceGUI use this module so they persist the same
scene_ref contract:

- render_anchor_id is the concrete render input.
- master/reverse/director env-only choices are snapshotted into the beat-owned
  selected_background.png before rendering.
- render_anchor_source_id preserves the UI-visible source of that snapshot.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Callable

from PIL import Image

from novelvideo.models import beat_scene_id, sync_beat_asset_refs
from novelvideo.utils.background_anchor import (
    ANCHOR_DIRECTOR_ENV_ONLY,
    ANCHOR_MASTER,
    ANCHOR_REVERSE,
    ANCHOR_SELECTED_BACKGROUND,
    background_anchor_label,
    background_anchor_path,
    copy_to_beat_selected_background,
    crop_to_beat_selected_background,
    infer_selected_background_source,
    normalize_background_anchor_id,
)
from novelvideo.utils.path_resolver import (
    canonical_beat_selected_background_path,
)

UrlBuilder = Callable[[Path, str], str | None]

BACKGROUND_SOURCE_ANCHORS = (
    ANCHOR_DIRECTOR_ENV_ONLY,
    ANCHOR_MASTER,
    ANCHOR_REVERSE,
    ANCHOR_SELECTED_BACKGROUND,
)
SNAPSHOT_SOURCE_ANCHORS = {
    ANCHOR_MASTER,
    ANCHOR_REVERSE,
    ANCHOR_DIRECTOR_ENV_ONLY,
}


class BackgroundAnchorError(ValueError):
    """Raised when a background-anchor operation cannot be completed."""


def beat_background_scene_name(beat: dict[str, Any]) -> str:
    return str(beat_scene_id(beat) or beat.get("location") or "").strip()


def _relative_path(project_dir: Path, path: Path) -> str:
    try:
        return path.relative_to(project_dir).as_posix()
    except ValueError:
        return path.as_posix()


def _build_url(
    builder: UrlBuilder | None,
    path: Path,
    rel_path: str,
) -> str | None:
    if builder is None:
        return None
    return builder(path, rel_path)


def _anchor_path(
    project_dir: Path,
    scene_name: str,
    *,
    episode_num: int,
    beat_num: int,
    anchor_id: str,
) -> Path | None:
    path_str = background_anchor_path(
        project_dir,
        scene_name,
        episode=int(episode_num),
        beat_num=int(beat_num),
        anchor_id=anchor_id,
    )
    return Path(path_str) if path_str else None


def build_background_reference_payload(
    *,
    project_dir: Path,
    scene_name: str,
    episode_num: int,
    beat_num: int,
    anchor_id: str,
    reference_id: str | None = None,
    url_builder: UrlBuilder | None = None,
) -> dict[str, Any] | None:
    """Build a transport-neutral reference object for one concrete image."""
    normalized = normalize_background_anchor_id(anchor_id)
    path = _anchor_path(
        project_dir,
        scene_name,
        episode_num=int(episode_num),
        beat_num=int(beat_num),
        anchor_id=normalized,
    )
    if not path or not path.exists():
        return None

    display_id = normalize_background_anchor_id(reference_id or normalized)
    rel_path = _relative_path(project_dir, path)
    return {
        "id": display_id,
        "label": background_anchor_label(display_id),
        "anchor_id": normalized,
        "path": path.as_posix(),
        "rel_path": rel_path,
        "url": _build_url(url_builder, path, rel_path),
    }


def _background_anchor_item(
    *,
    project_dir: Path,
    scene_name: str,
    episode_num: int,
    beat_num: int,
    anchor_id: str,
    current_anchor: str,
    url_builder: UrlBuilder | None = None,
) -> dict[str, Any]:
    normalized = normalize_background_anchor_id(anchor_id)
    path = _anchor_path(
        project_dir,
        scene_name,
        episode_num=int(episode_num),
        beat_num=int(beat_num),
        anchor_id=normalized,
    )
    exists = bool(path and path.exists())
    rel_path = None
    url = None
    if exists and path is not None:
        rel_path = _relative_path(project_dir, path)
        url = _build_url(url_builder, path, rel_path)
    return {
        "id": normalized,
        "anchor_id": normalized,
        "label": background_anchor_label(normalized),
        "current": normalized == current_anchor,
        "exists": exists,
        "path": path.as_posix() if path else "",
        "rel_path": rel_path,
        "url": url,
        "snapshot_to_selected_background": normalized in SNAPSHOT_SOURCE_ANCHORS,
    }


def current_background_source(
    *,
    project_dir: Path,
    scene_name: str,
    scene_ref: dict[str, Any] | None,
    episode_num: int,
    beat_num: int,
) -> tuple[str, str]:
    scene_ref = scene_ref if isinstance(scene_ref, dict) else {}
    stored_anchor = normalize_background_anchor_id(
        str(scene_ref.get("render_anchor_id") or "master")
    )
    source_anchor = normalize_background_anchor_id(
        str(scene_ref.get("render_anchor_source_id") or "")
    )
    if (
        stored_anchor == ANCHOR_SELECTED_BACKGROUND
        and source_anchor not in set(BACKGROUND_SOURCE_ANCHORS)
        and scene_name
    ):
        source_anchor = infer_selected_background_source(
            project_dir,
            scene_name,
            episode=int(episode_num),
            beat_num=int(beat_num),
        )
    if stored_anchor == ANCHOR_SELECTED_BACKGROUND:
        current_source = (
            source_anchor
            if source_anchor in set(BACKGROUND_SOURCE_ANCHORS)
            else ANCHOR_SELECTED_BACKGROUND
        )
    else:
        current_source = stored_anchor
    return stored_anchor, current_source


def build_background_anchors_payload(
    *,
    project_dir: Path,
    username: str,
    project: str,
    beat: dict[str, Any],
    episode_num: int,
    beat_num: int,
    reference_url_builder: UrlBuilder | None = None,
    anchor_url_builder: UrlBuilder | None = None,
) -> dict[str, Any]:
    del username, project  # Kept in the signature for API/NiceGUI call-site symmetry.
    scene_name = beat_background_scene_name(beat)
    scene_ref = beat.get("scene_ref") if isinstance(beat.get("scene_ref"), dict) else {}
    stored_anchor, current_source = current_background_source(
        project_dir=project_dir,
        scene_name=scene_name,
        scene_ref=scene_ref,
        episode_num=int(episode_num),
        beat_num=int(beat_num),
    )

    if not scene_name:
        return {
            "episode": int(episode_num),
            "beat_num": int(beat_num),
            "scene_id": "",
            "can_choose": False,
            "render_anchor_id": stored_anchor,
            "current_source": current_source,
            "current_anchor": current_source,
            "current_reference": None,
            "display_reference": None,
            "render_input": None,
            "anchors": [],
            "error": "当前 Beat 没有关联场景，不能选择背景",
        }

    render_input = build_background_reference_payload(
        project_dir=project_dir,
        scene_name=scene_name,
        episode_num=int(episode_num),
        beat_num=int(beat_num),
        anchor_id=stored_anchor,
        reference_id=stored_anchor,
        url_builder=reference_url_builder,
    )
    display_reference = build_background_reference_payload(
        project_dir=project_dir,
        scene_name=scene_name,
        episode_num=int(episode_num),
        beat_num=int(beat_num),
        anchor_id=current_source,
        reference_id=current_source,
        url_builder=reference_url_builder,
    )
    if display_reference is None and render_input is not None:
        display_reference = {
            **render_input,
            "id": current_source,
            "label": background_anchor_label(current_source),
        }

    return {
        "episode": int(episode_num),
        "beat_num": int(beat_num),
        "scene_id": scene_name,
        "can_choose": True,
        "render_anchor_id": stored_anchor,
        "current_source": current_source,
        "current_anchor": current_source,
        "current_reference": display_reference,
        "display_reference": display_reference,
        "render_input": render_input,
        "anchors": [
            _background_anchor_item(
                project_dir=project_dir,
                scene_name=scene_name,
                episode_num=int(episode_num),
                beat_num=int(beat_num),
                anchor_id=anchor_id,
                current_anchor=current_source,
                url_builder=anchor_url_builder,
            )
            for anchor_id in BACKGROUND_SOURCE_ANCHORS
        ],
        "error": "",
    }


def _set_selected_background_ref(
    beat: dict[str, Any],
    *,
    scene_name: str,
    source_anchor_id: str,
) -> dict[str, Any]:
    scene_ref = dict(beat.get("scene_ref") or {})
    scene_ref["scene_id"] = scene_name
    scene_ref["render_anchor_id"] = ANCHOR_SELECTED_BACKGROUND
    scene_ref["render_anchor_source_id"] = normalize_background_anchor_id(source_anchor_id)
    scene_ref.pop("render_anchor_path", None)
    beat["scene_ref"] = scene_ref
    sync_beat_asset_refs(beat)
    return dict(beat.get("scene_ref") or {})


def select_background_anchor(
    *,
    project_dir: Path,
    username: str,
    project: str,
    beat: dict[str, Any],
    episode_num: int,
    beat_num: int,
    anchor_id: str,
    reference_url_builder: UrlBuilder | None = None,
    anchor_url_builder: UrlBuilder | None = None,
) -> dict[str, Any]:
    scene_name = beat_background_scene_name(beat)
    if not scene_name:
        raise BackgroundAnchorError("当前 Beat 没有关联场景，不能选择背景")

    normalized = normalize_background_anchor_id(anchor_id)
    if normalized not in set(BACKGROUND_SOURCE_ANCHORS):
        raise BackgroundAnchorError(f"Unsupported background anchor: {anchor_id}")

    if normalized in SNAPSHOT_SOURCE_ANCHORS:
        source_path = _anchor_path(
            project_dir,
            scene_name,
            episode_num=int(episode_num),
            beat_num=int(beat_num),
            anchor_id=normalized,
        )
        if not source_path or not source_path.exists():
            raise BackgroundAnchorError(f"{background_anchor_label(normalized)} 背景图不存在")
        copy_to_beat_selected_background(project_dir, int(episode_num), int(beat_num), source_path)
        source_anchor = normalized
    else:
        selected_path = canonical_beat_selected_background_path(
            project_dir,
            int(episode_num),
            int(beat_num),
        )
        if not selected_path.exists():
            raise BackgroundAnchorError("当前 beat 还没有 selected_background.png")
        source_anchor = ANCHOR_SELECTED_BACKGROUND

    _set_selected_background_ref(beat, scene_name=scene_name, source_anchor_id=source_anchor)
    return build_background_anchors_payload(
        project_dir=project_dir,
        username=username,
        project=project,
        beat=beat,
        episode_num=int(episode_num),
        beat_num=int(beat_num),
        reference_url_builder=reference_url_builder,
        anchor_url_builder=anchor_url_builder,
    )


def crop_background_anchor_to_selected(
    *,
    project_dir: Path,
    username: str,
    project: str,
    beat: dict[str, Any],
    episode_num: int,
    beat_num: int,
    anchor_id: str,
    crop: dict[str, Any],
    reference_url_builder: UrlBuilder | None = None,
    anchor_url_builder: UrlBuilder | None = None,
) -> dict[str, Any]:
    scene_name = beat_background_scene_name(beat)
    if not scene_name:
        raise BackgroundAnchorError("当前 Beat 没有关联场景，不能裁剪背景参考")

    normalized = normalize_background_anchor_id(anchor_id)
    if normalized not in SNAPSHOT_SOURCE_ANCHORS:
        raise BackgroundAnchorError(f"Unsupported background crop source: {normalized}")

    source_path = _anchor_path(
        project_dir,
        scene_name,
        episode_num=int(episode_num),
        beat_num=int(beat_num),
        anchor_id=normalized,
    )
    if not source_path or not source_path.exists():
        raise BackgroundAnchorError(f"{background_anchor_label(normalized)} 背景图不存在")

    crop_to_beat_selected_background(
        project_dir,
        int(episode_num),
        int(beat_num),
        source_path,
        x=int(crop.get("x") or 0),
        y=int(crop.get("y") or 0),
        width=int(crop.get("width") or 0),
        height=int(crop.get("height") or 0),
    )
    _set_selected_background_ref(beat, scene_name=scene_name, source_anchor_id=normalized)
    return build_background_anchors_payload(
        project_dir=project_dir,
        username=username,
        project=project,
        beat=beat,
        episode_num=int(episode_num),
        beat_num=int(beat_num),
        reference_url_builder=reference_url_builder,
        anchor_url_builder=anchor_url_builder,
    )


def save_uploaded_background_anchor_image(
    *,
    project_dir: Path,
    username: str,
    project: str,
    beat: dict[str, Any],
    episode_num: int,
    beat_num: int,
    image: Image.Image,
    reference_url_builder: UrlBuilder | None = None,
    anchor_url_builder: UrlBuilder | None = None,
) -> dict[str, Any]:
    scene_name = beat_background_scene_name(beat)
    if not scene_name:
        raise BackgroundAnchorError("当前 Beat 没有关联场景，不能上传背景参考")

    selected_path = canonical_beat_selected_background_path(
        project_dir,
        int(episode_num),
        int(beat_num),
    )
    selected_path.parent.mkdir(parents=True, exist_ok=True)
    output = image.convert("RGB") if image.mode != "RGB" else image
    output.save(selected_path, format="PNG")

    _set_selected_background_ref(
        beat,
        scene_name=scene_name,
        source_anchor_id=ANCHOR_SELECTED_BACKGROUND,
    )
    return build_background_anchors_payload(
        project_dir=project_dir,
        username=username,
        project=project,
        beat=beat,
        episode_num=int(episode_num),
        beat_num=int(beat_num),
        reference_url_builder=reference_url_builder,
        anchor_url_builder=anchor_url_builder,
    )
