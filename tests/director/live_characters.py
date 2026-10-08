"""Opt-in character acceptance with one retained request per synthetic case.

Never retries UNKNOWN, adopts drafts or loads user projects. Model responses and
frozen parameters are evidence; a valid schema is not a literary pass.
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

CASES = {
    "silent": {
        "mode": "original",
        "episodes": 1,
        "seconds": 60,
        "facts": "温情默剧，只有林夏和陈伯，两人没有亲属关系，年龄与过去经历未设定。一间修画室。林夏看不清生日纸条，先从陈伯手中接过钥匙，再开盒取出修好的眼镜，戴上才读懂纸条并微笑致谢。陈伯不替她开盒。钥匙开锁后留桌上，纸条与盒子一直在桌上。无人说话，无旁白，不增加反派、爱情、退休或死亡背景。本集闭合。",
    },
    "workplace": {
        "mode": "original",
        "episodes": 2,
        "seconds": 180,
        "facts": "只有周宁、许澈、唐敏。第1集：初级设计师周宁说话简短、会反复确认数字；主管许澈用‘按流程’推迟给她确认；客户经理唐敏用具体交付时间问责。周宁为查清版本主动保留导出记录，但因此错过内部评选报名。第2集：周宁拿时间戳说明许澈覆盖了已确认设计，要求唐敏当面签认；许澈承认覆盖但不道歉；唐敏选择签认并承担延期说明。周宁保住客户交付，仍失去本次评选资格。不加爱情/亲属关系/隐藏老板，不补年龄外貌，不把口头威胁当已发生代价。",
    },
    "adaptation": {
        "mode": "adaptation",
        "episodes": 1,
        "seconds": 120,
        "facts": "原作第02集：只有林夏和陈伯在修画室。两人非亲属，年龄未知。林夏沉默地用蓝色手电找到《归舟》画框中的银钥匙，交给陈伯。陈伯开盒取信，念：‘天亮前，把画送到桥头。’信作者未揭晓，未确认任何人死亡。陈伯将《春山》交给林夏；林夏抱《春山》离开，《归舟》仍挂墙上。陈伯保留钥匙与旧信。仍是夜晚，未拍到桥头。只保留原作已呈现的性格和知情边界，不添加人物、身份、关系或对白。",
    },
}


def save(path: Path, value) -> None:
    path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


async def validate(root: Path, case_name: str) -> dict:
    root.mkdir(parents=True, exist_ok=False)
    case = CASES[case_name]
    store = DirectorStore(root / "isolated-project")
    repo = ExecutionRepository(store)
    service = ExecutionService(repo)
    adaptation = case["mode"] == "adaptation"
    creation = CreateWork(
        title=f"Synthetic character acceptance: {case_name}",
        brief=case["facts"],
        source_text=case["facts"] if adaptation else "",
        preset=DirectorPreset(
            mode=case["mode"],
            adapt_direction="condense" if adaptation else None,
            episode_count=case["episodes"],
            duration_seconds=case["seconds"],
            locked_facts=case["facts"],
            source_episode_label="EP02" if adaptation else "",
            delivery_episode_label="EP02" if adaptation else "",
        ),
    )
    work = store.create_work(creation)
    store.put_document(work["id"], "outline", "# 已确认故事大纲\n\n" + case["facts"], 0)
    save(root / "input.json", creation.model_dump())

    def send(payload):
        intent = identifier()
        command = ExecutionCommand.from_wire(
            {
                "schemaVersion": 2,
                "commandId": intent,
                "clientRequestId": intent,
                "sessionId": "bounded-character-validation",
                "workId": work["id"],
                "expected": {
                    "workRevision": store.get_work(work["id"])["revision"],
                    "documentVersions": {"characters": 0},
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
            "kind": "characters",
            "maxOutputTokens": 8192,
            "instruction": "按照人物小传合同整理全部既有人物；严格服从已确认大纲，不补未设定事实。主次分层但不得遗漏角色；用具体行动区分人物，沉默角色不编对白。",
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
        {"systemPrompt": PLANNING_SYSTEM, "snapshot": snapshot, "maxCalls": 1},
    )
    started = time.monotonic()
    result = await dispatch_writing(repo, work["id"], operation["id"])
    save(
        root / "response.json",
        {
            "result": result,
            "retained": repo.retained_result(work["id"], operation["id"]),
        },
    )
    changes = store.list_changes(work["id"])
    if changes:
        (root / "characters.md").write_text(changes[0]["content"], encoding="utf-8")
    summary = {
        "case": case_name,
        "status": result["status"],
        "usage": result.get("response", {}).get("usage"),
        "seconds": round(time.monotonic() - started, 2),
        "actualCost": None,
        "calls": 1,
        "automaticRetries": 0,
        "adopted": False,
        "literaryQuality": "requires-human-review",
    }
    save(root / "summary.json", summary)
    print(json.dumps(summary, ensure_ascii=False), flush=True)
    return summary


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--accept-bounded-cost", action="store_true")
    parser.add_argument("--case", choices=CASES, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if not args.accept_bounded_cost:
        parser.error(
            "Explicit consent required: one call, 8192 requested output tokens; reasoning may be billed separately"
        )
    asyncio.run(validate(args.output, args.case))
