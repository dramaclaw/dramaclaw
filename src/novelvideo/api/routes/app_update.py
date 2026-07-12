"""应用内自更新路由(仅原生便携/安装形态生效,见 novelvideo.app_update)。"""

from __future__ import annotations

import asyncio
from typing import Any

from fastapi import APIRouter, Depends, HTTPException

from novelvideo import app_update
from novelvideo.api.auth import get_api_user
from novelvideo.api.schemas import OkResponse

router = APIRouter()

# asyncio 只持任务弱引用:不自己收留,GB 级下载任务可能被 GC 中途回收
_apply_tasks: set[asyncio.Task[Any]] = set()


def _reap_apply_task(task: asyncio.Task[Any]) -> None:
    _apply_tasks.discard(task)
    if not task.cancelled():
        task.exception()  # 异常已进 progress,取出以免 unhandled 告警


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
    _apply_tasks.add(task)
    task.add_done_callback(_reap_apply_task)
    return OkResponse(data={"started": True, "target_tag": snapshot["latest_tag"]})
