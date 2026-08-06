"""Preset canvas builders for project-scoped Freezone.

This module is intentionally file-system based. It builds an initial canvas
from canonical project artifacts, while the canvas JSON remains the editable
workspace state.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable

from PIL import Image

from novelvideo.config import IMAGE_DEFAULT_STYLE as PROP_REF_DEFAULT_STYLE
from novelvideo.freezone.skill_registry import SKILL_SCHEMA_VERSION
from novelvideo.generators.nanobanana_prop import build_prop_reference_prompt
from novelvideo.generators.scene_reference_images import build_scene_reference_prompt
from novelvideo.models import (
    NO_CHARACTER_MARKER,
    NO_PROP_MARKER,
    NovelScene,
    build_prop_menu,
    build_scene_effective_prompt,
)
from novelvideo.utils.path_resolver import (
    PathResolver,
    canonical_beat_director_env_only_path,
    canonical_identity_costume_path,
    canonical_identity_path,
    canonical_identity_portrait_path,
    canonical_portrait_path,
    canonical_prop_reference_path,
    canonical_scene_master_path,
    canonical_scene_reverse_master_path,
    compute_identity_costume_path,
    compute_identity_portrait_path,
)
from novelvideo.utils.static_urls import project_static_url

IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp"}
VIDEO_EXTS = {".mp4", ".mov", ".webm"}
AUDIO_EXTS = {".mp3", ".m4a", ".wav", ".aac", ".flac", ".ogg"}
TEXT_EXTS = {".json", ".txt", ".md"}
FREEZONE_PRESET_DEFAULT_IMAGE_MODEL = "newapi_gpt_image2"
FREEZONE_PRESET_IMAGE_ASPECT_RATIOS = (
    "1:1",
    "16:9",
    "9:16",
    "4:3",
    "3:4",
    "3:2",
    "2:3",
    "4:5",
    "5:4",
    "21:9",
)


@dataclass
class PresetRef:
    kind: str
    role: str
    label: str
    rel_path: str | None = None
    url: str | None = None
    exists: bool = False
    media_type: str = "image"
    aspect_ratio: str = "1:1"
    meta: dict[str, Any] = field(default_factory=dict)

    def model_dump(self) -> dict[str, Any]:
        payload = {
            "kind": self.kind,
            "role": self.role,
            "label": self.label,
            "rel_path": self.rel_path,
            "url": self.url,
            "exists": self.exists,
            "media_type": self.media_type,
            "aspect_ratio": self.aspect_ratio,
            "meta": self.meta,
        }
        contexts = _mainline_context_for_ref(payload)
        if contexts:
            payload["mainline_context"] = contexts
        return payload


def _compact_context(data: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in data.items() if value not in (None, "", [])}


def _mainline_context_for_ref(ref: dict[str, Any]) -> list[dict[str, Any]]:
    role = str(ref.get("role") or "")
    kind = str(ref.get("kind") or "")
    meta = ref.get("meta") if isinstance(ref.get("meta"), dict) else {}
    label = str(ref.get("label") or "")
    url = ref.get("url")

    def base(context_kind: str, **extra: Any) -> dict[str, Any]:
        return {
            **_compact_context(
                {
                    "kind": context_kind,
                    "episode": meta.get("episode"),
                    "beat": meta.get("beat"),
                    "character": meta.get("character"),
                    "identityId": meta.get("identity_id"),
                    "sceneId": meta.get("scene_id") or meta.get("scene"),
                    "propId": meta.get("prop_id"),
                    "markerColor": meta.get("marker_color"),
                    "role": role,
                    "label": label,
                    "sourceUrl": url,
                    **extra,
                }
            )
        }

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


def _safe_id(value: str, fallback: str = "item") -> str:
    safe = re.sub(r"[^a-zA-Z0-9_\-]+", "_", value).strip("_")
    if safe:
        return safe[:48]
    return f"{fallback}_{hashlib.sha1(value.encode('utf-8')).hexdigest()[:10]}"


def preset_key_for_request(
    *,
    scope: str,
    episode: int | None = None,
    beat: int | None = None,
    primary_slot: str | None = None,
    asset_kind: str | None = None,
    character: str | None = None,
    identity_id: str | None = None,
    asset_id: str | None = None,
) -> str:
    if scope == "episode":
        if episode is None:
            raise ValueError("episode preset requires episode")
        return f"episode:ep{episode:03d}"
    if scope == "beat":
        if episode is None or beat is None:
            raise ValueError("beat preset requires episode and beat")
        slot = primary_slot or "render"
        return f"beat:ep{episode:03d}:beat{beat:03d}:{slot}"
    if scope == "asset":
        parts = [
            "asset",
            asset_kind or "unknown",
            character or "",
            identity_id or "",
            asset_id or "",
        ]
        return ":".join(parts)
    return "blank"


def canvas_id_for_preset(preset_key: str) -> str:
    digest = hashlib.sha1(preset_key.encode("utf-8")).hexdigest()[:8]
    stem = _safe_id(preset_key.replace(":", "_"), fallback="preset")
    return f"{stem[:50]}_{digest}"[:64]


def _make_url(project_id: str, project_dir: Path, rel_path: str) -> str:
    if not project_id:
        raise ValueError("project_id is required for preset static URLs")
    return project_static_url(project_id, rel_path, local_path=project_dir / rel_path)


def _path_rel_if_inside(project_dir: Path, path: Path) -> str | None:
    try:
        return path.relative_to(project_dir).as_posix()
    except ValueError:
        return None


def _rel(project_dir: Path, path: Path) -> str:
    return path.relative_to(project_dir).as_posix()


def _greatest_common_divisor(a: int, b: int) -> int:
    x = abs(int(a))
    y = abs(int(b))
    while y:
        x, y = y, x % y
    return x or 1


def _image_aspect_ratio(path: Path) -> str:
    if not path.exists() or path.suffix.lower() not in IMAGE_EXTS:
        return "1:1"
    try:
        with Image.open(path) as image:
            width, height = image.size
    except Exception:
        return "1:1"
    if width <= 0 or height <= 0:
        return "1:1"
    gcd = _greatest_common_divisor(width, height)
    return f"{round(width / gcd)}:{round(height / gcd)}"


def _parse_aspect_ratio_value(value: str) -> float | None:
    try:
        left, right = str(value or "").split(":", 1)
        width = float(left)
        height = float(right)
    except (TypeError, ValueError):
        return None
    if width <= 0 or height <= 0:
        return None
    return width / height


def _nearest_supported_image_aspect_ratio(value: str, fallback: str = "1:1") -> str:
    if value in FREEZONE_PRESET_IMAGE_ASPECT_RATIOS:
        return value
    actual = _parse_aspect_ratio_value(value)
    if actual is None:
        return fallback

    def distance(candidate: str) -> float:
        candidate_value = _parse_aspect_ratio_value(candidate)
        if candidate_value is None:
            return float("inf")
        return abs(math.log(actual / candidate_value))

    return min(FREEZONE_PRESET_IMAGE_ASPECT_RATIOS, key=distance)


def _normalize_supported_image_aspect_ratio(value: Any, fallback: str = "2:3") -> str:
    ratio = str(value or "").strip().replace("-", ":")
    if not ratio:
        return fallback
    if _parse_aspect_ratio_value(ratio) is None:
        return fallback
    return _nearest_supported_image_aspect_ratio(ratio, fallback=fallback)


def _project_sketch_aspect_ratio(
    project_config: dict[str, Any] | None,
    episode: Any,
    fallback: str = "2:3",
) -> str:
    config = project_config or {}
    ep_key = str(episode or "").strip()
    by_episode = config.get("sketch_aspect_ratio_by_episode") or {}
    if isinstance(by_episode, dict) and ep_key:
        value = by_episode.get(ep_key)
        if value is None:
            try:
                value = by_episode.get(int(ep_key))
            except ValueError:
                value = None
        ratio = _normalize_supported_image_aspect_ratio(value, fallback="")
        if ratio:
            return ratio
    for key in ("sketch_aspect_ratio", "aspect_ratio"):
        ratio = _normalize_supported_image_aspect_ratio(config.get(key), fallback="")
        if ratio:
            return ratio
    return fallback


def _context_sketch_aspect_ratio(context: dict[str, Any], fallback: str = "2:3") -> str:
    return _normalize_supported_image_aspect_ratio(
        context.get("sketch_aspect_ratio"),
        fallback=fallback,
    )


def _media_type_for_path(path: Path) -> str:
    suffix = path.suffix.lower()
    if suffix in IMAGE_EXTS:
        return "image"
    if suffix in VIDEO_EXTS:
        return "video"
    if suffix in AUDIO_EXTS:
        return "audio"
    if suffix in TEXT_EXTS:
        return "text"
    return "file"


def _aspect_ratio_for_ref(path: Path) -> str:
    media_type = _media_type_for_path(path)
    if media_type == "image":
        return _image_aspect_ratio(path)
    if media_type == "video":
        # Avoid probing video during canvas creation; frontend can refine from
        # metadata after loading, while 16:9 is the common novelvideo beat slot.
        return "16:9"
    return "1:1"


def _add_file_ref(
    refs: list[PresetRef],
    *,
    project_id: str,
    username: str,
    project: str,
    project_dir: Path,
    kind: str,
    role: str,
    label: str,
    rel_path: str,
    required: bool = False,
    placeholder_aspect_ratio: str | None = None,
    meta: dict[str, Any] | None = None,
) -> None:
    path = project_dir / rel_path
    exists = path.exists()
    if not exists and not required:
        return
    refs.append(
        PresetRef(
            kind=kind,
            role=role,
            label=label,
            rel_path=rel_path,
            url=_make_url(project_id, project_dir, rel_path) if exists else None,
            exists=exists,
            media_type=_media_type_for_path(path),
            aspect_ratio=(
                _aspect_ratio_for_ref(path)
                if exists
                else (placeholder_aspect_ratio or _aspect_ratio_for_ref(path))
            ),
            meta=meta or {},
        )
    )


def _latest_matching(directory: Path, patterns: Iterable[str]) -> list[Path]:
    if not directory.exists():
        return []
    seen: set[Path] = set()
    out: list[Path] = []
    for pattern in patterns:
        for p in directory.glob(pattern):
            if p.is_file() and p not in seen:
                seen.add(p)
                out.append(p)
    out.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    return out


def _normalize_scene_name(scene_ref: Any) -> str:
    if isinstance(scene_ref, dict):
        for key in ("scene_id", "name", "scene_name", "id", "title"):
            value = str(scene_ref.get(key) or "").strip()
            if value:
                return value
    if scene_ref:
        return str(scene_ref).strip()
    return ""


def _jsonable(value: Any) -> Any:
    if hasattr(value, "model_dump"):
        return value.model_dump()
    if isinstance(value, list):
        return [_jsonable(v) for v in value]
    if isinstance(value, dict):
        return {str(k): _jsonable(v) for k, v in value.items()}
    return value


_MARKER_RE = re.compile(r"\{\{([^{}]+)\}\}|\[\[([^\[\]]+)\]\]")


def _visual_markers(text: str) -> tuple[list[str], list[str]]:
    identities: list[str] = []
    props: list[str] = []
    for match in _MARKER_RE.finditer(text or ""):
        identity = (match.group(1) or "").strip()
        prop = (match.group(2) or "").strip()
        if identity:
            identities.append(identity)
        if prop:
            props.append(prop)
    return identities, props


def _identity_character(identity_id: str, known_characters: Iterable[str]) -> str:
    for name in sorted((n for n in known_characters if n), key=len, reverse=True):
        if identity_id == name or identity_id.startswith(f"{name}_"):
            return name
    if "_" in identity_id:
        return identity_id.split("_", 1)[0]
    return identity_id


def _identity_name(identity_id: str, character: str) -> str:
    prefix = f"{character}_"
    return identity_id[len(prefix) :] if identity_id.startswith(prefix) else identity_id


def _as_list(value: Any) -> list[Any]:
    if isinstance(value, list):
        return value
    if isinstance(value, tuple):
        return list(value)
    if value is None:
        return []
    return [value]


def _prop_id_from_item(item: Any) -> str:
    if isinstance(item, dict):
        return str(item.get("prop_id") or item.get("base_id") or item.get("id") or "").strip()
    return str(item or "").strip()


def _identity_id_from_item(item: Any) -> str:
    if isinstance(item, dict):
        return str(item.get("identity_id") or item.get("id") or item.get("name") or "").strip()
    return str(item or "").strip()


def _real_identity_ids(values: Iterable[str]) -> list[str]:
    return [value for value in values if value and value != NO_CHARACTER_MARKER]


def _real_prop_ids(values: Iterable[str]) -> list[str]:
    return [value for value in values if value and value != NO_PROP_MARKER]


def _add_character_refs(
    refs: list[PresetRef],
    *,
    project_id: str,
    username: str,
    project: str,
    project_dir: Path,
    character: str,
    identity_id: str | None,
) -> None:
    if not character:
        return
    if identity_id:
        _add_file_ref(
            refs,
            project_id=project_id,
            username=username,
            project=project,
            project_dir=project_dir,
            kind="identity",
            role="character_identity",
            label=identity_id,
            rel_path=_rel(
                project_dir,
                canonical_identity_path(
                    project_dir,
                    character,
                    _identity_name(identity_id, character),
                ),
            ),
            required=True,
            meta={"character": character, "identity_id": identity_id},
        )
    _add_file_ref(
        refs,
        project_id=project_id,
        username=username,
        project=project,
        project_dir=project_dir,
        kind="identity",
        role="character_portrait",
        label=f"{character} portrait",
        rel_path=_rel(project_dir, canonical_portrait_path(project_dir, character)),
        meta={"character": character},
    )


def _add_character_identity_ref(
    refs: list[PresetRef],
    *,
    project_id: str,
    username: str,
    project: str,
    project_dir: Path,
    character: str,
    identity_id: str,
) -> None:
    if not character or not identity_id:
        return
    _add_file_ref(
        refs,
        project_id=project_id,
        username=username,
        project=project,
        project_dir=project_dir,
        kind="identity",
        role="character_identity",
        label=identity_id,
        rel_path=_rel(
            project_dir,
            canonical_identity_path(
                project_dir,
                character,
                _identity_name(identity_id, character),
            ),
        ),
        required=True,
        meta={"character": character, "identity_id": identity_id},
    )


def _add_mainline_identity_ref(
    refs: list[PresetRef],
    *,
    project_id: str,
    username: str,
    project: str,
    project_dir: Path,
    character: str,
    identity_id: str,
    include_portrait_fallback: bool = True,
) -> None:
    """Add the single identity image consumed by EP/Beat mainline canvases.

    Asset canvases may expose portrait/identity as separate production
    steps. EP/Beat canvases only consume the selected identity concept; if the
    canonical identity file is missing, a portrait file can visually stand in
    for that identity without changing the semantic role.

    `include_portrait_fallback`: when False, no fallback to portrait /
    reference images — if the canonical identity image is missing, no node is
    emitted. EP-scope canvas uses this to avoid surfacing portrait nodes for
    identities that haven't been generated yet (users found portrait stand-ins
    confusing at the EP scope). Beat workbench keeps the fallback on so the
    workflow always has *some* image to anchor against.
    """
    if not character or not identity_id:
        return
    canonical_path = canonical_identity_path(
        project_dir,
        character,
        _identity_name(identity_id, character),
    )
    candidates: list[tuple[Path, str]] = [(canonical_path, "character_identity")]
    if include_portrait_fallback:
        candidates.append((canonical_portrait_path(project_dir, character), "character_portrait"))
    for path, source_role in candidates:
        if not path.exists():
            continue
        _add_file_ref(
            refs,
            project_id=project_id,
            username=username,
            project=project,
            project_dir=project_dir,
            kind="identity",
            role="character_identity",
            label=identity_id,
            rel_path=_rel(project_dir, path),
            meta={
                "character": character,
                "identity_id": identity_id,
                "source_role": source_role,
            },
        )
        return


def _add_prop_refs(
    refs: list[PresetRef],
    *,
    project_id: str,
    username: str,
    project: str,
    project_dir: Path,
    prop_id: str,
    meta: dict[str, Any],
) -> None:
    if not prop_id:
        return
    canonical = canonical_prop_reference_path(project_dir, prop_id)
    _add_file_ref(
        refs,
        project_id=project_id,
        username=username,
        project=project,
        project_dir=project_dir,
        kind="prop",
        role="prop_reference",
        label=prop_id,
        rel_path=_rel(project_dir, canonical),
        required=True,
        placeholder_aspect_ratio="1:1",
        meta=meta,
    )


def _add_selected_background_ref(
    refs: list[PresetRef],
    *,
    project_id: str,
    username: str,
    project: str,
    project_dir: Path,
    episode: int,
    beat: int,
    scene_id: str = "",
) -> None:
    ep_dir = f"ep{episode:03d}"
    beat_dir = f"beat_{beat:02d}"
    _add_file_ref(
        refs,
        project_id=project_id,
        username=username,
        project=project,
        project_dir=project_dir,
        kind="director",
        role="selected_background",
        label=f"当前背景 · Beat {beat}",
        rel_path=f"director_control_frames/{ep_dir}/{beat_dir}/selected_background.png",
        meta={"episode": episode, "beat": beat, "scene_id": scene_id},
    )


def _add_scene_refs(
    refs: list[PresetRef],
    *,
    project_id: str,
    username: str,
    project: str,
    project_dir: Path,
    scene_name: str,
    scene_info: dict[str, Any] | None = None,
    include_derived_assets: bool = True,
) -> None:
    if not scene_name:
        return
    scene_info = scene_info or {}
    effective_environment_prompt = str(
        scene_info.get("effective_environment_prompt") or scene_info.get("environment_prompt") or ""
    ).strip()
    scene_meta = {
        "scene": scene_name,
        "environment_prompt": effective_environment_prompt,
        "raw_environment_prompt": str(scene_info.get("environment_prompt") or "").strip(),
        "variant_prompt": str(scene_info.get("variant_prompt") or "").strip(),
        "base_scene_id": str(scene_info.get("base_scene_id") or "").strip(),
        "base_master_url": str(scene_info.get("base_master_url") or "").strip(),
        "base_master_rel_path": str(scene_info.get("base_master_rel_path") or "").strip(),
        "base_environment_prompt": str(scene_info.get("base_environment_prompt") or "").strip(),
        "base_description": str(scene_info.get("base_description") or "").strip(),
        "base_scene_type": str(scene_info.get("base_scene_type") or "").strip(),
        "variant_id": str(scene_info.get("variant_id") or "").strip(),
        "time_of_day": str(scene_info.get("time_of_day") or "").strip(),
        "description": str(scene_info.get("description") or "").strip(),
        "scene_type": str(scene_info.get("scene_type") or "").strip(),
        "style_name": str(scene_info.get("style_name") or "").strip(),
        "style_prompt": str(scene_info.get("style_prompt") or "").strip(),
        "avoid_instructions": str(scene_info.get("avoid_instructions") or "").strip(),
    }
    director_pano_path: Path | None = None
    director_ply_paths: list[tuple[Path, str, str, str]] = []
    if include_derived_assets:
        try:
            from novelvideo.director_world import stage_manifest

            director_pano_path = stage_manifest.resolve_pano_path(
                project_dir,
                scene_name,
            ) or (stage_manifest.stage_dir(project_dir, scene_name) / "pano_360.png")
            seen_ply_paths: set[str] = set()
            for ply_kind, role, label in [
                ("master", "scene_3gs_master_ply", f"{scene_name} 3D 世界（正面）"),
                ("reverse", "scene_3gs_reverse_ply", f"{scene_name} 3D 世界（背面）"),
                ("pano", "scene_3gs_pano_ply", f"{scene_name} 3D 世界（360）"),
            ]:
                path = stage_manifest.resolve_ply_path(project_dir, scene_name, ply_kind=ply_kind)
                if path is None:
                    continue
                rel = _rel(project_dir, path)
                if rel in seen_ply_paths:
                    continue
                seen_ply_paths.add(rel)
                director_ply_paths.append((path, role, label, ply_kind))
        except Exception:
            director_pano_path = None
            director_ply_paths = []
    # scene_360 is the direct panorama workflow/slot. Assets > Scenes uses
    # scene_director_pano_360 as the canonical director-world pano, so the
    # preset intentionally does not emit scene_360 as a mainline scene asset.
    # The direct-360 workflow itself remains available through freezone.scene_360
    # and scene_360_candidate outputs.
    for path, role, label, required, placeholder_aspect_ratio in [
        (
            canonical_scene_master_path(project_dir, scene_name),
            "scene_master",
            f"{scene_name} master",
            True,
            "16:9",
        ),
        (
            canonical_scene_reverse_master_path(project_dir, scene_name),
            "scene_reverse_master",
            f"{scene_name} reverse master",
            True,
            "16:9",
        ),
        (
            director_pano_path,
            "scene_director_pano_360",
            f"{scene_name} director pano 360",
            True,
            "2:1",
        ),
    ]:
        if path is None:
            continue
        if not include_derived_assets and role == "scene_director_pano_360":
            continue
        _add_file_ref(
            refs,
            project_id=project_id,
            username=username,
            project=project,
            project_dir=project_dir,
            kind="scene",
            role=role,
            label=label,
            rel_path=_rel(project_dir, path),
            required=required,
            placeholder_aspect_ratio=placeholder_aspect_ratio,
            meta={**scene_meta, "scene_id": scene_name},
        )
    for path, role, label, ply_kind in director_ply_paths:
        _add_file_ref(
            refs,
            project_id=project_id,
            username=username,
            project=project,
            project_dir=project_dir,
            kind="scene",
            role=role,
            label=label,
            rel_path=_rel(project_dir, path),
            meta={**scene_meta, "scene_id": scene_name, "ply_kind": ply_kind},
        )


def _beat_scene_source_urls(context: dict[str, Any]) -> dict[str, Any]:
    refs = context.get("refs") if isinstance(context.get("refs"), list) else []
    by_role: dict[str, dict[str, Any]] = {}
    for ref in refs:
        if not isinstance(ref, dict):
            continue
        role = str(ref.get("role") or "")
        if role:
            by_role[role] = ref
    scene_ref = (context.get("beat_data") or {}).get("scene_ref")
    scene_id = _normalize_scene_name(scene_ref)
    project_id = str(context.get("project_id") or "")

    def _maybe_int(value: Any) -> int | None:
        try:
            return int(value)
        except (TypeError, ValueError):
            return None

    episode = _maybe_int(context.get("episode"))
    beat = _maybe_int(context.get("beat"))
    project_dir_raw = context.get("project_dir")
    project_dir = (
        Path(project_dir_raw) if isinstance(project_dir_raw, str) and project_dir_raw else None
    )

    def url_for(role: str) -> str | None:
        ref = by_role.get(role) or {}
        url = ref.get("url")
        return str(url).strip() if isinstance(url, str) and url.strip() else None

    def url_for_path(path: Path | None) -> str | None:
        if not path or not project_dir or not project_id or not path.exists():
            return None
        return _make_url(project_id, project_dir, _rel(project_dir, path))

    direct_master_url = direct_reverse_url = direct_pano_url = direct_env_only_url = None
    direct_has_3gs = False
    if project_dir and scene_id:
        direct_master_url = url_for_path(canonical_scene_master_path(project_dir, scene_id))
        direct_reverse_url = url_for_path(
            canonical_scene_reverse_master_path(project_dir, scene_id)
        )
        try:
            from novelvideo.director_world import stage_manifest

            direct_pano_url = url_for_path(stage_manifest.resolve_pano_path(project_dir, scene_id))
            direct_has_3gs = any(
                stage_manifest.resolve_ply_path(project_dir, scene_id, ply_kind=ply_kind)
                for ply_kind in ("master", "reverse", "pano")
            )
        except Exception:
            direct_pano_url = None
            direct_has_3gs = False
    if project_dir and episode is not None and beat is not None:
        direct_env_only_url = url_for_path(
            canonical_beat_director_env_only_path(project_dir, episode, beat)
        )

    return {
        "scene_id": scene_id,
        "master_url": direct_master_url or url_for("scene_master"),
        "reverse_url": direct_reverse_url or url_for("scene_reverse_master"),
        "director_env_only_url": direct_env_only_url,
        "pano_360_url": direct_pano_url or url_for("scene_director_pano_360"),
        "has_3gs": direct_has_3gs
        or any(
            role in by_role
            for role in (
                "scene_3gs_master_ply",
                "scene_3gs_reverse_ply",
                "scene_3gs_pano_ply",
            )
        ),
    }


def collect_beat_preset_refs(
    *,
    username: str,
    project: str,
    project_dir: Path,
    store: Any,
    episode: int,
    beat: int,
    primary_slot: str = "render",
) -> dict[str, Any]:
    """Collect canonical refs for a beat preset.

    The return value is API-ready JSON so it can be used by both a spike script
    and the FastAPI factory endpoint.
    """
    # The store methods are async; this function is sync by design only for the
    # small helpers above. Use `build_beat_preset_context` for the public async API.
    raise RuntimeError("use build_beat_preset_context")


async def build_beat_preset_context(
    *,
    project_id: str,
    username: str,
    project: str,
    project_dir: Path,
    store: Any,
    episode: int,
    beat: int,
    primary_slot: str = "render",
) -> dict[str, Any]:
    beats = await store.get_beats_as_dicts(episode)
    target = next((b for b in beats if int(b.get("beat_number") or -1) == int(beat)), None)
    if not target:
        raise ValueError(f"beat not found: ep{episode} beat{beat}")

    episode_obj = await store.get_episode_from_graph(episode)
    prop_menu = [
        item.model_dump()
        for item in build_prop_menu(prop_menu=getattr(episode_obj, "prop_menu", []) or [])
    ]
    try:
        from novelvideo.services.prop_ref_service import runtime_prop_menu_with_cached_global_props

        prop_menu = runtime_prop_menu_with_cached_global_props(
            prop_menu=prop_menu,
            beats=[target],
            store=store,
        )
    except Exception:
        pass
    scene_menu = [
        item.model_dump() if hasattr(item, "model_dump") else _jsonable(item)
        for item in (getattr(episode_obj, "scene_menu", []) or [])
    ]
    prop_by_id = {item["prop_id"]: item for item in prop_menu if item.get("prop_id")}
    known_characters = list(getattr(store, "_characters", {}).keys())

    refs: list[PresetRef] = []
    ep_dir = f"ep{episode:03d}"
    beat_dir = f"beat_{beat:02d}"
    control_base = f"director_control_frames/{ep_dir}/{beat_dir}"
    paths = PathResolver(str(project_dir), episode)

    def _project_rel(path: Path) -> str:
        return path.relative_to(project_dir).as_posix()

    canonical_sketch_path = paths.sketch(beat)
    for rel_path, kind, role, label in [
        (_project_rel(canonical_sketch_path), "sketch", "current_sketch", "当前草图"),
        (_project_rel(paths.frame(beat)), "frame", "current_frame", "当前分镜"),
        (
            _project_rel(paths.video(beat)),
            "video",
            "current_video",
            "当前视频",
        ),
        (_project_rel(paths.audio(beat)), "audio", "current_audio", "当前音频"),
        (f"{control_base}/combined.png", "director", "director_combined", "导演合成图"),
    ]:
        _add_file_ref(
            refs,
            project_id=project_id,
            username=username,
            project=project,
            project_dir=project_dir,
            kind=kind,
            role=role,
            label=label,
            rel_path=rel_path,
            meta={"episode": episode, "beat": beat, "primary_slot": primary_slot},
        )

    scene_name = _normalize_scene_name(target.get("scene_ref"))

    # selected_background 不走 _add_file_ref(那个函数会在文件缺失时直接跳过) ——
    # 这个 slot 必须有站位节点,用户才知道往哪 commit 选定背景图。文件存在时
    # 走正常 asset node 渲染;缺失时 emit 一个 url=None 的 placeholder ref,
    # 让画布上 generic ref loop 给它建一个空 imageGenNode 占位。
    selected_bg_rel = f"{control_base}/selected_background.png"
    selected_bg_path = project_dir / selected_bg_rel
    selected_bg_exists = selected_bg_path.exists()
    fallback_bg_rel: str | None = None
    fallback_bg_path: Path | None = None
    if not selected_bg_exists and scene_name:
        scene_master_path = canonical_scene_master_path(project_dir, scene_name)
        if scene_master_path.exists():
            fallback_bg_rel = _path_rel_if_inside(project_dir, scene_master_path)
            fallback_bg_path = scene_master_path if fallback_bg_rel else None
    preview_bg_path = selected_bg_path if selected_bg_exists else fallback_bg_path
    preview_bg_rel = selected_bg_rel if selected_bg_exists else fallback_bg_rel
    preview_bg_exists = selected_bg_exists or bool(fallback_bg_path)
    selected_bg_meta = {
        "episode": episode,
        "beat": beat,
        "primary_slot": primary_slot,
        "scene_id": scene_name,
    }
    if fallback_bg_rel:
        selected_bg_meta.update(
            {
                "fallback_source": "scene_master",
                "fallback_rel_path": fallback_bg_rel,
            }
        )
    refs.append(
        PresetRef(
            kind="director",
            role="selected_background",
            label=f"当前背景 · Beat {beat}",
            rel_path=selected_bg_rel,
            url=(
                _make_url(project_id, project_dir, preview_bg_rel)
                if preview_bg_rel and preview_bg_exists
                else None
            ),
            exists=preview_bg_exists,
            media_type=_media_type_for_path(preview_bg_path) if preview_bg_path else "image",
            aspect_ratio=_aspect_ratio_for_ref(preview_bg_path) if preview_bg_path else "16:9",
            meta=selected_bg_meta,
        )
    )

    visual_description = str(target.get("visual_description") or "")
    marker_identities, marker_props = _visual_markers(visual_description)
    detected_identities = [
        _identity_id_from_item(x) for x in _as_list(target.get("detected_identities"))
    ]
    identity_ids = _real_identity_ids([*marker_identities, *detected_identities])
    seen_identities: set[str] = set()
    for identity_id in identity_ids:
        if identity_id in seen_identities:
            continue
        seen_identities.add(identity_id)
        character = _identity_character(identity_id, known_characters)
        _add_mainline_identity_ref(
            refs,
            project_id=project_id,
            username=username,
            project=project,
            project_dir=project_dir,
            character=character,
            identity_id=identity_id,
        )

    detected_props = [_prop_id_from_item(x) for x in _as_list(target.get("detected_props"))]
    prop_ids = _real_prop_ids([*marker_props, *detected_props])
    seen_props: set[str] = set()
    for prop_id in prop_ids:
        if prop_id in seen_props:
            continue
        seen_props.add(prop_id)
        _add_prop_refs(
            refs,
            project_id=project_id,
            username=username,
            project=project,
            project_dir=project_dir,
            prop_id=prop_id,
            meta=prop_by_id.get(prop_id, {"prop_id": prop_id}),
        )

    # Beat canvas does not project scene assets as nodes. Scene master /
    # reverse / 360 / 3GS remain available through the set-selected-background
    # SkillNode's embedded source picker.

    sketch_colors: dict[str, str] = {}
    get_sketch_colors = getattr(store, "get_sketch_colors", None)
    if callable(get_sketch_colors):
        try:
            sketch_colors = get_sketch_colors(episode) or {}
        except Exception:
            sketch_colors = {}
    if not sketch_colors:
        try:
            from novelvideo.generators.episode_optimizer import EpisodeOptimizer

            sketch_colors = EpisodeOptimizer.assign_sketch_colors(
                [
                    {
                        "name": getattr(character_obj, "name", ""),
                        "identities": [
                            (
                                identity.model_dump()
                                if hasattr(identity, "model_dump")
                                else _jsonable(identity)
                            )
                            for identity in (getattr(character_obj, "identities", []) or [])
                        ],
                    }
                    for character_obj in getattr(store, "get_all_characters", lambda: [])()
                ],
                episode_beats=beats,
            )
        except Exception:
            sketch_colors = {}

    try:
        from novelvideo.project_config import load_project_config_file

        project_config = load_project_config_file(username, project) if project else {}
    except Exception:
        project_config = {}
    sketch_aspect_ratio = _project_sketch_aspect_ratio(project_config, episode)

    prop_marker_colors: dict[str, str] = {}
    try:
        from novelvideo.generators.nanobanana_grid import _global_prop_marker_colors

        prop_marker_colors = _global_prop_marker_colors(
            [target],
            prop_menu=prop_menu,
            sketch_colors=sketch_colors,
        )
    except Exception:
        prop_marker_colors = {}

    character_profiles: dict[str, Any] = {}
    for character_obj in getattr(store, "get_all_characters", lambda: [])():
        character_name = str(getattr(character_obj, "name", "") or "").strip()
        if not character_name:
            continue
        character_profiles[character_name] = {
            "name": character_name,
            "gender": str(getattr(character_obj, "gender", "") or "").strip(),
            "body_type": str(getattr(character_obj, "body_type", "") or "").strip(),
            "appearance_details": str(
                getattr(character_obj, "appearance_details", "") or ""
            ).strip(),
            "identities": [
                identity.model_dump() if hasattr(identity, "model_dump") else _jsonable(identity)
                for identity in (getattr(character_obj, "identities", []) or [])
            ],
        }

    return {
        "scope": "beat",
        "username": username,
        "project": project,
        "project_id": project_id,
        "project_dir": str(project_dir),
        "episode": episode,
        "beat": beat,
        "primary_slot": primary_slot,
        "sketch_aspect_ratio": sketch_aspect_ratio,
        "beat_data": {
            "beat_number": target.get("beat_number"),
            "narration_segment": target.get("narration_segment"),
            "visual_description": visual_description,
            "video_prompt": target.get("video_prompt"),
            "keyframe_prompt": target.get("keyframe_prompt"),
            "scene_ref": target.get("scene_ref"),
            "detected_identities": target.get("detected_identities"),
            "detected_props": target.get("detected_props"),
        },
        "prop_menu": prop_menu,
        "scene_menu": scene_menu,
        "sketch_context": {
            "sketch_colors": sketch_colors,
            "prop_marker_colors": prop_marker_colors,
            "characters": character_profiles,
        },
        "refs": [r.model_dump() for r in refs],
    }


async def build_episode_preset_context(
    *,
    project_id: str,
    username: str,
    project: str,
    project_dir: Path,
    store: Any,
    episode: int,
) -> dict[str, Any]:
    beats = await store.get_beats_as_dicts(episode)
    try:
        episode_obj = await store.get_episode_from_graph(episode)
    except Exception:
        episode_obj = None

    episode_title = str(getattr(episode_obj, "title", "") or f"EP{episode}").strip()
    known_characters = list(getattr(store, "_characters", {}).keys())
    scene_ids: set[str] = set()
    identity_ids: set[str] = set()
    prop_ids: set[str] = set()
    beat_items: list[dict[str, Any]] = []
    background_items: list[dict[str, Any]] = []

    for beat in beats:
        try:
            beat_number = int(beat.get("beat_number") or 0)
        except (TypeError, ValueError):
            beat_number = 0
        if beat_number <= 0:
            continue
        visual_description = str(beat.get("visual_description") or "")
        marker_identities, marker_props = _visual_markers(visual_description)
        detected_identities = [
            _identity_id_from_item(x) for x in _as_list(beat.get("detected_identities"))
        ]
        detected_props = [_prop_id_from_item(x) for x in _as_list(beat.get("detected_props"))]
        scene_id = _normalize_scene_name(beat.get("scene_ref"))
        if scene_id:
            scene_ids.add(scene_id)
        for identity_id in _real_identity_ids([*marker_identities, *detected_identities]):
            identity_ids.add(identity_id)
        for prop_id in _real_prop_ids([*marker_props, *detected_props]):
            prop_ids.add(prop_id)
        beat_items.append(
            {
                "beat_number": beat_number,
                "visual_description": visual_description,
                "narration_segment": beat.get("narration_segment"),
                "scene_id": scene_id,
                "detected_identities": _real_identity_ids(
                    [*marker_identities, *detected_identities]
                ),
                "detected_props": _real_prop_ids([*marker_props, *detected_props]),
            }
        )
        background_items.append({"beat_number": beat_number, "scene_id": scene_id})

    identity_items = [
        {
            "identity_id": identity_id,
            "character": _identity_character(identity_id, known_characters),
        }
        for identity_id in sorted(identity_ids)
    ]
    prop_items = [{"prop_id": prop_id} for prop_id in sorted(prop_ids)]
    scene_items = [{"scene_id": scene_id} for scene_id in sorted(scene_ids)]

    refs: list[PresetRef] = []
    for item in identity_items:
        # EP canvas:不走 portrait/reference_front fallback。canonical identity
        # 缺失就不发 ref(用户看不到 portrait 替身,避免被误读为"该 identity 已生成")。
        # Beat 工作台保留 fallback(default include_portrait_fallback=True)。
        _add_mainline_identity_ref(
            refs,
            project_id=project_id,
            username=username,
            project=project,
            project_dir=project_dir,
            character=str(item.get("character") or ""),
            identity_id=str(item.get("identity_id") or ""),
            include_portrait_fallback=False,
        )
    for item in prop_items:
        prop_id = str(item.get("prop_id") or "")
        _add_prop_refs(
            refs,
            project_id=project_id,
            username=username,
            project=project,
            project_dir=project_dir,
            prop_id=prop_id,
            meta={"prop_id": prop_id},
        )
    for item in background_items:
        beat_number = int(item.get("beat_number") or 0)
        if beat_number <= 0:
            continue
        _add_selected_background_ref(
            refs,
            project_id=project_id,
            username=username,
            project=project,
            project_dir=project_dir,
            episode=episode,
            beat=beat_number,
            scene_id=str(item.get("scene_id") or ""),
        )

    return {
        "scope": "episode",
        "username": username,
        "project": project,
        "project_id": project_id,
        "project_dir": str(project_dir),
        "episode": episode,
        "episode_title": episode_title,
        "beats": sorted(beat_items, key=lambda item: int(item["beat_number"])),
        "scenes": scene_items,
        "backgrounds": background_items,
        "identities": identity_items,
        "props": prop_items,
        "refs": [r.model_dump() for r in refs],
    }


def _node_source_from_ref(ref: dict[str, Any]) -> dict[str, Any]:
    return {
        "kind": ref.get("kind"),
        "role": ref.get("role"),
        "label": ref.get("label"),
        "rel_path": ref.get("rel_path"),
        "meta": ref.get("meta") or {},
    }


def _node_mainline_context_from_ref(ref: dict[str, Any]) -> list[dict[str, Any]]:
    contexts = ref.get("mainline_context")
    if isinstance(contexts, list):
        return [ctx for ctx in contexts if isinstance(ctx, dict)]
    return _mainline_context_for_ref(ref)


def _beat_target_placeholder_ref(
    *,
    episode: Any,
    beat: Any,
    primary_slot: str,
    role: str,
    aspect_ratio: str = "2:3",
) -> dict[str, Any] | None:
    try:
        ep_num = int(episode)
        beat_num = int(beat)
    except (TypeError, ValueError):
        return None

    ep_dir = f"ep{ep_num:03d}"
    base_meta = {"episode": ep_num, "beat": beat_num, "primary_slot": primary_slot}
    output_aspect_ratio = _normalize_supported_image_aspect_ratio(aspect_ratio)
    if role == "current_sketch":
        return {
            "kind": "sketch",
            "role": role,
            "label": "当前草图",
            "rel_path": f"sketches/{ep_dir}/beat_{beat_num:02d}.png",
            "url": None,
            "exists": False,
            "media_type": "image",
            "aspect_ratio": output_aspect_ratio,
            "meta": base_meta,
        }
    if role == "current_frame":
        return {
            "kind": "frame",
            "role": role,
            "label": "当前分镜",
            "rel_path": f"frames/{ep_dir}/beat_{beat_num:02d}.png",
            "url": None,
            "exists": False,
            "media_type": "image",
            "aspect_ratio": output_aspect_ratio,
            "meta": base_meta,
        }
    if role == "selected_background":
        # selected_background 总是有站位 — 没文件时也画个 placeholder 节点,
        # 用户才知道往哪 commit 背景(否则 canvas 上完全找不到目标 slot)。
        # 16:9 跟导演阶段产出对齐,不走 beat sketch 的 2:3。
        beat_dir = f"beat_{beat_num:02d}"
        return {
            "kind": "director",
            "role": role,
            "label": f"当前背景 · Beat {beat_num}",
            "rel_path": f"director_control_frames/{ep_dir}/{beat_dir}/selected_background.png",
            "url": None,
            "exists": False,
            "media_type": "image",
            "aspect_ratio": "16:9",
            "meta": base_meta,
        }
    return None


def _text_node(
    node_id: str,
    x: int,
    y: int,
    label: str,
    content: str,
    extra_data: dict[str, Any] | None = None,
) -> dict[str, Any]:
    # preset_managed: True — every node returned by a `_*_node` factory in this
    # module is emitted by preset, so it must carry the explicit flag so frontend
    # nodeMainlineFlags() and backend _is_preset_managed_canvas_node() can rely
    # on a single source of truth (not heuristics over __freezone_source).
    return {
        "id": node_id,
        "type": "textAnnotationNode",
        "position": {"x": x, "y": y},
        "data": {
            "displayName": label,
            "content": content,
            "preset_managed": True,
            **(extra_data or {}),
        },
    }


def _skill_node(
    node_id: str,
    x: int,
    y: int,
    *,
    skill_id: str,
    display_name: str,
    extra_data: dict[str, Any] | None = None,
) -> dict[str, Any]:
    data = {
        "skill_id": skill_id,
        "skill_schema_version": SKILL_SCHEMA_VERSION,
        "displayName": display_name,
        "preset_managed": True,
    }
    if extra_data:
        data.update(extra_data)
    return {
        "id": node_id,
        "type": "skillNode",
        "position": {"x": x, "y": y},
        "measured": {"width": 380, "height": 520},
        "data": data,
    }


def _beat_context_node(
    node_id: str,
    x: int,
    y: int,
    label: str,
    content: str,
    *,
    mainline_context: list[dict[str, Any]],
    edit_fields: dict[str, Any] | None = None,
    extra_data: dict[str, Any] | None = None,
) -> dict[str, Any]:
    beat_ctx = next((ctx for ctx in mainline_context if ctx.get("kind") == "beat"), {})
    snapshot = {
        "visualDescription": beat_ctx.get("visualDescription") or "",
        "narrationSegment": beat_ctx.get("narrationSegment") or "",
        "sceneId": beat_ctx.get("sceneId") or "",
        "timeOfDay": (edit_fields or {}).get("time_of_day") or "",
        "detectedIdentities": beat_ctx.get("detectedIdentities") or [],
        "detectedProps": beat_ctx.get("detectedProps") or [],
        "sketchColors": beat_ctx.get("sketchColors") or {},
        "propMarkerColors": beat_ctx.get("propMarkerColors") or {},
        "selectedBackgroundExists": bool(beat_ctx.get("selectedBackgroundExists")),
        "currentSketchExists": bool(beat_ctx.get("currentSketchExists")),
        "currentFrameExists": bool(beat_ctx.get("currentFrameExists")),
    }
    data: dict[str, Any] = {
        "displayName": label,
        "content": content,
        "projectId": beat_ctx.get("projectId"),
        "episode": beat_ctx.get("episode"),
        "beat": beat_ctx.get("beat"),
        "snapshot": snapshot,
        "mainline_context": mainline_context,
        "beat_edit_fields": edit_fields or {},
        "preset_managed": True,
        **(extra_data or {}),
    }
    return {
        "id": node_id,
        "type": "beatContextNode",
        "position": {"x": x, "y": y},
        "data": data,
        # React Flow v12 uses measured size for the node wrapper. Without it,
        # BeatContextNode collapses to 0x0 and source handles/edges disappear.
        # Keep in sync with BeatContextNode.tsx DEFAULT_WIDTH/DEFAULT_HEIGHT.
        "measured": {"width": 420, "height": 560},
    }


def _beat_context_display_name(context: dict[str, Any]) -> str:
    episode = context.get("episode")
    beat = context.get("beat")
    primary_slot = str(context.get("primary_slot") or "").strip() or "render"
    ep_label = f"EP{episode}" if episode is not None else "EP?"
    beat_label = f"Beat {beat}" if beat is not None else "Beat ?"
    return f"{ep_label} / {beat_label} / {primary_slot}"


def _upload_node(node_id: str, x: int, y: int, ref: dict[str, Any]) -> dict[str, Any]:
    actual_ratio = str(ref.get("aspect_ratio") or "1:1")
    generation_ratio = _nearest_supported_image_aspect_ratio(actual_ratio)
    data: dict[str, Any] = {
        "displayName": ref.get("label") or ref.get("role") or "reference",
        "imageUrl": ref.get("url"),
        "previewImageUrl": ref.get("url"),
        "aspectRatio": generation_ratio,
        "__freezone_source": _node_source_from_ref(ref),
        "preset_managed": True,
    }
    contexts = _node_mainline_context_from_ref(ref)
    if contexts:
        data["mainline_context"] = contexts
    if actual_ratio and actual_ratio != generation_ratio:
        data["actualAspectRatio"] = actual_ratio
    return {
        "id": node_id,
        "type": "uploadNode",
        "position": {"x": x, "y": y},
        "data": data,
    }


def _pano_360_viewer_node(node_id: str, x: int, y: int, ref: dict[str, Any]) -> dict[str, Any]:
    url = ref.get("url")
    node = {
        "id": node_id,
        "type": "pano360ViewerNode",
        "position": {"x": x, "y": y},
        "data": {
            "displayName": ref.get("label") or ref.get("role") or "360 panorama",
            "panoUrl": url,
            "imageUrl": url,
            "previewImageUrl": url,
            "url": url,
            "aspectRatio": ref.get("aspect_ratio") or "2:1",
            "__freezone_source": _node_source_from_ref(ref),
            "preset_managed": True,
        },
    }
    contexts = _node_mainline_context_from_ref(ref)
    if contexts:
        node["data"]["mainline_context"] = contexts
    return node


def _three_d_world_node(node_id: str, x: int, y: int, ref: dict[str, Any]) -> dict[str, Any]:
    url = ref.get("url")
    meta = ref.get("meta") if isinstance(ref.get("meta"), dict) else {}
    ply_kind = str(meta.get("ply_kind") or "").strip().lower()
    node = {
        "id": node_id,
        "type": "threeDWorldNode",
        "position": {"x": x, "y": y},
        "data": {
            "displayName": ref.get("label") or ref.get("role") or "3GS",
            "plyUrl": url,
            "modelUrl": url,
            "fileUrl": url,
            "url": url,
            "sourceFileName": Path(str(ref.get("rel_path") or "")).name or None,
            "__freezone_source": _node_source_from_ref(ref),
            "preset_managed": True,
        },
    }
    if ply_kind in {"master", "reverse", "pano"}:
        node["data"]["plyKind"] = ply_kind
    contexts = _node_mainline_context_from_ref(ref)
    if contexts:
        node["data"]["mainline_context"] = contexts
    return node


def _director_world_source_from_ref(ref: dict[str, Any], scene_id: str) -> dict[str, Any] | None:
    url = ref.get("url")
    if not isinstance(url, str) or not url:
        return None
    role = str(ref.get("role") or "")
    safe_scene = _safe_id(scene_id, fallback="scene")
    label = str(ref.get("label") or role or "Director World source")
    meta = ref.get("meta") if isinstance(ref.get("meta"), dict) else {}
    if role in {"scene_director_pano_360", "scene_360"}:
        return {
            "id": f"scene-pano:{safe_scene}",
            "source_type": "pano360",
            "source_kind": "pano",
            "label": label,
            "url": url,
            "pano_url": url,
            "slot_kind": "scene_director_pano_360",
        }
    if role.startswith("scene_3gs_"):
        ply_kind = str(meta.get("ply_kind") or "").strip().lower()
        if not ply_kind:
            if role == "scene_3gs_master_ply":
                ply_kind = "master"
            elif role == "scene_3gs_reverse_ply":
                ply_kind = "reverse"
            elif role == "scene_3gs_pano_ply":
                ply_kind = "pano"
            else:
                ply_kind = "custom"
        return {
            "id": f"scene-sog:{ply_kind}:{safe_scene}",
            "source_type": "sog",
            "source_kind": ply_kind,
            "label": label,
            "ply_url": url,
            "url": url,
            "current": role == "scene_3gs_active_ply",
        }
    return None


def _director_world_node(
    node_id: str,
    x: int,
    y: int,
    *,
    scene_id: str,
    refs: list[dict[str, Any]],
) -> dict[str, Any]:
    sources: list[dict[str, Any]] = []
    seen_urls: set[str] = set()
    for ref in refs:
        source = _director_world_source_from_ref(ref, scene_id)
        if not source:
            continue
        source_url = str(source.get("pano_url") or source.get("ply_url") or source.get("url") or "")
        if source_url and source_url in seen_urls:
            continue
        if source_url:
            seen_urls.add(source_url)
        sources.append(source)

    active_source = (
        next((source for source in sources if source.get("current")), None)
        or next((source for source in sources if source.get("source_type") == "sog"), None)
        or (sources[0] if sources else None)
    )
    pano_source = next(
        (source for source in sources if source.get("source_type") == "pano360"),
        None,
    )
    preview_url = next(
        (
            ref.get("url")
            for ref in refs
            if str(ref.get("role") or "")
            in {"scene_master", "scene_director_pano_360", "scene_360"}
            and isinstance(ref.get("url"), str)
            and ref.get("url")
        ),
        None,
    )
    data: dict[str, Any] = {
        "displayName": f"{scene_id} 导演世界",
        "sources": sources,
        "activeSourceId": active_source.get("id") if active_source else None,
        "plyUrl": (
            active_source.get("ply_url")
            if active_source and active_source.get("source_type") == "sog"
            else None
        ),
        "panoUrl": pano_source.get("pano_url") if pano_source else None,
        "previewImageUrl": preview_url,
        "__freezone_source": {
            "kind": "scene",
            "role": "director_world",
            "label": f"{scene_id} director world",
            "meta": {"scene_id": scene_id},
        },
        "preset_managed": True,
    }
    contexts = _node_mainline_context_from_ref(refs[0]) if refs else []
    if contexts:
        data["mainline_context"] = contexts
    return {
        "id": node_id,
        "type": "threeDWorldNode",
        "position": {"x": x, "y": y},
        "data": data,
    }


def _asset_node_source_from_ref(ref: dict[str, Any]) -> dict[str, Any]:
    source = _node_source_from_ref(ref)
    role = str(ref.get("role") or "")
    if role == "character_portrait":
        source["kind"] = "portrait"
    elif role == "identity_portrait":
        source["kind"] = "identity_portrait"
    elif role == "identity_costume":
        source["kind"] = "identity_costume"
    return source


def _image_gen_node(
    node_id: str,
    x: int,
    y: int,
    label: str,
    prompt: str,
    *,
    aspect_ratio: str = "1:1",
    actual_aspect_ratio: str | None = None,
    source_meta: dict[str, Any] | None = None,
) -> dict[str, Any]:
    actual_ratio = str(actual_aspect_ratio or aspect_ratio or "1:1")
    generation_ratio = _nearest_supported_image_aspect_ratio(actual_ratio)
    data: dict[str, Any] = {
        "displayName": label,
        "imageUrl": None,
        "previewImageUrl": None,
        "aspectRatio": generation_ratio,
        "isSizeManuallyAdjusted": False,
        "requestAspectRatio": "auto",
        "prompt": prompt,
        "model": FREEZONE_PRESET_DEFAULT_IMAGE_MODEL,
        "size": "2K",
        "count": 1,
        "styleTemplateId": None,
        "focusRegion": None,
        "cameraSelection": None,
        "marks": [],
        "isGenerating": False,
        "generationStartedAt": None,
        "generationDurationMs": 60000,
        "__freezone_source": source_meta or {},
        "preset_managed": True,
    }
    if actual_ratio and actual_ratio != generation_ratio:
        data["actualAspectRatio"] = actual_ratio
    return {
        "id": node_id,
        "type": "imageGenNode",
        "position": {"x": x, "y": y},
        "data": data,
    }


def _asset_image_node(node_id: str, x: int, y: int, ref: dict[str, Any]) -> dict[str, Any]:
    node = _image_gen_node(
        node_id,
        x,
        y,
        str(ref.get("label") or ref.get("role") or "asset"),
        "",
        aspect_ratio=str(ref.get("aspect_ratio") or "1:1"),
        actual_aspect_ratio=str(ref.get("aspect_ratio") or "1:1"),
        source_meta=_asset_node_source_from_ref(ref),
    )
    node["data"]["imageUrl"] = ref.get("url")
    node["data"]["previewImageUrl"] = ref.get("url")
    contexts = _node_mainline_context_from_ref(ref)
    if contexts:
        node["data"]["mainline_context"] = contexts
    return node


def _ref_image_node(node_id: str, x: int, y: int, ref: dict[str, Any]) -> dict[str, Any]:
    role = str(ref.get("role") or "")
    rel_path = str(ref.get("rel_path") or "")
    media_type = str(ref.get("media_type") or "")
    if role.startswith("scene_3gs_") or (
        media_type == "file" and rel_path.lower().endswith((".ply", ".sog", ".splat", ".ksplat"))
    ):
        return _three_d_world_node(node_id, x, y, ref)
    if role in {"scene_director_pano_360", "scene_360"}:
        return _pano_360_viewer_node(node_id, x, y, ref)
    if role in DIRECTOR_CAPTURE_IMAGE_ROLES:
        return _asset_image_node(node_id, x, y, ref)
    if str(ref.get("role") or "") in {
        "character_portrait",
        "character_identity",
        "identity_portrait",
        "identity_costume",
        "prop_reference",
        "scene_master",
        "scene_reverse_master",
    }:
        return _asset_image_node(node_id, x, y, ref)
    return _upload_node(node_id, x, y, ref)


def _edge(
    edge_id: str,
    source: str,
    target: str,
    data: dict[str, Any] | None = None,
    *,
    source_handle: str | None = None,
    target_handle: str | None = None,
) -> dict[str, Any]:
    edge_data = dict(data or {})
    edge_data.setdefault("preset_managed", True)
    edge = {
        "id": edge_id,
        "source": source,
        "target": target,
        "data": edge_data,
    }
    if source_handle:
        edge["sourceHandle"] = source_handle
    if target_handle:
        edge["targetHandle"] = target_handle
    return edge


def _candidate_binding_edge(edge_id: str, source: str, target: str, role: str) -> dict[str, Any]:
    edge = _edge(edge_id, target, source)
    edge["data"] = {
        "edgeKind": "role_binding",
        "propagates": True,
        "role": role,
        "sourceNodeId": source,
        "beatContextNodeId": target,
        "preset_managed": True,
    }
    return edge


def _skill_role_edge(
    edge_id: str,
    source: str,
    target: str,
    *,
    role: str,
    label: str,
    source_handle: str | None = None,
    target_handle: str | None = None,
    extra_data: dict[str, Any] | None = None,
) -> dict[str, Any]:
    edge = _edge(
        edge_id,
        source,
        target,
        {
            "edgeKind": "role_binding",
            "role": role,
            "label": label,
        },
    )
    if extra_data:
        edge["data"].update(extra_data)
    edge["targetHandle"] = target_handle or role
    if source_handle:
        edge["sourceHandle"] = source_handle
    return edge


def _reference_path_lookup_keys(raw_path: str, project_dir: Path) -> set[str]:
    """Return stable lookup keys for matching NovelVideo ref-plan paths to canvas refs."""
    value = str(raw_path or "").strip()
    if not value:
        return set()
    keys = {value}
    try:
        path = Path(value)
        absolute_path = path if path.is_absolute() else project_dir / path
        resolved = absolute_path.resolve()
        keys.add(str(resolved))
        keys.add(resolved.as_posix())
        try:
            keys.add(resolved.relative_to(project_dir.resolve()).as_posix())
        except Exception:
            pass
    except Exception:
        pass
    return {key for key in keys if key}


def _is_asset_library_reference(ref: dict[str, Any]) -> bool:
    rel_path = str(ref.get("rel_path") or "")
    role = str(ref.get("role") or "")
    if rel_path.startswith("freezone/"):
        return False
    if rel_path.startswith("director_control_frames/ep"):
        return False
    if role == "director_blocking" or rel_path.startswith("director_blockings/"):
        return False
    if str(ref.get("kind") or "") == "director" and rel_path.endswith(".json"):
        return False
    return True


SCENE_IMAGE_ROLES = {
    "scene_master",
    "scene_reverse_master",
    "scene_360",
    "scene_director_pano_360",
}

SCENE_PLY_INPUT_ROLES = {
    "scene_3gs_master_ply": ("scene_master",),
    "scene_3gs_reverse_ply": ("scene_reverse_master",),
    "scene_3gs_pano_ply": ("scene_director_pano_360", "scene_360"),
    "scene_3gs_custom_scene": ("scene_master", "scene_director_pano_360", "scene_360"),
}

SCENE_PLY_WORKFLOW_ROLES = {
    "scene_3gs_master_ply": ("master", "scene_master", "3D 世界（正面）"),
    "scene_3gs_reverse_ply": ("reverse", "scene_reverse_master", "3D 世界（背面）"),
    "scene_3gs_pano_ply": ("pano", "scene_director_pano_360", "3D 世界（360）"),
}

DIRECTOR_CAPTURE_IMAGE_ROLES = (
    "selected_background",
    "director_combined",
    "director_env",
    "director_env_actor",
    "actor_overlay",
    "actor_mask",
    "prop_staging_overlay",
    "prop_staging_mask",
    "director_repaired_or_alt",
)

BEAT_CONTEXT_BINDING_ROLES = {
    "current_sketch",
    "current_frame",
    "current_video",
    "current_audio",
    "selected_background",
    "director_combined",
}

DIRECTOR_CAPTURE_LAYOUT_POSITIONS = {
    "selected_background": (-1080, -1040),
    "director_env": (-1500, 1560),
    "director_combined": (-1080, -360),
    "actor_overlay": (-1060, 1560),
    "director_env_actor": (-620, 1560),
    "prop_staging_overlay": (-1500, 1940),
    "actor_mask": (-1060, 1940),
    "prop_staging_mask": (-620, 1940),
    "director_repaired_or_alt": (-1500, 2320),
}

SKETCH_DIRECTOR_CAPTURE_LAYOUT_POSITIONS = {
    "selected_background": (-1080, -1040),
    "director_combined": (-1080, -360),
    "director_env": (-1500, 1560),
    "actor_overlay": (-1060, 1560),
    "director_env_actor": (-620, 1560),
    "prop_staging_overlay": (-1500, 1940),
    "actor_mask": (-1060, 1940),
    "prop_staging_mask": (-620, 1940),
    "director_repaired_or_alt": (-1500, 2320),
}


def _scene_prompt_content(scene_id: str, meta: dict[str, Any]) -> str:
    env_prompt = str(meta.get("environment_prompt") or "").strip()
    description = str(meta.get("description") or "").strip()
    scene_type = str(meta.get("scene_type") or "").strip()
    lines = [f"Scene: {scene_id}"]
    if scene_type:
        lines.append(f"Type: {scene_type}")
    if env_prompt:
        lines.extend(["", "[Environment Prompt]", env_prompt])
    if description and description != env_prompt:
        lines.extend(["", "[Description]", description])
    if not env_prompt and not description:
        lines.extend(["", "No scene prompt found; use the scene id as fallback intent."])
    style_block = _scene_style_block_from_meta(meta)
    if style_block:
        lines.extend(["", style_block])
    return "\n".join(lines)


def _scene_style_block_from_meta(meta: dict[str, Any]) -> str:
    style_name = str(meta.get("style_name") or "").strip()
    style_prompt = str(meta.get("style_prompt") or "").strip()
    avoid_instructions = str(meta.get("avoid_instructions") or "").strip()
    if not style_name and not style_prompt and not avoid_instructions:
        return ""
    parts = ["PROJECT STYLE PRESET:"]
    if style_name:
        parts.append(f"- Style id/name: {style_name}")
    if style_prompt:
        parts.append("- Positive style directives:")
        parts.append(style_prompt)
    if avoid_instructions:
        parts.append("- Negative / avoid directives:")
        parts.append(avoid_instructions)
    parts.append("- Apply this style preset consistently to the scene asset.")
    return "\n".join(parts)


def _project_style_meta(username: str, project: str, project_dir: Path) -> dict[str, str]:
    try:
        from novelvideo.config import IMAGE_DEFAULT_STYLE, get_style_preset
        from novelvideo.project_config import load_project_config

        project_config = load_project_config(username, project)
        style_id = str(project_config.get("visual_style") or IMAGE_DEFAULT_STYLE).strip()
        preset = get_style_preset(
            style_id, username=username, project=project, project_dir=str(project_dir)
        )
        label = str(preset.get("label") or style_id).strip()
        style_name = f"{label} ({style_id})" if label and label != style_id else style_id
        return {
            "style_name": style_name,
            "style_prompt": str(preset.get("style_instructions") or "").strip(),
            "avoid_instructions": str(preset.get("avoid_instructions") or "").strip(),
        }
    except Exception:
        return {}


def _scene_from_prompt_meta(scene_id: str, meta: dict[str, Any]) -> NovelScene:
    # Prefer the raw environment prompt: the composed effective prompt would be
    # re-composed (and partially dropped) by build_scene_effective_prompt.
    environment_prompt = str(
        meta.get("raw_environment_prompt") or meta.get("environment_prompt") or ""
    ).strip()
    return NovelScene(
        name=scene_id,
        scene_type=str(meta.get("scene_type") or "interior").strip() or "interior",
        base_scene_id=str(meta.get("base_scene_id") or "").strip(),
        variant_id=str(meta.get("variant_id") or "").strip(),
        time_of_day=str(meta.get("time_of_day") or "").strip(),
        description=str(meta.get("description") or "").strip(),
        environment_prompt=environment_prompt,
        variant_prompt=str(meta.get("variant_prompt") or "").strip(),
    )


def _base_scene_from_prompt_meta(meta: dict[str, Any]) -> NovelScene | None:
    base_scene_id = str(meta.get("base_scene_id") or "").strip()
    base_environment_prompt = str(meta.get("base_environment_prompt") or "").strip()
    base_description = str(meta.get("base_description") or "").strip()
    if not base_scene_id or not (base_environment_prompt or base_description):
        return None
    return NovelScene(
        name=base_scene_id,
        scene_type=str(meta.get("base_scene_type") or "interior").strip() or "interior",
        environment_prompt=base_environment_prompt,
        description=base_description,
    )


def _scene_reference_prompt_content(
    scene_id: str,
    meta: dict[str, Any],
    *,
    kind: str,
    has_master_reference: bool = False,
) -> str:
    scene = _scene_from_prompt_meta(scene_id, meta)
    return build_scene_reference_prompt(
        kind,  # type: ignore[arg-type]
        scene,
        style_name=str(meta.get("style_name") or "").strip(),
        style_prompt=str(meta.get("style_prompt") or "").strip(),
        avoid_instructions=str(meta.get("avoid_instructions") or "").strip(),
        has_master_reference=has_master_reference,
        base_scene=_base_scene_from_prompt_meta(meta),
    )


def _scene_ply_input_roles(role: str, ref: dict[str, Any]) -> tuple[str, ...] | None:
    if role != "scene_3gs_active_ply":
        return SCENE_PLY_INPUT_ROLES.get(role)

    rel_path = str(ref.get("rel_path") or "").lower()
    meta = ref.get("meta") if isinstance(ref.get("meta"), dict) else {}
    ply_kind = str(meta.get("ply_kind") or "").strip().lower()
    source_hint = f"{ply_kind} {rel_path}"
    if "master_sharp" in source_hint or ply_kind == "master":
        return ("scene_master",)
    if "reverse_sharp" in source_hint or ply_kind == "reverse":
        return ("scene_reverse_master",)
    if "pano_sharp" in source_hint or "pano_depth" in source_hint or ply_kind == "pano":
        return ("scene_director_pano_360", "scene_360")
    if "custom" in source_hint or ply_kind == "custom":
        return ("scene_master", "scene_director_pano_360", "scene_360")
    return ("scene_master", "scene_reverse_master", "scene_director_pano_360", "scene_360")


def _append_scene_asset_workflow(
    *,
    nodes: list[dict[str, Any]],
    edges: list[dict[str, Any]],
    ref_node_ids: list[tuple[dict[str, Any], str]],
    layout_style: str = "default",
) -> None:
    scene_refs: dict[str, list[tuple[dict[str, Any], str]]] = {}
    for ref, node_id in ref_node_ids:
        role = str(ref.get("role") or "")
        if role not in SCENE_IMAGE_ROLES and not role.startswith("scene_3gs_"):
            continue
        meta = ref.get("meta") if isinstance(ref.get("meta"), dict) else {}
        scene_id = str(meta.get("scene_id") or meta.get("scene") or "").strip()
        if not scene_id:
            continue
        scene_refs.setdefault(scene_id, []).append((ref, node_id))

    for scene_index, (scene_id, items) in enumerate(sorted(scene_refs.items())):
        prompt_source_ref = next(
            (ref for ref, _node_id in items if str(ref.get("role") or "") in SCENE_IMAGE_ROLES),
            items[0][0],
        )
        prompt_meta = (
            prompt_source_ref.get("meta") if isinstance(prompt_source_ref.get("meta"), dict) else {}
        )
        safe_scene = _safe_id(scene_id, fallback="scene")
        role_to_node: dict[str, str] = {}
        role_to_ref: dict[str, dict[str, Any]] = {}
        for ref, node_id in items:
            role = str(ref.get("role") or "")
            role_to_node.setdefault(role, node_id)
            role_to_ref.setdefault(role, ref)

        def _ensure_ply_workflow_node(
            role: str,
            *,
            x: int,
            y: int,
        ) -> str | None:
            existing_id = role_to_node.get(role)
            if existing_id:
                return existing_id
            config = SCENE_PLY_WORKFLOW_ROLES.get(role)
            if not config:
                return None
            ply_kind, preferred_source_role, label_suffix = config
            input_roles = SCENE_PLY_INPUT_ROLES.get(role, ())
            has_input = any(input_role in role_to_node for input_role in input_roles)
            if not has_input:
                return None
            source_ref = role_to_ref.get(preferred_source_role)
            if source_ref is None:
                source_ref = next(
                    (
                        role_to_ref[input_role]
                        for input_role in input_roles
                        if input_role in role_to_ref
                    ),
                    None,
                )
            source_meta = (
                source_ref.get("meta")
                if source_ref is not None and isinstance(source_ref.get("meta"), dict)
                else prompt_meta
            )
            ref = {
                "kind": "scene",
                "role": role,
                "label": f"{scene_id} {label_suffix}",
                "rel_path": None,
                "url": None,
                "exists": False,
                "media_type": "file",
                "aspect_ratio": "1:1",
                "meta": {**source_meta, "scene_id": scene_id, "ply_kind": ply_kind},
            }
            node_id = f"workflow_scene_{safe_scene}_{ply_kind}_ply"
            if any(node.get("id") == node_id for node in nodes):
                role_to_node[role] = node_id
                role_to_ref[role] = ref
                return node_id
            nodes.append(_three_d_world_node(node_id, x, y, ref))
            items.append((ref, node_id))
            role_to_node[role] = node_id
            role_to_ref[role] = ref
            return node_id

        def _set_scene_node_position(node_id: str | None, x: int, y: int) -> None:
            if not node_id:
                return
            for node in nodes:
                if node.get("id") == node_id:
                    node["position"] = {"x": x, "y": y}
                    return

        master_node = role_to_node.get("scene_master")
        reverse_node = role_to_node.get("scene_reverse_master")
        if layout_style == "sketch":
            master_prompt_pos = (-630, 590)
            reverse_prompt_pos = (1040, 730)
            generic_prompt_pos = (-680, 1160)
        elif layout_style == "beat":
            scene_row_y = 640 + scene_index * 900
            master_prompt_pos = (-540, scene_row_y)
            reverse_prompt_pos = (300, scene_row_y + 380)
            generic_prompt_pos = (-540, scene_row_y + 460)
        else:
            scene_y = scene_index * 1180
            master_prompt_pos = (100, 110 + scene_y)
            reverse_prompt_pos = (655, -376 + scene_y)
            generic_prompt_pos = (55, 520 + scene_y)
            _set_scene_node_position(master_node, 620, 100 + scene_y)
            _set_scene_node_position(reverse_node, 1460, -250 + scene_y)

            pano_roles = [
                role for role in ("scene_director_pano_360", "scene_360") if role in role_to_node
            ]
            for idx, role in enumerate(pano_roles):
                # Pano viewer 从 x=620 右移到 x=1240,腾出左边空间给
                # scene_director_pano_360 workflow trigger 表达数据流方向。
                _set_scene_node_position(role_to_node.get(role), 1240, 500 + scene_y + idx * 320)

            ply_roles = [
                role
                for role in (
                    "scene_3gs_active_ply",
                    "scene_3gs_master_ply",
                    "scene_3gs_reverse_ply",
                    "scene_3gs_pano_ply",
                    "scene_3gs_custom_scene",
                )
                if role in role_to_node
            ]
            for idx, role in enumerate(ply_roles):
                _set_scene_node_position(role_to_node.get(role), 1460, 460 + scene_y + idx * 320)

            for idx, role in enumerate(SCENE_PLY_WORKFLOW_ROLES):
                _ensure_ply_workflow_node(role, x=1460, y=460 + scene_y + idx * 320)

        if master_node:
            master_prompt_id = f"prompt_scene_{safe_scene}_master"
            if not any(node.get("id") == master_prompt_id for node in nodes):
                master_meta = (
                    role_to_ref.get("scene_master", {}).get("meta")
                    if isinstance(role_to_ref.get("scene_master", {}).get("meta"), dict)
                    else prompt_meta
                )
                nodes.append(
                    _prompt_text_node(
                        master_prompt_id,
                        master_prompt_pos[0],
                        master_prompt_pos[1],
                        f"{scene_id} master prompt",
                        _scene_reference_prompt_content(
                            scene_id,
                            master_meta,
                            kind="master",
                        ),
                        source_meta={
                            "kind": "scene_prompt",
                            "role": "scene_master_generation_prompt",
                            "label": f"{scene_id} master prompt",
                            "meta": {"scene_id": scene_id, "scene_reference_kind": "master"},
                        },
                    )
                )
            edges.append(
                _edge(
                    f"edge_{master_prompt_id}_to_{_safe_id(master_node)}",
                    master_prompt_id,
                    master_node,
                )
            )
            base_scene_id = str(prompt_meta.get("base_scene_id") or "").strip()
            base_master_url = str(prompt_meta.get("base_master_url") or "").strip()
            if base_scene_id and base_master_url:
                base_master_node_id = f"ref_scene_base_master_{safe_scene}"
                if not any(node.get("id") == base_master_node_id for node in nodes):
                    base_master_rel_path = str(
                        prompt_meta.get("base_master_rel_path") or ""
                    ).strip()
                    base_ref = {
                        "kind": "scene",
                        "role": "scene_base_master",
                        "label": f"{base_scene_id} base master",
                        "rel_path": base_master_rel_path or None,
                        "url": base_master_url,
                        "exists": True,
                        "media_type": "image",
                        "aspect_ratio": "16:9",
                        "meta": {
                            **prompt_meta,
                            "scene_id": base_scene_id,
                            "derived_scene_id": scene_id,
                            "base_for_scene_id": scene_id,
                        },
                    }
                    nodes.append(
                        _asset_image_node(
                            base_master_node_id,
                            master_prompt_pos[0],
                            master_prompt_pos[1] + 300,
                            base_ref,
                        )
                    )
                edges.append(
                    _edge(
                        f"edge_{base_master_node_id}_to_{_safe_id(master_node)}",
                        base_master_node_id,
                        master_node,
                        {"edgeKind": "scene_base_master_dependency"},
                    )
                )

        if reverse_node:
            reverse_prompt_id = f"prompt_scene_{safe_scene}_reverse_master"
            if not any(node.get("id") == reverse_prompt_id for node in nodes):
                reverse_meta = (
                    role_to_ref.get("scene_reverse_master", {}).get("meta")
                    if isinstance(role_to_ref.get("scene_reverse_master", {}).get("meta"), dict)
                    else prompt_meta
                )
                nodes.append(
                    _prompt_text_node(
                        reverse_prompt_id,
                        reverse_prompt_pos[0],
                        reverse_prompt_pos[1],
                        f"{scene_id} reverse master prompt",
                        _scene_reference_prompt_content(
                            scene_id,
                            reverse_meta,
                            kind="reverse_master",
                            has_master_reference=bool(master_node),
                        ),
                        source_meta={
                            "kind": "scene_prompt",
                            "role": "scene_reverse_master_generation_prompt",
                            "label": f"{scene_id} reverse master prompt",
                            "meta": {
                                "scene_id": scene_id,
                                "scene_reference_kind": "reverse_master",
                            },
                        },
                    )
                )
            if master_node:
                edges.append(
                    _edge(
                        f"edge_{_safe_id(master_node)}_to_{_safe_id(reverse_node)}",
                        master_node,
                        reverse_node,
                    )
                )
            edges.append(
                _edge(
                    f"edge_{reverse_prompt_id}_to_{_safe_id(reverse_node)}",
                    reverse_prompt_id,
                    reverse_node,
                )
            )

        generic_roles = {
            role
            for role in SCENE_IMAGE_ROLES
            if role not in {"scene_master", "scene_reverse_master"}
        }
        if any(role in role_to_node for role in generic_roles):
            prompt_id = f"prompt_scene_{safe_scene}"
        else:
            prompt_id = ""
        if prompt_id and not any(node.get("id") == prompt_id for node in nodes):
            nodes.append(
                _prompt_text_node(
                    prompt_id,
                    generic_prompt_pos[0],
                    generic_prompt_pos[1],
                    f"{scene_id} scene prompt",
                    _scene_prompt_content(scene_id, prompt_meta),
                    source_meta={
                        "kind": "scene_prompt",
                        "role": "scene_generation_prompt",
                        "label": f"{scene_id} scene prompt",
                        "meta": {"scene_id": scene_id},
                    },
                )
            )

        for ref, node_id in items:
            role = str(ref.get("role") or "")
            if prompt_id and role in generic_roles:
                # 资产画布 (layout_style=="default") 下,scene_director_pano_360 /
                # scene_360 viewer 旁会有独立的 workflow_scene_director_pano_360
                # trigger;prompt 应该连到 trigger 而非 viewer。这条 edge 在 asset
                # preset Phase 1d 阶段单独 emit。
                # Beat 画布 (layout_style=="beat" / "sketch") 下,pano viewer 是
                # 信息性参考节点 (没独立 trigger),prompt → pano viewer 仍有意义。
                if layout_style == "default" and role in {"scene_director_pano_360", "scene_360"}:
                    continue
                edges.append(
                    _edge(
                        f"edge_{prompt_id}_to_{_safe_id(node_id)}",
                        prompt_id,
                        node_id,
                    )
                )

        for pano_role in ("scene_director_pano_360", "scene_360"):
            source_id = role_to_node.get(pano_role)
            source_ref = role_to_ref.get(pano_role)
            if not source_id or not source_ref:
                continue
            source_node = next((node for node in nodes if node.get("id") == source_id), None)
            if source_node and source_node.get("type") == "pano360ViewerNode":
                continue
            viewer_id = f"viewer_{_safe_id(source_id)}"
            if any(node.get("id") == viewer_id for node in nodes):
                continue
            source_position = (source_node or {}).get("position") or {}
            source_x = int(source_position.get("x") or 0)
            source_y = int(source_position.get("y") or 0)
            viewer_x = source_x
            viewer_y = source_y + 360
            if layout_style == "sketch":
                viewer_x = 880
                viewer_y = 1135 + scene_index * 520
            if layout_style == "default":
                viewer_x = 1420
                viewer_y = 945 + scene_index * 1180
            nodes.append(
                _pano_360_viewer_node(
                    viewer_id,
                    viewer_x,
                    viewer_y,
                    source_ref,
                )
            )
            edges.append(
                _edge(
                    f"edge_{_safe_id(source_id)}_to_{_safe_id(viewer_id)}",
                    source_id,
                    viewer_id,
                )
            )

        for ref, node_id in items:
            role = str(ref.get("role") or "")
            input_roles = _scene_ply_input_roles(role, ref)
            if not input_roles:
                continue
            source_id = next(
                (
                    role_to_node[input_role]
                    for input_role in input_roles
                    if input_role in role_to_node
                ),
                None,
            )
            if source_id:
                edges.append(
                    _edge(
                        f"edge_{_safe_id(source_id)}_to_{_safe_id(node_id)}",
                        source_id,
                        node_id,
                    )
                )

        if layout_style == "default":
            director_world_id = f"director_world_scene_{safe_scene}"
            source_roles = {
                "scene_master",
                "scene_reverse_master",
                "scene_director_pano_360",
                "scene_360",
                "scene_3gs_active_ply",
                "scene_3gs_master_ply",
                "scene_3gs_reverse_ply",
                "scene_3gs_pano_ply",
                "scene_3gs_custom_scene",
            }
            source_refs = [
                ref for ref, _node_id in items if str(ref.get("role") or "") in source_roles
            ]

            for pano_role in ("scene_director_pano_360", "scene_360"):
                pano_node_id = role_to_node.get(pano_role)
                pano_ref = role_to_ref.get(pano_role)
                if not pano_node_id or not pano_ref:
                    continue
                existing_node = next(
                    (node for node in nodes if node.get("id") == pano_node_id),
                    None,
                )
                if not existing_node:
                    continue
                pos = existing_node.get("position") or {}
                pano_node = _asset_image_node(
                    pano_node_id,
                    int(pos.get("x") or 1240),
                    int(pos.get("y") or 500 + scene_index * 1180),
                    pano_ref,
                )
                pano_node["data"].update(
                    {
                        "media_kind": "pano360",
                        "output_role": "scene_director_pano_360",
                        "aspectRatio": "2:1",
                        "actualAspectRatio": "2:1",
                    }
                )
                nodes[:] = [pano_node if node.get("id") == pano_node_id else node for node in nodes]

            removed_world_node_ids = {
                node_id
                for role, node_id in role_to_node.items()
                if role.startswith("scene_3gs_") and node_id != director_world_id
            }
            if removed_world_node_ids:
                nodes[:] = [node for node in nodes if node.get("id") not in removed_world_node_ids]
                edges[:] = [
                    edge
                    for edge in edges
                    if edge.get("source") not in removed_world_node_ids
                    and edge.get("target") not in removed_world_node_ids
                ]

            existing_world = next(
                (node for node in nodes if node.get("id") == director_world_id),
                None,
            )
            director_world = _director_world_node(
                director_world_id,
                1880,
                500 + scene_index * 1180,
                scene_id=scene_id,
                refs=source_refs,
            )
            if existing_world:
                nodes[:] = [
                    director_world if node.get("id") == director_world_id else node
                    for node in nodes
                ]
            else:
                nodes.append(director_world)

            for role in (
                "scene_master",
                "scene_reverse_master",
                "scene_director_pano_360",
                "scene_360",
            ):
                source_id = role_to_node.get(role)
                if not source_id:
                    continue
                if any(
                    edge.get("source") == source_id and edge.get("target") == director_world_id
                    for edge in edges
                ):
                    continue
                edges.append(
                    _edge(
                        f"edge_{_safe_id(source_id)}_to_{_safe_id(director_world_id)}",
                        source_id,
                        director_world_id,
                    )
                )


def _append_director_capture_workflow(
    *,
    edges: list[dict[str, Any]],
    ref_node_ids: list[tuple[dict[str, Any], str]],
) -> None:
    role_to_nodes: dict[str, list[str]] = {}
    for ref, node_id in ref_node_ids:
        role = str(ref.get("role") or "")
        role_to_nodes.setdefault(role, []).append(node_id)

    source_id = next(
        (
            node_id
            for role in (
                "scene_3gs_active_ply",
                "scene_3gs_master_ply",
                "scene_3gs_pano_ply",
                "scene_3gs_reverse_ply",
                "scene_3gs_uploaded_ply",
            )
            for node_id in role_to_nodes.get(role, [])
        ),
        None,
    )
    if not source_id:
        return

    def has_edge(source: str, target: str) -> bool:
        return any(edge.get("source") == source and edge.get("target") == target for edge in edges)

    for role in DIRECTOR_CAPTURE_IMAGE_ROLES:
        for target_id in role_to_nodes.get(role, []):
            if has_edge(source_id, target_id):
                continue
            edges.append(
                _edge(
                    f"edge_{_safe_id(source_id)}_to_{_safe_id(target_id)}",
                    source_id,
                    target_id,
                )
            )


def _prompt_text_node(
    node_id: str,
    x: int,
    y: int,
    label: str,
    prompt: str,
    *,
    source_meta: dict[str, Any] | None = None,
) -> dict[str, Any]:
    node = _text_node(node_id, x, y, label, prompt)
    if source_meta:
        node["data"]["__freezone_source"] = source_meta
    return node


def _display_prompt_text(prompt: str, *, fallback_note: str) -> str:
    normalized = str(prompt or "").strip()
    return normalized or fallback_note


def _character_profile_content(profile: dict[str, Any]) -> str:
    def _text(value: Any) -> str:
        return str(value or "").strip()

    aliases = [_text(alias) for alias in (profile.get("aliases") or []) if _text(alias)]
    lines = [
        f"名称: {_text(profile.get('name')) or '(未填写)'}",
        f"性别: {_text(profile.get('gender')) or '(未填写)'}",
        f"角色定位: {_text(profile.get('role')) or '(未填写)'}",
        f"别名: {', '.join(aliases) if aliases else '(未填写)'}",
        f"年龄段: {_text(profile.get('age_group')) or '(未填写)'}",
    ]
    body_type = _text(profile.get("body_type"))
    if body_type:
        lines.append(f"体型: {body_type}")
    description = _text(profile.get("description"))
    if description:
        lines.extend(["", "描述:", description])
    face_prompt = _text(profile.get("face_prompt"))
    if face_prompt:
        lines.extend(["", "面部特征（face_prompt，不含服装）:", face_prompt])
    return "\n".join(lines)


def _prop_profile_content(profile: dict[str, Any]) -> str:
    def _text(value: Any) -> str:
        return str(value or "").strip()

    aliases = [str(item).strip() for item in profile.get("aliases") or [] if str(item).strip()]
    lines = [
        f"名称: {_text(profile.get('name'))}",
        f"类型: {_text(profile.get('prop_type')) or 'object'}",
    ]
    if aliases:
        lines.append(f"别名: {'、'.join(aliases)}")
    owner = _text(profile.get("owner"))
    if owner:
        lines.append(f"所属角色: {owner}")
    description = _text(profile.get("description"))
    if description:
        lines.extend(["", "描述:", description])
    visual_prompt = _text(profile.get("visual_prompt"))
    if visual_prompt:
        lines.extend(["", "视觉 Prompt:", visual_prompt])
    notes = _text(profile.get("notes"))
    if notes:
        lines.extend(["", "备注:", notes])
    return "\n".join(lines)


def _gender_label(value: str) -> str:
    normalized = str(value or "").strip().lower()
    if normalized in {"男", "男性", "male", "m"}:
        return "MALE"
    if normalized in {"女", "女性", "female", "f"}:
        return "FEMALE"
    return str(value or "").strip()


def _split_marker_color(color: str) -> tuple[str, str]:
    parts = str(color or "").strip().split(" ", 1)
    if not parts or not parts[0]:
        return "", ""
    return parts[0], parts[1] if len(parts) > 1 else parts[0]


def _identity_marker_context(
    *,
    identity_id: str,
    sketch_context: dict[str, Any],
) -> dict[str, str]:
    character = _identity_character(identity_id, (sketch_context.get("characters") or {}).keys())
    profile = (sketch_context.get("characters") or {}).get(character) or {}
    suffix = _identity_name(identity_id, character)
    identity_data = next(
        (
            item
            for item in (profile.get("identities") or [])
            if str(item.get("identity_id") or "") == identity_id
        ),
        {},
    )
    color = str((sketch_context.get("sketch_colors") or {}).get(identity_id) or "").strip()
    hex_code, color_name = _split_marker_color(color)
    gender = _gender_label(str(profile.get("gender") or ""))
    body_type = str(identity_data.get("body_type") or profile.get("body_type") or "").strip()
    body_desc = ", ".join(part for part in [gender, body_type] if part) or "character figure"
    try:
        from novelvideo.generators.prompt_builder import PromptComponents

        tag = PromptComponents.compute_char_tag(character, identity_id=identity_id)
    except Exception:
        tag = f"[{_safe_id(identity_id, fallback='CHAR').upper()}]"
    return {
        "identity_id": identity_id,
        "character": character,
        "suffix": suffix,
        "tag": tag,
        "color": color,
        "hex": hex_code,
        "color_name": color_name,
        "body_desc": body_desc,
        "appearance_details": str(
            identity_data.get("appearance_details") or profile.get("appearance_details") or ""
        ).strip(),
    }


def _prop_marker_context(
    prop_id: str,
    prop_menu: list[dict[str, Any]],
    prop_marker_colors: dict[str, str] | None = None,
) -> dict[str, str]:
    prop_info = next((item for item in prop_menu if str(item.get("prop_id") or "") == prop_id), {})
    try:
        from novelvideo.generators.prompt_builder import PromptComponents

        tag = PromptComponents.compute_prop_tag(prop_id)
    except Exception:
        tag = f"[{_safe_id(prop_id, fallback='PROP').upper()}]"
    return {
        "prop_id": prop_id,
        "tag": tag,
        "prop_type": str(prop_info.get("prop_type") or "object").strip(),
        "visual_prompt": str(prop_info.get("visual_prompt") or "").strip(),
        "description": str(prop_info.get("description") or "").strip(),
        "marker_color": str((prop_marker_colors or {}).get(prop_id) or "").strip(),
    }


def _replace_beat_markers(
    text: str,
    identity_markers: dict[str, dict[str, str]],
    prop_markers: dict[str, dict[str, str]],
) -> str:
    def replace_match(match: re.Match) -> str:
        identity_id = str(match.group(1) or "").strip()
        prop_id = str(match.group(2) or "").strip()
        if identity_id:
            marker = identity_markers.get(identity_id)
            if marker:
                color_name = marker.get("color_name") or marker.get("color") or "assigned color"
                return f"{marker.get('tag')} ({color_name})"
            return identity_id
        if prop_id:
            marker = prop_markers.get(prop_id)
            if marker:
                marker_color = str(marker.get("marker_color") or "").strip()
                if marker_color:
                    return f"{marker.get('tag')} ({marker_color})"
                return marker.get("tag", prop_id)
            return prop_id
        return match.group(0)

    return _MARKER_RE.sub(replace_match, text or "")


def _beat_sketch_marker_context(context: dict[str, Any]) -> dict[str, Any]:
    beat_data = context.get("beat_data") or {}
    visual_description = str(beat_data.get("visual_description") or "")
    marker_identities, marker_props = _visual_markers(visual_description)
    detected_identities = [
        _identity_id_from_item(item) for item in _as_list(beat_data.get("detected_identities"))
    ]
    detected_props = [
        _prop_id_from_item(item) for item in _as_list(beat_data.get("detected_props"))
    ]
    identity_ids = list(
        dict.fromkeys(_real_identity_ids([*marker_identities, *detected_identities]))
    )
    prop_ids = list(dict.fromkeys(_real_prop_ids([*marker_props, *detected_props])))
    sketch_context = context.get("sketch_context") or {}
    prop_marker_colors = dict(sketch_context.get("prop_marker_colors") or {})
    identities = {
        identity_id: _identity_marker_context(
            identity_id=identity_id,
            sketch_context=sketch_context,
        )
        for identity_id in identity_ids
        if identity_id
    }
    props = {
        prop_id: _prop_marker_context(
            prop_id,
            context.get("prop_menu") or [],
            prop_marker_colors=prop_marker_colors,
        )
        for prop_id in prop_ids
        if prop_id
    }
    return {
        "identities": identities,
        "props": props,
        "visual_with_tags": _replace_beat_markers(visual_description, identities, props),
    }


def _beat_sketch_marker_content(marker_context: dict[str, Any]) -> str:
    identity_lines = []
    for marker in marker_context.get("identities", {}).values():
        color = marker.get("color")
        if color:
            hex_code, color_name = _split_marker_color(color)
            identity_lines.append(
                f"- {marker.get('identity_id')} -> {marker.get('tag')} — "
                f"{color_name} ({hex_code}) figure. {marker.get('body_desc')}."
            )
        else:
            identity_lines.append(
                f"- {marker.get('identity_id')} -> {marker.get('tag')} — "
                f"{marker.get('body_desc')}."
            )

    prop_lines = []
    for marker in marker_context.get("props", {}).values():
        description = marker.get("visual_prompt") or marker.get("description") or "core prop/object"
        marker_color = str(marker.get("marker_color") or "").strip()
        if marker_color:
            prop_lines.append(
                f"- {marker.get('prop_id')} -> {marker.get('tag')} — "
                f"marker color {marker_color}; {description}"
            )
        else:
            prop_lines.append(f"- {marker.get('prop_id')} -> {marker.get('tag')} — {description}")

    lines = [
        "Sketch generation uses TEXT MARKERS, not image references.",
        "reference_images: []",
        "",
        "COLOR-CODED CHARACTERS:",
        *(identity_lines or ["- none"]),
        "",
        "NAMED CORE PROPS:",
        *(prop_lines or ["- none"]),
    ]
    return "\n".join(lines)


def _beat_sketch_prompt(context: dict[str, Any], marker_context: dict[str, Any]) -> str:
    beat_data = context.get("beat_data") or {}
    visual_with_tags = (
        marker_context.get("visual_with_tags")
        or str(beat_data.get("visual_description") or "").strip()
    )
    keyframe_prompt = str(beat_data.get("keyframe_prompt") or "").strip()
    identity_markers = list((marker_context.get("identities") or {}).values())
    prop_markers = list((marker_context.get("props") or {}).values())
    colored_character_targets = [
        marker.get("tag", "")
        for marker in identity_markers
        if marker.get("tag") and marker.get("color")
    ]
    colored_prop_markers = [
        marker
        for marker in prop_markers
        if marker.get("tag") and str(marker.get("marker_color") or "").strip()
    ]
    colored_targets = [
        *colored_character_targets,
        *[str(marker.get("tag") or "") for marker in colored_prop_markers],
    ]
    color_lines = []
    for marker in identity_markers:
        color = marker.get("color")
        if color:
            hex_code, color_name = _split_marker_color(color)
            color_lines.append(
                f"- {marker.get('tag')} — **{color_name} ({hex_code})** figure. "
                f"{marker.get('body_desc')}."
            )
        else:
            color_lines.append(f"- {marker.get('tag')} — {marker.get('body_desc')}.")
    prop_lines = []
    key_prop_color_lines = []
    for marker in prop_markers:
        marker_color = str(marker.get("marker_color") or "").strip()
        if marker_color:
            prop_lines.append(
                f"- {marker.get('tag')} — a solid {marker_color}-filled simple geometric "
                "shape replacing the prop. ZERO internal detail; the color is only an "
                "identity marker for the sketch stage."
            )
            key_prop_color_lines.append(f"- {marker.get('tag')} — flat solid {marker_color} block.")
        else:
            prop_lines.append(f"- {marker.get('prop_id')} {marker.get('tag')} — core prop/object.")
    color_law = ""
    if colored_targets:
        key_prop_colors = (
            ["", "KEY PROP COLORS:", *key_prop_color_lines] if key_prop_color_lines else []
        )
        color_law = "\n".join(
            [
                "COLOR LAW (NON-NEGOTIABLE):",
                "These named characters / named props MUST receive their assigned "
                f"color fill: {', '.join(colored_targets)}",
                "Unnamed people and extras must be gray stick figures only, NO color fill.",
                "Do not add arbitrary color fills to background, furniture, or unmarked props.",
                "",
                "COLOR-CODED CHARACTERS:",
                *(color_lines or ["- none"]),
                *key_prop_colors,
            ]
        )

    sections = [
        "Generate ONE storyboard sketch panel for this NovelVideo beat.",
        "",
        "STYLE: rushed film director's storyboard scribble, rough hand-drawn sketch on cheap white paper, raw thumbnail-grade draft.",
        "This is a blocking sketch: use stick figures, simple poses, sparse background lines, and no polished illustration.",
        "",
        color_law,
        "NAMED CORE PROPS (flat solid color blocks in sketch; rendered as real objects later):",
        *(prop_lines or ["- none"]),
        "",
        "SCENE DESCRIPTION (do NOT render this text on the image):",
        visual_with_tags,
    ]
    if keyframe_prompt:
        sections.extend(["", "KEYFRAME NOTE:", keyframe_prompt])
    sections.extend(
        [
            "",
            "ABSOLUTELY NO TEXT ON IMAGE: no labels, captions, panel numbers, signs, readable paper text, or dialogue bubbles.",
            "Human figures are minimal stick figures. Named props are simple readable shapes in the correct position; their final material is for render stage.",
            "REFERENCE IMAGES: none. This sketch stage follows NovelVideo production logic and uses text/color markers only.",
        ]
    )
    return "\n".join(part for part in sections if part is not None)


def _beat_render_prompt(context: dict[str, Any]) -> str:
    from novelvideo.generators.nanobanana_grid import (
        _resolve_scene_prop_asset_refs,
        filter_character_map_by_precomputed,
        load_precomputed_panel_detected,
    )
    from novelvideo.generators.prompt_builder import (
        PromptMode,
        UnifiedPromptBuilder,
        create_prompt_context,
    )
    from novelvideo.project_config import load_project_config_file
    from novelvideo.services.character_ref_service import build_character_map_for_grid
    from novelvideo.services.style_service import StyleService

    beat_data = context.get("beat_data") or {}
    beat_num = int(context.get("beat") or beat_data.get("beat_number") or 1)
    username = str(context.get("username") or "admin")
    project = str(context.get("project") or "")
    project_dir = Path(str(context.get("project_dir") or ""))
    project_config = load_project_config_file(username, project) if project else {}
    style = str(project_config.get("visual_style") or "chinese_period_drama")
    ethnicity = str(project_config.get("ethnicity") or "Chinese")
    sketch_aspect_ratio = _project_sketch_aspect_ratio(
        project_config,
        context.get("episode") or 1,
    )
    sketch_colors = dict((context.get("sketch_context") or {}).get("sketch_colors") or {})
    characters = list(((context.get("sketch_context") or {}).get("characters") or {}).values())
    user_output_dir = project_dir.parent if project_dir else Path("output") / username

    character_map = build_character_map_for_grid(
        grid_beats=[beat_data],
        characters=characters,
        user_output_dir=user_output_dir,
        project=project,
        sketch_colors=sketch_colors,
        use_detected_identities=True,
    )
    panel_detected = load_precomputed_panel_detected([beat_num], [beat_data])
    character_map = filter_character_map_by_precomputed(character_map, panel_detected)
    scene_refs, prop_asset_refs = _resolve_scene_prop_asset_refs(
        project_dir,
        [beat_data],
        episode_number=int(context.get("episode") or 1),
        sketch=False,
        use_director_refs=False,
        include_pano_view_refs=False,
        scene_menu=context.get("scene_menu") or [],
        prop_menu=context.get("prop_menu") or [],
    )
    style_family, animation_subtype = StyleService.get_style_branch(
        style,
        project_dir=project_dir,
    )
    ctx = create_prompt_context(
        mode=PromptMode.RENDER,
        beats=[beat_data],
        rows=1,
        cols=1,
        character_map=character_map,
        style=style,
        ethnicity=ethnicity,
        aspect_ratio=sketch_aspect_ratio,
        panel_detected_keys=panel_detected,
        scene_refs=scene_refs,
        prop_asset_refs=prop_asset_refs,
        sketch_colors=sketch_colors,
        style_family=style_family,
        animation_subtype=animation_subtype,
        project_dir=str(project_dir),
    )
    prompt = UnifiedPromptBuilder(ctx).build()
    ordered_chars = list(getattr(ctx, "resolved_render_chars", []) or [])
    plan_paths: list[str] = []
    try:
        from novelvideo.generators.prompt_builder import PromptComponents

        for entry in PromptComponents.build_reference_image_plan(ctx, ordered_chars):
            kind = str(entry.get("kind") or "")
            path = ""
            if kind in {"combined_composite", "composite", "portrait_only", "identity_portrait"}:
                path = str(entry.get("path") or "")
            elif kind in {"scene", "prop"}:
                ref = entry.get("ref")
                path = str(((getattr(ref, "image_paths", []) or [""])[0]) or "")
            if path:
                plan_paths.append(str(Path(path).resolve()))
    except Exception:
        plan_paths = []
    context["_freezone_render_reference_paths"] = plan_paths
    return prompt


def _content_for_context(context: dict[str, Any]) -> str:
    if context.get("scope") == "asset":
        lines = [
            f"Asset kind: {context.get('asset_kind')}",
            f"Character: {context.get('character') or ''}",
            f"Identity: {context.get('identity_id') or ''}",
            "",
            "[Notes]",
            "This preset is for editing a global project asset. Push affects every beat that uses it.",
        ]
        return "\n".join(lines)
    beat = context.get("beat_data") or {}
    return str(beat.get("visual_description") or "")


def _episode_overview_content(context: dict[str, Any]) -> str:
    beats = context.get("beats") if isinstance(context.get("beats"), list) else []
    return "\n".join(
        [
            f"Episode: {context.get('episode')}",
            f"Title: {context.get('episode_title') or ''}",
            f"Beats: {len(beats)}",
            "",
            "[Use]",
            "This canvas is an episode overview. Open a Beat Workbench for detailed edits.",
        ]
    )


def _episode_beat_content(episode: Any, beat: dict[str, Any]) -> str:
    return "\n".join(
        [
            f"Episode: {episode}",
            f"Beat: {beat.get('beat_number')}",
            f"Scene: {beat.get('scene_id') or ''}",
            "",
            "[Visual Description]",
            str(beat.get("visual_description") or ""),
            "",
            "[Narration]",
            str(beat.get("narration_segment") or ""),
        ]
    )


def _episode_beat_context(episode: Any, beat: dict[str, Any]) -> list[dict[str, Any]]:
    data = {
        "kind": "beat",
        "episode": episode,
        "beat": beat.get("beat_number"),
        "role": "beat_context",
        "label": f"EP{episode} Beat {beat.get('beat_number')} context",
        "visualDescription": beat.get("visual_description"),
        "narrationSegment": beat.get("narration_segment"),
        "sceneId": beat.get("scene_id"),
        "detectedIdentities": beat.get("detected_identities"),
        "detectedProps": beat.get("detected_props"),
    }
    return [{key: value for key, value in data.items() if value not in (None, "", [])}]


def _beat_context_mainline_context(context: dict[str, Any]) -> list[dict[str, Any]]:
    beat = context.get("beat_data") or {}
    sketch_context = context.get("sketch_context") or {}
    scene_id = _normalize_scene_name(beat.get("scene_ref"))
    data = {
        "kind": "beat",
        "episode": context.get("episode"),
        "beat": context.get("beat"),
        "role": "beat_context",
        "label": f"EP{context.get('episode')} Beat {context.get('beat')} context",
        "visualDescription": beat.get("visual_description"),
        "narrationSegment": beat.get("narration_segment"),
        "sceneId": scene_id,
        "detectedIdentities": beat.get("detected_identities"),
        "detectedProps": beat.get("detected_props"),
        "sketchColors": sketch_context.get("sketch_colors"),
        "propMarkerColors": sketch_context.get("prop_marker_colors"),
    }
    return [{key: value for key, value in data.items() if value not in (None, "", [])}]


def _beat_context_edit_fields(context: dict[str, Any]) -> dict[str, Any]:
    beat = context.get("beat_data") or {}
    return {
        "visual_description": str(beat.get("visual_description") or ""),
        "scene_id": _normalize_scene_name(beat.get("scene_ref")),
        "time_of_day": str(beat.get("time_of_day") or ""),
        "detected_identities": [
            str(item or "").strip()
            for item in _as_list(beat.get("detected_identities"))
            if str(item or "").strip()
        ],
        "detected_props": [
            str(item or "").strip()
            for item in _as_list(beat.get("detected_props"))
            if str(item or "").strip()
        ],
    }


async def build_asset_preset_context(
    *,
    project_id: str,
    username: str,
    project: str,
    project_dir: Path,
    store: Any,
    asset_kind: str,
    character: str | None = None,
    identity_id: str | None = None,
    asset_id: str | None = None,
    example_beat_limit: int = 0,
) -> dict[str, Any]:
    refs: list[PresetRef] = []
    asset_kind = (asset_kind or "").strip()
    generation_context: dict[str, Any] = {}
    if asset_kind in {"identity", "portrait", "character"}:
        if not character:
            raise ValueError(f"{asset_kind} preset requires character")
        if asset_kind == "identity" and not identity_id:
            raise ValueError("identity preset requires identity_id")
        char = store.get_character(character)
        if char is None:
            raise ValueError(f"character not found: {character}")
        generation_context["character_profile"] = {
            "name": str(getattr(char, "name", "") or character).strip(),
            "aliases": list(getattr(char, "aliases", None) or []),
            "role": str(getattr(char, "role", "") or "").strip(),
            "is_main": bool(getattr(char, "is_main", False)),
            "gender": str(getattr(char, "gender", "") or "").strip(),
            "age_group": str(getattr(char, "age_group", "") or "").strip(),
            "body_type": str(getattr(char, "body_type", "") or "").strip(),
            "description": str(getattr(char, "description", "") or "").strip(),
            "face_prompt": str(getattr(char, "face_prompt", "") or "").strip(),
        }
        char_identity_ids = [
            str(getattr(item, "identity_id", "") or "").strip()
            for item in (getattr(char, "identities", None) or [])
        ]
        portrait_prompt = str(getattr(char, "face_prompt", "") or "").strip()
        char_age_group = str(getattr(char, "age_group", "") or "youth")
        try:
            from novelvideo.config import IMAGE_DEFAULT_STYLE, get_style_preset
            from novelvideo.generators.nanobanana_character import NanoBananaCharacterGenerator
            from novelvideo.project_config import load_project_config

            project_config = load_project_config(username, project)
            project_style = str(project_config.get("visual_style") or IMAGE_DEFAULT_STYLE)
            project_ethnicity = str(project_config.get("ethnicity") or "Chinese")
            style_preset = get_style_preset(
                project_style,
                username=username,
                project=project,
                project_dir=str(project_dir),
            )
            style_keywords = style_preset.get("style_instructions", "")
            negative_keywords = style_preset.get("avoid_instructions", "")
            character_prompt_builder = NanoBananaCharacterGenerator.__new__(
                NanoBananaCharacterGenerator
            )
        except Exception:
            project_style = ""
            project_ethnicity = "Chinese"
            style_keywords = ""
            negative_keywords = ""
            character_prompt_builder = None

        def _novelvideo_portrait_full_prompt(prompt_text: str) -> str:
            if character_prompt_builder is None:
                return prompt_text
            character_tag = character_prompt_builder._generate_character_tag(character)
            return character_prompt_builder._build_character_prompt(
                character_name=character,
                character_prompt=prompt_text,
                character_tag=character_tag,
                style_name=project_style,
                project_dir=str(project_dir),
                style_keywords=style_keywords,
                negative_keywords=negative_keywords,
                ethnicity=project_ethnicity,
            )

        generation_context["portrait"] = {
            "character": character,
            "prompt": _novelvideo_portrait_full_prompt(portrait_prompt) if portrait_prompt else "",
            "display_name": f"{character} portrait prompt",
        }

        def _novelvideo_identity_full_prompt(
            *,
            identity_name: str,
            identity_prompt: str,
            has_costume_image: bool,
        ) -> str:
            if character_prompt_builder is None:
                return identity_prompt
            character_tag = character_prompt_builder._generate_character_tag(character)
            return character_prompt_builder._build_identity_locked_prompt(
                character_name=character,
                character_prompt=identity_prompt,
                character_tag=character_tag,
                target_view="front",
                style_name=project_style,
                project_dir=str(project_dir),
                style_keywords=style_keywords,
                negative_keywords=negative_keywords,
                ethnicity=project_ethnicity,
                has_costume_reference=has_costume_image,
            )

        def _build_identity_generation_context(identity_obj: Any) -> dict[str, Any]:
            current_identity_id = str(getattr(identity_obj, "identity_id", "") or "").strip()
            identity_name = str(
                getattr(identity_obj, "identity_name", "")
                or _identity_name(current_identity_id, character)
            ).strip()
            appearance_details = str(getattr(identity_obj, "appearance_details", "") or "").strip()
            face_override = str(getattr(identity_obj, "face_prompt", "") or "").strip()
            identity_age = str(getattr(identity_obj, "age_group", "") or "").strip()
            is_age_variant = bool(identity_age and identity_age != char_age_group)
            costume_image = compute_identity_costume_path(
                project_dir, character, identity_name
            ) or (str(getattr(identity_obj, "costume_image", "") or "").strip())
            if is_age_variant:
                identity_portrait = compute_identity_portrait_path(
                    project_dir, character, identity_name
                ) or (str(getattr(identity_obj, "portrait_image", "") or "").strip())
            else:
                identity_portrait = ""
            identity_costume_path = costume_image or str(
                canonical_identity_costume_path(project_dir, character, identity_name)
            )
            if is_age_variant:
                identity_portrait_path = identity_portrait or str(
                    canonical_identity_portrait_path(project_dir, character, identity_name)
                )
            else:
                identity_portrait_path = ""
            has_costume_image = bool(costume_image and Path(costume_image).exists())
            has_identity_portrait = bool(
                is_age_variant and identity_portrait and Path(identity_portrait).exists()
            )
            if is_age_variant:
                prompt = (
                    ""
                    if has_identity_portrait and has_costume_image
                    else (
                        appearance_details
                        if has_identity_portrait
                        else (
                            face_override
                            if has_costume_image
                            else (
                                f"{face_override}\n{appearance_details}"
                                if appearance_details
                                else face_override
                            )
                        )
                    )
                )
            else:
                prompt = "" if has_costume_image else appearance_details
            prompt = prompt.strip()
            full_prompt = _novelvideo_identity_full_prompt(
                identity_name=identity_name,
                identity_prompt=prompt,
                has_costume_image=has_costume_image,
            )
            identity_portrait_prompt = (face_override or appearance_details or prompt).strip()
            full_identity_portrait_prompt = (
                _novelvideo_portrait_full_prompt(identity_portrait_prompt)
                if identity_portrait_prompt
                else ""
            )
            return {
                "character": character,
                "identity_id": current_identity_id,
                "identity_name": identity_name,
                "prompt": full_prompt.strip(),
                "identity_portrait_prompt": full_identity_portrait_prompt.strip(),
                "identity_prompt": prompt,
                "appearance_details": appearance_details,
                "face_prompt": face_override,
                "is_age_variant": is_age_variant,
                "has_costume_image": has_costume_image,
                "has_identity_portrait": has_identity_portrait,
                "identity_costume_path": identity_costume_path,
                "identity_portrait_path": identity_portrait_path,
                "style": project_style,
                "ethnicity": project_ethnicity,
                "display_name": f"{identity_name} identity prompt",
            }

        identity_generation_contexts: list[dict[str, Any]] = []
        for identity_obj in getattr(char, "identities", None) or []:
            current_identity_id = str(getattr(identity_obj, "identity_id", "") or "").strip()
            if not current_identity_id:
                continue
            if asset_kind == "identity" and current_identity_id != identity_id:
                continue
            identity_generation_contexts.append(_build_identity_generation_context(identity_obj))
        generation_context["identities"] = identity_generation_contexts
        if asset_kind == "character":
            _add_file_ref(
                refs,
                project_id=project_id,
                username=username,
                project=project,
                project_dir=project_dir,
                kind="identity",
                role="character_portrait",
                label=f"{character} portrait",
                rel_path=_rel(project_dir, canonical_portrait_path(project_dir, character)),
                meta={"character": character},
            )
            for existing_identity_id in char_identity_ids:
                _add_character_identity_ref(
                    refs,
                    project_id=project_id,
                    username=username,
                    project=project,
                    project_dir=project_dir,
                    character=character,
                    identity_id=existing_identity_id,
                )
            for identity_ctx in identity_generation_contexts:
                identity_name = str(identity_ctx.get("identity_name") or "").strip()
                portrait_path = str(identity_ctx.get("identity_portrait_path") or "").strip()
                if portrait_path:
                    _add_file_ref(
                        refs,
                        project_id=project_id,
                        username=username,
                        project=project,
                        project_dir=project_dir,
                        kind="identity",
                        role="identity_portrait",
                        label=f"{identity_name} portrait",
                        rel_path=_rel(project_dir, Path(portrait_path)),
                        required=True,
                        meta={
                            "character": character,
                            "identity_id": identity_ctx.get("identity_id"),
                            "identity_name": identity_name,
                        },
                    )
                costume_path = str(identity_ctx.get("identity_costume_path") or "").strip()
                if costume_path:
                    _add_file_ref(
                        refs,
                        project_id=project_id,
                        username=username,
                        project=project,
                        project_dir=project_dir,
                        kind="identity",
                        role="identity_costume",
                        label=f"{identity_name} costume",
                        rel_path=_rel(project_dir, Path(costume_path)),
                        required=True,
                        meta={
                            "character": character,
                            "identity_id": identity_ctx.get("identity_id"),
                            "identity_name": identity_name,
                        },
                    )
        else:
            _add_character_refs(
                refs,
                project_id=project_id,
                username=username,
                project=project,
                project_dir=project_dir,
                character=character,
                identity_id=identity_id,
            )
            target_identity_ctx = next(
                (
                    item
                    for item in identity_generation_contexts
                    if str(item.get("identity_id") or "").strip() == (identity_id or "").strip()
                ),
                None,
            )
            if target_identity_ctx:
                identity_name = str(target_identity_ctx.get("identity_name") or "").strip()
                portrait_path = str(target_identity_ctx.get("identity_portrait_path") or "").strip()
                if portrait_path:
                    _add_file_ref(
                        refs,
                        project_id=project_id,
                        username=username,
                        project=project,
                        project_dir=project_dir,
                        kind="identity",
                        role="identity_portrait",
                        label=f"{identity_name} portrait",
                        rel_path=_rel(project_dir, Path(portrait_path)),
                        required=True,
                        meta={
                            "character": character,
                            "identity_id": target_identity_ctx.get("identity_id"),
                            "identity_name": identity_name,
                        },
                    )
            if target_identity_ctx:
                identity_name = str(target_identity_ctx.get("identity_name") or "").strip()
                costume_path = str(target_identity_ctx.get("identity_costume_path") or "").strip()
                if costume_path:
                    _add_file_ref(
                        refs,
                        project_id=project_id,
                        username=username,
                        project=project,
                        project_dir=project_dir,
                        kind="identity",
                        role="identity_costume",
                        label=f"{identity_name} costume",
                        rel_path=_rel(project_dir, Path(costume_path)),
                        required=True,
                        meta={
                            "character": character,
                            "identity_id": target_identity_ctx.get("identity_id"),
                            "identity_name": identity_name,
                        },
                    )
        if example_beat_limit > 0:
            matches: list[tuple[int, int]] = []
            try:
                visual_beats = await store.list_visual_beats()
            except Exception:
                visual_beats = []
            visual_beats = sorted(
                visual_beats,
                key=lambda b: (
                    int(getattr(b, "episode_number", 0)),
                    int(getattr(b, "beat_number", 0)),
                ),
                reverse=True,
            )
            for beat in visual_beats:
                visual = str(getattr(beat, "visual_description", "") or "")
                try:
                    detected = json.loads(getattr(beat, "detected_identities_json", "[]") or "[]")
                except Exception:
                    detected = []
                detected_ids = [_identity_id_from_item(x) for x in _as_list(detected)]
                mentions_character = character in visual
                mentions_identity = bool(
                    identity_id and (identity_id in visual or identity_id in detected_ids)
                )
                mentions_any_known_identity = bool(
                    asset_kind == "character"
                    and any(
                        existing_id and (existing_id in visual or existing_id in detected_ids)
                        for existing_id in char_identity_ids
                    )
                )
                if (
                    mentions_identity
                    or mentions_any_known_identity
                    or (not identity_id and mentions_character)
                ):
                    matches.append(
                        (
                            int(getattr(beat, "episode_number", 0)),
                            int(getattr(beat, "beat_number", 0)),
                        )
                    )
                if len(matches) >= example_beat_limit * 10:
                    break
            added_examples = 0
            for ep_num, beat_num in matches:
                ep_dir = f"ep{ep_num:03d}"
                before_example = len(refs)
                for rel_path, kind, role, label in [
                    (
                        f"sketches/{ep_dir}/beat_{beat_num:02d}.png",
                        "sketch",
                        "related_sketch",
                        f"EP{ep_num} Beat {beat_num} sketch",
                    ),
                    (
                        f"freezone/director_control_frames/{ep_dir}/beat_{beat_num:02d}/combined.png",
                        "director",
                        "related_director_combined",
                        f"EP{ep_num} Beat {beat_num} director",
                    ),
                ]:
                    _add_file_ref(
                        refs,
                        project_id=project_id,
                        username=username,
                        project=project,
                        project_dir=project_dir,
                        kind=kind,
                        role=role,
                        label=label,
                        rel_path=rel_path,
                        meta={"episode": ep_num, "beat": beat_num},
                    )
                if len(refs) > before_example:
                    added_examples += 1
                if added_examples >= example_beat_limit:
                    break
    elif asset_kind in {
        "scene",
        "scene_master",
        "scene_reverse_master",
        "scene_spatial_layout",
        "scene_360",
    }:
        scene_name = asset_id or identity_id or character or ""
        if not scene_name:
            raise ValueError("scene preset requires asset_id")
        scene_obj = await store.get_scene(scene_name)
        scene_info = (
            scene_obj.model_dump()
            if scene_obj is not None and hasattr(scene_obj, "model_dump")
            else _jsonable(scene_obj) if scene_obj is not None else {}
        )
        base_scene_id = str(scene_info.get("base_scene_id") or "").strip()
        base_scene_info: dict[str, Any] = {}
        if base_scene_id:
            try:
                base_scene_obj = await store.get_scene(base_scene_id)
                base_scene_info = (
                    base_scene_obj.model_dump()
                    if base_scene_obj is not None and hasattr(base_scene_obj, "model_dump")
                    else _jsonable(base_scene_obj) if base_scene_obj is not None else {}
                )
            except Exception:
                base_scene_info = {}
        if scene_info:
            scene_model = NovelScene(
                name=str(scene_info.get("name") or scene_info.get("scene_id") or scene_name),
                scene_type=str(scene_info.get("scene_type") or "interior") or "interior",
                base_scene_id=base_scene_id,
                variant_id=str(scene_info.get("variant_id") or "").strip(),
                time_of_day=str(scene_info.get("time_of_day") or "").strip(),
                environment_prompt=str(scene_info.get("environment_prompt") or "").strip(),
                variant_prompt=str(scene_info.get("variant_prompt") or "").strip(),
                description=str(scene_info.get("description") or "").strip(),
            )
            base_scene_model = None
            if base_scene_info:
                base_scene_model = NovelScene(
                    name=str(
                        base_scene_info.get("name")
                        or base_scene_info.get("scene_id")
                        or base_scene_id
                    ),
                    scene_type=str(base_scene_info.get("scene_type") or "interior") or "interior",
                    environment_prompt=str(base_scene_info.get("environment_prompt") or "").strip(),
                    description=str(base_scene_info.get("description") or "").strip(),
                )
            scene_info["effective_environment_prompt"] = build_scene_effective_prompt(
                scene_model,
                base_scene_model,
            )
            scene_info["base_environment_prompt"] = str(
                base_scene_info.get("environment_prompt") or ""
            ).strip()
            scene_info["base_description"] = str(
                base_scene_info.get("description") or ""
            ).strip()
            scene_info["base_scene_type"] = str(
                base_scene_info.get("scene_type") or ""
            ).strip()
            if base_scene_id:
                base_master_path = canonical_scene_master_path(project_dir, base_scene_id)
                if base_master_path.exists():
                    base_master_rel_path = _rel(project_dir, base_master_path)
                    scene_info["base_master_rel_path"] = base_master_rel_path
                    scene_info["base_master_url"] = _make_url(
                        project_id,
                        project_dir,
                        base_master_rel_path,
                    )
        scene_info = {**scene_info, **_project_style_meta(username, project, project_dir)}
        _add_scene_refs(
            refs,
            project_id=project_id,
            username=username,
            project=project,
            project_dir=project_dir,
            scene_name=scene_name,
            scene_info=scene_info,
        )
    elif asset_kind in {"prop", "prop_ref"}:
        prop_id = asset_id or identity_id or character or ""
        if not prop_id:
            raise ValueError("prop preset requires asset_id")
        prop_obj = None
        get_prop = getattr(store, "get_prop", None)
        if callable(get_prop):
            prop_obj = await get_prop(prop_id)
        if prop_obj is None:
            get_cached_prop = getattr(store, "get_cached_prop", None)
            if callable(get_cached_prop):
                prop_obj = get_cached_prop(prop_id)
        episode_props: list[dict[str, Any]] = []
        for ep in getattr(store, "_episodes", {}).values():
            for item in build_prop_menu(prop_menu=getattr(ep, "prop_menu", []) or []):
                if item.prop_id == prop_id:
                    episode_props.append(item.model_dump())
        prop_profile = {
            "name": str(getattr(prop_obj, "name", "") or prop_id).strip(),
            "aliases": list(getattr(prop_obj, "aliases", None) or []),
            "prop_type": str(getattr(prop_obj, "prop_type", "") or "").strip(),
            "visual_prompt": str(getattr(prop_obj, "visual_prompt", "") or "").strip(),
            "description": str(getattr(prop_obj, "description", "") or "").strip(),
            "owner": str(getattr(prop_obj, "owner", "") or "").strip(),
            "notes": str(getattr(prop_obj, "notes", "") or "").strip(),
        }
        meta = (
            episode_props[0]
            if episode_props
            else {
                "prop_id": prop_id,
                "prop_type": prop_profile["prop_type"] or "object",
                "visual_prompt": prop_profile["visual_prompt"] or prop_profile["description"],
                "description": prop_profile["description"],
            }
        )
        effective_visual_prompt = str(
            meta.get("visual_prompt") or prop_profile["visual_prompt"] or ""
        ).strip()
        effective_description = str(
            meta.get("description") or prop_profile["description"] or ""
        ).strip()
        effective_prompt = effective_visual_prompt or effective_description
        if effective_visual_prompt:
            prop_profile["visual_prompt"] = effective_visual_prompt
        if effective_description:
            prop_profile["description"] = effective_description
        try:
            from novelvideo.project_config import load_project_config_file

            project_config = load_project_config_file(username, project) if project else {}
        except Exception:
            project_config = {}
        project_style = str(
            project_config.get("visual_style")
            or project_config.get("project_style")
            or PROP_REF_DEFAULT_STYLE
        )
        reference_prompt = (
            build_prop_reference_prompt(
                visual_prompt=effective_prompt,
                style=project_style,
                project_dir=str(project_dir),
            )
            if effective_prompt
            else ""
        )
        generation_context["prop"] = {
            "prop_id": prop_id,
            "profile": prop_profile,
            "prompt": reference_prompt,
            "visual_prompt": effective_prompt,
            "display_name": f"{prop_id} reference prompt",
        }
        _add_prop_refs(
            refs,
            project_id=project_id,
            username=username,
            project=project,
            project_dir=project_dir,
            prop_id=prop_id,
            meta=meta,
        )
    else:
        raise ValueError(f"unsupported asset preset: {asset_kind}")

    return {
        "scope": "asset",
        "username": username,
        "project": project,
        "project_id": project_id,
        "project_dir": str(project_dir),
        "asset_kind": asset_kind,
        "character": character,
        "identity_id": identity_id,
        "asset_id": asset_id,
        "refs": [r.model_dump() for r in refs],
        "generation_context": generation_context,
    }


def build_canvas_payload_from_context(
    *,
    context: dict[str, Any],
    preset_key: str,
    default_push_target: dict[str, Any],
    created_at: str | None = None,
) -> dict[str, Any]:
    # 默认丢掉文件不存在的 ref(画布只显示已生成的资产),但是
    # 部分 canonical slots 缺文件时也要显示 placeholder,否则用户无法在
    # Freezone 里生成并 commit 回主线。
    _always_keep_roles = {
        "selected_background",
        "character_identity",
        "identity_portrait",
        "identity_costume",
        "prop_reference",
        "scene_master",
        "scene_reverse_master",
        "scene_director_pano_360",
    }
    _hidden_roles = {"scene_spatial_layout"}
    refs = [
        r
        for r in context.get("refs", [])
        if str(r.get("role") or "") not in _hidden_roles
        and ((r.get("exists") and r.get("url")) or str(r.get("role") or "") in _always_keep_roles)
    ]
    image_refs = [
        r
        for r in refs
        if Path(str(r.get("rel_path") or "")).suffix.lower()
        in {*IMAGE_EXTS, ".ply", ".sog", ".splat", ".ksplat", ".spz"}
    ]
    if context.get("scope") == "asset":
        image_refs = [
            r
            for r in image_refs
            if str(r.get("role") or "") not in {"related_sketch", "related_director_combined"}
        ]
    is_beat_scope = context.get("scope") == "beat"
    is_sketch_primary = is_beat_scope and str(context.get("primary_slot") or "").strip() == "sketch"
    nodes: list[dict[str, Any]] = []
    edges: list[dict[str, Any]] = []
    if context.get("scope") == "beat":
        beat_context_pos = (-1840, -820) if is_sketch_primary else (-1840, -720)
        nodes.append(
            _beat_context_node(
                "context_beat",
                beat_context_pos[0],
                beat_context_pos[1],
                _beat_context_display_name(context),
                _content_for_context(context),
                mainline_context=_beat_context_mainline_context(context),
                edit_fields=_beat_context_edit_fields(context),
                extra_data={
                    "__freezone_source": {
                        "kind": "beat_context",
                        "role": "beat_context",
                        "label": f"EP{context.get('episode')} Beat {context.get('beat')} context",
                        "meta": {
                            "episode": context.get("episode"),
                            "beat": context.get("beat"),
                        },
                    },
                },
            )
        )
    elif context.get("scope") == "episode":
        episode = context.get("episode")
        nodes.append(
            _text_node(
                "context_episode",
                -1120,
                -520,
                f"Episode {episode} Context",
                _episode_overview_content(context),
                {
                    "__freezone_source": {
                        "kind": "episode_context",
                        "role": "episode_context",
                        "label": f"EP{episode} context",
                        "meta": {"episode": episode},
                    },
                },
            )
        )
        background_node_ids: dict[int, str] = {}
        identity_node_ids: dict[str, str] = {}
        prop_node_ids: dict[str, str] = {}
        beat_row_y_by_number: dict[int, int] = {}
        for beat_idx, beat in enumerate(context.get("beats") or []):
            try:
                beat_number = int(beat.get("beat_number") or 0)
            except (TypeError, ValueError):
                beat_number = 0
            if beat_number > 0:
                beat_row_y_by_number[beat_number] = -520 + beat_idx * 260

        def _episode_beat_row_y(beat_number: int, fallback_index: int) -> int:
            return beat_row_y_by_number.get(beat_number, -520 + fallback_index * 260)

        def _episode_ref_for(
            *,
            role: str,
            meta_key: str,
            meta_value: str,
        ) -> dict[str, Any] | None:
            for ref in image_refs:
                if str(ref.get("role") or "") != role:
                    continue
                meta = ref.get("meta") if isinstance(ref.get("meta"), dict) else {}
                if str(meta.get(meta_key) or "") == meta_value:
                    return ref
            return None

        def _episode_identity_ref(identity_id: str, character: str) -> dict[str, Any] | None:
            return _episode_ref_for(
                role="character_identity",
                meta_key="identity_id",
                meta_value=identity_id,
            )

        def _episode_background_ref(beat_number: int) -> dict[str, Any] | None:
            for ref in image_refs:
                if str(ref.get("role") or "") != "selected_background":
                    continue
                meta = ref.get("meta") if isinstance(ref.get("meta"), dict) else {}
                try:
                    if int(meta.get("beat") or 0) == int(beat_number):
                        return ref
                except (TypeError, ValueError):
                    continue
            return None

        for idx, background in enumerate(context.get("backgrounds") or []):
            try:
                beat_number = int(background.get("beat_number") or 0)
            except (TypeError, ValueError):
                beat_number = 0
            if beat_number <= 0:
                continue
            node_id = f"context_background_{beat_number:03d}"
            background_node_ids[beat_number] = node_id
            background_ref = _episode_background_ref(beat_number)
            row_y = _episode_beat_row_y(beat_number, idx)
            if background_ref:
                nodes.append(_ref_image_node(node_id, -560, row_y, background_ref))
            else:
                nodes.append(
                    _text_node(
                        node_id,
                        -560,
                        row_y,
                        f"Background · Beat {beat_number}",
                        "\n".join(
                            [
                                f"Beat: {beat_number}",
                                f"Scene: {background.get('scene_id') or ''}",
                                "No selected_background image found yet.",
                            ]
                        ),
                        {
                            "mainline_context": [
                                {
                                    "kind": "selected_background",
                                    "episode": episode,
                                    "beat": beat_number,
                                    "sceneId": background.get("scene_id"),
                                    "role": "selected_background",
                                }
                            ],
                            "mainline_role": "context",
                        },
                    )
                )
        for idx, identity in enumerate(context.get("identities") or []):
            identity_id = str(identity.get("identity_id") or "").strip()
            if not identity_id:
                continue
            node_id = f"context_identity_{_safe_id(identity_id, fallback='identity')}"
            identity_node_ids[identity_id] = node_id
            identity_ref = _episode_identity_ref(
                identity_id,
                str(identity.get("character") or ""),
            )
            if identity_ref:
                nodes.append(_ref_image_node(node_id, -1120, 160 + idx * 260, identity_ref))
            else:
                nodes.append(
                    _text_node(
                        node_id,
                        -1120,
                        160 + idx * 180,
                        f"Identity · {identity_id}",
                        "\n".join(
                            [
                                f"Identity: {identity_id}",
                                f"Character: {identity.get('character') or ''}",
                            ]
                        ),
                        {
                            "mainline_context": [
                                {
                                    "kind": "identity",
                                    "identityId": identity_id,
                                    "character": identity.get("character"),
                                    "role": "identity_context",
                                }
                            ],
                            "mainline_role": "context",
                        },
                    )
                )
        for idx, prop in enumerate(context.get("props") or []):
            prop_id = str(prop.get("prop_id") or "").strip()
            if not prop_id:
                continue
            node_id = f"context_prop_{_safe_id(prop_id, fallback='prop')}"
            prop_node_ids[prop_id] = node_id
            prop_ref = _episode_ref_for(
                role="prop_reference",
                meta_key="prop_id",
                meta_value=prop_id,
            )
            if prop_ref:
                nodes.append(_ref_image_node(node_id, -560, 160 + idx * 260, prop_ref))
            else:
                nodes.append(
                    _text_node(
                        node_id,
                        -560,
                        160 + idx * 180,
                        f"Prop · {prop_id}",
                        f"Prop: {prop_id}",
                        {
                            "mainline_context": [
                                {"kind": "prop", "propId": prop_id, "role": "prop_context"}
                            ],
                            "mainline_role": "context",
                        },
                    )
                )
        for idx, beat in enumerate(context.get("beats") or []):
            beat_number = int(beat.get("beat_number") or 0)
            if beat_number <= 0:
                continue
            row_y = -520 + idx * 260
            node_id = f"context_beat_{beat_number:03d}"
            beat_mainline_context = _episode_beat_context(episode, beat)
            nodes.append(
                _beat_context_node(
                    node_id,
                    160,
                    row_y,
                    f"Beat {beat_number}",
                    _episode_beat_content(episode, beat),
                    mainline_context=beat_mainline_context,
                    edit_fields={
                        "visual_description": beat.get("visual_description") or "",
                        "scene_id": (
                            (beat.get("scene_ref") or {}).get("scene_id")
                            if isinstance(beat.get("scene_ref"), dict)
                            else ""
                        ),
                        "time_of_day": beat.get("time_of_day") or "",
                        "detected_identities": beat.get("detected_identities") or [],
                        "detected_props": beat.get("detected_props") or [],
                    },
                    extra_data={
                        "mainline_role": "context",
                        "workbench_target": {
                            "scope": "beat",
                            "episode": episode,
                            "beat": beat_number,
                        },
                    },
                )
            )
            edges.append(
                _edge(
                    f"edge_episode_to_beat_{beat_number:03d}",
                    node_id,
                    "context_episode",
                )
            )
            if beat_number in background_node_ids:
                edges.append(
                    _edge(
                        f"edge_background_{beat_number:03d}_to_beat_{beat_number:03d}",
                        node_id,
                        background_node_ids[beat_number],
                        {"edgeKind": "mainline_data", "propagates": True},
                    )
                )
            linked_identity_ids: set[str] = set()
            for identity_id in beat.get("detected_identities") or []:
                identity_id = str(identity_id or "").strip()
                if identity_id in identity_node_ids and identity_id not in linked_identity_ids:
                    linked_identity_ids.add(identity_id)
                    edges.append(
                        _edge(
                            f"edge_identity_{_safe_id(identity_id)}_to_beat_{beat_number:03d}",
                            node_id,
                            identity_node_ids[identity_id],
                        )
                    )
            linked_prop_ids: set[str] = set()
            for prop_id in beat.get("detected_props") or []:
                prop_id = str(prop_id or "").strip()
                if prop_id in prop_node_ids and prop_id not in linked_prop_ids:
                    linked_prop_ids.add(prop_id)
                    edges.append(
                        _edge(
                            f"edge_prop_{_safe_id(prop_id)}_to_beat_{beat_number:03d}",
                            node_id,
                            prop_node_ids[prop_id],
                        )
                    )
    ref_node_ids: list[tuple[dict[str, Any], str]] = []

    if context.get("scope") == "beat":
        beat_data = context.get("beat_data") or {}
        marker_context = _beat_sketch_marker_context(context)
        if is_sketch_primary:
            render_prompt = _beat_sketch_prompt(context, marker_context)
        else:
            render_prompt = _beat_render_prompt(context)
        if is_sketch_primary:
            nodes.append(
                _text_node(
                    "sketch_marker_context",
                    -1840,
                    -420,
                    "Sketch marker context",
                    _beat_sketch_marker_content(marker_context),
                    {
                        "__freezone_source": {
                            "kind": "beat_marker_context",
                            "role": "sketch_marker_context",
                            "label": f"EP{context.get('episode')} Beat {context.get('beat')} marker context",
                            "meta": {
                                "episode": context.get("episode"),
                                "beat": context.get("beat"),
                            },
                        }
                    },
                )
            )
        nodes.append(
            _prompt_text_node(
                "prompt_beat_visual",
                -1840,
                0 if is_sketch_primary else -260,
                "Beat sketch prompt" if is_sketch_primary else "Beat render prompt",
                _display_prompt_text(
                    render_prompt,
                    fallback_note="（当前 Beat 没有视觉描述或关键帧提示词）",
                ),
                source_meta={
                    "kind": "beat_prompt",
                    "role": "beat_visual_prompt",
                    "label": f"EP{context.get('episode')} Beat {context.get('beat')} visual prompt",
                    "meta": {"episode": context.get("episode"), "beat": context.get("beat")},
                },
            )
        )
        by_role = {str(ref.get("role") or ""): ref for ref in image_refs}
        primary_slot = str(context.get("primary_slot") or "").strip()
        beat_layout: list[tuple[str, int, int]] = (
            [("current_sketch", 520, -700)]
            if is_sketch_primary
            else [
                ("current_sketch", 520, -700),
                ("current_frame", 1680, 260),
            ]
        )
        preset_aspect_ratio = _context_sketch_aspect_ratio(context)
        for role_name, x, y in beat_layout:
            ref = by_role.get(role_name)
            if not ref:
                ref = _beat_target_placeholder_ref(
                    episode=context.get("episode"),
                    beat=context.get("beat"),
                    primary_slot=primary_slot,
                    role=role_name,
                    aspect_ratio=preset_aspect_ratio,
                )
                if not ref:
                    continue
            role = _safe_id(role_name, fallback="beat_ref")
            node_id = f"ref_{role}_1"
            if ref.get("url"):
                slot_node = _asset_image_node(node_id, x, y, ref)
            else:
                slot_node = _image_gen_node(
                    node_id,
                    x,
                    y,
                    str(ref.get("label") or role_name),
                    "",
                    aspect_ratio=str(ref.get("aspect_ratio") or "1:1"),
                    source_meta=_node_source_from_ref(ref),
                )
            # Preset-managed canonical slots keep only commit metadata here.
            # Generic SkillNode runtime metadata is introduced in later phases.
            ep_num = context.get("episode")
            beat_num = context.get("beat")
            if (
                role_name == "current_frame"
                and isinstance(ep_num, int)
                and isinstance(beat_num, int)
            ):
                slot_node.setdefault("data", {}).update(
                    {
                        "committed_slot_url": ref.get("url"),
                        "slot_target": {
                            "kind": "frame",
                            "episode": ep_num,
                            "beat": beat_num,
                        },
                    }
                )
            elif (
                role_name == "current_sketch"
                and isinstance(ep_num, int)
                and isinstance(beat_num, int)
            ):
                slot_node.setdefault("data", {}).update(
                    {
                        "committed_slot_url": ref.get("url"),
                        "slot_target": {
                            "kind": "sketch",
                            "episode": ep_num,
                            "beat": beat_num,
                        },
                    }
                )
            nodes.append(slot_node)
            ref_node_ids.append((ref, node_id))

        def _beat_ref_position(
            ref: dict[str, Any],
            *,
            kind: str,
            index: int,
        ) -> tuple[int, int]:
            role = str(ref.get("role") or "")
            if is_sketch_primary:
                if role == "character_portrait":
                    return -1500, 520 + (index // 2) * 360
                if role == "character_identity":
                    return -1060, 520 + (index // 2) * 360
                if role in DIRECTOR_CAPTURE_IMAGE_ROLES:
                    fallback_x = -1500 + (index % 2) * 440
                    fallback_y = 1420 + (index // 2) * 360
                    return SKETCH_DIRECTOR_CAPTURE_LAYOUT_POSITIONS.get(
                        role,
                        (fallback_x, fallback_y),
                    )
                base_positions = {
                    "identity": (-1060, 520),
                    "prop": (-1060, 1040),
                    "scene": (50, 510),
                    "director": (2520, -640),
                    "sketch": (520, 1040),
                    "frame": (1680, 1040),
                    "render": (2120, 1040),
                }
                base_x, base_y = base_positions.get(kind, (80, 820))
                if kind == "director":
                    return base_x + (index % 2) * 620, base_y + (index // 2) * 330
                return base_x + (index % 2) * 420, base_y + (index // 2) * 360
            if role in DIRECTOR_CAPTURE_IMAGE_ROLES:
                if role == "selected_background":
                    return -1080, -1040
                if role == "director_combined":
                    return -1080, -360
                return DIRECTOR_CAPTURE_LAYOUT_POSITIONS.get(role, (-1500, 1420))
            if role in {"prop_reference", "prop_3view", "prop_turnaround"}:
                return -1080, 1040 + index * 360
            if role == "character_portrait":
                return -1500, 420 + ((max(index, 1) - 1) // 2) * 360
            if role == "character_identity":
                return -1080, 420 + (index // 2) * 360
            base_positions = {
                "identity": (-1080, 420),
                "prop": (-1080, 1040),
                "scene": (80, 300),
                "director": (-1500, 1420),
                "sketch": (520, 1040),
                "frame": (1680, 1040),
                "render": (2120, 1040),
            }
            base_x, base_y = base_positions.get(kind, (80, 1120))
            return base_x + (index % 2) * 360, base_y + (index // 2) * 360

        beat_bucket_order = ["identity", "prop", "scene", "director", "sketch", "frame", "render"]
        role_counts: dict[str, int] = {
            str(ref.get("role") or ""): 1 for ref, _node_id in ref_node_ids
        }
        for kind in beat_bucket_order:
            kind_refs = [r for r in image_refs if r.get("kind") == kind]
            if not kind_refs:
                continue
            idx_for_kind = 0
            for ref in kind_refs[:12]:
                role_name = str(ref.get("role") or "")
                kind_name = str(ref.get("kind") or "")
                if (
                    kind_name == "scene" or role_name.startswith("scene_")
                ) and role_name not in DIRECTOR_CAPTURE_IMAGE_ROLES:
                    continue
                if role_name in {
                    "current_sketch",
                    "current_frame",
                }:
                    continue
                role = _safe_id(str(ref.get("role") or kind), fallback=kind)
                role_counts[role] = role_counts.get(role, 0) + 1
                node_id = f"ref_{role}_{role_counts[role]}"
                x, y = _beat_ref_position(ref, kind=kind, index=idx_for_kind)
                ref_node = _ref_image_node(node_id, x, y, ref)
                if role_name == "selected_background":
                    ref_node.setdefault("data", {}).update(
                        {
                            "committed_slot_url": ref.get("url"),
                            "slot_target": {
                                "kind": "selected_background",
                                "episode": context.get("episode"),
                                "beat": context.get("beat"),
                            },
                        }
                    )
                nodes.append(ref_node)
                ref_node_ids.append((ref, node_id))
                idx_for_kind += 1

        current_sketch_id = next(
            (node_id for ref, node_id in ref_node_ids if ref.get("role") == "current_sketch"),
            None,
        )
        current_frame_id = next(
            (node_id for ref, node_id in ref_node_ids if ref.get("role") == "current_frame"),
            None,
        )
        selected_background_id = next(
            (node_id for ref, node_id in ref_node_ids if ref.get("role") == "selected_background"),
            None,
        )
        director_combined_id = next(
            (node_id for ref, node_id in ref_node_ids if ref.get("role") == "director_combined"),
            None,
        )
        scene_master_id = next(
            (node_id for ref, node_id in ref_node_ids if ref.get("role") == "scene_master"),
            None,
        )
        scene_reverse_master_id = next(
            (node_id for ref, node_id in ref_node_ids if ref.get("role") == "scene_reverse_master"),
            None,
        )
        beat_data = context.get("beat_data") if isinstance(context.get("beat_data"), dict) else {}
        detected_identity_id_list = _real_identity_ids(
            _identity_id_from_item(item) for item in _as_list(beat_data.get("detected_identities"))
        )
        detected_identity_ids = set(detected_identity_id_list)
        detected_prop_id_list = _real_prop_ids(
            _prop_id_from_item(item) for item in _as_list(beat_data.get("detected_props"))
        )
        detected_prop_ids = set(detected_prop_id_list)

        def _matched_identity_target_id(ref: dict[str, Any]) -> str:
            if not detected_identity_ids:
                return ""
            meta = ref.get("meta") if isinstance(ref.get("meta"), dict) else {}
            identity_id = str(meta.get("identity_id") or "").strip()
            if identity_id and identity_id in detected_identity_ids:
                return identity_id
            character = str(meta.get("character") or "").strip()
            label = str(ref.get("label") or "").strip()
            for candidate in (character, label):
                if candidate and candidate in detected_identity_ids:
                    return candidate
            if character:
                character_identity_ids = [
                    item for item in detected_identity_id_list if item.startswith(f"{character}_")
                ]
                if len(character_identity_ids) == 1:
                    return character_identity_ids[0]
            return identity_id if identity_id and not detected_identity_ids else ""

        def _matched_prop_target_id(ref: dict[str, Any]) -> str:
            if not detected_prop_ids:
                return ""
            meta = ref.get("meta") if isinstance(ref.get("meta"), dict) else {}
            prop_id = str(meta.get("prop_id") or "").strip()
            if prop_id and prop_id in detected_prop_ids:
                return prop_id
            label = str(ref.get("label") or "").strip()
            if label and label in detected_prop_ids:
                return label
            return prop_id if prop_id and not detected_prop_ids else ""

        def _ref_matches_detected_identity(ref: dict[str, Any]) -> bool:
            return bool(_matched_identity_target_id(ref))

        def _ref_matches_detected_prop(ref: dict[str, Any]) -> bool:
            return bool(_matched_prop_target_id(ref))

        identity_node_refs_by_target: dict[str, tuple[int, str, str]] = {}
        for ref, node_id in ref_node_ids:
            role = str(ref.get("role") or "").strip()
            if role not in {"character_identity", "character_portrait"}:
                continue
            target_identity_id = _matched_identity_target_id(ref)
            if not target_identity_id:
                continue
            priority = 0 if role == "character_identity" else 1
            existing = identity_node_refs_by_target.get(target_identity_id)
            if existing is None or priority < existing[0]:
                identity_node_refs_by_target[target_identity_id] = (
                    priority,
                    node_id,
                    target_identity_id,
                )
        identity_node_refs = [
            (node_id, target_identity_id)
            for _priority, node_id, target_identity_id in identity_node_refs_by_target.values()
        ]
        prop_node_refs = [
            (node_id, _matched_prop_target_id(ref))
            for ref, node_id in ref_node_ids
            if ref.get("role") == "prop_reference" and _ref_matches_detected_prop(ref)
        ]

        skill_background_sketch_id = "skill_sketch_from_background"
        skill_director_sketch_id = "skill_sketch_from_director_combined"
        skill_set_background_id = "skill_set_selected_background"
        skill_set_director_combined_id = "skill_set_director_combined"
        skill_frame_id = "skill_frame_from_context"
        nodes.extend(
            [
                _skill_node(
                    skill_set_background_id,
                    -1560,
                    -1240,
                    skill_id="freezone.set_selected_background",
                    display_name="设为当前背景",
                    extra_data={"scene_source_urls": _beat_scene_source_urls(context)},
                ),
                _skill_node(
                    skill_set_director_combined_id,
                    -1560,
                    -620,
                    skill_id="freezone.set_director_combined",
                    display_name="设为导演合成图",
                    extra_data={"scene_source_urls": _beat_scene_source_urls(context)},
                ),
                _skill_node(
                    skill_background_sketch_id,
                    -360,
                    -1040,
                    skill_id="freezone.sketch_from_context",
                    display_name="Sketch from selected background",
                    extra_data={"parameters": {"aspect_ratio": "2:3"}},
                ),
                _skill_node(
                    skill_director_sketch_id,
                    -360,
                    -360,
                    skill_id="freezone.sketch_from_director_combined",
                    display_name="从导演合成图生成草图",
                    extra_data={"parameters": {"aspect_ratio": "2:3"}},
                ),
            ]
        )
        if not is_sketch_primary:
            nodes.append(
                _skill_node(
                    skill_frame_id,
                    1020,
                    260,
                    skill_id="freezone.frame_from_context",
                    display_name="Frame from context",
                    extra_data={"parameters": {"quality": "medium"}},
                )
            )

        def _append_skill_input_edge(
            edge_id: str,
            source_id: str | None,
            target_id: str,
            *,
            role: str,
            label: str,
            target_handle: str | None = None,
            extra_data: dict[str, Any] | None = None,
        ) -> None:
            if not source_id:
                return
            edges.append(
                _skill_role_edge(
                    edge_id,
                    source_id,
                    target_id,
                    role=role,
                    label=label,
                    target_handle=target_handle,
                    extra_data=extra_data,
                )
            )

        context_skill_ids = [
            skill_set_background_id,
            skill_set_director_combined_id,
            skill_background_sketch_id,
            skill_director_sketch_id,
        ]
        if not is_sketch_primary:
            context_skill_ids.append(skill_frame_id)
        for skill_id in context_skill_ids:
            _append_skill_input_edge(
                f"edge_context_beat_to_{skill_id}_beat_context",
                "context_beat",
                skill_id,
                role="beat_context",
                label="Beat context",
            )
        if selected_background_id:
            edges.append(
                _edge(
                    f"edge_{skill_set_background_id}_to_{_safe_id(selected_background_id)}",
                    skill_set_background_id,
                    selected_background_id,
                    {
                        "edgeKind": "mainline_data",
                        "propagates": True,
                        "role": "selected_background",
                        "label": "当前背景",
                    },
                    source_handle="selected_background",
                )
            )
        if director_combined_id:
            edges.append(
                _edge(
                    f"edge_{skill_set_director_combined_id}_to_{_safe_id(director_combined_id)}",
                    skill_set_director_combined_id,
                    director_combined_id,
                    {
                        "edgeKind": "mainline_data",
                        "propagates": True,
                        "role": "director_combined",
                        "label": "导演合成图",
                    },
                    source_handle="director_combined",
                )
            )
        _append_skill_input_edge(
            "edge_selected_background_to_skill_sketch_background",
            selected_background_id,
            skill_background_sketch_id,
            role="background",
            label="Background",
        )
        if not is_sketch_primary:
            _append_skill_input_edge(
                "edge_selected_background_to_skill_frame_background",
                selected_background_id,
                skill_frame_id,
                role="background",
                label="Background",
            )
        _append_skill_input_edge(
            "edge_director_combined_to_skill_sketch_director_combined",
            director_combined_id,
            skill_director_sketch_id,
            role="director_combined",
            label="导演合成图",
        )
        if not is_sketch_primary:
            _append_skill_input_edge(
                "edge_current_sketch_to_skill_frame_sketch",
                current_sketch_id,
                skill_frame_id,
                role="sketch",
                label="Sketch",
            )
            for index, (identity_node_id, identity_id) in enumerate(identity_node_refs, start=1):
                _append_skill_input_edge(
                    f"edge_{_safe_id(identity_node_id)}_to_skill_frame_identity_{index}",
                    identity_node_id,
                    skill_frame_id,
                    role="identity",
                    label="Identity",
                    target_handle=f"identity:{identity_id}",
                    extra_data={
                        "reference_target": {
                            "kind": "identity",
                            "identity_id": identity_id,
                        }
                    },
                )
            for index, (prop_node_id, prop_id) in enumerate(prop_node_refs, start=1):
                _append_skill_input_edge(
                    f"edge_{_safe_id(prop_node_id)}_to_skill_frame_prop_{index}",
                    prop_node_id,
                    skill_frame_id,
                    role="prop",
                    label="Prop",
                    target_handle=f"prop:{prop_id}",
                    extra_data={
                        "reference_target": {
                            "kind": "prop",
                            "prop_id": prop_id,
                        }
                    },
                )

        if current_sketch_id:
            for sketch_skill_id in (skill_background_sketch_id, skill_director_sketch_id):
                edges.append(
                    _edge(
                        f"edge_{sketch_skill_id}_to_{_safe_id(current_sketch_id)}",
                        sketch_skill_id,
                        current_sketch_id,
                        {
                            "edgeKind": "mainline_data",
                            "propagates": True,
                            "role": "current_sketch_candidate",
                            "label": "Current sketch candidate",
                        },
                        source_handle="current_sketch_candidate",
                    )
                )
        if not is_sketch_primary and current_frame_id:
            edges.append(
                _edge(
                    f"edge_{skill_frame_id}_to_{_safe_id(current_frame_id)}",
                    skill_frame_id,
                    current_frame_id,
                    {
                        "edgeKind": "mainline_data",
                        "propagates": True,
                        "role": "current_frame_candidate",
                        "label": "Current frame candidate",
                    },
                    source_handle="current_frame_candidate",
                )
            )

        # Visualization edges for prompt / marker context. annotation kind so
        # they show the prompt provenance without participating in mainline
        # data propagation (backend builds the prompt itself from DB).
        if is_sketch_primary:
            edges.append(
                _edge(
                    "edge_sketch_marker_context_to_prompt",
                    "sketch_marker_context",
                    "prompt_beat_visual",
                    {"edgeKind": "annotation"},
                )
            )
        edges.append(
            _edge(
                "edge_beat_context_to_prompt",
                "context_beat",
                "prompt_beat_visual",
                {"edgeKind": "mainline_data", "propagates": True},
            )
        )

        # current_sketch / current_frame canonical slots are outputs of
        # SkillNodes. Runtime inputs stay on SkillNode role_binding edges so the
        # visible graph matches left-input → skill → right-output flow.
        _append_director_capture_workflow(
            edges=edges,
            ref_node_ids=ref_node_ids,
        )
        metadata = {
            "preset": {
                "preset_key": preset_key,
                "scope": context.get("scope"),
                "episode": context.get("episode"),
                "beat": context.get("beat"),
                "primary_slot": context.get("primary_slot"),
                "created_at": created_at or datetime.now().isoformat(),
            },
            "workbench": {"kind": "beat", "primary_slot": context.get("primary_slot")},
            "references": [ref for ref in refs if _is_asset_library_reference(ref)],
            "beat_context": context.get("beat_data"),
            "prop_menu": context.get("prop_menu") or [],
        }
        metadata["director_capture"] = {
            "episode": context.get("episode"),
            "beat": context.get("beat"),
            "scene_id": _normalize_scene_name(beat_data.get("scene_ref")),
            "node_id": "director_capture",
        }
        return {
            "nodes": nodes,
            "edges": edges,
            "viewport": {"x": 960, "y": 540, "zoom": 0.65},
            "metadata": metadata,
        }

    buckets = [
        ("sketch", 260, -340),
        ("frame", 620, -340),
        ("render", 980, -340),
        ("identity", 260, 140),
        ("scene", 620, 140),
        ("prop", 980, 140),
        ("director", 260, 620),
    ]
    role_counts: dict[str, int] = {}
    if context.get("scope") != "episode":
        for kind, base_x, base_y in buckets:
            kind_refs = [r for r in image_refs if r.get("kind") == kind]
            if not kind_refs:
                continue
            for idx, ref in enumerate(kind_refs[:12]):
                role = _safe_id(str(ref.get("role") or kind), fallback=kind)
                role_counts[role] = role_counts.get(role, 0) + 1
                node_id = f"ref_{role}_{role_counts[role]}"
                x = base_x + (idx % 2) * 420
                y = base_y + (idx // 2) * 360
                nodes.append(_ref_image_node(node_id, x, y, ref))
                ref_node_ids.append((ref, node_id))

    def _find_ref_node_id(
        *,
        role: str,
        kind: str | None = None,
        identity_id: str | None = None,
    ) -> str | None:
        for ref, node_id in ref_node_ids:
            if str(ref.get("role") or "") != role:
                continue
            if kind and str(ref.get("kind") or "") != kind:
                continue
            meta = ref.get("meta") or {}
            if identity_id is not None and str(meta.get("identity_id") or "") != identity_id:
                continue
            return node_id
        return None

    def _find_ref_node_ids(
        *,
        role: str,
        kind: str | None = None,
        identity_id: str | None = None,
    ) -> list[str]:
        node_ids: list[str] = []
        for ref, node_id in ref_node_ids:
            if str(ref.get("role") or "") != role:
                continue
            if kind and str(ref.get("kind") or "") != kind:
                continue
            meta = ref.get("meta") or {}
            if identity_id is not None and str(meta.get("identity_id") or "") != identity_id:
                continue
            node_ids.append(node_id)
        return node_ids

    def _set_node_position(node_id: str, x: int, y: int) -> None:
        for node in nodes:
            if node.get("id") == node_id:
                node["position"] = {"x": x, "y": y}
                return

    def _node_image_url(node_id: str | None) -> str | None:
        if not node_id:
            return None
        for node in nodes:
            if node.get("id") != node_id:
                continue
            data = node.get("data") or {}
            for key in ("imageUrl", "previewImageUrl", "referenceImageUrl"):
                value = data.get(key)
                if isinstance(value, str) and value:
                    return value
        return None

    def _update_node_data(node_id: str | None, data: dict[str, Any]) -> None:
        if not node_id:
            return
        for node in nodes:
            if node.get("id") == node_id:
                node.setdefault("data", {}).update(data)
                return

    def _append_edge_if_missing(edge_id: str, source: str | None, target: str | None) -> None:
        if not source or not target:
            return
        for edge in edges:
            if edge.get("source") == source and edge.get("target") == target:
                return
        edges.append(_edge(edge_id, source, target))

    _append_scene_asset_workflow(nodes=nodes, edges=edges, ref_node_ids=ref_node_ids)

    if context.get("scope") == "asset":
        generation_context = context.get("generation_context") or {}
        asset_kind = str(context.get("asset_kind") or "").strip()
        character = str(context.get("character") or "").strip()
        character_profile = generation_context.get("character_profile") or {}
        if character_profile:
            nodes.append(
                _text_node(
                    "character_profile",
                    -1040,
                    -560,
                    "Character profile",
                    _character_profile_content(character_profile),
                    {
                        "__freezone_source": {
                            "kind": "character_profile",
                            "role": "character_context",
                            "label": f"{character} profile",
                            "meta": {"character": character},
                        }
                    },
                )
            )
        portrait_data = generation_context.get("portrait") or {}
        portrait_prompt = str(portrait_data.get("prompt") or "").strip()
        portrait_ref_id = _find_ref_node_id(role="character_portrait", kind="identity")
        portrait_flow_id = None
        portrait_sink_id = portrait_ref_id
        if portrait_prompt:
            portrait_prompt_id = "prompt_character_portrait"
            portrait_prompt_text = _display_prompt_text(
                portrait_prompt,
                fallback_note="（当前没有可复用的 Portrait 提示词）",
            )
            nodes.append(
                _prompt_text_node(
                    portrait_prompt_id,
                    -1040,
                    -220,
                    "Portrait prompt",
                    portrait_prompt_text,
                    source_meta={
                        "kind": "portrait_prompt",
                        "role": "character_portrait_prompt",
                        "label": f"{character} portrait prompt",
                        "meta": {"character": character},
                    },
                )
            )
            if portrait_ref_id:
                _set_node_position(portrait_ref_id, -560, -220)
                _append_edge_if_missing(
                    "edge_prompt_character_portrait_to_ref",
                    portrait_prompt_id,
                    portrait_ref_id,
                )
            else:
                portrait_flow_id = "flow_character_portrait"
                nodes.append(
                    _image_gen_node(
                        portrait_flow_id,
                        -560,
                        -220,
                        "Portrait generation",
                        portrait_prompt,
                        aspect_ratio="3:4",
                        source_meta={
                            "kind": "portrait",
                            "role": "character_portrait_workflow",
                            "label": f"{character} portrait",
                            "meta": {"character": character},
                        },
                    )
                )
                _append_edge_if_missing(
                    "edge_prompt_to_flow_character_portrait",
                    portrait_prompt_id,
                    portrait_flow_id,
                )
                portrait_sink_id = portrait_flow_id
        elif portrait_ref_id:
            _set_node_position(portrait_ref_id, -560, -220)
        # Portrait sink keeps commit metadata for candidate push/default target.
        if portrait_sink_id:
            existing_committed_url: Any = None
            for node in nodes:
                if node.get("id") == portrait_sink_id:
                    existing_committed_url = (node.get("data") or {}).get("imageUrl")
                    break
            _update_node_data(
                portrait_sink_id,
                {
                    "committed_slot_url": existing_committed_url,
                    "slot_target": {
                        "kind": "portrait",
                        "character": character,
                    },
                    "prompt": portrait_prompt,
                    "aspectRatio": "3:4",
                    "autoCommitOnGenerate": True,
                },
            )
        identity_contexts = generation_context.get("identities") or []
        if asset_kind == "portrait":
            identity_contexts = []
        usage_context_ids = [
            *_find_ref_node_ids(role="related_sketch", kind="sketch"),
            *_find_ref_node_ids(role="related_director_combined", kind="director"),
        ]
        workflow_asset_ids: list[str] = []
        for idx, identity_ctx in enumerate(identity_contexts):
            current_identity_id = str(identity_ctx.get("identity_id") or "").strip()
            if not current_identity_id:
                continue
            safe_identity_id = _safe_id(current_identity_id, fallback="identity")
            identity_name = str(identity_ctx.get("identity_name") or current_identity_id).strip()
            prompt = str(identity_ctx.get("prompt") or "").strip()
            prompt_node_id = f"prompt_identity_{safe_identity_id}"
            flow_node_id = f"flow_identity_{safe_identity_id}"
            lane_y = 260 + idx * 520
            prompt_text = _display_prompt_text(
                prompt,
                fallback_note="（当前生成主要依赖参考图，无额外提示词）",
            )
            nodes.append(
                _prompt_text_node(
                    prompt_node_id,
                    -1040,
                    lane_y,
                    f"{identity_name} prompt",
                    prompt_text,
                    source_meta={
                        "kind": "identity_prompt",
                        "role": "identity_generation_prompt",
                        "label": f"{identity_name} prompt",
                        "meta": {
                            "character": character,
                            "identity_id": current_identity_id,
                            "identity_name": identity_name,
                        },
                    },
                )
            )
            identity_ref_id = _find_ref_node_id(
                role="character_identity",
                kind="identity",
                identity_id=current_identity_id,
            )
            identity_portrait_ref_id = _find_ref_node_id(
                role="identity_portrait",
                kind="identity",
                identity_id=current_identity_id,
            )
            identity_costume_ref_id = _find_ref_node_id(
                role="identity_costume",
                kind="identity",
                identity_id=current_identity_id,
            )
            identity_target_id = identity_ref_id or flow_node_id
            if identity_ref_id:
                _set_node_position(identity_ref_id, 620, lane_y + 90)
                for node in nodes:
                    if node.get("id") == identity_ref_id:
                        node.setdefault("data", {})["prompt"] = prompt
                        break
            else:
                nodes.append(
                    _image_gen_node(
                        flow_node_id,
                        620,
                        lane_y + 90,
                        f"{identity_name} generation",
                        prompt,
                        aspect_ratio="3:4",
                        source_meta={
                            "kind": "identity",
                            "role": "identity_workflow",
                            "label": identity_name,
                            "meta": {
                                "character": character,
                                "identity_id": current_identity_id,
                                "identity_name": identity_name,
                            },
                        },
                    )
                )
            # Identity sink keeps commit metadata for candidate push/default target.
            existing_identity_committed_url: Any = None
            for node in nodes:
                if node.get("id") == identity_target_id:
                    existing_identity_committed_url = (node.get("data") or {}).get("imageUrl")
                    break
            _update_node_data(
                identity_target_id,
                {
                    "committed_slot_url": existing_identity_committed_url,
                    "slot_target": {
                        "kind": "identity",
                        "character": character,
                        "identity_id": current_identity_id,
                    },
                    "prompt": prompt,
                    "aspectRatio": "3:4",
                    "autoCommitOnGenerate": True,
                },
            )
            # Age variant identity 没自己 identity_portrait 时,不 fallback 主
            # character portrait —— 主 portrait 是 youth 形态,拿来当中年/老年
            # 变体的视觉参考会误导(用户以为这个 age 变体已经有 portrait)。
            # 没参考就走 prompt-only 生成(portrait_flow_id),让用户先把该
            # 变体的专属 portrait 生成出来。
            is_age_variant = bool(identity_ctx.get("is_age_variant"))
            portrait_source_id = identity_portrait_ref_id or (
                (portrait_ref_id if not is_age_variant else None) or portrait_flow_id
            )
            if identity_portrait_ref_id:
                _set_node_position(identity_portrait_ref_id, -560, lane_y)
                existing_portrait_committed_url: Any = None
                for node in nodes:
                    if node.get("id") == identity_portrait_ref_id:
                        existing_portrait_committed_url = (node.get("data") or {}).get("imageUrl")
                        break
                portrait_prompt = str(
                    identity_ctx.get("identity_portrait_prompt")
                    or identity_ctx.get("face_prompt")
                    or identity_ctx.get("appearance_details")
                    or identity_ctx.get("identity_prompt")
                    or ""
                ).strip()
                _update_node_data(
                    identity_portrait_ref_id,
                    {
                        "committed_slot_url": existing_portrait_committed_url,
                        "slot_target": {
                            "kind": "identity_portrait",
                            "character": character,
                            "identity_id": current_identity_id,
                        },
                        "prompt": portrait_prompt,
                        "aspectRatio": "3:4",
                        "autoCommitOnGenerate": True,
                    },
                )
                _append_edge_if_missing(
                    f"edge_ref_identity_portrait_{safe_identity_id}_to_identity",
                    identity_portrait_ref_id,
                    identity_target_id,
                )
            if identity_costume_ref_id:
                _set_node_position(identity_costume_ref_id, -560, lane_y + 260)
                existing_costume_committed_url: Any = None
                for node in nodes:
                    if node.get("id") == identity_costume_ref_id:
                        existing_costume_committed_url = (node.get("data") or {}).get("imageUrl")
                        break
                costume_prompt = prompt
                _update_node_data(
                    identity_costume_ref_id,
                    {
                        "committed_slot_url": existing_costume_committed_url,
                        "slot_target": {
                            "kind": "identity_costume",
                            "character": character,
                            "identity_id": current_identity_id,
                        },
                        "prompt": costume_prompt,
                        "aspectRatio": "3:4",
                        "autoCommitOnGenerate": True,
                    },
                )
                _append_edge_if_missing(
                    f"edge_ref_identity_costume_{safe_identity_id}_to_identity",
                    identity_costume_ref_id,
                    identity_target_id,
                )
            _append_edge_if_missing(
                f"edge_prompt_identity_{safe_identity_id}_to_identity",
                prompt_node_id,
                identity_target_id,
            )
            if portrait_source_id and portrait_source_id != identity_portrait_ref_id:
                _append_edge_if_missing(
                    f"edge_ref_portrait_to_identity_{safe_identity_id}",
                    portrait_source_id,
                    identity_target_id,
                )
            reference_url = _node_image_url(portrait_source_id)
            if reference_url:
                _update_node_data(identity_target_id, {"referenceImageUrl": reference_url})
            workflow_asset_ids.append(identity_target_id)

        usage_source_ids = workflow_asset_ids or ([portrait_ref_id] if portrait_ref_id else [])
        for idx, node_id in enumerate(usage_context_ids[:8]):
            paired_y = 260 + idx * 260
            _set_node_position(node_id, 1080, paired_y)
            for source_id in usage_source_ids[:3]:
                _append_edge_if_missing(
                    f"edge_asset_{source_id}_to_usage_{node_id}",
                    source_id,
                    node_id,
                )

        prop_context = generation_context.get("prop") or {}
        if asset_kind in {"prop", "prop_ref"} and prop_context:
            prop_id = str(prop_context.get("prop_id") or context.get("asset_id") or "").strip()
            prop_ref_id = _find_ref_node_id(role="prop_reference", kind="prop")
            if prop_ref_id:
                _set_node_position(prop_ref_id, -120, -120)
            profile = prop_context.get("profile") or {}
            if profile:
                nodes.append(
                    _text_node(
                        "prop_profile",
                        -1040,
                        -520,
                        "Prop profile",
                        _prop_profile_content(profile),
                        {
                            "__freezone_source": {
                                "kind": "prop_profile",
                                "role": "prop_context",
                                "label": f"{prop_id} profile",
                                "meta": {"prop_id": prop_id},
                            }
                        },
                    )
                )
            prompt = str(prop_context.get("prompt") or "").strip()
            prop_committed_url: Any = None
            if prop_ref_id:
                for node in nodes:
                    if node.get("id") == prop_ref_id:
                        prop_committed_url = (node.get("data") or {}).get("imageUrl")
                        break
                _update_node_data(
                    prop_ref_id,
                    {
                        "committed_slot_url": prop_committed_url,
                        "slot_target": {
                            "kind": "prop_ref",
                            "prop_id": prop_id,
                        },
                        "prompt": prompt,
                        "aspectRatio": "1:1",
                        "requestAspectRatio": "auto",
                        "autoCommitOnGenerate": True,
                    },
                )
            _append_edge_if_missing(
                "edge_prop_profile_to_reference",
                "prop_profile" if profile else None,
                prop_ref_id,
            )

        # Scene master/reverse slots keep commit metadata for candidate push/default target.
        # scene_director_pano_360 — 该 ref 由 _add_scene_refs 渲染成 pano360ViewerNode
        # (sphere viewer, 不是 imageGenNode),所以额外 emit 一个 imageGenNode
        # canonical source placeholder (workflow_scene_360)。两个节点共享同一 slot 文件:
        #   - pano360 viewer:展示当前 canonical 文件
        #   - workflow trigger: candidate preview + Push target metadata
        #
        # 注:旧 \"scene_360\" role 已 deprecate (presets.py:703-710 注释),asset
        # preset 实际只 emit scene_director_pano_360。所以这里只查后者。
        scene_master_node_id = _find_ref_node_id(role="scene_master", kind="scene")
        scene_reverse_node_id = _find_ref_node_id(role="scene_reverse_master", kind="scene")
        scene_pano_viewer_node_id = _find_ref_node_id(
            role="scene_director_pano_360",
            kind="scene",
        ) or _find_ref_node_id(role="scene_360", kind="scene")
        # scene_id 来源: asset_id (scene preset_key 把它放 asset_id);兼容老路径
        # 也接 identity_id / character (有些 fixture 没分清)。
        scene_name_for_target = str(
            context.get("asset_id") or context.get("identity_id") or context.get("character") or ""
        ).strip()
        if scene_master_node_id and scene_name_for_target:
            existing_master_url: Any = None
            for node in nodes:
                if node.get("id") == scene_master_node_id:
                    existing_master_url = (node.get("data") or {}).get("imageUrl")
                    break
            _update_node_data(
                scene_master_node_id,
                {
                    "committed_slot_url": existing_master_url,
                    "slot_target": {
                        "kind": "scene_master",
                        "scene_id": scene_name_for_target,
                    },
                    "aspectRatio": "16:9",
                    "autoCommitOnGenerate": True,
                },
            )
        if scene_reverse_node_id and scene_name_for_target:
            existing_reverse_url: Any = None
            for node in nodes:
                if node.get("id") == scene_reverse_node_id:
                    existing_reverse_url = (node.get("data") or {}).get("imageUrl")
                    break
            _update_node_data(
                scene_reverse_node_id,
                {
                    "committed_slot_url": existing_reverse_url,
                    "slot_target": {
                        "kind": "scene_reverse_master",
                        "scene_id": scene_name_for_target,
                    },
                    "aspectRatio": "16:9",
                    "autoCommitOnGenerate": True,
                },
            )
        if scene_pano_viewer_node_id and scene_name_for_target:
            # scene_director_pano_360 是复杂 workflow (master + reverse +
            # prompt → 360 panorama),应该由显式 SkillNode 表达组合技能:
            # master/reverse/prompt → SkillNode → readonly canonical viewer。
            pano_viewer_pos = (1480, 460)
            pano_viewer_url: Any = None
            for node in nodes:
                node_id = node.get("id")
                if node_id == scene_pano_viewer_node_id:
                    pano_viewer_url = (node.get("data") or {}).get("imageUrl")
                    pos = node.get("position") or {}
                    pano_viewer_pos = (
                        int(pos.get("x") or pano_viewer_pos[0]),
                        int(pos.get("y") or pano_viewer_pos[1]),
                    )
            skill_360_node_id = "skill_scene_360"
            nodes.append(
                _skill_node(
                    skill_360_node_id,
                    pano_viewer_pos[0] - 760,  # inputs → skill → output viewer
                    pano_viewer_pos[1],
                    skill_id="freezone.scene_360",
                    display_name=f"{scene_name_for_target} Scene 360",
                )
            )
            if scene_master_node_id:
                edges.append(
                    _skill_role_edge(
                        f"edge_{_safe_id(scene_master_node_id)}_to_skill_scene_360_scene_master",
                        scene_master_node_id,
                        skill_360_node_id,
                        role="scene_master",
                        label="Scene master",
                    )
                )
            if scene_reverse_node_id:
                edges.append(
                    _skill_role_edge(
                        f"edge_{_safe_id(scene_reverse_node_id)}_to_skill_scene_360_scene_reverse_master",
                        scene_reverse_node_id,
                        skill_360_node_id,
                        role="scene_reverse_master",
                        label="Scene reverse master",
                    )
                )
            # generic scene prompt → skill input. prompt_id pattern:
            # "prompt_scene_<safe_scene_id>".
            generic_scene_prompt_id = (
                f"prompt_scene_{_safe_id(scene_name_for_target, fallback='scene')}"
            )
            if any(node.get("id") == generic_scene_prompt_id for node in nodes):
                edges.append(
                    _skill_role_edge(
                        f"edge_{generic_scene_prompt_id}_to_{_safe_id(skill_360_node_id)}_scene",
                        generic_scene_prompt_id,
                        skill_360_node_id,
                        role="scene",
                        label="Scene prompt",
                    )
                )
            _update_node_data(
                scene_pano_viewer_node_id,
                {
                    "committed_slot_url": pano_viewer_url,
                    "slot_target": {
                        "kind": "scene_director_pano_360",
                        "scene_id": scene_name_for_target,
                    },
                },
            )
            edges.append(
                _edge(
                    f"edge_{_safe_id(skill_360_node_id)}_to_{_safe_id(scene_pano_viewer_node_id)}",
                    skill_360_node_id,
                    scene_pano_viewer_node_id,
                    {
                        "edgeKind": "mainline_data",
                        "propagates": True,
                        "role": "scene_360_canonical",
                        "label": "Scene 360",
                    },
                    source_handle="scene_360_candidate",
                )
            )

    metadata = {
        "preset": {
            "preset_key": preset_key,
            "scope": context.get("scope"),
            "episode": context.get("episode"),
            "beat": context.get("beat"),
            "primary_slot": context.get("primary_slot"),
            "created_at": created_at or datetime.now().isoformat(),
        },
        "default_push_target": default_push_target,
        "references": [ref for ref in refs if _is_asset_library_reference(ref)],
        "beat_context": context.get("beat_data"),
        "prop_menu": context.get("prop_menu") or [],
    }
    if context.get("scope") == "beat":
        beat_data = context.get("beat_data") or {}
        metadata["director_capture"] = {
            "episode": context.get("episode"),
            "beat": context.get("beat"),
            "scene_id": _normalize_scene_name(beat_data.get("scene_ref")),
            "node_id": "director_capture",
        }
    return {
        "nodes": nodes,
        "edges": edges,
        "viewport": {"x": 960, "y": 540, "zoom": 0.65},
        "metadata": metadata,
        "episode": context.get("episode"),
        "beat": context.get("beat"),
    }
