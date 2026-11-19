# SPDX-License-Identifier: Elastic-2.0
# Copyright (c) 2026 ClaymoreLab
"""Inspect planned canvas generation and quote it without submitting tasks."""

import asyncio
import logging
from pathlib import Path
from urllib.parse import quote

from fastapi import HTTPException

from novelvideo.api.freezone_server_workflow_host import InProcessActionHost
from novelvideo.freezone import canvas_core_pool
from novelvideo.freezone.canvas_confirmations import node_title
from novelvideo.freezone.generation_inputs import (
    MISSING_INPUT_CODES,
    empty_generation_inputs,
    upstream_ids,
)
from novelvideo.ports import get_usage_meter
from novelvideo.ports.local.usage import NoOpUsageMeter
from novelvideo.project_context import ProjectContext

logger = logging.getLogger(__name__)

_GENERATION_ROUTES = {
    "generate_image": {"gen"},
    "generate_video": {
        "video/gen", "video/i2v", "video/keyframes", "video/omni-gen",
        "video/video-edit", "video/video-extend",
    },
}


def _quotable_action(action: str, node: dict) -> bool:
    return action in _GENERATION_ROUTES and not (
        action == "generate_video" and (node.get("data") or {}).get("isUpscaleNode") is True
    )


async def _build_request(host: InProcessActionHost, canvas: dict, action: dict) -> dict:
    video = action["action"] == "generate_video"
    catalogs = await host.catalogs(video=video)
    env = {
        "locale": host.locale, "project": host.ctx.project_id, "canvasId": host.canvas_id,
        "catalogs": catalogs, "executionSource": "workflow",
    }
    if video:
        env["camera_templates"] = catalogs.get("camera_templates")
    op = "video_generation_request" if video else "image_generation_request"
    call = canvas_core_pool.get_canvas_core_pool().call_value
    payload = {"canvas": canvas, "node_id": action["node_id"], "env": env}
    built = await asyncio.to_thread(call, op, payload)
    request = built["request"]
    fallback = (built.get("compile_input") or {}).get("fallbackPrompt")
    if request.get("code") == "no_effective_prompt":
        # The prompt guard reads the graph even when the request has a prompt override.
        payload["canvas"] = {
            **canvas,
            "nodes": [
                {**node, "data": {**node["data"], "prompt": "."}}
                if node["id"] == action["node_id"] else node
                for node in canvas["nodes"]
            ],
        }
    elif not request["ok"] or fallback:
        # The worker already uses the compile fallback if the override is absent.
        return built
    env["prompt"] = fallback or "."
    return await asyncio.to_thread(call, op, payload)


async def check_generation_inputs(
    ctx: ProjectContext, canvas_id: str, planning: dict, refused_actions: list[dict],
) -> dict[int, dict]:
    canvas = planning.get("canvas")
    if canvas is None:
        return {}
    nodes = {node["id"]: node for node in canvas.get("nodes", [])}
    client_ids = planning["client_ids"]
    refused = {(item["node_id"], item["action"]) for item in refused_actions}
    earlier = set()
    not_ready = []
    requests = {}
    host = InProcessActionHost(ctx=ctx, canvas_id=canvas_id, assert_lease=lambda: None)
    for index, action in enumerate(planning["plan"]["actions"]):
        node_id, name = action["node_id"], action["action"]
        client_id = client_ids.get(node_id, node_id)
        if (client_id, name) in refused:
            continue
        node = nodes.get(node_id, {})
        input_pending = bool(earlier.intersection(upstream_ids(canvas, node_id)))
        earlier.add(node_id)
        if not _quotable_action(name, node):
            continue
        try:
            built = await _build_request(host, canvas, action)
        except Exception as exc:
            logger.warning("Confirmation input check unavailable: %s", type(exc).__name__)
            continue
        requests[index] = built
        request = built["request"]
        if request["ok"] or request.get("code") not in MISSING_INPUT_CODES or input_pending:
            continue
        inputs = empty_generation_inputs(canvas, node_id)
        for item in inputs:
            item["node_id"] = client_ids.get(item["node_id"], item["node_id"])
        not_ready.append({
            "node_id": client_id, "title": node_title(node.get("data") or {}) or client_id,
            "node_type": node.get("type"), "action": name,
            "code": request["code"], "message": request["message"], "inputs": inputs,
        })
    if not_ready:
        details = " ".join(
            f'Node "{item["title"]}" could not run. {item["message"]}' for item in not_ready
        )
        raise HTTPException(409, {
            "code": "generation_input_not_ready",
            "message": f"Generation inputs are missing. {details}",
            "not_ready": not_ready,
        })
    return requests


async def _quote_request(host: InProcessActionHost, action: str, request: dict) -> dict:
    from novelvideo.api.routes import freezone as routes
    from novelvideo.api.routes.model_credits import quote_generation_credit_cost

    path = request["path"]
    prefix = f"projects/{quote(host.ctx.project_id, safe='')}/freezone/"
    if not path.startswith(prefix) or path[len(prefix):] not in _GENERATION_ROUTES[action]:
        raise ValueError("Request has no generation billing probe")
    body = {
        key: value for key, value in request["body"].items()
        if key not in {"product_operation_id", "generation_attempt_id"}
    }
    token = routes._generation_billing_probe.set(True)
    try:
        await host.request("POST", path, body)
    except routes._GenerationBillingProbe as probe:
        feature_key, params, quantity = probe.feature_key, probe.params, probe.quantity
    else:
        raise ValueError("Generation billing was unavailable")
    finally:
        routes._generation_billing_probe.reset(token)
    data = (await quote_generation_credit_cost(
        kind="feature", surface="canvas", value=feature_key, params=params, quantity=quantity,
        user_id=host.ctx.requester_user_id,
    ))["data"]
    return {"status": "known", "credits": data["cost"], "display": data["display"]}


async def _price_action(
    host: InProcessActionHost, canvas: dict, node: dict, action: dict,
    input_pending: bool, built: dict | None,
) -> dict:
    name = action["action"]
    binding = (node.get("data") or {}).get("workflowCatalog")
    recipe_id = action.get("recipe_id") or (
        binding.get("recipeId") if isinstance(binding, dict) else None
    )
    if str(recipe_id or "").strip():
        reason = "recipe_action"
    elif not _quotable_action(name, node):
        reason = "action_not_quoted"
    else:
        try:
            if built is None:
                built = await _build_request(host, canvas, action)
            request = built["request"]
            if (
                request["ok"] and len(request["requests"]) == 1
                and built.get("trim_requirement") is None
                and (built.get("compile_input") or {}).get("ok") is not False
            ):
                return await _quote_request(host, name, request["requests"][0])
            reason = (
                "input_pending"
                if input_pending and request.get("code") in MISSING_INPUT_CODES
                else "request_unavailable"
            )
        except Exception as exc:
            logger.warning("Confirmation price unavailable: %s", type(exc).__name__)
            reason = "quote_failed"
    return {"status": "unknown", "reason": reason}


async def confirmation_price(
    *, ctx: ProjectContext, state_dir: Path, canvas_id: str, planning: dict,
    requests: dict[int, dict], reused_commands: list[dict] | None = None,
) -> dict:
    from novelvideo.api.freezone_server_workflow_start import _plan_run_commands
    from novelvideo.api.routes.model_credits import _display_credit_cost

    if isinstance(get_usage_meter(), NoOpUsageMeter):
        return {"status": "not_metered"}
    if reused_commands is not None:
        try:
            planning = await _plan_run_commands(
                ctx=ctx, state_dir=state_dir, canvas_id=canvas_id, commands=reused_commands,
            )
        except Exception as exc:
            logger.warning("Confirmation price plan unavailable: %s", type(exc).__name__)
    actions = (planning.get("plan") or {}).get("actions")
    if actions is None:
        return {"status": "unknown", "reason": "plan_unavailable", "items": []}
    canvas = planning["canvas"]
    client_ids = planning["client_ids"]
    nodes = {node["id"]: node for node in canvas.get("nodes", [])}
    host = InProcessActionHost(ctx=ctx, canvas_id=canvas_id, assert_lease=lambda: None)
    items = []
    earlier = set()
    for index, action in enumerate(actions):
        node_id = action["node_id"]
        price = await _price_action(
            host, canvas, nodes.get(node_id, {}), action,
            bool(earlier.intersection(upstream_ids(canvas, node_id))), requests.get(index),
        )
        items.append({
            "node_id": client_ids.get(node_id, node_id), "action": action["action"], **price,
        })
        earlier.add(node_id)

    known = [item for item in items if item["status"] == "known"]
    first_unknown = next((item for item in items if item["status"] == "unknown"), None)
    total = sum(item["credits"] for item in known)
    if first_unknown is not None:
        return {
            "status": "unknown", "reason": first_unknown["reason"], "items": items,
            **({"known_credits": total} if known else {}),
        }
    display = known[0]["display"] if len(known) == 1 else _display_credit_cost(total)
    return {"status": "known", "credits": total, "display": display, "items": items}
