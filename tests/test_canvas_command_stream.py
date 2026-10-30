"""SSE transport and session delivery regression tests."""

import asyncio
import json
import time

import pytest
from fastapi import HTTPException

from novelvideo.api.routes import chat
from novelvideo.chat.store import ChatScope
from novelvideo.freezone import canvas_command_bridge as bridge
from novelvideo.freezone.canvas_command_watch import BridgeWatchHub


@pytest.fixture
def scoped_bridge(monkeypatch, tmp_path):
    async def state(user, payload):
        assert user["username"] == "viewer"
        assert payload.project_id == "project"
        return tmp_path

    monkeypatch.setattr(chat, "_bridge_project_state_dir", state)
    monkeypatch.setattr(chat, "_candidate_canvas_bridge_dirs_for_scope", lambda *_: [tmp_path])
    return tmp_path


def publish(directory, key, external):
    bridge.put_pending_canvas_command(
        key=key,
        project_id="project",
        canvas_id="canvas",
        commands=[],
        envelope={"external_mcp_command": external, "canvas_id": "canvas"},
        bridge_dir=directory,
    )


async def test_sse_only_claims_external_frames_and_releases_subscription(scoped_bridge):
    directory = scoped_bridge
    publish(directory, "session", False)
    publish(directory, "external", True)
    response = await chat.stream_canvas_commands("project", "canvas", user={"username": "viewer"})
    assert response.headers["x-accel-buffering"] == "no"
    assert response.headers["cache-control"] == "no-cache"
    iterator = response.body_iterator
    try:
        event = await asyncio.wait_for(anext(iterator), 2)
        assert event["id"] == "external"
        frame = json.loads(event["data"])
        assert frame["type"] == "canvas.command"
        assert frame["bridge_key"] == "external"
        assert chat.bridge_watch_hub().metrics["sse_connections"] == 1
        assert (
            bridge.read_bridge_message("session", bridge_dir=directory)["transport_status"]
            == "pending"
        )
        bridge.resolve_canvas_command("external", {"ok": True}, bridge_dir=directory)
        assert await asyncio.to_thread(
            bridge.wait_canvas_command_result, "external", 1, bridge_dir=directory
        )
    finally:
        await iterator.aclose()
    assert not chat.bridge_watch_hub().directories
    assert chat.bridge_watch_hub().metrics["sse_connections"] == 0


@pytest.mark.parametrize(
    "project,canvas,agents",
    [("", "c", "main"), ("p", "", "main"), ("p", "c", "../other"), ("p", "c", "")],
)
async def test_sse_rejects_invalid_subscription(project, canvas, agents):
    with pytest.raises(HTTPException) as error:
        await chat.stream_canvas_commands(project, canvas, agents, user={"username": "viewer"})
    assert error.value.status_code == 400


async def test_sse_preserves_project_authorization(monkeypatch):
    async def denied(*_):
        raise HTTPException(status_code=403, detail="forbidden")

    monkeypatch.setattr(chat, "_bridge_project_state_dir", denied)
    with pytest.raises(HTTPException) as error:
        await chat.stream_canvas_commands("project", "canvas", user={"username": "viewer"})
    assert error.value.status_code == 403


async def test_session_historical_keys_do_not_block_lease_redelivery(scoped_bridge, monkeypatch):
    directory = scoped_bridge
    publish(directory, "session", False)
    monkeypatch.setattr(bridge, "BRIDGE_DELIVERY_LEASE_SECONDS", 0.1)
    hub = BridgeWatchHub()
    scope = ChatScope(kind="project", id="project", surface="freezone", canvas_id="canvas")
    async with hub.subscribe([directory]):
        for _ in range(100):
            if hub.pending(directory, "project", "canvas"):
                break
            await asyncio.sleep(0.01)
        first = await hub.run(
            chat._collect_session_canvas_commands,
            hub,
            [directory],
            scope,
            "viewer",
            "turn",
            {"session"},
            time.time(),
        )
        assert first[0]["bridge_key"] == "session"
        await asyncio.sleep(0.15)
        second = await hub.run(
            chat._collect_session_canvas_commands,
            hub,
            [directory],
            scope,
            "viewer",
            "turn",
            {"session"},
            time.time(),
        )
        assert second[0]["bridge_key"] == "session"
