import pytest


@pytest.mark.asyncio
async def test_local_project_access_counts_one_eligible_user() -> None:
    from novelvideo.ports.local.project import AllowAllProjectAccess

    count = await AllowAllProjectAccess().count_project_task_eligible_users(
        project_id="proj_1",
        owner_type="user",
        owner_id="user_1",
    )

    assert count == 1
