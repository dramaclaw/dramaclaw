"""Seedance 2.0 dialogue audio preparation via IndexTTS2.

This module is intentionally separate from the global TTS pipeline. It only
supports the Seedance 2.0 workbench flow: create/refresh the current beat MP3
so the existing Seedance 2.0 ``reference_audios`` asset path can pick it up.
"""

from __future__ import annotations

import hashlib
import inspect
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Literal

from novelvideo.generators.tts_generator import TTSResult

AudioUrlBuilder = Callable[[Path], str]
IDENTITY_VOICE_EXTENSIONS = (".mp3", ".wav", ".m4a", ".aac", ".ogg", ".webm")
NARRATOR_SPEAKER = "__narrator__"

DEFAULT_NARRATION_STYLE = "third_person"
NARRATION_STYLES: dict[str, dict[str, str]] = {
    "first_person": {
        "label": "第一人称（解说主角视角）",
        "prompt": "以第一人称视角，用解说主角内心独白般的语气娓娓道来",
    },
    "third_person": {
        "label": "第三人称（旁观者视角）",
        "prompt": "以第三人称旁白视角，用客观冷静的解说语气朗读",
    },
}


def narration_style_label(style: str) -> str:
    entry = (
        NARRATION_STYLES.get(str(style or "").strip()) or NARRATION_STYLES[DEFAULT_NARRATION_STYLE]
    )
    return entry["label"]


def narration_style_prompt(style: str) -> str:
    entry = (
        NARRATION_STYLES.get(str(style or "").strip()) or NARRATION_STYLES[DEFAULT_NARRATION_STYLE]
    )
    return entry["prompt"]


QUOTE_DIALOGUE_PATTERNS = (
    re.compile(r"“([^”]+)”"),
    re.compile(r"「([^」]+)」"),
    re.compile(r'"([^"]+)"'),
)


@dataclass
class Seedance2VoiceBatchResult:
    speaker: str
    total: int = 0
    generated: int = 0
    skipped_existing: int = 0
    failed: list[str] = field(default_factory=list)

    @property
    def success(self) -> bool:
        return not self.failed


def beat_audio_path(project_dir: str | Path, episode: int, beat_num: int) -> Path:
    return Path(project_dir) / "audio" / f"ep{int(episode):03d}" / f"beat_{int(beat_num):02d}.mp3"


def _absolute_project_path(project_dir: str | Path, stored_path: str) -> Path:
    path = Path(str(stored_path or ""))
    if path.is_absolute():
        return path
    return Path(project_dir) / path


def _safe_asset_name(value: str) -> str:
    return re.sub(r'[/\\:*?"<>|]', "_", str(value or "").strip())


def find_identity_reference_audio(
    project_dir: str | Path,
    character_name: str,
    identity_name: str,
) -> Path | None:
    """Find the current flat identity voice file by convention."""
    identity_stem = _safe_asset_name(identity_name)
    character = _safe_asset_name(character_name)
    if not identity_stem or not character:
        return None
    identity_dir = Path(project_dir) / "assets" / "characters" / character / "identities"
    for ext in IDENTITY_VOICE_EXTENSIONS:
        candidate = identity_dir / f"{identity_stem}_voice{ext}"
        if candidate.exists():
            return candidate
    return None


def dialogue_text(beat: dict) -> str:
    raw_text = str(
        beat.get("narration_segment") or beat.get("dialogue") or beat.get("narration") or ""
    ).strip()
    quoted_parts: list[str] = []
    for pattern in QUOTE_DIALOGUE_PATTERNS:
        for match in pattern.finditer(raw_text):
            quoted = match.group(1).strip()
            if quoted:
                quoted_parts.append(quoted)
    if quoted_parts:
        return " ".join(quoted_parts)
    return raw_text


def dialogue_emotion_prompt(beat: dict) -> str:
    raw_text = str(
        beat.get("narration_segment") or beat.get("dialogue") or beat.get("narration") or ""
    ).strip()
    if not raw_text:
        return ""

    if not any(pattern.search(raw_text) for pattern in QUOTE_DIALOGUE_PATTERNS):
        return ""

    emotion_text = raw_text
    for pattern in QUOTE_DIALOGUE_PATTERNS:
        emotion_text = pattern.sub(" ", emotion_text)
    emotion_text = re.sub(r"\s+", " ", emotion_text).strip(" ：:，,。.;；、 \t\r\n")
    return emotion_text


def dialogue_voice_key(beat: dict) -> str:
    if normalize_seedance2_audio_type(beat) != "dialogue":
        return ""
    if not dialogue_text(beat):
        return ""
    return str(beat.get("speaker") or "").strip()


def same_voice_dialogue_beats(beats: list[dict], speaker: str) -> list[tuple[int, dict]]:
    voice_key = str(speaker or "").strip()
    if not voice_key:
        return []
    grouped: list[tuple[int, dict]] = []
    for beat in beats:
        if dialogue_voice_key(beat) != voice_key:
            continue
        beat_num = int(beat.get("beat_number") or 0)
        if beat_num <= 0:
            continue
        grouped.append((beat_num, beat))
    return grouped


def narration_beat_text(beat: dict) -> str:
    return str(
        beat.get("narration_segment") or beat.get("narration") or beat.get("dialogue") or ""
    ).strip()


def normalize_seedance2_audio_type(beat: dict) -> str:
    """Return the Seedance2 audio route from beat metadata."""

    audio_type = str(beat.get("audio_type") or "").strip()
    if audio_type == "action":
        return "silence"
    if audio_type:
        return audio_type
    if str(beat.get("speaker") or "").strip():
        return "dialogue"
    return "narration"


def narration_beats(beats: list[dict]) -> list[tuple[int, dict]]:
    """Return beats whose ``audio_type`` is ``narration`` and have narration text."""
    grouped: list[tuple[int, dict]] = []
    for beat in beats:
        if normalize_seedance2_audio_type(beat) != "narration":
            continue
        if not narration_beat_text(beat):
            continue
        beat_num = int(beat.get("beat_number") or 0)
        if beat_num <= 0:
            continue
        grouped.append((beat_num, beat))
    return grouped


def narrator_reference_audio_path(project_dir: str | Path, stored_path: str) -> Path | None:
    """Resolve the project-level narrator reference audio path."""
    stored = str(stored_path or "").strip()
    if not stored:
        return None
    path = Path(stored)
    if not path.is_absolute():
        path = Path(project_dir) / path
    return path if path.exists() else None


def file_sha256(path: Path) -> str:
    """Stream-hash a file. Returns empty string if path is missing."""
    if not path.exists():
        return ""
    hasher = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 16), b""):
            hasher.update(chunk)
    return hasher.hexdigest()


NarratorSource = Literal["project_narrator", "protagonist_identity"]


@dataclass
class NarratorResolution:
    style: str
    source: NarratorSource | None
    audio_path: Path | None
    sha256: str
    character_name: str = ""
    identity_id: str = ""
    identity_name: str = ""
    error: str = ""


def _narrator_main_identity_audio(
    project_dir: Path, character
) -> tuple[Path | None, str, str, str]:
    """Return (audio_path, sha256, identity_id, identity_name) for the narrator main.

    Uses the 3-tier ``resolve_character_voice`` cascade
    (identity override → age-group preset → character default) so an upload to
    the character-level default slot is picked up even when the identity itself
    has no ``reference_audio_path``.
    """
    identities = list(getattr(character, "identities", None) or [])
    identity = identities[0] if identities else None
    identity_id = identity.identity_id if identity else ""
    identity_name = identity.identity_name if identity else ""

    resolution = resolve_character_voice(
        project_dir=project_dir,
        character=character,
        identity=identity,
    )
    if resolution.audio_path is not None:
        return resolution.audio_path, resolution.sha256, identity_id, identity_name

    if identity is not None:
        fallback = find_identity_reference_audio(
            project_dir, character.name, identity.identity_name
        )
        if fallback and fallback.exists():
            return fallback, file_sha256(fallback), identity_id, identity_name

    return None, "", identity_id, identity_name


def resolve_narrator_source(
    *,
    store,
    narration_style: str,
    project_narrator_stored_path: str,
    characters=None,
) -> NarratorResolution:
    """Resolve which audio file plays the role of the narrator for this project.

    - ``first_person`` → narrator main (``is_main=True``) first identity's reference audio.
    - ``third_person`` → the project-level narrator audio recorded in project_config.

    Pass ``characters`` from ``await store.list_characters()`` in async contexts;
    otherwise the in-memory ``store.get_all_characters()`` is used.
    """
    style = str(narration_style or "").strip()
    if style not in NARRATION_STYLES:
        style = DEFAULT_NARRATION_STYLE

    project_dir = Path(store.project_dir)

    if style == "first_person":
        chars = list(characters) if characters is not None else store.get_all_characters()
        narrator_main = next((c for c in chars if getattr(c, "is_main", False)), None)
        if narrator_main is None:
            return NarratorResolution(
                style=style,
                source="protagonist_identity",
                audio_path=None,
                sha256="",
                error="未找到解说主角（is_main=True），请先在角色工作台标记解说主角",
            )
        audio_path, sha256, identity_id, identity_name = _narrator_main_identity_audio(
            project_dir, narrator_main
        )
        if audio_path is None:
            return NarratorResolution(
                style=style,
                source="protagonist_identity",
                audio_path=None,
                sha256="",
                character_name=narrator_main.name,
                identity_id=identity_id,
                identity_name=identity_name,
                error="解说主角声线缺失，请在角色工作台为解说主角配置参考音频（默认声线即可）",
            )
        return NarratorResolution(
            style=style,
            source="protagonist_identity",
            audio_path=audio_path,
            sha256=sha256 or file_sha256(audio_path),
            character_name=narrator_main.name,
            identity_id=identity_id,
            identity_name=identity_name,
        )

    stored_narrator_path = str(project_narrator_stored_path or "").strip()
    if not stored_narrator_path:
        return NarratorResolution(
            style=style,
            source="project_narrator",
            audio_path=None,
            sha256="",
            error="项目解说人声线未配置，请上传或录制解说人音频",
        )

    audio_path = narrator_reference_audio_path(project_dir, stored_narrator_path)
    if audio_path is None:
        return NarratorResolution(
            style=style,
            source="project_narrator",
            audio_path=None,
            sha256="",
            error="项目解说人声线已配置，但声线文件无法读取，请重新上传或检查项目存储",
        )
    return NarratorResolution(
        style=style,
        source="project_narrator",
        audio_path=audio_path,
        sha256=file_sha256(audio_path),
    )


async def generate_seedance2_narration_audio(
    *,
    beat: dict,
    episode: int,
    beat_num: int,
    project_dir: str | Path,
    narrator_audio_path: Path,
    narration_style: str = DEFAULT_NARRATION_STYLE,
    generator=None,
    audio_url_builder: AudioUrlBuilder | None = None,
    emotion_prompt: str = "",
) -> TTSResult | None:
    """Generate narration audio for a single beat using the narrator reference."""
    if normalize_seedance2_audio_type(beat) != "narration":
        return None

    text = narration_beat_text(beat)
    if not text:
        return TTSResult(success=False, error="Beat narration text is empty")

    if not narrator_audio_path.exists():
        return TTSResult(
            success=False, error=f"Narrator reference audio not found: {narrator_audio_path}"
        )

    if generator is None:
        from novelvideo.generators.indextts2_fal import IndexTTS2FalClient

        generator = IndexTTS2FalClient()

    builder = audio_url_builder or build_reference_audio_url
    output_path = beat_audio_path(project_dir, episode, beat_num)
    resolved_emotion = str(emotion_prompt or "").strip() or narration_style_prompt(narration_style)
    maybe_result = generator.generate(
        prompt=text,
        audio_url=builder(narrator_audio_path),
        output_path=output_path,
        emotion_prompt=resolved_emotion,
    )
    if inspect.isawaitable(maybe_result):
        return await maybe_result
    return maybe_result


MAX_REFERENCE_AUDIO_BYTES = 5_000_000


def build_reference_audio_url(audio_path: Path) -> str:
    """Return an IndexTTS2-readable data URL for a local reference audio file.

    Reference audio still follows the v2.0 flow and travels as an inline
    ``data:`` URL. We cap raw audio at 5 MB and ask the user to re-encode
    anything larger to mono/16k MP3.
    """
    from novelvideo.generators.huimengi import local_file_to_data_url

    size = Path(audio_path).stat().st_size
    if size > MAX_REFERENCE_AUDIO_BYTES:
        raise ValueError(
            f"Reference audio {Path(audio_path).name} is {size} bytes "
            f"(> {MAX_REFERENCE_AUDIO_BYTES}). Re-encode to mono/16k MP3 before use."
        )
    return local_file_to_data_url(str(audio_path))


VoiceTier = Literal["identity_override", "age_group_preset", "character_default"]


@dataclass
class CharacterVoiceResolution:
    audio_path: Path | None
    sha256: str
    tier: VoiceTier | None
    age_group_key: str = ""


def resolve_character_voice(
    *,
    project_dir: str | Path,
    character,
    identity=None,
) -> CharacterVoiceResolution:
    """3-tier voice fallback shared by dialogue and narration paths.

    L1 identity.reference_audio_path → L2 character.voice_samples_by_age_group[identity.age_group]
    → L3 character.reference_audio_path. Returns the first hit whose file exists.
    """
    project_dir = Path(project_dir)

    if identity is not None:
        stored = str(getattr(identity, "reference_audio_path", "") or "").strip()
        if stored:
            candidate = _absolute_project_path(project_dir, stored)
            if candidate.exists():
                sha = str(
                    getattr(identity, "reference_audio_sha256", "") or ""
                ).strip() or file_sha256(candidate)
                return CharacterVoiceResolution(
                    audio_path=candidate,
                    sha256=sha,
                    tier="identity_override",
                )

    age_group = ""
    if identity is not None:
        age_group = str(getattr(identity, "age_group", "") or "").strip()

    samples = getattr(character, "voice_samples_by_age_group", None) or {}
    if age_group and isinstance(samples, dict):
        entry = samples.get(age_group)
        if isinstance(entry, dict):
            stored = str(entry.get("path", "") or "").strip()
            if stored:
                candidate = _absolute_project_path(project_dir, stored)
                if candidate.exists():
                    sha = str(entry.get("sha256", "") or "").strip() or file_sha256(candidate)
                    return CharacterVoiceResolution(
                        audio_path=candidate,
                        sha256=sha,
                        tier="age_group_preset",
                        age_group_key=age_group,
                    )

    default_stored = str(getattr(character, "reference_audio_path", "") or "").strip()
    if default_stored:
        candidate = _absolute_project_path(project_dir, default_stored)
        if candidate.exists():
            sha = str(
                getattr(character, "reference_audio_sha256", "") or ""
            ).strip() or file_sha256(candidate)
            return CharacterVoiceResolution(
                audio_path=candidate,
                sha256=sha,
                tier="character_default",
            )

    return CharacterVoiceResolution(audio_path=None, sha256="", tier=None)


async def resolve_dialogue_reference_audio(beat: dict, store) -> tuple[Path, str] | None:
    """Resolve the speaker's voice path and hash via the 3-tier fallback."""
    speaker = str(beat.get("speaker") or "").strip()
    if not speaker:
        return None

    project_dir = Path(store.project_dir)
    for character in await store.list_characters():
        if not speaker.startswith(character.name):
            continue

        identity = next(
            (item for item in character.identities if item.identity_id == speaker),
            None,
        )
        resolution = resolve_character_voice(
            project_dir=project_dir,
            character=character,
            identity=identity,
        )
        if resolution.audio_path is not None:
            sha256 = resolution.sha256 or file_sha256(resolution.audio_path)
            return (resolution.audio_path, sha256)

        if identity is not None:
            legacy = find_identity_reference_audio(
                project_dir,
                character.name,
                identity.identity_name,
            )
            if legacy:
                return (legacy, file_sha256(legacy))
        return None
    return None


async def generate_seedance2_dialogue_audio(
    *,
    beat: dict,
    episode: int,
    beat_num: int,
    store,
    generator=None,
    audio_url_builder: AudioUrlBuilder | None = None,
    emotion_prompt: str = "",
) -> TTSResult | None:
    """Generate the current Seedance 2.0 dialogue beat audio with IndexTTS2.

    Returns ``None`` when the beat is not a dialogue candidate or has no
    configured reference sample, so callers can present UI-only guidance without
    changing the normal project TTS pipeline.
    """
    if normalize_seedance2_audio_type(beat) != "dialogue":
        return None

    narration = dialogue_text(beat)
    if not narration:
        return TTSResult(success=False, error="Beat dialogue text is empty")

    resolved = await resolve_dialogue_reference_audio(beat, store)
    if resolved is None:
        return None
    reference_path, _scope = resolved
    if not reference_path.exists():
        return TTSResult(success=False, error=f"Reference audio not found: {reference_path}")

    if generator is None:
        from novelvideo.generators.indextts2_fal import IndexTTS2FalClient

        generator = IndexTTS2FalClient()

    builder = audio_url_builder or build_reference_audio_url
    output_path = beat_audio_path(store.project_dir, episode, beat_num)
    resolved_emotion_prompt = str(emotion_prompt or "").strip() or dialogue_emotion_prompt(beat)
    maybe_result = generator.generate(
        prompt=narration,
        audio_url=builder(reference_path),
        output_path=output_path,
        emotion_prompt=resolved_emotion_prompt,
    )
    if inspect.isawaitable(maybe_result):
        return await maybe_result
    return maybe_result


async def generate_seedance2_dialogue_audio_for_voice(
    *,
    beats: list[dict],
    speaker: str,
    episode: int,
    store,
    missing_only: bool = True,
    generator=None,
    audio_url_builder: AudioUrlBuilder | None = None,
    emotion_prompt: str = "",
) -> Seedance2VoiceBatchResult:
    """Generate dialogue audio for beats sharing the same identity/period voice."""
    result = Seedance2VoiceBatchResult(speaker=str(speaker or "").strip())
    targets = same_voice_dialogue_beats(beats, result.speaker)
    result.total = len(targets)
    if not targets:
        return result

    if generator is None:
        from novelvideo.generators.indextts2_fal import IndexTTS2FalClient

        generator = IndexTTS2FalClient()

    for beat_num, beat in targets:
        output_path = beat_audio_path(store.project_dir, episode, beat_num)
        if missing_only and output_path.exists() and output_path.stat().st_size > 0:
            result.skipped_existing += 1
            continue
        item_result = await generate_seedance2_dialogue_audio(
            beat=beat,
            episode=episode,
            beat_num=beat_num,
            store=store,
            generator=generator,
            audio_url_builder=audio_url_builder,
            emotion_prompt=emotion_prompt,
        )
        if item_result is None:
            result.failed.append(f"Beat {beat_num:02d}: no reference audio")
            continue
        if not item_result.success:
            result.failed.append(f"Beat {beat_num:02d}: {item_result.error}")
            continue
        result.generated += 1
    return result
