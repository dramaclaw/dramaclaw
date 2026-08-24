"""NovelVideo 自定义 Cognee Pipeline。

实现小说知识图谱的检索与结构化提取：
- 原始小说由 Cognee 构建知识图谱
- 角色、剧集、场景和道具等产品数据由 SQLite 持久化
- 规划和提取流程只读取 Cognee，不把派生产品数据回写图谱
"""

from __future__ import annotations

import hashlib
import json
import re
from typing import Any, Awaitable, Callable, Dict, List, Literal, Optional, Protocol, TypeVar
from pydantic import BaseModel, Field, field_validator, model_validator

from novelvideo.shared.env_guard import preserve_st_env
from novelvideo.config import get_newapi_structured_output_litellm_kwargs
from novelvideo.utils.bounded_concurrency import (
    default_llm_concurrency,
    map_bounded,
)
from novelvideo.models import (
    CharacterIdentity,
    NovelCharacter,
    NovelEpisode,
    NovelEvent,
    NovelVisualBeat,
)
from novelvideo.cognee.screenplay_normalizer import (
    NormalizedSceneBlock,
    clean_scene_name_and_time,
    normalize_time_of_day,
    normalize_screenplay_scenes,
)
from novelvideo.time_of_day import LlmTimeOfDay

# 重要：必须先导入 config，在 cognee 被导入之前设置环境变量
from . import config as _cognee_config  # noqa: F401
from .ladybug_access import ladybug_graph_access

# cognee 重量级模块延迟导入（避免 reload 时拉起整个初始化链）
# LLMGateway, Task, run_pipeline, setup
# 在各函数内部按需 import

# 业务模型已迁移到 novelvideo.models
from novelvideo.models import (
    CharacterIdentity,
    NovelCharacter,
    NovelEvent,
    NovelEpisode,
    NovelVisualBeat,
    NovelScene,
    NovelProp,
)

# ============================================================
# LLM 输出容器
# ============================================================


class CharacterList(BaseModel):
    """角色列表容器。"""

    characters: List[NovelCharacter]


class EpisodeList(BaseModel):
    """剧集列表容器。"""

    episodes: List[NovelEpisode]


_GraphReadResult = TypeVar("_GraphReadResult")


async def _run_graph_read(
    state_dir: Optional[str],
    operation: Callable[[], Awaitable[_GraphReadResult]],
) -> _GraphReadResult:
    """Run only the actual Ladybug query under the project read scope."""

    if not state_dir:
        # Test doubles can operate without project storage. A real Ladybug
        # adapter fails closed because it requires an explicit access scope.
        return await operation()
    async with ladybug_graph_access(state_dir, read_only=True):
        return await operation()


def _stringify_search_fragment(value) -> str:
    """Normalize heterogeneous Cognee search payloads into plain text."""
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return "\n".join(
            fragment
            for fragment in (_stringify_search_fragment(item) for item in value)
            if fragment
        )
    if isinstance(value, dict):
        search_result = value.get("search_result")
        if search_result is not None and search_result is not value:
            return _stringify_search_fragment(search_result)
        return json.dumps(value, ensure_ascii=False)
    if hasattr(value, "model_dump"):
        return json.dumps(value.model_dump(), ensure_ascii=False)
    return str(value)


def _clean_aliases(primary_name: str, aliases: List[str]) -> List[str]:
    """规范化 alias：strip、去重、去掉与主名等价的项。"""
    primary = (primary_name or "").strip()
    cleaned: List[str] = []
    seen: set[str] = set()
    for alias in aliases or []:
        normalized = (alias or "").strip()
        if not normalized or normalized == primary or normalized in seen:
            continue
        cleaned.append(normalized)
        seen.add(normalized)
    return cleaned


# ============================================================
# 自定义提取 Tasks
# ============================================================


async def extract_episodes_from_text(
    text: str,
    target_episodes: int = 10,
) -> List[NovelEpisode]:
    """从小说文本中规划剧集。"""
    with preserve_st_env():
        from cognee.infrastructure.llm.LLMGateway import LLMGateway

    system_prompt = f"""你是一个专业的剧集规划师。将小说内容规划为 {target_episodes} 集。

对于每集，生成：
1. number: 集数
2. title: 吸引人的标题
3. content_summary: 内容摘要（50字以内）
4. main_conflict: 主要冲突
5. cliffhanger: 结尾悬念（让观众想看下一集）
6. key_events: 关键事件列表

规则：
- 每集要有明确的冲突和悬念
- 情节连贯，前后呼应
- 高潮放在中后期"""

    result = await LLMGateway.acreate_structured_output(
        text,
        system_prompt,
        EpisodeList,
        **get_newapi_structured_output_litellm_kwargs(),
    )
    return result.episodes


async def generate_visual_prompts(
    characters: List[NovelCharacter],
) -> List[NovelCharacter]:
    """为角色生成/优化 face_prompt。

    注意：不添加风格前缀，风格在图像生成时动态添加。
    """
    # 如果已有 face_prompt，跳过
    for char in characters:
        if not char.face_prompt and char.description:
            # 从描述中生成纯面部特征（简单回退）
            char.face_prompt = f"{char.name}，{char.gender}，{char.description}"
    return characters


# ============================================================
# 统一 Pipeline
# ============================================================


async def _attach_character_metadata(
    characters: List[NovelCharacter],
    project_name: str = "",  # 保留参数用于向后兼容，但不再使用
) -> List[NovelCharacter]:
    """为角色附加元数据。

    注意：由于使用数据库级别隔离，不再需要 project_name。
    """
    return characters


async def _attach_episode_metadata(
    episodes: List[NovelEpisode],
    project_name: str = "",  # 保留参数用于向后兼容，但不再使用
) -> List[NovelEpisode]:
    """为剧集附加元数据。

    注意：由于使用数据库级别隔离，不再需要 project_name。
    """
    return episodes


async def run_character_extraction_pipeline(
    text: str,
    dataset_name: str = "novel",
    project_name: str = "",
) -> List[NovelCharacter]:
    """运行角色提取 Pipeline（已废弃）。

    文本提取已移除，请改用 build_characters_from_graph() 从图谱提取角色。
    """
    raise NotImplementedError(
        "extract_characters_from_text 已移除。"
        "请使用 CogneeStore.build_characters_from_graph() 从图谱提取角色。"
    )


async def run_episode_planning_pipeline(
    text: str,
    target_episodes: int = 10,
    dataset_name: str = "novel",
    project_name: str = "",
) -> List[NovelEpisode]:
    """运行剧集规划 Pipeline。"""
    with preserve_st_env():
        from cognee.modules.pipelines import Task, run_pipeline
        from cognee.modules.engine.operations.setup import setup

    await setup()

    async def extract_with_count(t: str) -> List[NovelEpisode]:
        return await extract_episodes_from_text(t, target_episodes)

    async def attach_metadata(episodes: List[NovelEpisode]) -> List[NovelEpisode]:
        return await _attach_episode_metadata(episodes, project_name)

    # 用于捕获中间结果的包装函数
    captured_episodes: List[NovelEpisode] = []

    async def capture_episodes(episodes: List[NovelEpisode]) -> List[NovelEpisode]:
        """Capture planner output; the caller persists episodes to SQLite."""
        nonlocal captured_episodes
        captured_episodes = episodes
        return episodes

    tasks = [
        Task(extract_with_count),
        Task(attach_metadata),
        Task(capture_episodes),
    ]

    async for result in run_pipeline(tasks=tasks, data=text, datasets=[dataset_name]):
        # 尝试从结果中获取剧集
        if isinstance(result, list) and result and isinstance(result[0], NovelEpisode):
            captured_episodes = result

    return captured_episodes


# ============================================================
# 分阶段构建：从图谱提取角色
# ============================================================


class CharacterEnrichment(BaseModel):
    """LLM 补充的角色信息（不含身份，身份由 IdentityPlanner 按集规划）。"""

    name: str = Field(..., description="角色主名称")
    aliases: List[str] = Field(
        default_factory=list, description="原文中真实出现过的稳定别名/昵称/固定称呼"
    )
    role: str = Field(default="", description="角色定位")
    is_main: bool = Field(default=False, description="是否为主角/核心角色")
    gender: str = Field(default="", description="性别")
    age_group: Literal["child", "youth", "middle", "elder"] = Field(
        default="youth", description="年龄段: child/youth/middle/elder"
    )
    body_type: str = Field(default="", description="体型描述")
    description: str = Field(default="", description="外貌描述")
    face_prompt: str = Field(
        default="",
        description="纯面部特征描述（发型、眼睛、肤色），不含服装",
    )


class CharacterEnrichmentList(BaseModel):
    """角色补充信息列表。"""

    characters: List[CharacterEnrichment]


async def extract_characters_from_graph(
    dataset_name: str = "novel",
    project_name: str = "",
    project_dir: Optional[str] = None,
    state_dir: Optional[str] = None,
    novel_text: Optional[str] = None,
    on_progress: Optional[Any] = None,
    on_log: Optional[Any] = None,
) -> List[NovelCharacter]:
    """从 cognee 图谱中提取角色（分阶段架构）。

    流程：
    1. 通过 cognee.search(only_context=True) 获取图谱上下文（人物+关系的摘要）
    2. 用 LLM 结构化输出提取角色信息
    3. 后处理去重
    4. 返回调用方，由 SQLite 持久化

    Args:
        dataset_name: Cognee 数据集名称
        project_name: 项目名称
        project_dir: 项目目录（用于备用全文提取）
        on_progress: 进度回调
        on_log: 日志回调

    Returns:
        提取的角色列表
    """
    with preserve_st_env():
        import cognee
        from cognee.api.v1.search import SearchType
        from cognee.infrastructure.llm.LLMGateway import LLMGateway

    def report(progress: float, task: str):
        if on_progress:
            on_progress(progress, task)

    def log(message: str):
        print(f"[extract_characters] {message}")

    # Step 1: 通过 cognee.search 获取图谱上下文
    report(0.1, "通过图谱检索人物信息...")
    log("使用 cognee.search(only_context=True) 获取图谱上下文...")

    context_text = ""
    try:
        results = await _run_graph_read(
            state_dir,
            lambda: cognee.search(
                query_text="列出小说中所有人物角色，包括他们的关系、别名、身份特征和外貌描述",
                query_type=SearchType.GRAPH_COMPLETION,
                datasets=[dataset_name],
                only_context=True,
                top_k=30,
            ),
        )
        if results:
            parts = []
            for item in results:
                if hasattr(item, "search_result"):
                    parts.append(_stringify_search_fragment(item.search_result))
                elif isinstance(item, dict):
                    parts.append(_stringify_search_fragment(item))
                else:
                    parts.append(_stringify_search_fragment(item))
            context_text = "\n".join(parts)
            log(f"图谱上下文获取成功: {len(context_text)} 字符")
    except Exception as e:
        import logging

        logging.warning(f"cognee.search 失败: {e}")
        log(f"cognee.search 失败: {e}")
        raise RuntimeError("Cognee 图谱角色搜索失败") from e

    if not context_text.strip():
        log("⚠️ 图谱搜索无数据，请先构建图谱（cognify）")
        return []

    # 注入人物设定上下文（辅助图谱，不替代）
    if novel_text:
        from .script_parser import extract_synopsis

        synopsis = extract_synopsis(novel_text)
        if synopsis:
            context_text += f"\n\n【剧本人物设定原文】\n{synopsis}"
            log(f"已注入人物设定上下文: {len(synopsis)} 字符")

    # Step 2: LLM 结构化提取
    report(0.3, "LLM 结构化提取角色...")
    log("使用图谱上下文进行 LLM 结构化提取...")

    system_prompt = f"""你是小说角色分析专家。以下是从知识图谱中提取的人物角色信息和关系。
请基于图谱上下文提取所有人物角色。

⚠️ 核心规则：
1. **只提取人类角色**（男性、女性角色）
2. **不要提取**：动物、宠物、神兽、怪物、精灵、机器人等非人类实体
3. 图谱中的别名/称谓（如"陛下"→萧玦、"靖王"→某人）应合并到同一角色
4. **不要提取身份/服装信息** — 身份由后续流程单独规划
5. **年龄变体是同一角色**：同一人物的幼年/少年/青年/中年/老年形态必须合并为一个角色，age_group 取角色在故事中**最主要的时期**对应的年龄段。不同年龄的外貌差异由后续身份系统处理，不在此步骤拆分。例如：小说中出现"小谢铮"（幼年回忆）和"谢铮"（成年主线），应合并为一个角色"谢铮"，age_group="youth"，aliases 中包含"小谢铮"

对于每个角色，生成：
1. name: 角色主名称（最正式的称呼）
2. aliases: 该角色在原文中真实出现过的其他称呼/头衔/昵称（利用图谱关系发现的稳定别名）
3. role: 角色定位（如：主角、闺蜜、前男友、皇后）
4. is_main: 是否为解说主角/第一人称叙述者（整部小说只能有 1 个 is_main=True）
5. gender: 性别（男/女）
6. age_group: 年龄段分类，必须是以下四个值之一: child（儿童）/ youth（青年）/ middle（中年）/ elder（老年）
7. body_type: 体型描述（如：纤细高挑、健壮魁梧、娇小玲珑）
8. description: 外貌和性格特征

9. **face_prompt**: 纯面部特征描述（⚠️ 关键！不含服装！）
   格式：[性别]，[年龄段]，[发型发色]，[眼睛特征]，[肤色]，[脸型/骨骼]
   示例："女性，二十多岁，黑色长发马尾，黑色杏眼，小麦肤色，瓜子脸"
   ⚠️ 不要在 face_prompt 中描述服装！

规则：
- face_prompt 必须是纯面部特征，绝对不能包含服装描述
- 图谱中同一人物的不同称呼要合并（利用 is_alias_of、same_as 等关系）
- aliases 只保留原文里真实出现过、且能稳定指向该角色的称呼
- 不要把过于泛化、依赖上下文才成立的称谓塞进 aliases，例如“男人 / 女人 / 老板 / 爸爸 / 女儿 / 店员”这类高歧义称呼默认不要收，除非图谱上下文已经明确它稳定指向同一角色
- 如果信息不足，只允许对 role / body_type / description 做保守推测；不要为 aliases 编造原文未出现的称呼"""

    try:
        result = await LLMGateway.acreate_structured_output(
            context_text,
            system_prompt,
            CharacterEnrichmentList,
            **get_newapi_structured_output_litellm_kwargs(),
        )
        characters = []
        for enriched in result.characters:
            # 自动映射 Fish Audio voice ID
            from novelvideo.config import get_fish_voice_id

            fish_voice_id = get_fish_voice_id(enriched.age_group, enriched.gender)
            char = NovelCharacter(
                name=enriched.name,
                aliases=_clean_aliases(enriched.name, enriched.aliases or []),
                role=enriched.role,
                is_main=enriched.is_main,
                gender=enriched.gender,
                age_group=enriched.age_group,
                body_type=enriched.body_type,
                fish_voice_id=fish_voice_id,
                description=enriched.description,
                face_prompt=enriched.face_prompt,
            )
            char.ensure_tag()
            characters.append(char)
        main_count = sum(1 for c in characters if c.is_main)
        if main_count > 1:
            found_first = False
            for character in characters:
                if not character.is_main:
                    continue
                if found_first:
                    character.is_main = False
                else:
                    found_first = True
            narrator_main = next((c.name for c in characters if c.is_main), "")
            log(f"⚠️ LLM 返回 {main_count} 个解说主角，已只保留第一个: {narrator_main}")
        log(f"LLM 结构化提取完成: {len(characters)} 个角色")
    except Exception as e:
        import logging

        logging.error(f"LLM 结构化提取失败: {e}")
        log(f"⚠️ LLM 结构化提取失败: {e}")
        raise RuntimeError("LLM 图谱角色提取失败") from e

    report(0.9, "提取完成")

    report(1.0, "完成")
    return characters


# ============================================================
# 分阶段构建：增强的剧集规划
# ============================================================


# Legacy-only: reached from build_episodes(), which runs only when
# planning_mode="ai". No current frontend workflow selects that mode.
# Structured-v2 projects must not enter this path.
async def extract_episodes_with_characters(
    text: str,
    target_episodes: int = 10,
    known_characters: Optional[List[str]] = None,
    dataset_name: str = "novel",
    project_name: str = "",
    on_log: Optional[Any] = None,
) -> List[NovelEpisode]:
    """规划剧集（支持已知角色列表）。

    与 extract_episodes_from_text 的区别：
    - 接受已确认的角色列表，确保剧集中引用的角色一致
    - 会将角色列表注入到 Prompt 中

    Args:
        text: 小说全文
        target_episodes: 目标剧集数
        known_characters: 已确认的角色名称列表
        dataset_name: 数据集名称
        project_name: 项目名称
        on_log: 日志回调函数

    Returns:
        规划的剧集列表
    """
    with preserve_st_env():
        from cognee.infrastructure.llm.LLMGateway import LLMGateway
        from cognee.modules.engine.operations.setup import setup

    def log(message: str):
        # 只打印到控制台，不调用 on_log（由 store.py 统一管理日志回调）
        print(f"[extract_episodes] {message}")

    await setup()
    log(f"开始规划 {target_episodes} 集...")

    character_hint = ""
    if known_characters:
        character_hint = f"""
已确认的角色列表：
{', '.join(known_characters)}

⚠️ 重要：character_names 字段只能从上述列表中选择，不要添加新角色名。
"""
        log(f"已知角色: {len(known_characters)} 个")

    system_prompt = f"""你是一个专业的剧集规划师。将小说内容规划为 {target_episodes} 集。
{character_hint}
对于每集，生成：
1. number: 集数
2. title: 吸引人的标题
3. chapter_start: 对应的起始章节（估计值）
4. chapter_end: 对应的结束章节（估计值）
5. content_summary: 内容摘要（50字以内）
6. main_conflict: 主要冲突
7. cliffhanger: 结尾悬念（让观众想看下一集）
8. key_events: 关键事件列表（3-5个）
9. character_names: 本集出场角色（从已确认角色中选择）

规则：
- 每集要有明确的冲突和悬念
- 情节连贯，前后呼应
- 高潮放在中后期
- 确保角色名称与已确认列表一致"""

    log("调用 LLM 规划剧集...")
    result = await LLMGateway.acreate_structured_output(
        text,
        system_prompt,
        EpisodeList,
        **get_newapi_structured_output_litellm_kwargs(),
    )
    log(f"LLM 返回 {len(result.episodes)} 集")

    # 验证剧集编号
    episode_numbers = [ep.number for ep in result.episodes]
    log(f"剧集编号: {episode_numbers}")

    if len(result.episodes) < target_episodes:
        log(
            f"⚠️ 警告：LLM 返回的集数 ({len(result.episodes)}) 少于目标 ({target_episodes})"
        )

    # 检查是否从 1 开始，如果不是则自动修正
    if episode_numbers and min(episode_numbers) != 1:
        log(
            f"⚠️ 警告：剧集编号不是从 1 开始，最小编号: {min(episode_numbers)}，正在自动修正..."
        )
        result.episodes.sort(key=lambda ep: ep.number)
        for i, ep in enumerate(result.episodes, start=1):
            if ep.number != i:
                log(f"  修正剧集编号: {ep.number} → {i}")
                ep.number = i

    # 检查编号是否连续
    sorted_numbers = sorted(episode_numbers)
    expected_numbers = list(range(1, len(result.episodes) + 1))
    if sorted_numbers != expected_numbers:
        log(f"⚠️ 警告：剧集编号不连续，正在自动修正...")
        result.episodes.sort(key=lambda ep: ep.number)
        for i, ep in enumerate(result.episodes, start=1):
            if ep.number != i:
                log(f"  修正剧集编号: {ep.number} → {i}")
                ep.number = i

    log(
        f"剧集规划完成: {len(result.episodes)} 集，编号: {[ep.number for ep in result.episodes]}"
    )

    return result.episodes


# ============================================================
# 场景提取 Pipeline
# ============================================================


class SceneEnrichment(BaseModel):
    """LLM 补充的场景信息。"""

    name: str = Field(..., description="场景主名称")
    aliases: List[str] = Field(default_factory=list, description="别名列表")
    scene_type: str = Field(default="interior", description="interior/exterior/nature")
    environment_prompt: str = Field(
        default="",
        description="场景空间视觉描述（按方位描述空间布局、光源方向、建筑风格、材质纹理，150-200字，不含人物）",
    )
    description: str = Field(default="", description="场景叙述性描述")


class SceneEnrichmentList(BaseModel):
    """场景补充信息列表。"""

    scenes: List[SceneEnrichment]


class GraphSceneCandidate(BaseModel):
    """Stable physical scene discovered from Cognee graph context."""

    name: str = Field(
        ..., description="稳定物理地点名称，不包含时间、人物、事件或镜头词"
    )
    aliases: List[str] = Field(default_factory=list, description="图谱中出现的地点别名")
    scene_type: str = Field(default="interior", description="interior/exterior/nature")
    evidence_lines: List[str] = Field(
        default_factory=list,
        description="图谱上下文中支持该地点存在及其固定环境特征的短句",
    )


class GraphSceneCandidateList(BaseModel):
    """Stable physical scenes extracted from Cognee graph context."""

    scenes: List[GraphSceneCandidate] = Field(default_factory=list)


SCENE_ENVIRONMENT_REQUIRED_HEADINGS = ("正面", "左侧", "右侧", "背面")


SCENE_ENRICHMENT_SYSTEM_PROMPT = """你是场景环境设计专家。
根据提供的场景名称和剧本原文，生成该场景的视觉环境描述。

生成：
1. name: 直接使用提供的场景名称（原样返回）
2. aliases: 空列表
3. scene_type: 根据场景判断 interior/exterior/nature
4. environment_prompt: 必须输出“完整 360 空间合同”，使用以下固定标题，不得省略、改名或合并：
   正面：
   左侧：
   右侧：
   背面：
   光源：
   材质/风格：
   禁止元素：

environment_prompt 规则：
- 正面/左侧/右侧/背面必须分别说明该方向的固定空间、墙体/边界、门窗/入口、固定陈设或外部延展。
- 正面是 master 图要看的主方向；背面是 reverse 图要看的方向；左右侧是两者边缘需要连续拼接的空间。
- 如果剧本没有明确某一方向，必须基于场景类型和原文证据合理补全，不能留空，不能写“未提及”。
- 描述中性默认状态；不要把临时剧情动作、天气、人物情绪当成固定环境。
- 不含人物，不含临时剧情道具，不含镜头调度。
- 总长度约 220-320 字，可超过 200 字以保证四向完整。
5. description: 场景叙述性描述（中文，50字以内）"""


# Every heading the contract may carry, in the order they must appear.
SCENE_ENVIRONMENT_ALL_HEADINGS = (
    "正面", "左侧", "右侧", "背面", "光源", "材质/风格", "禁止元素",
)

# A heading may open the text or follow a newline or a sentence break. Models
# routinely emit the whole contract on one line, and rejecting that discards a
# perfectly good description in favour of boilerplate.
_SCENE_HEADING_RE = re.compile(
    r"(?:^|[\n。；;])\s*(" + "|".join(re.escape(h) for h in SCENE_ENVIRONMENT_ALL_HEADINGS) + r")\s*[:：]"
)

# The first line of the generated fallback. Distinctive enough to recognise a
# prompt the system wrote when it could not use the model's.
SCENE_FALLBACK_FINGERPRINT = "最能代表地点身份的主入口、主墙面、主装置或主要活动面作为正面"


def parse_scene_environment_sections(prompt: str) -> list[tuple[str, str]]:
    """Split a 360 contract into (heading, body) pairs, wherever they sit.

    Returns an empty list when the text is not a contract, so callers can tell
    "no sections" from "sections with empty bodies".
    """
    text = str(prompt or "").strip()
    if not text:
        return []

    matches = list(_SCENE_HEADING_RE.finditer(text))
    if not matches:
        return []

    sections: list[tuple[str, str]] = []
    for index, match in enumerate(matches):
        end = matches[index + 1].start() if index + 1 < len(matches) else len(text)
        body = text[match.end() : end].strip().strip("。；;")
        sections.append((match.group(1), body))
    return sections


def _has_required_scene_environment_headings(prompt: str) -> bool:
    """Whether the text is a usable 360 contract.

    Presence alone is not enough: a body that merely mentions "左侧：" in passing
    would pass a substring test. The four directions must each open a section,
    appear in order, and actually say something.
    """
    sections = parse_scene_environment_sections(prompt)
    if not sections:
        return False

    seen = [heading for heading, body in sections if body]
    position = 0
    for required in SCENE_ENVIRONMENT_REQUIRED_HEADINGS:
        try:
            position = seen.index(required, position) + 1
        except ValueError:
            return False
    return True


def normalize_scene_environment_prompt(prompt: str) -> str:
    """Rewrite a valid contract as one section per line.

    Downstream readers and human reviewers both expect the sectioned form; the
    model's single-line output carries the same content in a shape that is hard
    to read and easy to mis-parse later.
    """
    sections = parse_scene_environment_sections(prompt)
    if not sections:
        return str(prompt or "").strip()
    return "\n".join(f"{heading}：{body}" for heading, body in sections if body)


def should_repair_scene_placeholder(existing_prompt: str, new_prompt: str) -> bool:
    """Whether a stored environment prompt is boilerplate worth replacing.

    Both tracks wrote the generated fallback for every scene while the contract
    validator rejected valid single-line model output, so both need the same
    narrow repair on rebuild. All three conditions matter:

    * the stored prompt carries the fallback fingerprint, so it is something
      this code wrote, never something a user typed or edited;
    * the replacement does not carry it, so a rebuild that fell back again does
      not churn the row;
    * the replacement is itself a valid 360 contract, so a malformed or empty
      model response can never overwrite a stored prompt with something worse.
    """
    existing = str(existing_prompt or "")
    replacement = str(new_prompt or "")
    if SCENE_FALLBACK_FINGERPRINT not in existing:
        return False
    if SCENE_FALLBACK_FINGERPRINT in replacement:
        return False
    return _has_required_scene_environment_headings(replacement)


def _compact_scene_context(
    lines: list[str] | tuple[str, ...] | str, *, limit: int = 180
) -> str:
    if isinstance(lines, str):
        raw = lines
    else:
        raw = " ".join(str(line).strip() for line in lines if str(line).strip())
    raw = re.sub(r"\s+", " ", raw).strip()
    return raw[:limit].rstrip()


def _ensure_directional_environment_prompt(
    *,
    prompt: str,
    scene_name: str,
    scene_type: str,
    time_of_day: str,
    context_lines: list[str],
) -> str:
    """Ensure graph-built scene prompts are usable as a 360 spatial contract."""
    text = str(prompt or "").strip()
    if _has_required_scene_environment_headings(text):
        return normalize_scene_environment_prompt(text)

    # Evidence comes from the script, never from the prompt that just failed
    # validation. Quoting a rejected description back as "原文证据" produced a
    # self-referential contract that cited itself as its own source.
    evidence = _compact_scene_context(context_lines)
    if not evidence:
        evidence = f"{scene_name}，{scene_type or 'interior'} 场景"
    type_label = scene_type or "interior"
    return "\n".join(
        [
            f"正面：以“{scene_name}”最能代表地点身份的主入口、主墙面、主装置或主要活动面作为正面；根据原文证据“{evidence}”确定固定结构和主要视觉锚点。",
            f"左侧：从正面视角向左延伸，布置与“{scene_name}”功能一致的侧墙、通道、门窗、固定陈设或外部边界；保持与正面材质、尺度和空间深度连续，不放人物。",
            f"右侧：从正面视角向右延伸，布置与左侧相对的侧向空间、墙体转角、走廊/街道/房间延展或固定设施；不要复制正面主体，只做合理连续补全。",
            f"背面：背对正面时看到该地点的后半空间，可为入口反向、走廊尽端、外院、后墙、窗面、街道延伸或次要功能区；必须和正面/左右侧构成完整 360 度闭合空间。",
            "光源：使用中性默认状态的稳定环境光；光源方向来自场景固定灯具、窗户、天光或室内顶灯，避免把剧情时间或临时情绪当成唯一照明。",
            f"材质/风格：保持{type_label}场景的固定建筑风格、墙地顶材质、门窗结构、家具/设施质感和旧化程度；只描述可复用环境，不描述人物动作。",
            "禁止元素：不出现人物、临时剧情道具、字幕、水印、UI、现代/古代/科幻等与场景名和原文证据冲突的元素。",
        ]
    )



def _create_scene_build_agent(system_prompt: str, output_type: Any, name: str):
    """Create the scene-build business LLM agent.

    This intentionally does not use Cognee's LLMGateway: scene construction uses
    Cognee project context, but its two structured LLM calls are business logic,
    not Cognee graph ingest/cognify/memify work.
    """
    from pydantic_ai import Agent
    from novelvideo.config import (
        get_newapi_structured_output_model_settings,
        get_newapi_text_pydantic_model,
    )

    return Agent(
        get_newapi_text_pydantic_model(
            "SCENE_BUILD_MODEL",
            "gemini-3-flash-preview",
            capability="cognee.llm",
        ),
        system_prompt=system_prompt,
        model_settings=get_newapi_structured_output_model_settings(),
        output_type=output_type,
        name=name,
    )


async def enrich_scene_environment_from_context(
    *,
    scene_name: str,
    scene_type: str = "interior",
    time_of_day: str = "",
    interior: bool = True,
    episodes: list[int] | None = None,
    characters: list[str] | None = None,
    context_lines: list[str] | None = None,
    aliases: list[str] | None = None,
    synopsis: str = "",
    enrichment_agent: Any | None = None,
) -> NovelScene:
    """Generate the canonical 360 environment prompt for one scene.

    Used by both project-level scene construction and episode-level scene planning
    so they do not drift into separate prompt contracts.
    """
    scene_name = str(scene_name or "").strip()
    context_lines = [
        str(line) for line in (context_lines or []) if str(line or "").strip()
    ]
    aliases = list(aliases or [])
    characters = list(characters or [])
    episodes = list(episodes or [])
    scene_type = str(
        scene_type or ("interior" if interior else "exterior") or "interior"
    )

    agent = enrichment_agent or _create_scene_build_agent(
        SCENE_ENRICHMENT_SYSTEM_PROMPT,
        SceneEnrichmentList,
        "Scene Build Enricher",
    )
    context = "\n".join(context_lines[:50])
    synopsis_section = f"\n\n【故事梗概与人物设定】\n{synopsis}" if synopsis else ""
    user_text = f"""场景名称：{scene_name}
出现时间线索：{time_of_day or "无"}（只用于理解剧情出现时段，不要把白天、夜晚、黄昏、月光等时段光照烘焙进基础场景）
室内外：{"内" if interior else "外"}
出现集数：{episodes}
出场人物：{", ".join(characters) if characters else "无"}

以下是该场景在剧本中的原文段落：
{context}{synopsis_section}"""

    try:
        result = (await agent.run(user_text)).output
        if result.scenes:
            enriched = result.scenes[0]
            resolved_type = enriched.scene_type or scene_type
            return NovelScene(
                name=scene_name,
                aliases=_clean_aliases(scene_name, aliases),
                scene_type=resolved_type,
                environment_prompt=_ensure_directional_environment_prompt(
                    prompt=enriched.environment_prompt,
                    scene_name=scene_name,
                    scene_type=resolved_type,
                    time_of_day="",
                    context_lines=context_lines,
                ),
                description=enriched.description,
            )
    except Exception as exc:
        import logging

        logging.error(f"LLM 场景描述生成失败 ({scene_name}): {exc}")

    return NovelScene(
        name=scene_name,
        aliases=_clean_aliases(scene_name, aliases),
        scene_type=scene_type,
        environment_prompt=_ensure_directional_environment_prompt(
            prompt="",
            scene_name=scene_name,
            scene_type=scene_type,
            time_of_day="",
            context_lines=context_lines,
        ),
    )


# Several scenes fit in one enrichment call. Each description runs 150-200
# characters, so a batch stays well inside a useful response length.
class SceneBuildCache(Protocol):
    """What a scene build needs from a store to be resumable.

    A protocol rather than the store itself: this code sits below the store
    layer, and tests drive it with a dict.  ``artifact_type`` is per call
    because a scene build caches several independent stages and none of them
    may read another's rows.
    """

    async def get(
        self, artifact_type: str, cache_keys: list[str]
    ) -> dict[str, str]: ...

    async def save(self, artifact_type: str, results: dict[str, str]) -> None: ...


class StoreAnalysisItemCache:
    """Adapter binding the protocol to a project's SQLite store.

    Nothing about it is scene-specific: ``artifact_type`` is per call, so the
    character build stores its appearance answers in the same table under its
    own type without either stage seeing the other's rows.
    """

    def __init__(self, store: Any) -> None:
        self._store = store

    async def get(self, artifact_type: str, cache_keys: list[str]) -> dict[str, str]:
        return await self._store.get_analysis_item_cache(artifact_type, cache_keys)

    async def save(self, artifact_type: str, results: dict[str, str]) -> None:
        await self._store.save_analysis_item_cache(artifact_type, results)


# The scene build named this adapter first and imports it by that name.
StoreSceneBuildCache = StoreAnalysisItemCache


_ENRICHMENT_BATCH_SIZE = 5

# Bump whenever the enrichment prompt, the contract validator, or the way a
# model answer is turned into a NovelScene changes.  It is part of every cache
# key, so a bump retires every stored result rather than mixing contracts.
SCENE_ENRICHMENT_CACHE_VERSION = 1

SCENE_ENRICHMENT_CACHE_TYPE = "scene_environment"

# Bump alongside the screenplay normalizer or the way its blocks are folded
# into candidates.
SCENE_BLOCKS_CACHE_VERSION = 1

SCENE_BLOCKS_CACHE_TYPE = "scene_blocks"


def scene_enrichment_cache_key(candidate: dict[str, Any], synopsis: str = "") -> str:
    """Hash the exact input one scene's enrichment call is made from.

    Every field the model sees, plus every field used to build the NovelScene
    from its answer, plus the contract version.  Anything left out would let a
    changed input silently reuse a result produced from the old one.

    A scene can be answered by either of two calls — the batch, or the
    per-scene retry it falls through to — and they do not read the same fields.
    The batch sends 24 context lines and no time or episode list; the per-scene
    call sends 50 lines plus both. The key is the *union*, because the result
    is stored under one key whichever call produced it, so a field either call
    reads has to be able to invalidate it. Keying on the batch's inputs alone
    meant a changed time of day, episode list, or context line 25 onwards left
    the key identical and replayed a result built from the old input.

    The cost of the union is an occasional needless rebuild. The cost of the
    intersection is serving a wrong answer, which does not announce itself.
    """
    payload = {
        "v": SCENE_ENRICHMENT_CACHE_VERSION,
        "name": str(candidate.get("name") or ""),
        "aliases": list(candidate.get("aliases") or []),
        "scene_type": str(candidate.get("scene_type") or ""),
        "interior": bool(candidate.get("interior", True)),
        "characters": list(candidate.get("characters") or []),
        "time_of_day": str(candidate.get("time_of_day") or ""),
        "episodes": list(candidate.get("episodes") or []),
        # 50, the larger of the two truncations, for the same reason.
        "context": [
            str(line) for line in (candidate.get("context_lines") or [])[:50]
        ],
        "synopsis": str(synopsis or ""),
    }
    canonical = json.dumps(payload, ensure_ascii=False, sort_keys=True)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def scene_to_cache_payload(scene: NovelScene) -> str:
    return json.dumps(
        {
            "name": scene.name,
            "aliases": list(scene.aliases or []),
            "scene_type": scene.scene_type,
            "environment_prompt": scene.environment_prompt,
            "description": scene.description,
        },
        ensure_ascii=False,
    )


def is_cacheable_scene_prompt(prompt: str) -> bool:
    """Whether a produced prompt is a real answer worth keeping.

    Two conditions, and the second is the one that is easy to miss: the
    generated fallback satisfies the 360 contract by construction, so a
    validity check alone would freeze boilerplate in as the permanent answer
    and every later rebuild would replay it instead of retrying the model.
    """
    text = str(prompt or "")
    if SCENE_FALLBACK_FINGERPRINT in text:
        return False
    return _has_required_scene_environment_headings(text)


def scene_from_cache_payload(payload: str) -> NovelScene | None:
    """Rebuild a scene from a stored payload, or None if it is unusable.

    A stored row that no longer parses, or that carries a prompt the current
    contract rejects, is treated as a miss rather than trusted: a cache must
    never be able to publish something the live path would have rejected.
    """
    try:
        data = json.loads(payload)
    except (TypeError, ValueError):
        return None
    if not isinstance(data, dict):
        return None
    prompt = str(data.get("environment_prompt") or "")
    if not is_cacheable_scene_prompt(prompt):
        return None
    return NovelScene(
        name=str(data.get("name") or ""),
        aliases=list(data.get("aliases") or []),
        scene_type=str(data.get("scene_type") or ""),
        environment_prompt=prompt,
        description=str(data.get("description") or ""),
    )


async def enrich_scene_environments_batched(
    candidates: list[dict[str, Any]],
    *,
    synopsis: str = "",
    enrichment_agent: Any | None = None,
    on_scene: Optional[Any] = None,
    cache: Optional[SceneBuildCache] = None,
) -> list[NovelScene]:
    """Generate environment prompts for several scenes per request.

    The enrichment agent already returns a list, but was being asked for one
    scene at a time. A screenplay yields dozens of base scenes, and each call
    costs the same few seconds of round trip regardless of how many it carries.

    A batch that fails or comes back short falls through to per-scene calls for
    exactly the scenes it missed, so batching can only cost time, never scenes.

    With a ``cache``, scenes whose input already produced a real answer are
    served from it and never sent to the model.  That is what makes an
    interrupted build resumable: each scene is an independent call, and the ones
    that finished stay finished.
    """
    if not candidates:
        return []

    keys = {
        id(candidate): scene_enrichment_cache_key(candidate, synopsis)
        for candidate in candidates
    }
    hits: dict[int, NovelScene] = {}
    if cache is not None:
        stored = await cache.get(SCENE_ENRICHMENT_CACHE_TYPE, list(keys.values()))
        for candidate in candidates:
            payload = stored.get(keys[id(candidate)])
            scene = scene_from_cache_payload(payload) if payload else None
            if scene is not None:
                hits[id(candidate)] = scene

    pending = [candidate for candidate in candidates if id(candidate) not in hits]
    if hits and on_scene:
        # Reported before any model call, so a resumed build shows the work it
        # is skipping instead of appearing to stall at zero.
        for candidate in candidates:
            scene = hits.get(id(candidate))
            if scene is not None:
                on_scene(candidate, scene)

    agent = enrichment_agent or _create_scene_build_agent(
        SCENE_ENRICHMENT_SYSTEM_PROMPT,
        SceneEnrichmentList,
        "Scene Build Enricher",
    )
    synopsis_section = f"\n\n【故事梗概与人物设定】\n{synopsis}" if synopsis else ""

    def describe(candidate: dict[str, Any]) -> str:
        context = "\n".join(
            str(line) for line in (candidate.get("context_lines") or [])[:24]
        )
        interior = bool(candidate.get("interior", True))
        return (
            f"### 场景：{candidate['name']}\n"
            f"室内外：{'内' if interior else '外'}\n"
            f"出场人物：{', '.join(candidate.get('characters') or []) or '无'}\n"
            f"原文段落：\n{context}"
        )

    async def run_batch(batch: list[dict[str, Any]]) -> list[NovelScene]:
        prompt = (
            "请为下面每一个场景分别生成 environment_prompt，"
            "name 必须与给出的场景名完全一致，不要合并或遗漏：\n\n"
            + "\n\n".join(describe(candidate) for candidate in batch)
            + synopsis_section
        )
        produced: dict[str, NovelScene] = {}
        try:
            result = (await agent.run(prompt)).output
            by_name = {
                str(item.name or "").strip(): item for item in (result.scenes or [])
            }
            for candidate in batch:
                item = by_name.get(candidate["name"])
                if item is None:
                    continue
                scene_type = item.scene_type or candidate.get("scene_type") or (
                    "interior" if candidate.get("interior", True) else "exterior"
                )
                produced[candidate["name"]] = NovelScene(
                    name=candidate["name"],
                    aliases=_clean_aliases(
                        candidate["name"], candidate.get("aliases") or []
                    ),
                    scene_type=scene_type,
                    environment_prompt=_ensure_directional_environment_prompt(
                        prompt=item.environment_prompt,
                        scene_name=candidate["name"],
                        scene_type=scene_type,
                        time_of_day="",
                        context_lines=list(candidate.get("context_lines") or []),
                    ),
                    description=item.description,
                )
        except Exception as exc:  # noqa: BLE001 - falls back per scene below
            import logging

            logging.warning("批量场景描述生成失败，逐个重试: %s", exc)

        scenes: list[NovelScene] = []
        for candidate in batch:
            scene = produced.get(candidate["name"])
            if scene is None:
                scene = await enrich_scene_environment_from_context(
                    scene_name=candidate["name"],
                    aliases=candidate.get("aliases") or [],
                    scene_type=candidate.get("scene_type") or "",
                    time_of_day=candidate.get("time_of_day") or "",
                    interior=bool(candidate.get("interior", True)),
                    episodes=candidate.get("episodes") or [],
                    characters=candidate.get("characters") or [],
                    context_lines=candidate.get("context_lines") or [],
                    synopsis=synopsis,
                    enrichment_agent=agent,
                )
            if on_scene:
                on_scene(candidate, scene)
            scenes.append(scene)
        if cache is not None and scenes:
            # Written per batch, not once at the end: a build killed halfway
            # must keep everything it already paid for.  Only real answers are
            # stored — a generated fallback would otherwise become permanent.
            await cache.save(
                SCENE_ENRICHMENT_CACHE_TYPE,
                {
                    keys[id(candidate)]: scene_to_cache_payload(scene)
                    for candidate, scene in zip(batch, scenes)
                    if is_cacheable_scene_prompt(scene.environment_prompt)
                },
            )
        return scenes

    batches = [
        pending[start : start + _ENRICHMENT_BATCH_SIZE]
        for start in range(0, len(pending), _ENRICHMENT_BATCH_SIZE)
    ]
    results = await map_bounded(batches, run_batch, limit=default_llm_concurrency())
    fresh = {scene.name: scene for batch in results if batch for scene in batch}

    # Rebuilt in the caller's original order, so a resumed build publishes the
    # same catalogue in the same order as a fresh one.
    ordered: list[NovelScene] = []
    for candidate in candidates:
        scene = hits.get(id(candidate)) or fresh.get(candidate["name"])
        if scene is not None:
            ordered.append(scene)
    return ordered


_DEFAULT_ENRICH_SCENE_ENVIRONMENT_FROM_CONTEXT = enrich_scene_environment_from_context


def _scene_candidates_from_normalized_blocks(
    blocks: list[NormalizedSceneBlock],
) -> list[dict[str, Any]]:
    merged: dict[str, dict[str, Any]] = {}
    for block in blocks:
        scene_name = str(block.location or "").strip()
        if not scene_name:
            continue
        existing = merged.get(scene_name)
        episode = _episode_number_from_normalized_block(block)
        normalized_time = normalize_time_of_day(block.time_of_day)
        if not existing:
            merged[scene_name] = {
                "name": scene_name,
                "aliases": _clean_aliases(scene_name, block.aliases),
                "scene_type": block.scene_type or "interior",
                "time_of_day": normalized_time,
                "time_counts": {normalized_time: 1} if normalized_time else {},
                "interior": block.interior_exterior != "外",
                "episodes": [episode],
                "characters": list(dict.fromkeys(block.characters)),
                "context_lines": list(block.content_lines or block.evidence_lines),
            }
            continue
        if episode not in existing["episodes"]:
            existing["episodes"].append(episode)
        existing["episodes"] = sorted(existing["episodes"])
        existing["aliases"] = _clean_aliases(
            scene_name,
            list(existing["aliases"]) + list(block.aliases),
        )
        existing["characters"] = list(
            dict.fromkeys(list(existing["characters"]) + list(block.characters))
        )
        existing["context_lines"].extend(block.content_lines or block.evidence_lines)
        if normalized_time:
            existing["time_counts"][normalized_time] = (
                existing["time_counts"].get(
                    normalized_time,
                    0,
                )
                + 1
            )
        if not existing["time_of_day"] and normalized_time:
            existing["time_of_day"] = normalized_time
    return list(merged.values())


def _format_observed_times_note(time_counts: dict[str, int] | None) -> str:
    counts = {
        str(key or "").strip(): int(value or 0)
        for key, value in (time_counts or {}).items()
        if str(key or "").strip() and int(value or 0) > 0
    }
    if not counts:
        return ""
    parts = [f"{time}×{counts[time]}" for time in sorted(counts)]
    return "observed_times: " + " / ".join(parts)


def _append_scene_note(existing: str, note: str) -> str:
    existing = str(existing or "").strip()
    note = str(note or "").strip()
    if not note:
        return existing
    if not existing:
        return note
    if note in existing:
        return existing
    return f"{existing}\n{note}"


def _episode_number_from_normalized_block(block: NormalizedSceneBlock) -> int:
    try:
        episode = int(block.episode_number or 0)
    except (TypeError, ValueError):
        episode = 0
    if episode > 0:
        return episode

    raw_header = str(block.raw_header or "").strip()
    header_match = re.match(r"^\s*(?P<episode>\d+)\s*[-－—]", raw_header)
    if header_match:
        return int(header_match.group("episode"))
    return 1


async def extract_scenes_from_graph(
    dataset_name: str = "novel",
    project_name: str = "",
    project_dir: Optional[str] = None,
    state_dir: Optional[str] = None,
    on_progress: Optional[Any] = None,
    on_log: Optional[Any] = None,
) -> List[NovelScene]:
    """Discover reusable base scenes from Cognee graph context.

    Project-level scene discovery must mirror character/prop discovery. Script
    normalization belongs to per-episode drama planning, not this graph path.
    """
    with preserve_st_env():
        import cognee
        from cognee.api.v1.search import SearchType
        from cognee.infrastructure.llm.LLMGateway import LLMGateway

    def report(progress: float, task: str) -> None:
        if on_progress:
            on_progress(progress, task)

    def log(message: str) -> None:
        print(f"[extract_scenes] {message}")
        if on_log:
            on_log(message)

    report(0.1, "通过图谱检索场景信息...")
    context_text = ""
    try:
        results = await _run_graph_read(
            state_dir,
            lambda: cognee.search(
                query_text=(
                    "列出作品中反复出现或对剧情重要的稳定物理地点，包括地点别名、"
                    "空间环境、建筑结构和地点之间的关系；不要列人物、事件、情绪或抽象概念"
                ),
                query_type=SearchType.GRAPH_COMPLETION,
                datasets=[dataset_name],
                only_context=True,
                top_k=50,
            ),
        )
        if results:
            context_text = "\n".join(
                _stringify_search_fragment(
                    item.search_result if hasattr(item, "search_result") else item
                )
                for item in results
            )
            log(f"图谱场景上下文获取成功: {len(context_text)} 字符")
    except Exception as exc:
        import logging

        logging.warning("cognee 场景搜索失败: %s", exc)
        log(f"图谱场景搜索失败: {exc}")
        raise RuntimeError("Cognee 图谱场景搜索失败") from exc

    if not context_text.strip():
        log("⚠️ 图谱搜索无场景数据，请先完成知识图谱构建")
        return []

    report(0.3, "从图谱结构化提取基础场景...")
    system_prompt = """你是影视项目的全局场景资产分析师。
输入是知识图谱检索得到的上下文。请只提取可以跨镜头复用的稳定物理地点。

规则：
- name 必须是具体物理地点，例如“菩提寝房”“镇国公府前院”，不能是“家里”“现场”“回忆”等泛称。
- 合并同一地点的别名；不同时间、天气、损毁状态不要拆成新的基础场景。
- 排除人物、组织、事件、动作、情绪、章节标题和抽象概念。
- scene_type 只能是 interior、exterior、nature。
- evidence_lines 必须来自输入图谱上下文，不得编造。
- 图谱证据不足时宁缺毋滥，不要猜测地点。"""
    try:
        result = await LLMGateway.acreate_structured_output(
            context_text,
            system_prompt,
            GraphSceneCandidateList,
            **get_newapi_structured_output_litellm_kwargs(),
        )
    except Exception as exc:
        import logging

        logging.error("LLM 图谱场景提取失败: %s", exc)
        log(f"LLM 图谱场景提取失败: {exc}")
        raise RuntimeError("LLM 图谱场景提取失败") from exc

    candidates: list[GraphSceneCandidate] = []
    seen: set[str] = set()
    generic_names = {"场景", "地点", "室内", "外景", "内景", "现场", "家里", "回忆"}
    for candidate in result.scenes:
        name = str(candidate.name or "").strip()
        if not name or name in seen or name in generic_names:
            continue
        aliases = _clean_aliases(name, candidate.aliases)
        evidence_lines = [
            str(line or "").strip()
            for line in candidate.evidence_lines
            if str(line or "").strip() and str(line or "").strip() in context_text
        ]
        if not evidence_lines:
            location_tokens = [name, *aliases]
            evidence_lines = [
                line.strip()
                for line in context_text.splitlines()
                if line.strip()
                and any(token and token in line for token in location_tokens)
            ][:8]
        if not evidence_lines:
            log(f"  跳过缺少图谱证据的场景候选: {name}")
            continue
        candidate.aliases = aliases
        candidate.evidence_lines = evidence_lines
        seen.add(name)
        candidates.append(candidate)

    if not candidates:
        log("⚠️ 图谱上下文未提取到稳定物理场景")
        return []

    report(0.5, "生成场景环境描述...")
    enrichment_agent = _create_scene_build_agent(
        SCENE_ENRICHMENT_SYSTEM_PROMPT,
        SceneEnrichmentList,
        "Scene Build Enricher",
    )
    scenes: list[NovelScene] = []
    total = len(candidates)
    for index, candidate in enumerate(candidates, start=1):
        report(
            0.5 + 0.45 * ((index - 1) / max(total, 1)),
            f"生成场景描述 ({index}/{total}): {candidate.name}",
        )
        scene_type = str(candidate.scene_type or "interior").strip().lower()
        if scene_type not in {"interior", "exterior", "nature"}:
            scene_type = "interior"
        scene = await enrich_scene_environment_from_context(
            scene_name=candidate.name,
            aliases=candidate.aliases,
            scene_type=scene_type,
            interior=scene_type == "interior",
            context_lines=list(candidate.evidence_lines),
            enrichment_agent=enrichment_agent,
        )
        scene.notes = _append_scene_note(scene.notes, "由 Cognee 图谱提取的基础场景")
        scenes.append(scene)
        log(f"  ✓ {scene.name}")

    report(1.0, "完成")
    log(f"图谱场景提取完成: {len(scenes)} 个")
    return scenes


async def _normalized_scene_blocks_cached(
    novel_text: str, cache: Optional[SceneBuildCache]
) -> list[dict[str, Any]]:
    """Run the screenplay normalizer once per source text, then reuse it.

    The normalizer is a model call and its answer varies between runs. Left
    uncached it does not just cost its own few seconds again — it reshuffles the
    candidates, which changes every downstream cache key, so a rebuild would
    re-pay for every scene description too. Keyed on the source text, so an
    unchanged script always yields the same candidates.
    """
    key = hashlib.sha256(
        json.dumps(
            {"v": SCENE_BLOCKS_CACHE_VERSION, "source": novel_text},
            ensure_ascii=False,
            sort_keys=True,
        ).encode("utf-8")
    ).hexdigest()

    if cache is not None:
        stored = (await cache.get(SCENE_BLOCKS_CACHE_TYPE, [key])).get(key)
        if stored:
            try:
                restored = json.loads(stored)
            except (TypeError, ValueError):
                restored = None
            if isinstance(restored, list) and restored:
                return restored

    blocks = await normalize_screenplay_scenes(novel_text)
    candidates = _scene_candidates_from_normalized_blocks(blocks)
    if cache is not None and candidates:
        await cache.save(
            SCENE_BLOCKS_CACHE_TYPE,
            {key: json.dumps(candidates, ensure_ascii=False)},
        )
    return candidates


def strip_scene_heading_suffix(name: str) -> str:
    """Drop the heading markers the parser left on a location name.

    "郑玉琴办公室内" is the same room as "郑玉琴办公室": the 内 is the heading's
    interior marker, which the parser also returns as its own field. Removing it
    is the whole of what a per-block model call used to buy here.

    The rules already exist — ``clean_scene_name_and_time`` handles the attached,
    separated and spaced forms and refuses to strip when the result would not be
    a name any more — so this only discards the time it also returns.
    """
    cleaned, _time_of_day = clean_scene_name_and_time(str(name or "").strip(), "")
    return cleaned or str(name or "").strip()


def _candidate_from_parsed_block(candidate: Any) -> dict[str, Any]:
    """Turn one parser-located block into a candidate, without a model call.

    A standard scene heading already states the location, the time and whether
    it is interior — the parser reads all three. Asking a model to restate them
    was one round trip per block, run one at a time, and on a feature-length
    screenplay the single largest cost in the whole build. Measured against the
    model path on a real 33k-char script it produces the same catalogue: 25
    scenes either way, 24 of them identical, and the one difference is which
    spelling of a merged pair wins.

    Deciding that two spellings are one room is the part worth a model, and
    ``adjudicate_scenes`` already does it downstream — with every candidate in
    view at once and occurrence counts to choose the canonical spelling, which
    a per-block call looking at one heading in isolation cannot have.
    """
    name = strip_scene_heading_suffix(candidate.name)
    normalized_time = normalize_time_of_day(candidate.time_of_day)
    return {
        "name": name,
        "aliases": _clean_aliases(name, [candidate.name]),
        "scene_type": "interior" if candidate.interior else "exterior",
        "time_of_day": normalized_time,
        "time_counts": {normalized_time: 1} if normalized_time else {},
        "interior": candidate.interior,
        "episodes": list(candidate.episodes),
        "characters": list(candidate.characters),
        "context_lines": list(candidate.context_lines),
    }


def _scene_recall_is_covered(
    normalized: list[dict[str, Any]], parsed: list[Any]
) -> tuple[bool, str]:
    """Whether the normalizer accounted for every location the parser found.

    The old test compared distinct-location *counts* and rejected the result
    whenever the normalizer returned fewer. But folding two spellings of one
    room into a single scene is the normalizer working correctly, and it always
    lowers the count — so a correct merge was punished as lost recall, and the
    whole result was thrown away for a per-block model loop that cost minutes.

    What actually matters is that nothing was dropped: every location the parser
    located must still be reachable, as a name, an alias, or the same name with
    its heading markers stripped.

    The test stays strict — an attached "内" is genuinely ambiguous ("商务车内"
    is a place, "郑玉琴办公室内" is a marker) so a merge across one is not
    recognised here and does send the build down the fallback. That is now
    affordable: the fallback is deterministic and costs no model call, and
    adjudication performs the same merge downstream with occurrence counts to
    decide it on.
    """
    known: set[str] = set()
    for candidate in normalized:
        for value in [candidate.get("name"), *(candidate.get("aliases") or [])]:
            text = str(value or "").strip()
            if text:
                known.add(text)
                known.add(strip_scene_heading_suffix(text))

    missing = [
        candidate.name
        for candidate in parsed
        if candidate.name not in known
        and strip_scene_heading_suffix(candidate.name) not in known
    ]
    if missing:
        return False, f"AI normalizer 漏掉了 {len(missing)} 个地点: {missing[:5]}"
    return True, ""


async def extract_scenes_from_script(
    novel_text: str,
    on_progress: Optional[Any] = None,
    on_log: Optional[Any] = None,
    cache: Optional[SceneBuildCache] = None,
) -> List[NovelScene]:
    """从格式化剧本提取场景（AI normalizer first + parser fallback + LLM enrichment）。

    流程：
    1. 程序 parser 高召回定位场景块，作为 AI normalizer 的召回 sanity check
    2. 优先使用 AI normalizer 输出的 NormalizedSceneBlock
    3. AI 抛错、返回空或基础场景数少于 parser 结果时，回退到 parser + LLM 规范化
    4. LLM 逐场景生成 environment_prompt
    """
    from .script_parser import parse_scenes, extract_synopsis

    def report(progress: float, task: str):
        if on_progress:
            on_progress(progress, task)

    def log(message: str):
        print(f"[extract_scenes] {message}")

    synopsis = extract_synopsis(novel_text)
    if synopsis:
        log(f"提取梗概+人物设定: {len(synopsis)} 字符")

    legacy_candidates = parse_scenes(novel_text)
    log(
        "程序召回 sanity check 得到 "
        f"{len(legacy_candidates)} 个场景块: {[c.name for c in legacy_candidates]}"
    )

    normalized_scene_candidates: list[dict[str, Any]] = []
    fallback_reason = ""

    report(0.1, "AI 规范化剧本场景块...")
    try:
        normalized_scene_candidates = await _normalized_scene_blocks_cached(
            novel_text, cache
        )
        covered, gap = _scene_recall_is_covered(
            normalized_scene_candidates, legacy_candidates
        )
        if not covered:
            fallback_reason = gap
            normalized_scene_candidates = []
        if normalized_scene_candidates:
            log(
                "AI 规范化得到 "
                f"{len(normalized_scene_candidates)} 个基础场景: "
                f"{[c['name'] for c in normalized_scene_candidates]}"
            )
        elif not fallback_reason:
            fallback_reason = "AI normalizer 返回空"
    except Exception as e:
        import logging

        logging.error(f"AI 场景规范化失败: {e}")
        fallback_reason = f"AI normalizer 失败 ({e})"

    if not normalized_scene_candidates:
        if fallback_reason:
            log(f"⚠️ {fallback_reason}，回退到程序定位 + 本地规范化")

        report(0.15, "定位剧本场景块...")
        candidates = legacy_candidates
        log(f"程序定位得到 {len(candidates)} 个场景块: {[c.name for c in candidates]}")

        if not candidates:
            log("⚠️ 未从剧本中解析出任何场景")
            return []

        # Deterministic, and no model call: a standard heading already states
        # everything a candidate needs, and the name cleanup a model used to do
        # here is a suffix strip. What is left — deciding that two spellings are
        # one room — belongs to adjudication, which sees all of them at once.
        normalized_candidates = [
            _candidate_from_parsed_block(candidate) for candidate in candidates
        ]

        merged_candidates: dict[str, dict[str, Any]] = {}
        for cand in normalized_candidates:
            scene_name = (cand["name"] or "").strip()
            if not scene_name:
                continue
            existing = merged_candidates.get(scene_name)
            if not existing:
                merged_candidates[scene_name] = {
                    "name": scene_name,
                    "aliases": list(dict.fromkeys(cand["aliases"])),
                    "scene_type": cand["scene_type"],
                    "time_of_day": cand["time_of_day"],
                    "time_counts": dict(cand.get("time_counts") or {}),
                    "interior": cand["interior"],
                    "episodes": list(cand["episodes"]),
                    "characters": list(dict.fromkeys(cand["characters"])),
                    "context_lines": list(cand["context_lines"]),
                }
                continue
            existing["aliases"] = list(
                dict.fromkeys(existing["aliases"] + cand["aliases"])
            )
            existing["episodes"] = sorted(set(existing["episodes"] + cand["episodes"]))
            existing["characters"] = list(
                dict.fromkeys(existing["characters"] + cand["characters"])
            )
            existing["context_lines"].extend(cand["context_lines"])
            for time_key, count in (cand.get("time_counts") or {}).items():
                time_key = str(time_key or "").strip()
                if not time_key:
                    continue
                existing["time_counts"][time_key] = existing["time_counts"].get(
                    time_key,
                    0,
                ) + int(count or 0)
            if not existing["time_of_day"] and cand["time_of_day"]:
                existing["time_of_day"] = cand["time_of_day"]

        normalized_scene_candidates = list(merged_candidates.values())
        log(
            "规范化后得到 "
            f"{len(normalized_scene_candidates)} 个基础场景: "
            f"{[c['name'] for c in normalized_scene_candidates]}"
        )

    # Step 3: LLM 逐场景生成 environment_prompt
    report(0.5, "LLM 生成场景环境描述...")
    scenes: List[NovelScene] = []
    total = len(normalized_scene_candidates)
    if not normalized_scene_candidates:
        log("⚠️ 场景规范化后为空")
        return []

    enrichment_agent = None
    if (
        enrich_scene_environment_from_context
        is _DEFAULT_ENRICH_SCENE_ENVIRONMENT_FROM_CONTEXT
    ):
        enrichment_agent = _create_scene_build_agent(
            SCENE_ENRICHMENT_SYSTEM_PROMPT,
            SceneEnrichmentList,
            "Scene Build Enricher",
        )

    # Each candidate's enrichment is an independent round trip. A feature-length
    # screenplay carries well over a hundred scenes, so running them one at a
    # time makes the build minutes of pure latency.
    completed = 0

    def note_progress(cand: dict, scene) -> None:
        nonlocal completed
        scene.time_of_day = ""
        scene.notes = _append_scene_note(
            scene.notes,
            _format_observed_times_note(cand.get("time_counts")),
        )
        completed += 1
        report(
            0.5 + 0.4 * (completed / max(total, 1)),
            f"生成场景描述 ({completed}/{total}): {cand['name']}",
        )
        log(f"  ✓ {cand['name']}: environment_prompt={len(scene.environment_prompt)}字")

    scenes.extend(
        await enrich_scene_environments_batched(
            normalized_scene_candidates,
            synopsis=synopsis,
            enrichment_agent=enrichment_agent,
            cache=cache,
            on_scene=note_progress,
        )
    )

    log(f"场景提取完成: {len(scenes)} 个")
    report(1.0, "完成")
    return scenes


# ============================================================
# 道具提取 Pipeline
# ============================================================


class PropEnrichment(BaseModel):
    """LLM 补充的道具信息。"""

    name: str = Field(..., description="道具主名称")
    aliases: List[str] = Field(
        default_factory=list, description="原文中真实出现过的别名/简称/自然称呼"
    )
    prop_type: str = Field(
        default="object", description="weapon/accessory/artifact/document/furniture"
    )
    visual_prompt: str = Field(
        default="",
        description="道具固有外观视觉描述（材质、工艺、尺寸、色泽、纹饰，80-120字，不含人物和临时状态变化）",
    )
    owner: str = Field(default="", description="所属角色名")


class PropEnrichmentList(BaseModel):
    """道具补充信息列表。"""

    props: List[PropEnrichment]


async def extract_props_from_graph(
    dataset_name: str = "novel",
    project_name: str = "",
    project_dir: Optional[str] = None,
    state_dir: Optional[str] = None,
    novel_text: Optional[str] = None,
    on_progress: Optional[Any] = None,
    on_log: Optional[Any] = None,
) -> List[NovelProp]:
    """从 cognee 图谱中提取道具。

    只提取有情节意义的道具（推动剧情的信物、武器等），不提取普通物件。
    """
    with preserve_st_env():
        import cognee
        from cognee.api.v1.search import SearchType
        from cognee.infrastructure.llm.LLMGateway import LLMGateway

    def report(progress: float, task: str):
        if on_progress:
            on_progress(progress, task)

    def log(message: str):
        print(f"[extract_props] {message}")

    report(0.1, "通过图谱检索道具信息...")

    context_text = ""
    try:
        results = await _run_graph_read(
            state_dir,
            lambda: cognee.search(
                query_text="列出小说中所有重要道具物件，包括武器、信物、文书、法宝等有情节意义的物品",
                query_type=SearchType.GRAPH_COMPLETION,
                datasets=[dataset_name],
                only_context=True,
                top_k=30,
            ),
        )
        if results:
            parts = []
            for item in results:
                if hasattr(item, "search_result"):
                    parts.append(_stringify_search_fragment(item.search_result))
                elif isinstance(item, dict):
                    parts.append(_stringify_search_fragment(item))
                else:
                    parts.append(_stringify_search_fragment(item))
            context_text = "\n".join(parts)
            log(f"图谱上下文获取成功: {len(context_text)} 字符")
    except Exception as e:
        import logging

        logging.warning(f"cognee.search 失败: {e}")
        raise RuntimeError("Cognee 图谱道具搜索失败") from e

    if not context_text.strip():
        log("⚠️ 图谱搜索无数据，请先构建图谱")
        return []

    if novel_text:
        context_text += f"\n\n【剧本原文全文】\n{novel_text}"
        log(f"已注入原文全文辅助上下文: {len(novel_text)} 字符")

    report(0.3, "LLM 结构化提取道具...")

    system_prompt = """你是小说道具分析专家。以下是从知识图谱中提取的物品信息。
请基于图谱上下文提取所有有情节意义的道具/物件；若提供了原文全文，可用来补充自然称呼和简称，但不要凭空添加图谱与原文都未提及的细节。

⚠️ 只提取推动剧情的重要物品（信物、武器、法宝、文书等），不提取普通日用品。

对于每个道具，生成：
1. name: 道具主名称（如 '七星剑'、'传国玉玺'）
2. aliases: 原文中真实出现过的其他称呼、简称或自然称呼
3. prop_type: weapon/accessory/artifact/document/furniture
4. visual_prompt: 道具固有外观视觉描述，80-120字，要求：
   - 包含**材质、工艺、尺寸、色泽、纹饰**等细节
   - 描述**固有外观**（断刀就是断的，锈剑就是锈的）
   - **不含**人物、使用场景、临时状态变化（如沾血、着火）
   - 基于图谱描述组织，不凭空创造细节
   示例："三尺青锋长剑，剑身寒铁锻造泛冷蓝光泽，剑脊镌刻七颗星辰纹饰。剑柄缠深棕色鲨鱼皮，末端嵌圆形白玉剑首。配紫檀木鞘，鞘身浮雕云纹，鞘口鎏金"
5. owner: 所属角色名（如有）

规则：
- 只提取有明确情节作用的道具
- visual_prompt 基于图谱描述组织，不凭空创造细节
- 同一物品的不同叫法合并（别名）
- 图谱是主依据，原文全文只作为补充证据，主要用于补全 aliases 和确认道具是否确实在原文中反复出现
- aliases 优先收录原文里真实出现过的自然称呼或简称，例如正式名较长时，可补充正文里反复出现的短称
- aliases 不要发散编造；不要加入过于泛化、容易误匹配其他物件的词
- 不要把过短、过泛、或高碰撞的类别词放进 aliases，例如“箱子 / 盒子 / 剑 / 刀 / 文件 / 车”这类默认不要收，除非图谱上下文明确表明原文就是把该具名道具稳定地这样称呼
- 如果某个别名只是主名称的重复写法，则不要重复输出"""

    try:
        result = await LLMGateway.acreate_structured_output(
            context_text,
            system_prompt,
            PropEnrichmentList,
            **get_newapi_structured_output_litellm_kwargs(),
        )
        props = [
            NovelProp(
                name=p.name,
                aliases=_clean_aliases(p.name, p.aliases or []),
                prop_type=p.prop_type,
                visual_prompt=p.visual_prompt,
                owner=p.owner,
            )
            for p in result.props
        ]
        log(f"LLM 结构化提取完成: {len(props)} 个道具")
    except Exception as e:
        import logging

        logging.error(f"LLM 道具提取失败: {e}")
        raise RuntimeError("LLM 图谱道具提取失败") from e

    report(1.0, "完成")
    return props
