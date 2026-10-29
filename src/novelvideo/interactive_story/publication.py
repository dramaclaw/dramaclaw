"""Immutable, instance-local interactive story publications."""

from __future__ import annotations

import copy
import errno
import hashlib
import portalocker
import json
import logging
import os
import re
import secrets
import shutil
import time
from threading import local
from collections.abc import Callable
from datetime import datetime, timezone
from contextlib import ExitStack, contextmanager
from pathlib import Path
from urllib.parse import parse_qsl, unquote, urlsplit

from pydantic import ValidationError

from novelvideo import config
from novelvideo.freezone import canvas_store
from novelvideo.freezone.asset_copy import copy_project_file
from novelvideo.interactive_story.canvas_mapper import (
    CanvasStoryMappingError,
    story_from_canvas,
)
from novelvideo.interactive_story.service import issues_for_story
from novelvideo.interactive_story import preparation_lease

logger = logging.getLogger(__name__)
NODE_FIELDS = {
    "displayName",
    "narration",
    "videoUrl",
    "choiceLoopVideoUrl",
    "storyRole",
    "choiceTimeLimitSec",
    "endingLabel",
    "storyCta",
}
EDGE_FIELDS = {
    "choiceText",
    "transitionMode",
    "order",
    "condition",
    "effects",
    "feedbackText",
    "interaction",
    "isDefault",
    "needsReview",
}


def pick(value: dict, keys: set[str]) -> dict:
    return {k: copy.deepcopy(v) for k, v in value.items() if k in keys}


def edge_playback_data(value: dict) -> dict:
    result = pick(value, EDGE_FIELDS)
    condition = result.get("condition")
    if isinstance(condition, dict):
        leaves = {"var", "op", "value", "flag", "visitedNodeId"}
        result["condition"] = (
            {
                "join": condition.get("join"),
                "items": [pick(item, leaves) for item in condition.get("items", [])],
            }
            if "join" in condition
            else pick(condition, leaves)
        )
    if isinstance(result.get("effects"), list):
        result["effects"] = [
            pick(item, {"var", "delta", "flag", "value"}) for item in result["effects"]
        ]
    if isinstance(result.get("interaction"), dict):
        interaction = pick(
            result["interaction"],
            {
                "trigger",
                "holdMs",
                "presentation",
                "anchor",
                "uiStyle",
                "motion",
                "transition",
            },
        )
        if isinstance(interaction.get("anchor"), dict):
            interaction["anchor"] = pick(
                interaction["anchor"], {"x", "y", "width", "height"}
            )
        result["interaction"] = interaction
    return result


class PublicationError(ValueError):
    def __init__(self, code: str, status: int = 422):
        self.code, self.status = code, status
        super().__init__(code)


def local_media_path(url: str) -> str:
    parsed = urlsplit(url)
    if (
        parsed.scheme
        or parsed.netloc
        or parsed.fragment
        or any(
            key not in {"st_v", "v", "st_thumb"}
            for key, _ in parse_qsl(parsed.query, keep_blank_values=True)
        )
    ):
        raise PublicationError("media_requires_local_archive")
    return parsed.path


class PublicationStore:
    def __init__(
        self,
        root: Path | None = None,
        *,
        project_id: str | None = None,
        index_root: Path | None = None,
        output_dir: Path | None = None,
    ):
        self.root = root or Path(
            os.environ.get(
                "ST_PUBLICATION_DIR", str(Path(config.STATE_DIR) / "publications")
            )
        )
        try:
            self.retention_limit = int(os.environ.get("ST_PUBLICATION_RETENTION_LIMIT", "10"))
            if self.retention_limit < 1:
                raise ValueError
        except ValueError:
            logger.warning("Invalid ST_PUBLICATION_RETENTION_LIMIT; using 10")
            self.retention_limit = 10
        self.project_id = project_id
        self.index_root = index_root
        self.output_dir = Path(output_dir) if output_dir is not None else None
        self.check_project: Callable[[], None] | None = None
        self._lock_state = local()
        self.cleanup_requested = False
        # A path can be reused immediately after purge. Bind this store/worker
        # to the directories it opened, not just their names or registry IDs.
        directories = [self.root.parent] if index_root is not None else []
        if self.output_dir is not None and self.output_dir.is_dir():
            directories.append(self.output_dir)
        self._project_directories = {
            path: self._directory_identity(path) for path in directories
        }

    @staticmethod
    def _directory_identity(path: Path) -> tuple[int, int] | None:
        try:
            stat = path.stat()
        except FileNotFoundError:
            return None
        return stat.st_dev, stat.st_ino

    def _same_project(self) -> bool:
        return all(
            identity is not None and self._directory_identity(path) == identity
            for path, identity in self._project_directories.items()
        )

    def _check_directory_identity(self) -> None:
        if not self._same_project():
            raise PublicationError("unavailable", 410)
        # Metadata-only projects may not have output yet. Bind it on the first
        # locked operation after it appears, before any preparation can copy.
        if self.output_dir is not None and self.output_dir not in self._project_directories:
            identity = self._directory_identity(self.output_dir)
            if identity is not None:
                self._project_directories[self.output_dir] = identity

    @contextmanager
    def locked(self):
        # Version reads may reconcile abandoned jobs inside an existing mutation.
        # Reuse only this thread's lock; other threads must still acquire the file lock.
        if getattr(self._lock_state, "held", False):
            yield
            return
        with self._project_lock():
            self._lock_state.held = True
            try:
                yield
            finally:
                self._lock_state.held = False

    @contextmanager
    def _project_lock(self):
        if self.index_root is not None:
            # The lock survives project directory moves, and stale workers must
            # never recreate a purged project's state directory.
            key = hashlib.sha256(str(self.root.parent.resolve()).encode()).hexdigest()
            path = self.index_root / "locks" / key
            path.parent.mkdir(parents=True, exist_ok=True)
            with self.file_lock(path):
                self._check_directory_identity()
                if not self.root.parent.is_dir():
                    raise PublicationError("unavailable", 410)
                self.root.mkdir(exist_ok=True)
                if self.check_project is not None:
                    self.check_project()
                yield
        else:
            self._check_directory_identity()
            self.root.mkdir(parents=True, exist_ok=True)
            with self.file_lock(self.root / ".lock"):
                self._check_directory_identity()
                if self.check_project is not None:
                    self.check_project()
                yield

    @contextmanager
    def media_locked(self, *, timeout: float = 3):
        """Serialize copies and directory removal, without blocking metadata reads.

        Callers holding the metadata lock must never wait here: cleanup defers
        on contention. Lifecycle moves acquire this lock before locked().
        """
        if getattr(self._lock_state, "media_held", False):
            yield
            return
        self._check_directory_identity()
        if self.index_root is not None:
            key = hashlib.sha256(str(self.root.parent.resolve()).encode()).hexdigest()
            path = self.index_root / "locks" / (key + ".media")
            path.parent.mkdir(parents=True, exist_ok=True)
        else:
            self.root.mkdir(parents=True, exist_ok=True)
            path = self.root / ".media-lock"
        if getattr(self._lock_state, "held", False):
            timeout = 0
        with self.file_lock(path, timeout=timeout):
            self._check_directory_identity()
            self._lock_state.media_held = True
            try:
                yield
            finally:
                self._lock_state.media_held = False

    def index_work(self, work: dict):
        if self.index_root is not None:
            self.write(
                self.index_root / "index" / f"{work['public_id']}.json",
                {"project_id": self.project_id},
            )

    @contextmanager
    def file_lock(self, path: Path, *, timeout: float = 3):
        lock = portalocker.Lock(
            path, mode="a", timeout=timeout, flags=portalocker.LOCK_EX | portalocker.LOCK_NB
        )
        try:
            lock.acquire()
        except portalocker.exceptions.LockException as exc:
            raise PublicationError("publication_busy", 503) from exc
        try:
            yield
        finally:
            lock.release()

    def write(self, path: Path, value: dict):
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(path.name + "." + secrets.token_hex(8))
        try:
            tmp.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")
            os.replace(tmp, path)
        finally:
            tmp.unlink(missing_ok=True)

    def directory(self, public_id: str) -> Path:
        if not re.fullmatch(r"[a-f0-9]{32}", public_id):
            raise PublicationError("not_found", 404)
        return self.root / public_id

    def media_directory(self, public_id: str, version: str) -> Path:
        self.directory(public_id)  # Validate the work ID before constructing a path.
        if not re.fullmatch(r"[a-f0-9]{32}", version):
            raise PublicationError("not_found", 404)
        if self.output_dir is None:
            raise PublicationError("publication_storage_unavailable", 503)
        return self.output_dir / "publications" / public_id / version / "media"

    @staticmethod
    def _remove_tree(path: Path) -> None:
        try:
            shutil.rmtree(path)
        except FileNotFoundError:
            if path.exists():
                raise

    def _remove_job(self, directory: Path) -> None:
        try:
            (directory / "job.json").unlink(missing_ok=True)
        except OSError:
            logger.exception("Unable to remove completed publication job %s", directory)

    def _retry_media_cleanup(self, release: dict) -> None:
        try:
            with self.media_locked(timeout=0):
                self._cleanup_failed_media(release)
        except PublicationError as exc:
            if exc.code != "publication_busy":
                raise
            # Preserve the marker without waiting under the metadata lock.
            self.write(
                self.directory(release["public_id"]) / release["version"] / "version.json",
                release,
            )

    def _cleanup_failed_media(self, release: dict) -> None:
        """Keep the durable marker until deletion succeeds, including across restarts."""
        if not release.get("media_cleanup_pending"):
            return
        # Free partial copies before writing metadata: CE state and output may
        # share a full disk. Until this write commits, preparing + job.json still
        # lets recovery repeat cleanup safely after a crash.
        try:
            self._remove_tree(
                self.media_directory(release["public_id"], release["version"]).parent
            )
        except OSError:
            logger.exception(
                "Unable to remove failed publication media %s", release["version"]
            )
        else:
            release.pop("media_cleanup_pending", None)
        with self._preparation_lock():
            self.write(
                self.directory(release["public_id"]) / release["version"] / "version.json",
                release,
            )

    def read(self, public_id: str) -> dict:
        try:
            return json.loads((self.directory(public_id) / "work.json").read_text())
        except FileNotFoundError:
            raise PublicationError("not_found", 404)

    def work(self, owner: str, project_id: str | None = None) -> dict:
        with self.locked():
            for path in self.root.glob("*/work.json"):
                work = json.loads(path.read_text())
                if work["owner"] == owner:
                    if project_id and not work.get("project_id"):
                        work["project_id"] = project_id
                        self.write(path, work)
                    self.index_work(work)
                    return work
            work = {
                "owner": owner,
                "project_id": project_id,
                "public_id": secrets.token_hex(16),
                "active_version": None,
                "listed": False,
                "versions": [],
                "published_versions": [],
                "publication_details": {},
            }
            self.write(self.directory(work["public_id"]) / "work.json", work)
            self.index_work(work)
            return work

    def unlist_all(self):
        """Call while holding the project publication lock; return rollback data."""
        previous = {
            path: json.loads(path.read_text())
            for path in self.root.glob("*/work.json")
        }
        try:
            for path, work in previous.items():
                if work.get("listed"):
                    self.write(path, {**work, "listed": False})
        except BaseException:
            self.restore_listings(previous)
            raise
        return previous

    def restore_listings(self, previous):
        for path, work in previous.items():
            self.write(path, work)

    def owned(self, public_id: str, owner: str) -> dict:
        work = self.read(public_id)
        if work["owner"] != owner:
            raise PublicationError("not_found", 404)
        return work

    def version(self, public_id: str, version: str, *, defer_cleanup: bool = False) -> dict:
        if not re.fullmatch(r"[a-f0-9]{32}", version):
            raise PublicationError("not_found", 404)
        try:
            release = json.loads(
                (self.directory(public_id) / version / "version.json").read_text()
            )
            work = self.read(public_id)
            if version not in work["versions"]:
                raise PublicationError("not_found", 404)
            if release.get("status") == "preparing" and release.get("preparation_lease"):
                if not getattr(self._lock_state, "held", False):
                    with self.locked():
                        # Re-read membership and status after lifecycle operations
                        # ahead of us have completed. Never write from stale data.
                        return self.version(public_id, version, defer_cleanup=defer_cleanup)
                directory = self.directory(public_id) / version
                with preparation_lease.abandoned(directory) as abandoned:
                    if abandoned:
                        with self.file_lock(directory / ".job-lock"):
                            # Re-read after acquiring the locks: another reader may
                            # already have recorded the interruption.
                            release = json.loads((directory / "version.json").read_text())
                            if release["status"] == "preparing":
                                release["status"] = "failed"
                                release["error"] = "publication_interrupted"
                                # Retain the author's original cover selection for retry.
                                release["cover"] = release.get("request", {}).get("cover")
                                release["media_cleanup_pending"] = True
                                if not defer_cleanup:
                                    try:
                                        self.write(directory / "version.json", release)
                                    except OSError as exc:
                                        if exc.errno != errno.ENOSPC:
                                            raise
                                        # The existing preparing/job record is durable;
                                        # background cleanup frees space before retrying.
            if release.get("media_cleanup_pending"):
                self.cleanup_requested = True
            release["published"] = version in work["published_versions"]
            if not isinstance(work.get("publication_details"), dict):
                raise PublicationError("publication_data_invalid", 500)
            details = work["publication_details"].get(version)
            if details:
                # Preserve media references in versions edited before the
                # metadata editor was withdrawn; no new edits are accepted.
                assets = {**release.get("assets", {}), **details.get("assets", {})}
                release.update(details)
                release["assets"] = assets
            return release
        except FileNotFoundError:
            raise PublicationError("not_found", 404)

    def media_source(
        self, public_id: str, project: str, output: Path, url: str, video: bool
    ) -> Path:
        path = unquote(local_media_path(url))
        prefixes = (
            f"/api/v1/projects/{project}/media/",
            f"/static/projects/{project}/",
        )
        prefix = next((p for p in prefixes if path.startswith(p)), None)
        if not prefix:
            match = re.fullmatch(
                r"/api/v1/public-stories/([a-f0-9]{32})/versions/([a-f0-9]{32})/media/([a-f0-9]{32}\.[a-z0-9]+)",
                path,
            )
            if not match or match[1] != public_id:
                raise PublicationError("media_requires_local_archive")
            prior = self.version(match[1], match[2])
            if match[3] not in prior.get("assets", {}):
                raise PublicationError("media_not_available")
            source = self.media_directory(match[1], match[2]) / match[3]
            media_root = source.parent.resolve()
        else:
            source = (output / path[len(prefix) :]).resolve()
            media_root = output
        allowed = (
            {".mp4", ".webm", ".mov"} if video else {".png", ".jpg", ".jpeg", ".webp"}
        )
        if (
            not source.resolve().is_relative_to(media_root)
            or not source.is_file()
            or source.suffix.lower() not in allowed
        ):
            raise PublicationError("media_not_available")
        return source

    @staticmethod
    def media_fingerprint(source: Path) -> list:
        stat = source.stat()
        return [
            str(source.resolve()),
            stat.st_dev,
            stat.st_ino,
            stat.st_size,
            stat.st_mtime_ns,
            stat.st_ctime_ns,
        ]

    @staticmethod
    def request_digest(body: dict) -> str:
        return hashlib.sha256(
            json.dumps(body, sort_keys=True, ensure_ascii=False).encode()
        ).hexdigest()

    def prune_drafts(self, public_id: str, *, wait: bool = False):
        # Do not silently inherit a caller's metadata lock across slow removal.
        # Normal mutation callers invoke cleanup after their transaction ends.
        if getattr(self._lock_state, "held", False):
            return
        while True:
            try:
                self.prune_once(public_id)
                return
            except PublicationError as exc:
                if exc.code != "publication_busy":
                    raise
                if not wait:
                    return
                # Background cleanup retries without holding the metadata lock.
                # Revalidate project identity on every attempt.
                time.sleep(0.25)

    def prune_once(self, public_id: str):
        """One cleanup attempt; callers decide how to retry contention."""
        if getattr(self._lock_state, "held", False):
            raise PublicationError("publication_busy", 503)
        with self.media_locked(timeout=0):
            self._prune_drafts(public_id)

    def _prune_drafts(self, public_id: str):
        """Bound published history while keeping the active version and recent drafts.

        Pending jobs may reference an older draft's cover or video. Defer the
        whole work's cleanup until all jobs finish; prepare registers its source
        snapshot under this same lock so it cannot race with deletion.
        """
        with self.locked():
            work = self.read(public_id)
            directory = self.directory(public_id)
            versions = [self.version(public_id, vid, defer_cleanup=True) for vid in work["versions"]]
            preparing = {v["version"] for v in versions if v["status"] == "preparing"}
            pending = set(work.get("pending_cleanup", []))
            # A crash can leave a terminal job or a job not yet committed to work.json.
            # Only a live owner may block cleanup; a stale file alone must not do so.
            for job in directory.glob("*/job.json"):
                vid = job.parent.name
                if not re.fullmatch(r"[a-f0-9]{32}", vid):
                    continue
                with preparation_lease.abandoned(job.parent) as abandoned:
                    if not abandoned:
                        return
                    with self.file_lock(job.parent / ".job-lock"):
                        if vid not in work["versions"]:
                            pending.add(vid)
                        elif vid not in preparing:
                            # Interrupted versions are persisted after lock-free
                            # media cleanup; keep their job until then.
                            release = next((v for v in versions if v["version"] == vid), None)
                            if release is None or not release.get("media_cleanup_pending"):
                                self._remove_job(job.parent)
            if preparing:
                return
        # Preparation completion can retry an earlier failed removal here.
        # Keep media_locked(), but do not hold the metadata lock during deletion.
        for release in versions:
            if release["status"] == "failed":
                self._retry_media_cleanup(release)
                with self.locked():
                    self._remove_job(directory / release["version"])
        with self.locked():
            # Another request may have prepared or activated a version while
            # cleanup ran. Rebuild the retention decision from the latest state.
            work = self.read(public_id)
            versions = [self.version(public_id, vid, defer_cleanup=True) for vid in work["versions"]]
            if any(v["status"] == "preparing" for v in versions):
                return
            pending = set(work.get("pending_cleanup", [])) | pending
            # Append order records first publication; rollback does not reorder it.
            published = set(work["published_versions"])
            keep = set(work["published_versions"][-self.retention_limit:])
            if work.get("active_version"):
                keep.add(work["active_version"])
            drafts = [v for v in versions if v["version"] not in published]
            if drafts:
                keep.add(drafts[-1]["version"])
            latest_ready = next(
                (v for v in reversed(drafts) if v["status"] == "ready"), None
            )
            if latest_ready:
                keep.add(latest_ready["version"])
            retired = [v for v in versions if v["version"] not in keep]
            for version in retired:
                # Retain only a digest, so a late retry cannot recreate old media.
                work.setdefault("retired_requests", {})[version["request_id"]] = (
                    self.request_digest(version["request"])
                )
                pending.add(version["version"])
            pending.difference_update(keep)
            work["versions"] = [vid for vid in work["versions"] if vid in keep]
            work["published_versions"] = [
                vid for vid in work["published_versions"] if vid in keep
            ]
            work["publication_details"] = {
                vid: details for vid, details in work["publication_details"].items()
                if vid in keep
            }
            work["pending_cleanup"] = sorted(pending)
            # Commit the index first. A failed/interrupted removal is retried by
            # the next cleanup, without breaking publication management reads.
            self.write(directory / "work.json", work)
        completed = set()
        for vid in sorted(pending):
            if not re.fullmatch(r"[a-f0-9]{32}", vid):
                raise PublicationError("publication_data_invalid", 500)
            target = directory / vid
            try:
                self._remove_tree(self.media_directory(public_id, vid).parent)
                self._remove_tree(target)
            except OSError:
                logger.exception(
                    "Unable to remove obsolete publication draft %s", vid
                )
            else:
                completed.add(vid)
        with self.locked():
            # New prepares, activation and metadata edits may have committed
            # while deletion ran. Only acknowledge our completed cleanup IDs.
            work = self.read(public_id)
            work["pending_cleanup"] = [
                vid for vid in work.get("pending_cleanup", []) if vid not in completed
            ]
            self.write(directory / "work.json", work)

    def _prune_best_effort(self, public_id: str, *, wait: bool = False):
        try:
            self.prune_drafts(public_id, wait=wait)
        except Exception:
            logger.exception("Unable to clean obsolete story publication drafts")

    def existing_request(self, work: dict, body: dict) -> dict | None:
        digest = work.get("retired_requests", {}).get(body["request_id"])
        if digest is not None:
            if digest != self.request_digest(body):
                raise PublicationError("idempotency_conflict", 409)
            raise PublicationError("version_not_ready", 409)
        for vid in work["versions"]:
            old = self.version(work["public_id"], vid)
            if old["request_id"] == body["request_id"]:
                if old["request"] != body:
                    raise PublicationError("idempotency_conflict", 409)
                return old
        return None

    def prepare(
        self,
        owner: str,
        state_dir: Path,
        output_dir: Path,
        project: str,
        body: dict,
        project_id: str | None = None,
    ) -> dict:
        if body.get("cover"):
            body = {**body, "cover": local_media_path(body["cover"])}
        work = self.work(owner, project_id or project)
        with self.locked():
            return self._prepare_locked(
                owner, state_dir, output_dir, project, body, work
            )

    def _prepare_locked(self, owner, state_dir, output_dir, project, body, work):
        work = self.owned(work["public_id"], owner)
        existing = self.existing_request(work, body)
        if existing:
            return existing
        canvas = canvas_store.read_canvas(state_dir, body["canvas_id"])
        if not canvas:
            raise PublicationError("story_not_found", 404)
        if canvas.get("revision") != body["revision"]:
            raise PublicationError("revision_conflict", 409)
        group = next(
            (
                n
                for n in canvas["nodes"]
                if n["id"] == body["group_id"] and n.get("data", {}).get("storyGroup")
            ),
            None,
        )
        if not group:
            raise PublicationError("story_not_found", 404)
        # Persist only the selected story's playback inputs, never the whole editor canvas.
        members = [
            n
            for n in canvas["nodes"]
            if n.get("parentId") == body["group_id"] and n.get("type") == "videoNode"
        ]
        member_ids = {n["id"] for n in members}
        edges = [
            e
            for e in canvas["edges"]
            if e.get("type") == "storyChoiceEdge" and e.get("source") in member_ids
        ]
        selected = [
            {
                "id": group["id"],
                "type": "groupNode",
                "position": {"x": 0, "y": 0},
                "data": {
                    k: copy.deepcopy(v)
                    for k, v in group["data"].items()
                    if k
                    in {
                        "storyGroup",
                        "storyVariableDefinitions",
                        "storyFlags",
                        "displayName",
                        "label",
                    }
                },
            }
        ]
        for field, allowed in (
            (
                "storyVariableDefinitions",
                {"name", "label", "initial", "minimum", "maximum"},
            ),
            ("storyFlags", {"name", "label", "initial"}),
        ):
            if isinstance(selected[0]["data"].get(field), list):
                selected[0]["data"][field] = [
                    pick(item, allowed) for item in selected[0]["data"][field]
                ]
        for node in members:
            data = {
                k: copy.deepcopy(v) for k, v in node["data"].items() if k in NODE_FIELDS
            }
            if isinstance(data.get("storyCta"), dict):
                data["storyCta"] = pick(data["storyCta"], {"label", "url"})
                cta = urlsplit(str(data["storyCta"].get("url") or ""))
                if cta.username or cta.password:
                    raise PublicationError("invalid_story")
            for key in ("videoUrl", "choiceLoopVideoUrl"):
                if data.get(key):
                    data[key] = local_media_path(data[key])
            selected.append(
                {
                    "id": node["id"],
                    "type": "videoNode",
                    "parentId": body["group_id"],
                    "position": {"x": 0, "y": 0},
                    "data": data,
                }
            )
        canvas = {
            "nodes": selected,
            "edges": [
                {
                    "id": e["id"],
                    "type": "storyChoiceEdge",
                    "source": e["source"],
                    "target": e["target"],
                    "data": edge_playback_data(e.get("data", {})),
                }
                for e in edges
            ],
            "revision": canvas["revision"],
        }
        sources = {}
        urls = [
            (n["data"].get(key), True)
            for n in selected[1:]
            for key in ("videoUrl", "choiceLoopVideoUrl")
        ]
        urls.append((body.get("cover"), False))
        for url, video in urls:
            if not url or url in sources:
                continue
            try:
                sources[url] = self.media_fingerprint(
                    self.media_source(
                        work["public_id"], project, output_dir.resolve(), url, video
                    )
                )
            except (PublicationError, OSError) as exc:
                sources[url] = {
                    "error": exc.code
                    if isinstance(exc, PublicationError)
                    else "media_not_available"
                }
        version = {
            "version": secrets.token_hex(16),
            "created_at": datetime.now(timezone.utc).isoformat(),
            "public_id": work["public_id"],
            "status": "preparing",
            "preparation_lease": True,
            "issues": [],
            "request_id": body["request_id"],
            "request": body,
            "title": body["title"],
            "description": body.get("description", ""),
            "cover_mode": body.get("cover_mode", "landscape"),
            "cover_position_x": body.get("cover_position_x", 50),
            "cover_position_y": body.get("cover_position_y", 50),
            "revision": body["revision"],
        }
        directory = self.directory(work["public_id"]) / version["version"]
        preparation_lease.claim(directory)
        try:
            self.write(directory / "version.json", version)
            self.write(
                directory / "job.json",
                {
                    **version,
                    "_canvas": copy.deepcopy(canvas),
                    "_sources": sources,
                    "_output": str(output_dir),
                    "_project": project,
                },
            )
            work["versions"].append(version["version"])
            self.write(directory.parent / "work.json", work)
        except Exception:
            preparation_lease.release(directory)
            raise
        # Capture the source before returning; the background task never reads a newer canvas.
        return {
            **version,
            "_canvas": copy.deepcopy(canvas),
            "_sources": sources,
            "_output": str(output_dir),
            "_project": project,
        }

    def recover(self):
        if not self.root.exists():
            return
        for job in self.root.glob("*/*/job.json"):
            try:
                prepared = json.loads(job.read_text())
                if self.version(prepared["public_id"], prepared["version"])["status"] == "preparing":
                    self.finish(prepared)
            except Exception:
                logger.exception("Unable to recover story publication job")

        for path in self.root.glob("*/work.json"):
            self._prune_best_effort(path.parent.name)

    def finish(self, prepared: dict, *, cleanup: bool = True):
        directory = self.directory(prepared["public_id"]) / prepared["version"]
        try:
            self._finish_owned(prepared)
        finally:
            preparation_lease.release(directory)
        if cleanup and directory.exists():
            self._prune_best_effort(prepared["public_id"], wait=True)

    def _finish_owned(self, prepared: dict):
        directory = self.directory(prepared["public_id"]) / prepared["version"]
        while True:
            try:
                with self.media_locked():
                    self._finish_job(prepared)
            except PublicationError as exc:
                if exc.code == "publication_busy":
                    # HTTP operations fail fast, but this accepted background job
                    # must survive contention with another copy or lifecycle move.
                    # Reacquiring also rechecks whether the project was purged.
                    time.sleep(0.25)
                    continue
                if exc.code != "unavailable" or self._same_project():
                    raise
                return
            except FileNotFoundError:
                # A duplicate background/recovery invocation may arrive after this
                # completed draft has already been superseded and removed.
                if directory.exists():
                    raise
            break

    @contextmanager
    def _preparation_lock(self):
        # Accepted jobs wait for short metadata transactions instead of failing
        # on the HTTP lock timeout. Retry acquisition, never the media copy.
        with ExitStack() as stack:
            while True:
                try:
                    stack.enter_context(self.locked())
                except PublicationError as exc:
                    if exc.code != "publication_busy":
                        raise
                    time.sleep(0.25)
                else:
                    break
            yield

    def _finish_job(self, prepared: dict):
        directory = self.directory(prepared["public_id"]) / prepared["version"]
        with ExitStack() as job:
            # Opening a lock file is a write too. Validate before opening it.
            with self._preparation_lock():
                # Never wait for another worker while holding the project lock.
                job.enter_context(self.file_lock(directory / ".job-lock", timeout=0))
            try:
                with self._preparation_lock():
                    preparing = (
                        self.version(prepared["public_id"], prepared["version"])["status"]
                        == "preparing"
                    )
                if preparing:
                    self._finish(prepared)
            except Exception as exc:
                logger.exception("Story publication task failed before completion")
                with self._preparation_lock():
                    # Read directly: enriched version reads may be the failure.
                    release = json.loads((directory / "version.json").read_text())
                    if release["status"] == "preparing":
                        release["status"] = "failed"
                        release["error"] = (
                            exc.code
                            if isinstance(exc, PublicationError)
                            else "publication_check_failed"
                        )
                        release["media_cleanup_pending"] = True
                # Keep the media lock, but release the metadata lock before I/O.
                self._retry_media_cleanup(release)
            with self._preparation_lock():
                self._remove_job(directory)

    def _finish(self, prepared: dict):
        version = {k: v for k, v in prepared.items() if not k.startswith("_")}
        directory = self.directory(version["public_id"]) / version["version"]
        body = version["request"]
        try:
            canvas = prepared["_canvas"]
            gid = body["group_id"]
            members = [
                n
                for n in canvas["nodes"]
                if n.get("parentId") == gid and n.get("type") == "videoNode"
            ]
            ids = {n["id"] for n in members}
            edges = [
                e
                for e in canvas["edges"]
                if e.get("type") == "storyChoiceEdge" and e["source"] in ids
            ]
            preliminary = []
            if not members:
                preliminary.append({"severity": "error", "code": "empty_story"})
            starts = [
                n for n in members if n.get("data", {}).get("storyRole") == "start"
            ]
            if len(starts) > 1:
                preliminary.append({"severity": "error", "code": "multiple_start"})
            for node in members:
                if not node.get("data", {}).get("videoUrl"):
                    preliminary.append(
                        {
                            "severity": "error",
                            "code": "missing_video",
                            "entity_id": node["id"],
                        }
                    )
            for edge in edges:
                if edge["target"] not in ids:
                    preliminary.append(
                        {
                            "severity": "error",
                            "code": "dangling_edge",
                            "entity_id": edge["source"],
                        }
                    )
            labels = {
                n["id"]: n.get("data", {}).get("displayName") or n["id"]
                for n in members
            }
            for edge in edges:
                data = edge.get("data", {})
                anchor = (data.get("interaction") or {}).get("anchor") or {}
                x, y, width, height = (
                    anchor.get(k) for k in ("x", "y", "width", "height")
                )
                if all(isinstance(v, (int, float)) for v in (x, y, width, height)):
                    sides = {
                        "left": x - width / 2 < 0,
                        "right": x + width / 2 > 1,
                        "top": y - height / 2 < 0,
                        "bottom": y + height / 2 > 1,
                    }
                    for side, outside in sides.items():
                        if outside:
                            preliminary.append(
                                {
                                    "severity": "error",
                                    "code": f"choice_area_outside_{side}",
                                    "entity_id": edge["id"],
                                    "node_id": edge["source"],
                                    "entity_label": f"{labels[edge['source']]} → {data.get('choiceText') or edge['id']}",
                                }
                            )
            for issue in preliminary:
                if issue.get("entity_id") in labels:
                    issue["entity_label"] = labels[issue["entity_id"]]
            if preliminary:
                version["issues"] = preliminary
                raise PublicationError("invalid_story")
            # Normalize manual canvas stories to the existing server-side domain validator.
            validation = copy.deepcopy(canvas)
            vg = next(n for n in validation["nodes"] if n["id"] == gid)
            vg["data"]["interactiveStoryId"] = "publication"
            if not any(n.get("data", {}).get("storyRole") == "start" for n in members):
                targets = {e["target"] for e in edges}
                roots = [n["id"] for n in members if n["id"] not in targets]
                if len(roots) == 1:
                    next(n for n in validation["nodes"] if n["id"] == roots[0])["data"][
                        "storyRole"
                    ] = "start"
            for n in validation["nodes"]:
                if n["id"] in ids:
                    n["data"]["storySegmentId"] = n["id"]
            try:
                story = story_from_canvas(validation, "publication")
            except (CanvasStoryMappingError, ValidationError) as exc:
                # Invalid authored data needs canvas corrections, not a system
                # retry. Keep raw validation inputs out of the public response.
                raise PublicationError("invalid_story") from exc
            issues = [i.model_dump() for i in issues_for_story(story)]
            if any(e.get("data", {}).get("needsReview") for e in edges):
                issues.append({"severity": "error", "code": "needs_review"})
            for issue in issues:
                if issue["code"] in {
                    "media_url_unresolved",
                    "automatic_no_fallback",
                    "leaf_no_ending",
                }:
                    issue["severity"] = "error"
            for issue in issues:
                entity = issue.get("entity_id")
                if entity in labels:
                    issue["entity_label"] = labels[entity]
                else:
                    edge = next((e for e in edges if e["id"] == entity), None)
                    if edge:
                        issue["node_id"] = edge["source"]
                        issue["entity_label"] = (
                            f"{labels[edge['source']]} → {edge.get('data', {}).get('choiceText') or entity}"
                        )
            version["issues"] = issues
            if any(i["severity"] == "error" for i in issues):
                raise PublicationError("invalid_story")
            assets = {}
            archived_sources = {}
            version["progress"] = {
                "completed": 0,
                "total": len(members)
                + sum(
                    bool(n.get("data", {}).get("choiceLoopVideoUrl")) for n in members
                )
                + int(bool(body.get("cover"))),
            }
            output = Path(prepared["_output"]).resolve()

            def archive(url: str, video: bool = False) -> str:
                source = self.media_source(
                    version["public_id"], prepared["_project"], output, url, video
                )
                expected = prepared.get("_sources", {}).get(url)
                if isinstance(expected, dict):
                    raise PublicationError(expected["error"])
                if expected != self.media_fingerprint(source):
                    raise PublicationError("media_changed_retry")
                source_key = str(source.resolve())
                if source_key in archived_sources:
                    version["progress"]["completed"] += 1
                    return archived_sources[source_key]
                asset = secrets.token_hex(16) + source.suffix.lower()
                media_dir = self.media_directory(version["public_id"], version["version"])
                # The worker holds media_locked(): mkdir on an OSS mount can
                # block too, so it must not acquire the metadata lock.
                media_dir.mkdir(parents=True, exist_ok=True)
                # media_locked() prevents lifecycle moves throughout the copy.
                # Keep the shared helper's OSS CopyObject path and local fallback.
                copy_project_file(source, media_dir / asset, create_parent=False)
                if expected != self.media_fingerprint(source):
                    raise PublicationError("media_changed_retry")
                version["progress"]["completed"] += 1
                with self._preparation_lock():
                    self.write(directory / "version.json", version)
                assets[asset] = asset
                archived_url = f"/api/v1/public-stories/{version['public_id']}/versions/{version['version']}/media/{asset}"
                archived_sources[source_key] = archived_url
                return archived_url

            nodes = [
                {
                    "id": gid,
                    "type": "groupNode",
                    "position": {"x": 0, "y": 0},
                    "data": {
                        "storyVariableDefinitions": [
                            v.model_dump(exclude_none=True) for v in story.variables
                        ],
                        "storyFlags": [v.model_dump() for v in story.flags],
                    },
                }
            ]
            for n in members:
                data = {
                    k: copy.deepcopy(v)
                    for k, v in n["data"].items()
                    if k in NODE_FIELDS
                }
                data["videoUrl"] = archive(data["videoUrl"], True)
                if (
                    not any(
                        m.get("data", {}).get("storyRole") == "start" for m in members
                    )
                    and n["id"] == roots[0]
                ):
                    data["storyRole"] = "start"
                if data.get("choiceLoopVideoUrl"):
                    data["choiceLoopVideoUrl"] = archive(
                        data["choiceLoopVideoUrl"], True
                    )
                nodes.append(
                    {
                        "id": n["id"],
                        "type": "videoNode",
                        "parentId": gid,
                        "position": {"x": 0, "y": 0},
                        "data": data,
                    }
                )
            for edge in edges:
                interaction = edge.get("data", {}).get("interaction")
                if isinstance(interaction, dict) and isinstance(
                    interaction.get("anchor"), dict
                ):
                    interaction["anchor"].pop("objectLabel", None)
            version["snapshot"] = {
                "groupId": gid,
                "nodes": nodes,
                "edges": [
                    {
                        "id": e["id"],
                        "type": "storyChoiceEdge",
                        "source": e["source"],
                        "target": e["target"],
                        "data": {
                            k: copy.deepcopy(v)
                            for k, v in e.get("data", {}).items()
                            if k in EDGE_FIELDS
                        },
                    }
                    for e in edges
                ],
            }
            version["cover"] = archive(body["cover"]) if body.get("cover") else None
            version["assets"] = assets
            version["status"] = "ready"
        except Exception as exc:
            logger.exception("Story publication preparation failed")
            version["status"] = "failed"
            version["error"] = (
                exc.code
                if isinstance(exc, PublicationError)
                else "publication_check_failed"
            )
            version["media_cleanup_pending"] = True
        if version.get("media_cleanup_pending"):
            self._retry_media_cleanup(version)
        else:
            with self._preparation_lock():
                self.write(directory / "version.json", version)

    def activate(
        self, public_id: str, owner: str, version: str | None, listed: bool,
        *, cleanup: bool = True,
    ) -> dict:
        with self.locked():
            work = self.owned(public_id, owner)
            if version:
                release = self.version(public_id, version)
                if release["status"] != "ready":
                    raise PublicationError("version_not_ready", 409)
                if version not in work["published_versions"]:
                    details = work["publication_details"]
                    details[version] = {
                        "number": max((d["number"] for d in details.values()), default=0) + 1,
                        "published_at": datetime.now(timezone.utc).isoformat(),
                    }
                    work["published_versions"].append(version)
                work["active_version"] = version
            if listed and not work["active_version"]:
                raise PublicationError("version_not_ready", 409)
            work["listed"] = listed
            self.write(self.directory(public_id) / "work.json", work)
        if cleanup:
            self._prune_best_effort(public_id)
        with self.locked():
            return self.read(public_id)

    def public(self, public_id: str, version: str | None = None) -> dict:
        work = self.read(public_id)
        if not work["listed"]:
            raise PublicationError("unavailable", 410)
        selected = version or work["active_version"]
        if selected not in work["published_versions"]:
            raise PublicationError("not_found", 404)
        return {**self.version(public_id, selected), "published": True}


def public_version(version: dict) -> dict:
    return {
        k: version[k]
        for k in (
            "public_id",
            "version",
            "status",
            "title",
            "description",
            "revision",
            "issues",
            "error",
            "snapshot",
            "cover",
            "cover_mode",
            "cover_position_x",
            "cover_position_y",
            "published_at",
            "progress",
            "number",
            "created_at",
            "published",
        )
        if k in version
    }


def player_version(version: dict) -> dict:
    """Only fields consumed by anonymous playback; author diagnostics stay private."""
    fields = (
        "public_id",
        "version",
        "title",
        "description",
        "snapshot",
        "cover",
        "cover_mode",
        "cover_position_x",
        "cover_position_y",
        "number",
        "published_at",
    )
    return {key: version[key] for key in fields if key in version}
