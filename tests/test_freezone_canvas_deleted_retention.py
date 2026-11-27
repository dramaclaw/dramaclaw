"""Soft-deleted canvas archives are capped, and the deletion count never goes back."""

from __future__ import annotations

import json
from pathlib import Path

from novelvideo.freezone import canvas_store


def _save(project_dir: Path, canvas_id: str, revision: int) -> None:
    path = canvas_store.canvas_path(project_dir, canvas_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"revision": revision, "nodes": [], "edges": []}))


def test_deleted_archives_are_capped_and_count_keeps_growing(tmp_path: Path) -> None:
    deleted_dir = canvas_store.canvas_deleted_dir_for_path(canvas_store.canvas_path(tmp_path, "c1"))
    for n in range(1, 6):
        _save(tmp_path, "c1", n)
        canvas_store.soft_delete_canvas(tmp_path, "c1", deleted_by="u")
        assert canvas_store.canvas_deletion_count(tmp_path, "c1") == n

    archives = sorted(deleted_dir.glob("*.json"))
    assert len(archives) == canvas_store.DELETED_ARCHIVES_KEPT
    assert sorted(json.loads(p.read_text())["revision"] for p in archives) == [3, 4, 5]


def test_legacy_tombstone_without_count_falls_back_to_archives(tmp_path: Path) -> None:
    path = canvas_store.canvas_path(tmp_path, "c1")
    deleted_dir = canvas_store.canvas_deleted_dir_for_path(path)
    deleted_dir.mkdir(parents=True)
    for n in range(4):
        (deleted_dir / f"2026010{n}_rev{n}.json").write_text("{}")
    path.with_name("c1.deleted.json").write_text(json.dumps({"deleted": True}))
    assert canvas_store.canvas_deletion_count(tmp_path, "c1") == 4

    _save(tmp_path, "c1", 9)
    canvas_store.soft_delete_canvas(tmp_path, "c1", deleted_by="u")
    assert canvas_store.canvas_deletion_count(tmp_path, "c1") == 5
    assert len(list(deleted_dir.glob("*.json"))) == canvas_store.DELETED_ARCHIVES_KEPT
