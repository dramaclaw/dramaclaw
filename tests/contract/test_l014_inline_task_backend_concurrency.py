import asyncio
import os
import signal
import sys
import textwrap
import threading
import time
from pathlib import Path

import pytest

from novelvideo.ports import registry
from novelvideo.ports.local.tasks import InlineTaskBackend, InMemoryCancellationStore
from novelvideo.project_context import ProjectContext
from novelvideo.generators import tts_generator, video_composer, video_generator
from novelvideo.generators.tts_generator import EdgeTTSGenerator, MockTTSGenerator
from novelvideo.generators.video_composer import SceneAsset, VideoComposer
from novelvideo.generators.video_generator import MockVideoGenerator
from novelvideo.task_backend.cancel import TaskCancelled, TaskTimedOut, raise_if_envelope_cancel_requested
from novelvideo.task_backend.limits import global_lane_concurrency
from novelvideo.task_backend.registry import register_project_task_runner
from novelvideo.task_backend.subprocesses import (
    active_subprocess_count,
    kill_task_processes,
    run_project_subprocess,
)
from novelvideo.task_state import TaskStateManager


pytestmark = pytest.mark.m07


def _ctx(tmp_path: Path, project_id: str = "proj_l014", requester: str = "editor_1") -> ProjectContext:
    return ProjectContext(
        project_id=project_id,
        project_name=project_id,
        owner_type="user",
        owner_id="owner_1",
        owner_username="alice",
        requester_user_id=requester,
        requester_username=requester,
        requester_principals=(("user", requester),),
        effective_role="editor",
        home_node_id="node_l014",
        output_dir=tmp_path / "output" / project_id,
        state_dir=tmp_path / "state" / project_id,
        runtime_dir=tmp_path / "runtime" / project_id,
        is_home_node=True,
    )


@pytest.fixture(autouse=True)
def _task_ports(monkeypatch):
    manager = TaskStateManager()
    monkeypatch.setattr(registry, "_PORTS", dict(registry._PORTS))
    registry.register_port("cancellation_store", InMemoryCancellationStore())
    monkeypatch.setattr("novelvideo.task_state._task_manager", manager)
    monkeypatch.setattr("novelvideo.ports.local.tasks.get_task_manager", lambda: manager)
    return manager


async def _wait_for_status(manager, ctx, task_type: str, status: str, *, episode: int = 1, timeout: float = 3.0):
    deadline = time.monotonic() + timeout
    observed = None
    while time.monotonic() < deadline:
        observed = manager.get_task_for_project(ctx, task_type, episode)
        if observed is not None and observed.status == status:
            return observed
        await asyncio.sleep(0.02)
    assert observed is not None
    assert observed.status == status
    return observed


def _pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


async def _wait_until_dead(pid: int, *, timeout: float = 3.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if not _pid_alive(pid):
            return True
        await asyncio.sleep(0.02)
    return not _pid_alive(pid)


async def _wait_lane_idle(backend: InlineTaskBackend, lane: str, *, timeout: float = 3.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if backend.lane_snapshot()[lane]["active"] == 0:
            return
        await asyncio.sleep(0.02)
    assert backend.lane_snapshot()[lane]["active"] == 0


def _spawn_tree_script(tmp_path: Path) -> tuple[Path, Path]:
    pidfile = tmp_path / "process-tree.pid"
    script = tmp_path / "spawn_tree.py"
    script.write_text(
        textwrap.dedent(
            f"""
            import pathlib
            import subprocess
            import sys
            import time

            child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
            pathlib.Path({str(pidfile)!r}).write_text(str(child.pid), encoding="utf-8")
            child.wait()
            time.sleep(30)
            """
        ),
        encoding="utf-8",
    )
    return script, pidfile


@pytest.mark.asyncio
async def test_gate1_cooperative_cancel_releases_lane_without_outer_task_cancel(_task_ports, tmp_path):
    ctx = _ctx(tmp_path)
    backend = InlineTaskBackend()
    started = threading.Event()
    observed_cancel = threading.Event()
    finished = threading.Event()
    task_type = "l014_gate1_cooperative_cancel"

    def runner(envelope, run_ctx):
        started.set()
        try:
            while True:
                raise_if_envelope_cancel_requested(envelope)
                time.sleep(0.02)
        except TaskCancelled:
            observed_cancel.set()
            raise
        finally:
            finished.set()

    register_project_task_runner(task_type, runner)

    queued = await backend.enqueue_project_task(ctx, task_type=task_type, episode=1, queue_kind="world")
    assert await asyncio.to_thread(started.wait, 3) is True

    await backend.cancel_project_task(ctx, queued.task_state)

    assert await asyncio.to_thread(observed_cancel.wait, 3) is True
    await _wait_for_status(_task_ports, ctx, task_type, "cancelled")
    assert await asyncio.to_thread(finished.wait, 3) is True
    await _wait_lane_idle(backend, "world")


@pytest.mark.asyncio
async def test_gate2_cancel_kills_registered_process_group_and_unregisters_handle(_task_ports, tmp_path):
    ctx = _ctx(tmp_path)
    backend = InlineTaskBackend()
    script, pidfile = _spawn_tree_script(tmp_path)
    started = threading.Event()
    task_type = "l014_gate2_cancel_kills_process_group"

    def runner(envelope, run_ctx):
        started.set()
        run_project_subprocess(
            [sys.executable, str(script)],
            envelope=envelope,
            capture_output=True,
            text=True,
            timeout=30,
        )
        return {"ok": True}

    register_project_task_runner(task_type, runner)

    queued = await backend.enqueue_project_task(ctx, task_type=task_type, episode=1, queue_kind="ffmpeg")
    assert await asyncio.to_thread(started.wait, 3) is True
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline and not pidfile.exists():
        await asyncio.sleep(0.02)
    assert pidfile.exists()
    child_pid = int(pidfile.read_text(encoding="utf-8"))
    assert active_subprocess_count(queued.task_state.task_id) == 1

    await backend.cancel_project_task(ctx, queued.task_state)

    await _wait_for_status(_task_ports, ctx, task_type, "cancelled")
    assert await _wait_until_dead(child_pid)
    # Unregistration happens asynchronously in the runner thread after proc.communicate(),
    # so poll for the handle to drain rather than asserting a single instant.
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline and active_subprocess_count(queued.task_state.task_id) != 0:
        await asyncio.sleep(0.02)
    assert active_subprocess_count(queued.task_state.task_id) == 0
    await _wait_lane_idle(backend, "ffmpeg")


@pytest.mark.asyncio
async def test_gate2_deadline_kills_process_group_and_marks_failed(monkeypatch, _task_ports, tmp_path):
    monkeypatch.setenv("ST_PROJECT_TASK_TIMEOUT_S", "1")
    ctx = _ctx(tmp_path)
    backend = InlineTaskBackend()
    script, pidfile = _spawn_tree_script(tmp_path)
    task_type = "l014_gate2_deadline_kills_process_group"

    def runner(envelope, run_ctx):
        run_project_subprocess(
            [sys.executable, str(script)],
            envelope=envelope,
            capture_output=True,
            text=True,
            timeout=30,
        )
        return {"ok": True}

    register_project_task_runner(task_type, runner)

    queued = await backend.enqueue_project_task(ctx, task_type=task_type, episode=1, queue_kind="world")
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline and not pidfile.exists():
        await asyncio.sleep(0.02)
    assert pidfile.exists()
    child_pid = int(pidfile.read_text(encoding="utf-8"))

    failed = await _wait_for_status(_task_ports, ctx, task_type, "failed", timeout=4)

    assert failed.metadata is not None
    assert failed.metadata["error_code"] == "TASK_TIMEOUT"
    assert await _wait_until_dead(child_pid)
    assert active_subprocess_count(queued.task_state.task_id) == 0
    await _wait_lane_idle(backend, "world")


@pytest.mark.asyncio
async def test_gate2_external_kill_reclassifies_running_subprocess_as_cancelled(tmp_path):
    script = tmp_path / "sleep.py"
    script.write_text("import time\ntime.sleep(30)\n", encoding="utf-8")
    task_id = "l014_external_kill_cancel"
    result: dict[str, object] = {}

    def run_subprocess():
        try:
            run_project_subprocess(
                [sys.executable, str(script)],
                envelope={
                    "project_id": "proj_l014",
                    "task_type": "external_kill",
                    "episode": 1,
                    "__run_task_id": task_id,
                },
                capture_output=True,
                text=True,
                timeout=30,
                poll_seconds=5,
            )
        except BaseException as exc:  # noqa: BLE001 - test records control-flow exception type
            result["exc"] = exc

    thread = threading.Thread(target=run_subprocess)
    thread.start()
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline and active_subprocess_count(task_id) == 0:
        await asyncio.sleep(0.02)
    assert active_subprocess_count(task_id) == 1

    assert kill_task_processes(task_id) == 1

    thread.join(timeout=3)
    assert not thread.is_alive()
    assert isinstance(result.get("exc"), TaskCancelled)
    assert active_subprocess_count(task_id) == 0


@pytest.mark.asyncio
async def test_gate2_control_signals_are_not_swallowed_by_generator_fallbacks(monkeypatch, tmp_path):
    def raise_cancelled(*args, **kwargs):
        raise TaskCancelled()

    monkeypatch.setattr(tts_generator, "run_project_subprocess", raise_cancelled)
    monkeypatch.setattr(video_generator, "_run_video_subprocess", raise_cancelled)
    monkeypatch.setattr(video_composer, "_run_video_subprocess", raise_cancelled)

    with pytest.raises(TaskCancelled):
        await EdgeTTSGenerator()._get_audio_duration(str(tmp_path / "voice.mp3"))

    with pytest.raises(TaskCancelled):
        await MockTTSGenerator().generate("hello", str(tmp_path / "mock.mp3"))

    with pytest.raises(TaskCancelled):
        await MockVideoGenerator().generate(
            image_path=str(tmp_path / "frame.png"),
            prompt="move",
            output_path=str(tmp_path / "mock.mp4"),
        )

    scene = SceneAsset(
        scene_number=1,
        image_path=str(tmp_path / "frame.png"),
        audio_path=str(tmp_path / "voice.mp3"),
        duration_seconds=1.0,
    )
    with pytest.raises(TaskCancelled):
        await VideoComposer()._create_scene_video(scene, str(tmp_path / "scene.mp4"))


@pytest.mark.asyncio
async def test_gate2_timeout_signals_are_not_swallowed_by_generator_fallbacks(monkeypatch, tmp_path):
    def raise_timeout(*args, **kwargs):
        raise TaskTimedOut(timeout_seconds=1)

    monkeypatch.setattr(tts_generator, "run_project_subprocess", raise_timeout)
    monkeypatch.setattr(video_generator, "_run_video_subprocess", raise_timeout)
    monkeypatch.setattr(video_composer, "_run_video_subprocess", raise_timeout)

    with pytest.raises(TaskTimedOut):
        await EdgeTTSGenerator()._get_audio_duration(str(tmp_path / "voice.mp3"))

    with pytest.raises(TaskTimedOut):
        await MockTTSGenerator().generate("hello", str(tmp_path / "mock.mp3"))

    with pytest.raises(TaskTimedOut):
        await MockVideoGenerator().generate(
            image_path=str(tmp_path / "frame.png"),
            prompt="move",
            output_path=str(tmp_path / "mock.mp4"),
        )

    scene = SceneAsset(
        scene_number=1,
        image_path=str(tmp_path / "frame.png"),
        audio_path=str(tmp_path / "voice.mp3"),
        duration_seconds=1.0,
    )
    with pytest.raises(TaskTimedOut):
        await VideoComposer()._create_scene_video(scene, str(tmp_path / "scene.mp4"))


@pytest.mark.asyncio
async def test_gate3_world_lane_saturation_does_not_starve_default_lane(
    monkeypatch,
    _task_ports,
    tmp_path,
):
    monkeypatch.setenv("ST_CE_GLOBAL_MAX_ACTIVE_WORLD_TASKS", "1")
    monkeypatch.setenv("ST_CE_GLOBAL_MAX_ACTIVE_DEFAULT_TASKS", "1")
    ctx = _ctx(tmp_path)
    backend = InlineTaskBackend()
    world_release = threading.Event()
    default_done = threading.Event()

    def world_runner(envelope, run_ctx):
        world_release.wait(timeout=3)
        return {"ok": True}

    def default_runner(envelope, run_ctx):
        default_done.set()
        return {"ok": True}

    register_project_task_runner("l014_gate3_world_blocker", world_runner)
    register_project_task_runner("l014_gate3_default_fast", default_runner)

    await backend.enqueue_project_task(ctx, task_type="l014_gate3_world_blocker", episode=1, queue_kind="world")
    await _wait_for_status(_task_ports, ctx, "l014_gate3_world_blocker", "running")
    await backend.enqueue_project_task(ctx, task_type="l014_gate3_default_fast", episode=1, queue_kind="default")

    assert await asyncio.to_thread(default_done.wait, 1) is True
    await _wait_for_status(_task_ports, ctx, "l014_gate3_default_fast", "completed")
    assert backend.lane_snapshot()["world"]["active"] == 1
    world_release.set()


@pytest.mark.asyncio
async def test_gate3_same_lane_overflow_is_explicitly_queued_and_cancelable(
    monkeypatch,
    _task_ports,
    tmp_path,
):
    monkeypatch.setenv("ST_CE_GLOBAL_MAX_ACTIVE_WORLD_TASKS", "1")
    monkeypatch.setenv("ST_PROJECT_MAX_ACTIVE_WORLD_TASKS", "5")
    monkeypatch.setenv("ST_PROJECT_USER_MAX_ACTIVE_WORLD_TASKS", "5")
    ctx = _ctx(tmp_path)
    backend = InlineTaskBackend()
    release = threading.Event()
    started = []

    def runner(envelope, run_ctx):
        started.append(envelope["task_type"])
        release.wait(timeout=3)
        return {"ok": True}

    register_project_task_runner("l014_gate3_world_running", runner)
    register_project_task_runner("l014_gate3_world_queued", runner)

    await backend.enqueue_project_task(ctx, task_type="l014_gate3_world_running", episode=1, queue_kind="world")
    queued = await backend.enqueue_project_task(ctx, task_type="l014_gate3_world_queued", episode=1, queue_kind="world")

    await _wait_for_status(_task_ports, ctx, "l014_gate3_world_running", "running")
    pending = _task_ports.get_task_for_project(ctx, "l014_gate3_world_queued", 1)
    assert pending is not None
    assert pending.status == "queued"
    assert backend.lane_snapshot()["world"] == {"active": 1, "queued": 1, "concurrency": 1}

    await backend.cancel_project_task(ctx, queued.task_state)

    await _wait_for_status(_task_ports, ctx, "l014_gate3_world_queued", "cancelled")
    assert backend.lane_snapshot()["world"]["queued"] == 0
    assert "l014_gate3_world_queued" not in started
    release.set()


@pytest.mark.asyncio
async def test_gate3_global_lane_queue_overflow_raises_typed_limit_exception(
    monkeypatch,
    _task_ports,
    tmp_path,
):
    monkeypatch.setenv("ST_CE_GLOBAL_MAX_ACTIVE_WORLD_TASKS", "1")
    monkeypatch.setenv("ST_CE_GLOBAL_MAX_QUEUED_WORLD_TASKS", "1")
    monkeypatch.setenv("ST_PROJECT_MAX_ACTIVE_WORLD_TASKS", "5")
    monkeypatch.setenv("ST_PROJECT_USER_MAX_ACTIVE_WORLD_TASKS", "5")
    ctx = _ctx(tmp_path)
    backend = InlineTaskBackend()
    release = threading.Event()

    def runner(envelope, run_ctx):
        release.wait(timeout=3)
        return {"ok": True}

    register_project_task_runner("l014_gate3_world_running_overflow", runner)
    register_project_task_runner("l014_gate3_world_queued_overflow", runner)
    register_project_task_runner("l014_gate3_world_rejected_overflow", runner)
    from novelvideo.task_backend.limits import GlobalLaneQueueLimitExceeded

    await backend.enqueue_project_task(
        ctx,
        task_type="l014_gate3_world_running_overflow",
        episode=1,
        queue_kind="world",
    )
    await _wait_for_status(_task_ports, ctx, "l014_gate3_world_running_overflow", "running")
    await backend.enqueue_project_task(
        ctx,
        task_type="l014_gate3_world_queued_overflow",
        episode=1,
        queue_kind="world",
    )

    with pytest.raises(GlobalLaneQueueLimitExceeded) as exc_info:
        await backend.enqueue_project_task(
            ctx,
            task_type="l014_gate3_world_rejected_overflow",
            episode=1,
            queue_kind="world",
        )

    exc = exc_info.value
    assert exc.project_id == ctx.project_id
    assert exc.queue_kind == "world"
    assert exc.limit == 1
    assert exc.queued == 1
    rejected = _task_ports.get_task_for_project(ctx, "l014_gate3_world_rejected_overflow", 1)
    assert rejected is not None
    assert rejected.status == "failed"
    release.set()


def test_gate3_global_lane_queue_limit_exception_maps_to_http_429():
    from fastapi.testclient import TestClient

    from novelvideo.api.app import create_app
    from novelvideo.task_backend.limits import GlobalLaneQueueLimitExceeded

    app = create_app()

    @app.get("/_test/global-lane-limit")
    async def _raise_global_lane_limit():
        raise GlobalLaneQueueLimitExceeded(
            project_id="proj_l014",
            queue_kind="world",
            limit=1,
            queued=1,
        )

    response = TestClient(app).get("/_test/global-lane-limit")

    assert response.status_code == 429
    body = response.json()
    assert body["ok"] is False
    assert body["data"] == {
        "project_id": "proj_l014",
        "queue_kind": "world",
        "limit": 1,
        "queued": 1,
        "limit_scope": "global_lane_queue",
    }


@pytest.mark.asyncio
async def test_gate3_lane_scheduler_uses_independent_global_concurrency_config(monkeypatch):
    monkeypatch.setenv("ST_PROJECT_MAX_ACTIVE_WORLD_TASKS", "5")
    monkeypatch.setenv("ST_CE_GLOBAL_MAX_ACTIVE_WORLD_TASKS", "1")

    assert global_lane_concurrency("world") == 1


@pytest.mark.asyncio
async def test_gate3_multi_project_lane_dispatch_is_project_fair_fifo(
    monkeypatch,
    _task_ports,
    tmp_path,
):
    monkeypatch.setenv("ST_CE_GLOBAL_MAX_ACTIVE_WORLD_TASKS", "1")
    monkeypatch.setenv("ST_PROJECT_MAX_ACTIVE_WORLD_TASKS", "5")
    monkeypatch.setenv("ST_PROJECT_USER_MAX_ACTIVE_WORLD_TASKS", "5")
    backend = InlineTaskBackend()
    ctx_a = _ctx(tmp_path, "proj_l014_a", requester="editor_a")
    ctx_b = _ctx(tmp_path, "proj_l014_b", requester="editor_b")
    release_first = threading.Event()
    run_order: list[str] = []

    def runner(envelope, run_ctx):
        run_order.append(envelope["project_id"])
        if envelope["project_id"] == ctx_a.project_id and len(run_order) == 1:
            release_first.wait(timeout=3)
        return {"ok": True}

    register_project_task_runner("l014_gate3_a1", runner)
    register_project_task_runner("l014_gate3_a2", runner)
    register_project_task_runner("l014_gate3_b1", runner)

    await backend.enqueue_project_task(ctx_a, task_type="l014_gate3_a1", episode=1, queue_kind="world")
    await _wait_for_status(_task_ports, ctx_a, "l014_gate3_a1", "running")
    await backend.enqueue_project_task(ctx_a, task_type="l014_gate3_a2", episode=1, queue_kind="world")
    await backend.enqueue_project_task(ctx_b, task_type="l014_gate3_b1", episode=1, queue_kind="world")

    assert backend.lane_snapshot()["world"]["queued"] == 2
    release_first.set()

    await _wait_for_status(_task_ports, ctx_b, "l014_gate3_b1", "completed")
    await _wait_for_status(_task_ports, ctx_a, "l014_gate3_a2", "completed")
    assert run_order[:3] == [ctx_a.project_id, ctx_b.project_id, ctx_a.project_id]
