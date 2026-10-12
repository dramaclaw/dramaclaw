"""Step registry for prompt previews.

A step registers two async callables. Neither may call a model or write files:
``targets_fn(scope)`` lists what can be previewed, ``build_fn(scope, target_id)`` builds it.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Awaitable, Callable

from novelvideo.prompt_preview.types import (
    LastSent,
    ModelKind,
    PreviewTarget,
    PromptPreview,
)


@dataclass
class PreviewScope:
    """Everything a builder needs; resolved once per request by the route."""

    project_dir: Path
    state_dir: str
    store: Any
    config: dict
    episode: int | None = None


TargetsFn = Callable[[PreviewScope], Awaitable[list[PreviewTarget]]]
BuildFn = Callable[[PreviewScope, str], Awaitable[PromptPreview]]


@dataclass
class StepSpec:
    step: str
    label: str
    model_kind: ModelKind
    needs_episode: bool = False
    note: str = ""
    targets_fn: TargetsFn | None = None
    build_fn: BuildFn | None = None

    @property
    def supported(self) -> bool:
        return self.build_fn is not None


_REGISTRY: dict[str, StepSpec] = {}

# Order follows api/routes/pipeline.py::_STEP_MAP. Steps without a builder stay listed as unsupported.
STEP_ORDER: list[tuple[str, str, ModelKind, bool]] = [
    ("characters", "角色提取 / Character extraction", "llm", False),
    ("episodes", "分集规划 / Episode planning", "llm", False),
    ("portraits", "肖像生成 / Portraits", "image", False),
    ("identity_plan", "身份规划 / Identity planning", "llm", True),
    ("identity_images", "身份图生成 / Identity images", "image", False),
    ("script", "脚本生成 / Script", "llm", True),
    ("sketches", "草图生成 / Sketch grids", "image", True),
    ("coloring", "配色+身份检测 / Coloring", "llm", True),
    ("global_optimize", "全局视频优化 / Global optimize", "llm", True),
    ("first_frames", "首帧生成 / First frames", "image", True),
    ("video_prompt", "视频提示词 / Video prompt", "llm", True),
    ("tts", "TTS 配音 / TTS", "tts", True),
    ("video", "视频生成 / Video", "video", True),
]


# Why a step has no preview, shown instead of a generic "not available".
UNSUPPORTED_NOTES: dict[str, str] = {
    "episodes": "结构化项目按章节切分集数，不调用 LLM；仅旧版 AI 规划才会发送提示词。"
    " / Structured projects split episodes by chapter without an LLM; only the legacy AI planner sends a prompt.",
    "coloring": "该步骤的提示词依赖草图图像与逐帧检测结果，运行时才产生。"
    " / Its prompt depends on sketch images and per-frame detection produced at run time.",
}


def register(spec: StepSpec) -> None:
    _REGISTRY[spec.step] = spec


def all_steps() -> list[StepSpec]:
    from novelvideo.prompt_preview import steps  # noqa: F401  (import registers builders)

    result: list[StepSpec] = []
    for step, label, kind, needs_episode in STEP_ORDER:
        spec = _REGISTRY.get(step)
        if spec is None:
            spec = StepSpec(
                step=step,
                label=label,
                model_kind=kind,
                needs_episode=needs_episode,
                note=UNSUPPORTED_NOTES.get(step, ""),
            )
        result.append(spec)
    return result


def get_step(step: str) -> StepSpec | None:
    return next((s for s in all_steps() if s.step == step), None)


def read_last_sent(path: Path) -> LastSent | None:
    try:
        return LastSent(
            text=path.read_text(encoding="utf-8"),
            path=str(path),
            mtime=path.stat().st_mtime,
        )
    except OSError:
        return None


def empty(step: str, kind: ModelKind, note: str, *, supported: bool = True) -> PromptPreview:
    return PromptPreview(step=step, model_kind=kind, supported=supported, note=note)
