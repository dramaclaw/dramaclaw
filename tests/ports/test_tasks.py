import asyncio
import base64
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
from novelvideo.task_backend.envelope import InvalidTaskEnvelope, SignedTaskEnvelope
from novelvideo.task_backend.registry import register_project_task_runner
from novelvideo.task_state import get_task_manager

SIGNING_KEY = b"t" * 32


class FakeProducer:
    def __init__(self, *, failure=None):
        self.calls = []
        self.failure = failure

    async def sign_top_level(self, **kwargs):
        self.calls.append(kwargs)
        await asyncio.sleep(0)
        if self.failure is not None:
            raise self.failure
        admission = AdmissionContext(
            requester_user_id=kwargs["user_id"],
            billing_principal=BillingPrincipal(kind="local", id=kwargs["user_id"]),
            credential=CredentialReference(
                source="local",
                credential_id="local-newapi",
                key_version=1,
            ),
            admission_id="admission-1",
            root_task_id=kwargs["root_task_id"],
            admitted_at="2026-08-03T04:05:00Z",
            authz_version=1,
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
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        task = manager.get_task_for_project(ctx, task_type, 1)
        if task is not None and task.status == expected:
            return task
        await asyncio.sleep(0.02)
    task = manager.get_task_for_project(ctx, task_type, 1)
    raise AssertionError(f"timed out waiting for {expected}, got {task}")


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

    queued = await InlineTaskBackend(producer=producer).enqueue_project_task(
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
    signed = delivered[0]["task_envelope_v2"]
    assert signed["payload"] == {
        "episode": 1,
        "beat_num": None,
        "scope": None,
        "queue_kind": "default",
        "payload": {},
    }


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

    queued = await InlineTaskBackend(producer=FakeProducer()).enqueue_project_task(
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
    assert state.metadata == {"error_code": "TASK_ENVELOPE_INVALID"}
    assert submitted == []


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
