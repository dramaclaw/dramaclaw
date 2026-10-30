from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from novelvideo import config
from novelvideo.api.routes import model_gateway
from novelvideo.chat import codex_app_server, hermes_pool, hermes_workspace
from novelvideo.chat import service as chat_service
from novelvideo.model_gateway_settings import (
    AGENT_LLM_MODE_INHERIT,
    AGENT_LLM_MODE_THIRD_PARTY,
    get_effective_agent_llm_config,
    get_effective_llm_config,
    get_effective_newapi_config,
    save_agent_llm_config,
    save_custom_newapi_gateway,
    save_official_newapi_key,
    set_model_gateway_mode,
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

    llm = get_effective_agent_llm_config()
    business_llm = get_effective_llm_config()
    media = get_effective_newapi_config()
    assert (llm.base_url, llm.api_key, llm.model) == (
        "https://agent.example/v1",
        "sk-agent-secret",
        "vendor-agent-model",
    )
    assert media.mode == "official"
    assert media.api_key == "sk-official-secret"
    assert business_llm.mode == "official"
    assert business_llm.api_key == "sk-official-secret"
    assert chat_service._codex_model() == "vendor-agent-model"

    captured_business_route: dict[str, object] = {}

    def fake_business_model(model_name: str, **kwargs: object) -> str:
        captured_business_route.update(model_name=model_name, **kwargs)
        return "business-model"

    monkeypatch.setattr(config, "_newapi_text_openai_model", fake_business_model)
    assert (
        config.get_newapi_text_pydantic_model("CONTENT_REWRITER_MODEL")
        == "business-model"
    )
    assert captured_business_route["api_key"] == "sk-official-secret"
    assert captured_business_route["base_url"] != "https://agent.example/v1"

    overrides = chat_service._codex_gateway_config_overrides(llm.base_url)
    catalog_setting = next(
        value for value in overrides if value.startswith("model_catalog_json=")
    )
    catalog_path = Path(json.loads(catalog_setting.split("=", 1)[1]))
    catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
    assert any(item.get("slug") == "vendor-agent-model" for item in catalog["models"])

    assert hermes_workspace._hermes_model_default() == "vendor-agent-model"
    assert hermes_workspace._hermes_model_api_mode() == "codex_responses"

    first_fingerprint = hermes_pool.gateway_origin_fingerprint()
    save_agent_llm_config(
        mode=AGENT_LLM_MODE_THIRD_PARTY,
        base_url="https://agent.example",
        api_key="sk-agent-secret",
        model="vendor-agent-model-v2",
    )
    assert hermes_pool.gateway_origin_fingerprint() != first_fingerprint

    save_agent_llm_config(mode=AGENT_LLM_MODE_INHERIT)
    assert get_effective_agent_llm_config().mode == "official"


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
    codex_home = tmp_path / "state" / ".codex-app-server"
    monkeypatch.setenv("DRAMACLAW_CODEX_HOME", str(codex_home))
    socket_path = codex_app_server._control_paths(codex_home)[0]
    owner_runtime = codex_app_server._SharedCodexRuntime()
    api_runtime = codex_app_server._SharedCodexRuntime()
    monkeypatch.setattr(owner_runtime, "ensure", lambda **_kwargs: socket_path)
    monkeypatch.setattr(api_runtime, "ensure", lambda **_kwargs: socket_path)
    _, lease_path = owner_runtime.acquire(
        codex_bin=tmp_path / "codex",
        codex_home=codex_home,
        env={},
        config_overrides=(),
    )
    monkeypatch.setattr(codex_app_server, "_RUNTIME", api_runtime)

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
    assert response.json()["runtime"]["codexAppServer"] == "draining"
    assert lease_path.exists()
    assert response.json()["data"]["agent"] == {
        "mode": "third_party",
        "baseUrl": "https://agent.example/v1",
        "apiKeyPreview": "sk-a...cret",
        "model": "vendor-agent-model",
        "configured": True,
    }
    assert "sk-agent-secret" not in response.text

    with pytest.raises(RuntimeError, match="applying new Agent configuration"):
        api_runtime.acquire(
            codex_bin=tmp_path / "codex",
            codex_home=codex_home,
            env={},
            config_overrides=(),
        )
    owner_runtime.release(codex_home, lease_path)
    drain_path = codex_app_server._coordination_paths(codex_home)[1]
    assert not drain_path.exists()

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


def test_inherited_agent_route_rotates_when_gateway_mode_changes(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _isolate_settings_db(monkeypatch, tmp_path)
    monkeypatch.setenv("NEWAPI_PROVISIONER_ENABLED", "true")
    save_official_newapi_key(api_key="sk-official-secret")
    save_custom_newapi_gateway(
        api_key="sk-custom-secret",
        base_url="https://custom.example",
        activate=False,
    )
    set_model_gateway_mode("official")
    save_agent_llm_config(mode=AGENT_LLM_MODE_INHERIT)

    rotations: list[bool] = []
    monkeypatch.setattr(
        model_gateway,
        "refresh_model_gateway_runtime",
        lambda: {"refreshed": True},
    )
    monkeypatch.setattr(
        model_gateway,
        "restart_shared_codex_runtime_when_idle",
        lambda: rotations.append(True) or "stopped",
    )

    app = FastAPI()
    app.include_router(model_gateway.router)
    response = TestClient(app).post("/model-gateway/custom/enable")

    assert response.status_code == 200
    assert response.json()["data"]["mode"] == "custom"
    assert response.json()["runtime"]["codexAppServer"] == "stopped"
    assert rotations == [True]


def test_codex_rotation_stops_owner_recorded_by_another_worker(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    codex_home = tmp_path / "codex-home"
    socket_path, _lock_path, signature_path = codex_app_server._control_paths(
        codex_home
    )
    owner_path, drain_path, _leases_dir = codex_app_server._coordination_paths(
        codex_home
    )
    signature_path.write_text("route-signature", encoding="ascii")
    owner_path.write_text(
        json.dumps({"pid": 424242, "signature": "route-signature"}),
        encoding="utf-8",
    )
    socket_path.touch()

    socket_state = {"accepting": True}
    requester_runtime = codex_app_server._SharedCodexRuntime()
    monkeypatch.setattr(
        requester_runtime,
        "_socket_accepting",
        lambda _path: socket_state["accepting"],
    )
    signals: list[tuple[int, int]] = []

    def fake_kill(pid: int, signal_number: int) -> None:
        signals.append((pid, signal_number))
        if signal_number == 15:
            socket_state["accepting"] = False

    monkeypatch.setattr(codex_app_server.os, "kill", fake_kill)

    assert requester_runtime.request_restart(codex_home) == "stopped"
    assert signals == [(424242, 15)]
    assert not drain_path.exists()
    assert not owner_path.exists()


def test_old_owner_worker_accepts_peer_replacement(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    codex_home = tmp_path / "codex-home"
    codex_bin = tmp_path / "codex"
    socket_path, _lock_path, signature_path = codex_app_server._control_paths(
        codex_home
    )
    owner_path, _drain_path, _leases_dir = codex_app_server._coordination_paths(
        codex_home
    )
    new_overrides = ('model="new-model"',)
    new_signature = (
        str(codex_bin),
        str(codex_home),
        new_overrides,
        "https://new.example/v1",
    )
    new_digest = codex_app_server._signature_digest(new_signature)
    signature_path.write_text(new_digest, encoding="ascii")
    owner_path.write_text(
        json.dumps({"pid": 222222, "signature": new_digest}),
        encoding="utf-8",
    )
    socket_path.touch()

    class ExitedOwnerProcess:
        pid = 111111

        @staticmethod
        def poll() -> int:
            return 0

    old_owner_runtime = codex_app_server._SharedCodexRuntime()
    old_owner_runtime._process = ExitedOwnerProcess()  # type: ignore[assignment]
    old_owner_runtime._signature = ("old-route",)
    old_owner_runtime._socket_path = socket_path
    old_owner_runtime._signature_path = signature_path
    monkeypatch.setattr(
        old_owner_runtime,
        "_socket_accepting",
        lambda _path: True,
    )

    resolved_socket = old_owner_runtime.ensure(
        codex_bin=codex_bin,
        codex_home=codex_home,
        env={"DRAMACLAW_CODEX_GATEWAY_BASE_URL": "https://new.example/v1"},
        config_overrides=new_overrides,
    )

    assert resolved_socket == socket_path
    assert old_owner_runtime._process is None
    assert old_owner_runtime._signature is None
