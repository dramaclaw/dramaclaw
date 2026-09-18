from __future__ import annotations

import inspect

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from novelvideo import blender_store
from novelvideo.api.routes import blender


@pytest.fixture()
def probe(tmp_path, monkeypatch):
    """一个只回显调用者身份的探针端点，用来测依赖本身。"""
    db_path = tmp_path / "blender.db"
    blender_store.init_db(db_path)
    monkeypatch.setattr(blender, "_db", lambda: db_path)

    app = FastAPI()

    @app.get("/probe")
    async def _probe(client=Depends(blender.get_blender_client)):
        return {"user_id": client.user_id, "label": client.label}

    with TestClient(app) as test_client:
        test_client.db_path = db_path
        yield test_client


def _issue_token(db_path, user_id="alice"):
    pairing = blender_store.create_pairing(db_path)
    blender_store.approve_pairing(db_path, pairing.code, user_id=user_id)
    return blender_store.consume_pairing(db_path, pairing.pairing_id).token


def test_valid_token_is_accepted(probe):
    token = _issue_token(probe.db_path)

    response = probe.get("/probe", headers={"Authorization": f"Bearer {token}"})

    assert response.status_code == 200
    assert response.json()["user_id"] == "alice"


def test_missing_header_is_401(probe):
    assert probe.get("/probe").status_code == 401


def test_wrong_scheme_is_401(probe):
    token = _issue_token(probe.db_path)

    response = probe.get("/probe", headers={"Authorization": f"Token {token}"})

    assert response.status_code == 401


def test_garbage_token_is_401(probe):
    assert (
        probe.get("/probe", headers={"Authorization": "Bearer nope"}).status_code == 401
    )


def test_revoked_token_is_401(probe):
    token = _issue_token(probe.db_path)
    token_id = blender_store.list_tokens(probe.db_path, user_id="alice")[0].token_id
    blender_store.revoke_token(probe.db_path, token_id, user_id="alice")

    response = probe.get("/probe", headers={"Authorization": f"Bearer {token}"})

    assert response.status_code == 401


def test_a_session_cookie_does_not_work_here(probe):
    # 反过来也要成立：浏览器会话不能冒充插件，否则 CSRF 就能触发投递。
    # 直接发 Cookie 头而不是 cookies=：httpx 0.28 对 per-request cookies 已在发弃用警告。
    response = probe.get("/probe", headers={"Cookie": "st_session=whatever"})

    assert response.status_code == 401


def test_blender_client_is_not_wired_into_the_main_auth_chain():
    """插件令牌绝不能变成一把通用的 30 天 API 钥匙。

    这条测试盯的是一个架构约束，不是一个函数的行为：`novelvideo/api/auth.py` 只认
    浏览器会话和短时 agent bearer。哪天有人图省事把 `verify_token` 接进去，这里就红。
    """
    from novelvideo.api import auth

    source = inspect.getsource(auth)

    assert "blender_store" not in source
    assert "get_blender_client" not in source
