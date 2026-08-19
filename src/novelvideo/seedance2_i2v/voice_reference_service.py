"""Seedance 2.0 voice-reference status helpers shared by REST API and UI."""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from novelvideo.models import real_detected_identities
from novelvideo.project_config import (
    load_effective_narration_style_for_voice,
    load_effective_narration_style_for_voice_from_state_dir,
    load_narrator_reference_audio,
    load_narrator_reference_audio_from_state_dir,
)
from novelvideo.seedance2_i2v.spoken_dialogue import (
    speaker_display_name,
    unique_seedance2_dialogue_speakers,
)
from novelvideo.seedance2_i2v.voice_clone import (
    DEFAULT_NARRATION_STYLE,
    NarratorResolution,
    file_sha256,
    find_identity_reference_audio,
    resolve_character_voice,
    resolve_narrator_source,
)


@dataclass
class NarratorReferenceStatus:
    narration_style: str
    source: str = ""
    reference_path: Path | None = None
    reference_sha256: str = ""
    character_name: str = ""
    identity_id: str = ""
    identity_name: str = ""
    error: str = ""

    @property
    def active_reference_path(self) -> Path | None:
        return self.reference_path

    @property
    def is_first_person(self) -> bool:
        return self.narration_style == "first_person"

    @property
    def detail(self) -> str:
        if self.error:
            return self.error
        if self.is_first_person:
            return _narrator_identity_detail(self)
        if self.reference_path:
            return str(self.reference_path)
        return ""


@dataclass
class VoiceReferenceStatus:
    speaker: str
    character_name: str = ""
    identity_id: str = ""
    identity_name: str = ""
    identity_reference_path: Path | None = None
    identity_reference_sha256: str = ""
    active_scope: str = ""

    @property
    def active_reference_path(self) -> Path | None:
        if self.active_scope in {"identity", "age_group", "character_default", "legacy_identity"}:
            return self.identity_reference_path
        return None


@dataclass
class DialogueVoiceReferenceRow:
    speaker: str
    display_name: str
    status: VoiceReferenceStatus


def resolve_narrator_reference_status(
    *,
    store,
    username: str,
    project: str,
) -> NarratorReferenceStatus:
    state_dir = str(getattr(store, "state_dir", "") or "")
    if state_dir:
        style = (
            load_effective_narration_style_for_voice_from_state_dir(state_dir)
            or DEFAULT_NARRATION_STYLE
        )
        stored = load_narrator_reference_audio_from_state_dir(state_dir)
    else:
        style = (
            load_effective_narration_style_for_voice(username, project)
            or DEFAULT_NARRATION_STYLE
        )
        stored = load_narrator_reference_audio(username, project)
    resolution = resolve_narrator_source(
        store=store,
        narration_style=style,
        project_narrator_stored_path=stored.get("path", ""),
    )
    status = _status_from_resolution(style, resolution)
    if status.source == "project_narrator" and status.reference_path is not None:
        status.reference_sha256 = status.reference_sha256 or stored.get("sha256", "")
    return status


def resolve_voice_reference_status(
    *,
    speaker: str,
    characters: list[Any],
    project_dir: str | Path,
) -> VoiceReferenceStatus:
    project_path = Path(project_dir)
    status = VoiceReferenceStatus(speaker=str(speaker or "").strip())
    if not status.speaker:
        return status

    for character in characters:
        char_name = str(getattr(character, "name", "") or "")
        if not status.speaker.startswith(char_name):
            continue
        status.character_name = char_name
        identity = next(
            (
                item
                for item in getattr(character, "identities", [])
                if item.identity_id == status.speaker
            ),
            None,
        )
        if identity:
            status.identity_id = identity.identity_id
            status.identity_name = identity.identity_name

        resolution = resolve_character_voice(
            project_dir=project_path,
            character=character,
            identity=identity,
        )
        if resolution.audio_path is not None:
            status.identity_reference_path = resolution.audio_path
            status.identity_reference_sha256 = resolution.sha256
            status.active_scope = {
                "identity_override": "identity",
                "age_group_preset": "age_group",
                "character_default": "character_default",
            }.get(str(resolution.tier or ""), "character_default")
        elif identity is not None:
            legacy = find_identity_reference_audio(
                project_path,
                char_name,
                identity.identity_name,
            )
            if legacy and legacy.exists():
                status.identity_reference_path = legacy
                status.identity_reference_sha256 = file_sha256(legacy)
                status.active_scope = "legacy_identity"
        break
    return status


def dialogue_voice_reference_rows(
    beat: dict,
    *,
    characters: list[Any],
    project_dir: str | Path,
) -> list[DialogueVoiceReferenceRow]:
    speakers = unique_seedance2_dialogue_speakers(beat)
    if not speakers:
        _options, selected_speaker = current_beat_speaker_options(beat)
        speakers = [selected_speaker] if selected_speaker else []

    rows: list[DialogueVoiceReferenceRow] = []
    seen: set[str] = set()
    for speaker in speakers:
        resolution_speaker = _speaker_resolution_key(beat, speaker)
        if not resolution_speaker or resolution_speaker in seen:
            continue
        seen.add(resolution_speaker)
        status = resolve_voice_reference_status(
            speaker=resolution_speaker,
            characters=characters,
            project_dir=project_dir,
        )
        rows.append(
            DialogueVoiceReferenceRow(
                speaker=resolution_speaker,
                display_name=speaker_display_name(str(speaker or resolution_speaker)),
                status=status,
            )
        )
    return rows


def current_beat_speaker_options(beat: dict) -> tuple[dict[str, str], str]:
    current_speaker = str((beat or {}).get("speaker") or "").strip()
    detected_identities = _beat_detected_identity_ids(beat)
    candidates = detected_identities or ([current_speaker] if current_speaker else [])
    options = {identity_id: _identity_display_label(identity_id) for identity_id in candidates}
    if not options:
        return {"": "未指定"}, ""
    value = current_speaker if current_speaker in options else next(iter(options))
    return options, value


def _status_from_resolution(style: str, resolution: NarratorResolution) -> NarratorReferenceStatus:
    return NarratorReferenceStatus(
        narration_style=style,
        source=resolution.source or "",
        reference_path=resolution.audio_path,
        reference_sha256=resolution.sha256,
        character_name=resolution.character_name,
        identity_id=resolution.identity_id,
        identity_name=resolution.identity_name,
        error=resolution.error,
    )


def _narrator_identity_detail(status: NarratorReferenceStatus) -> str:
    if not status.character_name:
        return "未配置解说主角"
    if status.identity_name:
        return f"{status.character_name}（{status.identity_name}）"
    if status.identity_id:
        return f"{status.character_name}（{_identity_display_label(status.identity_id)}）"
    return status.character_name


def _identity_display_label(identity_id: str) -> str:
    value = str(identity_id or "").strip()
    if not value:
        return "未指定"
    character, separator, identity = value.partition("_")
    if separator and character and identity:
        return f"{character}（{identity}）"
    return value


def _beat_detected_identity_ids(beat: dict) -> list[str]:
    raw_identities = (beat or {}).get("detected_identities")
    if raw_identities is None:
        raw_json = (beat or {}).get("detected_identities_json")
        if isinstance(raw_json, str) and raw_json.strip():
            try:
                raw_identities = json.loads(raw_json)
            except json.JSONDecodeError:
                raw_identities = []
    if isinstance(raw_identities, str):
        raw_identities = [raw_identities]
    if not isinstance(raw_identities, list):
        return []

    identities: list[str] = []
    seen: set[str] = set()
    for identity in raw_identities:
        identity_id = str(identity or "").strip()
        if not identity_id or identity_id in seen:
            continue
        seen.add(identity_id)
        identities.append(identity_id)
    return real_detected_identities(identities)


def _speaker_resolution_key(beat: dict, speaker: str) -> str:
    beat_speaker = str((beat or {}).get("speaker") or "").strip()
    if beat_speaker and speaker_display_name(beat_speaker) == speaker_display_name(speaker):
        return beat_speaker
    return str(speaker or "").strip()


__all__ = [
    "DialogueVoiceReferenceRow",
    "NarratorReferenceStatus",
    "VoiceReferenceStatus",
    "current_beat_speaker_options",
    "dialogue_voice_reference_rows",
    "resolve_narrator_reference_status",
    "resolve_voice_reference_status",
]
