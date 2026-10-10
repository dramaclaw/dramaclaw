from __future__ import annotations

import importlib

import pytest
from fastapi import HTTPException
from starlette.requests import Request


def _reset_modules():
    import novelvideo.ports as ports
    import novelvideo.ports.registry as registry

    registry._PORTS.clear()
    registry._BOOTSTRAPPED = False
    api_auth = importlib.import_module("novelvideo.api.auth")
    return registry, ports, api_auth


def _request(
    *,
    cookie: str | None = None,
    authorization: str | None = None,
    client_host: str = "testclient",
    extra_headers: dict[str, str] | None = None,
) -> Request:
    headers = []
    if cookie is not None:
        headers.append((b"cookie", f"st_session={cookie}".encode()))
    if authorization is not None:
        headers.append((b"authorization", authorization.encode()))
    for key, value in (extra_headers or {}).items():
        headers.append((key.lower().encode(), value.encode()))
    return Request(
        {
            "type": "http",
            "method": "GET",
            "path": "/api/v1/auth/me",
            "headers": headers,
            "query_string": b"",
            "server": ("testserver", 80),
            "scheme": "http",
            "client": (client_host, 50000),
        }
    )


@pytest.mark.asyncio
async def test_local_agent_trust_accepts_direct_loopback_request(monkeypatch) -> None:
    _registry, _ports, api_auth = _reset_modules()
    monkeypatch.setenv("DRAMACLAW_LOCAL_AGENT_TRUST", "true")
    monkeypatch.setenv("ST_LOCAL_USERNAME", "alice")

    user = await api_auth.get_api_user(
        _request(
            client_host="127.0.0.1",
            extra_headers={"host": "127.0.0.1:8780"},
        )
    )

    assert user["username"] == "alice"
    assert user["role"] == "owner"
    assert user["credential_kind"] == "local_trusted_agent"
    assert user["agent_kind"] == "local_mcp"


@pytest.mark.parametrize(
    ("client_host", "extra_headers"),
    [
        ("203.0.113.10", {"host": "127.0.0.1:8780"}),
        ("127.0.0.1", {"host": "example.com"}),
        ("127.0.0.1", {"host": "127.0.0.1:8780", "x-forwarded-host": "example.com"}),
        ("127.0.0.1", {"host": "127.0.0.1:8780", "x-forwarded-for": "203.0.113.10"}),
        ("127.0.0.1", {"host": "127.0.0.1:8780", "x-forwarded-proto": "https"}),
        (
            "127.0.0.1",
            {
                "host": "127.0.0.1:8780",
                "forwarded": "for=203.0.113.10;proto=https",
            },
        ),
    ],
)
def test_local_agent_trust_rejects_remote_or_proxied_requests(
    monkeypatch,
    client_host: str,
    extra_headers: dict[str, str],
) -> None:
    _registry, _ports, api_auth = _reset_modules()
    monkeypatch.setenv("DRAMACLAW_LOCAL_AGENT_TRUST", "true")

    assert not api_auth._is_local_trusted_agent_request(
        _request(client_host=client_host, extra_headers=extra_headers)
    )


@pytest.mark.asyncio
async def test_browser_path_without_registered_auth_port_returns_pinned_503() -> None:
    _registry, _ports, api_auth = _reset_modules()

    with pytest.raises(HTTPException) as exc:
        await api_auth.get_api_user(_request())

    assert exc.value.status_code == 503
    assert exc.value.detail == "auth backend not initialised"


@pytest.mark.asyncio
async def test_cookie_path_without_registered_auth_port_returns_pinned_503() -> None:
    _registry, _ports, api_auth = _reset_modules()

    with pytest.raises(HTTPException) as exc:
        await api_auth.get_api_user(_request(cookie="bad-cookie"))

    assert exc.value.status_code == 503
    assert exc.value.detail == "auth backend not initialised"


@pytest.mark.asyncio
async def test_bearer_path_without_registered_auth_session_port_returns_pinned_401() -> None:
    _registry, _ports, api_auth = _reset_modules()

    with pytest.raises(HTTPException) as exc:
        await api_auth.get_api_user(_request(authorization="Bearer bad-token"))

    assert exc.value.status_code == 401
    assert exc.value.detail == "Agent sessions require control plane"


@pytest.mark.asyncio
async def test_verify_credential_for_request_keeps_ce_cookie_less_stream_alive(monkeypatch) -> None:
    registry, _ports, api_auth = _reset_modules()
    monkeypatch.delenv("ST_CONTROL_PLANE_DSN", raising=False)
    monkeypatch.setenv("ST_EDITION", "ce")
    monkeypatch.setenv("ST_LOCAL_USERNAME", "alice")
    registry.ensure_bootstrap()

    user = await api_auth.verify_credential_for_request(_request())

    assert user == {"id": "local", "user_id": "local", "username": "alice", "role": "owner"}


@pytest.mark.asyncio
async def test_verify_credential_for_request_returns_none_for_ee_missing_cookie(
    monkeypatch,
) -> None:
    _registry, _ports, api_auth = _reset_modules()

    async def fail_browser_session(_raw_cookie):
        raise HTTPException(status_code=401, detail="Missing session or agent token")

    monkeypatch.setattr(api_auth, "_verify_browser_session", fail_browser_session)

    assert await api_auth.verify_credential_for_request(_request()) is None
