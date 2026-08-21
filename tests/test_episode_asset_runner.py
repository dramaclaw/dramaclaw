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
