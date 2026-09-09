import threading
from pathlib import Path
from types import SimpleNamespace

import pytest


class RecordingTaskManager:
    def __init__(self, task=None, tasks=None):
        self.task = task
        self.tasks = tasks or []
        self.call_thread_id = None

    def get_task_for_project(self, *_args, **_kwargs):
        self.call_thread_id = threading.get_ident()
        return self.task

    def list_tasks_for_project(self, *_args, **_kwargs):
        self.call_thread_id = threading.get_ident()
        return self.tasks

    def get_task(self, *_args, **_kwargs):
        self.call_thread_id = threading.get_ident()
        return self.task


def assert_called_off_event_loop(manager, event_loop_thread_id):
    assert manager.call_thread_id is not None
    assert manager.call_thread_id != event_loop_thread_id


@pytest.mark.asyncio
async def test_episode_scene_planner_reads_task_state_off_event_loop(monkeypatch):
    from novelvideo.api.routes import episodes

    ctx = SimpleNamespace(project_id="proj_123")
    manager = RecordingTaskManager(task=SimpleNamespace(status="running"))

    async def resolve_project_scope(*_args, **_kwargs):
        return SimpleNamespace(ctx=ctx)

    monkeypatch.setattr(episodes, "resolve_project_scope", resolve_project_scope)
    monkeypatch.setattr(episodes, "get_task_manager", lambda: manager)

    await episodes._enqueue_episode_asset_planner(
        project="proj_123",
        episode_num=1,
        asset_kind="scene",
        user={"username": "admin"},
    )

    assert_called_off_event_loop(manager, threading.get_ident())


@pytest.mark.asyncio
async def test_episode_identity_planner_reads_task_state_off_event_loop(monkeypatch):
    from novelvideo.api.routes import episodes

    ctx = SimpleNamespace(project_id="proj_123")
    manager = RecordingTaskManager(task=SimpleNamespace(status="running"))

    async def resolve_project_scope(*_args, **_kwargs):
        return SimpleNamespace(ctx=ctx)

    monkeypatch.setattr(episodes, "resolve_project_scope", resolve_project_scope)
    monkeypatch.setattr(episodes, "get_task_manager", lambda: manager)

    await episodes.plan_episode_identities(
        project="proj_123",
        episode_num=1,
        user={"username": "admin"},
    )

    assert_called_off_event_loop(manager, threading.get_ident())


@pytest.mark.asyncio
async def test_scene_build_reads_task_list_off_event_loop(monkeypatch, tmp_path: Path):
    from novelvideo.api.routes import scenes

    ctx = SimpleNamespace(project_id="proj_123", state_dir=tmp_path / "state")
    manager = RecordingTaskManager(
        tasks=[SimpleNamespace(task_type="episode_scene_planner", status="running")]
    )

    async def resolve_scene_project(*_args, **_kwargs):
        return ctx, "admin", "demo", tmp_path, tmp_path / "output", SimpleNamespace()

    monkeypatch.setattr(scenes, "_resolve_scene_project", resolve_scene_project)
    monkeypatch.setattr(scenes, "has_imported_novel", lambda _path: True)
    monkeypatch.setattr(
        scenes,
        "load_project_config_file_from_state_dir",
        lambda _path: {"spine_template": "drama"},
    )
    monkeypatch.setattr(scenes, "scene_build_applies", lambda *_args: True)
    monkeypatch.setattr(scenes, "get_task_manager", lambda: manager)

    await scenes.build_scenes(project="proj_123", user={"username": "admin"})

    assert_called_off_event_loop(manager, threading.get_ident())


@pytest.mark.asyncio
async def test_freezone_job_result_reads_task_state_off_event_loop(
    monkeypatch, tmp_path: Path
):
    from novelvideo.api.routes import freezone

    ctx = SimpleNamespace(project_id="proj_123")
    manager = RecordingTaskManager(
        task=SimpleNamespace(status="failed", error="boom", logs=[], current_task=None)
    )

    async def resolve_freezone_project(*_args, **_kwargs):
        return ctx, "admin", "demo", tmp_path, tmp_path / "output"

    monkeypatch.setattr(freezone, "_resolve_freezone_project", resolve_freezone_project)
    monkeypatch.setattr(freezone, "get_task_manager", lambda: manager)

    await freezone.freezone_job_result(
        project="proj_123",
        task_type="freezone_edit",
        job_id="job_1",
        user={"username": "admin"},
    )

    assert_called_off_event_loop(manager, threading.get_ident())


@pytest.mark.asyncio
async def test_legacy_freezone_job_result_reads_task_state_off_event_loop(
    monkeypatch, tmp_path: Path
):
    from novelvideo.api.routes import freezone

    manager = RecordingTaskManager(
        task=SimpleNamespace(status="failed", error="boom", logs=[], current_task=None)
    )

    async def resolve_freezone_project(*_args, **_kwargs):
        return None, "admin", "demo", tmp_path, tmp_path / "output"

    monkeypatch.setattr(freezone, "_resolve_freezone_project", resolve_freezone_project)
    monkeypatch.setattr(freezone, "get_task_manager", lambda: manager)

    await freezone.freezone_job_result(
        project="demo",
        task_type="freezone_edit",
        job_id="job_1",
        user={"username": "admin"},
    )

    assert_called_off_event_loop(manager, threading.get_ident())


@pytest.mark.asyncio
async def test_freezone_skill_result_reads_task_state_off_event_loop(
    monkeypatch, tmp_path: Path
):
    from novelvideo.api.routes import freezone

    ctx = SimpleNamespace(project_id="proj_123")
    manager = RecordingTaskManager(task=SimpleNamespace(status="running"))

    async def resolve_freezone_project(*_args, **_kwargs):
        return ctx, "admin", "demo", tmp_path, tmp_path / "output"

    monkeypatch.setattr(freezone, "_resolve_freezone_project", resolve_freezone_project)
    monkeypatch.setattr(
        freezone,
        "_read_skill_run_metadata",
        lambda *_args: {
            "task_type": "freezone_edit",
            "job_id": "job_1",
            "task_key": "task-key",
        },
    )
    monkeypatch.setattr(freezone, "get_task_manager", lambda: manager)

    await freezone.freezone_skill_run_result(
        project="proj_123",
        run_id="freezone_edit:job_1",
        user={"username": "admin"},
    )

    assert_called_off_event_loop(manager, threading.get_ident())


@pytest.mark.asyncio
async def test_legacy_freezone_skill_result_reads_task_state_off_event_loop(
    monkeypatch, tmp_path: Path
):
    from novelvideo.api.routes import freezone

    manager = RecordingTaskManager(task=SimpleNamespace(status="running"))

    async def resolve_freezone_project(*_args, **_kwargs):
        return None, "admin", "demo", tmp_path, tmp_path / "output"

    monkeypatch.setattr(freezone, "_resolve_freezone_project", resolve_freezone_project)
    monkeypatch.setattr(
        freezone,
        "_read_skill_run_metadata",
        lambda *_args: {
            "task_type": "freezone_edit",
            "job_id": "job_1",
            "task_key": "task-key",
        },
    )
    monkeypatch.setattr(freezone, "get_task_manager", lambda: manager)

    await freezone.freezone_skill_run_result(
        project="demo",
        run_id="freezone_edit:job_1",
        user={"username": "admin"},
    )

    assert_called_off_event_loop(manager, threading.get_ident())
