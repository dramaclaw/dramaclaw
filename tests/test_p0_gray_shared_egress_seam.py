from __future__ import annotations

from dataclasses import FrozenInstanceError, replace
from pathlib import Path
from types import SimpleNamespace

import pytest

from novelvideo.ports.authz import AdmissionContext, BillingPrincipal
from novelvideo.ports.model_credentials import CredentialReference
from novelvideo.project_context import ProjectContext
from novelvideo.task_backend.consumer import VerifiedTaskDelivery
from novelvideo.task_backend.envelope import InvalidTaskEnvelope


class _TaskManager:
    def update_progress_for_project(self, *_args, **_kwargs) -> None:
        return None

    def begin_task_execution_for_project(self, *_args, **_kwargs) -> bool:
        return True

    def complete_task_for_project(self, *_args, **_kwargs) -> None:
        return None

    def fail_task_for_project(self, *_args, **_kwargs) -> None:
        return None


def _delivery(
    *,
    requester_user_id: str = "user-1",
    project_id: str = "project-1",
    root_task_id: str = "task-1",
    payload: dict | None = None,
) -> VerifiedTaskDelivery:
    admission = AdmissionContext(
        requester_user_id=requester_user_id,
        billing_principal=BillingPrincipal(kind="organization", id="org-1"),
        credential=CredentialReference(
            source="organization",
            credential_id="credential-1",
            key_version=7,
            org_id="org-1",
        ),
        admission_id="admission-1",
        root_task_id=root_task_id,
        admitted_at="2026-08-03T04:05:00Z",
        membership_id="membership-1",
        authz_version=11,
    )
    return VerifiedTaskDelivery(
        envelope_id="envelope-1",
        admission=admission,
        task_type="p0g4s_probe",
        project_id=project_id,
        requester_user_id=requester_user_id,
        episode=1,
        beat_num=2,
        scope="beat",
        queue_kind="default",
        payload=payload or {},
    )


def _run_core(
    monkeypatch: pytest.MonkeyPatch,
    delivery: VerifiedTaskDelivery,
    *,
    run_task_id: str | None = None,
    context_project_id: str | None = None,
    context_requester_user_id: str | None = None,
):
    from novelvideo.task_backend import run_core
    from novelvideo.task_backend.registry import register_project_task_runner

    captured: dict[str, object] = {}

    async def not_cancelled(**_kwargs):
        return False

    async def no_metrics(*_args, **_kwargs):
        return None

    def runner(envelope, _ctx):
        captured["envelope"] = envelope
        return {"ok": True}

    monkeypatch.setattr(run_core, "_ensure_builtin_runners_registered", lambda: None)
    monkeypatch.setattr(run_core, "is_cancel_requested", not_cancelled)
    monkeypatch.setattr(run_core, "_emit_project_task_metrics", no_metrics)
    monkeypatch.setattr(
        run_core, "_set_project_task_metrics_context", lambda *_a, **_k: None
    )
    monkeypatch.setattr(run_core, "_clear_project_task_metrics_context", lambda: None)
    register_project_task_runner("p0g4s_probe", runner)

    run_core.run_project_task_core_sync(
        delivery,
        SimpleNamespace(
            project_id=context_project_id or delivery.project_id,
            requester_user_id=context_requester_user_id or delivery.requester_user_id,
        ),
        _TaskManager(),
        run_task_id=run_task_id or delivery.admission.root_task_id,
    )
    return captured["envelope"]


def _project_context(tmp_path: Path) -> ProjectContext:
    return ProjectContext(
        project_id="project-1",
        project_name="project",
        owner_type="user",
        owner_id="user-1",
        owner_username="user",
        requester_user_id="user-1",
        requester_username="user",
        requester_principals=(("user", "user-1"),),
        effective_role="editor",
        home_node_id="local",
        output_dir=tmp_path / "output",
        state_dir=tmp_path / "state",
        runtime_dir=tmp_path / "runtime",
        is_home_node=True,
    )


@pytest.fixture
def trusted_runner_envelope(monkeypatch: pytest.MonkeyPatch):
    return _run_core(
        monkeypatch,
        _delivery(
            payload={
                "job_id": "job-1",
                "prompt": "prompt",
                "input": "music",
                "text": "你好",
                "node_type": "text",
                "source_path": "source.mp4",
            }
        ),
    )


def test_run_core_constructs_immutable_secret_free_context_from_verified_delivery(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from novelvideo.egress_context import TrustedEgressContext

    captured = _run_core(monkeypatch, _delivery())
    context = captured["__trusted_egress_context"]

    assert type(context) is TrustedEgressContext
    assert context.envelope_id == "envelope-1"
    assert context.project_id == "project-1"
    assert context.requester_user_id == "user-1"
    assert context.root_task_id == "task-1"
    assert context.admitted_at == "2026-08-03T04:05:00Z"
    assert context.billing_principal == BillingPrincipal(
        kind="organization", id="org-1"
    )
    assert context.credential == CredentialReference(
        "organization", "credential-1", 7, "org-1"
    )
    assert "secret" not in repr(context).casefold()
    with pytest.raises(FrozenInstanceError):
        context.project_id = "borrowed-project"


def test_run_core_rejects_cross_task_admission_before_runner(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    delivery = _delivery(root_task_id="task-borrowed")

    with pytest.raises(InvalidTaskEnvelope):
        _run_core(monkeypatch, delivery, run_task_id="task-other")


def test_run_core_rejects_borrowed_user_and_project_before_runner(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    delivery = _delivery()

    with pytest.raises(InvalidTaskEnvelope):
        _run_core(
            monkeypatch,
            replace(delivery, requester_user_id="user-other"),
        )
    with pytest.raises(InvalidTaskEnvelope):
        _run_core(
            monkeypatch,
            delivery,
            context_project_id="project-other",
        )


def test_run_core_rejects_missing_verified_envelope_identity(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    with pytest.raises(InvalidTaskEnvelope):
        _run_core(monkeypatch, replace(_delivery(), envelope_id=""))


def test_payload_cannot_override_trusted_context(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    forged = {
        "project_id": "project-other",
        "credential": {"credential_id": "forged", "key_version": 99},
        "admitted_at": "2099-01-01T00:00:00Z",
    }
    captured = _run_core(
        monkeypatch,
        _delivery(payload={"__trusted_egress_context": forged}),
    )

    assert captured["payload"]["__trusted_egress_context"] is forged
    assert captured["__trusted_egress_context"].project_id == "project-1"
    assert captured["__trusted_egress_context"].admitted_at == "2026-08-03T04:05:00Z"


@pytest.mark.parametrize(
    ("admitted_at", "error_type", "message"),
    [
        ("", ValueError, "admitted_at is required"),
        (123, TypeError, "admitted_at must be a string"),
    ],
)
def test_trusted_egress_context_rejects_invalid_admitted_at(
    admitted_at,
    error_type,
    message,
) -> None:
    from novelvideo.egress_context import TrustedEgressContext

    with pytest.raises(error_type, match=message):
        TrustedEgressContext(
            envelope_id="envelope-1",
            project_id="project-1",
            task_type="p0g4s_probe",
            requester_user_id="user-1",
            root_task_id="task-1",
            admission_id="admission-1",
            admitted_at=admitted_at,
            membership_id="membership-1",
            authz_version=11,
            billing_principal=BillingPrincipal(kind="organization", id="org-1"),
            credential=CredentialReference(
                source="organization",
                credential_id="credential-1",
                key_version=7,
                org_id="org-1",
            ),
        )


@pytest.mark.asyncio
async def test_freezone_representative_leaves_receive_same_trusted_context(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    trusted_runner_envelope,
) -> None:
    from novelvideo.task_backend.runners import freezone

    project_dir = tmp_path / "output"
    envelope = trusted_runner_envelope
    envelope["payload"]["project_dir"] = str(project_dir)
    envelope["payload"]["source_path"] = str(project_dir / "source.mp4")
    context = envelope["__trusted_egress_context"]
    received: list[tuple[str, object]] = []

    class TaskManager:
        def update_progress_for_project(self, *_args, **_kwargs) -> None:
            return None

    async def await_direct(coro, **_kwargs):
        return await coro

    async def image_leaf(*, egress_context, **_kwargs):
        received.append(("image", egress_context))
        path = project_dir / "image.png"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"image")
        return path

    async def text_leaf(*, egress_context, **_kwargs):
        received.append(("text", egress_context))
        return "hello", "zh", "en"

    async def video_leaf(*, egress_context, **_kwargs):
        received.append(("video", egress_context))
        path = project_dir / "video.mp4"
        path.write_bytes(b"video")
        return path, {}

    async def audio_leaf(*, egress_context, **_kwargs):
        received.append(("audio", egress_context))
        path = project_dir / "audio.mp3"
        path.write_bytes(b"audio")
        return SimpleNamespace(
            audio_path=path,
            duration_ms=1000,
            mime_type="audio/mpeg",
            model="music-model",
        )

    monkeypatch.setattr(freezone, "get_task_manager", lambda: TaskManager())
    monkeypatch.setattr(freezone, "_await_with_cancel_watch", await_direct)
    monkeypatch.setattr("novelvideo.freezone.jobs.run_freezone_gen", image_leaf)
    monkeypatch.setattr(
        "novelvideo.freezone.text_node.translate_freezone_text", text_leaf
    )
    monkeypatch.setattr(
        "novelvideo.freezone.jobs.run_freezone_video_upscale", video_leaf
    )
    monkeypatch.setattr(
        "novelvideo.freezone.audio_node.generate_freezone_audio_eleven_music",
        audio_leaf,
    )

    ctx = _project_context(tmp_path)
    await freezone._run_freezone_gen_async(envelope, ctx)
    await freezone._run_freezone_text_translate_async(envelope, ctx)
    await freezone._run_freezone_video_upscale_async(envelope, ctx)
    await freezone._run_freezone_audio_eleven_music_async(envelope, ctx)

    assert [media for media, _context in received] == [
        "image",
        "text",
        "video",
        "audio",
    ]
    assert all(received_context is context for _media, received_context in received)


@pytest.mark.asyncio
@pytest.mark.parametrize("mutation", ["missing", "malformed"])
async def test_freezone_rejects_invalid_trusted_context_before_leaf(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    mutation: str,
    trusted_runner_envelope,
) -> None:
    from novelvideo.task_backend.runners import freezone

    envelope = trusted_runner_envelope
    envelope["payload"]["project_dir"] = str(tmp_path / "output")
    if mutation == "missing":
        envelope.pop("__trusted_egress_context")
    else:
        envelope["__trusted_egress_context"] = {"project_id": "forged"}
    leaf_calls = 0

    async def text_leaf(**_kwargs):
        nonlocal leaf_calls
        leaf_calls += 1
        return "hello", "zh", "en"

    class TaskManager:
        def update_progress_for_project(self, *_args, **_kwargs) -> None:
            return None

    monkeypatch.setattr(freezone, "get_task_manager", lambda: TaskManager())
    monkeypatch.setattr(
        "novelvideo.freezone.text_node.translate_freezone_text", text_leaf
    )

    with pytest.raises(InvalidTaskEnvelope):
        await freezone._run_freezone_text_translate_async(
            envelope,
            _project_context(tmp_path),
        )

    assert leaf_calls == 0
