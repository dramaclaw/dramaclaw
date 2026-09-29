"""Transactional per-project Director state.

Why not reuse story/docs: a single mutable JSON body cannot preserve the formal
version, pending proposal, human decision and episode identity independently.
SQLite lives inside the project state directory; no model output is published
into the canonical document until a version-checked human decision commits it.
"""

from __future__ import annotations

import hashlib
import json
import re
import sqlite3
import time
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

from novelvideo.director.models import CreateWork, DirectorPreset, HistoryCommand, UpdateWork


class DirectorNotFound(Exception):
    pass


class DirectorConflict(Exception):
    pass


class DirectorInvalidState(Exception):
    pass


def _json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


class DirectorStore:
    def __init__(self, state_dir: Path):
        self.path = state_dir / "director" / "studio.sqlite3"
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as db:
            db.executescript(
                """
                CREATE TABLE IF NOT EXISTS works (
                    id TEXT PRIMARY KEY, title TEXT NOT NULL, mode TEXT NOT NULL,
                    preset_json TEXT NOT NULL, brief TEXT NOT NULL,
                    source_text TEXT NOT NULL, source_sha256 TEXT NOT NULL,
                    source_episode_label TEXT NOT NULL,
                    delivery_episode_label TEXT NOT NULL,
                    current_episode INTEGER NOT NULL DEFAULT 1,
                    status TEXT NOT NULL DEFAULT 'created',
                    revision INTEGER NOT NULL DEFAULT 1,
                    created_at REAL NOT NULL, updated_at REAL NOT NULL
                );
                CREATE TABLE IF NOT EXISTS documents (
                    work_id TEXT NOT NULL, doc_key TEXT NOT NULL,
                    current_version INTEGER NOT NULL,
                    PRIMARY KEY (work_id, doc_key),
                    FOREIGN KEY (work_id) REFERENCES works(id)
                );
                CREATE TABLE IF NOT EXISTS document_versions (
                    work_id TEXT NOT NULL, doc_key TEXT NOT NULL,
                    version INTEGER NOT NULL, content TEXT NOT NULL,
                    origin TEXT NOT NULL, created_at REAL NOT NULL,
                    PRIMARY KEY (work_id, doc_key, version)
                );
                CREATE TABLE IF NOT EXISTS changes (
                    id TEXT PRIMARY KEY, work_id TEXT NOT NULL,
                    doc_key TEXT NOT NULL, base_version INTEGER NOT NULL,
                    content TEXT NOT NULL, reason TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'pending',
                    created_at REAL NOT NULL, decided_at REAL
                );
                CREATE TABLE IF NOT EXISTS runs (
                    id TEXT PRIMARY KEY, work_id TEXT NOT NULL,
                    action TEXT NOT NULL, input_sha256 TEXT NOT NULL,
                    request_json TEXT NOT NULL DEFAULT '{}',
                    response_json TEXT NOT NULL DEFAULT '{}',
                    status TEXT NOT NULL, error TEXT NOT NULL DEFAULT '',
                    change_id TEXT, created_at REAL NOT NULL, finished_at REAL
                );
                CREATE TABLE IF NOT EXISTS episode_confirmations (
                    work_id TEXT NOT NULL, ordinal INTEGER NOT NULL,
                    doc_key TEXT NOT NULL, version INTEGER NOT NULL,
                    confirmed_at REAL NOT NULL,
                    PRIMARY KEY (work_id, ordinal)
                );
                CREATE TABLE IF NOT EXISTS events (
                    work_id TEXT NOT NULL, seq INTEGER NOT NULL,
                    kind TEXT NOT NULL, payload_json TEXT NOT NULL,
                    created_at REAL NOT NULL,
                    PRIMARY KEY (work_id, seq)
                );
                CREATE TABLE IF NOT EXISTS history_archives (
                    work_id TEXT PRIMARY KEY REFERENCES works(id), archived_at REAL NOT NULL
                );
                CREATE TABLE IF NOT EXISTS history_commands (
                    command_id TEXT PRIMARY KEY, work_id TEXT NOT NULL REFERENCES works(id),
                    request_json TEXT NOT NULL, result_json TEXT NOT NULL
                );
                """
            )
            columns = {row[1] for row in db.execute("PRAGMA table_info(runs)")}
            for column in ("request_json", "response_json"):
                if column not in columns:
                    db.execute(
                        f"ALTER TABLE runs ADD COLUMN {column} TEXT NOT NULL DEFAULT '{{}}'"
                    )
            from .repository import initialize_schema

            initialize_schema(db)
            from .quality import initialize_quality

            initialize_quality(db)
            from .revisions import initialize_revisions

            initialize_revisions(db)
            from .outline_changes import initialize as initialize_outline_changes

            initialize_outline_changes(db)

    @contextmanager
    def _connect(self) -> Iterator[sqlite3.Connection]:
        db = sqlite3.connect(self.path, timeout=10, isolation_level=None)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys = ON")
        try:
            yield db
        finally:
            db.close()

    @contextmanager
    def _write(self) -> Iterator[sqlite3.Connection]:
        with self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            try:
                yield db
                db.execute("COMMIT")
            except BaseException:
                db.execute("ROLLBACK")
                raise

    @staticmethod
    def _event(
        db: sqlite3.Connection, work_id: str, kind: str, payload: object
    ) -> None:
        next_seq = db.execute(
            "SELECT COALESCE(MAX(seq), 0) + 1 FROM events WHERE work_id = ?", (work_id,)
        ).fetchone()[0]
        db.execute(
            "INSERT INTO events VALUES (?, ?, ?, ?, ?)",
            (work_id, next_seq, kind, _json(payload), time.time()),
        )

    @staticmethod
    def _work(db: sqlite3.Connection, work_id: str) -> sqlite3.Row:
        row = db.execute("SELECT * FROM works WHERE id = ?", (work_id,)).fetchone()
        if row is None:
            raise DirectorNotFound("work not found")
        return row

    @staticmethod
    def _work_data(row: sqlite3.Row, include_source: bool = False) -> dict[str, Any]:
        result = {
            "id": row["id"],
            "title": row["title"],
            "mode": row["mode"],
            "preset": json.loads(row["preset_json"]),
            "brief": row["brief"],
            "source_sha256": row["source_sha256"],
            "source_episode_label": row["source_episode_label"],
            "delivery_episode_label": row["delivery_episode_label"],
            "current_episode": row["current_episode"],
            "status": row["status"],
            "revision": row["revision"],
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
        }
        if include_source:
            result["source_text"] = row["source_text"]
        return result

    def create_work(self, command: CreateWork) -> dict[str, Any]:
        now = time.time()
        work_id = uuid.uuid4().hex
        source = command.source_text.replace("\r\n", "\n").replace("\r", "\n")
        source_hash = (
            hashlib.sha256(source.encode("utf-8")).hexdigest() if source else ""
        )
        preset = command.preset
        with self._write() as db:
            db.execute(
                """INSERT INTO works
                (id, title, mode, preset_json, brief, source_text, source_sha256,
                 source_episode_label, delivery_episode_label, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    work_id,
                    command.title.strip(),
                    preset.mode,
                    _json(preset.model_dump()),
                    command.brief.strip(),
                    source,
                    source_hash,
                    preset.source_episode_label,
                    preset.delivery_episode_label,
                    now,
                    now,
                ),
            )
            self._event(
                db,
                work_id,
                "work.created",
                {"mode": preset.mode, "source_sha256": source_hash},
            )
            from .repository import activate_new_work

            activate_new_work(db, self._work(db, work_id))
            return self._work_data(self._work(db, work_id))

    def list_works(self, archived: bool = False) -> list[dict[str, Any]]:
        with self._connect() as db:
            rows = db.execute(
                "SELECT * FROM works WHERE EXISTS (SELECT 1 FROM history_archives "
                "WHERE work_id = works.id) = ? ORDER BY updated_at DESC", (int(archived),)
            ).fetchall()
            return [self._work_data(row) for row in rows]

    def history_command(self, work_id: str, command: HistoryCommand, actor_id: str) -> dict[str, Any]:
        """Archive reversibly; never invalidate an in-flight paid operation's baseline."""
        request = _json({**command.model_dump(), "actor_id": actor_id})
        with self._write() as db:
            receipt = db.execute("SELECT * FROM history_commands WHERE command_id = ?", (command.command_id,)).fetchone()
            if receipt:
                if receipt["work_id"] != work_id or receipt["request_json"] != request:
                    raise DirectorConflict("history intent changed")
                return json.loads(receipt["result_json"])
            work = self._work(db, work_id)
            if work["revision"] != command.expected_revision:
                raise DirectorConflict("work changed before history action")
            if db.execute("SELECT 1 FROM runs WHERE work_id = ? AND status = 'running'", (work_id,)).fetchone():
                raise DirectorConflict("wait for the active generation before changing history")
            if db.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'director_operations'").fetchone():
                if db.execute(
                    "SELECT 1 FROM director_operations WHERE work_id = ? "
                    "AND status IN ('queued','dispatching','cancel_requested','unknown')", (work_id,)
                ).fetchone():
                    raise DirectorConflict("resolve the active operation before changing history")
            now = time.time()
            if command.action == "rename":
                db.execute("UPDATE works SET title = ?, revision = revision + 1, updated_at = ? WHERE id = ?", (command.title.strip(), now, work_id))
            else:
                if command.action == "archive":
                    db.execute("INSERT OR REPLACE INTO history_archives VALUES (?, ?)", (work_id, now))
                else:
                    db.execute("DELETE FROM history_archives WHERE work_id = ?", (work_id,))
                db.execute("UPDATE works SET revision = revision + 1, updated_at = ? WHERE id = ?", (now, work_id))
            self._event(db, work_id, f"history.{command.action}", {"actor_id": actor_id, "command_id": command.command_id})
            result = self._work_data(self._work(db, work_id))
            db.execute("INSERT INTO history_commands VALUES (?, ?, ?, ?)", (command.command_id, work_id, request, _json(result)))
            return result

    def update_work(self, work_id: str, command: UpdateWork) -> dict[str, Any]:
        """Freeze inputs at the first written artifact so old versions remain reproducible."""
        source = command.source_text.replace("\r\n", "\n").replace("\r", "\n")
        source_hash = (
            hashlib.sha256(source.encode("utf-8")).hexdigest() if source else ""
        )
        with self._write() as db:
            work = self._work(db, work_id)
            if work["revision"] != command.expected_revision:
                raise DirectorConflict("work settings changed before save")
            if (
                work["status"] != "created"
                or any(
                    db.execute(
                        f"SELECT 1 FROM {table} WHERE work_id = ? LIMIT 1", (work_id,)
                    ).fetchone()
                    for table in ("documents", "changes", "episode_confirmations")
                )
                or db.execute(
                    "SELECT 1 FROM runs WHERE work_id = ? AND status != 'failed' LIMIT 1",
                    (work_id,),
                ).fetchone()
            ):
                raise DirectorInvalidState(
                    "work settings are frozen after writing begins"
                )
            preset = command.preset
            now = time.time()
            db.execute(
                """UPDATE works SET title = ?, mode = ?, preset_json = ?, brief = ?,
                   source_text = ?, source_sha256 = ?, source_episode_label = ?,
                   delivery_episode_label = ?, revision = revision + 1, updated_at = ?
                   WHERE id = ?""",
                (
                    command.title.strip(),
                    preset.mode,
                    _json(preset.model_dump()),
                    command.brief.strip(),
                    source,
                    source_hash,
                    preset.source_episode_label,
                    preset.delivery_episode_label,
                    now,
                    work_id,
                ),
            )
            self._event(
                db,
                work_id,
                "work.settings_updated",
                {
                    "revision": command.expected_revision + 1,
                    "source_sha256": source_hash,
                },
            )
            from .repository import allocate_documents, is_canonical

            if is_canonical(db, work_id):
                allocate_documents(db, self._work(db, work_id))
            return self._work_data(self._work(db, work_id))

    def get_work(self, work_id: str, *, include_source: bool = False) -> dict[str, Any]:
        with self._connect() as db:
            return self._work_data(
                self._work(db, work_id), include_source=include_source
            )

    def get_document(self, work_id: str, doc_key: str) -> dict[str, Any]:
        with self._connect() as db:
            self._work(db, work_id)
            row = db.execute(
                """SELECT d.current_version AS version, v.content, v.origin, v.created_at
                FROM documents d JOIN document_versions v
                  ON d.work_id = v.work_id AND d.doc_key = v.doc_key
                 AND d.current_version = v.version
                WHERE d.work_id = ? AND d.doc_key = ?""",
                (work_id, doc_key),
            ).fetchone()
            if row is None:
                return {
                    "doc_key": doc_key,
                    "version": 0,
                    "content": "",
                    "origin": "",
                    "created_at": 0,
                }
            from .repository import ast_version, is_canonical

            if is_canonical(db, work_id):
                canonical = ast_version(db, work_id, doc_key, row["version"])
                if canonical is None:
                    raise DirectorInvalidState("canonical document version is missing")
                return {
                    "doc_key": doc_key,
                    **dict(row),
                    "content": canonical["content"],
                    "document_id": canonical["documentId"],
                    "content_hash": canonical["contentHash"],
                    "semantic_input_hash": canonical["semanticInputHash"],
                    "schema_version": 2,
                }
            return {"doc_key": doc_key, **dict(row)}

    def list_documents(self, work_id: str) -> list[dict[str, Any]]:
        with self._connect() as db:
            self._work(db, work_id)
            rows = db.execute(
                "SELECT doc_key, current_version AS version FROM documents WHERE work_id = ? ORDER BY doc_key",
                (work_id,),
            ).fetchall()
            return [dict(row) for row in rows]

    @staticmethod
    def _version(db: sqlite3.Connection, work_id: str, doc_key: str) -> int:
        row = db.execute(
            "SELECT current_version FROM documents WHERE work_id = ? AND doc_key = ?",
            (work_id, doc_key),
        ).fetchone()
        return int(row[0]) if row else 0

    def _ensure_writable(
        self,
        db: sqlite3.Connection,
        work: sqlite3.Row,
        doc_key: str,
        *,
        accepted_change_id: str | None = None,
    ) -> None:
        """A confirmed episode is an immutable checkpoint, not an editable draft."""
        if work["status"] == "completed":
            raise DirectorInvalidState("a completed work cannot be overwritten")
        if db.execute(
            """SELECT 1 FROM changes WHERE work_id = ? AND doc_key = ?
               AND status = 'pending' AND id != ?""",
            (work["id"], doc_key, accepted_change_id or ""),
        ).fetchone():
            raise DirectorInvalidState(
                "review the pending proposal before editing this document"
            )
        if doc_key.startswith("episode-"):
            ordinal = int(doc_key[8:])
            preset = DirectorPreset.model_validate_json(work["preset_json"])
            if ordinal != work["current_episode"] or ordinal > preset.episode_count:
                raise DirectorInvalidState("episode is not the current checkpoint")
            from .repository import is_canonical
            from .quality import valid_finalization

            confirmed = (
                valid_finalization(self, db, work["id"], ordinal)
                if is_canonical(db, work["id"])
                else db.execute(
                    "SELECT 1 FROM episode_confirmations WHERE work_id = ? AND ordinal = ?",
                    (work["id"], ordinal),
                ).fetchone()
            )
            if confirmed:
                raise DirectorInvalidState("a confirmed episode cannot be overwritten")

    def _put_document(
        self,
        db: sqlite3.Connection,
        work_id: str,
        doc_key: str,
        content: str,
        expected_version: int,
        origin: str,
        *,
        verified_ast=None,
    ) -> dict[str, Any]:
        current = self._version(db, work_id, doc_key)
        if current != expected_version:
            raise DirectorConflict(
                f"document version changed: expected {expected_version}, current {current}"
            )
        version = current + 1
        now = time.time()
        from .repository import is_canonical, write_ast, write_verified_ast

        if is_canonical(db, work_id):
            if verified_ast is not None:
                from .documents import render_markdown

                if render_markdown(verified_ast) != content:
                    raise DirectorInvalidState("candidate AST does not match its projection")
                content = write_verified_ast(db, work_id, doc_key, version, verified_ast, origin)
            else:
                content = write_ast(db, work_id, doc_key, version, content, origin)
        elif verified_ast is not None:
            raise DirectorInvalidState("reviewed AST requires canonical storage")
        db.execute(
            "INSERT INTO document_versions VALUES (?, ?, ?, ?, ?, ?)",
            (work_id, doc_key, version, content, origin, now),
        )
        db.execute(
            """INSERT INTO documents VALUES (?, ?, ?)
            ON CONFLICT(work_id, doc_key) DO UPDATE SET current_version = excluded.current_version""",
            (work_id, doc_key, version),
        )
        db.execute(
            "UPDATE works SET updated_at = ?, revision = revision + 1 WHERE id = ?",
            (now, work_id),
        )
        self._event(
            db,
            work_id,
            "document.versioned",
            {"doc_key": doc_key, "version": version, "origin": origin},
        )
        result = {
            "doc_key": doc_key,
            "version": version,
            "content": content,
            "origin": origin,
            "created_at": now,
        }
        if is_canonical(db, work_id):
            from .repository import ast_version

            canonical = ast_version(db, work_id, doc_key, version)
            result.update(
                document_id=canonical["documentId"],
                content_hash=canonical["contentHash"],
                semantic_input_hash=canonical["semanticInputHash"],
                schema_version=2,
            )
        return result

    def put_document(
        self,
        work_id: str,
        doc_key: str,
        content: str,
        expected_version: int,
    ) -> dict[str, Any]:
        with self._write() as db:
            work = self._work(db, work_id)
            if self._version(db, work_id, doc_key) != expected_version:
                raise DirectorConflict("document changed before edit")
            self._ensure_writable(db, work, doc_key)
            return self._put_document(
                db, work_id, doc_key, content, expected_version, "user"
            )

    def propose_change(
        self,
        work_id: str,
        doc_key: str,
        content: str,
        expected_version: int,
        reason: str,
    ) -> dict[str, Any]:
        with self._write() as db:
            work = self._work(db, work_id)
            self._ensure_writable(db, work, doc_key)
            if self._version(db, work_id, doc_key) != expected_version:
                raise DirectorConflict("document changed before proposal")
            pending = db.execute(
                """SELECT id FROM changes WHERE work_id = ? AND doc_key = ? AND status = 'pending'""",
                (work_id, doc_key),
            ).fetchone()
            if pending:
                raise DirectorConflict(
                    "a proposal for this document is already pending"
                )
            change_id = uuid.uuid4().hex
            now = time.time()
            db.execute(
                "INSERT INTO changes VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, NULL)",
                (change_id, work_id, doc_key, expected_version, content, reason, now),
            )
            self._event(
                db,
                work_id,
                "change.proposed",
                {
                    "change_id": change_id,
                    "doc_key": doc_key,
                    "base_version": expected_version,
                },
            )
            return self._change_data(db, change_id)

    @staticmethod
    def _change_data(db: sqlite3.Connection, change_id: str) -> dict[str, Any]:
        row = db.execute("SELECT * FROM changes WHERE id = ?", (change_id,)).fetchone()
        if row is None:
            raise DirectorNotFound("change not found")
        from .outline_changes import projection

        patch = projection(db, change_id)
        return {**dict(row), **({"outlinePatch": patch} if patch else {})}

    def list_changes(self, work_id: str) -> list[dict[str, Any]]:
        with self._connect() as db:
            self._work(db, work_id)
            return [
                self._change_data(db, row["id"])
                for row in db.execute(
                    "SELECT * FROM changes WHERE work_id = ? ORDER BY created_at DESC",
                    (work_id,),
                ).fetchall()
            ]

    def decide_change(
        self, work_id: str, change_id: str, accept: bool
    ) -> dict[str, Any]:
        with self._write() as db:
            self._work(db, work_id)
            change = self._change_data(db, change_id)
            if change["work_id"] != work_id:
                raise DirectorNotFound("change not found")
            if change.get("outlinePatch"):
                from .schemas.execution import ExecutionFault

                raise ExecutionFault("OUTLINE_GROUP_DECISION_REQUIRED")
            if change["status"] != "pending":
                raise DirectorConflict("change already decided")
            document = None
            if accept:
                self._ensure_writable(
                    db,
                    self._work(db, work_id),
                    change["doc_key"],
                    accepted_change_id=change_id,
                )
                document = self._put_document(
                    db,
                    work_id,
                    change["doc_key"],
                    change["content"],
                    change["base_version"],
                    "accepted_proposal",
                )
            status = "accepted" if accept else "rejected"
            db.execute(
                "UPDATE changes SET status = ?, decided_at = ? WHERE id = ?",
                (status, time.time(), change_id),
            )
            self._event(
                db,
                work_id,
                "change.decided",
                {"change_id": change_id, "decision": status},
            )
            return {"change": self._change_data(db, change_id), "document": document}

    @staticmethod
    def _episode_number(label: str) -> int | None:
        match = re.search(
            r"(?:EP\s*0*|第\s*)(\d+|[零〇一二两三四五六七八九十百]+)",
            label,
            re.IGNORECASE,
        )
        if not match:
            return None
        value = match.group(1)
        if value.isdecimal():
            return int(value)
        digits = {
            char: number
            for number, chars in enumerate(
                ("零〇", "一", "二两", "三", "四", "五", "六", "七", "八", "九")
            )
            for char in chars
        }
        if value == "一百":
            return 100
        if "十" in value:
            tens, _, ones = value.partition("十")
            if tens and tens not in digits:
                return None
            if ones and ones not in digits:
                return None
            return (digits[tens] if tens else 1) * 10 + (digits[ones] if ones else 0)
        return digits.get(value)

    def _quality_report(
        self, db: sqlite3.Connection, work: sqlite3.Row, ordinal: int
    ) -> dict[str, Any]:
        """Only mechanically provable faults block; creative quality remains human review."""
        preset = DirectorPreset.model_validate_json(work["preset_json"])
        doc_key = f"episode-{ordinal:03d}"
        version = self._version(db, work["id"], doc_key)
        row = db.execute(
            """SELECT content FROM document_versions
               WHERE work_id = ? AND doc_key = ? AND version = ?""",
            (work["id"], doc_key, version),
        ).fetchone()
        content = row["content"] if row else ""
        blockers: list[str] = []
        from .repository import ast_version, is_canonical

        if version and is_canonical(db, work["id"]):
            canonical = ast_version(db, work["id"], doc_key, version)
            if canonical is None:
                blockers.append("DOCUMENT_CORRUPT")
                content = ""
            else:
                content = canonical["content"]
                if canonical["status"] == "legacy_unverified":
                    blockers.append("LEGACY_REVIEW_REQUIRED")
        if (
            not is_canonical(db, work["id"])
            and db.execute(
                "SELECT 1 FROM director_invalidated_confirmations WHERE work_id=? AND ordinal<?",
                (work["id"], ordinal),
            ).fetchone()
        ):
            blockers.append("PRIOR_EPISODE_UNCONFIRMED")
        has_execution_ledger = db.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='director_operations'"
        ).fetchone()
        if (
            has_execution_ledger
            and db.execute(
                """SELECT 1 FROM director_operations WHERE work_id=?
               AND status IN ('queued','dispatching','cancel_requested','unknown') LIMIT 1""",
                (work["id"],),
            ).fetchone()
        ):
            blockers.append("ACTIVE_OPERATION")
        if ordinal != work["current_episode"] or ordinal > preset.episode_count:
            blockers.append("NOT_CURRENT_EPISODE")
        if not content.strip():
            blockers.append("EMPTY_EPISODE")
        if db.execute(
            "SELECT 1 FROM changes WHERE work_id = ? AND status = 'pending' LIMIT 1",
            (work["id"],),
        ).fetchone():
            blockers.append("PENDING_CHANGES")
        if ordinal > 1:
            from .quality import valid_finalization

            if is_canonical(db, work["id"]):
                prior_valid = all(
                    valid_finalization(self, db, work["id"], number)
                    for number in range(1, ordinal)
                )
            else:
                prior_valid = db.execute(
                    "SELECT 1 FROM episode_confirmations WHERE work_id=? AND ordinal=?",
                    (work["id"], ordinal - 1),
                ).fetchone()
            if not prior_valid:
                blockers.append("PRIOR_EPISODE_UNCONFIRMED")
        expected = (
            self._episode_number(work["delivery_episode_label"])
            if ordinal == 1
            else None
        )
        heading = content.lstrip().splitlines()[0] if content.strip() else ""
        actual = self._episode_number(heading)
        if expected is not None and actual is not None and actual != expected:
            blockers.append("EPISODE_LABEL_MISMATCH")
        warnings = ["DURATION_UNMEASURED", "CONTINUITY_REQUIRES_HUMAN_REVIEW"]
        if work["mode"] == "adaptation":
            warnings.append("SOURCE_EVENTS_UNVERIFIED")
        return {
            "doc_key": doc_key,
            "version": version,
            "blockers": blockers,
            "warnings": warnings,
            "ready_for_human_review": not blockers,
        }

    def quality_report(self, work_id: str, ordinal: int) -> dict[str, Any]:
        with self._connect() as db:
            return self._quality_report(db, self._work(db, work_id), ordinal)

    def finalize_episode(
        self,
        work_id: str,
        ordinal: int,
        expected_version: int,
        quality_acknowledged: bool,
    ) -> dict[str, Any]:
        if not quality_acknowledged:
            raise DirectorInvalidState("quality review must be explicitly acknowledged")
        with self._write() as db:
            work = self._work(db, work_id)
            from .repository import is_canonical

            report = self._quality_report(db, work, ordinal)
            if report["version"] != expected_version:
                raise DirectorConflict("episode version changed before confirmation")
            if report["blockers"]:
                raise DirectorInvalidState(
                    f"quality blockers: {', '.join(report['blockers'])}"
                )
            if is_canonical(db, work_id):
                raise DirectorInvalidState("FINALIZATION_V2_REQUIRED")
            return self._finalize_episode(db, work, ordinal, expected_version)

    def _finalize_episode(
        self,
        db: sqlite3.Connection,
        work: sqlite3.Row,
        ordinal: int,
        expected_version: int,
    ) -> dict:
        """Shared transaction tail only; callers must finish their respective guards."""
        work_id = work["id"]
        doc_key = f"episode-{ordinal:03d}"
        from .repository import is_canonical

        canonical = is_canonical(db, work_id)
        if (
            not canonical
            and db.execute(
                "SELECT 1 FROM episode_confirmations WHERE work_id = ? AND ordinal = ?",
                (work_id, ordinal),
            ).fetchone()
        ):
            raise DirectorConflict("episode already confirmed")
        preset = DirectorPreset.model_validate_json(work["preset_json"])
        completed = ordinal == preset.episode_count
        status = "completed" if completed else "awaiting_next_episode"
        next_episode = ordinal if completed else ordinal + 1
        now = time.time()
        if not canonical:
            db.execute(
                "INSERT INTO episode_confirmations VALUES (?, ?, ?, ?, ?)",
                (work_id, ordinal, doc_key, expected_version, now),
            )
        db.execute(
            "UPDATE works SET current_episode = ?, status = ?, revision = revision + 1, updated_at = ? WHERE id = ?",
            (next_episode, status, now, work_id),
        )
        self._event(
            db,
            work_id,
            "episode.confirmed",
            {
                "ordinal": ordinal,
                "doc_key": doc_key,
                "version": expected_version,
                "completed": completed,
            },
        )
        return self._work_data(self._work(db, work_id))

    def list_events(self, work_id: str, after_seq: int = 0) -> list[dict[str, Any]]:
        with self._connect() as db:
            self._work(db, work_id)
            return [
                {
                    "seq": row["seq"],
                    "kind": row["kind"],
                    "payload": json.loads(row["payload_json"]),
                    "created_at": row["created_at"],
                }
                for row in db.execute(
                    "SELECT * FROM events WHERE work_id = ? AND seq > ? ORDER BY seq",
                    (work_id, after_seq),
                ).fetchall()
            ]

    def start_run(
        self,
        work_id: str,
        action: str,
        input_sha256: str,
        request: dict[str, Any] | None = None,
    ) -> str:
        run_id = uuid.uuid4().hex
        with self._write() as db:
            self._work(db, work_id)
            if db.execute(
                "SELECT 1 FROM runs WHERE work_id = ? AND status = 'running'",
                (work_id,),
            ).fetchone():
                raise DirectorConflict("another generation is running for this work")
            db.execute(
                "INSERT INTO runs (id, work_id, action, input_sha256, request_json, status, created_at) "
                "VALUES (?, ?, ?, ?, ?, 'running', ?)",
                (
                    run_id,
                    work_id,
                    action,
                    input_sha256,
                    _json(request or {}),
                    time.time(),
                ),
            )
            self._event(
                db,
                work_id,
                "run.started",
                {"run_id": run_id, "action": action, "input_sha256": input_sha256},
            )
        return run_id

    def finish_run(
        self,
        work_id: str,
        run_id: str,
        *,
        change_id: str | None = None,
        error: str = "",
        response: dict[str, Any] | None = None,
    ) -> None:
        with self._write() as db:
            row = db.execute(
                "SELECT * FROM runs WHERE id = ? AND work_id = ?", (run_id, work_id)
            ).fetchone()
            if row is None:
                raise DirectorNotFound("run not found")
            if row["status"] != "running":
                raise DirectorConflict("run already finished")
            status = "failed" if error else "completed"
            db.execute(
                "UPDATE runs SET status = ?, error = ?, change_id = ?, response_json = ?, finished_at = ? WHERE id = ?",
                (
                    status,
                    error[:1000],
                    change_id,
                    _json(response or {}),
                    time.time(),
                    run_id,
                ),
            )
            self._event(
                db,
                work_id,
                f"run.{status}",
                {"run_id": run_id, "change_id": change_id, "error": error[:200]},
            )

    def list_runs(self, work_id: str) -> list[dict[str, Any]]:
        with self._connect() as db:
            self._work(db, work_id)
            rows = db.execute(
                "SELECT * FROM runs WHERE work_id = ? ORDER BY created_at DESC",
                (work_id,),
            ).fetchall()
            return [
                {
                    **dict(row),
                    "request": json.loads(row["request_json"]),
                    "response": json.loads(row["response_json"]),
                }
                for row in rows
            ]
