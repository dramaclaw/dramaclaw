"""History is reversible metadata, not destructive deletion of paid artifacts."""
import uuid

import pytest
from pydantic import ValidationError

from novelvideo.director.models import CreateWork, DirectorPreset, HistoryCommand
from novelvideo.director.store import DirectorConflict, DirectorStore
from tests.director.test_execution import runtime as execution_runtime


@pytest.fixture
def runtime(tmp_path, monkeypatch):
    return execution_runtime.__wrapped__(tmp_path, monkeypatch)


@pytest.fixture
def history(tmp_path):
    store = DirectorStore(tmp_path)
    work = store.create_work(CreateWork(title="Original", brief="A key is found.", preset=DirectorPreset(mode="original")))
    store.put_document(work["id"], "outline", "# Original\n\nKeep this paid result.", 0)
    return store, store.get_work(work["id"])


def command(work, action, **kwargs):
    return HistoryCommand(command_id=str(uuid.uuid4()), expected_revision=work["revision"], action=action, **kwargs)


def test_archive_restore_retains_document_and_version(history):
    store, work = history
    before = store.get_document(work["id"], "outline")
    archived = store.history_command(work["id"], command(work, "archive"), "actor")
    assert store.list_works() == []
    assert store.list_works(archived=True)[0]["id"] == work["id"]
    assert store.get_document(work["id"], "outline") == before
    restored = store.history_command(work["id"], command(archived, "restore"), "actor")
    assert store.list_works()[0] == restored
    assert store.list_works(archived=True) == []
    assert store.get_document(work["id"], "outline") == before


def test_rename_only_metadata_and_exact_idempotent_replay(history):
    store, work = history
    before = store.get_document(work["id"], "outline")
    intent = command(work, "rename", title="  New name  ")
    result = store.history_command(work["id"], intent, "actor")
    assert result["title"] == "New name"
    assert result["preset"] == work["preset"]
    assert result["revision"] == work["revision"] + 1
    assert store.history_command(work["id"], intent, "actor") == result
    assert store.get_document(work["id"], "outline") == before
    with pytest.raises(DirectorConflict):
        store.history_command(work["id"], intent.model_copy(update={"title": "Changed intent"}), "actor")
    with pytest.raises(DirectorConflict):
        store.history_command(work["id"], intent, "another-actor")
    with pytest.raises(DirectorConflict):
        store.history_command(work["id"], command(work, "archive"), "actor")


@pytest.mark.parametrize("status", ["queued", "dispatching", "cancel_requested", "unknown"])
def test_history_cannot_invalidate_in_flight_paid_baseline(runtime, status):
    from tests.director.test_execution import grant

    store, work, _, _, _ = runtime
    _, result = grant(runtime)
    with store._write() as db:
        db.execute("UPDATE director_operations SET status = ? WHERE id = ?", (status, result["id"]))
    with pytest.raises(DirectorConflict, match="active"):
        store.history_command(work["id"], command(work, "archive"), "actor")
    assert store.list_works()[0]["revision"] == work["revision"]


@pytest.mark.parametrize("payload", [{"action": "rename", "title": "  "}, {"action": "archive", "title": "wrong"}, {"action": "delete"}])
def test_history_rejects_ambiguous_or_destructive_payload(payload):
    with pytest.raises(ValidationError):
        HistoryCommand(command_id=str(uuid.uuid4()), expected_revision=1, **payload)
