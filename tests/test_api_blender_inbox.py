"""POST /projects/{project}/blender/inbox:take：画布页认领 Blender 投递的素材。"""

from __future__ import annotations

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from novelvideo import blender_store
from novelvideo.api.deps import ProjectResolution
from novelvideo.api.routes import blender


def _scope_factory(tmp_path):
    """给 monkeypatch 用的假 resolve_project_scope。

    两处都要用：`client` fixture，和只验鉴权的那条测试——后者尤其需要，
    不把项目端口挡掉的话拿到的 503 是「项目后端没注册」，跟登录态无关。
    """
    project_dir = tmp_path / "projects" / "demo"
    project_dir.mkdir(parents=True, exist_ok=True)

    async def _fake_scope(project, user, *, required_role="viewer"):
        # 认领是破坏性的（取走即删），只读协作者不该能调。假 scope 必须真的
        # 检查这个参数，否则把路由改成 viewer 测试也照样全绿。用 500 而不是
        # 403：403 跟下面 forbidden 分支撞了，角色回归会被误当成合法的权限拒绝。
        if required_role != "editor":
            raise HTTPException(status_code=500, detail=f"意外的角色要求：{required_role}")
        if project == "forbidden":
            raise HTTPException(status_code=403, detail="没有权限")
        return ProjectResolution(
            ctx=None,
            # 故意不等于 user["username"]：真的 resolve_project_scope 这里放的是
            # 项目**属主**（deps.py:117 的 ctx.owner_username），共享项目上跟调用者
            # 不是同一个人。两者写成一样的话，路由拿错人去查收件箱也测不出来——
            # 协作者会看到一个永远空的收件箱，而且不报错。
            username="owner",
            project_name=project,
            project_dir=project_dir,
            output_dir=str(project_dir),
            state_dir=str(tmp_path / "state"),
            runtime_dir=str(tmp_path / "runtime"),
        )

    return _fake_scope


@pytest.fixture()
def client(tmp_path, monkeypatch):
    db_path = tmp_path / "blender.db"
    blender_store.init_db(db_path)
    monkeypatch.setattr(blender, "_db", lambda: db_path)
    monkeypatch.setattr(blender, "resolve_project_scope", _scope_factory(tmp_path))

    app = FastAPI()
    app.include_router(blender.router, prefix="/api/v1")
    app.dependency_overrides[blender.get_api_user] = lambda: {"username": "alice"}
    with TestClient(app) as test_client:
        test_client.db_path = db_path
        yield test_client


def _record(db_path, *, user_id="alice", project_id="demo", name="a.png", kind="image"):
    return blender_store.record_delivery(
        db_path, user_id=user_id, project_id=project_id, url=f"/files/{name}",
        kind=kind, filename=name, camera="Camera", frame=7,
        frame_start=None, frame_end=None, fps=None, width=1920, height=1080,
    )


def test_returns_and_consumes_the_pending_deliveries(client):
    delivery_id = _record(client.db_path)
    response = client.post("/api/v1/projects/demo/blender/inbox:take")
    assert response.status_code == 200
    items = response.json()["items"]
    assert len(items) == 1
    assert items[0]["delivery_id"] == delivery_id
    assert items[0]["url"] == "/files/a.png"
    assert items[0]["kind"] == "image"
    assert items[0]["filename"] == "a.png"
    assert items[0]["width"] == 1920
    # 白名单的存在理由就是防列泄漏，得有人守着：断言「恰好这些键」而不是
    # 「包含这些键」——后者对 dict(row) 照样成立，等于没测。
    #
    # 这里写字面量而不是 `set(blender._INBOX_FIELDS)`：拿响应去比常量自己是
    # 同义反复，常量少一个字段两边同步少一个，断言恒成立（实测把 camera 从
    # 白名单里删掉，测试照样全绿）。字段集是发给前端的契约，得钉在测试里。
    assert set(items[0]) == {
        "delivery_id",
        "url",
        "kind",
        "filename",
        "camera",
        "frame",
        "frame_start",
        "frame_end",
        "fps",
        "width",
        "height",
        "created_at",
    }
    # 认领一次就没了，不然 5 秒后的下一轮会重复建节点。
    assert client.post("/api/v1/projects/demo/blender/inbox:take").json()["items"] == []


def test_empty_inbox_is_a_200_with_an_empty_list(client):
    # 每 5 秒一次的轮询，绝大多数都是空的。空不是错误。
    response = client.post("/api/v1/projects/demo/blender/inbox:take")
    assert response.status_code == 200
    assert response.json() == {"items": []}


def test_does_not_hand_over_another_users_deliveries(client):
    _record(client.db_path, user_id="bob")
    assert client.post("/api/v1/projects/demo/blender/inbox:take").json()["items"] == []
    # bob 的那行必须还在——用 list_inbox 这个非破坏性读法去看，不要用
    # take_inbox：后者取完就删，拿它来断言「还在」会把证据自己销毁。
    assert blender_store.list_inbox(client.db_path, user_id="bob", project_id="demo")


def test_project_permission_is_checked_even_when_the_inbox_has_rows(client):
    # 收件箱里有行不代表这人现在还有这个项目的权限，权限必须单独验。
    _record(client.db_path, project_id="forbidden")
    response = client.post("/api/v1/projects/forbidden/blender/inbox:take")
    assert response.status_code == 403


def test_requires_a_browser_session(tmp_path, monkeypatch):
    # 把项目端口也 mock 掉，让「鉴权」成为唯一的变量：否则裸 app 里
    # resolve_project_scope 自己就会 503，把 Depends(get_api_user) 整个摘掉
    # 这条测试照样通过——它就只是在验「两个端口都没注册」而已。
    #
    # 光测「没带凭证拿不到」也不够：路由若误挂成 get_blender_client，裸请求
    # 同样是 401，测试照过却验错了东西。所以再签一个货真价实的插件令牌，证明
    # 「即使拿着合法插件令牌」也认领不到——这个端点是给浏览器的，不给插件。
    db_path = tmp_path / "blender.db"
    blender_store.init_db(db_path)
    monkeypatch.setattr(blender, "_db", lambda: db_path)
    monkeypatch.setattr(blender, "resolve_project_scope", _scope_factory(tmp_path))

    pairing = blender_store.create_pairing(db_path)
    blender_store.approve_pairing(db_path, pairing.code, user_id="alice")
    token = blender_store.consume_pairing(db_path, pairing.pairing_id).token

    app = FastAPI()
    app.include_router(blender.router, prefix="/api/v1")
    with TestClient(app) as anonymous:
        no_cred = anonymous.post("/api/v1/projects/demo/blender/inbox:take")
        with_plugin_token = anonymous.post(
            "/api/v1/projects/demo/blender/inbox:take",
            headers={"Authorization": f"Bearer {token}"},
        )

    assert no_cred.status_code in (401, 503)
    assert with_plugin_token.status_code != 200
