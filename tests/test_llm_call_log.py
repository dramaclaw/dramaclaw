from __future__ import annotations

import base64
import json
from typing import Any

import aiohttp
import httpx
import pytest
from aiohttp import web
from aiohttp.test_utils import TestServer

from novelvideo import llm_call_log
from novelvideo.llm_call_log import hooks
from novelvideo.llm_call_log.classify import classify, sanitize_url
from novelvideo.llm_call_log.payload import (
    Limits,
    RawBytes,
    externalize,
    parse_multipart,
)
from novelvideo.llm_call_log.settings import load_settings
from novelvideo.llm_call_log.tracker import CallTracker

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 400
MP4 = b"\x00\x00\x00\x18ftypmp42" + b"\x00" * 64
LIMITS = Limits(max_text_chars=50, max_media_bytes=10_000, capture_media=True)


def fake_media(data: bytes, mime: str) -> tuple[str, str, int]:
    return ("MEDIA", mime, len(data))


class FakeSink:
    def __init__(self, fail: bool = False) -> None:
        self.started: list[dict[str, Any]] = []
        self.finished: list[Any] = []
        self.fail = fail

    def make_media(self, data: bytes, mime: str) -> Any:
        return fake_media(data, mime)

    def start(self, **kwargs: Any) -> Any:
        if self.fail:
            raise RuntimeError("sink down")
        self.started.append(kwargs)
        return len(self.started) - 1

    def finish(self, handle: Any, result: Any) -> None:
        self.finished.append((handle, result))

    def flush(self) -> None:
        pass


def make_tracker(sink: FakeSink, **env: str) -> CallTracker:
    base = {
        "LLM_CALL_LOG_ENABLED": "1",
        "LANGFUSE_HOST": "http://langfuse.local:3100",
        "LANGFUSE_PUBLIC_KEY": "pk",
        "LANGFUSE_SECRET_KEY": "sk",
    }
    return CallTracker(load_settings({**base, **env}), sink)


@pytest.fixture
def restore_http_clients():
    originals = (
        httpx.AsyncClient.send,
        httpx.Client.send,
        aiohttp.ClientSession._request,
    )
    flags = (hooks._installed_httpx, hooks._installed_aiohttp, llm_call_log._tracker)
    hooks._installed_httpx = hooks._installed_aiohttp = False
    llm_call_log._tracker = None
    yield
    httpx.AsyncClient.send, httpx.Client.send, aiohttp.ClientSession._request = (
        originals
    )
    hooks._installed_httpx, hooks._installed_aiohttp, llm_call_log._tracker = flags


# --- classify ---------------------------------------------------------------


@pytest.mark.parametrize(
    ("url", "kind"),
    [
        ("http://newapi:3000/v1/chat/completions", "text"),
        ("http://host.docker.internal:6969/v1/chat/completions", "text"),
        ("https://x.test/v1/images/edits", "image"),
        ("https://x.test/v1/images/generations", "image"),
        ("https://x.test/v1/audio/speech", "audio"),
        ("https://x.test/v1/embeddings", "embedding"),
        ("https://x.test/v1/video/generations", "video"),
        ("https://x.test/api/v3/contents/generations/tasks/abc", "video"),
        (
            "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=S",
            "text",
        ),
    ],
)
def test_classify_known_endpoints(url: str, kind: str) -> None:
    info = classify(url)
    assert info is not None and info.kind == kind


def test_classify_ignores_unrelated_and_test_hosts() -> None:
    assert classify("https://oss.example.com/file.mp4") is None
    assert classify("http://testserver/api/v1/projects/x/messages") is None
    assert (
        classify("https://custom.example.com/ping", ("custom.example.com",)).kind
        == "other"
    )


def test_classify_extracts_model_from_gemini_path_and_sanitize_drops_secrets() -> None:
    url = "https://g.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=SECRET"
    assert classify(url).model_from_path == "gemini-3.5-flash"
    assert (
        sanitize_url("https://user:pw@g.googleapis.com/a/b?key=SECRET")
        == "https://g.googleapis.com/a/b"
    )


# --- payload ----------------------------------------------------------------


def test_externalize_lifts_data_uri_b64_json_and_inline_data() -> None:
    b64 = base64.b64encode(PNG).decode()
    out = externalize(
        {
            "image_url": f"data:image/png;base64,{b64}",
            "data": [{"b64_json": b64}],
            "contents": [{"inlineData": {"mimeType": "image/png", "data": b64}}],
        },
        fake_media,
        LIMITS,
    )
    assert out["image_url"] == ("MEDIA", "image/png", len(PNG))
    assert out["data"][0]["b64_json"] == ("MEDIA", "image/png", len(PNG))
    assert out["contents"][0]["inlineData"]["data"] == ("MEDIA", "image/png", len(PNG))


def test_externalize_redacts_secrets_and_truncates_text() -> None:
    out = externalize(
        {"api_key": "sk-1", "Authorization": "Bearer x", "text": "a" * 80},
        fake_media,
        LIMITS,
    )
    assert out["api_key"] == "***" and out["Authorization"] == "***"
    assert out["text"].startswith("a" * 50) and "truncated 30 chars" in out["text"]


def test_externalize_respects_capture_and_size_limits() -> None:
    off = Limits(max_text_chars=50, max_media_bytes=10_000, capture_media=False)
    assert (
        externalize(RawBytes(PNG, "image/png"), fake_media, off)["omitted"]
        == "capture_media disabled"
    )
    small = Limits(max_text_chars=50, max_media_bytes=10, capture_media=True)
    assert (
        "exceeds"
        in externalize(RawBytes(PNG, "image/png"), fake_media, small)["omitted"]
    )


def test_parse_multipart_returns_files_as_rawbytes() -> None:
    boundary = "xyz"
    body = (
        (
            f'--{boundary}\r\nContent-Disposition: form-data; name="prompt"\r\n\r\nmake it red\r\n'
            f'--{boundary}\r\nContent-Disposition: form-data; name="image"; filename="a.png"\r\n'
            f"Content-Type: image/png\r\n\r\n"
        ).encode()
        + PNG
        + f"\r\n--{boundary}--\r\n".encode()
    )
    fields = parse_multipart(f"multipart/form-data; boundary={boundary}", body)
    assert fields["prompt"] == "make it red"
    assert fields["image"].mime == "image/png" and fields["image"].data.startswith(
        b"\x89PNG"
    )


# --- httpx hook -------------------------------------------------------------


async def test_httpx_text_call_is_logged_with_usage_and_no_secrets(
    restore_http_clients,
) -> None:
    sink = FakeSink()
    hooks.install_httpx_hook(make_tracker(sink))

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "choices": [{"message": {"role": "assistant", "content": "hi"}}],
                "usage": {
                    "prompt_tokens": 3,
                    "completion_tokens": 2,
                    "total_tokens": 5,
                },
            },
            headers={"x-request-id": "req-1"},
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        response = await client.post(
            "http://newapi:3000/v1/chat/completions",
            headers={"Authorization": "Bearer sk-secret"},
            json={
                "model": "deepseek-chat",
                "messages": [{"role": "user", "content": "yo"}],
            },
        )
    assert response.json()["choices"][0]["message"]["content"] == "hi"
    (start,) = sink.started
    assert start["kind"] == "text" and start["model"] == "deepseek-chat"
    assert start["input"]["messages"][0]["content"] == "yo"
    assert "sk-secret" not in json.dumps(start, default=str)
    ((_, result),) = sink.finished
    assert result.usage == {"input": 3, "output": 2, "total": 5}
    assert result.metadata["provider_request_id"] == "req-1" and not result.error


async def test_httpx_image_b64_response_becomes_media(restore_http_clients) -> None:
    sink = FakeSink()
    hooks.install_httpx_hook(make_tracker(sink))
    payload = {"data": [{"b64_json": base64.b64encode(PNG).decode()}]}
    transport = httpx.MockTransport(lambda r: httpx.Response(200, json=payload))
    async with httpx.AsyncClient(transport=transport) as client:
        await client.post(
            "http://newapi/v1/images/generations", json={"model": "m", "prompt": "cat"}
        )
    ((_, result),) = sink.finished
    assert result.output["data"][0]["b64_json"] == ("MEDIA", "image/png", len(PNG))


async def test_httpx_audio_and_video_bytes_responses_become_media(
    restore_http_clients,
) -> None:
    sink = FakeSink()
    hooks.install_httpx_hook(make_tracker(sink))
    wav = b"RIFF\x00\x00\x00\x00WAVE" + b"\x00" * 32
    transport = httpx.MockTransport(
        lambda r: httpx.Response(
            200, content=wav, headers={"content-type": "audio/wav"}
        )
    )
    async with httpx.AsyncClient(transport=transport) as client:
        await client.post(
            "http://newapi/v1/audio/speech", json={"model": "tts", "input": "hello"}
        )
    ((_, result),) = sink.finished
    assert result.output == ("MEDIA", "audio/wav", len(wav))


async def test_httpx_multipart_edit_request_lifts_reference_image(
    restore_http_clients,
) -> None:
    sink = FakeSink()
    hooks.install_httpx_hook(make_tracker(sink))
    transport = httpx.MockTransport(lambda r: httpx.Response(200, json={"data": []}))
    async with httpx.AsyncClient(transport=transport) as client:
        await client.post(
            "http://newapi/v1/images/edits",
            data={"model": "m", "prompt": "red"},
            files={"image": ("a.png", PNG, "image/png")},
        )
    (start,) = sink.started
    assert start["input"]["prompt"] == "red"
    assert start["input"]["image"] == ("MEDIA", "image/png", len(PNG))


async def test_httpx_http_error_is_recorded_and_still_raised_by_caller(
    restore_http_clients,
) -> None:
    sink = FakeSink()
    hooks.install_httpx_hook(make_tracker(sink))
    transport = httpx.MockTransport(
        lambda r: httpx.Response(500, json={"error": "boom"})
    )
    async with httpx.AsyncClient(transport=transport) as client:
        response = await client.post(
            "http://newapi/v1/chat/completions", json={"model": "m"}
        )
    assert response.status_code == 500
    ((_, result),) = sink.finished
    assert result.error.startswith("HTTP 500") and "boom" in result.error


async def test_httpx_transport_exception_is_recorded_and_reraised(
    restore_http_clients,
) -> None:
    sink = FakeSink()
    hooks.install_httpx_hook(make_tracker(sink))

    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused")

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(httpx.ConnectError):
            await client.post("http://newapi/v1/chat/completions", json={"model": "m"})
    ((_, result),) = sink.finished
    assert "ConnectError" in result.error


async def test_httpx_unrelated_and_langfuse_traffic_is_not_logged(
    restore_http_clients,
) -> None:
    sink = FakeSink()
    hooks.install_httpx_hook(make_tracker(sink))
    transport = httpx.MockTransport(lambda r: httpx.Response(200, json={}))
    async with httpx.AsyncClient(transport=transport) as client:
        await client.get("https://oss.example.com/a.mp4")
        await client.post("http://langfuse.local:3100/v1/chat/completions", json={})
    assert sink.started == []


async def test_sink_failure_never_breaks_the_model_call(restore_http_clients) -> None:
    hooks.install_httpx_hook(make_tracker(FakeSink(fail=True)))
    transport = httpx.MockTransport(lambda r: httpx.Response(200, json={"ok": True}))
    async with httpx.AsyncClient(transport=transport) as client:
        response = await client.post(
            "http://newapi/v1/chat/completions", json={"model": "m"}
        )
    assert response.json() == {"ok": True}


async def test_video_poll_logged_only_when_terminal(restore_http_clients) -> None:
    sink = FakeSink()
    hooks.install_httpx_hook(make_tracker(sink))
    bodies = iter(
        [
            {"id": "t1", "status": "running"},
            {"id": "t1", "status": "succeeded", "video_url": "https://cdn.x/v.mp4"},
        ]
    )
    transport = httpx.MockTransport(lambda r: httpx.Response(200, json=next(bodies)))
    async with httpx.AsyncClient(transport=transport) as client:
        await client.get("http://newapi/v1/video/generations/t1")
        assert sink.started == []
        await client.get("http://newapi/v1/video/generations/t1")
    assert len(sink.started) == 1 and sink.started[0]["kind"] == "video"
    assert sink.finished[0][1].output["video_url"] == "https://cdn.x/v.mp4"


def test_httpx_sync_client_is_covered(restore_http_clients) -> None:
    sink = FakeSink()
    hooks.install_httpx_hook(make_tracker(sink))
    transport = httpx.MockTransport(lambda r: httpx.Response(200, json={"ok": 1}))
    with httpx.Client(transport=transport) as client:
        client.post(
            "http://newapi/v1/embeddings", json={"model": "bge-m3", "input": "x"}
        )
    assert sink.started[0]["kind"] == "embedding"


# --- aiohttp hook -----------------------------------------------------------


async def test_aiohttp_json_call_is_logged_and_body_still_readable(
    restore_http_clients,
) -> None:
    sink = FakeSink()
    hooks.install_aiohttp_hook(make_tracker(sink))

    async def handler(request: web.Request) -> web.Response:
        body = await request.json()
        return web.json_response(
            {"echo": body["prompt"], "video_url": "https://cdn.x/v.mp4"}
        )

    app = web.Application()
    app.router.add_post("/v1/video/generations", handler)
    async with TestServer(app) as server:
        async with aiohttp.ClientSession() as session:
            async with session.post(
                server.make_url("/v1/video/generations"),
                json={"model": "seedance", "prompt": "a cat"},
            ) as response:
                data = await response.json()
    assert data["echo"] == "a cat"
    assert (
        sink.started[0]["kind"] == "video"
        and sink.started[0]["input"]["prompt"] == "a cat"
    )
    assert sink.finished[0][1].output["video_url"] == "https://cdn.x/v.mp4"


# --- install / settings -----------------------------------------------------


def test_install_is_noop_when_disabled(restore_http_clients) -> None:
    original = httpx.AsyncClient.send
    assert llm_call_log.install({}, sink=FakeSink()) is False
    assert httpx.AsyncClient.send is original


def test_install_requires_langfuse_config_without_custom_sink(
    restore_http_clients,
) -> None:
    original = httpx.AsyncClient.send
    assert llm_call_log.install({"LLM_CALL_LOG_ENABLED": "1"}) is False
    assert httpx.AsyncClient.send is original


def test_install_patches_clients_and_is_idempotent(restore_http_clients) -> None:
    env = {"LLM_CALL_LOG_ENABLED": "true", "LANGFUSE_HOST": "http://lf:3100"}
    assert llm_call_log.install(env, sink=FakeSink()) is True
    patched = httpx.AsyncClient.send
    assert llm_call_log.install(env, sink=FakeSink()) is True
    assert httpx.AsyncClient.send is patched


def test_record_artifact_logs_file_media(restore_http_clients, tmp_path) -> None:
    sink = FakeSink()
    llm_call_log._tracker = make_tracker(sink)
    clip = tmp_path / "clip.mp4"
    clip.write_bytes(MP4)
    llm_call_log.record_artifact(
        "video", path=clip, label="clip.mp4", source_url="https://cdn.x/v.mp4?sig=S"
    )
    assert sink.started[0]["kind"] == "video"
    assert sink.finished[0][1].output == ("MEDIA", "video/mp4", len(MP4))
    assert "sig=S" not in json.dumps(sink.started[0], default=str)
