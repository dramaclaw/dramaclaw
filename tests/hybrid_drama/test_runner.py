from decimal import Decimal
import hashlib
import json
import threading
import time

import httpx
import pytest

from novelvideo.hybrid_drama.runner import (
    build_seedance_request,
    estimate_cost,
    load_state,
    poll_tasks,
    submit_task,
)


def test_pre_submit_estimate_uses_runbook_token_rates():
    assert estimate_cost(1_000_000, has_video_input=False) == Decimal("10.70")
    assert estimate_cost(1_000_000, has_video_input=True) == Decimal("6.40")
    assert estimate_cost(87_300, has_video_input=False) == Decimal("0.934110")


def test_seedance_request_is_direct_720p_with_opaque_reference_urls():
    request = build_seedance_request(
        {"prompt": "Scene\n@Image1 is Mia", "reference_ids": ["mia"]},
        {"mia": "https://signed.example/opaque?signature=secret"},
    )

    assert request == {
        "model": "dreamina-seedance-2-5-260628",
        "content": [
            {"type": "text", "text": "Scene\n@Image1 is Mia"},
            {
                "type": "image_url",
                "image_url": {"url": "https://signed.example/opaque?signature=secret"},
                "role": "reference_image",
            },
        ],
        "generate_audio": True,
        "ratio": "9:16",
        "resolution": "720p",
        "duration": 4,
        "watermark": False,
    }


def test_submit_uploads_exact_reference_bytes_and_persists_lineage(tmp_path):
    raw = b"\x89PNG\r\noriginal\x00bytes-not-a-reencode"
    reference = tmp_path / "mia.png"
    reference.write_bytes(raw)
    uploads = []

    class Relay:
        def upload_bytes(self, data, **kwargs):
            uploads.append((data, kwargs))
            return "https://opaque.example/signed-reference"

    def handler(request):
        assert request.url.path == "/api/v3/contents/generations/tasks"
        payload = json.loads(request.content)
        assert payload["content"][1]["image_url"]["url"] == (
            "https://opaque.example/signed-reference"
        )
        return httpx.Response(200, json={"id": "cgt-123"})

    prepared = {
        "beat_key": "p:e:1",
        "beat_number": 1,
        "project": {"id": "p"},
        "episode": {"id": "e"},
        "beat": {"beat_number": 1},
        "prompt": "Scene",
        "reference_ids": ["mia"],
        "has_dialogue": False,
    }
    result = submit_task(
        tmp_path / "run",
        prepared,
        {"mia": reference},
        max_cost_usd=Decimal("1"),
        api_key="test-key",
        relay=Relay(),
        http_client=httpx.Client(transport=httpx.MockTransport(handler)),
    )

    assert result["task_id"] == "cgt-123"
    assert uploads == [
        (
            raw,
            {"ext": "png", "resource_type": "image", "object_key": None},
        )
    ]
    digest = hashlib.sha256(raw).hexdigest()
    stored_reference = tmp_path / "run" / "references" / f"{digest}.png"
    assert stored_reference.read_bytes() == raw
    state = load_state(tmp_path / "run")
    task = state["tasks"][0]
    assert task["status"] == "submitted"
    assert task["task_id"] == "cgt-123"
    assert task["estimated_cost_usd"] == "0.934110"
    assert task["references"][0]["sha256"] == digest
    request_record = json.loads(
        (tmp_path / "run" / task["request_path"]).read_text()
    )
    assert request_record["references"][0]["sha256"] == digest
    assert request_record["request"]["resolution"] == "720p"
    assert (tmp_path / "run" / task["receipt_path"]).is_file()


def test_submit_rejects_estimate_above_required_run_budget(tmp_path):
    class NoUpload:
        def upload_bytes(self, data, **kwargs):
            raise AssertionError("budget rejection must precede upload")

    prepared = {
        "beat_key": "p:e:1",
        "beat_number": 1,
        "project": {"id": "p"},
        "episode": {"id": "e"},
        "beat": {"beat_number": 1},
        "prompt": "Scene",
        "reference_ids": ["mia"],
        "has_dialogue": False,
    }
    reference = tmp_path / "mia.png"
    reference.write_bytes(b"raw")

    with pytest.raises(ValueError, match="max_cost_usd"):
        submit_task(
            tmp_path / "run",
            prepared,
            {"mia": reference},
            max_cost_usd=Decimal("0.90"),
            api_key="test-key",
            relay=NoUpload(),
            http_client=httpx.Client(transport=httpx.MockTransport(lambda request: None)),
        )


def test_duplicate_submission_is_blocked_without_another_provider_call(tmp_path):
    calls = 0

    class Relay:
        def upload_bytes(self, data, **kwargs):
            return "https://opaque.example/reference"

    def handler(request):
        nonlocal calls
        calls += 1
        return httpx.Response(200, json={"id": "cgt-123"})

    prepared = {
        "beat_key": "p:e:1",
        "beat_number": 1,
        "project": {"id": "p"},
        "episode": {"id": "e"},
        "beat": {"beat_number": 1},
        "prompt": "Scene",
        "reference_ids": [],
        "has_dialogue": False,
    }
    client = httpx.Client(transport=httpx.MockTransport(handler))
    submit_task(
        tmp_path,
        prepared,
        {},
        max_cost_usd=Decimal("10"),
        api_key="test-key",
        relay=Relay(),
        http_client=client,
    )

    with pytest.raises(ValueError, match="duplicate"):
        submit_task(
            tmp_path,
            prepared,
            {},
            max_cost_usd=Decimal("10"),
            api_key="test-key",
            relay=Relay(),
            http_client=client,
        )
    assert calls == 1


def test_lost_submission_response_is_unknown_and_cannot_be_retried(tmp_path):
    calls = 0

    class Relay:
        def upload_bytes(self, data, **kwargs):
            return "https://opaque.example/reference"

    def handler(request):
        nonlocal calls
        calls += 1
        raise httpx.ConnectError("response lost", request=request)

    prepared = {
        "beat_key": "p:e:1",
        "beat_number": 1,
        "project": {"id": "p"},
        "episode": {"id": "e"},
        "beat": {"beat_number": 1},
        "prompt": "Scene",
        "reference_ids": [],
        "has_dialogue": False,
    }
    client = httpx.Client(transport=httpx.MockTransport(handler))
    with pytest.raises(httpx.ConnectError):
        submit_task(
            tmp_path,
            prepared,
            {},
            max_cost_usd=Decimal("10"),
            api_key="test-key",
            relay=Relay(),
            http_client=client,
        )

    assert load_state(tmp_path)["tasks"][0]["status"] == "unknown"
    with pytest.raises(ValueError, match="duplicate"):
        submit_task(
            tmp_path,
            prepared,
            {},
            max_cost_usd=Decimal("10"),
            api_key="test-key",
            relay=Relay(),
            http_client=client,
        )
    assert calls == 1


def test_only_known_failures_can_be_manually_retried_within_attempt_cap(tmp_path):
    calls = 0

    class Relay:
        def upload_bytes(self, data, **kwargs):
            return "https://opaque.example/reference"

    def handler(request):
        nonlocal calls
        calls += 1
        if calls == 1:
            return httpx.Response(400, json={"error": "moderation"})
        return httpx.Response(200, json={"id": "cgt-retry"})

    prepared = {
        "beat_key": "p:e:1",
        "beat_number": 1,
        "project": {"id": "p"},
        "episode": {"id": "e"},
        "beat": {"beat_number": 1},
        "prompt": "Scene",
        "reference_ids": [],
        "has_dialogue": False,
    }
    client = httpx.Client(transport=httpx.MockTransport(handler))
    with pytest.raises(httpx.HTTPStatusError):
        submit_task(
            tmp_path,
            prepared,
            {},
            max_cost_usd=Decimal("10"),
            api_key="test-key",
            relay=Relay(),
            http_client=client,
        )
    assert load_state(tmp_path)["tasks"][0]["status"] == "failed"
    assert calls == 1

    with pytest.raises(ValueError, match="max_attempts"):
        submit_task(
            tmp_path,
            prepared,
            {},
            max_cost_usd=Decimal("10"),
            max_attempts=1,
            manual_retry=True,
            api_key="test-key",
            relay=Relay(),
            http_client=client,
        )
    result = submit_task(
        tmp_path,
        prepared,
        {},
        max_cost_usd=Decimal("10"),
        max_attempts=2,
        manual_retry=True,
        api_key="test-key",
        relay=Relay(),
        http_client=client,
    )
    assert result["task_id"] == "cgt-retry"
    assert calls == 2


def test_poll_persists_receipt_downloads_candidate_and_records_actual_usage(tmp_path):
    media = b"downloaded-mp4-exact-bytes"

    class Relay:
        def upload_bytes(self, data, **kwargs):
            return "https://opaque.example/reference"

    def handler(request):
        if request.method == "POST":
            return httpx.Response(200, json={"id": "cgt-123"})
        if request.url.host == "ark.ap-southeast.bytepluses.com":
            assert request.url.path == "/api/v3/contents/generations/tasks/cgt-123"
            return httpx.Response(
                200,
                json={
                    "id": "cgt-123",
                    "status": "succeeded",
                    "content": {"video_url": "https://video.example/candidate.mp4"},
                    "usage": {"total_tokens": 87001},
                },
            )
        assert request.url.host == "video.example"
        return httpx.Response(200, content=media)

    prepared = {
        "beat_key": "p:e:1",
        "beat_number": 1,
        "project": {"id": "p"},
        "episode": {"id": "e"},
        "beat": {"beat_number": 1},
        "prompt": "Scene",
        "reference_ids": [],
        "has_dialogue": False,
    }
    client = httpx.Client(transport=httpx.MockTransport(handler))
    submit_task(
        tmp_path,
        prepared,
        {},
        max_cost_usd=Decimal("10"),
        api_key="test-key",
        relay=Relay(),
        http_client=client,
    )
    probe = {
        "streams": [
            {"codec_type": "video", "width": 720, "height": 1280},
            {"codec_type": "audio", "channels": 2, "sample_rate": "48000"},
        ]
    }

    results = poll_tasks(
        tmp_path,
        api_key="test-key",
        http_client=client,
        media_inspector=lambda path: probe,
    )

    task = results[0]
    assert task["status"] == "succeeded"
    assert task["usage"]["total_tokens"] == 87001
    digest = hashlib.sha256(media).hexdigest()
    candidate = tmp_path / task["candidate"]["path"]
    assert candidate.read_bytes() == media
    assert task["candidate"]["sha256"] == digest
    assert task["candidate"]["request_sha256"] == task["request_sha256"]
    assert task["poll_receipts"]
    assert (tmp_path / task["poll_receipts"][0]["path"]).is_file()


def test_poll_continues_provider_queued_tasks(tmp_path):
    (tmp_path / "state.json").write_text(
        json.dumps(
            {
                "version": 1,
                "tasks": [
                    {
                        "beat_key": "p:e:1",
                        "status": "queued",
                        "task_id": "cgt-queued",
                        "request_sha256": "request-hash",
                        "references": [],
                        "poll_receipts": [],
                    }
                ],
                "reviews": [],
            }
        )
    )
    calls = 0

    def handler(request):
        nonlocal calls
        calls += 1
        return httpx.Response(200, json={"id": "cgt-queued", "status": "running"})

    results = poll_tasks(
        tmp_path,
        api_key="test-key",
        http_client=httpx.Client(transport=httpx.MockTransport(handler)),
    )

    assert calls == 1
    assert results[0]["status"] == "running"


def test_success_response_without_task_id_is_persisted_as_unknown(tmp_path):
    class Relay:
        def upload_bytes(self, data, **kwargs):
            return "https://opaque.example/reference"

    prepared = {
        "beat_key": "p:e:1",
        "beat_number": 1,
        "project": {"id": "p"},
        "episode": {"id": "e"},
        "beat": {"beat_number": 1},
        "prompt": "Scene",
        "reference_ids": [],
        "has_dialogue": False,
    }
    client = httpx.Client(
        transport=httpx.MockTransport(
            lambda request: httpx.Response(200, json={"status": "accepted"})
        )
    )

    with pytest.raises(ValueError, match="task ID"):
        submit_task(
            tmp_path,
            prepared,
            {},
            max_cost_usd=Decimal("10"),
            api_key="test-key",
            relay=Relay(),
            http_client=client,
        )

    task = load_state(tmp_path)["tasks"][0]
    assert task["status"] == "unknown"
    assert task["task_id"] is None
    assert (tmp_path / task["receipt_path"]).is_file()


def test_concurrent_duplicate_submits_are_serialized(tmp_path):
    reference = tmp_path / "ref.png"
    reference.write_bytes(b"raw-reference")
    upload_count = 0
    first_upload = threading.Event()
    provider_calls = 0

    class Relay:
        def upload_bytes(self, data, **kwargs):
            nonlocal upload_count
            upload_count += 1
            current = upload_count
            if current == 1:
                first_upload.set()
                time.sleep(0.3)
            return f"https://opaque.example/ref-{current}"

    def handler(request):
        nonlocal provider_calls
        provider_calls += 1
        return httpx.Response(200, json={"id": f"cgt-{provider_calls}"})

    prepared = {
        "beat_key": "p:e:1",
        "beat_number": 1,
        "project": {"id": "p"},
        "episode": {"id": "e"},
        "beat": {"beat_number": 1},
        "prompt": "Scene",
        "reference_ids": ["mia"],
        "has_dialogue": False,
    }
    client = httpx.Client(transport=httpx.MockTransport(handler))
    errors = []

    def submit():
        try:
            submit_task(
                tmp_path / "run",
                prepared,
                {"mia": reference},
                max_cost_usd=Decimal("10"),
                api_key="test-key",
                relay=Relay(),
                http_client=client,
            )
        except ValueError as exc:
            errors.append(str(exc))

    first = threading.Thread(target=submit)
    first.start()
    assert first_upload.wait(1)
    second = threading.Thread(target=submit)
    second.start()
    first.join(2)
    second.join(2)

    assert provider_calls == 1
    assert len(errors) == 1 and "duplicate" in errors[0]
    assert len(load_state(tmp_path / "run")["tasks"]) == 1
