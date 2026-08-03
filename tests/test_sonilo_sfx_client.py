"""SoniloSfxClient 的异步任务管线（提交/轮询/下载）与错误处理。"""

import httpx
import pytest
import respx

from novelvideo.audio import sonilo_soundtrack
from novelvideo.audio.sonilo_soundtrack import (
    SoniloSfxClient,
    SoniloSfxError,
)


pytestmark = pytest.mark.m09

_BASE_URL = "https://sonilo.test"
_SUBMIT_ENDPOINT = f"{_BASE_URL}/v1/video-to-sfx"
_TASK_ENDPOINT = f"{_BASE_URL}/v1/tasks/task-123"
_ARTIFACT_URL = "https://cdn.sonilo.test/artifacts/task-123.m4a?sig=presigned"


@pytest.fixture(autouse=True)
def _no_poll_wait(monkeypatch):
    monkeypatch.setattr(sonilo_soundtrack, "_sfx_poll_sleep", lambda _seconds: None)


def _client(**overrides):
    kwargs = {
        "api_key": "test-key",
        "base_url": _BASE_URL,
        "timeout_seconds": 30,
    }
    kwargs.update(overrides)
    return SoniloSfxClient(**kwargs)


def _video(tmp_path):
    video_path = tmp_path / "ep001_final.mp4"
    video_path.write_bytes(b"video")
    return video_path


def _submitted() -> httpx.Response:
    return httpx.Response(202, json={"task_id": "task-123"})


def _task(status: str, **extra) -> httpx.Response:
    return httpx.Response(200, json={"status": status, **extra})


def test_client_requires_api_key(tmp_path):
    with pytest.raises(SoniloSfxError, match="SONILO_API_KEY"):
        _client(api_key="").generate_sfx(_video(tmp_path), tmp_path / "out.m4a")


@respx.mock
def test_client_submits_polls_and_downloads_audio(tmp_path):
    submit_route = respx.post(_SUBMIT_ENDPOINT).mock(return_value=_submitted())
    task_route = respx.get(_TASK_ENDPOINT).mock(
        side_effect=[
            _task("processing"),
            _task("succeeded", audio={"url": _ARTIFACT_URL, "content_type": "audio/mp4"}),
        ]
    )
    artifact_route = respx.get(_ARTIFACT_URL).mock(
        return_value=httpx.Response(200, content=b"SFXAUDIO")
    )

    output_path = tmp_path / "ep001_sfx.m4a"
    result = _client().generate_sfx(_video(tmp_path), output_path, prompt="雨夜街道")

    assert result == output_path
    assert output_path.read_bytes() == b"SFXAUDIO"

    submit_request = submit_route.calls.last.request
    assert submit_request.headers["authorization"] == "Bearer test-key"
    content = submit_request.read()
    assert b'name="video"' in content
    assert "雨夜街道".encode() in content

    assert task_route.call_count == 2
    assert task_route.calls.last.request.headers["authorization"] == "Bearer test-key"
    # 产物 URL 是预签名的，下载请求绝不能携带 API key。
    assert "authorization" not in artifact_route.calls.last.request.headers


@respx.mock
def test_client_raises_on_failed_task(tmp_path):
    respx.post(_SUBMIT_ENDPOINT).mock(return_value=_submitted())
    respx.get(_TASK_ENDPOINT).mock(
        return_value=_task(
            "failed",
            error={"code": "GENERATION_FAILED", "message": "generation failed"},
            refunded=True,
        )
    )

    with pytest.raises(SoniloSfxError, match="generation failed"):
        _client().generate_sfx(_video(tmp_path), tmp_path / "out.m4a")
    assert not (tmp_path / "out.m4a").exists()


@respx.mock
def test_client_fails_fast_on_task_404(tmp_path):
    """/v1/tasks 只覆盖音效任务：404 = task_id 无效，重试无意义，立即失败。"""
    respx.post(_SUBMIT_ENDPOINT).mock(return_value=_submitted())
    task_route = respx.get(_TASK_ENDPOINT).mock(
        return_value=httpx.Response(404, json={"detail": "task not found"})
    )

    with pytest.raises(SoniloSfxError, match="task-123"):
        _client().generate_sfx(_video(tmp_path), tmp_path / "out.m4a")
    assert task_route.call_count == 1


@respx.mock
def test_client_retries_transient_poll_errors(tmp_path):
    """轮询遇到 5xx 等暂时性错误时任务仍在后端继续，留在循环里等下一轮。"""
    respx.post(_SUBMIT_ENDPOINT).mock(return_value=_submitted())
    respx.get(_TASK_ENDPOINT).mock(
        side_effect=[
            httpx.Response(500, json={"detail": "backend hiccup"}),
            _task("succeeded", audio={"url": _ARTIFACT_URL}),
        ]
    )
    respx.get(_ARTIFACT_URL).mock(return_value=httpx.Response(200, content=b"SFX"))

    output_path = tmp_path / "out.m4a"
    _client().generate_sfx(_video(tmp_path), output_path)
    assert output_path.read_bytes() == b"SFX"


@respx.mock
def test_client_times_out_when_task_never_finishes(tmp_path):
    respx.post(_SUBMIT_ENDPOINT).mock(return_value=_submitted())
    respx.get(_TASK_ENDPOINT).mock(return_value=_task("processing"))

    with pytest.raises(SoniloSfxError, match="超时"):
        _client(timeout_seconds=0.001).generate_sfx(
            _video(tmp_path), tmp_path / "out.m4a"
        )


@respx.mock
def test_client_raises_when_submit_returns_no_task_id(tmp_path):
    respx.post(_SUBMIT_ENDPOINT).mock(return_value=httpx.Response(202, json={}))

    with pytest.raises(SoniloSfxError, match="task_id"):
        _client().generate_sfx(_video(tmp_path), tmp_path / "out.m4a")


@respx.mock
def test_client_raises_when_task_succeeds_without_audio(tmp_path):
    respx.post(_SUBMIT_ENDPOINT).mock(return_value=_submitted())
    respx.get(_TASK_ENDPOINT).mock(return_value=_task("succeeded"))

    with pytest.raises(SoniloSfxError, match="未返回音频产物"):
        _client().generate_sfx(_video(tmp_path), tmp_path / "out.m4a")


@respx.mock
def test_client_maps_http_401_without_leaking_key(tmp_path):
    respx.post(_SUBMIT_ENDPOINT).mock(
        return_value=httpx.Response(401, json={"detail": "invalid key"})
    )

    with pytest.raises(SoniloSfxError) as exc_info:
        _client().generate_sfx(_video(tmp_path), tmp_path / "out.m4a")

    message = str(exc_info.value)
    assert "SONILO_API_KEY" in message
    assert "test-key" not in message
