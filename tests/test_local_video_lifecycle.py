"""Local-GPU lifecycle boundaries; all HTTP calls remain in-process doubles."""

import asyncio
from pathlib import Path
from types import SimpleNamespace

import aiohttp
import pytest

from novelvideo.generators import video_generator as module
from novelvideo.ports.video_delivery import VideoDeliveryError, VideoDeliveryReceipt


@pytest.fixture
def local(monkeypatch, tmp_path):
    monkeypatch.setenv("LOCAL_VIDEO_UPSCALE_ENABLED", "true")
    monkeypatch.setenv("LOCAL_VIDEO_UPSCALE_CLIENT_KEY", "a" * 64)
    monkeypatch.setenv("NEWAPI_BASE_URL", "https://gateway.example/v1")
    generator = module.NewApiVideoGenerator(
        api_key="ordinary-key",
        endpoint="https://gateway.example/v1",
        model="video-upscale-fast",
        resolution="1080p",
    )
    posts, downloads, refunds = [], [], []
    clock = SimpleNamespace(now=0)
    monkeypatch.setattr(module, "time", SimpleNamespace(monotonic=lambda: clock.now))

    async def post(url, payload, *, headers):
        assert headers["Authorization"] == "Bearer ordinary-key"
        if generator.model == "video-upscale-fast":
            assert headers["X-Local-Video-Upscale-Key"] == "a" * 64
        else:
            assert "X-Local-Video-Upscale-Key" not in headers
        posts.append(url)
        return (
            {"state": "cancelled"}
            if url.endswith("/cancel")
            else {"task_id": "task_lifecycle"}
        )

    async def download(url, output_path, *, headers, timeout_seconds):
        assert "X-Local-Video-Upscale-Key" not in headers
        downloads.append(timeout_seconds)
        Path(output_path).write_bytes(b"result")
        return VideoDeliveryReceipt(method="download", size=6, sha256="fixture")

    async def noop(*args, **kwargs):
        return None

    async def refund(*args, **kwargs):
        refunds.append(kwargs)

    monkeypatch.setattr(generator, "_post_json", post)
    monkeypatch.setattr(module, "get_video_result_delivery", lambda: None)
    monkeypatch.setattr(module, "_reserve_video_model_call", noop)
    monkeypatch.setattr(module, "_confirm_video_model_call", noop)
    monkeypatch.setattr(module, "_refund_video_model_call", refund)
    from novelvideo.utils import media_download

    monkeypatch.setattr(media_download, "download_to_path", download)
    return SimpleNamespace(
        generator=generator,
        posts=posts,
        downloads=downloads,
        refunds=refunds,
        clock=clock,
        output=tmp_path / "output.mp4",
        download=download,
    )


def options(local):
    return dict(
        image_path=None,
        prompt="",
        output_path=str(local.output),
        references=[
            module.ShotReference("video", "https://relay.example/source.mp4", "source")
        ],
        gen_mode="video_upscale",
        poll_interval=0,
        max_polls=12,
    )


def completed():
    return {
        "data": {
            "status": "SUCCESS",
            "progress": "100%",
            "result_url": "https://gateway.example/v1/videos/task_lifecycle/content",
        }
    }


@pytest.mark.asyncio
@pytest.mark.parametrize("fault", [503, 429, "network"])
async def test_poll_retries_without_resubmission_or_progress_regression(
    local, monkeypatch, fault
):
    polls = 0
    progress = []

    async def poll(*args, **kwargs):
        nonlocal polls
        polls += 1
        if polls == 2:
            if fault == "network":
                raise aiohttp.ClientConnectionError("network unavailable")
            raise module.NewApiVideoError("transient", status_code=fault)
        if polls == 4:
            return completed()
        return {
            "data": {
                "status": "IN_PROGRESS",
                "progress": "50%" if polls == 1 else "30%",
            }
        }

    monkeypatch.setattr(local.generator, "_get_json", poll)
    result = await local.generator.generate(
        **options(local), on_progress=progress.append
    )
    assert result.status is module.VideoGenStatus.DONE
    assert len(local.posts) == 1
    assert not local.refunds
    assert progress == sorted(progress)
    assert local.downloads == [900]


@pytest.mark.asyncio
async def test_cancellation_waits_for_compute_process_release(local, monkeypatch):
    accepted = asyncio.Event()

    async def poll(*args, **kwargs):
        accepted.set()
        await asyncio.Future()

    original = local.generator._post_json
    states = iter(["cancelling", "cancelled"])

    async def post(url, payload, *, headers):
        response = await original(url, payload, headers=headers)
        if url.endswith("/cancel"):
            response = {"state": next(states)}
        return response

    monkeypatch.setattr(local.generator, "_get_json", poll)
    monkeypatch.setattr(local.generator, "_post_json", post)
    task = asyncio.create_task(local.generator.generate(**options(local)))
    await asyncio.wait_for(accepted.wait(), 3)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert local.posts == [
        "https://gateway.example/v1/video/generations",
        "https://gateway.example/v1/videos/task_lifecycle/cancel",
        "https://gateway.example/v1/videos/task_lifecycle/cancel",
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize("status,expected_polls", [(403, 1), (503, 6)])
async def test_poll_failure_is_bounded_and_cancels_before_return(
    local, monkeypatch, status, expected_polls
):
    polls = 0

    async def poll(*args, **kwargs):
        nonlocal polls
        polls += 1
        raise module.NewApiVideoError("unavailable", status_code=status)

    async def no_sleep(*args):
        return None

    monkeypatch.setattr(local.generator, "_get_json", poll)
    monkeypatch.setattr(module.asyncio, "sleep", no_sleep)
    result = await local.generator.generate(**options(local))
    assert result.status is module.VideoGenStatus.FAILED
    assert polls == expected_polls
    assert local.posts[-1].endswith("/videos/task_lifecycle/cancel")
    assert len(local.posts) == 2
    assert len(local.refunds) == 1


@pytest.mark.asyncio
async def test_compute_deadline_includes_queue_wait_and_cancels(local, monkeypatch):
    polls = 0

    async def poll(*args, **kwargs):
        nonlocal polls
        polls += 1
        local.clock.now = 3661
        return {"data": {"status": "QUEUED", "progress": "0%"}}

    monkeypatch.setattr(local.generator, "_get_json", poll)
    result = await local.generator.generate(**options(local))
    assert result.status is module.VideoGenStatus.FAILED
    assert polls == 1
    assert local.posts[-1].endswith("/cancel")


@pytest.mark.asyncio
async def test_download_retry_uses_remaining_shared_budget(local, monkeypatch):
    from novelvideo.utils import media_download

    async def poll(*args, **kwargs):
        return completed()

    budgets = []

    async def download(url, output_path, *, headers, timeout_seconds):
        budgets.append(timeout_seconds)
        if len(budgets) == 1:
            local.clock.now += 700
            raise VideoDeliveryError("VIDEO_DOWNLOAD_FAILED", retryable=True)
        return await local.download(
            url, output_path, headers=headers, timeout_seconds=timeout_seconds
        )

    monkeypatch.setattr(local.generator, "_get_json", poll)
    monkeypatch.setattr(media_download, "download_to_path", download)
    result = await local.generator.generate(**options(local))
    assert result.status is module.VideoGenStatus.DONE
    assert budgets == [900, 200]
    assert len(local.posts) == 1
    assert not local.refunds


@pytest.mark.asyncio
async def test_download_cancellation_removes_partial_and_preserves_original(
    monkeypatch, tmp_path
):
    from novelvideo.utils import media_download

    original = tmp_path / "output.mp4"
    original.write_bytes(b"original")
    budgets = []

    class Content:
        async def iter_chunked(self, size):
            yield b"partial"
            raise asyncio.CancelledError()

    class Response:
        status = 200
        content = Content()

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return None

    class Session(Response):
        def __init__(self, *, timeout):
            budgets.append(timeout.total)

        def get(self, *args, **kwargs):
            return Response()

    monkeypatch.setattr(media_download.aiohttp, "ClientSession", Session)
    with pytest.raises(asyncio.CancelledError):
        await media_download.download_to_path(
            "https://gateway.example/video", str(original), timeout_seconds=900
        )
    assert budgets == [900]
    assert original.read_bytes() == b"original"
    assert list(tmp_path.iterdir()) == [original]


@pytest.mark.asyncio
async def test_queued_progress_refreshes_same_task_without_regression(
    monkeypatch, tmp_path
):
    from novelvideo.task_backend.runners import freezone as runner
    from novelvideo.api import deps

    monkeypatch.setenv("LOCAL_VIDEO_UPSCALE_ENABLED", "true")
    clock = SimpleNamespace(now=0)
    updates = []
    monkeypatch.setattr(runner, "time", SimpleNamespace(monotonic=lambda: clock.now))
    monkeypatch.setattr(
        runner,
        "get_task_manager",
        lambda: SimpleNamespace(
            update_progress_for_project=lambda *a, **kw: updates.append(kw)
        ),
    )
    monkeypatch.setattr(
        deps, "make_static_url_for_context", lambda *args: "/static/output.mp4"
    )

    async def leaf(*args, **kwargs):
        kwargs["on_progress"](0.27)
        clock.now = 31
        kwargs["on_progress"](0.27)
        clock.now = 62
        kwargs["on_progress"](0.10)
        path = tmp_path / "result.mp4"
        path.write_bytes(b"result")
        return path, {}

    monkeypatch.setattr(runner, "_call_freezone_leaf", leaf)
    result = await runner._run_freezone_video_upscale_async(
        {
            "payload": {
                "job_id": "owned",
                "source_path": "unused",
                "upscale_backend": "video-upscale-fast",
            }
        },
        SimpleNamespace(output_dir=tmp_path),
    )
    assert result["job_id"] == "owned"
    assert [u["progress"] for u in updates] == [0.1, 0.27, 0.27, 0.27]
    assert all(u["scope"] == "owned" for u in updates)
    assert updates[0]["metadata"] == {"video_cancel_protocol": "gateway-v1"}


@pytest.mark.asyncio
async def test_unconfirmed_cancellation_is_bounded_and_does_not_log_credentials(
    local, monkeypatch, caplog
):
    async def blocked(*args, **kwargs):
        await asyncio.Future()

    monkeypatch.setattr(local.generator, "_post_json", blocked)
    monkeypatch.setattr(module, "LOCAL_VIDEO_UPSCALE_CANCEL_TIMEOUT_SECONDS", 0.01)
    await asyncio.wait_for(
        local.generator._cancel_local_video(
            "https://gateway.example/v1",
            "task_lifecycle",
            {"Authorization": "Bearer ordinary-key"},
        ),
        timeout=1,
    )
    assert "local_video_cancel_unconfirmed" in caplog.text
    assert "ordinary-key" not in caplog.text
    assert "a" * 64 not in caplog.text


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "model", ["local-video-upscale", "local-video-frame-rate", "custom-3060-alias"]
)
async def test_third_group_model_and_alias_keep_dedicated_headers_and_idempotency(
    local, monkeypatch, model
):
    local.generator.model = model
    original = local.generator._post_json

    async def post(url, payload, *, headers):
        assert headers["Idempotency-Key"] == "frozen-job-id"
        assert payload["model"] == model
        assert payload["metadata"]["source_sha256"] == "b" * 64
        return await original(url, payload, headers=headers)

    async def poll(*args, **kwargs):
        return completed()

    monkeypatch.setattr(local.generator, "_post_json", post)
    monkeypatch.setattr(local.generator, "_get_json", poll)
    result = await local.generator.generate(
        **options(local),

        idempotency_key="frozen-job-id",
        processing_metadata={"source_sha256": "b" * 64},
    )
    assert result.status is module.VideoGenStatus.DONE
    assert len(local.posts) == 1


@pytest.mark.asyncio
async def test_unknown_submit_retries_original_identity_without_deployment_key(
    local, monkeypatch
):
    local.generator.model = "local-video-upscale"
    monkeypatch.delenv("LOCAL_VIDEO_UPSCALE_CLIENT_KEY", raising=False)
    calls = []

    async def no_sleep(*args):
        pass

    async def post(url, payload, *, headers):
        calls.append((payload, dict(headers)))
        if len(calls) == 1:
            raise aiohttp.ClientConnectionError("accepted response lost")
        return {"id": "task_lifecycle"}

    async def poll(*args, **kwargs):
        return completed()

    monkeypatch.setattr(local.generator, "_post_json", post)
    monkeypatch.setattr(local.generator, "_get_json", poll)
    monkeypatch.setattr(module.asyncio, "sleep", no_sleep)
    result = await local.generator.generate(
        **options(local), idempotency_key="same-stage"
    )
    assert result.status is module.VideoGenStatus.DONE
    assert len(calls) == 2
    assert all(
        h["Idempotency-Key"] == "same-stage" and "X-Local-Video-Upscale-Key" not in h
        for _, h in calls
    )
    assert not local.refunds


@pytest.mark.asyncio
async def test_unknown_submit_remains_traceable_without_refund_or_new_identity(
    local, monkeypatch
):
    from novelvideo.freezone.local_video_upscale import LocalVideoSubmissionPending

    local.generator.model = "local-video-upscale"
    calls = []

    async def no_sleep(*args):
        pass

    async def post(url, payload, *, headers):
        calls.append(headers["Idempotency-Key"])
        raise aiohttp.ClientConnectionError("acceptance unknown")

    monkeypatch.setattr(local.generator, "_post_json", post)
    monkeypatch.setattr(module.asyncio, "sleep", no_sleep)
    with pytest.raises(LocalVideoSubmissionPending) as pending:
        await local.generator.generate(
            **options(local), idempotency_key="original-stage"
        )
    assert pending.value.request_id == "original-stage"
    assert calls == ["original-stage"] * 12
    assert not local.refunds


@pytest.mark.asyncio
async def test_cancel_unknown_submission_fences_original_request(local, monkeypatch):
    local.generator.model = "local-video-upscale"
    accepted = asyncio.Event()
    calls = []

    async def post(url, payload, *, headers):
        calls.append((url, payload, headers))
        if url.endswith("/submissions/cancel"):
            return {"state": "cancelled"}
        accepted.set()
        await asyncio.Future()

    monkeypatch.setattr(local.generator, "_post_json", post)
    task = asyncio.create_task(
        local.generator.generate(**options(local), idempotency_key="cancel-stage")
    )
    await asyncio.wait_for(accepted.wait(), 3)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert calls[-1][0].endswith("/video/submissions/cancel")
    assert calls[-1][1] == {
        "model": "local-video-upscale",
        "request_id": "cancel-stage",
    }
    assert "X-Local-Video-Upscale-Key" not in calls[-1][2]
