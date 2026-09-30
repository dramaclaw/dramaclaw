import pytest

from novelvideo import config
from novelvideo.ports.local.project import SQLiteProjectRegistry


@pytest.mark.asyncio
async def test_local_purge_lock_serializes_same_project(monkeypatch, tmp_path):
    monkeypatch.setattr(config, "STATE_DIR", tmp_path / "state")
    registry = SQLiteProjectRegistry()
    async with registry.purge_lock("project-a") as first:
        assert first
        async with registry.purge_lock("project-a") as second:
            assert not second
        async with registry.purge_lock("project-b") as other:
            assert other
    async with registry.purge_lock("project-a") as retry:
        assert retry
