"""Explicit one-call full-episode review; retain failures and never regenerate text."""
import argparse
import asyncio
import json
import time
import tempfile
from pathlib import Path

from novelvideo.director.dispatch import dispatch_writing
from novelvideo.director.execution import ExecutionService, execution_capability
from novelvideo.director.execution_repository import ExecutionRepository, identifier
from novelvideo.director.models import CreateWork, DirectorPreset
from novelvideo.director.quality import QualityService, REVIEW_SYSTEM
from novelvideo.director.schemas.execution import ExecutionCommand
from novelvideo.director.store import DirectorStore
from tests.director.live_execution import save

BRIEF = "第一集：许澈把确认单递给周宁，周宁未签。结尾纸在周宁手里，手机一直在许澈手里。第二集：仍在同一办公室，许澈用自己的手机显示客户原文，周宁看清日期后签单，再把单交给许澈。本剧结束。不得新增人物、年龄、称呼、道具；不得改变手机持有与位置。"
PRIOR = "# 第1集\n\n## 办公室 日 内\n\n△ 许澈递出确认单，周宁接住，没有签字。手机在许澈手中。\n\n**周宁：** 先核对原件。"
POSITIVE = "# 第2集\n\n## 办公室 日 内\n\n△ 许澈手持手机，打开客户原文，转向周宁。周宁看清日期，在手中的确认单上签字，把单交给许澈。手机仍在许澈手中。\n\n**周宁：** 这次可以了。"
NEGATIVE = POSITIVE.replace("许澈手持手机，打开客户原文，转向周宁。", "许澈从口袋重新掏出手机，放到桌角，打开客户原文。周宁从文件夹里拿出确认单。")


async def run(root: Path, case: str):
    root.mkdir(parents=True, exist_ok=False)
    store = DirectorStore(root / "isolated-project")
    work = store.create_work(CreateWork(title=f"Synthetic fact audit {case}", brief=BRIEF,
        preset=DirectorPreset(mode="original", episode_count=2, duration_seconds=120)))
    store.put_document(work["id"], "episode-001", PRIOR, 0)
    with store._write() as db:
        db.execute("UPDATE works SET current_episode=2 WHERE id=?", (work["id"],))
    body = POSITIVE if case == "positive" else NEGATIVE
    store.put_document(work["id"], "episode-002", body, 0)
    repo, started = ExecutionRepository(store), time.monotonic()
    service = ExecutionService(repo)

    def send(payload):
        request_id = identifier()
        command = ExecutionCommand.from_wire({"schemaVersion": 2, "commandId": request_id,
            "clientRequestId": request_id, "sessionId": "episode-facts-test", "workId": work["id"],
            "expected": {"workRevision": store.get_work(work["id"])["revision"],
                         "documentVersions": {"episode-002": 1}, "capabilityVersion": execution_capability()["version"]},
            "payload": payload})
        result = service.execute("authorized-episode-audit", command)["result"]
        save(root / (payload["type"].replace(".", "-") + ".json"), {"command": command.model_dump(by_alias=True), "result": result})
        return result

    quote = send({"type": "cost.quote", "kind": "episode", "episodeOrdinal": 2, "purpose": "review", "maxOutputTokens": 8192})
    operation = send({"type": "approval.grant", "quoteId": quote["quoteId"], "requestHash": quote["requestHash"], "unknownCostConsent": True})
    with store._connect() as db:
        snapshot = repo.snapshot(db, operation["id"])
    save(root / "request.json", {"systemPrompt": REVIEW_SYSTEM, "snapshot": snapshot, "maxCalls": 1, "case": case})
    result = await dispatch_writing(repo, work["id"], operation["id"])
    save(root / "response.json", {"result": result, "retained": repo.retained_result(work["id"], operation["id"])})
    report = QualityService(store).report(work["id"], 2)
    save(root / "report.json", report)
    audit = (report.get("review") or {}).get("episodeFacts") or {}
    summary = {"case": case, "status": result["status"], "reviewStatus": (report.get("review") or {}).get("status"),
               "factStatus": audit.get("status"), "coverage": audit.get("coverage"), "usage": result.get("response", {}).get("usage"),
               "seconds": round(time.monotonic() - started, 2), "actualCost": None, "calls": 1, "automaticRetries": 0}
    save(root / "summary.json", summary)
    print(json.dumps(summary, ensure_ascii=False), flush=True)


async def local_router_run(root: Path, case: str):
    # CE settings.db intentionally overrides env URLs. Isolate settings, never
    # mutate the user's selected gateway or persist credentials in evidence.
    import httpx
    from novelvideo import config
    from novelvideo.local_gateway import router_config, _router_token
    from novelvideo.model_gateway_settings import save_custom_newapi_gateway

    router = router_config()
    base_url = f"http://127.0.0.1:{router.port}/v1"
    token = _router_token(router)
    async with httpx.AsyncClient(trust_env=False, timeout=10) as client:
        response = await client.get(base_url + "/models", headers={"Authorization": f"Bearer {token}"})
        response.raise_for_status()
    previous = config.STATE_DIR
    with tempfile.TemporaryDirectory(prefix="director-facts-settings-") as temporary:
        try:
            config.STATE_DIR = temporary
            save_custom_newapi_gateway(base_url=base_url, api_key=token)
            await run(root, case)
        finally:
            config.STATE_DIR = previous


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--case", choices=["positive", "negative"], required=True)
    parser.add_argument("--accept-bounded-cost", action="store_true")
    parser.add_argument("--local-router", action="store_true")
    args = parser.parse_args()
    if not args.accept_bounded_cost:
        parser.error("Explicit cost consent required")
    asyncio.run(local_router_run(args.output, args.case) if args.local_router else run(args.output, args.case))
