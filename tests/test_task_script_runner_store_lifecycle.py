from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest

from novelvideo.project_context import ProjectContext


class _Manager:
    def update_progress_for_project(self, *args, **kwargs) -> None:
        pass


class _ClosableStore:
    def __init__(self) -> None:
        self.closed = False
        self.initialized = False
        self.graph_loaded = False

    async def initialize(self) -> None:
        self.initialized = True

    async def load_graph_state(self) -> None:
        self.graph_loaded = True

    async def close(self) -> None:
        self.closed = True

    def get_all_characters(self) -> list:
        return []

    def get_sketch_colors(self, episode: int) -> dict:
        return {}


def _ctx(tmp_path: Path) -> ProjectContext:
    return ProjectContext(
        project_id="proj_123",
        project_name="demo",
        owner_type="user",
        owner_id="user_123",
        owner_username="alice",
        requester_user_id="user_123",
        requester_username="alice",
        requester_principals=(("user", "user_123"),),
        effective_role="owner",
        home_node_id="local",
        output_dir=tmp_path / "output",
        state_dir=tmp_path / "state",
        runtime_dir=tmp_path / "runtime",
        is_home_node=True,
    )


@pytest.mark.asyncio
async def test_beat_video_prompt_runner_closes_sqlite_store(monkeypatch, tmp_path):
    from novelvideo.api import deps
    from novelvideo.api.routes import scripts
    from novelvideo.task_backend.runners import script as runner

    store = _ClosableStore()

    async def fake_make_sqlite_store_for_context(ctx):
        return store

    async def fake_generate_and_save_beat_video_prompt(**kwargs):
        return {"field": "video_prompt", "prompt": "camera move"}

    monkeypatch.setattr(runner, "get_task_manager", lambda: _Manager())
    monkeypatch.setattr(deps, "make_sqlite_store_for_context", fake_make_sqlite_store_for_context)
    monkeypatch.setattr(
        scripts,
        "_generate_and_save_beat_video_prompt",
        fake_generate_and_save_beat_video_prompt,
    )

    result = await runner._run_beat_video_prompt(
        {"episode": 1, "beat_num": 2, "payload": {"output_dir": str(tmp_path)}},
        _ctx(tmp_path),
    )

    assert result["prompt"] == "camera move"
    assert store.closed is True


@pytest.mark.asyncio
async def test_script_writer_reads_scoped_config_and_closes_store(monkeypatch, tmp_path):
    import novelvideo.cognee as cognee
    from novelvideo import project_config
    from novelvideo.task_backend.runners import script as runner
    from novelvideo.workflows import script_writing

    store = _ClosableStore()
    ctx = _ctx(tmp_path)
    ctx.state_dir.mkdir(parents=True)
    (ctx.state_dir / "project_config.json").write_text(
        '{"genre":"thriller","story_setting":"night city","spine_template":"narrated"}',
        encoding="utf-8",
    )
    monkeypatch.setattr(project_config, "OUTPUT_DIR", tmp_path / "fallback-state")
    workflow_config: dict = {}

    class FakeCogneeStore:
        def __new__(cls, *args, **kwargs):
            return store

    class FakeWorkflow:
        last_review_passed = True
        last_review_summary = "ok"

        async def run(self, **kwargs):
            return SimpleNamespace(beats=[])

    def fake_create_script_writing_workflow(*args, **kwargs):
        workflow_config.update(kwargs)
        return FakeWorkflow()

    monkeypatch.setattr(runner, "get_task_manager", lambda: _Manager())
    monkeypatch.setattr(cognee, "CogneeStore", FakeCogneeStore)
    monkeypatch.setattr(
        script_writing,
        "create_script_writing_workflow",
        fake_create_script_writing_workflow,
    )

    result = await runner._run_script_writer(
        {"episode": 1, "payload": {"output_dir": str(tmp_path)}},
        ctx,
    )

    assert workflow_config == {
        "genre": "thriller",
        "story_setting": "night city",
        "spine_template": "narrated",
    }
    assert result["beats"] == 0
    assert result["degraded_lines"] == []
    assert store.closed is True
