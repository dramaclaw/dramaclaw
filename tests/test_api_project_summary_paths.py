import sqlite3
from pathlib import Path

import pytest

from novelvideo.ports.project import ProjectRecord


@pytest.mark.asyncio
async def test_project_summary_counts_from_registered_state_dir(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    state_dir = tmp_path / "state" / "_orgs" / "org-1" / "alice" / "demo"
    output_dir = tmp_path / "output" / "_orgs" / "org-1" / "alice" / "demo"
    runtime_dir = tmp_path / "runtime" / "_orgs" / "org-1" / "alice" / "demo"
    state_dir.mkdir(parents=True)
    output_dir.mkdir(parents=True)
    runtime_dir.mkdir(parents=True)
    with sqlite3.connect(state_dir / "data.db") as conn:
        conn.execute("CREATE TABLE episodes (episode_number INTEGER PRIMARY KEY)")
        conn.execute("CREATE TABLE beats (id INTEGER PRIMARY KEY)")
        conn.executemany("INSERT INTO episodes VALUES (?)", [(1,), (2,)])
        conn.executemany("INSERT INTO beats VALUES (?)", [(1,), (2,), (3,)])

    # Resolved at call time rather than bound at import, which is how the route
    # uses it anyway. The CE contract test that once orphaned this reference now
    # restores the import system itself, so this is defence in depth rather than
    # the thing standing between the patch below and the code it patches.
    from novelvideo.api.routes.projects import _summary_for_record

    monkeypatch.setattr(
        "novelvideo.api.routes.projects.is_record_home_node", lambda _record: True
    )
    record = ProjectRecord(
        id="project-1",
        owner_type="user",
        owner_id="user-1",
        owner_username="alice",
        name="demo",
        home_node_id="local-dev",
        output_dir=str(output_dir),
        state_dir=str(state_dir),
        runtime_dir=str(runtime_dir),
        status="active",
    )

    summary = await _summary_for_record(record)

    assert summary.episode_count == 2
    assert summary.beat_count == 3
