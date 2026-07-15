from __future__ import annotations

import json
import os

import pytest
import respx
from fastapi import FastAPI
from fastapi.testclient import TestClient
from httpx import Response

from novelvideo import config
from novelvideo.api.routes import model_gateway
from novelvideo.official_defaults import OFFICIAL_NEWAPI_BASE_URL
from novelvideo.model_gateway_settings import (
    MODE_CUSTOM,
    MODE_OFFICIAL,
    build_newapi_database_status,
    build_model_gateway_status,
    get_effective_cognee_embedding_config,
    get_effective_newapi_config,
    normalize_relay_base_url,
    save_official_newapi_key,
    save_custom_newapi_gateway,
    save_newapi_embedding_model_config,
    save_media_relay_config,
    save_newapi_database_config,
    save_newapi_provider_channels,
    set_model_gateway_mode,
)
from novelvideo.newapi_provisioner import (
    AdminToken,
    build_channel_payload,
    ensure_newapi_setup,
    get_provisioner_config,
    NewApiSetupCredentials,
    NewApiProvisionerConfig,
    normalize_admin_base_url,
    open_newapi_db,
    require_provisioner_enabled,
    update_provider_channel_credentials,
    upsert_channel,
)


def _isolate_settings_db(monkeypatch: pytest.MonkeyPatch, tmp_path):
    monkeypatch.setattr(config, "STATE_DIR", str(tmp_path / "state"))
    monkeypatch.delenv("MODEL_GATEWAY_MODE", raising=False)


def test_model_gateway_uses_explicit_custom_mode(monkeypatch, tmp_path):
    _isolate_settings_db(monkeypatch, tmp_path)

    save_custom_newapi_gateway(
        base_url="http://127.0.0.1:3000",
        api_key="sk-custom-secret",
        admin_base_url="http://127.0.0.1:3000",
        token_name="dramaclaw-ce-runtime",
        token_id=3,
        activate=True,
    )

    effective = get_effective_newapi_config(
        official_base_url="https://official.example/v1",
        official_api_key="sk-official-secret",
    )
    assert effective.mode == MODE_CUSTOM
    assert effective.base_url == "http://127.0.0.1:3000/v1"
    assert effective.api_key == "sk-custom-secret"


def test_newapi_runtime_credentials_prefer_saved_custom_gateway(monkeypatch, tmp_path):
    _isolate_settings_db(monkeypatch, tmp_path)
    monkeypatch.setenv("NEWAPI_API_KEY", "sk-env-secret")
    monkeypatch.setenv("NEWAPI_BASE_URL", "https://env.example/v1")

    save_custom_newapi_gateway(
        base_url="http://127.0.0.1:3000",
        api_key="sk-custom-secret",
        admin_base_url="http://127.0.0.1:3000",
        token_name="dramaclaw-ce-runtime",
        token_id=3,
        activate=True,
    )

    api_key, base_url = config.get_newapi_runtime_credentials()

    assert api_key == "sk-custom-secret"
    assert base_url == "http://127.0.0.1:3000/v1"


def test_newapi_runtime_credentials_allow_explicit_override(monkeypatch, tmp_path):
    _isolate_settings_db(monkeypatch, tmp_path)
    save_custom_newapi_gateway(
        base_url="http://127.0.0.1:3000",
        api_key="sk-custom-secret",
        activate=True,
    )

    api_key, base_url = config.get_newapi_runtime_credentials(
        api_key_override="sk-request-secret",
        base_url_override="https://request.example/v1",
    )

    assert api_key == "sk-request-secret"
    assert base_url == "https://request.example/v1"


def test_cognee_newapi_resolution_prefers_saved_gateway(monkeypatch, tmp_path):
    _isolate_settings_db(monkeypatch, tmp_path)
    monkeypatch.delenv("COGNEE_LLM_PROVIDER", raising=False)
    monkeypatch.delenv("COGNEE_LLM_MODEL", raising=False)
    monkeypatch.delenv("NEWAPI_BASE_URL", raising=False)
    monkeypatch.setenv("NEWAPI_API_KEY", "sk-env-secret")

    save_custom_newapi_gateway(
        base_url="https://custom.example",
        api_key="sk-custom-secret",
        activate=True,
    )

    from novelvideo.cognee import config as cognee_config

    assert cognee_config._resolve_llm_provider() == "newapi"
    assert (
        cognee_config._resolve_llm_api_key("newapi", "openai/DC-model")
        == "sk-custom-secret"
    )
    assert (
        cognee_config._get_endpoint_env("newapi", "COGNEE_LLM_ENDPOINT", "LLM_ENDPOINT")
        == "https://custom.example/v1"
    )


def test_model_gateway_can_switch_back_to_official(monkeypatch, tmp_path):
    _isolate_settings_db(monkeypatch, tmp_path)
    save_custom_newapi_gateway(
        base_url="http://127.0.0.1:3000/v1",
        api_key="sk-custom-secret",
        activate=True,
    )
    set_model_gateway_mode(MODE_OFFICIAL)

    effective = get_effective_newapi_config(
        official_base_url="https://official.example/v1",
        official_api_key="sk-official-secret",
    )
    assert effective.mode == MODE_OFFICIAL
    assert effective.base_url == OFFICIAL_NEWAPI_BASE_URL
    assert effective.api_key == "sk-official-secret"

    status = build_model_gateway_status(
        official_base_url="https://official.example/v1",
        official_api_key="sk-official-secret",
    )
    assert status["custom"]["configured"] is True
    assert status["effective"]["source"] == "official"


def test_model_gateway_status_keeps_official_section_when_custom_is_active(
    monkeypatch,
    tmp_path,
):
    _isolate_settings_db(monkeypatch, tmp_path)
    save_official_newapi_key(
        api_key="sk-official-secret",
        activate=True,
    )
    save_custom_newapi_gateway(
        base_url="http://new-api:3000",
        api_key="sk-custom-secret",
        activate=True,
    )

    status = build_model_gateway_status(
        official_base_url="https://env.example/v1",
        official_api_key="sk-env-secret",
    )

    assert status["mode"] == MODE_CUSTOM
    assert status["effective"]["source"] == "custom"
    assert status["effective"]["baseUrl"] == "http://new-api:3000/v1"
    assert status["official"]["baseUrl"] == OFFICIAL_NEWAPI_BASE_URL
    assert status["official"]["source"] == "database"


def test_model_gateway_official_database_key_overrides_env(monkeypatch, tmp_path):
    _isolate_settings_db(monkeypatch, tmp_path)
    save_official_newapi_key(
        api_key="sk-user-official-secret",
        activate=True,
    )

    effective = get_effective_newapi_config(
        official_base_url="https://env-official.example/v1",
        official_api_key="sk-env-official-secret",
    )
    assert effective.mode == MODE_OFFICIAL
    assert effective.base_url == OFFICIAL_NEWAPI_BASE_URL
    assert effective.api_key == "sk-user-official-secret"

    status = build_model_gateway_status(
        official_base_url="https://env-official.example/v1",
        official_api_key="sk-env-official-secret",
    )
    assert status["official"]["source"] == "database"
    assert status["official"]["environment"]["configured"] is True


def test_model_gateway_official_url_ignores_newapi_base_url_env(monkeypatch, tmp_path):
    _isolate_settings_db(monkeypatch, tmp_path)
    monkeypatch.setenv("MODEL_GATEWAY_MODE", MODE_OFFICIAL)
    monkeypatch.setenv("NEWAPI_BASE_URL", "https://malicious.example/v1")
    monkeypatch.setenv("NEWAPI_API_KEY", "sk-env-secret")

    effective = get_effective_newapi_config()

    assert effective.mode == MODE_OFFICIAL
    assert effective.base_url == OFFICIAL_NEWAPI_BASE_URL
    assert effective.api_key == "sk-env-secret"


def test_newapi_base_url_normalizers_keep_admin_and_relay_urls_separate():
    assert normalize_admin_base_url("http://new-api:3000/v1") == "http://new-api:3000"
    assert normalize_admin_base_url("http://new-api:3000/") == "http://new-api:3000"
    assert normalize_relay_base_url("http://new-api:3000") == "http://new-api:3000/v1"
    assert (
        normalize_relay_base_url("http://new-api:3000/v1") == "http://new-api:3000/v1"
    )


def test_build_channel_payload_maps_dc_models_to_upstream_models():
    payload = build_channel_payload(
        provider="ali",
        name="user-supplied-name-is-ignored",
        upstream_key="sk-upstream",
        model_mapping={
            "DC-screenplay-normalizer-LLM": "qwen-plus",
            "DC-staging-prop-planner-LLM": "qwen-max",
        },
        group="default,drama",
        priority=2,
    )

    channel = payload["channel"]
    assert payload["mode"] == "single"
    assert channel["name"] == "DC-ali"
    assert channel["type"] == 17
    assert (
        channel["models"] == "DC-screenplay-normalizer-LLM,DC-staging-prop-planner-LLM"
    )
    assert channel["group"] == ",default,drama,"
    assert channel["test_model"] == "DC-screenplay-normalizer-LLM"
    assert channel["model_mapping"] == (
        '{"DC-screenplay-normalizer-LLM":"qwen-plus",'
        '"DC-staging-prop-planner-LLM":"qwen-max"}'
    )


@respx.mock
def test_ensure_newapi_setup_creates_root_when_instance_is_fresh():
    cfg = NewApiProvisionerConfig(
        admin_base_url="http://new-api:3000",
        sql_dsn="local",
        sqlite_path="/tmp/one-api.db",
        admin_username="root",
        init_timeout_ms=1000,
        relay_token_name="dramaclaw-ce-runtime",
    )
    respx.get("http://new-api:3000/api/setup").mock(
        side_effect=[
            Response(200, json={"success": True, "data": {"status": False}}),
            Response(
                200,
                json={
                    "success": True,
                    "data": {
                        "status": False,
                        "root_init": False,
                        "database_type": "postgres",
                    },
                },
            ),
            Response(200, json={"success": True, "data": {"status": True}}),
            Response(
                200,
                json={
                    "success": True,
                    "data": {
                        "status": True,
                        "root_init": True,
                        "database_type": "postgres",
                    },
                },
            ),
        ]
    )
    setup_request = respx.post("http://new-api:3000/api/setup").mock(
        return_value=Response(200, json={"success": True})
    )

    status = ensure_newapi_setup(
        cfg,
        NewApiSetupCredentials(
            username="admin",
            password="strongpass",
            confirm_password="strongpass",
        ),
    )

    assert status.initialized is True
    assert status.root_initialized is True
    assert status.setup_performed is True
    assert status.already_initialized is False
    assert setup_request.calls.last.request.content
    assert json.loads(setup_request.calls.last.request.content) == {
        "SelfUseModeEnabled": True,
        "DemoSiteEnabled": False,
        "username": "admin",
        "password": "strongpass",
        "confirmPassword": "strongpass",
    }


@respx.mock
def test_ensure_newapi_setup_requires_credentials_for_fresh_instance():
    cfg = NewApiProvisionerConfig(
        admin_base_url="http://new-api:3000",
        sql_dsn="local",
        sqlite_path="/tmp/one-api.db",
        admin_username="root",
        init_timeout_ms=1000,
        relay_token_name="dramaclaw-ce-runtime",
    )
    respx.get("http://new-api:3000/api/setup").mock(
        side_effect=[
            Response(200, json={"success": True, "data": {"status": False}}),
            Response(
                200,
                json={
                    "success": True,
                    "data": {
                        "status": False,
                        "root_init": False,
                        "database_type": "postgres",
                    },
                },
            ),
        ]
    )

    with pytest.raises(ValueError, match="setupUsername"):
        ensure_newapi_setup(cfg, NewApiSetupCredentials(username="admin"))


@respx.mock
def test_ensure_newapi_setup_finishes_setup_when_root_already_exists():
    cfg = NewApiProvisionerConfig(
        admin_base_url="http://new-api:3000",
        sql_dsn="local",
        sqlite_path="/tmp/one-api.db",
        admin_username="root",
        init_timeout_ms=1000,
        relay_token_name="dramaclaw-ce-runtime",
    )
    respx.get("http://new-api:3000/api/setup").mock(
        side_effect=[
            Response(200, json={"success": True, "data": {"status": False}}),
            Response(
                200,
                json={
                    "success": True,
                    "data": {
                        "status": False,
                        "root_init": True,
                        "database_type": "postgres",
                    },
                },
            ),
            Response(200, json={"success": True, "data": {"status": True}}),
            Response(
                200,
                json={
                    "success": True,
                    "data": {
                        "status": True,
                        "root_init": True,
                        "database_type": "postgres",
                    },
                },
            ),
        ]
    )
    setup_request = respx.post("http://new-api:3000/api/setup").mock(
        return_value=Response(200, json={"success": True})
    )

    status = ensure_newapi_setup(cfg)

    assert status.initialized is True
    assert status.setup_performed is True
    assert status.already_initialized is False
    assert json.loads(setup_request.calls.last.request.content) == {
        "SelfUseModeEnabled": True,
        "DemoSiteEnabled": False,
    }


@respx.mock
def test_ensure_newapi_setup_skips_post_when_instance_is_initialized():
    cfg = NewApiProvisionerConfig(
        admin_base_url="http://new-api:3000",
        sql_dsn="local",
        sqlite_path="/tmp/one-api.db",
        admin_username="root",
        init_timeout_ms=1000,
        relay_token_name="dramaclaw-ce-runtime",
    )
    respx.get("http://new-api:3000/api/setup").mock(
        side_effect=[
            Response(200, json={"success": True, "data": {"status": True}}),
            Response(
                200,
                json={
                    "success": True,
                    "data": {
                        "status": True,
                        "root_init": True,
                        "database_type": "postgres",
                    },
                },
            ),
        ]
    )
    setup_request = respx.post("http://new-api:3000/api/setup").mock(
        return_value=Response(200, json={"success": True})
    )

    status = ensure_newapi_setup(
        cfg,
        NewApiSetupCredentials(
            username="root",
            password="strongpass",
            confirm_password="strongpass",
        ),
    )

    assert status.initialized is True
    assert status.root_initialized is True
    assert status.setup_performed is False
    assert status.already_initialized is True
    assert not setup_request.called


@respx.mock
def test_upsert_channel_merges_existing_dc_provider_channel():
    cfg = NewApiProvisionerConfig(
        admin_base_url="http://new-api:3000",
        sql_dsn="local",
        sqlite_path="/tmp/one-api.db",
        admin_username="root",
        init_timeout_ms=1000,
        relay_token_name="dramaclaw-ce-runtime",
    )
    admin = AdminToken(
        admin_user_id=1,
        admin_username="root",
        access_token="admin-secret",
        token_created=False,
    )
    payload = build_channel_payload(
        provider="ali",
        upstream_key="sk-upstream-new",
        model_mapping={"DC-screenplay-normalizer-LLM": "qwen-plus"},
        base_url="https://dashscope-new.example.com",
    )

    respx.get("http://new-api:3000/api/channel/").mock(
        return_value=Response(
            200,
            json={
                "success": True,
                "data": {
                    "items": [{"id": 3, "name": "DC-ali", "type": 17}],
                    "total": 1,
                },
            },
        )
    )
    respx.get("http://new-api:3000/api/channel/3").mock(
        return_value=Response(
            200,
            json={
                "success": True,
                "data": {
                    "id": 3,
                    "name": "DC-ali",
                    "type": 17,
                    "key": "sk-upstream-old",
                    "base_url": "https://dashscope-old.example.com",
                    "models": "DC-old-model",
                    "model_mapping": json.dumps({"DC-old-model": "qwen-old"}),
                    "group": ",default,",
                    "status": 1,
                },
            },
        )
    )
    update_route = respx.put("http://new-api:3000/api/channel/").mock(
        return_value=Response(200, json={"success": True})
    )

    result = upsert_channel(cfg, admin, payload)

    assert result["ok"] is True
    assert result["action"] == "update"
    assert result["channelId"] == 3
    channel = json.loads(update_route.calls.last.request.content)
    assert channel["id"] == 3
    assert channel["name"] == "DC-ali"
    assert channel["key"] == "sk-upstream-new"
    assert channel["base_url"] == "https://dashscope-new.example.com"
    assert channel["models"] == "DC-old-model,DC-screenplay-normalizer-LLM"
    assert json.loads(channel["model_mapping"]) == {
        "DC-old-model": "qwen-old",
        "DC-screenplay-normalizer-LLM": "qwen-plus",
    }


@respx.mock
def test_update_provider_channel_credentials_preserves_models_and_mapping():
    cfg = NewApiProvisionerConfig(
        admin_base_url="http://new-api:3000",
        sql_dsn="local",
        sqlite_path="/tmp/one-api.db",
        admin_username="root",
        init_timeout_ms=1000,
        relay_token_name="dramaclaw-ce-runtime",
    )
    admin = AdminToken(
        admin_user_id=1,
        admin_username="root",
        access_token="admin-secret",
        token_created=False,
    )

    respx.get("http://new-api:3000/api/channel/").mock(
        return_value=Response(
            200,
            json={
                "success": True,
                "data": {
                    "items": [{"id": 3, "name": "DC-ali", "type": 17}],
                    "total": 1,
                },
            },
        )
    )
    respx.get("http://new-api:3000/api/channel/3").mock(
        return_value=Response(
            200,
            json={
                "success": True,
                "data": {
                    "id": 3,
                    "name": "DC-ali",
                    "type": 17,
                    "key": "sk-upstream-old",
                    "base_url": "https://dashscope-old.example.com",
                    "models": "DC-old-model,DC-screenplay-normalizer-LLM",
                    "model_mapping": json.dumps(
                        {
                            "DC-old-model": "qwen-old",
                            "DC-screenplay-normalizer-LLM": "qwen-plus",
                        }
                    ),
                    "group": ",default,",
                    "priority": 2,
                    "weight": 3,
                    "test_model": "DC-old-model",
                },
            },
        )
    )
    update_route = respx.put("http://new-api:3000/api/channel/").mock(
        return_value=Response(200, json={"success": True})
    )

    result = update_provider_channel_credentials(
        cfg,
        admin,
        provider="ali",
        upstream_key="sk-upstream-new",
        base_url="https://dashscope-new.example.com/",
    )

    assert result["ok"] is True
    assert result["action"] == "update"
    assert result["channelId"] == 3
    channel = json.loads(update_route.calls.last.request.content)
    assert channel["key"] == "sk-upstream-new"
    assert channel["base_url"] == "https://dashscope-new.example.com"
    assert channel["models"] == "DC-old-model,DC-screenplay-normalizer-LLM"
    assert json.loads(channel["model_mapping"]) == {
        "DC-old-model": "qwen-old",
        "DC-screenplay-normalizer-LLM": "qwen-plus",
    }
    assert channel["priority"] == 2
    assert channel["weight"] == 3
    assert channel["test_model"] == "DC-old-model"


@respx.mock
def test_update_provider_channel_credentials_clears_base_url_override():
    cfg = NewApiProvisionerConfig(
        admin_base_url="http://new-api:3000",
        sql_dsn="local",
        sqlite_path="/tmp/one-api.db",
        admin_username="root",
        init_timeout_ms=1000,
        relay_token_name="dramaclaw-ce-runtime",
    )
    admin = AdminToken(
        admin_user_id=1,
        admin_username="root",
        access_token="admin-secret",
        token_created=False,
    )

    respx.get("http://new-api:3000/api/channel/").mock(
        return_value=Response(
            200,
            json={
                "success": True,
                "data": {
                    "items": [{"id": 3, "name": "DC-ali", "type": 17}],
                    "total": 1,
                },
            },
        )
    )
    respx.get("http://new-api:3000/api/channel/3").mock(
        return_value=Response(
            200,
            json={
                "success": True,
                "data": {
                    "id": 3,
                    "name": "DC-ali",
                    "type": 17,
                    "key": "sk-upstream-old",
                    "base_url": "https://dashscope-old.example.com",
                    "models": "DC-old-model",
                    "model_mapping": json.dumps({"DC-old-model": "qwen-old"}),
                    "group": ",default,",
                    "test_model": "DC-old-model",
                },
            },
        )
    )
    update_route = respx.put("http://new-api:3000/api/channel/").mock(
        return_value=Response(200, json={"success": True})
    )

    result = update_provider_channel_credentials(
        cfg,
        admin,
        provider="ali",
        upstream_key="sk-upstream-new",
        base_url="",
    )

    assert result["ok"] is True
    channel = json.loads(update_route.calls.last.request.content)
    assert channel["key"] == "sk-upstream-new"
    assert channel["base_url"] == ""
    assert channel["models"] == "DC-old-model"
    assert json.loads(channel["model_mapping"]) == {"DC-old-model": "qwen-old"}


@respx.mock
def test_upsert_channel_removes_same_dc_model_from_other_provider_channels():
    cfg = NewApiProvisionerConfig(
        admin_base_url="http://new-api:3000",
        sql_dsn="local",
        sqlite_path="/tmp/one-api.db",
        admin_username="root",
        init_timeout_ms=1000,
        relay_token_name="dramaclaw-ce-runtime",
    )
    admin = AdminToken(
        admin_user_id=1,
        admin_username="root",
        access_token="admin-secret",
        token_created=False,
    )
    payload = build_channel_payload(
        provider="openrouter",
        upstream_key="sk-openrouter",
        model_mapping={"DC-hermes-LLM": "google/gemini-2.5-flash"},
    )

    respx.get("http://new-api:3000/api/channel/").mock(
        side_effect=[
            Response(
                200,
                json={
                    "success": True,
                    "data": {
                        "items": [
                            {"id": 4, "name": "DC-openrouter", "type": 20},
                            {"id": 3, "name": "DC-ali", "type": 17},
                        ],
                    },
                },
            ),
            Response(
                200,
                json={
                    "success": True,
                    "data": {
                        "items": [
                            {"id": 4, "name": "DC-openrouter", "type": 20},
                            {"id": 3, "name": "DC-ali", "type": 17},
                        ],
                    },
                },
            ),
        ]
    )
    respx.get("http://new-api:3000/api/channel/4").mock(
        return_value=Response(
            200,
            json={
                "success": True,
                "data": {
                    "id": 4,
                    "name": "DC-openrouter",
                    "type": 20,
                    "key": "sk-old-openrouter",
                    "base_url": "https://openrouter.ai/api",
                    "models": "DC-old-openrouter-model",
                    "model_mapping": json.dumps(
                        {"DC-old-openrouter-model": "openrouter/old"}
                    ),
                    "group": ",default,",
                    "status": 1,
                },
            },
        )
    )
    respx.get("http://new-api:3000/api/channel/3").mock(
        return_value=Response(
            200,
            json={
                "success": True,
                "data": {
                    "id": 3,
                    "name": "DC-ali",
                    "type": 17,
                    "key": "sk-ali",
                    "base_url": "https://dashscope.aliyuncs.com",
                    "models": "DC-hermes-LLM,DC-screenplay-normalizer-LLM",
                    "model_mapping": json.dumps(
                        {
                            "DC-hermes-LLM": "qwen-plus",
                            "DC-screenplay-normalizer-LLM": "qwen-max",
                        }
                    ),
                    "group": ",default,",
                    "status": 1,
                    "test_model": "DC-hermes-LLM",
                },
            },
        )
    )
    update_route = respx.put("http://new-api:3000/api/channel/").mock(
        return_value=Response(200, json={"success": True})
    )

    result = upsert_channel(cfg, admin, payload)

    assert result["ok"] is True
    assert result["action"] == "update"
    assert result["dedupedChannels"] == [
        {
            "channelId": 3,
            "name": "DC-ali",
            "ok": True,
            "httpStatus": 200,
            "removedModels": ["DC-hermes-LLM"],
        }
    ]
    target_update = json.loads(update_route.calls[0].request.content)
    assert target_update["id"] == 4
    assert json.loads(target_update["model_mapping"]) == {
        "DC-old-openrouter-model": "openrouter/old",
        "DC-hermes-LLM": "google/gemini-2.5-flash",
    }
    stale_update = json.loads(update_route.calls[1].request.content)
    assert stale_update["id"] == 3
    assert stale_update["models"] == "DC-screenplay-normalizer-LLM"
    assert stale_update["test_model"] == "DC-screenplay-normalizer-LLM"
    assert json.loads(stale_update["model_mapping"]) == {
        "DC-screenplay-normalizer-LLM": "qwen-max",
    }


def test_provisioner_enabled_by_default_and_can_be_disabled(monkeypatch):
    monkeypatch.delenv("NEWAPI_PROVISIONER_ENABLED", raising=False)
    require_provisioner_enabled()

    monkeypatch.setenv("NEWAPI_PROVISIONER_ENABLED", "false")
    with pytest.raises(PermissionError, match="not enabled"):
        require_provisioner_enabled()

    monkeypatch.setenv("NEWAPI_PROVISIONER_ENABLED", "true")
    require_provisioner_enabled()


def test_newapi_db_defaults_to_managed_ce_sqlite_and_does_not_create_empty_file(
    monkeypatch,
    tmp_path,
):
    _isolate_settings_db(monkeypatch, tmp_path)
    monkeypatch.chdir(tmp_path)
    monkeypatch.delenv("NEWAPI_SQL_DSN", raising=False)
    monkeypatch.delenv("NEWAPI_SQLITE_PATH", raising=False)

    cfg = model_gateway.get_provisioner_config()

    assert cfg.admin_base_url == "http://127.0.0.1:3000"
    assert cfg.sql_dsn == "local"
    assert cfg.sqlite_path == str(tmp_path / "state" / "newapi" / "one-api.db")
    with pytest.raises(RuntimeError, match="does not exist"):
        open_newapi_db(cfg)

    assert not (tmp_path / "state" / "newapi" / "one-api.db").exists()


def test_newapi_db_rejects_missing_sqlite_file(monkeypatch, tmp_path):
    _isolate_settings_db(monkeypatch, tmp_path)
    missing = tmp_path / "missing-one-api.db"
    monkeypatch.setenv("NEWAPI_SQL_DSN", "local")
    monkeypatch.setenv("NEWAPI_SQLITE_PATH", str(missing))

    with pytest.raises(RuntimeError, match="does not exist"):
        open_newapi_db(model_gateway.get_provisioner_config())

    assert not missing.exists()


def test_provisioner_config_prefers_saved_database_settings(monkeypatch, tmp_path):
    _isolate_settings_db(monkeypatch, tmp_path)
    monkeypatch.setenv(
        "NEWAPI_SQL_DSN", "postgresql://env:envpass@127.0.0.1:5432/envdb"
    )
    monkeypatch.setenv("NEWAPI_SQLITE_PATH", "/env/one-api.db")
    monkeypatch.setenv("NEWAPI_ADMIN_USERNAME", "env-root")
    monkeypatch.setenv("NEWAPI_ADMIN_BASE_URL", "http://env-new-api:3000")
    save_custom_newapi_gateway(
        base_url="http://saved-new-api:3000/v1",
        api_key="sk-custom-secret",
        admin_base_url="http://saved-new-api:3000",
        activate=True,
    )
    save_newapi_database_config(
        sql_dsn="local",
        sqlite_path="/saved/one-api.db",
        admin_username="saved-root",
    )

    cfg = get_provisioner_config()

    assert cfg.admin_base_url == "http://saved-new-api:3000"
    assert cfg.sql_dsn == "local"
    assert cfg.sqlite_path == "/saved/one-api.db"
    assert cfg.admin_username == "saved-root"


def test_provisioner_config_request_database_overrides_saved_settings(
    monkeypatch, tmp_path
):
    _isolate_settings_db(monkeypatch, tmp_path)
    save_newapi_database_config(
        sql_dsn="local",
        sqlite_path="/saved/one-api.db",
        admin_username="saved-root",
    )

    cfg = get_provisioner_config(
        "http://request-new-api:3000",
        sql_dsn="postgresql://request:secret@127.0.0.1:5432/newapi",
        sqlite_path="",
        admin_username="request-root",
    )

    assert cfg.admin_base_url == "http://request-new-api:3000"
    assert cfg.sql_dsn == "postgresql://request:secret@127.0.0.1:5432/newapi"
    assert cfg.sqlite_path == ""
    assert cfg.admin_username == "request-root"


def test_database_status_does_not_expose_database_credentials(monkeypatch, tmp_path):
    _isolate_settings_db(monkeypatch, tmp_path)
    save_newapi_database_config(
        sql_dsn="postgresql://root:secret@127.0.0.1:5432/newapi",
        admin_username="root",
    )

    status = build_newapi_database_status()

    assert status["configured"] is True
    assert status["source"] == "database"
    assert status["databaseType"] == "external"
    assert "sqlDsnPreview" not in status
    assert "sqlitePath" not in status
    assert "adminUsername" not in status
    assert "secret" not in str(status)


def test_model_gateway_config_route_masks_effective_key(monkeypatch, tmp_path):
    _isolate_settings_db(monkeypatch, tmp_path)
    monkeypatch.setattr(
        model_gateway.app_config, "NEWAPI_BASE_URL", "https://official.example/v1"
    )
    monkeypatch.setattr(
        model_gateway.app_config, "NEWAPI_API_KEY", "sk-official-secret"
    )

    app = FastAPI()
    app.include_router(model_gateway.router)
    client = TestClient(app)

    response = client.get("/model-gateway/config")

    assert response.status_code == 200
    data = response.json()["data"]
    assert data["mode"] == MODE_OFFICIAL
    assert data["effective"]["apiKeyPreview"] == "sk-o...cret"
    assert "sk-official-secret" not in response.text


def test_model_gateway_config_excludes_closed_source_provider_presets(
    monkeypatch, tmp_path
):
    _isolate_settings_db(monkeypatch, tmp_path)

    app = FastAPI()
    app.include_router(model_gateway.router)
    client = TestClient(app)

    response = client.get("/model-gateway/config")

    assert response.status_code == 200
    providers = response.json()["data"]["provisioner"]["providers"]
    assert "ali" in providers
    assert "openrouter" in providers
    assert "deepseek" in providers
    assert "openai" in providers
    assert providers["azure"]["type"] == 3
    assert providers["gemini"]["type"] == 24
    assert providers["volcengine"]["type"] == 45
    assert providers["codex"]["type"] == 57
    assert "huimeng" not in providers
    assert "fal" not in providers


def test_enable_official_gateway_route_switches_mode_when_enabled(
    monkeypatch, tmp_path
):
    _isolate_settings_db(monkeypatch, tmp_path)
    monkeypatch.setenv("NEWAPI_PROVISIONER_ENABLED", "true")
    monkeypatch.setattr(
        model_gateway.app_config, "NEWAPI_BASE_URL", "https://official.example/v1"
    )
    monkeypatch.setattr(
        model_gateway.app_config, "NEWAPI_API_KEY", "sk-official-secret"
    )
    save_custom_newapi_gateway(
        base_url="http://new-api:3000",
        api_key="sk-custom-secret",
        activate=True,
    )

    app = FastAPI()
    app.include_router(model_gateway.router)
    client = TestClient(app)

    response = client.post("/model-gateway/official/enable")

    assert response.status_code == 200
    assert response.json()["data"]["mode"] == MODE_OFFICIAL
    assert (
        get_effective_newapi_config(
            official_base_url="https://official.example/v1",
            official_api_key="sk-official-secret",
        ).mode
        == MODE_OFFICIAL
    )


def test_save_official_gateway_route_persists_user_registered_key(
    monkeypatch, tmp_path
):
    _isolate_settings_db(monkeypatch, tmp_path)
    monkeypatch.setenv("NEWAPI_PROVISIONER_ENABLED", "true")
    monkeypatch.setattr(
        model_gateway.app_config, "NEWAPI_BASE_URL", "https://env.example/v1"
    )
    monkeypatch.setattr(model_gateway.app_config, "NEWAPI_API_KEY", "sk-env-secret")

    app = FastAPI()
    app.include_router(model_gateway.router)
    client = TestClient(app)

    response = client.post(
        "/model-gateway/official/config",
        json={
            "newApiApiKey": "sk-user-registered-secret",
        },
    )

    assert response.status_code == 200
    data = response.json()["data"]
    assert data["mode"] == MODE_OFFICIAL
    assert data["official"]["baseUrl"] == OFFICIAL_NEWAPI_BASE_URL
    assert data["official"]["source"] == "database"
    assert data["official"]["apiKeyPreview"] == "sk-u...cret"
    assert "sk-user-registered-secret" not in response.text

    effective = get_effective_newapi_config(
        official_base_url="https://env.example/v1",
        official_api_key="sk-env-secret",
    )
    assert effective.base_url == OFFICIAL_NEWAPI_BASE_URL
    assert effective.api_key == "sk-user-registered-secret"


def test_save_official_gateway_route_ignores_submitted_gateway_url(
    monkeypatch, tmp_path
):
    _isolate_settings_db(monkeypatch, tmp_path)
    monkeypatch.setenv("NEWAPI_PROVISIONER_ENABLED", "true")
    monkeypatch.setattr(
        model_gateway.app_config, "NEWAPI_BASE_URL", "https://env.example/v1"
    )
    monkeypatch.setattr(model_gateway.app_config, "NEWAPI_API_KEY", "sk-env-secret")

    app = FastAPI()
    app.include_router(model_gateway.router)
    client = TestClient(app)

    response = client.post(
        "/model-gateway/official/config",
        json={
            "newApiBaseUrl": "https://official-user.example",
            "newApiApiKey": "sk-user-registered-secret",
        },
    )

    assert response.status_code == 200
    assert response.json()["data"]["official"]["baseUrl"] == OFFICIAL_NEWAPI_BASE_URL
    effective = get_effective_newapi_config(
        official_base_url="https://env.example/v1",
        official_api_key="sk-env-secret",
    )
    assert effective.base_url == OFFICIAL_NEWAPI_BASE_URL
    assert effective.api_key == "sk-user-registered-secret"


def test_custom_newapi_init_route_accepts_empty_body(monkeypatch, tmp_path):
    _isolate_settings_db(monkeypatch, tmp_path)
    monkeypatch.setenv("NEWAPI_PROVISIONER_ENABLED", "true")
    calls = {}

    class Admin:
        admin_user_id = 1
        admin_username = "root"
        token_created = False
        access_token = "admin-secret"

    def fake_get_config(base_url=None, **_kwargs):
        calls["base_url"] = base_url
        return type(
            "Cfg",
            (),
            {
                "admin_base_url": "http://new-api:3000",
                "relay_token_name": "dramaclaw-ce-runtime",
            },
        )()

    monkeypatch.setattr(model_gateway, "get_provisioner_config", fake_get_config)
    monkeypatch.setattr(
        model_gateway,
        "ensure_newapi_setup",
        lambda *_args, **_kwargs: type(
            "SetupStatus",
            (),
            {
                "initialized": True,
                "root_initialized": True,
                "database_type": "sqlite",
                "setup_performed": False,
                "already_initialized": True,
            },
        )(),
    )
    monkeypatch.setattr(
        model_gateway, "ensure_admin_access_token", lambda _cfg: Admin()
    )
    monkeypatch.setattr(
        model_gateway,
        "create_or_reuse_relay_token",
        lambda *_args, **_kwargs: {
            "created": False,
            "tokenId": 2,
            "name": "dramaclaw-ce-runtime",
            "key": "sk-runtime-secret",
            "keyPreview": "sk-r...cret",
        },
    )

    app = FastAPI()
    app.include_router(model_gateway.router)
    client = TestClient(app)

    response = client.post("/model-gateway/custom/newapi/init")

    assert response.status_code == 200
    data = response.json()["data"]
    assert calls["base_url"] is None
    assert data["mode"] == MODE_CUSTOM
    assert data["newApiAdminBaseUrl"] == "http://new-api:3000"
    assert data["newApiBaseUrl"] == "http://new-api:3000/v1"
    assert "sk-runtime-secret" not in response.text


def test_custom_newapi_init_route_persists_request_database_config(
    monkeypatch, tmp_path
):
    _isolate_settings_db(monkeypatch, tmp_path)
    monkeypatch.setenv("NEWAPI_PROVISIONER_ENABLED", "true")
    calls = {}

    class Admin:
        admin_user_id = 1
        admin_username = "root"
        token_created = False
        access_token = "admin-secret"

    def fake_get_config(base_url=None, **kwargs):
        calls["base_url"] = base_url
        calls["kwargs"] = kwargs
        return type(
            "Cfg",
            (),
            {
                "admin_base_url": "http://new-api:3000",
                "relay_token_name": "dramaclaw-ce-runtime",
                "sql_dsn": kwargs["sql_dsn"],
                "sqlite_path": kwargs["sqlite_path"],
                "admin_username": kwargs["admin_username"],
            },
        )()

    monkeypatch.setattr(model_gateway, "get_provisioner_config", fake_get_config)
    monkeypatch.setattr(
        model_gateway,
        "ensure_newapi_setup",
        lambda *_args, **_kwargs: type(
            "SetupStatus",
            (),
            {
                "initialized": True,
                "root_initialized": True,
                "database_type": "sqlite",
                "setup_performed": False,
                "already_initialized": True,
            },
        )(),
    )
    monkeypatch.setattr(
        model_gateway, "ensure_admin_access_token", lambda _cfg: Admin()
    )
    monkeypatch.setattr(
        model_gateway,
        "create_or_reuse_relay_token",
        lambda *_args, **_kwargs: {
            "created": True,
            "tokenId": 7,
            "name": "dramaclaw-ce-runtime",
            "key": "sk-runtime-secret",
            "keyPreview": "sk-r...cret",
        },
    )

    app = FastAPI()
    app.include_router(model_gateway.router)
    client = TestClient(app)

    response = client.post(
        "/model-gateway/custom/newapi/init",
        json={
            "newApiBaseUrl": "http://new-api:3000",
            "database": {
                "sqlDsn": "local",
                "sqlitePath": "/Users/hg/data/new-api/one-api.db",
                "adminUsername": "root",
            },
        },
    )

    assert response.status_code == 200
    assert calls["base_url"] == "http://new-api:3000"
    assert calls["kwargs"] == {
        "sql_dsn": "local",
        "sqlite_path": "/Users/hg/data/new-api/one-api.db",
        "admin_username": "root",
    }
    data = response.json()["data"]
    assert data["database"]["configured"] is True
    assert data["database"]["source"] == "database"
    assert data["database"]["databaseType"] == "sqlite"
    assert "sqlitePath" not in data["database"]
    cfg = get_provisioner_config()
    assert cfg.sql_dsn == "local"
    assert cfg.sqlite_path == "/Users/hg/data/new-api/one-api.db"
    assert cfg.admin_username == "root"
    assert cfg.admin_base_url == "http://new-api:3000"


def test_custom_newapi_channels_batch_reuses_admin_and_masks_keys(
    monkeypatch, tmp_path
):
    _isolate_settings_db(monkeypatch, tmp_path)
    monkeypatch.setenv("NEWAPI_PROVISIONER_ENABLED", "true")
    calls: dict[str, list[object] | int] = {"payloads": [], "ensure_admin": 0}

    class Admin:
        admin_user_id = 1
        admin_username = "root"
        token_created = False
        access_token = "admin-secret"

    def fake_get_config(base_url=None, **_kwargs):
        assert base_url == "http://new-api:3000"
        return type("Cfg", (), {"admin_base_url": "http://new-api:3000"})()

    def fake_ensure_admin(_cfg):
        calls["ensure_admin"] = int(calls["ensure_admin"]) + 1
        return Admin()

    def fake_upsert_channel(_cfg, _admin, payload):
        calls["payloads"].append(payload)
        return {
            "ok": True,
            "httpStatus": 200,
            "newApiResponse": {"success": True},
            "action": "create",
            "channelId": None,
        }

    monkeypatch.setattr(model_gateway, "get_provisioner_config", fake_get_config)
    monkeypatch.setattr(model_gateway, "ensure_admin_access_token", fake_ensure_admin)
    monkeypatch.setattr(model_gateway, "upsert_channel", fake_upsert_channel)

    app = FastAPI()
    app.include_router(model_gateway.router)
    client = TestClient(app)

    response = client.post(
        "/model-gateway/custom/newapi/channels/batch",
        json={
            "newApiBaseUrl": "http://new-api:3000",
            "channels": [
                {
                    "provider": "ali",
                    "name": "ali-text",
                    "upstreamKey": "sk-upstream-one",
                    "modelMapping": {"DC-screenplay-normalizer-LLM": "qwen-plus"},
                },
                {
                    "provider": "deepseek",
                    "name": "deepseek-text",
                    "upstreamKey": "sk-upstream-two",
                    "modelMapping": {"DC-hermes-LLM": "deepseek-chat"},
                    "priority": 3,
                },
            ],
        },
    )

    assert response.status_code == 200
    data = response.json()["data"]
    assert response.json()["ok"] is True
    assert data["succeeded"] == 2
    assert data["failed"] == 0
    assert calls["ensure_admin"] == 1
    assert len(calls["payloads"]) == 2
    assert (
        data["results"][0]["sentPayload"]["channel"]["models"]
        == "DC-screenplay-normalizer-LLM"
    )
    assert data["results"][1]["sentPayload"]["channel"]["type"] == 43
    assert "sk-upstream-one" not in response.text
    assert "sk-upstream-two" not in response.text


def test_custom_newapi_provider_channels_route_persists_and_masks_keys(
    monkeypatch,
    tmp_path,
):
    _isolate_settings_db(monkeypatch, tmp_path)
    monkeypatch.setenv("NEWAPI_PROVISIONER_ENABLED", "true")

    app = FastAPI()
    app.include_router(model_gateway.router)
    client = TestClient(app)

    response = client.post(
        "/model-gateway/custom/newapi/provider-channels",
        json={
            "channels": [
                {
                    "provider": "ali",
                    "upstreamKey": "sk-ali-upstream-secret",
                    "baseUrl": "https://dashscope.example.com/",
                },
                {
                    "provider": "deepseek",
                    "upstreamKey": "sk-deepseek-upstream-secret",
                },
            ]
        },
    )

    assert response.status_code == 200
    assert response.json()["ok"] is True
    assert "sk-ali-upstream-secret" not in response.text
    assert "sk-deepseek-upstream-secret" not in response.text

    config_response = client.get("/model-gateway/config")
    channels = config_response.json()["data"]["provisioner"]["providerChannels"]
    assert channels == [
        {
            "provider": "ali",
            "configured": True,
            "upstreamKeyPreview": "sk-a...cret",
            "baseUrl": "https://dashscope.example.com",
        },
        {
            "provider": "deepseek",
            "configured": True,
            "upstreamKeyPreview": "sk-d...cret",
            "baseUrl": "",
        },
    ]
    assert "sk-ali-upstream-secret" not in config_response.text
    assert "sk-deepseek-upstream-secret" not in config_response.text


def test_custom_newapi_provider_channel_sync_updates_newapi_and_local_config(
    monkeypatch,
    tmp_path,
):
    _isolate_settings_db(monkeypatch, tmp_path)
    monkeypatch.setenv("NEWAPI_PROVISIONER_ENABLED", "true")

    class Admin:
        admin_user_id = 1
        admin_username = "root"
        token_created = False
        access_token = "admin-secret"

    calls: dict[str, object] = {}

    monkeypatch.setattr(
        model_gateway,
        "get_provisioner_config",
        lambda _base_url=None, **_kwargs: type(
            "Cfg",
            (),
            {"admin_base_url": "http://new-api:3000"},
        )(),
    )
    monkeypatch.setattr(
        model_gateway, "ensure_admin_access_token", lambda _cfg: Admin()
    )

    def fake_update_credentials(_cfg, _admin, *, provider, upstream_key, base_url=None):
        calls["provider"] = provider
        calls["upstream_key"] = upstream_key
        calls["base_url"] = base_url
        return {
            "ok": True,
            "httpStatus": 200,
            "newApiResponse": {"success": True},
            "sentPayload": {
                "mode": "single",
                "channel": {
                    "id": 7,
                    "name": "DC-ali",
                    "key": upstream_key,
                    "base_url": base_url,
                },
            },
            "channelId": 7,
        }

    monkeypatch.setattr(
        model_gateway,
        "update_provider_channel_credentials",
        fake_update_credentials,
    )

    app = FastAPI()
    app.include_router(model_gateway.router)
    client = TestClient(app)

    response = client.post(
        "/model-gateway/custom/newapi/provider-channel/sync",
        json={
            "newApiBaseUrl": "http://new-api:3000",
            "provider": "ali",
            "upstreamKey": "sk-ali-new-upstream-secret",
            "baseUrl": "https://dashscope-new.example.com/",
        },
    )

    assert response.status_code == 200
    assert response.json()["ok"] is True
    assert calls == {
        "provider": "ali",
        "upstream_key": "sk-ali-new-upstream-secret",
        "base_url": "https://dashscope-new.example.com/",
    }
    assert "sk-ali-new-upstream-secret" not in response.text
    assert response.json()["data"]["savedChannel"] == {
        "provider": "ali",
        "configured": True,
        "upstreamKeyPreview": "sk-a...cret",
        "baseUrl": "https://dashscope-new.example.com",
    }

    config_response = client.get("/model-gateway/config")
    channels = config_response.json()["data"]["provisioner"]["providerChannels"]
    assert channels == [
        {
            "provider": "ali",
            "configured": True,
            "upstreamKeyPreview": "sk-a...cret",
            "baseUrl": "https://dashscope-new.example.com",
        }
    ]
    assert "sk-ali-new-upstream-secret" not in config_response.text


def test_custom_newapi_provider_channel_sync_allows_clearing_saved_base_url(
    monkeypatch,
    tmp_path,
):
    _isolate_settings_db(monkeypatch, tmp_path)
    monkeypatch.setenv("NEWAPI_PROVISIONER_ENABLED", "true")
    save_newapi_provider_channels(
        [
            {
                "provider": "ali",
                "upstreamKey": "sk-ali-old-upstream-secret",
                "baseUrl": "https://dashscope-old.example.com",
            }
        ]
    )

    class Admin:
        admin_user_id = 1
        admin_username = "root"
        token_created = False
        access_token = "admin-secret"

    calls: dict[str, object] = {}

    monkeypatch.setattr(
        model_gateway,
        "get_provisioner_config",
        lambda _base_url=None, **_kwargs: type(
            "Cfg",
            (),
            {"admin_base_url": "http://new-api:3000"},
        )(),
    )
    monkeypatch.setattr(
        model_gateway, "ensure_admin_access_token", lambda _cfg: Admin()
    )

    def fake_update_credentials(_cfg, _admin, *, provider, upstream_key, base_url=None):
        calls["provider"] = provider
        calls["upstream_key"] = upstream_key
        calls["base_url"] = base_url
        return {
            "ok": True,
            "httpStatus": 200,
            "newApiResponse": {"success": True},
            "sentPayload": {
                "mode": "single",
                "channel": {
                    "id": 7,
                    "name": "DC-ali",
                    "key": upstream_key,
                    "base_url": base_url,
                },
            },
            "channelId": 7,
        }

    monkeypatch.setattr(
        model_gateway,
        "update_provider_channel_credentials",
        fake_update_credentials,
    )

    app = FastAPI()
    app.include_router(model_gateway.router)
    client = TestClient(app)

    response = client.post(
        "/model-gateway/custom/newapi/provider-channel/sync",
        json={
            "newApiBaseUrl": "http://new-api:3000",
            "provider": "ali",
            "upstreamKey": "sk-ali-new-upstream-secret",
            "baseUrl": "",
        },
    )

    assert response.status_code == 200
    assert response.json()["ok"] is True
    assert calls == {
        "provider": "ali",
        "upstream_key": "sk-ali-new-upstream-secret",
        "base_url": "",
    }
    assert "https://dashscope-old.example.com" not in response.text

    config_response = client.get("/model-gateway/config")
    channels = config_response.json()["data"]["provisioner"]["providerChannels"]
    assert channels == [
        {
            "provider": "ali",
            "configured": True,
            "upstreamKeyPreview": "sk-a...cret",
            "baseUrl": "",
        }
    ]


def test_custom_newapi_provider_channel_sync_does_not_save_when_newapi_update_fails(
    monkeypatch,
    tmp_path,
):
    _isolate_settings_db(monkeypatch, tmp_path)
    monkeypatch.setenv("NEWAPI_PROVISIONER_ENABLED", "true")

    class Admin:
        admin_user_id = 1
        admin_username = "root"
        token_created = False
        access_token = "admin-secret"

    monkeypatch.setattr(
        model_gateway,
        "get_provisioner_config",
        lambda _base_url=None, **_kwargs: type(
            "Cfg",
            (),
            {"admin_base_url": "http://new-api:3000"},
        )(),
    )
    monkeypatch.setattr(
        model_gateway, "ensure_admin_access_token", lambda _cfg: Admin()
    )
    monkeypatch.setattr(
        model_gateway,
        "update_provider_channel_credentials",
        lambda *_args, **_kwargs: {
            "ok": False,
            "httpStatus": 400,
            "newApiResponse": {"success": False, "message": "invalid key"},
            "sentPayload": {
                "mode": "single",
                "channel": {
                    "id": 7,
                    "name": "DC-ali",
                    "key": "sk-ali-new-upstream-secret",
                },
            },
            "channelId": 7,
        },
    )

    app = FastAPI()
    app.include_router(model_gateway.router)
    client = TestClient(app)

    response = client.post(
        "/model-gateway/custom/newapi/provider-channel/sync",
        json={
            "newApiBaseUrl": "http://new-api:3000",
            "provider": "ali",
            "upstreamKey": "sk-ali-new-upstream-secret",
        },
    )

    assert response.status_code == 200
    assert response.json()["ok"] is False
    assert response.json()["data"]["savedChannel"] is None
    assert "sk-ali-new-upstream-secret" not in response.text

    config_response = client.get("/model-gateway/config")
    assert config_response.json()["data"]["provisioner"]["providerChannels"] == []


def test_custom_newapi_channels_batch_uses_saved_provider_channel_config(
    monkeypatch,
    tmp_path,
):
    _isolate_settings_db(monkeypatch, tmp_path)
    monkeypatch.setenv("NEWAPI_PROVISIONER_ENABLED", "true")
    save_newapi_provider_channels(
        [
            {
                "provider": "ali",
                "upstreamKey": "sk-saved-upstream-secret",
                "baseUrl": "https://saved-dashscope.example.com",
            }
        ]
    )

    class Admin:
        admin_user_id = 1
        admin_username = "root"
        token_created = False
        access_token = "admin-secret"

    payloads: list[dict] = []

    monkeypatch.setattr(
        model_gateway,
        "get_provisioner_config",
        lambda _base_url=None, **_kwargs: type(
            "Cfg",
            (),
            {"admin_base_url": "http://new-api:3000"},
        )(),
    )
    monkeypatch.setattr(
        model_gateway, "ensure_admin_access_token", lambda _cfg: Admin()
    )

    def fake_upsert_channel(_cfg, _admin, payload):
        payloads.append(payload)
        return {
            "ok": True,
            "httpStatus": 200,
            "newApiResponse": {"success": True},
            "action": "create",
            "channelId": None,
        }

    monkeypatch.setattr(model_gateway, "upsert_channel", fake_upsert_channel)

    app = FastAPI()
    app.include_router(model_gateway.router)
    client = TestClient(app)

    response = client.post(
        "/model-gateway/custom/newapi/channels/batch",
        json={
            "channels": [
                {
                    "provider": "ali",
                    "modelMapping": {"DC-screenplay-normalizer-LLM": "qwen-plus"},
                }
            ]
        },
    )

    assert response.status_code == 200
    assert response.json()["ok"] is True
    assert payloads[0]["channel"]["key"] == "sk-saved-upstream-secret"
    assert payloads[0]["channel"]["base_url"] == "https://saved-dashscope.example.com"
    assert "sk-saved-upstream-secret" not in response.text


def test_custom_newapi_media_models_groups_by_provider_and_persists_mapping(
    monkeypatch,
    tmp_path,
):
    _isolate_settings_db(monkeypatch, tmp_path)
    monkeypatch.setenv("NEWAPI_PROVISIONER_ENABLED", "true")
    save_newapi_provider_channels(
        [
            {
                "provider": "openai",
                "upstreamKey": "sk-openai-upstream-secret",
                "baseUrl": "",
            },
            {
                "provider": "volcengine",
                "upstreamKey": "sk-volc-upstream-secret",
                "baseUrl": "https://ark.example.com",
            },
        ]
    )

    class Admin:
        admin_user_id = 1
        admin_username = "root"
        token_created = False
        access_token = "admin-secret"

    payloads: list[dict] = []

    monkeypatch.setattr(
        model_gateway,
        "get_provisioner_config",
        lambda _base_url=None, **_kwargs: type(
            "Cfg",
            (),
            {"admin_base_url": "http://new-api:3000"},
        )(),
    )
    monkeypatch.setattr(
        model_gateway, "ensure_admin_access_token", lambda _cfg: Admin()
    )

    def fake_upsert_channel(_cfg, _admin, payload):
        payloads.append(payload)
        return {
            "ok": True,
            "httpStatus": 200,
            "newApiResponse": {"success": True},
            "action": "update",
            "channelId": 3,
        }

    monkeypatch.setattr(model_gateway, "upsert_channel", fake_upsert_channel)

    app = FastAPI()
    app.include_router(model_gateway.router)
    client = TestClient(app)

    response = client.post(
        "/model-gateway/custom/newapi/media-models",
        json={
            "newApiBaseUrl": "http://new-api:3000",
            "models": {
                "LingShan-G2": {
                    "provider": "openai",
                    "upstreamModel": "gpt-image-upstream",
                },
                "seedance-1.5-pro": {
                    "provider": "volcengine",
                    "upstreamModel": "doubao-seedance-1-5",
                },
                "seedance-2.0-fast": {
                    "provider": "volcengine",
                    "upstreamModel": "",
                },
                "index-tts-2": {
                    "provider": "volcengine",
                    "upstreamModel": "index-tts-2-upstream",
                },
                "LingShan-MU-11": {
                    "provider": "volcengine",
                    "upstreamModel": "lingshan-mu-upstream",
                },
            },
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    assert body["data"]["succeeded"] == 2
    assert len(payloads) == 2
    by_name = {payload["channel"]["name"]: payload["channel"] for payload in payloads}
    assert json.loads(by_name["DC-openai"]["model_mapping"]) == {
        "LingShan-G2": "gpt-image-upstream",
    }
    assert json.loads(by_name["DC-volcengine"]["model_mapping"]) == {
        "seedance-1.5-pro": "doubao-seedance-1-5",
        "seedance-2.0-fast": "seedance-2.0-fast",
        "index-tts-2": "index-tts-2-upstream",
        "LingShan-MU-11": "lingshan-mu-upstream",
    }
    assert by_name["DC-openai"]["key"] == "sk-openai-upstream-secret"
    assert by_name["DC-volcengine"]["base_url"] == "https://ark.example.com"
    assert "sk-openai-upstream-secret" not in response.text
    assert "sk-volc-upstream-secret" not in response.text

    config_response = client.get("/model-gateway/config")
    media_models = config_response.json()["data"]["provisioner"]["mediaModels"]
    assert media_models == {
        "LingShan-G2": {
            "provider": "openai",
            "upstreamModel": "gpt-image-upstream",
        },
        "seedance-1.5-pro": {
            "provider": "volcengine",
            "upstreamModel": "doubao-seedance-1-5",
        },
        "seedance-2.0-fast": {
            "provider": "volcengine",
            "upstreamModel": "",
        },
        "index-tts-2": {
            "provider": "volcengine",
            "upstreamModel": "index-tts-2-upstream",
        },
        "LingShan-MU-11": {
            "provider": "volcengine",
            "upstreamModel": "lingshan-mu-upstream",
        },
    }


def test_custom_newapi_media_models_rejects_official_value_models(
    monkeypatch, tmp_path
):
    _isolate_settings_db(monkeypatch, tmp_path)
    monkeypatch.setenv("NEWAPI_PROVISIONER_ENABLED", "true")

    app = FastAPI()
    app.include_router(model_gateway.router)
    client = TestClient(app)

    response = client.post(
        "/model-gateway/custom/newapi/media-models",
        json={
            "models": {
                "seedance-2.0-value": {
                    "provider": "volcengine",
                    "upstreamModel": "seedance-2.0-value",
                }
            }
        },
    )

    assert response.status_code == 400
    assert "official-channel only" in response.text


def test_custom_newapi_embedding_model_writes_mapping_and_persists_dimension(
    monkeypatch,
    tmp_path,
):
    _isolate_settings_db(monkeypatch, tmp_path)
    monkeypatch.setenv("NEWAPI_PROVISIONER_ENABLED", "true")
    save_newapi_provider_channels(
        [
            {
                "provider": "openai",
                "upstreamKey": "sk-openai-upstream-secret",
                "baseUrl": "",
            }
        ]
    )

    class Admin:
        admin_user_id = 1
        admin_username = "root"
        token_created = False
        access_token = "admin-secret"

    payloads: list[dict] = []

    monkeypatch.setattr(
        model_gateway,
        "get_provisioner_config",
        lambda _base_url=None, **_kwargs: type(
            "Cfg",
            (),
            {"admin_base_url": "http://new-api:3000"},
        )(),
    )
    monkeypatch.setattr(
        model_gateway, "ensure_admin_access_token", lambda _cfg: Admin()
    )

    def fake_upsert_channel(_cfg, _admin, payload):
        payloads.append(payload)
        return {
            "ok": True,
            "httpStatus": 200,
            "newApiResponse": {"success": True},
            "action": "update",
            "channelId": 7,
        }

    monkeypatch.setattr(model_gateway, "upsert_channel", fake_upsert_channel)

    app = FastAPI()
    app.include_router(model_gateway.router)
    client = TestClient(app)

    response = client.post(
        "/model-gateway/custom/newapi/embedding-model",
        json={
            "newApiBaseUrl": "http://new-api:3000",
            "provider": "openai",
            "upstreamModel": "text-embedding-3-large",
            "dimension": 3072,
            "batchSize": 36,
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    assert payloads[0]["channel"]["name"] == "DC-openai"
    assert payloads[0]["channel"]["key"] == "sk-openai-upstream-secret"
    assert json.loads(payloads[0]["channel"]["model_mapping"]) == {
        "DC-cognee-embedding": "text-embedding-3-large",
    }
    assert "dimension" not in payloads[0]["channel"]
    assert "3072" not in payloads[0]["channel"]["model_mapping"]
    assert "sk-openai-upstream-secret" not in response.text

    config_response = client.get("/model-gateway/config")
    embedding = config_response.json()["data"]["provisioner"]["embeddingModel"]
    assert embedding == {
        "provider": "openai",
        "upstreamModel": "text-embedding-3-large",
        "dimension": 3072,
        "batchSize": 36,
        "internalModel": "DC-cognee-embedding",
    }


def test_effective_cognee_embedding_prefers_saved_custom_config(monkeypatch, tmp_path):
    _isolate_settings_db(monkeypatch, tmp_path)
    monkeypatch.setenv("COGNEE_EMBEDDING_PROVIDER", "gemini")
    monkeypatch.setenv("COGNEE_EMBEDDING_MODEL", "gemini-embedding-001")
    monkeypatch.setenv("COGNEE_EMBEDDING_DIM", "768")

    save_newapi_embedding_model_config(
        provider="openai",
        upstream_model="text-embedding-3-large",
        dimension=3072,
    )

    effective = get_effective_cognee_embedding_config(llm_provider="gemini")

    assert effective.source == "database"
    assert effective.provider == "newapi"
    assert effective.model == "DC-cognee-embedding"
    assert effective.dimensions == "3072"
    assert effective.upstream_provider == "openai"
    assert effective.upstream_model == "text-embedding-3-large"


def test_effective_cognee_embedding_keeps_saved_batch_size(monkeypatch, tmp_path):
    _isolate_settings_db(monkeypatch, tmp_path)

    save_newapi_embedding_model_config(
        provider="ali",
        upstream_model="text-embedding-v3",
        dimension=1024,
        batch_size=10,
    )

    effective = get_effective_cognee_embedding_config(llm_provider="newapi")

    assert effective.source == "database"
    assert effective.provider == "newapi"
    assert effective.model == "DC-cognee-embedding"
    assert effective.dimensions == "1024"
    assert effective.batch_size == "10"


def test_cognee_apply_embedding_env_sets_saved_batch_size(monkeypatch, tmp_path):
    _isolate_settings_db(monkeypatch, tmp_path)
    monkeypatch.delenv("EMBEDDING_BATCH_SIZE", raising=False)

    save_custom_newapi_gateway(
        base_url="https://custom.example",
        api_key="sk-custom-secret",
        activate=True,
    )
    save_newapi_embedding_model_config(
        provider="ali",
        upstream_model="text-embedding-v3",
        dimension=1024,
        batch_size=10,
    )

    from novelvideo.cognee import config as cognee_config

    cognee_config._apply_embedding_env("newapi", "sk-custom-secret")

    assert os.environ["EMBEDDING_BATCH_SIZE"] == "10"


def test_custom_newapi_channels_batch_reports_partial_failure(monkeypatch, tmp_path):
    _isolate_settings_db(monkeypatch, tmp_path)
    monkeypatch.setenv("NEWAPI_PROVISIONER_ENABLED", "true")

    class Admin:
        admin_user_id = 1
        admin_username = "root"
        token_created = False
        access_token = "admin-secret"

    monkeypatch.setattr(
        model_gateway,
        "get_provisioner_config",
        lambda _base_url=None, **_kwargs: type(
            "Cfg",
            (),
            {"admin_base_url": "http://new-api:3000"},
        )(),
    )
    monkeypatch.setattr(
        model_gateway, "ensure_admin_access_token", lambda _cfg: Admin()
    )

    def fake_upsert_channel(_cfg, _admin, payload):
        if "DC-staging-prop-planner-LLM" in payload["channel"]["models"]:
            return {
                "ok": False,
                "httpStatus": 400,
                "newApiResponse": {"success": False, "message": "bad model"},
                "action": "update",
                "channelId": 7,
            }
        return {
            "ok": True,
            "httpStatus": 200,
            "newApiResponse": {"success": True},
            "action": "create",
            "channelId": None,
        }

    monkeypatch.setattr(model_gateway, "upsert_channel", fake_upsert_channel)

    app = FastAPI()
    app.include_router(model_gateway.router)
    client = TestClient(app)

    response = client.post(
        "/model-gateway/custom/newapi/channels/batch",
        json={
            "channels": [
                {
                    "provider": "ali",
                    "name": "ok-channel",
                    "upstreamKey": "sk-upstream-one",
                    "modelMapping": {"DC-screenplay-normalizer-LLM": "qwen-plus"},
                },
                {
                    "provider": "ali",
                    "name": "bad-channel",
                    "upstreamKey": "sk-upstream-two",
                    "modelMapping": {"DC-staging-prop-planner-LLM": "qwen-plus"},
                },
            ],
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is False
    assert body["data"]["succeeded"] == 1
    assert body["data"]["failed"] == 1
    assert body["data"]["results"][0]["ok"] is True
    assert body["data"]["results"][1]["ok"] is False
    assert body["data"]["results"][1]["httpStatus"] == 400


def test_media_relay_config_route_persists_and_masks_oss_keys(monkeypatch, tmp_path):
    _isolate_settings_db(monkeypatch, tmp_path)
    monkeypatch.setenv("NEWAPI_PROVISIONER_ENABLED", "true")
    monkeypatch.setattr(model_gateway.app_config, "MEDIA_RELAY_PROVIDER", "aliyun_oss")
    monkeypatch.setattr(model_gateway.app_config, "MEDIA_RELAY_TTL_SECONDS", 1800)
    monkeypatch.setattr(model_gateway.app_config, "OSS_RELAY_ENDPOINT", "env.endpoint")
    monkeypatch.setattr(model_gateway.app_config, "OSS_RELAY_BUCKET", "env-bucket")
    monkeypatch.setattr(model_gateway.app_config, "OSS_RELAY_AK", "env-ak-secret")
    monkeypatch.setattr(model_gateway.app_config, "OSS_RELAY_SK", "env-sk-secret")

    app = FastAPI()
    app.include_router(model_gateway.router)
    client = TestClient(app)

    response = client.post(
        "/model-gateway/media-relay/config",
        json={
            "provider": "aliyun_oss",
            "ttlSeconds": 900,
            "endpoint": "oss-cn-shanghai.aliyuncs.com",
            "bucket": "user-relay",
            "accessKeyId": "LTAI-user-secret",
            "accessKeySecret": "SK-user-secret",
        },
    )

    assert response.status_code == 200
    data = response.json()["data"]
    assert data["source"] == "database"
    assert data["ttlSeconds"] == 900
    assert data["endpoint"] == "oss-cn-shanghai.aliyuncs.com"
    assert data["bucket"] == "user-relay"
    assert data["accessKeyIdPreview"] == "LTAI...cret"
    assert data["accessKeySecretPreview"] == "SK-u...cret"
    assert "LTAI-user-secret" not in response.text
    assert "SK-user-secret" not in response.text


def test_media_relay_config_route_persists_and_masks_cloudinary_keys(
    monkeypatch, tmp_path
):
    _isolate_settings_db(monkeypatch, tmp_path)
    monkeypatch.setenv("NEWAPI_PROVISIONER_ENABLED", "true")
    monkeypatch.setattr(model_gateway.app_config, "MEDIA_RELAY_PROVIDER", "aliyun_oss")
    monkeypatch.setattr(model_gateway.app_config, "MEDIA_RELAY_TTL_SECONDS", 1800)
    monkeypatch.setattr(model_gateway.app_config, "OSS_RELAY_ENDPOINT", "env.endpoint")
    monkeypatch.setattr(model_gateway.app_config, "OSS_RELAY_BUCKET", "env-bucket")
    monkeypatch.setattr(model_gateway.app_config, "OSS_RELAY_AK", "env-ak-secret")
    monkeypatch.setattr(model_gateway.app_config, "OSS_RELAY_SK", "env-sk-secret")
    monkeypatch.setattr(model_gateway.app_config, "CLOUDINARY_RELAY_CLOUD_NAME", "")
    monkeypatch.setattr(model_gateway.app_config, "CLOUDINARY_RELAY_API_KEY", "")
    monkeypatch.setattr(model_gateway.app_config, "CLOUDINARY_RELAY_API_SECRET", "")
    monkeypatch.setattr(model_gateway.app_config, "CLOUDINARY_RELAY_FOLDER", "relay")

    app = FastAPI()
    app.include_router(model_gateway.router)
    client = TestClient(app)

    response = client.post(
        "/model-gateway/media-relay/config",
        json={
            "provider": "cloudinary",
            "ttlSeconds": 900,
            "cloudName": "demo-cloud",
            "apiKey": "cloudinary-api-key-secret",
            "apiSecret": "cloudinary-api-secret",
            "apiFolder": "dramaclaw-relay",
        },
    )

    assert response.status_code == 200
    data = response.json()["data"]
    assert data["source"] == "database"
    assert data["provider"] == "cloudinary"
    assert data["ttlSeconds"] == 900
    assert data["cloudName"] == "demo-cloud"
    assert data["apiFolder"] == "dramaclaw-relay"
    assert data["cloudinaryApiKeyPreview"] == "clou...cret"
    assert data["cloudinaryApiSecretPreview"] == "clou...cret"
    assert data["configured"] is True
    assert "cloudinary-api-key-secret" not in response.text
    assert "cloudinary-api-secret" not in response.text


def test_media_relay_status_prefers_database_config(monkeypatch, tmp_path):
    _isolate_settings_db(monkeypatch, tmp_path)
    save_media_relay_config(
        provider="aliyun_oss",
        ttl_seconds=600,
        endpoint="db.endpoint",
        bucket="db-bucket",
        access_key_id="db-ak-secret",
        access_key_secret="db-sk-secret",
    )

    status = model_gateway._media_relay_status()

    assert status["source"] == "database"
    assert status["ttlSeconds"] == 600
    assert status["endpoint"] == "db.endpoint"
    assert status["bucket"] == "db-bucket"
    assert status["configured"] is True
