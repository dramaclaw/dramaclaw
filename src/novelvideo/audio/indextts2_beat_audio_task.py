"""Shared IndexTTS2 beat audio generation for video workbenches."""

from __future__ import annotations

import hashlib
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Awaitable, Callable, Literal

from novelvideo.audio_request_usage import (
    record_audio_generation_attempt,
    update_audio_generation_attempt,
)
from novelvideo.config import INDEXTTS2_RECORD_MODEL, INDEXTTS2_RECORD_PROVIDER
from novelvideo.shared.billing_errors import is_insufficient_credits_error
from novelvideo.project_config import (
    is_narrated_project,
    load_effective_narration_style_for_voice,
    load_narrator_reference_audio,
)
from novelvideo.seedance2_i2v.models import parse_seedance2_config
from novelvideo.seedance2_i2v.voice_audio_records import (
    classify_seedance2_voice_audio,
    upsert_seedance2_voice_audio_record,
)
from novelvideo.seedance2_i2v.voice_clone import (
    IDENTITY_VOICE_EXTENSIONS,
    NARRATOR_SPEAKER,
    beat_audio_path,
    dialogue_text,
    file_sha256,
    generate_seedance2_dialogue_audio,
    generate_seedance2_narration_audio,
    narration_beat_text,
    normalize_seedance2_audio_type,
    resolve_dialogue_reference_audio,
    resolve_narrator_source,
)

IndexTTS2BeatAudioMode = Literal[
    "sync_changed",
    "missing_only",
    "redo_selected",
    "redo_all",
]
ProgressCallback = Callable[[int, int, str], None | Awaitable[None]]
LogCallback = Callable[[str], None | Awaitable[None]]
AudioUrlBuilder = Callable[[Path], str]


@dataclass
class IndexTTS2BeatAudioTaskResult:
    total_targets: int = 0
    generated: int = 0
    skipped_existing: int = 0
    skipped_empty: int = 0
    skipped_manual: int = 0
    skipped_silence: int = 0
    skipped_non_dialogue: int = 0
    generated_beats: list[int] = field(default_factory=list)
    failed: list[str] = field(default_factory=list)
    mode: str = "sync_changed"

    def to_dict(self) -> dict:
        return {
            "total_targets": self.total_targets,
            "generated": self.generated,
            "skipped_existing": self.skipped_existing,
            "skipped_empty": self.skipped_empty,
            "skipped_manual": self.skipped_manual,
            "skipped_silence": self.skipped_silence,
            "skipped_non_dialogue": self.skipped_non_dialogue,
            "generated_beats": list(self.generated_beats),
            "failed": list(self.failed),
            "mode": self.mode,
        }


async def _maybe_call(callback, *args) -> None:
    if callback is None:
        return
    maybe_result = callback(*args)
    if hasattr(maybe_result, "__await__"):
        await maybe_result


def _normalize_mode(mode: str | None) -> IndexTTS2BeatAudioMode:
    if mode == "sync_changed":
        return "sync_changed"
    if mode == "missing_only":
        return "missing_only"
    if mode == "redo_selected":
        return "redo_selected"
    if mode == "redo_all":
        return "redo_all"
    return "sync_changed"


def _text_sha256(text: str) -> str:
    return hashlib.sha256(str(text or "").encode("utf-8")).hexdigest()


def _normalize_beat_numbers(beat_numbers) -> set[int] | None:
    if beat_numbers is None:
        return None
    normalized: set[int] = set()
    for value in beat_numbers:
        try:
            beat_number = int(value)
        except (TypeError, ValueError):
            continue
        if beat_number > 0:
            normalized.add(beat_number)
    return normalized


def _beat_number(beat: dict) -> int:
    try:
        return int(beat.get("beat_number") or 0)
    except (TypeError, ValueError):
        return 0


def _audio_usage_scope(episode: int, beat_num: int, speaker: str) -> str:
    return f"ep{episode:03d}:beat_{beat_num:02d}:{speaker}"


def _audio_usage_request_id(
    *,
    episode: int,
    beat_num: int,
    speaker: str,
    text_sha256: str,
    voice_sha256: str,
) -> str:
    stable = f"{episode}:{beat_num}:{speaker}:{text_sha256}:{voice_sha256}"
    return f"indextts2:{uuid.uuid5(uuid.NAMESPACE_URL, stable).hex}"


def _is_narrated_project(username: str, project: str) -> bool:
    return is_narrated_project(username, project)


def _resolve_beat_uploaded_narration_voice(beat: dict, project_dir: str | Path) -> Path | None:
    config = parse_seedance2_config(beat.get("seedance2_config_json"))
    root = Path(project_dir)
    for stored_path in config.reference_audio_paths:
        path = Path(str(stored_path or "").strip())
        if not str(path):
            continue
        if not path.is_absolute():
            path = root / path
        if path.exists() and path.suffix.lower() in IDENTITY_VOICE_EXTENSIONS:
            return path
    return None


def _target_beats_for_audio_generation(
    all_beats: list[dict],
    selected_numbers: set[int] | None,
) -> list[dict]:
    return [
        beat
        for beat in all_beats
        if _beat_number(beat) > 0
        and (selected_numbers is None or _beat_number(beat) in selected_numbers)
    ]


async def _resolve_dialogue_voice(beat: dict, store) -> tuple[Path, str] | None:
    resolved = await resolve_dialogue_reference_audio(beat, store)
    if resolved is None:
        return None
    audio_path, voice_sha256 = resolved
    return audio_path, voice_sha256 or file_sha256(audio_path)


async def _diagnose_missing_dialogue_voice(speaker: str, store) -> str:
    """Build a human-readable hint explaining why no voice was resolved."""
    if not speaker:
        return "beat 未设置 speaker，请在 beat 编辑器里指定说话身份"
    try:
        characters = await store.list_characters()
    except Exception as exc:  # pragma: no cover - defensive
        return f"读取角色失败：{exc}"
    matched = next((c for c in characters if speaker.startswith(c.name)), None)
    if matched is None:
        names = "、".join(c.name for c in characters) or "<无>"
        return f"未找到匹配角色（已存在角色：{names}）"
    identity = next(
        (i for i in matched.identities if i.identity_id == speaker),
        None,
    )
    parts: list[str] = [f"找到角色「{matched.name}」"]
    if identity is not None:
        parts.append(
            f"匹配身份「{identity.identity_name}」(age_group={identity.age_group or '<空>'})"
        )
    samples = matched.voice_samples_by_age_group or {}
    parts.append(
        f"角色默认 reference_audio_path={matched.reference_audio_path or '<空>'}; "
        f"年龄段插槽 keys={sorted(samples.keys()) or '<无>'}"
    )
    parts.append("请在角色工作区上传「默认」或对应年龄段声线")
    return "；".join(parts)


async def _resolve_narrator_voice(
    *,
    store,
    username: str,
    project: str,
) -> tuple[Path | None, str, str, str]:
    narration_style = load_effective_narration_style_for_voice(username, project)
    narrator_reference = load_narrator_reference_audio(username, project)
    characters = await store.list_characters()
    resolution = resolve_narrator_source(
        store=store,
        narration_style=narration_style,
        project_narrator_stored_path=narrator_reference.get("path", ""),
        characters=characters,
    )
    if resolution.audio_path is None:
        return None, "", narration_style, resolution.error
    return (
        resolution.audio_path,
        resolution.sha256 or file_sha256(resolution.audio_path),
        narration_style,
        "",
    )


async def _resolve_narration_voice_for_beat(
    *,
    beat: dict,
    store,
    username: str,
    project: str,
) -> tuple[Path | None, str, str, str]:
    if not _is_narrated_project(username, project):
        beat_voice = _resolve_beat_uploaded_narration_voice(beat, store.project_dir)
        if beat_voice is not None:
            narration_style = load_effective_narration_style_for_voice(username, project)
            return beat_voice, file_sha256(beat_voice), narration_style, ""
    return await _resolve_narrator_voice(store=store, username=username, project=project)


async def collect_indextts2_voice_prereq_errors(
    *,
    store,
    username: str,
    project: str,
    episode: int,
    beat_numbers,
    mode: str = "sync_changed",
) -> list[str]:
    """Return missing voice errors before starting a user-facing audio task."""

    normalized_mode = _normalize_mode(mode)
    selected_numbers = _normalize_beat_numbers(beat_numbers)
    all_beats = list(await store.get_beats_as_dicts(episode))
    target_beats = _target_beats_for_audio_generation(all_beats, selected_numbers)
    force_redo = normalized_mode in {"redo_selected", "redo_all"}
    errors: list[str] = []
    narrator_resolution: tuple[Path | None, str, str, str] | None = None

    for beat in target_beats:
        beat_num = _beat_number(beat)

        audio_type = normalize_seedance2_audio_type(beat)
        if audio_type == "silence":
            continue
        if audio_type not in {"narration", "dialogue"}:
            continue

        is_narration = audio_type == "narration"
        text = narration_beat_text(beat) if is_narration else dialogue_text(beat)
        if not text:
            continue

        output_path = beat_audio_path(store.project_dir, episode, beat_num)
        if (
            normalized_mode == "missing_only"
            and output_path.exists()
            and output_path.stat().st_size > 0
        ):
            continue
        text_sha256 = _text_sha256(text)

        if is_narration:
            beat_voice = None
            if not _is_narrated_project(username, project):
                beat_voice = _resolve_beat_uploaded_narration_voice(beat, store.project_dir)
            if beat_voice is not None:
                voice_path = beat_voice
                voice_sha256 = file_sha256(beat_voice)
                voice_error = ""
            else:
                if narrator_resolution is None:
                    narrator_resolution = await _resolve_narrator_voice(
                        store=store,
                        username=username,
                        project=project,
                    )
                voice_path, voice_sha256, _style, voice_error = narrator_resolution
            if (
                not force_redo
                and voice_path is not None
                and classify_seedance2_voice_audio(
                    db_path=store.db_path,
                    episode_number=episode,
                    beat_number=beat_num,
                    speaker=NARRATOR_SPEAKER,
                    audio_path=output_path,
                    current_voice_sha256=voice_sha256,
                    current_text_sha256=text_sha256,
                ).state
                == "current"
            ):
                continue
            narrator_error = "" if voice_path is not None else voice_error or "解说声线缺失"
            if narrator_error:
                errors.append(f"Beat {beat_num:02d} 解说声线缺失：{narrator_error}")
            continue

        resolved_voice = await _resolve_dialogue_voice(beat, store)
        if resolved_voice is None:
            speaker = str(beat.get("speaker") or "").strip() or "未指定说话身份"
            errors.append(f"Beat {beat_num:02d} 角色声线缺失：{speaker}")
            continue
        speaker = str(beat.get("speaker") or "").strip()
        _voice_path, voice_sha256 = resolved_voice
        if (
            not force_redo
            and classify_seedance2_voice_audio(
                db_path=store.db_path,
                episode_number=episode,
                beat_number=beat_num,
                speaker=speaker,
                audio_path=output_path,
                current_voice_sha256=voice_sha256,
                current_text_sha256=text_sha256,
            ).state
            == "current"
        ):
            continue

    return errors


async def run_indextts2_beat_audio_generation(
    *,
    store,
    username: str,
    project: str,
    episode: int,
    beat_numbers,
    mode: str = "sync_changed",
    generator=None,
    audio_url_builder: AudioUrlBuilder | None = None,
    progress_callback: ProgressCallback | None = None,
    log_callback: LogCallback | None = None,
) -> IndexTTS2BeatAudioTaskResult:
    """Generate selected beat MP3s with IndexTTS2 character/narrator references."""

    normalized_mode = _normalize_mode(mode)
    result = IndexTTS2BeatAudioTaskResult(mode=normalized_mode)
    selected_numbers = _normalize_beat_numbers(beat_numbers)
    all_beats = list(await store.get_beats_as_dicts(episode))
    target_beats = _target_beats_for_audio_generation(all_beats, selected_numbers)
    result.total_targets = len(target_beats)
    force_redo = normalized_mode in {"redo_selected", "redo_all"}

    await _maybe_call(log_callback, f"IndexTTS2 audio task started: {len(target_beats)} beats")

    for index, beat in enumerate(target_beats, start=1):
        beat_num = _beat_number(beat)
        output_path = beat_audio_path(store.project_dir, episode, beat_num)
        await _maybe_call(progress_callback, index - 1, len(target_beats), f"Beat {beat_num:02d}")

        audio_type = normalize_seedance2_audio_type(beat)
        if audio_type == "silence":
            result.skipped_silence += 1
            continue
        if audio_type not in {"narration", "dialogue"}:
            result.skipped_non_dialogue += 1
            continue

        is_narration = audio_type == "narration"
        text = narration_beat_text(beat) if is_narration else dialogue_text(beat)
        if not text:
            result.skipped_empty += 1
            continue

        if (
            normalized_mode == "missing_only"
            and output_path.exists()
            and output_path.stat().st_size > 0
        ):
            result.skipped_existing += 1
            continue
        text_sha256 = _text_sha256(text)

        try:
            if is_narration:
                (
                    voice_path,
                    voice_sha256,
                    narration_style,
                    voice_error,
                ) = await _resolve_narration_voice_for_beat(
                    beat=beat,
                    store=store,
                    username=username,
                    project=project,
                )
                speaker = NARRATOR_SPEAKER
                if voice_path is None:
                    raise ValueError(voice_error or "解说声线缺失")
            else:
                resolved_voice = await _resolve_dialogue_voice(beat, store)
                speaker = str(beat.get("speaker") or "").strip()
                if resolved_voice is None:
                    diag = await _diagnose_missing_dialogue_voice(speaker, store)
                    raise ValueError(f"角色声线缺失（speaker={speaker or '<空>'}）：{diag}")
                voice_path, voice_sha256 = resolved_voice

            if (
                not force_redo
                and classify_seedance2_voice_audio(
                    db_path=store.db_path,
                    episode_number=episode,
                    beat_number=beat_num,
                    speaker=speaker,
                    audio_path=output_path,
                    current_voice_sha256=voice_sha256,
                    current_text_sha256=text_sha256,
                ).state
                == "current"
            ):
                result.skipped_existing += 1
                continue

            if is_narration:
                item_result = await generate_seedance2_narration_audio(
                    beat=beat,
                    episode=episode,
                    beat_num=beat_num,
                    project_dir=store.project_dir,
                    narrator_audio_path=voice_path,
                    narration_style=narration_style,
                    generator=generator,
                    audio_url_builder=audio_url_builder,
                )
            else:
                item_result = await generate_seedance2_dialogue_audio(
                    beat=beat,
                    episode=episode,
                    beat_num=beat_num,
                    store=store,
                    generator=generator,
                    audio_url_builder=audio_url_builder,
                )

            request_id = _audio_usage_request_id(
                episode=episode,
                beat_num=beat_num,
                speaker=speaker,
                text_sha256=text_sha256,
                voice_sha256=voice_sha256,
            )
            record_audio_generation_attempt(
                project_output_dir=store.project_dir,
                request_id=request_id,
                provider=INDEXTTS2_RECORD_PROVIDER,
                model_name=INDEXTTS2_RECORD_MODEL,
                task_type="audio_generation_indextts2",
                scope=_audio_usage_scope(episode, beat_num, speaker),
                episode=episode,
                speaker=speaker,
            )
            if item_result is None:
                update_audio_generation_attempt(
                    project_output_dir=store.project_dir,
                    request_id=request_id,
                    status="failed",
                    error_message="声线缺失",
                )
                raise ValueError("声线缺失")
            if not item_result.success:
                update_audio_generation_attempt(
                    project_output_dir=store.project_dir,
                    request_id=request_id,
                    status="failed",
                    error_message=item_result.error or "IndexTTS2 generation failed",
                )
                if is_insufficient_credits_error(message=item_result.error or ""):
                    raise RuntimeError(item_result.error or "IndexTTS2 generation failed")
                raise RuntimeError(item_result.error or "IndexTTS2 generation failed")

            result.generated += 1
            result.generated_beats.append(beat_num)
            update_audio_generation_attempt(
                project_output_dir=store.project_dir,
                request_id=request_id,
                status="completed",
            )
            upsert_seedance2_voice_audio_record(
                db_path=store.db_path,
                episode_number=episode,
                beat_number=beat_num,
                speaker=speaker,
                audio_path=output_path,
                voice_sha256=voice_sha256,
                text_sha256=text_sha256,
                mode=normalized_mode,
                provider=INDEXTTS2_RECORD_PROVIDER,
                model=INDEXTTS2_RECORD_MODEL,
                status="success",
            )
        except Exception as exc:
            if is_insufficient_credits_error(exc):
                raise
            message = f"Beat {beat_num:02d}: {exc}"
            result.failed.append(message)
            await _maybe_call(log_callback, message)

    await _maybe_call(progress_callback, len(target_beats), len(target_beats), "done")
    skipped_total = (
        result.skipped_existing
        + result.skipped_empty
        + result.skipped_manual
        + result.skipped_silence
        + result.skipped_non_dialogue
    )
    await _maybe_call(
        log_callback,
        "IndexTTS2 audio task finished: "
        f"generated={result.generated}, "
        f"skipped={skipped_total} "
        f"(existing={result.skipped_existing}, empty={result.skipped_empty}, "
        f"manual={result.skipped_manual}, silence={result.skipped_silence}, "
        f"non_dialogue={result.skipped_non_dialogue}), "
        f"failed={len(result.failed)}",
    )
    return result
