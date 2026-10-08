"""LibTV share import uses only a copyable project and a local cookie file."""

from __future__ import annotations

import json

import httpx
import pytest

from novelvideo.freezone import liblib_import


SHARE_URL = (
    "https://www.liblib.tv/canvas/share?spaceId=8347675"
    "&projectId=64c5bb59a1cb4296bece54f7e7d66994"
)


def test_parse_share_url_restricts_host_and_endpoint() -> None:
    share = liblib_import.parse_liblib_share_url(SHARE_URL)
    assert share.space_id == "8347675"
    assert share.project_id == "64c5bb59a1cb4296bece54f7e7d66994"
    with pytest.raises(liblib_import.LiblibImportError, match="HTTPS"):
        liblib_import.parse_liblib_share_url(SHARE_URL.replace("https:", "http:"))
    with pytest.raises(liblib_import.LiblibImportError):
        liblib_import.parse_liblib_share_url(SHARE_URL.replace("www.liblib.tv", "www.liblib.tv.evil.test"))
    with pytest.raises(liblib_import.LiblibImportError):
        liblib_import.parse_liblib_share_url(SHARE_URL.replace("/canvas/share", "/canvas"))


def test_read_local_cookie_supports_compact_object_and_export_list(tmp_path) -> None:
    path = tmp_path / liblib_import.COOKIE_FILENAME
    path.write_text(json.dumps({"usertoken": "example-token", "webid": "example-webid"}))
    assert liblib_import.read_liblib_cookie(path) == ("example-token", "example-webid")
    path.write_text(json.dumps([
        {"name": "usertoken", "value": "updated-token"},
        {"name": "webid", "value": "updated-webid"},
    ]))
    assert liblib_import.read_liblib_cookie(path) == ("updated-token", "updated-webid")
    path.write_text("{}")
    with pytest.raises(liblib_import.LiblibImportError) as exc:
        liblib_import.read_liblib_cookie(path)
    assert exc.value.code == "liblib_cookie_invalid"


@pytest.mark.asyncio
async def test_fetch_detail_checks_copy_policy_and_project_identity(monkeypatch) -> None:
    share = liblib_import.parse_liblib_share_url(SHARE_URL)
    monkeypatch.setattr(liblib_import, "read_liblib_cookie", lambda: ("example-token", "example-webid"))
    payload = {
        "code": 0,
        "data": {
            "projectMeta": {
                "uuid": share.project_id,
                "name": "Example",
                "projectSpaceId": int(share.space_id),
                "accessConfig": {"accessPolicy": 2, "allowCopy": True},
            },
            "projectDraft": {"viewportZoom": "0.1"},
            "nodeList": [{"nodeKey": "image-1"}],
            "connectionList": [],
        },
    }

    class FakeClient:
        def __init__(self, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return None

        async def get(self, url, *, params, headers):
            assert url == liblib_import.DETAIL_URL
            assert params == {"uuid": share.project_id}
            assert headers["token"] == "example-token"
            return httpx.Response(200, json=payload, request=httpx.Request("GET", url))

    monkeypatch.setattr(liblib_import.httpx, "AsyncClient", FakeClient)
    detail = await liblib_import.fetch_liblib_canvas_detail(share)
    assert detail["projectMeta"] == {
        "uuid": share.project_id,
        "name": "Example",
        "projectSpaceId": int(share.space_id),
    }
    assert detail["nodeList"] == [{"nodeKey": "image-1"}]

    payload["data"]["projectMeta"]["accessConfig"]["allowCopy"] = False
    with pytest.raises(liblib_import.LiblibImportError) as exc:
        await liblib_import.fetch_liblib_canvas_detail(share)
    assert exc.value.code == "liblib_not_copyable"

    payload["data"]["projectMeta"]["accessConfig"]["allowCopy"] = True
    payload["data"]["projectMeta"]["uuid"] = "another-project"
    with pytest.raises(liblib_import.LiblibImportError) as exc:
        await liblib_import.fetch_liblib_canvas_detail(share)
    assert exc.value.code == "liblib_project_mismatch"
