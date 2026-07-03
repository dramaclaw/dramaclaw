"""NovelVideo Studio - REST API 模块。

提供 /api/v1/ 端点，供 OpenClaw 等外部 Agent 调用。
"""

import logging
from importlib.metadata import entry_points
from logging.handlers import RotatingFileHandler
from pathlib import Path

from fastapi import APIRouter

from novelvideo.config import RUNTIME_DIR
from novelvideo.shared import runtime_env

_api_logger = logging.getLogger("novelvideo.api")
_api_logger.setLevel(logging.INFO)
_api_logger.propagate = True
_log_path = f"{RUNTIME_DIR}/api.log"
try:
    Path(RUNTIME_DIR).mkdir(parents=True, exist_ok=True)
    _existing_handler = next(
        (
            handler
            for handler in _api_logger.handlers
            if isinstance(handler, RotatingFileHandler)
            and getattr(handler, "baseFilename", "") == _log_path
        ),
        None,
    )
    if _existing_handler is None:
        _fh = RotatingFileHandler(
            _log_path,
            maxBytes=10 * 1024 * 1024,
            backupCount=3,
            encoding="utf-8",
        )
        _fh.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
        _api_logger.addHandler(_fh)
except Exception:
    pass

from novelvideo.api.routes import (  # noqa: E402
    assets,
    auth,
    characters,
    chat,
    config,
    content,
    episodes,
    files,
    freezone,
    generation,
    ingest,
    model_gateway,
    model_credits,
    pipeline,
    projects,
    props,
    release_notifications,
    scenes,
    scripts,
    styles,
    tasks,
)

api_router = APIRouter(prefix="/api/v1")

OPENAPI_TAGS = [
    {"name": "freezone-bootstrap", "description": "Freezone 启动、初始化与 provider 能力发现。"},
    {"name": "freezone-media", "description": "Freezone 候选媒体输入，如上传与外部文件导入。"},
    {
        "name": "freezone-audio",
        "description": "Freezone 音频节点接口，包括参考音频和文生语音。",
    },
    {
        "name": "freezone-image",
        "description": "Freezone 图片节点接口，包括生成、编辑、扩图、重绘、反推提示词等。",
    },
    {
        "name": "freezone-video",
        "description": "Freezone 视频节点接口，包括文生视频、图生视频、运镜模板、角色库等。",
    },
    {"name": "freezone-text", "description": "Freezone 文本节点接口，包括翻译与故事脚本生成。"},
    {"name": "freezone-canvas", "description": "Freezone 画布文档接口。"},
    {"name": "freezone-assets", "description": "Freezone canonical 资产与上下文接口。"},
    {
        "name": "freezone-commit",
        "description": "Freezone candidate 写回 canonical asset slot 的相关接口。",
    },
    {"name": "freezone-jobs", "description": "Freezone 异步任务结果查询接口。"},
]

api_router.include_router(auth.router, tags=["auth"])
if not runtime_env.is_ce_effective():
    for ep in entry_points(group="novelvideo.api_routes"):
        ep.load()(api_router)
api_router.include_router(config.router, tags=["config"])
api_router.include_router(chat.router, tags=["chat"])
api_router.include_router(projects.router, tags=["projects"])
api_router.include_router(ingest.router, tags=["ingest"])
api_router.include_router(characters.router, tags=["characters"])
api_router.include_router(assets.router, tags=["assets"])
api_router.include_router(scenes.router, tags=["scenes"])
api_router.include_router(props.router, tags=["props"])
api_router.include_router(episodes.router, tags=["episodes"])
api_router.include_router(scripts.router, tags=["scripts"])
api_router.include_router(content.router, tags=["content"])
api_router.include_router(generation.router, tags=["generation"])
api_router.include_router(tasks.router, tags=["tasks"])
api_router.include_router(files.router, tags=["files"])
api_router.include_router(styles.router, tags=["styles"])
api_router.include_router(pipeline.router, tags=["pipeline"])
api_router.include_router(model_gateway.router, tags=["model-gateway"])
api_router.include_router(model_credits.router, tags=["model-credits"])
api_router.include_router(freezone.router)
api_router.include_router(release_notifications.router, tags=["release-notifications"])
_verification_routes_registered = False


def register_verification_routes():
    """延迟注册验证路由，避免循环导入。"""
    global _verification_routes_registered
    if _verification_routes_registered:
        return
    from novelvideo.verification.routes import router as verification_router

    api_router.include_router(verification_router, tags=["verification"])
    _verification_routes_registered = True
