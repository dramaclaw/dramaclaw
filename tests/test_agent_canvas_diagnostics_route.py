"""Authenticated canvas diagnostics expose only process-local numeric state."""

import os

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from novelvideo.api.auth import get_api_user
from novelvideo.api.routes import diagnostics
from novelvideo.freezone import agent_canvas_metrics as metrics


def test_agent_canvas_diagnostics_response():
    app = FastAPI()
    app.include_router(diagnostics.router)
    app.dependency_overrides[get_api_user] = lambda: {}
    metrics.count("test.canvas.diagnostics")
    expected = metrics.metrics_snapshot()["test.canvas.diagnostics"]
    with TestClient(app) as client:
        response = client.get("/diagnostics/agent-canvas")
    assert response.status_code == 200
    body = response.json()
    assert set(body) == {"ok", "data"}
    assert body["ok"] is True
    assert set(body["data"]) == {"worker_pid", "counters", "observations", "canvas_push"}
    assert body["data"]["worker_pid"] == os.getpid()
    assert body["data"]["counters"]["test.canvas.diagnostics"] == expected
    assert body["data"]["observations"] == metrics.observations_snapshot()
    assert body["data"]["canvas_push"] == {"canvas_patch_frames": 0, "canvas_reset_frames": 0}


def test_agent_canvas_diagnostics_uses_api_auth():
    app = FastAPI()
    app.include_router(diagnostics.router)

    def unauthorized():
        raise HTTPException(status_code=401, detail="Authentication required")

    app.dependency_overrides[get_api_user] = unauthorized
    with TestClient(app) as client:
        response = client.get("/diagnostics/agent-canvas")
    assert response.status_code == 401
    assert response.json() == {"detail": "Authentication required"}
