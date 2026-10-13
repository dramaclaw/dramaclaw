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


def _browser_model_url(env_name: str) -> str | None:
    """读一个浏览器端推理（抠图、深度动作捕捉）资源源地址；非 http(s) 一律忽略。

    三个变量都不配时浏览器走 transformers.js 默认源（Hugging Face Hub + jsDelivr），
    国内网络基本不可达：
    - BROWSER_MODEL_ASSET_BASE：自托管前缀，权重和 wasm 都从这里拉，目录布局与
      准备方法见 scripts/fetch_browser_models.py。
    - BROWSER_MODEL_HF_ENDPOINT：只换权重源，路径规则与 Hugging Face Hub 一致的镜像。
    - BROWSER_ORT_WASM_BASE：只换 onnxruntime wasm 源，`{version}` 由前端按打进包里
      的 onnxruntime-web 版本替换。
    后两个各自优先于 ASSET_BASE。
    """
    base = os.environ.get(env_name, "").strip().rstrip("/")
    if not base:
        return None
    parts = urlsplit(base)
    if parts.scheme not in {"http", "https"} or not parts.netloc:
        logger.warning("%s 不是 http(s) 地址，已忽略；浏览器端模型仍走默认源。", env_name)
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
                "browser_model_asset_base": _browser_model_url("BROWSER_MODEL_ASSET_BASE"),
                "browser_model_hf_endpoint": _browser_model_url("BROWSER_MODEL_HF_ENDPOINT"),
                "browser_ort_wasm_base": _browser_model_url("BROWSER_ORT_WASM_BASE"),
            },
        }
    )
