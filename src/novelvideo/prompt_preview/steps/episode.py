"""Per-episode previews: stored beat prompts (video, Seedance2), TTS, and grid audit files."""

from __future__ import annotations

import json
from pathlib import Path

from novelvideo.prompt_preview.registry import (
    PreviewScope,
    StepSpec,
    empty,
    read_last_sent,
    register,
)
from novelvideo.prompt_preview.types import PreviewTarget, PromptPart, PromptPreview


async def _beats(scope: PreviewScope) -> list[dict]:
    if scope.episode is None:
        return []
    return await scope.store.get_beats_as_dicts(scope.episode)


def _beat_targets_from(beats: list[dict]) -> list[PreviewTarget]:
    return [
        PreviewTarget(str(b["beat_number"]), f"Beat {b['beat_number']}")
        for b in beats
        if b.get("beat_number") is not None
    ]


async def _beat_targets(scope: PreviewScope) -> list[PreviewTarget]:
    return _beat_targets_from(await _beats(scope))


async def _find_beat(scope: PreviewScope, target: str) -> dict | None:
    return next((b for b in await _beats(scope) if str(b.get("beat_number")) == target), None)


def _seedance_final_prompt(beat: dict) -> str:
    try:
        cfg = json.loads(beat.get("seedance2_config_json") or "{}")
    except ValueError:
        return ""
    return str(cfg.get("final_prompt") or "").strip() if isinstance(cfg, dict) else ""


async def _video_build(scope: PreviewScope, target: str) -> PromptPreview:
    beat = await _find_beat(scope, target)
    if beat is None:
        return empty("video", "video", f"找不到分镜 / Beat not found: {target}")
    out = PromptPreview(step="video", model_kind="video", target_label=f"Beat {target}")
    seedance = _seedance_final_prompt(beat)
    keyframe = str(beat.get("keyframe_prompt") or "").strip()
    video = str(beat.get("video_prompt") or "").strip()
    if seedance:
        out.parts.append(PromptPart("user", "seedance2.final_prompt", seedance))
    if video:
        out.parts.append(PromptPart("user", "video_prompt", video))
    if keyframe:
        out.parts.append(PromptPart("user", "keyframe_prompt", keyframe))
    if not out.parts:
        out.note = "该分镜还没有视频提示词 / No video prompt yet; run the video-prompt step first"
    else:
        out.note = "视频生成直接发送已保存的提示词 / Video generation sends the stored prompt as-is"
    return out


async def _tts_build(scope: PreviewScope, target: str) -> PromptPreview:
    from novelvideo.seedance2_i2v.voice_clone import (
        dialogue_emotion_prompt,
        narration_style_prompt,
    )

    beat = await _find_beat(scope, target)
    if beat is None:
        return empty("tts", "tts", f"找不到分镜 / Beat not found: {target}")
    text = str(
        beat.get("narration_segment") or beat.get("dialogue") or beat.get("narration") or ""
    ).strip()
    style = scope.config.get("narration_style", "")
    emotion = dialogue_emotion_prompt(beat) or narration_style_prompt(style)
    out = PromptPreview(
        step="tts",
        model_kind="tts",
        target_label=f"Beat {target}",
        inputs={"narration_style": style, "speaker": beat.get("speaker", "")},
    )
    if text:
        out.parts.append(PromptPart("user", "text (spoken)", text))
    if emotion:
        out.parts.append(PromptPart("user", "emotion_prompt", emotion))
    if not out.parts:
        out.note = "该分镜没有台词 / This beat has no spoken text"
    return out


# --- grid audit files (sketch / render prompts written by generate_grid) -------------------------


def _grid_files(scope: PreviewScope, kind: str) -> list[Path]:
    if scope.episode is None:
        return []
    root = scope.project_dir / "grids" / f"ep{scope.episode:03d}"
    if not root.is_dir():
        return []
    found = [
        p
        for pattern in ("*.prompt.txt", "*_prompt.txt")
        for p in root.rglob(pattern)
        if p.is_file()
    ]
    wanted = [p for p in found if kind in p.relative_to(root).as_posix().lower()]
    return sorted(set(wanted), key=lambda p: p.relative_to(root).as_posix())


def _grid_steps(step: str, kind: str, label: str) -> StepSpec:
    async def targets(scope: PreviewScope) -> list[PreviewTarget]:
        root = scope.project_dir / "grids" / f"ep{scope.episode or 0:03d}"
        return [
            PreviewTarget(p.relative_to(root).as_posix(), p.relative_to(root).as_posix())
            for p in _grid_files(scope, kind)
        ]

    async def build(scope: PreviewScope, target: str) -> PromptPreview:
        root = (scope.project_dir / "grids" / f"ep{scope.episode or 0:03d}").resolve()
        path = (root / target).resolve()
        if root not in path.parents or not path.is_file():
            return empty(step, "image", f"找不到文件 / Prompt file not found: {target}")
        last = read_last_sent(path)
        out = PromptPreview(
            step=step,
            model_kind="image",
            target_label=target,
            last_sent=last,
            note="此步骤的完整提示词在生成时才拼装，这里显示最近一次发送的内容 / "
            "Assembled at generation time; showing the most recently sent prompt",
        )
        return out

    return StepSpec(step, label, "image", needs_episode=True, targets_fn=targets, build_fn=build)


register(StepSpec("video", "视频生成 / Video", "video", needs_episode=True,
                  targets_fn=_beat_targets, build_fn=_video_build))
register(StepSpec("tts", "TTS 配音 / TTS", "tts", needs_episode=True,
                  targets_fn=_beat_targets, build_fn=_tts_build))
register(_grid_steps("sketches", "sketch", "草图生成 / Sketch grids"))
register(_grid_steps("first_frames", "render", "首帧生成 / First frames"))
