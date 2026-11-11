"""Delivery waiters must not occupy the generation slots they depend on."""

import sqlite3

import pytest

from task_context_helper import task_context
from novelvideo.task_backend.limits import (
    ProjectTaskLimitExceeded,
    ProjectUserTaskLimitExceeded,
)
from novelvideo.task_state import TaskStateManager


def test_delivery_trackers_do_not_block_lane_but_remain_active_tasks():
    with sqlite3.connect(":memory:") as conn:
        conn.execute(
            "CREATE TABLE task_states (project_id TEXT, requester_user_id TEXT, "
            "queue_kind TEXT, task_type TEXT, status TEXT)"
        )
        conn.executemany("INSERT INTO task_states VALUES (?, ?, ?, ?, ?)", [
            ("p", "u", "default", "freezone_agent_recipe_result", "running")
            for _ in range(3)
        ])
        manager = TaskStateManager.__new__(TaskStateManager)
        count = manager._count_active_project_tasks_on_connection
        assert count(conn, project_id="p") == 3
        assert count(conn, project_id="p", queue_kind="default") == 0
        conn.execute("INSERT INTO task_states VALUES (?, ?, ?, ?, ?)",
                     ("p", "u", "default", "freezone_text_generate", "running"))
        assert count(conn, project_id="p", queue_kind="default", requester_user_id="u") == 1
        assert count(conn, project_id="p", queue_kind="video") == 0
        assert count(conn, project_id="other", queue_kind="default") == 0
        assert count(conn, project_id="p", queue_kind="default", requester_user_id="other") == 0


@pytest.mark.parametrize("task_type", [
    "freezone_agent_workflow_result",
    "freezone_agent_recipe_result",
    "freezone_agent_workflow_generate",
    "freezone_agent_recipe_generate",
    "freezone_workflow_drive",
])
@pytest.mark.parametrize("limit_kind", ["project", "requester"])
def test_trackers_reserve_when_default_lane_is_full(
    tmp_path, monkeypatch, task_type, limit_kind,
):
    monkeypatch.setenv(
        "ST_PROJECT_MAX_ACTIVE_DEFAULT_TASKS", "3" if limit_kind == "project" else "9",
    )
    monkeypatch.setenv("ST_PROJECT_USER_MAX_ACTIVE_DEFAULT_TASKS", "3")
    ctx = task_context(tmp_path)
    manager = TaskStateManager()
    ordinary = [
        manager.reserve_task_for_project(ctx, "freezone_text_generate", 0, scope=str(n))[0]
        for n in range(3)
    ]
    duplicate, reserved = manager.reserve_task_for_project(
        ctx, "freezone_text_generate", 0, scope="0",
    )
    assert reserved is False
    assert duplicate.task_id == ordinary[0].task_id
    error_type = (
        ProjectTaskLimitExceeded if limit_kind == "project" else ProjectUserTaskLimitExceeded
    )
    with pytest.raises(error_type) as error:
        manager.reserve_task_for_project(ctx, "freezone_text_generate", 0, scope="extra")
    assert str(error.value) == (
        "project project default lane is full (3/3)" if limit_kind == "project" else
        "user requester in project project default lane is full (3/3)"
    )

    tracker, reserved = manager.reserve_task_for_project(ctx, task_type, 0, scope="tracker")
    assert reserved is True
    assert tracker.status == "submitting"
    duplicate, reserved = manager.reserve_task_for_project(ctx, task_type, 0, scope="tracker")
    assert reserved is False
    assert duplicate.task_id == tracker.task_id
    assert manager.count_active_tasks_for_project(ctx) == 4
    assert manager.count_active_tasks_for_project_lane(ctx, "default") == 3
    assert manager.count_active_tasks_for_project_user_lane(ctx, "default") == 3
