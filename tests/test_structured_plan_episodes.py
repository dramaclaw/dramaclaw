"""Chapter mapping has to work on the store each track actually opens.

structured_v1 builds and planning open a SQLiteStore directly — they have no
graph to reach through the Cognee facade for. Chapter mapping is deterministic
and touches no graph, but it lived on CogneeStore, so the plan-episodes runner
raised AttributeError for every structured project. Nothing caught it because
the tests drove the store classes rather than the runner's own store loading.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from novelvideo.knowledge_pipeline import (
    KNOWLEDGE_PIPELINE_KEY,
    KNOWLEDGE_PIPELINE_STRUCTURED,
)

CHAPTERED = (
    "第一章 归来\n\n林默回到阔别十年的故乡。\n\n"
    "第二章 旧友\n\n他在巷口遇见了陈舟。\n\n"
    "第三章 对峙\n\n两人在旧屋前争执起来。\n"
)


def _project(tmp_path: Path, *, structured: bool) -> Path:
    state_dir = tmp_path / "user" / ("structured" if structured else "legacy")
    state_dir.mkdir(parents=True)
    config = {"user": "eric", "spine_template": "narrated"}
    if structured:
        config[KNOWLEDGE_PIPELINE_KEY] = KNOWLEDGE_PIPELINE_STRUCTURED
    (state_dir / "project_config.json").write_text(
        json.dumps(config, ensure_ascii=False), encoding="utf-8"
    )
    return state_dir


async def _sqlite_store(state_dir: Path):
    from novelvideo.sqlite_store import SQLiteStore

    store = SQLiteStore(
        "user/project", output_dir=str(state_dir), state_dir=str(state_dir)
    )
    await store.initialize()
    await store.load_graph_state()
    return store


@pytest.fixture
async def structured_store(tmp_path):
    store = await _sqlite_store(_project(tmp_path, structured=True))
    store.save_novel_content(CHAPTERED)
    try:
        yield store
    finally:
        await store.close()


# ── the store structured projects actually open ─────────────────────────────


async def test_chapter_mapping_works_on_the_sqlite_store(structured_store):
    episodes = await structured_store.build_episodes_from_chapters()

    assert [episode.number for episode in episodes] == [1, 2, 3]
    assert [episode.title for episode in episodes] == ["第1集", "第2集", "第3集"]


async def test_the_episodes_are_actually_persisted(structured_store, tmp_path):
    await structured_store.build_episodes_from_chapters()
    await structured_store.close()

    reopened = await _sqlite_store(Path(structured_store.state_dir))
    try:
        stored = await reopened.get_episode_from_graph(2)
        assert stored is not None
        assert "陈舟" in await reopened.load_episode_content(2)
    finally:
        await reopened.close()


async def test_planned_assets_survive_a_remap(structured_store):
    """Re-running chapter mapping must not discard planning already done."""
    await structured_store.build_episodes_from_chapters()
    await structured_store.patch_episode(
        2, identity_ids=["林默:default"], scene_menu=[{"scene_id": "巷口"}]
    )

    await structured_store.build_episodes_from_chapters()

    episode = await structured_store.get_episode_from_graph(2)
    assert episode.identity_ids == ["林默:default"]
    assert episode.scene_menu


# ── the runner, which is where the gap was ──────────────────────────────────


async def test_the_plan_episodes_runner_works_for_a_structured_project(tmp_path):
    """The regression itself: the runner opens SQLiteStore for structured.

    Testing the store classes alone is what let this through — the runner picks
    a different one per track, and only one of them had the method.
    """
    from novelvideo.task_backend.runners import graph_build

    state_dir = _project(tmp_path, structured=True)
    store = await _sqlite_store(state_dir)
    store.save_novel_content(CHAPTERED)
    await store.close()

    ctx = graph_build.ProjectContext(
        project_id="p1",
        project_name="project",
        owner_type="user",
        owner_id="1",
        owner_username="user",
        requester_user_id="1",
        requester_username="user",
        requester_principals=(),
        effective_role="owner",
        home_node_id="node",
        output_dir=state_dir,
        state_dir=state_dir,
        runtime_dir=state_dir,
        is_home_node=True,
    )
    loaded = await graph_build._load_store(ctx)
    try:
        episodes = await loaded.build_episodes_from_chapters(generate_metadata=False)
        assert [episode.number for episode in episodes] == [1, 2, 3]
    finally:
        await loaded.close()


# ── legacy ──────────────────────────────────────────────────────────────────


async def test_legacy_keeps_the_method_and_its_cache(tmp_path):
    """CogneeStore delegates now; callers and its episode cache must not care."""
    from novelvideo.cognee.store import CogneeStore

    state_dir = _project(tmp_path, structured=False)
    sqlite = await _sqlite_store(state_dir)
    # Built the way the legacy suite builds one, so Cognee initialization — which
    # needs a gateway key — is not what this test is about.
    store = CogneeStore.__new__(CogneeStore)
    store.project_name = "user/legacy"
    store.dataset_name = "novelvideo_user/legacy"
    store._db = None
    store._characters = {}
    store._episodes = {}
    store._alias_index = {}
    store.project_dir = str(state_dir)
    store.state_dir = str(state_dir)
    store.db_path = str(state_dir / "data.db")
    store.sqlite_store = sqlite

    try:
        store.save_novel_content(CHAPTERED)
        episodes = await store.build_episodes_from_chapters()

        assert [episode.number for episode in episodes] == [1, 2, 3]
        # The in-memory cache the facade keeps must reflect the write, or the
        # next reader on this instance sees the pre-mapping world.
        assert store.get_episode(3) is not None
        assert store.get_episode(3).title == "第3集"
    finally:
        await sqlite.close()
