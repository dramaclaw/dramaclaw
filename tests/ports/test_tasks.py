import asyncio
import base64
from datetime import datetime, timezone
import json
import time
from pathlib import Path

import pytest

from novelvideo.project_context import ProjectContext
from novelvideo.ports import registry
from novelvideo.ports.authz import AdmissionContext, BillingPrincipal
from novelvideo.ports.local.tasks import InlineTaskBackend, InMemoryCancellationStore
from novelvideo.ports.model_credentials import CredentialReference
from novelvideo.task_backend import cancel as cancel_module
from novelvideo.task_backend.consumer import TaskEnvelopeConsumer, VerifiedTaskDelivery
from novelvideo.task_backend.envelope import (
    InvalidTaskEnvelope,
    SignedTaskEnvelope,
)
from novelvideo.task_backend.registry import register_project_task_runner
from novelvideo.task_state import get_task_manager

SIGNING_KEY = b"t" * 32
NOW = datetime(2026, 8, 3, 4, 5, 7, tzinfo=timezone.utc)


def _admission(*, user_id: str, root_task_id: str, key_version: int = 1):
    return AdmissionContext(
        requester_user_id=user_id,
        billing_principal=BillingPrincipal(kind="local", id=user_id),
        credential=CredentialReference(
            source="local",
            credential_id="local-newapi",
            key_version=key_version,
        ),
        admission_id="admission-1",
        root_task_id=root_task_id,
        admitted_at="2026-08-03T04:05:00Z",
        authz_version=1,
    )


class FakeProducer:
    def __init__(self, *, failure=None):
        self.calls = []
        self.failure = failure

    async def sign_top_level(self, **kwargs):
        self.calls.append(kwargs)
        await asyncio.sleep(0)
        if self.failure is not None:
            raise self.failure
        admission = _admission(
            user_id=kwargs["user_id"],
            root_task_id=kwargs["root_task_id"],
        )
        return SignedTaskEnvelope.sign(
            admission=admission,
            envelope_id=f"envelope-{len(self.calls)}",
            task_type=kwargs["task_type"],
            project_id=kwargs["project_id"],
            payload=kwargs["payload"],
            issued_at="2026-08-03T04:05:06Z",
            expires_at="2026-08-04T04:05:06Z",
            signing_key_id="test-v1",
            signing_key=SIGNING_KEY,
        )


class FakeAuthz:
    def __init__(self, *, key_version: int = 1):
        self.key_version = key_version
        self.calls = []

    async def admit_model_task(self, *, user_id, root_task_id):
        self.calls.append({"user_id": user_id, "root_task_id": root_task_id})
        return _admission(
            user_id=user_id,
            root_task_id=root_task_id,
            key_version=self.key_version,
        )


def _inline_backend(*, producer=None, authz=None):
    authority = authz or FakeAuthz()
    consumer = TaskEnvelopeConsumer(
        keyring={"test-v1": SIGNING_KEY},
        authz=authority,
        clock=lambda: NOW,
    )
    return InlineTaskBackend(
        producer=producer or FakeProducer(),
        consumer=consumer,
    )


def _ctx(tmp_path: Path) -> ProjectContext:
    return ProjectContext(
        project_id="proj_t6",
        project_name="demo",
        owner_type="user",
        owner_id="owner_1",
        owner_username="alice",
        requester_user_id="editor_1",
        requester_username="bob",
        requester_principals=(("user", "editor_1"),),
        effective_role="editor",
        home_node_id="node_a",
        output_dir=tmp_path / "output" / "alice" / "demo",
        state_dir=tmp_path / "state" / "alice" / "demo",
        runtime_dir=tmp_path / "runtime" / "alice" / "demo",
        is_home_node=True,
    )


@pytest.fixture(autouse=True)
def _restore_task_ports(monkeypatch):
    monkeypatch.setattr(registry, "_PORTS", dict(registry._PORTS))
    monkeypatch.setattr(registry, "_BOOTSTRAPPED", registry._BOOTSTRAPPED)
    registry.register_port("cancellation_store", InMemoryCancellationStore())


async def _wait_for_status(
    ctx: ProjectContext, task_type: str, expected: str
) -> object:
    manager = get_task_manager()
    deadline = time.monotonic() + 6
    while time.monotonic() < deadline:
        task = manager.get_task_for_project(ctx, task_type, 1)
        if task is not None and task.status == expected:
            return task
        await asyncio.sleep(0.02)
    task = manager.get_task_for_project(ctx, task_type, 1)
    raise AssertionError(f"timed out waiting for {expected}, got {task}")


@pytest.mark.asyncio
async def test_inline_consumer_precedes_run_core_and_runner(monkeypatch, tmp_path):
    ctx = _ctx(tmp_path)
    events: list[str] = []
    submitted = []

    class FakeConsumer:
        async def consume(self, raw_delivery, *, expected_root_task_id):
            events.append("consumer")
            signed = SignedTaskEnvelope.from_dict(raw_delivery["task_envelope_v2"])
            payload = signed.to_dict()["payload"]
            assert expected_root_task_id == signed.admission.root_task_id
            return VerifiedTaskDelivery(
                envelope_id=signed.envelope_id,
                admission=signed.admission,
                task_type=signed.task_type,
                project_id=signed.project_id,
                requester_user_id=signed.admission.requester_user_id,
                episode=payload["episode"],
                beat_num=payload["beat_num"],
                scope=payload["scope"],
                queue_kind=payload["queue_kind"],
                payload=payload["payload"],
            )

    consumer = FakeConsumer()
    backend = InlineTaskBackend(producer=FakeProducer(), consumer=consumer)
    monkeypatch.setattr(backend, "_submit_lane_job", submitted.append)

    await backend.enqueue_project_task(ctx, task_type="single_video", episode=1)
    job = submitted[0]

    def fake_run_core(verified, *_args, **_kwargs):
        events.append("run_core")
        assert verified.__class__ is VerifiedTaskDelivery
        events.append("runner")
        return {"ok": True}

    monkeypatch.setattr(
        "novelvideo.ports.local.tasks.run_project_task_core_sync",
        fake_run_core,
    )

    await backend._run_inline(backend._lanes["default"], job)

    assert events == ["consumer", "run_core", "runner"]


@pytest.mark.asyncio
async def test_inline_task_backend_returns_immediately_and_completes_in_background(
    tmp_path,
):
    ctx = _ctx(tmp_path)
    task_type = "t6_inline_success"
    producer = FakeProducer()
    delivered = []

    def runner(envelope, run_ctx):
        delivered.append(envelope)
        assert envelope["__run_task_id"]
        assert run_ctx.project_id == ctx.project_id
        return {"ok": True, "task_type": envelope["task_type"]}

    register_project_task_runner(task_type, runner)

    queued = await _inline_backend(producer=producer).enqueue_project_task(
        ctx,
        task_type=task_type,
        episode=1,
    )

    assert queued.backend == "inline"
    assert queued.queue is None
    assert queued.celery_id is None
    assert queued.task_state.status in {"submitting", "queued"}

    completed = await _wait_for_status(ctx, task_type, "completed")
    assert completed.result["ok"] is True
    assert producer.calls[0]["root_task_id"] == queued.task_state.task_id
    assert "task_envelope_v2" not in delivered[0]
    assert delivered[0]["project_id"] == "proj_t6"
    assert delivered[0]["requester_user_id"] == "editor_1"
    assert delivered[0]["episode"] == 1
    assert delivered[0]["payload"] == {}


@pytest.mark.asyncio
async def test_inline_task_backend_runs_runner_outside_active_event_loop(tmp_path):
    ctx = _ctx(tmp_path)
    task_type = "t6_inline_asyncio_run_guard"

    async def probe():
        await asyncio.sleep(0)
        return "ok"

    def runner(envelope, run_ctx):
        return {"result": asyncio.run(probe())}

    register_project_task_runner(task_type, runner)

    queued = await _inline_backend().enqueue_project_task(
        ctx, task_type=task_type, episode=1
    )

    assert queued.backend == "inline"
    completed = await _wait_for_status(ctx, task_type, "completed")
    assert completed.result["result"] == "ok"


@pytest.mark.asyncio
async def test_inline_duplicate_reservation_has_zero_second_admission_and_delivery(
    monkeypatch, tmp_path
):
    ctx = _ctx(tmp_path)
    producer = FakeProducer()
    backend = InlineTaskBackend(producer=producer)
    submitted = []
    monkeypatch.setattr(backend, "_submit_lane_job", submitted.append)

    first, second = await asyncio.gather(
        backend.enqueue_project_task(ctx, task_type="single_video", episode=1),
        backend.enqueue_project_task(ctx, task_type="single_video", episode=1),
    )

    assert first.task_state.task_id == second.task_state.task_id
    assert len(producer.calls) == 1
    assert len(submitted) == 1


@pytest.mark.asyncio
async def test_inline_signing_failure_marks_task_failed_without_delivery(
    monkeypatch, tmp_path
):
    ctx = _ctx(tmp_path)
    backend = InlineTaskBackend(producer=FakeProducer(failure=InvalidTaskEnvelope()))
    submitted = []
    monkeypatch.setattr(backend, "_submit_lane_job", submitted.append)

    with pytest.raises(InvalidTaskEnvelope):
        await backend.enqueue_project_task(ctx, task_type="single_video", episode=1)

    state = get_task_manager().get_task_for_project(ctx, "single_video", 1)
    assert state.status == "failed"
    assert state.metadata["error_code"] == "TASK_ENVELOPE_INVALID"
    assert submitted == []


@pytest.mark.asyncio
async def test_inline_signed_flat_mismatch_has_zero_runner_usage_and_success(
    monkeypatch, tmp_path
):
    ctx = _ctx(tmp_path)
    authz = FakeAuthz()
    backend = _inline_backend(authz=authz)
    submitted = []
    downstream_calls = []
    monkeypatch.setattr(backend, "_submit_lane_job", submitted.append)
    monkeypatch.setattr(
        "novelvideo.ports.local.tasks.run_project_task_core_sync",
        lambda *_args, **_kwargs: downstream_calls.append("run_core"),
    )

    await backend.enqueue_project_task(ctx, task_type="single_video", episode=1)
    job = submitted[0]
    job.envelope["episode"] = True

    await backend._run_inline(backend._lanes["default"], job)

    state = get_task_manager().get_task_for_project(ctx, "single_video", 1)
    assert state.status == "failed"
    assert state.metadata["error_code"] == "TASK_ENVELOPE_INVALID"
    assert authz.calls == []
    assert downstream_calls == []


@pytest.mark.asyncio
async def test_inline_stale_authority_has_zero_runner_usage_and_success(
    monkeypatch, tmp_path
):
    ctx = _ctx(tmp_path)
    authz = FakeAuthz(key_version=2)
    backend = _inline_backend(authz=authz)
    submitted = []
    downstream_calls = []
    monkeypatch.setattr(backend, "_submit_lane_job", submitted.append)
    monkeypatch.setattr(
        "novelvideo.ports.local.tasks.run_project_task_core_sync",
        lambda *_args, **_kwargs: downstream_calls.append("run_core"),
    )

    await backend.enqueue_project_task(ctx, task_type="single_video", episode=1)
    job = submitted[0]

    await backend._run_inline(backend._lanes["default"], job)

    state = get_task_manager().get_task_for_project(ctx, "single_video", 1)
    assert state.status == "failed"
    assert state.metadata["error_code"] == "TASK_ENVELOPE_STALE"
    assert authz.calls == [{"user_id": "editor_1", "root_task_id": job.run_task_id}]
    assert downstream_calls == []


def test_local_bootstrap_builds_authz_and_producer_before_registering(monkeypatch):
    from novelvideo.ports.local import register_local_ports

    monkeypatch.setattr(registry, "_PORTS", {})
    monkeypatch.setenv("ST_TASK_ENVELOPE_ACTIVE_KEY_ID", "test-v1")
    monkeypatch.setenv(
        "ST_TASK_ENVELOPE_KEYRING_B64_JSON",
        json.dumps({"test-v1": base64.b64encode(SIGNING_KEY).decode("ascii")}),
    )

    register_local_ports()

    backend = registry.get_port("task_backend")
    authz = registry.get_port("authz")
    assert backend._producer._authz is authz
    assert backend._consumer is registry.get_port("task_envelope_consumer")
    assert backend._consumer._authz is authz


def test_local_bootstrap_bad_signing_config_registers_zero_ports(monkeypatch):
    from novelvideo.ports.local import register_local_ports
    from novelvideo.task_backend.signing import TaskEnvelopeSigningConfigError

    monkeypatch.setattr(registry, "_PORTS", {})
    monkeypatch.delenv("ST_TASK_ENVELOPE_ACTIVE_KEY_ID", raising=False)
    monkeypatch.delenv("ST_TASK_ENVELOPE_KEYRING_B64_JSON", raising=False)

    with pytest.raises(TaskEnvelopeSigningConfigError):
        register_local_ports()

    assert registry._PORTS == {}


@pytest.mark.asyncio
async def test_in_memory_cancellation_store_ttl_and_cross_thread_visibility():
    store = InMemoryCancellationStore()
    fields = {
        "project_id": "proj_t6",
        "task_type": "single_video",
        "episode": 1,
        "task_id": "task_1",
        "beat_num": 2,
        "scope": "main",
    }

    assert await store.is_cancel_requested(**fields) is False
    await store.request_cancel(**fields, ttl_seconds=60)
    assert await store.is_cancel_requested(**fields) is True

    assert (
        await asyncio.to_thread(
            lambda: asyncio.run(store.is_cancel_requested(**fields))
        )
        is True
    )

    await store.request_cancel(**{**fields, "task_id": "expired"}, ttl_seconds=0)
    assert await store.is_cancel_requested(**{**fields, "task_id": "expired"}) is False


@pytest.mark.asyncio
async def test_cancel_leaf_functions_delegate_to_registered_store(monkeypatch):
    calls: list[tuple[str, dict]] = []

    class FakeStore:
        async def request_cancel(self, **kwargs):
            calls.append(("request", kwargs))

        async def is_cancel_requested(self, **kwargs):
            calls.append(("is", kwargs))
            return True

    monkeypatch.setattr(cancel_module, "get_cancellation_store", lambda: FakeStore())

    fields = {
        "project_id": "proj_t6",
        "task_type": "single_video",
        "episode": 1,
        "task_id": "task_1",
    }
    await cancel_module.request_cancel(**fields)
    assert await cancel_module.is_cancel_requested(**fields) is True
    assert [call[0] for call in calls] == ["request", "is"]
