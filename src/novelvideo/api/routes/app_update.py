"""应用内自更新路由(仅原生便携/安装形态生效,见 novelvideo.app_update)。"""

from __future__ import annotations

import asyncio

from fastapi import APIRouter, Depends, HTTPException

from novelvideo import app_update
from novelvideo.api.auth import get_api_user
from novelvideo.api.schemas import OkResponse

router = APIRouter()


@router.get("/app-update/status", response_model=OkResponse)
async def get_app_update_status(_user: dict = Depends(get_api_user)) -> OkResponse:
    return OkResponse(data=await app_update.status())


@router.post("/app-update/apply", response_model=OkResponse)
async def post_app_update_apply(_user: dict = Depends(get_api_user)) -> OkResponse:
    snapshot = await app_update.status()
    if snapshot["mode"] != "self_update":
        raise HTTPException(status_code=409, detail=f"self update unavailable (mode={snapshot['mode']})")
    if not snapshot["update_available"]:
        raise HTTPException(status_code=409, detail="already up to date")
    # 下载体量在 GB 级:后台执行,前端轮询 status.progress;
    # 失败只落在 progress.phase=failed,不影响现有安装。
    task = asyncio.create_task(app_update.apply())
    task.add_done_callback(lambda t: t.exception())  # 异常已进 progress,避免 unhandled 告警
    return OkResponse(data={"started": True, "target_tag": snapshot["latest_tag"]})
