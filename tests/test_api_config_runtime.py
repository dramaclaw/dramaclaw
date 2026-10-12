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
    assert first_data["mcp_direct_canvas_apply"] is False


def test_runtime_config_exposes_direct_mcp_canvas_apply(monkeypatch) -> None:
    from novelvideo.api.routes import config
    from novelvideo.shared import runtime_env

    monkeypatch.setattr(runtime_env, "load_project_dotenv", lambda override=False: None)
    monkeypatch.setenv("DRAMACLAW_MCP_DIRECT_CANVAS_APPLY", "1")

    app = FastAPI()
    app.include_router(config.router, prefix="/api/v1")
    response = TestClient(app).get("/api/v1/config")

    assert response.status_code == 200
    assert response.json()["data"]["mcp_direct_canvas_apply"] is True


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        (None, None),
        ("", None),
        ("https://cdn.example.com/browser-models/", "https://cdn.example.com/browser-models"),
        ("  http://127.0.0.1:9000/models  ", "http://127.0.0.1:9000/models"),
        ("cdn.example.com/browser-models", None),
        ("javascript:alert(1)", None),
    ],
)
def test_runtime_config_exposes_browser_model_asset_base(monkeypatch, raw, expected) -> None:
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
