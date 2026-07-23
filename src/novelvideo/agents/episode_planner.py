"""剧集规划 Agent。

使用 PydanticAI Agent 框架 + Cognee 图谱搜索能力进行多轮迭代式剧集规划。
替代原来 pipeline.py 中的单次 LLM 调用，实现更智能的剧集划分。

架构：
    EpisodePlannerAgent
    ├── 工具集 (create_episode_planner_tools)
    │   ├── tool_search_plot_points()       # 搜索情节转折点
    │   ├── tool_search_character_arcs()    # 搜索角色弧线
    │   ├── tool_search_relationship_changes()  # 搜索关系变化
    │   ├── tool_search_timeline_events()   # 按时间搜索事件
    │   ├── tool_get_story_structure()      # 获取故事结构
    │   └── tool_get_all_characters_for_planning()  # 获取角色列表
    │
    └── 多轮迭代
        ├── 第1轮: 搜索全书高潮点/转折点
        ├── 第2轮: 识别角色关系变化节点
        ├── 第3轮: 规划剧集边界
        └── 第4轮: 生成剧集大纲
"""

from typing import Optional, List, Any, Callable, TYPE_CHECKING

from pydantic_ai import Agent
from pydantic import BaseModel, Field

from novelvideo.config import get_pydantic_model
from novelvideo.cognee.tools import create_episode_planner_tools
from novelvideo.shared.env_guard import preserve_st_env
from novelvideo.utils.logging import log_agent_start, log_agent_end

if TYPE_CHECKING:
    from novelvideo.cognee import CogneeStore
    from novelvideo.models import NovelEpisode


# =============================================================================
# Output Schema
# =============================================================================


class EpisodePlan(BaseModel):
    """单集规划输出。"""

    number: int = Field(description="集数（从1开始）")
    title: str = Field(description="集标题（吸引人、有悬念）", min_length=2)
    chapter_start: int = Field(default=0, description="对应的起始章节（估计值）")
    chapter_end: int = Field(default=0, description="对应的结束章节（估计值）")
    content_summary: str = Field(
        description="内容摘要（50字以内，概括本集主要情节）",
        min_length=10,
        max_length=100,
    )
    main_conflict: str = Field(
        description="主要冲突（本集核心矛盾点）",
    )
    cliffhanger: str = Field(
        description="结尾悬念（让观众想看下一集的钩子）",
        min_length=5,
    )
    key_events: List[str] = Field(
        description="关键事件列表（3-5个）",
        min_length=1,
    )
    character_names: List[str] = Field(
        description="本集出场角色（从已知角色列表中选择）",
        min_length=1,
    )


class EpisodePlannerOutput(BaseModel):
    """剧集规划输出。"""

    episodes: List[EpisodePlan] = Field(description="剧集列表")


# =============================================================================
# Agent Prompt
# =============================================================================


EPISODE_PLANNER_PROMPT = """# 你是专业的剧集规划师

## 任务
将小说内容规划为指定数量的剧集。每集要有独立的冲突和悬念，同时保持整体叙事连贯。

## 工具使用策略（重要）

你有多种图谱搜索工具，请按以下顺序充分使用：

### 第一步：了解故事整体结构
1. 调用 `tool_get_story_structure()` 获取故事整体框架
2. 调用 `tool_get_all_characters_for_planning()` 获取角色列表

### 第二步：识别关键节点
3. 调用 `tool_search_plot_points("主要冲突和转折")` 找出高潮点
4. 调用 `tool_search_timeline_events("从开篇到结局的主要事件")` 获取时间线

### 第三步：分析角色发展
5. 对主要角色调用 `tool_search_character_arcs(角色名)` 了解角色弧线
6. 调用 `tool_search_relationship_changes("主要角色之间的关系变化")` 了解关系演变

### 第四步：确定剧集边界
7. 根据以上信息，找出自然的剧集切分点（如：
   - 重大冲突爆发/解决
   - 角色命运转折
   - 关系重大变化
   - 悬念揭示/新悬念产生）

### 第五步：细化每集内容
8. 对每集的章节范围调用 `tool_search_chapter_summary(范围)` 获取详细内容
9. 调用 `tool_search_cliffhanger_candidates(本集内容)` 找到合适的悬念点

## 剧集规划原则

### 结构要求
- 第1集：建立世界观、引入主角、埋下主线伏笔
- 第2-3集：发展冲突、展开支线
- 中间集：推进主线、角色成长、关系变化
- 倒数2-3集：主要冲突激化、高潮前奏
- 最后1-2集：高潮、结局、留白

### 单集要求
1. **完整性**：每集有独立的开始-发展-高潮
2. **悬念**：每集结尾必须有悬念，让观众想看下一集
3. **冲突**：每集有明确的主要冲突
4. **角色**：限制出场角色数量（3-6人为宜）
5. **时长**：内容量适合 3-5 分钟视频

### cliffhanger 技巧
- 悬念揭示一半（如：门被推开，来人是...）
- 危机降临（如：信使带来坏消息...）
- 反转预告（如：而她不知道的是...）
- 秘密暴露（如：一封信从袖中滑落...）

## 角色引用规范

`character_names` 必须从已知角色列表中选择，不要创造新角色名。

## 输出要求

使用工具充分搜索信息后，输出 EpisodePlannerOutput 格式的 JSON。
确保：
1. 编号从 1 开始连续
2. 每集都有 cliffhanger
3. 角色名与已知列表一致
"""


# =============================================================================
# Agent Factory
# =============================================================================


def create_episode_planner_agent(tools: List[Callable]) -> Agent:
    """创建剧集规划 Agent。

    Args:
        tools: 剧集规划工具列表

    Returns:
        配置好的 Agent
    """
    return Agent(
        get_pydantic_model(),
        system_prompt=EPISODE_PLANNER_PROMPT,
        tools=tools,
        output_type=EpisodePlannerOutput,
        output_retries=3,
        name="剧集规划师",
    )


# =============================================================================
# EpisodePlannerAgent 类
# =============================================================================


class EpisodePlannerAgent:
    """剧集规划 Agent - 使用图谱搜索进行多轮迭代式规划。

    替代原来 pipeline.py 中的 extract_episodes_with_characters() 函数。
    通过充分利用 Cognee 图谱搜索能力，生成更高质量的剧集规划。

    示例:
        >>> planner = EpisodePlannerAgent(cognee_store)
        >>> episodes = await planner.plan_episodes(target_episodes=10)
    """

    def __init__(self, store: "CogneeStore"):
        """初始化剧集规划 Agent。

        Args:
            store: CogneeStore 实例（用于图谱搜索）
        """
        self.store = store
        self.tools = create_episode_planner_tools(store)

    async def plan_episodes(
        self,
        target_episodes: int,
        known_characters: Optional[List[str]] = None,
        on_progress: Optional[Callable[[float, str], None]] = None,
        on_log: Optional[Callable[[str], None]] = None,
    ) -> List["NovelEpisode"]:
        """规划剧集。

        使用 Agent 进行多轮迭代式规划：
        1. 搜索故事结构和高潮点
        2. 识别角色关系变化节点
        3. 规划剧集边界
        4. 生成剧集大纲

        Args:
            target_episodes: 目标剧集数
            known_characters: 已知角色名称列表（用于限制角色引用）
            on_progress: 进度回调
            on_log: 日志回调

        Returns:
            规划的剧集列表
        """
        from novelvideo.models import NovelEpisode

        with preserve_st_env():
            from cognee.tasks.storage import add_data_points

        def report(progress: float, task: str):
            if on_progress:
                on_progress(progress, task)

        def log(message: str):
            if on_log:
                on_log(message)
            print(f"[EpisodePlanner] {message}")

        log_agent_start("剧集规划师", f"规划 {target_episodes} 集")
        report(0.1, "初始化规划...")

        # 获取已知角色列表
        if known_characters is None:
            characters = await self.store.list_characters()
            known_characters = [c.name for c in characters]
        log(f"已知角色: {len(known_characters)} 个")

        # 构建角色提示
        character_hint = ""
        if known_characters:
            character_hint = f"""

## 已知角色列表
以下是已确认的角色，character_names 字段只能从此列表选择：
{', '.join(known_characters)}
"""

        # 创建 Agent
        agent = create_episode_planner_agent(self.tools)

        # 构建任务
        task = f"""请为这部小说规划 {target_episodes} 集。
{character_hint}

请按照以下步骤操作：

1. 首先调用 tool_get_story_structure() 了解故事整体结构
2. 调用 tool_get_all_characters_for_planning() 确认角色列表
3. 调用 tool_search_plot_points("主要冲突和高潮") 找出关键节点
4. 调用 tool_search_timeline_events("从开篇到结局") 获取时间线
5. 根据搜索结果规划 {target_episodes} 集

确保：
- 每集有独立的冲突和悬念
- 角色名只使用已知列表中的名字
- cliffhanger 要吸引观众想看下一集
"""

        report(0.2, "Agent 搜索故事信息...")
        log("开始多轮搜索...")

        try:
            # 运行 Agent（会自动进行多轮工具调用）
            result = await agent.run(task)

            report(0.7, "解析规划结果...")

            # 解析输出
            output = result.output

            log(f"Agent 返回 {len(output.episodes)} 集规划")

            # 转换为 NovelEpisode
            episodes = []
            for plan in output.episodes:
                episode = NovelEpisode(
                    number=plan.number,
                    title=plan.title,
                    chapter_start=plan.chapter_start,
                    chapter_end=plan.chapter_end,
                    content_summary=plan.content_summary,
                    main_conflict=plan.main_conflict,
                    cliffhanger=plan.cliffhanger,
                    key_events=plan.key_events,
                    character_names=plan.character_names,
                    project_name=self.store.project_name,
                )
                episodes.append(episode)

            # 验证和修正编号
            episodes = self._validate_and_fix_episodes(episodes, target_episodes, log)

            report(0.9, "存入图谱...")
            log("存入 Cognee 图谱...")
            await add_data_points(episodes)

            log_agent_end("剧集规划师", success=True, result=f"规划 {len(episodes)} 集")
            report(1.0, "完成")

            return episodes

        except Exception as e:
            log_agent_end("剧集规划师", success=False, result=str(e))
            log(f"Agent 规划失败: {e}，回退到旧方案...")

            # 回退到旧的单次 LLM 调用
            return await self._fallback_planning(
                target_episodes,
                known_characters,
                on_progress,
                on_log,
            )

    def _validate_and_fix_episodes(
        self,
        episodes: List["NovelEpisode"],
        target_count: int,
        log: Callable[[str], None],
    ) -> List["NovelEpisode"]:
        """验证并修正剧集列表。

        确保：
        - 编号从 1 开始
        - 编号连续
        - 数量符合预期

        Args:
            episodes: 原始剧集列表
            target_count: 目标数量
            log: 日志函数

        Returns:
            修正后的剧集列表
        """
        if not episodes:
            return episodes

        # 按编号排序
        episodes.sort(key=lambda ep: ep.number)

        # 检查编号是否从 1 开始
        if episodes[0].number != 1:
            log(f"修正编号：从 {episodes[0].number} 改为从 1 开始")
            for i, ep in enumerate(episodes, start=1):
                ep.number = i

        # 检查编号是否连续
        for i, ep in enumerate(episodes, start=1):
            if ep.number != i:
                log(f"修正编号 {ep.number} → {i}")
                ep.number = i

        # 检查数量
        if len(episodes) < target_count:
            log(f"警告：规划的集数 ({len(episodes)}) 少于目标 ({target_count})")
        elif len(episodes) > target_count:
            log(f"警告：规划的集数 ({len(episodes)}) 多于目标 ({target_count})")

        return episodes

    async def _fallback_planning(
        self,
        target_episodes: int,
        known_characters: Optional[List[str]],
        on_progress: Optional[Callable[[float, str], None]],
        on_log: Optional[Callable[[str], None]],
    ) -> List["NovelEpisode"]:
        """回退到旧的规划方案（单次 LLM 调用）。

        当 Agent 规划失败时使用。

        Args:
            target_episodes: 目标剧集数
            known_characters: 已知角色列表
            on_progress: 进度回调
            on_log: 日志回调

        Returns:
            规划的剧集列表
        """
        from novelvideo.cognee.pipeline import extract_episodes_with_characters
        from novelvideo.novel_source import require_imported_novel

        def log(message: str):
            if on_log:
                on_log(message)
            print(f"[EpisodePlanner.fallback] {message}")

        log("使用旧方案（单次 LLM 调用）...")

        # 从文件加载原文
        novel_content = require_imported_novel(self.store.project_dir)

        episodes = await extract_episodes_with_characters(
            novel_content,
            target_episodes=target_episodes,
            known_characters=known_characters,
            dataset_name=self.store.dataset_name,
            project_name=self.store.project_name,
        )

        log(f"旧方案完成: {len(episodes)} 集")
        return episodes


# =============================================================================
# 工厂函数
# =============================================================================


def create_episode_planner(store: "CogneeStore") -> EpisodePlannerAgent:
    """创建剧集规划 Agent。

    Args:
        store: CogneeStore 实例

    Returns:
        EpisodePlannerAgent 实例
    """
    return EpisodePlannerAgent(store)
