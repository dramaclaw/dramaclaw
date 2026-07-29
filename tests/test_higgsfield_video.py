"""Contract tests for the Higgsfield image-to-video generator.

These mock the aiohttp HTTP layer (no network) and assert the review's
blocking correctness fixes:

  * submit request forwards the requested aspect_ratio + duration,
  * unsupported aspect_ratio / duration produce a clear error (never a
    silent provider default),
  * poll -> complete -> download flow works end to end, and
  * the recorded duration is probed from the provider response rather than
    assumed equal to the requested duration.
"""

import json

import pytest

import novelvideo.generators.video_generator as vg
from novelvideo.generators.video_generator import (
    HiggsfieldVideoGenerator,
    VideoGenStatus,
)

pytestmark = pytest.mark.m09


# --------------------------------------------------------------------------
# Minimal aiohttp fakes: session.post/get are async context managers whose
# response exposes .status / .json() / .text() / .read().
# --------------------------------------------------------------------------
class _FakeResponse:
    def __init__(self, *, status=200, json_data=None, body=b""):
        self.status = status
        self._json = json_data
        self._body = body

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_exc):
        return False

    async def json(self):
        return self._json

    async def text(self):
        return json.dumps(self._json) if self._json is not None else ""

    async def read(self):
        return self._body


class _FakeSession:
    """Routes calls to a shared handler that records requests + scripts replies."""

    def __init__(self, handler):
        self._handler = handler

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_exc):
        return False

    def post(self, url, **kwargs):
        return self._handler.handle("POST", url, kwargs)

    def get(self, url, **kwargs):
        return self._handler.handle("GET", url, kwargs)


class _Handler:
    VIDEO_URL = "https://cdn.higgsfield.ai/out.mp4"

    def __init__(self, *, submit_reply, poll_replies=None, video_body=b"MP4DATA"):
        self.submit_reply = submit_reply
        self.poll_replies = list(poll_replies or [])
        self.video_body = video_body
        self.submitted_body = None
        self.poll_count = 0

    def handle(self, method, url, kwargs):
        if method == "POST":
            self.submitted_body = kwargs.get("json")
            return _FakeResponse(json_data=self.submit_reply)
        # GET: either the video download or a status poll.
        if url == self.VIDEO_URL:
            return _FakeResponse(body=self.video_body)
        reply = self.poll_replies[min(self.poll_count, len(self.poll_replies) - 1)]
        self.poll_count += 1
        return _FakeResponse(json_data=reply)


def _install(monkeypatch, handler):
    monkeypatch.setattr(vg.aiohttp, "ClientSession", lambda *a, **k: _FakeSession(handler))


def _generator():
    return HiggsfieldVideoGenerator(api_key="KEY_ID:KEY_SECRET")


# --------------------------------------------------------------------------
# Tests
# --------------------------------------------------------------------------
async def test_submit_forwards_aspect_ratio_and_duration(monkeypatch, tmp_path):
    handler = _Handler(
        submit_reply={
            "request_id": "req-1",
            "status_url": "https://platform.higgsfield.ai/requests/req-1/status",
        },
        poll_replies=[
            {"status": "queued"},
            {
                "status": "completed",
                "video": {"url": _Handler.VIDEO_URL, "duration": 5.0},
            },
        ],
    )
    _install(monkeypatch, handler)

    out = tmp_path / "clip.mp4"
    result = await _generator().generate(
        image_path="https://example.com/frame.png",
        prompt="camera slowly pushes in",
        output_path=str(out),
        aspect_ratio="16:9",
        duration=5.0,
        poll_interval=0.0,
    )

    assert result.status == VideoGenStatus.DONE
    # Blocking fix #1: both values reach the provider request body.
    assert handler.submitted_body["aspect_ratio"] == "16:9"
    assert handler.submitted_body["duration"] == 5
    assert out.read_bytes() == b"MP4DATA"


async def test_poll_then_complete_then_download(monkeypatch, tmp_path):
    handler = _Handler(
        submit_reply={
            "request_id": "req-2",
            "status_url": "https://platform.higgsfield.ai/requests/req-2/status",
        },
        poll_replies=[
            {"status": "queued"},
            {"status": "in_progress"},
            {
                "status": "completed",
                "jobs": [
                    {"results": {"raw": {"url": _Handler.VIDEO_URL, "duration": 3}}}
                ],
            },
        ],
    )
    _install(monkeypatch, handler)

    out = tmp_path / "clip.mp4"
    result = await _generator().generate(
        image_path="https://example.com/frame.png",
        prompt="gentle motion",
        output_path=str(out),
        aspect_ratio="9:16",
        duration=3,
        poll_interval=0.0,
    )

    assert result.status == VideoGenStatus.DONE
    assert result.task_id == "req-2"
    assert result.video_url == _Handler.VIDEO_URL
    assert handler.poll_count == 3  # two non-terminal polls + the completed one
    assert out.exists()


async def test_recorded_duration_probed_from_response(monkeypatch, tmp_path):
    # Provider reports 4.7s even though 5s was requested -> record the real value.
    handler = _Handler(
        submit_reply={
            "status": "completed",
            "video": {"url": _Handler.VIDEO_URL, "duration": 4.7},
        }
    )
    _install(monkeypatch, handler)

    result = await _generator().generate(
        image_path="https://example.com/frame.png",
        prompt="motion",
        output_path=str(tmp_path / "clip.mp4"),
        aspect_ratio="9:16",
        duration=5.0,
        poll_interval=0.0,
    )

    assert result.status == VideoGenStatus.DONE
    assert result.duration_seconds == pytest.approx(4.7)


async def test_duration_falls_back_to_requested_when_provider_silent(
    monkeypatch, tmp_path
):
    # No duration in the response and the fake body is not a real video, so the
    # ffprobe fallback yields nothing -> record the requested (mapped) duration.
    handler = _Handler(
        submit_reply={
            "status": "completed",
            "video": {"url": _Handler.VIDEO_URL},
        }
    )
    _install(monkeypatch, handler)

    result = await _generator().generate(
        image_path="https://example.com/frame.png",
        prompt="motion",
        output_path=str(tmp_path / "clip.mp4"),
        aspect_ratio="1:1",
        duration=3,
        poll_interval=0.0,
    )

    assert result.status == VideoGenStatus.DONE
    assert result.duration_seconds == pytest.approx(3.0)


async def test_unsupported_aspect_ratio_is_a_clear_error(monkeypatch, tmp_path):
    # Must not reach the network: validation fails before submit.
    def _boom(*_a, **_k):
        raise AssertionError("network should not be touched on validation failure")

    monkeypatch.setattr(vg.aiohttp, "ClientSession", _boom)

    result = await _generator().generate(
        image_path="https://example.com/frame.png",
        prompt="motion",
        output_path=str(tmp_path / "clip.mp4"),
        aspect_ratio="21:9",
        duration=5.0,
    )

    assert result.status == VideoGenStatus.FAILED
    assert "aspect_ratio" in result.error
    assert "21:9" in result.error


async def test_unsupported_duration_is_a_clear_error(monkeypatch, tmp_path):
    def _boom(*_a, **_k):
        raise AssertionError("network should not be touched on validation failure")

    monkeypatch.setattr(vg.aiohttp, "ClientSession", _boom)

    result = await _generator().generate(
        image_path="https://example.com/frame.png",
        prompt="motion",
        output_path=str(tmp_path / "clip.mp4"),
        aspect_ratio="9:16",
        duration=12,
    )

    assert result.status == VideoGenStatus.FAILED
    assert "duration" in result.error
    assert "12" in result.error


def test_extract_duration_reads_all_shapes():
    ex = HiggsfieldVideoGenerator._extract_duration
    assert ex({"video": {"duration": 5}}) == 5.0
    assert ex({"jobs": [{"results": {"raw": {"duration": 3.2}}}]}) == pytest.approx(3.2)
    assert ex({"duration": "4"}) == 4.0
    assert ex({"video": {"url": "x"}}) is None
    assert ex({"duration": 0}) is None  # non-positive ignored


def test_capabilities_declared():
    caps = HiggsfieldVideoGenerator.CAPABILITIES
    assert caps["keyframe_mode"] is False
    assert caps["native_audio"] is False
    assert "9:16" in caps["supported_aspect_ratios"]
    assert 5 in caps["supported_durations_seconds"]
