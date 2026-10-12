"""NovelVideo - 小说解说视频自动生成系统（Cognee 版）。

基于 SuperScript 架构，将小说转换为 30-60 集解说视频。

核心特性：
- Cognee 统一图谱
- 火山引擎 Seedream 图像生成
- 角色一致性保障（参考图 + SeedEdit）
- 多 Agent 协作生成
"""

import os as _os

# Dev-only model-call logging (Langfuse). Inert unless LLM_CALL_LOG_ENABLED is set.
if _os.environ.get("LLM_CALL_LOG_ENABLED", "").strip().lower() in {"1", "true", "yes", "on"}:
    import atexit as _atexit

    from novelvideo import llm_call_log as _llm_call_log

    if _llm_call_log.install():
        _atexit.register(_llm_call_log.flush)
