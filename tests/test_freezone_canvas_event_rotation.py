"""Canvas event logs rotate by size and keep a bounded number of segments."""

from __future__ import annotations

import json
from pathlib import Path

import novelvideo.freezone.canvas_events as canvas_events
from novelvideo.freezone.canvas_creation import _reserved_canvas_ids


def _append(project_dir: Path, n: int, canvas_id: str = "c1") -> None:
    canvas_events.append_canvas_event(
        project_dir=project_dir,
        project_id="p",
        canvas_id=canvas_id,
        event_type="canvas.saved",
        actor={"kind": "user", "id": "u"},
        payload={"n": n, "pad": "x" * 200},
    )


def _events(path: Path) -> list[int]:
    return [json.loads(line)["payload"]["n"] for line in path.read_text().splitlines()]


def test_event_log_rotates_and_keeps_newest_segments(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(canvas_events, "CANVAS_EVENT_SEGMENT_BYTES", 1024)
    for n in range(40):
        _append(tmp_path, n)

    events_dir = canvas_events.canvas_events_dir(tmp_path)
    active = events_dir / "c1.jsonl"
    segments = sorted((events_dir / "_segments" / "c1").glob("*.jsonl"))
    assert active.stat().st_size <= 1024 + 400
    assert len(segments) == canvas_events.CANVAS_EVENT_SEGMENTS_KEPT

    kept = [n for segment in segments for n in _events(segment)] + _events(active)
    assert kept == list(range(kept[0], 40))  # contiguous newest events, nothing lost


def test_rotation_keeps_deleted_canvas_id_reserved(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(canvas_events, "CANVAS_EVENT_SEGMENT_BYTES", 512)
    for n in range(10):
        _append(tmp_path, n, canvas_id="gone")

    # No canvas file for "gone": its event log alone must keep the id reserved,
    # and rotated segments must not leak bogus ids into the reserved list.
    assert _reserved_canvas_ids(tmp_path) == ["gone"]
