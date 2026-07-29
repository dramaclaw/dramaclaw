from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Callable, Optional

from pydantic import BaseModel, Field, ValidationInfo, field_validator, model_validator
from pydantic_ai import Agent
from pydantic_ai.exceptions import ContentFilterError

from novelvideo.config import (
    get_newapi_text_pydantic_model,
    get_newapi_text_pydantic_model_settings,
)
from novelvideo.models import (
    NarrationScript,
    SceneRef,
    VisualBeat,
    build_scene_ref,
    extract_char_identities_from_markers,
    extract_prop_ids_from_markers,
)
from novelvideo.time_of_day import normalize_time_of_day
from novelvideo.utils.screenplay_quality import check_screenplay_import_quality
from novelvideo.utils.screenplay_scene_parser import (
    parse_character_line,
    parse_location_header,
    parse_scene_blocks,
    split_screenplay_lines,
)

DIALOGUE_RE = re.compile(r"^(?P<speaker>[^：:]{1,24})[：:](?P<speech>.+)$")

CONTENT_FILTER_HINT_TERMS: dict[str, tuple[str, ...]] = {
    "暴力/武器": (
        "血",
        "流血",
        "滴血",
        "鲜血",
        "尸体",
        "死亡",
        "杀",
        "刺",
        "捅",
        "刀",
        "匕首",
        "枪",
        "爆炸",
        "blood",
        "bloody",
        "bleeding",
        "corpse",
        "dead",
        "death",
        "kill",
        "murder",
        "stab",
        "knife",
        "dagger",
        "blade",
        "gun",
        "shoot",
        "shot",
        "explosion",
    ),
    "自伤/生命威胁": (
        "自杀",
        "我不能死",
        "不想死",
        "去死",
        "suicide",
        "kill myself",
        "i can't die",
        "i cannot die",
        "don't want to die",
        "do not want to die",
        "go die",
    ),
    "胁迫/虐待": (
        "清除",
        "处决",
        "强迫",
        "强喂",
        "掐住",
        "压制",
        "虐待",
        "force",
        "forced",
        "coerce",
        "coerced",
        "choke",
        "strangle",
        "pin down",
        "restrain",
        "abuse",
        "torture",
        "execute",
        "execution",
    ),
    "性/裸露": (
        "性侵",
        "裸露",
        "裸体",
        "nude",
        "naked",
        "sexual assault",
        "rape",
    ),
}


def _short_log_text(text: str, *, limit: int = 120) -> str:
    compact = re.sub(r"\s+", " ", (text or "").strip())
    if len(compact) <= limit:
        return compact
    return compact[: limit - 1] + "…"


def _content_filter_hint_matches(text: str) -> list[str]:
    haystack = (text or "").casefold()
    matches: list[str] = []
    for category, terms in CONTENT_FILTER_HINT_TERMS.items():
        category_matches = []
        for term in terms:
            normalized = term.casefold()
            if normalized and normalized in haystack:
                category_matches.append(term)
        if category_matches:
            matches.append(f"{category}: " + "、".join(dict.fromkeys(category_matches)))
    return matches


@dataclass
class SceneBlock:
    header_line: str = ""
    location: str = ""
    time_of_day: str = ""
    interior_exterior: str = ""
    characters: list[str] = field(default_factory=list)
    lines: list[str] = field(default_factory=list)
    context: "SceneBlockContext | None" = None


@dataclass
class SceneBlockContext:
    """场景块级预编译候选集。"""

    candidate_identity_ids: set[str] = field(default_factory=set)
    candidate_prop_ids: set[str] = field(default_factory=set)
    identity_fallback_reason: str = ""
    identity_section: str = ""
    prop_section: str = ""


@dataclass
class SceneLineContext:
    raw_line: str
    scene_block: SceneBlock
    prev_window: list[str] = field(default_factory=list)
    next_line: str = ""
    source_line_number: int = 0


class LiteralBeatMetaOutput(BaseModel):
    """逐行剧本模式的 LLM 输出。"""

    audio_type: str = Field(
        default="silence",
        description="当前行对应的音频类型；silence=无朗读画面 beat，narration=解说/旁白，dialogue=明确说话人台词",
    )
    speaker: str = Field(
        default="",
        description="当前行说话人标签；仅 dialogue 时填写。角色可填 identity_id 或剧本里的角色标签，非角色发声源也可保留原标签",
    )
    speaker_kind: str = Field(
        default="character",
        description="speaker 类型；character=物理角色或普通角色，non_character=广播/画外音/字幕/屏幕等非角色发声源",
    )
    visual_description: str = Field(
        min_length=5,
        description="只描述当前这一行对应的可见画面，尽量忠实保留原行的画面性质",
    )
    scene_id: str = Field(
        default="",
        description="兜底 scene_id：仅在系统未锁定当前场次 scene_id 时使用。必须从本集场景菜单中精确选择（字符串完全相等），否则留空。",
    )

    @field_validator("scene_id")
    @classmethod
    def validate_scene_id(cls, value: str, info: ValidationInfo) -> str:
        scene_id = (value or "").strip()
        if not scene_id:
            return ""
        valid_scene_ids = set((info.context or {}).get("valid_scene_ids") or [])
        if valid_scene_ids and scene_id not in valid_scene_ids:
            return ""
        return scene_id

    @field_validator("visual_description")
    @classmethod
    def validate_visual_description(cls, value: str, info: ValidationInfo) -> str:
        visual_description = cls._validate_marked_text(value, info, field_name="visual_description")
        if "或者" in visual_description or "二选一" in visual_description:
            raise ValueError(
                "visual_description 必须是确定画面，不能出现“或者 / 二选一”等备选表达"
            )
        return visual_description

    @classmethod
    def _validate_marked_text(
        cls,
        value: str,
        info: ValidationInfo,
        *,
        field_name: str,
    ) -> str:
        text = (value or "").strip()
        if not text:
            return ""
        valid_identity_ids = set((info.context or {}).get("valid_identity_ids") or [])
        valid_prop_ids = set((info.context or {}).get("valid_prop_ids") or [])

        markers = extract_char_identities_from_markers(text, strict=True)
        if valid_identity_ids:
            invalid_identity_ids = sorted(
                identity_id
                for identity_id in markers.values()
                if identity_id not in valid_identity_ids
            )
            if invalid_identity_ids:
                raise ValueError(
                    f"{field_name} 出现非法角色标记: {invalid_identity_ids}；{{{{}}}} 只能用于身份菜单中的 identity_id"
                )

        prop_marker_ids = extract_prop_ids_from_markers(text, strict=True)
        if valid_prop_ids:
            invalid_prop_ids = sorted(
                prop_id for prop_id in prop_marker_ids if prop_id not in valid_prop_ids
            )
            if invalid_prop_ids:
                raise ValueError(
                    f"{field_name} 出现非法道具标记: {invalid_prop_ids}；[[ ]] 只能用于道具菜单中的 prop_id"
                )

        for identity_id in sorted(valid_identity_ids):
            if (
                identity_id in text
                and f"{{{{{identity_id}}}}}" not in text
            ):
                raise ValueError(
                    f"{field_name} 中出现裸 identity_id '{identity_id}'，必须用 {{{{{identity_id}}}}} 包裹"
                )

        return text

    @field_validator("audio_type")
    @classmethod
    def validate_audio_type(cls, value: str) -> str:
        audio_type = (value or "").strip()
        if audio_type not in {"silence", "narration", "dialogue"}:
            raise ValueError("audio_type 必须是 silence/narration/dialogue")
        return audio_type

    @field_validator("speaker_kind")
    @classmethod
    def validate_speaker_kind(cls, value: str) -> str:
        speaker_kind = (value or "").strip()
        if speaker_kind not in {"character", "non_character"}:
            raise ValueError("speaker_kind 只能是 character 或 non_character")
        return speaker_kind

    @model_validator(mode="after")
    def validate_dialogue_speaker(self) -> "LiteralBeatMetaOutput":
        if self.audio_type == "dialogue" and not (self.speaker or "").strip():
            raise ValueError("audio_type=dialogue 时必须填写 speaker")
        if self.audio_type in {"silence", "narration"}:
            self.speaker = ""
            self.speaker_kind = "character"
        return self


LITERAL_SCRIPT_PROMPT = """# 你是短剧剧本逐行分镜标注师

你的任务不是改写整集，而是严格围绕“当前这一行剧本”补全 2.0 beat 元数据。

## 核心原则
- 一行对应一个 beat
- 不改写原行，不合并多行，不总结剧情
- 你需要同时判断并输出 `audio_type` / `speaker` / `speaker_kind`；这些判断必须严格服从原行文字，不允许凭常识脑补
- `visual_description` 的职责是最大限度还原当前这一行剧本已经给出的可见画面信息，不替后续分镜阶段做导演决策
- 优先忠实保留原行的画面性质：如果原行本身就是复合画面、屏幕画面、回忆叠化、分屏直播、监控视角等表达，不要为了“统一成单镜头”而强行改写
- 如果一行前缀是镜头/机位/画面提示，不要把它误判成 speaker；只有明确“人物名：台词内容”时才判为 dialogue
- 只在必要时把原行补成更可画的身体动作、姿态、空间关系；不要擅自把原行扩写成新的镜头设计
- 当前 beat 的场景和时间由当前场次头确定；不要改写场景，不要切换到别的 scene_id
- 只有物理出场、被拿着、被操作、被看的具名道具，才在 `visual_description` 中用 `[[prop_id]]` 标记

## visual_description 规则
- 只描述当前行这一拍真正可见的画面
- 如果 `audio_type=dialogue`，默认画面主体优先是说话者的说话姿态、表情或动作；只有当原行明确指出另一方反应/动作才是重点时，才转向对方
- 如果当前行明确写了 `【特写】` / `【第一人称画面】` / `俯拍` / `仰拍` / `空镜` / `黑屏` 等画面提示，`visual_description` 必须原样保留这些提示，不要遗漏，也不要改写成解释性句子
- 如果原行本身包含复合画面装置或复合表达，可以直接保留这种画面性质，不要强行压成单一镜头
- visual_description 必须是唯一确定画面；不要写“或者 / 可选 / 二选一 / A 或 B”这类备选表达
- 不要把多行内容压进这一拍，不要主动补出原行没有的新时间切换、新空间切换或新的镜头编排
- 不要因为候选菜单里有某个道具/资产，就提前把它写进当前 beat；只有当前行文本明确出现或明确可见时才能写入
- 对 `抓住/按住/强喂/递交/掐住/扶住/压制` 这类非对称互动，必须写清主动方/被动方和手部几何
- 如果字段应留空，就直接留空；不要写“理论上应为”“原行未注，留空”这类解释性文字
- 如果对白行原文只有对白内容、没有括号动作，不要额外发明肢体动作；最多保留“说话 / 看向对方 / 开口”的最低限度说话状态

## 角色标记规则
- `visual_description` 中的角色标记使用 `{{identity_id}}`，且优先只给“物理可见且在身份菜单中”的角色
- 角色标记优先级：
  1. `dialogue` beat 的 speaker 优先使用 `{{identity_id}}`
  2. 其余物理可见且在身份菜单中的角色，也应优先使用 `{{identity_id}}`
  3. 当前动作核心角色优先级高于不重要陪衬角色
- 如果画面里出现了身份菜单中的已知角色，并且该角色物理可见，`visual_description` 应优先使用 `{{identity_id}}`
- 背景中清晰可见、但不是主体的已知角色，也应优先使用 `{{identity_id}}`
- 屏幕、电视、照片、回忆画面中如果呈现的是清晰可见的具体人物，并且上下文能识别为身份菜单里的角色年龄身份，也要使用 `{{identity_id}}`
- 菜单外角色、路人、泛称角色、只是被提及/想起但没有实际可见画面的人物，不要使用 `{{identity_id}}`
- `{{}}` 只能用于角色 identity_id；场景名和道具名都不要写进 `{{}}`

## 道具标记规则
- `visual_description` 中物理可见、被拿着、被操作、被观看的已知道具，优先使用 `[[prop_id]]`
- `[[ ]]` 只能用于道具菜单中的 prop_id
- 不要把角色写进 `[[ ]]`，也不要把道具写进 `{{}}`
- 道具的状态、摆放关系、谁在拿它，都写进 `visual_description`

## audio / speaker 规则
- 只有明确“已知角色/物理出场人物：台词内容”或等价的明确角色发声表达，才使用 `audio_type=dialogue`
- 如果原行明确是旁白、解说、画外音、广播、监控室声音、屏幕外发声、非角色发声且需要朗读，使用 `audio_type=narration`，不要输出 `dialogue`
- 如果是动作描写、环境描写、空镜、画面说明、时间字幕、镜头提示、舞台说明，即使带冒号，也优先判为 `audio_type=silence`
- `audio_type=dialogue` 时必须填写 `speaker`
- 如果 `dialogue` 的 speaker 对应身份菜单中的已知角色，`speaker` 优先直接输出对应的 `identity_id`，不要只输出裸角色名
- `audio_type=narration` 时 `speaker` 留空；广播/画外音/屏幕发声/非角色发声也应归入 narration 并留空 speaker
- `speaker_kind=non_character` 只用于广播、画外音、字幕、屏幕文字、系统播报等非物理角色发声源

## scene / prop 规则
- 道具只通过 `visual_description` 的 `[[prop_id]]` 表达；`[[prop_id]]` 只能从候选道具菜单里选择
- 不要编造新 prop_id 或新的 scene_id

## scene_id 兜底规则（仅在系统未锁定 scene_id 时使用）
- 系统通常会从“当前场次头”里解析出 scene_id 并在上下文中给出。当“当前 scene_id”已锁定时，`scene_id` 字段必须留空，不要重复输出。
- 仅当“当前 scene_id: 未锁定”时，你才需要从“本集场景菜单”中**精确**选择一个 scene_id 填入 `scene_id` 字段。
- 选择依据：当前场次头的地点字段、场次原始标签、当前行 visual_description 的可见空间线索（家门口/电梯/街道/面馆/家中/赛博空间/3D 大屏…）。
- 必须与本集场景菜单中的某个 scene_id **字符串完全相等**；不要编造新名字、不要做模糊缩写。
- 如果当前行明确发生在虚空/黑屏/无场景，且菜单里没有对应条目，留空。

## 输出
- 只输出当前这一行的结构化元数据
- 不要解释，不要复述原行
"""


def split_literal_source_text(source_text: str) -> list[str]:
    return split_screenplay_lines(source_text)


def _parse_scene_characters(character_text: str) -> list[str]:
    return parse_character_line(character_text)


def _parse_scene_block_location(location_text: str) -> tuple[str, str, str]:
    parsed = parse_location_header(location_text)
    if parsed:
        return parsed
    return (location_text or "").strip(), "", ""


class LiteralScriptWritingWorkflow:
    """适配 2.0 beat schema 的逐行剧本工作流。"""

    def __init__(
        self,
        cognee_store: Any,
        sqlite_store: Any | None = None,
        output_dir: str = "",
        audio_type_mode: str = "literal",
    ) -> None:
        self.cognee_store = cognee_store
        self.sqlite_store = sqlite_store or cognee_store
        self.output_dir = output_dir
        self.audio_type_mode = "narrated" if audio_type_mode == "narrated" else "literal"
        self._current_episode = 1
        self._agent: Agent | None = None
        self._valid_identity_ids: set[str] = set()
        self._valid_scene_ids: set[str] = set()
        self._scene_menu_split: dict[str, tuple[str, str, str]] = {}
        self._valid_prop_ids: set[str] = set()
        self._identity_section = ""
        self._scene_section = ""
        self._prop_section = ""
        self.last_review_passed = True
        self.last_review_summary = "逐行剧本模式"

    @property
    def agent(self) -> Agent:
        if self._agent is None:
            self._agent = Agent(
                get_newapi_text_pydantic_model(
                    "LITERAL_BEAT_META_MODEL",
                    "gemini-3.5-flash",
                ),
                system_prompt=LITERAL_SCRIPT_PROMPT,
                model_settings=get_newapi_text_pydantic_model_settings(
                    "LITERAL_BEAT_META_THINKING_LEVEL",
                    "low",
                ),
                output_type=LiteralBeatMetaOutput,
                output_retries=2,
                validation_context={
                    "valid_identity_ids": self._valid_identity_ids,
                    "valid_scene_ids": self._valid_scene_ids,
                    "valid_prop_ids": self._valid_prop_ids,
                },
                name="逐行剧本分镜标注师",
            )
        return self._agent

    async def run(
        self,
        *,
        episode_num: int,
        source_text: str | None = None,
        target_duration: float | None = None,
        narration_style: str = "first_person",
        visual_style: str = "chinese_period_drama",
        protagonist_name: str = "",
        on_progress: Optional[Callable[[float, str], None]] = None,
        on_log: Optional[Callable[[str], None]] = None,
        **_: Any,
    ) -> NarrationScript:
        del target_duration, narration_style, protagonist_name

        def report_progress(progress: float, task: str) -> None:
            if on_progress:
                on_progress(progress, task)

        def log(message: str) -> None:
            if on_log:
                on_log(message)

        self._current_episode = episode_num
        self._agent = None
        self._identity_section = ""
        self._scene_section = ""
        self._prop_section = ""
        self.last_review_passed = True
        self.last_review_summary = "逐行剧本模式"

        await self.cognee_store.load_graph_state()
        episode = await self.sqlite_store.get_episode_from_graph(episode_num)
        if not episode:
            raise ValueError(f"未找到第 {episode_num} 集规划")

        if source_text is None:
            source_text = (
                getattr(episode, "beat_source_text", "")
                or await self.sqlite_store.load_episode_content(episode_num)
                or getattr(episode, "content_summary", "")
                or ""
            )
        if not source_text.strip():
            raise ValueError("当前集原文为空，无法逐行生成脚本")

        quality_report = check_screenplay_import_quality(source_text)
        for issue in quality_report.blocking_issues:
            log(f"[Literal][Quality][blocking-as-warning] {issue.code}: {issue.message}")
        for issue in quality_report.warnings:
            log(f"[Literal][Quality][warning] {issue.code}: {issue.message}")

        # 这些调用当前主要用于填充 episode 级合法集合（_valid_*），
        # block compiler 和 fallback 仍依赖这些全集真值；返回的 *_section 文本仅保留作调试遗留。
        self._identity_section, self._valid_identity_ids = self._build_identity_menu_for_episode(
            episode_num
        )
        self._scene_section = self._build_scene_menu_for_episode(episode)
        self._prop_section = self._build_prop_menu_for_episode(episode)
        episode_identity_ids = set(self._valid_identity_ids)
        episode_identity_default_map = dict(getattr(episode, "identity_default_map", {}) or {})
        episode_prop_ids = set(self._valid_prop_ids)
        identity_metadata = self._build_identity_metadata(episode_identity_ids)
        prop_metadata = self._build_prop_metadata(episode)

        lines = split_literal_source_text(source_text)
        if not lines:
            raise ValueError("原文无法切分出有效行")

        scene_blocks = self._build_scene_blocks(lines)
        for block_index, block in enumerate(scene_blocks):
            block.context = self._compile_scene_block_context(
                block,
                block_index,
                episode,
                episode_identity_ids,
                episode_identity_default_map,
                episode_prop_ids,
                identity_metadata,
                prop_metadata,
                on_log=log,
            )
        line_contexts = self._build_scene_line_contexts(scene_blocks, source_lines=lines)
        if not line_contexts:
            raise ValueError("原文无法切分出有效场次内容")

        report_progress(0.05, "按行切分剧本...")
        log(f"[Literal] 共切分出 {len(lines)} 行，识别 {len(scene_blocks)} 个场次块")

        beats: list[VisualBeat] = []
        total = max(1, len(line_contexts))
        current_block: SceneBlock | None = None
        episode_sticky_identities: dict[str, str] = dict(episode_identity_default_map)
        block_sticky_identities: dict[str, str] = {}

        for content_index, line_ctx in enumerate(line_contexts, start=1):
            raw_line = line_ctx.raw_line
            block = line_ctx.scene_block
            if block is not current_block:
                current_block = block
                block_sticky_identities = dict(episode_sticky_identities)
                block_ctx = block.context
                narrowed_identity_ids = (
                    set(block_ctx.candidate_identity_ids)
                    if block_ctx and block_ctx.candidate_identity_ids
                    else set(episode_identity_ids)
                )
                if (
                    block_ctx
                    and not block_ctx.candidate_identity_ids
                    and block_ctx.identity_fallback_reason
                ):
                    log(f"[Literal Block] {block_ctx.identity_fallback_reason}")
                narrowed_prop_ids = (
                    set(block_ctx.candidate_prop_ids)
                    if block_ctx and block_ctx.candidate_prop_ids
                    else set(episode_prop_ids)
                )
                self._valid_identity_ids.clear()
                self._valid_identity_ids.update(narrowed_identity_ids)
                self._valid_prop_ids.clear()
                self._valid_prop_ids.update(narrowed_prop_ids)

            current_scene_label = block.location
            current_scene_id = self._resolve_scene_id(block.location, episode)
            current_allowed_scene_ids = self._allowed_scene_ids_for_block(current_scene_id)
            current_time_of_day = block.time_of_day

            report_progress(
                0.08 + ((content_index - 1) / total) * 0.82, f"生成第 {content_index}/{total} 行..."
            )

            block_ctx = block.context
            block_menu_sections = [
                section.strip()
                for section in (
                    block_ctx.identity_section if block_ctx else "",
                    block_ctx.prop_section if block_ctx else "",
                )
                if section and section.strip()
            ]
            block_menu_text = (
                "\n\n".join(block_menu_sections)
                if block_menu_sections
                else "（无候选资产，回退到本集菜单）"
            )

            scene_id_fallback_section = ""
            if current_scene_id and current_allowed_scene_ids:
                scene_id_fallback_section = (
                    "\n\n## 当前场次 scene_id 候选\n"
                    f"当前基础 scene_id 已锁定为 `{current_scene_id}`；"
                    "只能从下列 scene_id 中精确选择一个，或留空让系统回落基础场景。\n"
                    + "\n".join(f"- `{sid}`" for sid in sorted(current_allowed_scene_ids))
                )
            elif self._valid_scene_ids:
                scene_id_fallback_section = (
                    "\n\n## 本集场景菜单（scene_id 兜底候选）\n"
                    "当前 scene_id 未锁定，请从下列 scene_id 中精确选择一个填入 `scene_id` 字段；"
                    "没有合适匹配则留空。\n"
                    + "\n".join(f"- `{sid}`" for sid in sorted(self._valid_scene_ids))
                )

            prev_beat_anchor = ""
            if beats:
                last = beats[-1]
                prev_identities = re.findall(r"\{\{(.+?)\}\}", last.visual_description or "")
                prev_props = extract_prop_ids_from_markers(
                    last.visual_description or "", strict=False
                )
                anchor_parts = []
                if prev_identities:
                    anchor_parts.append(f"身份: {', '.join(prev_identities)}")
                if prev_props:
                    anchor_parts.append(f"道具: {', '.join(prev_props)}")
                if anchor_parts:
                    prev_beat_anchor = "- 上一 beat 已选: " + " | ".join(anchor_parts)

            sticky_lines = []
            if block_sticky_identities:
                for char_name, identity_id in sorted(block_sticky_identities.items()):
                    sticky_lines.append(f"  - {char_name} → `{identity_id}`")
            sticky_section = ""
            if sticky_lines:
                sticky_section = (
                    "- 当前场次已锁定结果（除非有强证据应切换，否则沿用）:\n"
                    + "\n".join(sticky_lines)
                )

            prompt = f"""请为第 {episode_num} 集当前这一行剧本补全 beat 元数据。

## 本集信息
- 标题: {episode.title}
- 视觉风格配置: {visual_style}

## 当前场次候选菜单
{block_menu_text}{scene_id_fallback_section}

## 当前场次上下文
- 当前场次头原文: {block.header_line or "无"}
- 当前场次原始标签: {current_scene_label or "未锁定"}
- 当前 scene_id: {current_scene_id or "未锁定"}
- 当前 time_of_day: {current_time_of_day or "未锁定"}
- 当前场次出场人物: {", ".join(block.characters) if block.characters else "未标注"}
- 当前场次前文（最多 2 行）:
{chr(10).join(f"  - {item}" for item in line_ctx.prev_window) if line_ctx.prev_window else "  - 无"}
- 下一行: {line_ctx.next_line or "无"}
{prev_beat_anchor or "- 上一 beat 已选: 无"}
{sticky_section or "- 当前场次已锁定结果: 无"}
## 当前行
- 行序号: {content_index}/{total}
- 上一行: {line_ctx.prev_window[-1] if line_ctx.prev_window else "无"}
- 当前行: {raw_line}
- 下一行复述: {line_ctx.next_line or "无"}
## 约束
- narration_segment 由系统根据 audio_type 定型：dialogue 提取台词，narration 保留解说文本，silence 留空；你不要输出 narration_segment
{self._audio_type_mode_instruction()}
- 当前 beat 的 scene_id 与 time_of_day 已由当前场次锁定，不要改写
- 当前行可见的道具用 `[[prop_id]]` 标在 visual_description 里
- 同一场次块内同一角色默认沿用已锁定 identity_id，只有当前行有强证据时才切换
- 如果原行含 `【特写】` / `【第一人称画面】` / `俯拍` / `仰拍` / `空镜` / `黑屏` 等提示，必须直接保留到 visual_description
- 角色只用 `{{identity_id}}` 标记，道具只用 `[[prop_id]]` 标记
- visual_description 必须选择一个确定画面，不要输出“或者 / 可选 / 二选一”
- 候选资产菜单不是当前行可见清单；当前行没明确出现的道具/资产，不要提前写入 visual_description
- `scene_id` 字段：当前 scene_id {"基础已锁定，只能留空或从当前场次 scene_id 候选中精确选择" if current_scene_id else "未锁定，请从本集场景菜单中精确选一个 scene_id 填入；没有合适匹配则留空"}
"""

            try:
                result = await self.agent.run(prompt)
            except ContentFilterError as exc:
                for message in self._content_filter_log_messages(
                    content_index=content_index,
                    total=total,
                    line_ctx=line_ctx,
                    error=exc,
                ):
                    log(message)
                raise RuntimeError(
                    f"第 {content_index}/{total} 行触发模型内容安全过滤，剧本生成已停止。"
                    "请检查该行及前后文是否包含血腥、暴力、胁迫、裸露等高风险表达，"
                    "或在 RelayClaw 中切换更适合剧本创作的文本模型后重试。"
                ) from exc
            output: LiteralBeatMetaOutput = result.output

            resolved_scene_id = (current_scene_id or "").strip()
            llm_scene_id = (output.scene_id or "").strip()
            if resolved_scene_id:
                if llm_scene_id and llm_scene_id in current_allowed_scene_ids:
                    resolved_scene_id = llm_scene_id
                elif llm_scene_id and llm_scene_id != current_scene_id:
                    log(
                        f"[Literal][WARN] beat {len(beats) + 1} scene_id `{llm_scene_id}` "
                        f"不属于当前场次候选，回落 `{current_scene_id}`"
                    )
            else:
                if llm_scene_id and llm_scene_id in self._valid_scene_ids:
                    resolved_scene_id = llm_scene_id
                    log(
                        f"[Literal] beat {len(beats) + 1} scene_id 字符串匹配失败，"
                        f"LLM 兜底选用 `{llm_scene_id}`（block.location={current_scene_label!r}）"
                    )
                else:
                    log(
                        f"[Literal][WARN] beat {len(beats) + 1} scene_id 留空 "
                        f"(block.location={current_scene_label!r}, LLM 输出={llm_scene_id!r})"
                    )
            time_of_day = (current_time_of_day or "").strip()
            visual_description = output.visual_description.strip()
            audio_type = self._normalize_audio_type_for_mode(output.audio_type)
            speaker_kind = (output.speaker_kind or "character").strip()
            speaker = (output.speaker or "").strip()
            audio_type, speaker = self._normalize_audio_metadata(
                audio_type=audio_type,
                speaker_kind=speaker_kind,
                speaker=speaker,
            )
            if audio_type != "dialogue":
                speaker_kind = "character"
            if audio_type == "dialogue" and speaker_kind == "character" and speaker:
                speaker = self._resolve_unit_speaker_label(speaker)
            narration_segment = self._derive_narration_segment(raw_line, audio_type)

            beats.append(
                VisualBeat(
                    beat_number=len(beats) + 1,
                    narration_segment=narration_segment,
                    visual_description=visual_description,
                    time_of_day=time_of_day,
                    scene_ref=self._canonical_scene_ref_for_menu_choice(resolved_scene_id),
                    audio_type=audio_type,
                    speaker=speaker,
                    speaker_kind=speaker_kind,
                    estimated_duration=0.0,
                )
            )

            identities_in_beat = re.findall(r"\{\{(.+?)\}\}", visual_description)
            for identity_id in identities_in_beat:
                char_name = identity_id.split("_", 1)[0] if "_" in identity_id else identity_id
                if char_name and char_name not in block_sticky_identities:
                    block_sticky_identities[char_name] = identity_id
                if char_name and char_name not in episode_sticky_identities:
                    episode_sticky_identities[char_name] = identity_id
            log(f"[Literal] 行 {content_index}/{total} -> {audio_type}")

        self._valid_identity_ids.clear()
        self._valid_identity_ids.update(episode_identity_ids)
        self._valid_prop_ids.clear()
        self._valid_prop_ids.update(episode_prop_ids)

        script = NarrationScript(
            episode_number=episode_num,
            title=getattr(episode, "title", f"第 {episode_num} 集"),
            beats=beats,
            total_duration_seconds=0.0,
        )
        report_progress(0.93, "保存脚本...")
        await self.cognee_store.persist_narration_script(script)
        report_progress(1.0, "完成")
        return script

    async def run_all_episodes(self) -> list[NarrationScript]:
        episodes = await self.sqlite_store.list_episodes()
        scripts: list[NarrationScript] = []
        for episode in episodes:
            scripts.append(await self.run(episode_num=episode.number))
        return scripts

    def _build_identity_menu_for_episode(self, episode_number: int) -> tuple[str, set[str]]:
        episode = self.sqlite_store.get_episode(episode_number)
        ep_identity_ids = set(episode.identity_ids) if episode and episode.identity_ids else set()
        if not ep_identity_ids:
            return "", set()

        lines = ["\n## 本集可用身份菜单"]
        valid_ids: set[str] = set()
        by_character: dict[str, list[str]] = {}
        for identity_id in sorted(ep_identity_ids):
            char_name = identity_id.split("_", 1)[0] if "_" in identity_id else identity_id
            by_character.setdefault(char_name, []).append(identity_id)
            valid_ids.add(identity_id)

        for char_name, ids in by_character.items():
            lines.append(f"### {char_name}")
            for identity_id in ids:
                lines.append(f"- `{identity_id}`")
        return "\n".join(lines) + "\n", valid_ids

    def _build_scene_menu_for_episode(self, episode: Any) -> str:
        scene_menu = list(getattr(episode, "scene_menu", []) or [])
        self._valid_scene_ids.clear()
        self._scene_menu_split.clear()
        for item in scene_menu:
            scene_id = str(getattr(item, "scene_id", "") or "").strip()
            if not scene_id:
                continue
            self._valid_scene_ids.add(scene_id)
            base_scene_id = str(getattr(item, "base_scene_id", "") or "").strip()
            variant_id = str(getattr(item, "variant_id", "") or "").strip()
            time_of_day = str(getattr(item, "time_of_day", "") or "").strip()
            if base_scene_id and (variant_id or time_of_day):
                self._scene_menu_split[scene_id] = (base_scene_id, variant_id, time_of_day)
        if not scene_menu:
            return "\n## 本集可用场景菜单\n- 无\n"
        lines = ["\n## 本集可用场景菜单"]
        for item in scene_menu:
            lines.append(f"- `{item.scene_id}`")
        return "\n".join(lines) + "\n"

    def _base_ids(self) -> set[str]:
        derived_ids = set(self._scene_menu_split)
        return {scene_id for scene_id in self._valid_scene_ids if scene_id not in derived_ids}

    def _allowed_scene_ids_for_block(self, base_id: str) -> set[str]:
        base_id = str(base_id or "").strip()
        if not base_id:
            return set()
        allowed = {base_id} if base_id in self._valid_scene_ids else set()
        allowed.update(
            scene_id
            for scene_id, (item_base, _variant, _time) in self._scene_menu_split.items()
            if item_base == base_id
        )
        return allowed

    def _canonical_scene_ref_for_menu_choice(self, scene_id: str) -> SceneRef | None:
        scene_id = str(scene_id or "").strip()
        if not scene_id:
            return None
        base_scene_id, variant_id, time_of_day = self._scene_menu_split.get(scene_id, ("", "", ""))
        if base_scene_id and (variant_id or time_of_day):
            return build_scene_ref(base_scene_id, variant_id)
        return build_scene_ref(scene_id)

    def _build_prop_menu_for_episode(self, episode: Any) -> str:
        prop_menu = list(getattr(episode, "prop_menu", []) or [])
        self._valid_prop_ids.clear()
        self._valid_prop_ids.update(item.prop_id for item in prop_menu if item.prop_id)
        if not prop_menu:
            return "\n## 本集可用道具菜单\n- 无\n"
        lines = ["\n## 本集可用道具菜单"]
        for item in prop_menu:
            scope = str(getattr(item, "scope", "") or "episode").strip()
            description = str(getattr(item, "description", "") or "").strip()
            meta = []
            if scope:
                meta.append(f"scope={scope}")
            suffix = f" ({', '.join(meta)})" if meta else ""
            desc_suffix = f" — {description}" if description else ""
            lines.append(f"- `{item.prop_id}`{suffix}{desc_suffix}")
        return "\n".join(lines) + "\n"

    @staticmethod
    def _normalize_match_text(value: str) -> str:
        text = str(value or "").strip()
        return re.sub(r"[\s\u3000·•．。,:：，、／/（）()\\\-_\[\]{}]+", "", text).lower()

    @classmethod
    def _contains_text(cls, haystack: str, needle: str) -> bool:
        normalized_needle = cls._normalize_match_text(needle)
        if not normalized_needle:
            return False
        return normalized_needle in cls._normalize_match_text(haystack)

    def _build_identity_metadata(self, episode_identity_ids: set[str]) -> dict[str, dict[str, Any]]:
        metadata: dict[str, dict[str, Any]] = {}
        for character in self.cognee_store.get_all_characters():
            aliases = [
                str(alias or "").strip()
                for alias in (getattr(character, "aliases", []) or [])
                if str(alias or "").strip()
            ]
            for identity in getattr(character, "identities", []) or []:
                identity_id = str(getattr(identity, "identity_id", "") or "").strip()
                if not identity_id or identity_id not in episode_identity_ids:
                    continue
                metadata[identity_id] = {
                    "character_name": str(getattr(character, "name", "") or "").strip(),
                    "character_aliases": aliases,
                    "identity_name": str(getattr(identity, "identity_name", "") or "").strip(),
                }
        return metadata

    def _build_prop_metadata(self, episode: Any) -> dict[str, dict[str, Any]]:
        global_props = {
            str(prop.name or "").strip(): prop
            for prop in self.cognee_store._props.values()
            if str(getattr(prop, "name", "") or "").strip()
        }
        metadata: dict[str, dict[str, Any]] = {}
        for item in list(getattr(episode, "prop_menu", []) or []):
            prop_id = str(getattr(item, "prop_id", "") or "").strip()
            if not prop_id:
                continue
            prop_obj = global_props.get(prop_id)
            aliases = []
            if prop_obj:
                aliases = [
                    str(alias or "").strip()
                    for alias in (getattr(prop_obj, "aliases", []) or [])
                    if str(alias or "").strip()
                ]
            metadata[prop_id] = {
                "aliases": aliases,
                "description": str(getattr(item, "description", "") or "").strip(),
            }
        return metadata

    def _format_identity_section(
        self, candidate_identity_ids: set[str], episode_identity_ids: set[str]
    ) -> str:
        if not candidate_identity_ids:
            return ""
        lines = ["## 当前场次候选身份"]
        grouped: dict[str, list[str]] = {}
        for identity_id in sorted(candidate_identity_ids):
            character_name = identity_id.split("_", 1)[0] if "_" in identity_id else identity_id
            grouped.setdefault(character_name, []).append(identity_id)
        for character_name in sorted(grouped):
            lines.append(f"### {character_name}")
            for identity_id in grouped[character_name]:
                marker = "" if identity_id in episode_identity_ids else "（非本集身份）"
                lines.append(f"- `{identity_id}`{marker}")
        return "\n".join(lines)

    def _format_prop_section(self, candidate_prop_ids: set[str]) -> str:
        if not candidate_prop_ids:
            return ""
        lines = ["## 当前场次候选道具"]
        for prop_id in sorted(candidate_prop_ids):
            lines.append(f"- `{prop_id}`")
        return "\n".join(lines)

    def _compile_scene_block_context(
        self,
        block: SceneBlock,
        block_index: int,
        episode: Any,
        episode_identity_ids: set[str],
        episode_identity_default_map: dict[str, str],
        episode_prop_ids: set[str],
        identity_metadata: dict[str, dict[str, Any]],
        prop_metadata: dict[str, dict[str, Any]],
        on_log: Optional[Callable[[str], None]] = None,
    ) -> SceneBlockContext:
        block_text = "\n".join(
            item for item in [block.header_line, *block.lines] if str(item or "").strip()
        )
        matched_identities_by_character: dict[str, list[str]] = {}
        speaker_candidates: set[str] = set()
        for line in block.lines:
            speaker, _ = self._split_dialogue_line(line)
            if speaker:
                speaker_candidates.add(speaker)
        explicit_character_tokens = set(block.characters) | speaker_candidates
        explicit_character_tokens = {
            str(token or "").strip()
            for token in explicit_character_tokens
            if str(token or "").strip()
        }

        for identity_id in sorted(episode_identity_ids):
            meta = identity_metadata.get(identity_id, {})
            character_name = str(meta.get("character_name", "") or "").strip()
            aliases = list(meta.get("character_aliases", []) or [])
            identity_name = str(meta.get("identity_name", "") or "").strip()
            tokens = [character_name, *aliases, identity_id, identity_name]
            matched = any(self._contains_text(block_text, token) for token in tokens if token)
            matched = matched or any(
                self._contains_text(token, character_name)
                or any(self._contains_text(token, alias) for alias in aliases)
                for token in explicit_character_tokens
                if character_name
            )
            if not matched or not character_name:
                continue
            matched_identities_by_character.setdefault(character_name, []).append(identity_id)

        candidate_identity_ids: set[str] = set()
        for character_name, identity_ids in matched_identities_by_character.items():
            if len(identity_ids) == 1:
                candidate_identity_ids.update(identity_ids)
                continue
            scored = []
            for identity_id in identity_ids:
                meta = identity_metadata.get(identity_id, {})
                identity_name = str(meta.get("identity_name", "") or "").strip()
                score = 0
                if identity_name and self._contains_text(block_text, identity_name):
                    score += 2
                if identity_name and self._contains_text(block.header_line, identity_name):
                    score += 1
                scored.append((score, identity_id))
            max_score = max(score for score, _ in scored)
            narrowed = [
                identity_id for score, identity_id in scored if score == max_score and score > 0
            ]
            if narrowed:
                candidate_identity_ids.update(narrowed)
            else:
                default_identity_id = str(
                    episode_identity_default_map.get(character_name, "") or ""
                ).strip()
                if default_identity_id and default_identity_id in identity_ids:
                    candidate_identity_ids.add(default_identity_id)
                    if on_log:
                        on_log(
                            f"[Literal Block] 默认身份回退: "
                            f"{character_name} -> {default_identity_id}"
                        )
                else:
                    candidate_identity_ids.update(identity_ids)
                    if on_log:
                        on_log(
                            f"[Literal Block] 身份无法区分（无 identity_name 文本证据）: "
                            f"{character_name} -> {', '.join(sorted(identity_ids))}"
                        )

        identity_fallback_reason = ""
        if not candidate_identity_ids and explicit_character_tokens:
            identity_fallback_reason = "身份候选为空，回退本集身份池: " + ", ".join(
                sorted(explicit_character_tokens)
            )

        candidate_prop_ids: set[str] = set()
        for prop_id in sorted(episode_prop_ids):
            meta = prop_metadata.get(prop_id, {})
            aliases = list(meta.get("aliases", []) or [])
            tokens = [prop_id, *aliases]
            if any(self._contains_text(block_text, token) for token in tokens if token):
                candidate_prop_ids.add(prop_id)

        return SceneBlockContext(
            candidate_identity_ids=candidate_identity_ids,
            candidate_prop_ids=candidate_prop_ids,
            identity_fallback_reason=identity_fallback_reason,
            identity_section=self._format_identity_section(
                candidate_identity_ids, episode_identity_ids
            ),
            prop_section=self._format_prop_section(candidate_prop_ids),
        )

    @staticmethod
    def _parse_scene_block_header(line: str) -> dict[str, Any] | None:
        blocks = parse_scene_blocks([(line or "").strip()])
        if not blocks:
            return None
        block = blocks[0]
        if not block.header_line or not block.location:
            return None
        return {
            "header_line": block.header_line,
            "location": block.location,
            "time_of_day": normalize_time_of_day(block.time_of_day),
            "interior_exterior": block.interior_exterior,
            "characters": list(block.characters),
        }

    @staticmethod
    def _parse_scene_header(line: str) -> dict[str, str] | None:
        block_header = LiteralScriptWritingWorkflow._parse_scene_block_header(line)
        if block_header:
            return {
                "location": str(block_header.get("location") or "").strip(),
                "time_of_day": str(block_header.get("time_of_day") or "").strip(),
            }

        parsed = parse_location_header((line or "").strip())
        if not parsed:
            return None
        location, time_of_day, _interior_exterior = parsed
        return {
            "location": location,
            "time_of_day": normalize_time_of_day(time_of_day),
        }

    @classmethod
    def _build_scene_blocks(cls, lines: list[str]) -> list[SceneBlock]:
        parsed_blocks = parse_scene_blocks(lines)
        return [
            SceneBlock(
                header_line=block.header_line,
                location=block.location,
                time_of_day=normalize_time_of_day(block.time_of_day),
                interior_exterior=block.interior_exterior,
                characters=list(block.characters),
                lines=list(block.lines),
            )
            for block in parsed_blocks
            if block.header_line or block.lines
        ]

    @staticmethod
    def _build_scene_line_contexts(
        blocks: list[SceneBlock],
        window: int = 2,
        source_lines: list[str] | None = None,
    ) -> list[SceneLineContext]:
        entries: list[SceneLineContext] = []
        source_cursor = 0
        source_lines = list(source_lines or [])
        for block in blocks:
            scene_lines = [line for line in block.lines if line.strip()]
            for idx, raw_line in enumerate(scene_lines):
                source_line_number = 0
                if source_lines:
                    for source_idx in range(source_cursor, len(source_lines)):
                        if source_lines[source_idx] == raw_line:
                            source_line_number = source_idx + 1
                            source_cursor = source_idx + 1
                            break
                prev_window = scene_lines[max(0, idx - window) : idx]
                next_line = scene_lines[idx + 1] if idx + 1 < len(scene_lines) else ""
                entries.append(
                    SceneLineContext(
                        raw_line=raw_line,
                        scene_block=block,
                        prev_window=prev_window,
                        next_line=next_line,
                        source_line_number=source_line_number,
                    )
                )
        return entries

    @staticmethod
    def _split_dialogue_line(line: str) -> tuple[str, str]:
        match = DIALOGUE_RE.match((line or "").strip())
        if not match:
            return "", ""
        speaker = re.sub(r"[（(].*?[）)]", "", match.group("speaker")).strip()
        speech = (match.group("speech") or "").strip()
        return speaker, speech

    @classmethod
    def _derive_narration_segment(cls, raw_line: str, audio_type: str) -> str:
        line = (raw_line or "").strip()
        if audio_type == "silence":
            return ""
        if audio_type == "dialogue":
            _, speech = cls._split_dialogue_line(line)
            if speech:
                return speech
        return line

    def _normalize_audio_type_for_mode(self, audio_type: str) -> str:
        normalized = (audio_type or "silence").strip()
        if self.audio_type_mode == "narrated" and normalized == "silence":
            return "narration"
        return normalized

    @staticmethod
    def _normalize_audio_metadata(
        *,
        audio_type: str,
        speaker_kind: str,
        speaker: str,
    ) -> tuple[str, str]:
        normalized_type = (audio_type or "silence").strip()
        normalized_speaker_kind = (speaker_kind or "character").strip()
        normalized_speaker = (speaker or "").strip()
        if normalized_type == "dialogue" and normalized_speaker_kind == "non_character":
            return "narration", ""
        if normalized_type in {"silence", "narration"}:
            return normalized_type, ""
        return normalized_type, normalized_speaker

    @staticmethod
    def _content_filter_log_messages(
        *,
        content_index: int,
        total: int,
        line_ctx: SceneLineContext,
        error: BaseException,
    ) -> list[str]:
        prev_line = line_ctx.prev_window[-1] if line_ctx.prev_window else ""
        current_line = line_ctx.raw_line
        next_line = line_ctx.next_line
        source_line_number = int(getattr(line_ctx, "source_line_number", 0) or 0)
        block = line_ctx.scene_block
        source_line_label = (
            f"源文本第 {source_line_number} 行，" if source_line_number > 0 else ""
        )
        context_text = "\n".join([prev_line, current_line, next_line])
        hint_matches = _content_filter_hint_matches(context_text)
        messages = [
            (
                f"[Literal][ERROR] 第 {content_index}/{total} 行生成失败："
                "上游文本模型触发内容安全过滤(content_filter)，未返回可解析剧本内容。"
            ),
            (
                f"[Literal][ERROR] 需修改行（{source_line_label}内容行 {content_index}/{total}）: "
                f"{_short_log_text(current_line, limit=300)}"
            ),
        ]
        if block.header_line or block.location:
            messages.append(
                "[Literal][ERROR] 所属场次: "
                f"{_short_log_text(block.header_line or block.location, limit=180)}"
            )
        if prev_line or next_line:
            messages.append(
                "[Literal][ERROR] 前后文: "
                f"上一行={_short_log_text(prev_line, limit=180) or '无'}；"
                f"下一行={_short_log_text(next_line, limit=180) or '无'}"
            )
        if hint_matches:
            messages.append(
                f"[Literal][ERROR] 第 {content_index}/{total} 行附近包含疑似高风险表达: "
                + "；".join(hint_matches)
            )
        else:
            messages.append(
                f"[Literal][ERROR] 第 {content_index}/{total} 行附近未识别到明确疑似词，"
                "但模型仍判定输入或潜在输出不符合安全策略。"
            )
        messages.append(
            "[Literal][ERROR] 建议：弱化该行及前后文中的血腥、暴力、胁迫、裸露等表达，"
            "或在 RelayClaw 中将该内部文本模型切换到更适合剧本创作的上游模型后重试。"
        )
        messages.append(
            "[Literal][ERROR] 说明：上游模型不会返回精确违规规则；以上行号和疑似表达"
            "是 Dramaclaw 根据本次请求上下文本地定位，供修改剧本时参考。"
        )
        messages.append(f"[Literal][ERROR] 原始模型错误: {_short_log_text(str(error), limit=180)}")
        return messages

    def _audio_type_mode_instruction(self) -> str:
        if self.audio_type_mode != "narrated":
            return (
                "- 当前项目使用 2.0 短剧逐行模式："
                "可按原行性质输出 silence / narration / dialogue。"
            )
        return (
            "- 当前项目是解说剧：沿用 1.0 音频口径，audio_type 只能是 narration / dialogue，"
            "不要输出 silence；非明确角色对白的解说稿行一律输出 narration。"
        )

    def _resolve_scene_id(self, location_label: str, episode: Any) -> str:
        location = (location_label or "").strip()
        if not location:
            return ""
        if not self._valid_scene_ids:
            scene_menu = list(getattr(episode, "scene_menu", []) or [])
            self._valid_scene_ids.update(item.scene_id for item in scene_menu if item.scene_id)
        base_ids = self._base_ids()
        for scene_id in base_ids:
            if scene_id == location:
                return scene_id
        for scene_id in base_ids:
            if location in scene_id or scene_id in location:
                return scene_id
        return ""

    def _resolve_unit_speaker_label(self, speaker: str) -> str:
        normalized = re.sub(r"[（(].*?[）)]", "", (speaker or "")).strip()
        if not normalized:
            return ""
        if normalized in self._valid_identity_ids:
            return normalized
        exact_base = [iid for iid in self._valid_identity_ids if iid.split("_", 1)[0] == normalized]
        if exact_base:
            for candidate in exact_base:
                if candidate.endswith("_默认"):
                    return candidate
            return exact_base[0]
        return normalized

def create_literal_script_writing_workflow(
    cognee_store: Any,
    sqlite_store: Any | None = None,
    output_dir: str = "",
    genre: str = "",
    story_setting: str = "",
    audio_type_mode: str = "literal",
) -> LiteralScriptWritingWorkflow:
    del genre, story_setting
    return LiteralScriptWritingWorkflow(
        cognee_store=cognee_store,
        sqlite_store=sqlite_store or cognee_store,
        output_dir=output_dir,
        audio_type_mode=audio_type_mode,
    )
