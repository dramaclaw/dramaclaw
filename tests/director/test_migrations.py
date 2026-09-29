"""Legacy import is opt-in, no-loss, atomic, repeatable and never a quality PASS."""

from __future__ import annotations

import json

import pytest

from novelvideo.director.documents import object_hash
from novelvideo.director.migrations.v2 import preview_legacy
from novelvideo.director.models import CreateWork, DirectorPreset
from novelvideo.director.repository import DocumentRepository
from novelvideo.director.schemas.documents import DocumentCommand
from novelvideo.director.schemas.execution import ExecutionFault
from novelvideo.director.store import DirectorStore


@pytest.fixture
def legacy(tmp_path):
    store = DirectorStore(tmp_path / "中文项目")
    work = store.create_work(
        CreateWork(
            title="Legacy",
            brief="Synthetic",
            source_text="EP02\n甲持有两幅画。",
            preset=DirectorPreset(
                mode="adaptation",
                adapt_direction="condense",
                episode_count=1,
                source_episode_label="EP02",
                delivery_episode_label="EP02",
            ),
        )
    )
    with store._write() as db:
        db.execute("DELETE FROM director_authorities WHERE work_id=?", (work["id"],))
    store.put_document(work["id"], "episode-001", "# EP02\r\n甲拿画。\n| 物 | 人 |", 0)
    store.put_document(work["id"], "episode-001", "# EP02\n甲把画交给乙。", 1)
    return store, work, DocumentRepository(store)


def import_command(work, preview):
    return DocumentCommand.from_wire(
        {
            "schemaVersion": 2,
            "commandId": "import-1",
            "clientRequestId": "import-1",
            "sessionId": "s",
            "workId": work["id"],
            "expected": {
                "workRevision": preview["workRevision"],
                "documentVersions": {},
            },
            "payload": {
                "type": "import.commitLegacy",
                "previewHash": preview["previewHash"],
            },
        }
    )


def test_legacy_finalizations_survive_upgrade_and_new_review_without_blocking_reconfirmation(
    tmp_path,
):
    from tests.director.test_quality import reviewed_command
    from novelvideo.director.quality import QualityService

    store = DirectorStore(tmp_path)
    work = store.create_work(
        CreateWork(
            title="Legacy completed pair",
            brief="A key and a box.",
            preset=DirectorPreset(mode="original", episode_count=2),
        )
    )
    with store._write() as db:
        db.execute("DELETE FROM director_authorities WHERE work_id=?", (work["id"],))
    for ordinal in (1, 2):
        store.put_document(
            work["id"],
            f"episode-{ordinal:03d}",
            f"# Episode {ordinal}\nAda opens the box.",
            0,
        )
        store.finalize_episode(work["id"], ordinal, 1, True)
    with store._connect() as db:
        original = [
            dict(row)
            for row in db.execute(
                "SELECT * FROM episode_confirmations ORDER BY ordinal"
            )
        ]
    preview = preview_legacy(store, work["id"])
    DocumentRepository(store).execute("actor", import_command(work, preview))
    assert store.get_work(work["id"])["current_episode"] == 1
    assert not QualityService(store).report(work["id"], 1)["ready_for_human_review"]
    for ordinal in (1, 2):
        command = reviewed_command(store, work["id"], ordinal)
        assert QualityService(store).report(work["id"], ordinal)[
            "ready_for_human_review"
        ]
        QualityService(store).finalize("actor", command)
    assert store.get_work(work["id"])["status"] == "completed"
    with store._connect() as db:
        assert [
            dict(row)
            for row in db.execute(
                "SELECT * FROM episode_confirmations ORDER BY ordinal"
            )
        ] == original
        assert (
            db.execute("SELECT COUNT(*) FROM director_finalizations_v2").fetchone()[0]
            == 2
        )
        assert db.execute("SELECT COUNT(*) FROM document_versions").fetchone()[0] == 2


def test_preview_does_not_migrate_and_commit_preserves_every_version_source_and_label(
    legacy,
):
    store, work, repo = legacy
    preview = preview_legacy(store, work["id"])
    assert repo.projection(work["id"])["schemaVersion"] == 1
    assert preview["versionCount"] == 2 and preview["modelCalls"] == 0
    assert "PARSE_UNSUPPORTED" in preview["warnings"]
    assert preview_legacy(store, work["id"])["previewHash"] == preview["previewHash"]
    command = import_command(work, preview)
    result = repo.execute("user", command)
    assert repo.execute("user", command) == result
    projection = repo.projection(work["id"])
    episode = projection["episodes"][0]
    assert episode["sourceEpisodeLabel"] == episode["deliveryLabel"] == "EP02"
    assert episode["orderKey"] == 1
    doc = next(d for d in projection["documents"] if d["kind"] == "episode")
    assert doc["version"] == 2 and doc["status"] == "legacy_unverified"
    assert (
        store.get_work(work["id"], include_source=True)["source_text"]
        == "EP02\n甲持有两幅画。"
    )
    with store._connect() as db:
        backup = db.execute("SELECT * FROM director_migration_backups").fetchone()
        original = json.loads(backup["backup_json"])
        assert object_hash(original) == backup["source_hash"] == preview["sourceHash"]
        assert original["document_versions"][0]["content"].startswith("# EP02\r\n")
        assert db.execute("SELECT COUNT(*) FROM document_versions").fetchone()[0] == 2
        assert (
            db.execute("SELECT COUNT(*) FROM director_document_asts").fetchone()[0] == 2
        )


def test_import_rejects_stale_preview_and_keeps_v1_unchanged(legacy):
    store, work, repo = legacy
    preview = preview_legacy(store, work["id"])
    store.put_document(work["id"], "episode-001", "# EP02\n新版本。", 2)
    with pytest.raises(ExecutionFault, match="VERSION_CONFLICT"):
        repo.execute("user", import_command(work, preview))
    assert repo.projection(work["id"])["schemaVersion"] == 1


def test_failed_import_rolls_back_all_canonical_data_then_retry_succeeds(
    legacy, monkeypatch
):
    from novelvideo.director.migrations import v2

    store, work, repo = legacy
    preview = preview_legacy(store, work["id"])
    original = v2.write_ast
    calls = []

    def fail_second(*args, **kwargs):
        calls.append(1)
        if len(calls) == 2:
            raise RuntimeError("injected interruption")
        return original(*args, **kwargs)

    monkeypatch.setattr(v2, "write_ast", fail_second)
    with pytest.raises(RuntimeError, match="injected"):
        repo.execute("user", import_command(work, preview))
    assert repo.projection(work["id"])["schemaVersion"] == 1
    with store._connect() as db:
        assert (
            db.execute("SELECT COUNT(*) FROM director_document_asts").fetchone()[0] == 0
        )
        assert (
            db.execute("SELECT COUNT(*) FROM director_migration_backups").fetchone()[0]
            == 0
        )
    monkeypatch.setattr(v2, "write_ast", original)
    assert repo.execute("user", import_command(work, preview))["result"]["migrated"]


def test_pending_proposal_cannot_be_silently_abandoned_by_migration(legacy):
    store, work, repo = legacy
    store.propose_change(work["id"], "episode-001", "candidate", 2, "test")
    preview = preview_legacy(store, work["id"])
    with pytest.raises(ExecutionFault, match="PENDING_CHANGES"):
        repo.execute("user", import_command(work, preview))
    assert repo.projection(work["id"])["schemaVersion"] == 1


def test_other_work_cannot_reuse_preview(legacy):
    store, work, repo = legacy
    preview = preview_legacy(store, work["id"])
    other = store.create_work(
        CreateWork(
            title="Other", brief="Unrelated", preset=DirectorPreset(mode="original")
        )
    )
    command = import_command(other, preview)
    with pytest.raises(ExecutionFault, match="ALREADY_CANONICAL"):
        repo.execute("user", command)
