"""LibTV references and media are copied into project-local storage."""

from __future__ import annotations

import json
from pathlib import Path

import httpx
import pytest

from novelvideo.freezone.liblib_assets import (
    _download_media,
    _download_media_or_reason,
    _media_target,
    _mirrorable_media_url,
    canvas_media_urls,
    localize_media_urls,
)
from novelvideo.freezone.liblib_import import LiblibImportError


MEDIA = "https://libtv-res.liblib.art/example/image.png"
VIDEO = "https://libtv-res.liblib.art/example/video.mp4"
IMAGE_BYTES = b"\x89PNG\r\n\x1a\nlocal-image"


def test_collects_originals_references_and_cross_browser_previews() -> None:
    detail = {
        "nodeList": [
            {"type": 2, "data": json.dumps({"url": [MEDIA]})},
            {"type": 3, "data": json.dumps({
                "url": [VIDEO],
                "params": {"mixedList": [{"mediaType": "image", "url": MEDIA}]},
            })},
        ],
    }
    urls, skipped = canvas_media_urls(detail)
    assert skipped == {}
    assert MEDIA in urls
    assert VIDEO in urls
    assert any("image%2Fresize" in url for url in urls)
    assert any("video%2Fsnapshot" in url for url in urls)
    assert len(urls) == 4
    poster_url = next(url for url in urls if "video%2Fsnapshot" in url)
    assert _media_target(Path("media"), poster_url).suffix == ".jpg"


def test_skips_unmirrorable_reference_instead_of_failing_the_whole_canvas() -> None:
    """一条存不下来的素材不该否决整张画布。

    LibTV 自己就不止一个素材域(「AI 搜图」的素材落在 xla-persist.xingliu.art),
    按厂商域名做白名单永远补不全,而补不全的代价是几十个节点一个都进不来。
    存不下的素材跳过即可——前端 `assetUrl()` 会自动回落到远端地址。
    """
    unreachable = "https://127.0.0.1/private.png"
    detail = {"nodeList": [{"type": 2, "data": json.dumps({
        "url": [MEDIA],
        "params": {"imageList": [{"url": unreachable}]},
    })}]}
    urls, skipped = canvas_media_urls(detail)
    assert MEDIA in urls
    assert skipped == {unreachable: "internal_host"}
    assert unreachable not in urls


def test_refuses_to_fetch_internal_addresses() -> None:
    """host 校验保留的是安全护栏而不是厂商护栏:后端会真的去 GET 这些地址。"""
    assert _mirrorable_media_url("https://127.0.0.1/a.png") is None
    assert _mirrorable_media_url("https://10.0.0.5/a.png") is None
    assert _mirrorable_media_url("https://[::1]/a.png") is None
    assert _mirrorable_media_url("http://libtv-res.liblib.art/a.png") is None
    assert _mirrorable_media_url("https://user:pw@libtv-res.liblib.art/a.png") is None
    # 陌生但公网的厂商域名照常镜像 —— 不再按域名白名单拦。
    assert _mirrorable_media_url(MEDIA) == MEDIA


def test_domain_resolving_into_a_private_range_is_still_mirrorable(monkeypatch) -> None:
    """代理软件的 fake-IP 会把正常 CDN 域名解析到 198.18/15,不能因此判为内网。

    按私有段拦的后果不是「少存一张图」,而是整张画布 99/99 条素材全部
    internal_host、一张都本地化不了。https + 证书校验已经挡住了 SSRF:
    内网服务拿不出 LibTV 域名的合法证书。
    """
    from novelvideo.freezone import liblib_assets

    liblib_assets._is_internal_host.cache_clear()
    monkeypatch.setattr(
        liblib_assets.socket,
        "getaddrinfo",
        lambda host, port: [(2, 1, 6, "", ("198.18.0.7", 0))],
    )
    try:
        assert _mirrorable_media_url(MEDIA) == MEDIA
    finally:
        liblib_assets._is_internal_host.cache_clear()


def test_domain_resolving_to_loopback_is_still_refused(monkeypatch) -> None:
    """放宽私有段不等于放弃护栏:回环这类绝无可能的目标照旧拦。"""
    from novelvideo.freezone import liblib_assets

    liblib_assets._is_internal_host.cache_clear()
    monkeypatch.setattr(
        liblib_assets.socket,
        "getaddrinfo",
        lambda host, port: [(2, 1, 6, "", ("127.0.0.1", 0))],
    )
    try:
        assert _mirrorable_media_url(MEDIA) is None
    finally:
        liblib_assets._is_internal_host.cache_clear()


def test_ignores_nodes_and_references_without_downloadable_media() -> None:
    detail = {"nodeList": [
        {"type": 5, "data": json.dumps({"type": "group", "childNodeIds": ["image-1"]})},
        {"type": 1, "data": json.dumps({"type": "text", "text": "prompt"})},
        {"type": 2, "data": json.dumps({
            "type": "image",
            "params": {"imageList": [{"nodeId": "pending", "url": None}]},
        })},
    ]}
    assert canvas_media_urls(detail) == ([], {})


@pytest.mark.asyncio
async def test_downloads_media_and_reuses_local_file(tmp_path) -> None:
    calls = 0

    def handle(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        assert request.url == MEDIA
        # The CDN may report binary media as application/octet-stream.
        return httpx.Response(200, headers={"content-type": "application/octet-stream"}, content=IMAGE_BYTES)

    target = _media_target(tmp_path, MEDIA)
    async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
        assert await _download_media(client, MEDIA, target) == (target, len(IMAGE_BYTES))
        assert target.read_bytes() == IMAGE_BYTES
        assert await _download_media(client, MEDIA, target) == (target, len(IMAGE_BYTES))
    assert calls == 1


@pytest.mark.asyncio
async def test_renames_jpg_url_when_media_is_png(tmp_path) -> None:
    jpg_url = "https://libtv-res.liblib.art/example/misnamed.jpg"
    target = _media_target(tmp_path, jpg_url)
    transport = httpx.MockTransport(lambda request: httpx.Response(
        200, headers={"content-type": "application/octet-stream"}, content=IMAGE_BYTES,
    ))
    async with httpx.AsyncClient(transport=transport) as client:
        actual, size = await _download_media(client, jpg_url, target)
        assert (actual, size) == (target.with_suffix(".png"), len(IMAGE_BYTES))
        assert await _download_media(client, jpg_url, target) == (actual, size)
    assert actual.read_bytes() == IMAGE_BYTES
    assert not target.exists()


@pytest.mark.asyncio
async def test_rejects_remote_non_media_response(tmp_path) -> None:
    target = _media_target(tmp_path, MEDIA)
    transport = httpx.MockTransport(lambda request: httpx.Response(
        200, headers={"content-type": "text/html"}, content=b"login",
    ))
    async with httpx.AsyncClient(transport=transport) as client:
        with pytest.raises(LiblibImportError) as exc:
            await _download_media(client, MEDIA, target)
    assert exc.value.code == "liblib_media_type_invalid"
    assert not target.exists()


@pytest.mark.asyncio
async def test_download_failure_is_skipped_not_fatal(tmp_path) -> None:
    """源站取不到只影响这一条素材,不该让整张画布导入失败。"""
    target = _media_target(tmp_path, MEDIA)
    assert target is not None
    transport = httpx.MockTransport(lambda request: httpx.Response(404))
    async with httpx.AsyncClient(transport=transport) as client:
        with pytest.raises(LiblibImportError):
            await _download_media(client, MEDIA, target)
        # 失败返回原因码而不是抛错 —— 原因要一路显示到节点上。
        assert await _download_media_or_reason(client, MEDIA, target) == "liblib_media_unavailable"


def test_unknown_extension_is_skipped_not_fatal(tmp_path) -> None:
    assert _media_target(tmp_path, "https://libtv-res.liblib.art/example/thing.exe") is None
    assert _media_target(tmp_path, MEDIA) is not None


@pytest.mark.asyncio
async def test_localize_media_urls_reports_per_url_reasons(tmp_path: Path) -> None:
    """「一键本地化」要能单独重跑,而且照旧逐条给原因,不因为一条坏地址整批失败。"""
    asset_map, skipped = await localize_media_urls(
        ["https://127.0.0.1/a.png", "not-a-url"],
        tmp_path,
        "proj",
        "802b3f40",
    )
    assert asset_map == {}
    assert {item["url"]: item["reason"] for item in skipped} == {
        "https://127.0.0.1/a.png": "internal_host",
        "not-a-url": "not_https",
    }


@pytest.mark.asyncio
async def test_localize_media_urls_writes_into_the_import_media_dir(tmp_path: Path, monkeypatch) -> None:
    """补下载必须落回导入时同一个目录,否则重复导入会拿不到已本地化的文件。"""
    from novelvideo.freezone import liblib_assets

    async def fake_download(_client, url, target):
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(b"\x89PNG\r\n\x1a\n" + b"0" * 24)
        return target, 32

    monkeypatch.setattr(liblib_assets, "_download_media", fake_download)
    asset_map, skipped = await localize_media_urls([MEDIA], tmp_path, "proj", "802b3f40")
    assert skipped == []
    assert list(asset_map) == [MEDIA]
    assert (tmp_path / "freezone" / "liblib_import" / "802b3f40" / "media").is_dir()
