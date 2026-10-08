"""Opt-in, resumable production-path Seed experiment; no provider bypass or retry.

Each action requires explicit invocation. A failed or unknown operation stops
the pump. Every request/response is retained before the next paid step starts.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import time
from pathlib import Path

from novelvideo.director.dispatch import dispatch_writing
from novelvideo.director.execution import execution_capability
from novelvideo.director.execution_repository import ExecutionRepository, identifier
from novelvideo.director.models import CreateWork, DirectorPreset
from novelvideo.director.schemas.planning import WorkflowCommand
from novelvideo.director.store import DirectorStore
from novelvideo.director.workflow import WorkflowService


def save(path: Path, value: object) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


async def run(root: Path, inputs: Path, action: str, group_index: int = 0) -> dict:
    os.environ["DIRECTOR_OUTLINE_V3"] = "1"
    if action == "direction":
        root.mkdir(parents=True, exist_ok=False)
    store = DirectorStore(root / "state")
    repo = ExecutionRepository(store)
    service = WorkflowService(repo)
    if action == "direction":
        source = (inputs / "summary.md").read_text()
        brief = (inputs / "brief.txt").read_text()
        direction = (inputs / "direction.txt").read_text()
        preset = DirectorPreset(mode="adaptation", adapt_direction="condense", model_name="ark::doubao-seed-evolving",
            episode_count=1, duration_seconds=600, structure="three_act", ending_type="closed",
            output_language="zh", primary_genre="古典志怪", narrative_tone="克制、诡丽、后怕而回甘",
            locked_facts=direction, fidelity="strict")
        command = CreateWork(title="Seed outline v3 comparison", source_text=source, brief=brief, preset=preset)
        work = store.create_work(command)
        save(root / "manifest.json", {"workId": work["id"], "createdAt": time.time(),
             "input": command.model_dump(), "scope": "outline-only; no media; no automatic retries"})
    else:
        work = store.get_work(json.loads((root / "manifest.json").read_text())["workId"])
    work_id = work["id"]

    if action == "export":
        summaries = []
        for operation in reversed(repo.list_operations(work_id)):
            op_root = root / operation["id"]
            op_root.mkdir(exist_ok=True)
            with store._connect() as db:
                snapshot = repo.snapshot(db, operation["id"])
                events = [dict(row) for row in db.execute(
                    "SELECT * FROM director_execution_events WHERE operation_id=? ORDER BY seq", (operation["id"],))]
            # Preserve original experiment outcomes and elapsed measurements.
            if not (op_root / "request.json").exists():
                save(op_root / "request.json", snapshot)
                (op_root / "prompt.txt").write_text(snapshot["prompt"], encoding="utf-8")
            if operation["status"] in {"succeeded", "failed", "unknown", "cancelled"} and not (op_root / "response.json").exists():
                save(op_root / "response.json", {"result": operation,
                    "retained": repo.retained_result(work_id, operation["id"]), "exportedAt": time.time()})
            save(op_root / "events.json", events)
            previews = [e for e in events if e["type"] == "outline.section.preview"]
            summaries.append({"operation": operation["id"], "stage": operation["parameters"].get("stage"),
                "status": operation["status"], "usage": operation["response"].get("usage"),
                "previewEvents": len(previews), "previewFirstAt": previews[0]["created_at"] if previews else None,
                "updatedAt": operation["updatedAt"]})
        save(root / "operation-summary.json", summaries)
        save(root / "browser-current-document.json", store.get_document(work_id, "outline"))
        return {"exported": len(summaries), "latest": summaries[-1]}

    if action in {"patch", "review-partial"}:
        from novelvideo.director.execution import ExecutionService
        from novelvideo.director.schemas.execution import ExecutionCommand

        def execution_send(payload):
            cid = identifier()
            intent = ExecutionCommand.from_wire({"schemaVersion": 2, "commandId": cid,
                "clientRequestId": cid, "sessionId": "seed-outline-parity", "workId": work_id,
                "expected": {"workRevision": store.get_work(work_id)["revision"],
                    "documentVersions": {"outline": store.get_document(work_id, "outline")["version"]},
                    "capabilityVersion": execution_capability()["version"]}, "payload": payload})
            result = ExecutionService(repo).execute("authorized-seed-parity", intent)["result"]
            save(root / f"command-{cid}.json", {"command": intent.model_dump(by_alias=True), "result": result})
            return result

        payload = {"type": "cost.quote", "kind": "outline"}
        if action == "patch":
            payload["instruction"] = (inputs / "revision-compact.txt").read_text()
        else:
            change = next(c for c in store.list_changes(work_id) if c["status"] == "pending")
            patch = change["outlinePatch"]
            groups = [g["id"] for g in patch["groups"] if patch["decisions"][g["id"]] == "pending"]
            if not 0 <= group_index < len(groups):
                raise ValueError("Select an existing pending dependency group before buying review.")
            group = groups[group_index]
            payload.update(purpose="review", reviewTarget={"changeId": change["id"],
                "changeRevision": patch["revision"], "acceptGroupIds": [group]})
        quote = execution_send(payload)
        operation = execution_send({"type": "approval.grant", "quoteId": quote["quoteId"],
            "requestHash": quote["requestHash"], "unknownCostConsent": True})
        operation_id = operation["id"]
        op_root = root / operation_id
        op_root.mkdir(exist_ok=False)
        with store._connect() as db:
            snapshot = repo.snapshot(db, operation_id)
        save(op_root / "request.json", snapshot)
        (op_root / "prompt.txt").write_text(snapshot["prompt"])
        print(json.dumps({"started": operation_id, "action": action}), flush=True)
        began = time.monotonic()
        result = await dispatch_writing(repo, work_id, operation_id)
        save(op_root / "response.json", {"result": result, "retained": repo.retained_result(work_id, operation_id),
            "elapsed": time.monotonic() - began})
        save(root / f"{action}-changes.json", store.list_changes(work_id))
        return {"operation": operation_id, "status": result["status"], "elapsed": round(time.monotonic() - began, 2)}

    def send(payload):
        cid = identifier()
        command = WorkflowCommand.from_wire({"schemaVersion": 2, "commandId": cid,
            "clientRequestId": cid, "sessionId": "seed-outline-parity", "workId": work_id,
            "expected": {"workRevision": store.get_work(work_id)["revision"],
                         "workflowRevision": service.projection(work_id)["revision"],
                         "capabilityVersion": execution_capability()["version"]}, "payload": payload})
        result = service.execute("authorized-seed-parity", command)["result"]
        save(root / f"command-{cid}.json", {"command": command.model_dump(by_alias=True), "result": result})
        return result

    if action == "revalidate":
        result = send({"type": "planning.revalidate"})
        return {"phase": result["phase"], "artifactStages": list(result["artifacts"])}
    if action == "outline":
        state = service.projection(work_id)
        if state["phase"] != "WAIT_DIRECTION":
            raise ValueError("Expected the persisted direction checkpoint; no implicit retry.")
        cp = state["checkpoint"]
        questions = cp["payload"]["specQuestions"]
        answers_path = root / "answers.json"
        if questions and not answers_path.exists():
            save(root / "questions.json", questions)
            return {"phase": "WAIT_DIRECTION", "requiresExplicitAnswers": True}
        answers = json.loads(answers_path.read_text()) if questions else {}
        send({"type": "planning.decide", "checkpointId": cp["id"], "resumeToken": cp["resumeToken"],
              "payloadHash": cp["payloadHash"], "decision": "select", "optionId": None,
              "freeText": (inputs / "direction.txt").read_text(), "answers": answers})
    elif action == "adopt":
        cp = service.projection(work_id)["checkpoint"]
        result = send({"type": "planning.decide", "checkpointId": cp["id"], "resumeToken": cp["resumeToken"],
                       "payloadHash": cp["payloadHash"], "decision": "adopt"})
        save(root / "adopted-document.json", store.get_document(work_id, "outline"))
        return {"phase": result["phase"]}
    elif action == "revise":
        cp = service.projection(work_id)["checkpoint"]
        send({"type": "planning.decide", "checkpointId": cp["id"], "resumeToken": cp["resumeToken"],
              "payloadHash": cp["payloadHash"], "decision": "revise", "freeText": (root / "revision-request.txt").read_text()})
    elif action == "retry-direction":
        state = service.projection(work_id)
        if state["phase"] != "FAILED_RECOVERABLE" or "M03" in state["artifacts"]:
            raise ValueError("Only a known failed direction stage may be explicitly retried.")
    elif action == "retry-outline":
        state = service.projection(work_id)
        if state["phase"] != "FAILED_RECOVERABLE" or "M03" not in state["artifacts"]:
            raise ValueError("Only a known failed outline stage may be explicitly retried.")
    elif action == "continue":
        if service.projection(work_id)["phase"] != "WAIT_COST":
            raise ValueError("Expected an explicit cost checkpoint")
    elif action != "direction":
        raise ValueError("Unknown experiment action")
    quote = send({"type": "planning.quote", "targetScope": "outline", "sourceKind": "curated_summary"})
    send({"type": "planning.grant", "quoteId": quote["quoteId"], "planHash": quote["planHash"],
          "unknownCostConsent": True})
    for _ in range(len(quote["plan"]["stages"])):
        operation_id = service.advance(work_id)
        if operation_id is None:
            break
        op_root = root / operation_id
        op_root.mkdir(exist_ok=False)
        with store._connect() as db:
            snapshot = repo.snapshot(db, operation_id)
        save(op_root / "request.json", snapshot)
        (op_root / "prompt.txt").write_text(snapshot["prompt"], encoding="utf-8")
        print(json.dumps({"started": operation_id, "stage": snapshot["parameters"]["stage"],
                          "maxOutputTokens": snapshot["limits"]["maxOutputTokens"]}), flush=True)
        began = time.monotonic()
        result = await dispatch_writing(repo, work_id, operation_id)
        retained = repo.retained_result(work_id, operation_id)
        save(op_root / "response.json", {"result": result, "retained": retained, "elapsed": time.monotonic() - began})
        print(json.dumps({"finished": operation_id, "status": result["status"] if result else "unclaimed",
                          "elapsed": round(time.monotonic() - began, 2)}), flush=True)
        if result is None or result["status"] != "succeeded":
            break
    service.advance(work_id)
    state = service.projection(work_id)
    save(root / f"{action}-state.json", state)
    with store._connect() as db:
        save(root / f"{action}-events.json", [dict(row) for row in db.execute(
            "SELECT * FROM director_execution_events WHERE work_id=? ORDER BY seq", (work_id,))])
    return {"phase": state["phase"], "errorCode": state["errorCode"], "artifactStages": list(state["artifacts"])}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--inputs", type=Path, required=True)
    parser.add_argument("--action", choices=["direction", "retry-direction", "outline", "retry-outline", "adopt", "revalidate", "continue", "revise", "patch", "review-partial", "export"], required=True)
    parser.add_argument("--allow-paid-model", action="store_true")
    parser.add_argument("--group-index", type=int, default=0)
    args = parser.parse_args()
    if args.action != "export" and not args.allow_paid_model:
        parser.error("--allow-paid-model is required for experiment actions other than read-only export")
    print(json.dumps(asyncio.run(run(args.root, args.inputs, args.action, args.group_index)), ensure_ascii=False))
