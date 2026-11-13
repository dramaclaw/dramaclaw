# SPDX-License-Identifier: Elastic-2.0
# Copyright (c) 2026 ClaymoreLab
"""Plan canvas creation outside locks and validate the snapshot before saving."""

import asyncio
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from novelvideo.freezone import canvas_store, paths
from novelvideo.freezone.canvas_core_pool import get_canvas_core_pool
from novelvideo.freezone.canvas_lock import CanvasLockBusy
from novelvideo.ports import get_canvas_write_mutex

MAX_PLAN_ATTEMPTS = 3


@dataclass
class CanvasCreationResult:
    status: Literal["created", "exists", "rejected"]
    canvas_id: str | None = None
    display_name: str | None = None
    revision: int | None = None
    rejection: dict | None = None
    plan_payload: dict | None = None
    saved: canvas_store.CanvasSaveResult | None = None


class _CanvasAlreadyExists(Exception):
    pass


def _fingerprint(canvases: list[dict]) -> list[tuple]:
    rows = []
    for item in canvases:
        metadata = item.get("metadata") or {}
        rows.append((
            item["id"], metadata.get("canvas_origin"),
            metadata.get("creator_username"), metadata.get("display_name"),
        ))
    return sorted(rows)


def _replay(project_dir: Path, canvas_id: str, request_id: str) -> CanvasCreationResult | None:
    # The canvas's own request ID survives expiration of the store's replay cache.
    existing = canvas_store.read_canvas(project_dir, canvas_id)
    metadata = (existing or {}).get("metadata") or {}
    if existing is not None and metadata.get("create_request_id") == request_id:
        return CanvasCreationResult(
            "exists", canvas_id, metadata.get("display_name"), existing.get("revision"),
        )
    return None


def _save_plan(project_dir, plan, fingerprint, request_id, prepare_payload):
    # Always acquire the project create mutex before the store's per-canvas mutex.
    with get_canvas_write_mutex().write_mutex(project_dir, paths.CANVAS_CREATE_LOCK_ID):
        if _fingerprint(canvas_store.list_canvases(project_dir)) != fingerprint:
            return None
        canvas_id = plan["canvasId"]
        payload = plan["payload"]
        display_name = payload["metadata"]["display_name"]
        rejection = CanvasCreationResult(
            "rejected", rejection={"code": "id_taken", "name": display_name, "canvasId": canvas_id},
        )
        # Unlisted legacy files and writers outside the create mutex still reserve IDs.
        if paths.canvas_path(project_dir, canvas_id).exists():
            return _replay(project_dir, canvas_id, request_id) or rejection

        def build_payload(existing):
            if existing is not None:
                raise _CanvasAlreadyExists()
            return prepare_payload(payload, None)

        try:
            # Let the builder reject a raced creation before revision validation can mask it.
            saved = canvas_store.save_canvas(
                project_dir, canvas_id, base_revision=None, build_payload=build_payload,
                enforce_revision=False, client_save_id=request_id,
                save_source=payload["save_source"],
            )
        except _CanvasAlreadyExists:
            return rejection
        return CanvasCreationResult(
            "created", canvas_id, display_name, saved.payload.get("revision"),
            plan_payload=payload, saved=saved,
        )


async def create_user_canvas(
    project_dir: Path, *, project_id: str, name: str, request_id: str,
    creator_username: str | None, locale: str, origin: dict | None,
    prepare_payload: Callable[[dict, dict | None], dict],
) -> CanvasCreationResult:
    pool = get_canvas_core_pool()
    for _ in range(MAX_PLAN_ATTEMPTS):
        canvases = await asyncio.to_thread(canvas_store.list_canvases, project_dir)
        fingerprint = _fingerprint(canvases)
        wire = {
            "project_id": project_id, "name": name, "creator_username": creator_username,
            "request_id": request_id, "save_source": "agent_create" if origin else "manual_save",
            "canvases": canvases, "env": {"locale": locale},
        }
        if origin is not None:
            wire["origin"] = origin
        # Node computation must remain outside all write locks so plans can run concurrently.
        plan = await asyncio.to_thread(pool.call, "plan_canvas_creation", wire)
        if plan.get("canvasId"):
            replay = await asyncio.to_thread(_replay, project_dir, plan["canvasId"], request_id)
            if replay is not None:
                return replay
        if plan["status"] == "rejected":
            return CanvasCreationResult("rejected", rejection=plan["rejection"])
        result = await asyncio.to_thread(
            _save_plan, project_dir, plan, fingerprint, request_id, prepare_payload,
        )
        if result is not None:
            return result
    raise CanvasLockBusy(paths.CANVAS_CREATE_LOCK_ID)


async def describe_project_canvases(
    project_dir: Path, *, username: str | None, chat_canvas_id: str | None, locale: str,
) -> dict:
    canvases = await asyncio.to_thread(canvas_store.list_canvases, project_dir)
    pool = get_canvas_core_pool()
    return await asyncio.to_thread(pool.call, "describe_canvases", {
        "canvases": canvases,
        "viewer": {"username": username, "chat_canvas_id": chat_canvas_id},
        "env": {"locale": locale},
    })
