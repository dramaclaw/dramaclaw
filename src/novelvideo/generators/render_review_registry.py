"""Provider-agnostic lookup for the render-review dialog (dry-run preview,
AI rewrite, lint) — one dispatch table shared by every RunPod render
provider that gets this tooling, instead of each new provider needing its
own copy of `api/routes/generation.py`'s review/rewrite routes.

Lives in `generators/`, not `api/routes/`, because it's imported by
`task_backend/runners/render.py` too (which must not import `api.routes`),
and the agent imports below are lazy (inside `rewrite`) so this module
itself has no heavy import-time cost for callers that only need
`strategy_for_selection()`'s key lookup.

Add a new render-review-capable provider by adding one `RenderReviewStrategy`
entry to `_STRATEGIES` below — no route changes needed.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Awaitable, Callable, List, Literal, Optional

from novelvideo.agents.qwen_edit_render_prompt_lint import LintResult


@dataclass(frozen=True)
class RenderReviewStrategy:
    family: str  # "runpod_qwen_edit" | "runpod_qwen21_render"
    model_label: str  # shown in the review dialog, e.g. "Qwen-Image 2.1"
    store_namespace: str  # generators/qwen_edit_prompt_store.py namespace
    # 3rd positional-or-keyword arg is `subject_hints: list[str] | None`,
    # used only by the qwen21 adapter's `scene_only` stage (added
    # 2026-10-18 — see `build_qwen21_render_prompt`'s docstring); the
    # qwen_edit adapter accepts and ignores it, for signature symmetry.
    build_prompt: Callable[..., str]
    lint: Callable[..., LintResult]  # (prompt, *, stage) -> LintResult
    rewrite: Callable[..., Awaitable[str]]  # see _rewrite_* adapters below
    seconds_per_pass: float  # for render/review's estimate_minutes


async def _rewrite_qwen_edit(
    *,
    stage: Literal["full", "scene_only", "inpaint"],
    default_prompt: str,
    image_1_path: str,
    image_2_path: str,
    image_2_label: str,
    retry_feedback: str,
) -> str:
    from novelvideo.agents.qwen_edit_render_prompt_builder import (
        QwenEditRewriteContext,
        rewrite_qwen_edit_render_prompt,
    )

    context = QwenEditRewriteContext(
        stage=stage,
        default_prompt=default_prompt,
        picture_1_path=image_1_path,
        picture_2_path=image_2_path,
        picture_2_label=image_2_label,
        retry_feedback=retry_feedback,
    )
    return await rewrite_qwen_edit_render_prompt(context)


async def _rewrite_qwen21(
    *,
    stage: Literal["full", "scene_only", "inpaint"],
    default_prompt: str,
    image_1_path: str,
    image_2_path: str,
    image_2_label: str,
    retry_feedback: str,
) -> str:
    from novelvideo.agents.qwen21_render_prompt_builder import (
        Qwen21RewriteContext,
        rewrite_qwen21_render_prompt,
    )

    context = Qwen21RewriteContext(
        stage=stage,
        default_prompt=default_prompt,
        image_1_path=image_1_path,
        image_2_path=image_2_path,
        image_2_label=image_2_label,
        retry_feedback=retry_feedback,
    )
    return await rewrite_qwen21_render_prompt(context)


def _lint_qwen_edit(prompt: str, *, stage: str) -> LintResult:
    from novelvideo.agents.qwen_edit_render_prompt_lint import lint_qwen_edit_render_prompt

    return lint_qwen_edit_render_prompt(prompt, stage=stage)


def _lint_qwen21(prompt: str, *, stage: str) -> LintResult:
    from novelvideo.agents.qwen21_render_prompt_lint import lint_qwen21_render_prompt

    return lint_qwen21_render_prompt(prompt, stage=stage)


def _build_prompt_qwen_edit(
    beats: list[dict], stage: str, subject_hints: Optional[List[str]] = None
) -> str:
    from novelvideo.generators.prompt_builder import build_qwen_edit_render_prompt

    # subject_hints intentionally ignored — see RenderReviewStrategy docstring.
    return build_qwen_edit_render_prompt(beats, stage=stage)


def _build_prompt_qwen21(
    beats: list[dict], stage: str, subject_hints: Optional[List[str]] = None
) -> str:
    from novelvideo.generators.prompt_builder import build_qwen21_render_prompt

    return build_qwen21_render_prompt(beats, stage=stage, subject_hints=subject_hints)


# Measured ~600s/pass for Edit-2511 (40 steps, 20B model, see
# .claude/CLAUDE.md 2026-10-17). 2.1's figure is provisional (not yet
# measured end-to-end for render as of 2026-10-18) — estimated from this
# project's own t2i measurements (25 steps: 1K ~45-85s) scaled to the
# official 40-step recipe; retune once real render passes are timed.
_EDIT_2511_SECONDS_PER_PASS = 600.0
_QWEN21_SECONDS_PER_PASS = 150.0

_STRATEGIES: dict[str, RenderReviewStrategy] = {}


def _register(keys: tuple[str, ...], strategy: RenderReviewStrategy) -> None:
    for key in keys:
        _STRATEGIES[key] = strategy


def _build_registry() -> None:
    from novelvideo.config import (
        RUNPOD_QWEN21_RENDER_SELECTION_KEYS,
        RUNPOD_QWEN_EDIT_SELECTION_KEYS,
    )

    _register(
        RUNPOD_QWEN_EDIT_SELECTION_KEYS,
        RenderReviewStrategy(
            family="runpod_qwen_edit",
            model_label="Qwen-Image-Edit-2511",
            store_namespace="qwen_edit",
            build_prompt=_build_prompt_qwen_edit,
            lint=_lint_qwen_edit,
            rewrite=_rewrite_qwen_edit,
            seconds_per_pass=_EDIT_2511_SECONDS_PER_PASS,
        ),
    )
    _register(
        RUNPOD_QWEN21_RENDER_SELECTION_KEYS,
        RenderReviewStrategy(
            family="runpod_qwen21_render",
            model_label="Qwen-Image 2.1",
            store_namespace="qwen21_render",
            build_prompt=_build_prompt_qwen21,
            lint=_lint_qwen21,
            rewrite=_rewrite_qwen21,
            seconds_per_pass=_QWEN21_SECONDS_PER_PASS,
        ),
    )


_build_registry()


def strategy_for_selection(selection: str) -> Optional[RenderReviewStrategy]:
    return _STRATEGIES.get(selection)
