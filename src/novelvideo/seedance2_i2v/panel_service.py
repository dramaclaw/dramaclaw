"""Seedance 2.0 panel-domain helpers shared by REST API and legacy UI."""

from __future__ import annotations

import math
import re
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

from novelvideo.manual_shots import resolve_target_video_duration
from novelvideo.project_config import load_project_config_file, set_narrator_reference_audio
from novelvideo.seedance2_i2v.assets import (
    Seedance2ResolvedAsset,
    apply_prompt_audio_selection,
    build_seedance2_project_assets,
    selected_reference_paths,
    validate_seedance2_reference_image,
)
from novelvideo.seedance2_i2v.character_voice_storage import (
    VOICE_SAMPLE_EXTENSIONS,
    trim_voice_sample_content,
    voice_content_sha256,
)
from novelvideo.seedance2_i2v.models import (
    Seedance2I2VMode,
    dump_seedance2_config,
    parse_seedance2_config,
)
from novelvideo.seedance2_i2v.prompt import (
    build_seedance2_prompt_draft,
    compute_seedance2_prompt_inputs_hash,
    generate_seedance2_prompt,
)
from novelvideo.seedance2_i2v.voice_clone import normalize_seedance2_audio_type
from novelvideo.utils.media_io import crop_image_to_path, get_audio_duration
from novelvideo.utils.path_resolver import PathResolver


SEEDANCE2_PROMPT_GUIDANCE_TEMPLATES: dict[str, str] = {
    "主体": "主体：明确画面核心人物或物体、当前动作和状态，避免多个主体争抢焦点。",
    "场景": "场景：补充空间背景、地点关系、关键道具和环境材质，保持与参考图一致。",
    "光影": "光影：描述主光源、明暗层次、色温和氛围，避免忽明忽暗。",
    "镜头": "镜头：说明景别、视角、运镜速度和运动方向，保持镜头运动清晰可执行。",
    "风格": "风格：限定画面质感、时代感、色彩倾向和真实度，避免风格漂移。",
    "无字幕": "无字幕：避免生成任何文字或字幕，保持画面纯净。",
}


@dataclass(frozen=True)
class Seedance2VideoPanelState:
    mode: str
    duration: int
    duration_floor: int
    resolution: str
    ratio: str
    generate_audio: bool
    return_last_frame: bool
    human_review: bool
    prompt_guidance: str
    final_prompt: str
    prompt_source: str
    text_overlay: dict[str, Any]
    assets: list[Seedance2ResolvedAsset]
    storyboard_context: list[tuple[str, str]]
    prompt_inputs_hash: str
    current_prompt_inputs_hash: str
    prompt_status: str


async def save_seedance2_video_panel_config(
    *,
    store: Any,
    episode: int,
    beat: dict[str, Any],
    mode: str | None = None,
    duration: int | float | None = None,
    resolution: str | None = None,
    ratio: str | None = None,
    generate_audio: bool | None = None,
    return_last_frame: bool | None = None,
    human_review: bool | None = None,
    prompt_guidance: str | None = None,
    final_prompt: str | None = None,
    text_overlay: dict[str, Any] | None = None,
    project_dir: Path | None = None,
    next_beat: dict[str, Any] | None = None,
    prop_menu: list[Any] | None = None,
) -> str:
    config = parse_seedance2_config(beat.get("seedance2_config_json"))
    if mode is not None:
        config.mode = Seedance2I2VMode(mode)
    if duration is not None:
        config.duration = int(duration)
    if resolution is not None:
        config.resolution = str(resolution or "720p").strip()
    if ratio is not None:
        config.ratio = str(ratio or "9:16").strip()
    if generate_audio is not None:
        config.generate_audio = bool(generate_audio)
        config.generate_audio_user_set = True
    if return_last_frame is not None:
        config.return_last_frame = bool(return_last_frame)
    if human_review is not None:
        config.human_review = bool(human_review)
        config.human_review_user_set = True
    if prompt_guidance is not None:
        config.prompt_guidance = str(prompt_guidance or "").strip()
    if final_prompt is not None:
        config.final_prompt = str(final_prompt or "").strip()
        config.prompt_source = "manual" if config.final_prompt else ""
    if text_overlay is not None:
        overlay = dict(config.text_overlay or {})
        overlay.update(text_overlay)
        config.text_overlay = overlay
    if project_dir is not None:
        _sync_seedance2_asset_paths(
            config=config,
            project_dir=project_dir,
            episode=episode,
            beat=beat,
            next_beat=next_beat,
            prop_menu=prop_menu,
        )

    saved_json = dump_seedance2_config(config)
    beat["seedance2_config_json"] = saved_json
    await store.update_beat_asset(
        episode_number=episode,
        beat_number=int(beat.get("beat_number") or 0),
        seedance2_config_json=saved_json,
    )
    return saved_json


async def append_seedance2_prompt_guidance_template(
    *,
    store: Any | None,
    episode: int,
    beat: dict[str, Any],
    label: str,
    prompt_guidance: str | None = None,
) -> str:
    template = SEEDANCE2_PROMPT_GUIDANCE_TEMPLATES.get(str(label or "").strip())
    config = parse_seedance2_config(beat.get("seedance2_config_json"))
    if prompt_guidance is not None:
        config.prompt_guidance = str(prompt_guidance or "").strip()
    if template and template not in config.prompt_guidance:
        parts = [part for part in [config.prompt_guidance, template] if part]
        config.prompt_guidance = "\n".join(parts)

    saved_json = dump_seedance2_config(config)
    beat["seedance2_config_json"] = saved_json
    if store is not None:
        await store.update_beat_asset(
            episode_number=episode,
            beat_number=int(beat.get("beat_number") or 0),
            seedance2_config_json=saved_json,
        )
    return saved_json


async def generate_seedance2_prompt_for_panel(
    *,
    store: Any,
    episode: int,
    beat: dict[str, Any],
    project_dir: Path,
    next_beat: dict[str, Any] | None = None,
    composer=None,
    manual_prompt_reference: str | None = None,
    prompt_guidance: str | None = None,
    prop_menu: list[Any] | None = None,
) -> str:
    config = parse_seedance2_config(beat.get("seedance2_config_json"))
    if prompt_guidance is not None:
        config.prompt_guidance = str(prompt_guidance or "").strip()
    assets = build_seedance2_project_assets(
        project_output=Path(project_dir),
        episode=episode,
        beat=beat,
        mode=config.mode,
        next_beat=next_beat,
        prop_menu=prop_menu,
    )
    _append_seedance2_user_reference_assets(assets, config)
    initial_prompt = _seedance2_initial_prompt(beat)
    reference_prompt = str(
        manual_prompt_reference
        if manual_prompt_reference is not None
        else (config.final_prompt or initial_prompt or "")
    ).strip()
    prompt_beat = _beat_with_seedance2_initial_prompt(beat, initial_prompt)
    inputs_hash = _seedance2_prompt_inputs_hash(
        config=config,
        beat=prompt_beat,
        assets=assets,
    )
    result = await generate_seedance2_prompt(
        mode=config.mode,
        beat=prompt_beat,
        assets=assets,
        text_overlay=config.text_overlay,
        prompt_guidance=config.prompt_guidance,
        request_params={
            "duration": int(config.duration),
            "resolution": config.resolution,
            "ratio": config.ratio,
        },
        manual_prompt_reference=reference_prompt,
        composer=composer,
    )
    config.final_prompt = mark_seedance2_prompt_references_for_editor(result.prompt)
    config.prompt_source = "generated" if result.used_ai else "fallback"
    config.prompt_inputs_hash = inputs_hash
    config.prompt_updated_at = datetime.now().isoformat(timespec="seconds")
    saved_json = dump_seedance2_config(config)
    beat["seedance2_config_json"] = saved_json
    await store.update_beat_asset(
        episode_number=episode,
        beat_number=int(beat.get("beat_number") or 0),
        seedance2_config_json=saved_json,
    )
    return saved_json


async def save_seedance2_uploaded_asset(
    *,
    store: Any,
    episode: int,
    beat: dict[str, Any],
    project_dir: Path,
    filename: str,
    content: bytes,
    content_type: str = "",
) -> Path | None:
    media_kind = _seedance2_uploaded_media_kind(filename, content_type)
    if not media_kind or not content:
        return None

    beat_num = int(beat.get("beat_number") or 0)
    upload_dir = (
        Path(project_dir)
        / "seedance2_uploads"
        / f"ep{episode:03d}"
        / f"beat_{beat_num:02d}"
        / media_kind
    )
    upload_dir.mkdir(parents=True, exist_ok=True)
    target = _next_available_upload_path(upload_dir, filename)
    target.write_bytes(bytes(content))

    config = parse_seedance2_config(beat.get("seedance2_config_json"))
    path_value = str(target)
    if media_kind == "images":
        config.reference_image_paths = _unique_paths(
            list(config.reference_image_paths) + [path_value]
        )
    else:
        config.reference_audio_paths = _unique_paths(
            list(config.reference_audio_paths) + [path_value]
        )

    saved_json = dump_seedance2_config(config)
    beat["seedance2_config_json"] = saved_json
    await store.update_beat_asset(
        episode_number=episode,
        beat_number=beat_num,
        seedance2_config_json=saved_json,
    )
    return target


async def crop_seedance2_asset_to_reference(
    *,
    store: Any,
    episode: int,
    beat: dict[str, Any],
    project_dir: Path,
    asset_key: str,
    source_path: str | Path,
    crop_data: dict[str, Any],
) -> Path | None:
    source = Path(source_path)
    if not source.exists():
        return None
    width = int(crop_data.get("width") or 0)
    height = int(crop_data.get("height") or 0)
    if width <= 0 or height <= 0:
        return None

    beat_num = int(beat.get("beat_number") or 0)
    target = str(crop_data.get("target") or "reference_image")
    if target in {"first_frame", "last_frame"}:
        paths = PathResolver(project_dir, episode)
        output_path = paths.video_input_frame(beat_num, slot=target)
    else:
        output_path = (
            Path(project_dir)
            / "seedance2_crops"
            / f"ep{episode:03d}"
            / f"beat_{beat_num:02d}"
            / f"{_seedance2_safe_asset_key(str(asset_key or 'asset'))}.png"
        )
    await crop_image_to_path(
        source,
        x=int(crop_data.get("x") or 0),
        y=int(crop_data.get("y") or 0),
        width=width,
        height=height,
        output_path=output_path,
    )
    if validate_seedance2_reference_image(output_path):
        return None
    if target in {"first_frame", "last_frame"}:
        paths.write_video_input_frame_meta(beat_num, slot=target, source_path=source)
        return output_path

    config = parse_seedance2_config(beat.get("seedance2_config_json"))
    output_value = str(output_path)
    config.reference_image_paths = _unique_paths(
        list(config.reference_image_paths) + [output_value]
    )
    saved_json = dump_seedance2_config(config)
    beat["seedance2_config_json"] = saved_json
    await store.update_beat_asset(
        episode_number=episode,
        beat_number=beat_num,
        seedance2_config_json=saved_json,
    )
    return output_path


def _project_relative_path(project_dir: Path, path: Path) -> str:
    try:
        return path.relative_to(project_dir).as_posix()
    except ValueError:
        return str(path)


def _archive_narrator_voice_siblings(target: Path) -> None:
    stamp = datetime.now().strftime("%Y%m%d%H%M%S")
    for ext in VOICE_SAMPLE_EXTENSIONS:
        sibling = target.with_suffix(ext)
        if sibling.exists():
            sibling.replace(sibling.with_name(f"{sibling.stem}_{stamp}{sibling.suffix}"))


def _resolve_project_audio_source(project_dir: Path, source_path: str | Path) -> Path:
    root = Path(project_dir).resolve()
    raw_path = Path(source_path)
    source = raw_path if raw_path.is_absolute() else root / raw_path
    source = source.resolve()
    try:
        source.relative_to(root)
    except ValueError as exc:
        raise ValueError("请选择项目内有效的音频文件") from exc
    if not source.exists() or not source.is_file() or source.suffix.lower() not in VOICE_SAMPLE_EXTENSIONS:
        raise ValueError("请选择项目内有效的音频文件")
    return source


async def trim_seedance2_audio_to_reference(
    *,
    store: Any,
    episode: int,
    beat: dict[str, Any],
    project_dir: Path,
    asset_key: str,
    source_path: str | Path,
    start_seconds: float = 0.0,
    duration_seconds: float = 4.0,
) -> Path | None:
    source = _resolve_project_audio_source(Path(project_dir), source_path)
    content, _filename = trim_voice_sample_content(
        source.read_bytes(),
        filename=source.name,
        start_seconds=start_seconds,
        duration_seconds=duration_seconds,
    )

    if str(asset_key or "").strip() == "voice:narrator":
        target = Path(project_dir) / "assets" / "narrator" / "voice.mp3"
        target.parent.mkdir(parents=True, exist_ok=True)
        _archive_narrator_voice_siblings(target)
        target.write_bytes(content)
        username, project = _project_owner_from_output(Path(project_dir))
        set_narrator_reference_audio(
            username,
            project,
            relative_path=_project_relative_path(Path(project_dir), target),
            sha256=voice_content_sha256(content),
        )
        return target

    beat_num = int(beat.get("beat_number") or 0)
    output_path = (
        Path(project_dir)
        / "seedance2_crops"
        / f"ep{episode:03d}"
        / f"beat_{beat_num:02d}"
        / f"{_seedance2_safe_asset_key(str(asset_key or 'audio'))}_trimmed.mp3"
    )
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_bytes(content)

    config = parse_seedance2_config(beat.get("seedance2_config_json"))
    output_value = str(output_path)
    config.reference_audio_paths = _unique_paths(
        list(config.reference_audio_paths) + [output_value]
    )
    saved_json = dump_seedance2_config(config)
    beat["seedance2_config_json"] = saved_json
    await store.update_beat_asset(
        episode_number=episode,
        beat_number=beat_num,
        seedance2_config_json=saved_json,
    )
    return output_path


async def remove_seedance2_uploaded_asset(
    *,
    store: Any,
    episode: int,
    beat: dict[str, Any],
    media_kind: str,
    path: str,
) -> bool:
    config = parse_seedance2_config(beat.get("seedance2_config_json"))
    paths = config.reference_image_paths if media_kind == "images" else config.reference_audio_paths
    path_value = str(path)
    if path_value not in paths:
        return False
    paths[:] = [existing for existing in paths if existing != path_value]
    _seedance2_unlink_user_reference_file(path_value)
    saved_json = dump_seedance2_config(config)
    beat["seedance2_config_json"] = saved_json
    await store.update_beat_asset(
        episode_number=episode,
        beat_number=int(beat.get("beat_number") or 0),
        seedance2_config_json=saved_json,
    )
    return True


def build_seedance2_video_panel_state(
    *,
    project_dir: Path,
    episode: int,
    beat: dict[str, Any],
    next_beat: dict[str, Any] | None = None,
    characters: list[Any] | None = None,
    prop_menu: list[Any] | None = None,
) -> Seedance2VideoPanelState:
    config = parse_seedance2_config(beat.get("seedance2_config_json"))
    duration_floor = _seedance2_duration_floor(
        project_dir=project_dir,
        episode=episode,
        beat=beat,
    )
    duration = max(int(config.duration or 4), duration_floor)
    assets = build_seedance2_project_assets(
        project_output=project_dir,
        episode=episode,
        beat=beat,
        mode=config.mode,
        next_beat=next_beat,
        characters=characters,
        prop_menu=prop_menu,
    )
    _append_seedance2_user_reference_assets(assets, config)
    prompt_source = config.prompt_source or "saved"
    final_prompt = config.final_prompt
    initial_prompt = _seedance2_initial_prompt(beat)
    if not final_prompt and initial_prompt:
        final_prompt = _seedance2_default_prompt(
            beat=_beat_with_seedance2_initial_prompt(beat, initial_prompt),
            config=config,
            assets=assets,
            text_overlay=config.text_overlay,
        )
        prompt_source = "fallback"
    assets = apply_prompt_audio_selection(assets, final_prompt)
    current_prompt_inputs_hash = _seedance2_prompt_inputs_hash(
        config=config,
        beat=beat,
        assets=assets,
    )
    return Seedance2VideoPanelState(
        mode=config.mode.value,
        duration=duration,
        duration_floor=duration_floor,
        resolution=config.resolution,
        ratio=config.ratio,
        generate_audio=config.generate_audio,
        return_last_frame=config.return_last_frame,
        human_review=config.human_review,
        prompt_guidance=config.prompt_guidance,
        final_prompt=final_prompt,
        prompt_source=prompt_source,
        text_overlay=dict(config.text_overlay or {}),
        assets=assets,
        storyboard_context=_seedance2_storyboard_context(beat),
        prompt_inputs_hash=config.prompt_inputs_hash,
        current_prompt_inputs_hash=current_prompt_inputs_hash,
        prompt_status=_seedance2_prompt_status(config, current_prompt_inputs_hash),
    )


def mark_seedance2_prompt_references_for_editor(prompt: str) -> str:
    text = str(prompt or "")
    text = re.sub(r"@@+(图片|音频)\s*(\d+)", r"@\1\2", text)
    text = re.sub(r"@?(图片|音频)\s+(\d+)", r"@\1\2", text)
    text = re.sub(r"(?<!@)(图片|音频)(\d+)", r"@\1\2", text)
    return text


def _unique_paths(values: list[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for value in values:
        text = str(value or "").strip()
        if text and text not in seen:
            seen.add(text)
            result.append(text)
    return result


def _project_owner_from_output(project_dir: Path) -> tuple[str, str]:
    return str(project_dir.parent.name or "").strip(), str(project_dir.name or "").strip()


def _is_narrated_project(project_dir: Path) -> bool:
    username, project = _project_owner_from_output(project_dir)
    config = load_project_config_file(username, project)
    return str(config.get("spine_template") or "drama") == "narrated"


def _existing_user_audio_paths(config: Any, project_dir: Path) -> list[str]:
    result: list[str] = []
    for value in list(config.reference_audio_paths):
        path = Path(str(value or "").strip())
        if not str(path):
            continue
        resolved = path if path.is_absolute() else project_dir / path
        if resolved.exists():
            result.append(str(value))
    return result


def _drop_auto_narration_audio_when_user_audio_selected(
    *,
    assets: list[Seedance2ResolvedAsset],
    config: Any,
    project_dir: Path,
    beat: dict[str, Any],
) -> list[Seedance2ResolvedAsset]:
    if _is_narrated_project(project_dir):
        return assets
    if normalize_seedance2_audio_type(beat) != "narration":
        return assets
    if not _existing_user_audio_paths(config, project_dir):
        return assets
    return [
        asset
        for asset in assets
        if not (asset.media_type == "audio" and str(asset.key).startswith("voice:"))
    ]


def _sync_seedance2_asset_paths(
    *,
    config: Any,
    project_dir: Path,
    episode: int,
    beat: dict[str, Any],
    next_beat: dict[str, Any] | None = None,
    prop_menu: list[Any] | None = None,
) -> None:
    assets = build_seedance2_project_assets(
        project_output=Path(project_dir),
        episode=episode,
        beat=beat,
        mode=config.mode,
        next_beat=next_beat,
        prop_menu=prop_menu,
    )
    _append_seedance2_user_reference_assets(assets, config)
    assets = apply_prompt_audio_selection(assets, str(config.final_prompt or ""))
    auto_images = selected_reference_paths(assets, "reference_images")
    auto_audios = selected_reference_paths(assets, "reference_audios")
    extra_images = [path for path in config.reference_image_paths if path not in auto_images]
    extra_audios: list[str] = []
    config.reference_image_paths = _unique_paths(auto_images + extra_images)
    config.reference_audio_paths = _unique_paths(auto_audios + extra_audios)


def _seedance2_user_reference_paths(
    config_paths: list[str],
    auto_paths: set[str],
) -> list[str]:
    return [
        str(path)
        for path in config_paths
        if str(path or "").strip() and str(path) not in auto_paths
    ]


def _append_seedance2_user_reference_assets(
    assets: list[Seedance2ResolvedAsset],
    config: Any,
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
    for path in _seedance2_user_reference_paths(
        list(config.reference_image_paths),
        auto_image_paths,
    ):
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
    for path in _seedance2_user_reference_paths(
        list(config.reference_audio_paths),
        auto_audio_paths,
    ):
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


def _seedance2_default_prompt(
    *,
    beat: dict[str, Any],
    config: Any,
    assets: list[Seedance2ResolvedAsset],
    text_overlay: dict[str, Any],
) -> str:
    return build_seedance2_prompt_draft(
        mode=config.mode,
        beat=beat,
        assets=assets,
        text_overlay=text_overlay,
        prompt_guidance=config.prompt_guidance,
    )


def _seedance2_initial_prompt(beat: dict[str, Any]) -> str:
    return str(beat.get("video_prompt") or beat.get("keyframe_prompt") or "").strip()


def _beat_with_seedance2_initial_prompt(
    beat: dict[str, Any],
    initial_prompt: str,
) -> dict[str, Any]:
    if not initial_prompt:
        return beat
    updated = dict(beat)
    if not str(updated.get("video_prompt") or updated.get("keyframe_prompt") or "").strip():
        updated["video_prompt"] = initial_prompt
    return updated


def _seedance2_uploaded_media_kind(filename: str, content_type: str) -> str | None:
    name = str(filename or "").lower()
    mime = str(content_type or "").lower()
    if mime.startswith("image/"):
        return "images"
    if mime.startswith("audio/"):
        return "audios"
    if name.endswith((".png", ".jpg", ".jpeg", ".webp")):
        return "images"
    if name.endswith((".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg")):
        return "audios"
    return None


def _safe_upload_name(filename: str, default: str = "seedance2_asset") -> str:
    name = Path(str(filename or default)).name.strip()
    return name or default


def _next_available_upload_path(upload_dir: Path, filename: str) -> Path:
    target = upload_dir / _safe_upload_name(filename)
    if not target.exists():
        return target
    for index in range(1, 1000):
        candidate = target.with_name(f"{target.stem}_{index}{target.suffix}")
        if not candidate.exists():
            return candidate
    return target.with_name(f"{target.stem}_latest{target.suffix}")


def _seedance2_safe_asset_key(asset_key: str) -> str:
    return (
        "".join(
            char if char.isalnum() or char in {"_", ".", "-"} else "_" for char in asset_key
        ).strip(".")
        or "asset"
    )


def _seedance2_unlink_user_reference_file(path: str | Path) -> bool:
    text = str(path or "").strip()
    if not text or text.startswith(("http://", "https://")):
        return False
    file_path = Path(text)
    if not file_path.exists() or not file_path.is_file():
        return False
    if "seedance2_uploads" not in file_path.parts and "seedance2_crops" not in file_path.parts:
        return False
    try:
        file_path.unlink()
    except OSError:
        return False
    return True


def _seedance2_prompt_inputs_hash(
    *,
    config: Any,
    beat: dict[str, Any],
    assets: list[Seedance2ResolvedAsset],
) -> str:
    return compute_seedance2_prompt_inputs_hash(
        mode=config.mode,
        beat=beat,
        assets=assets,
        text_overlay=config.text_overlay,
        prompt_guidance=config.prompt_guidance,
    )


def _seedance2_prompt_status(config: Any, current_hash: str) -> str:
    if not str(config.final_prompt or "").strip():
        return "未生成"
    if str(config.prompt_source or "") in {"manual", "edited"}:
        return "已手动编辑"
    if config.prompt_inputs_hash and config.prompt_inputs_hash != current_hash:
        return "Prompt 已过期"
    if config.prompt_source == "generated":
        return "AI 生成"
    if config.prompt_source == "fallback":
        return "规则草稿"
    return "旧提示词"


def _seedance2_storyboard_context(beat: dict[str, Any]) -> list[tuple[str, str]]:
    spoken_text = ""
    if normalize_seedance2_audio_type(beat) in {"narration", "dialogue"}:
        spoken_text = str(
            beat.get("narration_segment") or beat.get("dialogue") or beat.get("narration") or ""
        ).strip()
    rows = [
        (
            "分镜概要",
            str(beat.get("synopsis") or beat.get("visual_description") or "").strip(),
        ),
        (
            "旧视频提示词",
            str(beat.get("video_prompt") or beat.get("keyframe_prompt") or "").strip(),
        ),
        ("旁白/对话", spoken_text),
    ]
    return [(label, value) for label, value in rows if value]


def _seedance2_duration_floor(*, project_dir: Path, episode: int, beat: dict[str, Any]) -> int:
    beat_num = int(beat.get("beat_number") or 0)
    audio_duration = None
    audio_path = project_dir / "audio" / f"ep{episode:03d}" / f"beat_{beat_num:02d}.mp3"
    if normalize_seedance2_audio_type(beat) in {"narration", "dialogue"} and audio_path.exists():
        try:
            audio_duration = get_audio_duration(str(audio_path))
        except Exception:
            audio_duration = None
    floor = resolve_target_video_duration(beat, audio_duration)
    try:
        return max(4, int(math.ceil(float(floor))))
    except (TypeError, ValueError):
        return 4


__all__ = [
    "SEEDANCE2_PROMPT_GUIDANCE_TEMPLATES",
    "Seedance2VideoPanelState",
    "append_seedance2_prompt_guidance_template",
    "build_seedance2_video_panel_state",
    "crop_seedance2_asset_to_reference",
    "generate_seedance2_prompt_for_panel",
    "mark_seedance2_prompt_references_for_editor",
    "remove_seedance2_uploaded_asset",
    "save_seedance2_uploaded_asset",
    "save_seedance2_video_panel_config",
    "trim_seedance2_audio_to_reference",
]
