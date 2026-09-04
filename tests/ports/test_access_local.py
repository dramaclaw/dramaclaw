import pytest

from novelvideo.ports.local.project import AllowAllProjectAccess
from novelvideo.ports.project import Principal, ProjectRecord


def _project() -> ProjectRecord:
    return ProjectRecord(
        id="proj-1",
        owner_type="user",
        owner_id="u1",
        owner_username="alice",
        name="demo",
        home_node_id="node-1",
        output_dir="/tmp/output",
        state_dir="/tmp/state",
        runtime_dir="/tmp/runtime",
        status="active",
    )


@pytest.mark.asyncio
async def test_allow_all_project_access_returns_owner_semantics() -> None:
    access = AllowAllProjectAccess()

    principals = await access.resolve_requester_principals("u1")
    role = await access.effective_project_role(_project(), principals)
    role_by_id = await access.effective_project_role_by_id("proj-1", principals)
    count = await access.count_project_task_eligible_users(
        project_id="proj-1",
        owner_type="user",
        owner_id="u1",
    )

    assert principals == [Principal("user", "local")]
    assert role == "owner"
    assert role_by_id == "owner"
    assert count == 1
