from __future__ import annotations

import io

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image

from novelvideo import blender_store
from novelvideo.api.deps import ProjectResolution
from novelvideo.api.routes import blender
from novelvideo.utils.upload_safety import MAX_PROJECT_UPLOAD_BYTES

PNG_MAGIC = b"\x89PNG\r\n\x1a\n"


def _png_bytes(size=(16, 16)) -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", size, (200, 200, 200)).save(buffer, format="PNG")
    return buffer.getvalue()


def _mp4_bytes(payload_size: int = 64) -> bytes:
    # 一个足以通过 magic 检查的最小 MP4 头：box 长度 + 'ftyp' + brand。
    return b"\x00\x00\x00\x18ftypisom" + b"\x00" * payload_size


@pytest.fixture()
def client(tmp_path, monkeypatch):
    db_path = tmp_path / "blender.db"
    blender_store.init_db(db_path)
    monkeypatch.setattr(blender, "_db", lambda: db_path)

    project_dir = tmp_path / "projects" / "demo"
    project_dir.mkdir(parents=True)

    async def _fake_scope(project, user, *, required_role="viewer"):
        return ProjectResolution(
            ctx=None,
            username=user["username"],
            project_name=project,
            project_dir=project_dir,
            output_dir=str(project_dir),
            state_dir=str(tmp_path / "state"),
            runtime_dir=str(tmp_path / "runtime"),
        )

    monkeypatch.setattr(blender, "resolve_project_scope", _fake_scope)
    monkeypatch.setattr(
        blender,
        "make_static_url_for_context",
        lambda ctx, relative_path, local_path=None: f"/files/{relative_path}",
    )

    app = FastAPI()
    app.include_router(blender.router, prefix="/api/v1")
    with TestClient(app) as test_client:
        test_client.db_path = db_path
        test_client.project_dir = project_dir
        yield test_client


def _auth(db_path, user_id="alice"):
    pairing = blender_store.create_pairing(db_path)
    blender_store.approve_pairing(db_path, pairing.code, user_id=user_id)
    token = blender_store.consume_pairing(db_path, pairing.pairing_id).token
    return {"Authorization": f"Bearer {token}"}


def _deliver(client, *, files, data, headers=None):
    return client.post(
        "/api/v1/projects/demo/blender/deliver",
        files=files,
        data=data,
        headers=headers if headers is not None else _auth(client.db_path),
    )


def test_image_lands_in_uploads_and_comes_back_with_a_url(client):
    payload = _png_bytes()

    response = _deliver(
        client,
        files={"file": ("blockout_Camera_frame_24_20260918.png", payload, "image/png")},
        data={"kind": "image", "camera": "Camera", "frame": "24", "width": "1280", "height": "720"},
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["url"].startswith("/files/freezone/_uploads/")
    landed = client.project_dir / "freezone" / "_uploads" / body["filename"]
    assert landed.read_bytes() == payload


def test_delivery_shows_up_in_the_inbox(client):
    response = _deliver(
        client,
        files={"file": ("shot.png", _png_bytes(), "image/png")},
        data={"kind": "image", "camera": "Camera", "frame": "24", "width": "1280", "height": "720"},
    )

    items = blender_store.list_inbox(client.db_path, user_id="alice", project_id="demo")

    assert [item["delivery_id"] for item in items] == [response.json()["delivery_id"]]
    assert items[0]["camera"] == "Camera"
    assert items[0]["frame"] == 24


def test_video_carries_its_frame_range_and_fps(client):
    response = _deliver(
        client,
        files={"file": ("shot.mp4", _mp4_bytes(), "video/mp4")},
        data={
            "kind": "video",
            "camera": "Camera",
            "frame_start": "1",
            "frame_end": "250",
            "fps": "24",
            "width": "720",
            "height": "1280",
        },
    )

    assert response.status_code == 200, response.text
    item = blender_store.list_inbox(client.db_path, user_id="alice", project_id="demo")[0]
    assert (item["frame_start"], item["frame_end"], item["fps"]) == (1, 250, 24.0)
    assert (item["width"], item["height"]) == (720, 1280)


def test_deliver_needs_a_plugin_token(client):
    response = _deliver(
        client,
        files={"file": ("shot.png", _png_bytes(), "image/png")},
        data={"kind": "image", "camera": "Camera", "frame": "1", "width": "16", "height": "16"},
        headers={},
    )

    assert response.status_code == 401


def test_oversized_image_is_refused_and_leaves_nothing_behind(client, monkeypatch):
    monkeypatch.setattr(blender, "MAX_IMAGE_BYTES", 128)

    response = _deliver(
        client,
        files={"file": ("big.png", _png_bytes((256, 256)), "image/png")},
        data={"kind": "image", "camera": "Camera", "frame": "1", "width": "256", "height": "256"},
    )

    assert response.status_code == 413
    uploads = client.project_dir / "freezone" / "_uploads"
    assert list(uploads.glob("*")) == []


def test_content_that_contradicts_the_declared_kind_is_refused(client):
    # `kind` 来自插件，是不可信输入。落地之后按真实字节复核一遍。
    response = _deliver(
        client,
        files={"file": ("liar.png", _mp4_bytes(), "image/png")},
        data={"kind": "image", "camera": "Camera", "frame": "1", "width": "16", "height": "16"},
    )

    assert response.status_code == 400
    assert list((client.project_dir / "freezone" / "_uploads").glob("*")) == []


def test_unknown_kind_is_refused(client):
    response = _deliver(
        client,
        files={"file": ("x.png", _png_bytes(), "image/png")},
        data={"kind": "hologram", "camera": "Camera", "frame": "1", "width": "16", "height": "16"},
    )

    assert response.status_code == 422


def test_filename_cannot_escape_the_uploads_directory(client):
    response = _deliver(
        client,
        files={"file": ("../../evil.png", _png_bytes(), "image/png")},
        data={"kind": "image", "camera": "Camera", "frame": "1", "width": "16", "height": "16"},
    )

    assert response.status_code == 200
    landed = client.project_dir / "freezone" / "_uploads" / response.json()["filename"]
    assert landed.exists()
    assert not (client.project_dir.parent.parent / "evil.png").exists()


def test_two_deliveries_with_the_same_name_do_not_clobber_each_other(client):
    first = _png_bytes((16, 16))
    second = _png_bytes((32, 32))
    data = {"kind": "image", "camera": "Camera", "frame": "1", "width": "16", "height": "16"}

    a = _deliver(client, files={"file": ("same.png", first, "image/png")}, data=data)
    b = _deliver(client, files={"file": ("same.png", second, "image/png")}, data=data)

    assert a.json()["filename"] != b.json()["filename"]
    uploads = client.project_dir / "freezone" / "_uploads"
    assert len(list(uploads.glob("*.png"))) == 2


def _deliver_through_real_app(content_length: int):
    """用真实 app（带全局中间件栈）打一次投递，只设 content-length 不造 body。

    中间件只读 `content-length` 头，不读 body，所以这里不需要真的搬几百 MB 字节。
    """
    from novelvideo.api.app import create_app

    with TestClient(create_app()) as real_client:
        return real_client.post(
            "/api/v1/projects/demo/blender/deliver",
            content=b"",
            headers={
                "content-type": "multipart/form-data; boundary=x",
                "content-length": str(content_length),
            },
        )


def _is_middleware_413(response) -> bool:
    if response.status_code != 413:
        return False
    detail = response.json().get("detail")
    return isinstance(detail, dict) and detail.get("code") == "canvas_payload_too_large"


def test_deliver_passes_the_global_request_body_middleware():
    """blender 投递必须能穿过全局请求体中间件（`api/app.py` 的 `_limit_body_size`）。

    这条测试存在的理由：本文件其余所有测试都用裸 `FastAPI()` + `include_router`，
    照不到 `create_app()` 的中间件栈。中间件跑在路由和鉴权之前，默认只给 5MB；
    面板上写的却是「视频最长 30 秒、最大 200MB」，一段 30 秒白模轻松几十 MB。
    没有这条测试，整条投递在真实 app 里 413，而 64 条后端测试照样全绿。

    断言的是「中间件没拦」，不是「投递成功」——没有插件令牌，拿到 401 正好说明
    请求已经穿过中间件抵达鉴权层。
    """
    response = _deliver_through_real_app(6 * 1024 * 1024)

    assert not _is_middleware_413(response), response.text


def test_deliver_still_has_an_upper_bound():
    """闸门抬高到 200MB，不是拆掉：超过 `MAX_PROJECT_UPLOAD_BYTES` 仍然当场 413。"""
    response = _deliver_through_real_app(MAX_PROJECT_UPLOAD_BYTES + 1)

    assert _is_middleware_413(response), response.text
