"""Public runtime configuration for the frontend."""

from __future__ import annotations

import logging
import os
from typing import Literal
from urllib.parse import urlsplit

from fastapi import APIRouter
from fastapi.responses import JSONResponse
from ulid import ULID

from novelvideo.shared import runtime_env

logger = logging.getLogger(__name__)

router = APIRouter()

RuntimeEdition = Literal["ce", "ee"]
_INSTANCE_ID = str(ULID())


def _runtime_edition() -> RuntimeEdition:
    return "ce" if runtime_env.is_ce_effective() else "ee"


def _mcp_direct_canvas_apply_enabled() -> bool:
    return os.environ.get("DRAMACLAW_MCP_DIRECT_CANVAS_APPLY", "").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }


def _browser_model_asset_base() -> str | None:
    """浏览器端推理（抠图、深度动作捕捉）拉模型权重与 onnxruntime wasm 的自托管前缀。

    不配时浏览器走 transformers.js 默认源（Hugging Face Hub + jsDelivr），国内网络
    基本不可达。目录布局与准备方法见 scripts/fetch_browser_models.py。
    """
    base = os.environ.get("BROWSER_MODEL_ASSET_BASE", "").strip().rstrip("/")
    if not base:
        return None
    parts = urlsplit(base)
    if parts.scheme not in {"http", "https"} or not parts.netloc:
        logger.warning("BROWSER_MODEL_ASSET_BASE 不是 http(s) 地址，已忽略；浏览器端模型仍走默认源。")
        return None
    return base


@router.get("/config")
async def get_runtime_config():
    edition = _runtime_edition()
    return JSONResponse(
        {
            "ok": True,
            "data": {
                "edition": edition,
                "auth_required": edition == "ee",
                "instance_id": _INSTANCE_ID,
                "mcp_direct_canvas_apply": _mcp_direct_canvas_apply_enabled(),
                "browser_model_asset_base": _browser_model_asset_base(),
            },
        }
    )
