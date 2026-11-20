# SPDX-License-Identifier: Elastic-2.0
# Copyright (c) 2026 ClaymoreLab
"""Inspect planned canvas generation and quote it without submitting tasks."""

import asyncio
import hashlib
import json
import logging
from pathlib import Path
from urllib.parse import quote

from fastapi import HTTPException

from novelvideo.api.freezone_server_workflow_host import InProcessActionHost
from novelvideo.freezone import canvas_core_pool
from novelvideo.freezone.agent_product_operations import agent_product_price_key
from novelvideo.freezone.canvas_confirmations import node_title
from novelvideo.freezone.generation_inputs import (
    MISSING_INPUT_CODES,
    empty_generation_inputs,
    upstream_ids,
)
from novelvideo.ports import get_usage_meter
from novelvideo.ports.local.usage import NoOpUsageMeter
from novelvideo.project_context import ProjectContext
from novelvideo.shared.billing_errors import find_billing_rule_not_configured_error

logger = logging.getLogger(__name__)

# Minted per submission, so they are neither billed nor part of what the user was shown.
_REQUEST_IDENTITY_KEYS = frozenset({"product_operation_id", "generation_attempt_id"})

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

    path = request["path"]
    prefix = f"projects/{quote(host.ctx.project_id, safe='')}/freezone/"
    if not path.startswith(prefix) or path[len(prefix):] not in _GENERATION_ROUTES[action]:
        raise ValueError("Request has no generation billing probe")
    body = {
        key: value for key, value in request["body"].items()
        if key not in _REQUEST_IDENTITY_KEYS
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
    return await _quote_feature(host, feature_key, params, quantity)


async def _quote_feature(
    host: InProcessActionHost, feature_key: str, params: dict, quantity: int,
) -> dict:
    from novelvideo.api.routes.model_credits import quote_generation_credit_cost

    data = (await quote_generation_credit_cost(
        kind="feature", surface="canvas", value=feature_key, params=params, quantity=quantity,
        user_id=host.ctx.requester_user_id,
    ))["data"]
    return {"status": "known", "credits": data["cost"], "display": data["display"]}


async def _price_action(
    host: InProcessActionHost, canvas: dict, node: dict, action: dict,
    input_pending: bool, built: dict | None, with_price: bool,
) -> tuple[dict, dict]:
    """Price one planned action; also return what it would run, for the confirmation digest."""
    from novelvideo.api.freezone_server_workflow_start import workflow_action_recipe_binding
    from novelvideo.api.routes.freezone import (
        WORKFLOW_RECIPE_ONLY_ACTIONS,
        workflow_action_recipe_admission,
    )
    from novelvideo.api.routes.model_credits import _display_credit_cost

    name = action["action"]
    binding = workflow_action_recipe_binding(node)
    admits_recipe = workflow_action_recipe_admission({"action": name, **binding})
    shown = {"recipe": binding if admits_recipe else None, "request": None}
    parts = []
    try:
        if not (admits_recipe and name in WORKFLOW_RECIPE_ONLY_ACTIONS):
            if not _quotable_action(name, node):
                return {"status": "unknown", "reason": "action_not_quoted"}, shown
            if built is None:
                built = await _build_request(host, canvas, action)
            shown["request"] = built
            if not with_price:
                return {}, shown
            request = built["request"]
            if (
                request["ok"] and len(request["requests"]) == 1
                and built.get("trim_requirement") is None
                and (built.get("compile_input") or {}).get("ok") is not False
            ):
                parts.append(await _quote_request(host, name, request["requests"][0]))
            else:
                reason = (
                    "input_pending"
                    if input_pending and request.get("code") in MISSING_INPUT_CODES
                    else "request_unavailable"
                )
                return {"status": "unknown", "reason": reason}, shown
        if admits_recipe and with_price:
            feature_key = agent_product_price_key("recipe_result")
            parts.append(await _quote_feature(host, feature_key, {}, 1))
    except Exception as exc:
        logger.warning("Confirmation price unavailable: %s", type(exc).__name__)
        reason = (
            "price_not_configured"
            if find_billing_rule_not_configured_error(exc) is not None
            else "quote_failed"
        )
        return {"status": "unknown", "reason": reason}, shown
    if not with_price:
        return {}, shown
    if len(parts) == 1:
        return parts[0], shown
    total = sum(part["credits"] for part in parts)
    return {"status": "known", "credits": total, "display": _display_credit_cost(total)}, shown


def _digest(value: object) -> str:
    text = json.dumps(value, sort_keys=True, ensure_ascii=False, default=str)
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _without_request_identity(value: object) -> object:
    if isinstance(value, dict):
        return {
            key: _without_request_identity(item) for key, item in value.items()
            if key not in _REQUEST_IDENTITY_KEYS
        }
    if isinstance(value, list):
        return [_without_request_identity(item) for item in value]
    return value


def _content_digest(shown: list[dict] | None, client_ids: dict[str, str]) -> str:
    text = json.dumps(
        _without_request_identity(shown), sort_keys=True, ensure_ascii=False, default=str,
    )
    # A node the confirmation will create has a new preview id on every plan.
    for preview_id, client_id in client_ids.items():
        text = text.replace(json.dumps(preview_id), json.dumps(client_id))
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _price_digest(price: dict) -> str:
    # Why a price is unknown is not part of what was agreed; only the amounts are.
    return _digest({
        "status": price["status"], "credits": price.get("credits"),
        "known_credits": price.get("known_credits"),
        "items": sorted(
            json.dumps([item["action"], item["status"], item.get("credits")])
            for item in price.get("items", [])
        ),
    })


async def _quote_plan(
    *, ctx: ProjectContext, state_dir: Path, canvas_id: str, planning: dict,
    requests: dict[int, dict], reused_commands: list[dict] | None, with_price: bool = True,
) -> tuple[dict, str]:
    """Return the price of the planned actions and a digest of what they would run."""
    from novelvideo.api.freezone_server_workflow_start import _plan_run_commands
    from novelvideo.api.routes.model_credits import _display_credit_cost

    if reused_commands is not None:
        try:
            planning = await _plan_run_commands(
                ctx=ctx, state_dir=state_dir, canvas_id=canvas_id, commands=reused_commands,
            )
        except Exception as exc:
            logger.warning("Confirmation price plan unavailable: %s", type(exc).__name__)
    actions = (planning.get("plan") or {}).get("actions")
    if actions is None:
        price = {"status": "unknown", "reason": "plan_unavailable", "items": []}
        return price, _content_digest(None, {})
    canvas = planning["canvas"]
    client_ids = planning["client_ids"]
    nodes = {node["id"]: node for node in canvas.get("nodes", [])}
    host = InProcessActionHost(ctx=ctx, canvas_id=canvas_id, assert_lease=lambda: None)
    items = []
    shown = []
    earlier = set()
    for index, action in enumerate(actions):
        node_id = action["node_id"]
        price, runs = await _price_action(
            host, canvas, nodes.get(node_id, {}), action,
            bool(earlier.intersection(upstream_ids(canvas, node_id))), requests.get(index),
            with_price,
        )
        items.append({
            "node_id": client_ids.get(node_id, node_id), "action": action["action"], **price,
        })
        shown.append({
            "node_id": node_id, "action": action["action"],
            "execution_mode": action.get("execution_mode"),
            "parameters": action.get("parameters"), **runs,
        })
        earlier.add(node_id)
    content = _content_digest(shown, client_ids)
    if not with_price:
        return {}, content

    known = [item for item in items if item["status"] == "known"]
    first_unknown = next((item for item in items if item["status"] == "unknown"), None)
    total = sum(item["credits"] for item in known)
    if first_unknown is not None:
        return {
            "status": "unknown", "reason": first_unknown["reason"], "items": items,
            **({"known_credits": total} if known else {}),
        }, content
    display = known[0]["display"] if len(known) == 1 else _display_credit_cost(total)
    return {"status": "known", "credits": total, "display": display, "items": items}, content


async def confirmation_price(
    *, ctx: ProjectContext, state_dir: Path, canvas_id: str, planning: dict,
    requests: dict[int, dict], reused_commands: list[dict] | None = None,
) -> dict:
    if isinstance(get_usage_meter(), NoOpUsageMeter):
        return {"status": "not_metered"}
    return (await _quote_plan(
        ctx=ctx, state_dir=state_dir, canvas_id=canvas_id, planning=planning,
        requests=requests, reused_commands=reused_commands,
    ))[0]


async def confirmation_quote_digest(
    *, ctx: ProjectContext, state_dir: Path, canvas_id: str, commands: list[dict], price: dict,
) -> dict | None:
    """Digest what a paid confirmation card showed: the planned requests and the price.

    The planned requests are derived from the stored commands, exactly as at confirm time.
    """
    if isinstance(get_usage_meter(), NoOpUsageMeter):
        return None
    _, content = await _quote_plan(
        ctx=ctx, state_dir=state_dir, canvas_id=canvas_id, planning={}, requests={},
        reused_commands=commands, with_price=False,
    )
    return {"content": content, "price": _price_digest(price)}


async def confirmation_quote_changes(
    *, ctx: ProjectContext, state_dir: Path, canvas_id: str, record: dict,
) -> list[str]:
    """Name what differs between the card a user confirmed and the canvas now.

    Re-derives the plan and the quote from the current canvas through the code that created
    them. ``unverified`` means the card has no usable digest to compare against.
    """
    if isinstance(get_usage_meter(), NoOpUsageMeter):
        return []
    stored = record.get("quote_digest")
    if not (
        isinstance(stored, dict)
        and isinstance(stored.get("content"), str) and isinstance(stored.get("price"), str)
    ):
        return ["unverified"]
    try:
        price, content = await _quote_plan(
            ctx=ctx, state_dir=state_dir, canvas_id=canvas_id, planning={}, requests={},
            reused_commands=record["commands"],
        )
    except Exception as exc:
        logger.warning("Confirmation quote check unavailable: %s", type(exc).__name__)
        return ["unverified"]
    return [
        name for name, current in (("content", content), ("price", _price_digest(price)))
        if current != stored[name]
    ]
