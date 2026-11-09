"""Publish validated private previews as independent project audio assets."""

from hashlib import sha256
import math
import os
from pathlib import Path
import re
import tempfile
from uuid import NAMESPACE_URL, UUID, uuid5

from novelvideo.audio.voice_design_storage import (
    CandidateStorageError,
    VoiceDesignStorage,
)
from novelvideo.freezone.video_node import (
    add_video_character_library_item,
    load_video_character_library,
)
from novelvideo.project_context import ProjectContext
from novelvideo.utils.static_urls import project_static_url


def _asset_path(project_dir: Path, asset_id: str) -> Path:
    project_dir = Path(project_dir)
    path = project_dir / "assets" / "audio" / "voice-design" / f"{UUID(asset_id)}.mp3"
    for component in (project_dir, *path.relative_to(project_dir).parents):
        candidate = component if component == project_dir else project_dir / component
        if candidate.is_symlink():
            raise CandidateStorageError("candidate_persist_failed")
    if path.is_symlink() or not path.resolve().is_relative_to(project_dir.resolve()):
        raise CandidateStorageError("candidate_persist_failed")
    return path


def _verified_bytes(path: Path, expected_sha: str) -> bytes:
    try:
        if path.is_symlink():
            raise CandidateStorageError("candidate_persist_failed")
        descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        with os.fdopen(descriptor, "rb") as stream:
            if not 0 < os.fstat(stream.fileno()).st_size <= 10 * 1024 * 1024:
                raise CandidateStorageError("candidate_persist_failed")
            content = stream.read(10 * 1024 * 1024 + 1)
    except OSError:
        raise CandidateStorageError("candidate_audio_missing") from None
    if len(content) > 10 * 1024 * 1024 or sha256(content).hexdigest() != expected_sha:
        raise CandidateStorageError("candidate_persist_failed")
    return content


def _library_item(project_dir: Path, asset_id: str) -> dict | None:
    item_id = f"voice-design:{UUID(asset_id)}"
    return next(
        (
            item
            for item in load_video_character_library(project_dir)
            if item.get("id") == item_id
        ),
        None,
    )


def load_library_voice_asset(project_dir: Path, asset_id: str) -> tuple[dict, bytes]:
    """Read only a registered, immutable voice asset in this project."""
    item = _library_item(project_dir, asset_id)
    metadata = item.get("voice_design") if item else None
    if not isinstance(metadata, dict) or item.get("media") != "audio":
        raise CandidateStorageError("invalid_input")
    try:
        duration = metadata["duration_seconds"]
        if (
            str(UUID(metadata["asset_id"])) != str(UUID(asset_id))
            or not isinstance(metadata["sha256"], str)
            or not re.fullmatch(r"[0-9a-f]{64}", metadata["sha256"])
            or type(duration) not in (int, float)
            or not math.isfinite(duration)
            or not 0 < duration <= 15
        ):
            raise ValueError
    except (KeyError, TypeError, ValueError):
        raise CandidateStorageError("candidate_persist_failed") from None
    return metadata, _verified_bytes(
        _asset_path(project_dir, asset_id), metadata["sha256"]
    )


def save_candidate_asset(
    *,
    ctx: ProjectContext,
    storage: VoiceDesignStorage,
    candidate_id: str,
    request_id: str,
    name: str,
) -> dict:
    """Converge publication after interruption. Caller holds the project lock."""
    candidate_id, request_id = str(UUID(candidate_id)), str(UUID(request_id))
    asset_id = str(
        uuid5(
            NAMESPACE_URL,
            f"voice-design:{ctx.project_id}:{ctx.requester_user_id}:{candidate_id}",
        )
    )
    receipt = storage.receipt(request_id, "library")
    if receipt and (receipt["candidate_id"], receipt["target"]) != (candidate_id, name):
        raise CandidateStorageError("idempotency_conflict")
    existing = _library_item(ctx.output_dir, asset_id)
    if existing:
        metadata, _ = load_library_voice_asset(ctx.output_dir, asset_id)
        if metadata["name"] != name:
            raise CandidateStorageError("idempotency_conflict")
        result = {
            key: metadata[key]
            for key in ("asset_id", "name", "url", "sha256", "duration_seconds")
        }
        storage.save_receipt(request_id, candidate_id, "library", name, result)
        return result
    if receipt and receipt["result"] is not None:
        # A deliberately removed library entry is not recreated by an old retry.
        raise CandidateStorageError("save_failed")
    record = storage.get(candidate_id)
    if record is None:
        raise CandidateStorageError("candidate_not_found")
    if record["status"] == "expired":
        raise CandidateStorageError("candidate_expired")
    if record["status"] != "ready":
        raise CandidateStorageError("candidate_not_ready")
    content = _verified_bytes(storage.output_path(candidate_id), record["sha256"])
    storage.save_receipt(request_id, candidate_id, "library", name, None)
    path = _asset_path(ctx.output_dir, asset_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        _verified_bytes(path, record["sha256"])
    else:
        fd, staged = tempfile.mkstemp(prefix=".voice-", suffix=".mp3", dir=path.parent)
        try:
            with os.fdopen(fd, "wb") as stream:
                stream.write(content)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(staged, path)
        finally:
            Path(staged).unlink(missing_ok=True)
    result = {
        "asset_id": asset_id,
        "name": name,
        "url": project_static_url(
            ctx.project_id, path.relative_to(ctx.output_dir).as_posix(), local_path=path
        ),
        "sha256": record["sha256"],
        "duration_seconds": record["duration_seconds"],
    }
    add_video_character_library_item(
        ctx.output_dir,
        name=name,
        media="audio",
        source="upload",
        category="character",
        item_id=f"voice-design:{asset_id}",
        audio_url=result["url"],
        voice_design={**result, "model": record["model"]},
    )
    storage.save_receipt(request_id, candidate_id, "library", name, result)
    return result
