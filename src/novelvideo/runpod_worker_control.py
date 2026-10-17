"""Start/stop control for the dev-only RunPod Qwen-Image 2.1 worker.

Lets the Settings UI flip the shared endpoint's `workers.max` between 0 and 1
without needing the `photoreal-short-drama-generator` project's own `rp.py`
CLI. Mirrors that project's `scripts/rp.py` transport (same two RunPod hosts,
same Cloudflare-dodging User-Agent on the CTRL host — see its module
docstring) but only the pieces this UI needs: read the endpoint's current
`workers` config plus live worker/job counts, and PATCH `workers.max`.

This endpoint (`a31613hf7l83r5`, project name `photoreal-drama-h3`) is now
dedicated to DramaClaw — the photoreal project only uses it for ad hoc
testing, not production, so there is no conflicting owner to coordinate with.
"""

from __future__ import annotations

from typing import Any

import httpx

from novelvideo.config import (
    RUNPOD_API_KEY,
    RUNPOD_QWEN_IMAGE_ENDPOINT_ID,
    RUNPOD_QWEN_IMAGE_IDLE_TIMEOUT_SECONDS,
    _runpod_qwen_image_configured,
)

_JOB_HOST = "https://api.runpod.ai/v2"
_CTRL_HOST = "https://api.runpod.io/v2"
# CTRL host (api.runpod.io) sits behind Cloudflare, which blocks the default
# httpx/urllib User-Agent as a bot (error 1010) — same workaround as
# photoreal's scripts/rp.py `workers()`.
_CTRL_USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)


class RunpodWorkerControlError(RuntimeError):
    """RUNPOD_API_KEY/RUNPOD_QWEN_IMAGE_ENDPOINT_ID missing, or a RunPod API call failed."""


def runpod_worker_control_configured() -> bool:
    """Same gate as the `runpod_qwen_image*` Image source selections — see
    `_visible_image_generation_selection()` in config.py. Worker start/stop
    only needs RUNPOD_API_KEY + the endpoint id, but requiring the full set
    (R2 too) keeps this control from appearing when the provider itself
    couldn't actually generate anything yet.
    """
    return _runpod_qwen_image_configured()


def _require_configured() -> None:
    if not runpod_worker_control_configured():
        raise RunpodWorkerControlError(
            "RunPod worker control is not configured "
            "(RUNPOD_API_KEY / RUNPOD_QWEN_IMAGE_ENDPOINT_ID / R2_* missing)"
        )


async def _ctrl_get() -> dict[str, Any]:
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.get(
            f"{_CTRL_HOST}/serverless/{RUNPOD_QWEN_IMAGE_ENDPOINT_ID}",
            headers={
                "Authorization": f"Bearer {RUNPOD_API_KEY}",
                "User-Agent": _CTRL_USER_AGENT,
            },
        )
        resp.raise_for_status()
        return resp.json()


async def _ctrl_patch_workers(max_workers: int) -> dict[str, Any]:
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.patch(
            f"{_CTRL_HOST}/serverless/{RUNPOD_QWEN_IMAGE_ENDPOINT_ID}",
            headers={
                "Authorization": f"Bearer {RUNPOD_API_KEY}",
                "User-Agent": _CTRL_USER_AGENT,
                "Content-Type": "application/json",
            },
            json={
                "workers": {
                    "max": max_workers,
                    "min": 0,
                    "idleTimeout": RUNPOD_QWEN_IMAGE_IDLE_TIMEOUT_SECONDS,
                }
            },
        )
        resp.raise_for_status()
        return resp.json()


async def _job_health() -> dict[str, Any] | None:
    """Live worker/job counts — best-effort, so a transient RunPod hiccup
    degrades the status payload instead of failing the whole request."""
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.get(
                f"{_JOB_HOST}/{RUNPOD_QWEN_IMAGE_ENDPOINT_ID}/health",
                headers={"Authorization": f"Bearer {RUNPOD_API_KEY}"},
            )
            resp.raise_for_status()
            return resp.json()
    except httpx.HTTPError:
        return None


def _status_payload(
    endpoint_cfg: dict[str, Any], health: dict[str, Any] | None
) -> dict[str, Any]:
    workers_cfg = endpoint_cfg.get("workers") or {}
    max_workers = int(workers_cfg.get("max") or 0)
    return {
        "configured": True,
        "running": max_workers > 0,
        "endpointId": RUNPOD_QWEN_IMAGE_ENDPOINT_ID,
        "endpointName": endpoint_cfg.get("name"),
        "workers": {
            "max": max_workers,
            "min": int(workers_cfg.get("min") or 0),
            "idleTimeoutSeconds": int(workers_cfg.get("idleTimeout") or 0),
        },
        # {idle, initializing, ready, running, throttled, unhealthy} — None
        # when the health call itself failed, not when the endpoint is cold.
        "live": (health or {}).get("workers"),
        "jobs": (health or {}).get("jobs"),
    }


async def get_status() -> dict[str, Any]:
    if not runpod_worker_control_configured():
        return {"configured": False, "running": False}
    endpoint_cfg = await _ctrl_get()
    health = await _job_health()
    return _status_payload(endpoint_cfg, health)


async def start_worker() -> dict[str, Any]:
    _require_configured()
    endpoint_cfg = await _ctrl_patch_workers(1)
    health = await _job_health()
    return _status_payload(endpoint_cfg, health)


async def stop_worker() -> dict[str, Any]:
    _require_configured()
    endpoint_cfg = await _ctrl_patch_workers(0)
    health = await _job_health()
    return _status_payload(endpoint_cfg, health)
