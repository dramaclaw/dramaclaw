from types import SimpleNamespace
from pathlib import Path
from novelvideo.api.routes import chat as route
from novelvideo.chat.store import ChatScope


def test_project_watcher_and_receipt_use_worker_directory(monkeypatch, tmp_path):
    def workspace(username, *, profile, project_state_dir=None):
        return (
            (
                tmp_path / "legacy"
                if project_state_dir is None
                else Path(project_state_dir)
            )
            / "agents"
            / "hermes"
            / profile
        )

    monkeypatch.setattr(route, "ensure_user_hermes_workspace", workspace)
    state = tmp_path / "project-a"
    scope = ChatScope(
        kind="project",
        id="project-a",
        surface="freezone",
        canvas_id="default",
        state_dir=str(state),
    )
    expected = (
        state
        / "agents/hermes/freezone/tmp/supertale_canvas_command_bridge/freezone_main"
    )
    dirs = route._candidate_canvas_bridge_dirs_for_scope("local", scope)
    assert dirs[0] == expected
    expected.mkdir(parents=True)
    (expected / "test.pending.json").write_text("{}")
    payload = SimpleNamespace(canvas_id="default", agent_id="main", bridge_key="test")
    assert (
        route._bridge_dir_for_pending_key("local", payload, project_state_dir=state)
        == expected
    )
    other = route._candidate_canvas_bridge_dirs_for_scope(
        "local",
        ChatScope(
            kind="project",
            id="project-b",
            surface="freezone",
            canvas_id="default",
            state_dir=str(tmp_path / "project-b"),
        ),
    )
    assert expected not in other


async def test_bridge_path_resolves_authorized_project(monkeypatch, tmp_path):
    async def resolve(**kwargs):
        assert kwargs == {
            "user": {"username": "local"},
            "project_id": "project-a",
            "required_role": "viewer",
        }
        return SimpleNamespace(state_dir=tmp_path, is_home_node=True)

    monkeypatch.setattr(route, "resolve_project_context", resolve)
    assert (
        await route._bridge_project_state_dir(
            {"username": "local"},
            SimpleNamespace(project_id="project-a", state_dir="/untrusted"),
        )
        == tmp_path
    )


async def test_bridge_path_does_not_fallback_on_denied_project(monkeypatch):
    from fastapi import HTTPException
    import pytest

    async def denied(**kwargs):
        raise HTTPException(403, "denied")

    monkeypatch.setattr(route, "resolve_project_context", denied)
    with pytest.raises(HTTPException) as error:
        await route._bridge_project_state_dir(
            {"username": "local"}, SimpleNamespace(project_id="other")
        )
    assert error.value.status_code == 403


def test_canvas_receipt_is_written_where_project_worker_waits(monkeypatch, tmp_path):
    import json
    from novelvideo.freezone.canvas_command_bridge import put_pending_canvas_command

    def workspace(username, *, profile, project_state_dir=None):
        return Path(project_state_dir) / "agents" / "hermes" / profile

    monkeypatch.setattr(route, "ensure_user_hermes_workspace", workspace)
    bridge = (
        tmp_path
        / "agents/hermes/freezone/tmp/supertale_canvas_command_bridge/freezone_main"
    )
    put_pending_canvas_command(
        key="receipt-test",
        project_id="project-a",
        canvas_id="default",
        commands=[{"type": "html_artifact", "action": "create"}],
        envelope={},
        bridge_dir=bridge,
    )
    payload = route.CanvasCommandToolResultIn(
        bridge_key="receipt-test",
        project_id="project-a",
        canvas_id="default",
        applied=True,
        applied_count=1,
        tool_call_status="completed",
        canvas_apply_status="applied",
    )
    route._resolve_canvas_command_tool_result_payload(
        payload, username="local", project_state_dir=tmp_path
    )
    result = json.loads((bridge / "receipt-test.result.json").read_text())
    assert result["ok"] is True
    assert result["applied_count"] == 1


async def test_live_watcher_reads_project_scoped_pending(monkeypatch, tmp_path):
    import asyncio
    import time
    from novelvideo.freezone.canvas_command_bridge import put_pending_canvas_command

    def workspace(username, *, profile, project_state_dir=None):
        return Path(project_state_dir) / "agents" / "hermes" / profile

    monkeypatch.setattr(route, "ensure_user_hermes_workspace", workspace)
    bridge = (
        tmp_path
        / "agents/hermes/freezone/tmp/supertale_canvas_command_bridge/freezone_main"
    )
    put_pending_canvas_command(
        key="live-project-test",
        project_id="project-a",
        canvas_id="default",
        commands=[{"type": "create_node", "node_type": "videoNode"}],
        envelope={
            "schema_version": "canvas_chat_commands.v1",
            "commands": [{"type": "create_node", "node_type": "videoNode"}],
        },
        bridge_dir=bridge,
    )
    emitted = asyncio.Event()
    frames = []

    class Socket:
        async def send_json(self, value):
            frames.append(value)
            emitted.set()

    task = asyncio.create_task(
        route._watch_pending_canvas_commands(
            websocket=Socket(),
            username="local",
            scope=ChatScope(
                kind="project",
                id="project-a",
                surface="freezone",
                canvas_id="default",
                state_dir=str(tmp_path),
            ),
            turn_id="test-turn",
            send_lock=asyncio.Lock(),
            emitted_bridge_keys=set(),
            started_at=time.time(),
        )
    )
    try:
        await asyncio.wait_for(emitted.wait(), timeout=3)
        assert frames[0]["bridge_key"] == "live-project-test"
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
