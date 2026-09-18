from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from novelvideo import blender_store
from novelvideo.api.routes import blender


@pytest.fixture()
def client(tmp_path, monkeypatch):
    db_path = tmp_path / "blender.db"
    blender_store.init_db(db_path)
    monkeypatch.setattr(blender, "_db", lambda: db_path)
    monkeypatch.setattr(
        blender, "list_user_projects", lambda username: ["demo", "another"]
    )

    app = FastAPI()
    app.include_router(blender.router, prefix="/api/v1")
    app.dependency_overrides[blender.get_api_user] = lambda: {"username": "alice"}
    with TestClient(app) as test_client:
        test_client.db_path = db_path
        yield test_client


def _issue_token(db_path, user_id="alice"):
    pairing = blender_store.create_pairing(db_path)
    blender_store.approve_pairing(db_path, pairing.code, user_id=user_id)
    return blender_store.consume_pairing(db_path, pairing.pairing_id).token


def test_projects_lists_what_the_paired_user_owns(client):
    token = _issue_token(client.db_path)

    response = client.get(
        "/api/v1/blender/projects", headers={"Authorization": f"Bearer {token}"}
    )

    assert response.status_code == 200
    assert response.json() == {"projects": ["demo", "another"]}


def test_projects_needs_a_plugin_token(client):
    assert client.get("/api/v1/blender/projects").status_code == 401


def test_clients_lists_the_users_plugins_without_the_secret(client):
    _issue_token(client.db_path)

    body = client.get("/api/v1/blender/clients").json()

    assert len(body["clients"]) == 1
    entry = body["clients"][0]
    assert entry["label"] == "Blender"
    assert "token" not in entry
    assert "token_hash" not in entry
    assert entry["expires_at"] > entry["created_at"]


def test_clients_only_shows_your_own(client):
    _issue_token(client.db_path, user_id="bob")

    assert client.get("/api/v1/blender/clients").json() == {"clients": []}


def test_revoke_kills_the_token(client):
    token = _issue_token(client.db_path)
    token_id = client.get("/api/v1/blender/clients").json()["clients"][0]["token_id"]

    assert client.delete(f"/api/v1/blender/clients/{token_id}").status_code == 200

    assert (
        client.get(
            "/api/v1/blender/projects", headers={"Authorization": f"Bearer {token}"}
        ).status_code
        == 401
    )


def test_revoking_an_unknown_token_is_404(client):
    assert client.delete("/api/v1/blender/clients/nope").status_code == 404


def test_revoking_someone_elses_token_is_404(client):
    _issue_token(client.db_path, user_id="bob")
    token_id = blender_store.list_tokens(client.db_path, user_id="bob")[0].token_id

    # 404 而不是 403：别确认「这个 id 确实存在，只是不是你的」。
    assert client.delete(f"/api/v1/blender/clients/{token_id}").status_code == 404
