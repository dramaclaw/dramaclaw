"""Column-level episode updates, and the default switch to structured_v1.

Scene, prop and identity planning for one episode run concurrently in separate
Celery workers. Any whole-row read-modify-write loses one planner's result, and
re-reading first does not help: both writers can re-read before either commits.
These tests assert against the database, never the in-memory cache, because the
cache is not shared across workers and so cannot demonstrate correctness.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

from novelvideo.knowledge_pipeline import (
    COGNEE_LEGACY,
    KNOWLEDGE_PIPELINE_KEY,
    KNOWLEDGE_PIPELINE_STRUCTURED,
    knowledge_pipeline_from_state_dir,
)


def _write_config(state_dir: Path, config: dict) -> None:
    state_dir.mkdir(parents=True, exist_ok=True)
    (state_dir / "project_config.json").write_text(
        json.dumps(config, ensure_ascii=False), encoding="utf-8"
    )


async def _open_store(state_dir: Path):
    from novelvideo.sqlite_store import SQLiteStore

    store = SQLiteStore(
        "user/project", output_dir=str(state_dir), state_dir=str(state_dir)
    )
    await store.initialize()
    await store.load_graph_state()
    return store


@pytest.fixture
async def project(tmp_path):
    from novelvideo.cognee.pipeline import NovelEpisode

    state_dir = tmp_path / "user" / "project"
    _write_config(state_dir, {KNOWLEDGE_PIPELINE_KEY: KNOWLEDGE_PIPELINE_STRUCTURED})
    store = await _open_store(state_dir)
    await store.add_episodes([NovelEpisode(number=1, title="第一集")])
    try:
        yield store, state_dir
    finally:
        await store.close()


# ── column-level semantics ──────────────────────────────────────────────────


async def test_patch_touches_only_the_named_columns(project):
    store, state_dir = project
    await store.patch_episode(1, scene_menu=[{"scene_id": "客厅"}])
    await store.patch_episode(1, identity_ids=["林默:default"])

    reopened = await _open_store(state_dir)
    try:
        episode = await reopened.get_episode_from_graph(1)
        assert episode.identity_ids == ["林默:default"]
        assert episode.scene_menu  # survived the identity write
    finally:
        await reopened.close()


async def test_an_empty_list_really_clears_the_column(project):
    """Omitting a field leaves its column alone; an empty list clears it."""
    store, state_dir = project
    await store.patch_episode(1, prop_menu=[{"prop_id": "怀表"}])
    await store.patch_episode(1, prop_menu=[])

    reopened = await _open_store(state_dir)
    try:
        assert (await reopened.get_episode_from_graph(1)).prop_menu == []
    finally:
        await reopened.close()


async def test_patching_nothing_is_a_no_op(project):
    store, _ = project
    await store.patch_episode(1)


async def test_patching_a_missing_episode_raises(project):
    store, _ = project
    with pytest.raises(ValueError):
        await store.patch_episode(999, scene_menu=[])


# ── the race this exists to remove ──────────────────────────────────────────


async def test_two_workers_writing_different_menus_do_not_overwrite_each_other(
    project,
):
    """Two stores stand in for two Celery workers, each with its own cache.

    Both read the episode, then write different columns with interleaved
    commits. A whole-row write would drop whichever landed first.
    """
    store, state_dir = project
    await store.close()

    worker_a = await _open_store(state_dir)
    worker_b = await _open_store(state_dir)
    try:
        # Both workers have loaded the episode before either writes.
        assert worker_a.get_episode(1) is not None
        assert worker_b.get_episode(1) is not None

        await asyncio.gather(
            worker_a.patch_episode(1, scene_menu=[{"scene_id": "客厅"}]),
            worker_b.patch_episode(1, prop_menu=[{"prop_id": "怀表"}]),
        )
    finally:
        await worker_a.close()
        await worker_b.close()

    verifier = await _open_store(state_dir)
    try:
        episode = await verifier.get_episode_from_graph(1)
        assert episode.scene_menu, "scene planning result was lost"
        assert episode.prop_menu, "prop planning result was lost"
    finally:
        await verifier.close()


async def test_three_concurrent_planners_all_survive(project):
    """Scene, prop and identity planning can all be in flight at once."""
    store, state_dir = project
    await store.close()

    workers = [await _open_store(state_dir) for _ in range(3)]
    try:
        await asyncio.gather(
            workers[0].patch_episode(1, scene_menu=[{"scene_id": "客厅"}]),
            workers[1].patch_episode(1, prop_menu=[{"prop_id": "怀表"}]),
            workers[2].patch_episode(
                1, identity_ids=["林默:default"], character_names=["林默"]
            ),
        )
    finally:
        for worker in workers:
            await worker.close()

    verifier = await _open_store(state_dir)
    try:
        episode = await verifier.get_episode_from_graph(1)
        assert episode.scene_menu
        assert episode.prop_menu
        assert episode.identity_ids == ["林默:default"]
        assert episode.character_names == ["林默"]
    finally:
        await verifier.close()


async def test_whole_row_update_is_still_available_for_replacement(project):
    """patch_episode adds a path; it does not take over whole-row writes."""
    store, state_dir = project
    await store.update_episode(1, title="改名后的标题")

    reopened = await _open_store(state_dir)
    try:
        assert (await reopened.get_episode_from_graph(1)).title == "改名后的标题"
    finally:
        await reopened.close()


# ── default switch ──────────────────────────────────────────────────────────


async def test_new_projects_are_structured_and_carry_no_embedding_binding(
    tmp_path, monkeypatch
):
    from types import SimpleNamespace

    from novelvideo.api.routes import projects
    from novelvideo.embedding_models import (
        PROJECT_EMBEDDING_DIMENSION_KEY,
        PROJECT_EMBEDDING_MODEL_KEY,
    )

    from novelvideo import config
    from novelvideo.ports.project import ProjectRecord

    monkeypatch.setattr(config, "OUTPUT_DIR", tmp_path / "output")
    monkeypatch.setattr(config, "STATE_DIR", tmp_path / "state")
    monkeypatch.setattr(config, "RUNTIME_DIR", tmp_path / "runtime")
    state_dir = tmp_path / "state" / "someone" / "fresh"
    record = ProjectRecord(
        id="proj_1",
        owner_type="user",
        owner_id="1",
        owner_username="someone",
        name="fresh",
        home_node_id="local",
        output_dir=str(tmp_path / "output" / "someone" / "fresh"),
        state_dir=str(state_dir),
        runtime_dir=str(tmp_path / "runtime" / "someone" / "fresh"),
        status="active",
    )

    async def create_project(**_kwargs):
        return record

    def boom():
        raise AssertionError("new projects must not bind an embedding model")

    monkeypatch.setattr(
        projects, "get_project_registry", lambda: SimpleNamespace(create_project=create_project)
    )
    monkeypatch.setattr(projects, "validate_project_name", lambda _name: None)
    monkeypatch.setattr(projects, "user_id_from_api_user", _async(1))
    def ensure_dirs(**paths):
        for path in paths.values():
            Path(path).mkdir(parents=True, exist_ok=True)

    monkeypatch.setattr(projects, "ensure_project_dirs_at_paths", ensure_dirs)
    monkeypatch.setattr(
        "novelvideo.embedding_models.embedding_model_binding_for_new_project", boom
    )

    response = await projects.create_project(
        body=SimpleNamespace(name="fresh"),
        user={"username": "someone"},
    )
    assert response["ok"] is True

    config = json.loads((state_dir / "project_config.json").read_text(encoding="utf-8"))
    assert config[KNOWLEDGE_PIPELINE_KEY] == KNOWLEDGE_PIPELINE_STRUCTURED
    assert PROJECT_EMBEDDING_MODEL_KEY not in config
    assert PROJECT_EMBEDDING_DIMENSION_KEY not in config


def test_existing_projects_keep_their_track(tmp_path):
    """The switch must not reclassify anything already on disk."""
    legacy = tmp_path / "legacy"
    _write_config(legacy, {"user": "x", "cognee_embedding_model": "DC-cognee-embedding-v2"})
    assert knowledge_pipeline_from_state_dir(legacy) == COGNEE_LEGACY

    ancient = tmp_path / "ancient"
    _write_config(ancient, {"user": "x"})
    assert knowledge_pipeline_from_state_dir(ancient) == COGNEE_LEGACY


def _async(value):
    async def _call(*_args, **_kwargs):
        return value

    return _call


# ── planner wiring ──────────────────────────────────────────────────────────


def _planner_store(state_dir: Path, *, structured: bool):
    """A stand-in exposing what the planners actually touch."""
    from types import SimpleNamespace

    config = {KNOWLEDGE_PIPELINE_KEY: KNOWLEDGE_PIPELINE_STRUCTURED} if structured else {"user": "x"}
    _write_config(state_dir, config)

    sqlite = SimpleNamespace(patched=[], updated=[])

    async def patch_episode(number, **fields):
        sqlite.patched.append((number, fields))

    async def update_episode(number, **fields):
        sqlite.updated.append((number, fields))

    sqlite.patch_episode = patch_episode
    sqlite.update_episode = update_episode
    return SimpleNamespace(
        sqlite_store=sqlite, state_dir=str(state_dir),
        update_episode=update_episode, patch_episode=patch_episode,
    )


async def test_structured_identity_planning_uses_the_column_patch(tmp_path):
    """Identity planning runs alongside scene and prop planning.

    A whole-row write here re-serialises the menus this planner loaded earlier,
    losing whatever was written meanwhile.
    """
    from novelvideo.agents.identity_planner import IdentityPlanner

    store = _planner_store(tmp_path / "structured", structured=True)
    planner = IdentityPlanner(store)
    await planner._write_episode_identities(1, identity_ids=["林默:default"])

    assert store.sqlite_store.patched == [(1, {"identity_ids": ["林默:default"]})]
    assert store.sqlite_store.updated == []


async def test_legacy_identity_planning_also_uses_the_column_patch(tmp_path):
    """The race is fixed for existing projects too, not routed around them.

    Safe because the normalization behind the patch is the same code the legacy
    whole-row write used — proven byte-for-byte in the parity suite.
    """
    from novelvideo.agents.identity_planner import IdentityPlanner

    store = _planner_store(tmp_path / "legacy", structured=False)
    planner = IdentityPlanner(store)
    await planner._write_episode_identities(1, identity_ids=["林默:default"])

    assert store.sqlite_store.patched == [(1, {"identity_ids": ["林默:default"]})]
    assert store.sqlite_store.updated == []


def test_planners_never_write_episodes_outside_their_branch_helper():
    """Guard against the gap this class of bug keeps reappearing in.

    Testing patch_episode proves the primitive works; it says nothing about
    whether a planner actually calls it. Every episode write in these two
    planners must go through the helper that picks a route by track.
    """
    import ast
    import inspect

    from novelvideo.agents import asset_compiler, identity_planner

    allowed = {"_write_menus", "_write_episode_identities"}
    for module in (asset_compiler, identity_planner):
        tree = ast.parse(inspect.getsource(module))
        for func in ast.walk(tree):
            if not isinstance(func, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            if func.name in allowed:
                continue
            for node in ast.walk(func):
                if (
                    isinstance(node, ast.Call)
                    and isinstance(node.func, ast.Attribute)
                    and node.func.attr in {"update_episode", "patch_episode"}
                ):
                    raise AssertionError(
                        f"{module.__name__}.{func.name} writes the episode row "
                        f"directly via {node.func.attr}; route it through "
                        f"{sorted(allowed)} so legacy and structured each get "
                        "the write their track expects"
                    )




def test_the_marker_colour_write_is_column_atomic():
    """Guard the call itself, since the route is hard to drive end to end."""
    import inspect

    from novelvideo.api.routes import generation

    source = inspect.getsource(generation.assign_sketch_colors)
    assert "patch_episode(episode_num, prop_menu=" in source
    assert "update_episode" not in source
