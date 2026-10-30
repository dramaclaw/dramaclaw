from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from novelvideo.freezone import canvas_store
from novelvideo.freezone.canvas_lock import (
    CanvasLockBusy,
    canvas_lock_path,
    canvas_write_lock,
)


def _write_canvas_for_list(
    project_dir: Path,
    canvas_id: str,
    *,
    created_at: str,
    modified_time: int,
    canvas_scope: str = "beat",
    episode: int | None = None,
    beat: int | None = None,
) -> None:
    canvas_file = project_dir / "freezone" / "canvases" / f"{canvas_id}.json"
    canvas_file.parent.mkdir(parents=True, exist_ok=True)
    canvas_file.write_text(
        json.dumps(
            {
                "schema_version": 2,
                "canvas_id": canvas_id,
                "project_id": "proj",
                "canvas_scope": canvas_scope,
                "episode": episode,
                "beat": beat,
                "created_at": created_at,
                "updated_at": "2026-05-28T12:00:00",
                "revision": 1,
                "nodes": [],
                "edges": [],
            }
        ),
        encoding="utf-8",
    )
    os.utime(canvas_file, (modified_time, modified_time))


def _write_preset_canvas(
    project_dir: Path,
    canvas_id: str,
    *,
    preset_key: str,
    modified_time: int,
    deleted: bool = False,
) -> None:
    suffix = ".deleted.json" if deleted else ".json"
    canvas_file = project_dir / "freezone" / "canvases" / f"{canvas_id}{suffix}"
    canvas_file.parent.mkdir(parents=True, exist_ok=True)
    canvas_file.write_text(
        json.dumps(
            {
                "schema_version": 2,
                "canvas_id": canvas_id,
                "project_id": "proj",
                "revision": 1,
                "nodes": [],
                "edges": [],
                "metadata": {"preset": {"preset_key": preset_key}},
            }
        ),
        encoding="utf-8",
    )
    os.utime(canvas_file, (modified_time, modified_time))


def test_latest_preset_canvas_reuses_old_entry_by_key_without_time_window(
    tmp_path: Path,
) -> None:
    project_dir = tmp_path / "project"
    _write_preset_canvas(
        project_dir,
        "old_beat_canvas",
        preset_key="beat:ep001:beat002:sketch",
        modified_time=100,
    )

    found = canvas_store.latest_preset_canvas(project_dir, "beat:ep001:beat002:sketch")

    assert found == "old_beat_canvas"


def test_latest_preset_canvas_chooses_most_recent_matching_live_canvas(
    tmp_path: Path,
) -> None:
    project_dir = tmp_path / "project"
    _write_preset_canvas(
        project_dir,
        "deleted_newer",
        preset_key="beat:ep001:beat002:sketch",
        modified_time=300,
        deleted=True,
    )
    _write_preset_canvas(
        project_dir,
        "older_match",
        preset_key="beat:ep001:beat002:sketch",
        modified_time=100,
    )
    _write_preset_canvas(
        project_dir,
        "newer_match",
        preset_key="beat:ep001:beat002:sketch",
        modified_time=200,
    )
    _write_preset_canvas(
        project_dir,
        "newer_other_key",
        preset_key="beat:ep001:beat003:sketch",
        modified_time=400,
    )

    found = canvas_store.latest_preset_canvas(project_dir, "beat:ep001:beat002:sketch")

    assert found == "newer_match"


def test_list_canvases_keeps_default_first_then_beat_order_then_assets(
    tmp_path: Path,
) -> None:
    project_dir = tmp_path / "project"
    _write_canvas_for_list(
        project_dir,
        "beat_ep001_b03",
        created_at="2026-05-28T10:01:00",
        modified_time=100,
        episode=1,
        beat=3,
    )
    _write_canvas_for_list(
        project_dir,
        "asset_character",
        created_at="2026-05-28T09:00:00",
        modified_time=400,
        canvas_scope="asset",
    )
    _write_canvas_for_list(
        project_dir,
        "default",
        created_at="2026-05-28T10:02:00",
        modified_time=300,
        canvas_scope="default",
    )
    _write_canvas_for_list(
        project_dir,
        "beat_ep001_b01",
        created_at="2026-05-28T10:03:00",
        modified_time=200,
        episode=1,
        beat=1,
    )
    _write_canvas_for_list(
        project_dir,
        "beat_ep002_b01",
        created_at="2026-05-28T10:00:00",
        modified_time=500,
        episode=2,
        beat=1,
    )

    listed = canvas_store.list_canvases(project_dir)

    assert [item["id"] for item in listed] == [
        "default",
        "beat_ep001_b01",
        "beat_ep001_b03",
        "beat_ep002_b01",
        "asset_character",
    ]
    assert listed[0]["created_at"] == "2026-05-28T10:02:00"


def test_list_canvases_modified_at_is_utc_z_timestamp(tmp_path: Path) -> None:
    project_dir = tmp_path / "project"
    _write_canvas_for_list(
        project_dir,
        "default",
        created_at="2026-05-28T10:02:00",
        modified_time=0,
        canvas_scope="default",
    )

    listed = canvas_store.list_canvases(project_dir)

    assert listed[0]["modified_at"] == "1970-01-01T00:00:00Z"


def test_list_canvases_uses_preset_created_at_for_older_payloads(tmp_path: Path) -> None:
    project_dir = tmp_path / "project"
    canvas_dir = project_dir / "freezone" / "canvases"
    canvas_dir.mkdir(parents=True)
    first = canvas_dir / "beat_a.json"
    second = canvas_dir / "beat_b.json"
    first.write_text(
        json.dumps(
            {
                "canvas_id": "beat_a",
                "metadata": {
                    "preset": {
                        "scope": "beat",
                        "episode": 1,
                        "beat": 2,
                        "created_at": "2026-05-28T10:01:00",
                    }
                },
                "nodes": [],
                "edges": [],
            }
        ),
        encoding="utf-8",
    )
    second.write_text(
        json.dumps(
            {
                "canvas_id": "beat_b",
                "metadata": {
                    "preset": {
                        "scope": "beat",
                        "episode": 1,
                        "beat": 1,
                        "created_at": "2026-05-28T10:02:00",
                    }
                },
                "nodes": [],
                "edges": [],
            }
        ),
        encoding="utf-8",
    )
    os.utime(first, (300, 300))
    os.utime(second, (100, 100))

    listed = canvas_store.list_canvases(project_dir)

    assert [item["id"] for item in listed] == ["beat_b", "beat_a"]
    assert listed[0]["canvas_scope"] == "beat"
    assert listed[0]["episode"] == 1
    assert listed[0]["beat"] == 1


def test_ensure_default_canvas_creates_minimal_system_canvas(tmp_path: Path) -> None:
    project_dir = tmp_path / "project"

    result = canvas_store.ensure_default_canvas(
        project_dir,
        project_id="proj_freezone",
        actor_id="owner_1",
    )

    canvas_file = project_dir / "freezone" / "canvases" / "default.json"
    saved = json.loads(canvas_file.read_text(encoding="utf-8"))
    assert result.created is True
    assert result.payload == saved
    assert saved["schema_version"] == 2
    assert saved["canvas_id"] == "default"
    assert saved["project_id"] == "proj_freezone"
    assert saved["canvas_scope"] == "default"
    assert saved["revision"] == 1
    assert saved["nodes"] == []
    assert saved["edges"] == []
    assert saved["viewport"] is None
    assert saved["metadata"] is None
    assert saved["created_by"] == "owner_1"
    assert saved["updated_by"] == "owner_1"
    assert saved["created_at"].endswith("Z")
    assert saved["updated_at"].endswith("Z")
    assert not list((canvas_file.parent / "_history").glob("default.rev*.json"))


def test_ensure_default_canvas_is_idempotent(tmp_path: Path) -> None:
    project_dir = tmp_path / "project"

    first = canvas_store.ensure_default_canvas(
        project_dir,
        project_id="proj_freezone",
        actor_id="owner_1",
    )
    second = canvas_store.ensure_default_canvas(
        project_dir,
        project_id="proj_freezone",
        actor_id="owner_1",
    )

    assert first.created is True
    assert second.created is False
    assert second.payload == first.payload
    assert second.payload["revision"] == 1
    canvas_file = project_dir / "freezone" / "canvases" / "default.json"
    assert not list((canvas_file.parent / "_history").glob("default.rev*.json"))


def test_ensure_default_canvas_does_not_recreate_deleted_default(tmp_path: Path) -> None:
    project_dir = tmp_path / "project"
    canvas_dir = project_dir / "freezone" / "canvases"
    canvas_dir.mkdir(parents=True)
    tombstone = canvas_dir / "default.deleted.json"
    tombstone.write_text(
        json.dumps(
            {
                "schema_version": "canvas_tombstone.v1",
                "canvas_id": "default",
                "deleted": True,
                "revision": 3,
            }
        ),
        encoding="utf-8",
    )

    result = canvas_store.ensure_default_canvas(
        project_dir,
        project_id="proj_freezone",
        actor_id="owner_1",
    )

    assert result.created is False
    assert result.payload["deleted"] is True
    assert not (canvas_dir / "default.json").exists()


def test_canvas_write_lock_reports_busy(tmp_path: Path) -> None:
    project_dir = tmp_path / "project"

    with canvas_write_lock(project_dir, "default", timeout_seconds=0.01):
        with pytest.raises(CanvasLockBusy):
            with canvas_write_lock(
                project_dir,
                "default",
                timeout_seconds=0.01,
                retry_interval_seconds=0.001,
            ):
                pass


def test_save_canvas_prunes_history_to_retention_limit(tmp_path: Path) -> None:
    project_dir = tmp_path / "project"
    canvas_file = project_dir / "freezone" / "canvases" / "default.json"
    canvas_file.parent.mkdir(parents=True)
    canvas_file.write_text(
        json.dumps(
            {
                "schema_version": 2,
                "canvas_id": "default",
                "project_id": "proj",
                "revision": 0,
                "nodes": [],
                "edges": [],
            }
        ),
        encoding="utf-8",
    )

    for revision in range(105):
        result = canvas_store.save_canvas(
            project_dir,
            "default",
            base_revision=revision,
            build_payload=lambda _existing, rev=revision: {
                "schema_version": 2,
                "canvas_id": "default",
                "project_id": "proj",
                "revision": rev + 1,
                "nodes": [{"id": f"node_{rev + 1}"}],
                "edges": [],
            },
        )
        assert result.payload["revision"] == revision + 1

    history_files = list((canvas_file.parent / "_history").glob("default.rev*.json"))
    assert len(history_files) == canvas_store.HISTORY_RETENTION_LIMIT
    assert not list((canvas_file.parent / "_history").glob("default.rev0.*.json"))
    assert list((canvas_file.parent / "_history").glob("default.rev104.*.json"))


def test_save_canvas_idempotency_returns_cached_response(tmp_path: Path) -> None:
    project_dir = tmp_path / "project"
    canvas_file = project_dir / "freezone" / "canvases" / "default.json"
    canvas_file.parent.mkdir(parents=True)
    canvas_file.write_text(
        json.dumps({"revision": 1, "nodes": [{"id": "old_1"}, {"id": "old_2"}], "edges": []}),
        encoding="utf-8",
    )

    first = canvas_store.save_canvas(
        project_dir,
        "default",
        base_revision=1,
        client_save_id="save-1",
        request_hash=canvas_store.canvas_request_hash(
            {
                "base_revision": 1,
                "nodes": [{"id": "new"}],
                "edges": [],
            }
        ),
        build_payload=lambda _existing: {
            "revision": 2,
            "nodes": [{"id": "new"}],
            "edges": [],
            "updated_at": "2026-05-28T12:00:00",
        },
    )
    second = canvas_store.save_canvas(
        project_dir,
        "default",
        base_revision=1,
        client_save_id="save-1",
        request_hash=canvas_store.canvas_request_hash(
            {
                "base_revision": 1,
                "nodes": [{"id": "new"}],
                "edges": [],
            }
        ),
        build_payload=lambda _existing: {
            "revision": 999,
            "nodes": [{"id": "should_not_write"}],
            "edges": [],
        },
    )

    assert first.response_cache == second.response_cache
    assert second.idempotent is True
    saved = json.loads(canvas_file.read_text(encoding="utf-8"))
    assert saved["revision"] == 2
    assert saved["nodes"] == [{"id": "new"}]
    assert len(list((canvas_file.parent / "_history").glob("default.rev*.json"))) == 1


def test_save_canvas_skip_if_short_circuits_before_revision_check(tmp_path: Path) -> None:
    project_dir = tmp_path / "project"
    canvas_file = project_dir / "freezone" / "canvases" / "default.json"
    canvas_file.parent.mkdir(parents=True)
    canvas_file.write_text(
        json.dumps({
            "revision": 7,
            "nodes": [{"id": "existing"}],
            "edges": [],
            "metadata": {"preset": {"facts_signature": "same"}},
        }),
        encoding="utf-8",
    )

    result = canvas_store.save_canvas(
        project_dir,
        "default",
        base_revision=3,
        skip_if=lambda existing: (
            {"saved": False, "revision": existing["revision"], "updated_at": existing.get("updated_at")}
            if existing and existing.get("metadata", {}).get("preset", {}).get("facts_signature") == "same"
            else None
        ),
        build_payload=lambda _existing: {
            "revision": 999,
            "nodes": [{"id": "should_not_write"}],
            "edges": [],
        },
    )

    saved = json.loads(canvas_file.read_text(encoding="utf-8"))
    assert result.payload["revision"] == 7
    assert result.response_cache == {"saved": False, "revision": 7, "updated_at": None}
    assert saved["revision"] == 7
    assert saved["nodes"] == [{"id": "existing"}]
    assert not list((canvas_file.parent / "_history").glob("default.rev*.json"))


def test_save_canvas_rejects_idempotency_key_with_different_payload(tmp_path: Path) -> None:
    project_dir = tmp_path / "project"
    canvas_file = project_dir / "freezone" / "canvases" / "default.json"
    canvas_file.parent.mkdir(parents=True)
    canvas_file.write_text(
        json.dumps({"revision": 1, "nodes": [{"id": "old"}], "edges": []}),
        encoding="utf-8",
    )

    canvas_store.save_canvas(
        project_dir,
        "default",
        base_revision=1,
        client_save_id="save-1",
        request_hash=canvas_store.canvas_request_hash({"nodes": [{"id": "new"}]}),
        build_payload=lambda _existing: {"revision": 2, "nodes": [{"id": "new"}], "edges": []},
    )

    with pytest.raises(canvas_store.CanvasIdempotencyConflict):
        canvas_store.save_canvas(
            project_dir,
            "default",
            base_revision=1,
            client_save_id="save-1",
            request_hash=canvas_store.canvas_request_hash({"nodes": [{"id": "different"}]}),
            build_payload=lambda _existing: {
                "revision": 3,
                "nodes": [{"id": "different"}],
                "edges": [],
            },
        )

    saved = json.loads(canvas_file.read_text(encoding="utf-8"))
    assert saved["revision"] == 2
    assert saved["nodes"] == [{"id": "new"}]


def test_save_canvas_rejects_dangerous_empty_autosave(tmp_path: Path) -> None:
    project_dir = tmp_path / "project"
    canvas_file = project_dir / "freezone" / "canvases" / "default.json"
    canvas_file.parent.mkdir(parents=True)
    canvas_file.write_text(
        json.dumps({"revision": 1, "nodes": [{"id": "old_1"}, {"id": "old_2"}], "edges": []}),
        encoding="utf-8",
    )

    with pytest.raises(canvas_store.DangerousEmptyCanvasOverwrite):
        canvas_store.save_canvas(
            project_dir,
            "default",
            base_revision=1,
            save_source="autosave",
            build_payload=lambda _existing: {"revision": 2, "nodes": [], "edges": []},
        )

    saved = json.loads(canvas_file.read_text(encoding="utf-8"))
    assert saved["revision"] == 1
    assert not list((canvas_file.parent / "_history").glob("default.rev*.json"))


def test_save_canvas_warns_for_oversized_payload_but_writes(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    project_dir = tmp_path / "project"
    canvas_file = project_dir / "freezone" / "canvases" / "default.json"
    canvas_file.parent.mkdir(parents=True)
    canvas_file.write_text(
        json.dumps({"revision": 1, "nodes": [{"id": "old"}], "edges": []}),
        encoding="utf-8",
    )
    monkeypatch.setattr(canvas_store, "CANVAS_PAYLOAD_SIZE_LIMIT_BYTES", 512)

    result = canvas_store.save_canvas(
        project_dir,
        "default",
        base_revision=1,
        build_payload=lambda _existing: {
            "revision": 2,
            "nodes": [
                {
                    "id": "big",
                    "type": "exportImageNode",
                    "data": {"imageUrl": "data:image/png;base64," + ("a" * 1024)},
                }
            ],
            "edges": [],
        },
    )

    assert result.response_cache is not None
    warning = result.response_cache["warning"]
    assert warning["code"] == "canvas_payload_large"
    assert warning["actual_kb"] > warning["limit_kb"]
    assert warning["top_fields"][0]["path"] == "nodes[0]"
    assert any(row["path"] == "nodes[0].data.imageUrl" for row in warning["top_fields"])
    saved = json.loads(canvas_file.read_text(encoding="utf-8"))
    assert saved["revision"] == 2
    assert saved["nodes"][0]["id"] == "big"
    assert len(list((canvas_file.parent / "_history").glob("default.rev1.*.json"))) == 1


def test_save_canvas_rejects_dangerous_empty_autosave_for_last_node(tmp_path: Path) -> None:
    project_dir = tmp_path / "project"
    canvas_file = project_dir / "freezone" / "canvases" / "default.json"
    canvas_file.parent.mkdir(parents=True)
    canvas_file.write_text(
        json.dumps({"revision": 1, "nodes": [{"id": "last"}], "edges": []}),
        encoding="utf-8",
    )

    with pytest.raises(canvas_store.DangerousEmptyCanvasOverwrite):
        canvas_store.save_canvas(
            project_dir,
            "default",
            base_revision=1,
            save_source="autosave",
            build_payload=lambda _existing: {"revision": 2, "nodes": [], "edges": []},
        )

    saved = json.loads(canvas_file.read_text(encoding="utf-8"))
    assert saved["revision"] == 1
    assert saved["nodes"] == [{"id": "last"}]
    assert not list((canvas_file.parent / "_history").glob("default.rev*.json"))


def test_soft_delete_canvas_clears_idempotency_file(tmp_path: Path) -> None:
    project_dir = tmp_path / "project"
    canvas_file = project_dir / "freezone" / "canvases" / "default.json"
    canvas_file.parent.mkdir(parents=True)
    canvas_file.write_text(
        json.dumps({"revision": 1, "nodes": [{"id": "n"}], "edges": []}),
        encoding="utf-8",
    )
    # Populate idempotency cache by performing a save.
    canvas_store.save_canvas(
        project_dir,
        "default",
        base_revision=1,
        client_save_id="save-1",
        request_hash=canvas_store.canvas_request_hash({"nodes": [{"id": "n2"}]}),
        build_payload=lambda _existing: {"revision": 2, "nodes": [{"id": "n2"}], "edges": []},
    )
    idem_path = canvas_store.canvas_idempotency_path(project_dir, "default")
    assert idem_path.exists(), "precondition: idempotency cache should have been written"

    canvas_store.soft_delete_canvas(project_dir, "default", deleted_by="alice")

    assert not idem_path.exists(), (
        "soft_delete_canvas must remove the idempotency cache so a future "
        "re-creation with the same canvas_id is not corrupted by stale entries"
    )
    tombstone = json.loads(canvas_file.with_name("default.deleted.json").read_text())
    assert tombstone["deleted_at"].endswith("Z")


def test_prune_orphan_locks_removes_locks_without_canvas(tmp_path: Path) -> None:
    project_dir = tmp_path / "project"
    canvases_dir = project_dir / "freezone" / "canvases"
    canvases_dir.mkdir(parents=True)
    # Live canvas with an active lock file.
    (canvases_dir / "live.json").write_text(
        json.dumps({"revision": 1, "nodes": [], "edges": []}),
        encoding="utf-8",
    )
    live_lock = canvas_lock_path(project_dir, "live")
    live_lock.parent.mkdir(parents=True, exist_ok=True)
    live_lock.touch()
    # Orphan lock — the canvas was deleted but the lock file lingered.
    orphan_lock = canvas_lock_path(project_dir, "ghost")
    orphan_lock.touch()
    # Tombstoned canvas: lock should also be considered orphan because the
    # canvas file is gone (tombstone marker has a different filename).
    (canvases_dir / "soft_deleted.deleted.json").write_text(
        json.dumps({"deleted": True, "canvas_id": "soft_deleted"}),
        encoding="utf-8",
    )
    soft_deleted_lock = canvas_lock_path(project_dir, "soft_deleted")
    soft_deleted_lock.touch()

    removed = canvas_store.prune_orphan_locks(project_dir)

    assert live_lock.exists(), "lock for an existing canvas must be preserved"
    assert not orphan_lock.exists(), "orphan lock with no canvas must be removed"
    assert not soft_deleted_lock.exists(), (
        "lock whose canvas only has a tombstone (.deleted.json) is orphan"
    )
    assert {p.name for p in removed} == {"ghost.lock", "soft_deleted.lock"}


def test_save_canvas_allows_manual_clear_of_last_node(tmp_path: Path) -> None:
    project_dir = tmp_path / "project"
    canvas_file = project_dir / "freezone" / "canvases" / "default.json"
    canvas_file.parent.mkdir(parents=True)
    canvas_file.write_text(
        json.dumps({"revision": 1, "nodes": [{"id": "last"}], "edges": []}),
        encoding="utf-8",
    )

    result = canvas_store.save_canvas(
        project_dir,
        "default",
        base_revision=1,
        save_source="manual_clear",
        allow_empty_overwrite=True,
        build_payload=lambda _existing: {"revision": 2, "nodes": [], "edges": []},
    )

    saved = json.loads(canvas_file.read_text(encoding="utf-8"))
    assert result.payload["revision"] == 2
    assert saved["nodes"] == []
    assert len(list((canvas_file.parent / "_history").glob("default.rev1.*.json"))) == 1


def test_save_rejects_multiple_story_groups_without_changing_canvas(tmp_path):
    group = {"id": "story", "type": "groupNode", "data": {"storyGroup": True}}
    original = {"revision": 1, "nodes": [group], "edges": []}
    canvas_store.save_canvas(
        tmp_path, "c", base_revision=0, build_payload=lambda _: original,
    )
    path = canvas_store.canvas_path(tmp_path, "c")
    before = path.read_bytes()
    history = canvas_store.list_canvas_history(tmp_path, "c")
    with pytest.raises(canvas_store.CanvasStoryGroupLimit):
        canvas_store.save_canvas(
            tmp_path, "c", base_revision=1,
            build_payload=lambda _: {**original, "revision": 2, "nodes": [group, {**group, "id": "second"}]},
        )
    assert path.read_bytes() == before
    assert canvas_store.list_canvas_history(tmp_path, "c") == history
    # Regular groups and stories on separate canvases remain supported.
    canvas_store.save_canvas(
        tmp_path, "c", base_revision=1,
        build_payload=lambda _: {**original, "revision": 2, "nodes": [group, {"id": "normal", "type": "groupNode", "data": {}}]},
    )
    canvas_store.save_canvas(tmp_path, "other", base_revision=0, build_payload=lambda _: original)


def test_story_group_limit_maps_to_structured_http_error():
    from fastapi import HTTPException
    from novelvideo.api.routes.freezone import _raise_canvas_store_http

    with pytest.raises(HTTPException) as error:
        _raise_canvas_store_http(canvas_store.CanvasStoryGroupLimit())
    assert error.value.status_code == 409
    assert error.value.detail["code"] == "story_group_limit"


def test_restore_cannot_reintroduce_multiple_story_groups(tmp_path, monkeypatch):
    group = {"id": "story", "type": "groupNode", "data": {"storyGroup": True}}
    payload = {"revision": 1, "nodes": [group], "edges": []}
    canvas_store.save_canvas(tmp_path, "c", base_revision=0, build_payload=lambda _: payload)
    path = canvas_store.canvas_path(tmp_path, "c")
    before = path.read_bytes()
    old = tmp_path / "old.json"
    old.write_text(json.dumps({**payload, "nodes": [group, {**group, "id": "second"}]}))
    monkeypatch.setattr(canvas_store, "resolve_canvas_history_file", lambda *args: old)
    with pytest.raises(canvas_store.CanvasStoryGroupLimit):
        canvas_store.restore_canvas_version(
            tmp_path, "c", base_revision=1, history_id="old",
            build_payload=lambda _, historical: {**historical, "revision": 2},
        )
    assert path.read_bytes() == before
