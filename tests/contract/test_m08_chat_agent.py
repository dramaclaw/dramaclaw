import json
import os
import subprocess
import sys

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from novelvideo.ports.auth_contract import AuthError

pytestmark = pytest.mark.m08


def _run_ce_agent_route_probe() -> dict:
    env = os.environ.copy()
    env["ST_EDITION"] = "ce"
    env["ST_CONTROL_PLANE_DSN"] = ""
    env["REDIS_URL"] = ""
    code = """
import json

from fastapi.testclient import TestClient
from novelvideo.api.app import create_app

with TestClient(create_app()) as client:
    results = {
        "get_keys": client.get("/api/v1/agent/keys").status_code,
        "post_keys": client.post("/api/v1/agent/keys", json={}).status_code,
        "revoke_key": client.post("/api/v1/agent/keys/key-1/revoke").status_code,
        "sessions": client.post("/api/v1/agent/sessions", json={}).status_code,
    }
print(json.dumps(results), end="")
"""
    proc = subprocess.run(
        [sys.executable, "-c", code],
        check=True,
        capture_output=True,
        text=True,
        env=env,
    )
    return json.loads(proc.stdout)


def test_ce_agent_key_routes_are_not_mounted() -> None:
    assert _run_ce_agent_route_probe() == {
        "get_keys": 404,
        "post_keys": 404,
        "revoke_key": 404,
        "sessions": 404,
    }


def test_ce_chat_http_routes_are_mounted_and_use_local_auth(monkeypatch) -> None:
    from novelvideo.api.app import create_app
    from novelvideo.chat import service as chat_service
    from novelvideo.ports import registry

    monkeypatch.setenv("ST_EDITION", "ce")
    monkeypatch.setenv("ST_CONTROL_PLANE_DSN", "")
    monkeypatch.setenv("REDIS_URL", "")
    monkeypatch.setattr(registry, "_PORTS", {})
    monkeypatch.setattr(registry, "_BOOTSTRAPPED", False)
    monkeypatch.setattr(chat_service, "force_release_chat_run_lock", lambda *_args: None)

    app = create_app()
    with TestClient(app) as client:
        cancel = client.post("/api/v1/chat/cancel")
        ui_event = client.post(
            "/api/v1/chat/ui-events",
            json={
                "scope": {"kind": "home"},
                "turn_id": "turn-1",
                "event": {"type": "noop"},
            },
        )

    assert cancel.status_code == 200
    assert cancel.json()["ok"] is True
    assert ui_event.status_code == 200
    assert ui_event.json()["ok"] is True


def test_ce_chat_ws_accepts_missing_cookie_via_local_auth(monkeypatch) -> None:
    from novelvideo.api.app import create_app
    from novelvideo.chat import service as chat_service
    from novelvideo.ports import registry

    async def _no_prewarm(*_args, **_kwargs) -> None:
        return None

    monkeypatch.setenv("ST_EDITION", "ce")
    monkeypatch.setenv("ST_CONTROL_PLANE_DSN", "")
    monkeypatch.setenv("REDIS_URL", "")
    monkeypatch.setattr(registry, "_PORTS", {})
    monkeypatch.setattr(registry, "_BOOTSTRAPPED", False)
    monkeypatch.setattr(chat_service, "prewarm_chat_backend", _no_prewarm)

    app = create_app()
    with TestClient(app) as client:
        with client.websocket_connect("/api/v1/chat/ws") as websocket:
            first_frame = websocket.receive_json()

    assert first_frame["type"] == "scope.changed"
    assert first_frame["scope"] == {"kind": "home", "id": None}


def test_chat_ws_auth_failure_reports_unauthorized(monkeypatch) -> None:
    from novelvideo.api.app import create_app
    from novelvideo.api.routes import chat as chat_routes
    from novelvideo.chat import service as chat_service
    from novelvideo.ports import registry

    async def _reject_browser_session(_raw_cookie: str | None) -> dict:
        raise HTTPException(status_code=401, detail="Invalid session")

    async def _no_prewarm(*_args, **_kwargs) -> None:
        return None

    monkeypatch.setenv("ST_EDITION", "ce")
    monkeypatch.setenv("ST_CONTROL_PLANE_DSN", "")
    monkeypatch.setenv("REDIS_URL", "")
    monkeypatch.setattr(registry, "_PORTS", {})
    monkeypatch.setattr(registry, "_BOOTSTRAPPED", False)
    monkeypatch.setattr(chat_routes, "_verify_browser_session", _reject_browser_session)
    monkeypatch.setattr(chat_service, "prewarm_chat_backend", _no_prewarm)

    app = create_app()
    with TestClient(app) as client:
        client.cookies.set("st_session", "bad-cookie")
        with client.websocket_connect("/api/v1/chat/ws") as websocket:
            first_frame = websocket.receive_json()

    assert first_frame == {"type": "error", "message": "unauthorized"}


@pytest.mark.asyncio
async def test_ce_chat_page_agent_session_uses_local_auth_session(monkeypatch) -> None:
    from novelvideo.chat import service as chat_service
    from novelvideo.ports import get_auth_session_port, registry
    from novelvideo.ports.local import register_local_ports

    monkeypatch.setattr(registry, "_PORTS", {})
    monkeypatch.setattr(registry, "_BOOTSTRAPPED", False)
    register_local_ports()

    token_value = await chat_service._create_page_agent_session_token(
        "local",
        "project-a",
        agent_kind="codex",
    )

    port = get_auth_session_port()
    user = await port.verify_agent_session(token_value)
    assert user["username"] == "local"
    assert user["current_scope_kind"] == "project"
    assert user["current_project_id"] == "project-a"

    await port.update_agent_session_scope(
        token_value,
        scope_kind="home",
        project_id=None,
    )
    updated = await port.verify_agent_session(token_value)
    assert updated["current_scope_kind"] == "home"
    assert updated["current_project_id"] is None

    await port.revoke_agent_session(token_value)
    with pytest.raises(AuthError):
        await port.verify_agent_session(token_value)
