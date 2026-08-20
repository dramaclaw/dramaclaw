from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient


@pytest.fixture()
def items_client(monkeypatch, tmp_path):
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


_LIBRARY = "/api/v1/projects/proj_demo/freezone/video/character-library"


def _new_item(client: TestClient, project_dir, name: str = "原子朋克") -> str:
    asset = project_dir / "freezone" / "_uploads" / "ref.png"
    asset.parent.mkdir(parents=True, exist_ok=True)
    asset.write_bytes(b"png")
    response = client.post(
        _LIBRARY,
        json={"name": name, "image_urls": ["/freezone/_uploads/ref.png"]},
    )
    assert response.status_code == 200, response.text
    return str(response.json()["data"]["id"])


def _items(client: TestClient) -> list[dict]:
    response = client.get(_LIBRARY)
    assert response.status_code == 200, response.text
    return response.json()["data"]


def test_rename_item_changes_only_the_name(items_client) -> None:
    client, project_dir = items_client
    item_id = _new_item(client, project_dir)
    before = _items(client)[0]

    response = client.patch(f"{_LIBRARY}/{item_id}", json={"name": "  赛博霓虹  "})

    assert response.status_code == 200, response.text
    after = response.json()["data"]
    assert after["name"] == "赛博霓虹"
    # 改名只动名字：地址、类目、保存位置都得原样留着，否则画布上引用该素材的节点会裂图。
    assert after["image_urls"] == before["image_urls"]
    assert after["category"] == before["category"]
    assert after["folder"] == before["folder"]
    assert [entry["name"] for entry in _items(client)] == ["赛博霓虹"]


def test_rename_missing_item_is_404(items_client) -> None:
    client, _project_dir = items_client

    response = client.patch(f"{_LIBRARY}/nope", json={"name": "赛博霓虹"})

    assert response.status_code == 404


@pytest.mark.parametrize("name", ["", "   ", "长" * 61])
def test_rename_rejects_empty_and_overlong_names(items_client, name: str) -> None:
    client, project_dir = items_client
    item_id = _new_item(client, project_dir)

    response = client.patch(f"{_LIBRARY}/{item_id}", json={"name": name})

    assert response.status_code == 400, response.text
    assert [entry["name"] for entry in _items(client)] == ["原子朋克"]
