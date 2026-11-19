# SPDX-License-Identifier: Elastic-2.0
# Copyright (c) 2026 ClaymoreLab
"""Paid confirmation quotes use the same billing inputs as generation."""

from copy import deepcopy
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from novelvideo.api.freezone_server_workflow_host import InProcessActionHost
from novelvideo.api.routes import freezone as routes, model_credits
from novelvideo.freezone import canvas_store
from novelvideo.ports import registry
from novelvideo.ports.local.usage import NoOpUsageMeter
from test_canvas_confirmation_routes import (
    BASE,
    DELETE,
    PAID,
    TARGETS,
    create,
    edit_canvas,
    record,
    setup as setup,
)

VIDEO = {"type": "run_node_action", "node_id": "n2", "action": "generate_video"}
FRAME = "/static/projects/proj/freezone/frame.png"
KEYFRAME_ERROR = "A source keyframe is required."
PATH = "/projects/proj/freezone/"
IMAGE_BODY = {
    "prompt": "A ship", "image_size": "2K", "variant_count": 2,
    "canvas_id": "default", "node_id": "n1",
}
VIDEO_BODY = {
    "prompt": "A ship", "first_frame_url": FRAME, "gen_mode": "firstFrame",
    "duration_seconds": 5, "resolution": "720p", "canvas_id": "default", "node_id": "n2",
}


def set_plan(setup, *commands, **metadata):
    def plan(payload):
        actions = [
            {
                "command_index": index, "node_id": command["node_id"],
                "action": command["action"], "label": command["node_id"],
                "execution_mode": "task", **metadata,
            }
            for index, command in enumerate(payload["commands"])
        ]
        return {
            "ok": True, "actions": actions, "levels": [[i] for i in range(len(actions))],
            "dependencies": (
                {actions[1]["node_id"]: [actions[0]["node_id"]]} if len(actions) == 2 else {}
            ),
            "already_completed": False,
        }

    setup.pool.plan = plan
    return list(commands)


def set_frame(setup, *, source_type="uploadNode", image_url="", uploading=False):
    def change(canvas):
        source, video, _ = canvas["nodes"]
        source["type"] = source_type
        source["data"] = {"label": "首帧", "imageUrl": image_url}
        if uploading:
            source["data"]["isUploading"] = True
        video["data"]["genMode"] = "firstFrame"
        return canvas

    edit_canvas(setup, change)


class Meter:
    def reserve_current_model_call_credit(self, *args, **kwargs):
        pytest.fail("A confirmation quote must never reserve credits")

    def clear_llm_usage_context(self):
        pass


class QuotePort:
    def __init__(self):
        self.calls = []
        self.fail = False

    async def generation_credit_quote(self, **kwargs):
        self.calls.append(deepcopy(kwargs))
        if self.fail:
            raise RuntimeError("quote service unavailable")
        cost = {"freezone.image_generate": 30, "freezone.video_generate": 120}[kwargs["model"]]
        return SimpleNamespace(total_cost=cost, original_total_cost=None, discount_amount=0)


@pytest.fixture
def generation_core(setup, monkeypatch):
    calls = []

    def call_value(op, payload):
        calls.append((op, deepcopy(payload)))
        assert op in {"image_generation_request", "video_generation_request"}
        if op == "image_generation_request":
            endpoint, body = "gen", IMAGE_BODY
        else:
            endpoint, body = "video/keyframes", VIDEO_BODY
        body = {**body, "node_id": payload["node_id"]}
        canvas = payload["canvas"]
        nodes = {node["id"]: node for node in canvas["nodes"]}
        sources = [nodes[e["source"]] for e in canvas["edges"] if e["target"] == body["node_id"]]
        if op == "video_generation_request" and not any(n["data"].get("imageUrl") for n in sources):
            request = {"ok": False, "code": "missing_media", "message": KEYFRAME_ERROR}
        else:
            request = {"ok": True, "requests": [{
                "path": PATH.lstrip("/") + endpoint, "method": "POST",
                "body": {
                    **body, "product_operation_id": "probe-must-strip-this",
                    "generation_attempt_id": "probe-must-strip-this-too",
                },
            }]}
        return {
            "compile_input": {"ok": True, "fallbackPrompt": body["prompt"]},
            "request": request, "trim_requirement": None,
        }

    monkeypatch.setattr(setup.pool, "call_value", call_value, raising=False)
    return calls


@pytest.fixture
def pricing(setup, monkeypatch, generation_core):
    quote = QuotePort()
    monkeypatch.setitem(registry._PORTS, "usage_meter", Meter())
    monkeypatch.setitem(registry._PORTS, "credit_quote", quote)
    confirmation_resolve = routes._resolve_freezone_project

    async def resolve(project, user, **kwargs):
        return await confirmation_resolve(project, user, require_home_node=False)

    async def admit(**kwargs):
        return None

    async def allow_model(*args, **kwargs):
        return None

    async def catalog_request(media_type, *args, **kwargs):
        if media_type == "video":
            return {}, {}, {"id": "video-model", "supportedModes": ["first_frame"]}
        return {}, {}, {"id": "image-model", "provider": "openai", "apiModel": "gpt-image-1"}

    async def video_backend(*args, **kwargs):
        return "seedance_2"

    async def reject_enqueue(**kwargs):
        pytest.fail("A confirmation quote must never enqueue generation")

    monkeypatch.setattr(routes, "_resolve_freezone_project", resolve)
    monkeypatch.setattr(routes, "admit_canvas_workflow_run_actions", admit)
    monkeypatch.setattr(routes, "_require_scoped_media_model", allow_model)
    monkeypatch.setattr(routes, "_resolve_catalog_request", catalog_request)
    monkeypatch.setattr(routes, "_resolve_catalog_video_backend", video_backend)
    monkeypatch.setattr(routes, "_enqueue_claimed_workflow_media", reject_enqueue)
    frame = setup.root / "frame.png"
    frame.touch()
    monkeypatch.setattr(routes, "_resolve_url_list", lambda _, urls: [str(frame) for _ in urls])
    return quote


def test_default_ports_add_not_metered_without_pricing(setup, monkeypatch, generation_core):
    monkeypatch.setenv("DRAMACLAW_AGENT_CANVAS_EXECUTOR", "browser")
    monkeypatch.setitem(registry._PORTS, "usage_meter", NoOpUsageMeter())
    quote = QuotePort()
    monkeypatch.setitem(registry._PORTS, "credit_quote", quote)

    async def reject_probe(*args, **kwargs):
        pytest.fail("Unmetered price must not probe a generation route")

    monkeypatch.setattr(InProcessActionHost, "request", reject_probe)
    monkeypatch.setattr(routes, "canvas_page_url", lambda *_: None)
    data = create(setup, commands=PAID)
    assert generation_core == []
    assert quote.calls == []
    stored = record(setup, data)
    expected = {
        "project_name": "demo", "confirmation_id": stored["id"], "kinds": ["paid_generation"],
        "targets": [{**TARGETS[0], "action": "generate_image"}],
        "expires_at": stored["expires_at"], "browser_open": False,
    }
    assert data == {**expected, "price": {"status": "not_metered"}}


@pytest.mark.parametrize(
    "command,endpoint,body,billing_helper,cost,quantity",
    [
        (PAID[0], "gen", IMAGE_BODY, "freezone_image_generate_billing_params", 30, 2),
        (VIDEO, "video/keyframes", VIDEO_BODY, "freezone_video_generate_task_billing", 120, 1),
    ],
    ids=["image", "first-frame-video"],
)
def test_single_action_quote_matches_generation_billing(
    setup, monkeypatch, pricing, command, endpoint, body, billing_helper, cost, quantity,
):
    if command == VIDEO:
        set_frame(setup, image_url=FRAME)
    commands = set_plan(setup, command)
    billed = []
    quoted = []
    original_billing = getattr(model_credits, billing_helper)
    original_quote_params = model_credits._default_billing_params

    def billing(params):
        billed.append(deepcopy(params))
        return original_billing(params)

    def quote_params(**kwargs):
        quoted.append(deepcopy(kwargs))
        return original_quote_params(**kwargs)

    async def stop_at_enqueue(**kwargs):
        raise HTTPException(418, "Stopped before enqueue")

    monkeypatch.setattr(model_credits, billing_helper, billing)
    monkeypatch.setattr(model_credits, "_default_billing_params", quote_params)
    with monkeypatch.context() as patch:
        patch.setattr(routes, "_enqueue_claimed_workflow_media", stop_at_enqueue)
        response = setup.client.post(PATH + endpoint, json=body)
        assert response.status_code == 418, response.text
    expected_params, = billed
    billed.clear()
    before = canvas_store.read_canvas(setup.root, "default")
    data = create(setup, commands=commands)
    assert canvas_store.read_canvas(setup.root, "default") == before
    expected_item = {
        "node_id": command["node_id"], "action": command["action"], "status": "known",
        "credits": cost, "display": str(cost),
    }
    assert data["price"] == {
        "status": "known", "credits": cost, "display": str(cost), "items": [expected_item],
    }
    assert billed == []
    quote, = quoted
    assert quote["explicit_params"] == expected_params
    assert (quote["kind"], quote["surface"], quote["value"], quote["quantity"]) == (
        "feature", "canvas", f'freezone.{command["action"].removeprefix("generate_")}_generate',
        quantity,
    )
    call, = pricing.calls
    assert call["user_id"] == "owner"
    assert call["quantity"] == quantity


def test_pending_video_input_preserves_known_image_price(setup, pricing):
    set_frame(setup, source_type="imageGenNode")
    data = create(setup, commands=set_plan(setup, PAID[0], VIDEO))
    assert data["price"] == {
        "status": "unknown", "reason": "input_pending", "known_credits": 30,
        "items": [
            {"node_id": "n1", "action": "generate_image", "status": "known",
             "credits": 30, "display": "30"},
            {"node_id": "n2", "action": "generate_video", "status": "unknown",
             "reason": "input_pending"},
        ],
    }
    assert len(pricing.calls) == 1


@pytest.mark.parametrize("reason", ["recipe_action", "action_not_quoted", "quote_failed"])
def test_unquotable_action_still_creates_confirmation(setup, pricing, reason):
    command = PAID[0]
    metadata = {}
    if reason == "recipe_action":
        metadata["recipe_id"] = "image-recipe"

        def bind_recipe(canvas):
            canvas["nodes"][0]["data"]["workflowCatalog"] = {"recipeId": "image-recipe"}
            return canvas

        edit_canvas(setup, bind_recipe)
    elif reason == "action_not_quoted":
        command = {**command, "action": "generate_audio"}

        def make_audio(canvas):
            canvas["nodes"][0]["type"] = "audioNode"
            return canvas

        edit_canvas(setup, make_audio)
    else:
        pricing.fail = True
    data = create(setup, commands=set_plan(setup, command, **metadata))
    assert record(setup, data)["status"] == "pending"
    assert data["price"] == {
        "status": "unknown", "reason": reason, "items": [{
            "node_id": "n1", "action": command["action"], "status": "unknown", "reason": reason,
        }],
    }
    assert len(pricing.calls) == (1 if pricing.fail else 0)


def test_request_and_command_data_cannot_supply_price(setup, pricing):
    baseline = create(setup, commands=PAID)
    forged = {"price": {"status": "known", "credits": 1}, "credits": 1, "price_text": "Free"}
    response = setup.client.post(BASE + "/confirmations", json={
        **forged, "turn_id": "t2", "commands": [
            {"type": "update_node_data", "node_id": "n1", "data": forged}, *PAID,
        ],
    })
    assert response.status_code == 200, response.text
    assert response.json()["data"]["price"] == baseline["price"]
    assert baseline["price"]["credits"] == 30
    assert pricing.calls[0] == pricing.calls[1]


def test_non_paid_confirmation_has_no_price(setup, pricing, generation_core):
    data = create(setup, commands=DELETE)
    assert "price" not in data
    assert pricing.calls == generation_core == []
