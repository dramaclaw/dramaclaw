"""Seedance 2.0 identity voice audio task compatibility layer."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

from novelvideo.config import INDEXTTS2_RECORD_MODEL, INDEXTTS2_RECORD_PROVIDER
from novelvideo.seedance2_i2v.voice_audio_records import (
    upsert_seedance2_voice_audio_record,
)
from novelvideo.seedance2_i2v.voice_clone import (
    beat_audio_path,
    file_sha256,
    find_identity_reference_audio,
    generate_seedance2_dialogue_audio,
    resolve_character_voice,
    same_voice_dialogue_beats,
)


@dataclass
class Seedance2VoiceAudioTaskResult:
    total_targets: int = 0
    generated: int = 0
    skipped_existing: int = 0
    generated_beats: list[int] = field(default_factory=list)
    failed: list[str] = field(default_factory=list)
    voice_sha256: str = ""
    mode: str = "missing_only"

    def to_dict(self) -> dict:
        return {
            "total_targets": self.total_targets,
            "generated": self.generated,
            "skipped_existing": self.skipped_existing,
            "generated_beats": list(self.generated_beats),
            "failed": list(self.failed),
            "voice_sha256": self.voice_sha256,
            "mode": self.mode,
        }


async def resolve_identity_voice_sha256(store, speaker: str) -> str:
    speaker = str(speaker or "").strip()
    if not speaker:
        return ""
    for character in await store.list_characters():
        if not speaker.startswith(character.name):
            continue
        identity = next(
            (item for item in getattr(character, "identities", []) if item.identity_id == speaker),
            None,
        )
        resolution = resolve_character_voice(
            project_dir=store.project_dir,
            character=character,
            identity=identity,
        )
        if resolution.audio_path is not None:
            return str(resolution.sha256 or "").strip()
        if identity is not None:
            legacy = find_identity_reference_audio(
                Path(store.project_dir),
                character.name,
                identity.identity_name,
            )
            if legacy and legacy.exists():
                return file_sha256(legacy)
        return ""
    return ""


async def assert_identity_voice_hash_current(
    *,
    store,
    speaker: str,
    expected_voice_sha256: str,
) -> None:
    current_hash = await resolve_identity_voice_sha256(store, speaker)
    if not current_hash:
        raise RuntimeError("当前身份缺少声线版本，请重新保存声线")
    if current_hash != str(expected_voice_sha256 or "").strip():
        raise RuntimeError("当前身份声线版本已变化，请重新启动音频任务")


async def run_seedance2_voice_audio_generation(
    *,
    store,
    episode: int,
    speaker: str,
    mode: str,
    expected_voice_sha256: str,
    generator=None,
    audio_url_builder=None,
    progress_callback=None,
    log_callback=None,
) -> Seedance2VoiceAudioTaskResult:
    def _emit_log(message: str) -> None:
        if log_callback:
            try:
                log_callback(message)
            except Exception:
                pass

    mode = str(mode or "").strip()
    if mode not in {"missing_only", "redo_all"}:
        raise ValueError(f"Unsupported Seedance2 voice audio mode: {mode}")

    await assert_identity_voice_hash_current(
        store=store,
        speaker=speaker,
        expected_voice_sha256=expected_voice_sha256,
    )

    beats = await store.get_beats_as_dicts(int(episode))
    targets = same_voice_dialogue_beats(beats, speaker)
    _emit_log(
        f"Seedance2 身份音频: 共扫描 Beat {len(beats)} 个，"
        f"匹配身份 {speaker} 的目标 {len(targets)} 个"
    )
    result = Seedance2VoiceAudioTaskResult(
        total_targets=len(targets),
        voice_sha256=str(expected_voice_sha256 or "").strip(),
        mode=mode,
    )

    for index, (beat_num, beat) in enumerate(targets, start=1):
        await assert_identity_voice_hash_current(
            store=store,
            speaker=speaker,
            expected_voice_sha256=expected_voice_sha256,
        )
        output_path = beat_audio_path(store.project_dir, episode, beat_num)
        if mode == "missing_only" and output_path.exists() and output_path.stat().st_size > 0:
            result.skipped_existing += 1
            _emit_log(f"Beat {beat_num:02d}: 已有音频，跳过")
            if progress_callback:
                progress_callback(index, len(targets), beat_num, "skipped")
            continue

        _emit_log(f"Beat {beat_num:02d}: 调用 IndexTTS2 开始生成")
        try:
            item_result = await generate_seedance2_dialogue_audio(
                beat=beat,
                episode=episode,
                beat_num=beat_num,
                store=store,
                generator=generator,
                audio_url_builder=audio_url_builder,
            )
        except Exception as exc:
            error = f"{type(exc).__name__}: {exc}"
            result.failed.append(f"Beat {beat_num:02d}: {error}")
            _emit_log(f"Beat {beat_num:02d}: 异常 {error}")
            status = "failed"
            item_result = None
        else:
            if item_result is None:
                result.failed.append(f"Beat {beat_num:02d}: no reference audio")
                status = "failed"
                error = "no reference audio"
                _emit_log(f"Beat {beat_num:02d}: 没有解析到参考声线")
            elif not item_result.success:
                error = item_result.error or "IndexTTS2 generation failed"
                result.failed.append(f"Beat {beat_num:02d}: {error}")
                status = "failed"
                _emit_log(f"Beat {beat_num:02d}: 失败 {error}")
            else:
                result.generated += 1
                result.generated_beats.append(int(beat_num))
                status = "completed"
                error = ""
                _emit_log(f"Beat {beat_num:02d}: 生成完成 -> {output_path.name}")

        upsert_seedance2_voice_audio_record(
            db_path=store.db_path,
            episode_number=episode,
            beat_number=beat_num,
            speaker=speaker,
            audio_path=output_path,
            voice_sha256=expected_voice_sha256,
            mode=mode,
            provider=INDEXTTS2_RECORD_PROVIDER,
            model=INDEXTTS2_RECORD_MODEL,
            status=status,
            error=error,
        )
        if progress_callback:
            progress_callback(index, len(targets), beat_num, status)

    return result
