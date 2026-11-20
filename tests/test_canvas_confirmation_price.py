# SPDX-License-Identifier: Elastic-2.0
# Copyright (c) 2026 ClaymoreLab
"""Paid confirmation quotes use the same billing inputs as generation."""

from copy import deepcopy
import json
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from novelvideo.api.freezone_server_workflow_host import InProcessActionHost
from novelvideo.api.freezone_server_workflow_start import _server_run_actions
from novelvideo.api.routes import freezone as routes, model_credits
from novelvideo.freezone import canvas_store, workflow_runs
from novelvideo.freezone.agent_product_operations import (
    PRODUCT_TASK_TYPES,
    create_agent_product_operation,
)
from novelvideo.ports import registry
from novelvideo.ports.local.usage import NoOpUsageMeter
from novelvideo.shared.billing_errors import BillingRuleNotConfiguredError
from test_canvas_confirmation_routes import (
    BASE,
    DELETE,
    MIXED,
    PAID,
    TARGETS,
    create,
    decide,
    directory,
    edit_canvas,
    external_create,
    mixed_plan,
    notices,
    record,
    runs,
    setup as setup,
)

RECIPE_PRICE_KEY = "freezone.agent.recipe_result"
TEXT = {"type": "run_node_action", "node_id": "n3", "action": "generate_text"}
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
        self.rates = {
            RECIPE_PRICE_KEY: 11,
            "freezone.image_generate": 15,
            "freezone.video_generate": 24,
        }

    def cost(self, model, params, quantity):
        units = params["pricing_quantity"] if model == "freezone.video_generate" else 1
        return self.rates[model] * units * quantity

    async def generation_credit_quote(self, **kwargs):
        self.calls.append(deepcopy(kwargs))
        if self.fail:
            raise RuntimeError("billing rule is not configured")
        cost = self.cost(kwargs["model"], kwargs["params"], kwargs["quantity"])
        return SimpleNamespace(total_cost=cost, original_total_cost=None, discount_amount=0)


@pytest.fixture
def generation_core(setup, monkeypatch):
    calls = []

    def call_value(op, payload):
        calls.append((op, deepcopy(payload)))
        if op == "recipe_compile_request":
            pytest.fail("A confirmation quote must never build a recipe compile request")
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

    async def allow_model(*args, **kwargs):
        return None

    async def catalog_request(media_type, *args, **kwargs):
        if media_type == "video":
            return {}, {}, {"id": "video-model", "supportedModes": ["first_frame"]}
        return {}, {}, {"id": "image-model", "provider": "openai", "apiModel": "gpt-image-1"}

    async def video_backend(*args, **kwargs):
        return "seedance_2"

    async def reject_enqueue(*args, **kwargs):
        pytest.fail("A confirmation quote must never enqueue generation")

    async def reject_recipe_request(*args, **kwargs):
        pytest.fail("A confirmation quote must never execute a recipe request")

    def reject_product_operation(*args, **kwargs):
        pytest.fail("A confirmation quote must never create a product operation")

    monkeypatch.setattr(routes, "compile_freezone_recipe", reject_recipe_request)
    monkeypatch.setattr(routes, "generate_freezone_recipe_text", reject_recipe_request)
    monkeypatch.setattr(routes, "create_agent_product_operation", reject_product_operation)
    monkeypatch.setattr(routes, "get_task_backend", lambda: SimpleNamespace(
        enqueue_project_task=reject_enqueue,
    ))
    monkeypatch.setattr(routes, "_resolve_freezone_project", resolve)
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
    assert listed_confirmation(setup, data)["price"] == {"status": "not_metered"}
    assert stored["price"] == {"status": "not_metered"}


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


def bind_recipe(setup, command, *, node_type=None):
    def change(canvas):
        node = next(node for node in canvas["nodes"] if node["id"] == command["node_id"])
        node["data"]["workflowCatalog"] = {"recipeId": "test-recipe"}
        if node_type:
            node["type"] = node_type
        return canvas

    edit_canvas(setup, change)


@pytest.mark.parametrize(
    "command,endpoint,body,feature,quantity",
    [
        (TEXT, None, None, None, 1),
        (PAID[0], "gen", IMAGE_BODY, "freezone.image_generate", 2),
        (VIDEO, "video/keyframes", VIDEO_BODY, "freezone.video_generate", 1),
    ],
    ids=["text", "image", "video"],
)
async def test_template_confirmation_quotes_what_the_run_reserves(
    setup, monkeypatch, pricing, generation_core,
    command, endpoint, body, feature, quantity,
):
    if command == VIDEO:
        set_frame(setup, image_url=FRAME)
    bind_recipe(setup, command)
    metadata = {"recipe_id": "test-recipe", "execution_mode": "inline"} if command == TEXT else {}
    commands = set_plan(setup, command, **metadata)
    canvas = canvas_store.read_canvas(setup.root, "default")
    price = create(setup, commands=commands)["price"]
    assert canvas_store.read_canvas(setup.root, "default") == canvas
    assert setup.queued == []
    assert all(op != "recipe_compile_request" for op, _ in generation_core)

    reserved = []

    async def enqueue(ctx, *, task_type, product_surface, **kwargs):
        assert ctx is setup.ctx
        assert task_type == PRODUCT_TASK_TYPES["recipe_result"]
        assert product_surface == "freezone_assistant"
        reserved.append(pricing.cost(RECIPE_PRICE_KEY, {}, 1))
        return SimpleNamespace(task_state=SimpleNamespace(task_id="recipe-task"))

    with monkeypatch.context() as patch:
        patch.setattr(routes, "create_agent_product_operation", create_agent_product_operation)
        patch.setattr(routes, "get_task_backend", lambda: SimpleNamespace(
            enqueue_project_task=enqueue,
        ))
        actions = _server_run_actions(canvas, setup.pool.plan({"commands": commands}), "test")
        run = workflow_runs.create_workflow_run(
            project_dir=setup.root, project_id="proj", canvas_id="default",
            actions=actions, owner_kind="server",
        )
        admitted = await routes.admit_canvas_workflow_run_actions(
            ctx=setup.ctx, state_dir=setup.root, canvas_id="default", run=run,
        )
        assert admitted["actions"][0]["product_operation_id"]
    assert reserved == [11]

    if endpoint:
        async def charge_model(*, payload, **kwargs):
            billing = payload["billing"]
            model = billing.get("feature_key", "freezone.image_generate")
            count = payload.get("variant_count", 1)
            assert (model, count) == (feature, quantity)
            reserved.append(pricing.cost(model, billing, count))
            raise HTTPException(418, "Stopped before enqueue")

        with monkeypatch.context() as patch:
            patch.setattr(routes, "_enqueue_claimed_workflow_media", charge_model)
            response = setup.client.post(
                PATH + endpoint, json={**body, "prompt": "Compiled prompt"},
            )
            assert response.status_code == 418, response.text
        assert len(reserved) == 2

    total = sum(reserved)
    assert price == {
        "status": "known", "credits": total, "display": str(total), "items": [{
            "node_id": command["node_id"], "action": command["action"], "status": "known",
            "credits": total, "display": str(total),
        }],
    }
    expected_calls = [("feature", RECIPE_PRICE_KEY, 1)]
    if feature:
        expected_calls.append(("feature", feature, quantity))
    assert sorted(
        (call["kind"], call["model"], call["quantity"]) for call in pricing.calls
    ) == sorted(expected_calls)


def test_manual_confirmation_does_not_quote_template_fee(setup, pricing):
    price = create(setup, commands=PAID)["price"]
    assert price["status"] == "known"
    assert [call["model"] for call in pricing.calls] == ["freezone.image_generate"]


@pytest.mark.parametrize("reason", ["action_not_quoted", "quote_failed"])
def test_unquotable_action_still_creates_confirmation(setup, pricing, reason):
    command = PAID[0]
    metadata = {}
    if reason == "action_not_quoted":
        command = {**command, "action": "generate_audio"}
        metadata["recipe_id"] = "test-recipe"
        bind_recipe(setup, command, node_type="audioNode")
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


@pytest.mark.parametrize("feature", [RECIPE_PRICE_KEY, "freezone.image_generate"])
@pytest.mark.parametrize("chain", ["direct", "cause", "context"])
def test_unconfigured_template_or_model_price_reports_typed_reason(
    setup, monkeypatch, pricing, feature, chain,
):
    command = PAID[0]
    bind_recipe(setup, command)
    original_quote = pricing.generation_credit_quote
    rejected = []

    async def quote(**kwargs):
        if kwargs["model"] != feature:
            return await original_quote(**kwargs)
        rejected.append(feature)
        error = BillingRuleNotConfiguredError(kind="feature", key=feature)
        error.args = ("missing rule",)
        if chain == "direct":
            raise error
        if chain == "cause":
            raise RuntimeError("quote service error") from error
        try:
            raise error
        except BillingRuleNotConfiguredError:
            raise RuntimeError("quote service error")

    monkeypatch.setattr(pricing, "generation_credit_quote", quote)
    data = create(setup, commands=set_plan(setup, command))
    assert record(setup, data)["status"] == "pending"
    assert data["price"] == {
        "status": "unknown", "reason": "price_not_configured", "items": [{
            "node_id": "n1", "action": "generate_image", "status": "unknown",
            "reason": "price_not_configured",
        }],
    }
    assert rejected == [feature]


def test_request_and_command_data_cannot_supply_price(setup, pricing):
    baseline = create(setup, commands=PAID)
    forged = {"price": {"status": "known", "credits": 1}, "credits": 1, "price_text": "Free"}
    response = setup.client.post(BASE + "/confirmations", json={
        **forged, "turn_id": "t2", "commands": [
            {"type": "update_node_data", "node_id": "n1", "data": forged}, *PAID,
        ],
    })
    assert response.status_code == 200, response.text
    created = response.json()["data"]
    assert created["price"] == baseline["price"]
    assert baseline["price"]["credits"] == 30
    assert pricing.calls[0] == pricing.calls[1]
    listed = listed_confirmation(setup, created)
    assert listed["price"] == baseline["price"]
    assert "credits" not in listed
    assert "price_text" not in listed


def test_non_paid_confirmation_has_no_price(setup, pricing, generation_core):
    data = create(setup, commands=DELETE)
    assert "price" not in data
    assert pricing.calls == generation_core == []


def listed_confirmation(setup, created):
    response = setup.client.get(BASE + "/confirmations")
    assert response.status_code == 200, response.text
    return next(
        item for item in response.json()["data"]["confirmations"]
        if item["id"] == created["confirmation_id"]
    )


def test_lists_persisted_single_action_price(setup, pricing):
    data = create(setup, commands=set_plan(setup, PAID[0]))

    assert data["price"]["status"] == "known"
    assert data["price"]["credits"] == 30
    assert listed_confirmation(setup, data)["price"] == data["price"]
    assert record(setup, data)["price"] == data["price"]


def test_lists_total_and_items_for_two_paid_actions(setup, pricing):
    set_frame(setup, image_url=FRAME)
    data = create(setup, commands=set_plan(setup, PAID[0], VIDEO))

    assert data["price"]["status"] == "known"
    assert data["price"]["credits"] == 150
    price = listed_confirmation(setup, data)["price"]
    assert price["status"] == "known"
    assert price["credits"] == 150
    assert [(item["node_id"], item["action"], item["credits"]) for item in price["items"]] == [
        ("n1", "generate_image", 30),
        ("n2", "generate_video", 120),
    ]


def test_list_omits_price_for_non_paid_confirmation(setup, pricing):
    data = create(setup, commands=DELETE)

    assert "price" not in listed_confirmation(setup, data)


QUOTE_CHANGED_MESSAGE = (
    "确认卡片展示之后，节点内容或价格已发生变化，确认已作废，未执行；"
    "请重新发起确认以查看最新内容和价格。"
)


@pytest.fixture
def shown(setup, monkeypatch, pricing):
    """Make the request builder reflect the node, as the real one does."""
    build = setup.pool.call_value

    def call_value(op, payload):
        built = build(op, payload)
        data = next(n for n in payload["canvas"]["nodes"] if n["id"] == payload["node_id"])["data"]
        for request in built["request"].get("requests", []):
            request["body"].update({
                key: data[field] for key, field in (
                    ("prompt", "prompt"), ("variant_count", "variantCount"),
                ) if field in data
            })
        return built

    monkeypatch.setattr(setup.pool, "call_value", call_value)
    return pricing


def edit_node(setup, node_id, **data):
    def change(canvas):
        next(n for n in canvas["nodes"] if n["id"] == node_id)["data"].update(data)
        return canvas

    edit_canvas(setup, change)


def assert_voided_as_changed(setup, created, response, changed, message=QUOTE_CHANGED_MESSAGE):
    assert response.status_code == 409, response.text
    assert response.json()["detail"] == {
        "code": "quote_changed", "changed": changed, "message": message,
    }
    stored = record(setup, created)
    assert stored["status"] == "voided"
    assert stored["outcome"] == {"reason": "quote_changed"}
    assert runs(setup) == []
    assert setup.queued == []
    notice = notices(setup)[0]["content"]
    assert "Nothing was executed" in notice
    assert "Request the confirmation again" in notice


def test_confirm_voids_when_edited_node_now_costs_a_different_price(setup, shown):
    created = create(setup, commands=set_plan(setup, PAID[0]))
    assert created["price"]["credits"] == 30
    edit_node(setup, "n1", variantCount=3)

    response = decide(setup, created)

    assert_voided_as_changed(setup, created, response, ["content", "price"])


def test_confirm_voids_when_edited_node_sends_a_different_request_at_the_same_price(
    setup, shown,
):
    created = create(setup, commands=set_plan(setup, PAID[0]))
    edit_node(setup, "n1", prompt="A harbour at night")

    response = decide(setup, created)

    assert_voided_as_changed(setup, created, response, ["content"])


def test_confirm_voids_when_only_the_price_changed(setup, shown):
    created = create(setup, commands=set_plan(setup, PAID[0]))
    shown.rates["freezone.image_generate"] = 20

    response = decide(setup, created)

    assert_voided_as_changed(setup, created, response, ["price"])


def test_confirm_of_unchanged_canvas_starts_the_run(setup, shown):
    created = create(setup, commands=set_plan(setup, PAID[0]))
    quotes = len(shown.calls)

    response = decide(setup, created)

    assert response.status_code == 200, response.text
    assert response.json()["data"]["status"] == "running"
    assert len(runs(setup)) == 1
    assert record(setup, created)["price"] == created["price"]
    # The confirm-time check quotes once more through the same quote port.
    assert len(shown.calls) == quotes + 1


@pytest.mark.parametrize("recovers", [False, True], ids=["still-unknown", "now-known"])
def test_confirm_with_unknown_price_only_voids_when_a_price_appears(setup, shown, recovers):
    shown.fail = True
    created = create(setup, commands=set_plan(setup, PAID[0]))
    assert created["price"]["status"] == "unknown"
    shown.fail = not recovers

    response = decide(setup, created)

    if recovers:
        assert_voided_as_changed(setup, created, response, ["price"])
    else:
        assert response.status_code == 200, response.text
        assert len(runs(setup)) == 1


def test_confirmation_stored_without_a_digest_asks_for_a_fresh_one(setup, shown):
    created = create(setup, commands=set_plan(setup, PAID[0]))
    path = directory(setup) / f"{created['confirmation_id']}.json"
    stored = json.loads(path.read_text(encoding="utf-8"))
    assert stored.pop("quote_digest")
    path.write_text(json.dumps(stored), encoding="utf-8")

    response = decide(setup, created)

    assert_voided_as_changed(
        setup, created, response, ["unverified"],
        "这条确认没有保存展示时的内容和价格记录，无法核对是否已变化，确认已作废，未执行；"
        "请重新发起确认以查看最新内容和价格。",
    )


def test_non_paid_confirmation_is_not_requoted_at_confirm(setup, shown, generation_core):
    created = create(setup, commands=DELETE)

    response = decide(setup, created)

    assert response.status_code == 200, response.text
    assert response.json()["data"]["status"] == "executed"
    assert generation_core == []
    assert shown.calls == []
    assert "quote_digest" not in record(setup, created)


def test_quote_digest_is_not_listed(setup, shown):
    created = create(setup, commands=set_plan(setup, PAID[0]))

    assert "quote_digest" not in created
    assert "quote_digest" not in listed_confirmation(setup, created)


@pytest.mark.parametrize("flow", ["created-at-confirm", "written-before-confirmation"])
def test_confirm_of_unchanged_canvas_with_a_node_the_request_creates(setup, shown, flow):
    setup.pool.plan = mixed_plan()
    if flow == "created-at-confirm":
        created = create(setup, commands=MIXED)
        response = decide(setup, created)
    else:
        created = external_create(setup)
        response = decide(setup, created, via="conversation", turn_id=None)

    assert created["price"]["credits"] == 30
    assert response.status_code == 200, response.text
    assert len(runs(setup)) == 1
