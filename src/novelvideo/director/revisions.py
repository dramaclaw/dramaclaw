"""Reopen and spec-impact transactions preserve the evidence they supersede.

No model is called here. A conservative impact closure is preferable to letting
an unreviewed style/length change inherit an old finalization. Future semantic
diffing can narrow this closure, but must never silently expand paid scope.
"""

from __future__ import annotations

import json
import sqlite3
import time
import uuid
from typing import TYPE_CHECKING

from .documents import object_hash
from .models import DirectorPreset
from .repository import allocate_documents, is_canonical
from .schemas.execution import ExecutionFault
from .schemas.revisions import CommitRevision, RevisionPreviewCommand

if TYPE_CHECKING:
    from .store import DirectorStore


def initialize_revisions(db: sqlite3.Connection) -> None:
    db.executescript("""
      CREATE TABLE IF NOT EXISTS director_revision_previews (
        id TEXT PRIMARY KEY, work_id TEXT NOT NULL, actor TEXT NOT NULL,
        preview_json TEXT NOT NULL, preview_hash TEXT NOT NULL, expires_at REAL NOT NULL
      );
      CREATE TABLE IF NOT EXISTS director_settings_history (
        work_id TEXT NOT NULL, revision INTEGER NOT NULL, actor TEXT NOT NULL,
        snapshot_json TEXT NOT NULL, snapshot_hash TEXT NOT NULL,
        reason TEXT NOT NULL, created_at REAL NOT NULL,
        PRIMARY KEY(work_id,revision)
      );
      CREATE TABLE IF NOT EXISTS director_revision_commands (
        work_id TEXT NOT NULL, actor TEXT NOT NULL, command_id TEXT NOT NULL,
        client_request_id TEXT NOT NULL, request_hash TEXT NOT NULL, result_json TEXT NOT NULL,
        PRIMARY KEY(work_id,actor,command_id), UNIQUE(work_id,actor,client_request_id)
      );
    """)


def settings_snapshot(work: sqlite3.Row) -> dict:
    return {
        "format": "legacy-preset-adapter-v2",
        "title": work["title"],
        "brief": work["brief"],
        "preset": DirectorPreset.model_validate_json(work["preset_json"]).model_dump(),
        "sourceHash": work["source_sha256"],
    }


def save_settings_snapshot(db, work, actor: str, reason: str) -> None:
    snapshot = settings_snapshot(work)
    db.execute(
        "INSERT OR IGNORE INTO director_settings_history VALUES (?,?,?,?,?,?,?)",
        (
            work["id"],
            work["revision"],
            actor,
            json.dumps(snapshot, ensure_ascii=False),
            object_hash(snapshot),
            reason,
            time.time(),
        ),
    )


class RevisionService:
    def __init__(self, store: DirectorStore, *, clock=time.time):
        self.store = store
        self.clock = clock

    def _boundary(self, db, work) -> dict:
        work_id = work["id"]
        if not is_canonical(db, work_id):
            raise ExecutionFault("LEGACY_IMPORT_REQUIRED")
        if db.execute(
            "SELECT 1 FROM sqlite_master WHERE name='director_operations'"
        ).fetchone():
            if db.execute(
                "SELECT 1 FROM director_operations WHERE work_id=? AND status IN ('queued','dispatching','cancel_requested','unknown')",
                (work_id,),
            ).fetchone():
                raise ExecutionFault("ACTIVE_OPERATION", recovery="inspect_run")
        if db.execute(
            "SELECT 1 FROM runs WHERE work_id=? AND status='running'", (work_id,)
        ).fetchone():
            raise ExecutionFault("ACTIVE_OPERATION", recovery="inspect_run")
        if db.execute(
            "SELECT 1 FROM changes WHERE work_id=? AND status='pending'", (work_id,)
        ).fetchone():
            raise ExecutionFault("PENDING_CHANGES")
        return {
            "workRevision": work["revision"],
            "settings": settings_snapshot(work),
            "documents": [
                dict(r)
                for r in db.execute(
                    "SELECT doc_key,current_version FROM documents WHERE work_id=? ORDER BY doc_key",
                    (work_id,),
                )
            ],
            "reports": [
                r[0]
                for r in db.execute(
                    "SELECT id FROM director_quality_reports WHERE work_id=? ORDER BY id",
                    (work_id,),
                )
            ],
            "finalizations": [
                r[0]
                for r in db.execute(
                    "SELECT id FROM director_finalizations_v2 WHERE work_id=? ORDER BY id",
                    (work_id,),
                )
            ],
            "artifacts": [
                dict(r)
                for r in db.execute(
                    "SELECT id,version,body_hash,status FROM director_artifacts WHERE work_id=? ORDER BY id",
                    (work_id,),
                )
            ],
        }

    def preview(self, actor: str, command: RevisionPreviewCommand) -> dict:
        if not actor:
            raise ExecutionFault("FORBIDDEN", status=403)
        with self.store._write() as db:
            work = self.store._work(db, command.work_id)
            if work["revision"] != command.expected_work_revision:
                raise ExecutionFault("VERSION_CONFLICT")
            boundary = self._boundary(db, work)
            before = boundary["settings"]
            after = before
            count = before["preset"]["episode_count"]
            fields = []
            if command.payload.type == "settings.preview":
                value = command.payload.candidate
                preset = value.preset.model_dump()
                for key in ("mode", "source_episode_label"):
                    if before["preset"][key] != preset[key]:
                        raise ExecutionFault("SOURCE_BINDING_IMMUTABLE")
                if not value.brief.strip() and not work["source_text"].strip():
                    raise ExecutionFault("REQUIRED_CONTEXT_MISSING")
                after = {
                    **before,
                    "title": value.title.strip(),
                    "brief": value.brief.strip(),
                    "preset": preset,
                }
                for key in ("title", "brief"):
                    if before[key] != after[key]:
                        fields.append(
                            {"field": key, "before": before[key], "after": after[key]}
                        )
                for key in preset:
                    if before["preset"][key] != preset[key]:
                        fields.append(
                            {
                                "field": key,
                                "before": before["preset"][key],
                                "after": preset[key],
                            }
                        )
                if not fields:
                    raise ExecutionFault("NO_SETTINGS_CHANGE")
                start = 1 if any(f["field"] not in {"title", "model_name"} for f in fields) else None
                count = preset["episode_count"]
            else:
                start = command.payload.episode_ordinal
                if start > count or not self.store._version(
                    db, work["id"], f"episode-{start:03d}"
                ):
                    raise ExecutionFault("EPISODE_NOT_FOUND", status=404)
            episodes = [
                dict(r)
                for r in db.execute(
                    """SELECT e.*,d.doc_key,COALESCE(v.current_version,0) AS version
                FROM director_episodes e JOIN director_document_ids d ON d.id=e.document_id
                LEFT JOIN documents v ON v.work_id=e.work_id AND v.doc_key=d.doc_key
                WHERE e.work_id=? ORDER BY e.order_key""",
                    (work["id"],),
                )
            ]
            affected = [
                e for e in episodes if start is not None and e["order_key"] >= start
            ]

            def public_episode(e):
                return {
                    "id": e["id"],
                    "docKey": e["doc_key"],
                    "ordinal": e["order_key"],
                    "label": e["delivery_label"],
                    "version": e["version"],
                }

            value = {
                "schemaVersion": 2,
                "workId": work["id"],
                "workRevision": work["revision"],
                "type": command.payload.type,
                "before": before,
                "after": after,
                "changedFields": fields,
                "restartEpisode": start,
                "affectedEpisodes": [public_episode(e) for e in affected],
                "archiveEpisodes": [
                    public_episode(e)
                    for e in episodes
                    if e["order_key"] > count and not e["archived"]
                ],
                "restoredEpisodes": [
                    public_episode(e)
                    for e in episodes
                    if e["order_key"] <= count and e["archived"]
                ],
                "addedOrdinals": list(
                    range(max(e["order_key"] for e in episodes) + 1, count + 1)
                ),
                "invalidatedReportIds": [
                    r[0]
                    for r in db.execute(
                        "SELECT q.id FROM director_quality_reports q JOIN director_document_ids d ON d.work_id=q.work_id AND d.doc_key=q.doc_key JOIN director_episodes e ON e.document_id=d.id LEFT JOIN director_review_invalidations i ON i.report_id=q.id WHERE q.work_id=? AND e.order_key>=? AND i.report_id IS NULL ORDER BY q.id",
                        (work["id"], start or 101),
                    )
                ],
                "invalidatedFinalizationIds": [
                    r[0]
                    for r in db.execute(
                        "SELECT f.id FROM director_finalizations_v2 f JOIN director_episodes e ON e.id=f.episode_id LEFT JOIN director_finalization_invalidations i ON i.finalization_id=f.id WHERE f.work_id=? AND e.order_key>=? AND i.finalization_id IS NULL ORDER BY f.id",
                        (work["id"], start or 101),
                    )
                ],
                "boundaryHash": object_hash(boundary),
                "modelCalls": 0,
            }
            preview_hash = object_hash(value)
            preview_id = uuid.uuid4().hex
            expiry = self.clock() + 900
            db.execute(
                "INSERT INTO director_revision_previews VALUES (?,?,?,?,?,?)",
                (
                    preview_id,
                    work["id"],
                    actor,
                    json.dumps(value, ensure_ascii=False),
                    preview_hash,
                    expiry,
                ),
            )
            return {
                **value,
                "previewId": preview_id,
                "previewHash": preview_hash,
                "expiresAt": expiry,
            }

    def commit(self, actor: str, command: CommitRevision) -> dict:
        if not actor:
            raise ExecutionFault("FORBIDDEN", status=403)
        request_hash = object_hash(command.model_dump(by_alias=True))
        with self.store._write() as db:
            prior = db.execute(
                "SELECT * FROM director_revision_commands WHERE work_id=? AND actor=? AND (command_id=? OR client_request_id=?)",
                (command.work_id, actor, command.command_id, command.client_request_id),
            ).fetchall()
            if prior:
                if len(prior) != 1 or prior[0]["request_hash"] != request_hash:
                    raise ExecutionFault("IDEMPOTENCY_CONFLICT")
                return json.loads(prior[0]["result_json"])
            work = self.store._work(db, command.work_id)
            row = db.execute(
                "SELECT * FROM director_revision_previews WHERE id=? AND work_id=? AND actor=?",
                (command.preview_id, command.work_id, actor),
            ).fetchone()
            if row is None:
                raise ExecutionFault("RESOURCE_GONE", status=404)
            preview = json.loads(row["preview_json"])
            if (
                object_hash(preview) != row["preview_hash"]
                or command.preview_hash != row["preview_hash"]
            ):
                raise ExecutionFault("IMPACT_HASH_MISMATCH")
            if self.clock() >= row["expires_at"]:
                raise ExecutionFault("IMPACT_EXPIRED")
            if object_hash(self._boundary(db, work)) != preview["boundaryHash"]:
                raise ExecutionFault("IMPACT_STALE")
            if set(command.archive_episode_ids) != {
                e["id"] for e in preview["archiveEpisodes"]
            }:
                raise ExecutionFault("ARCHIVE_CONFIRMATION_REQUIRED")
            save_settings_snapshot(db, work, actor, "baseline-before-revision")
            after = preview["after"]
            start = preview["restartEpisode"]
            if start is not None:
                for report_id in preview["invalidatedReportIds"]:
                    db.execute(
                        "INSERT OR IGNORE INTO director_review_invalidations VALUES (?,?,?)",
                        (report_id, command.preview_id, self.clock()),
                    )
                for finalization_id in preview["invalidatedFinalizationIds"]:
                    db.execute(
                        "INSERT OR IGNORE INTO director_finalization_invalidations VALUES (?,?,?)",
                        (finalization_id, command.preview_id, self.clock()),
                    )
                # Unknown artifact dependency schemas are not a license to
                # reuse a report under changed constraints. Preserve but stale.
                db.execute(
                    "UPDATE director_artifacts SET status='stale' WHERE work_id=?",
                    (work["id"],),
                )
            db.execute(
                """UPDATE works SET title=?,brief=?,preset_json=?,delivery_episode_label=?,
                revision=revision+1,current_episode=?,status=?,updated_at=? WHERE id=?""",
                (
                    after["title"],
                    after["brief"],
                    json.dumps(after["preset"], ensure_ascii=False),
                    after["preset"]["delivery_episode_label"],
                    start or work["current_episode"],
                    "needs_review" if start is not None else work["status"],
                    self.clock(),
                    work["id"],
                ),
            )
            updated = self.store._work(db, work["id"])
            allocate_documents(db, updated)
            save_settings_snapshot(db, updated, actor, command.reason)
            result = {
                "schemaVersion": 2,
                "work": self.store._work_data(updated, include_source=True),
                "previewId": command.preview_id,
                "previewHash": command.preview_hash,
                "modelCalls": 0,
            }
            self.store._event(
                db,
                work["id"],
                "work.revision_committed",
                {
                    "revision": updated["revision"],
                    "previewId": command.preview_id,
                    "restartEpisode": start,
                    "archiveEpisodeIds": command.archive_episode_ids,
                },
            )
            db.execute(
                "INSERT INTO director_revision_commands VALUES (?,?,?,?,?,?)",
                (
                    work["id"],
                    actor,
                    command.command_id,
                    command.client_request_id,
                    request_hash,
                    json.dumps(result, ensure_ascii=False),
                ),
            )
            return result

    def history(self, work_id: str) -> list[dict]:
        with self.store._connect() as db:
            self.store._work(db, work_id)
            return [
                {
                    "revision": row["revision"],
                    "snapshot": json.loads(row["snapshot_json"]),
                    "snapshotHash": row["snapshot_hash"],
                    "reason": row["reason"],
                    "createdAt": row["created_at"],
                }
                for row in db.execute(
                    "SELECT * FROM director_settings_history WHERE work_id=? ORDER BY revision",
                    (work_id,),
                )
            ]
