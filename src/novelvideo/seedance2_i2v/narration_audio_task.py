"""Seedance 2.0 narration audio task compatibility layer."""

from __future__ import annotations

from dataclasses import dataclass, field

from novelvideo.config import INDEXTTS2_RECORD_MODEL, INDEXTTS2_RECORD_PROVIDER
from novelvideo.project_config import (
    load_effective_narration_style_for_voice,
    load_narrator_reference_audio,
)
from novelvideo.seedance2_i2v.voice_audio_records import (
    upsert_seedance2_voice_audio_record,
)
from novelvideo.seedance2_i2v.voice_clone import (
    DEFAULT_NARRATION_STYLE,
    NARRATOR_SPEAKER,
    NarratorResolution,
    beat_audio_path,
    generate_seedance2_narration_audio,
    narration_beats,
    resolve_narrator_source,
)


@dataclass
class Seedance2NarrationAudioTaskResult:
    total_targets: int = 0
    generated: int = 0
    skipped_existing: int = 0
    generated_beats: list[int] = field(default_factory=list)
    failed: list[str] = field(default_factory=list)
    voice_sha256: str = ""
    mode: str = "missing_only"
    narration_style: str = DEFAULT_NARRATION_STYLE

    def to_dict(self) -> dict:
        return {
            "total_targets": self.total_targets,
            "generated": self.generated,
            "skipped_existing": self.skipped_existing,
            "generated_beats": list(self.generated_beats),
            "failed": list(self.failed),
            "voice_sha256": self.voice_sha256,
            "mode": self.mode,
            "narration_style": self.narration_style,
        }


async def _resolve_for_run(store, username: str, project: str) -> NarratorResolution:
    style = load_effective_narration_style_for_voice(username, project)
    descriptor = load_narrator_reference_audio(username, project)
    characters = await store.list_characters() if style == "first_person" else None
    return resolve_narrator_source(
        store=store,
        narration_style=style,
        project_narrator_stored_path=descriptor.get("path", ""),
        characters=characters,
    )


def _assert_resolution_matches(
    resolution: NarratorResolution,
    *,
    expected_voice_sha256: str,
) -> None:
    if resolution.audio_path is None:
        raise RuntimeError(resolution.error or "解说人声线不可用")
    current = (resolution.sha256 or "").strip()
    expected = str(expected_voice_sha256 or "").strip()
    if not current:
        raise RuntimeError("解说人声线文件无法读取，请检查文件是否完整")
    if expected and current != expected:
        raise RuntimeError("解说人声线版本已变化，请重新启动音频任务")


async def run_seedance2_narration_audio_generation(
    *,
    store,
    username: str,
    project: str,
    episode: int,
    mode: str,
    expected_voice_sha256: str,
    generator=None,
    audio_url_builder=None,
    progress_callback=None,
    log_callback=None,
) -> Seedance2NarrationAudioTaskResult:
    def _emit_log(message: str) -> None:
        if log_callback:
            try:
                log_callback(message)
            except Exception:
                pass

    mode = str(mode or "").strip()
    if mode not in {"missing_only", "redo_all"}:
        raise ValueError(f"Unsupported Seedance2 narration audio mode: {mode}")

    resolution = await _resolve_for_run(store, username, project)
    _assert_resolution_matches(resolution, expected_voice_sha256=expected_voice_sha256)

    narrator_path = resolution.audio_path
    style = resolution.style
    beats = await store.get_beats_as_dicts(int(episode))
    targets = narration_beats(beats)
    source_hint = (
        f"解说主角声线（{resolution.character_name}）"
        if resolution.source == "protagonist_identity"
        else "项目解说人声线"
    )
    _emit_log(
        f"Seedance2 解说音频: 共扫描 Beat {len(beats)} 个，匹配解说 Beat {len(targets)} 个，"
        f"解说风格 {style}，声线来源 {source_hint}"
    )
    result = Seedance2NarrationAudioTaskResult(
        total_targets=len(targets),
        voice_sha256=resolution.sha256,
        mode=mode,
        narration_style=style,
    )

    for index, (beat_num, beat) in enumerate(targets, start=1):
        live = await _resolve_for_run(store, username, project)
        _assert_resolution_matches(live, expected_voice_sha256=expected_voice_sha256)
        output_path = beat_audio_path(store.project_dir, episode, beat_num)
        if mode == "missing_only" and output_path.exists() and output_path.stat().st_size > 0:
            result.skipped_existing += 1
            _emit_log(f"Beat {beat_num:02d}: 已有音频，跳过")
            if progress_callback:
                progress_callback(index, len(targets), beat_num, "skipped")
            continue

        _emit_log(f"Beat {beat_num:02d}: 调用 IndexTTS2 开始生成（解说）")
        try:
            item_result = await generate_seedance2_narration_audio(
                beat=beat,
                episode=episode,
                beat_num=beat_num,
                project_dir=store.project_dir,
                narrator_audio_path=narrator_path,
                narration_style=style,
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
                result.failed.append(f"Beat {beat_num:02d}: not a narration beat")
                status = "failed"
                error = "not a narration beat"
                _emit_log(f"Beat {beat_num:02d}: 非解说 Beat，跳过")
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
            speaker=NARRATOR_SPEAKER,
            audio_path=output_path,
            voice_sha256=resolution.sha256,
            mode=mode,
            provider=INDEXTTS2_RECORD_PROVIDER,
            model=INDEXTTS2_RECORD_MODEL,
            status=status,
            error=error,
        )
        if progress_callback:
            progress_callback(index, len(targets), beat_num, status)

    return result
