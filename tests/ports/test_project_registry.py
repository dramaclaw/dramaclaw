from __future__ import annotations

import re
from pathlib import Path

import pytest

ULID_RE = re.compile(r"^[0-9A-HJKMNP-TV-Z]{26}$")


def _set_roots(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> tuple[Path, Path, Path]:
    output = tmp_path / "output"
    state = tmp_path / "state"
    runtime = tmp_path / "runtime"
    import novelvideo.config as config

    monkeypatch.setattr(config, "OUTPUT_DIR", str(output))
    monkeypatch.setattr(config, "STATE_DIR", str(state))
    monkeypatch.setattr(config, "RUNTIME_DIR", str(runtime))
    return output, state, runtime


@pytest.mark.asyncio
async def test_sqlite_project_registry_persists_and_reads_all_project_methods(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    output, state, runtime = _set_roots(monkeypatch, tmp_path)
    monkeypatch.setenv("ST_LOCAL_USERNAME", "alice")

    from novelvideo.ports.local import project as local_project

    monkeypatch.setattr(local_project, "resolve_worker_id", lambda: "node_local", raising=False)
    registry = local_project.SQLiteProjectRegistry()

    created = await registry.create_project(
        owner_user_id="ignored-user-id",
        owner_username="alice",
        name="demo",
    )

    assert ULID_RE.match(created.id)
    assert created.owner_type == "user"
    assert created.owner_id == "local"
    assert created.owner_username == "alice"
    assert created.name == "demo"
    assert created.home_node_id == "local"
    assert created.output_dir == str((output / "alice" / "demo").resolve())
    assert created.state_dir == str((state / "alice" / "demo").resolve())
    assert created.runtime_dir == str((runtime / "alice" / "demo").resolve())
    assert created.status == "active"
    assert created.created_at
    assert created.updated_at
    assert created.purged_at is None

    assert (state / "local" / "projects.db").exists()
    assert not (state / "alice" / "demo").exists()
    assert not (state / "alice" / "demo" / "project.json").exists()
    assert not (output / "alice" / "demo").exists()
    assert not (runtime / "alice" / "demo").exists()

    assert await registry.get_project(created.id) == created
    assert await registry.get_project_by_owner_name("local", "demo") == created
    assert await registry.resolve_username_by_user_id("local") == "alice"
    assert await registry.resolve_user_id_by_username("alice") == "local"

    listed = await registry.list_accessible_projects([("user", "local")])
    assert [item.id for item in listed] == [created.id]
    assert await registry.list_accessible_projects([("user", "not-local")]) == []
    assert await registry.list_accessible_projects([("team", "local")]) == []

    with pytest.raises(ValueError, match="already exists"):
        await registry.create_project(
            owner_user_id="local",
            owner_username="alice",
            name="demo",
        )

    archived = await registry.update_project_status(created.id, "archived")
    assert archived is not None
    assert archived.status == "archived"
    assert archived.updated_at >= created.updated_at

    purged = await registry.mark_project_purged(created.id)
    assert purged is not None
    assert purged.status == "deleted"
    assert purged.purged_at

    assert await registry.update_project_status(created.id, "active") is None
    assert await registry.get_project(created.id) is None

    assert await registry.delete_project_home(created.id) is None
    assert await registry.delete_uncommitted_project(created.id) is None
    assert await registry.get_project(created.id) is None


@pytest.mark.asyncio
async def test_sqlite_project_registry_does_not_backfill_legacy_state_dirs(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _output, state, _runtime = _set_roots(monkeypatch, tmp_path)
    monkeypatch.setenv("ST_LOCAL_USERNAME", "alice")

    legacy_state = state / "alice" / "legacy"
    legacy_state.mkdir(parents=True)
    (legacy_state / "project_config.json").write_text("{}", encoding="utf-8")

    from novelvideo.ports.local import project as local_project

    monkeypatch.setattr(local_project, "resolve_worker_id", lambda: "node_local", raising=False)
    registry = local_project.SQLiteProjectRegistry()

    records = await registry.list_accessible_projects([("user", "local")])

    assert records == []
    assert await registry.get_project_by_owner_name("local", "legacy") is None
    assert not (legacy_state / "project.json").exists()
