"""Opt-in, isolated scene samples: one real call, complete evidence, no retries.

Synthetic stories exercise spatial grounding; schema success is not a literary
pass. Nothing is adopted or finalized and no user project is loaded.
"""

from __future__ import annotations

import argparse
import asyncio
import time
from pathlib import Path

from novelvideo.director.dispatch import dispatch_writing
from novelvideo.director.execution import ExecutionService, execution_capability
from novelvideo.director.execution_repository import ExecutionRepository, identifier
from novelvideo.director.models import CreateWork, DirectorPreset
from novelvideo.director.planning import PLANNING_SYSTEM
from novelvideo.director.schemas.execution import ExecutionCommand
from novelvideo.director.store import DirectorStore
from tests.director.live_characters import save

CASES = {
    "silent": {
        "mode": "original",
        "episodes": 1,
        "seconds": 60,
        "facts": "一集温情默剧，只在室内修画室，白天。桌上始终放纸条和锁盒，盒里是修好的眼镜。林夏看不清纸条，先从陈伯手中接钥匙，再在桌前开盒取眼镜，戴上才读懂纸条并微笑致谢。陈伯不替她开盒。钥匙用后留桌上。两人无亲属关系，无对白。门窗方位与入口未设定，禁止增设布局与新地点，不加反派、背景或重复到访。",
    },
    "workplace": {
        "mode": "original",
        "episodes": 2,
        "seconds": 180,
        "facts": "两集职场剧。第1集白天：会议室内长桌上放确认单，门关闭，周宁先从桌前起身开门，才进入室内走廊；走廊拐角有纸箱，遮挡她与许澈的视线，许澈绕过纸箱递给她导出记录。第2集白天：两人回同一会议室，在同一长桌前用导出记录核对确认单，许澈签字后，周宁拿确认单开门离开。结尾她独自走到室外露天院子，只握紧确认单。院子只有这一次出现，布局未定。不加办公室、监控、保安、秘密通道、雨夜、爱情、亲属或第三人；不能让关闭的门无需动作就被穿过。",
    },
    "adaptation": {
        "mode": "adaptation",
        "episodes": 1,
        "seconds": 120,
        "facts": "原作EP02：夜晚，只在室内修画室。桌、锁盒在室内，画《归舟》始终挂墙上。林夏以蓝色手电在《归舟》画框里找到银钥匙，交给陈伯；陈伯站桌前开盒取信，读‘天亮前把画送到桥头’，随后把《春山》交给林夏。林夏抱《春山》从门离开，陈伯保留信与钥匙。没有拍到桥头，没有进入室外。角落电视静音播放火车车厢内无人空座，车厢只存在于电视画面，角色从未进入。门朝向、窗户、走廊均未设定，禁止增补。不新增场所实景、不把信中桥头变成已发生的行动、不混淆两幅画。",
    },
}


async def validate(root: Path, case_name: str) -> dict:
    root.mkdir(parents=True, exist_ok=False)
    case = CASES[case_name]
    adaptation = case["mode"] == "adaptation"
    store = DirectorStore(root / "isolated-project")
    repo = ExecutionRepository(store)
    service = ExecutionService(repo)
    creation = CreateWork(
        title=f"Synthetic scene acceptance: {case_name}",
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
        cmd = ExecutionCommand.from_wire(
            {
                "schemaVersion": 2,
                "commandId": intent,
                "clientRequestId": intent,
                "sessionId": "bounded-scene-validation",
                "workId": work["id"],
                "expected": {
                    "workRevision": store.get_work(work["id"])["revision"],
                    "documentVersions": {"scenes": 0},
                    "capabilityVersion": execution_capability()["version"],
                },
                "payload": payload,
            }
        )
        result = service.execute("authorized-live-validation", cmd)["result"]
        save(
            root / (payload["type"].replace(".", "-") + ".json"),
            {"command": cmd.model_dump(by_alias=True), "result": result},
        )
        return result

    quote = send(
        {
            "type": "cost.quote",
            "kind": "scenes",
            "maxOutputTokens": 8192,
            "instruction": "按场景设计五项合同整理已有空间，场景齐全且具体。严格保留行动因果与空间未知项，不为填表虚构。引用场所与实际到访分别标明；关键集次使用宿主集次。",
        }
    )
    op = send(
        {
            "type": "approval.grant",
            "quoteId": quote["quoteId"],
            "requestHash": quote["requestHash"],
            "unknownCostConsent": True,
        }
    )
    with store._connect() as db:
        snapshot = repo.snapshot(db, op["id"])
    save(
        root / "request.json",
        {
            "systemPrompt": PLANNING_SYSTEM,
            "snapshot": snapshot,
            "maxCalls": 1,
            "maxOutputTokens": 8192,
        },
    )
    started = time.monotonic()
    result = await dispatch_writing(repo, work["id"], op["id"])
    save(
        root / "response.json",
        {"result": result, "retained": repo.retained_result(work["id"], op["id"])},
    )
    changes = store.list_changes(work["id"])
    if changes:
        (root / "scenes.md").write_text(changes[0]["content"], encoding="utf-8")
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
    print(summary, flush=True)
    return summary


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--accept-bounded-cost", action="store_true")
    parser.add_argument("--case", choices=CASES, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if not args.accept_bounded_cost:
        parser.error(
            "Explicit consent required: one call, 8192 output tokens; actual cost unknown"
        )
    asyncio.run(validate(args.output, args.case))
