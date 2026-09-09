import asyncio
import sqlite3
import threading
from pathlib import Path

import anyio
import pytest

from novelvideo.ports.project import ProjectRecord


def _project_record(tmp_path: Path, name: str = "demo") -> ProjectRecord:
    state_dir = tmp_path / "state" / name
    output_dir = tmp_path / "output" / name
    runtime_dir = tmp_path / "runtime" / name
    state_dir.mkdir(parents=True)
    output_dir.mkdir(parents=True)
    runtime_dir.mkdir(parents=True)
    return ProjectRecord(
        id=f"project-{name}",
        owner_type="user",
        owner_id="user-1",
        owner_username="alice",
        name=name,
        home_node_id="local-dev",
        output_dir=str(output_dir),
        state_dir=str(state_dir),
        runtime_dir=str(runtime_dir),
        status="active",
    )


@pytest.mark.asyncio
async def test_project_summary_counts_from_registered_state_dir(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    state_dir = tmp_path / "state" / "_orgs" / "org-1" / "alice" / "demo"
    output_dir = tmp_path / "output" / "_orgs" / "org-1" / "alice" / "demo"
    runtime_dir = tmp_path / "runtime" / "_orgs" / "org-1" / "alice" / "demo"
    state_dir.mkdir(parents=True)
    output_dir.mkdir(parents=True)
    runtime_dir.mkdir(parents=True)
    with sqlite3.connect(state_dir / "data.db") as conn:
        conn.execute("CREATE TABLE episodes (episode_number INTEGER PRIMARY KEY)")
        conn.execute("CREATE TABLE beats (id INTEGER PRIMARY KEY)")
        conn.executemany("INSERT INTO episodes VALUES (?)", [(1,), (2,)])
        conn.executemany("INSERT INTO beats VALUES (?)", [(1,), (2,), (3,)])

    # Resolved at call time rather than bound at import, which is how the route
    # uses it anyway. The CE contract test that once orphaned this reference now
    # restores the import system itself, so this is defence in depth rather than
    # the thing standing between the patch below and the code it patches.
    from novelvideo.api.routes.projects import _summary_for_record

    monkeypatch.setattr(
        "novelvideo.api.routes.projects.is_record_home_node", lambda _record: True
    )
    record = ProjectRecord(
        id="project-1",
        owner_type="user",
        owner_id="user-1",
        owner_username="alice",
        name="demo",
        home_node_id="local-dev",
        output_dir=str(output_dir),
        state_dir=str(state_dir),
        runtime_dir=str(runtime_dir),
        status="active",
    )

    summary = await _summary_for_record(record)

    assert summary.episode_count == 2
    assert summary.beat_count == 3


@pytest.mark.asyncio
async def test_project_summary_reads_files_off_the_event_loop(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from novelvideo.api.routes import projects

    record = _project_record(tmp_path)
    loop_thread_id = threading.get_ident()
    reader_thread_ids: list[int] = []

    def fake_load_config(_state_dir: str) -> dict:
        reader_thread_ids.append(threading.get_ident())
        return {}

    monkeypatch.setattr(projects, "is_record_home_node", lambda _record: True)
    monkeypatch.setattr(
        projects, "load_project_config_file_from_state_dir", fake_load_config
    )

    await projects._summary_for_record(record)

    assert reader_thread_ids
    assert reader_thread_ids[0] != loop_thread_id


@pytest.mark.asyncio
async def test_project_summary_blocking_reads_use_a_small_shared_limiter(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from novelvideo.api.routes import projects

    records = [_project_record(tmp_path, f"demo-{index}") for index in range(3)]
    condition = threading.Condition()
    active = 0
    peak = 0

    def fake_load_config(_state_dir: str) -> dict:
        nonlocal active, peak
        with condition:
            active += 1
            peak = max(peak, active)
            condition.notify_all()
            if active == 1:
                condition.wait_for(lambda: peak >= 2, timeout=1)
        try:
            return {}
        finally:
            with condition:
                active -= 1
                condition.notify_all()

    monkeypatch.setattr(projects, "is_record_home_node", lambda _record: True)
    monkeypatch.setattr(
        projects, "load_project_config_file_from_state_dir", fake_load_config
    )

    await asyncio.gather(*(projects._summary_for_record(record) for record in records))

    assert peak == 2


@pytest.mark.asyncio
async def test_cancelled_project_summary_keeps_limiter_token_until_worker_finishes(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from novelvideo.api.routes import projects

    first_record = _project_record(tmp_path, "first")
    second_record = _project_record(tmp_path, "second")
    first_entered = threading.Event()
    second_entered = threading.Event()
    release_first = threading.Event()

    def fake_load_config(state_dir: str) -> dict:
        if Path(state_dir).name == "first":
            first_entered.set()
            release_first.wait(timeout=1)
        else:
            second_entered.set()
        return {}

    limiter = anyio.CapacityLimiter(1)
    limiter_var = projects.RunVar("test_project_summary_limiter")
    limiter_var.set(limiter)
    monkeypatch.setattr(
        projects,
        "_project_summary_limiter_var",
        limiter_var,
    )
    monkeypatch.setattr(projects, "is_record_home_node", lambda _record: True)
    monkeypatch.setattr(
        projects, "load_project_config_file_from_state_dir", fake_load_config
    )

    first_task = asyncio.create_task(projects._summary_for_record(first_record))
    while not first_entered.is_set():
        await asyncio.sleep(0)

    second_task = asyncio.create_task(projects._summary_for_record(second_record))

    async def wait_until_second_task_is_queued() -> None:
        while limiter.statistics().tasks_waiting != 1:
            await asyncio.sleep(0)

    await asyncio.wait_for(wait_until_second_task_is_queued(), timeout=1)
    assert limiter.statistics().borrowed_tokens == 1

    first_task.cancel()
    cancellation_delivered = asyncio.Event()
    asyncio.get_running_loop().call_soon(cancellation_delivered.set)
    await cancellation_delivered.wait()

    assert not first_task.done()
    assert limiter.statistics().borrowed_tokens == 1
    assert limiter.statistics().tasks_waiting == 1
    assert not second_entered.is_set()

    release_first.set()
    with pytest.raises(asyncio.CancelledError):
        await first_task
    await second_task
    assert second_entered.is_set()


@pytest.mark.asyncio
async def test_project_summary_preserves_anyio_cancel_scope_marker(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from novelvideo.api.routes import projects

    record = _project_record(tmp_path)
    worker_entered = threading.Event()
    release_worker = threading.Event()

    def fake_load_config(_state_dir: str) -> dict:
        worker_entered.set()
        release_worker.wait(timeout=1)
        return {}

    async def cancel_and_release(scope: anyio.CancelScope) -> None:
        while not worker_entered.is_set():
            await asyncio.sleep(0)
        scope.cancel()
        await asyncio.sleep(0)
        release_worker.set()

    monkeypatch.setattr(projects, "is_record_home_node", lambda _record: True)
    monkeypatch.setattr(
        projects, "load_project_config_file_from_state_dir", fake_load_config
    )

    with anyio.CancelScope() as scope:
        canceller = asyncio.create_task(cancel_and_release(scope))
        await projects._summary_for_record(record)
    await canceller

    assert scope.cancel_called


@pytest.mark.asyncio
async def test_list_project_summaries_runs_blocking_summaries_concurrently_in_record_order(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from novelvideo.api.routes import projects
    from novelvideo.api.schemas import ProjectSummary

    records = [_project_record(tmp_path, f"demo-{index}") for index in range(3)]
    all_started = asyncio.Event()
    started: list[str] = []

    class FakeRegistry:
        async def list_accessible_projects(self, _principals):
            return records

    class FakeAccess:
        async def resolve_requester_principals(self, _user_id):
            return []

        async def effective_project_role(self, _record, _principals):
            return "viewer"

    async def fake_user_id(_user):
        return "user-1"

    async def fake_summary(record: ProjectRecord, *, effective_role: str = ""):
        started.append(record.id)
        if len(started) == len(records):
            all_started.set()
        await all_started.wait()
        return ProjectSummary(
            id=record.id,
            name=record.name,
            owner_type=record.owner_type,
            owner_id=record.owner_id,
            owner_username=record.owner_username,
            effective_role=effective_role,
            home_node_id=record.home_node_id,
            status=record.status,
        )

    monkeypatch.setattr(projects, "user_id_from_api_user", fake_user_id)
    monkeypatch.setattr(projects, "get_project_access", lambda: FakeAccess())
    monkeypatch.setattr(projects, "get_project_registry", lambda: FakeRegistry())
    monkeypatch.setattr(projects, "_summary_for_record", fake_summary)

    response = await asyncio.wait_for(
        projects.list_project_summaries(status="all", user={"username": "alice"}),
        timeout=1,
    )

    assert [row["id"] for row in response["data"]] == [record.id for record in records]
