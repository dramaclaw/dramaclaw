# SPDX-License-Identifier: Elastic-2.0
# Copyright (c) 2026 ClaymoreLab
"""Plan confirmed canvas commands and start server-owned workflow runs."""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone
import logging
from pathlib import Path

from novelvideo.api.freezone_server_workflow_host import InProcessActionHost
from novelvideo.freezone import canvas_store
from novelvideo.freezone.canvas_core_pool import get_canvas_core_pool
from novelvideo.freezone.canvas_ui_locale import recorded_ui_locale
from novelvideo.freezone.server_workflow_actions import SERVER_WORKFLOW_ACTIONS
from novelvideo.freezone.server_workflow_index import (
    enqueue_server_workflow_drive,
    register_server_workflow_run,
)
from novelvideo.freezone.workflow_runs import (
    GENERATION_ACTIONS,
    create_workflow_run,
    mark_server_workflow_drive_enqueued,
)
from novelvideo.ports import get_usage_meter
from novelvideo.ports.local.usage import NoOpUsageMeter
from novelvideo.project_context import ProjectContext

logger = logging.getLogger(__name__)


def is_run_command(command: dict) -> bool:
    return command.get("type") == "run_workflow" or (
        command.get("type") == "run_node_action"
        and not command.get("action", "").startswith("open_")
    )


async def check_server_workflow(
    *, ctx: ProjectContext, state_dir: Path, canvas_id: str,
    commands: list[dict], locale: str | None = None,
) -> dict:
    run_commands = [command for command in commands if is_run_command(command)]
    if not run_commands:
        return {"status": "none"}
    other_commands = [command for command in commands if not is_run_command(command)]
    if other_commands:
        return {"status": "blocked", "plan": None, "blocked": [{
            "node_id": command.get("node_id"), "action": command["type"],
            "label": command["type"], "reason": "mixed_commands",
        } for command in other_commands]}

    from novelvideo.api.routes import freezone as routes

    canvas = await asyncio.to_thread(canvas_store.read_canvas, state_dir, canvas_id)
    locale = locale or await asyncio.to_thread(recorded_ui_locale, state_dir) or "zh"
    image, video = await asyncio.gather(
        routes._freezone_image_models_data(ctx.requester_user_id),
        routes._freezone_video_models_data(ctx.requester_user_id),
    )
    plan = await asyncio.to_thread(get_canvas_core_pool().call, "plan_workflow", {
        "canvas": canvas, "commands": run_commands,
        "env": {"locale": locale, "catalogs": {"image": image, "video": video},
                "selectedNodeIds": []},
    })
    if not plan["ok"]:
        return {"status": "invalid", "message": plan["message"]}
    metered = not isinstance(get_usage_meter(), NoOpUsageMeter)
    blocked = []
    for action in plan["actions"]:
        reason = None
        if metered:
            reason = "metered_runtime"
        elif action["action"] not in SERVER_WORKFLOW_ACTIONS:
            reason = "action_not_on_server"
        elif "parameters" in action:
            reason = "action_parameters"
        if reason:
            blocked.append({"node_id": action["node_id"], "action": action["action"],
                            "label": action["label"], "reason": reason})
    if blocked:
        return {"status": "blocked", "blocked": blocked, "plan": plan}
    return {"status": "runnable", "plan": plan}


def canvas_open_required_detail(check: dict) -> dict:
    labels = ", ".join(item["label"] or item["action"] for item in check["blocked"])
    return {"code": "canvas_open_required",
            "message": f"这些动作需要打开画布才能运行：{labels}", "blocked": check["blocked"]}


async def start_server_workflow_run(
    *, ctx: ProjectContext, state_dir: Path, canvas_id: str, plan: dict,
    confirmation: dict, actor_id: str, now: datetime | None = None,
) -> dict:
    current = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    requester = {"user_id": ctx.requester_user_id, "username": ctx.requester_username}
    run = await asyncio.to_thread(
        create_workflow_run, project_dir=state_dir, project_id=ctx.project_id,
        canvas_id=canvas_id,
        actions=[{"node_id": action["node_id"], "action": action["action"]}
                 for action in plan["actions"]],
        actor_id=actor_id, owner_kind="server",
        idempotency_key=f"canvas-confirmation:{confirmation['id']}",
        metadata={"levels": plan["levels"], "dependencies": plan["dependencies"],
                  "requester": requester,
                  "confirmation": {key: confirmation[key]
                                   for key in ("id", "agent_id", "username")}},
        now=current,
    )
    # Register first: a server run that the recovery index does not know would block the canvas.
    await asyncio.to_thread(
        register_server_workflow_run, project_id=ctx.project_id, state_dir=state_dir,
        canvas_id=canvas_id, run_id=run["run_id"], requester=requester,
    )
    host = InProcessActionHost(ctx=ctx, canvas_id=canvas_id, assert_lease=lambda: None)
    timestamp = current.isoformat(timespec="milliseconds").replace("+00:00", "Z")
    for action in plan["actions"]:
        if action["action"] in GENERATION_ACTIONS and action.get("invalidation_reason"):
            await host.patch_node(action["node_id"], {
                "workflowResultStale": True, "workflowInvalidatedAt": timestamp,
                "workflowInvalidationReason": action["invalidation_reason"],
            })
    generation = await asyncio.to_thread(
        mark_server_workflow_drive_enqueued, project_dir=state_dir, canvas_id=canvas_id,
        run_id=run["run_id"], now=current,
    )
    if generation is not None:
        try:
            await enqueue_server_workflow_drive(
                ctx, canvas_id=canvas_id, run_id=run["run_id"], generation=generation,
            )
        except Exception:
            logger.error("Server workflow enqueue deferred run_id=%s", run["run_id"])
    return run
