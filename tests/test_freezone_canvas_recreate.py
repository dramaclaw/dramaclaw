# SPDX-License-Identifier: Elastic-2.0
# Copyright (c) 2026 ClaymoreLab
"""A canvas created after a same-name canvas was deleted starts clean."""

import json
import time
from types import SimpleNamespace

from fastapi import HTTPException
import pytest

from canvas_core_requirements import CANVAS_CORE_BUNDLE, requires_canvas_core_bundle
from novelvideo.api import freezone_server_workflow_start
from novelvideo.api.routes import chat as chat_routes
from novelvideo.api.routes import freezone as routes
from novelvideo.api.schemas import CanvasConfirmationDecisionRequest, CanvasCreateRequest
from novelvideo.chat.store import ChatScope, ChatStore
from novelvideo.freezone import agent_canvas, canvas_confirmations, canvas_creation, canvas_store
from novelvideo.freezone.canvas_command_bridge import list_pending_bridge_messages
from novelvideo.freezone.canvas_core_pool import CanvasCorePool
from novelvideo.freezone.canvas_presence import canvas_browser_open, touch_canvas_presence
from novelvideo.project_context import ProjectContext

pytestmark = requires_canvas_core_bundle

USER = {"id": "u-alice", "username": "alice"}
NAME = "Ghost Plan"
OLD_ID = "canvas_ghost_plan_1cebeu5"
NEW_ID = f"{OLD_ID}_2"
BATCH = [
    {"type": "create_node", "client_id": "new-img", "node_type": "imageGenNode",
     "data": {"displayName": "批内新节点", "prompt": "cat"}},
    {"type": "run_node_action", "node_id": "new-img", "action": "generate_image"},
]
DELETED = {"code": "canvas_deleted", "message": "画布已删除或重建，确认已作废，未执行。"}


@pytest.fixture(scope="module")
def core():
    pool = CanvasCorePool(CANVAS_CORE_BUNDLE, size=2)
    try:
        yield pool
    finally:
        pool.close()


@pytest.fixture
def project(monkeypatch, tmp_path, core):
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

    async def scope_context(user, scope):
        return ctx

    async def no_models(_user_id):
        return {"models": []}

    monkeypatch.setenv("DRAMACLAW_AGENT_CANVAS_EXECUTOR", "browser")
    monkeypatch.setattr(routes, "_resolve_freezone_project", resolve)
    monkeypatch.setattr(routes, "_freezone_image_models_data", no_models)
    monkeypatch.setattr(routes, "_freezone_video_models_data", no_models)
    monkeypatch.setattr(chat_routes, "_project_context_for_scope", scope_context)
    for module in (canvas_creation, agent_canvas, freezone_server_workflow_start):
        monkeypatch.setattr(module, "get_canvas_core_pool", lambda: core)
    return SimpleNamespace(root=ctx.state_dir, chat=ChatStore())


async def _create(name=NAME, request_id="req-1"):
    response = await routes.create_canvas(
        "proj", CanvasCreateRequest(name=name, request_id=request_id), USER,
    )
    assert response["ok"] is True
    return response["data"]


def _save(root, canvas_id, nodes):
    current = canvas_store.read_canvas(root, canvas_id)
    revision = current["revision"]
    canvas_store.save_canvas(
        root, canvas_id, base_revision=revision,
        build_payload=lambda existing: {**existing, "revision": revision + 1, "nodes": nodes},
    )


def _node(node_id, title):
    return {"id": node_id, "type": "imageGenNode", "position": {"x": 0, "y": 0},
            "data": {"displayName": title, "prompt": "p"}}


def _seed(root, canvas_id):
    canvas_store.save_canvas(root, canvas_id, base_revision=None, build_payload=lambda _: {
        "schema_version": 2, "canvas_id": canvas_id, "project_id": "proj", "revision": 1,
        "nodes": [_node("n1", "旧海报")], "edges": [],
        "metadata": {"canvas_origin": "user_created", "display_name": canvas_id,
                     "creator_username": "alice"},
    })


def _scope(root, canvas_id):
    return ChatScope(kind="project", id="proj", surface="freezone", canvas_id=canvas_id,
                     agent_id="main", state_dir=str(root))


def _directory(root):
    return canvas_confirmations.confirmations_dir("alice", "main", root)


def _request(root, canvas_id, commands, turn_id="turn-old"):
    return canvas_confirmations.request_confirmation(
        username="alice", agent_id="main", project_id="proj", canvas_id=canvas_id,
        project_state_dir=root, turn_id=turn_id, commands=commands, now=time.time(),
    )


async def _decide(canvas_id, record):
    return await routes.decide_canvas_confirmation(
        "proj", canvas_id, record["id"],
        CanvasConfirmationDecisionRequest(
            decision="confirmed", via="card", turn_id=record["turn_id"],
            command_hash=record["command_hash"],
        ), USER,
    )


def _bridge(root, canvas_id):
    return list_pending_bridge_messages(
        project_id="proj", canvas_id=canvas_id, bridge_dir=_directory(root).parent,
    )


def _events(root, canvas_id):
    path = root / "freezone" / "_canvas_events" / f"{canvas_id}.jsonl"
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]


async def _old_canvas_with_state(project):
    """The V1 A-4 setup: a canvas with history, chat, events, open tab and pending cards."""
    created = await _create()
    assert created["canvas_id"] == OLD_ID
    _save(project.root, OLD_ID, [_node("n1", "旧海报")])
    _save(project.root, OLD_ID, [_node("n1", "旧海报"), _node("n2", "旧配图")])
    project.chat.append_message("alice", _scope(project.root, OLD_ID), "user", "旧画布上的对话")
    cards = {
        "existing": _request(project.root, OLD_ID, [{"type": "delete_nodes", "node_ids": ["n1"]}]),
        "batch": _request(project.root, OLD_ID, BATCH),
    }
    touch_canvas_presence(project.root, OLD_ID, "old-tab")
    assert len(canvas_store.list_canvas_history(project.root, OLD_ID)) == 2
    assert _events(project.root, OLD_ID)
    return cards


async def test_recreated_name_gets_a_canvas_without_the_deleted_canvas_state(project):
    cards = await _old_canvas_with_state(project)

    assert (await routes.delete_canvas("proj", OLD_ID, USER))["data"] == {"deleted": True}
    recreated = await _create(request_id="req-2")

    assert recreated["status"] == "created"
    assert recreated["canvas_id"] == NEW_ID
    new = canvas_store.read_canvas(project.root, NEW_ID)
    assert new["nodes"] == []
    assert new["metadata"]["display_name"] == NAME
    assert canvas_store.list_canvas_history(project.root, NEW_ID) == []
    assert (await routes.list_canvas_history("proj", NEW_ID, USER))["data"] == []
    assert project.chat.list_messages("alice", _scope(project.root, NEW_ID)) == []
    assert [event["event_type"] for event in _events(project.root, NEW_ID)] == ["canvas.saved"]
    listed = await routes.list_canvas_confirmations("proj", NEW_ID, ["main"], USER)
    assert listed["data"]["confirmations"] == []
    assert canvas_browser_open(project.root, NEW_ID) is False
    for record in cards.values():
        stored = canvas_confirmations.read_confirmation(_directory(project.root), record["id"])
        assert stored["status"] == "voided"
        assert stored["outcome"] == {"reason": "canvas_deleted"}


async def test_pre_delete_paid_batch_card_is_refused_after_recreate(project):
    cards = await _old_canvas_with_state(project)
    await routes.delete_canvas("proj", OLD_ID, USER)
    await _create(request_id="req-2")
    touch_canvas_presence(project.root, OLD_ID, "old-tab")
    touch_canvas_presence(project.root, NEW_ID, "new-tab")

    with pytest.raises(HTTPException) as exc:
        await _decide(OLD_ID, cards["batch"])

    assert exc.value.status_code == 409
    assert exc.value.detail == DELETED
    assert _bridge(project.root, OLD_ID) == []
    assert _bridge(project.root, NEW_ID) == []
    with pytest.raises(HTTPException) as moved:
        await _decide(NEW_ID, cards["batch"])
    assert moved.value.status_code == 404


async def test_card_from_before_a_direct_delete_is_refused_when_the_id_is_written_again(project):
    # Only the decision check runs here: the delete bypasses the route that voids cards.
    _seed(project.root, "canvas_again")
    card = _request(project.root, "canvas_again", BATCH)
    canvas_store.soft_delete_canvas(project.root, "canvas_again", deleted_by="alice")
    _seed(project.root, "canvas_again")
    touch_canvas_presence(project.root, "canvas_again", "tab")

    with pytest.raises(HTTPException) as exc:
        await _decide("canvas_again", card)

    assert exc.value.status_code == 409
    assert exc.value.detail == DELETED
    stored = canvas_confirmations.read_confirmation(_directory(project.root), card["id"])
    assert stored["status"] == "voided"
    assert stored["outcome"] == {"reason": "canvas_deleted"}
    assert _bridge(project.root, "canvas_again") == []


async def test_delete_voids_cards_recorded_without_a_deletion_count(project):
    # Only the delete-time voiding runs here: the card predates the deletion count.
    _seed(project.root, "canvas_gone")
    _seed(project.root, "canvas_kept")
    targets = [{"node_id": "new-img", "title": "批内新节点", "node_type": "imageGenNode",
                "action": "generate_image"}]

    def legacy(canvas_id):
        return canvas_confirmations.create_confirmation(
            _directory(project.root), project_id="proj", canvas_id=canvas_id, agent_id="main",
            username="alice", turn_id="turn-old", commands=BATCH, targets=targets,
            now=time.time(),
        )

    gone, kept = legacy("canvas_gone"), legacy("canvas_kept")
    await routes.delete_canvas("proj", "canvas_gone", USER)

    stored = canvas_confirmations.read_confirmation(_directory(project.root), gone["id"])
    assert stored["status"] == "voided"
    assert stored["outcome"] == {"reason": "canvas_deleted"}
    untouched = canvas_confirmations.read_confirmation(_directory(project.root), kept["id"])
    assert untouched["status"] == "pending"
    _seed(project.root, "canvas_gone")
    touch_canvas_presence(project.root, "canvas_gone", "tab")
    with pytest.raises(HTTPException) as exc:
        await _decide("canvas_gone", gone)
    assert exc.value.status_code == 409
    assert exc.value.detail == DELETED
    assert _bridge(project.root, "canvas_gone") == []


async def test_card_on_a_live_canvas_still_reaches_the_bridge(project):
    _seed(project.root, "canvas_live")
    card = _request(project.root, "canvas_live", BATCH)
    touch_canvas_presence(project.root, "canvas_live", "tab")

    response = await _decide("canvas_live", card)

    assert response["data"]["status"] == "submitted"
    assert len(_bridge(project.root, "canvas_live")) == 1


async def test_replay_and_duplicate_name_after_recreate(project):
    await _old_canvas_with_state(project)
    await routes.delete_canvas("proj", OLD_ID, USER)
    recreated = await _create(request_id="req-2")

    assert await _create(request_id="req-2") == {**recreated, "status": "exists"}
    duplicate = await _create(request_id="req-3")
    assert duplicate["rejection"] == {
        "code": "duplicate_name", "name": NAME, "existing_canvas_id": NEW_ID,
    }
    replay_of_deleted = await _create(request_id="req-1")
    assert replay_of_deleted["rejection"]["code"] == "duplicate_name"
    assert [canvas["id"] for canvas in canvas_store.list_canvases(project.root)] == [NEW_ID]


async def test_deleted_canvas_history_stays_restorable_under_its_old_id(project):
    await _old_canvas_with_state(project)
    await routes.delete_canvas("proj", OLD_ID, USER)
    await _create(request_id="req-2")

    history = (await routes.list_canvas_history("proj", OLD_ID, USER))["data"]
    assert len(history) == 2
    entry = max(history, key=lambda item: item["node_count"])
    restored = await routes.restore_canvas_history(
        "proj", OLD_ID, {"history_id": entry["history_id"], "base_revision": None}, USER,
    )

    assert restored["data"]["restored"] is True
    assert [node["id"] for node in canvas_store.read_canvas(project.root, OLD_ID)["nodes"]] == [
        "n1",
    ]
    assert canvas_store.read_canvas(project.root, NEW_ID)["nodes"] == []
