"""Opt-in one-call synthetic prop acceptance; preserve evidence, never auto-adopt."""

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
    "handoff": {
        "mode": "original",
        "episodes": 1,
        "seconds": 90,
        "facts": "单集默剧。白天室内修画室，桌上放一张生日纸条和锁盒，盒内是修好的眼镜。林夏看不清纸条，先从陈伯手中接过钥匙，自己在桌前开盒，取出眼镜戴上，随后读懂纸条并微笑。最后林夏戴着眼镜、把钥匙留在桌上，盒与纸条未离开桌面，陈伯没有代开盒。两人无亲属关系、无对白。所有物件的颜色材质、钥匙其他功能、纸条署名和法律所有权均未设定，禁止补写或加新物件、暗线、结尾动作。只整理已确认物件。",
    },
    "two_phones": {
        "mode": "original",
        "episodes": 2,
        "seconds": 180,
        "facts": "两集职场小剧。只整理这些既定事实：第一集周宁用自己的手机收到客户文字‘请核对页脚’，一直自己持有。许澈用自己的另一部手机录下屏幕上静止的页脚，录制完成但没发送；他没有拍到任何改字过程。第二集许澈在原手机回放视频给周宁看，手机仍由许澈持有，视频仍没发送，不能把‘展示’写成转交手机或文件。周宁的手机第二集不出场；周宁拿出首次出现的纸质确认单，与视频核对后本人签字并保留确认单。没有第三人、监控、备份、群发、承认篡改、修复视频。两部手机不得合并，确认单不得提前到第一集。颜色、型号、签字工具未指定，禁止增补物件。",
    },
    "screen_adaptation": {
        "mode": "adaptation",
        "episodes": 1,
        "seconds": 120,
        "facts": "原作EP02，忠实整理。电视只显示一份尚未签字的退学申请书，画面有人握笔但未落笔，不显示签署结果。现实修画室桌上另有一份《借画确认单》，与电视里的申请书不是同一份文件。林夏从《归舟》的画框背面找到银钥匙，递给陈伯，陈伯用它开桌上的锁盒取信，读出‘天亮前把画送到桥头’。随后陈伯把《春山》交给林夏，林夏抱《春山》离开。《归舟》留在原处，陈伯保留信与钥匙。林夏从未拿过信；本集没人触碰或签署《借画确认单》；没有送到桥头、未见收件人，锁盒最后开合状态未交代。不能把未来要求写成完成，不能混淆两幅画、两份文件、屏内/实景物件；无额外科技功能、物件或背景故事。",
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
        title=f"Synthetic prop acceptance: {case_name}",
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
                "sessionId": "bounded-prop-validation",
                "workId": work["id"],
                "expected": {
                    "workRevision": store.get_work(work["id"])["revision"],
                    "documentVersions": {"props": 0},
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
            "kind": "props",
            "maxOutputTokens": 8192,
            "instruction": "按道具设计五项整理已有物件。保持同类不同物、持有人、流转和已发生状态一致，不为填表虚构。首次及关键集次使用宿主ID。",
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
        (root / "props.md").write_text(changes[0]["content"], encoding="utf-8")
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
