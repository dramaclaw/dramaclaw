import pytest
from starlette.websockets import WebSocketDisconnect

from novelvideo.api.routes import chat as chat_route
from novelvideo.chat.store import ChatScope
from novelvideo.ports.product_surface_access import ProductSurfaceUnavailableError


@pytest.mark.anyio
async def test_send_scope_changed_returns_none_when_client_disconnected(monkeypatch) -> None:
    class DisconnectedWebSocket:
        async def send_json(self, payload):
            raise WebSocketDisconnect(code=1006)

    async def fake_history(username, scope, *, project_ctx=None):
        return []

    monkeypatch.setattr(chat_route, "_history", fake_history)

    result = await chat_route._send_scope_changed(
        DisconnectedWebSocket(),
        {"username": "admin"},
        "admin",
        ChatScope(kind="home"),
    )

    assert result is None


def test_ws_connect_does_not_prewarm_default_home_scope() -> None:
    assert chat_route._should_prewarm_on_ws_connect(ChatScope(kind="home")) is False


def test_ws_connect_can_prewarm_non_home_scope() -> None:
    assert chat_route._should_prewarm_on_ws_connect(ChatScope(kind="project", id="project_a")) is True


@pytest.mark.anyio
async def test_ai_assistant_access_check_uses_chat_feature_key(monkeypatch) -> None:
    seen = {}

    class FakeSurfaceAccess:
        async def require_assistant_access(self, _user_id: str, surface_code: str):
            seen["surface_code"] = surface_code
            return {"available": True}

    class FakeUsageMeter:
        async def require_feature_credit_balance(self, **kwargs):
            seen.update(kwargs)
            return {"allowed": True}

    monkeypatch.setattr(chat_route, "get_product_surface_access", lambda: FakeSurfaceAccess())
    monkeypatch.setattr(chat_route, "get_usage_meter", lambda: FakeUsageMeter())

    await chat_route._require_ai_assistant_access(
        user={"id": "usr_1", "username": "alice"},
        scope=ChatScope(kind="home"),
        product_surface="assistant",
    )

    assert seen["user_id"] == "usr_1"
    assert seen["feature_key"] == "assistant.chat"
    assert seen["project_id"] == ""
    assert seen["resource_kind"] == "chat"
    assert seen["metadata"]["scope"] == {"kind": "home", "id": None}
    assert seen["metadata"]["product_surface"] == "assistant"
    assert seen["surface_code"] == "assistant"


@pytest.mark.anyio
async def test_closed_assistant_surface_does_not_prewarm(monkeypatch) -> None:
    prewarm_called = False

    class FakeSurfaceAccess:
        async def require_assistant_access(self, _user_id: str, surface_code: str):
            raise ProductSurfaceUnavailableError(surface_code, "入口维护中")

    async def fake_prewarm(*_args, **_kwargs):
        nonlocal prewarm_called
        prewarm_called = True

    monkeypatch.setattr(chat_route, "get_product_surface_access", lambda: FakeSurfaceAccess())
    monkeypatch.setattr(chat_route.chat_service, "prewarm_chat_backend", fake_prewarm)

    with pytest.raises(ProductSurfaceUnavailableError, match="入口维护中"):
        await chat_route._prewarm_authorized_chat_backend(
            user={"id": "usr_1", "username": "alice"},
            username="alice",
            scope=ChatScope(kind="home"),
            product_surface="freezone_assistant",
        )

    assert prewarm_called is False


@pytest.mark.anyio
async def test_freezone_chat_ignores_forged_client_surface(monkeypatch) -> None:
    seen = {}

    class FakeWebSocket:
        def __init__(self):
            self.frames = [
                {
                    "type": "scope.set",
                    "product_surface": "assistant",
                    "scope": {"kind": "project", "id": "project_a"},
                }
            ]

        async def accept(self):
            return None

        async def receive_json(self):
            if self.frames:
                return self.frames.pop(0)
            raise WebSocketDisconnect(code=1000)

        async def send_json(self, _payload):
            return None

    async def fake_authenticate(_websocket):
        return {"id": "usr_1", "username": "alice"}

    async def fake_prewarm(**kwargs):
        seen["surface"] = kwargs["product_surface"]

    async def fake_scope_changed(_websocket, _user, _username, scope):
        return scope

    async def fake_sync(_username, _scope):
        seen["scope_synced"] = True

    monkeypatch.setattr(chat_route, "_authenticate_ws", fake_authenticate)
    monkeypatch.setattr(chat_route, "_prewarm_authorized_chat_backend", fake_prewarm)
    monkeypatch.setattr(chat_route, "_send_scope_changed", fake_scope_changed)
    monkeypatch.setattr(chat_route, "_sync_running_agent_scope", fake_sync)

    await chat_route._serve_chat_ws(
        FakeWebSocket(),
        product_surface="freezone_assistant",
    )

    assert seen == {
        "surface": "freezone_assistant",
        "scope_synced": True,
    }
