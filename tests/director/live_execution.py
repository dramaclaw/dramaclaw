"""Opt-in paid acceptance, never collected by pytest; synthetic stories only.

Three bounded intents use the production approval/dispatch path. An existing
receipt directory is never reused, so rerunning cannot silently buy retries.
Headers, secrets, provider URLs and exception strings are not recorded.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sqlite3
import time
from pathlib import Path

from novelvideo.director.dispatch import dispatch_writing
from novelvideo.director.execution import ExecutionService, execution_capability
from novelvideo.director.execution_repository import ExecutionRepository, identifier
from novelvideo.director.models import CreateWork, DirectorPreset
from novelvideo.director.schemas.execution import ExecutionCommand
from novelvideo.director.store import DirectorStore
from novelvideo.director.writing import SYSTEM_PROMPT
from novelvideo.director.quality import QualityService, REVIEW_SYSTEM


SOURCE = """《两幅画》原作第02集。仅有林夏和陈伯，不存在亲属关系。
夜晚，修画室内。两幅不同的画：P1《春山》在陈伯手里，P2《归舟》挂在墙上。
停电后林夏拿出蓝色手电，照向《归舟》，发现画框内的银钥匙。
林夏把钥匙交给陈伯。陈伯用钥匙打开铁盒，取出一封旧信，念道：“天亮前，把画送到桥头。”
陈伯把《春山》交给林夏，《归舟》仍挂墙上。林夏抱着《春山》离开修画室，仍是夜晚。
本集到这里结束。未揭示旧信作者，也未确认任何人死亡。
"""
BASE = """# 第02集《两幅画》
## 场1 修画室 内 夜
林夏用蓝色手电照向墙上的《归舟》，从画框取出银钥匙，交给陈伯。
陈伯以钥匙打开铁盒，取出旧信。
陈伯：“天亮前，把画送到桥头。”
## 场2 修画室门口 外 夜
陈伯把《春山》交给林夏。《归舟》仍在室内墙上。
林夏抱着《春山》离开。银钥匙和旧信留在陈伯手里。
"""


def save(path: Path, value: dict) -> None:
    path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


async def validate(root: Path, selected_case: str | None = None) -> None:
    # Refuse an existing run before loading provider configuration or creating DBs.
    root.mkdir(parents=True, exist_ok=False)
    store = DirectorStore(root / "isolated-project")
    repo = ExecutionRepository(store)
    service = ExecutionService(repo)
    cases = [
        (
            "original",
            "original",
            "一集30秒，温情默剧，仅林夏和陈伯，一间修画室、一把钥匙。林夏找钥匙打开盒子，里面是陈伯补好的旧眼镜；本集完结，不开第二集。",
            "写本集完整剧本，控制在180个汉字以内，2场以内，无旁白。不要重复列出参数表。",
            "",
        ),
        (
            "adaptation",
            "adaptation",
            "把原作第02集改为一个90秒交付件，保留原作第02集标题。忠于所有关键事实。",
            "保留来源中的因果、两幅画的区别、钥匙交接、夜晚规则及指定台词；未确认身份不可补为事实。300至450汉字，明确区分新增动作。",
            "",
        ),
        (
            "revision",
            "adaptation",
            "把原作第02集改为一个90秒交付件，保留所有既有事实。",
            "仅在场1中给林夏发现钥匙前加一个犹豫后行动的可拍动作。严格保持场2所有文字逐字不变，陈伯台词逐字不变，不改任何物件归属。输出完整修订稿。",
            BASE,
        ),
    ]
    summary = []
    for label, mode, brief, instruction, existing in cases:
        if selected_case and label != selected_case:
            continue
        work = store.create_work(
            CreateWork(
                title=f"Real model acceptance: {label}",
                brief=brief,
                source_text=SOURCE if mode == "adaptation" else "",
                preset=DirectorPreset(
                    mode=mode,
                    episode_count=1,
                    duration_seconds=30 if mode == "original" else 90,
                    primary_genre="温情现实",
                    structure="three_act",
                    adapt_direction="condense" if mode == "adaptation" else None,
                    source_episode_label="第02集" if mode == "adaptation" else "",
                    delivery_episode_label="第02集" if mode == "adaptation" else "",
                ),
            )
        )
        version = 0
        if existing:
            version = store.put_document(work["id"], "episode-001", existing, 0)[
                "version"
            ]
        work = store.get_work(work["id"])

        def command(payload: dict) -> ExecutionCommand:
            intent = identifier()
            return ExecutionCommand.from_wire(
                {
                    "schemaVersion": 2,
                    "commandId": intent,
                    "clientRequestId": intent,
                    "sessionId": "bounded-real-validation",
                    "workId": work["id"],
                    "expected": {
                        "workRevision": work["revision"],
                        "documentVersions": {"episode-001": version},
                        "capabilityVersion": execution_capability()["version"],
                    },
                    "payload": payload,
                }
            )

        preview_command = command(
            {
                "type": "cost.quote",
                "kind": "episode",
                "episodeOrdinal": 1,
                "instruction": instruction,
                "maxOutputTokens": 4096,
            }
        )
        quote = service.execute("authorized-live-validation", preview_command)["result"]
        approval_command = command(
            {
                "type": "approval.grant",
                "quoteId": quote["quoteId"],
                "requestHash": quote["requestHash"],
                "unknownCostConsent": True,
            }
        )
        run = service.execute("authorized-live-validation", approval_command)["result"]
        with store._connect() as db:
            frozen = repo.snapshot(db, run["id"])
        evidence = {
            "case": label,
            "systemPrompt": SYSTEM_PROMPT,
            "snapshot": frozen,
            "quote": quote,
            "command": approval_command.model_dump(by_alias=True),
            "startedAt": time.time(),
            "status": "queued",
        }
        save(root / f"{label}.json", evidence)
        result = await dispatch_writing(repo, work["id"], run["id"])
        with store._connect() as db:
            output = db.execute(
                "SELECT output_text FROM director_operations WHERE id=?", (run["id"],)
            ).fetchone()[0]
        evidence.update(
            {
                "finishedAt": time.time(),
                "result": result,
                "output": output,
                "status": result["status"],
            }
        )
        # These are narrow deterministic checks, not semantic or timing guarantees.
        assertions = {
            "candidateOnly": store.get_document(work["id"], "episode-001")["version"]
            == version,
            "nonempty": bool(output),
            "singleProviderRequest": result["response"].get("usage", {}).get("requests")
            == 1,
        }
        if mode == "adaptation":
            assertions.update(
                {
                    "protectedDialoguePresent": bool(
                        output and "天亮前，把画送到桥头。" in output
                    ),
                    "bothPaintingNamesPresent": bool(
                        output and "《春山》" in output and "《归舟》" in output
                    ),
                    "sourceLabelPresent": bool(output and "02集" in output),
                }
            )
        if label == "revision":
            assertions["outsideSceneUnchanged"] = bool(
                output and BASE.split("## 场2", 1)[1].strip() in output
            )
        evidence["assertions"] = assertions
        save(root / f"{label}.json", evidence)
        item = {
            "case": label,
            "status": result["status"],
            "elapsedSeconds": round(evidence["finishedAt"] - evidence["startedAt"], 2),
            "usage": result["response"].get("usage"),
            "assertions": assertions,
        }
        summary.append(item)
        save(
            root / "summary.json",
            {"results": summary, "actualAmount": None, "noAutomaticRetries": True},
        )
        print(json.dumps(item, ensure_ascii=False), flush=True)
        if result["status"] == "unknown":
            print(
                "Stopped: unknown provider result; no automatic retries or further paid calls.",
                flush=True,
            )
            break


async def validate_reviews(
    root: Path, originals: Path, selected_case: str | None = None
) -> None:
    """Buy only independent reviews of preserved synthetic samples, never rewrite them."""
    source_db = originals / "isolated-project/director/studio.sqlite3"
    if not source_db.is_file():
        raise ValueError("SYNTHETIC_RECEIPTS_REQUIRED")
    # Validate all evidence before a provider call and refuse to reuse an output.
    cases = []
    with sqlite3.connect(f"file:{source_db.resolve()}?mode=ro", uri=True) as db:
        db.row_factory = sqlite3.Row
        for label in ("original", "adaptation", "revision"):
            if selected_case and label != selected_case:
                continue
            receipt = json.loads(
                (originals / f"{label}.json").read_text(encoding="utf-8")
            )
            old = db.execute(
                "SELECT * FROM works WHERE id=?", (receipt["command"]["workId"],)
            ).fetchone()
            if (
                not old
                or not old["title"].startswith("Real model acceptance:")
                or not receipt.get("output")
            ):
                raise ValueError("NON_SYNTHETIC_OR_EMPTY_RECEIPT")
            base = db.execute(
                "SELECT content FROM document_versions WHERE work_id=? AND doc_key='episode-001' ORDER BY version DESC LIMIT 1",
                (old["id"],),
            ).fetchone()
            cases.append((label, dict(old), receipt, base[0] if base else ""))
    root.mkdir(parents=True, exist_ok=False)
    store = DirectorStore(root / "isolated-project")
    repo = ExecutionRepository(store)
    service = ExecutionService(repo)
    summary = []
    for label, old, receipt, base in cases:
        work = store.create_work(
            CreateWork(
                title=f"Independent review: {label}",
                brief=old["brief"],
                source_text=old["source_text"],
                preset=DirectorPreset.model_validate_json(old["preset_json"]),
            )
        )
        version = (
            store.put_document(work["id"], "episode-001", base, 0)["version"]
            if base
            else 0
        )
        change = store.propose_change(
            work["id"],
            "episode-001",
            receipt["output"],
            version,
            receipt["snapshot"]["parameters"]["instruction"],
        )
        store.decide_change(work["id"], change["id"], True)
        version += 1
        work = store.get_work(work["id"])

        def command(payload):
            key = identifier()
            return ExecutionCommand.from_wire(
                {
                    "schemaVersion": 2,
                    "commandId": key,
                    "clientRequestId": key,
                    "sessionId": "bounded-independent-review",
                    "workId": work["id"],
                    "expected": {
                        "workRevision": work["revision"],
                        "documentVersions": {"episode-001": version},
                        "capabilityVersion": execution_capability()["version"],
                    },
                    "payload": payload,
                }
            )

        quote = service.execute(
            "authorized-live-validation",
            command(
                {
                    "type": "cost.quote",
                    "kind": "episode",
                    "episodeOrdinal": 1,
                    "purpose": "review",
                    "instruction": "",
                    "maxOutputTokens": 4096,
                }
            ),
        )["result"]
        approval = command(
            {
                "type": "approval.grant",
                "quoteId": quote["quoteId"],
                "requestHash": quote["requestHash"],
                "unknownCostConsent": True,
            }
        )
        run = service.execute("authorized-live-validation", approval)["result"]
        with store._connect() as db:
            snapshot = repo.snapshot(db, run["id"])
        evidence = {
            "case": label,
            "systemPrompt": REVIEW_SYSTEM,
            "snapshot": snapshot,
            "quote": quote,
            "command": approval.model_dump(by_alias=True),
            "startedAt": time.time(),
            "status": "queued",
        }
        save(root / f"{label}.json", evidence)
        result = await dispatch_writing(repo, work["id"], run["id"])
        evidence.update(
            {
                "finishedAt": time.time(),
                "result": result,
                "output": repo.retained_result(work["id"], run["id"])["output"],
                "status": result["status"],
                "quality": QualityService(store).report(work["id"], 1),
            }
        )
        save(root / f"{label}.json", evidence)
        item = {
            "case": label,
            "status": result["status"],
            "reviewStatus": (evidence["quality"]["review"] or {}).get("status"),
            "elapsedSeconds": round(evidence["finishedAt"] - evidence["startedAt"], 2),
            "usage": result["response"].get("usage"),
            "checks": [
                {"id": c["id"], "status": c["status"]}
                for c in (evidence["quality"]["review"] or {}).get("checks", [])
            ],
        }
        summary.append(item)
        save(
            root / "summary.json",
            {"results": summary, "actualAmount": None, "noAutomaticRetries": True},
        )
        print(json.dumps(item, ensure_ascii=False), flush=True)
        if result["status"] == "unknown":
            break


async def validate_preparation(root: Path) -> None:
    """At most four fresh requests; stop on any failure, retaining every response."""
    from novelvideo.director.planning import PLANNING_SYSTEM
    from novelvideo.director.schemas.planning import WorkflowCommand
    from novelvideo.director.workflow import WorkflowService

    root.mkdir(parents=True, exist_ok=False)
    store = DirectorStore(root / "isolated-project")
    repo = ExecutionRepository(store)
    service = WorkflowService(repo)
    work = store.create_work(
        CreateWork(
            title="Synthetic real preparation validation",
            brief="一集30秒温情默剧。只有林夏和陈伯，一间修画室。林夏从陈伯手里接钥匙，打开盒子取出修好的旧眼镜，戴上眼镜读一张写着生日快乐的纸条，向陈伯微笑致谢。本集完结，不开第二集。不加台词、旁白、第三个人、支线或新地点。",
            preset=DirectorPreset(
                mode="original",
                episode_count=1,
                duration_seconds=30,
                primary_genre="温情现实",
                structure="three_act",
            ),
        )
    )
    receipts, intents = [], []

    def send(payload):
        command = WorkflowCommand.from_wire(
            {
                "schemaVersion": 2,
                "commandId": identifier(),
                "clientRequestId": identifier(),
                "sessionId": "bounded-planning-validation",
                "workId": work["id"],
                "expected": {
                    "workRevision": store.get_work(work["id"])["revision"],
                    "workflowRevision": service.projection(work["id"])["revision"],
                    "capabilityVersion": execution_capability()["version"],
                },
                "payload": payload,
            }
        )
        result = service.execute("authorized-live-validation", command)["result"]
        intents.append({"command": command.model_dump(by_alias=True), "result": result})
        save(root / "commands.json", {"commands": intents})
        return result

    def summary():
        state = service.projection(work["id"])
        save(
            root / "summary.json",
            {
                "results": receipts,
                "planning": state,
                "actualAmount": None,
                "noAutomaticRetries": True,
                "formalAdoptionPerformed": False,
                "qualityAcceptance": "not-certified",
            },
        )
        return state

    for group in ("direction", "preparation"):
        quote = send({"type": "planning.quote", "maxOutputTokens": 4096})
        send(
            {
                "type": "planning.grant",
                "quoteId": quote["quoteId"],
                "planHash": quote["planHash"],
                "unknownCostConsent": True,
            }
        )
        for _ in range(1 if group == "direction" else 3):
            operation_id = service.advance(work["id"])
            if not operation_id:
                summary()
                return
            with store._connect() as db:
                frozen = repo.snapshot(db, operation_id)
            stage = frozen["parameters"]["stage"]
            evidence = {
                "stage": stage,
                "systemPrompt": PLANNING_SYSTEM,
                "snapshot": frozen,
                "quote": quote,
                "startedAt": time.time(),
                "status": "queued",
            }
            save(root / f"{stage}.json", evidence)
            result = await dispatch_writing(repo, work["id"], operation_id)
            evidence.update(
                {
                    "finishedAt": time.time(),
                    "result": result,
                    "output": repo.retained_result(work["id"], operation_id)["output"],
                    "status": result["status"] if result else "not-dispatched",
                }
            )
            save(root / f"{stage}.json", evidence)
            receipt = {
                "stage": stage,
                "status": evidence["status"],
                "elapsedSeconds": round(
                    evidence["finishedAt"] - evidence["startedAt"], 2
                ),
                "usage": (result or {}).get("response", {}).get("usage"),
            }
            receipts.append(receipt)
            print(json.dumps(receipt, ensure_ascii=False), flush=True)
            if not result or result["status"] != "succeeded":
                service.advance(work["id"])
                summary()
                return
        service.advance(work["id"])
        state = summary()
        if group == "direction":
            checkpoint = state["checkpoint"]
            if state["phase"] != "WAIT_DIRECTION":
                return
            # An explicit human-equivalent synthetic choice, not a production
            # default: no real user's unanswered question is approved here.
            payload = checkpoint["payload"]
            send(
                {
                    "type": "planning.decide",
                    "checkpointId": checkpoint["id"],
                    "resumeToken": checkpoint["resumeToken"],
                    "payloadHash": checkpoint["payloadHash"],
                    "decision": "select",
                    "optionId": payload["options"][0]["id"],
                    **({
                        "episodeCount": payload["confirmedPreset"]["episodeCount"],
                        "durationSeconds": payload["confirmedPreset"]["durationSeconds"],
                    } if "confirmedPreset" in payload else {}),
                    "freeText": "只在表情、镜头强调和动作节奏上变化，严格保留原创意所有事实；不要扩充剧情。",
                    "answers": {
                        q[
                            "id"
                        ]: "以已确认的一集30秒温情默剧要求为准，不增加人物地点支线。"
                        for q in payload["specQuestions"]
                    },
                }
            )
    summary()


async def resume_failed_preparation(root: Path) -> None:
    """Explicitly buy only the failed M09 child; keep the three successful receipts."""
    from novelvideo.director.schemas.planning import WorkflowCommand
    from novelvideo.director.workflow import WorkflowService

    summary_path = root / "summary.json"
    retry_path = root / "M09-resume-01.json"
    if not summary_path.is_file() or retry_path.exists():
        raise ValueError("RESUME_RECEIPT_MISSING_OR_ALREADY_USED")
    previous = json.loads(summary_path.read_text(encoding="utf-8"))
    if [(item["stage"], item["status"]) for item in previous["results"]] != [
        ("M03", "succeeded"), ("M07", "succeeded"), ("M08", "succeeded"),
        ("M09", "failed"),
    ]:
        raise ValueError("ONLY_FAILED_M09_CAN_RESUME")
    store = DirectorStore(root / "isolated-project")
    repo = ExecutionRepository(store)
    service = WorkflowService(repo)
    work_id = previous["planning"]["workId"]
    work = store.get_work(work_id)
    state = service.projection(work_id)
    if work["title"] != "Synthetic real preparation validation" or state["phase"] != "FAILED_RECOVERABLE":
        raise ValueError("RESUME_WORK_MISMATCH")
    intents = []

    def send(payload):
        current = service.projection(work_id)
        key = identifier()
        command = WorkflowCommand.from_wire({
            "schemaVersion": 2, "commandId": key, "clientRequestId": key,
            "sessionId": "bounded-planning-validation", "workId": work_id,
            "expected": {"workRevision": store.get_work(work_id)["revision"],
                         "workflowRevision": current["revision"],
                         "capabilityVersion": execution_capability()["version"]},
            "payload": payload,
        })
        result = service.execute("authorized-live-validation", command)["result"]
        intents.append({"command": command.model_dump(by_alias=True), "result": result})
        save(root / "resume-commands.json", {"commands": intents})
        return result

    quote = send({"type": "planning.quote", "maxOutputTokens": 4096})
    if quote["plan"]["stages"] != ["M09"]:
        raise ValueError("RESUME_WOULD_REBUY_SUCCESSFUL_STAGE")
    send({"type": "planning.grant", "quoteId": quote["quoteId"],
          "planHash": quote["planHash"], "unknownCostConsent": True})
    operation_id = service.advance(work_id)
    with store._connect() as db:
        frozen = repo.snapshot(db, operation_id)
    if frozen["parameters"]["stage"] != "M09":
        raise ValueError("RESUME_STAGE_MISMATCH")
    evidence = {"stage": "M09", "snapshot": frozen, "quote": quote,
                "startedAt": time.time(), "status": "queued"}
    save(retry_path, evidence)
    result = await dispatch_writing(repo, work_id, operation_id)
    evidence.update({"finishedAt": time.time(), "result": result,
                     "output": repo.retained_result(work_id, operation_id)["output"],
                     "status": result["status"]})
    save(retry_path, evidence)
    if result["status"] == "succeeded":
        service.advance(work_id)
    save(root / "resume-summary.json", {
        "results": [{"stage": "M09", "status": result["status"],
                     "elapsedSeconds": round(evidence["finishedAt"] - evidence["startedAt"], 2),
                     "usage": result["response"].get("usage")}],
        "planning": service.projection(work_id), "actualAmount": None,
        "noAutomaticRetries": True, "formalAdoptionPerformed": False,
        "qualityAcceptance": "not-certified",
    })
    print(json.dumps({"stage": "M09", "status": result["status"],
                      "elapsedSeconds": round(evidence["finishedAt"] - evidence["startedAt"], 2),
                      "usage": result["response"].get("usage")}, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--accept-bounded-cost", action="store_true")
    parser.add_argument("--review-existing", type=Path)
    parser.add_argument("--planning", action="store_true")
    parser.add_argument("--resume-planning", type=Path)
    parser.add_argument("--case", choices=("original", "adaptation", "revision"))
    parser.add_argument(
        "--output", type=Path, default=Path("output/playwright/director-live-20260926")
    )
    args = parser.parse_args()
    if not args.accept_bounded_cost:
        parser.error(
            "explicit --accept-bounded-cost required: at most 4 planning or 3 writing/review requests, 4096 output tokens each"
        )
    if args.planning and (args.review_existing or args.case or args.resume_planning):
        parser.error("--planning cannot be combined with --review-existing or --case")
    if args.resume_planning and (args.review_existing or args.case):
        parser.error("--resume-planning cannot be combined with other cases")
    asyncio.run(
        resume_failed_preparation(args.resume_planning)
        if args.resume_planning
        else validate_preparation(args.output)
        if args.planning
        else validate_reviews(args.output, args.review_existing, args.case)
        if args.review_existing
        else validate(args.output, args.case)
    )
