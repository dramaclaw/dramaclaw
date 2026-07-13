"""Prop asset workbench endpoints."""

from __future__ import annotations

import shutil
from pathlib import Path
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Query

from novelvideo.api.asset_metadata import newest_updated_at, tree_updated_at, utc_iso
from novelvideo.api.auth import get_api_user
from novelvideo.api.deps import (
    make_sqlite_store,
    make_sqlite_store_for_context,
    make_static_url_for_context,
    resolve_project_scope,
)
from novelvideo.api.schemas import PropCreate, PropReferenceGenerateRequest, PropUpdate
from novelvideo.models import NovelProp, build_prop_menu
from novelvideo.project_config import load_project_config_file
from novelvideo.sqlite_store import SQLiteStore
from novelvideo.ports import get_task_backend
from novelvideo.task_scopes import prop_reference_asset_scope
from novelvideo.task_identity import project_task_state_key
from novelvideo.utils.path_resolver import compute_prop_reference_path

router = APIRouter()


def _project_style(username: str, project: str) -> str:
    config = load_project_config_file(username, project)
    return str(config.get("visual_style") or config.get("project_style") or "")


def _asset_url(ctx, project_dir: Path, abs_path: str | Path) -> str:
    path = Path(abs_path)
    if not path.exists():
        return ""
    try:
        rel_path = path.relative_to(project_dir).as_posix()
    except ValueError:
        return ""
    return make_static_url_for_context(ctx, rel_path, local_path=path)


def _prop_payload(
    prop: NovelProp,
    *,
    ctx,
    project_dir: Path,
    scope: str = "global",
    source_episode: int | None = None,
) -> dict[str, Any]:
    reference_path = compute_prop_reference_path(project_dir, prop.name)
    payload = {
        "name": prop.name,
        "aliases": prop.aliases,
        "prop_type": prop.prop_type,
        "visual_prompt": prop.visual_prompt,
        "description": prop.description,
        "owner": prop.owner,
        "notes": prop.notes,
        "updated_at": newest_updated_at(
            getattr(prop, "updated_at", ""),
            tree_updated_at(project_dir / "assets" / "props" / prop.name),
        ),
        "scope": scope,
        "reference_path": reference_path,
        "reference_url": (
            _asset_url(ctx, project_dir, reference_path) if reference_path else ""
        ),
    }
    if source_episode is not None:
        payload["source_episode"] = source_episode
    return payload


async def _local_episode_prop_payloads(
    *,
    store: SQLiteStore,
    global_prop_names: set[str],
) -> list[dict[str, Any]]:
    if not hasattr(store, "list_episodes"):
        return []
    try:
        episodes = await store.list_episodes()
    except Exception:
        return []

    payloads: list[dict[str, Any]] = []
    seen_local: set[tuple[int, str]] = set()
    for episode in episodes or []:
        episode_number = int(getattr(episode, "number", 0) or 0)
        episode_updated_at = utc_iso(getattr(episode, "updated_at", ""))
        for menu_item in build_prop_menu(prop_menu=getattr(episode, "prop_menu", []) or []):
            prop_id = str(menu_item.prop_id or "").strip()
            if not prop_id or prop_id in global_prop_names:
                continue
            key = (episode_number, prop_id)
            if key in seen_local:
                continue
            seen_local.add(key)
            payloads.append(
                {
                    "name": prop_id,
                    "aliases": [],
                    "prop_type": menu_item.prop_type,
                    "visual_prompt": menu_item.visual_prompt,
                    "description": menu_item.description,
                    "owner": menu_item.owner_identity_id,
                    "notes": "",
                    "updated_at": episode_updated_at,
                    "scope": "local",
                    "source_episode": episode_number,
                    "reference_path": "",
                    "reference_url": "",
                }
            )
    return payloads


def _rename_prop_asset_dir(project_dir: Path, old_name: str, new_name: str) -> None:
    old_dir = project_dir / "assets" / "props" / old_name
    new_dir = project_dir / "assets" / "props" / new_name
    if not old_dir.exists():
        return
    if new_dir.exists():
        raise ValueError(f"Target asset directory already exists: {new_dir}")
    new_dir.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(old_dir), str(new_dir))


async def _require_prop(store: SQLiteStore, name: str) -> NovelProp | None:
    return await store.get_prop(name)


@router.get("/projects/{project}/props")
async def list_props(
    project: str,
    scope: Annotated[str, Query(pattern="^(global|local|all)$")] = "global",
    user: dict = Depends(get_api_user),
):
    resolved = await resolve_project_scope(project, user, required_role="viewer")
    store = (
        await make_sqlite_store_for_context(resolved.ctx)
        if resolved.ctx
        else await make_sqlite_store(resolved.username, resolved.project_name)
    )
    project_dir = resolved.project_dir
    props = await store.list_props()
    global_names = {prop.name for prop in props}
    data: list[dict[str, Any]] = []
    if scope in {"global", "all"}:
        data.extend(
            _prop_payload(prop, ctx=resolved.ctx, project_dir=project_dir)
            for prop in props
        )
    if scope in {"local", "all"}:
        data.extend(await _local_episode_prop_payloads(store=store, global_prop_names=global_names))
    return {
        "ok": True,
        "data": data,
    }


@router.post("/projects/{project}/props")
async def create_prop(
    project: str,
    body: PropCreate,
    user: dict = Depends(get_api_user),
):
    resolved = await resolve_project_scope(project, user, required_role="editor")
    store = (
        await make_sqlite_store_for_context(resolved.ctx)
        if resolved.ctx
        else await make_sqlite_store(resolved.username, resolved.project_name)
    )
    project_dir = resolved.project_dir
    name = body.name.strip()
    if not name:
        return {"ok": False, "error": "Prop name is required"}
    existing = await store.get_prop(name)
    if existing is not None:
        return {"ok": False, "error": f"Prop '{name}' already exists"}

    prop = NovelProp(
        name=name,
        aliases=body.aliases,
        prop_type=body.prop_type,
        visual_prompt=body.visual_prompt,
        description=body.description,
        owner=body.owner,
        notes=body.notes,
    )
    await store.add_prop(prop)
    return {
        "ok": True,
        "data": _prop_payload(prop, ctx=resolved.ctx, project_dir=project_dir),
    }


@router.patch("/projects/{project}/props/{name}")
async def update_prop(
    project: str,
    name: str,
    body: PropUpdate,
    user: dict = Depends(get_api_user),
):
    resolved = await resolve_project_scope(project, user, required_role="editor")
    store = (
        await make_sqlite_store_for_context(resolved.ctx)
        if resolved.ctx
        else await make_sqlite_store(resolved.username, resolved.project_name)
    )
    project_dir = resolved.project_dir
    prop = await _require_prop(store, name)
    if prop is None:
        return {"ok": False, "error": f"Prop '{name}' not found"}

    updates = body.model_dump(exclude_unset=True, exclude_none=True)
    requested_name = str(updates.pop("name", "") or "").strip()
    if requested_name and requested_name != prop.name:
        if await store.get_prop(requested_name) is not None:
            return {"ok": False, "error": f"Prop '{requested_name}' already exists"}
        try:
            _rename_prop_asset_dir(project_dir, prop.name, requested_name)
        except ValueError as exc:
            return {"ok": False, "error": str(exc)}
        renamed = await store.rename_prop(prop.name, requested_name)
        if not renamed:
            return {"ok": False, "error": f"Prop '{prop.name}' rename failed"}
        prop = await _require_prop(store, requested_name) or prop
    if updates:
        await store.update_prop(prop.name, **updates)
        prop = await _require_prop(store, prop.name) or prop

    return {
        "ok": True,
        "data": _prop_payload(prop, ctx=resolved.ctx, project_dir=project_dir),
    }


@router.post("/projects/{project}/props/{name}/delete")
async def delete_prop(
    project: str,
    name: str,
    user: dict = Depends(get_api_user),
):
    resolved = await resolve_project_scope(project, user, required_role="editor")
    store = (
        await make_sqlite_store_for_context(resolved.ctx)
        if resolved.ctx
        else await make_sqlite_store(resolved.username, resolved.project_name)
    )
    prop = await _require_prop(store, name)
    if prop is None:
        return {"ok": False, "error": f"Prop '{name}' not found"}
    deleted = await store.delete_prop(prop.name)
    return {"ok": True, "data": {"deleted": deleted}}


@router.post("/projects/{project}/props/{name}/reference/generate-async")
async def generate_prop_reference(
    project: str,
    name: str,
    body: PropReferenceGenerateRequest | None = None,
    user: dict = Depends(get_api_user),
):
    resolved = await resolve_project_scope(project, user, required_role="editor")
    ctx = resolved.ctx
    username = resolved.username
    project_name = resolved.project_name
    output_dir = resolved.output_dir
    store = (
        await make_sqlite_store_for_context(ctx)
        if ctx
        else await make_sqlite_store(username, project_name)
    )
    style = (body.style if body else "") or _project_style(username, project_name)
    model = str(body.model if body else "").strip()
    prop = await _require_prop(store, name)
    if prop is None:
        return {"ok": False, "error": f"Prop '{name}' not found"}
    if not (prop.visual_prompt or prop.description or prop.name):
        return {"ok": False, "error": f"Prop '{prop.name}' has no visual prompt"}

    scope = prop_reference_asset_scope(prop.name)
    if ctx is not None:
        queued = await get_task_backend().enqueue_project_task(
            ctx,
            task_type="prop_reference_asset",
            queue_kind="default",
            episode=0,
            scope=scope,
            payload={
                "prop_name": prop.name,
                "style": style,
                "model": model,
                "output_dir": output_dir,
            },
        )
        return {
            "ok": True,
            "task_type": "prop_reference_asset",
            "scope": scope,
            "task_id": queued.task_state.task_id,
            "task_key": project_task_state_key(
                "prop_reference_asset", ctx.project_id, 0, scope=scope
            ),
            "backend": queued.backend,
            "queue": queued.queue,
            "message": f"道具「{prop.name}」参考图生成任务已进入队列",
        }

    return {"ok": False, "error": "道具参考图生成需要 project context"}


@router.post("/projects/{project}/props/reference/batch-generate")
async def batch_generate_prop_references(
    project: str,
    body: PropReferenceGenerateRequest | None = None,
    user: dict = Depends(get_api_user),
):
    resolved = await resolve_project_scope(project, user, required_role="editor")
    ctx = resolved.ctx
    username = resolved.username
    project_name = resolved.project_name
    output_dir = resolved.output_dir
    style = (body.style if body else "") or _project_style(username, project_name)
    model = str(body.model if body else "").strip()

    if ctx is not None:
        queued = await get_task_backend().enqueue_project_task(
            ctx,
            task_type="batch_prop_ref",
            queue_kind="default",
            episode=0,
            payload={"style": style, "model": model, "output_dir": output_dir},
        )
        return {
            "ok": True,
            "task_type": "batch_prop_ref",
            "task_id": queued.task_state.task_id,
            "task_key": project_task_state_key("batch_prop_ref", ctx.project_id, 0),
            "backend": queued.backend,
            "queue": queued.queue,
            "message": "批量道具参考图生成任务已进入队列",
        }

    return {"ok": False, "error": "批量道具参考图生成需要 project context"}
