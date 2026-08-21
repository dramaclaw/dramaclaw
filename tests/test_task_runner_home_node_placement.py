"""Runner placement declared once in the registry, checked once at run_core entry."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi import HTTPException

from novelvideo.ports.authz import AdmissionContext, BillingPrincipal
from novelvideo.ports.model_credentials import CredentialReference
from novelvideo.project_context import ProjectContext
from novelvideo.task_backend import registry as registry_module
from novelvideo.task_backend.consumer import VerifiedTaskDelivery
from novelvideo.task_backend.queues import QUEUE_KINDS
from novelvideo.task_backend.registry import (
    get_project_task_runner,
    project_task_lane,
    project_task_requires_home_node,
    register_project_task_runner,
    registered_project_task_types,
)
from novelvideo.task_backend.projection import PROJECTION_REQUIREMENTS


PLACEMENT_FREE_TASKS = {
    "freezone_analyze",
    "freezone_audio_eleven_music",
    "freezone_audio_separate",
    "freezone_audio_speech",
    "freezone_edit",
    "freezone_extract",
    "freezone_gen",
    "freezone_image_reverse_prompt",
    "freezone_image_to_3gs",
    "freezone_mask_edit",
    "freezone_story_script",
    "freezone_text_generate",
    "freezone_text_translate",
    "freezone_video_compose",
    "freezone_video_erase",
    "freezone_video_gen",
    "freezone_video_story",
    "freezone_video_upscale",
    "mainline_director_control_sketch",
    "mainline_frame_from_context",
    "mainline_sketch_from_context",
}


@pytest.fixture
def isolated_registry(monkeypatch):
    """Snapshot the module globals the same way tests/ports/test_tasks.py:118-119 does."""
    monkeypatch.setattr(
        registry_module,
        "_PROJECT_TASK_RUNNERS",
        dict(registry_module._PROJECT_TASK_RUNNERS),
    )
    monkeypatch.setattr(
        registry_module,
        "_PROJECT_TASK_PLACEMENTS",
        dict(registry_module._PROJECT_TASK_PLACEMENTS),
    )


def _runner(_envelope, _ctx):
    return {"ok": True}


# --------------------------------------------------------------------------
# registry
# --------------------------------------------------------------------------


def test_registering_without_placement_keeps_the_task_home_node_bound(isolated_registry):
    register_project_task_runner("tcp_d2_probe", _runner)

    assert get_project_task_runner("tcp_d2_probe") is _runner
    assert project_task_requires_home_node("tcp_d2_probe") is True
    assert project_task_lane("tcp_d2_probe") is None
    assert "tcp_d2_probe" in registered_project_task_types()


def test_only_audited_self_contained_builtin_runners_are_placement_free():
    """Audited payload/shared-output runners may float; every other runner stays bound."""
    import novelvideo.task_backend.runners  # noqa: F401

    task_types = registered_project_task_types()
    assert len(task_types) >= 25

    flipped = {t for t in task_types if project_task_requires_home_node(t) is not True}
    laned = [t for t in task_types if project_task_lane(t) is not None]

    assert flipped == PLACEMENT_FREE_TASKS
    assert set(PROJECTION_REQUIREMENTS) <= PLACEMENT_FREE_TASKS
    assert laned == []


def test_registering_with_explicit_placement_is_reported_back(isolated_registry):
    register_project_task_runner(
        "tcp_d2_probe_free",
        _runner,
        requires_home_node=False,
        lane="video",
    )

    assert project_task_requires_home_node("tcp_d2_probe_free") is False
    assert project_task_lane("tcp_d2_probe_free") == "video"


def test_registering_an_unknown_lane_is_rejected_not_silently_absorbed(isolated_registry):
    """The registry is the single source both routing and guards read (B2 §6.4 step 9).

    Accepting a misspelled lane here would poison that source, so it goes
    through the same ``normalize_queue_kind`` that D1 made throw
    (``task_backend/queues.py:19-20``).
    """
    assert "sketch" not in QUEUE_KINDS

    with pytest.raises(ValueError) as exc_info:
        register_project_task_runner("tcp_d2_probe_bad_lane", _runner, lane="sketch")

    assert "sketch" in str(exc_info.value)
    assert get_project_task_runner("tcp_d2_probe_bad_lane") is None
    assert "tcp_d2_probe_bad_lane" not in registered_project_task_types()


def test_unregistered_task_type_reads_as_home_node_bound():
    assert project_task_requires_home_node("tcp_d2_never_registered") is True
    assert project_task_lane("tcp_d2_never_registered") is None


# --------------------------------------------------------------------------
# run_core entry check
# --------------------------------------------------------------------------


class _FakeTaskManager:
    """Same shape as tests/test_task_timeout.py:15-30."""

    def __init__(self) -> None:
        self.completed: list[dict] = []
        self.failed: list[dict] = []
        self.updates: list[dict] = []

    def update_progress_for_project(self, *_args, **kwargs) -> None:
        self.updates.append(kwargs)

    def begin_task_execution_for_project(self, *_args, **_kwargs) -> bool:
        return True

    def complete_task_for_project(self, *_args, **kwargs) -> None:
        self.completed.append(kwargs)

    def fail_task_for_project(self, *_args, **kwargs) -> None:
        self.failed.append(kwargs)


def _verified_delivery(
    *, task_type: str, payload: dict | None = None
) -> VerifiedTaskDelivery:
    admission = AdmissionContext(
        requester_user_id="usr_1",
        billing_principal=BillingPrincipal(kind="local", id="usr_1"),
        credential=CredentialReference("local", "local-newapi", 1),
        admission_id="admission-1",
        root_task_id="task_1",
        admitted_at="2026-08-03T04:05:00Z",
        authz_version=1,
    )
    return VerifiedTaskDelivery(
        envelope_id="envelope-1",
        admission=admission,
        task_type=task_type,
        project_id="proj_d2",
        requester_user_id="usr_1",
        episode=0,
        beat_num=None,
        scope=None,
        queue_kind="default",
        payload=payload or {},
    )


def _ctx(tmp_path: Path, *, is_home_node: bool) -> ProjectContext:
    return ProjectContext(
        project_id="proj_d2",
        project_name="demo",
        owner_type="user",
        owner_id="owner_1",
        owner_username="alice",
        requester_user_id="usr_1",
        requester_username="alice",
        requester_principals=(("user", "usr_1"),),
        effective_role="editor",
        home_node_id="node_a",
        output_dir=tmp_path / "output",
        state_dir=tmp_path / "state",
        runtime_dir=tmp_path / "runtime",
        is_home_node=is_home_node,
    )


@pytest.fixture
def quiet_run_core(monkeypatch):
    """Neutralise everything around the entry check (mirrors test_task_timeout.py:151-160)."""
    from novelvideo.task_backend import run_core

    async def fake_is_cancel_requested(**_kwargs):
        return False

    async def fake_emit_project_task_metrics(*_args, **_kwargs):
        return None

    monkeypatch.setattr(run_core, "_ensure_builtin_runners_registered", lambda: None)
    monkeypatch.setattr(run_core, "is_cancel_requested", fake_is_cancel_requested)
    monkeypatch.setattr(
        run_core, "_emit_project_task_metrics", fake_emit_project_task_metrics
    )
    monkeypatch.setattr(
        run_core, "_set_project_task_metrics_context", lambda *_a, **_k: None
    )
    monkeypatch.setattr(run_core, "_clear_project_task_metrics_context", lambda: None)
    monkeypatch.setattr(run_core, "_project_task_timeout_seconds", lambda: 30 * 60)
    return run_core


def test_home_node_bound_task_is_rejected_at_entry_on_a_foreign_node(
    tmp_path, quiet_run_core, isolated_registry
):
    ran: list[dict] = []

    def tracking_runner(envelope, _ctx):
        ran.append(dict(envelope))
        return {"ok": True}

    register_project_task_runner("tcp_d2_bound", tracking_runner)
    manager = _FakeTaskManager()

    with pytest.raises(HTTPException) as exc_info:
        quiet_run_core.run_project_task_core_sync(
            _verified_delivery(task_type="tcp_d2_bound"),
            _ctx(tmp_path, is_home_node=False),
            manager,
            run_task_id="task_1",
        )

    assert exc_info.value.status_code == 409
    assert exc_info.value.detail["code"] == "project_not_on_this_node"
    # Louder and earlier: the runner never starts and no state was written.
    assert ran == []
    assert manager.updates == []
    assert manager.completed == []
    assert manager.failed == []


def test_home_node_bound_task_still_runs_on_its_home_node(
    tmp_path, quiet_run_core, isolated_registry
):
    ran: list[dict] = []

    def tracking_runner(envelope, _ctx):
        ran.append(dict(envelope))
        return {"ok": True}

    register_project_task_runner("tcp_d2_bound_home", tracking_runner)

    result = quiet_run_core.run_project_task_core_sync(
        _verified_delivery(task_type="tcp_d2_bound_home"),
        _ctx(tmp_path, is_home_node=True),
        _FakeTaskManager(),
        run_task_id="task_1",
    )

    assert result == {"ok": True}
    assert len(ran) == 1


def test_placement_free_task_is_not_stopped_by_the_entry_check(
    tmp_path, quiet_run_core, isolated_registry
):
    """The entry layer lets an explicitly placement-free runner execute remotely."""
    ran: list[dict] = []

    def tracking_runner(envelope, _ctx):
        ran.append(dict(envelope))
        return {"ok": True}

    register_project_task_runner(
        "tcp_d2_free", tracking_runner, requires_home_node=False
    )

    result = quiet_run_core.run_project_task_core_sync(
        _verified_delivery(task_type="tcp_d2_free"),
        _ctx(tmp_path, is_home_node=False),
        _FakeTaskManager(),
        run_task_id="task_1",
    )

    assert result == {"ok": True}
    assert len(ran) == 1


def test_projected_placement_free_task_requires_projection_off_home_node(
    tmp_path, quiet_run_core, isolated_registry
):
    ran: list[dict] = []

    def tracking_runner(envelope, _ctx):
        ran.append(dict(envelope))
        return {"ok": True}

    register_project_task_runner(
        "mainline_frame_from_context",
        tracking_runner,
        requires_home_node=False,
    )

    with pytest.raises(HTTPException) as exc_info:
        quiet_run_core.run_project_task_core_sync(
            _verified_delivery(task_type="mainline_frame_from_context"),
            _ctx(tmp_path, is_home_node=False),
            _FakeTaskManager(),
            run_task_id="task_1",
        )

    assert exc_info.value.status_code == 409
    assert ran == []


def test_projected_placement_free_task_runs_with_projection_off_home_node(
    tmp_path, quiet_run_core, isolated_registry
):
    ran: list[dict] = []

    def tracking_runner(envelope, _ctx):
        ran.append(dict(envelope))
        return {"ok": True}

    register_project_task_runner(
        "mainline_frame_from_context",
        tracking_runner,
        requires_home_node=False,
    )
    payload = {
        "projection": {
            "projection_version": 1,
            "task_type": "mainline_frame_from_context",
            "fields": {},
        }
    }

    result = quiet_run_core.run_project_task_core_sync(
        _verified_delivery(
            task_type="mainline_frame_from_context",
            payload=payload,
        ),
        _ctx(tmp_path, is_home_node=False),
        _FakeTaskManager(),
        run_task_id="task_1",
    )

    assert result == {"ok": True}
    assert len(ran) == 1


def test_unregistered_task_type_is_checked_not_waved_through(
    tmp_path, quiet_run_core, isolated_registry
):
    manager = _FakeTaskManager()

    with pytest.raises(HTTPException) as exc_info:
        quiet_run_core.run_project_task_core_sync(
            _verified_delivery(task_type="tcp_d2_unregistered"),
            _ctx(tmp_path, is_home_node=False),
            manager,
            run_task_id="task_1",
        )

    assert exc_info.value.status_code == 409
    assert manager.failed == []


def test_entry_check_resolves_placement_after_builtin_runners_are_imported(
    tmp_path, monkeypatch
):
    """The registry is populated lazily; the check must not read an empty one.

    Without ``_ensure_builtin_runners_registered()`` in front of it, a task
    registered as ``requires_home_node=False`` would read as unregistered on a
    cold worker and be rejected.
    """
    from novelvideo.task_backend import run_core

    calls: list[str] = []
    monkeypatch.setattr(
        run_core,
        "_ensure_builtin_runners_registered",
        lambda: calls.append("imported"),
    )

    async def fake_is_cancel_requested(**_kwargs):
        return False

    monkeypatch.setattr(run_core, "is_cancel_requested", fake_is_cancel_requested)
    monkeypatch.setattr(run_core, "_clear_project_task_metrics_context", lambda: None)

    with pytest.raises(HTTPException):
        run_core.run_project_task_core_sync(
            _verified_delivery(task_type="tcp_d2_cold"),
            _ctx(tmp_path, is_home_node=False),
            _FakeTaskManager(),
            run_task_id="task_1",
        )

    assert calls == ["imported"]
