"""DRAMACLAW_FRONTEND_DIST 门控的 SPA 静态伺服契约。

Starlette StaticFiles 未命中时是 raise HTTPException(404) 而非返回 404
响应,SPA 回落必须捕获它;深链接/刷新客户端路由要拿到 index.html,
而缺失的静态资产(带扩展名)仍应如实 404。
"""

from pathlib import Path

import pytest

pytestmark = pytest.mark.m07


@pytest.fixture()
def spa_client(tmp_path: Path, monkeypatch):
    dist = tmp_path / "dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text("<html>SPA-SHELL</html>", encoding="utf-8")
    (dist / "assets" / "app.js").write_text("console.log(1)", encoding="utf-8")
    monkeypatch.setenv("DRAMACLAW_FRONTEND_DIST", str(dist))

    from starlette.testclient import TestClient

    from novelvideo.api.app import create_app

    return TestClient(create_app(), raise_server_exceptions=False)


def test_root_serves_index(spa_client):
    r = spa_client.get("/")
    assert r.status_code == 200
    assert "SPA-SHELL" in r.text


def test_real_asset_is_served(spa_client):
    r = spa_client.get("/assets/app.js")
    assert r.status_code == 200
    assert r.text == "console.log(1)"


def test_deep_link_falls_back_to_index(spa_client):
    r = spa_client.get("/projects/abc/ingest")
    assert r.status_code == 200
    assert "SPA-SHELL" in r.text


def test_missing_asset_with_extension_stays_404(spa_client):
    assert spa_client.get("/missing.js").status_code == 404


def test_api_routes_take_precedence(spa_client):
    r = spa_client.get("/api/v1/config")
    assert r.status_code == 200
    assert r.json()["ok"] is True


def test_shell_must_revalidate(spa_client):
    """旧 index.html 被缓存住会让升级后的首屏 404(黑屏)。"""
    assert spa_client.get("/").headers["cache-control"] == "no-cache"


def test_deep_link_shell_must_revalidate(spa_client):
    r = spa_client.get("/projects/abc/ingest")
    assert r.headers["cache-control"] == "no-cache"


def test_hashed_assets_are_immutable(spa_client):
    r = spa_client.get("/assets/app.js")
    assert r.headers["cache-control"] == "public, max-age=31536000, immutable"


def test_asset_redirect_is_not_cached(spa_client, tmp_path: Path):
    """跳转/错误响应被长期缓存会在 URL 不变时永久卡住(同 #92 的教训)。"""
    (tmp_path / "dist" / "assets" / "sub").mkdir()
    (tmp_path / "dist" / "assets" / "sub" / "index.html").write_text(
        "s", encoding="utf-8"
    )
    r = spa_client.get("/assets/sub", follow_redirects=False)
    assert r.status_code == 307
    assert "immutable" not in r.headers.get("cache-control", "")


def test_asset_404_page_is_not_cached(spa_client, tmp_path: Path):
    (tmp_path / "dist" / "404.html").write_text("nf", encoding="utf-8")
    r = spa_client.get("/assets/missing.js")
    assert r.status_code == 404
    assert "immutable" not in r.headers.get("cache-control", "")


def test_asset_range_and_revalidation_stay_immutable(spa_client):
    r = spa_client.get("/assets/app.js", headers={"range": "bytes=0-0"})
    assert r.status_code == 206
    assert r.headers["cache-control"] == "public, max-age=31536000, immutable"
    etag = spa_client.get("/assets/app.js").headers["etag"]
    r = spa_client.get("/assets/app.js", headers={"if-none-match": etag})
    assert r.status_code == 304
    assert r.headers["cache-control"] == "public, max-age=31536000, immutable"
