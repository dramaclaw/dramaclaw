"""Cognee 工具函数。

为仍使用图谱检索的规划和审核 Agent 提供查询能力。
Agent 在任务运行器中运行，工具直接使用 async def，复用当前 event loop。

工具集：
- create_episode_planner_tools: 剧集规划 Agent 工具
- create_reviewer_tools: 脚本审核/修复 Agent 工具（用于身份验证）
"""

from typing import Callable, List

from novelvideo.cognee import CogneeStore
from novelvideo.utils.logging import tool_logger

def create_episode_planner_tools(store: CogneeStore) -> List[Callable]:
    """创建 EpisodePlanner 的 Cognee 工具集。

    为剧集规划 Agent 提供图谱搜索能力，用于：
    - 识别情节高潮点和转折点
    - 查找角色关系变化节点
    - 按时间顺序获取事件
    - 获取角色列表

    所有工具都是 async def，直接复用当前 event loop。
    """

    @tool_logger("search_plot_points")
    async def tool_search_plot_points(query: str) -> str:
        """搜索情节转折点、高潮点。

        用于识别故事中的关键情节节点，如：
        - 重大冲突爆发
        - 角色命运转折
        - 悬念揭示
        - 情感高潮

        Args:
            query: 情节查询，如"主要的冲突事件"、"角色命运的转折点"
        """
        enhanced_query = f"故事中的重要转折点和高潮：{query}"
        return await store.search(enhanced_query, mode="graph")

    @tool_logger("search_character_arcs")
    async def tool_search_character_arcs(character_name: str) -> str:
        """搜索角色的成长弧线和关键变化。

        查找角色在故事中的主要变化节点，如：
        - 身份变化
        - 性格转变
        - 关系变化
        - 命运转折

        Args:
            character_name: 角色名称
        """
        query = f"{character_name}在故事中的主要变化和成长节点，包括身份变化、重要决定、关系转变"
        return await store.search(query, mode="triplet")

    @tool_logger("search_relationship_changes")
    async def tool_search_relationship_changes(query: str) -> str:
        """搜索角色关系变化。

        查找角色之间关系的重大变化，如：
        - 敌对转友好
        - 背叛
        - 结盟
        - 分离

        Args:
            query: 关系查询，如"主角与反派的关系变化"
        """
        return await store.search(query, mode="triplet")

    @tool_logger("get_story_structure")
    async def tool_get_story_structure() -> str:
        """获取故事整体结构概览。

        返回故事的起承转合、主要冲突、角色阵营等宏观信息。
        """
        query = "故事的整体结构，包括开端、发展、高潮、结局，以及主要冲突和角色阵营"
        return await store.search(query, mode="summaries")

    @tool_logger("get_all_characters_for_planning")
    async def tool_get_all_characters_for_planning() -> str:
        """获取所有角色列表（用于剧集规划）。

        返回角色名称、定位、重要性等信息。
        """
        characters = await store.list_characters()
        if not characters:
            return "暂无角色信息"

        lines = ["## 角色列表（剧集规划用）"]
        for char in characters:
            role_info = f"({char.role})" if char.role else ""
            lines.append(
                f"- {char.name} {role_info}: {char.description[:50]}..."
                if char.description
                else f"- {char.name} {role_info}"
            )
        return "\n".join(lines)

    @tool_logger("search_chapter_summary")
    async def tool_search_chapter_summary(chapter_range: str) -> str:
        """获取指定章节范围的摘要。

        Args:
            chapter_range: 章节范围，如"1-10"、"前5章"、"中期章节"
        """
        query = f"第{chapter_range}章的主要情节、冲突和角色表现"
        return await store.search(query, mode="summaries")

    @tool_logger("search_conflict_events")
    async def tool_search_conflict_events(query: str) -> str:
        """搜索冲突事件。

        查找故事中的冲突、对抗、矛盾事件。

        Args:
            query: 冲突查询，如"皇后与妃嫔的冲突"、"朝堂斗争"
        """
        enhanced_query = f"冲突和对抗：{query}"
        return await store.search(enhanced_query, mode="graph_cot")

    @tool_logger("search_cliffhanger_candidates")
    async def tool_search_cliffhanger_candidates(context: str) -> str:
        """搜索适合作为剧集结尾悬念的情节点。

        Args:
            context: 当前剧集的上下文，用于找到合适的悬念点
        """
        query = f"在{context}之后，什么事件可以作为悬念或钩子让观众期待下一集"
        return await store.search(query, mode="context_ext")

    return [
        tool_search_plot_points,
        tool_search_character_arcs,
        tool_search_relationship_changes,
        tool_get_story_structure,
        tool_get_all_characters_for_planning,
        tool_search_chapter_summary,
        tool_search_conflict_events,
        tool_search_cliffhanger_candidates,
    ]


def create_reviewer_tools(store: CogneeStore) -> List[Callable]:
    """创建 ScriptReviewer/ScriptFixer 专用工具集。

    为审核员和修复员提供角色身份查询和验证能力，
    解决 Reviewer/Fixer "盲人摸象"问题 - 无法访问身份元数据。

    工具列表:
    - tool_get_character: 查询角色详情和所有身份
    - tool_validate_identity: 验证身份 ID 是否有效
    - tool_list_all_identities: 列出所有角色的身份列表
    """

    @tool_logger("get_character")
    async def tool_get_character(name: str) -> str:
        """查询角色的所有身份信息。

        返回角色的详细信息，包括所有可用身份及其外观描述。
        用于验证脚本中使用的身份 ID 是否正确。

        Args:
            name: 角色名称（支持别名解析）

        Returns:
            角色详情字符串，包含身份列表
        """
        # 解析别名
        resolved_name = store.resolve_name(name)
        char = await store.get_character_from_graph(resolved_name)
        if not char:
            return f"未找到角色: {name}"
        return store.format_character_context(char)

    @tool_logger("validate_identity")
    async def tool_validate_identity(identity_id: str) -> str:
        """验证身份 ID 是否有效。

        检查给定的身份 ID 是否存在于系统中，
        如果无效则返回该角色的所有可用身份列表。

        Args:
            identity_id: 身份ID，格式为 "角色名_身份名"

        Returns:
            验证结果：
            - 有效：返回身份外观描述
            - 无效：返回可用身份列表
        """
        if "_" not in identity_id:
            return f"❌ 无效格式: {identity_id}，应为 '角色名_身份名'"

        # 尝试解析角色名（可能包含多个下划线）
        parts = identity_id.split("_")
        char = None
        char_name = None

        # 从长到短尝试匹配角色名
        for i in range(len(parts) - 1, 0, -1):
            candidate_name = "_".join(parts[:i])
            resolved = store.resolve_name(candidate_name)
            candidate_char = await store.get_character_from_graph(resolved)
            if candidate_char:
                char = candidate_char
                char_name = resolved
                break

        if not char:
            # 使用第一个下划线前的部分作为角色名
            char_name = parts[0]
            resolved = store.resolve_name(char_name)
            char = await store.get_character_from_graph(resolved)

        if not char:
            return f"❌ 未找到角色: {char_name}"

        # 检查身份是否有效
        for identity in char.identities:
            if identity.identity_id == identity_id:
                desc = (
                    identity.appearance_details[:100]
                    if identity.appearance_details
                    else "无外观描述"
                )
                return f"✅ 有效身份: {identity_id}\n外观: {desc}"

        # 身份无效，返回可用列表
        valid_ids = [i.identity_id for i in char.identities]
        return f"❌ 无效身份: {identity_id}\n可用身份: {', '.join(valid_ids)}"

    @tool_logger("list_all_identities")
    async def tool_list_all_identities() -> str:
        """列出所有角色的身份列表。

        返回系统中所有角色及其身份的完整列表，
        用于审核员查表验证身份选择是否正确。

        Returns:
            格式化的角色身份列表
        """
        characters = await store.list_characters()
        if not characters:
            return "暂无角色信息"

        lines = ["## 所有角色身份"]
        for char in characters:
            if char.identities:
                lines.append(f"\n### {char.name}")
                for identity in char.identities:
                    desc = identity.appearance_details
                    if desc:
                        desc = desc[:60] + "..." if len(desc) > 60 else desc
                    else:
                        desc = "无外观描述"
                    lines.append(f"- {identity.identity_id}: {desc}")

        return "\n".join(lines)

    @tool_logger("search_plot_context")
    async def tool_search_plot_context(query: str) -> str:
        """搜索原文情节，验证叙述是否符合原著。

        用于审核脚本时查证情节细节、角色互动是否符合原文。

        Args:
            query: 情节查询，如"主角在第3集做了什么"、"角色A和B的关系"
        """
        return await store.search(query, mode="graph")

    @tool_logger("search_background")
    async def tool_search_background(query: str) -> str:
        """扩展上下文搜索，获取修复所需的剧情背景。

        自动关联相关实体和事件，提供更丰富的上下文。
        用于修复脚本时理解角色背景和情节上下文。

        Args:
            query: 背景查询，如"角色的成长经历"、"事件的前因后果"
        """
        return await store.search(query, mode="context_ext")

    return [
        # 身份验证
        tool_get_character,
        tool_validate_identity,
        tool_list_all_identities,
        # 图谱搜索
        tool_search_plot_context,
        tool_search_background,
    ]
