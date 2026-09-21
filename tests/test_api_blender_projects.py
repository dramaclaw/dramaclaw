"""插件项目下拉框 `GET /blender/projects`，以及它和投递接口之间的契约。

下拉框曾经返回项目**目录名**，插件把名字存下来拼进
`/projects/{project}/blender/deliver`；可投递接口走 `resolve_project_scope`，按注册表
**id**（ULID）查——名字永远查不到，每次投递都是 `Project not found`。当时两边的测试
各自 mock 掉了对方，这条缝一直没人看见。所以这里的契约测试**不 mock**
`resolve_project_scope`：列表给出的 id 必须原样投得进去。
"""

from __future__ import annotations

import io

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image

from novelvideo import blender_store, project_context
from novelvideo.api.routes import blender
from novelvideo.ports.project import Principal, ProjectRecord


def _record(tmp_path, project_id: str, name: str, **overrides) -> ProjectRecord:
    project_dir = tmp_path / "projects" / name
    project_dir.mkdir(parents=True, exist_ok=True)
    fields = dict(
        id=project_id,
        owner_type="user",
        owner_id="u-alice",
        owner_username="alice",
        name=name,
        home_node_id="local",
        output_dir=str(project_dir),
        state_dir=str(tmp_path / "state" / name),
        runtime_dir=str(tmp_path / "runtime" / name),
        status="active",
    )
    fields.update(overrides)
    return ProjectRecord(**fields)


class _FakeRegistry:
    def __init__(self, records):
        self._records = {record.id: record for record in records}

    async def resolve_user_id_by_username(self, username):
        return {"alice": "u-alice", "bob": "u-bob"}.get(username)

    async def list_accessible_projects(self, principals):
        return list(self._records.values())

    async def get_project(self, project_id):
        return self._records.get(project_id)


class _FakeAccess:
    def __init__(self, roles):
        self._roles = roles

    async def resolve_requester_principals(self, user_id):
        return [Principal(type="user", id=user_id)]

    async def effective_project_role(self, record, principals):
        return self._roles.get(record.id, "")


@pytest.fixture()
def client(tmp_path, monkeypatch):
    db_path = tmp_path / "blender.db"
    blender_store.init_db(db_path)
    monkeypatch.setattr(blender, "_db", lambda: db_path)

    records = [
        _record(tmp_path, "01JPROJECTDEMO", "demo"),
        _record(tmp_path, "01JPROJECTSHARED", "shared-edit"),
        _record(tmp_path, "01JPROJECTVIEW", "view-only"),
        _record(tmp_path, "01JPROJECTTRASH", "trashed", status="deleted"),
        _record(tmp_path, "01JPROJECTGONE", "purged", purged_at="2026-09-01T00:00:00Z"),
    ]
    roles = {
        "01JPROJECTDEMO": "owner",
        "01JPROJECTSHARED": "editor",
        "01JPROJECTVIEW": "viewer",
        "01JPROJECTTRASH": "owner",
        "01JPROJECTGONE": "owner",
    }
    registry, access = _FakeRegistry(records), _FakeAccess(roles)
    for module in (blender, project_context):
        monkeypatch.setattr(module, "get_project_registry", lambda: registry)
        monkeypatch.setattr(module, "get_project_access", lambda: access)
    monkeypatch.setattr(project_context, "is_record_home_node", lambda record: True)
    monkeypatch.setattr(
        blender,
        "make_static_url_for_context",
        lambda ctx, relative_path, local_path=None: f"/files/{relative_path}",
    )

    app = FastAPI()
    app.include_router(blender.router, prefix="/api/v1")
    with TestClient(app) as test_client:
        test_client.db_path = db_path
        yield test_client


def _auth(db_path, user_id="alice"):
    pairing = blender_store.create_pairing(db_path)
    blender_store.approve_pairing(db_path, pairing.code, user_id=user_id)
    token = blender_store.consume_pairing(db_path, pairing.pairing_id).token
    return {"Authorization": f"Bearer {token}"}


def _png_bytes() -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", (16, 16), (200, 200, 200)).save(buffer, format="PNG")
    return buffer.getvalue()


def test_lists_id_and_name_of_projects_the_user_can_deliver_into(client):
    response = client.get("/api/v1/blender/projects", headers=_auth(client.db_path))

    assert response.status_code == 200
    # 只读协作者投不进去（投递要 editor），回收站和已清除的也不该出现在下拉框里。
    assert response.json() == {
        "projects": [
            {"id": "01JPROJECTDEMO", "name": "demo"},
            {"id": "01JPROJECTSHARED", "name": "shared-edit"},
        ]
    }


def test_every_listed_id_is_deliverable(client):
    headers = _auth(client.db_path)
    projects = client.get("/api/v1/blender/projects", headers=headers).json()["projects"]
    assert projects, "列表是空的，这条契约等于没测"

    for project in projects:
        response = client.post(
            f"/api/v1/projects/{project['id']}/blender/deliver",
            files={"file": ("blockout.png", _png_bytes(), "image/png")},
            data={"kind": "image", "camera": "Camera"},
            headers=headers,
        )
        assert response.status_code == 200, (project, response.text)


def test_the_name_is_not_an_address(client):
    """反面钉死：拿名字去投必须失败。哪天有人让它「顺便也认名字」，这条会先红，
    逼他想清楚同名项目（别人共享给你的和你自己的撞名）该投给谁。"""
    response = client.post(
        "/api/v1/projects/demo/blender/deliver",
        files={"file": ("blockout.png", _png_bytes(), "image/png")},
        data={"kind": "image", "camera": "Camera"},
        headers=_auth(client.db_path),
    )

    assert response.status_code == 404
