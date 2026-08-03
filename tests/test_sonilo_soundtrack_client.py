"""SoniloSoundtrackClient 的 NDJSON 流式响应解析与错误处理。"""

import base64
import json

import httpx
import pytest
import respx

from novelvideo.audio.sonilo_soundtrack import (
    SoniloSoundtrackClient,
    SoniloSoundtrackError,
)


pytestmark = pytest.mark.m09

_BASE_URL = "https://sonilo.test"
_ENDPOINT = f"{_BASE_URL}/v1/video-to-music"


def _client(**overrides):
    kwargs = {
        "api_key": "test-key",
        "base_url": _BASE_URL,
        "timeout_seconds": 30,
    }
    kwargs.update(overrides)
    return SoniloSoundtrackClient(**kwargs)


def _video(tmp_path):
    video_path = tmp_path / "ep001_final.mp4"
    video_path.write_bytes(b"video")
    return video_path


def _chunk(data: bytes, index: int = 0) -> str:
    return json.dumps(
        {
            "type": "audio_chunk",
            "stream_index": index,
            "num_streams": 1,
            "data": base64.b64encode(data).decode(),
        }
    )


def test_client_requires_api_key(tmp_path):
    with pytest.raises(SoniloSoundtrackError, match="SONILO_API_KEY"):
        _client(api_key="").generate_soundtrack(
            _video(tmp_path), tmp_path / "out.m4a"
        )


@respx.mock
def test_client_streams_audio_chunks_to_file(tmp_path):
    body = "\n".join(
        [
            json.dumps({"type": "stage_start", "stage": "analysis"}),
            _chunk(b"AUD"),
            _chunk(b"IO"),
            json.dumps({"type": "title", "title": "Episode Theme"}),
            "not-json",
            json.dumps({"type": "complete"}),
            "",
        ]
    )
    route = respx.post(_ENDPOINT).mock(return_value=httpx.Response(200, text=body))

    output_path = tmp_path / "ep001_soundtrack.m4a"
    result = _client().generate_soundtrack(
        _video(tmp_path), output_path, prompt="悬疑"
    )

    assert result == output_path
    assert output_path.read_bytes() == b"AUDIO"
    request = route.calls.last.request
    assert request.headers["authorization"] == "Bearer test-key"
    content = request.read()
    assert b'name="video"' in content
    assert "悬疑".encode() in content


@respx.mock
def test_client_raises_on_error_event(tmp_path):
    body = "\n".join(
        [
            _chunk(b"AUD"),
            json.dumps({"type": "error", "message": "generation failed"}),
        ]
    )
    respx.post(_ENDPOINT).mock(return_value=httpx.Response(200, text=body))

    with pytest.raises(SoniloSoundtrackError, match="generation failed"):
        _client().generate_soundtrack(_video(tmp_path), tmp_path / "out.m4a")
    assert not (tmp_path / "out.m4a").exists()


@respx.mock
def test_client_raises_when_stream_ends_without_complete(tmp_path):
    respx.post(_ENDPOINT).mock(return_value=httpx.Response(200, text=_chunk(b"AUD")))

    with pytest.raises(SoniloSoundtrackError, match="complete"):
        _client().generate_soundtrack(_video(tmp_path), tmp_path / "out.m4a")


@respx.mock
def test_client_maps_http_401_without_leaking_key(tmp_path):
    respx.post(_ENDPOINT).mock(
        return_value=httpx.Response(401, json={"detail": "invalid key"})
    )

    with pytest.raises(SoniloSoundtrackError) as exc_info:
        _client().generate_soundtrack(_video(tmp_path), tmp_path / "out.m4a")

    message = str(exc_info.value)
    assert "SONILO_API_KEY" in message
    assert "test-key" not in message
