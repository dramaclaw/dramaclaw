"""Seedance 2.0 video generation input preparation."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import re
from typing import Any

from novelvideo.generators.video_generator import ShotReference
from novelvideo.seedance2_i2v.character_voice_storage import probe_voice_sample_duration_seconds
from novelvideo.seedance2_i2v.assets import (
    Seedance2ResolvedAsset,
    apply_prompt_audio_selection,
    append_seedance2_user_reference_assets,
    build_seedance2_project_assets,
    selected_reference_paths,
)
from novelvideo.seedance2_i2v.models import (
    Seedance2I2VMode,
    dump_seedance2_config,
    parse_seedance2_config,
)
from novelvideo.seedance2_i2v.spoken_dialogue import parse_seedance2_spoken_lines
from novelvideo.seedance2_i2v.voice_clone import normalize_seedance2_audio_type

SEEDANCE2_HUIMENG_BACKEND = "huimeng_seedance-2.0-fast"
SEEDANCE2_NEWAPI_BACKEND = "newapi_seedance-2.0-fast"
MAX_SEEDANCE2_REFERENCE_AUDIOS = 3
MAX_SEEDANCE2_REFERENCE_AUDIO_TOTAL_SECONDS = 15.0


@dataclass(frozen=True)
class Seedance2PreparedGeneration:
    prompt: str
    seedance2_config_json: str
    duration: int
    mode: Seedance2I2VMode
    image_path: str | None
    last_frame_path: str | None
    references: list[ShotReference]
    assets: list[Seedance2ResolvedAsset]


@dataclass(frozen=True)
class Seedance2VideoPrereqError:
    beat_number: int
    key: str
    label: str
    media_type: str
    path: str
    reason: str


def is_huimeng_seedance2_backend(backend: str | None) -> bool:
    value = str(backend or "").strip()
    if value in {SEEDANCE2_HUIMENG_BACKEND, SEEDANCE2_NEWAPI_BACKEND}:
        return True
    for prefix in ("huimeng_", "huimengi_", "newapi_"):
        if value.startswith(prefix):
            return value[len(prefix) :].strip().startswith("seedance-2.0")
    return False


def _unique_paths(paths: list[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for path in paths:
        text = str(path or "").strip()
        if text and text not in seen:
            seen.add(text)
            result.append(text)
    return result


def _references_from_paths(
    *,
    image_paths: list[str],
    audio_paths: list[str],
) -> list[ShotReference]:
    references: list[ShotReference] = []
    for index, path in enumerate(image_paths, start=1):
        references.append(ShotReference("image", path, f"图片{index}"))
    for index, path in enumerate(audio_paths, start=1):
        references.append(ShotReference("audio", path, f"音频{index}"))
    return references


def _asset_missing_reason(asset: Seedance2ResolvedAsset) -> str:
    if not getattr(asset, "required", True) and not asset.selected:
        return ""
    if not asset.exists:
        return "missing"
    if asset.validation_error:
        return asset.validation_error
    return ""


def _selected_audio_assets(assets: list[Seedance2ResolvedAsset]) -> list[Seedance2ResolvedAsset]:
    return [
        asset
        for asset in assets
        if asset.media_type == "audio"
        and asset.selected
        and asset.request_field == "reference_audios"
    ]


def _validate_reference_audio_request(audio_paths: list[str]) -> None:
    if len(audio_paths) > MAX_SEEDANCE2_REFERENCE_AUDIOS:
        raise ValueError("Seedance2 参考音频最多 3 段")

    total_duration = 0.0
    measured = False
    for path in audio_paths:
        try:
            total_duration += probe_voice_sample_duration_seconds(path)
            measured = True
        except ValueError:
            continue
    if measured and total_duration > MAX_SEEDANCE2_REFERENCE_AUDIO_TOTAL_SECONDS:
        raise ValueError(
            "Seedance2 参考音频总时长超过 15 秒，" "请回到角色工作台把参考声线裁剪到 3-5 秒"
        )


def _compact_text(value: Any) -> str:
    return re.sub(r"\s+", "", str(value or "").strip())


def _validate_dialogue_final_prompt(
    *,
    beat: dict[str, Any],
    final_prompt: str,
    assets: list[Seedance2ResolvedAsset],
) -> None:
    if normalize_seedance2_audio_type(beat) != "dialogue":
        return

    lines = parse_seedance2_spoken_lines(beat)
    if not lines:
        return

    prompt_text = _compact_text(final_prompt)
    missing_lines = [
        line.text
        for line in lines
        if _compact_text(line.text) and _compact_text(line.text) not in prompt_text
    ]
    if missing_lines:
        raise ValueError(
            "Seedance2 最终提示词缺少台词内容："
            + "、".join(str(item) for item in missing_lines[:3])
        )

    audio_labels = [
        asset.reference_label
        for asset in _selected_audio_assets(assets)
        if asset.reference_label.startswith("音频")
    ]
    if not audio_labels or any(label not in final_prompt for label in audio_labels):
        raise ValueError("Seedance2 最终提示词缺少参考声线，请在台词描述中写明对应音频编号")


def collect_seedance2_video_prereq_errors(
    *,
    project_output: str | Path,
    episode: int,
    beats: list[dict[str, Any]],
    characters: list[Any] | None = None,
    prop_menu: list[Any] | None = None,
) -> list[Seedance2VideoPrereqError]:
    """Return missing/invalid Seedance 2.0 project references before video generation."""

    project_output = Path(project_output)
    errors: list[Seedance2VideoPrereqError] = []
    for index, beat in enumerate(beats):
        config = parse_seedance2_config(beat.get("seedance2_config_json"))
        next_beat = beats[index + 1] if index + 1 < len(beats) else None
        assets = build_seedance2_project_assets(
            project_output=project_output,
            episode=episode,
            beat=beat,
            mode=config.mode,
            next_beat=next_beat,
            characters=characters,
            prop_menu=prop_menu,
        )
        final_prompt = str(config.final_prompt or "").strip()
        append_seedance2_user_reference_assets(
            assets,
            reference_image_paths=list(config.reference_image_paths),
            reference_audio_paths=list(config.reference_audio_paths),
        )
        assets = apply_prompt_audio_selection(assets, final_prompt)
        beat_number = int(beat.get("beat_number") or index + 1)
        selected_audio_assets = _selected_audio_assets(assets)
        if len(selected_audio_assets) > MAX_SEEDANCE2_REFERENCE_AUDIOS:
            errors.append(
                Seedance2VideoPrereqError(
                    beat_number=beat_number,
                    key="reference_audios",
                    label="Seedance2 参考音频最多 3 段，请减少同一 Beat 的 speaker 或合并台词",
                    media_type="audio",
                    path="",
                    reason="reference_audio_count_exceeded",
                )
            )
            continue
        for asset in assets:
            reason = _asset_missing_reason(asset)
            if not reason:
                continue
            errors.append(
                Seedance2VideoPrereqError(
                    beat_number=beat_number,
                    key=asset.key,
                    label=f"{asset.label}（{asset.note}）" if asset.note else asset.label,
                    media_type=asset.media_type,
                    path=str(asset.path),
                    reason=reason,
                )
            )
    return errors


async def prepare_seedance2_generation_inputs(
    *,
    project_output: str | Path,
    episode: int,
    beat: dict[str, Any],
    video_mode: str,
    prompt: str,
    duration: float,
    resolution: str = "720p",
    ratio: str = "9:16",
    next_beat: dict[str, Any] | None = None,
    characters: list[Any] | None = None,
    prop_menu: list[Any] | None = None,
) -> Seedance2PreparedGeneration:
    """Prepare prompt, config, and media references for one Seedance 2.0 beat."""

    project_output = Path(project_output)
    config = parse_seedance2_config(beat.get("seedance2_config_json"))

    if video_mode == "keyframe" and config.mode != Seedance2I2VMode.FIRST_LAST_FRAME:
        config.mode = Seedance2I2VMode.FIRST_LAST_FRAME

    assets = build_seedance2_project_assets(
        project_output=project_output,
        episode=episode,
        beat=beat,
        mode=config.mode,
        next_beat=next_beat,
        characters=characters,
        prop_menu=prop_menu,
    )
    append_seedance2_user_reference_assets(
        assets,
        reference_image_paths=list(config.reference_image_paths),
        reference_audio_paths=list(config.reference_audio_paths),
    )

    target_duration = int(config.duration or duration or 0)
    config.duration = target_duration
    config.resolution = resolution or config.resolution
    config.ratio = ratio or config.ratio

    final_prompt = str(config.final_prompt or "").strip()
    if not final_prompt:
        beat_number = int(beat.get("beat_number") or 0)
        prefix = f"Beat {beat_number} " if beat_number else ""
        raise ValueError(
            f"{prefix}Seedance 2.0 最终提示词为空，请先在 Seedance 2.0 Prompt 面板生成或填写最终提示词"
        )
    config.final_prompt = final_prompt
    assets = apply_prompt_audio_selection(assets, final_prompt)

    auto_images = selected_reference_paths(assets, "reference_images")
    auto_audios = selected_reference_paths(assets, "reference_audios")
    config.reference_image_paths = _unique_paths(auto_images)
    config.reference_audio_paths = _unique_paths(auto_audios)
    _validate_reference_audio_request(config.reference_audio_paths)

    _validate_dialogue_final_prompt(
        beat=beat,
        final_prompt=final_prompt,
        assets=assets,
    )

    image_path: str | None = None
    last_frame_path: str | None = None
    references: list[ShotReference] = []

    if config.mode == Seedance2I2VMode.FIRST_FRAME:
        first_frames = selected_reference_paths(assets, "image_url")
        image_path = first_frames[0] if first_frames else None
    elif config.mode == Seedance2I2VMode.FIRST_LAST_FRAME:
        first_frames = selected_reference_paths(assets, "first_frame_image")
        last_frames = selected_reference_paths(assets, "last_frame_image")
        image_path = first_frames[0] if first_frames else None
        last_frame_path = last_frames[0] if last_frames else None
    else:
        references = _references_from_paths(
            image_paths=config.reference_image_paths,
            audio_paths=config.reference_audio_paths,
        )

    return Seedance2PreparedGeneration(
        prompt=final_prompt,
        seedance2_config_json=dump_seedance2_config(config),
        duration=target_duration,
        mode=config.mode,
        image_path=image_path,
        last_frame_path=last_frame_path,
        references=references,
        assets=assets,
    )
