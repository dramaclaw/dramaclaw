from __future__ import annotations

import threading

import httpx
import pytest
import respx
from fastapi import FastAPI
from fastapi.testclient import TestClient

from novelvideo import model_gateway_settings, newapi_provisioner
from novelvideo.api.routes import model_gateway
from novelvideo.newapi_provisioner import AdminToken, NewApiProvisionerConfig


BASE_URL = "http://new-api:3000"
ENDPOINT = "/model-gateway/custom/newapi/provider-channel/models"
SECRET = "sk-upstream-secret-must-not-leak"


@pytest.fixture
def discovery_client(monkeypatch, tmp_path):
    monkeypatch.setenv("ST_EDITION", "ce")
    monkeypatch.delenv("ST_CONTROL_PLANE_DSN", raising=False)
    monkeypatch.setenv("NEWAPI_PROVISIONER_ENABLED", "true")
    monkeypatch.setattr(
        model_gateway_settings, "_settings_db_path", lambda: tmp_path / "settings.db"
    )
    cfg = NewApiProvisionerConfig(
        admin_base_url=BASE_URL,
        sql_dsn="local",
        sqlite_path=str(tmp_path / "one-api.db"),
        admin_username="root",
        init_timeout_ms=1000,
        relay_token_name="dramaclaw-ce-runtime",
    )
    admin = AdminToken(1, "root", "admin-secret", False)
    monkeypatch.setattr(model_gateway, "get_provisioner_config", lambda *a, **kw: cfg)
    monkeypatch.setattr(model_gateway, "ensure_admin_access_token", lambda cfg: admin)
    app = FastAPI()
    app.include_router(model_gateway.router)
    with TestClient(app) as client:
        yield client


def mock_channels(items=None):
    if items is None:
        items = [{"id": 7, "name": "DC-openai", "type": 1, "key": SECRET}]
    return respx.get(f"{BASE_URL}/api/channel/").respond(
        200, json={"success": True, "data": {"items": items}}
    )


@respx.mock
def test_discovery_uses_saved_gateway_channel_and_normalizes_models(
    discovery_client, monkeypatch
):
    client_options = []
    real_client = httpx.Client

    def management_client(**kwargs):
        client_options.append(kwargs)
        return real_client(**kwargs)

    monkeypatch.setattr(newapi_provisioner.httpx, "Client", management_client)
    channels = mock_channels()
    discovery = respx.get(f"{BASE_URL}/api/channel/fetch_models/7").respond(
        200,
        json={
            "success": True,
            "data": [
                " gpt-4o ",
                "gpt-4o",
                "vendor/model",
                "",
                "  ",
                None,
                123,
                True,
                {"id": "not-a-string"},
                ["nested"],
                "x" * 256,
                "x" * 255,
                "bad,model",
                "bad\nmodel",
                "bad\x00model",
                "bad\x7fmodel",
                "bad model",
                "GPT-4o",
            ],
        },
    )

    response = discovery_client.post(ENDPOINT, json={"provider": " OpenAI "})

    assert response.status_code == 200
    assert response.json() == {
        "ok": True,
        "data": {
            "provider": "openai",
            "models": ["gpt-4o", "vendor/model", "x" * 255, "GPT-4o"],
            "channelId": 7,
        },
    }
    assert channels.call_count == discovery.call_count == 1
    assert client_options[-1] == {"trust_env": False, "timeout": 30}
    request = discovery.calls[0].request
    assert request.method == "GET"
    assert request.content == b""
    assert request.headers["Authorization"] == "admin-secret"
    assert request.headers["New-Api-User"] == "1"
    assert SECRET not in str(request.headers)
    assert SECRET not in response.text


@respx.mock
@pytest.mark.parametrize("explicit_type", [None, 62])
def test_discovery_supports_saved_or_explicit_custom_channel_type(
    discovery_client, monkeypatch, explicit_type
):
    monkeypatch.setattr(
        model_gateway, "get_newapi_provider_channel", lambda provider: {"type": 62}
    )
    mock_channels(
        [
            {"id": 9, "name": "DC-tokenhub", "type": 1},
            {"id": 8, "name": "DC-tokenhub", "type": 62},
            {"id": 7, "name": "DC-tokenhub", "type": 62},
        ]
    )
    respx.get(f"{BASE_URL}/api/channel/fetch_models/8").respond(
        200, json={"success": True, "data": []}
    )
    payload = {"provider": "tokenhub"}
    if explicit_type is not None:
        payload["type"] = explicit_type
    response = discovery_client.post(ENDPOINT, json=payload)
    assert response.status_code == 200
    assert response.json()["data"] == {
        "provider": "tokenhub",
        "models": [],
        "channelId": 8,
    }


@respx.mock
def test_missing_channel_requires_sync(discovery_client):
    mock_channels([])
    response = discovery_client.post(ENDPOINT, json={"provider": "openai"})
    assert response.status_code == 404
    assert response.json() == {
        "detail": "provider channel not found; save and sync it first"
    }
    assert len(respx.calls) == 1


@respx.mock
@pytest.mark.parametrize(
    "status,body",
    [
        (401, {"success": False, "message": SECRET}),
        (500, {"error": SECRET}),
        (404, {"message": "model listing unsupported " + SECRET}),
        (405, {"message": SECRET}),
        (200, {"success": False, "message": SECRET}),
        (200, {"success": True, "data": {"models": [SECRET]}}),
        (200, {"success": True, "data": SECRET}),
        (200, {"success": True}),
        (200, {"data": ["model"]}),
        (200, [SECRET]),
    ],
)
def test_gateway_rejections_and_invalid_lists_are_secret_free(
    discovery_client, status, body
):
    mock_channels()
    respx.get(f"{BASE_URL}/api/channel/fetch_models/7").respond(status, json=body)
    response = discovery_client.post(ENDPOINT, json={"provider": "openai"})
    assert response.status_code == 502
    assert response.json() == {"detail": "NewAPI provider model discovery failed"}
    assert SECRET not in response.text


@respx.mock
def test_invalid_json_is_secret_free(discovery_client):
    mock_channels()
    respx.get(f"{BASE_URL}/api/channel/fetch_models/7").respond(200, text=SECRET)
    response = discovery_client.post(ENDPOINT, json={"provider": "openai"})
    assert response.status_code == 502
    assert SECRET not in response.text


@respx.mock
@pytest.mark.parametrize(
    "error,status,detail",
    [
        (httpx.ReadTimeout(SECRET), 504, "NewAPI provider model discovery timed out"),
        (httpx.ConnectError(SECRET), 502, "NewAPI provider model discovery failed"),
    ],
)
def test_transport_errors_are_stable_and_secret_free(
    discovery_client, error, status, detail
):
    mock_channels()
    respx.get(f"{BASE_URL}/api/channel/fetch_models/7").mock(side_effect=error)
    response = discovery_client.post(ENDPOINT, json={"provider": "openai"})
    assert response.status_code == status
    assert response.json() == {"detail": detail}


@respx.mock
def test_channel_lookup_failure_is_secret_free(discovery_client):
    respx.get(f"{BASE_URL}/api/channel/").respond(
        500, json={"success": False, "message": SECRET}
    )
    response = discovery_client.post(ENDPOINT, json={"provider": "openai"})
    assert response.status_code == 502
    assert SECRET not in response.text


def test_admin_failure_is_secret_free(discovery_client, monkeypatch):
    def fail(cfg):
        raise RuntimeError(SECRET)

    monkeypatch.setattr(model_gateway, "ensure_admin_access_token", fail)
    response = discovery_client.post(ENDPOINT, json={"provider": "openai"})
    assert response.status_code == 502
    assert SECRET not in response.text


@pytest.mark.parametrize(
    "payload", [{"provider": " "}, {"provider": "openai", "type": 0}]
)
def test_invalid_provider_or_type_does_not_contact_gateway(
    discovery_client, monkeypatch, payload
):
    def unexpected(cfg):
        pytest.fail("invalid requests must not resolve admin credentials")

    monkeypatch.setattr(model_gateway, "ensure_admin_access_token", unexpected)
    response = discovery_client.post(ENDPOINT, json=payload)
    assert response.status_code == 400


@pytest.mark.parametrize("denial", ["ee", "disabled"])
def test_management_permission_is_checked_before_discovery(
    discovery_client, monkeypatch, denial
):
    if denial == "ee":
        monkeypatch.setenv("ST_EDITION", "ee")
        monkeypatch.setenv("ST_CONTROL_PLANE_DSN", "postgresql://control-plane")
    else:
        monkeypatch.setenv("NEWAPI_PROVISIONER_ENABLED", "false")

    def unexpected(*args, **kwargs):
        pytest.fail("denied requests must not read management configuration")

    monkeypatch.setattr(model_gateway, "get_provisioner_config", unexpected)
    monkeypatch.setattr(model_gateway, "get_newapi_provider_channel", unexpected)
    response = discovery_client.post(ENDPOINT, json={"provider": "openai"})
    assert response.status_code == 403
    if denial == "ee":
        assert response.json()["detail"] == "ORG_SERVICE_EGRESS_DENIED"


async def test_discovery_offloads_management_work_and_passes_request_config(
    monkeypatch,
):
    event_loop_thread = threading.get_ident()
    calls = []
    cfg = object()
    admin = object()
    monkeypatch.setattr(model_gateway, "require_ce_gateway_management", lambda: None)
    monkeypatch.setattr(
        model_gateway, "get_newapi_provider_channel", lambda provider: {}
    )

    def resolve(base_url, **kwargs):
        assert threading.get_ident() != event_loop_thread
        calls.append((base_url, kwargs))
        return cfg

    def authenticate(actual_cfg):
        assert threading.get_ident() != event_loop_thread
        assert actual_cfg is cfg
        return admin

    def discover(actual_cfg, actual_admin, **kwargs):
        assert threading.get_ident() != event_loop_thread
        assert actual_cfg is cfg and actual_admin is admin
        assert kwargs == {"provider": "openai", "channel_type": None}
        return {"provider": "openai", "models": ["gpt-4o"], "channelId": 7}

    monkeypatch.setattr(model_gateway, "get_provisioner_config", resolve)
    monkeypatch.setattr(model_gateway, "ensure_admin_access_token", authenticate)
    monkeypatch.setattr(model_gateway, "fetch_provider_channel_models", discover)
    response = await model_gateway.get_custom_newapi_provider_channel_models(
        model_gateway.ProviderChannelModelsBody(
            provider="openai",
            newApiBaseUrl=BASE_URL,
            database={
                "sqlDsn": "local",
                "sqlitePath": "/tmp/db",
                "adminUsername": "owner",
            },
        )
    )
    assert response["ok"] is True
    assert calls == [
        (
            BASE_URL,
            {"sql_dsn": "local", "sqlite_path": "/tmp/db", "admin_username": "owner"},
        )
    ]
