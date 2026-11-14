# SPDX-License-Identifier: Elastic-2.0
# Copyright (c) 2026 ClaymoreLab
"""Plan confirmed canvas commands and start server-owned workflow runs."""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone
import logging
from pathlib import Path
import re

from fastapi import HTTPException

from novelvideo.api.freezone_server_workflow_host import InProcessActionHost
from novelvideo.freezone import canvas_store
from novelvideo.freezone.agent_canvas import core_canvas_input
from novelvideo.freezone.canvas_core_pool import CanvasCoreError, get_canvas_core_pool
from novelvideo.freezone.canvas_ui_locale import recorded_ui_locale
from novelvideo.freezone.server_workflow_actions import (
    IMAGE_TOOL_SERVER_ACTIONS,
    server_action_refusal,
    server_action_supported,
)
from novelvideo.freezone.server_workflow_index import (
    enqueue_server_workflow_drive,
    register_server_workflow_run,
)
from novelvideo.freezone.workflow_runs import (
    GENERATION_ACTIONS,
    acknowledge_server_workflow_drive,
    create_workflow_run,
    mark_server_workflow_drive_enqueued,
    read_workflow_run,
    record_server_workflow_drive_enqueue_failed,
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


def _server_run_actions(canvas: dict, plan: dict, idempotency_key: str) -> list[dict]:
    nodes = {node["id"]: node for node in canvas.get("nodes", [])}
    actions = []
    # workflowInvalidation.ts includes HTML and Skill actions in generation identities.
    generation_actions = GENERATION_ACTIONS | IMAGE_TOOL_SERVER_ACTIONS | {
        "generate_html", "run_skill", "translate_text",
    }
    for planned in plan["actions"]:
        node_id, name = planned["node_id"], planned["action"]
        catalog = nodes.get(node_id, {}).get("data", {}).get("workflowCatalog")
        catalog = catalog if isinstance(catalog, dict) else {}
        action = {"node_id": node_id, "action": name}
        for source, target in (("recipeId", "recipe_id"), ("recipeVersion", "recipe_version")):
            value = str(catalog.get(source) or "").strip()
            if value:
                action[target] = value
        if name in generation_actions:
            action["generation_attempt_id"] = f"{idempotency_key}:{node_id}:{name}"
        actions.append(action)
    return actions


def created_node_mapping(receipt: dict, commands: list[dict]) -> dict[str, str]:
    mapping = {}
    for result in receipt.get("command_results", []):
        if not result.get("createdNodeId"):
            continue
        if result.get("type") == "create_node":
            client_id = result.get("nodeId")
        elif result.get("type") == "add_next_node":
            client_id = commands[result["commandIndex"]].get("client_id")
        else:
            continue
        if client_id:
            mapping[client_id] = result["createdNodeId"]
    return mapping


def _rewrite_command_indices(message: str, indices: list[int]) -> str:
    def replace(match: re.Match) -> str:
        index = int(match[1])
        if index >= len(indices):
            return match[0]
        return f"envelopes[0].commands[{indices[index]}]"

    return re.sub(r"envelopes\[0\]\.commands\[(\d+)\]", replace, message)


def rewrite_run_commands(commands: list[dict], mapping: dict[str, str]) -> list[dict]:
    rewritten = []
    for command in commands:
        item = dict(command)
        if "node_ids" in item:
            item["node_ids"] = [mapping.get(node_id, node_id) for node_id in item["node_ids"]]
        if "node_id" in item:
            item["node_id"] = mapping.get(item["node_id"], item["node_id"])
        rewritten.append(item)
    return rewritten


async def check_server_workflow(
    *, ctx: ProjectContext, state_dir: Path, canvas_id: str,
    commands: list[dict], locale: str | None = None,
) -> dict:
    run_commands = [command for command in commands if is_run_command(command)]
    if not run_commands:
        return {"status": "none"}
    other_commands = [command for command in commands if not is_run_command(command)]
    run_indices = [index for index, command in enumerate(commands) if is_run_command(command)]
    other_indices = [index for index, command in enumerate(commands) if not is_run_command(command)]
    browser_commands = [command for command in other_commands if (
        command["type"] in {"html_artifact", "open_mainline_projection"}
        or (command["type"] == "run_node_action"
            and command.get("action", "").startswith("open_"))
    )]
    if browser_commands:
        return {"status": "blocked", "plan": None, "blocked": [{
            "node_id": command.get("node_id") or command.get("client_id"),
            "action": command["type"],
            "label": command["type"], "reason": "mixed_commands",
        } for command in browser_commands]}

    from novelvideo.api.routes import freezone as routes

    canvas = await asyncio.to_thread(canvas_store.read_canvas, state_dir, canvas_id) or {
        "nodes": [], "edges": []
    }
    locale = locale or await asyncio.to_thread(recorded_ui_locale, state_dir) or "zh"
    image, video = await asyncio.gather(
        routes._freezone_image_models_data(ctx.requester_user_id),
        routes._freezone_video_models_data(ctx.requester_user_id),
    )
    client_ids = {}
    if other_commands:
        preview = await asyncio.to_thread(get_canvas_core_pool().call, "apply_commands", {
            "canvas": core_canvas_input(canvas),
            "envelopes": [{
                "schema_version": "canvas_chat_commands.v1", "project_id": ctx.project_id,
                "canvas_id": canvas_id, "commands": other_commands,
            }],
            "env": {"locale": locale, "catalogs": {"image": image, "video": video}},
        })
        if preview["status"] != "applied":
            raise CanvasCoreError("invalid_request", _rewrite_command_indices(
                "; ".join(preview["receipt"]["errors"]), other_indices,
            ))
        mapping = created_node_mapping(preview["receipt"], other_commands)
        client_ids = {node_id: client_id for client_id, node_id in mapping.items()}
        run_commands = rewrite_run_commands(run_commands, mapping)
        canvas = preview["canvas"]
    try:
        plan = await asyncio.to_thread(get_canvas_core_pool().call, "plan_workflow", {
            "canvas": canvas, "commands": run_commands,
            "env": {"locale": locale, "catalogs": {"image": image, "video": video},
                    "selectedNodeIds": []},
        })
    except CanvasCoreError as exc:
        raise CanvasCoreError(exc.code, _rewrite_command_indices(str(exc), run_indices)) from exc
    if not plan["ok"]:
        return {"status": "invalid",
                "message": _rewrite_command_indices(plan["message"], run_indices)}
    metered = not isinstance(get_usage_meter(), NoOpUsageMeter)
    refused = []
    run_actions = _server_run_actions(canvas, plan, "canvas-confirmation:preflight")
    nodes = {node["id"]: node for node in canvas.get("nodes", [])}
    for action, run_action in zip(plan["actions"], run_actions):
        reason = None
        if action.get("auto_commit") is True:
            reason = "mainline_auto_commit"
        elif not server_action_supported(
            action["action"], nodes.get(action["node_id"], {}).get("type"),
        ):
            reason = "action_not_on_server"
        else:
            reason = server_action_refusal(
                action["action"], nodes.get(action["node_id"], {}), canvas.get("edges", []),
            )
        if reason is None and metered:
            try:
                await routes.admit_canvas_workflow_run_actions(
                    ctx=ctx, state_dir=state_dir, canvas_id=canvas_id, actions=[run_action],
                )
            except HTTPException:
                reason = "recipe_required"
        if reason:
            refused.append({"node_id": client_ids.get(action["node_id"], action["node_id"]),
                            "action": action["action"],
                            "label": action["label"], "reason": reason})
    if plan["actions"] and len(refused) == len(plan["actions"]):
        return {"status": "blocked", "blocked": refused, "plan": plan}
    return {"status": "runnable", "plan": plan, "refused": refused}


def canvas_open_required_detail(check: dict) -> dict:
    labels = ", ".join(item["label"] or item["action"] for item in check["blocked"])
    return {"code": "canvas_open_required",
            "message": f"这些动作需要打开画布才能运行：{labels}", "blocked": check["blocked"]}  # i18n-exempt


async def start_server_workflow_run(
    *, ctx: ProjectContext, state_dir: Path, canvas_id: str, plan: dict,
    confirmation: dict, actor_id: str, now: datetime | None = None,
    refused: list[dict] | None = None,
) -> dict:
    from novelvideo.api.routes import freezone as routes

    current = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    idempotency_key = f"canvas-confirmation:{confirmation['id']}"
    canvas = await asyncio.to_thread(canvas_store.read_canvas, state_dir, canvas_id)
    actions = _server_run_actions(canvas, plan, idempotency_key)
    refusals = {(item["node_id"], item["action"]): item for item in refused or []}
    runnable_actions = [item for item in actions
                        if (item["node_id"], item["action"]) not in refusals]
    manifest = []
    for planned in plan["actions"]:
        entry = {key: planned[key] for key in (
            "command_index", "node_id", "action", "label", "execution_mode",
        )}
        if "parameters" in planned:
            entry["parameters"] = planned["parameters"]
        refusal = refusals.get((planned["node_id"], planned["action"]))
        if refusal:
            entry["refusal"] = {"code": "canvas_open_required", "reason": refusal["reason"]}
        manifest.append(entry)
    metered = not isinstance(get_usage_meter(), NoOpUsageMeter)
    if metered:
        await routes.admit_canvas_workflow_run_actions(
            ctx=ctx, state_dir=state_dir, canvas_id=canvas_id, actions=runnable_actions,
        )
    requester = {"user_id": ctx.requester_user_id, "username": ctx.requester_username}
    run = await asyncio.to_thread(
        create_workflow_run, project_dir=state_dir, project_id=ctx.project_id,
        canvas_id=canvas_id,
        actions=actions,
        actor_id=actor_id, owner_kind="server",
        idempotency_key=idempotency_key,
        metadata={"levels": plan["levels"], "dependencies": plan["dependencies"],
                  "action_manifest": manifest,
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
    if metered:
        await routes.admit_canvas_workflow_run_actions(
            ctx=ctx, state_dir=state_dir, canvas_id=canvas_id,
            run={**run, "actions": [item for item in run["actions"]
                                   if (item["node_id"], item["action"]) not in refusals]},
        )
        run = await asyncio.to_thread(
            read_workflow_run, project_dir=state_dir, canvas_id=canvas_id, run_id=run["run_id"],
        )
    host = InProcessActionHost(ctx=ctx, canvas_id=canvas_id, assert_lease=lambda: None)
    timestamp = current.isoformat(timespec="milliseconds").replace("+00:00", "Z")
    for action in plan["actions"]:
        if (
            (action["node_id"], action["action"]) not in refusals
            and action["action"] in GENERATION_ACTIONS and action.get("invalidation_reason")
        ):
            await host.patch_node(action["node_id"], {
                "workflowResultStale": True, "workflowInvalidatedAt": timestamp,
                "workflowInvalidationReason": action["invalidation_reason"],
            })
    attempt = await asyncio.to_thread(
        mark_server_workflow_drive_enqueued, project_dir=state_dir, canvas_id=canvas_id,
        run_id=run["run_id"], now=current,
    )
    if attempt is not None:
        try:
            await enqueue_server_workflow_drive(
                ctx, canvas_id=canvas_id, run_id=run["run_id"], attempt=attempt,
            )
        except Exception as exc:
            try:
                await asyncio.to_thread(
                    record_server_workflow_drive_enqueue_failed, project_dir=state_dir,
                    canvas_id=canvas_id, run_id=run["run_id"], attempt=attempt,
                    error_kind=type(exc).__name__,
                )
            except Exception:
                logger.warning("Server workflow enqueue failure recording deferred run_id=%s",
                               run["run_id"])
            logger.error("Server workflow enqueue deferred run_id=%s", run["run_id"])
        else:
            try:
                await asyncio.to_thread(
                    acknowledge_server_workflow_drive, project_dir=state_dir,
                    canvas_id=canvas_id, run_id=run["run_id"], attempt=attempt,
                )
            except Exception:
                logger.warning("Server workflow drive acknowledgement deferred run_id=%s",
                               run["run_id"])
    logger.info("Server workflow run started run_id=%s actions=%d refused=%d",
                run["run_id"], len(actions), len(refusals))
    return run
