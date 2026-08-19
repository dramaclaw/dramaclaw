"""Project asset resolution for Seedance 2.0 image-to-video."""

from __future__ import annotations

import json
import re
import sqlite3
import struct
from dataclasses import dataclass
from dataclasses import replace
from pathlib import Path
from typing import Any

from novelvideo.models import (
    NovelCharacter,
    NovelProp,
    beat_scene_ref,
    collect_prop_marker_ids_from_beat,
    real_detected_identities,
    real_detected_props,
    resolve_scene_plate,
)
from novelvideo.project_config import (
    load_effective_narration_style_for_voice,
    load_effective_narration_style_for_voice_from_state_dir,
    load_narrator_reference_audio,
    load_narrator_reference_audio_from_state_dir,
)
from novelvideo.seedance2_i2v.character_voice_storage import probe_voice_sample_duration_seconds
from novelvideo.seedance2_i2v.models import Seedance2I2VMode
from novelvideo.seedance2_i2v.spoken_dialogue import (
    speaker_display_name,
    unique_seedance2_dialogue_speakers,
)
from novelvideo.seedance2_i2v.voice_clone import (
    DEFAULT_NARRATION_STYLE,
    find_identity_reference_audio,
    NARRATOR_SPEAKER,
    normalize_seedance2_audio_type,
    resolve_character_voice,
)
from novelvideo.utils.path_resolver import PathResolver
from novelvideo.utils.path_resolver import canonical_scene_master_path
from novelvideo.utils.path_resolver import canonical_prop_reference_path

MIN_REFERENCE_ASPECT_RATIO = 0.4
MAX_REFERENCE_ASPECT_RATIO = 2.5
MIN_REFERENCE_DIMENSION = 300
MAX_REFERENCE_DIMENSION = 6000
MIN_SEEDANCE2_VOICE_REFERENCE_SECONDS = 3.0
MAX_SEEDANCE2_VOICE_REFERENCE_SECONDS = 5.0


@dataclass(frozen=True)
class Seedance2ResolvedAsset:
    key: str
    label: str
    media_type: str
    path: Path
    exists: bool
    selected: bool
    request_field: str
    reference_label: str
    note: str = ""
    image_number: int | None = None
    audio_number: int | None = None
    identity_id: str = ""
    prop_id: str = ""
    prop_scope: str = ""
    validation_error: str = ""
    required: bool = True
    fallback_text: str = ""
    crop_source_path: Path | None = None


def _text(value: Any) -> str:
    return str(value or "").strip()


def _unique_strings(values: list[Any]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for value in values:
        text = _text(value)
        if text and text not in seen:
            seen.add(text)
            result.append(text)
    return result


def _identity_ids_from_visual_markers(beat: dict[str, Any]) -> list[str]:
    return _unique_strings(re.findall(r"\{\{([^}]+)\}\}", _text(beat.get("visual_description"))))


def _load_sqlite_detected_identities(
    project_output: Path,
    *,
    episode: int,
    beat_number: int,
) -> list[str] | None:
    db_path = _character_db_path(project_output)
    if not db_path.exists():
        return None
    try:
        conn = sqlite3.connect(db_path)
        try:
            row = conn.execute(
                "SELECT detected_identities_json FROM beats "
                "WHERE episode_number = ? AND beat_number = ?",
                (int(episode), int(beat_number)),
            ).fetchone()
        finally:
            conn.close()
    except sqlite3.Error:
        return None
    if not row:
        return None
    try:
        parsed = json.loads(row[0] or "[]")
    except json.JSONDecodeError:
        return None
    if not isinstance(parsed, list):
        return None
    return _unique_strings(parsed)


def _load_sqlite_detected_props(
    project_output: Path,
    *,
    episode: int,
    beat_number: int,
) -> list[str] | None:
    db_path = _character_db_path(project_output)
    if not db_path.exists():
        return None
    try:
        conn = sqlite3.connect(db_path)
        try:
            row = conn.execute(
                "SELECT detected_props_json FROM beats "
                "WHERE episode_number = ? AND beat_number = ?",
                (int(episode), int(beat_number)),
            ).fetchone()
        finally:
            conn.close()
    except sqlite3.Error:
        return None
    if not row:
        return None
    try:
        parsed = json.loads(row[0] or "[]")
    except json.JSONDecodeError:
        return None
    if not isinstance(parsed, list):
        return None
    return _unique_strings(parsed)


def resolve_beat_identity_ids(
    beat: dict[str, Any],
    *,
    project_output: Path | None = None,
    episode: int | None = None,
) -> list[str]:
    candidates: list[Any] = []
    if project_output is not None and episode is not None:
        sqlite_detected = _load_sqlite_detected_identities(
            Path(project_output),
            episode=int(episode),
            beat_number=int(beat.get("beat_number") or 0),
        )
        if sqlite_detected is not None:
            candidates.extend(sqlite_detected)

    detected = beat.get("detected_identities") or beat.get("detected_identities_json") or []
    if isinstance(detected, str):
        try:
            detected = json.loads(detected)
        except json.JSONDecodeError:
            detected = []
    if isinstance(detected, list):
        candidates.extend(detected)
    candidates.extend(_identity_ids_from_visual_markers(beat))
    return real_detected_identities(_unique_strings(candidates))


def resolve_beat_prop_ids(
    beat: dict[str, Any],
    *,
    project_output: Path | None = None,
    episode: int | None = None,
) -> list[str]:
    candidates: list[Any] = []
    if project_output is not None and episode is not None:
        sqlite_detected = _load_sqlite_detected_props(
            Path(project_output),
            episode=int(episode),
            beat_number=int(beat.get("beat_number") or 0),
        )
        if sqlite_detected is not None:
            candidates.extend(sqlite_detected)

    detected = beat.get("detected_props") or beat.get("detected_props_json") or []
    if isinstance(detected, str):
        try:
            detected = json.loads(detected)
        except json.JSONDecodeError:
            detected = []
    if isinstance(detected, list):
        candidates.extend(detected)
    candidates.extend(collect_prop_marker_ids_from_beat(beat))
    return real_detected_props(_unique_strings(candidates))


def _split_identity_label(identity_id: str) -> tuple[str, str]:
    if "_" not in identity_id:
        return identity_id, ""
    return identity_id.split("_", 1)


def _identity_display_label(identity_id: str) -> str:
    character, identity = _split_identity_label(identity_id)
    return f"{character}（{identity}）" if identity else character


def _identity_asset_path(project_output: Path, identity_id: str) -> Path:
    character, identity = _split_identity_label(identity_id)
    if not identity:
        return project_output / "assets" / "characters" / character / "portrait.png"
    return project_output / "assets" / "characters" / character / "identities" / f"{identity}.png"


def _prop_asset_path(project_output: Path, prop_id: str) -> Path:
    return canonical_prop_reference_path(project_output, prop_id)


def _load_sqlite_episode_prop_menu(project_output: Path, episode: int) -> list[dict[str, Any]]:
    db_path = _character_db_path(project_output)
    if not db_path.exists():
        return []
    try:
        conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        try:
            row = conn.execute(
                "SELECT prop_menu_json FROM episodes WHERE number = ?",
                (int(episode),),
            ).fetchone()
        finally:
            conn.close()
    except sqlite3.Error:
        return []
    if not row:
        return []
    try:
        parsed = json.loads(row[0] or "[]")
    except json.JSONDecodeError:
        return []
    return [item for item in parsed if isinstance(item, dict)] if isinstance(parsed, list) else []


def _truthy_flag(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    text = _text(value).lower()
    return text in {"1", "true", "yes", "y", "on", "global", "tracked_marker"}


def _prop_menu_item_id(item: Any) -> str:
    if isinstance(item, dict):
        return _text(item.get("prop_id") or item.get("base_id") or item.get("name"))
    return _text(
        getattr(item, "prop_id", None)
        or getattr(item, "base_id", None)
        or getattr(item, "name", None)
    )


def _prop_menu_metadata(prop_id: str, prop_menu: list[Any] | None) -> dict[str, Any]:
    lookup = _text(prop_id)
    if not lookup:
        return {}
    for item in prop_menu or []:
        if _prop_menu_item_id(item) != lookup:
            continue
        if isinstance(item, dict):
            scope = _text(item.get("asset_scope") or item.get("scope")).lower()
            is_global = (
                _truthy_flag(item.get("is_global_asset"))
                or scope == "global"
                or _truthy_flag(item.get("preserve_marker_color"))
                or _truthy_flag(item.get("tracking"))
                or bool(_text(item.get("marker_color")))
            )
            return {
                "prop_id": lookup,
                "scope": "global" if is_global else (scope or "episode"),
                "is_global_asset": is_global,
                "visual_prompt": _text(item.get("visual_prompt")),
                "description": _text(item.get("description")),
                "prop_type": _text(item.get("prop_type") or item.get("type")),
                "owner_identity_id": _text(item.get("owner_identity_id")),
            }
        return {
            "prop_id": lookup,
            "scope": "episode",
            "is_global_asset": False,
            "visual_prompt": _text(getattr(item, "visual_prompt", "")),
            "description": _text(getattr(item, "description", "")),
            "prop_type": _text(getattr(item, "prop_type", "")),
            "owner_identity_id": _text(getattr(item, "owner_identity_id", "")),
        }
    return {}


def _join_unique_text_parts(parts: list[str]) -> str:
    seen: set[str] = set()
    result: list[str] = []
    for part in parts:
        text = _text(part)
        if text and text not in seen:
            seen.add(text)
            result.append(text)
    return "；".join(result)


def _scene_asset_names(project_output: Path) -> set[str]:
    scenes_dir = project_output / "assets" / "scenes"
    if not scenes_dir.exists():
        return set()
    return {path.name for path in scenes_dir.iterdir() if path.is_dir()}


def _beat_scene_label(project_output: Path, beat: dict[str, Any]) -> str:
    scene_ref = beat_scene_ref(beat)
    if scene_ref:
        scene_name, _time_baked = resolve_scene_plate(
            scene_ref.scene_id,
            scene_ref.variant_id,
            _text(beat.get("time_of_day")),
            _scene_asset_names(project_output),
        )
        return scene_name
    location = _text(beat.get("location"))
    if location:
        return location
    return _text(beat.get("scene_description")).split("，", 1)[0] or "未识别场景"


def _scene_asset_path(project_output: Path, beat: dict[str, Any]) -> Path:
    return _beat_scene_asset(project_output, beat)[1]


def _beat_scene_asset(project_output: Path, beat: dict[str, Any]) -> tuple[str, Path]:
    scene_label = _beat_scene_label(project_output, beat)
    scene_path = canonical_scene_master_path(project_output, scene_label)
    if scene_path.exists():
        return scene_label, scene_path
    scene_ref = beat_scene_ref(beat)
    if scene_ref and scene_ref.variant_id:
        base_path = canonical_scene_master_path(project_output, scene_ref.scene_id)
        if base_path.exists():
            return scene_ref.scene_id, base_path
    return scene_label, scene_path


def _read_png_size(path: Path) -> tuple[int, int] | None:
    try:
        with path.open("rb") as handle:
            header = handle.read(24)
    except OSError:
        return None
    if len(header) >= 24 and header[:8] == b"\x89PNG\r\n\x1a\n" and header[12:16] == b"IHDR":
        return struct.unpack(">II", header[16:24])
    return None


def _read_jpeg_size(path: Path) -> tuple[int, int] | None:
    try:
        with path.open("rb") as handle:
            data = handle.read()
    except OSError:
        return None
    if not data.startswith(b"\xff\xd8"):
        return None
    index = 2
    while index + 9 < len(data):
        if data[index] != 0xFF:
            index += 1
            continue
        marker = data[index + 1]
        index += 2
        if marker in {0xD8, 0xD9}:
            continue
        if index + 2 > len(data):
            return None
        segment_length = int.from_bytes(data[index : index + 2], "big")
        if segment_length < 2 or index + segment_length > len(data):
            return None
        if 0xC0 <= marker <= 0xCF and marker not in {0xC4, 0xC8, 0xCC}:
            if segment_length >= 7:
                height = int.from_bytes(data[index + 3 : index + 5], "big")
                width = int.from_bytes(data[index + 5 : index + 7], "big")
                return width, height
            return None
        index += segment_length
    return None


def read_seedance2_image_size(path: Path) -> tuple[int, int] | None:
    return _read_png_size(path) or _read_jpeg_size(path)


def validate_seedance2_reference_image(path: Path) -> str:
    size = read_seedance2_image_size(path)
    if not size:
        return ""
    width, height = size
    if width < MIN_REFERENCE_DIMENSION or width > MAX_REFERENCE_DIMENSION:
        return f"Width must be between 300px and 6000px. Current: {width}px."
    if height < MIN_REFERENCE_DIMENSION or height > MAX_REFERENCE_DIMENSION:
        return f"Height must be between 300px and 6000px. Current: {height}px."
    aspect_ratio = width / height if height else 0
    if not (MIN_REFERENCE_ASPECT_RATIO <= aspect_ratio <= MAX_REFERENCE_ASPECT_RATIO):
        return (
            "Aspect ratio must be between 0.4 and 2.5. "
            f"Current: {aspect_ratio:.2f} ({width}x{height})."
        )
    return ""


def validate_seedance2_reference_audio(path: Path) -> tuple[str, str]:
    try:
        duration = probe_voice_sample_duration_seconds(path)
    except ValueError:
        return "", ""
    if duration < MIN_SEEDANCE2_VOICE_REFERENCE_SECONDS:
        return "", f"当前 {duration:.1f} 秒，建议裁剪到 3-5 秒。"
    if duration > MAX_SEEDANCE2_VOICE_REFERENCE_SECONDS:
        return "", f"当前 {duration:.1f} 秒，建议裁剪到 3-5 秒。"
    return "", ""


def _load_sqlite_characters(project_output: Path) -> list[NovelCharacter]:
    db_path = _character_db_path(project_output)
    if not db_path.exists():
        return []
    try:
        conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        conn.row_factory = sqlite3.Row
        try:
            rows = conn.execute("SELECT * FROM characters").fetchall()
        finally:
            conn.close()
    except sqlite3.Error:
        return []

    characters: list[NovelCharacter] = []
    for row in rows:
        keys = set(row.keys())
        try:
            characters.append(
                NovelCharacter(
                    name=row["name"],
                    aliases=(
                        json.loads(row["aliases_json"] or "[]") if "aliases_json" in keys else []
                    ),
                    role=row["role"] or "" if "role" in keys else "",
                    is_main=bool(row["is_main"]) if "is_main" in keys else False,
                    gender=row["gender"] or "" if "gender" in keys else "",
                    age_group=row["age_group"] or "youth" if "age_group" in keys else "youth",
                    body_type=row["body_type"] or "" if "body_type" in keys else "",
                    fish_voice_id=row["fish_voice_id"] or "" if "fish_voice_id" in keys else "",
                    description=row["description"] or "" if "description" in keys else "",
                    face_prompt=row["face_prompt"] or "" if "face_prompt" in keys else "",
                    appearance_details=(
                        row["appearance_details"] or "" if "appearance_details" in keys else ""
                    ),
                    identities_json=(
                        row["identities_json"] or "[]" if "identities_json" in keys else "[]"
                    ),
                    reference_audio_path=(
                        row["reference_audio_path"] or "" if "reference_audio_path" in keys else ""
                    ),
                    reference_audio_sha256=(
                        row["reference_audio_sha256"] or ""
                        if "reference_audio_sha256" in keys
                        else ""
                    ),
                    reference_audio_updated_at=(
                        row["reference_audio_updated_at"] or ""
                        if "reference_audio_updated_at" in keys
                        else ""
                    ),
                    voice_samples_by_age_group_json=(
                        row["voice_samples_by_age_group_json"] or "{}"
                        if "voice_samples_by_age_group_json" in keys
                        else "{}"
                    ),
                )
            )
        except (TypeError, ValueError, json.JSONDecodeError):
            continue
    return characters


def _load_sqlite_props(project_output: Path) -> list[NovelProp]:
    db_path = _character_db_path(project_output)
    if not db_path.exists():
        return []
    try:
        conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        conn.row_factory = sqlite3.Row
        try:
            rows = conn.execute("SELECT * FROM props").fetchall()
        finally:
            conn.close()
    except sqlite3.Error:
        return []

    props: list[NovelProp] = []
    for row in rows:
        try:
            props.append(
                NovelProp(
                    name=row["name"],
                    aliases=json.loads(row["aliases_json"] or "[]"),
                    prop_type=row["prop_type"] or "object",
                    visual_prompt=row["visual_prompt"] or "",
                    description=row["description"] or "",
                    owner=row["owner"] or "",
                    notes=row["notes"] or "",
                )
            )
        except (TypeError, ValueError, json.JSONDecodeError):
            continue
    return props


def _character_db_path(project_output: Path) -> Path:
    """Resolve the project's data.db, anchoring on state/ (the canonical home).

    Mirrors the resolution logic in `image_request_usage.get_image_request_usage_db_path`:
    if `project_output` lives under OUTPUT_DIR, bootstrap any legacy payload
    into state/ and return the state path. Otherwise (test fixtures, arbitrary
    paths) fall back to `project_output / data.db` unchanged.
    """
    from novelvideo.config import OUTPUT_DIR, STATE_DIR
    from novelvideo.utils.project_paths import ProjectPaths

    project_output = Path(project_output).resolve()
    output_root = Path(OUTPUT_DIR).resolve()
    state_root = Path(STATE_DIR).resolve()
    try:
        rel = project_output.relative_to(output_root)
    except ValueError:
        return (project_output / "data.db").resolve()
    if len(rel.parts) >= 2:
        user, project = rel.parts[0], rel.parts[1]
        ProjectPaths(user, project).bootstrap_from_legacy_output()
        return (state_root / user / project / "data.db").resolve()
    return (project_output / "data.db").resolve()


def _find_character_for_identity(
    identity_id: str, characters: list[Any]
) -> tuple[Any | None, Any | None]:
    character_name, identity_name = _split_identity_label(identity_id)
    for character in characters:
        if _text(getattr(character, "name", "")) != character_name:
            continue
        identity = next(
            (
                item
                for item in getattr(character, "identities", []) or []
                if _text(getattr(item, "identity_id", "")) == identity_id
                or _text(getattr(item, "identity_name", "")) == identity_name
            ),
            None,
        )
        return character, identity
    return None, None


def _find_prop(prop_id: str, props: list[Any]) -> Any | None:
    lookup = _text(prop_id)
    if not lookup:
        return None
    for prop in props or []:
        name = _text(getattr(prop, "name", ""))
        aliases = list(getattr(prop, "aliases", []) or [])
        if lookup == name or lookup in {_text(alias) for alias in aliases}:
            return prop
    return None


def _prop_prompt_fallback(
    prop_id: str,
    props: list[Any],
    menu_meta: dict[str, Any] | None = None,
) -> str:
    prop = _find_prop(prop_id, props)
    menu_meta = menu_meta or {}
    parts = (
        [
            _text(menu_meta.get("visual_prompt")),
            _text(menu_meta.get("description")),
            _text(getattr(prop, "visual_prompt", "")),
            _text(getattr(prop, "description", "")),
        ]
        if prop is not None
        else [
            _text(menu_meta.get("visual_prompt")),
            _text(menu_meta.get("description")),
        ]
    )
    return _join_unique_text_parts(parts)


def _identity_prompt_fallback(identity_id: str, characters: list[Any]) -> str:
    character, identity = _find_character_for_identity(identity_id, characters)
    if character is None:
        return _identity_display_label(identity_id)

    face_prompt = _text(getattr(identity, "face_prompt", "")) if identity is not None else ""
    if not face_prompt:
        face_prompt = _text(getattr(character, "face_prompt", ""))
    appearance = _text(getattr(identity, "appearance_details", "")) if identity is not None else ""
    if not appearance:
        appearance = _text(getattr(character, "appearance_details", ""))
    body_type = _text(getattr(identity, "body_type", "")) if identity is not None else ""
    if not body_type:
        body_type = _text(getattr(character, "body_type", ""))
    parts = [part for part in (face_prompt, appearance, body_type) if part]
    return "，".join(parts) or _identity_display_label(identity_id)


def _speaker_matches_character(speaker: str, character: Any) -> bool:
    speaker_text = _text(speaker)
    character_name = _text(getattr(character, "name", ""))
    if not speaker_text or not character_name:
        return False
    if speaker_text == character_name or speaker_text.startswith(f"{character_name}_"):
        return True
    if speaker_display_name(speaker_text) == character_name:
        return True
    aliases = getattr(character, "aliases", None) or []
    return any(
        speaker_text == alias or speaker_display_name(speaker_text) == alias for alias in aliases
    )


def _identity_for_speaker(speaker: str, character: Any, beat: dict[str, Any]):
    speaker_text = _text(speaker)
    beat_speaker = _text(beat.get("speaker"))
    identities = list(getattr(character, "identities", None) or [])

    for identity in identities:
        if _text(getattr(identity, "identity_id", "")) == speaker_text:
            return identity

    if beat_speaker and speaker_display_name(beat_speaker) == getattr(character, "name", ""):
        for identity in identities:
            if _text(getattr(identity, "identity_id", "")) == beat_speaker:
                return identity

    for identity in identities:
        if _text(getattr(identity, "identity_name", "")) == speaker_text:
            return identity
    return None


def _voice_asset_label(character: Any, identity: Any | None) -> str:
    character_name = _text(getattr(character, "name", ""))
    identity_name = _text(getattr(identity, "identity_name", "")) if identity is not None else ""
    if identity_name:
        return f"{character_name} · {identity_name}声线"
    return f"{character_name}声线"


def _voice_asset_key(character: Any, identity: Any | None) -> str:
    identity_id = _text(getattr(identity, "identity_id", "")) if identity is not None else ""
    if identity_id:
        return f"voice:{identity_id}"
    return f"voice:{_text(getattr(character, 'name', ''))}"


def _voice_identity_id(character: Any, identity: Any | None) -> str:
    identity_id = _text(getattr(identity, "identity_id", "")) if identity is not None else ""
    return identity_id or _text(getattr(character, "name", ""))


def _project_path(project_output: Path, stored_path: str) -> Path:
    path = Path(_text(stored_path))
    if path.is_absolute():
        return path
    return project_output / path


def _stored_voice_candidate(project_output: Path, character: Any, identity: Any | None) -> Path:
    if identity is not None:
        stored = _text(getattr(identity, "reference_audio_path", ""))
        if stored:
            return _project_path(project_output, stored)

        age_group = _text(getattr(identity, "age_group", ""))
        samples = getattr(character, "voice_samples_by_age_group", None) or {}
        if age_group and isinstance(samples, dict):
            entry = samples.get(age_group)
            if isinstance(entry, dict) and _text(entry.get("path")):
                return _project_path(project_output, _text(entry.get("path")))

    stored = _text(getattr(character, "reference_audio_path", ""))
    if stored:
        return _project_path(project_output, stored)

    character_name = _text(getattr(character, "name", ""))
    return (
        project_output / "assets" / "characters" / character_name / "voices" / "voice_default.mp3"
    )


def _resolve_voice_path(project_output: Path, character: Any, identity: Any | None) -> Path:
    resolution = resolve_character_voice(
        project_dir=project_output,
        character=character,
        identity=identity,
    )
    if resolution.audio_path is not None:
        return resolution.audio_path
    if identity is not None:
        legacy = find_identity_reference_audio(
            project_output,
            _text(getattr(character, "name", "")),
            _text(getattr(identity, "identity_name", "")),
        )
        if legacy is not None:
            return legacy
    return _stored_voice_candidate(project_output, character, identity)


def _dialogue_voice_assets(
    *,
    project_output: Path,
    beat: dict[str, Any],
    characters: list[Any],
) -> list[dict[str, Any]]:
    refs: list[dict[str, Any]] = []
    seen: set[str] = set()
    for speaker in unique_seedance2_dialogue_speakers(beat):
        character = next(
            (item for item in characters if _speaker_matches_character(speaker, item)),
            None,
        )
        if character is None:
            display_name = speaker_display_name(speaker)
            missing_path = (
                project_output
                / "assets"
                / "characters"
                / display_name
                / "voices"
                / "voice_default.mp3"
            )
            key = f"voice:{_text(speaker) or display_name}"
            if key in seen:
                continue
            seen.add(key)
            refs.append(
                {
                    "key": key,
                    "label": f"{display_name}声线",
                    "path": missing_path,
                    "identity_id": _text(speaker) or display_name,
                }
            )
            continue

        identity = _identity_for_speaker(speaker, character, beat)
        identity_id = _voice_identity_id(character, identity)
        key = _voice_asset_key(character, identity)
        if key in seen:
            continue
        seen.add(key)
        refs.append(
            {
                "key": key,
                "label": _voice_asset_label(character, identity),
                "path": _resolve_voice_path(project_output, character, identity),
                "identity_id": identity_id,
            }
        )
    return refs


def _project_owner_from_output(project_output: Path) -> tuple[str, str]:
    project = _text(project_output.name)
    username = _text(project_output.parent.name)
    return username, project


def _narration_voice_asset(
    *,
    project_output: Path,
    characters: list[Any],
    state_dir: str | Path | None = None,
) -> dict[str, Any]:
    username, project = _project_owner_from_output(project_output)
    try:
        style = (
            load_effective_narration_style_for_voice_from_state_dir(state_dir)
            if state_dir
            else load_effective_narration_style_for_voice(username, project)
        )
    except Exception:
        style = DEFAULT_NARRATION_STYLE

    if style == "first_person":
        protagonist = next((item for item in characters if getattr(item, "is_main", False)), None)
        if protagonist is not None:
            identities = list(getattr(protagonist, "identities", None) or [])
            identity = identities[0] if identities else None
            return {
                "key": _voice_asset_key(protagonist, identity),
                "label": _voice_asset_label(protagonist, identity),
                "path": _resolve_voice_path(project_output, protagonist, identity),
                "identity_id": _voice_identity_id(protagonist, identity),
            }

    try:
        descriptor = (
            load_narrator_reference_audio_from_state_dir(state_dir)
            if state_dir
            else load_narrator_reference_audio(username, project)
        )
    except Exception:
        descriptor = {}
    stored_path = _text(descriptor.get("path")) if isinstance(descriptor, dict) else ""
    path = (
        _project_path(project_output, stored_path)
        if stored_path
        else (project_output / "assets" / "narrator" / "voice.mp3")
    )
    return {
        "key": "voice:narrator",
        "label": "项目解说声线",
        "path": path,
        "identity_id": NARRATOR_SPEAKER,
    }


def build_seedance2_project_assets(
    *,
    project_output: Path,
    episode: int,
    beat: dict[str, Any],
    mode: Seedance2I2VMode,
    next_beat: dict[str, Any] | None = None,
    characters: list[Any] | None = None,
    prop_menu: list[Any] | None = None,
    state_dir: str | Path | None = None,
) -> list[Seedance2ResolvedAsset]:
    """Resolve project assets in the order used for Seedance 2.0 requests."""

    beat_num = int(beat.get("beat_number") or 0)
    next_beat_num = int(next_beat.get("beat_number") or 0) if next_beat else 0
    assets: list[Seedance2ResolvedAsset] = []
    next_image_number = 1
    next_audio_number = 1

    def add_image(
        *,
        key: str,
        label: str,
        path: Path,
        selected: bool,
        request_field: str,
        note: str = "",
        identity_id: str = "",
        prop_id: str = "",
        prop_scope: str = "",
        required: bool = True,
        fallback_text: str = "",
        crop_source_path: Path | None = None,
    ) -> None:
        nonlocal next_image_number
        exists = path.exists()
        validation_error = validate_seedance2_reference_image(path) if exists and selected else ""
        use = selected and exists and not validation_error
        image_number = next_image_number if use else None
        if image_number:
            next_image_number += 1
        reference_label = f"图片{image_number}" if image_number else "未发送"
        asset_note = (
            f"{note}；{validation_error}"
            if validation_error and note
            else (validation_error or note)
        )
        assets.append(
            Seedance2ResolvedAsset(
                key=key,
                label=label,
                media_type="image",
                path=path,
                exists=exists,
                selected=use,
                request_field=request_field if use else "",
                reference_label=reference_label,
                note=asset_note,
                image_number=image_number,
                identity_id=identity_id,
                prop_id=prop_id,
                prop_scope=prop_scope,
                validation_error=validation_error,
                required=required,
                fallback_text=fallback_text,
                crop_source_path=crop_source_path,
            )
        )

    def add_audio(
        *,
        key: str,
        label: str,
        path: Path,
        selected: bool,
        note: str = "",
        identity_id: str = "",
    ) -> None:
        nonlocal next_audio_number
        exists = path.exists()
        validation_error = ""
        validation_note = ""
        if exists and selected:
            validation_error, validation_note = validate_seedance2_reference_audio(path)
        use = selected and exists and not validation_error
        audio_number = next_audio_number if use else None
        if audio_number:
            next_audio_number += 1
        asset_note = (
            f"{note}；{validation_note}" if validation_note and note else (validation_note or note)
        )
        assets.append(
            Seedance2ResolvedAsset(
                key=key,
                label=label,
                media_type="audio",
                path=path,
                exists=exists,
                selected=use,
                request_field="reference_audios" if use else "",
                reference_label=f"音频{audio_number}" if audio_number else "未发送",
                note=asset_note,
                audio_number=audio_number,
                identity_id=identity_id,
                validation_error=validation_error,
            )
        )

    paths = PathResolver(project_output, episode)
    first_frame_source = paths.frame(beat_num)
    first_frame_path = (
        paths.valid_video_input_frame(
            beat_num,
            slot="first_frame",
            source_path=first_frame_source,
        )
        or first_frame_source
    )
    if mode == Seedance2I2VMode.FIRST_FRAME:
        add_image(
            key="first_frame",
            label=f"首帧 render · Beat {beat_num}",
            path=first_frame_path,
            selected=True,
            request_field="image_url",
            note="首帧模式只发送这一张首帧图，不混用参考图。",
            crop_source_path=first_frame_source,
        )
        return assets

    if mode == Seedance2I2VMode.FIRST_LAST_FRAME:
        last_frame_beat_num = next_beat_num or beat_num + 1
        last_frame_source = paths.frame(last_frame_beat_num)
        last_frame_path = (
            paths.valid_video_input_frame(
                beat_num,
                slot="last_frame",
                source_path=last_frame_source,
            )
            or last_frame_source
        )
        add_image(
            key="first_frame",
            label=f"首帧 render · Beat {beat_num}",
            path=first_frame_path,
            selected=True,
            request_field="first_frame_image",
            crop_source_path=first_frame_source,
        )
        add_image(
            key="last_frame",
            label=f"尾帧 render · Beat {next_beat_num or beat_num + 1}",
            path=last_frame_path,
            selected=bool(next_beat_num),
            request_field="last_frame_image",
            crop_source_path=last_frame_source,
        )
        return assets

    add_image(
        key="first_frame",
        label=f"当前 render · Beat {beat_num}",
        path=first_frame_path,
        selected=True,
        request_field="reference_images",
        note="多参考模式下作为参考图发送，不作为严格首帧。",
    )

    resolved_characters = (
        list(characters) if characters is not None else _load_sqlite_characters(project_output)
    )
    resolved_props = _load_sqlite_props(project_output)
    resolved_prop_menu = (
        list(prop_menu)
        if prop_menu is not None
        else _load_sqlite_episode_prop_menu(project_output, episode)
    )

    identity_ids: list[str] = []
    for identity_id in resolve_beat_identity_ids(
        beat,
        project_output=project_output,
        episode=episode,
    ):
        if identity_id not in identity_ids:
            identity_ids.append(identity_id)
    for identity_id in identity_ids:
        character, identity = _split_identity_label(identity_id)
        identity_fallback = _identity_prompt_fallback(identity_id, resolved_characters)
        add_image(
            key=f"identity:{identity_id}",
            label=f"{character} · {identity}" if identity else character,
            path=_identity_asset_path(project_output, identity_id),
            selected=True,
            request_field="reference_images",
            note="有图时作为角色身份图保持一致；无图时使用身份提示词生成造型。",
            identity_id=identity_id,
            required=False,
            fallback_text=identity_fallback,
        )

    prop_ids: list[str] = []
    for prop_id in resolve_beat_prop_ids(
        beat,
        project_output=project_output,
        episode=episode,
    ):
        if prop_id not in prop_ids:
            prop_ids.append(prop_id)
    for prop_id in prop_ids:
        prop_obj = _find_prop(prop_id, resolved_props)
        base_prop_id = _text(getattr(prop_obj, "name", "")) or prop_id
        prop_path = _prop_asset_path(project_output, base_prop_id)
        menu_meta = _prop_menu_metadata(prop_id, resolved_prop_menu) or _prop_menu_metadata(
            base_prop_id,
            resolved_prop_menu,
        )
        is_global_prop = (
            prop_obj is not None or bool(menu_meta.get("is_global_asset")) or prop_path.exists()
        )
        prop_scope = "global" if is_global_prop else "episode"
        prop_fallback = _prop_prompt_fallback(prop_id, resolved_props, menu_meta)
        label_prefix = "全局道具" if prop_scope == "global" else "剧集道具"
        note = (
            "全局道具有图时作为参考保持造型、材质和细节一致；无图时使用道具提示词约束。"
            if prop_scope == "global"
            else "剧集道具使用道具提示词约束造型、材质和细节。"
        )
        add_image(
            key=f"prop:{prop_id}",
            label=f"{label_prefix} · {prop_id}",
            path=prop_path,
            selected=True,
            request_field="reference_images",
            note=note,
            prop_id=prop_id,
            prop_scope=prop_scope,
            required=False,
            fallback_text=prop_fallback,
        )

    location, scene_path = _beat_scene_asset(project_output, beat)
    add_image(
        key=f"scene:{location}",
        label=f"场景锚点 · {location}",
        path=scene_path,
        selected=True,
        request_field="reference_images",
        note="用于约束场景结构、材质和空间关系。",
    )

    audio_type = normalize_seedance2_audio_type(beat)
    if audio_type == "dialogue":
        for voice_asset in _dialogue_voice_assets(
            project_output=project_output,
            beat=beat,
            characters=resolved_characters,
        ):
            add_audio(
                key=voice_asset["key"],
                label=voice_asset["label"],
                path=voice_asset["path"],
                selected=True,
                identity_id=voice_asset["identity_id"],
                note="Seedance 2.0 多参考模式只发送角色参考声线，不预生成台词音频。",
            )
    elif audio_type == "narration":
        voice_asset = _narration_voice_asset(
            project_output=project_output,
            characters=resolved_characters,
            state_dir=state_dir,
        )
        add_audio(
            key=voice_asset["key"],
            label=voice_asset["label"],
            path=voice_asset["path"],
            selected=True,
            identity_id=voice_asset["identity_id"],
            note="Seedance 2.0 解说只发送参考声线，不预生成解说音频。",
        )

    return assets


def selected_reference_paths(assets: list[Seedance2ResolvedAsset], request_field: str) -> list[str]:
    return [
        str(asset.path)
        for asset in assets
        if asset.selected and asset.request_field == request_field and asset.path.exists()
    ]


def _user_reference_paths(config_paths: list[str], auto_paths: set[str]) -> list[str]:
    return [
        str(path)
        for path in config_paths
        if str(path or "").strip() and str(path) not in auto_paths
    ]


def append_seedance2_user_reference_assets(
    assets: list[Seedance2ResolvedAsset],
    *,
    reference_image_paths: list[str],
    reference_audio_paths: list[str],
) -> None:
    auto_image_paths = {
        str(asset.path)
        for asset in assets
        if asset.selected and asset.request_field == "reference_images"
    }
    auto_audio_paths = {
        str(asset.path)
        for asset in assets
        if asset.selected and asset.request_field == "reference_audios"
    }
    image_count = sum(
        1 for asset in assets if asset.selected and asset.request_field == "reference_images"
    )
    audio_count = sum(
        1 for asset in assets if asset.selected and asset.request_field == "reference_audios"
    )
    for path in _user_reference_paths(list(reference_image_paths), auto_image_paths):
        image_count += 1
        item_path = Path(path)
        validation_error = (
            validate_seedance2_reference_image(item_path) if item_path.exists() else ""
        )
        assets.append(
            Seedance2ResolvedAsset(
                key=f"user_image:{path}",
                label=item_path.name,
                media_type="image",
                path=item_path,
                exists=item_path.exists(),
                selected=item_path.exists() and not validation_error,
                request_field="reference_images",
                reference_label=f"图片{image_count}",
                validation_error=validation_error,
            )
        )
    for path in _user_reference_paths(list(reference_audio_paths), auto_audio_paths):
        audio_count += 1
        item_path = Path(path)
        assets.append(
            Seedance2ResolvedAsset(
                key=f"user_audio:{path}",
                label=item_path.name,
                media_type="audio",
                path=item_path,
                exists=item_path.exists(),
                selected=item_path.exists(),
                request_field="reference_audios",
                reference_label=f"音频{audio_count}",
            )
        )


def apply_prompt_audio_selection(
    assets: list[Seedance2ResolvedAsset],
    final_prompt: str,
) -> list[Seedance2ResolvedAsset]:
    """Mark audio references as sent only when the current prompt mentions their label."""

    prompt_text = str(final_prompt or "")
    result: list[Seedance2ResolvedAsset] = []
    for asset in assets:
        if asset.media_type != "audio" or not asset.reference_label.startswith("音频"):
            result.append(asset)
            continue
        should_send = (
            asset.exists
            and not asset.validation_error
            and (
                asset.reference_label in prompt_text
                or f"@{asset.reference_label}" in prompt_text
            )
        )
        result.append(
            replace(
                asset,
                selected=should_send,
                request_field="reference_audios" if should_send else "",
            )
        )
    return result
