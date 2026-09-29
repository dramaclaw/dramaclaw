"""Durable preparation checkpoints with bounded, dependency-bound child calls.

A parent consent is not a reusable single-call approval. Each child gets its
own frozen request and ledger entry inside the budget transaction. A crash can
leave a queued child or a completed stage, never permission to resend a claim.
"""

from __future__ import annotations

import json
import sqlite3

from .execution_repository import ExecutionRepository, canonical, digest, identifier
from .planning import GROUPS, compile_planning, planning_documents, validate_planning
from .schemas.execution import ExecutionCommand, ExecutionFault
from .schemas.planning import (
    PlanningDecision,
    PlanningGrant,
    PlanningQuote,
    WorkflowCommand,
)
from .writing import resolve_director_model
from .documents import content_hash


def preparation_group(row: sqlite3.Row) -> str:
    from .outline_compiler import is_pipeline

    if is_pipeline(json.loads(row["root_json"])):
        return "adaptation_outline" if row["direction_json"] else "adaptation_direction"
    if not row["direction_json"]:
        return "direction"
    return json.loads(row["root_json"]).get("targetScope", "preparation")


def initialize_workflow(db: sqlite3.Connection) -> None:
    db.executescript("""
        CREATE TABLE IF NOT EXISTS director_workflows (
            work_id TEXT PRIMARY KEY REFERENCES works(id), actor TEXT NOT NULL,
            session_id TEXT NOT NULL, revision INTEGER NOT NULL, phase TEXT NOT NULL,
            root_json TEXT NOT NULL, direction_json TEXT, checkpoint_id TEXT,
            budget_id TEXT, error_code TEXT
        );
        CREATE TABLE IF NOT EXISTS director_planning_quotes (
            id TEXT PRIMARY KEY, work_id TEXT NOT NULL, actor TEXT NOT NULL,
            revision INTEGER NOT NULL, plan_hash TEXT NOT NULL, plan_json TEXT NOT NULL,
            expires_at REAL NOT NULL, status TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS director_planning_budgets (
            id TEXT PRIMARY KEY, quote_id TEXT NOT NULL UNIQUE, work_id TEXT NOT NULL,
            actor TEXT NOT NULL, plan_hash TEXT NOT NULL, plan_json TEXT NOT NULL,
            expires_at REAL NOT NULL, calls_reserved INTEGER NOT NULL DEFAULT 0,
            output_tokens_reserved INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS director_planning_children (
            operation_id TEXT PRIMARY KEY REFERENCES director_operations(id),
            work_id TEXT NOT NULL, budget_id TEXT NOT NULL, stage TEXT NOT NULL,
            UNIQUE(budget_id,stage)
        );
        CREATE TABLE IF NOT EXISTS director_planning_artifacts (
            work_id TEXT NOT NULL, stage TEXT NOT NULL, operation_id TEXT NOT NULL UNIQUE,
            artifact_hash TEXT NOT NULL, artifact_json TEXT NOT NULL,
            PRIMARY KEY(work_id,stage)
        );
        CREATE TABLE IF NOT EXISTS director_planning_checkpoints (
            id TEXT PRIMARY KEY, work_id TEXT NOT NULL, kind TEXT NOT NULL,
            status TEXT NOT NULL, resume_token TEXT NOT NULL, payload_hash TEXT NOT NULL,
            payload_json TEXT NOT NULL, decision_json TEXT, actor TEXT, created_at REAL NOT NULL
        );
    """)


def workflow_row(db: sqlite3.Connection, work_id: str) -> sqlite3.Row | None:
    return db.execute(
        "SELECT * FROM director_workflows WHERE work_id=?", (work_id,)
    ).fetchone()


def artifacts_for(db: sqlite3.Connection, work_id: str) -> dict:
    result = {}
    for row in db.execute(
        "SELECT * FROM director_planning_artifacts WHERE work_id=?", (work_id,)
    ):
        value = json.loads(row["artifact_json"])
        if digest(value) != row["artifact_hash"]:
            raise ExecutionFault("SNAPSHOT_CORRUPT")
        result[row["stage"]] = value
    return result


def record_planning_output(
    db: sqlite3.Connection, work_id: str, run_id: str, snapshot: dict, raw: str
) -> dict:
    child = db.execute(
        "SELECT * FROM director_planning_children WHERE operation_id=? AND work_id=?",
        (run_id, work_id),
    ).fetchone()
    workflow = workflow_row(db, work_id)
    if (
        child is None
        or workflow is None
        or workflow["phase"] != "EXEC"
        or workflow["budget_id"] != child["budget_id"]
    ):
        raise ValueError("PLANNING_RESULT_STALE")
    artifact = validate_planning(
        child["stage"],
        raw,
        json.loads(workflow["root_json"]),
        artifacts_for(db, work_id),
    )
    from .outline_compiler import is_pipeline

    if is_pipeline(json.loads(workflow["root_json"])):
        artifact["operationId"] = run_id
    db.execute(
        "INSERT INTO director_planning_artifacts VALUES (?,?,?,?,?)",
        (work_id, child["stage"], run_id, digest(artifact), canonical(artifact)),
    )
    return {
        "stage": child["stage"],
        "artifactHash": digest(artifact),
        "inputHash": snapshot["inputHash"],
    }


class WorkflowService:
    def __init__(self, repository: ExecutionRepository):
        self.repo = repository

    def _phase(
        self,
        db: sqlite3.Connection,
        row: sqlite3.Row,
        phase: str,
        error: str | None = None,
    ) -> None:
        db.execute(
            "UPDATE director_workflows SET phase=?,error_code=?,revision=revision+1 WHERE work_id=?",
            (phase, error, row["work_id"]),
        )
        self.repo.event(
            db,
            row["work_id"],
            row["session_id"],
            "workflow.changed",
            {"before": row["phase"], "after": phase, "errorCode": error},
        )

    def _root_current(self, db: sqlite3.Connection, row: sqlite3.Row) -> None:
        root = json.loads(row["root_json"])
        work = self.repo.store._work(db, row["work_id"])
        if work["revision"] != root["workRevision"] or work["status"] == "completed":
            raise ExecutionFault("PLANNING_INPUT_CHANGED")
        versions = {
            r["doc_key"]: r["current_version"]
            for r in db.execute(
                "SELECT * FROM documents WHERE work_id=?", (row["work_id"],)
            )
        }
        if versions != root["documentVersions"]:
            raise ExecutionFault("PLANNING_INPUT_CHANGED")

    def _new_workflow(
        self, db: sqlite3.Connection, actor: str, command: WorkflowCommand
    ) -> sqlite3.Row:
        work = self.repo.store._work(db, command.work_id)
        preset = json.loads(work["preset_json"])
        if preset["mode"] == "adaptation":
            if not work["source_text"].strip():
                raise ExecutionFault("SOURCE_REQUIRED", status=422)
            if command.payload.target_scope != "outline":
                raise ExecutionFault("PLANNING_ADAPTATION_OUTLINE_ONLY", status=422)
        elif preset["mode"] != "original" or work["source_text"]:
            raise ExecutionFault("PLANNING_ORIGINAL_ONLY", status=422)
        versions = {
            r["doc_key"]: r["current_version"]
            for r in db.execute(
                "SELECT * FROM documents WHERE work_id=?", (command.work_id,)
            )
        }
        if any(versions.values()) or work["status"] == "completed":
            raise ExecutionFault("PLANNING_REQUIRES_NEW_WORK")
        episodes = [
            dict(id=r["id"], orderKey=r["order_key"], deliveryLabel=r["delivery_label"])
            for r in db.execute(
                "SELECT * FROM director_episodes WHERE work_id=? AND archived=0 ORDER BY order_key",
                (command.work_id,),
            )
        ]
        if len(episodes) != preset["episode_count"]:
            raise ExecutionFault("PLANNING_EPISODES_MISMATCH")
        root = {
            "workId": command.work_id,
            "workRevision": work["revision"],
            "preset": preset,
            "brief": work["brief"],
            "episodes": episodes,
            "documentVersions": versions,
            "model": resolve_director_model(preset["model_name"]),
            "targetScope": command.payload.target_scope,
            "sourceText": work["source_text"],
            "sourceHash": content_hash(work["source_text"]),
        }
        from .outline_compiler import enabled
        from .schemas.outline_delivery import DELIVERY_CONTRACT

        if preset["mode"] == "adaptation" and enabled():
            root.update(outlineContract=DELIVERY_CONTRACT,
                        sourceKind=command.payload.source_kind, sourceLabel=work["title"])
        db.execute(
            "INSERT INTO director_workflows VALUES (?,?,?,1,'WAIT_COST',?,NULL,NULL,NULL,NULL)",
            (command.work_id, actor, command.session_id, canonical(root)),
        )
        self.repo.event(
            db,
            command.work_id,
            command.session_id,
            "workflow.created",
            {"rootHash": digest(root)},
        )
        return workflow_row(db, command.work_id)

    def execute(self, actor: str, command: WorkflowCommand) -> dict:
        from .execution import ExecutionService, execution_capability

        if not actor:
            raise ExecutionFault("FORBIDDEN", status=403)
        with self.repo.transaction() as db:
            work = self.repo.store._work(db, command.work_id)
            prior = self.repo.replay(db, actor, command)
            if prior is not None:
                return prior
            row = workflow_row(db, command.work_id)
            if row is not None and row["actor"] != actor:
                raise ExecutionFault("FORBIDDEN", status=403)
            if (
                row["revision"] if row else 0
            ) != command.expected.workflow_revision or work[
                "revision"
            ] != command.expected.work_revision:
                raise ExecutionFault("VERSION_CONFLICT")
            capability = execution_capability()
            if command.expected.capability_version != capability["version"]:
                raise ExecutionFault("CAPABILITY_CHANGED")
            if isinstance(command.payload, (PlanningQuote, PlanningGrant)):
                ExecutionService._no_active(db, command.work_id)
                if db.execute(
                    "SELECT 1 FROM changes WHERE work_id=? AND status='pending'",
                    (command.work_id,),
                ).fetchone():
                    raise ExecutionFault("PENDING_CHANGES")
            if row is None:
                if not isinstance(command.payload, PlanningQuote):
                    raise ExecutionFault("RESOURCE_GONE", status=404)
                row = self._new_workflow(db, actor, command)
            if command.payload.type not in {"planning.cancel", "planning.resume"}:
                self._root_current(db, row)
            if isinstance(command.payload, PlanningQuote):
                result = self._quote(db, row, command.payload, capability)
            elif isinstance(command.payload, PlanningGrant):
                self._grant(db, row, command.payload, capability)
                result = self._projection(db, command.work_id)
            elif isinstance(command.payload, PlanningDecision):
                self._decide(db, row, command.payload, actor)
                result = self._projection(db, command.work_id)
            elif command.payload.type == "planning.revalidate":
                self._revalidate(db, row)
                result = self._projection(db, command.work_id)
            else:
                self._control(db, row, command.payload.type == "planning.cancel")
                result = self._projection(db, command.work_id)
            seq = db.execute(
                "SELECT COALESCE(MAX(seq),0) FROM director_execution_events WHERE work_id=?",
                (command.work_id,),
            ).fetchone()[0]
            return self.repo.remember(
                db,
                actor,
                command,
                {
                    "schemaVersion": 2,
                    "commandId": command.command_id,
                    "eventSeq": seq,
                    "result": result,
                },
            )

    def _revalidate(self, db: sqlite3.Connection, row: sqlite3.Row) -> None:
        from .execution import ExecutionService
        from .outline_compiler import PIPELINE_VERSION, is_pipeline

        root = json.loads(row["root_json"])
        if row["phase"] != "FAILED_RECOVERABLE" or not is_pipeline(root):
            raise ExecutionFault("PLANNING_CHECKPOINT_REQUIRED")
        self._root_current(db, row)
        ExecutionService._no_active(db, row["work_id"])
        artifacts = artifacts_for(db, row["work_id"])
        stages = [s for s in GROUPS[preparation_group(row)] if s not in artifacts]
        failed = db.execute(
            "SELECT o.* FROM director_planning_children c JOIN director_operations o "
            "ON o.id=c.operation_id WHERE c.work_id=? AND c.stage=? ORDER BY o.created_at DESC LIMIT 1",
            (row["work_id"], stages[0] if stages else ""),
        ).fetchone()
        if failed is None or failed["status"] != "failed" or not failed["output_text"]:
            raise ExecutionFault("PLANNING_STAGE_FAILED")
        receipt = json.loads(failed["response_json"])
        snapshot = self.repo.snapshot(db, failed["id"])
        direction = json.loads(row["direction_json"]) if row["direction_json"] else None
        if (not receipt.get("validation") or receipt.get("usage", {}).get("finishReason") in {"length", "content_filter"}
                or snapshot["parameters"].get("workflowRootHash") != digest(root)
                or snapshot["parameters"].get("directionHash") != digest(direction)
                or receipt.get("output_sha256") != content_hash(failed["output_text"])):
            raise ExecutionFault("PLANNING_RESULT_STALE")
        artifact = validate_planning(stages[0], failed["output_text"], root, artifacts)
        artifact.update(operationId=failed["id"], revalidated={
            "outputHash": receipt["output_sha256"], "validatorVersion": PIPELINE_VERSION,
        })
        db.execute("INSERT INTO director_planning_artifacts VALUES (?,?,?,?,?)",
                   (row["work_id"], stages[0], failed["id"], digest(artifact), canonical(artifact)))
        self.repo.event(db, row["work_id"], row["session_id"], "planning.output_revalidated",
                        {"operationId": failed["id"], "stage": stages[0], **artifact["revalidated"]})
        artifacts[stages[0]] = artifact
        group = preparation_group(row)
        if all(stage in artifacts for stage in GROUPS[group]):
            self._group_checkpoint(db, row, group, artifacts)
        else:
            self._phase(db, row, "WAIT_COST")

    def _group_checkpoint(self, db: sqlite3.Connection, row: sqlite3.Row, group: str, artifacts: dict) -> None:
        """Normal completion and zero-cost revalidation must resume identically."""
        kind = "WAIT_DIRECTION" if group in {"direction", "adaptation_direction"} else "WAIT_OUTLINE"
        value = artifacts["M03"] if kind == "WAIT_DIRECTION" else {
            "artifacts": {key: artifacts[key] for key in GROUPS[group]},
            "documents": planning_documents(artifacts, json.loads(row["root_json"])),
        }
        if group == "direction":
            # The observed original flow asks about the already configured
            # count and duration after direction selection. Model questions are
            # retained with M03, but cannot silently become extra required pages.
            preset = json.loads(row["root_json"])["preset"]
            value = {**value, "specQuestions": [],
                     "suggestedQuestions": value["specQuestions"],
                     "confirmedPreset": {
                         "episodeCount": preset["episode_count"],
                         "durationSeconds": preset["duration_seconds"],
                     }}
        if kind == "WAIT_OUTLINE" and "M12" in artifacts and group == "adaptation_outline":
            value["quality"] = {key: artifacts["M12"][key] for key in (
                "status", "violatedPaths", "uncertainPaths", "literaryNotes")}
        self._checkpoint(db, row, kind, value)

    def _quote(
        self,
        db: sqlite3.Connection,
        row: sqlite3.Row,
        payload: PlanningQuote,
        capability: dict,
    ) -> dict:
        if row["phase"] not in {"WAIT_COST", "FAILED_RECOVERABLE", "CANCELLED"}:
            raise ExecutionFault("PLANNING_CHECKPOINT_REQUIRED")
        artifacts = artifacts_for(db, row["work_id"])
        if payload.target_scope != json.loads(row["root_json"]).get("targetScope", "preparation"):
            raise ExecutionFault("PLANNING_INPUT_CHANGED")
        group = preparation_group(row)
        stages = [stage for stage in GROUPS[group] if stage not in artifacts]
        if not stages:
            raise ExecutionFault("PLANNING_CHECKPOINT_REQUIRED")
        root = json.loads(row["root_json"])
        recoveries = {}
        for stage in stages:
            failed = db.execute(
                "SELECT o.* FROM director_planning_children c JOIN director_operations o "
                "ON o.id=c.operation_id WHERE c.work_id=? AND c.stage=? "
                "ORDER BY o.created_at DESC LIMIT 1", (row["work_id"], stage),
            ).fetchone()
            if failed is None or failed["status"] != "failed" or not failed["output_text"]:
                continue
            receipt = json.loads(failed["response_json"])
            snapshot = self.repo.snapshot(db, failed["id"])
            direction = json.loads(row["direction_json"]) if row["direction_json"] else None
            if direction and direction.get("revision") and snapshot["parameters"].get("directionHash") != digest(direction):
                continue
            if receipt.get("validation") and failed["output_text"]:
                # Re-evaluate retained bytes with current host validators; a
                # diagnostic upgrade need not buy another invalid response.
                from .planning import validate_planning
                from .output_validation import validation_receipt

                try:
                    validate_planning(stage, failed["output_text"], root, artifacts)
                except (ValueError, KeyError, TypeError) as exc:
                    receipt["validation"] = validation_receipt(exc)
            if receipt.get("validation") and snapshot["parameters"].get("workflowRootHash") == digest(root):
                recoveries[stage] = {"operationId": failed["id"],
                    "outputHash": receipt["output_sha256"], "output": failed["output_text"],
                    "validation": receipt["validation"]}
        from .output_budget import output_budget

        budgets = [output_budget(stage, root["preset"], source_chars=len(root.get("sourceText", "")), explicit=payload.max_output_tokens) for stage in stages]
        if any(budget.get("requiresSectionPlan") for budget in budgets):
            raise ExecutionFault("SECTION_PLAN_REQUIRED", status=422)
        max_tokens = max(budget["maxOutputTokens"] for budget in budgets)
        plan = {
            "schemaVersion": 2,
            "group": group,
            "rootHash": digest(json.loads(row["root_json"])),
            "capabilityVersion": capability["version"],
            "stages": stages,
            "dependencyHashes": {
                key: digest(value) for key, value in artifacts.items()
            },
            "directionHash": digest(json.loads(row["direction_json"]))
            if row["direction_json"]
            else None,
            "model": json.loads(row["root_json"])["model"],
            "validationRecoveries": recoveries,
            "outputBudgets": dict(zip(stages, budgets, strict=True)),
            "limits": {
                "maxCalls": len(stages),
                "maxOutputTokensPerCall": max_tokens,
                "maxTotalOutputTokens": sum(budget["maxOutputTokens"] for budget in budgets),
                "maxAttemptsPerStage": 1,
                "automaticRevisions": 0,
            },
        }
        # Check method/context validity before asking for money. Later children
        # compile only after their declared, validated prerequisites exist.
        from .planning import with_validation_recovery

        with_validation_recovery(compile_planning(
            json.loads(row["root_json"]),
            stages[0],
            artifacts,
            json.loads(row["direction_json"]) if row["direction_json"] else None,
            budgets[0]["maxOutputTokens"],
        ), recoveries.get(stages[0]))
        quote_id, expiry = identifier(), self.repo.clock() + 600
        db.execute(
            "INSERT INTO director_planning_quotes VALUES (?,?,?,?,?,?,?,'pending')",
            (
                quote_id,
                row["work_id"],
                row["actor"],
                row["revision"],
                digest(plan),
                canonical(plan),
                expiry,
            ),
        )
        self.repo.event(
            db,
            row["work_id"],
            row["session_id"],
            "planning.approval_requested",
            {"quoteId": quote_id, "planHash": digest(plan), "limits": plan["limits"]},
        )
        return {
            "quoteId": quote_id,
            "planHash": digest(plan),
            "plan": plan,
            "expiresAt": expiry,
            "workflowRevision": row["revision"],
            "estimateMinor": None,
            "currency": None,
        }

    def _grant(
        self,
        db: sqlite3.Connection,
        row: sqlite3.Row,
        payload: PlanningGrant,
        capability: dict,
    ) -> None:
        quote = db.execute(
            "SELECT * FROM director_planning_quotes WHERE id=? AND work_id=? AND actor=?",
            (payload.quote_id, row["work_id"], row["actor"]),
        ).fetchone()
        if quote is None:
            raise ExecutionFault("RESOURCE_GONE", status=404)
        if not payload.unknown_cost_consent:
            raise ExecutionFault("COST_CONSENT_REQUIRED")
        if quote["status"] != "pending" or row["phase"] not in {
            "WAIT_COST",
            "FAILED_RECOVERABLE",
            "CANCELLED",
        }:
            raise ExecutionFault("APPROVAL_ALREADY_USED")
        if quote["expires_at"] <= self.repo.clock():
            raise ExecutionFault("APPROVAL_EXPIRED")
        plan = json.loads(quote["plan_json"])
        if payload.plan_hash != quote["plan_hash"] or digest(plan) != payload.plan_hash:
            raise ExecutionFault("REQUEST_HASH_MISMATCH")
        if (
            quote["revision"] != row["revision"]
            or plan["capabilityVersion"] != capability["version"]
        ):
            raise ExecutionFault("VERSION_CONFLICT")
        budget_id = identifier()
        db.execute(
            "INSERT INTO director_planning_budgets VALUES (?,?,?,?,?,?,?,0,0,'granted')",
            (
                budget_id,
                quote["id"],
                row["work_id"],
                row["actor"],
                payload.plan_hash,
                quote["plan_json"],
                self.repo.clock() + 3600,
            ),
        )
        db.execute(
            "UPDATE director_planning_quotes SET status='consumed' WHERE id=?",
            (quote["id"],),
        )
        db.execute(
            "UPDATE director_workflows SET budget_id=? WHERE work_id=?",
            (budget_id, row["work_id"]),
        )
        self._phase(db, row, "EXEC")
        self.repo.event(
            db,
            row["work_id"],
            row["session_id"],
            "planning.approval_granted",
            {"budgetId": budget_id, "planHash": payload.plan_hash},
        )
        self._queue_next(db, workflow_row(db, row["work_id"]))

    def _queue_next(self, db: sqlite3.Connection, row: sqlite3.Row) -> str | None:
        from .execution import ExecutionService, execution_capability

        self._root_current(db, row)
        budget = db.execute(
            "SELECT * FROM director_planning_budgets WHERE id=?", (row["budget_id"],)
        ).fetchone()
        plan, artifacts = (
            json.loads(budget["plan_json"]),
            artifacts_for(db, row["work_id"]),
        )
        if budget["status"] != "granted":
            raise ExecutionFault("APPROVAL_EXPIRED")
        if digest(plan) != budget["plan_hash"] or plan["rootHash"] != digest(
            json.loads(row["root_json"])
        ):
            raise ExecutionFault("SNAPSHOT_CORRUPT")
        if execution_capability()["version"] != plan["capabilityVersion"]:
            raise ExecutionFault("CAPABILITY_CHANGED")
        if any(
            key not in artifacts or digest(artifacts[key]) != value
            for key, value in plan["dependencyHashes"].items()
        ):
            raise ExecutionFault("PLANNING_DEPENDENCY_MISSING")
        stages = [stage for stage in plan["stages"] if stage not in artifacts]
        if not stages:
            self._group_checkpoint(db, row, plan["group"], artifacts)
            db.execute(
                "UPDATE director_planning_budgets SET status='consumed' WHERE id=?",
                (budget["id"],),
            )
            return None
        if budget["expires_at"] <= self.repo.clock():
            raise ExecutionFault("APPROVAL_EXPIRED")
        stage = stages[0]
        existing = db.execute(
            "SELECT o.* FROM director_planning_children c JOIN director_operations o ON o.id=c.operation_id WHERE c.budget_id=? AND c.stage=?",
            (budget["id"], stage),
        ).fetchone()
        if existing:
            if existing["status"] in {"queued", "dispatching", "cancel_requested"}:
                return existing["id"]
            raise ExecutionFault(
                "STATUS_UNKNOWN"
                if existing["status"] == "unknown"
                else "PLANNING_STAGE_FAILED"
            )
        limits = plan["limits"]
        stage_budget = plan.get("outputBudgets", {}).get(stage)
        stage_tokens = stage_budget["maxOutputTokens"] if stage_budget else limits["maxOutputTokensPerCall"]
        if (
            budget["calls_reserved"] >= limits["maxCalls"]
            or budget["output_tokens_reserved"] + stage_tokens
            > limits["maxTotalOutputTokens"]
        ):
            raise ExecutionFault("PLANNING_BUDGET_EXHAUSTED")
        compiled = compile_planning(
            json.loads(row["root_json"]),
            stage,
            artifacts,
            json.loads(row["direction_json"]) if row["direction_json"] else None,
            stage_tokens,
        )
        from .planning import with_validation_recovery

        compiled = with_validation_recovery(compiled, plan.get("validationRecoveries", {}).get(stage))
        root = json.loads(row["root_json"])
        if stage_budget:
            compiled["parameters"]["outputBudget"] = stage_budget
        snapshot = {
            **compiled,
            "schemaVersion": 2,
            "purpose": "planning",
            "workRevision": root["workRevision"],
            "baseVersion": root["documentVersions"].get("outline", 0),
            "docKey": "outline",
            "capabilityVersion": plan["capabilityVersion"],
            "parentPlanHash": budget["plan_hash"],
            "parentBudgetId": budget["id"],
            "limits": {
                "maxAttempts": 1,
                "maxOutputTokens": stage_tokens,
                "inputChars": len(compiled["prompt"]),
                "timeoutSeconds": 600 if stage == "M12" else 300,
            },
        }
        quote_id, now = identifier(), self.repo.clock()
        db.execute(
            "INSERT INTO director_quotes VALUES (?,?,?,?,?,?,?,?,'pending')",
            (
                quote_id,
                row["work_id"],
                row["actor"],
                row["session_id"],
                digest(snapshot),
                canonical(snapshot),
                now,
                budget["expires_at"],
            ),
        )
        command = ExecutionCommand.model_validate(
            {
                "schemaVersion": 2,
                "commandId": identifier(),
                "clientRequestId": identifier(),
                "sessionId": row["session_id"],
                "workId": row["work_id"],
                "expected": {
                    "workRevision": root["workRevision"],
                    "documentVersions": {"outline": snapshot["baseVersion"]},
                    "capabilityVersion": plan["capabilityVersion"],
                },
                "payload": {
                    "type": "approval.grant",
                    "quoteId": quote_id,
                    "requestHash": digest(snapshot),
                    "unknownCostConsent": True,
                },
            }
        )
        child = ExecutionService(self.repo)._grant(db, row["actor"], command)
        db.execute(
            "INSERT INTO director_planning_children VALUES (?,?,?,?)",
            (child["id"], row["work_id"], budget["id"], stage),
        )
        db.execute(
            "UPDATE director_planning_budgets SET calls_reserved=calls_reserved+1,output_tokens_reserved=output_tokens_reserved+? WHERE id=?",
            (stage_tokens, budget["id"]),
        )
        self.repo.event(
            db,
            row["work_id"],
            row["session_id"],
            "planning.child_queued",
            {
                "stage": stage,
                "budgetId": budget["id"],
                "parentPlanHash": budget["plan_hash"],
                "requestHash": child["requestHash"],
            },
            child["id"],
        )
        return child["id"]

    def _checkpoint(
        self, db: sqlite3.Connection, row: sqlite3.Row, kind: str, value: dict
    ) -> None:
        cp_id = identifier()
        db.execute(
            "INSERT INTO director_planning_checkpoints VALUES (?,?,?,'open',?,?,?,NULL,NULL,?)",
            (
                cp_id,
                row["work_id"],
                kind,
                identifier(),
                digest(value),
                canonical(value),
                self.repo.clock(),
            ),
        )
        db.execute(
            "UPDATE director_workflows SET checkpoint_id=? WHERE work_id=?",
            (cp_id, row["work_id"]),
        )
        self._phase(db, row, kind)
        self.repo.event(
            db,
            row["work_id"],
            row["session_id"],
            "question.opened",
            {"checkpointId": cp_id, "kind": kind, "payloadHash": digest(value)},
        )

    def _decide(
        self,
        db: sqlite3.Connection,
        row: sqlite3.Row,
        payload: PlanningDecision,
        actor: str,
    ) -> None:
        cp = db.execute(
            "SELECT * FROM director_planning_checkpoints WHERE id=? AND work_id=?",
            (payload.checkpoint_id, row["work_id"]),
        ).fetchone()
        if (
            cp is None
            or cp["id"] != row["checkpoint_id"]
            or cp["resume_token"] != payload.resume_token
            or cp["payload_hash"] != payload.payload_hash
        ):
            raise ExecutionFault("PLANNING_CHECKPOINT_STALE")
        if payload.decision != "select" and (
            payload.episode_count is not None or payload.duration_seconds is not None
        ):
            raise ExecutionFault("INVALID_COMMAND_TYPE", status=422)
        if payload.decision == "return":
            if row["phase"] != "WAIT_INPUT" or cp["status"] != "skipped":
                raise ExecutionFault("PLANNING_CHECKPOINT_STALE")
            db.execute(
                "UPDATE director_planning_checkpoints SET status='superseded' WHERE id=?",
                (cp["id"],),
            )
            self._checkpoint(db, row, cp["kind"], json.loads(cp["payload_json"]))
            return
        if cp["status"] != "open" or row["phase"] != cp["kind"]:
            raise ExecutionFault("PLANNING_CHECKPOINT_STALE")
        value = json.loads(cp["payload_json"])
        if digest(value) != cp["payload_hash"]:
            raise ExecutionFault("SNAPSHOT_CORRUPT")
        if payload.decision == "skip":
            status, phase = "skipped", "WAIT_INPUT"
        elif payload.decision == "revise" and cp["kind"] == "WAIT_OUTLINE":
            from .outline_compiler import is_pipeline

            if not is_pipeline(json.loads(row["root_json"])) or not payload.free_text.strip():
                raise ExecutionFault("PLANNING_ANSWER_REQUIRED", status=422)
            if payload.option_id or payload.answers:
                raise ExecutionFault("INVALID_COMMAND_TYPE", status=422)
            artifacts = artifacts_for(db, row["work_id"])
            direction = json.loads(row["direction_json"])
            direction["revision"] = {"instruction": payload.free_text, "checkpointId": cp["id"],
                "previousDelivery": artifacts["M07"]["delivery"], "review": artifacts["M12"],
                "authority": "Revise requested defects only; do not add source events."}
            db.execute("UPDATE director_workflows SET direction_json=? WHERE work_id=?",
                       (canonical(direction), row["work_id"]))
            # Immutable checkpoints, operation outputs and cost entries retain
            # old candidates; only the current stage pointers are invalidated.
            db.execute("DELETE FROM director_planning_artifacts WHERE work_id=? AND stage IN ('M07','M12')", (row["work_id"],))
            status, phase = "superseded", "WAIT_COST"
        elif payload.decision == "select" and cp["kind"] == "WAIT_DIRECTION":
            selected = next(
                (item for item in value["options"] if item["id"] == payload.option_id),
                None,
            )
            if selected is None and not (
                payload.option_id is None and payload.free_text.strip()
            ):
                raise ExecutionFault("PLANNING_ANSWER_REQUIRED", status=422)
            if set(payload.answers) != {item["id"] for item in value["specQuestions"]}:
                raise ExecutionFault("PLANNING_ANSWER_REQUIRED", status=422)
            confirmed = value.get("confirmedPreset")
            if confirmed is not None:
                if payload.episode_count is None or payload.duration_seconds is None:
                    raise ExecutionFault("PLANNING_ANSWER_REQUIRED", status=422)
                root = json.loads(row["root_json"])
                preset = {**root["preset"], "episode_count": payload.episode_count,
                          "duration_seconds": payload.duration_seconds}
                from .models import DirectorPreset

                DirectorPreset.model_validate(preset)
                if preset != root["preset"]:
                    from .repository import allocate_documents

                    db.execute(
                        "UPDATE works SET preset_json=?,revision=revision+1,updated_at=? WHERE id=?",
                        (canonical(preset), self.repo.clock(), row["work_id"]),
                    )
                    updated = self.repo.store._work(db, row["work_id"])
                    allocate_documents(db, updated)
                    root.update(workRevision=updated["revision"], preset=preset,
                                episodes=[dict(id=episode["id"], orderKey=episode["order_key"],
                                               deliveryLabel=episode["delivery_label"])
                                          for episode in db.execute(
                                              "SELECT * FROM director_episodes WHERE work_id=? AND archived=0 ORDER BY order_key",
                                              (row["work_id"],))])
                    db.execute("UPDATE director_workflows SET root_json=? WHERE work_id=?",
                               (canonical(root), row["work_id"]))
                    self.repo.event(db, row["work_id"], row["session_id"],
                                    "planning.spec_confirmed", {
                                        "episodeCount": payload.episode_count,
                                        "durationSeconds": payload.duration_seconds,
                                        "workRevision": updated["revision"],
                                    })
            elif payload.episode_count is not None or payload.duration_seconds is not None:
                raise ExecutionFault("INVALID_COMMAND_TYPE", status=422)
            decision = {
                "option": selected,
                "freeText": payload.free_text,
                "answers": payload.answers,
                "confirmedSpec": {
                    "episodeCount": payload.episode_count,
                    "durationSeconds": payload.duration_seconds,
                } if confirmed is not None else None,
                "provenance": "explicit_user_decision",
                "checkpointId": cp["id"],
                "actor": actor,
            }
            db.execute(
                "UPDATE director_workflows SET direction_json=? WHERE work_id=?",
                (canonical(decision), row["work_id"]),
            )
            status, phase = "answered", "WAIT_COST"
        elif payload.decision == "adopt" and cp["kind"] == "WAIT_OUTLINE":
            root = json.loads(row["root_json"])
            from .outline_compiler import is_pipeline

            if is_pipeline(root):
                from .documents import object_hash
                from .outline_candidate_review import AUDIT_VALIDATOR_VERSION

                artifacts = artifacts_for(db, row["work_id"])
                report, candidate = artifacts["M12"], artifacts["M07"]["candidate"]
                if (report["status"] != "reviewed"
                        or report.get("validatorVersion") != AUDIT_VALIDATOR_VERSION
                        or report["candidateHash"] != object_hash(candidate)
                        or report["sourceHash"] != root["sourceHash"]
                        or report["operationId"] == artifacts["M07"]["operationId"]):
                    raise ExecutionFault("OUTLINE_FACT_CONFLICT")
            if payload.option_id or payload.free_text or payload.answers:
                raise ExecutionFault("INVALID_COMMAND_TYPE", status=422)
            for key in value["documents"]:
                self.repo.store._ensure_writable(
                    db, self.repo.store._work(db, row["work_id"]), key
                )
            for key, content in value["documents"].items():
                from .schemas.documents import DocumentAST

                self.repo.store._put_document(
                    db,
                    row["work_id"],
                    key,
                    content,
                    root["documentVersions"].get(key, 0),
                    "planning-human-adopted",
                    **({"verified_ast": DocumentAST.from_wire(candidate["ast"])} if is_pipeline(root) else {}),
                )
            status, phase = "answered", "READY"
        else:
            raise ExecutionFault("INVALID_COMMAND_TYPE", status=422)
        db.execute(
            "UPDATE director_planning_checkpoints SET status=?,decision_json=?,actor=? WHERE id=?",
            (
                status,
                canonical(payload.model_dump(mode="json", by_alias=True)),
                actor,
                cp["id"],
            ),
        )
        self._phase(db, row, phase)
        self.repo.event(
            db,
            row["work_id"],
            row["session_id"],
            "question." + status,
            {"checkpointId": cp["id"], "decision": payload.decision},
        )

    def _control(self, db: sqlite3.Connection, row: sqlite3.Row, cancel: bool) -> None:
        active = db.execute(
            "SELECT o.* FROM director_operations o JOIN director_planning_children c ON c.operation_id=o.id WHERE c.work_id=? AND o.status IN ('queued','dispatching','cancel_requested','unknown')",
            (row["work_id"],),
        ).fetchone()
        if active and active["status"] == "unknown":
            raise ExecutionFault("STATUS_UNKNOWN")
        if cancel:
            if row["phase"] != "EXEC":
                raise ExecutionFault("PLANNING_CHECKPOINT_REQUIRED")
            group = preparation_group(row)
            if not active and all(
                stage in artifacts_for(db, row["work_id"]) for stage in GROUPS[group]
            ):
                # A stop racing the final response must not strand paid results.
                # Opening their question neither dispatches nor adopts anything.
                self._queue_next(db, row)
                return
            if active:
                self.repo.stop_or_recover(db, row["work_id"], active["id"], True)
            if row["budget_id"]:
                db.execute(
                    "UPDATE director_planning_budgets SET status='cancelled' WHERE id=?",
                    (row["budget_id"],),
                )
            self._phase(db, row, "CANCELLED")
        else:
            if row["phase"] != "EXEC":
                raise ExecutionFault("PLANNING_CHECKPOINT_REQUIRED")
            if active and active["status"] in {"dispatching", "cancel_requested"}:
                self.repo.stop_or_recover(db, row["work_id"], active["id"], False)

    def advance(self, work_id: str) -> str | None:
        with self.repo.transaction() as db:
            row = workflow_row(db, work_id)
            if row is None or row["phase"] != "EXEC":
                return None
            # Failed compilation cannot roll back a paid response saved earlier.
            db.execute("SAVEPOINT next_child")
            try:
                result = self._queue_next(db, row)
                db.execute("RELEASE next_child")
                return result
            except (ExecutionFault, ValueError) as exc:
                db.execute("ROLLBACK TO next_child")
                db.execute("RELEASE next_child")
                code = (
                    exc.code
                    if isinstance(exc, ExecutionFault)
                    else "PLANNING_STAGE_FAILED"
                )
                self._phase(
                    db,
                    row,
                    "UNKNOWN" if code == "STATUS_UNKNOWN" else "FAILED_RECOVERABLE",
                    code,
                )
                return None

    def projection(self, work_id: str) -> dict:
        with self.repo.store._connect() as db:
            self.repo.store._work(db, work_id)
            return self._projection(db, work_id)

    def _projection(self, db: sqlite3.Connection, work_id: str) -> dict:
        row = workflow_row(db, work_id)
        work_revision = self.repo.store._work(db, work_id)["revision"]
        if row is None:
            return {
                "workId": work_id,
                "workRevision": work_revision,
                "revision": 0,
                "phase": "NOT_STARTED",
                "checkpoint": None,
                "artifacts": {},
                "budgets": [],
                "errorCode": None,
            }
        cp = db.execute(
            "SELECT * FROM director_planning_checkpoints WHERE id=?",
            (row["checkpoint_id"],),
        ).fetchone()
        error = row["error_code"]
        if row["phase"] != "READY":
            try:
                self._root_current(db, row)
            except ExecutionFault as exc:
                error = exc.code
        budgets = [
            {
                "id": b["id"],
                "planHash": b["plan_hash"],
                "plan": json.loads(b["plan_json"]),
                "callsReserved": b["calls_reserved"],
                "outputTokensReserved": b["output_tokens_reserved"],
                "status": b["status"],
                "expiresAt": b["expires_at"],
            }
            for b in db.execute(
                "SELECT * FROM director_planning_budgets WHERE work_id=? ORDER BY rowid",
                (work_id,),
            )
        ]
        return {
            "workId": work_id,
            "workRevision": work_revision,
            "revision": row["revision"],
            "phase": row["phase"],
            "checkpoint": {
                "id": cp["id"],
                "status": cp["status"],
                "kind": cp["kind"],
                "resumeToken": cp["resume_token"],
                "payloadHash": cp["payload_hash"],
                "payload": json.loads(cp["payload_json"]),
            }
            if cp
            else None,
            "artifacts": artifacts_for(db, work_id),
            "budgets": budgets,
            "errorCode": error,
        }


async def dispatch_planning(
    repository: ExecutionRepository, work_id: str, model_call=None
) -> None:
    from .dispatch import dispatch_writing

    workflow = WorkflowService(repository)
    # The approved group has at most three children. Refresh never starts this
    # pump; explicit grant/resume does, and claim prevents duplicate delivery.
    for _ in range(4):
        run_id = workflow.advance(work_id)
        if run_id is None:
            return
        result = await dispatch_writing(repository, work_id, run_id, model_call)
        if result is None:
            return
        if result["status"] != "succeeded":
            workflow.advance(work_id)
            return
