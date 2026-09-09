from __future__ import annotations

import pytest

from novelvideo.api.routes import projects
from novelvideo.ports.project import Principal


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
