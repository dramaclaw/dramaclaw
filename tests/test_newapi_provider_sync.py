"""First credential sync creates a channel before model mappings exist."""

import httpx
import pytest

from novelvideo import newapi_provisioner as provisioner


@pytest.mark.parametrize("accepted", [True, False])
def test_first_provider_sync_creates_empty_channel(monkeypatch, accepted):
    channels = []
    requests = []

    def gateway(request):
        import json
        requests.append((request.method, request.url.path))
        if request.method == "GET":
            return httpx.Response(200, json={"success": True, "data": {"items": channels}})
        assert request.method == "POST" and request.url.path == "/api/channel/"
        channel = json.loads(request.content)["channel"]
        assert channel["name"] == "DC-openai"
        assert channel["type"] == 1
        assert channel["key"] == "test-upstream-key"
        assert channel["base_url"] == "https://custom.example.test"
        assert channel["models"] == ""
        assert channel["model_mapping"] == "{}"
        if accepted:
            channels.append({"id": 7, **channel})
        return httpx.Response(200, json={"success": accepted, "message": "" if accepted else "invalid key"})

    client_type = httpx.Client
    transport = httpx.MockTransport(gateway)
    monkeypatch.setattr(provisioner.httpx, "Client", lambda **kwargs: client_type(transport=transport, **kwargs))
    cfg = provisioner.NewApiProvisionerConfig(
        admin_base_url="http://gateway.test", sql_dsn="local", sqlite_path="",
        admin_username="root", init_timeout_ms=1000, relay_token_name="test",
    )
    admin = provisioner.AdminToken(1, "root", "test-admin-key", False)
    result = provisioner.update_provider_channel_credentials(
        cfg, admin, provider="openai", upstream_key="test-upstream-key",
        base_url="https://custom.example.test/",
    )
    assert result["ok"] is accepted
    assert result["action"] == "create"
    assert result["channelId"] == (7 if accepted else None)
    assert ("POST", "/api/channel/") in requests
