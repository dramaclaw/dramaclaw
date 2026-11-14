from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest


@pytest.mark.parametrize("edition", [None, "", "ce"])
def test_runtime_config_includes_stable_instance_id(monkeypatch, edition) -> None:
    from novelvideo.api.routes import config
    from novelvideo.shared import runtime_env

    monkeypatch.setattr(runtime_env, "load_project_dotenv", lambda override=False: None)
    if edition is None:
        monkeypatch.delenv("ST_EDITION", raising=False)
    else:
        monkeypatch.setenv("ST_EDITION", edition)
    monkeypatch.delenv("ST_CONTROL_PLANE_DSN", raising=False)
    monkeypatch.delenv("SUPERTALE_OPENFILM_STUDIO_ENABLED", raising=False)

    app = FastAPI()
    app.include_router(config.router, prefix="/api/v1")
    client = TestClient(app)

    first = client.get("/api/v1/config")
    second = client.get("/api/v1/config")

    assert first.status_code == 200
    assert second.status_code == 200
    first_data = first.json()["data"]
    second_data = second.json()["data"]

    assert first_data["edition"] == "ce"
    assert first_data["auth_required"] is False
    assert isinstance(first_data["instance_id"], str)
    assert first_data["instance_id"]
    assert second_data["instance_id"] == first_data["instance_id"]
    assert first_data["agent_canvas_executor"] == "browser"
    assert first_data["openfilm_studio_enabled"] is False


def test_runtime_config_exposes_server_canvas_executor(monkeypatch) -> None:
    from novelvideo.api.routes import config
    from novelvideo.shared import runtime_env

    monkeypatch.setattr(runtime_env, "load_project_dotenv", lambda override=False: None)
    monkeypatch.setenv("DRAMACLAW_AGENT_CANVAS_EXECUTOR", "server")
    monkeypatch.setenv("DRAMACLAW_CANVAS_PATCH_PUSH", "1")

    app = FastAPI()
    app.include_router(config.router, prefix="/api/v1")
    response = TestClient(app).get("/api/v1/config")

    assert response.status_code == 200
    assert response.json()["data"]["agent_canvas_executor"] == "server"


def test_runtime_config_exposes_explicit_openfilm_studio_opt_in(monkeypatch) -> None:
    from novelvideo.api.routes import config
    from novelvideo.shared import runtime_env

    monkeypatch.setattr(runtime_env, "load_project_dotenv", lambda override=False: None)
    monkeypatch.setenv("SUPERTALE_OPENFILM_STUDIO_ENABLED", "true")

    app = FastAPI()
    app.include_router(config.router, prefix="/api/v1")
    response = TestClient(app).get("/api/v1/config")

    assert response.status_code == 200
    assert response.json()["data"]["openfilm_studio_enabled"] is True


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        (None, None),
        ("", None),
        (
            "https://cdn.example.com/browser-models/",
            "https://cdn.example.com/browser-models",
        ),
        ("  http://127.0.0.1:9000/models  ", "http://127.0.0.1:9000/models"),
        ("cdn.example.com/browser-models", None),
        ("javascript:alert(1)", None),
    ],
)
def test_runtime_config_exposes_browser_model_asset_base(
    monkeypatch, raw, expected
) -> None:
    monkeypatch.delenv("BROWSER_MODEL_HF_ENDPOINT", raising=False)
    monkeypatch.delenv("BROWSER_ORT_WASM_BASE", raising=False)
    from novelvideo.api.routes import config
    from novelvideo.shared import runtime_env

    monkeypatch.setattr(runtime_env, "load_project_dotenv", lambda override=False: None)
    if raw is None:
        monkeypatch.delenv("BROWSER_MODEL_ASSET_BASE", raising=False)
    else:
        monkeypatch.setenv("BROWSER_MODEL_ASSET_BASE", raw)

    app = FastAPI()
    app.include_router(config.router, prefix="/api/v1")
    response = TestClient(app).get("/api/v1/config")

    assert response.status_code == 200
    assert response.json()["data"]["browser_model_asset_base"] == expected


def test_runtime_config_exposes_public_mirror_sources(monkeypatch) -> None:
    from novelvideo.api.routes import config
    from novelvideo.shared import runtime_env

    monkeypatch.setattr(runtime_env, "load_project_dotenv", lambda override=False: None)
    monkeypatch.delenv("BROWSER_MODEL_ASSET_BASE", raising=False)
    monkeypatch.setenv("BROWSER_MODEL_HF_ENDPOINT", "https://www.modelscope.cn/models/")
    monkeypatch.setenv(
        "BROWSER_ORT_WASM_BASE",
        "https://registry.npmmirror.com/onnxruntime-web/{version}/files/dist",
    )

    app = FastAPI()
    app.include_router(config.router, prefix="/api/v1")
    data = TestClient(app).get("/api/v1/config").json()["data"]

    assert data["browser_model_asset_base"] is None
    assert data["browser_model_hf_endpoint"] == "https://www.modelscope.cn/models"
    assert (
        data["browser_ort_wasm_base"]
        == "https://registry.npmmirror.com/onnxruntime-web/{version}/files/dist"
    )
