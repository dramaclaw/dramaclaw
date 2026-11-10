"""Home chat attachments are files under the user's state dir; chat keeps their address."""

from __future__ import annotations

import json

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from novelvideo.api.auth import get_api_user
from novelvideo.api.routes import chat as chat_routes
from novelvideo.chat import home_uploads

NOTES = "# 大纲\n第一幕".encode("utf-8")
# sha256(NOTES)[:16]
NOTES_NAME = "b6aa2a754278da9f-notes.md"


@pytest.fixture
def api(monkeypatch, tmp_path):
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(tmp_path / "state"))
    viewer = {"username": "alice"}
    app = FastAPI()
    app.include_router(chat_routes.router, prefix="/api/v1")
    app.dependency_overrides[get_api_user] = lambda: dict(viewer)
    return TestClient(app), viewer, tmp_path / "state"


def _upload(client: TestClient, name: str, body: bytes):
    return client.post("/api/v1/chat/uploads", files={"file": (name, body, "text/markdown")})


def test_home_upload_is_written_under_the_user_state_dir_and_returns_its_address(api):
    client, _viewer, state = api

    response = _upload(client, "notes.md", NOTES)

    assert response.status_code == 200
    assert response.json() == {
        "ok": True,
        "data": {
            "url": f"/api/v1/chat/uploads/{NOTES_NAME}",
            "fileName": "notes.md",
            "fileSize": 18,
            "mimeType": "text/markdown",
        },
    }
    assert (state / "alice" / "_uploads" / NOTES_NAME).read_bytes() == NOTES
    assert sorted(p.name for p in (state / "alice" / "_uploads").iterdir()) == [NOTES_NAME]

    read = client.get(f"/api/v1/chat/uploads/{NOTES_NAME}")
    assert read.status_code == 200
    assert read.content == NOTES


@pytest.mark.parametrize(
    "name, body, mime_type, disposition",
    [
        (
            "script.html",
            b"<script>alert(1)</script>",
            "text/html",
            'attachment; filename="5c140d35dcb46a62-script.html"',
        ),
        (
            "script.svg",
            b'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
            "image/svg+xml",
            'attachment; filename="3f67c8be987aa1db-script.svg"',
        ),
    ],
)
def test_active_home_upload_is_downloaded_with_nosniff(api, name, body, mime_type, disposition):
    client, _viewer, _state = api
    upload = client.post("/api/v1/chat/uploads", files={"file": (name, body, mime_type)})
    assert upload.status_code == 200

    read = client.get(upload.json()["data"]["url"])

    assert read.status_code == 200
    assert read.content == body
    assert read.headers.get("content-disposition", "").startswith("attachment")
    assert read.headers["content-disposition"] == disposition
    assert read.headers.get("x-content-type-options") == "nosniff"


def test_png_home_upload_is_served_inline_with_nosniff(api):
    client, _viewer, _state = api
    upload = client.post(
        "/api/v1/chat/uploads", files={"file": ("image.png", b"small image", "image/png")}
    )
    assert upload.status_code == 200

    read = client.get(upload.json()["data"]["url"])

    assert read.status_code == 200
    assert read.content == b"small image"
    assert read.headers["content-type"] == "image/png"
    assert read.headers.get("content-disposition", "inline") == "inline"
    assert read.headers.get("x-content-type-options") == "nosniff"


def test_another_user_cannot_read_a_home_upload(api):
    client, viewer, _state = api
    assert _upload(client, "notes.md", NOTES).status_code == 200

    viewer["username"] = "bob"
    response = client.get(f"/api/v1/chat/uploads/{NOTES_NAME}")

    assert response.status_code == 404


def test_project_bound_agent_session_cannot_use_home_uploads(api):
    client, viewer, state = api
    assert _upload(client, "notes.md", NOTES).status_code == 200

    viewer.update(
        credential_kind="agent_session",
        current_scope_kind="project",
        current_project_id="p1",
        scopes=["projects:write"],
    )

    assert client.get(f"/api/v1/chat/uploads/{NOTES_NAME}").status_code == 403
    assert _upload(client, "other.md", b"other").status_code == 403
    assert sorted(p.name for p in (state / "alice" / "_uploads").iterdir()) == [NOTES_NAME]


def test_home_bound_agent_session_can_use_home_uploads(api):
    client, viewer, _state = api
    viewer.update(
        credential_kind="agent_session",
        current_scope_kind="home",
        scopes=["projects:write"],
    )

    assert _upload(client, "notes.md", NOTES).status_code == 200
    read = client.get(f"/api/v1/chat/uploads/{NOTES_NAME}")
    assert read.status_code == 200
    assert read.content == NOTES


@pytest.mark.parametrize(
    "name",
    ["..%2Falice%2F_uploads%2F" + NOTES_NAME, ".upload-x.tmp", "notes.md"],
)
def test_home_upload_read_only_serves_stored_upload_names(api, name):
    client, _viewer, _state = api
    assert _upload(client, "notes.md", NOTES).status_code == 200

    assert client.get(f"/api/v1/chat/uploads/{name}").status_code == 404


def test_home_upload_over_the_size_limit_is_rejected_and_leaves_nothing(api, monkeypatch):
    client, _viewer, state = api
    monkeypatch.setattr(home_uploads, "HOME_UPLOAD_MAX_BYTES", 17)

    response = _upload(client, "notes.md", NOTES)

    assert response.status_code == 413
    assert list((state / "alice" / "_uploads").iterdir()) == []


def test_home_upload_limit_is_the_project_upload_limit():
    assert home_uploads.HOME_UPLOAD_MAX_BYTES == 200 * 1024 * 1024


def test_stored_attachment_keeps_addresses_and_drops_file_content():
    attachments = [
        chat_routes.ChatAttachmentIn(
            type="file",
            fileName="notes.md",
            url=f"/api/v1/chat/uploads/{NOTES_NAME}",
            content="# 大纲\n第一幕",
        ),
        chat_routes.ChatAttachmentIn(
            type="image",
            fileName="paste.png",
            url="data:image/png;base64,iVBORw0KGgo=",
            path=" data:image/png;base64,iVBORw0KGgo=",
        ),
    ]

    assert chat_routes._attachment_payloads(attachments) == [
        {"type": "file", "fileName": "notes.md", "url": f"/api/v1/chat/uploads/{NOTES_NAME}"},
        {"type": "image", "fileName": "paste.png"},
    ]
    context = chat_routes._attachment_context_block(attachments)
    assert "data:" not in context
    assert f"url=/api/v1/chat/uploads/{NOTES_NAME}" in context


def test_stored_canvas_reference_keeps_node_identity_and_addresses_only():
    reference = {
        "schema_version": "canvas_node_reference.v1",
        "project": "demo",
        "canvas_id": "canvas-1",
        "display_nodes": [
            {
                "node_id": "n1",
                "node_type": "imageGen",
                "label": "主角",
                "text_field": "prompt",
                "text_content": "很长的提示词",
                "media_type": "image",
                "source_url": "/static/projects/demo/freezone/n1.png?v=2",
                "preview_url": None,
                "position": {"x": 10, "y": 20},
                "action_catalog": {"actions": [{"id": "run"}]},
            }
        ],
        "nodes": [
            {
                "node_id": "n1",
                "node_type": "imageGen",
                "label": "主角",
                "text_content": "很长的提示词",
                "media_type": "image",
                "source_url": "/static/projects/demo/freezone/n1.png?v=2",
                "preview_url": None,
                "slot_target": {"slot": "hero"},
                "mainline_context": {"episode": 1},
            }
        ],
        "edges": [{"edge_id": "e1", "source": "n1", "target": "n2"}],
    }
    attachment = chat_routes.ChatAttachmentIn(
        id="canvas-ref:canvas-1",
        type="canvas_node_reference",
        kind="canvas_node_reference",
        label="主角",
        content=json.dumps(reference, ensure_ascii=False),
    )

    (stored,) = chat_routes._attachment_payloads([attachment])

    node = {
        "node_id": "n1",
        "node_type": "imageGen",
        "label": "主角",
        "media_type": "image",
        "source_url": "/static/projects/demo/freezone/n1.png?v=2",
        "preview_url": None,
    }
    assert {key: value for key, value in stored.items() if key != "content"} == {
        "id": "canvas-ref:canvas-1",
        "type": "canvas_node_reference",
        "kind": "canvas_node_reference",
        "label": "主角",
    }
    assert json.loads(stored["content"]) == {
        "schema_version": "canvas_node_reference.v1",
        "project": "demo",
        "canvas_id": "canvas-1",
        "display_nodes": [node],
        "nodes": [node],
    }
