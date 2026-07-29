# SPDX-License-Identifier: Elastic-2.0
# Copyright (c) 2026 ClaymoreLab
"""Contract tests for the Artlist image-to-video MCP provider.

These tests exercise the generator against MOCKED MCP responses. They pin the
tool names, request fields, cost-confirmation flow, polling payloads and the
download step that the generator depends on.

IMPORTANT: mocked responses are not a substitute for a live smoke test. The real
partner auth scheme and the exact ``mcp.artlist.io`` contract remain unverified
(see the module docstring in ``artlist_video.py``). These tests guard the wiring
so a future live verification only has to confirm the shapes, not rediscover
them.
"""

from __future__ import annotations

import pytest

from novelvideo.generators import artlist_video as av
from novelvideo.generators.artlist_video import (
    ArtlistVideoGenerator,
    ModelCapabilities,
    capabilities_for_group,
    describe_capabilities,
    parse_artlist_video_backend,
    validate_capabilities,
)
from novelvideo.generators.video_generator import VideoGenStatus


# --------------------------------------------------------------------------- #
# Fake MCP transport / session
# --------------------------------------------------------------------------- #
class FakeToolResult:
    """Mimics an MCP tool result carrying a structured JSON payload."""

    def __init__(self, payload: dict):
        self.structuredContent = payload
        self.content = []


class FakeSession:
    """Records call_tool invocations and returns canned payloads."""

    def __init__(self, responses: dict):
        # responses: tool_name -> dict | list[dict] (list = one payload per call,
        # last payload repeats once exhausted).
        self.responses = responses
        self.calls: list[tuple[str, dict]] = []
        self.initialized = False

    async def initialize(self) -> None:
        self.initialized = True

    async def call_tool(self, name: str, args: dict) -> FakeToolResult:
        self.calls.append((name, dict(args)))
        entry = self.responses[name]
        if isinstance(entry, list):
            payload = entry.pop(0) if len(entry) > 1 else entry[0]
        else:
            payload = entry
        return FakeToolResult(payload)

    def tool_names(self) -> list[str]:
        return [name for name, _ in self.calls]

    def args_for(self, name: str) -> dict:
        for called, args in self.calls:
            if called == name:
                return args
        raise AssertionError(f"tool {name!r} was never called; got {self.tool_names()}")


def _session_cls(session: FakeSession):
    class _Ctx:
        def __init__(self, read, write):
            self._session = session

        async def __aenter__(self):
            return self._session

        async def __aexit__(self, *exc):
            return False

    return _Ctx


def _streamable(captured: dict):
    def factory(url, headers=None):
        captured["url"] = url
        captured["headers"] = headers

        class _Ctx:
            async def __aenter__(self):
                return (object(), object(), None)

            async def __aexit__(self, *exc):
                return False

        return _Ctx()

    return factory


# --------------------------------------------------------------------------- #
# Fake aiohttp (for presigned upload PUT and download GET)
# --------------------------------------------------------------------------- #
class FakeHTTPResponse:
    def __init__(self, status: int = 200, body: bytes = b"VIDEO"):
        self.status = status
        self._body = body

    async def read(self) -> bytes:
        return self._body

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False


class FakeHTTPSession:
    def __init__(self, record: list, status: int = 200, body: bytes = b"VIDEO"):
        self._record = record
        self._status = status
        self._body = body

    def get(self, url, **kwargs):
        self._record.append(("GET", url))
        return FakeHTTPResponse(self._status, self._body)

    def put(self, url, data=None, headers=None):
        self._record.append(("PUT", url, data))
        return FakeHTTPResponse(self._status, b"")

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False


def _patch_aiohttp(monkeypatch, record: list, status: int = 200):
    monkeypatch.setattr(
        av.aiohttp,
        "ClientSession",
        lambda *a, **k: FakeHTTPSession(record, status=status),
    )


def _make_generator(**kwargs) -> ArtlistVideoGenerator:
    kwargs.setdefault("token", "test-partner-token")
    return ArtlistVideoGenerator(**kwargs)


async def _run_flow(gen: ArtlistVideoGenerator, session: FakeSession, **overrides):
    captured: dict = {}
    params = dict(
        image_path="https://cdn.example.com/first.png",
        prompt="a slow push in",
        output_path=overrides.pop("output_path"),
        aspect_ratio="9:16",
        duration=5.0,
        resolution=None,
        poll_interval=0.0,
        max_polls=10,
        log=lambda *_: None,
        progress=lambda *_: None,
        streamablehttp_client=_streamable(captured),
        client_session_cls=_session_cls(session),
    )
    params.update(overrides)
    result = await gen._run(**params)
    return result, captured


# --------------------------------------------------------------------------- #
# Backend alias parsing
# --------------------------------------------------------------------------- #
def test_parse_backend_alias_and_numeric():
    assert parse_artlist_video_backend("artlist_seedance-2.0") == 358
    assert parse_artlist_video_backend("artlist_358") == 358
    assert parse_artlist_video_backend("artlist_kling-2.1") == 105
    assert parse_artlist_video_backend("ARTLIST_seedance-2.0") == 358


def test_parse_backend_rejects_non_artlist_and_unknown():
    assert parse_artlist_video_backend("seedance_2") is None
    assert parse_artlist_video_backend("") is None
    assert parse_artlist_video_backend(None) is None
    # An artlist_ prefix with an unknown alias resolves to no group id.
    assert parse_artlist_video_backend("artlist_does-not-exist") is None


# --------------------------------------------------------------------------- #
# Auth header (assumed bearer scheme)
# --------------------------------------------------------------------------- #
def test_requires_token():
    with pytest.raises(ValueError):
        ArtlistVideoGenerator(token=None)


def test_headers_send_bearer_token():
    gen = _make_generator(token="abc123")
    assert gen._headers() == {"Authorization": "Bearer abc123"}


# --------------------------------------------------------------------------- #
# Happy path: http first frame -> submit -> poll -> download
# --------------------------------------------------------------------------- #
async def test_happy_path_submit_poll_download(tmp_path, monkeypatch):
    record: list = []
    _patch_aiohttp(monkeypatch, record)

    session = FakeSession(
        {
            "upload_image": {"assetId": "asset-1"},
            "generate_video": {"status": "queued", "generationId": "gen-1"},
            "get_generation_status": [
                {"status": "processing"},
                {"status": "completed", "url": "https://cdn.example.com/out.mp4"},
            ],
        }
    )
    gen = _make_generator(model_group_id=358)
    out = str(tmp_path / "out.mp4")
    result, captured = await _run_flow(gen, session, output_path=out)

    # Transport got the configured URL and the assumed bearer header.
    assert captured["url"] == gen.mcp_url
    assert captured["headers"] == {"Authorization": "Bearer test-partner-token"}
    assert session.initialized is True

    # Tool names and order.
    assert session.tool_names() == [
        "upload_image",
        "generate_video",
        "get_generation_status",
        "get_generation_status",
    ]

    # upload_image received the http image URL.
    assert session.args_for("upload_image") == {"imageUrl": "https://cdn.example.com/first.png"}

    # generate_video request fields.
    gv = session.args_for("generate_video")
    assert gv["prompt"] == "a slow push in"
    assert gv["input"] == {"assetId": "asset-1"}
    assert gv["modelGroupId"] == 358
    assert gv["settings"]["aspect_ratio"] == "9:16"
    assert gv["settings"]["duration"] == 5

    # polling used the generation id.
    assert session.args_for("get_generation_status") == {"generationId": "gen-1"}

    # download happened and the result is populated.
    assert ("GET", "https://cdn.example.com/out.mp4") in record
    assert result.status == VideoGenStatus.DONE
    assert result.video_url == "https://cdn.example.com/out.mp4"
    assert result.video_path == out
    assert result.task_id == "gen-1"
    assert result.duration_seconds == 5.0
    # bytes actually written
    with open(out, "rb") as fh:
        assert fh.read() == b"VIDEO"


# --------------------------------------------------------------------------- #
# Presigned upload of a local file: upload_image -> PUT -> confirm_upload
# --------------------------------------------------------------------------- #
async def test_presigned_local_file_upload_confirm_flow(tmp_path, monkeypatch):
    record: list = []
    _patch_aiohttp(monkeypatch, record)

    img = tmp_path / "frame.png"
    img.write_bytes(b"PNGDATA")

    session = FakeSession(
        {
            "upload_image": {
                "uploadUrl": "https://upload.example.com/put",
                "uploadId": "up-9",
            },
            "confirm_upload": {"assetId": "asset-9"},
            "generate_video": {"status": "queued", "generationId": "gen-9"},
            "get_generation_status": {
                "status": "completed",
                "videoUrl": "https://cdn.example.com/clip.mp4",
            },
        }
    )
    gen = _make_generator()
    out = str(tmp_path / "clip.mp4")
    result, _ = await _run_flow(gen, session, image_path=str(img), output_path=out)

    # presigned negotiation carried mime + filename.
    up = session.args_for("upload_image")
    assert up["fileName"] == "frame.png"
    assert up["mimeType"] == "image/png"

    # bytes were PUT to the presigned URL.
    assert any(
        entry[0] == "PUT" and entry[1] == "https://upload.example.com/put"
        for entry in record
    )

    # confirm_upload closed the loop with the uploadId, yielding the assetId.
    assert session.args_for("confirm_upload") == {"uploadId": "up-9"}
    assert session.args_for("generate_video")["input"] == {"assetId": "asset-9"}

    assert result.status == VideoGenStatus.DONE
    assert result.video_url == "https://cdn.example.com/clip.mp4"


# --------------------------------------------------------------------------- #
# Cost confirmation flow
# --------------------------------------------------------------------------- #
async def test_confirmation_required_refused_by_default(tmp_path, monkeypatch):
    record: list = []
    _patch_aiohttp(monkeypatch, record)

    session = FakeSession(
        {
            "upload_image": {"assetId": "asset-1"},
            "generate_video": {"status": "confirmation_required", "confirmationId": "c-1"},
        }
    )
    gen = _make_generator()  # auto_confirm defaults to False
    result, _ = await _run_flow(gen, session, output_path=str(tmp_path / "o.mp4"))

    assert result.status == VideoGenStatus.FAILED
    assert "confirmation" in (result.error or "").lower()
    # It must NOT proceed to polling when refusing to confirm.
    assert "get_generation_status" not in session.tool_names()
    # generate_video was called exactly once (no auto re-submit).
    assert session.tool_names().count("generate_video") == 1


async def test_confirmation_auto_confirm_resubmits_and_proceeds(tmp_path, monkeypatch):
    record: list = []
    _patch_aiohttp(monkeypatch, record)

    session = FakeSession(
        {
            "upload_image": {"assetId": "asset-1"},
            "generate_video": [
                {"status": "confirmation_required", "confirmationId": "c-42"},
                {"status": "queued", "generationId": "gen-42"},
            ],
            "get_generation_status": {
                "status": "completed",
                "url": "https://cdn.example.com/ok.mp4",
            },
        }
    )
    gen = _make_generator(auto_confirm=True)
    result, _ = await _run_flow(gen, session, output_path=str(tmp_path / "ok.mp4"))

    # generate_video called twice: initial + confirm re-submit.
    gv_calls = [args for name, args in session.calls if name == "generate_video"]
    assert len(gv_calls) == 2
    assert gv_calls[1]["confirm"] is True
    assert gv_calls[1]["confirmationId"] == "c-42"

    assert result.status == VideoGenStatus.DONE
    assert result.task_id == "gen-42"


# --------------------------------------------------------------------------- #
# Error / edge polling payloads
# --------------------------------------------------------------------------- #
async def test_generation_failed_state(tmp_path, monkeypatch):
    record: list = []
    _patch_aiohttp(monkeypatch, record)
    session = FakeSession(
        {
            "upload_image": {"assetId": "a"},
            "generate_video": {"status": "queued", "generationId": "g"},
            "get_generation_status": {"status": "failed"},
        }
    )
    gen = _make_generator()
    result, _ = await _run_flow(gen, session, output_path=str(tmp_path / "o.mp4"))
    assert result.status == VideoGenStatus.FAILED
    assert result.task_id == "g"
    assert "failed" in (result.error or "").lower()


async def test_missing_generation_id(tmp_path, monkeypatch):
    record: list = []
    _patch_aiohttp(monkeypatch, record)
    session = FakeSession(
        {
            "upload_image": {"assetId": "a"},
            "generate_video": {"status": "queued"},  # no generationId
        }
    )
    gen = _make_generator()
    result, _ = await _run_flow(gen, session, output_path=str(tmp_path / "o.mp4"))
    assert result.status == VideoGenStatus.FAILED
    assert "generationId" in (result.error or "")


async def test_done_without_video_url(tmp_path, monkeypatch):
    record: list = []
    _patch_aiohttp(monkeypatch, record)
    session = FakeSession(
        {
            "upload_image": {"assetId": "a"},
            "generate_video": {"status": "queued", "generationId": "g"},
            "get_generation_status": {"status": "completed"},  # no url
        }
    )
    gen = _make_generator()
    result, _ = await _run_flow(gen, session, output_path=str(tmp_path / "o.mp4"))
    assert result.status == VideoGenStatus.FAILED
    assert "video url" in (result.error or "").lower()


async def test_download_failure_reported(tmp_path, monkeypatch):
    record: list = []
    _patch_aiohttp(monkeypatch, record, status=500)  # GET returns non-200
    session = FakeSession(
        {
            "upload_image": {"assetId": "a"},
            "generate_video": {"status": "queued", "generationId": "g"},
            "get_generation_status": {
                "status": "completed",
                "url": "https://cdn.example.com/out.mp4",
            },
        }
    )
    gen = _make_generator()
    result, _ = await _run_flow(gen, session, output_path=str(tmp_path / "o.mp4"))
    assert result.status == VideoGenStatus.FAILED
    assert "download" in (result.error or "").lower()


# --------------------------------------------------------------------------- #
# Resolution forwarding (declared capability)
# --------------------------------------------------------------------------- #
async def test_resolution_forwarded_into_settings(tmp_path, monkeypatch):
    record: list = []
    _patch_aiohttp(monkeypatch, record)
    session = FakeSession(
        {
            "upload_image": {"assetId": "a"},
            "generate_video": {"status": "queued", "generationId": "g"},
            "get_generation_status": {
                "status": "completed",
                "url": "https://cdn.example.com/out.mp4",
            },
        }
    )
    gen = _make_generator()
    assert gen.capabilities.resolution is True
    await _run_flow(
        gen, session, output_path=str(tmp_path / "o.mp4"), resolution="1080P"
    )
    assert session.args_for("generate_video")["settings"]["resolution"] == "1080p"


# --------------------------------------------------------------------------- #
# Capability declaration + validation (reject, don't silently drop)
# --------------------------------------------------------------------------- #
def test_default_capabilities_declared():
    caps = capabilities_for_group(358)
    assert caps.first_frame_image is True
    assert caps.resolution is True
    # Extras the alias name implies but this backend does NOT forward:
    assert caps.multi_image is False
    assert caps.audio_reference is False
    assert caps.video_reference is False
    assert caps.generated_audio is False
    flags = describe_capabilities(caps)
    assert set(flags) >= {
        "first_frame_image",
        "multi_image",
        "audio_reference",
        "video_reference",
        "generated_audio",
        "resolution",
    }


def test_validate_capabilities_accepts_single_frame():
    caps = capabilities_for_group(358)
    assert validate_capabilities(caps) == []
    assert validate_capabilities(caps, resolution="1080p") == []


def test_validate_capabilities_rejects_extras():
    caps = capabilities_for_group(358)
    assert validate_capabilities(caps, last_frame_path="/tmp/last.png")
    assert validate_capabilities(
        caps, references=[{"type": "image"}, {"type": "image"}]
    )
    assert validate_capabilities(caps, references=[{"type": "video"}])
    assert validate_capabilities(caps, references=[{"type": "audio"}])
    assert validate_capabilities(caps, generate_audio=True)
    assert validate_capabilities(caps, audio=True)
    # a single image reference is fine
    assert validate_capabilities(caps, references=[{"type": "image"}]) == []


def test_validate_capabilities_respects_declared_extras():
    caps = ModelCapabilities(multi_image=True, video_reference=True)
    assert validate_capabilities(caps, last_frame_path="/tmp/last.png") == []
    assert validate_capabilities(caps, references=[{"type": "video"}]) == []


IMG_URL = "https://cdn.example.com/first.png"


async def test_generate_rejects_last_frame(tmp_path):
    gen = _make_generator()
    result = await gen.generate(
        image_path=IMG_URL,
        prompt="p",
        output_path=str(tmp_path / "o.mp4"),
        last_frame_path="https://cdn.example.com/last.png",
    )
    assert result.status == VideoGenStatus.FAILED
    assert "multi-image" in result.error or "keyframe" in result.error


async def test_generate_rejects_video_and_audio_references(tmp_path):
    gen = _make_generator()
    result = await gen.generate(
        image_path=IMG_URL,
        prompt="p",
        output_path=str(tmp_path / "o.mp4"),
        references=[{"type": "video", "path": "/tmp/v.mp4"}],
    )
    assert result.status == VideoGenStatus.FAILED
    assert "video reference" in result.error.lower()


async def test_generate_rejects_generated_audio(tmp_path):
    gen = _make_generator()
    result = await gen.generate(
        image_path=IMG_URL,
        prompt="p",
        output_path=str(tmp_path / "o.mp4"),
        generate_audio=True,
    )
    assert result.status == VideoGenStatus.FAILED
    assert "audio" in result.error.lower()


# --------------------------------------------------------------------------- #
# _tool_json / _find_video_url parsing
# --------------------------------------------------------------------------- #
def test_tool_json_parses_structured_and_text():
    class R1:
        structuredContent = {"a": 1}
        content = []

    assert ArtlistVideoGenerator._tool_json(R1()) == {"a": 1}

    class Block:
        text = '{"b": 2}'

    class R2:
        structuredContent = None
        content = [Block()]

    assert ArtlistVideoGenerator._tool_json(R2()) == {"b": 2}


def test_find_video_url_across_shapes():
    f = ArtlistVideoGenerator._find_video_url
    assert f({"url": "http://x/v.mp4"}) == "http://x/v.mp4"
    assert f({"videoUrl": "https://x/v.mp4"}) == "https://x/v.mp4"
    assert f({"output": {"downloadUrl": "https://x/o.mp4"}}) == "https://x/o.mp4"
    assert f({"outputs": ["https://x/a.mp4"]}) == "https://x/a.mp4"
    assert f({"assets": [{"assetUrl": "https://x/b.mp4"}]}) == "https://x/b.mp4"
    assert f({"nope": 1}) is None
    assert f(None) is None
