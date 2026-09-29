"""Explicit, hash-bound import keeps legacy evidence intact and unverified.

The backup is a complete logical snapshot stored in the same atomic commit as
the ID map. Activation is last, so interruption never exposes half an import.
No file paths, scripts or network requests are accepted from imported content.
"""

from __future__ import annotations

import json
import sqlite3
import time
from typing import TYPE_CHECKING

from ..documents import object_hash, parse_markdown, render_markdown, walk_blocks
from ..repository import (
    allocate_documents,
    canonical,
    is_canonical,
    stable_id,
    write_ast,
)
from ..schemas.execution import ExecutionFault

if TYPE_CHECKING:
    from ..store import DirectorStore


def _snapshot(db: sqlite3.Connection, work_id: str) -> dict:
    work = db.execute("SELECT * FROM works WHERE id=?", (work_id,)).fetchone()
    if work is None:
        raise ExecutionFault("RESOURCE_GONE", status=404)
    result = {"work": dict(work)}
    for table in (
        "documents",
        "document_versions",
        "changes",
        "runs",
        "events",
        "episode_confirmations",
    ):
        result[table] = [
            dict(row)
            for row in db.execute(
                f"SELECT * FROM {table} WHERE work_id=? ORDER BY rowid", (work_id,)
            )
        ]
    return result


def preview_in_transaction(db: sqlite3.Connection, work_id: str) -> dict:
    if is_canonical(db, work_id):
        raise ExecutionFault("ALREADY_CANONICAL")
    snapshot = _snapshot(db, work_id)
    source_hash = object_hash(snapshot)
    mapping = []
    warnings: set[str] = {"LEGACY_REVIEW_REQUIRED"}
    for doc in snapshot["documents"]:
        identity = stable_id(work_id, "document:" + doc["doc_key"])
        mapping.append(
            {
                "docKey": doc["doc_key"],
                "documentId": identity,
                "version": doc["current_version"],
            }
        )
    for version in snapshot["document_versions"]:
        ast = parse_markdown(version["content"])
        if render_markdown(ast) != version["content"]:
            warnings.add("LINE_ENDINGS_NORMALIZED")
        if any(b.attrs.parse_status != "valid" for b in walk_blocks(ast)):
            warnings.add("PARSE_UNSUPPORTED")
    value = {
        "schemaVersion": 2,
        "workId": work_id,
        "workRevision": snapshot["work"]["revision"],
        "sourceHash": source_hash,
        "documentMap": mapping,
        "versionCount": len(snapshot["document_versions"]),
        "historicalConfirmationCount": len(snapshot["episode_confirmations"]),
        "warnings": sorted(warnings),
        "modelCalls": 0,
    }
    return {**value, "previewHash": object_hash(value)}


def preview_legacy(store: DirectorStore, work_id: str) -> dict:
    with store._connect() as db:
        db.execute("BEGIN")
        try:
            return preview_in_transaction(db, work_id)
        finally:
            db.execute("ROLLBACK")


def commit_legacy(
    store: DirectorStore,
    db: sqlite3.Connection,
    work_id: str,
    expected_revision: int,
    preview_hash: str,
) -> dict:
    previous = db.execute(
        "SELECT * FROM director_migration_backups WHERE work_id=?", (work_id,)
    ).fetchone()
    if previous:
        if previous["preview_hash"] != preview_hash:
            raise ExecutionFault("VERSION_CONFLICT")
        if object_hash(json.loads(previous["backup_json"])) != previous["source_hash"]:
            raise ExecutionFault("BACKUP_CORRUPT")
        return {
            "schemaVersion": 2,
            "migrated": True,
            "sourceHash": previous["source_hash"],
            "previewHash": preview_hash,
        }
    preview = preview_in_transaction(db, work_id)
    if (
        preview["workRevision"] != expected_revision
        or preview["previewHash"] != preview_hash
    ):
        raise ExecutionFault("VERSION_CONFLICT")
    if db.execute(
        "SELECT 1 FROM changes WHERE work_id=? AND status='pending'", (work_id,)
    ).fetchone():
        raise ExecutionFault("PENDING_CHANGES")
    if db.execute(
        "SELECT 1 FROM sqlite_master WHERE name='director_operations'"
    ).fetchone():
        if db.execute(
            "SELECT 1 FROM director_operations WHERE work_id=? AND status IN ('queued','dispatching','cancel_requested','unknown')",
            (work_id,),
        ).fetchone():
            raise ExecutionFault("ACTIVE_OPERATION")
    snapshot = _snapshot(db, work_id)
    backup_json = canonical(snapshot)
    if object_hash(json.loads(backup_json)) != preview["sourceHash"]:
        raise ExecutionFault("BACKUP_CORRUPT")
    mapping = allocate_documents(db, store._work(db, work_id))
    for doc in snapshot["documents"]:
        if doc["doc_key"] not in {row["docKey"] for row in mapping}:
            raise ExecutionFault("UNSUPPORTED_LEGACY_DOCUMENT", status=422)
    for version in sorted(
        snapshot["document_versions"], key=lambda row: (row["doc_key"], row["version"])
    ):
        write_ast(
            db,
            work_id,
            version["doc_key"],
            version["version"],
            version["content"],
            version["origin"],
            legacy=True,
        )
    db.execute(
        "INSERT INTO director_migration_backups VALUES (?,?,?,?,?,?)",
        (
            work_id,
            preview["sourceHash"],
            preview_hash,
            backup_json,
            canonical(mapping),
            time.time(),
        ),
    )
    db.execute(
        "INSERT INTO director_authorities VALUES (?,2,?,?)",
        (work_id, time.time(), preview["sourceHash"]),
    )
    # Keep legacy confirmations verbatim in the backup and original table;
    # they are not evidence for the v2 document/semantic quality gate.
    db.execute(
        "UPDATE works SET status='needs_review',current_episode=1,revision=revision+1,updated_at=? WHERE id=?",
        (time.time(), work_id),
    )
    store._event(
        db,
        work_id,
        "work.migrated",
        {
            "schemaVersion": 2,
            "sourceHash": preview["sourceHash"],
            "legacyUnverified": True,
        },
    )
    return {
        "schemaVersion": 2,
        "migrated": True,
        "sourceHash": preview["sourceHash"],
        "previewHash": preview_hash,
    }
