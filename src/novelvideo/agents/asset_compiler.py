"""Asset Compiler — 以 SceneBlock 为单位编译本集场景和道具资产。"""

from __future__ import annotations

import re
from typing import Any, Callable, Optional

from pydantic import BaseModel, Field, ValidationError, ValidationInfo, model_validator
from pydantic_ai import Agent
from pydantic_ai.exceptions import UnexpectedModelBehavior

from novelvideo.config import (
    get_newapi_text_pydantic_model,
    get_newapi_text_pydantic_model_settings,
)
from novelvideo.models import (
    NovelProp,
    NovelScene,
    PropMenuItem,
    SceneMenuItem,
)
from novelvideo.cognee.screenplay_normalizer import normalize_time_of_day
from novelvideo.utils.derived_scenes import compose_derived_scene_name
from novelvideo.workflows.literal_script_writing import (
    LiteralScriptWritingWorkflow,
    SceneBlock,
    split_literal_source_text,
)


class DerivedSceneRequirement(BaseModel):
    label: str = Field(description="派生场景后缀，如 '雪景'、'战后版'、'蒸汽弥漫'")
    description: str = Field(
        default="",
        description="派生场景的简短视觉说明，描述区别于基础场景的稳定视觉特征",
    )
    lighting: str = Field(default="", description="派生场景特有的光照条件；没有就留空")
    atmosphere: str = Field(default="", description="派生场景特有的氛围/天气/空气感；没有就留空")


PROP_OUTPUT_SCHEMA_HINT = (
    "道具规划结构化输出校验失败: requirements 必须是对象数组，每项必须包含 "
    "prop_name 和 visual_prompt；不能是字符串数组；prop_name 必须逐字来自当前场景块文本或候选道具"
)


class PropRequirement(BaseModel):
    prop_name: str = Field(
        description="道具名称，必须逐字复制自当前场景块文本或候选道具，如 '七星剑'、'玉佩'；不要改写或同义词替换"
    )
    prop_type: str = Field(
        default="",
        description="道具类型: weapon / accessory / artifact / document / furniture",
    )
    owner: str = Field(default="", description="所属角色名（如有）")
    visual_prompt: str = Field(
        default="",
        description="用于生成参考图的视觉提示词，必须写清形状、材质、颜色、可识别细节，80字内",
    )
    description: str = Field(default="", description="一句话叙述描述（用途/剧情关系，50字内）")


class BlockDerivedSceneOutput(BaseModel):
    derived_scenes: list[DerivedSceneRequirement] = Field(
        default_factory=list,
        description="当前场景块需要提升为独立场景的稳定视觉状态",
    )


class BlockPropRequirements(BaseModel):
    requirements: list[PropRequirement] = Field(
        default_factory=list,
        description="当前场景块中有情节意义的道具对象数组；每项必须是对象，不能是字符串列表",
    )

    @model_validator(mode="after")
    def validate_props(self, info: ValidationInfo) -> "BlockPropRequirements":
        block_text = str((info.context or {}).get("block_text", "") or "")
        allowed_existing_names = {
            str(item or "").strip()
            for item in ((info.context or {}).get("allowed_existing_names") or set())
            if str(item or "").strip()
        }
        normalized: list[PropRequirement] = []
        seen: set[str] = set()
        for req in self.requirements:
            prop_name = str(req.prop_name or "").strip()
            if not prop_name or prop_name in seen:
                continue
            if prop_name not in allowed_existing_names and prop_name not in block_text:
                raise ValueError(f"道具名 '{prop_name}' 未在当前场景块文本中出现")
            seen.add(prop_name)
            normalized.append(req)
        self.requirements = normalized
        return self


class NarratedSceneRequirement(BaseModel):
    scene_name: str = Field(description="基础场景名，必须是可复用的物理地点")
    scene_type: str = Field(default="interior", description="interior / exterior / nature")
    aliases: list[str] = Field(default_factory=list, description="原文中出现过的自然别名")
    description: str = Field(default="", description="一句话说明该地点在本集中的作用")
    evidence_lines: list[str] = Field(default_factory=list, description="支持该场景的原文证据")

    @model_validator(mode="after")
    def validate_scene(self, info: ValidationInfo) -> "NarratedSceneRequirement":
        source_text = str((info.context or {}).get("source_text", "") or "")
        existing_scene_names = {
            str(item or "").strip()
            for item in ((info.context or {}).get("existing_scene_names") or set())
            if str(item or "").strip()
        }
        self.scene_name = str(self.scene_name or "").strip()
        self.scene_type = AssetCompiler._normalize_scene_type(self.scene_type)
        self.aliases = [
            str(alias or "").strip() for alias in (self.aliases or []) if str(alias or "").strip()
        ]
        self.description = str(self.description or "").strip()
        self.evidence_lines = [
            str(line or "").strip()
            for line in (self.evidence_lines or [])
            if str(line or "").strip()
        ]
        if source_text and self.scene_name and self.scene_name not in existing_scene_names:
            tokens = [self.scene_name, *self.aliases]
            if not any(token and token in source_text for token in tokens):
                raise ValueError(f"场景名 '{self.scene_name}' 未在本集文本中出现")
        return self


class NarratedScenePlanOutput(BaseModel):
    scenes: list[NarratedSceneRequirement] = Field(
        default_factory=list,
        description="本集解说稿/小说段落中需要进入 2.0 场景资产库的稳定物理场景",
    )


class BaseSceneReconcileDecision(BaseModel):
    action: str = Field(description="reuse / create / ignore")
    scene_name: str = Field(default="", description="需要创建或引用的基础场景名")
    matched_existing_name: str = Field(default="", description="复用已有基础场景时填写")
    scene_type: str = Field(default="interior", description="interior / exterior / nature")
    aliases: list[str] = Field(default_factory=list, description="原文中出现的自然别名")
    description: str = Field(default="", description="一句话说明该物理地点")
    evidence_lines: list[str] = Field(default_factory=list, description="支持该决策的原文证据")
    confidence: float = Field(default=0.0, description="0-1 置信度")

    @model_validator(mode="after")
    def normalize_action_and_type(self) -> "BaseSceneReconcileDecision":
        self.action = str(self.action or "").strip().lower()
        if self.action not in {"reuse", "create", "ignore"}:
            self.action = "ignore"
        self.scene_name = str(self.scene_name or "").strip()
        self.matched_existing_name = str(self.matched_existing_name or "").strip()
        self.scene_type = AssetCompiler._normalize_scene_type(self.scene_type)
        self.aliases = [
            str(alias or "").strip() for alias in (self.aliases or []) if str(alias or "").strip()
        ]
        self.description = str(self.description or "").strip()
        self.evidence_lines = [
            str(line or "").strip()
            for line in (self.evidence_lines or [])
            if str(line or "").strip()
        ]
        return self


class EpisodeBaseSceneReconcileOutput(BaseModel):
    scenes: list[BaseSceneReconcileDecision] = Field(
        default_factory=list,
        description="本集文本中的基础场景复用/新建/忽略决策",
    )


BASE_SCENE_RECONCILE_PROMPT = """# 你是影视项目基础场景资产校对员

任务：根据本集文本和已有基础场景表，判断文本中出现的物理地点是否应复用已有基础场景、创建新基础场景，或忽略。

规则：
- 你必须优先复用已有基础场景及其别名；不要因为描述、时段、天气、状态变化创建新基础场景。
- 基础场景名必须是中性的物理地点，如“公寓楼电梯间”“城市街道”“医院走廊”。
- 不要把“雨夜/白天/黄昏/漏水/爆炸后/凌乱/雪景”等时间、天气、状态写进基础场景名；这些交给后续 plate/变体规划。
- 只有明确是可复用物理地点、且有原文证据时，才输出 create。
- “室内”“外景”“本集主场景”“路边”等泛称一律 ignore。
- evidence_lines 必须引用原文中的短句。
- 输出结构化结果；不要输出解释性散文。
"""


DERIVED_SCENE_PROMPT = """# 你是派生场景分析师

任务：基于当前场景块文本，判断该基础场景在本集是否出现了稳定、可复用、应提升为独立场景的视觉状态。

规则：
- 只输出稳定视觉状态，不要把普通时间、镜头、景别、机位写成独立场景
- 普通“白天/夜晚/黄昏”只属于 time_of_day，不要机械派生
- 但如果光线/天气/损坏/陈设变化是需要审批、跨镜头复用、会作为视频参考图的稳定 plate，可以输出派生场景
- 正确示例：蒸汽弥漫、雪景、战后版、凌乱版、节日装饰版
- 正确示例：暴雨夜霓虹版、停电手电筒版、漏水冷光版
- 错误示例：白天、夜晚、俯拍、特写、黑屏、第一人称
- 没有就输出空列表
"""


BLOCK_PROP_PROMPT = """# 你是场景块关键道具分析师

任务：只基于当前场景块文本，提取需要在多个镜头中被当作"同一个对象"持续追踪的道具。

## 核心判断标准
一个物体值得列为道具，当且仅当：
- 它是一个**独立的、可移动的物理实体**
- 它在**多个镜头/多行描写中反复出现**，或者**被角色拿取、递交、操作**
- 后续镜头需要画出"同一个东西"来保持视觉连续性

## 不是道具的东西
- **场景固定设施**：门、窗、墙、灯、巨幕、大屏、广告牌、招牌、门锁、挂钟、
  数字显示屏 — 这些是场景的一部分
- **环境陈设**：桌子、椅子、凳子、沙发、床、柜子、栏杆 — 除非被角色明确拿起或操作
- **屏幕显示内容**：电影字幕、LOGO、弹窗、提示字、广告文案 — 这是画面内容，不是物理实体
- **回忆/电视/幻象中一闪而过的物品**：试卷、画笔、折断的画笔 — 除非在现实场景中也作为实体出场
- **特效/虚拟元素**：透明的手、光效、数字粒子 — 除非它是被角色物理操作的实体
- **食品/一次性消耗品**：易拉罐、面碗、筷子、餐巾纸 — 吃完就没了，不需要跨镜头追踪

## 复用规则
- 优先复用已有道具名和本集前面已选的道具
- 道具名必须来自当前场景块文本或给定的候选道具列表

## 输出规则
- requirements 必须是对象数组，每个元素必须包含 prop_name / visual_prompt；不能是字符串数组
- 禁止输出 `{{"requirements":["强光手电"]}}`
- 正确输出示例：
  `{{
    "requirements": [
      {{
        "prop_name": "强光手电",
        "prop_type": "object",
        "owner": "陆辰",
        "visual_prompt": "黑色金属强光手电，冷白光束，筒身有磨损划痕",
        "description": "陆辰在地下室照明并寻找暗格"
      }}
    ]
  }}`
- 每个道具必须给出 visual_prompt；不要只写用途，要写可画出来的外观
- description 写剧情用途；如果没有明确用途，可以留空
- prop_name 必须从当前场景块文本或候选道具中逐字复制；不要改写、泛化、补同义词。原文是“强光手电”，不要写“手电筒”
"""


NARRATED_SCENE_PROMPT = """# 你是解说剧场景资产规划师

任务：从一集小说原文或逐行解说工作稿中提取需要进入项目资产库的稳定物理场景。

规则：
- 只提取可复用的地点/空间，如医院走廊、出租屋客厅、山路、城门口
- 不要把情绪、镜头、事件、人物关系提成场景
- 不要输出“本集主场景”“室内”“外景”等泛化名称
- 同一物理地点只输出一次，名称尽量保留原文具体锚点
- scene_type 只能用 interior / exterior / nature
- evidence_lines 只放原文中支持该场景的短句
- 输出的是 2.0 NovelScene 概念，不涉及旧版 scene_registry 或 anchor.png
"""


BACKGROUND_PROP_DENYLIST = {
    # 环境陈设
    "桌子",
    "椅子",
    "凳子",
    "门",
    "窗",
    "窗户",
    "灯",
    "墙",
    "墙壁",
    "地板",
    "天花板",
    "沙发",
    "床",
    "柜子",
    "架子",
    "楼梯",
    "栏杆",
    "屏风",
    "书架",
    "货架",
    # 场景固定设施
    "挂钟",
    "门锁",
    "门铃",
    "电梯",
    "数字显示屏",
    "显示屏",
    "路灯",
    "广告牌",
    "招牌",
    "3D巨幕",
    "大屏",
    "巨幕",
    "3D大屏",
    # 食品/一次性消耗品
    "易拉罐",
    "面碗",
    "碗",
    "筷子",
    "杯子",
    "茶杯",
    "餐巾纸",
    "餐巾纸盒",
    "盘子",
    # 屏幕显示内容
    "电影字幕",
    "LOGO",
    "字幕",
    "logo",
    "字样",
    "标语",
    # 回忆/幻象中的一次性画面元素
    "折断的画笔",
    "画笔",
    "试卷",
    # 特效/虚拟元素
    "透明的手",
}

NON_PROP_KEYWORDS = (
    "字幕",
    "logo",
    "LOGO",
    "字样",
    "标语",
    "提示字",
    "广告文案",
    "弹窗",
    "巨幕",
    "大屏",
    "显示屏",
    "屏幕内容",
    "招牌",
    "广告牌",
    "透明的手",
    "光效",
    "粒子",
)


async def enrich_scene_environment_from_context(**kwargs) -> NovelScene:
    from novelvideo.cognee.pipeline import (
        enrich_scene_environment_from_context as enrich,
    )

    return await enrich(**kwargs)


INTERACTION_VERBS = (
    "拿",
    "递",
    "看",
    "开",
    "关",
    "摔",
    "抱",
    "拖",
    "抽",
    "打开",
    "放下",
    "捡起",
    "拿起",
    "接过",
    "交给",
    "扔",
    "掷",
    "举",
    "按",
    "推",
    "拉",
    "操作",
    "注视",
    "盯着",
    "指着",
    "握着",
    "攥着",
    "递给",
    "塞给",
    "捧着",
)


class AssetCompiler:
    """以 SceneBlock 为单位编译本集场景和道具资产。"""

    def __init__(self, cognee_store: Any):
        self.cognee_store = cognee_store

    async def compile_single_episode(
        self,
        episode: Any,
        on_log: Optional[Callable[[str], None]] = None,
        on_progress: Optional[Callable[[float, str], None]] = None,
    ) -> tuple[list[SceneMenuItem], list[PropMenuItem], int]:
        """兼容旧入口：一次性编译场景和道具。新 UI 应优先调用拆分入口。"""

        def log(message: str) -> None:
            if on_log:
                on_log(message)

        def report(progress: float, task: str) -> None:
            if on_progress:
                on_progress(progress, task)

        source_text = await self._load_source_text(episode)
        if not source_text.strip():
            raise ValueError("当前集原文为空，无法编译资产")

        lines = split_literal_source_text(source_text)
        if not lines:
            raise ValueError("原文无法切分出有效行")

        scene_blocks = LiteralScriptWritingWorkflow._build_scene_blocks(lines)
        if not scene_blocks:
            raise ValueError("原文无法切分出有效场景块")

        report(0.05, "解析场景块...")
        log(f"[AssetCompiler] 共识别 {len(scene_blocks)} 个场景块")

        report(0.12, "AI校对基础场景...")
        await self._reconcile_base_scenes_from_text(source_text, episode, log)

        report(0.2, "编译场景资产...")
        scene_menu, pending_scenes = await self._compile_scenes(scene_blocks, episode, log)
        if not scene_menu:
            report(0.3, "从解说稿规划场景资产...")
            scene_menu, pending_scenes = await self._compile_narrated_scenes(
                source_text, episode, log
            )
        if not scene_menu:
            raise ValueError("未识别到任何场景，请先生成逐行解说工作稿或补充场次地点")

        report(0.55, "编译道具资产...")
        prop_menu = await self._compile_props(scene_blocks, episode, log)

        report(0.9, "写入本集资产...")
        for scene in pending_scenes:
            await self.cognee_store.sqlite_store.add_scene(scene)
        await self.cognee_store.update_episode(
            episode.number,
            scene_menu=scene_menu,
            prop_menu=prop_menu,
        )

        report(1.0, "完成")
        return scene_menu, prop_menu, len(pending_scenes)

    async def compile_episode_scenes(
        self,
        episode: Any,
        on_log: Optional[Callable[[str], None]] = None,
        on_progress: Optional[Callable[[float, str], None]] = None,
    ) -> tuple[list[SceneMenuItem], int]:
        """只编译并写入本集 scene_menu，不覆盖 prop_menu。"""

        def log(message: str) -> None:
            if on_log:
                on_log(message)

        def report(progress: float, task: str) -> None:
            if on_progress:
                on_progress(progress, task)

        scene_blocks = await self._load_scene_blocks(episode)
        report(0.1, "解析场景块...")
        log(f"[AssetCompiler] 共识别 {len(scene_blocks)} 个场景块")

        source_text = await self._load_source_text(episode)
        report(0.18, "AI校对基础场景...")
        await self._reconcile_base_scenes_from_text(source_text, episode, log)

        report(0.25, "编译场景资产...")
        scene_menu, pending_scenes = await self._compile_scenes(scene_blocks, episode, log)
        if not scene_menu:
            report(0.45, "从解说稿规划场景资产...")
            scene_menu, pending_scenes = await self._compile_narrated_scenes(
                source_text, episode, log
            )
        if not scene_menu:
            raise ValueError("未识别到任何场景，请先生成逐行解说工作稿或补充场次地点")

        report(0.85, "写入本集场景规划...")
        for scene in pending_scenes:
            await self.cognee_store.sqlite_store.add_scene(scene)
        await self.cognee_store.update_episode(episode.number, scene_menu=scene_menu)

        report(1.0, "完成")
        return scene_menu, len(pending_scenes)

    async def compile_episode_props(
        self,
        episode: Any,
        on_log: Optional[Callable[[str], None]] = None,
        on_progress: Optional[Callable[[float, str], None]] = None,
    ) -> list[PropMenuItem]:
        """只编译并写入本集 prop_menu，不覆盖 scene_menu。"""

        def log(message: str) -> None:
            if on_log:
                on_log(message)

        def report(progress: float, task: str) -> None:
            if on_progress:
                on_progress(progress, task)

        scene_blocks = await self._load_scene_blocks(episode)
        report(0.1, "解析场景块...")
        log(f"[AssetCompiler] 共识别 {len(scene_blocks)} 个场景块")

        report(0.25, "编译道具资产...")
        prop_menu = await self._compile_props(scene_blocks, episode, log)

        report(0.9, "写入本集道具规划...")
        await self.cognee_store.update_episode(episode.number, prop_menu=prop_menu)

        report(1.0, "完成")
        return prop_menu

    async def _reconcile_base_scenes_from_text(
        self,
        source_text: str,
        episode: Any,
        log: Callable[[str], None],
    ) -> list[str]:
        source_text = str(source_text or "").strip()
        if not source_text:
            return []
        existing_scenes = await self.cognee_store.sqlite_store.list_scenes()
        base_scenes = [
            scene
            for scene in existing_scenes
            if not str(getattr(scene, "base_scene_id", "") or "").strip()
        ]
        existing_lines: list[str] = []
        for scene in base_scenes:
            aliases = "、".join(getattr(scene, "aliases", []) or [])
            prompt = str(
                getattr(scene, "environment_prompt", "")
                or getattr(scene, "description", "")
                or ""
            ).strip()
            parts = [str(getattr(scene, "name", "") or "").strip()]
            if aliases:
                parts.append(f"别名: {aliases}")
            scene_type = str(getattr(scene, "scene_type", "") or "").strip()
            if scene_type:
                parts.append(f"类型: {scene_type}")
            if prompt:
                parts.append(f"描述: {prompt[:120]}")
            existing_lines.append("；".join(part for part in parts if part))

        agent = Agent(
            get_newapi_text_pydantic_model(
                "EPISODE_SCENE_RECONCILE_MODEL",
                "gemini-3.5-flash",
            ),
            system_prompt=BASE_SCENE_RECONCILE_PROMPT,
            model_settings=get_newapi_text_pydantic_model_settings(
                "EPISODE_SCENE_RECONCILE_THINKING_LEVEL",
                "low",
            ),
            output_type=EpisodeBaseSceneReconcileOutput,
            output_retries=2,
            name="基础场景资产校对员",
        )
        result = await agent.run(f"""## 已有基础场景
{chr(10).join(existing_lines) if existing_lines else "（无）"}

## 第 {episode.number} 集文本
{source_text}
""")
        return await self._apply_base_scene_reconcile_output(result.output, source_text, episode, log)

    async def _apply_base_scene_reconcile_output(
        self,
        output: EpisodeBaseSceneReconcileOutput,
        source_text: str,
        episode: Any,
        log: Callable[[str], None],
    ) -> list[str]:
        created: list[str] = []
        generic_names = {"室内", "外景", "内景", "路边", "街边", "本集主场景", "主场景"}
        for decision in output.scenes:
            if decision.action != "create":
                continue
            scene_name = str(decision.scene_name or "").strip()
            if not scene_name or scene_name in generic_names:
                continue
            if await self._find_existing_base_scene_by_name_or_alias(
                [scene_name, decision.matched_existing_name, *(decision.aliases or [])]
            ):
                continue
            evidence_lines = [
                str(line or "").strip()
                for line in (decision.evidence_lines or [])
                if str(line or "").strip()
            ]
            if not evidence_lines:
                continue
            if source_text and not any(line in source_text for line in evidence_lines):
                continue
            scene = await enrich_scene_environment_from_context(
                scene_name=scene_name,
                scene_type=decision.scene_type,
                context_lines=evidence_lines,
            )
            scene.aliases = list(
                dict.fromkeys(
                    str(alias or "").strip()
                    for alias in (decision.aliases or [])
                    if str(alias or "").strip() and str(alias or "").strip() != scene_name
                )
            )
            if decision.description and not str(scene.description or "").strip():
                scene.description = decision.description
            scene.notes = f"由 AssetCompiler AI 校对创建 (ep{episode.number})"
            await self.cognee_store.sqlite_store.add_scene(scene)
            created.append(scene.name)
            log(f"  AI补全基础场景: {scene.name}")
        return created

    async def _find_existing_base_scene_by_name_or_alias(
        self,
        names: list[str],
    ) -> NovelScene | None:
        """Return an existing base scene when any candidate matches a name or alias."""

        candidates = [
            str(name or "").strip()
            for name in (names or [])
            if str(name or "").strip()
        ]
        for name in candidates:
            scene = await self.cognee_store.sqlite_store.get_scene(name)
            if scene:
                return scene

        candidate_set = set(candidates)
        all_scenes = await self.cognee_store.sqlite_store.list_scenes()
        for scene in all_scenes:
            if str(getattr(scene, "base_scene_id", "") or "").strip():
                continue
            tokens = [
                str(getattr(scene, "name", "") or "").strip(),
                *[
                    str(alias or "").strip()
                    for alias in (getattr(scene, "aliases", []) or [])
                ],
            ]
            if any(token and token in candidate_set for token in tokens):
                return scene
        return None

    async def _load_scene_blocks(self, episode: Any) -> list[SceneBlock]:
        source_text = await self._load_source_text(episode)
        if not source_text.strip():
            raise ValueError("当前集原文为空，无法编译资产")

        lines = split_literal_source_text(source_text)
        if not lines:
            raise ValueError("原文无法切分出有效行")

        scene_blocks = LiteralScriptWritingWorkflow._build_scene_blocks(lines)
        if not scene_blocks:
            raise ValueError("原文无法切分出有效场景块")

        return scene_blocks

    async def _load_source_text(self, episode: Any) -> str:
        working_content = ""
        working_loader = getattr(
            getattr(self.cognee_store, "sqlite_store", None),
            "load_working_content",
            None,
        )
        if callable(working_loader):
            working_content = await working_loader(episode.number)
        return (
            getattr(episode, "beat_source_text", "")
            or working_content
            or await self.cognee_store.load_episode_content(episode.number)
            or getattr(episode, "content_summary", "")
            or ""
        )

    async def _compile_scenes(
        self,
        scene_blocks: list[SceneBlock],
        episode: Any,
        log: Callable[[str], None],
    ) -> tuple[list[SceneMenuItem], list[NovelScene]]:
        scene_menu: list[SceneMenuItem] = []
        seen_scene_ids: set[str] = set()
        pending_scenes: list[NovelScene] = []
        pending_scene_map: dict[str, NovelScene] = {}
        time_plate_counts = self._time_plate_counts(scene_blocks)

        for block in scene_blocks:
            location = str(block.location or "").strip()
            if not location:
                continue

            existing = pending_scene_map.get(location) or await self._find_matching_scene(location)
            if not existing:
                log(f"  跳过缺失基础场景: {location}（AI校对未创建或未复用）")
                continue
            else:
                existing = await self._enrich_scene_prompt_from_block(
                    existing,
                    block,
                    episode,
                    persist=True,
                    log=log,
                )

            derived_requirements = await self._analyze_derived_scenes(existing.name, block)
            normalized_derived = self._build_derived_scene_specs(derived_requirements)
            self._add_to_scene_menu(existing.name, scene_menu, seen_scene_ids)
            for scene_time, count in sorted(time_plate_counts.get(location, {}).items()):
                if count < 2:
                    continue
                time_plate = self._build_time_plate_scene(existing, scene_time, episode)
                existing_time_plate = pending_scene_map.get(
                    time_plate.name
                ) or await self.cognee_store.sqlite_store.get_scene(time_plate.name)
                if not existing_time_plate:
                    pending_scene_map[time_plate.name] = time_plate
                    pending_scenes.append(time_plate)
                self._add_to_scene_menu(
                    time_plate.name,
                    scene_menu,
                    seen_scene_ids,
                    base_scene_id=existing.name,
                    time_of_day=scene_time,
                )
            for requirement in normalized_derived:
                derived_scene = self._build_derived_scene(existing, requirement)
                existing_derived = pending_scene_map.get(
                    derived_scene.name
                ) or await self.cognee_store.sqlite_store.get_scene(derived_scene.name)
                if not existing_derived:
                    pending_scene_map[derived_scene.name] = derived_scene
                    pending_scenes.append(derived_scene)
                self._add_to_scene_menu(
                    derived_scene.name,
                    scene_menu,
                    seen_scene_ids,
                    base_scene_id=existing.name,
                    variant_id=requirement.label,
                )
            extra = f" ({len(normalized_derived)} 派生场景)" if normalized_derived else ""
            log(f"  场景: {existing.name}{extra}")

        return scene_menu, pending_scenes

    async def _compile_narrated_scenes(
        self,
        source_text: str,
        episode: Any,
        log: Callable[[str], None],
    ) -> tuple[list[SceneMenuItem], list[NovelScene]]:
        scene_menu: list[SceneMenuItem] = []
        seen_scene_ids: set[str] = set()
        pending_scenes: list[NovelScene] = []
        pending_scene_map: dict[str, NovelScene] = {}

        scenes = await self._extract_narrated_episode_scenes(source_text, episode, log)
        for scene in scenes:
            scene_name = str(getattr(scene, "name", "") or "").strip()
            if not scene_name:
                continue
            existing = pending_scene_map.get(scene_name) or await self._find_matching_scene(
                scene_name
            )
            canonical_name = scene_name
            if existing:
                canonical_name = existing.name
                if not str(getattr(existing, "environment_prompt", "") or "").strip():
                    await self.cognee_store.sqlite_store.update_scene(
                        existing.name,
                        scene_type=scene.scene_type or existing.scene_type,
                        environment_prompt=scene.environment_prompt,
                        description=scene.description or existing.description,
                    )
                    log(f"  补齐解说场景环境描述: {existing.name}")
            else:
                pending_scenes.append(scene)
                pending_scene_map[scene.name] = scene
                log(f"  新建解说场景: {scene.name}")
            self._add_to_scene_menu(canonical_name, scene_menu, seen_scene_ids)
            log(f"  场景: {canonical_name}")

        return scene_menu, pending_scenes

    async def _extract_narrated_episode_scenes(
        self,
        source_text: str,
        episode: Any,
        log: Callable[[str], None],
    ) -> list[NovelScene]:
        source_text = str(source_text or "").strip()
        if not source_text:
            return []

        requirements = await self._analyze_narrated_scene_requirements(source_text, episode, log)
        if not requirements:
            requirements = self._heuristic_narrated_scene_requirements(source_text)
        if not requirements:
            return []

        source_lines = split_literal_source_text(source_text)
        scenes: list[NovelScene] = []
        seen: set[str] = set()
        for req in requirements[:8]:
            scene_name = str(req.scene_name or "").strip()
            if not scene_name or scene_name in seen:
                continue
            seen.add(scene_name)
            context_lines = [line for line in req.evidence_lines if str(line or "").strip()]
            if not context_lines:
                context_lines = source_lines[:12]
            scene_type = self._normalize_scene_type(req.scene_type)
            enriched = await enrich_scene_environment_from_context(
                scene_name=scene_name,
                aliases=req.aliases,
                scene_type=scene_type,
                interior=scene_type == "interior",
                episodes=[int(getattr(episode, "number", 1) or 1)],
                context_lines=context_lines,
                synopsis=str(getattr(episode, "content_summary", "") or ""),
            )
            if not str(enriched.description or "").strip():
                enriched.description = str(req.description or "").strip()
            enriched.notes = (
                str(enriched.notes or "").strip()
                or f"由 AssetCompiler 从解说稿自动创建 (ep{episode.number})"
            )
            scenes.append(enriched)

        return scenes

    async def _analyze_narrated_scene_requirements(
        self,
        source_text: str,
        episode: Any,
        log: Callable[[str], None],
    ) -> list[NarratedSceneRequirement]:
        existing_scenes = await self.cognee_store.sqlite_store.list_scenes()
        existing_scene_names = {
            str(getattr(scene, "name", "") or "").strip()
            for scene in existing_scenes
            if str(getattr(scene, "name", "") or "").strip()
        }
        excerpt = source_text[:12000]
        task = f"""请为当前集规划 2.0 场景资产。

## 集数
第 {getattr(episode, "number", "")} 集 {getattr(episode, "title", "") or ""}

## 已有场景资产
{", ".join(sorted(existing_scene_names)) if existing_scene_names else "（无）"}

## 本集文本
{excerpt}
"""
        agent = Agent(
            get_newapi_text_pydantic_model(
                "NARRATED_SCENE_ASSET_MODEL",
                "gemini-3.5-flash",
            ),
            system_prompt=NARRATED_SCENE_PROMPT,
            model_settings=get_newapi_text_pydantic_model_settings(
                "NARRATED_SCENE_ASSET_THINKING_LEVEL",
                "low",
            ),
            output_type=NarratedScenePlanOutput,
            output_retries=2,
            validation_context={
                "source_text": source_text,
                "existing_scene_names": existing_scene_names,
            },
            name="解说剧场景资产规划师",
        )
        try:
            result = await agent.run(task)
            return list(result.output.scenes or [])
        except Exception as exc:
            log(f"  解说场景分析失败，改用文本规则兜底: {exc}")
            return []

    async def _enrich_scene_prompt_from_block(
        self,
        scene: NovelScene,
        block: SceneBlock,
        episode: Any,
        *,
        persist: bool,
        log: Callable[[str], None],
    ) -> NovelScene:
        if str(scene.environment_prompt or "").strip():
            return scene

        enriched = await enrich_scene_environment_from_context(
            scene_name=scene.name,
            aliases=scene.aliases,
            scene_type=scene.scene_type,
            time_of_day=str(getattr(block, "time_of_day", "") or ""),
            interior=str(getattr(block, "interior_exterior", "") or "内") != "外",
            episodes=[int(getattr(episode, "number", 1) or 1)],
            characters=list(getattr(block, "characters", []) or []),
            context_lines=list(getattr(block, "lines", []) or []),
        )
        scene.scene_type = enriched.scene_type or scene.scene_type
        scene.environment_prompt = enriched.environment_prompt
        if str(enriched.description or "").strip():
            scene.description = enriched.description

        if persist:
            await self.cognee_store.sqlite_store.update_scene(
                scene.name,
                scene_type=scene.scene_type,
                environment_prompt=scene.environment_prompt,
                description=scene.description,
            )
            log(f"  补齐场景环境描述: {scene.name}")

        return scene

    async def _analyze_derived_scenes(
        self,
        scene_name: str,
        block: SceneBlock,
    ) -> list[DerivedSceneRequirement]:
        content_lines = [line for line in block.lines if str(line or "").strip()]
        has_env_desc = any(str(line or "").strip().startswith("△") for line in content_lines)
        if len(content_lines) < 3 and not has_env_desc:
            return []
        block_text = "\n".join(content_lines)
        if not block_text:
            return []
        task = f"""分析场景 `{scene_name}` 在当前场景块里的视觉状态。

## 场次头
{block.header_line or "无"}

## 当前场景块文本
{block_text}
"""
        agent = Agent(
            get_newapi_text_pydantic_model(
                "EPISODE_SCENE_PLANNER_MODEL",
                "gemini-3.5-flash",
            ),
            system_prompt=DERIVED_SCENE_PROMPT,
            model_settings=get_newapi_text_pydantic_model_settings(
                "EPISODE_SCENE_PLANNER_THINKING_LEVEL",
                "low",
            ),
            output_type=BlockDerivedSceneOutput,
            output_retries=2,
            name="派生场景分析师",
        )
        result = await agent.run(task)
        return result.output.derived_scenes

    async def _compile_props(
        self,
        scene_blocks: list[SceneBlock],
        episode: Any,
        log: Callable[[str], None],
    ) -> list[PropMenuItem]:
        prop_menu: list[PropMenuItem] = []
        seen_prop_ids: set[str] = set()
        existing_props = await self.cognee_store.sqlite_store.list_props()
        episode_selected_props: dict[str, str] = {}

        for block_index, block in enumerate(scene_blocks):
            block_text = "\n".join(
                item for item in [block.header_line, *block.lines] if str(item or "").strip()
            )
            if not block_text.strip():
                continue

            preselected = self._preselect_existing_props(block_text, existing_props)
            prior_reuse = self._prior_selected_props_in_block(block, episode_selected_props)
            if prior_reuse and self._is_short_prior_prop_reuse_block(block, preselected):
                requirements = prior_reuse
            else:
                try:
                    requirements = await self._analyze_block_props(
                        block,
                        preselected,
                        sorted(set(episode_selected_props.values())),
                    )
                except ValueError as exc:
                    log(f"  道具[{block_index + 1}]: {exc}")
                    raise
            requirements = self._filter_background_props(requirements, block_text)
            for req in requirements:
                existing = await self._find_matching_prop(req.prop_name)
                if existing:
                    prop_id = existing.name
                    source = "复用"
                else:
                    prop_id = self._match_selected_prop(req.prop_name, episode_selected_props)
                    source = "本集复用" if prop_id else "本集局部"
                prop_id = prop_id or str(req.prop_name or "").strip()
                if not prop_id:
                    continue
                episode_selected_props[str(req.prop_name or "").strip()] = prop_id
                episode_selected_props[prop_id] = prop_id
                self._add_to_prop_menu(prop_id, prop_menu, seen_prop_ids, existing, req)
                log(f"  道具[{block_index + 1}]: {prop_id} [{source}]")

        return prop_menu

    @classmethod
    def _prior_selected_props_in_block(
        cls,
        block: SceneBlock,
        episode_selected_props: dict[str, str],
    ) -> list[PropRequirement]:
        block_text = "\n".join(
            item for item in [block.header_line, *block.lines] if str(item or "").strip()
        )
        result: list[PropRequirement] = []
        seen: set[str] = set()
        prior_ids = sorted(
            {value for value in episode_selected_props.values() if str(value or "").strip()}
        )
        for prop_id in prior_ids:
            if prop_id in seen:
                continue
            if cls._contains_text(block_text, prop_id) or cls._contains_text(prop_id, block_text):
                seen.add(prop_id)
                result.append(PropRequirement(prop_name=prop_id))
        return result

    @staticmethod
    def _is_short_prior_prop_reuse_block(
        block: SceneBlock,
        preselected: list[NovelProp],
    ) -> bool:
        content_lines = [line for line in block.lines if str(line or "").strip()]
        has_env_desc = any(str(line or "").strip().startswith("△") for line in content_lines)
        return len(content_lines) <= 3 and not has_env_desc and not preselected

    def _preselect_existing_props(
        self,
        block_text: str,
        existing_props: list[NovelProp],
    ) -> list[NovelProp]:
        result: list[NovelProp] = []
        seen: set[str] = set()
        for prop in existing_props:
            name = str(prop.name or "").strip()
            if not name or name in seen:
                continue
            tokens = [name, *(prop.aliases or [])]
            if any(
                LiteralScriptWritingWorkflow._contains_text(block_text, token)
                for token in tokens
                if str(token or "").strip()
            ):
                seen.add(name)
                result.append(prop)
        return result

    async def _analyze_block_props(
        self,
        block: SceneBlock,
        preselected: list[NovelProp],
        prior_selected_prop_ids: list[str],
    ) -> list[PropRequirement]:
        block_text = "\n".join(
            item for item in [block.header_line, *block.lines] if str(item or "").strip()
        )
        content_lines = [line for line in block.lines if str(line or "").strip()]
        has_env_desc = any(str(line or "").strip().startswith("△") for line in content_lines)
        if (
            len(content_lines) < 2
            and not preselected
            and not prior_selected_prop_ids
            and not has_env_desc
        ):
            return []
        candidate_lines = []
        allowed_existing_names: set[str] = set()
        for prop in preselected:
            candidate_lines.append(f"- {prop.name}")
            allowed_existing_names.add(str(prop.name or "").strip())
            for alias in prop.aliases or []:
                alias_text = str(alias or "").strip()
                if alias_text:
                    allowed_existing_names.add(alias_text)
        if prior_selected_prop_ids:
            candidate_lines.append("## 本集前面已选道具")
            for prop_id in prior_selected_prop_ids:
                candidate_lines.append(f"- {prop_id}")
                allowed_existing_names.add(str(prop_id or "").strip())

        candidate_section = "\n".join(candidate_lines) if candidate_lines else "（无预筛候选）"
        task = f"""分析当前场景块中的关键道具。

## 场次头
{block.header_line or "无"}

## 当前场景块文本
{block_text}

## 预筛命中的已有道具
{candidate_section}
"""
        agent = Agent(
            get_newapi_text_pydantic_model(
                "EPISODE_PROP_PLANNER_MODEL",
                "gemini-3.5-flash",
            ),
            system_prompt=BLOCK_PROP_PROMPT,
            model_settings=get_newapi_text_pydantic_model_settings(
                "EPISODE_PROP_PLANNER_THINKING_LEVEL",
                "low",
            ),
            output_type=BlockPropRequirements,
            output_retries=2,
            validation_context={
                "block_text": block_text,
                "allowed_existing_names": allowed_existing_names,
            },
            name="场景块道具分析师",
        )
        try:
            result = await agent.run(task)
        except (UnexpectedModelBehavior, ValidationError) as exc:
            raise ValueError(f"{PROP_OUTPUT_SCHEMA_HINT}；原始错误: {exc}") from exc
        return result.output.requirements

    @classmethod
    def _has_interaction_evidence(cls, prop_name: str, block_text: str) -> bool:
        name = str(prop_name or "").strip()
        if not name:
            return False
        lines = [
            str(line or "").strip() for line in block_text.splitlines() if str(line or "").strip()
        ]
        for line in lines:
            for verb in INTERACTION_VERBS:
                if f"{name}{verb}" in line or f"{verb}{name}" in line:
                    return True
                if re.search(rf"{re.escape(name)}.{{0,12}}{re.escape(verb)}", line):
                    return True
                if re.search(rf"{re.escape(verb)}.{{0,12}}{re.escape(name)}", line):
                    return True
        return False

    @classmethod
    def _filter_background_props(
        cls,
        requirements: list[PropRequirement],
        block_text: str,
    ) -> list[PropRequirement]:
        filtered: list[PropRequirement] = []
        for req in requirements:
            name = str(req.prop_name or "").strip()
            if not name:
                continue
            if any(token in name for token in NON_PROP_KEYWORDS):
                continue
            if name in BACKGROUND_PROP_DENYLIST and not cls._has_interaction_evidence(
                name, block_text
            ):
                continue
            filtered.append(req)
        return filtered

    @classmethod
    def _match_selected_prop(cls, prop_name: str, episode_selected_props: dict[str, str]) -> str:
        normalized_name = str(prop_name or "").strip()
        if not normalized_name:
            return ""
        exact = episode_selected_props.get(normalized_name, "")
        if exact:
            return exact
        canonical_ids = sorted(
            {value for value in episode_selected_props.values() if str(value or "").strip()}
        )
        for canonical in canonical_ids:
            if cls._contains_text(canonical, normalized_name) or cls._contains_text(
                normalized_name, canonical
            ):
                return canonical
        return ""

    @staticmethod
    def _contains_text(haystack: str, needle: str) -> bool:
        return LiteralScriptWritingWorkflow._contains_text(haystack, needle)

    @staticmethod
    def _normalize_scene_type(value: str) -> str:
        normalized = str(value or "").strip().lower()
        if normalized in {"exterior", "外", "室外", "外景"}:
            return "exterior"
        if normalized in {"nature", "自然", "自然环境", "山林", "野外"}:
            return "nature"
        return "interior"

    @classmethod
    def _guess_scene_type_from_name(cls, name: str) -> str:
        if any(token in name for token in ("山", "林", "河", "湖", "海", "谷", "荒野")):
            return "nature"
        if any(token in name for token in ("街", "路", "巷", "广场", "码头", "城门", "山路")):
            return "exterior"
        return "interior"

    @classmethod
    def _heuristic_narrated_scene_requirements(
        cls,
        source_text: str,
    ) -> list[NarratedSceneRequirement]:
        suffixes = (
            "护士站",
            "急诊室",
            "会议室",
            "办公室",
            "电梯间",
            "出租屋",
            "咖啡馆",
            "走廊",
            "楼道",
            "客厅",
            "卧室",
            "书房",
            "厨房",
            "病房",
            "门口",
            "街口",
            "小巷",
            "山路",
            "公路",
            "庭院",
            "大殿",
            "广场",
            "码头",
            "车站",
            "机场",
            "酒吧",
            "餐厅",
            "天台",
            "学校",
            "医院",
            "警局",
            "公司",
            "别墅",
            "王府",
            "城门",
            "山谷",
            "森林",
            "河边",
        )
        suffix_pattern = "|".join(re.escape(suffix) for suffix in suffixes)
        pattern = re.compile(rf"[\u4e00-\u9fff]{{1,10}}(?:{suffix_pattern})")
        seen: set[str] = set()
        requirements: list[NarratedSceneRequirement] = []
        for line in split_literal_source_text(source_text):
            text = str(line or "").strip()
            if not text:
                continue
            for match in pattern.finditer(text):
                name = match.group(0).strip("，。！？；：、,.!?;: ")
                name = re.sub(
                    r"^.*(?:冲进|走进|进入|来到|回到|赶到|站在|穿过|转入|在|到|进)",
                    "",
                    name,
                ).strip("，。！？；：、,.!?;: ")
                if len(name) < 2 or name in seen:
                    continue
                seen.add(name)
                requirements.append(
                    NarratedSceneRequirement(
                        scene_name=name,
                        scene_type=cls._guess_scene_type_from_name(name),
                        evidence_lines=[text],
                    )
                )
                break
            if len(requirements) >= 8:
                break
        return requirements

    @staticmethod
    def _add_to_prop_menu(
        prop_id: str,
        prop_menu: list[PropMenuItem],
        seen_prop_ids: set[str],
        existing: NovelProp | None = None,
        requirement: PropRequirement | None = None,
    ) -> None:
        if prop_id not in seen_prop_ids:
            description = str(getattr(requirement, "description", "") or "").strip()
            visual_prompt = str(getattr(requirement, "visual_prompt", "") or "").strip()
            prop_type = str(getattr(requirement, "prop_type", "") or "").strip() or "object"
            existing_visual = str(getattr(existing, "visual_prompt", "") or "").strip()
            existing_description = str(getattr(existing, "description", "") or "").strip()
            fallback_visual = visual_prompt or description or prop_id
            prop_menu.append(
                PropMenuItem(
                    prop_id=prop_id,
                    prop_type=getattr(existing, "prop_type", "") if existing else prop_type,
                    visual_prompt=existing_visual or existing_description or fallback_visual,
                    description=description or existing_description or existing_visual,
                    owner_identity_id=getattr(existing, "owner", "") if existing else "",
                )
            )
            seen_prop_ids.add(prop_id)

    @staticmethod
    def _normalize_alias_lookup(value: str) -> str:
        return " ".join((value or "").replace("\u3000", " ").strip().lower().split())

    async def _find_matching_scene(self, name: str) -> Optional[NovelScene]:
        scene = await self.cognee_store.sqlite_store.get_scene(name)
        if scene:
            return scene

        all_scenes = await self.cognee_store.sqlite_store.list_scenes()
        base_candidates = [
            item
            for item in all_scenes
            if str(getattr(item, "name", "") or "").strip()
            and not str(getattr(item, "base_scene_id", "") or "").strip()
        ]
        for item in base_candidates:
            if name in item.aliases:
                return item
        for item in base_candidates:
            if name in item.name or item.name in name:
                return item

        return None

    @staticmethod
    def _build_derived_scene(
        parent_scene: NovelScene, requirement: DerivedSceneRequirement
    ) -> NovelScene:
        label = str(requirement.label or "").strip()
        derived_name = compose_derived_scene_name(parent_scene.name, label)
        variant_prompt_parts = [
            str(requirement.description or "").strip(),
            str(requirement.lighting or "").strip(),
            str(requirement.atmosphere or "").strip(),
        ]
        variant_prompt = "\n".join(part for part in variant_prompt_parts if part)
        description = str(requirement.description or "").strip()
        return NovelScene(
            name=derived_name,
            aliases=[parent_scene.name],
            scene_type=parent_scene.scene_type,
            base_scene_id=parent_scene.name,
            variant_id=label,
            environment_prompt="",
            variant_prompt=variant_prompt,
            description=description,
            notes=f"由 AssetCompiler 从场景 {parent_scene.name} 派生",
        )

    @staticmethod
    def _time_plate_counts(scene_blocks: list[SceneBlock]) -> dict[str, dict[str, int]]:
        counts: dict[str, dict[str, int]] = {}
        for block in scene_blocks or []:
            location = str(getattr(block, "location", "") or "").strip()
            scene_time = normalize_time_of_day(str(getattr(block, "time_of_day", "") or ""))
            if not location or not scene_time:
                continue
            counts.setdefault(location, {})
            counts[location][scene_time] = counts[location].get(scene_time, 0) + 1
        return counts

    @staticmethod
    def _build_time_plate_scene(
        parent_scene: NovelScene,
        time_of_day: str,
        episode: Any,
    ) -> NovelScene:
        scene_time = normalize_time_of_day(time_of_day)
        plate_name = compose_derived_scene_name(parent_scene.name, scene_time)
        return NovelScene(
            name=plate_name,
            aliases=[parent_scene.name],
            scene_type=parent_scene.scene_type,
            base_scene_id=parent_scene.name,
            variant_id="",
            time_of_day=scene_time,
            environment_prompt="",
            description="",
            notes=f"由 AssetCompiler 从场景 {parent_scene.name} 创建的空 plate 槽位 (ep{episode.number})",
        )

    @staticmethod
    def _normalize_derived_scenes(
        derived_scenes: list[DerivedSceneRequirement],
    ) -> list[DerivedSceneRequirement]:
        forbidden_exact = {
            "日",
            "夜",
            "晨",
            "晚",
            "午",
            "清晨",
            "上午",
            "正午",
            "午后",
            "黄昏",
            "傍晚",
            "夜晚",
            "白天",
            "晚上",
            "内",
            "外",
            "室内",
            "室外",
            "第一人称",
            "POV",
            "黑屏",
            "空镜",
            "特写",
            "近景",
            "中景",
            "远景",
            "全景",
            "俯拍",
            "仰拍",
            "平视",
            "过肩",
        }
        forbidden_contains = ("内景", "外景", "第一人称", "POV")
        normalized: list[DerivedSceneRequirement] = []
        seen: set[str] = set()
        for raw in derived_scenes or []:
            label = str(getattr(raw, "label", "") or "").strip()
            if not label:
                continue
            if label in forbidden_exact:
                continue
            if any(token in label for token in forbidden_contains):
                continue
            if label in seen:
                continue
            seen.add(label)
            description = str(getattr(raw, "description", "") or "").strip()
            lighting = str(getattr(raw, "lighting", "") or "").strip()
            atmosphere = str(getattr(raw, "atmosphere", "") or "").strip()
            normalized.append(
                DerivedSceneRequirement(
                    label=label,
                    description=description or label,
                    lighting=lighting,
                    atmosphere=atmosphere,
                )
            )
        return normalized

    @classmethod
    def _build_derived_scene_specs(
        cls, derived_scenes: list[DerivedSceneRequirement]
    ) -> list[DerivedSceneRequirement]:
        return cls._normalize_derived_scenes(derived_scenes)

    @staticmethod
    def _add_to_scene_menu(
        scene_id: str,
        scene_menu: list[SceneMenuItem],
        seen_scene_ids: set[str],
        *,
        base_scene_id: str = "",
        variant_id: str = "",
        time_of_day: str = "",
    ) -> None:
        if scene_id not in seen_scene_ids:
            scene_menu.append(
                SceneMenuItem(
                    scene_id=scene_id,
                    base_scene_id=str(base_scene_id or "").strip(),
                    variant_id=str(variant_id or "").strip(),
                    time_of_day=str(time_of_day or "").strip(),
                )
            )
            seen_scene_ids.add(scene_id)
            return

    async def _find_matching_prop(self, name: str) -> Optional[NovelProp]:
        prop = await self.cognee_store.sqlite_store.get_prop(name)
        if prop:
            return prop

        lookup = self._normalize_alias_lookup(name)
        all_props = await self.cognee_store.sqlite_store.list_props()
        for item in all_props:
            if any(self._normalize_alias_lookup(alias) == lookup for alias in item.aliases):
                return item
            if name in item.name or item.name in name:
                return item

        return None
