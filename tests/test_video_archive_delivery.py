from __future__ import annotations

import hashlib
from pathlib import Path

import pytest

pytestmark = pytest.mark.m09


def test_ce_does_not_expose_archive_delivery_port(monkeypatch) -> None:
    import novelvideo.ports as ports

    monkeypatch.setattr(ports.runtime_env, "edition", lambda: "ce")

    def forbidden(_name: str):
        raise AssertionError("CE must not resolve the EE archive delivery port")

    monkeypatch.setattr(ports, "get_port", forbidden)

    assert ports.get_video_result_delivery() is None


def test_ee_resolves_archive_delivery_port(monkeypatch) -> None:
    import novelvideo.ports as ports

    delivery = object()
    monkeypatch.setattr(ports.runtime_env, "edition", lambda: "ee")
    monkeypatch.setattr(
        ports,
        "get_port",
        lambda name: delivery if name == "video_result_delivery" else None,
    )

    assert ports.get_video_result_delivery() is delivery


class _ArchiveDelivery:
    def __init__(self) -> None:
        self.calls = 0

    async def deliver(self, *, source, output_path: str):
        from novelvideo.ports.video_delivery import VideoDeliveryReceipt

        self.calls += 1
        Path(output_path).write_bytes(b"archived-video")
        return VideoDeliveryReceipt(
            method="download",
            size=len(b"archived-video"),
            sha256=hashlib.sha256(b"archived-video").hexdigest(),
        )


def _archive_payload(status: str, *, retryable: bool) -> dict:
    payload = {"status": status, "retryable": retryable}
    if status == "success":
        payload.update(
            {
                "asset_id": 17,
                "storage_provider": "aliyun_oss",
                "bucket": "gateway-archive",
                "object_key": "newapi/results/task/video.mp4",
                "url": "https://archive.example/video.mp4?signature=fresh",
                "content_type": "video/mp4",
                "size": len(b"archived-video"),
                "sha256": hashlib.sha256(b"archived-video").hexdigest(),
            }
        )
    return payload


@pytest.mark.asyncio
async def test_newapi_waits_for_archive_then_delivers_without_resubmitting(
    monkeypatch, tmp_path: Path
) -> None:
    from novelvideo.generators import video_generator as module
    from novelvideo.generators.video_generator import (
        NewApiVideoGenerator,
        VideoGenStatus,
    )

    generator = NewApiVideoGenerator(
        api_key="test-key", endpoint="https://gateway.example/v1", model="video-model"
    )
    delivery = _ArchiveDelivery()
    calls = {"submit": 0, "poll": 0, "confirm": 0, "refund": 0}

    async def submit(*_args, **_kwargs):
        calls["submit"] += 1
        return {"id": "task-1"}

    async def poll(*_args, **_kwargs):
        calls["poll"] += 1
        archive = _archive_payload(
            "pending" if calls["poll"] == 1 else "success",
            retryable=calls["poll"] == 1,
        )
        return {
            "code": "success",
            "data": {
                "status": "success",
                "task_id": "task-1",
                "result_url": "https://upstream.example/video.mp4",
                "archive": archive,
            },
        }

    async def reserve(*_args, **_kwargs):
        return "reservation-1"

    async def confirm(*_args, **_kwargs):
        calls["confirm"] += 1

    async def refund(*_args, **_kwargs):
        calls["refund"] += 1

    async def forbidden(*_args, **_kwargs):
        raise AssertionError("archived result must not use the legacy downloader")

    monkeypatch.setattr(generator, "_post_json", submit)
    monkeypatch.setattr(generator, "_get_json", poll)
    monkeypatch.setattr(generator, "_download_video", forbidden)
    monkeypatch.setattr(module, "get_video_result_delivery", lambda: delivery)
    monkeypatch.setattr(module, "_reserve_video_model_call", reserve)
    monkeypatch.setattr(module, "_confirm_video_model_call", confirm)
    monkeypatch.setattr(module, "_refund_video_model_call", refund)

    output = tmp_path / "video.mp4"
    result = await generator.generate(
        image_path=None,
        prompt="test",
        output_path=str(output),
        poll_interval=0,
        max_polls=2,
    )

    assert result.status is VideoGenStatus.DONE
    assert result.video_url == "https://archive.example/video.mp4?signature=fresh"
    assert output.read_bytes() == b"archived-video"
    assert calls == {"submit": 1, "poll": 2, "confirm": 1, "refund": 0}
    assert delivery.calls == 1


@pytest.mark.asyncio
async def test_newapi_archive_timeout_confirms_generation_and_never_refunds(
    monkeypatch, tmp_path: Path
) -> None:
    from novelvideo.generators import video_generator as module
    from novelvideo.generators.video_generator import (
        NewApiVideoGenerator,
        VideoGenStatus,
    )

    generator = NewApiVideoGenerator(
        api_key="test-key", endpoint="https://gateway.example/v1", model="video-model"
    )
    settlements = {"confirm": 0, "refund": 0}

    async def reserve(*_args, **_kwargs):
        return "reservation-1"

    async def confirm(*_args, **_kwargs):
        settlements["confirm"] += 1

    async def refund(*_args, **_kwargs):
        settlements["refund"] += 1

    async def submit(*_args, **_kwargs):
        return {"id": "task-1"}

    async def poll(*_args, **_kwargs):
        return {
            "status": "success",
            "archive": _archive_payload("pending", retryable=True),
        }

    monkeypatch.setattr(generator, "_post_json", submit)
    monkeypatch.setattr(generator, "_get_json", poll)
    monkeypatch.setattr(module, "get_video_result_delivery", lambda: _ArchiveDelivery())
    monkeypatch.setattr(module, "_reserve_video_model_call", reserve)
    monkeypatch.setattr(module, "_confirm_video_model_call", confirm)
    monkeypatch.setattr(module, "_refund_video_model_call", refund)

    result = await generator.generate(
        image_path=None,
        prompt="test",
        output_path=str(tmp_path / "video.mp4"),
        poll_interval=0,
        max_polls=1,
    )

    assert result.status is VideoGenStatus.FAILED
    assert result.error == "VIDEO_ARCHIVE_PENDING"
    assert settlements == {"confirm": 1, "refund": 0}


@pytest.mark.asyncio
async def test_newapi_delivery_retry_repolls_archive_without_regenerating(
    monkeypatch, tmp_path: Path
) -> None:
    from novelvideo.generators import video_generator as module
    from novelvideo.generators.video_generator import (
        NewApiVideoGenerator,
        VideoGenStatus,
    )
    from novelvideo.ports.video_delivery import VideoDeliveryError, VideoDeliveryReceipt

    generator = NewApiVideoGenerator(
        api_key="test-key", endpoint="https://gateway.example/v1", model="video-model"
    )
    calls = {"submit": 0, "poll": 0, "delivery": 0, "confirm": 0, "refund": 0}

    class RetryDelivery:
        async def deliver(self, *, source, output_path: str):
            calls["delivery"] += 1
            if calls["delivery"] == 1:
                raise VideoDeliveryError(
                    "VIDEO_PROJECT_OSS_COPY_FAILED", retryable=True
                )
            Path(output_path).write_bytes(b"archived-video")
            return VideoDeliveryReceipt(
                method="oss_copy",
                size=len(b"archived-video"),
                sha256=hashlib.sha256(b"archived-video").hexdigest(),
            )

    async def submit(*_args, **_kwargs):
        calls["submit"] += 1
        return {"id": "task-1"}

    async def poll(*_args, **_kwargs):
        calls["poll"] += 1
        archive = _archive_payload("success", retryable=False)
        archive["url"] = f"https://archive.example/video.mp4?attempt={calls['poll']}"
        return {"status": "success", "archive": archive}

    async def reserve(*_args, **_kwargs):
        return "reservation-1"

    async def confirm(*_args, **_kwargs):
        calls["confirm"] += 1

    async def refund(*_args, **_kwargs):
        calls["refund"] += 1

    monkeypatch.setattr(generator, "_post_json", submit)
    monkeypatch.setattr(generator, "_get_json", poll)
    monkeypatch.setattr(module, "get_video_result_delivery", lambda: RetryDelivery())
    monkeypatch.setattr(module, "_reserve_video_model_call", reserve)
    monkeypatch.setattr(module, "_confirm_video_model_call", confirm)
    monkeypatch.setattr(module, "_refund_video_model_call", refund)

    result = await generator.generate(
        image_path=None,
        prompt="test",
        output_path=str(tmp_path / "video.mp4"),
        poll_interval=0,
        max_polls=2,
    )

    assert result.status is VideoGenStatus.DONE
    assert result.video_url.endswith("attempt=2")
    assert calls == {"submit": 1, "poll": 2, "delivery": 2, "confirm": 1, "refund": 0}


@pytest.mark.asyncio
async def test_newapi_terminal_archive_failure_does_not_deliver_or_refund(
    monkeypatch, tmp_path: Path
) -> None:
    from novelvideo.generators import video_generator as module
    from novelvideo.generators.video_generator import (
        NewApiVideoGenerator,
        VideoGenStatus,
    )

    generator = NewApiVideoGenerator(
        api_key="test-key", endpoint="https://gateway.example/v1", model="video-model"
    )
    calls = {"confirm": 0, "refund": 0}

    async def reserve(*_args, **_kwargs):
        return "reservation-1"

    async def confirm(*_args, **_kwargs):
        calls["confirm"] += 1

    async def refund(*_args, **_kwargs):
        calls["refund"] += 1

    async def submit(*_args, **_kwargs):
        return {"id": "task-1"}

    async def poll(*_args, **_kwargs):
        return {
            "status": "success",
            "archive": _archive_payload("failed", retryable=False),
        }

    async def forbidden(*_args, **_kwargs):
        raise AssertionError("terminal archive failure cannot enter delivery")

    monkeypatch.setattr(generator, "_post_json", submit)
    monkeypatch.setattr(generator, "_get_json", poll)
    monkeypatch.setattr(generator, "_download_video", forbidden)
    monkeypatch.setattr(module, "get_video_result_delivery", lambda: _ArchiveDelivery())
    monkeypatch.setattr(module, "_reserve_video_model_call", reserve)
    monkeypatch.setattr(module, "_confirm_video_model_call", confirm)
    monkeypatch.setattr(module, "_refund_video_model_call", refund)

    result = await generator.generate(
        image_path=None,
        prompt="test",
        output_path=str(tmp_path / "video.mp4"),
        poll_interval=0,
        max_polls=1,
    )

    assert result.status is VideoGenStatus.FAILED
    assert result.error == "VIDEO_ARCHIVE_FAILED"
    assert result.task_id == "task-1"
    assert calls == {"confirm": 1, "refund": 0}


@pytest.mark.asyncio
async def test_newapi_without_copy_port_keeps_legacy_url_delivery(
    monkeypatch, tmp_path: Path
) -> None:
    from novelvideo.generators import video_generator as module
    from novelvideo.generators.video_generator import (
        NewApiVideoGenerator,
        VideoGenStatus,
    )
    from novelvideo.ports.video_delivery import VideoDeliveryReceipt

    generator = NewApiVideoGenerator(
        api_key="test-key", endpoint="https://gateway.example/v1", model="video-model"
    )
    calls = {"submit": 0, "poll": 0, "download": 0, "confirm": 0, "refund": 0}
    submitted_payload: dict = {}

    async def submit(_url, payload, **_kwargs):
        calls["submit"] += 1
        submitted_payload.update(payload)
        return {"id": "task-legacy"}

    async def poll(*_args, **_kwargs):
        calls["poll"] += 1
        return {
            "status": "success",
            "task_id": "task-legacy",
            "url": "https://upstream.example/video.mp4",
        }

    async def download(url: str, output_path: str):
        calls["download"] += 1
        assert url == "https://upstream.example/video.mp4"
        payload = b"legacy-video"
        Path(output_path).write_bytes(payload)
        return VideoDeliveryReceipt(
            method="download",
            size=len(payload),
            sha256=hashlib.sha256(payload).hexdigest(),
        )

    async def reserve(*_args, **_kwargs):
        return "reservation-legacy"

    async def confirm(*_args, **_kwargs):
        calls["confirm"] += 1

    async def refund(*_args, **_kwargs):
        calls["refund"] += 1

    monkeypatch.setattr(generator, "_post_json", submit)
    monkeypatch.setattr(generator, "_get_json", poll)
    monkeypatch.setattr(generator, "_download_video", download)
    monkeypatch.setattr(module, "get_video_result_delivery", lambda: None)
    monkeypatch.setattr(module, "_reserve_video_model_call", reserve)
    monkeypatch.setattr(module, "_confirm_video_model_call", confirm)
    monkeypatch.setattr(module, "_refund_video_model_call", refund)

    output = tmp_path / "video.mp4"
    result = await generator.generate(
        image_path=None,
        prompt="test",
        output_path=str(output),
        poll_interval=0,
        max_polls=1,
    )

    assert result.status is VideoGenStatus.DONE
    assert output.read_bytes() == b"legacy-video"
    assert submitted_payload["response_format"] == "url"
    assert calls == {"submit": 1, "poll": 1, "download": 1, "confirm": 1, "refund": 0}


@pytest.mark.asyncio
async def test_newapi_copy_enabled_requires_archive(
    monkeypatch, tmp_path: Path
) -> None:
    from novelvideo.generators import video_generator as module
    from novelvideo.generators.video_generator import (
        NewApiVideoGenerator,
        VideoGenStatus,
    )

    generator = NewApiVideoGenerator(
        api_key="test-key", endpoint="https://gateway.example/v1", model="video-model"
    )
    calls = {"confirm": 0, "refund": 0}

    async def submit(*_args, **_kwargs):
        return {"id": "task-without-archive"}

    async def poll(*_args, **_kwargs):
        return {
            "status": "success",
            "task_id": "task-without-archive",
            "result_url": "https://upstream.example/video.mp4",
        }

    async def forbidden_download(*_args, **_kwargs):
        raise AssertionError("copy-enabled EE must not download without archive")

    async def reserve(*_args, **_kwargs):
        return "reservation-1"

    async def confirm(*_args, **_kwargs):
        calls["confirm"] += 1

    async def refund(*_args, **_kwargs):
        calls["refund"] += 1

    monkeypatch.setattr(generator, "_post_json", submit)
    monkeypatch.setattr(generator, "_get_json", poll)
    monkeypatch.setattr(generator, "_download_video", forbidden_download)
    monkeypatch.setattr(module, "get_video_result_delivery", lambda: _ArchiveDelivery())
    monkeypatch.setattr(module, "_reserve_video_model_call", reserve)
    monkeypatch.setattr(module, "_confirm_video_model_call", confirm)
    monkeypatch.setattr(module, "_refund_video_model_call", refund)

    result = await generator.generate(
        image_path=None,
        prompt="test",
        output_path=str(tmp_path / "video.mp4"),
        poll_interval=0,
        max_polls=1,
    )

    assert result.status is VideoGenStatus.FAILED
    assert result.error == "VIDEO_ARCHIVE_MISSING"
    assert calls == {"confirm": 1, "refund": 0}


@pytest.mark.asyncio
async def test_ce_ignores_advertised_archive_and_downloads_result_url(
    monkeypatch, tmp_path: Path
) -> None:
    from novelvideo.generators import video_generator as module
    from novelvideo.generators.video_generator import (
        NewApiVideoGenerator,
        VideoGenStatus,
    )
    from novelvideo.ports.video_delivery import VideoDeliveryReceipt

    generator = NewApiVideoGenerator(
        api_key="test-key", endpoint="https://gateway.example/v1", model="video-model"
    )
    calls = {"poll": 0, "download": 0}

    async def submit(*_args, **_kwargs):
        return {"id": "task-ce"}

    async def poll(*_args, **_kwargs):
        calls["poll"] += 1
        return {
            "status": "success",
            "task_id": "task-ce",
            "result_url": "https://gateway.example/result.mp4",
            "archive": _archive_payload("pending", retryable=True),
        }

    async def download(url: str, output_path: str):
        calls["download"] += 1
        assert url == "https://gateway.example/result.mp4"
        payload = b"ce-result-url"
        Path(output_path).write_bytes(payload)
        return VideoDeliveryReceipt(
            method="download",
            size=len(payload),
            sha256=hashlib.sha256(payload).hexdigest(),
        )

    async def reserve(*_args, **_kwargs):
        return "reservation-ce"

    async def confirm(*_args, **_kwargs):
        return None

    monkeypatch.setattr(generator, "_post_json", submit)
    monkeypatch.setattr(generator, "_get_json", poll)
    monkeypatch.setattr(generator, "_download_video", download)
    monkeypatch.setattr(module, "get_video_result_delivery", lambda: None)
    monkeypatch.setattr(module, "_reserve_video_model_call", reserve)
    monkeypatch.setattr(module, "_confirm_video_model_call", confirm)

    output = tmp_path / "video.mp4"
    result = await generator.generate(
        image_path=None,
        prompt="test",
        output_path=str(output),
        poll_interval=0,
        max_polls=1,
    )

    assert result.status is VideoGenStatus.DONE
    assert result.video_url == "https://gateway.example/result.mp4"
    assert output.read_bytes() == b"ce-result-url"
    assert calls == {"poll": 1, "download": 1}


@pytest.mark.asyncio
async def test_freezone_upscale_download_uses_the_submitting_gateway(monkeypatch, tmp_path):
    from novelvideo.generators import video_generator as module
    from novelvideo.ports.video_delivery import VideoDeliveryReceipt
    from novelvideo.utils import media_download
    proof_header = "X-Local-Video-Upscale-Key"
    monkeypatch.setenv("LOCAL_VIDEO_UPSCALE_ENABLED", "true")
    monkeypatch.setenv("LOCAL_VIDEO_UPSCALE_CLIENT_KEY", "a" * 64)
    monkeypatch.setenv("NEWAPI_BASE_URL", "https://gateway.example/v1")

    generator = module.NewApiVideoGenerator(
        api_key="test-key",
        endpoint="https://gateway.example/v1",
        model="video-upscale-fast",
        resolution="1080p",
    )
    reference = "https://relay.example/input.mp4"
    task_id = "task_upscale"
    downloaded = []
    progress = []
    task_states = iter([("QUEUED", "20%"), ("IN_PROGRESS", "30%"), ("SUCCESS", "100%")])

    async def submit(url, payload, *, headers):
        assert url == "https://gateway.example/v1/video/generations"
        assert headers[proof_header] == "a" * 64
        assert headers["Authorization"] == "Bearer test-key"
        assert payload["metadata"]["reference_videos"] == [reference]
        assert payload["metadata"]["resolution"] == "1080p"
        return {"task_id": task_id}

    async def poll(*args, **kwargs):
        assert proof_header not in (kwargs.get("headers") or {})
        status, percent = next(task_states)
        return {
            "data": {
                "status": status,
                "progress": percent,
                "task_id": task_id,
                "result_url": f"https://unexpected.example/v1/videos/{task_id}/content",
            }
        }

    async def download(url, output_path, *, headers):
        downloaded.append(url)
        assert headers["Authorization"] == "Bearer test-key"
        assert proof_header not in headers
        Path(output_path).write_bytes(b"upscale-result")
        return VideoDeliveryReceipt(method="download", size=14, sha256="fixture")

    async def billing(*args, **kwargs):
        return None

    monkeypatch.setattr(generator, "_post_json", submit)
    monkeypatch.setattr(generator, "_get_json", poll)
    monkeypatch.setattr(module, "get_video_result_delivery", lambda: None)
    monkeypatch.setattr(module, "_reserve_video_model_call", billing)
    monkeypatch.setattr(module, "_confirm_video_model_call", billing)
    monkeypatch.setattr(media_download, "download_to_path", download)

    output = tmp_path / "video.mp4"
    result = await generator.generate(
        image_path=None,
        prompt="",
        output_path=str(output),
        aspect_ratio="auto",
        duration=3,
        references=[module.ShotReference("video", reference, "源视频")],
        gen_mode="video_upscale",
        poll_interval=0,
        max_polls=3,
        on_progress=progress.append,
    )

    assert result.status is module.VideoGenStatus.DONE
    assert progress == [0.1, 0.2, 0.2, 0.3, 0.9, 1.0]
    assert downloaded == [f"https://gateway.example/v1/videos/{task_id}/content"]
    assert output.read_bytes() == b"upscale-result"


@pytest.mark.asyncio
async def test_local_upscale_credential_is_not_sent_to_a_different_gateway(monkeypatch, tmp_path):
    from novelvideo.generators import video_generator as module

    monkeypatch.setenv("LOCAL_VIDEO_UPSCALE_ENABLED", "true")
    monkeypatch.setenv("LOCAL_VIDEO_UPSCALE_CLIENT_KEY", "a" * 64)
    monkeypatch.setenv("NEWAPI_BASE_URL", "https://gateway.example/v1")
    generator = module.NewApiVideoGenerator(
        api_key="test-key", endpoint="https://other-gateway.example/v1", model="video-upscale-fast",
    )

    async def unexpected(*_args, **_kwargs):
        pytest.fail("a request was made before validating the credential destination")

    monkeypatch.setattr(generator, "_post_json", unexpected)
    monkeypatch.setattr(generator, "_apply_huimeng_protocol_media_inputs", unexpected)
    result = await generator.generate(
        image_path=None, prompt="", output_path=str(tmp_path / "result.mp4"), gen_mode="video_upscale",
    )
    assert result.status is module.VideoGenStatus.FAILED
    assert result.error == "LOCAL_VIDEO_UPSCALE_GATEWAY_MISMATCH"


@pytest.mark.asyncio
async def test_local_upscale_submit_disables_http_redirects(monkeypatch):
    from novelvideo.generators import video_generator as module

    generator = module.NewApiVideoGenerator(
        api_key="test-key", endpoint="https://gateway.example/v1", model="video-upscale-fast",
    )

    class Redirect(_Response):
        status = 307
        headers = {"Location": "https://other-gateway.example/v1/video/generations"}

        async def text(self):
            return "redirect"

    class Session(_Session):
        def post(self, url, *, json, headers, allow_redirects=True):
            assert allow_redirects is False
            return Redirect([])

    monkeypatch.setattr(module.aiohttp, "ClientSession", lambda **kwargs: Session([], **kwargs))
    with pytest.raises(module.NewApiVideoError, match="HTTP 307"):
        await generator._post_json(
            "https://gateway.example/v1/video/generations", {},
            headers={"X-Local-Video-Upscale-Key": "a" * 64},
        )


class _Content:
    def __init__(self, chunks: list[bytes]) -> None:
        self._chunks = chunks

    async def iter_chunked(self, _size: int):
        for chunk in self._chunks:
            yield chunk


class _Response:
    status = 200

    def __init__(self, chunks: list[bytes]) -> None:
        self.content = _Content(chunks)

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return None


class _Session:
    def __init__(self, chunks: list[bytes], **_kwargs) -> None:
        self._chunks = chunks

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return None

    def get(self, _url: str):
        return _Response(self._chunks)


@pytest.mark.asyncio
async def test_result_url_download_is_streamed_verified_and_atomic(
    monkeypatch, tmp_path: Path
) -> None:
    from novelvideo.utils import media_download

    chunks = [b"first-", b"second-", b"third"]
    payload = b"".join(chunks)
    monkeypatch.setattr(
        media_download.aiohttp,
        "ClientSession",
        lambda **kwargs: _Session(chunks, **kwargs),
    )
    output = tmp_path / "video.mp4"

    receipt = await media_download.download_to_path(
        "https://archive.example/video.mp4",
        str(output),
        expected_size=len(payload),
        expected_sha256=hashlib.sha256(payload).hexdigest(),
    )

    assert receipt.method == "download"
    assert receipt.size == len(payload)
    assert output.read_bytes() == payload
    assert [path for path in tmp_path.iterdir() if path.name.endswith(".part")] == []


@pytest.mark.asyncio
async def test_result_url_download_keeps_existing_file_on_integrity_failure(
    monkeypatch, tmp_path: Path
) -> None:
    from novelvideo.ports.video_delivery import VideoDeliveryError
    from novelvideo.utils import media_download

    monkeypatch.setattr(
        media_download.aiohttp,
        "ClientSession",
        lambda **kwargs: _Session([b"new"], **kwargs),
    )
    output = tmp_path / "video.mp4"
    output.write_bytes(b"old")

    with pytest.raises(VideoDeliveryError, match="VIDEO_ARCHIVE_SHA256_MISMATCH"):
        await media_download.download_to_path(
            "https://archive.example/video.mp4",
            str(output),
            expected_sha256=hashlib.sha256(b"different").hexdigest(),
        )

    assert output.read_bytes() == b"old"
    assert [path for path in tmp_path.iterdir() if path.name.endswith(".part")] == []


@pytest.mark.asyncio
async def test_result_url_download_rejects_malformed_data_url(
    tmp_path: Path,
) -> None:
    from novelvideo.ports.video_delivery import VideoDeliveryError
    from novelvideo.utils.media_download import download_to_path

    output = tmp_path / "video.mp4"
    with pytest.raises(VideoDeliveryError) as captured:
        await download_to_path("data:video/mp4,not-base64", str(output))

    assert captured.value.code == "VIDEO_DATA_URL_INVALID"
    assert captured.value.retryable is False
    assert not output.exists()
    assert [path for path in tmp_path.iterdir() if path.name.endswith(".part")] == []
