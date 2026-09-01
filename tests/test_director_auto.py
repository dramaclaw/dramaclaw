from __future__ import annotations

import asyncio
import time
from dataclasses import replace
from pathlib import Path

import pytest

from novelvideo.chat import director_auto
from novelvideo.chat.director_auto import (
    DirectorAutoCoordinator,
    DirectorAutoRun,
    DirectorAutoStore,
)
from novelvideo.project_context import ProjectContext
from novelvideo.task_state import TaskState


def context(tmp_path: Path) -> ProjectContext:
    return ProjectContext(
        project_id="project-1",
        project_name="demo",
        owner_type="user",
        owner_id="user-1",
        owner_username="alice",
        requester_user_id="user-1",
        requester_username="alice",
        requester_principals=(("user", "user-1"),),
        effective_role="owner",
        home_node_id="local",
        output_dir=tmp_path / "output",
        state_dir=tmp_path / "state",
        runtime_dir=tmp_path / "runtime",
        is_home_node=True,
    )


def task(
    task_id: str,
    status: str,
    *,
    task_type: str = "identity_image",
    error: str | None = None,
) -> TaskState:
    return TaskState(
        task_id=task_id,
        task_type=task_type,
        username="alice",
        project="demo",
        project_id="project-1",
        episode=1,
        status=status,
        updated_at="2026-08-14T01:00:00+00:00",
        completed_at=("2026-08-14T01:00:00+00:00" if status in {"completed", "failed"} else ""),
        error=error,
    )


def run_record(tmp_path: Path, **overrides) -> DirectorAutoRun:
    ctx = context(tmp_path)
    base = DirectorAutoRun(
        run_id="run-1",
        username="alice",
        project_id=ctx.project_id,
        episode=1,
        status="running",
        activated_at="2026-08-14T00:00:00+00:00",
        updated_at="2026-08-14T00:00:00+00:00",
        context_json=director_auto._serialize_context(ctx),
        baseline_task_ids=(),
        handled_task_ids=(),
    )
    return replace(base, **overrides)


def test_store_round_trips_durable_run(tmp_path: Path) -> None:
    store = DirectorAutoStore(tmp_path / "director-auto.db")
    run = run_record(
        tmp_path,
        baseline_task_ids=("old",),
        handled_task_ids=("done",),
        voice_policy="system",
    )
    store.upsert(run)

    loaded = store.get("alice", "project-1")

    assert loaded == run
    assert loaded is not None
    assert loaded.context.output_dir == context(tmp_path).output_dir
    assert store.active() == [run]


def test_store_lease_claim_is_atomic_and_expired_lease_can_be_reclaimed(tmp_path: Path) -> None:
    store = DirectorAutoStore(tmp_path / "director-auto.db")
    run = run_record(tmp_path)
    store.upsert(run)

    assert store.claim_lease(run.run_id, "worker-a", lease_seconds=10, now=100) is True
    assert store.claim_lease(run.run_id, "worker-b", lease_seconds=10, now=101) is False
    assert store.owns_lease(run.run_id, "worker-a", now=101) is True
    assert store.claim_lease(run.run_id, "worker-b", lease_seconds=10, now=111) is True
    assert store.owns_lease(run.run_id, "worker-a", now=111) is False
    assert store.owns_lease(run.run_id, "worker-b", now=111) is True


@pytest.mark.asyncio
async def test_stale_owner_cannot_overwrite_pause_or_release_new_owner(
    tmp_path: Path,
) -> None:
    store = DirectorAutoStore(tmp_path / "director-auto.db")
    original = run_record(tmp_path)
    store.upsert(original)
    base = time.time()

    assert store.claim_lease(original.run_id, "worker-a", lease_seconds=10, now=base)
    assert store.claim_lease(
        original.run_id,
        "worker-b",
        lease_seconds=120,
        now=base + 11,
    )
    owned_by_b = replace(original, handled_task_ids=("handled-by-b",))
    assert store.update_if_owned(owned_by_b, "worker-b", now=base + 12)

    stale_snapshot = replace(original, handled_task_ids=("stale-a",))
    assert not store.update_if_owned(stale_snapshot, "worker-a", now=base + 12)
    assert not store.release_lease(original.run_id, "worker-a")
    assert store.owns_lease(original.run_id, "worker-b", now=base + 12)

    stale = DirectorAutoCoordinator(DirectorAutoStore(store.db_path))
    stale.owner_token = "worker-a"
    assert (
        await stale._pause_owned(
            run_id=original.run_id,
            username=original.username,
            project_id=original.project_id,
            reason="stale worker timeout",
        )
        is None
    )
    saved = store.get(original.username, original.project_id)
    assert saved is not None
    assert saved.status == "running"
    assert saved.handled_task_ids == ("handled-by-b",)
    assert store.owns_lease(original.run_id, "worker-b", now=base + 12)


@pytest.mark.asyncio
async def test_two_coordinators_only_one_process_continues_the_same_run(
    tmp_path: Path,
) -> None:
    entered: list[str] = []
    release = asyncio.Event()

    class RecordingCoordinator(DirectorAutoCoordinator):
        async def _run(self, run_id, _username, _project_id):
            entered.append(self.owner_token)
            await release.wait()

    db_path = tmp_path / "director-auto.db"
    store_a = DirectorAutoStore(db_path)
    store_a.upsert(run_record(tmp_path))
    first = RecordingCoordinator(store_a)
    second = RecordingCoordinator(DirectorAutoStore(db_path))
    run = store_a.get("alice", "project-1")
    assert run is not None

    first._ensure_worker(run)
    second._ensure_worker(run)
    await asyncio.sleep(0.05)

    assert len(entered) == 1
    assert entered[0] in {first.owner_token, second.owner_token}
    release.set()
    await first.shutdown()
    await second.shutdown()


@pytest.mark.asyncio
async def test_agent_continuation_is_pinned_to_the_auto_run_episode(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    prompts: list[str] = []
    ctx = context(tmp_path)

    async def fake_resolve_project_context(**_kwargs):
        return ctx

    async def fake_stream_reply(_username, _project_id, prompt, _on_event, **_kwargs):
        prompts.append(prompt)

    monkeypatch.setattr(director_auto, "resolve_project_context", fake_resolve_project_context)
    monkeypatch.setattr(
        director_auto.chat_service,
        "chat_run_lock_is_active",
        lambda *_args, **_kwargs: False,
    )
    monkeypatch.setattr(
        director_auto.chat_service,
        "stream_assistant_reply",
        fake_stream_reply,
    )
    coordinator = DirectorAutoCoordinator(DirectorAutoStore(tmp_path / "director-auto.db"))
    run = run_record(tmp_path, episode=2)

    wrote = await coordinator._agent_continue(run)

    assert wrote is False
    assert "只继续第 2 集的下一步" in prompts[0]
    assert "不得启动、修改或推进其他集" in prompts[0]


@pytest.mark.asyncio
async def test_resume_only_restarts_persisted_running_sessions(tmp_path: Path) -> None:
    class RecordingCoordinator(DirectorAutoCoordinator):
        def __init__(self, store):
            super().__init__(store)
            self.resumed: list[str] = []

        def _ensure_worker(self, run):
            self.resumed.append(run.run_id)

    store = DirectorAutoStore(tmp_path / "director-auto.db")
    store.upsert(run_record(tmp_path, run_id="running"))
    store.upsert(
        run_record(
            tmp_path,
            run_id="paused",
            project_id="project-2",
            status="paused",
        )
    )
    coordinator = RecordingCoordinator(store)

    await coordinator.resume()

    assert coordinator.resumed == ["running"]


@pytest.mark.asyncio
async def test_start_adopts_existing_active_task_but_ignores_terminal_history(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    class Manager:
        def list_tasks_for_project(self, _ctx):
            return [task("old-complete", "completed"), task("already-running", "running")]

    monkeypatch.setattr(director_auto, "get_task_manager", lambda: Manager())
    store = DirectorAutoStore(tmp_path / "director-auto.db")
    coordinator = DirectorAutoCoordinator(store)

    run = await coordinator.start(username="alice", ctx=context(tmp_path), episode=1)
    await coordinator.pause(username="alice", project_id="project-1")

    assert run.baseline_task_ids == ("old-complete",)
    assert "already-running" not in run.baseline_task_ids
    await coordinator.shutdown()


@pytest.mark.asyncio
async def test_completed_task_notifies_and_triggers_one_server_continuation(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    completed = task("new-complete", "completed")

    class Manager:
        def list_tasks_for_project(self, _ctx):
            return [completed]

    class RecordingCoordinator(DirectorAutoCoordinator):
        def __init__(self, store):
            super().__init__(store)
            self.notifications: list[str] = []
            self.continuations = 0

        async def _notify(self, run, text):
            self.notifications.append(text)
            return {"content": text}

        async def _agent_continue(self, run, *, final_delivery=False):
            self.continuations += 1
            await self.pause(username=run.username, project_id=run.project_id, reason="test-stop")
            return True

    monkeypatch.setattr(director_auto, "get_task_manager", lambda: Manager())
    monkeypatch.setattr(director_auto, "POLL_SECONDS", 0.01)
    store = DirectorAutoStore(tmp_path / "director-auto.db")
    store.upsert(run_record(tmp_path))
    coordinator = RecordingCoordinator(store)

    coordinator._ensure_worker(store.get("alice", "project-1"))  # type: ignore[arg-type]
    await asyncio.sleep(0.08)

    assert coordinator.continuations == 1
    assert coordinator.notifications == ["✅ 角色身份图已完成。本集自动正在继续下一步。"]
    saved = store.get("alice", "project-1")
    assert saved is not None
    assert saved.handled_task_ids == ("new-complete",)
    await coordinator.shutdown()


@pytest.mark.asyncio
async def test_failure_pauses_without_starting_downstream_turn(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    failed = task("new-failed", "failed")
    failed.error = "upstream rejected"

    class Manager:
        def list_tasks_for_project(self, _ctx):
            return [failed]

    class RecordingCoordinator(DirectorAutoCoordinator):
        def __init__(self, store):
            super().__init__(store)
            self.notifications: list[str] = []
            self.continuations = 0

        async def _notify(self, run, text):
            self.notifications.append(text)
            return {"content": text}

        async def _broadcast_status(self, run, **_kwargs):
            return None

        async def _agent_continue(self, run, *, final_delivery=False):
            self.continuations += 1
            return True

    monkeypatch.setattr(director_auto, "get_task_manager", lambda: Manager())
    monkeypatch.setattr(director_auto, "POLL_SECONDS", 0.01)
    store = DirectorAutoStore(tmp_path / "director-auto.db")
    store.upsert(run_record(tmp_path))
    coordinator = RecordingCoordinator(store)

    coordinator._ensure_worker(store.get("alice", "project-1"))  # type: ignore[arg-type]
    await asyncio.sleep(0.08)

    saved = store.get("alice", "project-1")
    assert saved is not None and saved.status == "paused"
    assert coordinator.continuations == 0
    assert "upstream rejected" in coordinator.notifications[0]
    await coordinator.shutdown()


def test_missing_portrait_recovery_only_matches_exact_identity_failure() -> None:
    recoverable = task(
        "identity-failed",
        "failed",
        error="请先为角色「锦绣」生成 Portrait（面部特写）",
    )
    unrelated_task = task(
        "portrait-failed",
        "failed",
        task_type="character_portrait",
        error="请先为角色「锦绣」生成 Portrait（面部特写）",
    )
    unrelated_error = task("other-failed", "failed", error="模型调用失败")

    assert director_auto._missing_character_portrait(recoverable) == "锦绣"
    assert director_auto._missing_character_portrait(unrelated_task) is None
    assert director_auto._missing_character_portrait(unrelated_error) is None


@pytest.mark.asyncio
async def test_missing_portrait_is_repaired_once_without_pausing_auto_mode(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    failed = task(
        "identity-failed",
        "failed",
        error="请先为角色「锦绣」生成 Portrait（面部特写）",
    )
    portrait = task("portrait-running", "running", task_type="character_portrait")

    class Manager:
        repair_started = False

        def list_tasks_for_project(self, _ctx):
            return [failed, portrait] if self.repair_started else [failed]

    manager = Manager()

    class RecordingCoordinator(DirectorAutoCoordinator):
        def __init__(self, store):
            super().__init__(store)
            self.notifications: list[str] = []
            self.instructions: list[str] = []

        async def _notify(self, run, text):
            self.notifications.append(text)
            return {"content": text}

        async def _broadcast_status(self, run, **_kwargs):
            return None

        async def _agent_continue(self, run, *, final_delivery=False, instruction=None):
            assert instruction is not None
            self.instructions.append(instruction)
            manager.repair_started = True
            return True

    monkeypatch.setattr(director_auto, "get_task_manager", lambda: manager)
    monkeypatch.setattr(director_auto, "POLL_SECONDS", 0.01)
    store = DirectorAutoStore(tmp_path / "director-auto.db")
    store.upsert(run_record(tmp_path))
    coordinator = RecordingCoordinator(store)

    coordinator._ensure_worker(store.get("alice", "project-1"))  # type: ignore[arg-type]
    await asyncio.sleep(0.08)

    saved = store.get("alice", "project-1")
    assert saved is not None and saved.status == "running"
    assert saved.handled_task_ids == ("identity-failed",)
    assert saved.recovery_keys == ("missing-character-portrait:锦绣",)
    assert len(coordinator.instructions) == 1
    assert "仅启动该角色的一个 Portrait" in coordinator.instructions[0]
    assert coordinator.notifications == [
        "检测到角色身份图缺少前置肖像，正在自动补生成「锦绣」肖像。"
    ]
    await coordinator.shutdown()


@pytest.mark.asyncio
async def test_repeated_missing_portrait_failure_pauses_instead_of_looping(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    failed = task(
        "identity-failed-again",
        "failed",
        error="请先为角色「锦绣」生成 Portrait（面部特写）",
    )

    class Manager:
        def list_tasks_for_project(self, _ctx):
            return [failed]

    class RecordingCoordinator(DirectorAutoCoordinator):
        def __init__(self, store):
            super().__init__(store)
            self.continuations = 0

        async def _notify(self, run, text):
            return {"content": text}

        async def _broadcast_status(self, run, **_kwargs):
            return None

        async def _agent_continue(self, run, *, final_delivery=False, instruction=None):
            self.continuations += 1
            return True

    monkeypatch.setattr(director_auto, "get_task_manager", lambda: Manager())
    monkeypatch.setattr(director_auto, "POLL_SECONDS", 0.01)
    store = DirectorAutoStore(tmp_path / "director-auto.db")
    store.upsert(
        run_record(tmp_path, recovery_keys=("missing-character-portrait:锦绣",))
    )
    coordinator = RecordingCoordinator(store)

    coordinator._ensure_worker(store.get("alice", "project-1"))  # type: ignore[arg-type]
    await asyncio.sleep(0.08)

    saved = store.get("alice", "project-1")
    assert saved is not None and saved.status == "paused"
    assert coordinator.continuations == 0
    await coordinator.shutdown()


@pytest.mark.asyncio
async def test_suspend_and_resume_preserve_the_same_auto_run(tmp_path: Path) -> None:
    class RecordingCoordinator(DirectorAutoCoordinator):
        def __init__(self, store):
            super().__init__(store)
            self.started: list[str] = []
            self.statuses: list[str] = []

        def _ensure_worker(self, run):
            self.started.append(run.run_id)

        async def _broadcast_status(self, run, **_kwargs):
            self.statuses.append(run.status)

    store = DirectorAutoStore(tmp_path / "director-auto.db")
    original = run_record(
        tmp_path,
        handled_task_ids=("task-already-finished",),
        recovery_keys=("missing-character-portrait:锦绣",),
    )
    store.upsert(original)
    coordinator = RecordingCoordinator(store)

    suspended = await coordinator.suspend_for_confirmation(
        username="alice",
        project_id="project-1",
        reason="用户可能要修改镜头",
    )
    assert suspended is not None
    assert suspended.status == "awaiting_confirmation"
    assert suspended.run_id == original.run_id
    assert suspended.handled_task_ids == original.handled_task_ids

    resumed = await coordinator.resume_suspended(
        username="alice",
        project_id="project-1",
    )
    assert resumed is not None
    assert resumed.status == "running"
    assert resumed.run_id == original.run_id
    assert resumed.recovery_keys == original.recovery_keys
    assert coordinator.started == [original.run_id]
    assert coordinator.statuses == ["awaiting_confirmation", "running"]


@pytest.mark.asyncio
async def test_hard_paused_auto_run_cannot_be_resumed_as_declined_change(tmp_path: Path) -> None:
    store = DirectorAutoStore(tmp_path / "director-auto.db")
    store.upsert(run_record(tmp_path, status="paused", last_error="生成失败"))
    coordinator = DirectorAutoCoordinator(store)

    with pytest.raises(ValueError, match="只有等待修改确认"):
        await coordinator.resume_suspended(username="alice", project_id="project-1")
