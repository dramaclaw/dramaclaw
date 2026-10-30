from __future__ import annotations

from dataclasses import replace

from novelvideo.project_context import ProjectContext
from novelvideo.task_state import TaskStateManager


def _context(tmp_path):
    return ProjectContext(
        project_id="project",
        project_name="demo",
        owner_type="user",
        owner_id="owner",
        owner_username="alice",
        requester_user_id="alice",
        requester_username="alice",
        requester_principals=(("user", "alice"),),
        effective_role="editor",
        home_node_id="home",
        output_dir=tmp_path / "output",
        state_dir=tmp_path / "state",
        runtime_dir=tmp_path / "runtime",
        is_home_node=True,
    )


def test_batch_reads_only_requested_project_and_omits_logs(tmp_path):
    manager = TaskStateManager()
    ctx = _context(tmp_path)
    other = replace(ctx, project_id="other")
    manager.create_task_for_project(ctx, "freezone_gen", 0, scope="one")
    manager.create_task_for_project(ctx, "freezone_gen", 0, scope="unrelated")
    manager.create_task_for_project(other, "freezone_gen", 0, scope="one")
    key = manager._project_key("freezone_gen", ctx.project_id, 0, scope="one")
    foreign_key = manager._project_key("freezone_gen", other.project_id, 0, scope="one")
    with manager._connect_context(ctx) as conn:
        # Invalid/large logs must not even be decoded for workflow snapshots.
        conn.execute(
            "UPDATE task_states SET logs_json = 'invalid-json' WHERE task_key = ?",
            (key,),
        )
    snapshots = manager.get_tasks_for_project(
        ctx, [key, key, foreign_key], include_logs=False
    )
    assert list(snapshots) == [key]
    assert snapshots[key].scope == "one"
    assert snapshots[key].logs == []


def test_expired_batch_snapshot_is_hidden_without_deleting_a_task(tmp_path):
    manager = TaskStateManager()
    ctx = _context(tmp_path)
    task = manager.create_task_for_project(ctx, "freezone_gen", 0, scope="one")
    key = manager._project_key("freezone_gen", ctx.project_id, 0, scope="one")
    with manager._connect_context(ctx) as conn:
        conn.execute(
            "UPDATE task_states SET expires_at = '2000-01-01T00:00:00Z' WHERE task_key = ?",
            (key,),
        )
    assert manager.get_tasks_for_project(ctx, [key]) == {}
    with manager._connect_context(ctx) as conn:
        row = conn.execute(
            "SELECT task_id FROM task_states WHERE task_key = ?", (key,)
        ).fetchone()
        assert row["task_id"] == task.task_id


def test_empty_batch_does_not_open_database(tmp_path, monkeypatch):
    manager = TaskStateManager()

    def unexpected(*_args, **_kwargs):
        raise AssertionError("empty batch opened the database")

    monkeypatch.setattr(manager, "_connect_context", unexpected)
    assert manager.get_tasks_for_project(_context(tmp_path), []) == {}
