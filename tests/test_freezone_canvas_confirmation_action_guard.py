# SPDX-License-Identifier: Elastic-2.0
# Copyright (c) 2026 ClaymoreLab
"""Paid confirmation cards: refuse actions a node cannot run and list only used settings."""

from types import SimpleNamespace

from fastapi import HTTPException
import pytest

from canvas_core_requirements import CANVAS_CORE_BUNDLE, requires_canvas_core_bundle
from novelvideo.api import freezone_server_workflow_start
from novelvideo.api.routes import freezone as routes
from novelvideo.api.schemas import CanvasConfirmationRequest
from novelvideo.freezone import agent_canvas, canvas_confirmations, canvas_store
from novelvideo.freezone.canvas_core_pool import CanvasCorePool
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


@pytest.mark.parametrize("executor", ["browser", "server"])
@pytest.mark.parametrize("commands,message", [
    ([_run("t1", "generate_image")], UNAVAILABLE),
    ([
        {"type": "create_node", "client_id": "draft", "node_type": "textAnnotationNode",
         "data": {"content": "新文字"}},
        _run("draft", "generate_image"),
    ], "envelopes[0].commands[1]: action not available on node: generate_image"),
], ids=["existing-text-node", "batch-created-text-node"])
async def test_action_missing_from_node_catalog_creates_no_card(
    guard, executor, commands, message,
):
    _executor(guard, executor)

    with pytest.raises(HTTPException) as exc:
        await _confirm(commands)

    assert exc.value.status_code == 422
    assert exc.value.detail == {"code": "invalid_agent_canvas_request", "message": message}
    assert _records(guard) == []


@pytest.mark.parametrize("executor", ["browser", "server"])
async def test_available_image_action_still_creates_the_same_card(guard, executor):
    _executor(guard, executor)

    data = await _confirm([_run("i1", "generate_image")])

    assert set(data) == {"confirmation_id", "kinds", "targets", "expires_at", "browser_open"}
    assert data["kinds"] == ["paid_generation"]
    assert data["targets"] == [{"node_id": "i1", "title": "海报", "node_type": "imageGenNode",
                                "action": "generate_image"}]
    assert _records(guard) == [f"{data['confirmation_id']}.json"]


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
