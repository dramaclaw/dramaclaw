"""NovelVideo 自定义 Cognee Pipeline。

实现小说知识图谱的检索与结构化提取：
- 原始小说由 Cognee 构建知识图谱
- 角色、剧集、场景和道具等产品数据由 SQLite 持久化
- 规划和提取流程只读取 Cognee，不把派生产品数据回写图谱
"""

from __future__ import annotations

import json
import re
from typing import Any, Dict, List, Literal, Optional
from pydantic import BaseModel, Field, field_validator, model_validator

from novelvideo.shared.env_guard import preserve_st_env
from novelvideo.models import (
    CharacterIdentity,
    NovelCharacter,
    NovelEpisode,
    NovelEvent,
    NovelVisualBeat,
)
from novelvideo.config import ensure_project_dirs, get_newapi_reasoning_kwargs
from novelvideo.cognee.screenplay_normalizer import (
    NormalizedSceneBlock,
    clean_scene_name_and_time,
    normalize_time_of_day,
    normalize_screenplay_scenes,
)
from novelvideo.time_of_day import LlmTimeOfDay

# 重要：必须先导入 config，在 cognee 被导入之前设置环境变量
from . import config as _cognee_config  # noqa: F401
from .config import apply_cognee_project_storage_context

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


def _set_cognee_project_context(
    project_name: str = "",
    project_dir: Optional[str] = None,
    verbose: bool = False,
) -> None:
    """Point Cognee search at the current project's isolated graph/vector store."""
    if not project_dir and project_name:
        project_dir = ensure_project_dirs(project_name)["base"]
    if not project_dir:
        return

    state_dir = project_dir
    parts = project_name.split("/", 1)
    if len(parts) == 2:
        from novelvideo.utils.project_paths import ProjectPaths

        paths = ProjectPaths(parts[0], parts[1])
        paths.bootstrap_from_legacy_output()
        state_dir = str(paths.state_dir)

    with preserve_st_env():
        import cognee

    cognee_system_dir, cognee_data_dir = apply_cognee_project_storage_context(state_dir, cognee)
    if verbose:
        print(
            f"[cognee_context] project={project_name} "
            f"project_dir={project_dir} "
            f"system_root_directory={cognee_system_dir} "
            f"data_root_directory={cognee_data_dir}",
            flush=True,
        )


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


def _strip_scene_name_wrapper(text: str) -> str:
    value = (text or "").strip()
    if not value:
        return ""
    value = re.sub(r"^场次[（(]?\d+[）)]?\s*", "", value)
    value = re.sub(r"^(地点|场景)\s*[:：]\s*", "", value)
    return value.strip(" ，,。；;：:")


def _remove_minor_scene_fillers(text: str) -> str:
    value = _strip_scene_name_wrapper(text)
    return re.sub(r"[的里内外中旁前后侧处]\s*", "", value)


def _select_scene_primary_name(original_name: str, normalized_name: str) -> str:
    """Prefer the original scene name unless the LLM version is only a light cleanup.

    This blocks over-generalization such as:
    - 兰州拉面馆 -> 面馆
    - 春熙路的3D大屏下 -> 春熙路
    """
    original = _strip_scene_name_wrapper(original_name)
    normalized = _strip_scene_name_wrapper(normalized_name)
    cleaned_original, _time_of_day = clean_scene_name_and_time(original, "")

    if not original:
        return normalized
    if not normalized or normalized == original:
        return cleaned_original or original

    if cleaned_original and normalized == cleaned_original:
        return cleaned_original

    # Only trust the normalized form when it preserves the same concrete anchor
    # and merely removes light filler words like “的/里/内/外/中”.
    if _remove_minor_scene_fillers(normalized) == _remove_minor_scene_fillers(original):
        return normalized

    return original


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
        **get_newapi_reasoning_kwargs(
            thinking_env="COGNEE_LLM_THINKING_LEVEL",
            default_thinking_level="high",
        ),
    )
    return result.episodes


async def generate_visual_prompts(characters: List[NovelCharacter]) -> List[NovelCharacter]:
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

    _set_cognee_project_context(project_name=project_name, project_dir=project_dir, verbose=True)

    # Step 1: 通过 cognee.search 获取图谱上下文
    report(0.1, "通过图谱检索人物信息...")
    log("使用 cognee.search(only_context=True) 获取图谱上下文...")

    context_text = ""
    try:
        results = await cognee.search(
            query_text="列出小说中所有人物角色，包括他们的关系、别名、身份特征和外貌描述",
            query_type=SearchType.GRAPH_COMPLETION,
            datasets=[dataset_name],
            only_context=True,
            top_k=30,
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
            **get_newapi_reasoning_kwargs(
                thinking_env="COGNEE_LLM_THINKING_LEVEL",
                default_thinking_level="high",
            ),
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
        **get_newapi_reasoning_kwargs(
            thinking_env="COGNEE_LLM_THINKING_LEVEL",
            default_thinking_level="high",
        ),
    )
    log(f"LLM 返回 {len(result.episodes)} 集")

    # 验证剧集编号
    episode_numbers = [ep.number for ep in result.episodes]
    log(f"剧集编号: {episode_numbers}")

    if len(result.episodes) < target_episodes:
        log(f"⚠️ 警告：LLM 返回的集数 ({len(result.episodes)}) 少于目标 ({target_episodes})")

    # 检查是否从 1 开始，如果不是则自动修正
    if episode_numbers and min(episode_numbers) != 1:
        log(f"⚠️ 警告：剧集编号不是从 1 开始，最小编号: {min(episode_numbers)}，正在自动修正...")
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

    log(f"剧集规划完成: {len(result.episodes)} 集，编号: {[ep.number for ep in result.episodes]}")

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

    name: str = Field(..., description="稳定物理地点名称，不包含时间、人物、事件或镜头词")
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


def _has_required_scene_environment_headings(prompt: str) -> bool:
    text = str(prompt or "").strip()
    if not text:
        return False
    return all(
        re.search(rf"(^|\n)\s*{re.escape(label)}\s*[:：]", text)
        for label in SCENE_ENVIRONMENT_REQUIRED_HEADINGS
    )


def _compact_scene_context(lines: list[str] | tuple[str, ...] | str, *, limit: int = 180) -> str:
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
        return text

    evidence = _compact_scene_context(text or context_lines)
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


class SceneNormalization(BaseModel):
    """LLM 规范化后的场景块。"""

    name: str = Field(..., description="规范化后的基础场景名")
    aliases: List[str] = Field(default_factory=list, description="同义别名")
    scene_type: str = Field(default="interior", description="interior/exterior/nature")
    time_of_day: LlmTimeOfDay = Field(
        default="无",
        description="只能输出：无/清晨/上午/正午/午后/白天/黄昏/夜晚",
    )
    interior: bool = Field(default=True, description="是否室内")
    characters: List[str] = Field(default_factory=list, description="该场景块明确出场的人物")

    @field_validator("time_of_day", mode="before")
    @classmethod
    def normalize_time_of_day_value(cls, value: str) -> str:
        return normalize_time_of_day(value) or "无"

    @model_validator(mode="after")
    def normalize_empty_time_of_day(self) -> "SceneNormalization":
        if self.time_of_day == "无":
            self.time_of_day = ""
        return self


class SceneNormalizationList(BaseModel):
    """场景规范化输出列表。"""

    scenes: List[SceneNormalization]


def _create_scene_build_agent(system_prompt: str, output_type: Any, name: str):
    """Create the scene-build business LLM agent.

    This intentionally does not use Cognee's LLMGateway: scene construction uses
    Cognee project context, but its two structured LLM calls are business logic,
    not Cognee graph ingest/cognify/memify work.
    """
    from pydantic_ai import Agent
    from novelvideo.config import (
        get_newapi_text_pydantic_model,
        get_newapi_text_pydantic_model_settings,
    )

    return Agent(
        get_newapi_text_pydantic_model("SCENE_BUILD_MODEL", "gemini-3-flash-preview"),
        system_prompt=system_prompt,
        model_settings=get_newapi_text_pydantic_model_settings(
            "SCENE_BUILD_THINKING_LEVEL",
            "high",
        ),
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
    context_lines = [str(line) for line in (context_lines or []) if str(line or "").strip()]
    aliases = list(aliases or [])
    characters = list(characters or [])
    episodes = list(episodes or [])
    scene_type = str(scene_type or ("interior" if interior else "exterior") or "interior")

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

    _set_cognee_project_context(
        project_name=project_name,
        project_dir=project_dir,
        verbose=True,
    )

    report(0.1, "通过图谱检索场景信息...")
    context_text = ""
    try:
        results = await cognee.search(
            query_text=(
                "列出作品中反复出现或对剧情重要的稳定物理地点，包括地点别名、"
                "空间环境、建筑结构和地点之间的关系；不要列人物、事件、情绪或抽象概念"
            ),
            query_type=SearchType.GRAPH_COMPLETION,
            datasets=[dataset_name],
            only_context=True,
            top_k=50,
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
            **get_newapi_reasoning_kwargs(
                thinking_env="COGNEE_LLM_THINKING_LEVEL",
                default_thinking_level="high",
            ),
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


async def extract_scenes_from_script(
    novel_text: str,
    on_progress: Optional[Any] = None,
    on_log: Optional[Any] = None,
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
        normalized_blocks = await normalize_screenplay_scenes(novel_text)
        normalized_scene_candidates = _scene_candidates_from_normalized_blocks(normalized_blocks)
        if len(normalized_scene_candidates) < len(legacy_candidates):
            fallback_reason = (
                "AI normalizer 基础场景不足 "
                f"(ai={len(normalized_scene_candidates)}, parser={len(legacy_candidates)})"
            )
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
            log(f"⚠️ {fallback_reason}，回退到程序粗定位 + LLM 规范化")

        # Step 1: 程序粗定位
        report(0.1, "定位剧本场景块...")
        candidates = legacy_candidates
        log(f"程序定位得到 {len(candidates)} 个场景块: {[c.name for c in candidates]}")

        if not candidates:
            log("⚠️ 未从剧本中解析出任何场景")
            return []

        # Step 2: LLM 规范化场景块
        report(0.2, "LLM 规范化场景块...")
        normalized_candidates = []
        total = len(candidates)
        normalization_system_prompt = """你是剧本场景规范化器。程序已经定位到一个“疑似场景块”，你的任务是把它归一成基础场景信息。

输出：
1. name: 基础场景名，尽量保留原文里的具体地点全称；只移除明显脏词、场次包裹词、镜头修辞，不要把具体地点泛化成上位类词
2. aliases: 该场景在原文中真实出现过的常见简称/自然称呼，可为空
3. scene_type: interior / exterior / nature
4. time_of_day: 只能输出 无 / 清晨 / 上午 / 正午 / 午后 / 白天 / 黄昏 / 夜晚；无明确时间时输出“无”；日/昼归为白天，夜/深夜/三更/亥时归为夜晚
5. interior: true/false
6. characters: 该场景块明确出场的人物名列表

规则：
- 优先参考原文，其次参考程序猜测
- 如果程序定位大致正确但名称过脏，请清洗后返回规范场景名
- 同一物理地点的不同重复场景，应归一成同一个基础场景名
- 保留原文中的具体锚点：品牌、地名、建筑名、功能区、装置名，不要擅自删掉
- 错误示例：兰州拉面馆 -> 面馆；春熙路的3D大屏下 -> 春熙路
- aliases 优先保留原文里真实出现过的简称或自然叫法，例如“公寓电梯间”可补“电梯间”
- aliases 只允许来自该场景块原文中的真实叫法；不要把“程序猜测”里的候选词、梗概里的概括词、或你自己归纳出来的地点词写进 aliases
- 不要发明原文里没有的新地点
- 不要发明原文里没有的新地点"""
        normalization_agent = _create_scene_build_agent(
            normalization_system_prompt,
            SceneNormalizationList,
            "Scene Build Normalizer",
        )

        for idx, cand in enumerate(candidates):
            progress = 0.2 + 0.25 * (idx / total)
            report(progress, f"规范化场景 ({idx+1}/{total}): {cand.name}")

            context = "\n".join(cand.context_lines[:30])
            synopsis_section = f"\n\n【故事梗概与人物设定】\n{synopsis}" if synopsis else ""
            user_text = f"""程序定位到一个场景块，请你将它规范化。

【程序猜测】
- 场景名候选：{cand.name}
- 时间：{cand.time_of_day}
- 室内外：{"内" if cand.interior else "外"}
- 出场人物：{", ".join(cand.characters) if cand.characters else "无"}
- 出现集数：{cand.episodes}

【该场景块原文】
{context}{synopsis_section}"""
            try:
                result = (await normalization_agent.run(user_text)).output
                if result.scenes:
                    normalized = result.scenes[0]
                    primary_name = _select_scene_primary_name(cand.name, normalized.name.strip())
                    normalized_time = normalize_time_of_day(
                        normalized.time_of_day.strip() or cand.time_of_day
                    )
                    normalized_candidates.append(
                        {
                            "name": primary_name,
                            "aliases": _clean_aliases(
                                primary_name,
                                [cand.name, normalized.name.strip()] + (normalized.aliases or []),
                            ),
                            "scene_type": normalized.scene_type
                            or ("interior" if cand.interior else "exterior"),
                            "time_of_day": normalized_time,
                            "time_counts": {normalized_time: 1} if normalized_time else {},
                            "interior": normalized.interior if primary_name else cand.interior,
                            "episodes": cand.episodes,
                            "characters": normalized.characters or cand.characters,
                            "context_lines": cand.context_lines,
                        }
                    )
                    log(f"  ✓ 规范化: {cand.name} -> {primary_name}")
                else:
                    normalized_time = normalize_time_of_day(cand.time_of_day)
                    normalized_candidates.append(
                        {
                            "name": cand.name,
                            "aliases": [],
                            "scene_type": "interior" if cand.interior else "exterior",
                            "time_of_day": normalized_time,
                            "time_counts": {normalized_time: 1} if normalized_time else {},
                            "interior": cand.interior,
                            "episodes": cand.episodes,
                            "characters": cand.characters,
                            "context_lines": cand.context_lines,
                        }
                    )
                    log(f"  ⚠ {cand.name}: 规范化返回空，使用程序候选")
            except Exception as e:
                import logging

                logging.error(f"LLM 场景规范化失败 ({cand.name}): {e}")
                normalized_time = normalize_time_of_day(cand.time_of_day)
                normalized_candidates.append(
                    {
                        "name": cand.name,
                        "aliases": [],
                        "scene_type": "interior" if cand.interior else "exterior",
                        "time_of_day": normalized_time,
                        "time_counts": {normalized_time: 1} if normalized_time else {},
                        "interior": cand.interior,
                        "episodes": cand.episodes,
                        "characters": cand.characters,
                        "context_lines": cand.context_lines,
                    }
                )
                log(f"  ⚠ {cand.name}: 规范化失败 ({e})，使用程序候选")

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
            existing["aliases"] = list(dict.fromkeys(existing["aliases"] + cand["aliases"]))
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
    if enrich_scene_environment_from_context is _DEFAULT_ENRICH_SCENE_ENVIRONMENT_FROM_CONTEXT:
        enrichment_agent = _create_scene_build_agent(
            SCENE_ENRICHMENT_SYSTEM_PROMPT,
            SceneEnrichmentList,
            "Scene Build Enricher",
        )

    for idx, cand in enumerate(normalized_scene_candidates):
        progress = 0.5 + 0.4 * (idx / max(total, 1))
        report(progress, f"生成场景描述 ({idx+1}/{total}): {cand['name']}")

        scene_type = cand["scene_type"] or ("interior" if cand["interior"] else "exterior")
        scene = await enrich_scene_environment_from_context(
            scene_name=cand["name"],
            aliases=cand["aliases"],
            scene_type=scene_type,
            time_of_day=cand["time_of_day"],
            interior=cand["interior"],
            episodes=cand["episodes"],
            characters=cand["characters"],
            context_lines=cand["context_lines"],
            synopsis=synopsis,
            enrichment_agent=enrichment_agent,
        )
        scene.time_of_day = ""
        scene.notes = _append_scene_note(
            scene.notes,
            _format_observed_times_note(cand.get("time_counts")),
        )
        scenes.append(scene)
        log(f"  ✓ {cand['name']}: environment_prompt={len(scene.environment_prompt)}字")

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

    _set_cognee_project_context(project_name=project_name, project_dir=project_dir, verbose=True)

    report(0.1, "通过图谱检索道具信息...")

    context_text = ""
    try:
        results = await cognee.search(
            query_text="列出小说中所有重要道具物件，包括武器、信物、文书、法宝等有情节意义的物品",
            query_type=SearchType.GRAPH_COMPLETION,
            datasets=[dataset_name],
            only_context=True,
            top_k=30,
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
            **get_newapi_reasoning_kwargs(
                thinking_env="COGNEE_LLM_THINKING_LEVEL",
                default_thinking_level="high",
            ),
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
