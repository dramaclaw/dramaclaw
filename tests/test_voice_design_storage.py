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
    now[0] += 121
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


def test_ttl_and_eviction_keep_formal_files(store, ctx):
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
    assert store.get(records[0]["candidate_id"])["status"] == "expired"
    assert not store.output_path(records[0]["candidate_id"]).exists()
    assert records[-1]["expires_at"] == records[-1]["created_at"] + 3600
    now[0] += 3600
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
    assert completed["expires_at"] == 4660
    second, _ = reserve(store)
    store.claim(second["candidate_id"])
    path = store.output_path(second["candidate_id"])
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"audio")
    now[0] += 121
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
