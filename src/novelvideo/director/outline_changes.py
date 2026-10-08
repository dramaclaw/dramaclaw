"""A review is permission for one exact cumulative candidate, never a whole draft.

Changes use the existing pending-change identity so legacy editors cannot race
this review. Decisions and canonical AST updates share the caller's transaction.
"""

from __future__ import annotations

import json
import sqlite3
import time
import uuid

from .documents import object_hash, render_markdown
from .outline_candidate_review import AUDIT_VALIDATOR_VERSION, validate_candidate_audit
from .outline_compiler import is_pipeline
from .outline_patch import apply_groups, index_current, patch_context, replacement_blocks, validate_patch
from .outline_source import source_for_root
from .repository import ast_version, canonical
from .schemas.common import require_unique
from .schemas.documents import DocumentAST
from .schemas.execution import ExecutionFault


def initialize(db: sqlite3.Connection) -> None:
    db.executescript("""
    CREATE TABLE IF NOT EXISTS director_outline_changes (
      change_id TEXT PRIMARY KEY REFERENCES changes(id), operation_id TEXT NOT NULL UNIQUE,
      proposal_json TEXT NOT NULL, root_json TEXT NOT NULL, revision INTEGER NOT NULL,
      head_version INTEGER NOT NULL, decisions_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS director_outline_candidate_reviews (
      id TEXT PRIMARY KEY, change_id TEXT NOT NULL REFERENCES director_outline_changes(change_id),
      operation_id TEXT NOT NULL UNIQUE, change_revision INTEGER NOT NULL,
      candidate_hash TEXT NOT NULL, report_json TEXT NOT NULL);
    """)


def workflow_basis(db: sqlite3.Connection, work_id: str) -> tuple[dict, dict, dict] | None:
    from .workflow import artifacts_for, workflow_row

    # Store may be used without an ExecutionRepository having installed planning.
    if not db.execute("SELECT 1 FROM sqlite_master WHERE name='director_workflows'").fetchone():
        return None
    row = workflow_row(db, work_id)
    if row is None or not is_pipeline(root := json.loads(row["root_json"])):
        return None
    if row["phase"] != "READY":
        raise ExecutionFault("PLANNING_CHECKPOINT_REQUIRED")
    work = db.execute("SELECT * FROM works WHERE id=?", (work_id,)).fetchone()
    spec = json.loads(work["preset_json"])
    if (work["source_sha256"] != root["sourceHash"] or work["brief"] != root["brief"]
            or {k: v for k, v in spec.items() if k != "model_name"}
            != {k: v for k, v in root["preset"].items() if k != "model_name"}):
        raise ExecutionFault("PLANNING_INPUT_CHANGED")
    return root, artifacts_for(db, work_id), json.loads(row["direction_json"])


def current_context(db: sqlite3.Connection, work_id: str, root: dict, artifacts: dict) -> dict:
    version = db.execute("SELECT current_version FROM documents WHERE work_id=? AND doc_key='outline'", (work_id,)).fetchone()[0]
    saved = ast_version(db, work_id, "outline", version)
    if not saved:
        raise ExecutionFault("OUTLINE_CONVERSION_REQUIRED")
    ast = DocumentAST.from_wire(saved["ast"])
    bindings = index_current(ast, artifacts["M07"]["candidate"]["bindings"])
    return patch_context(ast, bindings, version, [c["id"] for c in artifacts["M04"]["claims"]])


def compile_patch(store, work_id: str, instruction: str, max_tokens: int) -> dict | None:
    from .context import ContextItem, compile_context
    from .documents import content_hash
    from .rules.resolver import RuleContext
    from .schemas.outline_changes import PATCH_CONTRACT, OutlinePatchContext
    from .skills.runtime import compile_method, output_schema
    from .structured_output import response_format
    from .writing import resolve_director_model

    with store._connect() as db:
        basis = workflow_basis(db, work_id)
        if basis is None:
            return None
        root, artifacts, direction = basis
        frozen = current_context(db, work_id, root, artifacts)
    work = store.get_work(work_id)
    model = resolve_director_model(work["preset"]["model_name"])
    schema = output_schema("M14", contract=PATCH_CONTRACT)
    for key in ("baseVersion", "baseAstHash", "baseSemanticHash"):
        schema["properties"][key]["const"] = frozen[key]
    parameters = {**work["preset"], "stage": "M14", "model_name": model,
        "stream": True,
        "instruction": instruction, "output_contract": PATCH_CONTRACT, "outlineRoot": root,
        "patchContext": frozen, "responseSchema": schema,
        "response_format": response_format(model, schema, name="director_outline_patch")}
    ast = DocumentAST.from_wire(frozen["baseAst"])
    inputs = {"source": source_for_root(root), "sourceGraph": artifacts["M04"],
        "confirmedDirection": {"freeText": direction["freeText"], "answers": direction["answers"]},
        "instruction": instruction, "targets": [{"sectionKey": section["key"],
            "targetBlockIds": [b.id], "beforeHash": object_hash([b.model_dump(by_alias=True)]),
            "text": b.text, "type": b.type, "attrs": b.attrs.model_dump(by_alias=True),
            "marks": [m.model_dump(by_alias=True) for m in b.marks],
            "protected": b.id in frozen["bindings"]["protectedBlockIds"]} for section in frozen["bindings"]["sections"]
            for b in ast.blocks if b.id in section["blockIds"]]}
    indexed = {bid for section in frozen["bindings"]["sections"] for bid in section["blockIds"]}
    inputs["documentContext"] = [b.model_dump(by_alias=True) for b in ast.blocks if b.id not in indexed]
    method = compile_method(OutlinePatchContext(schema_version=2, stage="M14", mode="adaptation",
        episode_ordinal=1, total_episodes=root["preset"]["episode_count"],
        ending_type=root["preset"]["ending_type"], parameters_hash=object_hash(parameters)), contract=PATCH_CONTRACT)
    parameters.update(skill_key=method["binding"]["skillId"], skill_revision=method["binding"]["revisionId"],
                      skill_version=method["binding"]["version"])
    # Persistence needs the whole immutable AST/index; the model needs each
    # current block once, not two copies plus repeated reference metadata.
    prompt_parameters = {k: v for k, v in parameters.items() if k not in {"outlineRoot", "patchContext"}}
    prompt_parameters["hostSnapshotHash"] = object_hash(parameters)
    prompt_parameters["patchContext"] = {k: frozen[k] for k in (
        "baseVersion", "baseAstHash", "baseSemanticHash", "claimIds", "allowedSections")}
    prompt_parameters["patchContext"]["protectedBlockIds"] = frozen["bindings"]["protectedBlockIds"]
    text = canonical(inputs)
    item = ContextItem(id="outline-patch-inputs", work_id=work_id, version=work["revision"], kind="plan",
                       text=text, text_hash=content_hash(text), current=True, required=True)
    result = compile_context(work_id=work_id, context=RuleContext(stage="M14", mode="adaptation", has_source=True,
        total_episodes=root["preset"]["episode_count"], ending_type=root["preset"]["ending_type"]),
        items=[item], parameters=prompt_parameters, input_budget=240000, output_reserve=max_tokens,
        system_reserve=1500, required_ids=[item.id], method_bundle=method)
    return {"prompt": result["prompt"], "input_sha256": result["inputHash"],
            "parameters": parameters, "context_manifest": result["manifest"]}


def compile_candidate_review(db: sqlite3.Connection, store, work_id: str, target, max_tokens: int) -> dict:
    from .outline_compiler import compile_outline_request
    from .writing import resolve_director_model

    basis = workflow_basis(db, work_id)
    if basis is None:
        raise ExecutionFault("OUTLINE_CONVERSION_REQUIRED")
    root, artifacts, direction = basis
    frozen = freeze_review(db, work_id, target)
    root = {**root, "model": resolve_director_model(store.get_work(work_id)["preset"]["model_name"])}
    candidate_artifacts = {**artifacts, "M07": {"candidate": frozen["candidate"]}}
    recovery = failed_review_context(db, work_id, frozen)
    result = compile_outline_request(root, "M12", candidate_artifacts, direction, max_tokens, recovery=recovery)
    result["parameters"]["purpose"] = "review"
    return {"prompt": result["prompt"], "input_sha256": result["inputHash"], "parameters": result["parameters"],
            "context_manifest": result["contextManifest"], "review_inputs": {}, "outlineReviewTarget": frozen}


def failed_review_context(db: sqlite3.Connection, work_id: str, target: dict) -> dict | None:
    """A new approval may repair one known failure, never redispatch UNKNOWN."""
    from jsonschema import Draft202012Validator
    from .documents import content_hash
    from .execution_repository import ExecutionRepository
    from .outline_candidate_review import audit_wire_schema
    from .output_validation import parse_model_json

    for row in db.execute("SELECT * FROM director_operations WHERE work_id=? AND status='failed' "
                          "AND error_code='PLANNING_OUTPUT_INVALID' ORDER BY created_at DESC LIMIT 20", (work_id,)):
        prior = ExecutionRepository.snapshot(db, row["id"]).get("outlineReviewTarget", {})
        if any(prior.get(key) != target[key] for key in ("candidateHash", "changeId", "changeRevision", "headVersion")):
            continue
        receipt = json.loads(row["response_json"])
        if not row["output_text"] or receipt.get("usage", {}).get("finishReason") != "stop":
            continue
        if receipt.get("output_sha256") != content_hash(row["output_text"]):
            continue
        issues = receipt.get("validation", {}).get("issues", [])
        try:
            value = parse_model_json(row["output_text"])
            schema = audit_wire_schema(source_for_root(target["root"]), target["candidate"], compact=True)
            all_errors = [{"path": ".".join(map(str, e.path)), "code": e.validator}
                          for e in Draft202012Validator(schema).iter_errors(value)]
            if all_errors:
                issues = all_errors
        except (ValueError, TypeError):
            pass
        return {"operationId": row["id"], "outputHash": content_hash(row["output_text"]),
                "output": row["output_text"], "issues": issues}
    return None


def record_patch(db: sqlite3.Connection, store, work_id: str, operation_id: str,
                 snapshot: dict, value: dict) -> str:
    parameters = snapshot["parameters"]
    proposal = validate_patch(value, parameters["patchContext"])
    candidate = apply_groups(proposal, [g["id"] for g in proposal["groups"]])
    change_id = uuid.uuid4().hex
    db.execute("INSERT INTO changes VALUES (?,?,?,?,?,?,'pending',?,NULL)", (
        change_id, work_id, "outline", snapshot["baseVersion"],
        render_markdown(DocumentAST.from_wire(candidate["ast"])),
        parameters["instruction"], time.time()))
    decisions = {g["id"]: "pending" for g in proposal["groups"]}
    db.execute("INSERT INTO director_outline_changes VALUES (?,?,?,?,1,?,?)", (
        change_id, operation_id, canonical(proposal), canonical(parameters["outlineRoot"]),
        snapshot["baseVersion"], canonical(decisions)))
    store._event(db, work_id, "outline.patch_proposed", {"changeId": change_id, "groups": len(decisions)})
    if not decisions:
        # A model may honestly decline an inapplicable request. Preserve its
        # explanation, but never leave a zero-action proposal locking editing.
        db.execute("UPDATE changes SET status='rejected',decided_at=? WHERE id=?", (time.time(), change_id))
    return change_id


def row_for(db: sqlite3.Connection, work_id: str, change_id: str) -> sqlite3.Row:
    row = db.execute("SELECT p.*,c.work_id,c.status FROM director_outline_changes p "
                     "JOIN changes c ON c.id=p.change_id WHERE c.work_id=? AND p.change_id=?",
                     (work_id, change_id)).fetchone()
    if row is None:
        raise ExecutionFault("RESOURCE_GONE", status=404)
    return row


def projection(db: sqlite3.Connection, change_id: str) -> dict | None:
    row = db.execute("SELECT * FROM director_outline_changes WHERE change_id=?", (change_id,)).fetchone()
    if row is None:
        return None
    proposal = json.loads(row["proposal_json"])
    decisions = json.loads(row["decisions_json"])
    accepted = [k for k, v in decisions.items() if v == "accepted"]
    return {"contract": "outline-patch/1.0.0", "revision": row["revision"],
            "headVersion": row["head_version"], "groups": proposal["groups"],
            "hunks": [{**h, "renderedBlocks": [b.model_dump(by_alias=True) for b in replacement_blocks(proposal, h)]}
                      for h in proposal["patch"]["hunks"]], "baseAst": proposal["base"]["baseAst"],
            "decisions": decisions, "acceptedGroupIds": accepted,
            "changeSummary": proposal["patch"]["changeSummary"],
            "unresolvedRequests": proposal["patch"]["unresolvedRequests"],
            "reviews": [{"id": r["id"], "changeRevision": r["change_revision"],
                         "currentValidator": json.loads(r["report_json"]).get("validatorVersion") == AUDIT_VALIDATOR_VERSION,
                         **json.loads(r["report_json"])} for r in db.execute(
                             "SELECT * FROM director_outline_candidate_reviews WHERE change_id=?", (change_id,))]}


def freeze_review(db: sqlite3.Connection, work_id: str, target) -> dict:
    row = row_for(db, work_id, target.change_id)
    if row["status"] != "pending" or row["revision"] != target.change_revision:
        raise ExecutionFault("OUTLINE_REVIEW_HEAD_CHANGED")
    require_unique(target.accept_group_ids, "OUTLINE_DUPLICATE_GROUP")
    decisions = json.loads(row["decisions_json"])
    if any(decisions.get(g) != "pending" for g in target.accept_group_ids):
        raise ExecutionFault("OUTLINE_GROUP_ALREADY_DECIDED")
    accepted = [g for g, state in decisions.items() if state == "accepted"]
    candidate = apply_groups(json.loads(row["proposal_json"]), accepted + target.accept_group_ids)
    return {"changeId": target.change_id, "changeRevision": row["revision"],
            "headVersion": row["head_version"], "candidate": candidate,
            "candidateHash": object_hash(candidate), "acceptGroupIds": target.accept_group_ids,
            "root": json.loads(row["root_json"])}


def review_current(db: sqlite3.Connection, work_id: str, target: dict) -> bool:
    from .schemas.execution import OutlineReviewTarget

    try:
        now = freeze_review(db, work_id, OutlineReviewTarget.from_wire({
            k: target[k] for k in ("changeId", "changeRevision", "acceptGroupIds")}))
        return now == target
    except (ValueError, ExecutionFault):
        return False


def record_review(db: sqlite3.Connection, work_id: str, operation_id: str, target: dict, value: dict) -> dict:
    if not review_current(db, work_id, target):
        raise ExecutionFault("OUTLINE_REVIEW_HEAD_CHANGED")
    report = validate_candidate_audit(value, target["candidate"], source_for_root(target["root"]))
    report["acceptGroupIds"] = target["acceptGroupIds"]
    report_id = uuid.uuid4().hex
    db.execute("INSERT INTO director_outline_candidate_reviews VALUES (?,?,?,?,?,?)", (
        report_id, target["changeId"], operation_id, target["changeRevision"],
        target["candidateHash"], canonical(report)))
    return {"id": report_id, **report}


def decide_groups(db: sqlite3.Connection, store, work_id: str, payload, current: int) -> dict:
    row = row_for(db, work_id, payload.change_id)
    if row["status"] != "pending" or row["revision"] != payload.change_revision or row["head_version"] != current:
        raise ExecutionFault("OUTLINE_REVIEW_HEAD_CHANGED")
    require_unique(payload.group_ids, "OUTLINE_DUPLICATE_GROUP")
    decisions = json.loads(row["decisions_json"])
    if any(decisions.get(g) != "pending" for g in payload.group_ids):
        raise ExecutionFault("OUTLINE_GROUP_ALREADY_DECIDED")
    if db.execute("SELECT 1 FROM director_operations WHERE work_id=? AND status IN ('queued','dispatching','cancel_requested','unknown')", (work_id,)).fetchone():
        raise ExecutionFault("ACTIVE_OPERATION")
    version = current
    if payload.decision == "accept":
        from .schemas.execution import OutlineReviewTarget

        target = freeze_review(db, work_id, OutlineReviewTarget.from_wire({"changeId": payload.change_id,
            "changeRevision": payload.change_revision, "acceptGroupIds": payload.group_ids}))
        saved = db.execute("SELECT * FROM director_outline_candidate_reviews WHERE id=? AND change_id=?",
                           (payload.report_id, payload.change_id)).fetchone()
        if (saved is None or saved["change_revision"] != row["revision"]
                or saved["candidate_hash"] != target["candidateHash"]
                or json.loads(saved["report_json"]).get("validatorVersion") != AUDIT_VALIDATOR_VERSION
                or json.loads(saved["report_json"])["status"] != "reviewed"):
            raise ExecutionFault("OUTLINE_CANDIDATE_REVIEW_REQUIRED")
        store._ensure_writable(db, store._work(db, work_id), "outline", accepted_change_id=payload.change_id)
        ast = DocumentAST.from_wire(target["candidate"]["ast"])
        store._put_document(db, work_id, "outline", render_markdown(ast), current,
                            "accepted_proposal", verified_ast=ast)
        version += 1
    for group_id in payload.group_ids:
        decisions[group_id] = "accepted" if payload.decision == "accept" else "rejected"
    status = "pending" if "pending" in decisions.values() else "accepted" if "accepted" in decisions.values() else "rejected"
    db.execute("UPDATE director_outline_changes SET revision=revision+1,head_version=?,decisions_json=? WHERE change_id=?",
               (version, canonical(decisions), payload.change_id))
    db.execute("UPDATE changes SET status=?,decided_at=? WHERE id=?", (status, None if status == "pending" else time.time(), payload.change_id))
    store._event(db, work_id, "outline.groups_decided", {"changeId": payload.change_id,
        "groupIds": payload.group_ids, "decision": payload.decision, "version": version})
    return projection(db, payload.change_id)
