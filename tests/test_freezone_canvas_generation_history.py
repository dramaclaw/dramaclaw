"""Canvas-level generation-history aggregation.

Deleting a node from the canvas must NOT remove its past generations from the
history browser. History lives in per-node append-only JSONL files that the
canvas JSON never touches, so ``read_canvas_generation_history`` reads *every*
node file under a canvas — including nodes that no longer exist on the canvas.
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace

import pytest

from novelvideo.freezone.history import (
    append_generation_history,
    build_node_history_record,
    delete_generation_history_record,
    generation_history_path,
    read_canvas_generation_history,
    read_generation_history,
)


def _append(project_dir: Path, node_id: str, job_id: str, recorded_at: str) -> None:
    append_generation_history(
        project_dir=project_dir,
        canvas_id="default",
        node_id=node_id,
        record={
            "id": f"video:{job_id}",
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


def test_media_workers_preserve_admitted_workflow_attempt_in_history(tmp_path: Path) -> None:
    from novelvideo.task_backend.runners.freezone import _append_node_history
    from novelvideo.task_backend.runners.video import _append_freezone_video_node_history

    ctx = SimpleNamespace(project_id="project-1")
    payload = {
        "canvas_id": "default",
        "node_id": "media-1",
        "generation_attempt_id": "attempt-1",
        "product_operation_id": "operation-1",
    }
    image = _append_node_history(
        ctx=ctx,
        project_dir=tmp_path,
        payload=payload,
        task_type="freezone_gen",
        job_id="image-job",
        media_type="image",
        result={"image_url": "/static/image.png"},
    )
    video = _append_freezone_video_node_history(
        ctx=ctx,
        project_dir=tmp_path,
        payload=payload,
        job_id="video-job",
        result={"output_url": "/static/video.mp4"},
    )
    assert image is not None and video is not None
    for record in (image, video):
        assert record["generation_attempt_id"] == "attempt-1"
        assert record["product_operation_id"] == "operation-1"


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


def test_idempotent_history_append_is_atomic_without_scanning_full_history(
    tmp_path: Path, monkeypatch
) -> None:
    import novelvideo.freezone.history as history

    project_dir = tmp_path / "proj"
    record = {
        "id": "html:artifact:v1",
        "job_id": "artifact:v1",
        "status": "completed",
        "media_type": "html",
    }
    monkeypatch.setattr(
        history,
        "_read_history_file",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("idempotent append must not scan the whole JSONL file")
        ),
    )

    def append_once():
        return append_generation_history(
            project_dir=project_dir,
            canvas_id="default",
            node_id="html_node",
            record=record,
            idempotency_key=record["id"],
        )

    with ThreadPoolExecutor(max_workers=4) as pool:
        list(pool.map(lambda _index: append_once(), range(8)))

    path = generation_history_path(project_dir, "default", "html_node")
    assert len(path.read_text(encoding="utf-8").splitlines()) == 1


def test_delete_history_record_hides_only_target_and_keeps_append_only_file(
    tmp_path: Path,
) -> None:
    project_dir = tmp_path / "proj"
    _append(project_dir, "node_a", "job_keep", "2026-06-10T00:00:00Z")
    path = generation_history_path(project_dir, "default", "node_a")
    append_generation_history(
        project_dir=project_dir,
        canvas_id="default",
        node_id="node_a",
        record={
            "id": "video:job_delete",
            "job_id": "job_delete",
            "status": "completed",
            "media_type": "video",
            "result": {"output_url": "/static/job_delete.mp4"},
        },
    )
    size_before = path.stat().st_size

    assert delete_generation_history_record(
        project_dir=project_dir,
        canvas_id="default",
        node_id="node_a",
        record_id="video:job_delete",
    )
    assert path.stat().st_size > size_before
    assert [
        record["job_id"]
        for record in read_canvas_generation_history(
            project_dir=project_dir, canvas_id="default"
        )
    ] == ["job_keep"]
    assert not delete_generation_history_record(
        project_dir=project_dir,
        canvas_id="default",
        node_id="node_a",
        record_id="video:job_delete",
    )


def _shrink_history_limits(
    monkeypatch, *, compact_at: int, keep: int, ignore_record_size: bool = False
) -> None:
    import novelvideo.freezone.history as history

    monkeypatch.setattr(history, "HISTORY_COMPACT_AT_BYTES", compact_at)
    monkeypatch.setattr(history, "HISTORY_RETENTION_RECORDS", keep)
    if ignore_record_size:
        # Compact on every append past compact_at, even when nothing would be dropped.
        monkeypatch.setattr(history, "_average_line_bytes", lambda _path, _size: 0)


def _ids_in_file(path: Path) -> list[str]:
    import json

    return [json.loads(line).get("id") or "tombstone" for line in path.read_text().splitlines()]


def test_large_history_compacts_to_newest_live_records(tmp_path: Path, monkeypatch) -> None:
    _shrink_history_limits(monkeypatch, compact_at=4096, keep=5)
    project_dir = tmp_path / "proj"
    path = generation_history_path(project_dir, "default", "node_a")
    for index in range(3):
        _append(project_dir, "node_a", f"job{index}", f"2026-06-10T00:00:0{index}Z")
    assert delete_generation_history_record(
        project_dir=project_dir, canvas_id="default", node_id="node_a", record_id="video:job2"
    )

    index = 3
    while path.stat().st_size <= 4096 or index < 6:
        size_before = path.stat().st_size
        _append(project_dir, "node_a", f"job{index}", "2026-06-11T00:00:00Z")
        index += 1
        if path.stat().st_size < size_before:
            break

    ids = _ids_in_file(path)
    assert "tombstone" not in ids
    assert "video:job2" not in ids
    assert ids == [f"video:job{n}" for n in range(index - 5, index)]


def _story_script_record(n: int) -> dict:
    rows = [
        {"shot": i, "description": "镜头描述" * 60, "dialogue": "台词" * 40} for i in range(20)
    ]
    return build_node_history_record(
        task_type="freezone_story_script",
        job_id=f"job{n}",
        task_key=f"k{n}",
        status="completed",
        media_type="text",
        result={"job_id": f"job{n}", "output_format": "json", "rows": rows},
    )


def test_default_page_of_large_records_survives_compaction(tmp_path: Path) -> None:
    project_dir = tmp_path / "proj"
    for n in range(120):
        append_generation_history(
            project_dir=project_dir,
            canvas_id="default",
            node_id="script_node",
            record=_story_script_record(n),
        )

    records = read_generation_history(
        project_dir=project_dir, canvas_id="default", node_id="script_node", limit=100
    )
    assert len(records) == 100


def test_large_records_keep_the_full_retention_window(tmp_path: Path, monkeypatch) -> None:
    _shrink_history_limits(monkeypatch, compact_at=4096, keep=10)
    project_dir = tmp_path / "proj"
    path = generation_history_path(project_dir, "default", "node_a")
    compactions = 0
    for index in range(200):
        size_before = path.stat().st_size if path.exists() else 0
        _append(project_dir, "node_a", f"job{index}", "2026-06-11T00:00:00Z")
        if path.stat().st_size < size_before:
            compactions += 1
            assert _ids_in_file(path) == [f"video:job{n}" for n in range(index - 9, index + 1)]

    assert compactions >= 2
    # The file grows to about twice the window between rewrites, not one record.
    assert compactions <= 200 // 10
    assert len(_ids_in_file(path)) <= 20


def test_concurrent_appends_survive_compaction(tmp_path: Path, monkeypatch) -> None:
    _shrink_history_limits(monkeypatch, compact_at=2048, keep=10_000, ignore_record_size=True)
    project_dir = tmp_path / "proj"

    with ThreadPoolExecutor(max_workers=8) as pool:
        list(
            pool.map(
                lambda n: _append(project_dir, "node_a", f"job{n}", "2026-06-11T00:00:00Z"),
                range(60),
            )
        )

    path = generation_history_path(project_dir, "default", "node_a")
    assert sorted(_ids_in_file(path)) == sorted(f"video:job{n}" for n in range(60))


def test_plain_append_survives_a_busy_history_lock(tmp_path: Path, monkeypatch) -> None:
    from novelvideo.freezone.canvas_lock import CanvasLockBusy

    class BusyMutex:
        def write_mutex(self, *_args, **_kwargs):
            raise CanvasLockBusy("history_x")

    monkeypatch.setattr("novelvideo.ports.get_canvas_write_mutex", lambda: BusyMutex())
    project_dir = tmp_path / "proj"
    _append(project_dir, "node_a", "job1", "2026-06-11T00:00:00Z")

    path = generation_history_path(project_dir, "default", "node_a")
    assert _ids_in_file(path) == ["video:job1"]


def test_lease_lost_during_compaction_does_not_duplicate_the_record(tmp_path: Path, monkeypatch) -> None:
    from contextlib import contextmanager

    from novelvideo.ports.canvas_mutex import CanvasLeaseLost

    _shrink_history_limits(monkeypatch, compact_at=1, keep=500, ignore_record_size=True)

    class LosingGuard:
        calls = 0

        def reassert(self):
            LosingGuard.calls += 1
            if LosingGuard.calls > 1:  # lost between the append and the rewrite
                raise CanvasLeaseLost("history_x")

    class Mutex:
        @contextmanager
        def write_mutex(self, *_args, **_kwargs):
            yield LosingGuard()

    monkeypatch.setattr("novelvideo.ports.get_canvas_write_mutex", lambda: Mutex())
    project_dir = tmp_path / "proj"
    _append(project_dir, "node_a", "job1", "2026-06-11T00:00:00Z")

    path = generation_history_path(project_dir, "default", "node_a")
    assert _ids_in_file(path) == ["video:job1"]
    assert not list(path.parent.glob(".*.tmp"))
