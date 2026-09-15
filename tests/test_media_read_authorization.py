"""Only explicit media reads may use an optional cached viewer capability."""

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException

from novelvideo import project_context


@pytest.fixture
def ports(monkeypatch):
    record = SimpleNamespace(id="project")
    registry = SimpleNamespace(get_project=AsyncMock(return_value=record))
    access = SimpleNamespace(
        resolve_requester_principals=AsyncMock(return_value=[]),
        effective_project_role=AsyncMock(return_value="owner"),
        effective_media_read_role=AsyncMock(return_value="viewer"),
    )
    monkeypatch.setattr(project_context, "get_project_registry", lambda: registry)
    monkeypatch.setattr(project_context, "get_project_access", lambda: access)
    monkeypatch.setattr(project_context, "user_id_from_api_user", AsyncMock(return_value="user"))
    monkeypatch.setattr(project_context, "_ctx_from_record", lambda **kwargs: kwargs)
    return registry, access


@pytest.mark.asyncio
async def test_media_read_uses_optional_capability_but_rereads_project(ports):
    registry, access = ports
    for _ in range(2):
        ctx = await project_context.resolve_project_context(
            user={"username": "alice"}, project_id="project", media_read=True
        )
        assert ctx["role"] == "viewer"
    assert registry.get_project.await_count == 2
    assert access.effective_media_read_role.await_count == 2
    access.effective_project_role.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize("required_role", ["viewer", "editor", "admin", "owner"])
async def test_ordinary_requests_keep_authoritative_role(ports, required_role):
    _, access = ports
    await project_context.resolve_project_context(
        user={"username": "alice"}, project_id="project", required_role=required_role
    )
    access.effective_project_role.assert_awaited_once()
    access.effective_media_read_role.assert_not_awaited()


@pytest.mark.asyncio
async def test_old_provider_and_ce_remain_compatible(ports):
    _, access = ports
    del access.effective_media_read_role
    await project_context.resolve_project_context(
        user={"username": "alice"}, project_id="project", media_read=True
    )
    access.effective_project_role.assert_awaited_once()


@pytest.mark.asyncio
async def test_media_capability_cannot_authorize_writes(ports):
    with pytest.raises(ValueError, match="viewer-only"):
        await project_context.resolve_project_context(
            user={"username": "alice"}, project_id="project", media_read=True,
            required_role="editor",
        )


@pytest.mark.asyncio
async def test_denied_media_does_not_fall_back_to_another_role(ports):
    _, access = ports
    access.effective_media_read_role.return_value = None
    with pytest.raises(HTTPException) as exc:
        await project_context.resolve_project_context(
            user={"username": "alice"}, project_id="project", media_read=True
        )
    assert exc.value.status_code == 403
    access.effective_project_role.assert_not_awaited()


@pytest.mark.asyncio
async def test_missing_project_does_not_use_cached_permission(ports):
    registry, access = ports
    registry.get_project.return_value = None
    with pytest.raises(HTTPException) as exc:
        await project_context.resolve_project_context(
            user={"username": "alice"}, project_id="project", media_read=True
        )
    assert exc.value.status_code == 404
    access.effective_media_read_role.assert_not_awaited()
