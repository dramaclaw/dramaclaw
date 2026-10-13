from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from novelvideo import config
from novelvideo.api.routes import model_gateway
from novelvideo.chat import service as chat_service
from novelvideo.model_gateway_settings import (
    AGENT_LLM_MODE_INHERIT,
    AGENT_LLM_MODE_THIRD_PARTY,
    get_effective_llm_config,
    get_effective_newapi_config,
    save_agent_llm_config,
    save_official_newapi_key,
)


def _isolate_settings_db(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(config, "STATE_DIR", str(tmp_path / "state"))
    monkeypatch.setenv("ST_EDITION", "ce")
    monkeypatch.delenv("ST_CONTROL_PLANE_DSN", raising=False)


def test_third_party_agent_route_is_independent_from_media_gateway(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _isolate_settings_db(monkeypatch, tmp_path)
    save_official_newapi_key(api_key="sk-official-secret")
    save_agent_llm_config(
        mode=AGENT_LLM_MODE_THIRD_PARTY,
        base_url="https://agent.example",
        api_key="sk-agent-secret",
        model="vendor-agent-model",
    )

    llm = get_effective_llm_config()
    media = get_effective_newapi_config()
    assert (llm.base_url, llm.api_key, llm.model) == (
        "https://agent.example/v1",
        "sk-agent-secret",
        "vendor-agent-model",
    )
    assert media.mode == "official"
    assert media.api_key == "sk-official-secret"
    assert chat_service._codex_model() == "vendor-agent-model"

    overrides = chat_service._codex_gateway_config_overrides(llm.base_url)
    catalog_setting = next(
        value for value in overrides if value.startswith("model_catalog_json=")
    )
    catalog_path = Path(json.loads(catalog_setting.split("=", 1)[1]))
    catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
    assert any(item.get("slug") == "vendor-agent-model" for item in catalog["models"])

    save_agent_llm_config(mode=AGENT_LLM_MODE_INHERIT)
    assert get_effective_llm_config().mode == "official"


def test_agent_config_api_masks_secret_and_requires_key_for_new_host(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _isolate_settings_db(monkeypatch, tmp_path)
    monkeypatch.setenv("NEWAPI_PROVISIONER_ENABLED", "true")
    monkeypatch.setattr(
        model_gateway,
        "refresh_model_gateway_runtime",
        lambda: {"refreshed": True},
    )
    app = FastAPI()
    app.include_router(model_gateway.router)
    client = TestClient(app)

    response = client.post(
        "/model-gateway/agent/config",
        json={
            "mode": "third_party",
            "baseUrl": "https://agent.example",
            "apiKey": "sk-agent-secret",
            "model": "vendor-agent-model",
        },
    )
    assert response.status_code == 200
    assert response.json()["data"]["agent"] == {
        "mode": "third_party",
        "baseUrl": "https://agent.example/v1",
        "apiKeyPreview": "sk-a...cret",
        "model": "vendor-agent-model",
        "configured": True,
    }
    assert "sk-agent-secret" not in response.text

    response = client.post(
        "/model-gateway/agent/config",
        json={
            "mode": "third_party",
            "baseUrl": "https://other.example",
            "model": "vendor-agent-model",
        },
    )
    assert response.status_code == 400
    assert response.json()["detail"] == "apiKey is required"
