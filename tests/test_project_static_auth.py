from __future__ import annotations

import pytest
from fastapi import HTTPException

from novelvideo.api.routes import projects
from novelvideo.ports.auth_contract import AGENT_KEY_PROJECT_DELETED_MESSAGE
from novelvideo.ports.project import Principal, ProjectRecord


@pytest.mark.asyncio
async def test_static_auth_uses_project_id_role_lookup(monkeypatch):
    calls = []

    class FakeAccess:
        async def resolve_requester_principals(self, user_id: str):
            calls.append(("principals", user_id))
            return [Principal("user", user_id)]

        async def effective_project_role_by_id(self, project_id: str, principals):
            calls.append(("role", project_id, principals))
            return "owner"

    async def user_id_from_api_user(user):
        assert user == {"username": "alice"}
        return "user-1"

    monkeypatch.setattr(projects, "get_project_access", lambda: FakeAccess())
    monkeypatch.setattr(projects, "user_id_from_api_user", user_id_from_api_user)

    response = await projects.authorize_project_static_media(
        "project-1",
        user={"username": "alice"},
    )

    assert response.status_code == 204
    assert calls == [
        ("principals", "user-1"),
        ("role", "project-1", [Principal("user", "user-1")]),
    ]


@pytest.fixture
def external_agent_key_user():
    return {
        "username": "alice",
        "credential_kind": "agent_session",
        "external_agent_key_id": "key-1",
    }


def _mock_static_auth(monkeypatch, *, status: str, role: str | None):
    record = ProjectRecord(
        id="project-1",
        owner_type="user",
        owner_id="user-1",
        owner_username="alice",
        name="test-project",
        home_node_id="node-1",
        output_dir="output",
        state_dir="state",
        runtime_dir="runtime",
        status=status,
        purged_at=None,
    )

    class FakeAccess:
        async def resolve_requester_principals(self, user_id: str):
            return [Principal("user", user_id)]

        async def effective_project_role_by_id(self, project_id: str, principals):
            return role

    class FakeRegistry:
        async def get_project(self, project_id: str):
            assert project_id == record.id
            return record

    async def user_id_from_api_user(user):
        assert user["username"] == "alice"
        return "user-1"

    monkeypatch.setattr(projects, "get_project_access", lambda: FakeAccess())
    monkeypatch.setattr(projects, "user_id_from_api_user", user_id_from_api_user)
    monkeypatch.setattr(projects, "get_project_registry", lambda: FakeRegistry())


@pytest.mark.asyncio
async def test_static_auth_denies_external_agent_key_on_soft_deleted_project(
    monkeypatch, external_agent_key_user
):
    _mock_static_auth(monkeypatch, status="deleted", role="owner")

    with pytest.raises(HTTPException) as exc:
        await projects.authorize_project_static_media("project-1", user=external_agent_key_user)

    assert exc.value.status_code == 403
    assert exc.value.detail["code"] == "agent_key_project_deleted"
    assert exc.value.detail["message"] == AGENT_KEY_PROJECT_DELETED_MESSAGE


@pytest.mark.asyncio
@pytest.mark.parametrize("status", ["archived", "active"])
async def test_static_auth_allows_external_agent_key_on_archived_or_active_project(
    monkeypatch, external_agent_key_user, status
):
    _mock_static_auth(monkeypatch, status=status, role="viewer")

    response = await projects.authorize_project_static_media(
        "project-1", user=external_agent_key_user
    )

    assert response.status_code == 204


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "user",
    [
        pytest.param({"username": "alice"}, id="browser"),
        pytest.param({"username": "alice", "credential_kind": "agent_session"}, id="local-agent"),
    ],
)
async def test_static_auth_allows_browser_and_local_agent_on_soft_deleted_project(
    monkeypatch, user
):
    _mock_static_auth(monkeypatch, status="deleted", role="viewer")

    response = await projects.authorize_project_static_media("project-1", user=user)

    assert response.status_code == 204


@pytest.mark.asyncio
async def test_static_auth_preserves_role_refusal_on_soft_deleted_project(
    monkeypatch, external_agent_key_user
):
    _mock_static_auth(monkeypatch, status="active", role=None)
    with pytest.raises(HTTPException) as active_exc:
        await projects.authorize_project_static_media("project-1", user=external_agent_key_user)

    _mock_static_auth(monkeypatch, status="deleted", role=None)
    with pytest.raises(HTTPException) as deleted_exc:
        await projects.authorize_project_static_media("project-1", user=external_agent_key_user)

    assert deleted_exc.value.status_code == active_exc.value.status_code == 403
    assert deleted_exc.value.detail == active_exc.value.detail == "project role required: viewer"
