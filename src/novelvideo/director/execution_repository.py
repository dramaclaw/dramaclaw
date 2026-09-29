"""Additive execution ledger beside legacy documents, with one transaction owner.

The network is deliberately outside these transactions. Once claimed, an outbox
item is never automatically claimed again: a lost response is not proof that a
billable model call failed. Output, proposal and receipt commit together.
"""

from __future__ import annotations

import hashlib
import json
import sqlite3
import time
import uuid
from contextlib import contextmanager
from typing import Any, Callable, Iterator

from .schemas.execution import ExecutionCommand, ExecutionFault
from .output_validation import parse_model_json, validation_receipt
from .store import DirectorStore


def canonical(value: Any) -> str:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    )


def digest(value: Any) -> str:
    return hashlib.sha256(canonical(value).encode("utf-8")).hexdigest()


def identifier() -> str:
    return uuid.uuid4().hex


class ExecutionRepository:
    def __init__(self, store: DirectorStore, *, clock: Callable[[], float] = time.time):
        self.store = store
        self.clock = clock
        with store._connect() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS director_execution_commands (
                    actor TEXT NOT NULL, work_id TEXT NOT NULL, command_id TEXT NOT NULL,
                    client_request_id TEXT NOT NULL, request_hash TEXT NOT NULL,
                    result_json TEXT NOT NULL,
                    PRIMARY KEY(actor, work_id, command_id),
                    UNIQUE(actor, work_id, client_request_id)
                );
                CREATE TABLE IF NOT EXISTS director_quotes (
                    id TEXT PRIMARY KEY, work_id TEXT NOT NULL REFERENCES works(id),
                    actor TEXT NOT NULL, session_id TEXT NOT NULL,
                    request_hash TEXT NOT NULL, snapshot_json TEXT NOT NULL,
                    created_at REAL NOT NULL, expires_at REAL NOT NULL,
                    status TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS director_approvals (
                    id TEXT PRIMARY KEY, quote_id TEXT NOT NULL UNIQUE REFERENCES director_quotes(id),
                    actor TEXT NOT NULL, request_hash TEXT NOT NULL,
                    limits_json TEXT NOT NULL, created_at REAL NOT NULL, expires_at REAL NOT NULL
                );
                CREATE TABLE IF NOT EXISTS director_operations (
                    id TEXT PRIMARY KEY, work_id TEXT NOT NULL REFERENCES works(id),
                    approval_id TEXT NOT NULL UNIQUE REFERENCES director_approvals(id),
                    session_id TEXT NOT NULL, request_hash TEXT NOT NULL,
                    status TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
                    lease_token TEXT, lease_expires_at REAL, error_code TEXT,
                    output_text TEXT, response_json TEXT NOT NULL DEFAULT '{}',
                    change_id TEXT, created_at REAL NOT NULL, updated_at REAL NOT NULL
                );
                CREATE UNIQUE INDEX IF NOT EXISTS director_one_active_operation
                ON director_operations(work_id)
                WHERE status IN ('queued','dispatching','cancel_requested','unknown');
                CREATE TABLE IF NOT EXISTS director_cost_entries (
                    operation_id TEXT PRIMARY KEY REFERENCES director_operations(id),
                    estimate_minor INTEGER, reserved_minor INTEGER, actual_minor INTEGER,
                    currency TEXT, max_output_tokens INTEGER NOT NULL,
                    actual_output_tokens INTEGER, status TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS director_outbox (
                    operation_id TEXT PRIMARY KEY REFERENCES director_operations(id),
                    dispatch_key TEXT NOT NULL UNIQUE, status TEXT NOT NULL,
                    created_at REAL NOT NULL
                );
                CREATE TABLE IF NOT EXISTS director_execution_events (
                    work_id TEXT NOT NULL REFERENCES works(id), seq INTEGER NOT NULL,
                    event_id TEXT NOT NULL UNIQUE, session_id TEXT NOT NULL,
                    operation_id TEXT, type TEXT NOT NULL, payload_json TEXT NOT NULL,
                    created_at REAL NOT NULL, PRIMARY KEY(work_id,seq)
                );
            """)
            from .workflow import initialize_workflow

            initialize_workflow(db)

    @contextmanager
    def transaction(self) -> Iterator[sqlite3.Connection]:
        with self.store._write() as db:
            yield db

    def event(
        self,
        db: sqlite3.Connection,
        work_id: str,
        session_id: str,
        event_type: str,
        payload: dict,
        operation_id: str | None = None,
    ) -> int:
        seq = db.execute(
            "SELECT COALESCE(MAX(seq),0)+1 FROM director_execution_events WHERE work_id=?",
            (work_id,),
        ).fetchone()[0]
        db.execute(
            "INSERT INTO director_execution_events VALUES (?,?,?,?,?,?,?,?)",
            (
                work_id,
                seq,
                identifier(),
                session_id,
                operation_id,
                event_type,
                canonical(payload),
                self.clock(),
            ),
        )
        return seq

    def replay(
        self, db: sqlite3.Connection, actor: str, command: ExecutionCommand
    ) -> dict | None:
        value = command.model_dump(mode="json", by_alias=True)
        found = db.execute(
            """SELECT * FROM director_execution_commands WHERE actor=? AND work_id=?
                           AND (command_id=? OR client_request_id=?)""",
            (actor, command.work_id, command.command_id, command.client_request_id),
        ).fetchall()
        if not found:
            return None
        if len(found) != 1 or found[0]["request_hash"] != digest(value):
            raise ExecutionFault("IDEMPOTENCY_CONFLICT")
        return json.loads(found[0]["result_json"])

    def remember(
        self,
        db: sqlite3.Connection,
        actor: str,
        command: ExecutionCommand,
        result: dict,
    ) -> dict:
        db.execute(
            "INSERT INTO director_execution_commands VALUES (?,?,?,?,?,?)",
            (
                actor,
                command.work_id,
                command.command_id,
                command.client_request_id,
                digest(command.model_dump(mode="json", by_alias=True)),
                canonical(result),
            ),
        )
        return result

    @staticmethod
    def operation(db: sqlite3.Connection, work_id: str, run_id: str) -> sqlite3.Row:
        row = db.execute(
            "SELECT * FROM director_operations WHERE work_id=? AND id=?",
            (work_id, run_id),
        ).fetchone()
        if row is None:
            raise ExecutionFault("RESOURCE_GONE", status=404)
        return row

    @staticmethod
    def snapshot(db: sqlite3.Connection, run_id: str) -> dict:
        row = db.execute(
            """SELECT q.snapshot_json FROM director_operations o
                         JOIN director_approvals a ON a.id=o.approval_id
                         JOIN director_quotes q ON q.id=a.quote_id WHERE o.id=?""",
            (run_id,),
        ).fetchone()
        if row is None:
            raise ExecutionFault("RESOURCE_GONE", status=404)
        return json.loads(row[0])

    def projection(self, db: sqlite3.Connection, work_id: str, run_id: str) -> dict:
        row = self.operation(db, work_id, run_id)
        cost = db.execute(
            "SELECT * FROM director_cost_entries WHERE operation_id=?", (run_id,)
        ).fetchone()
        snapshot = self.snapshot(db, run_id)
        return {
            "id": row["id"],
            "workId": work_id,
            "sessionId": row["session_id"],
            "revision": row["revision"],
            "status": row["status"],
            "requestHash": row["request_hash"],
            "docKey": snapshot["docKey"],
            "parameters": snapshot["parameters"],
            "purpose": snapshot.get("purpose", "draft"),
            "limits": snapshot["limits"],
            "errorCode": row["error_code"],
            "changeId": row["change_id"],
            "createdAt": row["created_at"],
            "updatedAt": row["updated_at"],
            "response": json.loads(row["response_json"]),
            "cost": {
                "status": cost["status"],
                "estimateMinor": cost["estimate_minor"],
                "reservedMinor": cost["reserved_minor"],
                "actualMinor": cost["actual_minor"],
                "currency": cost["currency"],
                "maxOutputTokens": cost["max_output_tokens"],
                "actualOutputTokens": cost["actual_output_tokens"],
            },
            "canResume": row["status"] == "queued",
            "canCancel": row["status"] in {"queued", "dispatching"},
            "requiresReconciliation": row["status"] == "unknown"
            or (
                row["status"] in {"dispatching", "cancel_requested"}
                and row["lease_expires_at"] is not None
                and row["lease_expires_at"] <= self.clock()
            ),
        }

    def retained_result(self, work_id: str, run_id: str) -> dict:
        with self.store._connect() as db:
            self.store._work(db, work_id)
            row = self.operation(db, work_id, run_id)
            return {
                "runId": run_id,
                "status": row["status"],
                "output": row["output_text"],
                "outputHash": json.loads(row["response_json"]).get("output_sha256"),
                "factAudit": json.loads(row["response_json"]).get("factAudit"),
                "readOnly": True,
            }

    def list_operations(self, work_id: str) -> list[dict]:
        with self.store._connect() as db:
            self.store._work(db, work_id)
            rows = db.execute(
                "SELECT id FROM director_operations WHERE work_id=? ORDER BY created_at DESC LIMIT 200",
                (work_id,),
            )
            return [self.projection(db, work_id, row[0]) for row in rows.fetchall()]

    def events(self, work_id: str, after: int = 0) -> dict:
        with self.store._connect() as db:
            self.store._work(db, work_id)
            rows = db.execute(
                "SELECT * FROM director_execution_events WHERE work_id=? AND seq>? ORDER BY seq LIMIT 200",
                (work_id, after),
            ).fetchall()
            return {
                "schemaVersion": 2,
                "events": [
                    {
                        "seq": r["seq"],
                        "eventId": r["event_id"],
                        "type": r["type"],
                        "sessionId": r["session_id"],
                        "runId": r["operation_id"],
                        "payload": json.loads(r["payload_json"]),
                        "createdAt": r["created_at"],
                    }
                    for r in rows
                ],
                "nextSeq": rows[-1]["seq"] if rows else after,
            }

    def progress(self, work_id: str, run_id: str, token: str, event_type: str, payload: dict) -> int:
        """Append previews only; a delta never mutates a document or approves a draft."""
        if event_type not in {"method.loaded", "model.started", "text.delta", "outline.section.preview"}:
            raise ValueError("INVALID_PROGRESS_EVENT")
        with self.transaction() as db:
            row = self.operation(db, work_id, run_id)
            if row["lease_token"] != token:
                raise ExecutionFault("INVALID_DISPATCH_LEASE")
            if row["status"] not in {"dispatching", "cancel_requested"}:
                return 0
            return self.event(db, work_id, row["session_id"], event_type, payload, run_id)

    def retain_prefix(self, work_id: str, run_id: str, token: str, prefix: str) -> None:
        """A transport failure must not erase paid structured response bytes."""
        if len(prefix) > 1024 * 1024:
            raise ValueError("STREAM_OUTPUT_LIMIT")
        with self.transaction() as db:
            row = self.operation(db, work_id, run_id)
            if row["lease_token"] != token:
                raise ExecutionFault("INVALID_DISPATCH_LEASE")
            if row["status"] in {"dispatching", "cancel_requested"}:
                db.execute("UPDATE director_operations SET output_text=? WHERE id=?", (prefix, run_id))

    def claim(self, work_id: str, run_id: str) -> tuple[str, dict] | None:
        with self.transaction() as db:
            row = self.operation(db, work_id, run_id)
            if row["status"] != "queued":
                return None
            approval = db.execute(
                "SELECT * FROM director_approvals WHERE id=?", (row["approval_id"],)
            ).fetchone()
            if approval["expires_at"] <= self.clock():
                self._finish_unsent(db, row, "APPROVAL_EXPIRED")
                return None
            snapshot = self.snapshot(db, run_id)
            token = identifier()
            db.execute(
                "UPDATE director_operations SET status='dispatching',lease_token=?,lease_expires_at=?,revision=revision+1,updated_at=? WHERE id=?",
                (token, self.clock() + 600, self.clock(), run_id),
            )
            db.execute(
                "UPDATE director_outbox SET status='claimed' WHERE operation_id=?",
                (run_id,),
            )
            db.execute(
                "UPDATE director_cost_entries SET status='submitted' WHERE operation_id=?",
                (run_id,),
            )
            db.execute("UPDATE runs SET status='running' WHERE id=?", (run_id,))
            self.event(db, work_id, row["session_id"], "run.started", {}, run_id)
            return token, snapshot

    def _finish_unsent(
        self, db: sqlite3.Connection, row: sqlite3.Row, code: str
    ) -> None:
        run_id = row["id"]
        db.execute(
            "UPDATE director_operations SET status='cancelled',error_code=?,revision=revision+1,updated_at=? WHERE id=?",
            (code, self.clock(), run_id),
        )
        db.execute(
            "UPDATE director_outbox SET status='cancelled' WHERE operation_id=?",
            (run_id,),
        )
        db.execute(
            "UPDATE director_cost_entries SET status='released',actual_minor=0,reserved_minor=0 WHERE operation_id=?",
            (run_id,),
        )
        db.execute(
            "UPDATE runs SET status='failed',error=?,finished_at=? WHERE id=?",
            (code, self.clock(), run_id),
        )
        self.event(
            db,
            row["work_id"],
            row["session_id"],
            "run.cancelled",
            {"reason": code, "externalCalls": 0},
            run_id,
        )

    def stop_or_recover(
        self, db: sqlite3.Connection, work_id: str, run_id: str, cancel: bool
    ) -> dict:
        row = self.operation(db, work_id, run_id)
        if row["status"] == "queued":
            if cancel:
                self._finish_unsent(db, row, "CANCELLED_BEFORE_SEND")
        elif row["status"] in {"dispatching", "cancel_requested"}:
            expired = row["lease_expires_at"] <= self.clock()
            if not cancel and not expired:
                raise ExecutionFault("ALREADY_DISPATCHED", recovery="wait")
            status = "unknown" if expired else "cancel_requested"
            db.execute(
                "UPDATE director_operations SET status=?,revision=revision+1,updated_at=? WHERE id=?",
                (status, self.clock(), run_id),
            )
            if expired:
                db.execute(
                    "UPDATE director_cost_entries SET status='unknown' WHERE operation_id=?",
                    (run_id,),
                )
            self.event(db, work_id, row["session_id"], f"run.{status}", {}, run_id)
        elif row["status"] == "unknown":
            raise ExecutionFault("STATUS_UNKNOWN", recovery="manual_reconciliation")
        return self.projection(db, work_id, run_id)

    def complete(
        self,
        work_id: str,
        run_id: str,
        token: str,
        *,
        output: str | None = None,
        usage: dict | None = None,
        error_code: str | None = None,
        sent: bool = True,
    ) -> dict:
        with self.transaction() as db:
            row = self.operation(db, work_id, run_id)
            if row["lease_token"] != token:
                raise ExecutionFault("INVALID_DISPATCH_LEASE")
            if row["status"] not in {"dispatching", "cancel_requested", "unknown"}:
                return self.projection(db, work_id, run_id)
            snapshot = self.snapshot(db, run_id)
            change_id = None
            response = {}
            if output is None and error_code and row["output_text"]:
                output = row["output_text"]
                response["partial"] = True
            if usage is not None:
                response["usage"] = usage
            if output is not None:
                response.update(
                    {
                        "output_sha256": hashlib.sha256(
                            output.encode("utf-8")
                        ).hexdigest(),
                        "output_chars": len(output),
                    }
                )
            if not sent:
                status, cost_status = "failed", "released"
            elif error_code:
                status, cost_status = "unknown", "unknown"
            elif row["status"] == "cancel_requested":
                status, cost_status = "cancelled", "settlement_pending"
            elif row["status"] == "unknown":
                # A late response resolves transport ambiguity, not the user's
                # authorization to adopt into a possibly changed document.
                status, cost_status, error_code = (
                    "stale",
                    "settlement_pending",
                    "RESULT_STALE",
                )
            elif (
                (
                    usage
                    and usage.get("finishReason")
                    in {"length", "content_filter", "error"}
                )
                and snapshot.get("purpose") != "review"
                or output is None
                or (not output.strip() and snapshot.get("purpose") != "review")
                or len(output) > 1024 * 1024
            ):
                status, cost_status, error_code = (
                    "failed",
                    "settlement_pending",
                    {"length": "MODEL_OUTPUT_TRUNCATED", "content_filter": "MODEL_OUTPUT_FILTERED"}.get(
                        (usage or {}).get("finishReason"), "INVALID_MODEL_OUTPUT"
                    ),
                )
            else:
                work = self.store._work(db, work_id)
                stale = (
                    work["revision"] != snapshot["workRevision"]
                    or self.store._version(db, work_id, snapshot["docKey"])
                    != snapshot["baseVersion"]
                )
                pending = db.execute(
                    "SELECT 1 FROM changes WHERE work_id=? AND status='pending' AND id!=? LIMIT 1",
                    (work_id, snapshot.get("outlineReviewTarget", {}).get("changeId", "")),
                ).fetchone()
                if stale or pending or work["status"] == "completed":
                    status, cost_status, error_code = (
                        "stale",
                        "settlement_pending",
                        "RESULT_STALE",
                    )
                else:
                    self.store._ensure_writable(db, work, snapshot["docKey"],
                        accepted_change_id=snapshot.get("outlineReviewTarget", {}).get("changeId"))
                    if snapshot.get("purpose") == "planning":
                        from .workflow import record_planning_output

                        try:
                            response["planning"] = record_planning_output(
                                db, work_id, run_id, snapshot, output
                            )
                            status, error_code = "succeeded", None
                        except (ValueError, KeyError, TypeError) as exc:
                            status, error_code = "failed", "PLANNING_OUTPUT_INVALID"
                            response["validation"] = validation_receipt(exc)
                        cost_status = "settlement_pending"
                    elif snapshot.get("outlineReviewTarget"):
                        from .outline_changes import record_review

                        try:
                            response["outlineCandidateReview"] = record_review(db, work_id, run_id,
                                snapshot["outlineReviewTarget"], parse_model_json(output))
                            status, error_code = "succeeded", None
                        except (ValueError, KeyError, TypeError, ExecutionFault) as exc:
                            status, error_code = "failed", "PLANNING_OUTPUT_INVALID"
                            response["validation"] = validation_receipt(exc)
                        cost_status = "settlement_pending"
                    elif snapshot["parameters"].get("output_contract") == "outline-patch/1.0.0":
                        from .outline_changes import record_patch

                        try:
                            change_id = record_patch(db, self.store, work_id, run_id, snapshot, parse_model_json(output))
                            response["change_id"] = change_id
                            status, error_code = "succeeded", None
                        except (ValueError, KeyError, TypeError) as exc:
                            status, error_code = "failed", "PLANNING_OUTPUT_INVALID"
                            response["validation"] = validation_receipt(exc)
                        cost_status = "settlement_pending"
                    elif snapshot.get("purpose") == "review":
                        from .quality import save_review

                        reviewed = save_review(
                            db, work_id, run_id, snapshot, output, usage
                        )
                        response["review"] = reviewed
                        status = (
                            "failed"
                            if reviewed["status"] == "UNAVAILABLE"
                            else "succeeded"
                        )
                        error_code = reviewed["errorCode"]
                        cost_status = "settlement_pending"
                        self.store._event(
                            db,
                            work_id,
                            "review.completed",
                            {"reportId": reviewed["id"], "status": reviewed["status"]},
                        )
                    else:
                        candidate = output
                        candidate_output = output
                        fact_audit = None
                        if snapshot["parameters"].get("factBoundary"):
                            from .fact_guard import inspect as inspect_facts

                            try:
                                candidate_output, fact_audit = inspect_facts(output, snapshot["parameters"]["factBoundary"])
                            except (ValueError, KeyError, TypeError, AttributeError):
                                fact_audit = {"passed": False, "issues": [{"code": "FACT_EVIDENCE_INVALID"}]}
                            response["factAudit"] = fact_audit
                        if snapshot["parameters"].get("output_contract") == "episode-screenplay/1.0.0":
                            from .episode_format import inspect_episode

                            response["episodeFormat"] = inspect_episode(output)
                        if (
                            snapshot["parameters"].get("output_contract")
                            == "story-outline/2.2.0"
                        ):
                            from .outline import parse_outline, render_outline

                            try:
                                root = snapshot["parameters"]["outlineRoot"]
                                artifact = parse_outline(output, root)
                                candidate = render_outline(artifact, root)
                                response["outline"] = {
                                    "contract": "story-outline/2.2.0",
                                    "artifactHash": digest(artifact),
                                }
                            except (ValueError, KeyError, TypeError) as exc:
                                response["validation"] = validation_receipt(exc)
                                candidate = None
                        elif (
                            snapshot["parameters"].get("output_contract")
                            == "character-biographies/2.2.0"
                        ):
                            from .characters import parse_characters, render_characters

                            try:
                                root = snapshot["parameters"]["characterRoot"]
                                artifact = parse_characters(candidate_output, root)
                                candidate = render_characters(artifact, root)
                                response["characters"] = {
                                    "contract": "character-biographies/2.2.0",
                                    "artifactHash": digest(artifact),
                                }
                            except (ValueError, KeyError, TypeError):
                                candidate = None
                        elif (
                            snapshot["parameters"].get("output_contract")
                            == "scene-design/1.0.0"
                        ):
                            from .scenes import parse_scenes, render_scenes

                            try:
                                root = snapshot["parameters"]["sceneRoot"]
                                artifact = parse_scenes(candidate_output, root)
                                candidate = render_scenes(artifact, root)
                                response["scenes"] = {
                                    "contract": "scene-design/1.0.0",
                                    "artifactHash": digest(artifact),
                                }
                            except (ValueError, KeyError, TypeError):
                                candidate = None
                        elif (
                            snapshot["parameters"].get("output_contract")
                            == "prop-design/1.0.0"
                        ):
                            from .props import parse_props, render_props

                            try:
                                root = snapshot["parameters"]["propRoot"]
                                artifact = parse_props(output, root)
                                candidate = render_props(artifact, root)
                                response["props"] = {
                                    "contract": "prop-design/1.0.0",
                                    "artifactHash": digest(artifact),
                                }
                            except (ValueError, KeyError, TypeError):
                                candidate = None
                        if fact_audit and not fact_audit["passed"]:
                            candidate = None
                        if candidate is None:
                            status, cost_status, error_code = (
                                "failed",
                                "settlement_pending",
                                "SOURCE_FACT_UNGROUNDED" if fact_audit and not fact_audit["passed"] else "PLANNING_OUTPUT_INVALID",
                            )
                        else:
                            change_id = self._propose_output(
                                db, work_id, snapshot, candidate
                            )
                            response["change_id"] = change_id
                            status, cost_status = "succeeded", "settlement_pending"
            db.execute(
                "UPDATE director_operations SET status=?,error_code=?,output_text=?,response_json=?,change_id=?,revision=revision+1,updated_at=? WHERE id=?",
                (
                    status,
                    error_code,
                    output,
                    canonical(response),
                    change_id,
                    self.clock(),
                    run_id,
                ),
            )
            db.execute(
                "UPDATE director_cost_entries SET status=?,actual_minor=?,reserved_minor=?,actual_output_tokens=? WHERE operation_id=?",
                (
                    cost_status,
                    0 if not sent else None,
                    0 if not sent else None,
                    usage.get("outputTokens") if usage else None,
                    run_id,
                ),
            )
            db.execute(
                "UPDATE director_outbox SET status='finished' WHERE operation_id=?",
                (run_id,),
            )
            db.execute(
                "UPDATE runs SET status=?,error=?,response_json=?,change_id=?,finished_at=? WHERE id=?",
                (
                    "completed" if status == "succeeded" else "failed",
                    error_code or status if status != "succeeded" else "",
                    canonical(response),
                    change_id,
                    self.clock(),
                    run_id,
                ),
            )
            self.event(
                db,
                work_id,
                row["session_id"],
                f"run.{status}",
                {
                    "errorCode": error_code,
                    "changeId": change_id,
                    "costState": cost_status,
                },
                run_id,
            )
            return self.projection(db, work_id, run_id)

    def _propose_output(
        self, db: sqlite3.Connection, work_id: str, snapshot: dict, content: str
    ) -> str:
        change_id = identifier()
        db.execute(
            "INSERT INTO changes VALUES (?,?,?,?,?,?,'pending',?,NULL)",
            (
                change_id,
                work_id,
                snapshot["docKey"],
                snapshot["baseVersion"],
                content,
                f"model proposal {snapshot['parameters']['method_version']}",
                self.clock(),
            ),
        )
        self.store._event(
            db,
            work_id,
            "change.proposed",
            {
                "change_id": change_id,
                "doc_key": snapshot["docKey"],
                "base_version": snapshot["baseVersion"],
            },
        )
        return change_id
