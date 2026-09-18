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

    app = FastAPI()
    app.include_router(blender.router, prefix="/api/v1")
    app.dependency_overrides[blender.get_api_user] = lambda: {"username": "alice"}
    with TestClient(app) as test_client:
        yield test_client


def test_start_returns_a_code_and_a_pairing_id(client):
    response = client.post("/api/v1/blender/pairing/start")

    assert response.status_code == 200
    body = response.json()
    assert body["code"]
    assert body["pairing_id"]
    assert body["expires_in"] == blender_store.PAIRING_TTL_SECONDS


def test_poll_before_approval_says_pending_and_hands_out_nothing(client):
    pairing_id = client.post("/api/v1/blender/pairing/start").json()["pairing_id"]

    body = client.get(f"/api/v1/blender/pairing/{pairing_id}").json()

    assert body == {"status": "pending"}


def test_approve_then_poll_hands_out_the_token(client):
    started = client.post("/api/v1/blender/pairing/start").json()

    approve = client.post(
        "/api/v1/blender/pairing/approve", json={"code": started["code"]}
    )
    assert approve.status_code == 200
    assert approve.json() == {"ok": True}

    body = client.get(f"/api/v1/blender/pairing/{started['pairing_id']}").json()
    assert body["status"] == "approved"
    assert body["token"]
    assert body["expires_in"] == blender_store.TOKEN_TTL_SECONDS


def test_approving_a_wrong_code_is_400_not_404(client):
    # 404 会告诉攻击者「这个码不存在」，而 400 对「不存在」和「已用过」是同一句话。
    response = client.post(
        "/api/v1/blender/pairing/approve", json={"code": "ZZZZ-ZZZZ"}
    )

    assert response.status_code == 400
    assert "配对码" in response.json()["detail"]


def test_approve_requires_a_session(tmp_path, monkeypatch):
    db_path = tmp_path / "blender.db"
    blender_store.init_db(db_path)
    monkeypatch.setattr(blender, "_db", lambda: db_path)

    async def _reject():
        from fastapi import HTTPException

        raise HTTPException(status_code=401, detail="未登录")

    app = FastAPI()
    app.include_router(blender.router, prefix="/api/v1")
    app.dependency_overrides[blender.get_api_user] = _reject
    with TestClient(app) as unauthenticated:
        response = unauthenticated.post(
            "/api/v1/blender/pairing/approve", json={"code": "ABCD-EFGH"}
        )

    assert response.status_code == 401


def test_polling_an_unknown_pairing_id_says_expired(client):
    body = client.get("/api/v1/blender/pairing/nope").json()

    assert body == {"status": "expired"}


def test_start_is_rate_limited_per_client(client, monkeypatch):
    # 固定窗口按墙钟对齐。不钉住时钟的话，这串调用跨过 60 秒边界时计数清零，
    # 最后一次就不是 429 了——一年掉一次的那种 flaky，最难查。
    monkeypatch.setattr(blender_store, "_now", lambda: 1_800_000_000)

    for _ in range(blender.PAIRING_START_LIMIT):
        assert client.post("/api/v1/blender/pairing/start").status_code == 200

    response = client.post("/api/v1/blender/pairing/start")

    assert response.status_code == 429


def test_approve_is_rate_limited_per_user(client, monkeypatch):
    monkeypatch.setattr(blender_store, "_now", lambda: 1_800_000_000)

    for _ in range(blender.PAIRING_APPROVE_LIMIT):
        client.post("/api/v1/blender/pairing/approve", json={"code": "ZZZZ-ZZZZ"})

    response = client.post(
        "/api/v1/blender/pairing/approve", json={"code": "ZZZZ-ZZZZ"}
    )

    # 猜码必须被挡住，否则 40 bit 挡不了多久。
    assert response.status_code == 429
