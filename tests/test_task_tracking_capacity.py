"""Delivery waiters must not occupy the generation slots they depend on."""

import sqlite3

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
