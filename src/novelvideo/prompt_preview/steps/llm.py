"""LLM step previews, built from the same pure builders the agents use at run time.

Only the part of each prompt that is knowable before the step runs is shown. Anything that
depends on a previous model's output is named in ``note`` rather than guessed.
"""

from __future__ import annotations

from novelvideo.novel_source import NovelImportRequiredError, require_imported_novel
from novelvideo.prompt_preview.registry import PreviewScope, StepSpec, empty, register
from novelvideo.prompt_preview.types import PreviewTarget, PromptPart, PromptPreview
from novelvideo.utils.source_language import asset_language_instruction, detect_asset_language


def _novel_text(scope: PreviewScope) -> str | None:
    try:
        return require_imported_novel(scope.project_dir)
    except NovelImportRequiredError:
        return None


def _chunks(scope: PreviewScope):
    from novelvideo.story_analysis import chunk_source_text

    text = _novel_text(scope)
    if text is None:
        return None, None
    template = str(scope.config.get("spine_template") or "drama").strip()
    return text, chunk_source_text(text, template)


# --- characters: stage 1, one prompt per source chunk ---------------------------------------------

_CHARACTERS_NOTE = (
    "仅显示第一阶段（逐片段抽取）。合并、裁决与外貌补全依赖模型输出，运行时才产生。"
    " / Stage 1 only (per-chunk extraction). Merging, adjudication and appearance enrichment depend on model output."
)


async def _characters_targets(scope: PreviewScope) -> list[PreviewTarget]:
    _, chunks = _chunks(scope)
    return [PreviewTarget(c.chunk_id, c.section_label) for c in chunks or []]


async def _characters_build(scope: PreviewScope, target: str) -> PromptPreview:
    from novelvideo.structured_extraction import (
        CHARACTER_EXTRACTION_SYSTEM_PROMPT,
        build_character_chunk_prompt,
    )

    text, chunks = _chunks(scope)
    if text is None:
        return empty("characters", "llm", "请先导入原文 / Import the source text first")
    chunk = next((c for c in chunks if c.chunk_id == target), None)
    if chunk is None:
        return empty("characters", "llm", f"找不到片段 / Chunk not found: {target}")
    language = detect_asset_language(text)
    return PromptPreview(
        step="characters",
        model_kind="llm",
        target_label=chunk.section_label,
        parts=[
            PromptPart("system", "CHARACTER_EXTRACTION_SYSTEM_PROMPT", CHARACTER_EXTRACTION_SYSTEM_PROMPT),
            PromptPart("user", "chunk", build_character_chunk_prompt(chunk, language)),
        ],
        inputs={"chunk_id": chunk.chunk_id, "section_type": chunk.section_type, "language": language},
        note=_CHARACTERS_NOTE,
    )


# --- identity_plan: Pass A (default identities) ---------------------------------------------------


async def _identity_targets(scope: PreviewScope) -> list[PreviewTarget]:
    return [PreviewTarget("pass_a", "Pass A · 默认身份 / default identities")]


async def _identity_build(scope: PreviewScope, target: str) -> PromptPreview:
    from novelvideo.agents.identity_planner import (
        build_default_identity_system_prompt,
        build_default_identity_task,
        format_character_info,
    )

    episodes = await scope.store.list_episodes()
    episode = next((e for e in episodes if e.number == scope.episode), None)
    if episode is None:
        return empty("identity_plan", "llm", "找不到该集 / Episode not found")
    content = str(await scope.store.load_episode_content(episode.number) or "")
    if not content.strip():
        return empty("identity_plan", "llm", "该集还没有原文内容 / This episode has no source content yet")
    # The store's in-memory character cache is only filled with the full graph state, which the
    # preview route skips, so resolve names from the rows themselves.
    characters = await scope.store.list_characters()
    by_name = {c.name: c for c in characters}
    aliases = {a: c.name for c in characters for a in (c.aliases or [])}
    cast = list(by_name)
    info = format_character_info(
        cast, lambda n: aliases.get(n, n), lambda n: by_name.get(n)
    )
    return PromptPreview(
        step="identity_plan",
        model_kind="llm",
        target_label=f"EP{episode.number:03d} · Pass A",
        parts=[
            PromptPart("system", "DEFAULT_IDENTITY_PROMPT", build_default_identity_system_prompt(content)),
            PromptPart(
                "user",
                "task",
                build_default_identity_task(
                    episode_number=episode.number,
                    episode_title=episode.title,
                    cast_names=cast,
                    identity_info=info,
                    graph_context=None,
                    content_text=content,
                ),
            ),
        ],
        inputs={"cast_names": cast},
        note="出场角色在运行时先经 LLM 筛选，此处按全部角色预览；Pass B（特殊身份）未显示。"
        " / The cast is filtered by an LLM at run time; this preview assumes all characters. Pass B is not shown.",
    )


# --- script / global_optimize: system prompt only -------------------------------------------------


def _language(scope: PreviewScope) -> str:
    text = _novel_text(scope)
    return detect_asset_language(text) if text else "zh"


def _system_only(step: str, label: str, builder, note: str) -> StepSpec:
    async def targets(scope: PreviewScope) -> list[PreviewTarget]:
        return [PreviewTarget("system", "system prompt")]

    async def build(scope: PreviewScope, target: str) -> PromptPreview:
        name, text = builder(_language(scope))
        return PromptPreview(
            step=step,
            model_kind="llm",
            target_label="system prompt",
            parts=[PromptPart("system", name, text)],
            note=note,
        )

    return StepSpec(step, label, "llm", needs_episode=True, targets_fn=targets, build_fn=build)


def _script_system(language: str) -> tuple[str, str]:
    from novelvideo.workflows.literal_script_writing import LITERAL_SCRIPT_PROMPT

    return "LITERAL_SCRIPT_PROMPT", f"{LITERAL_SCRIPT_PROMPT}\n{asset_language_instruction(language)}"


def _optimizer_system(language: str) -> tuple[str, str]:
    from novelvideo.agents.global_video_optimizer import GLOBAL_VIDEO_OPTIMIZER_INSTRUCTIONS_EN

    return (
        "GLOBAL_VIDEO_OPTIMIZER_INSTRUCTIONS_EN",
        f"{GLOBAL_VIDEO_OPTIMIZER_INSTRUCTIONS_EN}\n\n## Output Language\n{asset_language_instruction(language)}",
    )


register(StepSpec("characters", "角色提取 / Character extraction", "llm",
                  targets_fn=_characters_targets, build_fn=_characters_build))
register(StepSpec("identity_plan", "身份规划 / Identity planning", "llm", needs_episode=True,
                  targets_fn=_identity_targets, build_fn=_identity_build))
register(_system_only(
    "script", "脚本生成 / Script", _script_system,
    "每一行的用户提示词依赖前面各行的选择，运行时逐行拼装；这里只显示系统提示词。"
    " / The per-line user prompt depends on earlier lines and is assembled at run time; only the system prompt is shown.",
))
register(_system_only(
    "global_optimize", "全局视频优化 / Global optimize", _optimizer_system,
    "每个分镜的用户提示词依赖草图图像与角色颜色映射，运行时拼装；这里只显示系统提示词。"
    " / The per-beat user prompt needs the sketch image and colour map at run time; only the system prompt is shown.",
))
