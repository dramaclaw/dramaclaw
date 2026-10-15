import base64
import io
import json
from types import SimpleNamespace

import pytest
from PIL import Image

from novelvideo.chat import hermes_sdk
from novelvideo.chat import service as chat_service
from novelvideo.chat.turn_images import (
    CODEX_IMAGE_INPUT_ENV,
    MAX_TURN_IMAGES,
    image_data_urls,
    referenced_image_paths,
)


def _png(path, size=(64, 32)):
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", size, (200, 30, 30)).save(path, format="PNG")
    return path


def _reference(nodes):
    return {
        "type": "canvas_node_reference",
        "content": json.dumps({"project": "p", "canvas_id": "c", "nodes": nodes}),
    }


def _image_node(name, media_type="image"):
    return {
        "node_id": name,
        "media_type": media_type,
        "source_url": f"/static/projects/p/freezone/_uploads/{name}?v=1",
    }


def test_referenced_image_paths_keeps_existing_project_images(tmp_path):
    uploads = tmp_path / "freezone" / "_uploads"
    a = _png(uploads / "a.png")
    b = _png(uploads / "b.jpg")
    (uploads / "clip.mp4").write_bytes(b"not an image")

    paths = referenced_image_paths(
        [
            {"type": "file", "content": "data:text/plain,hello"},
            {"type": "canvas_node_reference", "content": "{broken"},
            _reference(
                [
                    _image_node("a.png"),
                    _image_node("a.png"),
                    _image_node("clip.mp4", media_type="video"),
                    _image_node("missing.png"),
                    {"media_type": "image", "source_url": "/static/u/p/../../x.png"},
                    {"media_type": "image", "source_url": "https://evil.test/a.png"},
                    {"media_type": "image", "source_url": ""},
                ]
            ),
            _reference([_image_node("b.jpg")]),
        ],
        tmp_path,
    )

    assert paths == [a, b]


def test_referenced_image_paths_caps_images_per_turn(tmp_path):
    uploads = tmp_path / "freezone" / "_uploads"
    names = [f"{index}.png" for index in range(MAX_TURN_IMAGES + 2)]
    for name in names:
        _png(uploads / name)

    paths = referenced_image_paths(
        [_reference([_image_node(name) for name in names])], tmp_path
    )

    assert [path.name for path in paths] == names[:MAX_TURN_IMAGES]


async def test_image_data_urls_compacts_and_skips_unreadable(tmp_path):
    good = _png(tmp_path / "good.png", size=(4000, 1000))
    broken = tmp_path / "broken.png"
    broken.write_bytes(b"not a png")

    urls = await image_data_urls([broken, good])

    assert len(urls) == 1
    prefix = "data:image/jpeg;base64,"
    assert urls[0].startswith(prefix)
    with Image.open(io.BytesIO(base64.b64decode(urls[0][len(prefix) :]))) as image:
        assert max(image.size) == 1280


def test_attachment_context_tells_agent_chat_cannot_take_images():
    from novelvideo.api.routes.chat import ChatAttachmentIn, _attachment_context_block

    block = _attachment_context_block(
        [ChatAttachmentIn(**_reference([_image_node("a.png")]), fileName="a.png")]
    )

    assert "only if it arrives as image input" in block
    assert "never ask the user to attach one" in block


@pytest.mark.parametrize("flag", [None, "1"])
async def test_codex_turn_sends_referenced_images_only_when_enabled(
    monkeypatch, tmp_path, flag
):
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(tmp_path / "state"))
    monkeypatch.setenv("NOVELVIDEO_RUNTIME_DIR", str(tmp_path / "runtime"))
    if flag is None:
        monkeypatch.delenv(CODEX_IMAGE_INPUT_ENV, raising=False)
    else:
        monkeypatch.setenv(CODEX_IMAGE_INPUT_ENV, flag)
    image = _png(tmp_path / "freezone" / "_uploads" / "ref.png")
    calls = []

    class FakeThread:
        async def stream(self, prompt, **kwargs):
            calls.append(kwargs)
            yield SimpleNamespace(
                type="thread_started", thread_id="codex-thread", turn_id="t"
            )
            yield SimpleNamespace(type="complete", thread_id="codex-thread", text="ok")

    class FakeAuthPort:
        async def revoke_agent_session(self, token):  # noqa: ARG002
            return None

    async def fake_create_token(*args, **kwargs):  # noqa: ARG001
        return "agent-token"

    monkeypatch.setattr(chat_service, "_create_page_agent_session_token", fake_create_token)
    monkeypatch.setattr(chat_service, "_build_codex_thread", lambda *a, **kw: FakeThread())
    monkeypatch.setattr(chat_service, "get_auth_session_port", lambda: FakeAuthPort())
    monkeypatch.setattr(hermes_sdk, "_issue_turn_capability", lambda **kw: None)

    async def collect(event):  # noqa: ARG001
        return None

    await chat_service._stream_assistant_reply_codex(
        "admin",
        "project-a",
        "按这张图搭白膜",
        collect,
        project_state_dir=tmp_path / "state" / "admin" / "project-a",
        turn_id="business-turn",
        route_prompt="按这张图搭白膜",
        image_paths=[image],
    )

    if flag is None:
        assert calls == [{}]
    else:
        (images,) = [call["images"] for call in calls]
        assert len(images) == 1
        assert images[0].startswith("data:image/jpeg;base64,")
