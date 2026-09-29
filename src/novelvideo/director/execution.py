"""Freeze, authorize and queue; neither previews nor approval replay call a model."""

from __future__ import annotations

import json
import sqlite3

from .execution_repository import ExecutionRepository, canonical, digest, identifier
from .models import GenerateDraft, document_key
from .schemas.execution import (
    CancelWriting,
    ExecutionCommand,
    ExecutionFault,
    GrantWriting,
    QuoteWriting,
)
from .writing import (
    METHOD_VERSION,
    SYSTEM_PROMPT,
    compile_generation,
    director_model_contract,
)
from .rules.resolver import rule_bundle_hash
from .quality import (
    REVIEW_SYSTEM,
    REVIEW_VERSION,
    REVIEW_VALIDATOR_VERSION,
    compile_review,
)
from .skills.runtime import package_registry_hash
from .outline_review import (
    OUTLINE_REVIEW_SYSTEM,
    OUTLINE_REVIEW_VERSION,
    compile_outline_review,
)
from .output_budget import OUTPUT_BUDGET_VERSION, output_budget


def execution_capability() -> dict:
    from .planning import PLANNING_SYSTEM, PLANNING_VERSION
    from .context import CONTEXT_VERSION
    from .outline_compiler import enabled, PIPELINE_VERSION

    model = director_model_contract()
    value = {
        "schemaVersion": 2,
        "model": model,
        "methodVersion": METHOD_VERSION,
        "contextCompilerVersion": CONTEXT_VERSION,
        "systemPromptHash": digest(SYSTEM_PROMPT),
        "reviewSystemPromptHash": digest(REVIEW_SYSTEM),
        "reviewMethodVersion": REVIEW_VERSION,
        "reviewValidatorVersion": REVIEW_VALIDATOR_VERSION,
        "outlineReviewVersion": OUTLINE_REVIEW_VERSION,
        "outlineReviewSystemHash": digest(OUTLINE_REVIEW_SYSTEM),
        "ruleBundleHash": rule_bundle_hash(),
        "methodPackageRegistryHash": package_registry_hash(),
        "planningVersion": PLANNING_VERSION,
        "planningSystemHash": digest(PLANNING_SYSTEM),
        "outlineDeliveryV3": enabled(),
        "outlinePipelineVersion": PIPELINE_VERSION,
        "maxAttempts": 1,
        "outputBudgetPolicy": OUTPUT_BUDGET_VERSION,
        "outputTokens": {"minimum": 256, "maximum": 32768, "default": 12288},
        "cost": {
            "estimateMinor": None,
            "currency": None,
            "requiresUnknownCostConsent": True,
        },
        "supportsRemoteCancellation": False,
        "supportsAutomaticRedispatch": False,
    }
    return {**value, "version": digest(value)}


class ExecutionService:
    def __init__(self, repository: ExecutionRepository):
        self.repository = repository

    def execute(self, actor: str, command: ExecutionCommand) -> dict:
        if not actor:
            raise ExecutionFault("FORBIDDEN", status=403)
        repo = self.repository
        with repo.transaction() as db:
            repo.store._work(db, command.work_id)
            prior = repo.replay(db, actor, command)
            if prior is not None:
                return prior
            if isinstance(command.payload, (QuoteWriting, GrantWriting)):
                from .workflow import workflow_row

                workflow = workflow_row(db, command.work_id)
                if workflow is not None and workflow["phase"] != "READY":
                    raise ExecutionFault("PLANNING_CHECKPOINT_REQUIRED")
                capability = execution_capability()
                if capability["version"] != command.expected.capability_version:
                    raise ExecutionFault("CAPABILITY_CHANGED")
                work = repo.store._work(db, command.work_id)
                if work["revision"] != command.expected.work_revision:
                    raise ExecutionFault("VERSION_CONFLICT")
                if isinstance(command.payload, QuoteWriting):
                    result = self._quote(db, actor, command, capability)
                else:
                    result = self._grant(db, actor, command)
            else:
                result = repo.stop_or_recover(
                    db,
                    command.work_id,
                    command.payload.run_id,
                    isinstance(command.payload, CancelWriting),
                )
            seq = db.execute(
                "SELECT COALESCE(MAX(seq),0) FROM director_execution_events WHERE work_id=?",
                (command.work_id,),
            ).fetchone()[0]
            envelope = {
                "schemaVersion": 2,
                "commandId": command.command_id,
                "eventSeq": seq,
                "result": result,
            }
            return repo.remember(db, actor, command, envelope)

    def _quote(
        self,
        db: sqlite3.Connection,
        actor: str,
        command: ExecutionCommand,
        capability: dict,
    ) -> dict:
        repo = self.repository
        payload = command.payload
        assert isinstance(payload, QuoteWriting)
        key = document_key(payload.kind, payload.episode_ordinal)
        if set(command.expected.document_versions) != {key}:
            raise ExecutionFault("DOCUMENT_VERSIONS_REQUIRED", status=422)
        review_change = payload.review_target.change_id if payload.review_target else ""
        repo.store._ensure_writable(db, repo.store._work(db, command.work_id), key,
                                    accepted_change_id=review_change)
        if db.execute(
            "SELECT 1 FROM changes WHERE work_id=? AND status='pending' AND id!=?",
            (command.work_id, review_change),
        ).fetchone():
            raise ExecutionFault("PENDING_CHANGES")
        self._no_active(db, command.work_id)
        work = repo.store.get_work(command.work_id, include_source=True)
        document = repo.store.get_document(command.work_id, key)
        budget = output_budget(
            "M12" if payload.review_target else "review" if payload.purpose == "review" else payload.kind,
            work["preset"], source_chars=len(work["source_text"]),
            document_chars=len(document["content"]), explicit=payload.max_output_tokens,
        )
        if budget.get("requiresSectionPlan"):
            # Do not buy a response we already expect to truncate. A section
            # plan needs its own bounded quote; this is not permission to retry.
            raise ExecutionFault("SECTION_PLAN_REQUIRED", status=422)
        generation = GenerateDraft(
            kind=payload.kind,
            episode_ordinal=payload.episode_ordinal,
            instruction=payload.instruction,
            expected_version=command.expected.document_versions[key],
        )
        from .outline_changes import compile_candidate_review

        compiled = (
            compile_candidate_review(db, repo.store, command.work_id, payload.review_target, budget["maxOutputTokens"])
            if payload.review_target else compile_outline_review(repo.store, command.work_id)
            if payload.purpose == "review" and payload.kind == "outline"
            else compile_review(repo.store, command.work_id, payload.episode_ordinal)
            if payload.purpose == "review"
            else compile_generation(
                repo.store,
                command.work_id,
                generation,
                max_output_tokens=budget["maxOutputTokens"],
            )
        )
        snapshot = {
            "schemaVersion": 2,
            "purpose": payload.purpose,
            "workRevision": command.expected.work_revision,
            "baseVersion": generation.expected_version,
            "docKey": key,
            "prompt": compiled["prompt"],
            "inputHash": compiled["input_sha256"],
            "parameters": {**compiled["parameters"], "outputBudget": budget},
            "contextManifest": compiled["context_manifest"],
            "capabilityVersion": capability["version"],
            "limits": {
                "maxAttempts": 1,
                "maxOutputTokens": budget["maxOutputTokens"],
                "inputChars": len(compiled["prompt"]),
                "timeoutSeconds": 600 if payload.review_target else 300,
            },
        }
        if payload.purpose == "review":
            snapshot["reviewInputs"] = compiled["review_inputs"]
        if payload.review_target:
            snapshot["outlineReviewTarget"] = compiled["outlineReviewTarget"]
        quote_id = identifier()
        now = repo.clock()
        request_hash = digest(snapshot)
        db.execute(
            "INSERT INTO director_quotes VALUES (?,?,?,?,?,?,?,?,?)",
            (
                quote_id,
                command.work_id,
                actor,
                command.session_id,
                request_hash,
                canonical(snapshot),
                now,
                now + 600,
                "pending",
            ),
        )
        repo.event(
            db,
            command.work_id,
            command.session_id,
            "approval.requested",
            {"quoteId": quote_id, "requestHash": request_hash},
        )
        return {
            "quoteId": quote_id,
            "requestHash": request_hash,
            "inputHash": snapshot["inputHash"],
            "parameters": snapshot["parameters"],
            "limits": snapshot["limits"],
            "docKey": key,
            "estimateMinor": None,
            "currency": None,
            "expiresAt": now + 600,
        }

    @staticmethod
    def _no_active(db: sqlite3.Connection, work_id: str) -> None:
        if db.execute(
            "SELECT 1 FROM director_operations WHERE work_id=? AND status IN ('queued','dispatching','cancel_requested','unknown')",
            (work_id,),
        ).fetchone():
            raise ExecutionFault("ACTIVE_OPERATION", recovery="inspect_run")

    def _grant(
        self, db: sqlite3.Connection, actor: str, command: ExecutionCommand
    ) -> dict:
        repo = self.repository
        payload = command.payload
        assert isinstance(payload, GrantWriting)
        quote = db.execute(
            "SELECT * FROM director_quotes WHERE id=? AND work_id=? AND actor=? AND session_id=?",
            (payload.quote_id, command.work_id, actor, command.session_id),
        ).fetchone()
        if quote is None:
            raise ExecutionFault("RESOURCE_GONE", status=404)
        if quote["request_hash"] != payload.request_hash:
            raise ExecutionFault("REQUEST_HASH_MISMATCH")
        if quote["status"] != "pending":
            raise ExecutionFault("APPROVAL_ALREADY_USED")
        if quote["expires_at"] <= repo.clock():
            raise ExecutionFault("APPROVAL_EXPIRED", recovery="quote_again")
        if not payload.unknown_cost_consent:
            raise ExecutionFault("COST_CONSENT_REQUIRED")
        snapshot = json.loads(quote["snapshot_json"])
        if digest(snapshot) != quote["request_hash"]:
            raise ExecutionFault("SNAPSHOT_CORRUPT")
        if snapshot["capabilityVersion"] != command.expected.capability_version:
            raise ExecutionFault("CAPABILITY_CHANGED")
        if snapshot["workRevision"] != command.expected.work_revision:
            raise ExecutionFault("VERSION_CONFLICT")
        if command.expected.document_versions != {
            snapshot["docKey"]: snapshot["baseVersion"]
        }:
            raise ExecutionFault("VERSION_CONFLICT")
        if (
            repo.store._version(db, command.work_id, snapshot["docKey"])
            != snapshot["baseVersion"]
        ):
            raise ExecutionFault("VERSION_CONFLICT")
        from .outline_changes import review_current

        target = snapshot.get("outlineReviewTarget")
        if target and not review_current(db, command.work_id, target):
            raise ExecutionFault("OUTLINE_REVIEW_HEAD_CHANGED")
        review_change = target["changeId"] if target else ""
        repo.store._ensure_writable(db, repo.store._work(db, command.work_id), snapshot["docKey"],
                                    accepted_change_id=review_change)
        if db.execute(
            "SELECT 1 FROM changes WHERE work_id=? AND status='pending' AND id!=?",
            (command.work_id, review_change),
        ).fetchone():
            raise ExecutionFault("PENDING_CHANGES")
        self._no_active(db, command.work_id)
        approval_id, operation_id, now = identifier(), identifier(), repo.clock()
        db.execute(
            "INSERT INTO director_approvals VALUES (?,?,?,?,?,?,?)",
            (
                approval_id,
                quote["id"],
                actor,
                quote["request_hash"],
                canonical(snapshot["limits"]),
                now,
                quote["expires_at"],
            ),
        )
        db.execute(
            "INSERT INTO director_operations (id,work_id,approval_id,session_id,request_hash,status,created_at,updated_at) VALUES (?,?,?,?,?,'queued',?,?)",
            (
                operation_id,
                command.work_id,
                approval_id,
                command.session_id,
                quote["request_hash"],
                now,
                now,
            ),
        )
        db.execute(
            "INSERT INTO director_cost_entries VALUES (?,NULL,NULL,NULL,NULL,?,NULL,'reserved')",
            (operation_id, snapshot["limits"]["maxOutputTokens"]),
        )
        db.execute(
            "INSERT INTO director_outbox VALUES (?,?,'pending',?)",
            (operation_id, operation_id, now),
        )
        db.execute(
            "UPDATE director_quotes SET status='consumed' WHERE id=?", (quote["id"],)
        )
        # Legacy history remains readable. This is in the same transaction as
        # the approval/outbox, not a second start_run that could lose its receipt.
        db.execute(
            """INSERT INTO runs (id,work_id,action,input_sha256,request_json,status,created_at)
                   VALUES (?,?,?,?,?,'running',?)""",
            (
                operation_id,
                command.work_id,
                snapshot["docKey"],
                snapshot["inputHash"],
                canonical(
                    {
                        "parameters": snapshot["parameters"],
                        "prompt_chars": snapshot["limits"]["inputChars"],
                        "execution_version": 2,
                    }
                ),
                now,
            ),
        )
        repo.event(
            db,
            command.work_id,
            command.session_id,
            "approval.granted",
            {"approvalId": approval_id, "requestHash": quote["request_hash"]},
            operation_id,
        )
        repo.event(
            db,
            command.work_id,
            command.session_id,
            "cost.reserved",
            {"amountMinor": None, "limits": snapshot["limits"]},
            operation_id,
        )
        repo.event(
            db, command.work_id, command.session_id, "run.queued", {}, operation_id
        )
        return repo.projection(db, command.work_id, operation_id)
