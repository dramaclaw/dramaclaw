from dataclasses import replace
from hashlib import sha256
from uuid import uuid4

import pytest

from novelvideo.audio.voice_design_storage import (
    CandidateStorageError,
    VoiceDesignStorage,
)
from novelvideo.project_context import ProjectContext


@pytest.fixture
def env(tmp_path):
    ctx = ProjectContext(
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
    now = [1000.0]
    storage = VoiceDesignStorage(
        ctx, quota_path=tmp_path / "quota.db", clock=lambda: now[0]
    )
    cid = str(uuid4())
    storage.reserve(
        cid,
        description="voice",
        preview_text="A calm test preview.",
        language="en",
        surface="supertale",
    )
    storage.claim(cid)
    content = b"already validated candidate media"
    path = storage.output_path(cid)
    path.parent.mkdir(parents=True)
    path.write_bytes(content)
    storage.complete(cid, duration_seconds=4.5, sha256=sha256(content).hexdigest())
    return ctx, storage, cid, now, content


def test_library_save_survives_expiry_and_does_not_modify_character(env):
    from novelvideo.audio.voice_design_assets import (
        save_candidate_asset,
        load_library_voice_asset,
    )
    from novelvideo.freezone.video_node import load_video_character_library

    ctx, storage, cid, now, content = env
    formal = ctx.output_dir / "assets/characters/hero/voices/voice_default.mp3"
    formal.parent.mkdir(parents=True)
    formal.write_bytes(b"existing role")
    asset = save_candidate_asset(
        ctx=ctx,
        storage=storage,
        candidate_id=cid,
        request_id=str(uuid4()),
        name="Saved voice",
    )
    assert formal.read_bytes() == b"existing role"
    item = load_video_character_library(ctx.output_dir)[0]
    assert item["category"] == "character"
    assert item["media"] == "audio"
    assert item["voice_design"]["sha256"] == sha256(content).hexdigest()
    assert item["audio_url"] == asset["url"]
    assert "voice-design/candidates" not in item["audio_url"]
    assert "user_id" not in item["voice_design"]
    now[0] += 604800
    storage.cleanup()
    assert not storage.output_path(cid).exists()
    formal.write_bytes(b"replacement role")
    metadata, saved = load_library_voice_asset(ctx.output_dir, asset["asset_id"])
    assert saved == content
    assert metadata["sha256"] == sha256(content).hexdigest()


def test_library_save_is_idempotent_and_request_id_cannot_change_intent(env):
    from novelvideo.audio.voice_design_assets import save_candidate_asset
    from novelvideo.freezone.video_node import load_video_character_library

    ctx, storage, cid, _, _ = env
    rid = str(uuid4())

    def save(name="Saved voice", request_id=rid):
        return save_candidate_asset(
            ctx=ctx, storage=storage, candidate_id=cid, request_id=request_id, name=name
        )

    first = save()
    assert save() == first
    assert save(request_id=str(uuid4())) == first
    assert len(load_video_character_library(ctx.output_dir)) == 1
    assert storage.list_ready()[0] == []
    with pytest.raises(CandidateStorageError, match="idempotency_conflict"):
        save(name="Different voice")


def test_library_registration_failure_can_recover_without_duplicate(env, monkeypatch):
    from novelvideo.audio import voice_design_assets as assets
    from novelvideo.freezone.video_node import load_video_character_library

    ctx, storage, cid, _, _ = env
    original = assets.add_video_character_library_item
    rid = str(uuid4())

    def interrupted(*args, **kwargs):
        raise OSError("interrupted")

    monkeypatch.setattr(assets, "add_video_character_library_item", interrupted)
    with pytest.raises(OSError):
        assets.save_candidate_asset(
            ctx=ctx,
            storage=storage,
            candidate_id=cid,
            request_id=rid,
            name="Saved voice",
        )
    assert load_video_character_library(ctx.output_dir) == []
    assert len(storage.list_ready()[0]) == 1
    monkeypatch.setattr(assets, "add_video_character_library_item", original)
    assets.save_candidate_asset(
        ctx=ctx, storage=storage, candidate_id=cid, request_id=rid, name="Saved voice"
    )
    assert len(load_video_character_library(ctx.output_dir)) == 1


def test_temporary_candidate_cannot_be_published_by_other_user(env):
    from novelvideo.audio.voice_design_assets import save_candidate_asset

    ctx, storage, cid, _, _ = env
    other_ctx = replace(ctx, requester_user_id="other")
    other = VoiceDesignStorage(other_ctx, quota_path=storage.quota_path)
    with pytest.raises(CandidateStorageError, match="candidate_not_found"):
        save_candidate_asset(
            ctx=other_ctx,
            storage=other,
            candidate_id=cid,
            request_id=str(uuid4()),
            name="Saved voice",
        )


def test_library_receipt_interruption_recovers_after_candidate_expires(
    env, monkeypatch
):
    from novelvideo.audio.voice_design_assets import (
        save_candidate_asset,
        load_library_voice_asset,
    )
    from novelvideo.freezone.video_node import load_video_character_library

    ctx, storage, cid, now, content = env
    original = storage.save_receipt
    rid = str(uuid4())

    def interrupted(request_id, candidate_id, kind, target, result):
        if result is not None:
            raise OSError("receipt interrupted")
        return original(request_id, candidate_id, kind, target, result)

    monkeypatch.setattr(storage, "save_receipt", interrupted)
    with pytest.raises(OSError):
        save_candidate_asset(
            ctx=ctx,
            storage=storage,
            candidate_id=cid,
            request_id=rid,
            name="Saved voice",
        )
    assert len(load_video_character_library(ctx.output_dir)) == 1
    now[0] += 604800
    storage.cleanup()
    assert not storage.output_path(cid).exists()
    monkeypatch.setattr(storage, "save_receipt", original)
    asset = save_candidate_asset(
        ctx=ctx, storage=storage, candidate_id=cid, request_id=rid, name="Saved voice"
    )
    assert load_library_voice_asset(ctx.output_dir, asset["asset_id"])[1] == content
    assert len(load_video_character_library(ctx.output_dir)) == 1


@pytest.mark.parametrize("location", ["assets", "audio", "voice-design"])
def test_library_publish_rejects_symlink_parent(env, tmp_path, location):
    from novelvideo.audio.voice_design_assets import save_candidate_asset

    ctx, storage, cid, _, _ = env
    parts = ["assets", "audio", "voice-design"]
    parent = ctx.output_dir.joinpath(*parts[: parts.index(location)])
    parent.mkdir(parents=True)
    outside = tmp_path / "outside"
    outside.mkdir()
    (parent / location).symlink_to(outside, target_is_directory=True)
    with pytest.raises(CandidateStorageError, match="candidate_persist_failed"):
        save_candidate_asset(
            ctx=ctx,
            storage=storage,
            candidate_id=cid,
            request_id=str(uuid4()),
            name="Saved voice",
        )
    assert list(outside.iterdir()) == []


def test_library_asset_rejects_tampering_and_cross_project_lookup(env, tmp_path):
    from novelvideo.audio.voice_design_assets import (
        save_candidate_asset,
        load_library_voice_asset,
    )

    ctx, storage, cid, _, _ = env
    asset = save_candidate_asset(
        ctx=ctx,
        storage=storage,
        candidate_id=cid,
        request_id=str(uuid4()),
        name="Saved voice",
    )
    with pytest.raises(CandidateStorageError, match="invalid_input"):
        load_library_voice_asset(tmp_path / "other-project", asset["asset_id"])
    path = ctx.output_dir / "assets/audio/voice-design" / (asset["asset_id"] + ".mp3")
    path.write_bytes(b"tampered")
    with pytest.raises(CandidateStorageError, match="candidate_persist_failed"):
        load_library_voice_asset(ctx.output_dir, asset["asset_id"])
