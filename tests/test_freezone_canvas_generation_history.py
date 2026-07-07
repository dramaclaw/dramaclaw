"""Canvas-level generation-history aggregation.

Deleting a node from the canvas must NOT remove its past generations from the
history browser. History lives in per-node append-only JSONL files that the
canvas JSON never touches, so ``read_canvas_generation_history`` reads *every*
node file under a canvas — including nodes that no longer exist on the canvas.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from novelvideo.freezone.history import (
    append_generation_history,
    generation_history_path,
    read_canvas_generation_history,
)


def _append(project_dir: Path, node_id: str, job_id: str, recorded_at: str) -> None:
    append_generation_history(
        project_dir=project_dir,
        canvas_id="default",
        node_id=node_id,
        record={
            "job_id": job_id,
            "status": "completed",
            "media_type": "video",
            "recorded_at": recorded_at,
            "result": {"output_url": f"/static/{job_id}.mp4"},
        },
    )


def test_canvas_history_includes_deleted_node(tmp_path: Path) -> None:
    project_dir = tmp_path / "proj"
    _append(project_dir, "kept_node", "job_kept", "2026-06-16T00:00:00Z")
    _append(project_dir, "deleted_node", "job_deleted", "2026-06-15T00:00:00Z")

    # Simulate the node being removed from the canvas: only the canvas JSON would
    # drop it — the history file stays on disk, which is the whole point.
    assert generation_history_path(project_dir, "default", "deleted_node").exists()

    records = read_canvas_generation_history(project_dir=project_dir, canvas_id="default")
    job_ids = {r["job_id"] for r in records}
    assert job_ids == {"job_kept", "job_deleted"}


def test_canvas_history_sorted_newest_first(tmp_path: Path) -> None:
    project_dir = tmp_path / "proj"
    _append(project_dir, "node_a", "job_old", "2026-06-10T00:00:00Z")
    _append(project_dir, "node_b", "job_mid", "2026-06-12T00:00:00Z")
    _append(project_dir, "node_a", "job_new", "2026-06-14T00:00:00Z")

    records = read_canvas_generation_history(project_dir=project_dir, canvas_id="default")
    assert [r["job_id"] for r in records] == ["job_new", "job_mid", "job_old"]


def test_canvas_history_respects_limit(tmp_path: Path) -> None:
    project_dir = tmp_path / "proj"
    _append(project_dir, "node_a", "job_old", "2026-06-10T00:00:00Z")
    _append(project_dir, "node_b", "job_new", "2026-06-14T00:00:00Z")

    records = read_canvas_generation_history(
        project_dir=project_dir, canvas_id="default", limit=1
    )
    assert [r["job_id"] for r in records] == ["job_new"]


def test_canvas_history_missing_canvas_dir_is_empty(tmp_path: Path) -> None:
    records = read_canvas_generation_history(
        project_dir=tmp_path / "proj", canvas_id="default"
    )
    assert records == []


def test_canvas_history_rejects_bad_canvas_id(tmp_path: Path) -> None:
    with pytest.raises(ValueError):
        read_canvas_generation_history(
            project_dir=tmp_path / "proj", canvas_id="../escape"
        )
