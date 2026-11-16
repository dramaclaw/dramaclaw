# SPDX-License-Identifier: Elastic-2.0
# Copyright (c) 2026 ClaymoreLab
"""Paid confirmation cards: refuse actions a node cannot run and list only used settings.

With the browser executor (the default) a card is refused only when a node saved in the
canvas file does not offer the action; every other request keeps its previous outcome.
"""

import logging
from types import SimpleNamespace

from fastapi import HTTPException
import pytest

from canvas_core_requirements import CANVAS_CORE_BUNDLE, requires_canvas_core_bundle
from novelvideo.api import freezone_server_workflow_start
from novelvideo.api.routes import freezone as routes
from novelvideo.api.schemas import CanvasConfirmationRequest
from novelvideo.freezone import agent_canvas, canvas_confirmations, canvas_store
from novelvideo.freezone.canvas_core_pool import CanvasCoreError, CanvasCorePool
from novelvideo.freezone.canvas_presence import touch_canvas_presence
from novelvideo.project_context import ProjectContext

pytestmark = requires_canvas_core_bundle

CANVAS = "board"
USER = {"id": "u-alice", "username": "alice"}
# The marker the auth port writes for external agent keys; the value is an obvious fake.
EXTERNAL = {**USER, "credential_kind": "agent_session",
            "external_agent_key_id": "fake-key-id-not-a-secret"}
IMAGE_MODEL = {"id": "image-model", "apiModel": "image-model", "providerId": "openai"}
VIDEO_MODEL = {"id": "video-model", "apiModel": "video-model", "providerId": "openai"}
TEXT = {"displayName": "开场白", "content": "欢迎来到红杯小店。",
        "model": "newapi_gpt_image2", "extraParams": {}}
IMAGE = {"displayName": "海报", "prompt": "A red cup", "model": "image-model",
         "aspectRatio": "1:1", "size": "1K", "quality": "standard", "count": 1}
VIDEO = {"displayName": "片头", "prompt": "A red cup turns", "model": "video-model",
         "aspectRatio": "16:9", "durationSec": 5, "generateAudio": False}
UNAVAILABLE = "envelopes[0].commands[0]: action not available on node: generate_image"
CHECK_LOGGER = "novelvideo.api.freezone_server_workflow_start"


def _run(node_id, action):
    return {"type": "run_node_action", "node_id": node_id, "action": action}


@pytest.fixture(scope="module")
def core():
    pool = CanvasCorePool(CANVAS_CORE_BUNDLE, size=2)
    try:
        yield pool
    finally:
        pool.close()


@pytest.fixture
def guard(monkeypatch, tmp_path, core):
    ctx = ProjectContext(
        project_id="proj", project_name="demo", owner_type="user", owner_id="u-alice",
        owner_username="alice", requester_user_id="u-alice", requester_username="alice",
        requester_principals=(("user", "u-alice"),), effective_role="editor",
        home_node_id="node-a", output_dir=tmp_path / "output", state_dir=tmp_path / "state",
        runtime_dir=tmp_path / "runtime", is_home_node=True,
    )

    async def resolve(project, user, **kwargs):
        assert project == "proj"
        return ctx, user["username"], "demo", tmp_path / "output", str(tmp_path / "output")

    async def image_models(_user_id):
        return {"models": [IMAGE_MODEL]}

    async def video_models(_user_id):
        return {"models": [VIDEO_MODEL]}

    monkeypatch.setattr(routes, "_resolve_freezone_project", resolve)
    monkeypatch.setattr(routes, "_freezone_image_models_data", image_models)
    monkeypatch.setattr(routes, "_freezone_video_models_data", video_models)
    for module in (agent_canvas, freezone_server_workflow_start):
        monkeypatch.setattr(module, "get_canvas_core_pool", lambda: core)
    canvas_store.save_canvas(ctx.state_dir, CANVAS, base_revision=None, build_payload=lambda _: {
        "schema_version": 2, "canvas_id": CANVAS, "project_id": "proj", "revision": 1,
        "nodes": [
            {"id": "t1", "type": "textAnnotationNode", "position": {"x": 0, "y": 0},
             "data": dict(TEXT)},
            {"id": "i1", "type": "imageGenNode", "position": {"x": 300, "y": 0},
             "data": dict(IMAGE)},
            {"id": "v1", "type": "videoNode", "position": {"x": 600, "y": 0},
             "data": dict(VIDEO)},
        ],
        "edges": [],
    })
    return SimpleNamespace(root=ctx.state_dir, monkeypatch=monkeypatch)


def _executor(guard, executor):
    guard.monkeypatch.setenv("DRAMACLAW_AGENT_CANVAS_EXECUTOR", executor)
    # Server mode needs an open canvas for actions that only the browser runs.
    touch_canvas_presence(guard.root, CANVAS, "tab-1")


async def _confirm(commands, user=USER, turn_id="turn-1"):
    response = await routes.create_canvas_confirmation(
        "proj", CANVAS,
        CanvasConfirmationRequest(commands=commands, turn_id=turn_id, agent_id="main"), user,
    )
    assert response["ok"] is True
    return response["data"]


def _records(guard):
    directory = canvas_confirmations.confirmations_dir("alice", "main", guard.root)
    return sorted(path.name for path in directory.glob("cc_*.json"))


def _check_warnings(caplog):
    return [record for record in caplog.records
            if record.name == CHECK_LOGGER and record.levelno == logging.WARNING]


async def _outcome(commands):
    try:
        data = await _confirm(commands)
    except HTTPException as exc:
        return exc.status_code, exc.detail
    return 200, {"kinds": data["kinds"], "targets": data["targets"]}


def _invalid(message):
    return 422, {"code": "invalid_agent_canvas_request", "message": message}


def _card(node_id, title, node_type):
    return 200, {"kinds": ["paid_generation"], "targets": [
        {"node_id": node_id, "title": title, "node_type": node_type, "action": "generate_image"},
    ]}


@pytest.mark.parametrize("executor", ["browser", "server"])
@pytest.mark.parametrize("commands,message", [
    ([_run("t1", "generate_image")], UNAVAILABLE),
    ([
        {"type": "update_node_data", "node_id": "i1", "data": {"displayName": "新海报"}},
        _run("t1", "generate_image"),
    ], "envelopes[0].commands[1]: action not available on node: generate_image"),
], ids=["saved-text-node", "saved-text-node-after-structural-command"])
async def test_action_missing_from_saved_node_catalog_creates_no_card(
    guard, executor, commands, message,
):
    _executor(guard, executor)

    with pytest.raises(HTTPException) as exc:
        await _confirm(commands)

    assert exc.value.status_code == 422
    assert exc.value.detail == {"code": "invalid_agent_canvas_request", "message": message}
    assert _records(guard) == []


BATCH_TEXT_NODE = [
    {"type": "create_node", "client_id": "draft", "node_type": "textAnnotationNode",
     "data": {"content": "新文字"}},
    _run("draft", "generate_image"),
]
# Outcomes measured on the commit before the check was added; the server column is unchanged.
EARLIER_OUTCOMES = {
    "target-not-in-server-file": (
        [_run("ghost", "generate_image")],
        (409, {"code": "targets_missing", "message": "Canvas nodes missing: ghost"}),
        _invalid("envelopes[0].commands[0]: node not found: ghost"),
    ),
    "batch-created-text-node": (
        BATCH_TEXT_NODE,
        (200, {"kinds": ["paid_generation"], "targets": [
            {"action": "generate_image", "node_id": "draft",
             "node_type": "textAnnotationNode", "title": ""},
        ]}),
        _invalid("envelopes[0].commands[1]: action not available on node: generate_image"),
    ),
    "invalid-structural-command-type": (
        [{"type": "update_node", "node_id": "ghost", "data": {"displayName": "x"}},
         _run("i1", "generate_image")],
        _invalid("Unknown canvas command type: update_node"),
        _invalid("commands[0] (update_node) is not a valid canvas command"),
    ),
    "structural-command-on-missing-node": (
        [{"type": "update_node_data", "node_id": "ghost", "data": {"displayName": "x"}},
         _run("i1", "generate_image")],
        _card("i1", "海报", "imageGenNode"),
        _invalid("画布命令预校验失败，前端未展示确认卡，也未执行。; "
                 "envelopes[0].commands[0]: node not found: ghost"),
    ),
    "edge-from-missing-node": (
        [{"type": "create_edge", "source": "ghost", "target": "i1"},
         _run("i1", "generate_image")],
        _card("i1", "海报", "imageGenNode"),
        _invalid("commands[0] (create_edge) is not a valid canvas command"),
    ),
}


@pytest.mark.parametrize("case", list(EARLIER_OUTCOMES))
async def test_browser_executor_keeps_earlier_outcome_unless_a_saved_node_lacks_the_action(
    guard, caplog, case,
):
    commands, expected, _server = EARLIER_OUTCOMES[case]
    _executor(guard, "browser")
    caplog.set_level(logging.WARNING, logger=CHECK_LOGGER)

    assert await _outcome(commands) == expected

    assert len(_records(guard)) == (1 if expected[0] == 200 else 0)
    assert len(_check_warnings(caplog)) == 1


@pytest.mark.parametrize("case", list(EARLIER_OUTCOMES))
async def test_server_executor_outcome_is_unchanged(guard, case):
    commands, _browser, expected = EARLIER_OUTCOMES[case]
    _executor(guard, "server")

    assert await _outcome(commands) == expected
    assert _records(guard) == []


async def test_browser_executor_creates_the_card_when_the_model_catalog_fails(guard, caplog):
    _executor(guard, "browser")
    caplog.set_level(logging.WARNING, logger=CHECK_LOGGER)

    async def unavailable(_user_id):
        raise RuntimeError("model catalog unavailable")

    guard.monkeypatch.setattr(routes, "_freezone_image_models_data", unavailable)
    guard.monkeypatch.setattr(routes, "_freezone_video_models_data", unavailable)

    assert await _outcome([_run("i1", "generate_image")]) == _card("i1", "海报", "imageGenNode")
    assert len(_records(guard)) == 1
    assert len(_check_warnings(caplog)) == 1


class _PlanFails:
    """The real core, except that workflow planning raises the given error."""

    def __init__(self, core, error):
        self.core, self.error = core, error

    def call(self, op, payload):
        if op == "plan_workflow":
            raise self.error
        return self.core.call(op, payload)

    def call_value(self, op, payload):
        return self.core.call_value(op, payload)


def _unavailable(command_index=0, node_id="t1"):
    return {"unavailable_actions": [
        {"command_index": command_index, "node_id": node_id, "action": "generate_image"},
    ]}


@pytest.mark.parametrize("error", [
    lambda: CanvasCoreError("invalid_request", UNAVAILABLE),
    lambda: CanvasCoreError("invalid_request", UNAVAILABLE, details={}),
    lambda: CanvasCoreError("invalid_request", UNAVAILABLE, details=_unavailable(command_index=3)),
    lambda: CanvasCoreError("invalid_request", UNAVAILABLE,
                            details=_unavailable(command_index="0")),
    lambda: CanvasCoreError("invalid_request", UNAVAILABLE, details=_unavailable(node_id="i1")),
    lambda: CanvasCoreError("invalid_request", UNAVAILABLE,
                            details={"unavailable_actions": "generate_image"}),
    lambda: CanvasCoreError("canvas_core_busy", "Canvas core is busy"),
    lambda: RuntimeError("unexpected failure"),
], ids=["message-only", "empty-details", "index-out-of-range", "index-not-int",
        "different-node", "malformed-list", "core-busy", "unexpected-exception"])
async def test_browser_executor_refuses_only_on_structured_unavailable_action(
    guard, caplog, core, error,
):
    _executor(guard, "browser")
    caplog.set_level(logging.WARNING, logger=CHECK_LOGGER)
    guard.monkeypatch.setattr(freezone_server_workflow_start, "get_canvas_core_pool",
                              lambda: _PlanFails(core, error()))

    assert await _outcome([_run("t1", "generate_image")]) == _card(
        "t1", "开场白", "textAnnotationNode",
    )
    assert len(_records(guard)) == 1
    assert len(_check_warnings(caplog)) == 1


async def test_browser_executor_refusal_carries_the_core_message(guard, core):
    _executor(guard, "browser")
    error = CanvasCoreError("invalid_request", "core message", details=_unavailable())
    guard.monkeypatch.setattr(freezone_server_workflow_start, "get_canvas_core_pool",
                              lambda: _PlanFails(core, error))

    assert await _outcome([_run("t1", "generate_image")]) == _invalid("core message")
    assert _records(guard) == []


@pytest.mark.parametrize("executor", ["browser", "server"])
async def test_available_image_action_still_creates_the_same_card(guard, caplog, executor):
    _executor(guard, executor)
    caplog.set_level(logging.WARNING, logger=CHECK_LOGGER)

    data = await _confirm([_run("i1", "generate_image")])

    assert set(data) == {"confirmation_id", "kinds", "targets", "expires_at", "browser_open"}
    assert data["kinds"] == ["paid_generation"]
    assert data["targets"] == [{"node_id": "i1", "title": "海报", "node_type": "imageGenNode",
                                "action": "generate_image"}]
    assert _records(guard) == [f"{data['confirmation_id']}.json"]
    assert _check_warnings(caplog) == []


@pytest.mark.parametrize("executor", ["browser", "server"])
async def test_external_translate_lists_only_settings_the_action_uses(guard, executor):
    _executor(guard, executor)

    data = await _confirm(
        [_run("t1", "translate_text"), _run("i1", "generate_image"), _run("v1", "generate_video")],
        user=EXTERNAL, turn_id=None,
    )

    assert data["generation_settings"] == [
        {"node_id": "t1", "title": "开场白", "node_type": "textAnnotationNode",
         "action": "translate_text", "sources": {}},
        {"node_id": "i1", "title": "海报", "node_type": "imageGenNode",
         "action": "generate_image", "model": "image-model", "aspect_ratio": "1:1",
         "resolution": "1K", "quality": "standard", "count": 1,
         "sources": {key: "canvas" for key in (
             "model", "aspect_ratio", "resolution", "quality", "count",
         )}},
        {"node_id": "v1", "title": "片头", "node_type": "videoNode",
         "action": "generate_video", "model": "video-model", "aspect_ratio": "16:9",
         "duration_seconds": 5, "generate_audio": False,
         "sources": {key: "canvas" for key in (
             "model", "aspect_ratio", "duration_seconds", "generate_audio",
         )}},
    ]
    # The stored text node keeps its default model field; only the listing changes.
    stored = canvas_store.read_canvas(guard.root, CANVAS)
    assert stored["nodes"][0]["data"]["model"] == "newapi_gpt_image2"
