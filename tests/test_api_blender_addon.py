"""GET /blender/addon：项目管理中心「Blender 插件」按钮背后的下载端点。

包从哪来：本地 dist 里有就用本地的，没有就去 OSS 取。两条路都要注入同样的配置。
"""

from __future__ import annotations

import io
import json
import zipfile
from urllib.parse import urlsplit

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from novelvideo import blender_store
from novelvideo.api.routes import blender


@pytest.fixture()
def dist(tmp_path, monkeypatch):
    dist_dir = tmp_path / "dist"
    dist_dir.mkdir()
    monkeypatch.setenv(blender.ADDON_DIST_ENV, str(dist_dir))
    return dist_dir


class FakeOSS:
    """替掉真网络。默认什么都没传（404），测试按需往 `files` 里放包。"""

    def __init__(self) -> None:
        self.files: dict[str, bytes] = {}
        self.requested: list[str] = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        self.requested.append(url)
        if url in self.files:
            return httpx.Response(200, content=self.files[url])
        return httpx.Response(404, text="NoSuchKey")


@pytest.fixture(autouse=True)
def oss(monkeypatch):
    fake = FakeOSS()
    monkeypatch.delenv(blender.ADDON_URL_ENV, raising=False)
    monkeypatch.setattr(
        blender,
        "_addon_http_client",
        lambda: httpx.AsyncClient(transport=httpx.MockTransport(fake.handler)),
    )
    return fake


def _app(with_user: bool = True) -> FastAPI:
    app = FastAPI()
    app.include_router(blender.router, prefix="/api/v1")
    if with_user:
        app.dependency_overrides[blender.get_api_user] = lambda: {"username": "alice"}
    return app


def _make_zip(path, marker: str = "print('hi')\n") -> None:
    """造一个真 zip。端点现在要把包解开再重打，假字节过不去。"""
    path.write_bytes(_zip_bytes(marker))


def _zip_bytes(init_source: str = "print('hi')\n") -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("dramaclaw_blender/__init__.py", init_source)
    return buffer.getvalue()


def _entries(payload: bytes) -> dict[str, bytes]:
    with zipfile.ZipFile(io.BytesIO(payload)) as archive:
        return {name: archive.read(name) for name in archive.namelist()}


def test_serves_the_zip_as_an_attachment(dist):
    _make_zip(dist / "dramaclaw_blender-0.1.0.zip")
    with TestClient(_app()) as client:
        response = client.get("/api/v1/blender/addon")
    assert response.status_code == 200
    assert response.headers["content-type"] == "application/zip"
    disposition = response.headers["content-disposition"]
    assert "attachment" in disposition
    assert "dramaclaw_blender-0.1.0.zip" in disposition
    # no-store 而不是 no-cache：内容现在因人因请求而异，中间层一份都不许留。
    assert response.headers["cache-control"] == "no-store"
    assert "dramaclaw_blender/__init__.py" in _entries(response.content)


def test_picks_the_highest_version_numerically(dist):
    # 0.10.0 > 0.2.0 只有按数字比才成立，按字符串比会选到 0.2.0。
    for version in ("0.1.0", "0.2.0", "0.10.0"):
        _make_zip(dist / f"dramaclaw_blender-{version}.zip", marker=version)
    with TestClient(_app()) as client:
        response = client.get("/api/v1/blender/addon")
    assert response.status_code == 200
    assert "dramaclaw_blender-0.10.0.zip" in response.headers["content-disposition"]
    assert _entries(response.content)["dramaclaw_blender/__init__.py"] == b"0.10.0"


def test_ignores_files_that_are_not_versioned_addon_zips(dist):
    (dist / "readme.txt").write_text("nope")
    (dist / "dramaclaw_blender.zip").write_bytes(b"no version in name")
    # 前后缀都不许放过：这两个钉住「整名匹配」。把 fullmatch 换成 match 会把
    # .partial / .bak 这种半成品当成插件包发出去。
    (dist / "dramaclaw_blender-9.9.9.zip.bak").write_bytes(b"leftover")
    (dist / "old-dramaclaw_blender-9.9.9.zip").write_bytes(b"archived")
    # 名字对得上正则，但它是个目录——不是能发的文件，必须跳过。
    (dist / "dramaclaw_blender-9.9.9.zip").mkdir()
    with TestClient(_app()) as client:
        response = client.get("/api/v1/blender/addon")
    # 本地一个都不认，于是去 OSS 取；假 OSS 上没有包，就是 502。
    assert response.status_code == 502


def test_missing_dist_dir_falls_through_to_oss(tmp_path, monkeypatch, oss):
    monkeypatch.setenv(blender.ADDON_DIST_ENV, str(tmp_path / "nowhere"))
    with TestClient(_app()) as client:
        assert client.get("/api/v1/blender/addon").status_code == 502
    assert oss.requested == [blender.DEFAULT_ADDON_URL]


def test_dist_path_that_is_a_file_falls_through_to_oss(tmp_path, monkeypatch, oss):
    # ADDON_DIST_ENV 配错，指到了一个文件而不是目录——不能 iterdir()，当作本地没有。
    not_a_dir = tmp_path / "not-a-dir"
    not_a_dir.write_bytes(b"oops")
    monkeypatch.setenv(blender.ADDON_DIST_ENV, str(not_a_dir))
    with TestClient(_app()) as client:
        assert client.get("/api/v1/blender/addon").status_code == 502
    assert oss.requested == [blender.DEFAULT_ADDON_URL]


def test_requires_the_browser_session_dependency(dist, tmp_path, monkeypatch):
    # 不覆盖 get_api_user：裸测试应用没注册 auth port，真实依赖会给 503；
    # 若换成别的 auth 后端会是 401。两种都说明端点确实挂了鉴权，拿不到文件。
    #
    # 光测「没有凭证时拿不到」不够：如果路由误挂成 get_blender_client，一个没
    # 带凭证的请求也是 401，测试照样通过却验证错了东西。所以还要签发一个真实
    # 有效的插件令牌，证明「即使拿着合法插件令牌」也下载不到——这个端点是给
    # 浏览器用的，不是给插件用的。
    (dist / "dramaclaw_blender-0.1.0.zip").write_bytes(b"zip")

    db_path = tmp_path / "blender.db"
    blender_store.init_db(db_path)
    monkeypatch.setattr(blender, "_db", lambda: db_path)
    pairing = blender_store.create_pairing(db_path)
    blender_store.approve_pairing(db_path, pairing.code, user_id="alice")
    token = blender_store.consume_pairing(db_path, pairing.pairing_id).token

    with TestClient(_app(with_user=False)) as client:
        no_cred = client.get("/api/v1/blender/addon")
        with_plugin_token = client.get(
            "/api/v1/blender/addon", headers={"Authorization": f"Bearer {token}"}
        )

    assert no_cred.status_code in (401, 503)
    assert with_plugin_token.status_code != 200


def _config(payload: bytes) -> dict:
    return json.loads(_entries(payload)["dramaclaw_blender/config.json"])


def test_injects_the_backend_and_web_addresses(dist):
    _make_zip(dist / "dramaclaw_blender-0.1.0.zip")
    with TestClient(_app()) as client:
        response = client.get(
            "/api/v1/blender/addon",
            headers={
                "X-Forwarded-Proto": "https",
                "X-Forwarded-Host": "drama.example.com",
                "Referer": "https://drama.example.com/projects",
            },
        )
    assert _config(response.content) == {
        "server_url": "https://drama.example.com",
        "web_url": "https://drama.example.com",
    }


def test_web_url_comes_from_the_referer_origin(dist):
    # 开发环境：页面在 vite 的 5174，后端在 19081，两个地址必须分别对。
    _make_zip(dist / "dramaclaw_blender-0.1.0.zip")
    with TestClient(_app()) as client:
        response = client.get(
            "/api/v1/blender/addon",
            headers={"Referer": "http://localhost:5174/some/page?x=1"},
        )
    config = _config(response.content)
    # 只取 origin，路径和查询串都不要。
    assert config["web_url"] == "http://localhost:5174"


def test_web_url_falls_back_to_the_server_url_without_a_referer(dist):
    # Referer 可能被 referrer policy 剥掉。那就退回今天的行为，不能更差。
    _make_zip(dist / "dramaclaw_blender-0.1.0.zip")
    with TestClient(_app()) as client:
        response = client.get("/api/v1/blender/addon")
    config = _config(response.content)
    assert config["web_url"] == config["server_url"]


def test_env_override_wins_over_the_forwarded_headers(dist, monkeypatch):
    # 给那些两种转发头都不可靠的部署留的出口。
    monkeypatch.setenv(blender.PUBLIC_BASE_URL_ENV, "https://fixed.example.com/")
    _make_zip(dist / "dramaclaw_blender-0.1.0.zip")
    with TestClient(_app()) as client:
        response = client.get(
            "/api/v1/blender/addon",
            headers={
                "X-Forwarded-Proto": "https",
                "X-Forwarded-Host": "ignored.example.com",
            },
        )
    # 末尾的斜杠要去掉。这是防御性的规范化，不是插件依赖它：插件那三处拼接
    # （prefs.py `api_url`、ops.py 的轮询、core/pairing.py `approve_page_url`）
    # 自己都 rstrip 过。所以斜杠留着也不会坏，去掉只是别让 config.json 里出现
    # 两种写法、别让人以后对着 `//api/v1` 猜是谁的锅。
    assert _config(response.content)["server_url"] == "https://fixed.example.com"


def test_keeps_every_file_from_the_original_zip(dist):
    target = dist / "dramaclaw_blender-0.1.0.zip"
    with zipfile.ZipFile(target, "w") as archive:
        archive.writestr("dramaclaw_blender/__init__.py", "a")
        archive.writestr("dramaclaw_blender/ops.py", "b")
        archive.writestr("dramaclaw_blender/core/pairing.py", "c")
    with TestClient(_app()) as client:
        response = client.get("/api/v1/blender/addon")
    entries = _entries(response.content)
    # 重打包漏文件是最难发现的 bug：装上去缺个模块，插件启动就炸。
    assert entries["dramaclaw_blender/__init__.py"] == b"a"
    assert entries["dramaclaw_blender/ops.py"] == b"b"
    assert entries["dramaclaw_blender/core/pairing.py"] == b"c"


def test_forwarded_headers_use_the_value_nearest_the_app(dist):
    # 追加式代理链上这两个头会有多个值，最后一个才是离应用最近那一跳写的，前面的
    # 是客户端自己塞的。取 [0] 就等于让客户端指定服务器地址；这条钉住 [-1]。
    _make_zip(dist / "dramaclaw_blender-0.1.0.zip")
    with TestClient(_app()) as client:
        response = client.get(
            "/api/v1/blender/addon",
            headers={
                # 两个头都按「先客户端塞的、后代理追加的」排：proto 取到 https、
                # host 取到 real，取 [0] 则是 http://evil.example.com。
                "X-Forwarded-Proto": "http, https",
                "X-Forwarded-Host": "evil.example.com, real.example.com",
            },
        )
    assert _config(response.content)["server_url"] == "https://real.example.com"


def test_forwarded_host_with_inner_whitespace_is_rejected(dist):
    # 制表符在头部值里是合法字符（CRLF 才会被 h11 拦掉），所以这不是响应头注入，
    # 但 `https://a.example.com\tevil` 是个谁也连不上的地址。整级作废，回落到
    # request.base_url——TestClient 下就是 http://testserver。
    _make_zip(dist / "dramaclaw_blender-0.1.0.zip")
    with TestClient(_app()) as client:
        response = client.get(
            "/api/v1/blender/addon",
            headers={
                "X-Forwarded-Proto": "https",
                "X-Forwarded-Host": "a.example.com\tevil",
            },
        )
    assert _config(response.content)["server_url"] == "http://testserver"


def test_referer_with_userinfo_is_rejected(dist):
    # Referer 里正常不会带 userinfo，带了就当它不可用——否则 web_url 会变成
    # `https://user:pass@...`，一串凭证被原样写进用户的包里。
    _make_zip(dist / "dramaclaw_blender-0.1.0.zip")
    with TestClient(_app()) as client:
        response = client.get(
            "/api/v1/blender/addon",
            headers={"Referer": "https://user:pass@drama.example.com/p"},
        )
    config = _config(response.content)
    assert "@" not in config["web_url"]
    # 拒掉之后走调用方的回落分支：回到后端自己的地址。
    assert config["web_url"] == config["server_url"]


def test_a_config_entry_in_the_source_zip_is_replaced_not_duplicated(dist):
    # build.py 今天只打 *.py，所以这是潜在情况；但真发生时重打会写出两条重名记录，
    # 读到哪一条全看实现。钉住：服务出去的包里这个名字只有一条，且是新注入的那条。
    target = dist / "dramaclaw_blender-0.1.0.zip"
    with zipfile.ZipFile(target, "w") as archive:
        archive.writestr("dramaclaw_blender/__init__.py", "a")
        archive.writestr("dramaclaw_blender/config.json", '{"server_url": "junk"}')
    with TestClient(_app()) as client:
        response = client.get(
            "/api/v1/blender/addon",
            headers={
                "X-Forwarded-Proto": "https",
                "X-Forwarded-Host": "drama.example.com",
            },
        )
    assert response.status_code == 200
    with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
        assert archive.namelist().count("dramaclaw_blender/config.json") == 1
    assert _config(response.content) == {
        "server_url": "https://drama.example.com",
        "web_url": "https://drama.example.com",
    }


def test_a_corrupt_zip_fails_with_a_diagnosable_500(dist):
    # build.py 直接往最终路径写、没有临时文件加改名，所以「下载撞上重新打包、读到
    # 半截包」是真会发生的。裸 BadZipFile 逃出路由只会给运维一句「File is not a zip
    # file」，连哪个文件都不说。这条钉住：500，而且正文里有文件名。
    target = dist / "dramaclaw_blender-0.1.0.zip"
    target.write_bytes(b"PK\x03\x04 truncated garbage")
    with TestClient(_app()) as client:
        response = client.get("/api/v1/blender/addon")
    assert response.status_code == 500
    detail = response.json()["detail"]
    assert "dramaclaw_blender-0.1.0.zip" in detail
    # 文件名够定位了，绝对路径不要进 HTTP 正文。光断言「正文里有文件名」钉不住这点：
    # 绝对路径天然包含文件名，退回 f"{target}" 这条断言照样绿（复审实测过）。
    assert str(dist) not in detail


# ---- 本地没有包：从 OSS 取 -------------------------------------------------

_VERSIONED_INIT = 'bl_info = {\n    "version": (0, 1, 3),\n}\n'


def test_fetches_from_oss_and_injects_config_when_no_local_zip(dist, oss):
    oss.files[blender.DEFAULT_ADDON_URL] = _zip_bytes(_VERSIONED_INIT)
    with TestClient(_app()) as client:
        response = client.get(
            "/api/v1/blender/addon",
            headers={
                "X-Forwarded-Proto": "https",
                "X-Forwarded-Host": "drama.example.com",
                "Referer": "https://drama.example.com/projects",
            },
        )
    assert response.status_code == 200
    assert oss.requested == [blender.DEFAULT_ADDON_URL]
    assert response.headers["cache-control"] == "no-store"
    assert _config(response.content) == {
        "server_url": "https://drama.example.com",
        "web_url": "https://drama.example.com",
    }
    assert _entries(response.content)["dramaclaw_blender/__init__.py"] == (
        _VERSIONED_INIT.encode()
    )


def test_oss_download_is_named_by_the_bl_info_version(dist, oss):
    # OSS 上是 -latest.zip，下载下来得带真版本号，不然用户分不清装的是哪版。
    oss.files[blender.DEFAULT_ADDON_URL] = _zip_bytes(_VERSIONED_INIT)
    with TestClient(_app()) as client:
        response = client.get("/api/v1/blender/addon")
    assert (
        'filename="dramaclaw_blender-0.1.3.zip"'
        in response.headers["content-disposition"]
    )


def test_oss_download_without_a_readable_version_still_succeeds(dist, oss):
    oss.files[blender.DEFAULT_ADDON_URL] = _zip_bytes("no bl_info here")
    with TestClient(_app()) as client:
        response = client.get("/api/v1/blender/addon")
    assert response.status_code == 200
    assert 'filename="dramaclaw_blender.zip"' in response.headers["content-disposition"]


def test_env_overrides_the_oss_url(dist, oss, monkeypatch):
    url = "https://mirror.example.com/addon/dramaclaw_blender-latest.zip"
    monkeypatch.setenv(blender.ADDON_URL_ENV, f"  {url}  ")
    oss.files[url] = _zip_bytes(_VERSIONED_INIT)
    with TestClient(_app()) as client:
        response = client.get("/api/v1/blender/addon")
    assert response.status_code == 200
    assert oss.requested == [url]


def test_local_zip_wins_and_oss_is_not_touched(dist, oss):
    # 开发机跑过 build.py，下载到的就该是刚打的包，而不是 OSS 上的旧版。
    _make_zip(dist / "dramaclaw_blender-0.1.0.zip", marker="local")
    oss.files[blender.DEFAULT_ADDON_URL] = _zip_bytes("remote")
    with TestClient(_app()) as client:
        response = client.get("/api/v1/blender/addon")
    assert _entries(response.content)["dramaclaw_blender/__init__.py"] == b"local"
    assert oss.requested == []


def test_oss_missing_is_a_502_without_leaking_the_url(dist, oss):
    with TestClient(_app()) as client:
        response = client.get("/api/v1/blender/addon")
    assert response.status_code == 502
    # 取默认地址的真实域名，别写死：换过一次域名，写死的断言就成了空跑。
    assert urlsplit(blender.DEFAULT_ADDON_URL).hostname not in response.json()["detail"]


def test_oss_unreachable_is_a_502(dist, monkeypatch):
    def refuse(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused", request=request)

    monkeypatch.setattr(
        blender,
        "_addon_http_client",
        lambda: httpx.AsyncClient(transport=httpx.MockTransport(refuse)),
    )
    with TestClient(_app()) as client:
        assert client.get("/api/v1/blender/addon").status_code == 502


def test_oversized_oss_object_is_rejected(dist, oss, monkeypatch):
    # URL 配错指到一个大文件时，不能整个读进内存。
    monkeypatch.setattr(blender, "MAX_ADDON_BYTES", 1024)
    oss.files[blender.DEFAULT_ADDON_URL] = b"x" * 2048
    with TestClient(_app()) as client:
        assert client.get("/api/v1/blender/addon").status_code == 502


def test_corrupt_oss_object_is_a_diagnosable_500(dist, oss):
    oss.files[blender.DEFAULT_ADDON_URL] = b"<html>not a zip</html>"
    with TestClient(_app()) as client:
        response = client.get("/api/v1/blender/addon")
    assert response.status_code == 500
    assert "dramaclaw_blender.zip" in response.json()["detail"]
