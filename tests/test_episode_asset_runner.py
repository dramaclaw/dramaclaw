from types import SimpleNamespace

import pytest


@pytest.mark.asyncio
async def test_scene_planner_runner_rechecks_active_scene_build(monkeypatch):
    from novelvideo.scene_prerequisites import SceneCatalogBuildingError
    from novelvideo.task_backend.runners import episode_assets

    class BuildingTaskManager:
        def get_task_for_project(self, *_args, **_kwargs):
            return SimpleNamespace(status="running")

    class ForbiddenUsageMeter:
        async def set_project_llm_usage_context(self, **_kwargs):
            raise AssertionError("scene build must be rejected before planner setup")

    monkeypatch.setattr(episode_assets, "get_task_manager", BuildingTaskManager)
    monkeypatch.setattr(
        episode_assets,
        "get_usage_meter",
        lambda: ForbiddenUsageMeter(),
    )

    ctx = SimpleNamespace(
        owner_username="alice",
        project_name="demo",
        owner_project_label="alice/demo",
        output_dir="/tmp/out",
        state_dir="/tmp/state",
    )
    with pytest.raises(SceneCatalogBuildingError):
        await episode_assets._run_episode_asset_planner(
            {
                "task_type": "episode_scene_planner",
                "episode": 1,
                "payload": {"episode": 1, "asset_kind": "scene"},
            },
            ctx,
        )


@pytest.mark.asyncio
async def test_prop_planner_runner_does_not_depend_on_scene_build(monkeypatch):
    from novelvideo.task_backend.runners import episode_assets

    class BuildingTaskManager:
        def get_task_for_project(self, *_args, **_kwargs):
            return SimpleNamespace(status="running")

    class StopAfterAdmissionUsageMeter:
        async def set_project_llm_usage_context(self, **_kwargs):
            raise RuntimeError("admitted")

    monkeypatch.setattr(episode_assets, "get_task_manager", BuildingTaskManager)
    monkeypatch.setattr(
        episode_assets,
        "get_usage_meter",
        lambda: StopAfterAdmissionUsageMeter(),
    )

    ctx = SimpleNamespace(owner_username="alice", project_name="demo")
    with pytest.raises(RuntimeError, match="admitted"):
        await episode_assets._run_episode_asset_planner(
            {
                "task_type": "episode_prop_planner",
                "episode": 1,
                "payload": {"episode": 1, "asset_kind": "prop"},
            },
            ctx,
        )


# ── the other direction ─────────────────────────────────────────────────────


def _planner_task(status: str, task_type: str = "episode_scene_planner"):
    return SimpleNamespace(task_type=task_type, status=status)


def test_only_a_running_planner_blocks_a_build():
    """The asymmetry is what keeps two simultaneous requests from deadlocking.

    Planning refuses whenever a build is active, queued included. A build
    refuses only when planning is already past the starting line — so a build
    and a planner submitted together resolve one way: the build proceeds and
    the planner is turned away with something to do about it.
    """
    from novelvideo.scene_prerequisites import running_scene_planner

    assert running_scene_planner([_planner_task("running")])
    assert not running_scene_planner([_planner_task("queued")])
    assert not running_scene_planner([_planner_task("submitting")])
    assert not running_scene_planner([_planner_task("completed")])
    assert not running_scene_planner([])
    assert not running_scene_planner(None)


def test_a_running_prop_planner_does_not_block_a_scene_build():
    """Only the planner that writes the scenes table is a conflict."""
    from novelvideo.scene_prerequisites import running_scene_planner

    assert not running_scene_planner([_planner_task("running", "episode_prop_planner")])


@pytest.mark.asyncio
async def test_scene_build_runner_refuses_a_running_planner(monkeypatch):
    """Both write the scenes table, so whichever landed first decided the
    catalogue: the builder can skip a row the planner just created, or the
    planner can plan against a catalogue that is still half written."""
    from novelvideo.scene_prerequisites import ScenePlanningRunningError
    from novelvideo.task_backend.runners import graph_build

    class PlanningTaskManager:
        def list_tasks_for_project(self, *_args, **_kwargs):
            return [_planner_task("running")]

    monkeypatch.setattr(
        "novelvideo.task_state.get_task_manager", lambda: PlanningTaskManager()
    )
    monkeypatch.setattr(graph_build, "require_imported_novel", lambda _dir: "正文")

    async def forbidden(_ctx):
        raise AssertionError("the build must be rejected before opening the store")

    monkeypatch.setattr(graph_build, "_load_store", forbidden)

    ctx = SimpleNamespace(
        owner_username="alice",
        project_name="demo",
        owner_project_label="alice/demo",
        output_dir="/tmp/out",
        state_dir="/tmp/state",
    )
    with pytest.raises(ScenePlanningRunningError):
        await graph_build._run_build_scenes(ctx)


@pytest.mark.asyncio
async def test_scene_build_runner_proceeds_past_a_queued_planner(monkeypatch):
    from novelvideo.task_backend.runners import graph_build

    class QueuedTaskManager:
        def list_tasks_for_project(self, *_args, **_kwargs):
            return [_planner_task("queued")]

    monkeypatch.setattr(
        "novelvideo.task_state.get_task_manager", lambda: QueuedTaskManager()
    )
    monkeypatch.setattr(graph_build, "require_imported_novel", lambda _dir: "正文")

    async def reached(_ctx):
        raise RuntimeError("admitted")

    monkeypatch.setattr(graph_build, "_load_store", reached)

    ctx = SimpleNamespace(
        owner_username="alice",
        project_name="demo",
        owner_project_label="alice/demo",
        output_dir="/tmp/out",
        state_dir="/tmp/state",
    )
    with pytest.raises(RuntimeError, match="admitted"):
        await graph_build._run_build_scenes(ctx)


def test_the_build_route_checks_before_enqueueing():
    """Guard the call site: the runner check alone still burns a queue slot."""
    import inspect

    from novelvideo.api.routes import scenes

    source = inspect.getsource(scenes.build_scenes)
    assert "running_scene_planner" in source
    assert source.index("running_scene_planner") < source.index(
        "enqueue_project_task"
    )
