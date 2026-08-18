"""The sketch runner resolves scenes from the task payload, not from project data.

The interesting assertion is the negative one: with a projection present the two
project-data constructors are never called at all.  Patching them to raise is
what makes that a fact rather than a claim -- a silent fallback to reading the
database would look identical from the outside, and would hide exactly the kind
of omission this whole mechanism exists to surface.

Both scene-reference modes are exercised: the extra work director references do
sits behind its own branch, and only one of the two paths would otherwise be
covered.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest


@pytest.fixture
def forbid_project_data(monkeypatch: pytest.MonkeyPatch):
    """Make every project-data entry point on this path explode when touched."""
    from novelvideo.cognee import CogneeStore
    from novelvideo.sqlite_store import SQLiteStore

    calls: list[str] = []

    def refuse_cognee(self, *args, **kwargs):
        calls.append("CogneeStore.__init__")
        raise AssertionError("worker read project data through CogneeStore")

    def refuse_sqlite(self, *args, **kwargs):
        calls.append("SQLiteStore.__init__")
        raise AssertionError("worker read project data through SQLiteStore")

    monkeypatch.setattr(CogneeStore, "__init__", refuse_cognee)
    monkeypatch.setattr(SQLiteStore, "__init__", refuse_sqlite)
    return calls


def _projection(scenes: list[dict]) -> object:
    from novelvideo.task_backend.projection import ProjectProjection

    return ProjectProjection(
        task_type="mainline_sketch_from_context",
        projection_version=1,
        fields={"scenes": scenes},
    )


def _ctx():
    return SimpleNamespace(
        owner_project_label="alice/demo",
        output_dir="/nonexistent",
        state_dir="/state/_scopes/scope_123/alice/demo",
    )


async def _ensure(tmp_path, *, projection, director_ref_mode="off", beats=None):
    from novelvideo.task_backend.runners import sketch

    return await sketch._ensure_scene_refs_for_beats(
        ctx=_ctx(),
        output_dir=str(tmp_path),
        beats=beats if beats is not None else [{"beat_number": 1, "scene_id": "皇宫·大殿"}],
        episode=1,
        director_ref_mode=director_ref_mode,
        director_ref_beat_numbers=None,
        log=lambda *a, **k: None,
        projection=projection,
    )


@pytest.mark.asyncio
async def test_scene_check_reads_no_project_data_when_projected(
    tmp_path, forbid_project_data
) -> None:
    stats = await _ensure(tmp_path, projection=_projection([{"name": "皇宫·大殿", "aliases": []}]))

    assert stats["requested"] == 1
    assert forbid_project_data == []


@pytest.mark.asyncio
async def test_scene_check_reads_no_project_data_with_director_refs_on(
    tmp_path, forbid_project_data
) -> None:
    """Director references take a second pass over the beats; it must not read either."""
    stats = await _ensure(
        tmp_path,
        projection=_projection([{"name": "皇宫·大殿", "aliases": []}]),
        director_ref_mode="all",
    )

    assert stats["director_refs"] == 0
    assert forbid_project_data == []


@pytest.mark.asyncio
async def test_projected_scene_lookup_honours_aliases(tmp_path, forbid_project_data) -> None:
    """The store's lookup is alias-aware, so reading a projection instead of the
    store must not quietly narrow it to exact names."""
    from novelvideo.utils.path_resolver import canonical_scene_master_path

    master = canonical_scene_master_path(tmp_path, "皇宫·大殿")
    master.parent.mkdir(parents=True, exist_ok=True)
    master.write_bytes(b"x")

    stats = await _ensure(
        tmp_path,
        projection=_projection([{"name": "皇宫·大殿", "aliases": ["  THE Great Hall "]}]),
        beats=[{"beat_number": 1, "scene_id": "the great hall"}],
    )

    assert stats["missing"] == 0
    assert stats["skipped"] == 1


@pytest.mark.asyncio
async def test_unknown_scene_stays_missing_rather_than_falling_back(
    tmp_path, forbid_project_data
) -> None:
    """A scene the projection does not name is missing, not a reason to open a store."""
    stats = await _ensure(tmp_path, projection=_projection([{"name": "别处", "aliases": []}]))

    assert stats["missing"] == 1
    assert forbid_project_data == []


@pytest.mark.asyncio
async def test_projection_without_scenes_raises(tmp_path, forbid_project_data) -> None:
    """Invariant: a projection that is missing a field it promised is an error,
    never a silent return to reading the database."""
    from novelvideo.task_backend.projection import ProjectProjection

    empty = ProjectProjection(
        task_type="mainline_sketch_from_context", projection_version=1, fields={}
    )

    with pytest.raises(ValueError, match="scenes"):
        await _ensure(tmp_path, projection=empty)


@pytest.mark.asyncio
async def test_without_a_projection_the_store_is_still_used(tmp_path, monkeypatch) -> None:
    """The rollback: no projection in the payload, no change in behaviour."""
    from novelvideo.cognee import CogneeStore

    opened: list[tuple[str, dict]] = []
    closed: list[bool] = []

    def record(self, label, *args, **kwargs):
        opened.append((label, kwargs))

    async def noop(self, *args, **kwargs):
        return None

    async def close(self):
        closed.append(True)

    async def one_scene(name):
        return SimpleNamespace(name="皇宫·大殿")

    monkeypatch.setattr(CogneeStore, "__init__", record)
    monkeypatch.setattr(CogneeStore, "initialize", noop)
    monkeypatch.setattr(CogneeStore, "load_graph_state", noop)
    monkeypatch.setattr(CogneeStore, "close", close)
    monkeypatch.setattr(
        CogneeStore,
        "sqlite_store",
        property(lambda self: SimpleNamespace(get_scene=one_scene)),
        raising=False,
    )

    stats = await _ensure(tmp_path, projection=None)

    assert opened == [
        (
            "alice/demo",
            {
                "output_dir": str(tmp_path),
                "state_dir": "/state/_scopes/scope_123/alice/demo",
            },
        )
    ]
    assert stats["requested"] == 1
    assert closed == [True]


@pytest.mark.asyncio
async def test_store_is_closed_when_graph_state_loading_fails(tmp_path, monkeypatch) -> None:
    """Opening the fallback store transfers cleanup responsibility immediately."""
    from novelvideo.cognee import CogneeStore

    closed: list[bool] = []

    def record(self, *args, **kwargs):
        pass

    async def noop(self):
        pass

    async def fail(self):
        raise RuntimeError("graph state unavailable")

    async def close(self):
        closed.append(True)

    monkeypatch.setattr(CogneeStore, "__init__", record)
    monkeypatch.setattr(CogneeStore, "initialize", noop)
    monkeypatch.setattr(CogneeStore, "load_graph_state", fail)
    monkeypatch.setattr(CogneeStore, "close", close)

    with pytest.raises(RuntimeError, match="graph state unavailable"):
        await _ensure(tmp_path, projection=None)

    assert closed == [True]


class _StopHere(Exception):
    """Cut the runner off once it has reached the point under test."""


def _sketch_envelope(*, director_ref_mode: str, with_projection: bool) -> dict:
    payload: dict = {
        "output_dir": "/nonexistent",
        "config": {
            "beats": [{"beat_number": 1, "scene_id": "皇宫·大殿"}],
            "direct_sketch_beats": True,
            "beat_numbers": [1],
            "mode_key": "1x1_2-3",
            "director_ref_mode": director_ref_mode,
        },
    }
    if with_projection:
        payload["projection"] = {
            "task_type": "mainline_sketch_from_context",
            "projection_version": 1,
            "fields": {"scenes": [{"name": "皇宫·大殿", "aliases": []}]},
        }
    return {
        "task_type": "mainline_sketch_from_context",
        "episode": 1,
        "scope": "job-1",
        "payload": payload,
    }


@pytest.fixture
def quiet_runner(monkeypatch: pytest.MonkeyPatch):
    from novelvideo.task_backend.runners import sketch

    monkeypatch.setattr(sketch, "_log", lambda *a, **k: None)
    monkeypatch.setattr(sketch, "get_task_manager", lambda: SimpleNamespace())
    return sketch


@pytest.mark.asyncio
async def test_runner_hands_the_payload_projection_to_the_scene_check(
    quiet_runner, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Without this wiring every assertion above tests a call shape nobody uses."""
    seen: list[object] = []

    async def spy(**kwargs):
        seen.append(kwargs.get("projection"))
        raise _StopHere

    monkeypatch.setattr(quiet_runner, "_ensure_scene_refs_for_beats", spy)

    with pytest.raises(_StopHere):
        await quiet_runner._run_sketch_generation_async(
            _sketch_envelope(director_ref_mode="all", with_projection=True),
            _ctx(),
        )

    assert seen and seen[0] is not None
    assert seen[0].require("scenes") == [{"name": "皇宫·大殿", "aliases": []}]


@pytest.mark.asyncio
async def test_runner_passes_none_when_the_payload_carries_no_projection(
    quiet_runner, monkeypatch: pytest.MonkeyPatch
) -> None:
    seen: list[object] = []

    async def spy(**kwargs):
        seen.append(kwargs.get("projection"))
        raise _StopHere

    monkeypatch.setattr(quiet_runner, "_ensure_scene_refs_for_beats", spy)

    with pytest.raises(_StopHere):
        await quiet_runner._run_sketch_generation_async(
            _sketch_envelope(director_ref_mode="all", with_projection=False),
            _ctx(),
        )

    assert seen == [None]


@pytest.mark.asyncio
async def test_director_refs_off_never_reaches_the_scene_check(
    quiet_runner, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The other of the two branches: with director references off the runner
    does not check scenes at all, so nothing here may change that."""

    async def spy(**kwargs):
        raise AssertionError("scene check ran with director references off")

    def stop(*args, **kwargs):
        raise _StopHere

    monkeypatch.setattr(quiet_runner, "_ensure_scene_refs_for_beats", spy)
    monkeypatch.setattr(quiet_runner, "_scene_refs_override_from_config", stop)

    with pytest.raises(_StopHere):
        await quiet_runner._run_sketch_generation_async(
            _sketch_envelope(director_ref_mode="off", with_projection=True),
            _ctx(),
        )
