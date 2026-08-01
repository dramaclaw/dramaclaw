"""NovelVideo Cognee 统一存储模块。

核心理念：所有实体直接存入 Cognee 图谱，不需要额外的 JSON 存储。

使用方式：
    from novelvideo.cognee import CogneeStore, NovelCharacter, NovelEpisode

    store = await create_cognee_store("hongloumeng")

    # 导入小说并构建图谱角色/剧集
    await store.ingest_novel("hongloumeng.txt")

    # 查询角色（支持别名）
    char = store.get_character("皇后")  # 返回姜裳宁
    prompt = char.face_prompt  # 直接获取面部 Prompt
"""

# 重要：必须先导入 config，在 cognee 被导入之前设置环境变量
from .config import init_cognee, get_cognee_status

from .store import CogneeStore, create_cognee_store
from novelvideo.models import (
    NovelCharacter,
    NovelEpisode,
    NovelEvent,
    NovelVisualBeat,
    NovelScene,
    NovelProp,
)
from .pipeline import (
    run_character_extraction_pipeline,
    run_episode_planning_pipeline,
    extract_scenes_from_graph,
    extract_scenes_from_script,
    extract_props_from_graph,
)
from .tools import create_episode_planner_tools

__all__ = [
    # 存储
    "CogneeStore",
    "create_cognee_store",

    # 实体
    "NovelCharacter",
    "NovelEpisode",
    "NovelEvent",
    "NovelVisualBeat",
    "NovelScene",
    "NovelProp",

    # Pipeline
    "run_character_extraction_pipeline",
    "run_episode_planning_pipeline",
    "extract_scenes_from_graph",
    "extract_scenes_from_script",
    "extract_props_from_graph",

    # Tools
    "create_episode_planner_tools",

    # 配置
    "init_cognee",
    "get_cognee_status",
]
