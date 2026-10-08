"""One database transaction owns AST, projections and dependency invalidation.

Legacy Markdown is retained as an export cache and history, never a second
editable authority after activation. No migration or model call occurs on read.
"""

from __future__ import annotations

import json
import sqlite3
import time
import uuid
from typing import TYPE_CHECKING

from .documents import (
    object_hash,
    parse_markdown,
    render_markdown,
    semantic_hash,
    walk_blocks,
)
from .schemas.documents import DocumentAST, DocumentCommand, VersionReference
from .schemas.execution import ExecutionFault

if TYPE_CHECKING:
    from .store import DirectorStore


def canonical(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def stable_id(work_id: str, name: str) -> str:
    return uuid.uuid5(uuid.NAMESPACE_URL, f"director:{work_id}:{name}").hex


def initialize_schema(db: sqlite3.Connection) -> None:
    db.executescript("""
    CREATE TABLE IF NOT EXISTS director_authorities (
      work_id TEXT PRIMARY KEY REFERENCES works(id), schema_version INTEGER NOT NULL,
      activated_at REAL NOT NULL, migration_hash TEXT);
    CREATE TABLE IF NOT EXISTS director_document_ids (
      id TEXT PRIMARY KEY, work_id TEXT NOT NULL REFERENCES works(id), doc_key TEXT NOT NULL,
      kind TEXT NOT NULL, UNIQUE(work_id, doc_key));
    CREATE TABLE IF NOT EXISTS director_episodes (
      id TEXT PRIMARY KEY, work_id TEXT NOT NULL REFERENCES works(id),
      document_id TEXT NOT NULL UNIQUE REFERENCES director_document_ids(id),
      order_key INTEGER NOT NULL, source_label TEXT, delivery_label TEXT NOT NULL,
      archived INTEGER NOT NULL DEFAULT 0, UNIQUE(work_id, order_key));
    CREATE TABLE IF NOT EXISTS director_document_asts (
      document_id TEXT NOT NULL REFERENCES director_document_ids(id), version INTEGER NOT NULL,
      ast_json TEXT NOT NULL, content_hash TEXT NOT NULL, semantic_hash TEXT NOT NULL,
      status TEXT NOT NULL, origin TEXT NOT NULL, created_at REAL NOT NULL,
      PRIMARY KEY(document_id,version));
    CREATE TABLE IF NOT EXISTS director_artifacts (
      id TEXT PRIMARY KEY, work_id TEXT NOT NULL REFERENCES works(id), kind TEXT NOT NULL,
      version INTEGER NOT NULL, input_refs_json TEXT NOT NULL, spec_revision INTEGER NOT NULL,
      body_json TEXT NOT NULL, body_hash TEXT NOT NULL, method_hash TEXT NOT NULL,
      status TEXT NOT NULL, created_at REAL NOT NULL);
    CREATE TABLE IF NOT EXISTS director_user_drafts (
      work_id TEXT NOT NULL REFERENCES works(id), document_id TEXT NOT NULL,
      actor TEXT NOT NULL, client_draft_id TEXT NOT NULL, revision INTEGER NOT NULL,
      base_version INTEGER NOT NULL, text TEXT NOT NULL, updated_at REAL NOT NULL,
      PRIMARY KEY(work_id,document_id,actor,client_draft_id));
    CREATE TABLE IF NOT EXISTS director_document_commands (
      work_id TEXT NOT NULL, actor TEXT NOT NULL, command_id TEXT NOT NULL,
      client_request_id TEXT NOT NULL, request_hash TEXT NOT NULL, response_json TEXT NOT NULL,
      PRIMARY KEY(work_id,actor,command_id), UNIQUE(work_id,actor,client_request_id));
    CREATE TABLE IF NOT EXISTS director_migration_backups (
      work_id TEXT PRIMARY KEY REFERENCES works(id), source_hash TEXT NOT NULL,
      preview_hash TEXT NOT NULL, backup_json TEXT NOT NULL, mapping_json TEXT NOT NULL,
      created_at REAL NOT NULL);
    CREATE TABLE IF NOT EXISTS director_invalidated_confirmations (
      work_id TEXT NOT NULL, ordinal INTEGER NOT NULL, version INTEGER NOT NULL,
      invalidated_at REAL NOT NULL, reason_document_id TEXT NOT NULL,
      PRIMARY KEY(work_id,ordinal,version));
    """)


def is_canonical(db: sqlite3.Connection, work_id: str) -> bool:
    return (
        db.execute(
            "SELECT 1 FROM director_authorities WHERE work_id=?", (work_id,)
        ).fetchone()
        is not None
    )


def allocate_documents(db: sqlite3.Connection, work: sqlite3.Row) -> list[dict]:
    preset = json.loads(work["preset_json"])
    keys = [
        (key, key) for key in ("outline", "characters", "relations", "scenes", "props")
    ]
    keys += [
        (f"episode-{n:03d}", "episode") for n in range(1, preset["episode_count"] + 1)
    ]
    db.execute(
        "UPDATE director_episodes SET archived=1 WHERE work_id=? AND order_key>?",
        (work["id"], preset["episode_count"]),
    )
    result = []
    for key, kind in keys:
        document_id = stable_id(work["id"], "document:" + key)
        db.execute(
            "INSERT OR IGNORE INTO director_document_ids VALUES (?,?,?,?)",
            (document_id, work["id"], key, "locations" if kind == "scenes" else kind),
        )
        item = {"docKey": key, "documentId": document_id, "kind": kind}
        if kind == "episode":
            ordinal = int(key[8:])
            episode_id = stable_id(work["id"], "episode:" + key)
            source_label = work["source_episode_label"] or None
            # A source label cannot be extrapolated into facts for later episodes.
            if preset["episode_count"] != 1:
                source_label = None
            delivery = (
                work["delivery_episode_label"]
                if preset["episode_count"] == 1
                else f"EP{ordinal:02d}"
            )
            db.execute(
                "INSERT OR IGNORE INTO director_episodes VALUES (?,?,?,?,?,?,0)",
                (
                    episode_id,
                    work["id"],
                    document_id,
                    ordinal,
                    source_label,
                    delivery or f"EP{ordinal:02d}",
                ),
            )
            db.execute(
                "UPDATE director_episodes SET source_label=?,delivery_label=?,archived=0 WHERE id=?",
                (source_label, delivery or f"EP{ordinal:02d}", episode_id),
            )
            item["episodeId"] = episode_id
        result.append(item)
    return result


def activate_new_work(db: sqlite3.Connection, work: sqlite3.Row) -> None:
    allocate_documents(db, work)
    db.execute(
        "INSERT INTO director_authorities VALUES (?,2,?,NULL)",
        (work["id"], time.time()),
    )


def ast_version(
    db: sqlite3.Connection, work_id: str, key: str, version: int
) -> dict | None:
    row = db.execute(
        """SELECT a.*,i.id,i.doc_key,i.kind FROM director_document_asts a
      JOIN director_document_ids i ON i.id=a.document_id
      WHERE i.work_id=? AND i.doc_key=? AND a.version=?""",
        (work_id, key, version),
    ).fetchone()
    if row is None:
        return None
    ast = DocumentAST.model_validate_json(row["ast_json"])
    rendered = render_markdown(ast)
    if row["content_hash"] != object_hash(ast.model_dump(by_alias=True)) or row[
        "semantic_hash"
    ] != semantic_hash(ast):
        raise ExecutionFault("DOCUMENT_CORRUPT")
    return {
        "documentId": row["id"],
        "docKey": key,
        "kind": row["kind"],
        "version": version,
        "ast": ast.model_dump(by_alias=True),
        "contentHash": row["content_hash"],
        "semanticInputHash": row["semantic_hash"],
        "status": row["status"],
        "content": rendered,
        "createdAt": row["created_at"],
        "unsupportedBlockIds": [
            b.id for b in walk_blocks(ast) if b.attrs.parse_status != "valid"
        ],
    }


def write_ast(
    db: sqlite3.Connection,
    work_id: str,
    key: str,
    version: int,
    content: str,
    origin: str,
    *,
    legacy: bool = False,
) -> str:
    previous = ast_version(db, work_id, key, version - 1) if version > 1 else None
    ast = parse_markdown(
        content, DocumentAST.from_wire(previous["ast"]) if previous else None
    )
    return write_verified_ast(db, work_id, key, version, ast, origin, legacy=legacy)


def write_verified_ast(
    db: sqlite3.Connection, work_id: str, key: str, version: int,
    ast: DocumentAST, origin: str, *, legacy: bool = False,
) -> str:
    """Preserve reviewed block identities while sharing the sole version write path."""
    # Revalidate the wire payload, including duplicate IDs and AST bounds.
    ast = DocumentAST.from_wire(ast.model_dump(by_alias=True))
    identity = db.execute(
        "SELECT id FROM director_document_ids WHERE work_id=? AND doc_key=?",
        (work_id, key),
    ).fetchone()
    if identity is None:
        raise ExecutionFault("DOCUMENT_SCOPE_MISMATCH", status=422)
    rendered = render_markdown(ast)
    status = "legacy_unverified" if legacy else "draft"
    db.execute(
        "INSERT INTO director_document_asts VALUES (?,?,?,?,?,?,?,?)",
        (
            identity["id"],
            version,
            canonical(ast.model_dump(by_alias=True)),
            object_hash(ast.model_dump(by_alias=True)),
            semantic_hash(ast),
            status,
            origin,
            time.time(),
        ),
    )
    if not legacy:
        invalidate(db, work_id, identity["id"])
    return rendered


def invalidate(db: sqlite3.Connection, work_id: str, document_id: str) -> list[str]:
    # Traverse transitive dependencies. Never regenerate or charge as a side
    # effect of editing; stale receipts remain available for forensic review.
    invalid = {document_id}
    rows = db.execute(
        "SELECT id,input_refs_json FROM director_artifacts WHERE work_id=? AND status!='stale'",
        (work_id,),
    ).fetchall()
    changed = True
    stale: list[str] = []
    while changed:
        changed = False
        for row in rows:
            if row["id"] in invalid:
                continue
            if any(ref["id"] in invalid for ref in json.loads(row["input_refs_json"])):
                invalid.add(row["id"])
                stale.append(row["id"])
                changed = True
    for identifier in stale:
        db.execute(
            "UPDATE director_artifacts SET status='stale' WHERE id=?", (identifier,)
        )
    # Finalizations in legacy storage remain auditable but no longer count.
    source_episode = db.execute(
        "SELECT order_key FROM director_episodes WHERE document_id=?", (document_id,)
    ).fetchone()
    db.execute(
        """INSERT OR IGNORE INTO director_invalidated_confirmations
      SELECT work_id,ordinal,version,?,? FROM episode_confirmations WHERE work_id=? AND ordinal>=?""",
        (time.time(), document_id, work_id, source_episode[0] if source_episode else 1),
    )
    db.execute(
        """INSERT OR IGNORE INTO director_finalization_invalidations
      SELECT f.id,?,? FROM director_finalizations_v2 f JOIN director_episodes e ON e.id=f.episode_id
      WHERE f.work_id=? AND e.order_key>=?""",
        (document_id, time.time(), work_id, source_episode[0] if source_episode else 1),
    )
    return stale


class DocumentRepository:
    def __init__(self, store: DirectorStore):
        self.store = store

    def projection(self, work_id: str) -> dict:
        with self.store._connect() as db:
            work = self.store._work(db, work_id)
            enabled = is_canonical(db, work_id)
            docs = []
            if enabled:
                for row in db.execute(
                    "SELECT * FROM director_document_ids WHERE work_id=? ORDER BY doc_key",
                    (work_id,),
                ):
                    current = self.store._version(db, work_id, row["doc_key"])
                    version = (
                        ast_version(db, work_id, row["doc_key"], current)
                        if current
                        else None
                    )
                    if current and version is None:
                        raise ExecutionFault("DOCUMENT_CORRUPT")
                    docs.append(
                        version
                        or {
                            "documentId": row["id"],
                            "docKey": row["doc_key"],
                            "kind": row["kind"],
                            "version": 0,
                            "content": "",
                            "status": "empty",
                            "unsupportedBlockIds": [],
                        }
                    )
            artifacts = [
                {
                    "id": r["id"],
                    "kind": r["kind"],
                    "version": r["version"],
                    "status": r["status"],
                    "inputRefs": json.loads(r["input_refs_json"]),
                    "bodyHash": r["body_hash"],
                }
                for r in db.execute(
                    "SELECT * FROM director_artifacts WHERE work_id=? ORDER BY created_at",
                    (work_id,),
                )
            ]
            episodes = [
                {
                    "id": r["id"],
                    "documentId": r["document_id"],
                    "orderKey": r["order_key"],
                    "sourceEpisodeLabel": r["source_label"],
                    "deliveryLabel": r["delivery_label"],
                    "archived": bool(r["archived"]),
                }
                for r in db.execute(
                    "SELECT * FROM director_episodes WHERE work_id=? ORDER BY order_key",
                    (work_id,),
                )
            ]
            return {
                "schemaVersion": 2 if enabled else 1,
                "workRevision": work["revision"],
                "documents": docs,
                "episodes": episodes,
                "artifacts": artifacts,
            }

    def execute(self, actor: str, command: DocumentCommand) -> dict:
        if not actor:
            raise ExecutionFault("FORBIDDEN", status=403)
        request_hash = object_hash(command.model_dump(by_alias=True))
        with self.store._write() as db:
            work = self.store._work(db, command.work_id)
            prior = db.execute(
                """SELECT * FROM director_document_commands WHERE work_id=? AND actor=?
              AND (command_id=? OR client_request_id=?)""",
                (command.work_id, actor, command.command_id, command.client_request_id),
            ).fetchall()
            if prior:
                if len(prior) != 1 or prior[0]["request_hash"] != request_hash:
                    raise ExecutionFault("IDEMPOTENCY_CONFLICT")
                return json.loads(prior[0]["response_json"])
            payload = command.payload
            if payload.type == "import.commitLegacy":
                from .migrations.v2 import commit_legacy

                result = commit_legacy(
                    self.store,
                    db,
                    command.work_id,
                    command.expected.work_revision,
                    payload.preview_hash,
                )
            else:
                if not is_canonical(db, command.work_id):
                    raise ExecutionFault("LEGACY_IMPORT_REQUIRED")
                identity = db.execute(
                    "SELECT * FROM director_document_ids WHERE id=? AND work_id=?",
                    (payload.document_id, command.work_id),
                ).fetchone()
                if identity is None:
                    raise ExecutionFault("RESOURCE_GONE", status=404)
                current = self.store._version(db, command.work_id, identity["doc_key"])
                if command.expected.document_versions != {payload.document_id: current}:
                    raise ExecutionFault("VERSION_CONFLICT")
                if payload.type == "document.saveDraft":
                    result = self._save_draft(db, actor, command, current)
                elif payload.type == "outline.decideGroups":
                    from .outline_changes import decide_groups

                    if identity["doc_key"] != "outline" or command.expected.work_revision != work["revision"]:
                        raise ExecutionFault("VERSION_CONFLICT")
                    result = decide_groups(db, self.store, command.work_id, payload, current)
                else:
                    if command.expected.work_revision != work["revision"]:
                        raise ExecutionFault("VERSION_CONFLICT")
                    self.store._ensure_writable(db, work, identity["doc_key"])
                    self.store._put_document(
                        db,
                        command.work_id,
                        identity["doc_key"],
                        payload.text,
                        current,
                        "user",
                    )
                    result = ast_version(
                        db, command.work_id, identity["doc_key"], current + 1
                    )
            envelope = {
                "schemaVersion": 2,
                "commandId": command.command_id,
                # Autosave must advance from this transaction, not a later GET
                # which could have already observed another editor's version.
                "workRevision": self.store._work(db, command.work_id)["revision"],
                "result": result,
            }
            db.execute(
                "INSERT INTO director_document_commands VALUES (?,?,?,?,?,?)",
                (
                    command.work_id,
                    actor,
                    command.command_id,
                    command.client_request_id,
                    request_hash,
                    canonical(envelope),
                ),
            )
            return envelope

    def _save_draft(
        self, db: sqlite3.Connection, actor: str, command: DocumentCommand, current: int
    ) -> dict:
        value = command.payload
        if value.base_version != current:
            raise ExecutionFault("VERSION_CONFLICT")
        key = (command.work_id, value.document_id, actor, value.client_draft_id)
        previous = db.execute(
            "SELECT revision FROM director_user_drafts WHERE work_id=? AND document_id=? AND actor=? AND client_draft_id=?",
            key,
        ).fetchone()
        revision = previous[0] if previous else 0
        if revision != value.draft_revision:
            raise ExecutionFault("DRAFT_CONFLICT")
        db.execute(
            """INSERT INTO director_user_drafts VALUES (?,?,?,?,?,?,?,?)
          ON CONFLICT(work_id,document_id,actor,client_draft_id) DO UPDATE SET
          revision=excluded.revision,base_version=excluded.base_version,text=excluded.text,updated_at=excluded.updated_at""",
            (*key, revision + 1, current, value.text, time.time()),
        )
        return {
            "documentId": value.document_id,
            "clientDraftId": value.client_draft_id,
            "revision": revision + 1,
            "baseVersion": current,
            "text": value.text,
        }

    def drafts(self, work_id: str, actor: str) -> list[dict]:
        with self.store._connect() as db:
            self.store._work(db, work_id)
            return [
                {
                    "documentId": r["document_id"],
                    "clientDraftId": r["client_draft_id"],
                    "revision": r["revision"],
                    "baseVersion": r["base_version"],
                    "text": r["text"],
                }
                for r in db.execute(
                    "SELECT * FROM director_user_drafts WHERE work_id=? AND actor=?",
                    (work_id, actor),
                )
            ]

    def put_artifact(
        self,
        work_id: str,
        kind: str,
        refs: list[VersionReference],
        body: dict,
        method_hash: str,
        *,
        expected_revision: int,
    ) -> dict:
        """Internal stage receipt, not a public endpoint accepting model 'PASS'."""
        with self.store._write() as db:
            work = self.store._work(db, work_id)
            if work["revision"] != expected_revision or not is_canonical(db, work_id):
                raise ExecutionFault("VERSION_CONFLICT")
            if not refs or len({r.id for r in refs}) != len(refs):
                raise ExecutionFault("ARTIFACT_INPUTS_REQUIRED", status=422)
            for ref in refs:
                if ref.kind == "document":
                    row = db.execute(
                        """SELECT a.content_hash,a.version,d.current_version FROM director_document_ids i
                      JOIN director_document_asts a ON a.document_id=i.id
                      JOIN documents d ON d.work_id=i.work_id AND d.doc_key=i.doc_key
                      WHERE i.work_id=? AND i.id=? AND a.version=?""",
                        (work_id, ref.id, ref.version),
                    ).fetchone()
                    valid = (
                        row
                        and row["content_hash"] == ref.hash
                        and row["current_version"] == ref.version
                    )
                elif ref.kind == "artifact":
                    row = db.execute(
                        "SELECT * FROM director_artifacts WHERE work_id=? AND id=? AND version=?",
                        (work_id, ref.id, ref.version),
                    ).fetchone()
                    valid = (
                        row
                        and row["status"] == "valid"
                        and row["body_hash"] == ref.hash
                    )
                else:
                    valid = False
                if not valid:
                    raise ExecutionFault("STALE_ARTIFACT_INPUT")
            identifier = uuid.uuid4().hex
            hashed = object_hash(body)
            db.execute(
                "INSERT INTO director_artifacts VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                (
                    identifier,
                    work_id,
                    kind,
                    1,
                    canonical([r.model_dump(by_alias=True) for r in refs]),
                    expected_revision,
                    canonical(body),
                    hashed,
                    method_hash,
                    "valid",
                    time.time(),
                ),
            )
            self.store._event(
                db,
                work_id,
                "artifact.created",
                {"id": identifier, "kind": kind, "hash": hashed},
            )
            return {"id": identifier, "version": 1, "hash": hashed, "status": "valid"}
