"""CE-owner-mode safety boundary for the DramaClaw Hermes plugin.

Tokenless CE-owner mode (``DRAMACLAW_CE_OWNER=1`` with no bearer token) drops
the ``Authorization`` header entirely, so it must only ever target a loopback
CE the caller controls. These tests cover loopback acceptance, remote-host
rejection, the explicit unsafe override, bearer-token precedence, the
outside-owner-mode missing-token failure, and that ``Authorization`` is never
silently dropped when a token is present.
"""

from __future__ import annotations

import importlib.util
import sys
import types
from pathlib import Path

import pytest

_ENV_VARS = (
    "DRAMACLAW_API_URL",
    "DRAMACLAW_AGENT_TOKEN",
    "DRAMACLAW_CE_OWNER",
    "DRAMACLAW_CE_OWNER_ALLOW_REMOTE",
)


def _load_plugin_module():
    tools_module = types.ModuleType("tools")
    registry_module = types.ModuleType("tools.registry")
    registry_module.tool_error = lambda value: value
    registry_module.tool_result = lambda value: value
    sys.modules.setdefault("tools", tools_module)
    sys.modules.setdefault("tools.registry", registry_module)

    path = Path(__file__).resolve().parents[1] / ".hermes" / "plugins" / "dramaclaw" / "__init__.py"
    spec = importlib.util.spec_from_file_location("test_dramaclaw_ce_owner_plugin", path)
    assert spec is not None
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


class _FakeResponse:
    status = 200

    def read(self) -> bytes:
        return b'{"ok": true}'

    def __enter__(self) -> "_FakeResponse":
        return self

    def __exit__(self, *_exc) -> bool:
        return False


def _capture_requests(module, monkeypatch) -> list:
    """Patch the module's ``urlopen`` and record every outgoing Request."""
    captured: list = []

    def fake_urlopen(req, timeout=None):  # noqa: ARG001 - signature parity
        captured.append(req)
        return _FakeResponse()

    monkeypatch.setattr(module, "urlopen", fake_urlopen)
    return captured


def _clear_env(monkeypatch) -> None:
    for var in _ENV_VARS:
        monkeypatch.delenv(var, raising=False)


# --- loopback acceptance -------------------------------------------------


@pytest.mark.parametrize(
    "api_url",
    [
        "http://localhost:8780",
        "http://127.0.0.1:8780",
        "http://[::1]:8780",
    ],
)
def test_owner_mode_loopback_accepted(monkeypatch, api_url):
    module = _load_plugin_module()
    _clear_env(monkeypatch)
    monkeypatch.setenv("DRAMACLAW_API_URL", api_url)
    monkeypatch.setenv("DRAMACLAW_CE_OWNER", "1")
    captured = _capture_requests(module, monkeypatch)

    assert module._available() is True
    result = module._request("GET", "/api/v1/health")

    assert result["ok"] is True
    assert len(captured) == 1
    # Tokenless owner mode: no Authorization header is sent.
    assert captured[0].get_header("Authorization") is None


def test_enforce_target_accepts_bracketed_ipv6_loopback():
    module = _load_plugin_module()
    # Should not raise for any loopback literal, including bracketed IPv6.
    module._enforce_ce_owner_target("http://[::1]:8780")
    module._enforce_ce_owner_target("http://localhost")
    module._enforce_ce_owner_target("http://127.0.0.1:9000")


# --- remote rejection ----------------------------------------------------


def test_owner_mode_remote_rejected_without_override(monkeypatch):
    module = _load_plugin_module()
    _clear_env(monkeypatch)
    monkeypatch.setenv("DRAMACLAW_API_URL", "http://drama.example.com:8780")
    monkeypatch.setenv("DRAMACLAW_CE_OWNER", "1")
    captured = _capture_requests(module, monkeypatch)

    with pytest.raises(ValueError) as exc:
        module._request("GET", "/api/v1/health")

    assert "loopback" in str(exc.value).lower()
    # The request must never have gone out.
    assert captured == []


def test_owner_mode_remote_lan_ip_rejected(monkeypatch):
    module = _load_plugin_module()
    _clear_env(monkeypatch)
    monkeypatch.setenv("DRAMACLAW_API_URL", "http://192.168.1.50:8780")
    monkeypatch.setenv("DRAMACLAW_CE_OWNER", "1")

    with pytest.raises(ValueError):
        module._enforce_ce_owner_target(module._base_url())


# --- explicit unsafe override --------------------------------------------


def test_owner_mode_remote_allowed_with_override(monkeypatch):
    module = _load_plugin_module()
    _clear_env(monkeypatch)
    monkeypatch.setenv("DRAMACLAW_API_URL", "http://drama.example.com:8780")
    monkeypatch.setenv("DRAMACLAW_CE_OWNER", "1")
    monkeypatch.setenv("DRAMACLAW_CE_OWNER_ALLOW_REMOTE", "1")
    captured = _capture_requests(module, monkeypatch)

    result = module._request("GET", "/api/v1/health")

    assert result["ok"] is True
    assert len(captured) == 1
    # Still tokenless: override permits the target but adds no auth.
    assert captured[0].get_header("Authorization") is None


# --- bearer-token precedence ---------------------------------------------


def test_token_precedence_over_owner_mode(monkeypatch):
    module = _load_plugin_module()
    _clear_env(monkeypatch)
    # Token present AND owner mode set AND a remote host: the token wins, the
    # loopback restriction does not apply, and Authorization is sent.
    monkeypatch.setenv("DRAMACLAW_API_URL", "http://drama.example.com:8780")
    monkeypatch.setenv("DRAMACLAW_CE_OWNER", "1")
    monkeypatch.setenv("DRAMACLAW_AGENT_TOKEN", "secret-token")
    captured = _capture_requests(module, monkeypatch)

    result = module._request("GET", "/api/v1/health")

    assert result["ok"] is True
    assert len(captured) == 1
    assert captured[0].get_header("Authorization") == "Bearer secret-token"


# --- missing token outside owner mode ------------------------------------


def test_missing_token_outside_owner_mode_fails(monkeypatch):
    module = _load_plugin_module()
    _clear_env(monkeypatch)
    monkeypatch.setenv("DRAMACLAW_API_URL", "http://localhost:8780")
    captured = _capture_requests(module, monkeypatch)

    assert module._available() is False
    with pytest.raises(ValueError) as exc:
        module._request("GET", "/api/v1/health")

    assert "DRAMACLAW_AGENT_TOKEN is not set" in str(exc.value)
    assert captured == []


# --- Authorization is never silently dropped -----------------------------


def test_authorization_present_when_token_provided(monkeypatch):
    module = _load_plugin_module()
    _clear_env(monkeypatch)
    monkeypatch.setenv("DRAMACLAW_API_URL", "http://localhost:8780")
    monkeypatch.setenv("DRAMACLAW_AGENT_TOKEN", "abc123")
    captured = _capture_requests(module, monkeypatch)

    result = module._request("POST", "/api/v1/health", body={"x": 1})

    assert result["ok"] is True
    assert len(captured) == 1
    assert captured[0].get_header("Authorization") == "Bearer abc123"
