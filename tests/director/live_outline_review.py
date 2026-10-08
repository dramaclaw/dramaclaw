"""Opt-in one-call review of a retained synthetic outline; never regenerate it."""

import argparse
import asyncio
import json
import time
from pathlib import Path

from novelvideo.director.dispatch import dispatch_writing
from novelvideo.director.execution import ExecutionService, execution_capability
from novelvideo.director.execution_repository import ExecutionRepository, identifier
from novelvideo.director.schemas.execution import ExecutionCommand
from novelvideo.director.models import CreateWork
from novelvideo.director.outline_review import (
    OUTLINE_REVIEW_SYSTEM,
    outline_quality_report,
)
from novelvideo.director.store import DirectorStore
from tests.director.live_outline import save


async def review(source: Path, output: Path) -> dict:
    original = CreateWork.model_validate_json((source / "input.json").read_text())
    body = (source / "outline.md").read_text()
    output.mkdir(parents=True, exist_ok=False)
    store = DirectorStore(output / "isolated-project")
    work = store.create_work(original)
    store.put_document(work["id"], "outline", body, 0)
    repo = ExecutionRepository(store)
    service = ExecutionService(repo)

    def send(payload):
        request_id = identifier()
        intent = ExecutionCommand.from_wire(
            {
                "schemaVersion": 2,
                "commandId": request_id,
                "clientRequestId": request_id,
                "sessionId": "retained-outline-review",
                "workId": work["id"],
                "expected": {
                    "workRevision": store.get_work(work["id"])["revision"],
                    "documentVersions": {"outline": 1},
                    "capabilityVersion": execution_capability()["version"],
                },
                "payload": payload,
            }
        )
        result = service.execute("authorized-outline-review", intent)["result"]
        save(
            output / (payload["type"].replace(".", "-") + ".json"),
            {"command": intent.model_dump(by_alias=True), "result": result},
        )
        return result

    quote = send(
        {
            "type": "cost.quote",
            "kind": "outline",
            "purpose": "review",
            "maxOutputTokens": 8192,
        }
    )
    run = send(
        {
            "type": "approval.grant",
            "quoteId": quote["quoteId"],
            "requestHash": quote["requestHash"],
            "unknownCostConsent": True,
        }
    )
    with store._connect() as db:
        snapshot = repo.snapshot(db, run["id"])
    save(
        output / "request.json",
        {
            "systemPrompt": OUTLINE_REVIEW_SYSTEM,
            "snapshot": snapshot,
            "maxCalls": 1,
            "startedAt": time.time(),
            "draftRegenerated": False,
        },
    )
    started = time.monotonic()
    result = await dispatch_writing(repo, work["id"], run["id"])
    save(
        output / "response.json",
        {
            "result": result,
            "retained": repo.retained_result(work["id"], run["id"]),
            "finishedAt": time.time(),
        },
    )
    report = outline_quality_report(store, work["id"])
    save(output / "report.json", report)
    summary = {
        "status": result["status"] if result else "not-dispatched",
        "reviewStatus": (report["review"] or {}).get("status"),
        "usage": (result or {}).get("response", {}).get("usage"),
        "elapsedSeconds": round(time.monotonic() - started, 2),
        "actualCost": None,
        "automaticRetries": 0,
        "formalAdoptionPerformed": False,
    }
    save(output / "summary.json", summary)
    print(json.dumps(summary, ensure_ascii=False), flush=True)
    return summary


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--accept-bounded-cost", action="store_true")
    args = parser.parse_args()
    if not args.accept_bounded_cost:
        parser.error(
            "Explicit consent required: one paid review, requested 8192 output tokens, no retry."
        )
    asyncio.run(review(args.source, args.output))
