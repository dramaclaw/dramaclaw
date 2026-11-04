from concurrent.futures import ProcessPoolExecutor
from dataclasses import replace
from hashlib import sha256
from uuid import uuid4

import pytest

from novelvideo.project_context import ProjectContext


@pytest.fixture
def ctx(tmp_path):
    return ProjectContext(
        "project",
        "demo",
        "user",
        "owner",
        "owner",
        "user",
        "user",
        (),
        "editor",
        "local",
        tmp_path / "output",
        tmp_path / "state",
        tmp_path / "runtime",
        True,
    )


@pytest.fixture
def store(ctx, tmp_path):
    from novelvideo.audio.voice_design_storage import VoiceDesignStorage

    return VoiceDesignStorage(ctx, quota_path=tmp_path / "quota.sqlite3")


def reserve(store, candidate_id=None):
    return store.reserve(
        candidate_id or str(uuid4()),
        description="男声",
        preview_text="今天的天气很好，我们沿着河边慢慢走回家。",
        language="zh",
        surface="supertale",
    )


def test_persistent_idempotency_and_conflict(store, ctx):
    from novelvideo.audio.voice_design_storage import (
        CandidateStorageError,
        VoiceDesignStorage,
    )

    record, created = reserve(store)
    reopened = VoiceDesignStorage(ctx, quota_path=store.quota_path)
    assert created
    assert reserve(reopened, record["candidate_id"]) == (record, False)
    with pytest.raises(CandidateStorageError, match="idempotency_conflict"):
        reopened.reserve(
            record["candidate_id"],
            description="changed",
            preview_text=record["preview_text"],
            language="zh",
            surface="supertale",
        )


def claim_process(ctx, quota_path, candidate_id):
    from novelvideo.audio.voice_design_storage import VoiceDesignStorage

    return bool(VoiceDesignStorage(ctx, quota_path=quota_path).claim(candidate_id))


def test_cross_process_claim_once(store, ctx):
    record, _ = reserve(store)
    with ProcessPoolExecutor(2) as pool:
        results = list(
            pool.map(
                claim_process,
                [ctx] * 2,
                [store.quota_path] * 2,
                [record["candidate_id"]] * 2,
            )
        )
    assert sorted(results) == [False, True]


def test_claim_expiry_is_unknown_never_reclaimed(store):
    now = [1000.0]
    store.clock = lambda: now[0]
    record, _ = reserve(store)
    assert store.claim(record["candidate_id"])
    now[0] += store.lease_seconds + 1
    assert store.get(record["candidate_id"])["status"] == "unknown"
    assert store.claim(record["candidate_id"]) is None


def test_isolation(store, ctx):
    from novelvideo.audio.voice_design_storage import VoiceDesignStorage

    record, _ = reserve(store)
    assert (
        VoiceDesignStorage(
            replace(ctx, requester_user_id="other"), quota_path=store.quota_path
        ).get(record["candidate_id"])
        is None
    )
    assert (
        VoiceDesignStorage(
            replace(ctx, project_id="other"), quota_path=store.quota_path
        ).get(record["candidate_id"])
        is None
    )


def finish(store, candidate_id):
    assert store.claim(candidate_id)
    path = store.output_path(candidate_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"validated mp3 bytes")
    return store.complete(
        candidate_id, duration_seconds=3.5, sha256=sha256(path.read_bytes()).hexdigest()
    )


def test_seven_day_default_keeps_more_than_five_previews(store):
    store.clock = lambda: 1000
    records = []
    for _ in range(7):
        record, _ = reserve(store)
        records.append(finish(store, record["candidate_id"]))
    assert records[0]["expires_at"] == 1000 + 7 * 24 * 3600
    assert store.get(records[0]["candidate_id"])["status"] == "ready"
    assert store.output_path(records[0]["candidate_id"]).exists()


def test_keyset_pages_keep_original_snapshot_when_new_result_arrives(store):
    store.clock = lambda: 1000
    records = []
    for _ in range(7):
        record, _ = reserve(store)
        records.append(finish(store, record["candidate_id"]))
    page, cursor = store.list_ready(limit=2)
    collected = [r["candidate_id"] for r in page]
    store.clock = lambda: 1001
    newest, _ = reserve(store)
    finish(store, newest["candidate_id"])
    while cursor:
        page, cursor = store.list_ready(limit=2, cursor=cursor)
        collected.extend(r["candidate_id"] for r in page)
    assert collected == sorted((r["candidate_id"] for r in records), reverse=True)
    assert len(collected) == len(set(collected)) == 7


@pytest.mark.parametrize("cursor", ["", "bad", "*", "bnVsbA==", "W3RydWUsICJ4Il0=", "a" * 257])
def test_keyset_rejects_invalid_cursor(store, cursor):
    from novelvideo.audio.voice_design_storage import CandidateStorageError

    with pytest.raises(CandidateStorageError, match="invalid_input"):
        store.list_ready(cursor=cursor)


@pytest.mark.parametrize("limit", [0, 101, True, 1.5])
def test_keyset_rejects_invalid_page_size(store, limit):
    from novelvideo.audio.voice_design_storage import CandidateStorageError

    with pytest.raises(CandidateStorageError, match="invalid_input"):
        store.list_ready(limit=limit)


def test_new_ttl_never_extends_existing_records_or_revives_expired(ctx, tmp_path):
    from novelvideo.audio.voice_design_storage import VoiceDesignStorage

    now = [1000.0]
    old = VoiceDesignStorage(ctx, clock=lambda: now[0], ttl_seconds=3600, quota_path=tmp_path / "quota.db")
    record, _ = reserve(old)
    cid = record["candidate_id"]
    assert finish(old, cid)["expires_at"] == 4600
    current = VoiceDesignStorage(ctx, clock=lambda: now[0], quota_path=old.quota_path)
    assert current.ttl_seconds == 604800
    assert current.get(cid)["expires_at"] == 4600
    now[0] = 4600
    assert current.get(cid)["status"] == "expired"
    assert current.list_ready()[0] == []
    assert not current.output_path(cid).exists()
    fresh, _ = reserve(current)
    assert finish(current, fresh["candidate_id"])["expires_at"] == 4600 + 604800


def test_ttl_without_quantity_eviction_keeps_formal_files(store, ctx):
    now = [1000.0]
    store.clock = lambda: now[0]
    formal = ctx.output_dir / "formal.mp3"
    formal.parent.mkdir(parents=True)
    formal.write_bytes(b"formal")
    records = []
    for _ in range(6):
        record, _ = reserve(store)
        records.append(finish(store, record["candidate_id"]))
        now[0] += 1
    assert store.get(records[0]["candidate_id"])["status"] == "ready"
    assert store.output_path(records[0]["candidate_id"]).exists()
    assert records[-1]["expires_at"] == records[-1]["created_at"] + 604800
    now[0] += 604800
    store.cleanup()
    assert store.get(records[-1]["candidate_id"])["status"] == "expired"
    assert formal.read_bytes() == b"formal"


def test_daily_quota_and_concurrency_span_projects(store, ctx, tmp_path):
    from novelvideo.audio.voice_design_storage import (
        CandidateStorageError,
        VoiceDesignStorage,
    )

    other = VoiceDesignStorage(
        replace(ctx, project_id="second", state_dir=tmp_path / "second-state"),
        quota_path=store.quota_path,
    )
    first, _ = reserve(store)
    second, _ = reserve(other)
    assert store.claim(first["candidate_id"], daily_limit=1)
    with pytest.raises(CandidateStorageError, match="rate_limited"):
        other.claim(second["candidate_id"], daily_limit=1)
    store.fail(first["candidate_id"], "provider_bad_audio")
    with pytest.raises(CandidateStorageError, match="voice_design_quota_exceeded"):
        other.claim(second["candidate_id"], daily_limit=1)


def test_ready_requires_matching_local_file(store):
    from novelvideo.audio.voice_design_storage import CandidateStorageError

    record, _ = reserve(store)
    store.claim(record["candidate_id"])
    with pytest.raises(CandidateStorageError, match="candidate_persist_failed"):
        store.complete(record["candidate_id"], duration_seconds=3, sha256="a" * 64)
    assert store.get(record["candidate_id"])["status"] == "generating"


def test_channel_budget_spans_users_and_quota_resets_next_day(store, ctx, tmp_path):
    from novelvideo.audio.voice_design_storage import (
        CandidateStorageError,
        VoiceDesignStorage,
    )

    now = [86400.0]
    store.clock = lambda: now[0]
    other = VoiceDesignStorage(
        replace(ctx, requester_user_id="other"),
        clock=lambda: now[0],
        quota_path=store.quota_path,
    )
    first, _ = reserve(store)
    second, _ = reserve(other)
    store.claim(
        first["candidate_id"], channel_key="shared-channel", channel_daily_limit=1
    )
    store.fail(first["candidate_id"], "provider_bad_audio")
    with pytest.raises(CandidateStorageError, match="voice_design_quota_exceeded"):
        other.claim(
            second["candidate_id"], channel_key="shared-channel", channel_daily_limit=1
        )
    now[0] += 86400
    second, _ = reserve(other)
    assert other.claim(
        second["candidate_id"], channel_key="shared-channel", channel_daily_limit=1
    )


def test_ttl_starts_after_generation_and_late_completion_fails(store):
    from novelvideo.audio.voice_design_storage import CandidateStorageError

    now = [1000.0]
    store.clock = lambda: now[0]
    first, _ = reserve(store)
    now[0] += 60
    completed = finish(store, first["candidate_id"])
    assert completed["created_at"] == 1060
    assert completed["expires_at"] == 1060 + 604800
    second, _ = reserve(store)
    store.claim(second["candidate_id"])
    path = store.output_path(second["candidate_id"])
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"audio")
    now[0] += store.lease_seconds + 1
    with pytest.raises(CandidateStorageError, match="candidate_not_ready"):
        store.complete(
            second["candidate_id"],
            duration_seconds=3,
            sha256=sha256(b"audio").hexdigest(),
        )
    assert store.get(second["candidate_id"])["status"] == "unknown"
    assert not path.exists()


def test_runtime_ttl_configuration(ctx, tmp_path, monkeypatch):
    from novelvideo.audio.voice_design_storage import VoiceDesignStorage

    monkeypatch.setenv("VOICE_DESIGN_CANDIDATE_TTL_SECONDS", "30")
    store = VoiceDesignStorage(
        ctx, clock=lambda: 1000, quota_path=tmp_path / "quota.sqlite3"
    )
    record, _ = reserve(store)
    completed = finish(store, record["candidate_id"])
    assert completed["expires_at"] == 1030


def test_parent_symlink_cannot_publish_or_delete_formal_audio(store, ctx):
    from novelvideo.audio.voice_design_storage import CandidateStorageError

    record, _ = reserve(store)
    candidate_id = record["candidate_id"]
    store.claim(candidate_id)
    formal = ctx.output_dir / "formal"
    formal.mkdir(parents=True)
    protected = formal / f"{candidate_id}.mp3"
    protected.write_bytes(b"formal")
    root = ctx.runtime_dir / "voice-design"
    root.mkdir(parents=True)
    (root / ctx.requester_user_id).symlink_to(formal, target_is_directory=True)
    with pytest.raises(CandidateStorageError):
        store.complete(
            candidate_id, duration_seconds=3, sha256=sha256(b"formal").hexdigest()
        )
    store.mark_unknown(candidate_id)
    with pytest.raises(CandidateStorageError):
        store.cleanup()
    assert protected.read_bytes() == b"formal"


def test_unclaimed_queued_candidate_recovers_after_restart(store, ctx):
    from novelvideo.audio.voice_design_storage import VoiceDesignStorage

    store.clock = lambda: 1000
    record, _ = reserve(store)
    store.mark_queued(record["candidate_id"])
    reopened = VoiceDesignStorage(
        ctx, clock=lambda: 1000 + 86400, quota_path=store.quota_path
    )
    recovered = reopened.get(record["candidate_id"])
    assert recovered["status"] == "unknown"
    assert recovered["description"] == record["description"]
    assert reopened.claim(record["candidate_id"]) is None
    fresh, _ = reserve(reopened)
    assert reopened.claim(fresh["candidate_id"])


def test_sweep_discovers_candidates_without_requests(store):
    from novelvideo.audio.voice_design_storage import sweep_candidates

    store.clock = lambda: 1000
    record, _ = reserve(store)
    finish(store, record["candidate_id"])
    path = store.output_path(record["candidate_id"])
    sweep_candidates(quota_path=store.quota_path, clock=lambda: 605801)
    assert not path.exists()


def sweep_process(quota_path):
    from novelvideo.audio.voice_design_storage import sweep_candidates

    sweep_candidates(quota_path=quota_path, clock=lambda: 605801)
    return True


def test_multiple_cleanup_processes_are_idempotent(store):
    store.clock = lambda: 1000
    record, _ = reserve(store)
    finish(store, record["candidate_id"])
    with ProcessPoolExecutor(2) as pool:
        assert list(pool.map(sweep_process, [store.quota_path] * 2)) == [True, True]
    assert not store.output_path(record["candidate_id"]).exists()
    assert store.get(record["candidate_id"])["status"] == "expired"


def test_saved_candidate_does_not_count_toward_unsaved_limit(store):
    record, _ = reserve(store)
    candidate_id = record["candidate_id"]
    store.claim(candidate_id)
    path = store.output_path(candidate_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"audio")
    store.complete(
        candidate_id, duration_seconds=4, sha256=sha256(b"audio").hexdigest()
    )
    store.save_receipt(
        str(uuid4()), candidate_id, "character", "hero/default", {"sha256": "saved"}
    )
    for _ in range(5):
        reserve(store)
    assert store.get(candidate_id)["status"] == "ready"
    assert path.read_bytes() == b"audio"


def test_save_receipts_are_scoped_by_kind_and_reject_changed_target(store):
    from novelvideo.audio.voice_design_storage import CandidateStorageError

    record, _ = reserve(store)
    request_id = str(uuid4())
    for kind in ("character", "user_voice"):
        store.save_receipt(request_id, record["candidate_id"], kind, "target", None)
        store.save_receipt(
            request_id, record["candidate_id"], kind, "target", {"path": kind}
        )
        assert store.receipt(request_id, kind)["result"] == {"path": kind}
        with pytest.raises(CandidateStorageError, match="idempotency_conflict"):
            store.save_receipt(request_id, record["candidate_id"], kind, "other", {})


def test_saved_candidate_keeps_original_ttl(store):
    record, _ = reserve(store)
    cid = record["candidate_id"]
    store.claim(cid)
    path = store.output_path(cid)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"audio")
    ready = store.complete(cid, duration_seconds=4, sha256=sha256(b"audio").hexdigest())
    store.save_receipt(
        str(uuid4()), cid, "character", "hero/default", {"path": "saved"}
    )
    store.clock = lambda: ready["expires_at"] + 1
    assert store.get(cid)["status"] == "expired"
    assert not path.exists()


def test_upgrade_preserves_legacy_candidates_without_inventing_model(store, ctx):
    from novelvideo.audio.voice_design_storage import VoiceDesignStorage

    candidate, _ = reserve(store)
    assert candidate["model"] is None
    with store._transaction() as db:
        for column in ("catalog_id", "config_digest", "model_snapshot"):
            db.execute(f"ALTER TABLE candidates DROP COLUMN {column}")
    upgraded = VoiceDesignStorage(ctx, quota_path=store.quota_path)
    record = upgraded.get(candidate["candidate_id"])
    assert record["description"] == candidate["description"]
    assert record["status"] == "generating"
    assert record["model"] is None
    assert record["catalog_id"] is None
    assert record["config_digest"] is None


def test_model_snapshot_is_immutable_across_reopen_and_idempotent_create(store, ctx):
    from novelvideo.audio.voice_design_storage import (
        VoiceDesignStorage,
        CandidateStorageError,
    )

    model = {"catalog_id": "seed", "model": "seed-audio-1.0", "config_digest": "a" * 64}
    candidate_id = str(uuid4())
    args = dict(
        description="A low voice",
        preview_text="A calm voice speaks this preview.",
        language="zh",
        surface="supertale",
        catalog_id="seed",
        config_digest="a" * 64,
        model=model,
    )
    candidate, _ = store.reserve(candidate_id, **args)
    model["model"] = "changed-in-caller"
    reopened = VoiceDesignStorage(ctx, quota_path=store.quota_path)
    assert reopened.get(candidate_id)["model"]["model"] == "seed-audio-1.0"
    assert reopened.reserve(candidate_id, **{**args, "model": None}) == (
        candidate,
        False,
    )
    for changed in ({"catalog_id": "qwen"}, {"config_digest": "b" * 64}):
        with pytest.raises(CandidateStorageError, match="idempotency_conflict"):
            reopened.reserve(candidate_id, **{**args, **changed})


def test_recent_unsaved_ready_is_newest_first_and_survives_reopen(store, ctx):
    from novelvideo.audio.voice_design_storage import VoiceDesignStorage

    store.clock = lambda: 1000
    assert store.list_ready()[0] == []
    records = []
    for _ in range(6):
        record, _ = reserve(store)
        records.append(finish(store, record["candidate_id"]))
    expected = sorted((record["candidate_id"] for record in records), reverse=True)[:5]
    assert [r["candidate_id"] for r in store.list_ready()[0]] == expected
    reopened = VoiceDesignStorage(ctx, clock=lambda: 1000, quota_path=store.quota_path)
    assert [r["candidate_id"] for r in reopened.list_ready()[0]] == expected
    assert reopened.list_ready()[0][0]["description"] == records[-1]["description"]
    assert reopened.list_ready()[0][0]["model"] is None


def test_recent_unsaved_excludes_completed_saves_but_keeps_pending_save(store):
    records = []
    for _ in range(4):
        record, _ = reserve(store)
        records.append(finish(store, record["candidate_id"]))
    for record, kind, result in zip(
        records,
        ("character", "account", "character"),
        ({"path": "formal.mp3"}, {"voice_id": "saved"}, None),
    ):
        store.save_receipt(str(uuid4()), record["candidate_id"], kind, "target", result)
    assert {r["candidate_id"] for r in store.list_ready()[0]} == {
        record["candidate_id"] for record in records[2:]
    }


def test_recent_ready_excludes_other_states_and_preserves_model_snapshot(store):
    model = {"catalog_id": "seed", "model": "seed-audio-1.0"}
    ready, _ = store.reserve(
        str(uuid4()),
        description="A low voice",
        preview_text="A calm preview.",
        language="en",
        surface="canvas",
        model=model,
    )
    finish(store, ready["candidate_id"])
    for status in ("generating", "failed", "unknown"):
        record, _ = reserve(store)
        if status == "failed":
            store.fail(record["candidate_id"], "provider_bad_audio")
        elif status == "unknown":
            store.mark_unknown(record["candidate_id"])
    result = store.list_ready()[0]
    assert [record["candidate_id"] for record in result] == [ready["candidate_id"]]
    assert result[0]["model"] == model
    assert result[0]["preview_text"] == "A calm preview."


@pytest.mark.parametrize("scope", ["requester_user_id", "project_id"])
def test_recent_ready_never_lists_peer_scope(store, ctx, scope):
    from novelvideo.audio.voice_design_storage import VoiceDesignStorage

    record, _ = reserve(store)
    finish(store, record["candidate_id"])
    other = VoiceDesignStorage(
        replace(ctx, **{scope: "peer"}), quota_path=store.quota_path
    )
    assert other.list_ready()[0] == []
    assert len(store.list_ready()[0]) == 1


def test_listing_expires_temporary_media_without_deleting_formal_copy(store, ctx):
    store.clock = lambda: 1000
    store.ttl_seconds = 30
    record, _ = reserve(store)
    finish(store, record["candidate_id"])
    path = store.output_path(record["candidate_id"])
    formal = ctx.output_dir / "saved.mp3"
    formal.parent.mkdir(parents=True)
    formal.write_bytes(path.read_bytes())
    store.clock = lambda: 1029.9
    assert len(store.list_ready()[0]) == 1
    store.clock = lambda: 1030
    assert store.list_ready()[0] == []
    assert not path.exists()
    assert store.get(record["candidate_id"])["status"] == "expired"
    assert formal.read_bytes() == b"validated mp3 bytes"
