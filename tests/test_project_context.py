from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException

from novelvideo.ports.auth_contract import AgentAuthenticatedUser, AuthenticatedUser
from novelvideo.ports.project import Principal, ProjectRecord
from novelvideo.project_context import (
    ProjectContext,
    _ctx_from_record,
    require_project_home_node,
    resolve_project_context,
)


def _ctx(tmp_path: Path, *, is_home_node: bool) -> ProjectContext:
    return ProjectContext(
        project_id="proj_123",
        project_name="demo",
        owner_type="user",
        owner_id="user_owner",
        owner_username="alice",
        requester_user_id="user_editor",
        requester_username="bob",
        requester_principals=(("user", "user_editor"),),
        effective_role="editor",
        home_node_id="node_a",
        output_dir=tmp_path / "output" / "alice" / "demo",
        state_dir=tmp_path / "state" / "alice" / "demo",
        runtime_dir=tmp_path / "runtime" / "alice" / "demo",
        is_home_node=is_home_node,
    )


def test_require_project_home_node_allows_local_project(tmp_path):
    ctx = _ctx(tmp_path, is_home_node=True)

    assert require_project_home_node(ctx) is ctx


def test_require_project_home_node_rejects_remote_project(tmp_path):
    ctx = _ctx(tmp_path, is_home_node=False)

    with pytest.raises(HTTPException) as exc:
        require_project_home_node(ctx, operation="read project files")

    assert exc.value.status_code == 409
    assert exc.value.detail["code"] == "project_not_on_this_node"
    assert exc.value.detail["home_node_id"] == "node_a"


def test_ctx_from_record_treats_ce_local_home_node_as_local(monkeypatch, tmp_path):
    import novelvideo.project_context as project_context

    monkeypatch.setattr(project_context, "resolve_worker_id", lambda: "node_other")
    record = ProjectRecord(
        id="proj_local",
        owner_type="user",
        owner_id="local",
        owner_username="alice",
        name="demo",
        home_node_id="local",
        output_dir=str(tmp_path / "output"),
        state_dir=str(tmp_path / "state"),
        runtime_dir=str(tmp_path / "runtime"),
        status="active",
    )

    ctx = _ctx_from_record(
        project=record,
        requester_user_id="local",
        requester_username="alice",
        principals=[Principal("user", "local")],
        role="owner",
    )

    assert ctx.is_home_node is True
    assert require_project_home_node(ctx) is ctx


@pytest.fixture
def project_context_ports(monkeypatch, tmp_path):
    import novelvideo.project_context as project_context

    def configure(*, status, role="viewer", purged_at=None):
        record = ProjectRecord(
            id="proj_local",
            owner_type="user",
            owner_id="local",
            owner_username="alice",
            name="demo",
            home_node_id="local",
            output_dir=str(tmp_path / "output"),
            state_dir=str(tmp_path / "state"),
            runtime_dir=str(tmp_path / "runtime"),
            status=status,
            purged_at=purged_at,
        )
        registry = SimpleNamespace(get_project=AsyncMock(return_value=record))
        access = SimpleNamespace(
            resolve_requester_principals=AsyncMock(return_value=[Principal("user", "local")]),
            effective_project_role=AsyncMock(return_value=role),
        )
        monkeypatch.setattr(project_context, "get_project_registry", lambda: registry)
        monkeypatch.setattr(project_context, "get_project_access", lambda: access)
        return record

    return configure


def _project_user(*, external, project_id):
    if external:
        return AgentAuthenticatedUser(
            id="local",
            username="alice",
            role="owner",
            external_agent_key_id="key-1",
            current_scope_kind="project",
            current_project_id=project_id,
        ).to_legacy_dict()
    return AuthenticatedUser(id="local", username="alice", role="owner").to_legacy_dict()


async def test_external_agent_is_refused_after_project_role_allows_access(
    project_context_ports,
):
    record = project_context_ports(status="deleted")
    user = _project_user(external=True, project_id=record.id)

    with pytest.raises(HTTPException) as exc:
        await resolve_project_context(user=user, project_id=record.id)

    assert exc.value.status_code == 409
    from novelvideo.ports import auth_contract

    assert auth_contract.AuthFailureReason.PROJECT_DELETED.value == "project_deleted"
    assert auth_contract.AGENT_KEY_PROJECT_DELETED_CODE == "agent_key_project_deleted"
    assert {
        "AGENT_KEY_PROJECT_DELETED_CODE",
        "AGENT_KEY_PROJECT_DELETED_MESSAGE",
    } <= set(auth_contract.__all__)
    assert exc.value.detail == {
        "code": "agent_key_project_deleted",
        "message": auth_contract.AGENT_KEY_PROJECT_DELETED_MESSAGE,
        "project_id": record.id,
    }
    message = exc.value.detail["message"].lower()
    for phrase in ("valid", "deleted", "owner", "restor", "web app", "same key", "replace"):
        assert phrase in message


async def test_project_role_refusal_precedes_external_agent_deleted_project_refusal(
    project_context_ports,
):
    record = project_context_ports(status="deleted", role=None)
    user = _project_user(external=True, project_id=record.id)

    with pytest.raises(HTTPException) as exc:
        await resolve_project_context(user=user, project_id=record.id)

    assert exc.value.status_code == 403
    assert exc.value.detail == "project role required: viewer"


@pytest.mark.parametrize(
    "external,status,purged_at",
    [
        (False, "deleted", None),
        (True, "archived", None),
        (True, "deleted", "2026-01-01T00:00:00Z"),
    ],
    ids=["browser-deleted", "agent-archived", "agent-purged"],
)
async def test_project_context_allows_access_outside_external_agent_soft_delete(
    project_context_ports, external, status, purged_at
):
    record = project_context_ports(status=status, purged_at=purged_at)
    user = _project_user(external=external, project_id=record.id)

    ctx = await resolve_project_context(user=user, project_id=record.id)

    assert ctx.project_id == record.id
    assert ctx.effective_role == "viewer"
