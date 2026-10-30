"""Private candidate files and durable, scoped generation claims."""

from contextlib import contextmanager
from dataclasses import dataclass
import logging
from hashlib import sha256 as file_sha256
from pathlib import Path
import math
import os
import sqlite3
import time
from uuid import UUID
from typing import Any, Callable, Iterator

from novelvideo.config import STATE_DIR
from novelvideo.project_context import ProjectContext


class CandidateStorageError(Exception):
    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


@dataclass(frozen=True)
class CandidateScope:
    project_id: str
    requester_user_id: str
    state_dir: Path
    runtime_dir: Path


class VoiceDesignStorage:
    def __init__(
        self,
        ctx: ProjectContext | CandidateScope,
        *,
        clock: Callable[[], float] = time.time,
        ttl_seconds: float | None = None,
        lease_seconds: float = 120,
        quota_path: Path | None = None,
        enqueue_timeout_seconds: float = 600,
    ) -> None:
        self.ctx = ctx
        self.clock = clock
        try:
            self.ttl_seconds = (
                float(os.environ.get("VOICE_DESIGN_CANDIDATE_TTL_SECONDS", "3600"))
                if ttl_seconds is None
                else ttl_seconds
            )
            if not math.isfinite(self.ttl_seconds) or self.ttl_seconds <= 0:
                raise ValueError
        except ValueError:
            raise CandidateStorageError("voice_design_unavailable") from None
        self.lease_seconds = lease_seconds
        self.enqueue_timeout_seconds = enqueue_timeout_seconds
        self.db_path = ctx.state_dir / "voice-design" / "candidates.sqlite3"
        self.quota_path = Path(
            quota_path or Path(STATE_DIR) / "voice-design" / "quota.sqlite3"
        )
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self.quota_path.parent.mkdir(parents=True, exist_ok=True)
        with self._transaction() as db:
            db.execute("""CREATE TABLE IF NOT EXISTS candidates (
                project_id TEXT NOT NULL, user_id TEXT NOT NULL, candidate_id TEXT NOT NULL,
                description TEXT NOT NULL, preview_text TEXT NOT NULL, language TEXT NOT NULL, surface TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'generating', queued INTEGER NOT NULL DEFAULT 0,
                claimed INTEGER NOT NULL DEFAULT 0, lease_until REAL, error_code TEXT,
                created_at REAL NOT NULL, expires_at REAL, duration_seconds REAL, sha256 TEXT,
                PRIMARY KEY(project_id,user_id,candidate_id))""")
            db.execute("""CREATE TABLE IF NOT EXISTS quota.usage (
                user_id TEXT NOT NULL, project_id TEXT NOT NULL, candidate_id TEXT NOT NULL,
                day INTEGER NOT NULL, lease_until REAL NOT NULL, channel_key TEXT NOT NULL,
                PRIMARY KEY(user_id,project_id,candidate_id))""")

            db.execute("""CREATE TABLE IF NOT EXISTS quota.candidate_stores (
                project_id TEXT NOT NULL, user_id TEXT NOT NULL, state_dir TEXT NOT NULL,
                runtime_dir TEXT NOT NULL, PRIMARY KEY(project_id,user_id))""")
            db.execute(
                "INSERT OR REPLACE INTO quota.candidate_stores VALUES (?,?,?,?)",
                (
                    ctx.project_id,
                    ctx.requester_user_id,
                    str(ctx.state_dir),
                    str(ctx.runtime_dir),
                ),
            )

    @contextmanager
    def _transaction(self) -> Iterator[sqlite3.Connection]:
        db = sqlite3.connect(self.db_path, timeout=30)
        db.row_factory = sqlite3.Row
        try:
            db.execute("ATTACH DATABASE ? AS quota", (str(self.quota_path),))
            db.execute("BEGIN IMMEDIATE")
            yield db
            db.commit()
        except BaseException:
            db.rollback()
            raise
        finally:
            db.close()

    def _key(self, candidate_id):
        return (
            self.ctx.project_id,
            self.ctx.requester_user_id,
            str(UUID(str(candidate_id))),
        )

    def _read(self, db, candidate_id):
        row = db.execute(
            "SELECT * FROM candidates WHERE project_id=? AND user_id=? AND candidate_id=?",
            self._key(candidate_id),
        ).fetchone()
        return dict(row) if row else None

    def output_path(self, candidate_id: str) -> Path:
        user = self.ctx.requester_user_id
        if not user or user in {".", ".."} or "/" in user or "\\" in user:
            raise CandidateStorageError("candidate_persist_failed")
        root = self.ctx.runtime_dir
        directory = root / "voice-design" / user
        path = directory / f"{UUID(str(candidate_id))}.mp3"
        for component in (root, root / "voice-design", directory, path):
            if component.is_symlink():
                raise CandidateStorageError("candidate_persist_failed")
        if not path.resolve().is_relative_to(root.resolve()):
            raise CandidateStorageError("candidate_persist_failed")
        return path

    def task_scope(self, candidate_id: str) -> str:
        requester = file_sha256(self.ctx.requester_user_id.encode()).hexdigest()
        return f"{requester}:{UUID(str(candidate_id))}"

    def reserve(
        self,
        candidate_id: str,
        *,
        description: str,
        preview_text: str,
        language: str,
        surface: str,
    ) -> tuple[dict[str, Any], bool]:
        self.cleanup()
        with self._transaction() as db:
            previous = self._read(db, candidate_id)
            values = (description.strip(), preview_text.strip(), language, surface)
            if previous:
                if (
                    tuple(
                        previous[k]
                        for k in ("description", "preview_text", "language", "surface")
                    )
                    != values
                ):
                    raise CandidateStorageError("idempotency_conflict")
                return previous, False
            db.execute(
                "INSERT INTO candidates(project_id,user_id,candidate_id,description,preview_text,language,surface,created_at,lease_until) VALUES (?,?,?,?,?,?,?,?,?)",
                (
                    *self._key(candidate_id),
                    *values,
                    self.clock(),
                    self.clock() + self.enqueue_timeout_seconds,
                ),
            )
            rows = db.execute(
                "SELECT candidate_id FROM candidates WHERE project_id=? AND user_id=? AND status IN ('ready','generating') ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET 5",
                self._key(candidate_id)[:2],
            ).fetchall()
            for row in rows:
                db.execute(
                    "UPDATE candidates SET status='expired' WHERE project_id=? AND user_id=? AND candidate_id=?",
                    self._key(row["candidate_id"]),
                )
            record = self._read(db, candidate_id)
        self.cleanup()
        return record, True

    def mark_queued(self, candidate_id: str) -> None:
        with self._transaction() as db:
            db.execute(
                "UPDATE candidates SET queued=1 WHERE project_id=? AND user_id=? AND candidate_id=?",
                self._key(candidate_id),
            )

    def get(self, candidate_id: str) -> dict[str, Any] | None:
        self.cleanup()
        with self._transaction() as db:
            return self._read(db, candidate_id)

    def claim(
        self,
        candidate_id: str,
        *,
        daily_limit: int = 20,
        channel_key: str = "",
        channel_daily_limit: int | None = None,
    ) -> dict[str, Any] | None:
        self.cleanup()
        now = self.clock()
        with self._transaction() as db:
            record = self._read(db, candidate_id)
            if not record or record["status"] != "generating" or record["claimed"]:
                return None
            if db.execute(
                "SELECT 1 FROM quota.usage WHERE user_id=? AND lease_until>?",
                (self.ctx.requester_user_id, now),
            ).fetchone():
                raise CandidateStorageError("rate_limited")
            count = db.execute(
                "SELECT COUNT(*) FROM quota.usage WHERE user_id=? AND day=?",
                (self.ctx.requester_user_id, int(now // 86400)),
            ).fetchone()[0]
            if count >= daily_limit:
                raise CandidateStorageError("voice_design_quota_exceeded")
            if channel_daily_limit is not None:
                channel_count = db.execute(
                    "SELECT COUNT(*) FROM quota.usage WHERE channel_key=? AND day=?",
                    (channel_key, int(now // 86400)),
                ).fetchone()[0]
                if channel_count >= channel_daily_limit:
                    raise CandidateStorageError("voice_design_quota_exceeded")
            db.execute(
                "INSERT INTO quota.usage VALUES (?,?,?,?,?,?)",
                (
                    self.ctx.requester_user_id,
                    self.ctx.project_id,
                    str(UUID(str(candidate_id))),
                    int(now // 86400),
                    now + self.lease_seconds,
                    channel_key,
                ),
            )
            db.execute(
                "UPDATE candidates SET claimed=1, queued=1, lease_until=? WHERE project_id=? AND user_id=? AND candidate_id=?",
                (now + self.lease_seconds, *self._key(candidate_id)),
            )
            return self._read(db, candidate_id)

    def _release(self, db, candidate_id):
        db.execute(
            "UPDATE quota.usage SET lease_until=0 WHERE project_id=? AND user_id=? AND candidate_id=?",
            self._key(candidate_id),
        )

    def complete(
        self, candidate_id: str, *, duration_seconds: float, sha256: str
    ) -> dict[str, Any]:
        path = self.output_path(candidate_id)
        if not math.isfinite(duration_seconds) or not 0 < duration_seconds <= 15:
            raise CandidateStorageError("candidate_duration_exceeded")
        try:
            if (
                path.is_symlink()
                or not 0 < path.stat().st_size <= 10 * 1024 * 1024
                or file_sha256(path.read_bytes()).hexdigest() != sha256
            ):
                raise CandidateStorageError("candidate_persist_failed")
        except OSError:
            raise CandidateStorageError("candidate_persist_failed") from None
        with self._transaction() as db:
            changed = db.execute(
                "UPDATE candidates SET status='ready',created_at=?,expires_at=?,duration_seconds=?,sha256=? WHERE project_id=? AND user_id=? AND candidate_id=? AND status='generating' AND claimed=1 AND lease_until>?",
                (
                    self.clock(),
                    self.clock() + self.ttl_seconds,
                    duration_seconds,
                    sha256,
                    *self._key(candidate_id),
                    self.clock(),
                ),
            ).rowcount
            if not changed:
                raise CandidateStorageError("candidate_not_ready")
            self._release(db, candidate_id)
            return self._read(db, candidate_id)

    def fail(self, candidate_id: str, code: str) -> None:
        with self._transaction() as db:
            db.execute(
                "UPDATE candidates SET status='failed',error_code=? WHERE project_id=? AND user_id=? AND candidate_id=? AND status='generating'",
                (code, *self._key(candidate_id)),
            )
            self._release(db, candidate_id)

    def mark_unknown(self, candidate_id: str) -> None:
        with self._transaction() as db:
            db.execute(
                "UPDATE candidates SET status='unknown',error_code='generation_unknown' WHERE project_id=? AND user_id=? AND candidate_id=? AND status='generating'",
                self._key(candidate_id),
            )
            self._release(db, candidate_id)

    def cleanup(self) -> None:
        with self._transaction() as db:
            scope = (self.ctx.project_id, self.ctx.requester_user_id)
            db.execute(
                "UPDATE candidates SET status='unknown',error_code='generation_unknown' WHERE project_id=? AND user_id=? AND status='generating' AND lease_until<=?",
                (*scope, self.clock()),
            )
            db.execute(
                "UPDATE candidates SET status='expired' WHERE project_id=? AND user_id=? AND status='ready' AND expires_at<=?",
                (*scope, self.clock()),
            )
            expired = db.execute(
                "SELECT candidate_id FROM candidates WHERE project_id=? AND user_id=? AND status IN ('expired','failed','unknown')",
                scope,
            ).fetchall()
            for row in expired:
                self.output_path(row["candidate_id"]).unlink(missing_ok=True)


def sweep_candidates(*, quota_path: Path | None = None, clock=time.time) -> None:
    """Sweep persisted scopes, including users absent since the previous process."""
    quota_path = Path(quota_path or Path(STATE_DIR) / "voice-design" / "quota.sqlite3")
    if not quota_path.exists():
        return
    with sqlite3.connect(quota_path, timeout=30) as db:
        if not db.execute(
            "SELECT 1 FROM sqlite_master WHERE name='candidate_stores'"
        ).fetchone():
            return
        scopes = db.execute(
            "SELECT project_id,user_id,state_dir,runtime_dir FROM candidate_stores"
        ).fetchall()
    for project_id, user_id, state_dir, runtime_dir in scopes:
        scope = CandidateScope(project_id, user_id, Path(state_dir), Path(runtime_dir))
        if not (scope.state_dir / "voice-design" / "candidates.sqlite3").exists():
            continue
        try:
            VoiceDesignStorage(scope, clock=clock, quota_path=quota_path).cleanup()
        except (CandidateStorageError, OSError, sqlite3.Error):
            logging.getLogger(__name__).warning("Voice design candidate cleanup failed")
