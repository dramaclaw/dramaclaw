from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient


@pytest.fixture()
def folders_client(monkeypatch, tmp_path):
    from novelvideo.api.auth import get_api_user
    from novelvideo.api.routes import freezone

    project_dir = tmp_path / "project"
    project_dir.mkdir(parents=True, exist_ok=True)

    ctx = SimpleNamespace(
        project_id="proj_demo",
        owner_username="alice",
        project_name="demo",
        output_dir=str(project_dir),
        state_dir=str(project_dir),
        runtime_dir=str(project_dir / "_runtime"),
        is_home_node=True,
    )

    async def fake_resolve(project: str, user: dict, *, required_role: str = "editor"):
        return ctx, "alice", "demo", project_dir, str(project_dir)

    monkeypatch.setattr(freezone, "_resolve_freezone_project", fake_resolve)

    app = FastAPI()
    app.include_router(freezone.router, prefix="/api/v1")
    app.dependency_overrides[get_api_user] = lambda: {
        "id": "u-alice",
        "username": "alice",
    }
    return TestClient(app), project_dir


_FOLDERS = "/api/v1/projects/proj_demo/freezone/video/asset-library/folders"


def _new_folder(client: TestClient, name: str = "第一集素材") -> str:
    response = client.post(_FOLDERS, json={"name": name})
    assert response.status_code == 200, response.text
    return str(response.json()["data"]["id"])


def _cover(client: TestClient, folder_id: str) -> str | None:
    response = client.get(_FOLDERS)
    assert response.status_code == 200, response.text
    for folder in response.json()["data"]:
        if str(folder["id"]) == folder_id:
            return folder.get("cover")
    raise AssertionError(f"folder {folder_id} missing from listing")


def test_folder_cover_accepts_same_origin_asset(folders_client) -> None:
    client, project_dir = folders_client
    asset = project_dir / "freezone" / "_uploads" / "封面.png"
    asset.parent.mkdir(parents=True)
    asset.write_bytes(b"png")
    folder_id = _new_folder(client)

    response = client.patch(
        f"{_FOLDERS}/{folder_id}",
        json={"cover": "/freezone/_uploads/%E5%B0%81%E9%9D%A2.png"},
    )

    assert response.status_code == 200, response.text
    assert _cover(client, folder_id) == "/freezone/_uploads/%E5%B0%81%E9%9D%A2.png"


@pytest.mark.parametrize(
    "cover",
    [
        "https://evil.example/freezone/_uploads/foo.png",
        "//evil.example/freezone/_uploads/foo.png",
        "/\\evil.example/freezone/_uploads/foo.png",
    ],
)
def test_folder_cover_rejects_cross_origin_url(folders_client, cover: str) -> None:
    """封面是所有协作者的 <img src>，外链等于让别人的浏览器去访问第三方地址。

    攻击者用自己上传素材的真实路径拼在外链域名后面，削出来的 path 是落在项目里
    的——所以校验必须看整个字符串，且落库的要和校验过的是同一个值。
    """
    client, project_dir = folders_client
    decoy = project_dir / "freezone" / "_uploads" / "foo.png"
    decoy.parent.mkdir(parents=True)
    decoy.write_bytes(b"png")
    folder_id = _new_folder(client)

    response = client.patch(f"{_FOLDERS}/{folder_id}", json={"cover": cover})

    assert response.status_code == 400, response.text
    assert _cover(client, folder_id) in (None, "")


def test_folder_cover_missing_file_does_not_leak_server_path(folders_client) -> None:
    client, project_dir = folders_client
    folder_id = _new_folder(client)

    response = client.patch(
        f"{_FOLDERS}/{folder_id}",
        json={"cover": "/freezone/_uploads/nope.png"},
    )

    assert response.status_code == 404, response.text
    detail = str(response.json().get("detail", ""))
    assert str(project_dir) not in detail
    assert "/freezone/_uploads/nope.png" in detail
