import asyncio
import os
import runpy
import signal
import sys
import textwrap
import threading
import time
from pathlib import Path
from types import SimpleNamespace

import pytest

from novelvideo.ports import registry
from novelvideo.ports.local.tasks import InlineTaskBackend, InMemoryCancellationStore
from novelvideo.project_context import ProjectContext
from novelvideo.generators import tts_generator, video_composer, video_generator
from novelvideo.generators.tts_generator import EdgeTTSGenerator, MockTTSGenerator
from novelvideo.generators.video_composer import SceneAsset, VideoComposer
from novelvideo.generators.video_generator import MockVideoGenerator
from novelvideo.task_backend import registry as task_backend_registry
from novelvideo.task_backend import run_core
from novelvideo.task_backend.cancel import (
    TaskCancelled,
    TaskTimedOut,
    raise_if_envelope_cancel_requested,
)
from novelvideo.task_backend.limits import global_lane_concurrency
from novelvideo.task_backend.registry import register_project_task_runner
from novelvideo.task_backend.subprocesses import (
    active_subprocess_count,
    kill_task_processes,
    run_project_subprocess,
)
from novelvideo.task_state import LANE_EXEMPT_TASK_TYPES, TaskStateManager

pytestmark = pytest.mark.m07

def _ctx(
    tmp_path: Path, project_id: str = "proj_l014", requester: str = "editor_1"
) -> ProjectContext:
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
    monkeypatch.setattr(
        "novelvideo.ports.local.tasks.get_task_manager", lambda: manager
    )
    return manager


async def _wait_for_status(
    manager, ctx, task_type: str, status: str, *, episode: int = 1, timeout: float = 3.0
):
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
    if os.name == "nt":
        # os.kill(pid, 0) is not a liveness probe on Windows (WinError 87).
        import ctypes

        PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
        STILL_ACTIVE = 259
        kernel32 = ctypes.windll.kernel32
        handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
        if not handle:
            return False
        try:
            code = ctypes.c_ulong()
            if not kernel32.GetExitCodeProcess(handle, ctypes.byref(code)):
                return False
            return code.value == STILL_ACTIVE
        finally:
            kernel32.CloseHandle(handle)
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


async def _wait_lane_idle(
    backend: InlineTaskBackend, lane: str, *, timeout: float = 3.0
) -> None:
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
        textwrap.dedent(f"""
            import pathlib
            import subprocess
            import sys
            import time

            child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
            pidfile = pathlib.Path({str(pidfile)!r})
            pending_pidfile = pidfile.with_suffix(".tmp")
            pending_pidfile.write_text(str(child.pid), encoding="utf-8")
            pending_pidfile.replace(pidfile)
            child.wait()
            time.sleep(30)
            """),
        encoding="utf-8",
    )
    return script, pidfile


def test_process_tree_pid_is_published_only_after_write(tmp_path, monkeypatch):
    script, pidfile = _spawn_tree_script(tmp_path)
    original_write_text = Path.write_text
    writes = []

    def write_with_observable_empty_file(path, data, *args, **kwargs):
        # Model the window between opening a file with truncation and writing
        # its contents. Readers must not see the final PID path in this window.
        path.touch()
        assert not pidfile.exists()
        result = original_write_text(path, data, *args, **kwargs)
        assert not pidfile.exists()
        writes.append(path)
        return result

    monkeypatch.setattr(Path, "write_text", write_with_observable_empty_file)
    monkeypatch.setattr(
        "subprocess.Popen",
        lambda *_args, **_kwargs: SimpleNamespace(pid=12345, wait=lambda: None),
    )
    monkeypatch.setattr(time, "sleep", lambda _seconds: None)

    runpy.run_path(str(script), run_name="__main__")

    assert len(writes) == 1
    assert pidfile.read_text(encoding="utf-8") == "12345"
    assert not writes[0].exists()


@pytest.mark.asyncio
async def test_gate1_cooperative_cancel_releases_lane_without_outer_task_cancel(
    _task_ports, signed_inline_backend, tmp_path
):
    ctx = _ctx(tmp_path)
    backend = signed_inline_backend()
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

    queued = await backend.enqueue_project_task(
        ctx,
        task_type=task_type,
        product_surface="mainline",
        episode=1,
        queue_kind="world",
    )
    assert await asyncio.to_thread(started.wait, 3) is True

    await backend.cancel_project_task(ctx, queued.task_state)

    assert await asyncio.to_thread(observed_cancel.wait, 3) is True
    await _wait_for_status(_task_ports, ctx, task_type, "cancelled")
    assert await asyncio.to_thread(finished.wait, 3) is True
    await _wait_lane_idle(backend, "world")


@pytest.mark.asyncio
async def test_gate2_cancel_kills_registered_process_group_and_unregisters_handle(
    _task_ports, signed_inline_backend, tmp_path
):
    ctx = _ctx(tmp_path)
    backend = signed_inline_backend()
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

    queued = await backend.enqueue_project_task(
        ctx,
        task_type=task_type,
        product_surface="mainline",
        episode=1,
        queue_kind="ffmpeg",
    )
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
    while (
        time.monotonic() < deadline
        and active_subprocess_count(queued.task_state.task_id) != 0
    ):
        await asyncio.sleep(0.02)
    assert active_subprocess_count(queued.task_state.task_id) == 0
    await _wait_lane_idle(backend, "ffmpeg")


@pytest.mark.asyncio
async def test_gate2_deadline_kills_process_group_and_marks_failed(
    monkeypatch, _task_ports, signed_inline_backend, tmp_path
):
    monkeypatch.setenv("ST_PROJECT_TASK_TIMEOUT_S", "1")
    ctx = _ctx(tmp_path)
    backend = signed_inline_backend()
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

    queued = await backend.enqueue_project_task(
        ctx,
        task_type=task_type,
        product_surface="mainline",
        episode=1,
        queue_kind="world",
    )
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
async def test_gate2_external_kill_reclassifies_running_subprocess_as_cancelled(
    tmp_path,
):
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
        except (
            BaseException
        ) as exc:  # noqa: BLE001 - test records control-flow exception type
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
async def test_gate2_control_signals_are_not_swallowed_by_generator_fallbacks(
    monkeypatch, tmp_path
):
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
async def test_gate2_timeout_signals_are_not_swallowed_by_generator_fallbacks(
    monkeypatch, tmp_path
):
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
    signed_inline_backend,
    tmp_path,
):
    monkeypatch.setenv("ST_CE_GLOBAL_MAX_ACTIVE_WORLD_TASKS", "1")
    monkeypatch.setenv("ST_CE_GLOBAL_MAX_ACTIVE_DEFAULT_TASKS", "1")
    ctx = _ctx(tmp_path)
    backend = signed_inline_backend()
    world_release = threading.Event()
    world_started = threading.Event()
    default_done = threading.Event()

    def world_runner(envelope, run_ctx):
        world_started.set()
        # Hold the lane until the assertion finishes, not a short CI timing window.
        if not world_release.wait(timeout=30):
            raise TimeoutError("test did not release the world lane")
        return {"ok": True}

    def default_runner(envelope, run_ctx):
        default_done.set()
        return {"ok": True}

    register_project_task_runner("l014_gate3_world_blocker", world_runner)
    register_project_task_runner("l014_gate3_default_fast", default_runner)

    try:
        await backend.enqueue_project_task(
            ctx,
            task_type="l014_gate3_world_blocker",
            product_surface="mainline",
            episode=1,
            queue_kind="world",
        )
        assert await asyncio.to_thread(world_started.wait, 10) is True
        await backend.enqueue_project_task(
            ctx,
            task_type="l014_gate3_default_fast",
            product_surface="mainline",
            episode=1,
            queue_kind="default",
        )

        assert await asyncio.to_thread(default_done.wait, 10) is True
        await _wait_for_status(
            _task_ports, ctx, "l014_gate3_default_fast", "completed", timeout=5
        )
        assert backend.lane_snapshot()["world"]["active"] == 1
        assert not world_release.is_set()
    finally:
        world_release.set()
        await _wait_for_status(
            _task_ports, ctx, "l014_gate3_world_blocker", "completed", timeout=5
        )


@pytest.mark.asyncio
async def test_gate3_same_lane_overflow_is_explicitly_queued_and_cancelable(
    monkeypatch,
    _task_ports,
    signed_inline_backend,
    tmp_path,
):
    monkeypatch.setenv("ST_CE_GLOBAL_MAX_ACTIVE_WORLD_TASKS", "1")
    monkeypatch.setenv("ST_PROJECT_MAX_ACTIVE_WORLD_TASKS", "5")
    monkeypatch.setenv("ST_PROJECT_USER_MAX_ACTIVE_WORLD_TASKS", "5")
    ctx = _ctx(tmp_path)
    backend = signed_inline_backend()
    release = threading.Event()
    started = []

    def runner(envelope, run_ctx):
        started.append(envelope["task_type"])
        release.wait(timeout=3)
        return {"ok": True}

    register_project_task_runner("l014_gate3_world_running", runner)
    register_project_task_runner("l014_gate3_world_queued", runner)

    await backend.enqueue_project_task(
        ctx,
        task_type="l014_gate3_world_running",
        product_surface="mainline",
        episode=1,
        queue_kind="world",
    )
    queued = await backend.enqueue_project_task(
        ctx,
        task_type="l014_gate3_world_queued",
        product_surface="mainline",
        episode=1,
        queue_kind="world",
    )

    await _wait_for_status(_task_ports, ctx, "l014_gate3_world_running", "running")
    pending = _task_ports.get_task_for_project(ctx, "l014_gate3_world_queued", 1)
    assert pending is not None
    assert pending.status == "queued"
    assert backend.lane_snapshot()["world"] == {
        "active": 1,
        "queued": 1,
        "concurrency": 1,
    }

    await backend.cancel_project_task(ctx, queued.task_state)

    await _wait_for_status(_task_ports, ctx, "l014_gate3_world_queued", "cancelled")
    assert backend.lane_snapshot()["world"]["queued"] == 0
    assert "l014_gate3_world_queued" not in started
    release.set()
    await asyncio.gather(*backend._background_tasks)


@pytest.mark.asyncio
async def test_gate3_global_lane_queue_overflow_raises_typed_limit_exception(
    monkeypatch,
    _task_ports,
    signed_inline_backend,
    tmp_path,
):
    monkeypatch.setenv("ST_CE_GLOBAL_MAX_ACTIVE_WORLD_TASKS", "1")
    monkeypatch.setenv("ST_CE_GLOBAL_MAX_QUEUED_WORLD_TASKS", "1")
    monkeypatch.setenv("ST_PROJECT_MAX_ACTIVE_WORLD_TASKS", "5")
    monkeypatch.setenv("ST_PROJECT_USER_MAX_ACTIVE_WORLD_TASKS", "5")
    ctx = _ctx(tmp_path)
    backend = signed_inline_backend()
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
        product_surface="mainline",
        episode=1,
        queue_kind="world",
    )
    await _wait_for_status(
        _task_ports, ctx, "l014_gate3_world_running_overflow", "running"
    )
    await backend.enqueue_project_task(
        ctx,
        task_type="l014_gate3_world_queued_overflow",
        product_surface="mainline",
        episode=1,
        queue_kind="world",
    )

    with pytest.raises(GlobalLaneQueueLimitExceeded) as exc_info:
        await backend.enqueue_project_task(
            ctx,
            task_type="l014_gate3_world_rejected_overflow",
            product_surface="mainline",
            episode=1,
            queue_kind="world",
        )

    exc = exc_info.value
    assert exc.project_id == ctx.project_id
    assert exc.queue_kind == "world"
    assert exc.limit == 1
    assert exc.queued == 1
    rejected = _task_ports.get_task_for_project(
        ctx, "l014_gate3_world_rejected_overflow", 1
    )
    assert rejected is not None
    assert rejected.status == "failed"
    release.set()
    await asyncio.gather(*backend._background_tasks)


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
async def test_gate3_lane_scheduler_uses_independent_global_concurrency_config(
    monkeypatch,
):
    monkeypatch.setenv("ST_PROJECT_MAX_ACTIVE_WORLD_TASKS", "5")
    monkeypatch.setenv("ST_CE_GLOBAL_MAX_ACTIVE_WORLD_TASKS", "1")

    assert global_lane_concurrency("world") == 1


@pytest.mark.asyncio
async def test_gate3_multi_project_lane_dispatch_is_project_fair_fifo(
    monkeypatch,
    _task_ports,
    signed_inline_backend,
    tmp_path,
):
    monkeypatch.setenv("ST_CE_GLOBAL_MAX_ACTIVE_WORLD_TASKS", "1")
    monkeypatch.setenv("ST_PROJECT_MAX_ACTIVE_WORLD_TASKS", "5")
    monkeypatch.setenv("ST_PROJECT_USER_MAX_ACTIVE_WORLD_TASKS", "5")
    backend = signed_inline_backend()
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

    await backend.enqueue_project_task(
        ctx_a,
        task_type="l014_gate3_a1",
        product_surface="mainline",
        episode=1,
        queue_kind="world",
    )
    await _wait_for_status(_task_ports, ctx_a, "l014_gate3_a1", "running")
    await backend.enqueue_project_task(
        ctx_a,
        task_type="l014_gate3_a2",
        product_surface="mainline",
        episode=1,
        queue_kind="world",
    )
    await backend.enqueue_project_task(
        ctx_b,
        task_type="l014_gate3_b1",
        product_surface="mainline",
        episode=1,
        queue_kind="world",
    )

    assert backend.lane_snapshot()["world"]["queued"] == 2
    release_first.set()

    await _wait_for_status(_task_ports, ctx_b, "l014_gate3_b1", "completed")
    await _wait_for_status(_task_ports, ctx_a, "l014_gate3_a2", "completed")
    assert run_order[:3] == [ctx_a.project_id, ctx_b.project_id, ctx_a.project_id]


@pytest.mark.asyncio
async def test_child_enqueued_from_lane_thread_survives_parent_loop(
    _task_ports, signed_inline_backend, tmp_path,
):
    ctx = _ctx(tmp_path)
    backend = signed_inline_backend()
    home = asyncio.get_running_loop()
    parent_returned = asyncio.Event()
    child_entered = asyncio.Event()
    release = threading.Event()
    loop_observations = []
    original_sign = backend._producer.sign_top_level

    async def sign(**kwargs):
        if kwargs['task_type'] == 'inline_child':
            loop_observations.append(asyncio.get_running_loop() is home)
        return await original_sign(**kwargs)

    backend._producer.sign_top_level = sign

    def child(envelope, run_ctx):
        home.call_soon_threadsafe(child_entered.set)
        release.wait(timeout=3)
        return {'child': 'done'}

    def parent(envelope, run_ctx):
        async def submit():
            await backend.enqueue_project_task(
                run_ctx, task_type='inline_child', product_surface='mainline',
                episode=1, queue_kind='video',
            )
        asyncio.run(submit())
        home.call_soon_threadsafe(parent_returned.set)
        return {'parent': 'done'}

    register_project_task_runner('inline_parent', parent)
    register_project_task_runner('inline_child', child)
    try:
        await backend.enqueue_project_task(
            ctx, task_type='inline_parent', product_surface='mainline', episode=1,
        )
        await asyncio.wait_for(parent_returned.wait(), 3)
        await asyncio.wait_for(child_entered.wait(), 3)
        assert loop_observations == [True]
    finally:
        release.set()
        # Drain actual home-loop jobs without sleeping or polling wall-clock time.
        while backend._background_tasks:
            await asyncio.gather(*backend._background_tasks, return_exceptions=True)
            await asyncio.sleep(0)
    assert _task_ports.get_task_for_project(ctx, 'inline_child', 1).status == 'completed'
    assert backend.lane_snapshot()['video']['active'] == 0
    assert backend.lane_snapshot()['default']['active'] == 0


@pytest.mark.asyncio
async def test_cancellation_from_lane_thread_is_forwarded_to_home_loop(
    _task_ports, signed_inline_backend, tmp_path,
):
    ctx = _ctx(tmp_path)
    backend = signed_inline_backend()
    home = asyncio.get_running_loop()
    finished = asyncio.Event()
    observed_loops = []

    class CancellationStore(InMemoryCancellationStore):
        async def request_cancel(self, **kwargs):
            observed_loops.append(asyncio.get_running_loop() is home)
            return await super().request_cancel(**kwargs)

    registry.register_port('cancellation_store', CancellationStore())
    child = _task_ports.create_task_for_project(ctx, 'inline_cancel_child', 1)

    def parent(envelope, run_ctx):
        result = asyncio.run(backend.cancel_project_task(run_ctx, child))
        assert result['status'] == 'cancelled'
        home.call_soon_threadsafe(finished.set)
        return {'parent': 'done'}

    register_project_task_runner('inline_cancel_parent', parent)
    await backend.enqueue_project_task(
        ctx, task_type='inline_cancel_parent', product_surface='mainline', episode=1,
    )
    await asyncio.wait_for(finished.wait(), 3)
    while backend._background_tasks:
        await asyncio.gather(*backend._background_tasks, return_exceptions=True)
        await asyncio.sleep(0)
    assert observed_loops == [True]
    assert _task_ports.get_task_for_project(ctx, 'inline_cancel_child', 1).status == 'cancelled'
    assert backend.lane_snapshot()['default']['active'] == 0


@pytest.mark.asyncio
async def test_closed_home_loop_is_replaced_by_the_next_serving_loop(signed_inline_backend):
    # A test client or app restart in one process can close the first serving loop.
    backend = signed_inline_backend()
    stale = asyncio.new_event_loop()
    stale.close()
    backend._home_loop = stale
    assert backend._forward_loop() is None
    assert backend._home_loop is asyncio.get_running_loop()


_ORCHESTRATION_CHILD_TIMEOUT = 3.0
_ORCHESTRATION_CHILD_TASK_TYPE = "l014_orchestration_child"


def _register_simulated_orchestration(
    monkeypatch, manager, backend, task_type, *, before_child=None, after_child=None
):
    child_starts = []
    starts_lock = threading.Lock()

    def child(envelope, run_ctx):
        with starts_lock:
            child_starts.append(run_ctx.project_id)
        return {"child": "done"}

    def orchestration(envelope, run_ctx):
        if before_child is not None:
            before_child(run_ctx)
        asyncio.run(backend.enqueue_project_task(
            run_ctx,
            task_type=_ORCHESTRATION_CHILD_TASK_TYPE,
            product_surface="mainline",
            episode=1,
            queue_kind="default",
        ))
        deadline = time.monotonic() + _ORCHESTRATION_CHILD_TIMEOUT
        while time.monotonic() < deadline:
            row = manager.get_task_for_project(run_ctx, _ORCHESTRATION_CHILD_TASK_TYPE, 1)
            if row is not None and row.status == "completed":
                if after_child is not None:
                    after_child(run_ctx)
                return {"orchestration": "done"}
            time.sleep(0.02)
        with starts_lock:
            started = len(child_starts)
        raise TimeoutError(
            f"child did not complete; child starts={started}; lanes={backend.lane_snapshot()}"
        )

    run_core._ensure_builtin_runners_registered()
    monkeypatch.setitem(task_backend_registry._PROJECT_TASK_RUNNERS, task_type, orchestration)
    register_project_task_runner(_ORCHESTRATION_CHILD_TASK_TYPE, child)
    return child_starts


async def _assert_inline_task_completed(manager, backend, ctx, task_type):
    try:
        return await _wait_for_status(
            manager, ctx, task_type, "completed", timeout=_ORCHESTRATION_CHILD_TIMEOUT + 2
        )
    except AssertionError:
        row = manager.get_task_for_project(ctx, task_type, 1)
        assert row is not None, backend.lane_snapshot()
        assert row.status == "completed", f"{row.error}; lanes={backend.lane_snapshot()}"
        return row


async def _drain_inline_jobs(backend):
    while backend._background_tasks:
        await asyncio.gather(*backend._background_tasks, return_exceptions=True)
        await asyncio.sleep(0)


@pytest.mark.asyncio
async def test_saturating_orchestrations_do_not_starve_their_children(
    monkeypatch, _task_ports, signed_inline_backend, tmp_path
):
    monkeypatch.delenv("ST_CE_GLOBAL_MAX_ACTIVE_DEFAULT_TASKS", raising=False)
    backend = signed_inline_backend()
    assert backend.lane_snapshot()["default"]["concurrency"] == 8, backend.lane_snapshot()
    all_drives_started = threading.Barrier(8)
    task_type = "freezone_workflow_drive"
    child_starts = _register_simulated_orchestration(
        monkeypatch, _task_ports, backend, task_type,
        before_child=lambda _ctx: all_drives_started.wait(timeout=_ORCHESTRATION_CHILD_TIMEOUT),
    )
    contexts = [_ctx(tmp_path, f"workflow_{i}", requester=f"requester_{i}") for i in range(8)]

    try:
        for ctx in contexts:
            await backend.enqueue_project_task(
                ctx, task_type=task_type, product_surface="mainline", episode=1,
                queue_kind="default",
            )
        for ctx in contexts:
            drive = await _assert_inline_task_completed(_task_ports, backend, ctx, task_type)
            assert drive.queue_kind == "default", backend.lane_snapshot()
            await _assert_inline_task_completed(
                _task_ports, backend, ctx, _ORCHESTRATION_CHILD_TASK_TYPE
            )
        assert len(child_starts) == 8, backend.lane_snapshot()
        assert backend.lane_snapshot()["orchestration"]["concurrency"] == (
            global_lane_concurrency("default")
        ), backend.lane_snapshot()
    finally:
        await _drain_inline_jobs(backend)


@pytest.mark.asyncio
@pytest.mark.parametrize("task_type", sorted(LANE_EXEMPT_TASK_TYPES))
async def test_single_orchestration_completes_with_one_default_slot(
    monkeypatch, _task_ports, signed_inline_backend, tmp_path, task_type
):
    monkeypatch.setenv("ST_CE_GLOBAL_MAX_ACTIVE_DEFAULT_TASKS", "1")
    backend = signed_inline_backend()
    ctx = _ctx(tmp_path, "single_workflow", requester="single_requester")
    child_starts = _register_simulated_orchestration(
        monkeypatch, _task_ports, backend, task_type
    )

    try:
        await backend.enqueue_project_task(
            ctx, task_type=task_type, product_surface="mainline", episode=1,
            queue_kind="default",
        )
        drive = await _assert_inline_task_completed(_task_ports, backend, ctx, task_type)
        assert drive.queue_kind == "default", backend.lane_snapshot()
        await _assert_inline_task_completed(
            _task_ports, backend, ctx, _ORCHESTRATION_CHILD_TASK_TYPE
        )
        assert len(child_starts) == 1, backend.lane_snapshot()
    finally:
        await _drain_inline_jobs(backend)


@pytest.mark.asyncio
async def test_orchestration_pool_has_its_own_cap(
    monkeypatch, _task_ports, signed_inline_backend, tmp_path
):
    monkeypatch.setenv("ST_CE_GLOBAL_MAX_ACTIVE_DEFAULT_TASKS", "1")
    backend = signed_inline_backend()
    ctx_a = _ctx(tmp_path, "workflow_a", requester="requester_a")
    ctx_b = _ctx(tmp_path, "workflow_b", requester="requester_b")
    ctx_c = _ctx(tmp_path, "generation_c", requester="requester_c")
    child_a_completed = threading.Event()
    release_a = threading.Event()
    task_type = "freezone_workflow_drive"
    plain_task_type = "l014_plain_default_generation"

    def hold_a(run_ctx):
        if run_ctx.project_id == ctx_a.project_id:
            child_a_completed.set()
            if not release_a.wait(timeout=_ORCHESTRATION_CHILD_TIMEOUT * 3):
                raise TimeoutError("orchestration A was not released")

    child_starts = _register_simulated_orchestration(
        monkeypatch, _task_ports, backend, task_type, after_child=hold_a
    )
    register_project_task_runner(plain_task_type, lambda _envelope, _ctx: {"plain": "done"})

    try:
        await backend.enqueue_project_task(
            ctx_a, task_type=task_type, product_surface="mainline", episode=1,
            queue_kind="default",
        )
        snapshot = backend.lane_snapshot()
        assert "orchestration" in snapshot, snapshot
        assert await asyncio.to_thread(
            child_a_completed.wait, _ORCHESTRATION_CHILD_TIMEOUT + 2
        ), backend.lane_snapshot()
        await _wait_for_status(_task_ports, ctx_a, task_type, "running")
        await backend.enqueue_project_task(
            ctx_b, task_type=task_type, product_surface="mainline", episode=1,
            queue_kind="default",
        )
        await _wait_for_status(_task_ports, ctx_b, task_type, "queued")
        snapshot = backend.lane_snapshot()
        assert snapshot["orchestration"] == {
            "active": 1, "queued": 1, "concurrency": 1,
        }, snapshot

        await backend.enqueue_project_task(
            ctx_c, task_type=plain_task_type, product_surface="mainline", episode=1,
            queue_kind="default",
        )
        await _assert_inline_task_completed(_task_ports, backend, ctx_c, plain_task_type)
        assert not release_a.is_set(), backend.lane_snapshot()
        assert _task_ports.get_task_for_project(ctx_a, task_type, 1).status == (
            "running"
        ), backend.lane_snapshot()
        assert _task_ports.get_task_for_project(ctx_b, task_type, 1).status == (
            "queued"
        ), backend.lane_snapshot()
        release_a.set()

        for ctx in (ctx_a, ctx_b):
            drive = await _assert_inline_task_completed(_task_ports, backend, ctx, task_type)
            assert drive.queue_kind == "default", backend.lane_snapshot()
            await _assert_inline_task_completed(
                _task_ports, backend, ctx, _ORCHESTRATION_CHILD_TASK_TYPE
            )
        assert len(child_starts) == 2, backend.lane_snapshot()
        await _drain_inline_jobs(backend)
        for lane in ("orchestration", "default"):
            assert backend.lane_snapshot()[lane] == {
                "active": 0, "queued": 0, "concurrency": 1,
            }, backend.lane_snapshot()
    finally:
        release_a.set()
        await _drain_inline_jobs(backend)
