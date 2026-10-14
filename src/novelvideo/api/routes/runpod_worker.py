"""Start/stop control for the dev-only RunPod Qwen-Image 2.1 worker.

Backs the Settings → Models "RunPod Qwen Image 2.1" start/stop control (see
`runpod_worker_control.py` for the RunPod API calls themselves). Dev-only,
same gate as the `runpod_qwen_image*` Image source selections — invisible
unless this machine's `.env` actually has RUNPOD_API_KEY/R2_* configured.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException
import httpx

from novelvideo.runpod_worker_control import (
    RunpodWorkerControlError,
    get_status,
    start_worker,
    stop_worker,
)
from novelvideo.service_operation_gate import (
    ServiceOperationExcluded,
    require_legacy_local_service_operation,
)

router = APIRouter(prefix="/runpod-worker")


def _require_ce_local() -> None:
    try:
        require_legacy_local_service_operation()
    except ServiceOperationExcluded as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc


async def _call(action) -> dict[str, Any]:
    try:
        return await action()
    except RunpodWorkerControlError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except httpx.HTTPStatusError as exc:
        raise HTTPException(
            status_code=502,
            detail=f"RunPod API {exc.response.status_code}: {exc.response.text[:500]}",
        ) from exc
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"RunPod API request failed: {exc}") from exc


@router.get("/status")
async def get_runpod_worker_status() -> dict[str, Any]:
    _require_ce_local()
    data = await _call(get_status)
    return {"ok": True, "data": data}


@router.post("/start")
async def start_runpod_worker() -> dict[str, Any]:
    _require_ce_local()
    data = await _call(start_worker)
    return {"ok": True, "data": data}


@router.post("/stop")
async def stop_runpod_worker() -> dict[str, Any]:
    _require_ce_local()
    data = await _call(stop_worker)
    return {"ok": True, "data": data}
