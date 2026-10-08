"""Opt-in bounded episode calls; keep frozen inputs, deltas, raw answers and receipts."""

import argparse
import asyncio
import time
from pathlib import Path

from novelvideo.director.dispatch import dispatch_writing
from novelvideo.director.execution import ExecutionService
from novelvideo.director.execution_repository import ExecutionRepository
from novelvideo.director.models import CreateWork, DirectorPreset
from novelvideo.director.store import DirectorStore
from novelvideo.director.writing import SYSTEM_PROMPT
from tests.director.live_execution import save
from tests.director.test_streaming import queue_episode

FACTS = "许澈与周宁是同事，无亲属关系。第一集许澈请周宁签确认单，周宁发现页脚日期是明天，拒签，让许澈核对原件。纸在周宁手里，许澈的手机在许澈手里；本集没有承认造假，没有第三个人。第二集两人仍在同一办公室，许澈用自己的手机打开客户原文，发现是客户定时生效日期。周宁对照后签单，把确认单交还许澈，本剧结束；手机不转手。用克制职场对白，不旁白说教，不新增身世、监控、群聊、道具或反派。"
BASE = """# 第1集：明天的日期

## 正文

### 1-1｜办公室 日 / 内

出场人物：许澈、周宁

△ 许澈将确认单递给周宁。周宁看到页脚。

**周宁：**
“日期是明天。你让我今天签？”

**许澈：**
“客户催着要。”

### 1-2｜办公室 日 / 内

△ 周宁没有签字，把确认单留在自己手中。

**周宁：**
“先核对原件。”

△ 许澈拿出自己的手机，没有递过去。
"""


async def validate(root: Path, case: str):
    root.mkdir(parents=True, exist_ok=False)
    store = DirectorStore(root / "isolated-project")
    repo = ExecutionRepository(store)
    service = ExecutionService(repo)
    work = store.create_work(CreateWork(title=f"Synthetic episode: {case}", brief=FACTS,
        preset=DirectorPreset(mode="original", episode_count=2, duration_seconds=120,
                              narrative_tone="克制职场轻喜剧", locked_facts=FACTS)))
    store.put_document(work["id"], "outline", FACTS, 0)
    if case in {"continuation", "revision"}:
        store.put_document(work["id"], "episode-001", BASE, 0)
    if case == "continuation":
        # Seed a known prior checkpoint, not a fake live-model quality review.
        with store._write() as db:
            db.execute("UPDATE works SET current_episode=2 WHERE id=?", (work["id"],))
    instruction = "编写本集完整文学剧本，按集头七项、剧情梗概、正文与场次对白结构交付。对白要有立场和潜台词，以行动推进。没有确认的状态保持未知。"
    if case == "revision":
        instruction = "只把第1场许澈的台词‘客户催着要。’替换成‘我怕你明天才发现。’。其他文字、空行、标点，包括第二场必须逐字保持原样。不补结构，不说明修改过程，输出完整修改稿。"
    quote, run = queue_episode(store, work, service, instruction, 8192)
    with store._connect() as db:
        snapshot = repo.snapshot(db, run["id"])
    save(root / "request.json", {"case": case, "systemPrompt": SYSTEM_PROMPT, "snapshot": snapshot,
        "quote": quote, "authorization": {"maxCalls": 1, "maxOutputTokens": 8192, "automaticRetries": 0}})
    started = time.monotonic()
    result = await dispatch_writing(repo, work["id"], run["id"])
    retained = repo.retained_result(work["id"], run["id"])
    events, cursor = [], 0
    while True:
        page = repo.events(work["id"], cursor)
        events.extend(page["events"])
        cursor = page["nextSeq"]
        if len(page["events"]) < 200:
            break
    save(root / "response.json", {"result": result, "retained": retained, "events": events})
    summary = {"case": case, "status": result["status"], "usage": result["response"].get("usage"),
        "seconds": round(time.monotonic() - started, 2), "deltaEvents": sum(e["type"] == "text.delta" for e in events),
        "format": result["response"].get("episodeFormat"), "actualCost": None, "adopted": False,
        "exactRevision": retained["output"] == BASE.replace("客户催着要。", "我怕你明天才发现。").strip() if case == "revision" else None,
        "quality": "requires-human-review"}
    save(root / "summary.json", summary)
    print(summary, flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--accept-bounded-cost", action="store_true")
    parser.add_argument("--case", choices=["first", "continuation", "revision"], required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if not args.accept_bounded_cost:
        parser.error("Explicit consent required: one call, 8192 output tokens, unknown cost")
    asyncio.run(validate(args.output, args.case))
