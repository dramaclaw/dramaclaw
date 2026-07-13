"""Identity Planner — 批量为所有剧集规划角色身份。

在剧集工作台中一次性运行，为每集分析并落库角色身份。

当前流程（每集）：
1. 预筛本集出场角色
2. Pass A: 分析每个角色的现实主线默认身份
3. Pass B: 分析默认身份之外的其他非默认身份
4. resolve / create 并写回 episode.identity_ids + episode.identity_default_map
"""

import re
from typing import Optional, Callable, TYPE_CHECKING

from pydantic import BaseModel, Field, ValidationInfo, field_validator, model_validator

from pydantic_ai import Agent
from novelvideo.config import (
    get_newapi_text_pydantic_model,
    get_newapi_text_pydantic_model_settings,
)
from novelvideo.models import CharacterIdentity
from novelvideo.shared.env_guard import preserve_st_env

if TYPE_CHECKING:
    from novelvideo.cognee import CogneeStore
    from novelvideo.models import NovelEpisode

# =============================================================================
# Output Schema (AI structured output)
# =============================================================================


def _normalize_age_group_value(v: str) -> str:
    if not v:
        return ""
    v = v.strip().lower()
    if v in ("child", "youth", "middle", "elder"):
        return v
    mapping = {
        "儿童": "child", "幼儿": "child", "幼年": "child",
        "童年": "child", "孩童": "child",
        "少年": "youth", "teenager": "youth",
        "青年": "youth", "young": "youth", "adult": "youth",
        "中年": "middle", "中老年": "middle",
        "老年": "elder", "老人": "elder", "old": "elder",
    }
    return mapping.get(v, "")


def _merge_age_group_values(existing: str, incoming: str) -> str:
    existing_norm = _normalize_age_group_value(existing)
    incoming_norm = _normalize_age_group_value(incoming)
    if existing_norm and incoming_norm and existing_norm != incoming_norm:
        raise ValueError(f"冲突 age_group: {existing_norm!r} vs {incoming_norm!r}")
    return existing_norm or incoming_norm


class IdentityRequirement(BaseModel):
    """AI 分析出的单个身份需求。"""
    character_name: str = Field(description="角色名（使用主名称）")
    visual_state: str = Field(description="故事时期或造型分支名称，如 '战神时期'、'皇后宫装'、'皇后便装'、'嫡女时期'")
    age_group: str = Field(
        default="",
        description="该身份对应的年龄段，取值: child/youth/middle/elder。年龄变体必须填写；普通同龄换装留空字符串",
    )
    reason: str = Field(description="一句话原因")

    @field_validator("age_group", mode="before")
    @classmethod
    def normalize_age_group(cls, v: str) -> str:
        return _normalize_age_group_value(v)


class DefaultIdentityRequirement(BaseModel):
    """Pass A：每个角色的现实主线默认身份。"""
    character_name: str = Field(description="角色名（使用主名称）")
    visual_state: str = Field(description="本集现实主线中的默认视觉形态名称")
    age_group: str = Field(
        default="",
        description="该默认身份对应的年龄段，取值: child/youth/middle/elder。若 identity 本身是明确年龄阶段，必须填写；否则留空字符串",
    )
    reason: str = Field(description="一句话原因")

    @field_validator("age_group", mode="before")
    @classmethod
    def normalize_age_group(cls, v: str) -> str:
        return _normalize_age_group_value(v)


class EpisodeDefaultIdentities(BaseModel):
    """Pass A 的输出：每个出场角色的默认身份。"""
    defaults: list[DefaultIdentityRequirement] = Field(
        default_factory=list,
        description="每个出场角色的现实主线默认身份（每人一个）"
    )


class EpisodeIdentityRequirements(BaseModel):
    """Pass B 的输出：其他非默认身份。"""
    requirements: list[IdentityRequirement] = Field(
        default_factory=list,
        description="本集需要的其他非默认身份列表（不含默认身份）"
    )


_APPEARANCE_SCHEMA_TOKENS = (
    "appearance_details",
    "face_description",
    "age_group",
    "body_type",
)
_APPEARANCE_REASONING_RE = re.compile(
    r"(?:\blet(?:'s| us)\b|\breason(?:ing)?\b|step by step|\banalysis\s*:|"
    r"\bthinking\s*:|\bcount\s*:|check (?:the )?length|that's about|\bperfect\s*\.)",
    re.IGNORECASE,
)


def _appearance_corruption_reason(value: object, field_name: str) -> str | None:
    """Return a high-confidence reason when an appearance string is polluted."""
    text = str(value or "").strip()
    if not text:
        return None
    lowered = text.casefold()
    if "\ufffd" in text:
        return "包含 Unicode replacement character"
    if any(token in lowered for token in _APPEARANCE_SCHEMA_TOKENS):
        return "包含结构化输出字段名"
    if lowered == "/* empty */":
        return "包含模型空值哨兵"
    if "```" in text or "<tool" in lowered or "</tool" in lowered or "@returns" in lowered:
        return "包含工具调用框架"
    if field_name in {"face_description", "body_type"} and ("\n" in text or "\r" in text):
        return "短描述包含多行内容"
    if _APPEARANCE_REASONING_RE.search(text):
        return "包含模型推理文本"
    return None


class AppearanceDescription(BaseModel):
    """AI 生成的身份外观描述。"""
    appearance_details: str = Field(
        description="外观描述（服装、配饰、发型、整体造型状态，50-80字，不含动作表情）"
    )
    face_description: str = Field(
        default="",
        description="面部描述（仅当身份涉及年龄变化时填写：年龄特征、脸型、五官比例，不含服装）",
    )
    age_group: str = Field(
        default="",
        description="仅当身份涉及年龄变化时填写该身份的年龄段，取值: child/youth/middle/elder；普通换装留空字符串",
    )
    body_type: str = Field(
        default="",
        description="仅当身份涉及年龄变化时填写体型描述（如'矮小圆润的幼童体型'、'佝偻消瘦的老人体型'），普通换装不填",
    )

    @field_validator("appearance_details", "face_description", "body_type", mode="before")
    @classmethod
    def strip_description(cls, value: object) -> object:
        if value is None:
            return ""
        if isinstance(value, str):
            return value.strip()
        return value

    @field_validator("appearance_details", "face_description", "body_type")
    @classmethod
    def validate_description(cls, value: str, info) -> str:
        field_name = info.field_name
        if reason := _appearance_corruption_reason(value, field_name):
            raise ValueError(f"{field_name} {reason}")
        if field_name == "appearance_details":
            if not 10 <= len(value) <= 200:
                raise ValueError("appearance_details 长度必须为 10–200 字符")
        elif field_name == "face_description" and value and not 10 <= len(value) <= 100:
            raise ValueError("face_description 长度必须为 10–100 字符")
        elif field_name == "body_type" and value and not 2 <= len(value) <= 80:
            raise ValueError("body_type 长度必须为 2–80 字符")
        return value

    @field_validator("age_group", mode="before")
    @classmethod
    def normalize_age_group(cls, v: str) -> str:
        return _normalize_age_group_value(v)

    @model_validator(mode="after")
    def validate_age_variant_fields(self, info: ValidationInfo):
        variant_fields = (self.face_description, self.age_group, self.body_type)
        if any(variant_fields) and not all(variant_fields):
            raise ValueError(
                "face_description、age_group、body_type 必须同时为空或同时填写"
            )
        context = info.context if isinstance(info.context, dict) else {}
        planned_age_group = _normalize_age_group_value(
            context.get("planned_age_group", "")
        )
        if planned_age_group and self.age_group != planned_age_group:
            raise ValueError(
                f"已规划 age_group={planned_age_group}，外观输出必须填写匹配的年龄变体字段"
            )
        return self


class EpisodeCastList(BaseModel):
    """AI 从原文中筛选出的出场角色列表。"""
    character_names: list[str] = Field(
        description="本集中实际出场的角色名列表（使用主名称）"
    )


APPEARANCE_GENERATION_PROMPT = """# 你是专业的影视服装造型师

## 任务
为虚构影视作品中的角色设计服装造型方案。

## 要求
- appearance_details: 描述服装款式、面料材质、配饰、发型造型，50-80字，**不含**人物外貌、动作和表情
- face_description: **仅当身份涉及年龄变化**（幼年、少年、老年等）时填写面部描述，30-50字
  - 包括：年龄特征、脸型轮廓、五官比例
  - 不含：服装、配饰、动作、表情
  - 普通换装身份（同年龄段）不填此项
- body_type: **仅当身份涉及年龄变化**时填写体型描述
  - 包括：身高、体型、体态特征
  - 普通换装身份（同年龄段）不填此项
- 使用中文
- 具体、可视化，适合影视美术部门制作参考

## 示例
- appearance_details: "月白色麻布僧袍，腰系粗麻绳，颈戴木质佛珠，脚穿草鞋，光头造型"
- appearance_details: "大红织金嫁衣凤冠霞帔，金步摇垂珠，额间贴花钿，盘发高髻"
- face_description（幼年）: "六七岁幼童，圆润小脸，大而明亮的杏眼，小巧鼻子，婴儿肥双颊"
- face_description（老年）: "七旬老者，面颊消瘦多皱纹，眼窝深陷，颧骨突出，鬓发花白稀疏"
- body_type（幼年）: "矮小圆润的幼童体型，身高仅及成人腰部"
- body_type（老年）: "佝偻消瘦的老人体型，身高略矮，背部微驼"
"""


DEFAULT_IDENTITY_PROMPT = """# 你是影视角色主线形态分析师

## 任务
为本集每个出场角色确定一个**现实主线默认身份**。

## 什么是"默认身份"
- 本集中该角色在**非回忆、非闪回、非梦境**的现实场景中，最常出现的稳定视觉形态
- 一个角色只有一个默认身份
- 如果角色在本集只有一种形态，那它就是默认身份

## 规则
- 优先复用已有身份名称，不要新建近义词
- 命名优先使用人生阶段/社会阶段/年龄阶段（如"大厂时期"、"中年时期"、"学生时期"、"幼年时期"）
- 只有在**同一时期内部**长期稳定存在两套反复出现的造型时，才使用造型分支名（如"职场装束"、"居家装束"）
- 不要把服装类别直接当作一级默认身份名；如果它本质上对应一个人生阶段，应优先命名为该阶段
- 不用剧情语义词（不用"回归时期"、"觉醒时期"）
- 不用短期处境词（不用"落魄时期"、"囚禁中"）
- 不要包含角色名（用"中年时期"而非"杜晨_中年时期"）
- 输出时同时给出 age_group
  - 如果 visual_state 明确是年龄阶段（如"孩童时期"、"少年时期"、"中年时期"、"老年时期"），age_group 必填
  - 普通同龄造型分支（如"职场装束"、"居家装束"）可留空
"""


OTHER_IDENTITY_PROMPT = """# 你是影视视觉身份分析师

## 任务
基于本集全文，找出各角色在默认身份**之外**还需要的其他身份。

## 什么是"其他身份"
- 任何不同于默认身份、且需要独立稳定视觉基底的形态
- 包括但不限于：
  - 回忆/闪回中的不同年龄形态（幼年、少年、老年）
  - 同一时期内长期且反复出现的另一套稳定造型（如宫装 vs 便装、职场装束 vs 居家装束）
  - 电视画面/照片中的历史形象
  - 同集内明确长期分离的另一阶段形态

## 什么不是"其他身份"
- 一次性状态（脏了、受伤、淋湿）
- 短期剧情处境（待嫁、落魄、囚禁中）
- 单次动作或镜头语言
- 只是情绪变化、站位变化、构图变化

## 硬约束
- **年龄变体必须独立身份**：脸型、五官、身高完全不同，即使只出现一两场
- 不要把这一步理解成"只补年龄身份"
- 只要和默认身份不是同一个稳定视觉基底，就应该列出
- 命名优先使用时期/阶段名；只有在同一时期内部区分多套长期造型时，才使用"装束/便装/正装"这类造型名
- 默认身份已经处理完了，不要重复输出
- 优先复用已有身份名称
- 输出时同时给出 age_group
  - 年龄变体（孩童/少年/中年/老年）必须填写对应 age_group
  - 普通同龄造型分支可留空
"""




# =============================================================================
# IdentityPlanner
# =============================================================================


class IdentityPlanner:
    """批量为所有剧集规划角色身份。

    按集数顺序处理每集，后面的集数能看到前面新建的身份，自然复用。

    示例:
        >>> planner = IdentityPlanner(cognee_store)
        >>> results = await planner.plan_all_episodes(episodes)
        >>> # results = {1: 2, 2: 0, 3: 1}  # {集数: 新建身份数}
    """

    def __init__(self, cognee_store: "CogneeStore"):
        self.cognee_store = cognee_store
        self.auto_promoted_characters: list[str] = []

    @staticmethod
    def _normalize_visual_state_for_char(char_name: str, visual_state: str) -> str:
        """将 `杜晨_中年时期` 这类带角色前缀的 visual_state 归一为 `中年时期`。"""
        normalized_char = str(char_name or "").strip()
        normalized_state = str(visual_state or "").strip()
        prefix = normalized_char + "_"
        if normalized_char and normalized_state.startswith(prefix):
            return normalized_state[len(prefix):].strip()
        return normalized_state

    @staticmethod
    def _infer_age_group_from_visual_state(visual_state: str) -> str:
        """仅从 identity 名称本身推断明确的年龄变体。"""
        text = str(visual_state or "").strip()
        if not text:
            return ""

        child_tokens = ("幼年", "孩童", "儿童", "童年", "幼童", "孩提")
        youth_tokens = ("少年", "学生时期")
        middle_tokens = ("中年",)
        elder_tokens = ("老年", "老人", "老者")

        if any(token in text for token in child_tokens):
            return "child"
        if any(token in text for token in youth_tokens):
            return "youth"
        if any(token in text for token in middle_tokens):
            return "middle"
        if any(token in text for token in elder_tokens):
            return "elder"
        return ""

    def _seed_identity_structured_fields(
        self,
        char,
        visual_state: str,
        age_group: str = "",
    ) -> tuple[str, str]:
        """使用 AI 输出的 age_group，并做最小必要的一致性校验。"""
        normalized_age_group = _normalize_age_group_value(age_group)
        inferred_age_group = self._infer_age_group_from_visual_state(visual_state)
        if inferred_age_group and normalized_age_group and inferred_age_group != normalized_age_group:
            raise ValueError(
                f"身份 `{visual_state}` 的 age_group 冲突: AI={normalized_age_group}, 名称推断={inferred_age_group}"
            )
        final_age_group = normalized_age_group or inferred_age_group
        if not inferred_age_group and final_age_group == getattr(char, "age_group", ""):
            final_age_group = ""
        inferred_fish_voice = ""
        if final_age_group:
            from novelvideo.config import get_fish_voice_id

            inferred_fish_voice = get_fish_voice_id(final_age_group, char.gender)
        return final_age_group, inferred_fish_voice

    @staticmethod
    def _identity_model(model_env: str, default_model: str = "gemini-3.5-flash"):
        return get_newapi_text_pydantic_model(model_env, default_model)

    @staticmethod
    def _identity_model_settings(
        thinking_env: str,
        default_thinking_level: str,
    ) -> dict | None:
        return get_newapi_text_pydantic_model_settings(
            thinking_env,
            default_thinking_level,
        )

    async def plan_single_episode(
        self,
        episode: "NovelEpisode",
        on_log: Optional[Callable] = None,
    ) -> tuple[int, int]:
        """规划单集身份。完成后自动保存缓存。

        Returns:
            (new_count, resolved_count): 新建身份数 和 总解析身份数
        """
        self.auto_promoted_characters = []
        content_text = await self.cognee_store.load_episode_content(episode.number)
        if not content_text or not content_text.strip():
            return 0, 0

        # 预筛出场角色（只调一次，后续复用）
        all_chars = self.cognee_store.get_all_characters()
        all_names = [c.name for c in all_chars]
        cast_names, graph_context = await self._filter_cast(all_names, content_text, episode, on_log)
        if not cast_names:
            raise ValueError("Pass 0 未能稳定识别本集出场角色，已中止规划以避免污染已有身份结果")

        # Pass A: 默认身份分析 + resolve
        default_requirements = await self._analyze_default_identities(
            episode, on_log,
            cast_names=cast_names,
            content_text=content_text,
            graph_context=graph_context,
        )
        new_count = 0
        resolved_ids: list[str] = []
        identity_default_map: dict[str, str] = {}

        if default_requirements.defaults:
            default_as_requirements = EpisodeIdentityRequirements(
                requirements=[
                    IdentityRequirement(
                        character_name=d.character_name,
                        visual_state=d.visual_state,
                        age_group=d.age_group,
                        reason=d.reason,
                    )
                    for d in default_requirements.defaults
                ]
            )
            default_new, resolved_ids, resolved_identity_map = await self._resolve_requirements(
                episode.number, default_as_requirements, on_log
            )
            new_count += default_new
            for d in default_requirements.defaults:
                char_name = self.cognee_store.resolve_name(d.character_name) or d.character_name
                normalized_visual_state = self._normalize_visual_state_for_char(
                    char_name,
                    d.visual_state,
                )
                identity_id = resolved_identity_map.get((char_name, normalized_visual_state))
                if identity_id:
                    identity_default_map[char_name] = identity_id
                    if on_log:
                        on_log(f"  默认身份: {char_name} -> {identity_id}")

        canonical_cast_names = list(
            dict.fromkeys(
                (self.cognee_store.resolve_name(name) or name).strip()
                for name in cast_names
                if str(name or "").strip()
            )
        )
        missing_default_chars = [
            char_name
            for char_name in canonical_cast_names
            if not identity_default_map.get(char_name)
        ]
        if missing_default_chars:
            if on_log:
                on_log(
                    f"[EP{episode.number:03d}] Pass A 默认身份缺失: "
                    + ", ".join(missing_default_chars)
                )
            raise ValueError(
                "Pass A 默认身份覆盖不完整: "
                + ", ".join(missing_default_chars)
            )

        # Pass B: 其他非默认身份分析 + resolve
        special_requirements = await self._analyze_special_identities(
            episode, on_log,
            cast_names=cast_names,
            content_text=content_text,
            graph_context=graph_context,
            already_resolved=resolved_ids,
        )
        if special_requirements.requirements:
            special_new, special_ids, _ = await self._resolve_requirements(
                episode.number, special_requirements, on_log
            )
            new_count += special_new
            resolved_seen = set(resolved_ids)
            for identity_id in special_ids:
                if identity_id in resolved_seen:
                    continue
                resolved_ids.append(identity_id)
                resolved_seen.add(identity_id)

        # 保存
        if resolved_ids:
            char_names = list(dict.fromkeys(
                iid.split("_", 1)[0] for iid in resolved_ids
            ))
            await self.cognee_store.update_episode(
                episode.number,
                identity_ids=resolved_ids,
                character_names=char_names,
                identity_default_map=identity_default_map,
            )

        return new_count, len(resolved_ids)

    async def plan_all_episodes(
        self,
        episodes: list["NovelEpisode"],
        on_log: Optional[Callable] = None,
        on_progress: Optional[Callable] = None,
    ) -> dict[int, int]:
        """批量规划所有剧集的身份。按集数顺序处理。

        Returns:
            {集数: 新建身份数；失败时为 -1}
        """
        results = {}
        sorted_eps = sorted(episodes, key=lambda e: e.number)

        for i, episode in enumerate(sorted_eps):
            if on_progress:
                on_progress(
                    (i + 1) / len(sorted_eps),
                    f"规划第 {episode.number} 集身份..."
                )
            try:
                new_count, resolved_count = await self.plan_single_episode(episode, on_log)
                results[episode.number] = new_count
                if on_log:
                    on_log(f"[EP{episode.number:03d}] 完成, 新建 {new_count} / 复用 {resolved_count - new_count} 个身份")
            except Exception as e:
                results[episode.number] = -1
                if on_log:
                    on_log(f"[EP{episode.number:03d}] 失败: {e}")

        return results

    async def _filter_cast(
        self,
        all_names: list[str],
        content_text: str,
        episode: "NovelEpisode",
        on_log: Optional[Callable] = None,
    ) -> tuple[list[str], str]:
        """用 cognee 图谱 + AI 从原文中筛选本集实际出场的角色（含别名解析）。

        利用 cognee.search 的图谱能力自动解析别名关系（如"陛下"→萧玦）。

        Returns:
            (filtered_names, graph_context) — 筛选后的角色名列表 + 图谱上下文文本
        """
        graph_context = ""
        try:
            with preserve_st_env():
                import cognee
                from cognee.api.v1.search import SearchType

            self.cognee_store._set_cognee_context(verbose=True)

            # 获取与本集相关的图谱上下文（人物关系、别名、背景信息）
            try:
                graph_results = await cognee.search(
                    query_text=f"第{episode.number}集出场的人物角色，以及他们的别名、称谓和关系",
                    query_type=SearchType.GRAPH_COMPLETION,
                    datasets=[self.cognee_store.dataset_name],
                    only_context=True,
                    top_k=20,
                )
                if graph_results:
                    parts = []
                    for item in graph_results:
                        if hasattr(item, 'search_result'):
                            parts.append(str(item.search_result))
                        elif isinstance(item, dict):
                            parts.append(str(item.get('search_result', item)))
                        else:
                            parts.append(str(item))
                    graph_context = "\n".join(parts)
            except Exception as e:
                if on_log:
                    on_log(f"[EP{episode.number:03d}] 图谱上下文获取失败（非致命）: {e}")

            # 用 AI 结构化输出筛选出场角色（结合图谱上下文）
            graph_section = ""
            if graph_context:
                graph_section = f"""

以下是知识图谱中的人物关系信息（包含别名和称谓解析，如"陛下"→某角色名）：
---
{graph_context[:4000]}
---
利用上述图谱信息，将原文中的称谓/别名解析为角色主名。
"""

            cast_agent = Agent(
                self._identity_model("IDENTITY_PLANNER_CAST_MODEL"),
                model_settings=self._identity_model_settings(
                    "IDENTITY_PLANNER_CAST_THINKING_LEVEL",
                    "low",
                ),
                output_type=EpisodeCastList,
            )
            cast_result = await cast_agent.run(f"""以下是全部已知角色：
{chr(10).join(all_names)}
{graph_section}
请根据第{episode.number}集原文，列出本集中**被提及**的角色。
只要角色名或其别名/称谓在原文中出现（无论是直接出场、回忆、闪回、被叙述者提及），都算出场。
注意：返回角色主名，不要返回别名。

原文：
{content_text}""")
            cast = cast_result.output
            filtered = self._normalize_cast_names(cast.character_names)
            if on_log:
                on_log(f"[EP{episode.number:03d}] 图谱+AI 筛选出场角色: {', '.join(filtered)}")
            return filtered, graph_context
        except Exception as e:
            if on_log:
                on_log(f"[EP{episode.number:03d}] AI 筛选出场角色失败: {e}")
            raise RuntimeError(f"Pass 0 出场角色筛选失败: {e}") from e

    def _build_character_info(self, characters: list[str]) -> str:
        """构建角色基础信息 + 已有身份信息文本。"""
        lines = []
        for char_name in characters:
            resolved = self.cognee_store.resolve_name(char_name)
            char = self.cognee_store.get_character(resolved)
            if char:
                lines.append(f"### {char.name}")
                base_attrs = []
                if char.gender:
                    base_attrs.append(f"性别: {char.gender}")
                if char.age_group:
                    base_attrs.append(f"默认年龄段: {char.age_group}")
                if char.face_prompt:
                    base_attrs.append(f"默认面部: {char.face_prompt}")
                if char.body_type:
                    base_attrs.append(f"体型: {char.body_type}")
                if base_attrs:
                    lines.append(f"基础信息: {', '.join(base_attrs)}")
                if char.identities:
                    for ident in char.identities:
                        desc = ident.appearance_details or "无描述"
                        extra = ""
                        if ident.face_prompt:
                            extra = f" [身份级面容: {ident.face_prompt[:30]}, 年龄段={ident.age_group}]"
                        lines.append(f"- `{ident.identity_id}`: {desc}{extra}")
                else:
                    lines.append("- （无已有身份）")
                lines.append("")
            else:
                lines.append(f"### {resolved or char_name}")
                lines.append("- （无已有身份）")
                lines.append("")
        return "\n".join(lines)

    def _normalize_cast_names(self, names: list[str]) -> list[str]:
        """将主名/别名统一映射成主名并去重。"""
        normalized: list[str] = []
        seen: set[str] = set()
        for raw_name in names:
            name = str(raw_name or "").strip()
            if not name:
                continue
            resolved = (self.cognee_store.resolve_name(name) or name).strip()
            if not resolved or resolved in seen:
                continue
            if self.cognee_store.get_character(resolved) is None:
                continue
            normalized.append(resolved)
            seen.add(resolved)
        return normalized

    def _validate_default_requirements(
        self,
        defaults: list[DefaultIdentityRequirement],
        cast_names: list[str],
        on_log: Optional[Callable] = None,
    ) -> list[DefaultIdentityRequirement]:
        """确保 Pass A 输出满足每角色唯一默认身份。"""
        canonical_cast_names = self._normalize_cast_names(cast_names)
        cast_set = set(canonical_cast_names)
        seen_char_to_item: dict[str, DefaultIdentityRequirement] = {}

        for item in defaults:
            char_name = (self.cognee_store.resolve_name(item.character_name) or item.character_name).strip()
            visual_state = self._normalize_visual_state_for_char(
                char_name,
                str(item.visual_state or "").strip(),
            )
            if not char_name or not visual_state:
                continue
            if cast_set and char_name not in cast_set:
                continue
            existing_item = seen_char_to_item.get(char_name)
            if existing_item and existing_item.visual_state != visual_state:
                raise ValueError(
                    f"Pass A 为角色 {char_name} 输出了多个默认身份: {existing_item.visual_state}, {visual_state}"
                )
            if existing_item:
                try:
                    merged_age_group = _merge_age_group_values(existing_item.age_group, item.age_group)
                except ValueError:
                    if on_log:
                        on_log(
                            f"[Pass A] {char_name}_{visual_state} age_group 冲突: "
                            f"{existing_item.age_group!r} vs {item.age_group!r}，保留前者"
                        )
                    merged_age_group = existing_item.age_group
                if merged_age_group != existing_item.age_group:
                    existing_item.age_group = merged_age_group
                continue
            seen_char_to_item[char_name] = DefaultIdentityRequirement(
                character_name=char_name,
                visual_state=visual_state,
                age_group=item.age_group,
                reason=item.reason,
            )

        missing_chars = [char_name for char_name in canonical_cast_names if char_name not in seen_char_to_item]
        if missing_chars:
            raise ValueError("Pass A 默认身份覆盖不完整: " + ", ".join(missing_chars))
        return list(seen_char_to_item.values())

    def _normalize_other_requirements(
        self,
        requirements: list[IdentityRequirement],
        cast_names: list[str],
        default_identity_ids: list[str] | None = None,
        on_log: Optional[Callable] = None,
    ) -> list[IdentityRequirement]:
        """归一 Pass B 输出，过滤 cast 外角色、重复项和默认身份重复项。"""
        canonical_cast_names = self._normalize_cast_names(cast_names)
        cast_set = set(canonical_cast_names)
        default_states_by_char: dict[str, set[str]] = {}
        for identity_id in default_identity_ids or []:
            normalized_id = str(identity_id or "").strip()
            if not normalized_id or "_" not in normalized_id:
                continue
            char_name, identity_name = normalized_id.split("_", 1)
            default_states_by_char.setdefault(char_name, set()).add(identity_name)

        seen_pairs: dict[tuple[str, str], IdentityRequirement] = {}
        for item in requirements:
            char_name = (self.cognee_store.resolve_name(item.character_name) or item.character_name).strip()
            visual_state = self._normalize_visual_state_for_char(
                char_name,
                str(item.visual_state or "").strip(),
            )
            if not char_name or not visual_state:
                continue
            if cast_set and char_name not in cast_set:
                continue
            if visual_state in default_states_by_char.get(char_name, set()):
                continue
            pair = (char_name, visual_state)
            existing_item = seen_pairs.get(pair)
            if existing_item:
                try:
                    merged_age_group = _merge_age_group_values(existing_item.age_group, item.age_group)
                except ValueError:
                    if on_log:
                        on_log(
                            f"[Pass B] {char_name}_{visual_state} age_group 冲突: "
                            f"{existing_item.age_group!r} vs {item.age_group!r}，保留前者"
                        )
                    merged_age_group = existing_item.age_group
                if merged_age_group != existing_item.age_group:
                    existing_item.age_group = merged_age_group
                continue
            seen_pairs[pair] = IdentityRequirement(
                character_name=char_name,
                visual_state=visual_state,
                age_group=item.age_group,
                reason=item.reason,
            )
        return list(seen_pairs.values())

    async def _analyze_default_identities(
        self,
        episode: "NovelEpisode",
        on_log: Optional[Callable] = None,
        *,
        cast_names: list[str] | None = None,
        content_text: str | None = None,
        graph_context: str | None = None,
    ) -> EpisodeDefaultIdentities:
        """Pass A: 分析每个角色的现实主线默认身份。"""
        if content_text is None:
            content_text = await self.cognee_store.load_episode_content(episode.number)
        if not content_text:
            return EpisodeDefaultIdentities()
        if cast_names is None:
            cast_names = [c.name for c in self.cognee_store.get_all_characters()]

        identity_info = self._build_character_info(cast_names)
        graph_section = ""
        if graph_context and graph_context.strip():
            graph_section = f"\n## 图谱上下文\n{graph_context[:3000]}\n"

        task = f"""分析第 {episode.number} 集《{episode.title}》中每个角色的**现实主线默认身份**。

## 出场角色
{', '.join(cast_names)}

## 已有身份列表（优先复用）
{identity_info}
{graph_section}
## 本集原文
{content_text}

---
请为每个出场角色确定一个默认身份（现实主线中最常出现的稳定形态）。
- 已有身份能覆盖的，使用相同的 visual_state 名称（复用）
- character_name 使用角色主名称
- 每个角色只输出一个默认身份
- 同时输出 age_group
  - 如果 visual_state 明确是年龄阶段，请填写对应 age_group
  - 如果只是同龄造型分支，可留空
"""
        try:
            agent = Agent(
                self._identity_model("IDENTITY_PLANNER_ANALYSIS_MODEL"),
                system_prompt=DEFAULT_IDENTITY_PROMPT,
                model_settings=self._identity_model_settings(
                    "IDENTITY_PLANNER_ANALYSIS_THINKING_LEVEL",
                    "high",
                ),
                output_type=EpisodeDefaultIdentities,
            )
            result = await agent.run(task)
            result.output.defaults = self._validate_default_requirements(
                result.output.defaults,
                cast_names,
                on_log=on_log,
            )
            if on_log:
                for d in result.output.defaults:
                    age_suffix = f", age_group={d.age_group}" if d.age_group else ""
                    on_log(f"  [Pass A] {d.character_name} -> {d.visual_state}{age_suffix} ({d.reason})")
            return result.output
        except Exception as e:
            if on_log:
                on_log(f"[EP{episode.number:03d}] Pass A 默认身份分析失败: {e}")
            raise RuntimeError(f"Pass A 默认身份分析失败: {e}") from e

    async def _analyze_special_identities(
        self,
        episode: "NovelEpisode",
        on_log: Optional[Callable] = None,
        *,
        cast_names: list[str] | None = None,
        content_text: str | None = None,
        graph_context: str | None = None,
        already_resolved: list[str] | None = None,
    ) -> EpisodeIdentityRequirements:
        """Pass B: 全文分析默认身份之外的其他非默认身份。"""
        if content_text is None:
            content_text = await self.cognee_store.load_episode_content(episode.number)
        if not content_text:
            return EpisodeIdentityRequirements()
        if cast_names is None:
            cast_names = [c.name for c in self.cognee_store.get_all_characters()]

        canonical_cast_names = self._normalize_cast_names(cast_names)
        identity_info = self._build_character_info(canonical_cast_names)
        graph_section = ""
        if graph_context and graph_context.strip():
            graph_section = f"\n## 图谱上下文\n{graph_context[:3000]}\n"

        resolved_default_ids = list(dict.fromkeys(already_resolved or []))
        already_section = ""
        if resolved_default_ids:
            already_section = (
                "\n## 已确定的默认身份（不要重复）\n"
                + "\n".join(f"- `{iid}`" for iid in resolved_default_ids)
                + "\n"
            )

        task = f"""分析第 {episode.number} 集《{episode.title}》中各角色在默认身份之外还需要的**其他身份**。

## 出场角色
{', '.join(canonical_cast_names)}

## 已有身份列表（优先复用）
{identity_info}
{already_section}{graph_section}
## 本集原文
{content_text}

---
请列出本集中有强文本证据的其他非默认身份。
- 不要重复输出默认身份
- 年龄变体（幼年/少年/老年）必须独立身份，即使只在回忆/闪回中出现一两场
- 长期稳定的另一套造型/阶段也应独立列出
- 已有身份能覆盖的，使用相同的 visual_state 名称（复用）
- 同时输出 age_group
  - 年龄变体必须填写对应 age_group
  - 普通同龄造型分支可留空
- 如果没有其他身份需求，返回空列表
"""
        try:
            agent = Agent(
                self._identity_model("IDENTITY_PLANNER_ANALYSIS_MODEL"),
                system_prompt=OTHER_IDENTITY_PROMPT,
                model_settings=self._identity_model_settings(
                    "IDENTITY_PLANNER_ANALYSIS_THINKING_LEVEL",
                    "high",
                ),
                output_type=EpisodeIdentityRequirements,
            )
            result = await agent.run(task)
            result.output.requirements = self._normalize_other_requirements(
                result.output.requirements,
                canonical_cast_names,
                resolved_default_ids,
                on_log=on_log,
            )
            for req in result.output.requirements:
                if on_log:
                    age_suffix = f", age_group={req.age_group}" if req.age_group else ""
                    on_log(f"  [Pass B] {req.character_name} -> {req.visual_state}{age_suffix} ({req.reason})")
            return result.output
        except Exception as e:
            if on_log:
                on_log(f"[EP{episode.number:03d}] Pass B 其他身份分析失败: {e}")
            return EpisodeIdentityRequirements()

    @staticmethod
    def _is_pending_planner_identity(identity: CharacterIdentity) -> bool:
        return (
            identity.source == "identity_planner"
            and not str(identity.appearance_details or "").strip()
            and not str(identity.face_prompt or "").strip()
            and not str(identity.body_type or "").strip()
        )

    @staticmethod
    def _corrupted_identity_fields(identity: CharacterIdentity) -> dict[str, str]:
        if identity.source != "identity_planner":
            return {}
        field_specs = {
            "appearance_details": (identity.appearance_details, "appearance_details"),
            "face_prompt": (identity.face_prompt, "face_description"),
            "body_type": (identity.body_type, "body_type"),
        }
        return {
            storage_field: reason
            for storage_field, (value, schema_field) in field_specs.items()
            if (reason := _appearance_corruption_reason(value, schema_field))
        }

    async def _generate_identity_appearance_updates(
        self,
        char,
        visual_state: str,
        resolved_age_group: str,
        explicit_age_group: str,
        inferred_fish_voice: str,
        reason: str,
        on_log: Optional[Callable] = None,
    ) -> dict[str, str]:
        appearance_result = await self._generate_appearance(
            char.name,
            visual_state,
            resolved_age_group,
            reason,
            on_log,
        )

        if isinstance(appearance_result, str):
            appearance = appearance_result.strip()
            face_description = ""
            voice_age_group = resolved_age_group
            identity_body_type = ""
        else:
            appearance = appearance_result.appearance_details
            face_description = appearance_result.face_description or ""
            appearance_age_group = _normalize_age_group_value(appearance_result.age_group)
            if (
                resolved_age_group
                and appearance_age_group
                and appearance_age_group != resolved_age_group
            ):
                if on_log:
                    on_log(
                        f"  ⚠ {char.name}_{visual_state}: 外观阶段 age_group={appearance_age_group} "
                        f"与身份规划 age_group={resolved_age_group} 冲突，采用身份规划值"
                    )
                appearance_age_group = resolved_age_group
            voice_age_group = appearance_age_group or resolved_age_group
            identity_body_type = appearance_result.body_type or ""

        identity_fish_voice = inferred_fish_voice
        if voice_age_group:
            from novelvideo.config import get_fish_voice_id

            identity_fish_voice = get_fish_voice_id(voice_age_group, char.gender)
        else:
            identity_body_type = ""

        if voice_age_group and voice_age_group == char.age_group and not explicit_age_group:
            if on_log:
                on_log(
                    f"  ⚠ {char.name}_{visual_state}: age_group={voice_age_group} "
                    "与角色相同，清空年龄变体字段"
                )
            face_description = ""
            voice_age_group = ""
            identity_body_type = ""
            identity_fish_voice = ""

        reconciled = AppearanceDescription(
            appearance_details=appearance,
            face_description=face_description,
            age_group=voice_age_group,
            body_type=identity_body_type,
        )
        return {
            "appearance_details": reconciled.appearance_details,
            "face_prompt": reconciled.face_description,
            "age_group": reconciled.age_group,
            "body_type": reconciled.body_type,
            "fish_voice_id": identity_fish_voice,
        }

    async def _recover_identity_appearance(
        self,
        *,
        char,
        identity: CharacterIdentity,
        visual_state: str,
        resolved_age_group: str,
        explicit_age_group: str,
        inferred_fish_voice: str,
        reason: str,
        pending: bool,
        corrupted_fields: dict[str, str],
        on_log: Optional[Callable] = None,
    ) -> bool:
        try:
            generated = await self._generate_identity_appearance_updates(
                char,
                visual_state,
                resolved_age_group,
                explicit_age_group,
                inferred_fish_voice,
                reason,
                on_log,
            )
        except Exception:
            if corrupted_fields:
                sanitized = {field: "" for field in corrupted_fields}
                await self.cognee_store.update_character_identity(
                    char.name,
                    identity.identity_id,
                    **sanitized,
                )
                if on_log:
                    on_log(
                        f"  ⚠ 修复失败，已清空污染字段: {identity.identity_id} "
                        f"({', '.join(sorted(corrupted_fields))})"
                    )
            elif on_log:
                on_log(f"  保留: {identity.identity_id} 已创建，外观待补")
            return False

        if pending:
            await self.cognee_store.update_character_identity(
                char.name,
                identity.identity_id,
                **generated,
            )
            if on_log:
                on_log(
                    f"  补全: {identity.identity_id} — "
                    f"{generated['appearance_details'][:40]}..."
                )
            return True

        repair_updates = {
            field: generated[field]
            for field in corrupted_fields
        }
        merged_age_group = str(identity.age_group or "").strip()
        merged = {
            "appearance_details": repair_updates.get(
                "appearance_details", identity.appearance_details
            ),
            "face_description": repair_updates.get("face_prompt", identity.face_prompt),
            "age_group": merged_age_group,
            "body_type": repair_updates.get("body_type", identity.body_type),
        }
        try:
            AppearanceDescription(**merged)
        except ValueError:
            repair_updates = {field: "" for field in corrupted_fields}
            if on_log:
                on_log(
                    f"  ⚠ 无法在保留有效字段的前提下修复 {identity.identity_id}，"
                    "已清空污染字段并使用角色级回退"
                )

        await self.cognee_store.update_character_identity(
            char.name,
            identity.identity_id,
            **repair_updates,
        )
        if on_log:
            on_log(
                f"  修复: {identity.identity_id} "
                f"({', '.join(sorted(corrupted_fields))})"
            )
        return True

    async def _resolve_requirements(
        self,
        episode_number: int,
        requirements: EpisodeIdentityRequirements,
        on_log: Optional[Callable] = None,
    ) -> tuple[int, list[str], dict[tuple[str, str], str]]:
        """Phase 2: 匹配已有身份 → 创建缺失身份。

        Returns:
            (new_count, resolved_ids, resolved_identity_map):
            新建身份数、所有解析到的 identity_id 列表、(character_name, visual_state) 到 identity_id 的映射
        """
        new_count = 0
        resolved_ids: list[str] = []
        resolved_identity_map: dict[tuple[str, str], str] = {}

        for req in requirements.requirements:
            resolved_name = self.cognee_store.resolve_name(req.character_name)
            char = self.cognee_store.get_character(resolved_name)
            if not char:
                if on_log:
                    on_log(f"  跳过: 角色 {req.character_name} 不存在")
                continue

            # 构建候选 identity_id（去掉 visual_state 中重复的角色名前缀）
            vs = self._normalize_visual_state_for_char(char.name, req.visual_state)
            candidate_id = f"{char.name}_{vs}"
            explicit_age_group = self._infer_age_group_from_visual_state(vs)
            try:
                resolved_age_group, inferred_fish_voice = self._seed_identity_structured_fields(
                    char, vs, req.age_group
                )
            except ValueError as e:
                if on_log:
                    on_log(f"  跳过: {candidate_id} 字段冲突 ({e})")
                continue

            # 1. 精确匹配 identity_id
            matched = self._find_matching_identity(
                char, vs, candidate_id
            )

            if matched:
                resolved_ids.append(matched.identity_id)
                resolved_identity_map[(char.name, vs)] = matched.identity_id
                pending = self._is_pending_planner_identity(matched)
                corrupted_fields = self._corrupted_identity_fields(matched)
                if pending or corrupted_fields:
                    repair_age_group = (
                        _normalize_age_group_value(getattr(matched, "age_group", ""))
                        or resolved_age_group
                    )
                    await self._recover_identity_appearance(
                        char=char,
                        identity=matched,
                        visual_state=vs,
                        resolved_age_group=repair_age_group,
                        explicit_age_group=explicit_age_group,
                        inferred_fish_voice=inferred_fish_voice,
                        reason=req.reason,
                        pending=pending,
                        corrupted_fields=corrupted_fields,
                        on_log=on_log,
                    )
                else:
                    updates = {}
                    existing_age_group = getattr(matched, "age_group", "")
                    if existing_age_group != resolved_age_group:
                        updates["age_group"] = resolved_age_group
                    if inferred_fish_voice and not getattr(matched, "fish_voice_id", ""):
                        updates["fish_voice_id"] = inferred_fish_voice
                    if updates:
                        try:
                            await self.cognee_store.update_character_identity(
                                char.name,
                                matched.identity_id,
                                **updates,
                            )
                            if on_log:
                                on_log(
                                    f"  回填结构字段: {matched.identity_id}"
                                    f" age_group={updates.get('age_group', getattr(matched, 'age_group', ''))}"
                                )
                        except Exception as e:
                            if on_log:
                                on_log(f"  回填结构字段失败({matched.identity_id}): {e}")
                    if on_log:
                        on_log(
                            f"  复用: {matched.identity_id} (ep{episode_number})"
                        )
            else:
                from novelvideo.utils.identity_resolver import compute_char_tag
                identity = CharacterIdentity(
                    identity_id=candidate_id,
                    character_name=char.name,
                    identity_name=vs,
                    character_tag=compute_char_tag(char.name, identity_id=candidate_id),
                    age_group=resolved_age_group,
                    fish_voice_id=inferred_fish_voice,
                    source="identity_planner",
                )

                try:
                    await self.cognee_store.add_character_identity(
                        char.name, identity
                    )
                    new_count += 1
                    resolved_ids.append(candidate_id)
                    resolved_identity_map[(char.name, vs)] = candidate_id
                    if on_log:
                        on_log(f"  新建: {candidate_id} — 外观待补")
                except ValueError as e:
                    # 身份已存在（幂等性）
                    if "已存在" in str(e):
                        resolved_ids.append(candidate_id)
                        resolved_identity_map[(char.name, vs)] = candidate_id
                        if on_log:
                            on_log(f"  跳过: {candidate_id} 已存在")
                    else:
                        if on_log:
                            on_log(f"  错误: {e}")
                        continue

                try:
                    await self._recover_identity_appearance(
                        char=char,
                        identity=identity,
                        visual_state=vs,
                        resolved_age_group=resolved_age_group,
                        explicit_age_group=explicit_age_group,
                        inferred_fish_voice=inferred_fish_voice,
                        reason=req.reason,
                        pending=True,
                        corrupted_fields={},
                        on_log=on_log,
                    )
                except Exception as e:
                    if on_log:
                        on_log(f"  外观保存失败({candidate_id}): {e}，身份已保留")

        return new_count, resolved_ids, resolved_identity_map

    def _find_matching_identity(
        self,
        char,
        visual_state: str,
        candidate_id: str,
    ) -> Optional[CharacterIdentity]:
        """在角色已有身份中查找匹配（仅精确匹配）。

        AI 在 Phase 1 已经看到完整的已有身份列表并被要求复用相同名称，
        输出不同名字 = 需要新身份。子串/同义词 fallback 会导致误匹配。
        """
        if not char.identities:
            return None

        # 1. 精确匹配 identity_id
        for ident in char.identities:
            if ident.identity_id == candidate_id:
                return ident

        # 2. 精确匹配 identity_name
        for ident in char.identities:
            if ident.identity_name == visual_state:
                return ident

        return None

    async def _generate_appearance(
        self,
        character_name: str,
        visual_state: str,
        planned_age_group: str,
        reason: str,
        on_log: Optional[Callable] = None,
    ) -> AppearanceDescription:
        """用 AI 生成身份的服装造型描述（含可选面部描述）。"""
        # 获取角色已有造型作为参考（不发送 face_prompt 避免触发安全过滤）
        char = self.cognee_store.get_character(character_name)
        base_info = ""
        default_info = ""
        if char:
            # 角色默认面部、年龄段、体型——AI 需要对比判断是否需要覆盖
            default_parts = []
            if char.face_prompt:
                default_parts.append(f"默认面部特征: {char.face_prompt}")
            if char.age_group:
                default_parts.append(f"默认年龄段: {char.age_group}")
            if char.body_type:
                default_parts.append(f"默认体型: {char.body_type}")
            if char.gender:
                default_parts.append(f"性别: {char.gender}")
            if default_parts:
                default_info = "\n".join(default_parts) + "\n"
            if char.identities:
                existing_desc = "\n".join(
                    f"- {i.identity_name}: {i.appearance_details[:40]}"
                    for i in char.identities
                    if i.appearance_details
                )
                if existing_desc:
                    base_info = f"已有造型参考:\n{existing_desc}\n"

        planned_age_info = ""
        if planned_age_group:
            planned_age_info = f"该身份在前一规划阶段已确定年龄段: {planned_age_group}\n"

        task = f"""为虚构影视角色「{character_name}」的「{visual_state}」造型设计服装方案。

{default_info}{base_info}{planned_age_info}
剧情背景: {reason}

请设计 50-80 字的服装造型方案（款式、面料、配饰、发型，不含人物外貌和表情）。

⚠️ face_description、age_group、body_type 判断规则：
- 如果上面已经给出“已确定年龄段”，输出时应与该年龄段保持一致
- 只有当该身份的年龄与角色默认年龄段**明显不同**时才填写（如幼年回忆、老年形态）
- 如果该身份的年龄与上述默认一致或接近，face_description、age_group、body_type 必须留空
- face_description 格式：30-50字面部描述（年龄特征、脸型、五官比例，不含服装）
- body_type 格式：简短体型描述（如"矮小圆润的幼童体型"、"佝偻消瘦的老人体型"）
"""

        try:
            appearance_agent = Agent(
                self._identity_model("IDENTITY_PLANNER_APPEARANCE_MODEL"),
                system_prompt=APPEARANCE_GENERATION_PROMPT,
                model_settings=self._identity_model_settings(
                    "IDENTITY_PLANNER_APPEARANCE_THINKING_LEVEL",
                    "high",
                ),
                output_type=AppearanceDescription,
                retries={"output": 2},
                validation_context={"planned_age_group": planned_age_group},
            )
            ai_result = await appearance_agent.run(task)
            return ai_result.output
        except Exception as e:
            if on_log:
                on_log(f"  外观生成失败({character_name}/{visual_state}): {e}")
            raise
