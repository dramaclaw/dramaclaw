from types import SimpleNamespace

import pytest

from novelvideo.task_backend.runners.identity import _build_identity_planner_result


def test_identity_runner_result_includes_auto_promoted_characters():
    result = _build_identity_planner_result(
        episode=1,
        new_count=2,
        resolved_count=3,
        identities=[
            {
                "character_name": "陆辰",
                "identity_id": "陆辰_默认",
                "identity_name": "默认",
                "appearance_details": "",
            }
        ],
        auto_promoted_characters=["陆辰"],
    )

    assert result == {
        "episode": 1,
        "new_count": 2,
        "resolved_count": 3,
        "identities": [
            {
                "character_name": "陆辰",
                "identity_id": "陆辰_默认",
                "identity_name": "默认",
                "appearance_details": "",
            }
        ],
        "auto_promoted_characters": ["陆辰"],
    }


@pytest.mark.asyncio
async def test_identity_runner_preserves_task_billing_context(monkeypatch):
    from novelvideo.task_backend.runners import identity

    progress_updates: list[dict] = []

    class ForbiddenUsageMeter:
        async def set_project_llm_usage_context(self, **kwargs):
            raise AssertionError("identity runner must not overwrite task billing context")

    class FakeTaskManager:
        def update_progress_for_project(self, ctx, task_type, episode, **kwargs):
            progress_updates.append(
                {"ctx": ctx, "task_type": task_type, "episode": episode, **kwargs}
            )

    class FakeSQLiteStore:
        def __init__(self, *args, **kwargs):
            pass

        async def initialize(self):
            pass

        async def load_graph_state(self):
            pass

    class FakeCogneeStore:
        def __init__(self, *args, **kwargs):
            self.episode = SimpleNamespace(number=1, identity_ids=["hero_default"])
            self.character = SimpleNamespace(
                name="Hero",
                identities=[
                    SimpleNamespace(
                        identity_id="hero_default",
                        identity_name="默认",
                        appearance_details="black coat",
                    )
                ],
            )

        async def initialize(self):
            pass

        async def load_graph_state(self):
            pass

        def get_episode(self, episode):
            return self.episode if episode == 1 else None

        def get_all_characters(self):
            return [self.character]

    class FakeIdentityPlanner:
        auto_promoted_characters: list[str] = []

        def __init__(self, store):
            self.store = store

        async def plan_single_episode(self, episode_obj, on_log=None):
            if on_log:
                on_log("identity planned")
            return 1, 0

    monkeypatch.setattr(identity, "get_task_manager", lambda: FakeTaskManager())
    monkeypatch.setattr(identity, "get_usage_meter", lambda: ForbiddenUsageMeter(), raising=False)
    monkeypatch.setattr("novelvideo.sqlite_store.SQLiteStore", FakeSQLiteStore)
    monkeypatch.setattr("novelvideo.cognee.CogneeStore", FakeCogneeStore)
    monkeypatch.setattr(
        "novelvideo.agents.identity_planner.IdentityPlanner",
        FakeIdentityPlanner,
    )

    ctx = SimpleNamespace(
        owner_project_label="alice/demo",
        output_dir="/tmp/out",
        state_dir="/tmp/state",
    )
    result = await identity._run_identity_planner(
        {"task_type": "identity_planner", "episode": 1},
        ctx,
    )

    assert result["new_count"] == 1
    assert result["identities"][0]["identity_id"] == "hero_default"
    assert progress_updates
