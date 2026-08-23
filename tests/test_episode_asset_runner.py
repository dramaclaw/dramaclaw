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
    """A build arriving against a *queued* planner is not turned away.

    Planning refuses whenever a build is active, queued included; a build
    refuses only when planning is past the starting line. That is a preference,
    not a guarantee — each check runs inside its own task, after the backend has
    marked it running, so two tasks reaching their gates together can both
    refuse. Nothing is written either way, and retrying clears it.
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


def test_any_episodes_planner_blocks_the_build():
    """The scenes table is project-wide, so the conflict is not per episode."""
    from novelvideo.scene_prerequisites import (
        SCENE_PLANNING_RUNNING_MESSAGE,
        ScenePlanningRunningError,
        running_scene_planner,
    )

    # The task carries no episode of its own here; what matters is that the
    # predicate does not filter by one, and the message does not claim to.
    assert running_scene_planner([_planner_task("running")])
    assert "本集" not in SCENE_PLANNING_RUNNING_MESSAGE
    assert str(ScenePlanningRunningError()) == SCENE_PLANNING_RUNNING_MESSAGE


# ── a build a narrated project cannot use must not reach the queue ──────────


def test_scene_build_applies_only_where_it_can_produce_something():
    """Narrated structured projects have nothing to build a catalogue from.

    Legacy keeps the Cognee path whatever the template: its build does reach a
    model and does produce scenes, so excluding it would change what existing
    projects do.
    """
    import json
    import tempfile
    from pathlib import Path

    from novelvideo.knowledge_pipeline import (
        KNOWLEDGE_PIPELINE_KEY,
        KNOWLEDGE_PIPELINE_STRUCTURED,
    )
    from novelvideo.scene_prerequisites import scene_build_applies

    with tempfile.TemporaryDirectory() as tmp:
        structured = Path(tmp) / "structured"
        structured.mkdir()
        (structured / "project_config.json").write_text(
            json.dumps({KNOWLEDGE_PIPELINE_KEY: KNOWLEDGE_PIPELINE_STRUCTURED}),
            encoding="utf-8",
        )
        legacy = Path(tmp) / "legacy"
        legacy.mkdir()
        (legacy / "project_config.json").write_text(
            json.dumps({"user": "eric"}), encoding="utf-8"
        )

        assert scene_build_applies(str(structured), "drama")
        assert not scene_build_applies(str(structured), "narrated")
        assert scene_build_applies(str(legacy), "drama")
        assert scene_build_applies(str(legacy), "narrated")


@pytest.mark.asyncio
async def test_a_narrated_build_never_reaches_the_queue(tmp_path, monkeypatch):
    """The money path, driven rather than asserted about.

    A no-op is not free: EE resolves the billing key from task_type when the
    payload carries no explicit billing, reserves a feature credit at enqueue,
    and the runner's successful no-op then confirms the charge. So what has to
    be true is that enqueue is never called — not that a source file mentions
    the check before the call.
    """
    import json

    from novelvideo.api.routes import scenes as scenes_routes
    from novelvideo.knowledge_pipeline import (
        KNOWLEDGE_PIPELINE_KEY,
        KNOWLEDGE_PIPELINE_STRUCTURED,
    )
    from novelvideo.scene_prerequisites import SCENE_BUILD_NOT_APPLICABLE_CODE

    state_dir = tmp_path / "alice" / "demo"
    state_dir.mkdir(parents=True)
    (state_dir / "project_config.json").write_text(
        json.dumps(
            {
                KNOWLEDGE_PIPELINE_KEY: KNOWLEDGE_PIPELINE_STRUCTURED,
                "spine_template": "narrated",
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    (state_dir / "novel.txt").write_text("第一章 归来\n\n正文。\n", encoding="utf-8")

    ctx = SimpleNamespace(
        project_id="p1",
        owner_username="alice",
        project_name="demo",
        output_dir=state_dir,
        state_dir=state_dir,
    )

    enqueued: list = []

    class RecordingBackend:
        async def enqueue_project_task(self, *args, **kwargs):
            enqueued.append(kwargs)
            raise AssertionError("a narrated build must not reach the queue")

    async def _resolve(project, user, **_kwargs):
        return (ctx, "alice", "demo", state_dir, str(state_dir), object())

    monkeypatch.setattr(scenes_routes, "_resolve_scene_project", _resolve)
    monkeypatch.setattr(scenes_routes, "get_task_backend", lambda: RecordingBackend())
    monkeypatch.setattr(
        scenes_routes,
        "get_task_manager",
        lambda: SimpleNamespace(list_tasks_for_project=lambda _ctx: []),
    )

    response = await scenes_routes.build_scenes("demo", {"username": "alice"})

    assert enqueued == []
    assert response["ok"] is False
    assert response["code"] == SCENE_BUILD_NOT_APPLICABLE_CODE


@pytest.mark.asyncio
async def test_a_drama_build_still_reaches_the_queue(tmp_path, monkeypatch):
    """The guard must not turn away the projects a build does work for."""
    import json

    from novelvideo.api.routes import scenes as scenes_routes
    from novelvideo.knowledge_pipeline import (
        KNOWLEDGE_PIPELINE_KEY,
        KNOWLEDGE_PIPELINE_STRUCTURED,
    )

    state_dir = tmp_path / "alice" / "demo"
    state_dir.mkdir(parents=True)
    (state_dir / "project_config.json").write_text(
        json.dumps(
            {
                KNOWLEDGE_PIPELINE_KEY: KNOWLEDGE_PIPELINE_STRUCTURED,
                "spine_template": "drama",
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    (state_dir / "novel.txt").write_text("第1场 客厅 日 内\n", encoding="utf-8")

    ctx = SimpleNamespace(
        project_id="p1",
        owner_username="alice",
        project_name="demo",
        output_dir=state_dir,
        state_dir=state_dir,
    )
    enqueued: list = []

    class RecordingBackend:
        async def enqueue_project_task(self, *args, **kwargs):
            enqueued.append(kwargs)
            return SimpleNamespace(
                task_state=SimpleNamespace(task_id="t1"),
                backend="inline",
                queue="default",
            )

    async def _resolve(project, user, **_kwargs):
        return (ctx, "alice", "demo", state_dir, str(state_dir), object())

    monkeypatch.setattr(scenes_routes, "_resolve_scene_project", _resolve)
    monkeypatch.setattr(scenes_routes, "get_task_backend", lambda: RecordingBackend())
    monkeypatch.setattr(
        scenes_routes,
        "get_task_manager",
        lambda: SimpleNamespace(list_tasks_for_project=lambda _ctx: []),
    )

    response = await scenes_routes.build_scenes("demo", {"username": "alice"})

    assert len(enqueued) == 1
    assert enqueued[0]["task_type"] == "build_scenes"
    assert response["ok"] is True


def test_the_runner_still_defers_for_narrated():
    """Kept as the backstop for tasks queued before the route learned to say no."""
    import inspect

    from novelvideo import structured_builders

    source = inspect.getsource(structured_builders.build_scenes_structured)
    assert "episode_on_demand" in source
