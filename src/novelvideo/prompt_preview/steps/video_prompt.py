"""Preview of how each beat's video prompt is *generated* (as opposed to the "video" step, which
shows the stored prompt that is sent to the video model).

keyframe mode: the transition prompt built from two frames, using the same pure builders as
``KeyframePromptBuilder.build`` and the same frame lookup as ``scripts._generate_single_beat_keyframe_prompt``.
first_frame mode: only the optimizer's system prompt is knowable up front (its task needs the colour map).
"""

from __future__ import annotations

from pathlib import Path

from novelvideo.prompt_preview.registry import PreviewScope, StepSpec, empty, register
from novelvideo.prompt_preview.steps.llm import _language, _optimizer_system
from novelvideo.prompt_preview.types import LastSent, PreviewTarget, PromptPart, PromptPreview

_STEP = "video_prompt"


def _first_existing(*paths: Path) -> Path | None:
    return next((p for p in paths if p.exists()), None)


async def _beats(scope: PreviewScope) -> list[dict]:
    return await scope.store.get_beats_as_dicts(scope.episode) if scope.episode is not None else []


async def _targets(scope: PreviewScope) -> list[PreviewTarget]:
    return [
        PreviewTarget(str(b["beat_number"]), f"Beat {b['beat_number']} · {b.get('video_mode') or 'first_frame'}")
        for b in await _beats(scope)
        if b.get("beat_number") is not None
    ]


def _stored(beat: dict, field: str) -> LastSent | None:
    text = str(beat.get(field) or "").strip()
    return LastSent(text=text, path=f"beat.{field} (database)", mtime=0) if text else None


async def _build(scope: PreviewScope, target: str) -> PromptPreview:
    from novelvideo.agents.keyframe_prompt_builder import (
        build_keyframe_system_prompt,
        build_keyframe_task,
    )
    from novelvideo.models import format_beat_narration
    from novelvideo.utils.path_resolver import PathResolver

    beats = await _beats(scope)
    beat = next((b for b in beats if str(b.get("beat_number")) == target), None)
    if beat is None:
        return empty(_STEP, "llm", f"找不到分镜 / Beat not found: {target}")
    num = int(beat["beat_number"])
    mode = str(beat.get("video_mode") or "first_frame")
    language = _language(scope)
    paths = PathResolver(str(scope.project_dir), scope.episode)
    label = f"Beat {num} · {mode}"

    if mode != "keyframe":
        sketch = _first_existing(paths.sketch(num), paths.frame(num))
        name, text = _optimizer_system(language)
        return PromptPreview(
            step=_STEP,
            model_kind="llm",
            target_label=label,
            parts=[
                PromptPart("system", name, text),
                PromptPart("image", "sketch frame", str(sketch) if sketch else "（缺少草图或首帧 / missing sketch or frame）"),
            ],
            inputs={"video_mode": mode, "language": language},
            last_sent=_stored(beat, "video_prompt"),
            note="首帧模式：用户提示词依赖角色颜色映射，运行时拼装；这里显示系统提示词与草图。"
            " / First-frame mode: the user prompt needs the colour map at run time; showing the system prompt and sketch.",
        )

    next_beat = next((b for b in beats if int(b.get("beat_number") or 0) == num + 1), None)
    if next_beat is None:
        out = empty(_STEP, "llm", "这是最后一个 Beat，没有首尾帧过渡提示词 / Last beat: no keyframe transition prompt")
        out.target_label, out.last_sent = label, _stored(beat, "keyframe_prompt")
        return out

    first = _first_existing(paths.frame(num), paths.sketch(num))
    last = _first_existing(paths.frame(num + 1), paths.sketch(num + 1))
    audio_type = str(beat.get("audio_type") or "narration")
    narration = str(beat.get("narration_segment") or "")
    task = build_keyframe_task(
        narration=format_beat_narration(audio_type, str(beat.get("speaker") or ""), narration),
        next_narration=str(next_beat.get("narration_segment") or ""),
        language=language,
        visual_description=str(beat.get("visual_description") or ""),
        next_visual_description=str(next_beat.get("visual_description") or ""),
        audio_type=audio_type,
        dialogue_line=narration if audio_type == "dialogue" else "",
    )
    missing = "（缺少首帧或草图 / missing frame or sketch）"
    return PromptPreview(
        step=_STEP,
        model_kind="llm",
        target_label=label,
        parts=[
            PromptPart("system", "KEYFRAME_PROMPT_BUILDER_INSTRUCTIONS_EN", build_keyframe_system_prompt(language)),
            PromptPart("user", "task", task),
            PromptPart("image", "image 1 · first frame", str(first) if first else missing),
            PromptPart("image", f"image 2 · last frame (beat {num + 1})", str(last) if last else missing),
        ],
        inputs={"video_mode": mode, "language": language, "has_both_frames": bool(first and last)},
        last_sent=_stored(beat, "keyframe_prompt"),
        note="生成时语言取自界面语言，此处按原文语言预览；缺少任一帧时生成会失败。"
        " / At generation time the language follows the UI language (preview uses the source language); generation fails if either frame is missing.",
    )


register(StepSpec(_STEP, "视频提示词 / Video prompt", "llm", needs_episode=True,
                  targets_fn=_targets, build_fn=_build))
