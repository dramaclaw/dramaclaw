"""Celery runners for single-episode scene and prop planning."""

from __future__ import annotations

import asyncio
from typing import Any

from novelvideo.project_context import ProjectContext
from novelvideo.ports import get_usage_meter
from novelvideo.task_backend.cancel import await_envelope_with_cancel_watch
from novelvideo.task_backend.registry import register_project_task_runner
from novelvideo.task_state import get_task_manager

_TASK_ASSET_KIND = {
    "episode_scene_planner": "scene",
    "episode_prop_planner": "prop",
}


def _dump_items(items: list[Any]) -> list[dict]:
    data: list[dict] = []
    for item in items or []:
        if hasattr(item, "model_dump"):
            data.append(item.model_dump())
        elif isinstance(item, dict):
            data.append(dict(item))
    return data


def run_episode_asset_planner(
    envelope: dict[str, Any],
    ctx: ProjectContext,
) -> dict[str, Any] | None:
    return asyncio.run(
        await_envelope_with_cancel_watch(
            _run_episode_asset_planner(envelope, ctx),
            envelope,
            task_type=str(envelope.get("task_type") or ""),
        )
    )


async def _run_episode_asset_planner(
    envelope: dict[str, Any],
    ctx: ProjectContext,
) -> dict[str, Any]:
    from novelvideo.agents.asset_compiler import AssetCompiler
    from novelvideo.cognee import CogneeStore
    from novelvideo.services.prop_promotion_service import promote_episode_props_to_global
    from novelvideo.sqlite_store import SQLiteStore

    task_type = str(envelope.get("task_type") or "")
    scope = envelope.get("scope")
    payload = envelope.get("payload") or {}
    billing_metadata = envelope.get("billing_metadata") or {}
    asset_kind = str(payload.get("asset_kind") or _TASK_ASSET_KIND.get(task_type, ""))
    expected_kind = _TASK_ASSET_KIND.get(task_type)
    if asset_kind not in {"scene", "prop"} or (expected_kind and asset_kind != expected_kind):
        raise ValueError(f"Unsupported episode asset planner kind: {asset_kind}")

    episode = int(envelope.get("episode") or payload.get("episode") or 0)
    if episode <= 0:
        raise ValueError("episode must be greater than 0")

    manager = get_task_manager()
    await get_usage_meter().set_project_llm_usage_context(
        username=ctx.owner_username,
        project_name=ctx.project_name,
        resource_kind="script",
        billing_metadata=billing_metadata if isinstance(billing_metadata, dict) else None,
    )

    label = "Scene" if asset_kind == "scene" else "Prop"

    def update(
        progress: float | None = None,
        task: str | None = None,
        log: str | None = None,
    ) -> None:
        manager.update_progress_for_project(
            ctx,
            task_type,
            episode,
            scope=scope,
            progress=progress,
            current_task=task,
            logs=[log] if log else None,
        )

    update(0.05, "Loading project data...")
    sqlite_store = SQLiteStore(
        ctx.owner_project_label,
        output_dir=str(ctx.output_dir),
        state_dir=str(ctx.state_dir),
    )
    await sqlite_store.initialize()
    await sqlite_store.load_graph_state()

    cognee_store = CogneeStore(
        ctx.owner_project_label,
        output_dir=str(ctx.output_dir),
        state_dir=str(ctx.state_dir),
        sqlite_store=sqlite_store,
    )
    await cognee_store.initialize()
    await cognee_store.load_graph_state()

    episode_obj = cognee_store.get_episode(episode)
    if episode_obj is None:
        raise ValueError(f"Episode {episode} not found")

    update(0.15, f"Planning {label} assets...")
    compiler = AssetCompiler(cognee_store)

    def on_log(message: str) -> None:
        update(log=message)

    if asset_kind == "scene":
        scene_menu, new_count = await compiler.compile_episode_scenes(
            episode_obj,
            on_log=on_log,
            on_progress=lambda progress, task: update(0.15 + progress * 0.75, task),
        )
        scene_menu_data = _dump_items(scene_menu)
        if not scene_menu_data:
            raise ValueError("No scenes were identified; generate the line-by-line narration draft first or add scene locations")
        update(0.95, "Scene planning complete", f"Scenes {new_count} new / {len(scene_menu_data)} total")
        return {
            "episode": episode,
            "kind": "scene",
            "new_count": new_count,
            "total_count": len(scene_menu_data),
            "scene_menu": scene_menu_data,
        }

    prop_menu = await compiler.compile_episode_props(
        episode_obj,
        on_log=on_log,
        on_progress=lambda progress, task: update(0.15 + progress * 0.75, task),
    )
    promoted_props = await promote_episode_props_to_global(cognee_store, prop_menu)
    prop_menu_data = _dump_items(prop_menu)
    update(0.95, "Prop planning complete", f"Props {len(prop_menu_data)} total")
    return {
        "episode": episode,
        "kind": "prop",
        "total_count": len(prop_menu_data),
        "auto_promoted_props": promoted_props,
        "prop_menu": prop_menu_data,
    }


register_project_task_runner("episode_scene_planner", run_episode_asset_planner)
register_project_task_runner("episode_prop_planner", run_episode_asset_planner)
