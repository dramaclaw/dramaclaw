from contextlib import asynccontextmanager
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace

import pytest

from novelvideo import config
from novelvideo.ports.local.project_output import LocalProjectOutputPurger
from novelvideo.ports.project import ProjectRecord


@asynccontextmanager
async def _lock(_project_id):
    yield True


def _record(tmp_path):
    return ProjectRecord(
        id="01PROJECT",
        owner_type="user",
        owner_id="local",
        owner_username="alice",
        name="demo",
        home_node_id="local",
        output_dir=str(tmp_path / "output" / "alice" / "demo"),
        state_dir=str(tmp_path / "state" / "alice" / "demo"),
        runtime_dir=str(tmp_path / "runtime" / "alice" / "demo"),
        status="deleted",
    )


@pytest.mark.asyncio
async def test_purge_marks_registry_only_after_local_files_are_gone(monkeypatch, tmp_path):
    from novelvideo.api.routes import projects

    monkeypatch.setattr(config, "OUTPUT_DIR", tmp_path / "output")
    monkeypatch.setattr(config, "STATE_DIR", tmp_path / "state")
    monkeypatch.setattr(config, "RUNTIME_DIR", tmp_path / "runtime")
    record = _record(tmp_path)
    for name in ("output_dir", "state_dir", "runtime_dir"):
        path = Path(getattr(record, name))
        path.mkdir(parents=True)
        (path / "file.txt").write_text("old")
    order = []

    class Registry:
        purge_lock = staticmethod(_lock)
        async def get_project(self, _project_id):
            return record

        async def begin_project_purge(self, _project_id):
            return replace(record, purge_started_at="now")

        async def delete_project_home(self, _project_id):
            order.append("home")

        async def mark_project_purged(self, _project_id):
            assert all(not Path(getattr(record, name)).exists() for name in (
                "output_dir", "state_dir", "runtime_dir"
            ))
            order.append("purged")
            return replace(record, purged_at="now")

    monkeypatch.setattr(projects, "resolve_project_context", _resolve(record))
    monkeypatch.setattr(projects, "get_project_registry", lambda: Registry())
    monkeypatch.setattr(projects, "get_project_output_purger", lambda: LocalProjectOutputPurger())
    monkeypatch.setattr(projects, "emit_project_audit", _no_audit)

    result = await projects.purge_project(record.id, user={"username": "alice"})
    assert result["ok"]
    assert order == ["home", "purged"]


@pytest.mark.asyncio
async def test_failed_output_cleanup_does_not_purge_registry(monkeypatch, tmp_path):
    from novelvideo.api.routes import projects

    monkeypatch.setattr(config, "OUTPUT_DIR", tmp_path / "output")
    monkeypatch.setattr(config, "STATE_DIR", tmp_path / "state")
    monkeypatch.setattr(config, "RUNTIME_DIR", tmp_path / "runtime")
    record = _record(tmp_path)

    class Registry:
        purge_lock = staticmethod(_lock)
        async def get_project(self, _project_id):
            return record

        async def begin_project_purge(self, _project_id):
            return replace(record, purge_started_at="now")

        async def mark_project_purged(self, _project_id):
            raise AssertionError("registry must retain project")

    class FailingPurger:
        async def purge(self, _record):
            raise OSError("storage unavailable")

    monkeypatch.setattr(projects, "resolve_project_context", _resolve(record))
    monkeypatch.setattr(projects, "get_project_registry", lambda: Registry())
    monkeypatch.setattr(projects, "get_project_output_purger", lambda: FailingPurger())

    with pytest.raises(OSError, match="storage unavailable"):
        await projects.purge_project(record.id, user={"username": "alice"})


@pytest.mark.asyncio
async def test_output_reappearing_after_cleanup_keeps_project_retryable(monkeypatch, tmp_path):
    from novelvideo.api.routes import projects

    monkeypatch.setattr(config, "OUTPUT_DIR", tmp_path / "output")
    monkeypatch.setattr(config, "STATE_DIR", tmp_path / "state")
    monkeypatch.setattr(config, "RUNTIME_DIR", tmp_path / "runtime")
    record = _record(tmp_path)

    class Registry:
        purge_lock = staticmethod(_lock)

        async def get_project(self, _project_id):
            return record

        async def begin_project_purge(self, _project_id):
            return replace(record, purge_started_at="now")

        async def mark_project_purged(self, _project_id):
            raise AssertionError("reappearing output must prevent purged_at")

    class ReappearingOutput:
        async def purge(self, _record):
            return None

        async def has_current_data(self, _record):
            return True

    monkeypatch.setattr(projects, "resolve_project_context", _resolve(record))
    monkeypatch.setattr(projects, "get_project_registry", lambda: Registry())
    monkeypatch.setattr(projects, "get_project_output_purger", lambda: ReappearingOutput())

    with pytest.raises(OSError, match="reappeared"):
        await projects.purge_project(record.id, user={"username": "alice"})


async def _no_audit(**_kwargs):
    return None


def _context(record):
    return SimpleNamespace(
        project_id=record.id,
        project_name=record.name,
        owner_username=record.owner_username,
        is_home_node=True,
    )


def _resolve(record):
    async def resolve(**_kwargs):
        return _context(record)

    return resolve
