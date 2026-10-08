"""One opt-in real outline request; never collected by pytest or retried.

Uses production quote/grant/dispatch with an isolated synthetic project. Full
model input/content and usage are retained locally, not headers or credentials.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import time
from pathlib import Path

from novelvideo.director.dispatch import dispatch_writing
from novelvideo.director.execution import ExecutionService, execution_capability
from novelvideo.director.execution_repository import ExecutionRepository, identifier
from novelvideo.director.models import CreateWork, DirectorPreset
from novelvideo.director.planning import PLANNING_SYSTEM
from novelvideo.director.schemas.execution import ExecutionCommand
from novelvideo.director.store import DirectorStore


def save(path: Path, value: dict) -> None:
    path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


async def validate(
    root: Path, *, case: dict | None = None, max_output_tokens: int = 8192
) -> dict:
    root.mkdir(parents=True, exist_ok=False)
    store = DirectorStore(root / "isolated-project")
    repo = ExecutionRepository(store)
    service = ExecutionService(repo)
    brief = "一集30秒温情默剧。只有林夏和陈伯，两人无亲属关系，一间修画室。林夏看不清生日纸条；先从陈伯手里接钥匙，打开盒子取出修好的旧眼镜，戴上眼镜，才读到纸条上的生日快乐，向陈伯微笑致谢。钥匙开锁后放在桌上，纸条与盒子始终在桌上。本集完结，不开第二集。不加台词、旁白、第三个人、支线、新地点或退休/生死背景。"
    command = CreateWork(
        title="Synthetic outline element acceptance",
        brief=brief,
        preset=DirectorPreset(
            mode="original",
            episode_count=1,
            duration_seconds=30,
            primary_genre="温情现实",
            narrative_tone="克制、温暖、无对白",
            structure="three_act",
            locked_facts=brief,
        ),
    )
    instruction = "生成完整故事大纲，按实际适用性填写所有要素，不把一次赠礼夸大成身份反转。保留全部动作因果、物件位置和约束。"
    if case is not None:
        command = CreateWork.model_validate(case["work"])
        instruction = case["instruction"]
    save(root / "input.json", command.model_dump())
    work = store.create_work(command)

    def send(payload):
        intent = identifier()
        command = ExecutionCommand.from_wire(
            {
                "schemaVersion": 2,
                "commandId": intent,
                "clientRequestId": intent,
                "sessionId": "bounded-outline-validation",
                "workId": work["id"],
                "expected": {
                    "workRevision": work["revision"],
                    "documentVersions": {"outline": 0},
                    "capabilityVersion": execution_capability()["version"],
                },
                "payload": payload,
            }
        )
        result = service.execute("authorized-live-validation", command)["result"]
        save(
            root / (payload["type"].replace(".", "-") + ".json"),
            {"command": command.model_dump(by_alias=True), "result": result},
        )
        return result

    quote = send(
        {
            "type": "cost.quote",
            "kind": "outline",
            "maxOutputTokens": max_output_tokens,
            "instruction": instruction,
        }
    )
    operation = send(
        {
            "type": "approval.grant",
            "quoteId": quote["quoteId"],
            "requestHash": quote["requestHash"],
            "unknownCostConsent": True,
        }
    )
    with store._connect() as db:
        snapshot = repo.snapshot(db, operation["id"])
    save(
        root / "request.json",
        {
            "systemPrompt": PLANNING_SYSTEM,
            "snapshot": snapshot,
            "maxCalls": 1,
            "maxOutputTokens": max_output_tokens,
            "startedAt": time.time(),
        },
    )
    started = time.monotonic()
    result = await dispatch_writing(repo, work["id"], operation["id"])
    retained = repo.retained_result(work["id"], operation["id"])
    save(
        root / "response.json",
        {"result": result, "retained": retained, "finishedAt": time.time()},
    )
    changes = store.list_changes(work["id"])
    if changes:
        (root / "outline.md").write_text(changes[0]["content"], encoding="utf-8")
    summary = {
        "status": result["status"] if result else "not-dispatched",
        "usage": (result or {}).get("response", {}).get("usage"),
        "elapsedSeconds": round(time.monotonic() - started, 2),
        "calls": 1,
        "automaticRetries": 0,
        "actualCost": None,
        "formalAdoptionPerformed": False,
        "literaryQuality": "requires-human-review",
    }
    save(root / "summary.json", summary)
    print(json.dumps(summary, ensure_ascii=False), flush=True)
    return summary


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--accept-bounded-cost", action="store_true")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if not args.accept_bounded_cost:
        parser.error(
            "Explicit --accept-bounded-cost required: one request, requested output ceiling 8192 tokens; billing may include reasoning"
        )
    asyncio.run(validate(args.output))
