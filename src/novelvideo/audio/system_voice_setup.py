"""Prepare opt-in system-generated reference voices for the mainline agent."""

from __future__ import annotations

import re
from pathlib import Path

from novelvideo.generators.tts_generator import EdgeTTSGenerator
from novelvideo.project_config import (
    load_effective_narration_style_for_voice,
    load_narrator_reference_audio,
    set_narrator_reference_audio,
)
from novelvideo.seedance2_i2v.character_voice_storage import (
    DEFAULT_SLOT,
    persist_character_voice_file,
    project_relative_path,
    utc_now_iso,
    voice_content_sha256,
)
from novelvideo.seedance2_i2v.voice_clone import (
    dialogue_text,
    narration_beat_text,
    normalize_seedance2_audio_type,
    resolve_dialogue_reference_audio,
    resolve_narrator_source,
)

SYSTEM_VOICE_SAMPLE_TEXT = "你好，这是系统生成的参考声线，用于保持整部作品的声音稳定自然。"
NARRATOR_VOICE = "zh-CN-XiaoxuanNeural"
FEMALE_VOICES = (
    "zh-CN-XiaoxiaoNeural",
    "zh-CN-XiaoyiNeural",
    "zh-CN-XiaomoNeural",
)
MALE_VOICES = (
    "zh-CN-YunxiNeural",
    "zh-CN-YunjianNeural",
    "zh-CN-YunyangNeural",
)


def _system_voice_for_character(character) -> str:
    gender = str(getattr(character, "gender", "") or "").strip().lower()
    age_group = str(getattr(character, "age_group", "") or "").strip().lower()
    if "女" in gender or gender in {"female", "woman", "girl"}:
        if age_group == "child":
            return "zh-CN-XiaoshuangNeural"
        pool = FEMALE_VOICES
    else:
        pool = MALE_VOICES
    stable_index = sum(ord(char) for char in str(getattr(character, "name", "") or ""))
    return pool[stable_index % len(pool)]


def _safe_voice_filename(voice: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]+", "_", voice).strip("._") or "system_voice"


async def _system_voice_content(
    *,
    project_dir: Path,
    voice: str,
    cache: dict[str, bytes],
) -> bytes:
    cached = cache.get(voice)
    if cached:
        return cached
    cache_dir = project_dir / "assets" / "system_voices"
    output_path = cache_dir / f"{_safe_voice_filename(voice)}.mp3"
    if not output_path.exists() or output_path.stat().st_size <= 0:
        result = await EdgeTTSGenerator(voice=voice).generate(
            text=SYSTEM_VOICE_SAMPLE_TEXT,
            output_path=str(output_path),
            generate_subtitle=False,
        )
        if not result.success or not output_path.exists():
            raise RuntimeError(result.error or f"系统声线生成失败：{voice}")
    content = output_path.read_bytes()
    if not content:
        raise RuntimeError(f"系统声线生成结果为空：{voice}")
    cache[voice] = content
    return content


def _matching_character(speaker: str, characters: list):
    return next(
        (character for character in characters if speaker.startswith(character.name)),
        None,
    )


async def prepare_missing_system_voices(
    *,
    store,
    username: str,
    project: str,
    project_dir: str | Path,
    episode: int,
) -> dict:
    """Fill only missing narrator/character voice references with system presets."""

    root = Path(project_dir)
    beats = list(await store.get_beats_as_dicts(episode))
    characters = list(await store.list_characters())
    character_targets: dict[str, object] = {}
    needs_narrator = False
    unresolved_speakers: set[str] = set()

    for beat in beats:
        audio_type = normalize_seedance2_audio_type(beat)
        if audio_type == "narration" and narration_beat_text(beat):
            needs_narrator = True
        elif audio_type == "dialogue" and dialogue_text(beat):
            if await resolve_dialogue_reference_audio(beat, store) is not None:
                continue
            speaker = str(beat.get("speaker") or "").strip()
            character = _matching_character(speaker, characters)
            if character is None:
                unresolved_speakers.add(speaker or "未指定说话身份")
            else:
                character_targets[character.name] = character

    narration_style = load_effective_narration_style_for_voice(username, project)
    if needs_narrator:
        stored = load_narrator_reference_audio(username, project)
        resolution = resolve_narrator_source(
            store=store,
            narration_style=narration_style,
            project_narrator_stored_path=stored.get("path", ""),
            characters=characters,
        )
        if resolution.audio_path is None and narration_style == "first_person":
            protagonist = next((character for character in characters if character.is_main), None)
            if protagonist is not None:
                character_targets[protagonist.name] = protagonist

    prepared: list[dict[str, str]] = []
    content_cache: dict[str, bytes] = {}

    if needs_narrator and narration_style != "first_person":
        stored = load_narrator_reference_audio(username, project)
        resolution = resolve_narrator_source(
            store=store,
            narration_style=narration_style,
            project_narrator_stored_path=stored.get("path", ""),
            characters=characters,
        )
        if resolution.audio_path is None:
            content = await _system_voice_content(
                project_dir=root,
                voice=NARRATOR_VOICE,
                cache=content_cache,
            )
            target = root / "assets" / "narrator" / "voice.mp3"
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(content)
            set_narrator_reference_audio(
                username,
                project,
                relative_path=project_relative_path(root, target),
                sha256=voice_content_sha256(content),
            )
            prepared.append(
                {"target": "项目解说人", "voice": NARRATOR_VOICE, "slot": "narrator"}
            )

    for character_name, character in character_targets.items():
        voice = _system_voice_for_character(character)
        content = await _system_voice_content(
            project_dir=root,
            voice=voice,
            cache=content_cache,
        )
        rel_path, sha256, updated_at = persist_character_voice_file(
            project_dir=root,
            character_name=character_name,
            slot=DEFAULT_SLOT,
            filename="system_voice.mp3",
            content=content,
        )
        await store.update_character(
            character_name,
            reference_audio_path=rel_path,
            reference_audio_sha256=sha256,
            reference_audio_updated_at=updated_at or utc_now_iso(),
        )
        prepared.append(
            {"target": character_name, "voice": voice, "slot": DEFAULT_SLOT}
        )

    from novelvideo.audio.indextts2_beat_audio_task import (
        collect_indextts2_voice_prereq_errors,
    )

    remaining = await collect_indextts2_voice_prereq_errors(
        store=store,
        username=username,
        project=project,
        episode=episode,
        beat_numbers=None,
        mode="sync_changed",
    )
    for speaker in sorted(unresolved_speakers):
        detail = f"未找到说话身份对应角色：{speaker}"
        if detail not in remaining:
            remaining.append(detail)
    return {
        "prepared": prepared,
        "prepared_count": len(prepared),
        "remaining_errors": remaining,
        "ready": not remaining,
    }
