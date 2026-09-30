import pytest
import sqlite3

from novelvideo.ports.local.project import SQLiteProjectRegistry


@pytest.fixture
def local_registry(monkeypatch, tmp_path):
    state = tmp_path / "state"
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(state))
    import novelvideo.config as config

    monkeypatch.setattr(config, "STATE_DIR", str(state), raising=False)
    return SQLiteProjectRegistry()


@pytest.mark.asyncio
async def test_purge_deletes_registry_row_and_releases_owner_name(local_registry):
    first = await local_registry.create_project(
        owner_user_id="local",
        owner_username="alice",
        name="agent",
    )
    await local_registry.update_project_status(first.id, "deleted")
    await local_registry.begin_project_purge(first.id)
    purged = await local_registry.mark_project_purged(first.id)

    second = await local_registry.create_project(
        owner_user_id="local",
        owner_username="alice",
        name="agent",
    )
    resolved = await local_registry.get_project_by_owner_name("local", "agent")

    assert purged is not None
    assert purged.id == first.id
    assert purged.purged_at is not None
    assert await local_registry.get_project(first.id) is None
    assert second.id != first.id
    assert resolved is not None
    assert resolved.id == second.id


@pytest.mark.asyncio
async def test_started_purge_blocks_restore_and_keeps_name_reserved(local_registry):
    project = await local_registry.create_project(
        owner_user_id="local", owner_username="alice", name="agent"
    )
    await local_registry.update_project_status(project.id, "deleted")
    started = await local_registry.begin_project_purge(project.id)
    assert started is not None and started.purge_started_at
    retry = await local_registry.begin_project_purge(project.id)
    assert retry is not None and retry.purge_started_at == started.purge_started_at

    restored = await local_registry.update_project_status(project.id, "active")
    assert restored is not None and restored.status == "deleted"
    with pytest.raises(ValueError, match="already exists"):
        await local_registry.create_project(
            owner_user_id="local", owner_username="alice", name="agent"
        )


@pytest.mark.asyncio
async def test_existing_ce_registry_adds_purge_started_column(local_registry):
    path = local_registry._db_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(path) as db:
        db.execute(
            """CREATE TABLE projects (
                id TEXT PRIMARY KEY, owner_type TEXT NOT NULL, owner_id TEXT NOT NULL,
                owner_username TEXT NOT NULL, name TEXT NOT NULL, home_node_id TEXT NOT NULL,
                output_dir TEXT NOT NULL, state_dir TEXT NOT NULL, runtime_dir TEXT NOT NULL,
                status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
                purged_at TEXT, UNIQUE(owner_type, owner_id, name))"""
        )
    conn = await local_registry._connect()
    try:
        columns = await conn.execute_fetchall("PRAGMA table_info(projects)")
    finally:
        await conn.close()
    assert "purge_started_at" in {row[1] for row in columns}


@pytest.mark.asyncio
async def test_create_project_route_returns_409_for_duplicate_name(monkeypatch):
    from novelvideo.api.routes import projects as projects_route

    class DuplicateRegistry:
        async def create_project(self, **_kwargs):
            raise ValueError("Project 'agent' already exists")

    async def fake_user_id_from_api_user(_user):
        return "local"

    monkeypatch.setattr(projects_route, "validate_project_name", lambda _name: None)
    monkeypatch.setattr(projects_route, "user_id_from_api_user", fake_user_id_from_api_user)
    monkeypatch.setattr(projects_route, "get_project_registry", lambda: DuplicateRegistry())

    with pytest.raises(projects_route.HTTPException) as exc:
        await projects_route.create_project(
            projects_route.ProjectCreate(name="agent"),
            user={"id": "local", "username": "alice"},
        )

    assert exc.value.status_code == 409
    assert exc.value.detail == "Project 'agent' already exists"
