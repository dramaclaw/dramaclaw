"""Canvas writes publish bounded, replayable changes on disk."""

import importlib
import json
import logging
import os
from datetime import datetime

import pytest

from novelvideo.freezone import canvas_store


@pytest.fixture(autouse=True)
def enable_patch_push(monkeypatch):
    monkeypatch.setenv("DRAMACLAW_CANVAS_PATCH_PUSH", "1")
    monkeypatch.delenv("DRAMACLAW_CANVAS_CHANGE_LOG_MAX_ENTRIES", raising=False)
    monkeypatch.delenv("DRAMACLAW_CANVAS_CHANGE_LOG_MAX_BYTES", raising=False)


@pytest.fixture
def changes():
    return importlib.import_module("novelvideo.freezone.canvas_changes")


def change_dir(project_dir, canvas_id="board"):
    return project_dir / "freezone" / "canvas_changes" / canvas_id


def entries(project_dir, canvas_id="board"):
    return [
        json.loads(path.read_text())
        for path in sorted(change_dir(project_dir, canvas_id).glob("*.json"))
    ]


def save(project_dir, revision, **kwargs):
    return canvas_store.save_canvas(
        project_dir,
        "board",
        base_revision=revision - 1 if revision > 1 else None,
        build_payload=lambda existing: {
            "revision": revision,
            "nodes": [{"id": "node", "data": {"value": revision}}],
            "edges": [],
        },
        **kwargs,
    )


def test_save_publishes_literal_canvas_diff(tmp_path, monkeypatch):
    monkeypatch.setenv("DRAMACLAW_CANVAS_PATCH_PUSH", "0")
    canvas_store.save_canvas(
        tmp_path,
        "board",
        base_revision=None,
        build_payload=lambda existing: {
            "revision": 7,
            "nodes": [
                {"id": "changed", "value": "old"},
                {"id": "same", "value": 1},
                {"id": "deleted"},
                {"id": 42},
            ],
            "edges": [{"id": "removed-edge"}, {"id": "same-edge"}],
        },
    )
    monkeypatch.setenv("DRAMACLAW_CANVAS_PATCH_PUSH", "1")
    canvas_store.save_canvas(
        tmp_path,
        "board",
        base_revision=7,
        client_save_id=" save-8 ",
        save_source="manual_save",
        build_payload=lambda existing: {
            "revision": 8,
            "nodes": [
                {"id": "added", "value": 2},
                {"id": "same", "value": 1},
                {"id": "changed", "value": "new"},
                {"value": "ignored"},
                None,
            ],
            "edges": [{"id": "same-edge"}],
        },
    )

    assert sorted(path.name for path in change_dir(tmp_path).glob("*.json")) == [
        "000000000008.json"
    ]
    [entry] = entries(tmp_path)
    written_at = entry.pop("written_at")
    assert (
        datetime.fromisoformat(written_at.replace("Z", "+00:00")).utcoffset().total_seconds() == 0
    )
    assert entry == {
        "type": "canvas.patch",
        "canvas_id": "board",
        "revision": 8,
        "base_revision": 7,
        "save_source": "manual_save",
        "client_save_id": "save-8",
        "nodes": [{"id": "added", "value": 2}, {"id": "changed", "value": "new"}],
        "edges": [],
        "deleted_node_ids": ["deleted"],
        "deleted_edge_ids": ["removed-edge"],
    }


def test_flag_off_creates_no_change_directory(tmp_path, monkeypatch):
    monkeypatch.setenv("DRAMACLAW_CANVAS_PATCH_PUSH", "0")
    save(tmp_path, 1)
    assert not (tmp_path / "freezone" / "canvas_changes").exists()


def test_default_creation_publishes_once(tmp_path):
    assert canvas_store.ensure_default_canvas(tmp_path, project_id="project").created
    assert not canvas_store.ensure_default_canvas(tmp_path, project_id="project").created
    [entry] = entries(tmp_path, "default")
    assert entry["base_revision"] == 0
    assert entry["revision"] == 1
    assert entry["save_source"] == "system_default"
    assert entry["client_save_id"] is None
    assert entry["nodes"] == []


def test_restore_publishes_change_with_current_base(tmp_path, monkeypatch):
    monkeypatch.setenv("DRAMACLAW_CANVAS_PATCH_PUSH", "0")
    save(tmp_path, 1)
    saved = save(tmp_path, 2)
    monkeypatch.setenv("DRAMACLAW_CANVAS_PATCH_PUSH", "1")
    canvas_store.restore_canvas_version(
        tmp_path,
        "board",
        history_id=saved.backup_path.stem,
        base_revision=2,
        build_payload=lambda existing, history: {**history, "revision": 3},
    )
    [entry] = entries(tmp_path)
    assert entry["revision"] == 3
    assert entry["base_revision"] == 2
    assert entry["save_source"] == "restore"
    assert entry["nodes"] == [{"id": "node", "data": {"value": 1}}]


def test_idempotent_replay_does_not_republish(tmp_path):
    save(tmp_path, 1, client_save_id="request-1", request_hash="hash-1")
    before = (change_dir(tmp_path) / "000000000001.json").read_bytes()
    replay = save(tmp_path, 1, client_save_id="request-1", request_hash="hash-1")
    assert replay.idempotent
    assert len(entries(tmp_path)) == 1
    assert (change_dir(tmp_path) / "000000000001.json").read_bytes() == before


def test_skip_hit_does_not_publish(tmp_path):
    save(tmp_path, 1, skip_if=lambda existing: {"skipped": True})
    assert not change_dir(tmp_path).exists()


def test_publish_failure_does_not_fail_canvas_save(tmp_path, changes, monkeypatch, caplog):
    def fail_write(path, payload):
        raise OSError("private canvas content")

    monkeypatch.setattr(changes, "_write_entry", fail_write)
    with caplog.at_level(logging.WARNING):
        result = save(tmp_path, 1)
    assert result.payload["revision"] == 1
    assert canvas_store.read_canvas(tmp_path, "board")["revision"] == 1
    assert any(record.levelno == logging.WARNING for record in caplog.records)
    assert "board" in caplog.text
    assert "revision=1" in caplog.text
    assert "OSError" in caplog.text
    assert "private canvas content" not in caplog.text


def test_replay_returns_chained_saves_and_resets_invalid_cursors(tmp_path, changes):
    assert changes.read_canvas_changes(tmp_path, "board", 0).entries == []
    assert changes.read_canvas_changes(tmp_path, "board", 0).reset_revision is None
    for revision in (1, 2, 3):
        save(tmp_path, revision)

    replay = changes.read_canvas_changes(tmp_path, "board", 1)
    assert [entry["revision"] for entry in replay.entries] == [2, 3]
    assert [entry["base_revision"] for entry in replay.entries] == [1, 2]
    assert replay.reset_revision is None
    assert changes.read_canvas_changes(tmp_path, "board", 3).entries == []
    assert changes.read_canvas_changes(tmp_path, "board", 3).reset_revision is None
    assert changes.read_canvas_changes(tmp_path, "board", 4).entries == []
    assert changes.read_canvas_changes(tmp_path, "board", 4).reset_revision == 3
    assert changes.read_canvas_changes(tmp_path, "board", -1).entries == []
    assert changes.read_canvas_changes(tmp_path, "board", -1).reset_revision == 3


def test_entry_limit_prunes_oldest_revisions(tmp_path, changes, monkeypatch):
    monkeypatch.setenv("DRAMACLAW_CANVAS_CHANGE_LOG_MAX_ENTRIES", "3")
    for revision in range(1, 6):
        save(tmp_path, revision)
    assert sorted(path.name for path in change_dir(tmp_path).glob("*.json")) == [
        "000000000003.json",
        "000000000004.json",
        "000000000005.json",
    ]
    replay = changes.read_canvas_changes(tmp_path, "board", 1)
    assert replay.entries == []
    assert replay.reset_revision == 5
    assert [
        entry["revision"] for entry in changes.read_canvas_changes(tmp_path, "board", 2).entries
    ] == [3, 4, 5]


def test_byte_limit_always_keeps_newest_entry(tmp_path, monkeypatch):
    save(tmp_path, 1)
    monkeypatch.setenv("DRAMACLAW_CANVAS_CHANGE_LOG_MAX_BYTES", "1")
    save(tmp_path, 2)
    save(tmp_path, 3)
    assert [path.name for path in change_dir(tmp_path).glob("*.json")] == ["000000000003.json"]


@pytest.mark.parametrize("value", ["invalid", "0", "-1"])
def test_invalid_limits_fall_back_to_defaults(tmp_path, monkeypatch, value):
    monkeypatch.setenv("DRAMACLAW_CANVAS_CHANGE_LOG_MAX_ENTRIES", value)
    monkeypatch.setenv("DRAMACLAW_CANVAS_CHANGE_LOG_MAX_BYTES", value)
    save(tmp_path, 1)
    save(tmp_path, 2)
    assert [entry["revision"] for entry in entries(tmp_path)] == [1, 2]


def test_signal_path_and_mtime_advance(tmp_path, changes):
    save(tmp_path, 1)
    signal = changes.canvas_change_signal_path(tmp_path, "board")
    assert changes.canvas_changes_dir(tmp_path, "board") == change_dir(tmp_path)
    assert signal == change_dir(tmp_path) / "changes.signal"
    assert signal.is_file()
    os.utime(signal, ns=(1_000_000_000, 1_000_000_000))
    previous = signal.stat().st_mtime_ns
    save(tmp_path, 2)
    assert signal.stat().st_mtime_ns > previous


def test_soft_delete_clears_entries_and_wakes_readers(tmp_path):
    save(tmp_path, 1)
    signal = change_dir(tmp_path) / "changes.signal"
    assert signal.exists()
    os.utime(signal, ns=(1_000_000_000, 1_000_000_000))
    canvas_store.soft_delete_canvas(tmp_path, "board", deleted_by="actor")
    assert entries(tmp_path) == []
    assert signal.stat().st_mtime_ns > 1_000_000_000


def test_corrupt_or_missing_entry_requires_reset(tmp_path, changes, monkeypatch):
    for revision in (1, 2, 3):
        save(tmp_path, revision)
    middle = change_dir(tmp_path) / "000000000002.json"
    middle.write_text("not json")
    replay = changes.read_canvas_changes(tmp_path, "board", 1)
    assert replay.entries == []
    assert replay.reset_revision == 3
    original = type(middle).read_text

    def vanish(path, *args, **kwargs):
        if path == middle:
            raise FileNotFoundError()
        return original(path, *args, **kwargs)

    monkeypatch.setattr(type(middle), "read_text", vanish)
    assert changes.read_canvas_changes(tmp_path, "board", 1).reset_revision == 3


@pytest.mark.parametrize("revision", [None, "1", 1.5])
def test_noninteger_revision_is_not_published(tmp_path, revision):
    canvas_store.save_canvas(
        tmp_path,
        "board",
        base_revision=None,
        build_payload=lambda existing: {"revision": revision, "nodes": []},
    )
    assert not change_dir(tmp_path).exists()


def test_failed_atomic_replace_preserves_entry_and_removes_tempfile(
    tmp_path, changes, monkeypatch, caplog
):
    save(tmp_path, 1)
    entry = change_dir(tmp_path) / "000000000001.json"
    original = entry.read_bytes()

    def fail_replace(source, destination):
        raise OSError("private content")

    monkeypatch.setattr(changes.os, "replace", fail_replace)
    with caplog.at_level(logging.WARNING):
        changes.publish_canvas_change(
            tmp_path, "board", None, {"revision": 1, "nodes": []}, save_source="test"
        )
    assert entry.read_bytes() == original
    assert sorted(path.name for path in entry.parent.iterdir()) == [
        "000000000001.json",
        "changes.signal",
    ]
    assert "OSError" in caplog.text
    assert "private content" not in caplog.text


def test_clear_failure_is_logged_without_raising(tmp_path, changes, monkeypatch, caplog):
    save(tmp_path, 1)
    original = type(tmp_path).unlink

    def fail_entry_unlink(path, *args, **kwargs):
        if path.name == "000000000001.json":
            raise OSError("private content")
        return original(path, *args, **kwargs)

    monkeypatch.setattr(type(tmp_path), "unlink", fail_entry_unlink)
    with caplog.at_level(logging.WARNING):
        changes.clear_canvas_changes(tmp_path, "board")
    assert "board" in caplog.text
    assert "OSError" in caplog.text
    assert "private content" not in caplog.text
    assert any(record.levelno == logging.WARNING for record in caplog.records)


def test_clear_missing_log_creates_no_directory(tmp_path, changes):
    changes.clear_canvas_changes(tmp_path, "board")
    assert not change_dir(tmp_path).exists()
