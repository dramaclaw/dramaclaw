"""Celery runner for episode identity planning."""

from __future__ import annotations

import asyncio
from typing import Any

from novelvideo.project_context import ProjectContext
from novelvideo.task_backend.cancel import await_envelope_with_cancel_watch
from novelvideo.task_backend.registry import register_project_task_runner
from novelvideo.task_state import get_task_manager


def _build_identity_planner_result(
    *,
    episode: int,
    new_count: int,
    resolved_count: int,
    identities: list[dict[str, str]],
    auto_promoted_characters: list[str],
) -> dict[str, Any]:
    return {
        "episode": episode,
        "new_count": new_count,
        "resolved_count": resolved_count,
        "identities": identities,
        "auto_promoted_characters": auto_promoted_characters,
    }


def run_identity_planner(envelope: dict[str, Any], ctx: ProjectContext) -> dict[str, Any] | None:
    return asyncio.run(
        await_envelope_with_cancel_watch(
            _run_identity_planner(envelope, ctx),
            envelope,
            task_type="identity_planner",
        )
    )


async def _run_identity_planner(envelope: dict[str, Any], ctx: ProjectContext) -> dict[str, Any]:
    from novelvideo.agents.identity_planner import IdentityPlanner
    from novelvideo.cognee import CogneeStore
    from novelvideo.sqlite_store import SQLiteStore

    episode = int(envelope.get("episode") or (envelope.get("payload") or {}).get("episode") or 0)
    manager = get_task_manager()

    def update(
        progress: float | None = None, task: str | None = None, log: str | None = None
    ) -> None:
        manager.update_progress_for_project(
            ctx,
            "identity_planner",
            episode,
            progress=progress,
            current_task=task,
            logs=[log] if log else None,
        )

    update(0.05, "加载项目数据...")
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

    update(0.10, "分析身份需求...")
    planner = IdentityPlanner(cognee_store)

    def on_log(message: str) -> None:
        update(log=message)

    new_count, resolved_count = await planner.plan_single_episode(episode_obj, on_log=on_log)
    refreshed = cognee_store.get_episode(episode) or episode_obj

    identities: list[dict[str, str]] = []
    episode_identity_ids = set(getattr(refreshed, "identity_ids", []) or [])
    for character in cognee_store.get_all_characters():
        for identity in getattr(character, "identities", []) or []:
            identity_id = getattr(identity, "identity_id", "") or ""
            if not identity_id or identity_id not in episode_identity_ids:
                continue
            identities.append(
                {
                    "character_name": character.name,
                    "identity_id": identity_id,
                    "identity_name": getattr(identity, "identity_name", "") or identity_id,
                    "appearance_details": getattr(identity, "appearance_details", "") or "",
                }
            )

    update(0.95, "身份规划完成", f"新增 {new_count} 个身份，复用 {resolved_count} 个身份")
    return _build_identity_planner_result(
        episode=episode,
        new_count=new_count,
        resolved_count=resolved_count,
        identities=identities,
        auto_promoted_characters=list(getattr(planner, "auto_promoted_characters", []) or []),
    )


register_project_task_runner("identity_planner", run_identity_planner)
