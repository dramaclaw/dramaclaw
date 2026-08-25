from pathlib import Path
from types import SimpleNamespace

import pytest

from novelvideo.api import deps
from novelvideo.api.routes import freezone, scenes


@pytest.mark.asyncio
async def test_project_resolution_always_uses_control_plane(monkeypatch, tmp_path):
    calls: list[dict] = []
    ctx = SimpleNamespace(
        owner_username="alice",
        project_name="demo",
        output_dir=tmp_path / "output",
        state_dir=tmp_path / "state",
        runtime_dir=tmp_path / "runtime",
    )

    async def fake_resolve_project_context(**kwargs):
        calls.append(kwargs)
        return ctx

    def fail_legacy_project_dir(username: str, project: str) -> Path:
        raise AssertionError("legacy project path fallback should not be used")

    monkeypatch.setattr(deps, "resolve_project_context", fake_resolve_project_context)
    monkeypatch.setattr(deps, "require_project_home_node", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(deps, "get_project_dir", fail_legacy_project_dir)

    resolved = await deps.resolve_project_scope(
        "01PROJECT",
        {"id": "user-1", "username": "alice"},
        required_role="editor",
    )

    assert calls == [
        {
            "user": {"id": "user-1", "username": "alice"},
            "project_id": "01PROJECT",
            "required_role": "editor",
        }
    ]
    assert resolved.ctx is ctx
    assert resolved.username == "alice"
    assert resolved.project_name == "demo"
    assert resolved.project_dir == tmp_path / "output"


@pytest.mark.asyncio
async def test_freezone_project_resolution_does_not_use_legacy_fallback(monkeypatch, tmp_path):
    ctx = SimpleNamespace(
        owner_username="alice",
        project_name="demo",
        output_dir=tmp_path / "output",
        state_dir=tmp_path / "state",
        runtime_dir=tmp_path / "runtime",
    )

    async def fake_resolve_project_context(**kwargs):
        return ctx

    def fail_legacy_project_dir(username: str, project: str) -> Path:
        raise AssertionError("legacy project path fallback should not be used")

    monkeypatch.setattr(freezone, "resolve_project_context", fake_resolve_project_context)
    monkeypatch.setattr(freezone, "require_project_home_node", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(freezone, "get_project_dir", fail_legacy_project_dir, raising=False)

    resolved = await freezone._resolve_freezone_project(
        "01PROJECT",
        {"id": "user-1", "username": "alice"},
        required_role="editor",
    )

    assert resolved == (ctx, "alice", "demo", tmp_path / "output", str(tmp_path / "output"))


@pytest.mark.asyncio
async def test_scene_project_resolution_does_not_use_legacy_fallback(monkeypatch, tmp_path):
    store = object()
    ctx = SimpleNamespace(
        owner_username="alice",
        project_name="demo",
        output_dir=tmp_path / "output",
        state_dir=tmp_path / "state",
        runtime_dir=tmp_path / "runtime",
    )

    async def fake_resolve_project_context(**kwargs):
        return ctx

    async def fake_make_sqlite_store_for_context(
        resolved_ctx, *, load_graph_state=True
    ):
        assert resolved_ctx is ctx
        assert load_graph_state is False
        return store

    def fail_legacy_project_dir(username: str, project: str) -> Path:
        raise AssertionError("legacy project path fallback should not be used")

    monkeypatch.setattr(scenes, "resolve_project_context", fake_resolve_project_context)
    monkeypatch.setattr(scenes, "make_sqlite_store_for_context", fake_make_sqlite_store_for_context)
    monkeypatch.setattr(scenes, "get_project_dir", fail_legacy_project_dir, raising=False)

    resolved = await scenes._resolve_scene_project(
        "01PROJECT",
        {"id": "user-1", "username": "alice"},
        required_role="editor",
    )

    assert resolved == (
        ctx,
        "alice",
        "demo",
        tmp_path / "output",
        str(tmp_path / "output"),
        store,
    )
