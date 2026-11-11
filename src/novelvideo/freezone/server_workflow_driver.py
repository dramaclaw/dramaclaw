"""Lease-bound scheduling for server-owned canvas workflow runs."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable
from datetime import datetime, timezone
from pathlib import Path
from typing import Protocol

from novelvideo.freezone import workflow_runs as store
from novelvideo.freezone.agent_canvas_metrics import count, observe

logger = logging.getLogger(__name__)

# canvasChatCommands.ts: WORKFLOW_ACTION_CONCURRENCY.
WORKFLOW_ACTION_CONCURRENCY = 3
# canvasChatCommands.ts: WORKFLOW_ACTION_LANE_LIMITS.
WORKFLOW_ACTION_LANE_LIMITS = {"default": 3, "video": 3, "world": 1, "ffmpeg": 1}
# canvasChatCommands.ts: WORKFLOW_CAPACITY_POLL_INTERVAL_MS.
WORKFLOW_CAPACITY_POLL_SECONDS = 2.0
# canvasChatCommands.ts: DEFAULT_NODE_ACTION_TIMEOUT_MS (capacity wait and action timeout).
WORKFLOW_ACTION_TIMEOUT_SECONDS = 30 * 60
WORKFLOW_CAPACITY_TIMEOUT_SECONDS = 30 * 60
TEXT_INTERRUPTED_ERROR = "文本生成在接管前已发出，结果未知；为避免重复调用已停止，请重新发起"


class ServerWorkflowLeaseLost(RuntimeError):
    """The driver no longer has permission to write workflow results."""


class ServerActionRunner(Protocol):
    def supports(self, action: str) -> bool: ...

    async def lane_capacity(self, lane: str) -> int | None: ...

    async def interrupt_action(
        self, *, node_id: str, action: str, product_operation_id: str | None,
    ) -> None: ...

    async def run_action(
        self,
        *,
        node_id: str,
        action: str,
        existing_task: dict | None,
        product_operation_id: str | None,
        generation_attempt_id: str | None,
        on_accepted: Callable[[dict], Awaitable[None]],
        on_phase: Callable[[str], Awaitable[None]],
        should_stop: Callable[[], bool],
    ) -> dict: ...


def workflow_action_lane(action: str) -> str:
    # canvasChatCommands.ts: workflowActionLane.
    if action in {"generate_video", "generate_text_video"}:
        return "video"
    if action == "generate_3gs_world":
        return "world"
    if action == "auto_compose_video":
        return "ffmpeg"
    return "default"


def is_retryable_workflow_action_error(error: str | None) -> bool:
    # canvasChatCommands.ts: isRetryableWorkflowActionError.
    normalized = str(error or "").strip().lower()
    if any(marker in normalized for marker in (
        store.RECIPE_ATTEMPT_ENDED_MARKER, *store.NON_RETRYABLE_ERROR_MARKERS, "401", "403",
    )):
        return False
    return any(marker in normalized for marker in (
        "429", "502", "503", "504", "econnreset", "connection reset", "bad_response_body",
        "队列已满", "队列的任务已达", "queue is full", "lane is full",
    ))


def workflow_retry_delay_seconds(retry_count: int) -> float:
    # canvasChatCommands.ts: workflowRetryDelayMs.
    return min(2.0 ** max(retry_count - 1, 0), 4.0)


def _levels(run: dict) -> list[list[int]]:
    levels = run["metadata"].get("levels")
    if (
        isinstance(levels, list) and levels
        and all(isinstance(level, list) and level for level in levels)
    ):
        indices = [index for level in levels for index in level]
        if all(type(index) is int for index in indices) and sorted(indices) == list(
            range(len(run["actions"]))
        ):
            return levels
    return [[index] for index in range(len(run["actions"]))]


class _RunEnded(RuntimeError):
    pass


async def drive_server_workflow_run(
    *,
    project_dir: Path,
    canvas_id: str,
    run_id: str,
    runner_id: str,
    action_runner_factory: Callable[[dict, Callable[[], None]], ServerActionRunner],
    now: Callable[[], datetime] = lambda: datetime.now(timezone.utc),
    sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    poll_seconds: float = 5.0,
    lease_seconds: int = store.WORKFLOW_RUN_LEASE_SECONDS,
) -> dict:
    scope = dict(project_dir=project_dir, canvas_id=canvas_id, run_id=run_id)
    took_over = False
    acquired_run = False
    started = now()

    def result(status: str, **extra) -> dict:
        if acquired_run:
            elapsed_ms = (now() - started).total_seconds() * 1000
            count(f"workflow_run.drive.{status}")
            observe("workflow_run.drive_ms", elapsed_ms)
            logger.info(
                "Server workflow drive ended run_id=%s status=%s took_over=%s duration_ms=%d",
                run_id, status, took_over, elapsed_ms,
            )
        return dict(status=status, run_id=run_id, runner_id=runner_id,
                    took_over=took_over, **extra)

    try:
        acquired = await asyncio.to_thread(
            store.acquire_server_workflow_run, **scope, runner_id=runner_id,
            now=now(), lease_seconds=lease_seconds,
        )
    except store.WorkflowRunLeaseConflict:
        return result("superseded")
    if acquired is None:
        return result("missing")
    run = acquired["run"]
    metadata = run["metadata"]
    raw_dependencies = metadata.get("dependencies")
    dependencies = {
        node_id: upstream for node_id, upstream in raw_dependencies.items()
        if isinstance(node_id, str) and isinstance(upstream, list)
        and all(isinstance(value, str) for value in upstream)
    } if isinstance(raw_dependencies, dict) else {}
    raw_manifest = metadata.get("action_manifest")
    manifest = {
        (item["node_id"], item["action"]): item for item in raw_manifest
        if isinstance(item, dict) and isinstance(item.get("node_id"), str)
        and isinstance(item.get("action"), str)
    } if isinstance(raw_manifest, list) else {}
    if not acquired["acquired"]:
        return result(run["status"], acquired=False)
    acquired_run = True
    took_over = acquired["took_over"]
    if took_over:
        count("workflow_run.takeover")
    logger.info("Driving workflow run_id=%s runner_id=%s took_over=%s takeover_count=%s",
                run_id, runner_id, took_over, run["metadata"]["takeover_count"])
    expiry = datetime.fromisoformat(run["lease_expires_at"].replace("Z", "+00:00"))
    renewed_at = now()
    stopped = asyncio.Event()
    lease_lost = False
    ended_status = "cancelled"
    write_lock = asyncio.Lock()
    action_tasks: set[asyncio.Task] = set()
    executing: dict[asyncio.Task, datetime] = {}
    timed_out: set[asyncio.Task] = set()

    def assert_lease() -> None:
        if lease_lost or now() >= expiry:
            raise ServerWorkflowLeaseLost("workflow driver lease expired or was lost")

    def should_stop() -> bool:
        return stopped.is_set() or lease_lost or now() >= expiry

    def track(updated: dict) -> None:
        nonlocal run, expiry, renewed_at, ended_status
        run = updated
        expiry = datetime.fromisoformat(run["lease_expires_at"].replace("Z", "+00:00"))
        renewed_at = now()
        if run["status"] != "running":
            ended_status = run["status"]
            stopped.set()

    async def write(**kwargs) -> dict:
        async with write_lock:
            assert_lease()
            if stopped.is_set():
                raise _RunEnded()

            def guarded_update():
                assert_lease()
                return store.update_workflow_run(
                    **scope, owner_kind="server", runner_id=runner_id, now=now(), **kwargs,
                )

            updated = await asyncio.to_thread(guarded_update)
            if updated is None:
                stopped.set()
                raise _RunEnded()
            track(updated)
            return updated

    async def monitor() -> None:
        nonlocal lease_lost, ended_status
        try:
            while not stopped.is_set():
                await sleep(poll_seconds)
                async with write_lock:
                    current = await asyncio.to_thread(store.read_workflow_run, **scope)
                    if current is None or current["status"] != "running":
                        ended_status = current["status"] if current else "missing"
                        stopped.set()
                        return
                    if current["runner_id"] != runner_id:
                        raise ServerWorkflowLeaseLost("workflow driver replaced")
                    assert_lease()
                    if (now() - renewed_at).total_seconds() >= lease_seconds / 3:
                        renewed = await asyncio.to_thread(
                            store.acquire_server_workflow_run, **scope, runner_id=runner_id,
                            now=now(), lease_seconds=lease_seconds,
                        )
                        if renewed is None:
                            stopped.set()
                            return
                        track(renewed["run"])
                    for task, started in list(executing.items()):
                        if (now() - started).total_seconds() >= WORKFLOW_ACTION_TIMEOUT_SECONDS:
                            timed_out.add(task)
                            task.cancel()
        except (ServerWorkflowLeaseLost, store.WorkflowRunLeaseConflict):
            lease_lost = True
            stopped.set()

    async def action(item: dict) -> None:
        node_id, name = item["node_id"], item["action"]
        if item["status"] in {"completed", "skipped", "failed", "blocked"}:
            return

        async def update(**kwargs) -> dict:
            return await write(action_updates=[{
                "node_id": node_id, "action": name, "status": "running", **kwargs,
            }])

        for upstream in dependencies.get(node_id, []):
            if any(row["node_id"] == upstream and row["status"] in {"failed", "blocked"}
                   for row in run["actions"]):
                await update(status="blocked",
                             error=f"跳过 {name}：上游节点 {upstream} 未成功完成。")
                return
        if "refusal" in manifest.get((node_id, name), {}) or not runner.supports(name):
            await update(status="failed", error=f"工作流动作 {name} 需要打开画布运行")
            return
        if (
            name == "generate_text"
            and item["status"] == "running"
            and item.get("phase") == "generating"
        ):
            await runner.interrupt_action(
                node_id=node_id, action=name,
                product_operation_id=item.get("product_operation_id"),
            )
            await update(status="failed", error=TEXT_INTERRUPTED_ERROR)
            return
        lane = workflow_action_lane(name)
        # Acquire the lane first so queued world actions do not consume global slots.
        async with lanes[lane], global_slots:
            existing_task = (
                {key: item.get(key) for key in ("task_key", "task_type", "job_id")}
                if item["status"] == "running" and item.get("task_key") else None
            )
            retry_count = item.get("retry_count", 0)
            while not should_stop():
                if name in store.GENERATION_ACTIONS:
                    started = now()
                    waiting = False
                    while not should_stop():
                        capacity = await runner.lane_capacity(lane)
                        if capacity is None or capacity > 0:
                            break
                        if (now() - started).total_seconds() >= WORKFLOW_CAPACITY_TIMEOUT_SECONDS:
                            await update(status="failed", error="workflow lane capacity timed out")
                            return
                        if not waiting:
                            await update(phase="waiting_capacity")
                            waiting = True
                        await sleep(WORKFLOW_CAPACITY_POLL_SECONDS)
                if should_stop():
                    return
                await update(phase="preparing")

                async def on_accepted(task: dict) -> None:
                    await update(phase="generating", **{
                        key: task.get(key) for key in ("task_key", "task_type", "job_id")
                    })

                async def on_phase(phase: str) -> None:
                    await update(phase=phase)

                task = asyncio.create_task(runner.run_action(
                    node_id=node_id, action=name, existing_task=existing_task,
                    product_operation_id=item.get("product_operation_id"),
                    generation_attempt_id=item.get("generation_attempt_id"),
                    on_accepted=on_accepted, on_phase=on_phase, should_stop=should_stop,
                ))
                executing[task] = now()
                try:
                    outcome = await task
                except asyncio.CancelledError:
                    if task not in timed_out:
                        raise
                    outcome = {"status": "failed", "error": "workflow action timed out"}
                except (ServerWorkflowLeaseLost, store.WorkflowRunLeaseConflict, _RunEnded):
                    raise
                except Exception as exc:
                    outcome = {"status": "failed", "error": str(exc)}
                finally:
                    executing.pop(task, None)
                    timed_out.discard(task)
                if should_stop() or outcome["status"] == "stopped":
                    assert_lease()
                    return
                if outcome["status"] == "skipped":
                    await update(status="skipped", error=outcome.get("error"))
                    return
                if outcome["status"] == "completed":
                    # The store validates ``result`` as the artifact; ``output`` is the
                    # canvas-facing projection and may use different field names.
                    await update(status="completed",
                                 result=outcome.get("artifact", outcome["output"]))
                    return
                error = outcome.get("error") or "workflow action failed"
                if (
                    is_retryable_workflow_action_error(error)
                    and retry_count < store.WORKFLOW_ACTION_MAX_RETRIES
                ):
                    retry_count += 1
                    cleared_task = ({} if (
                        item.get("product_operation_id") or item.get("generation_attempt_id")
                    ) else {
                        "task_key": "", "task_type": "", "job_id": "",
                    })
                    await update(phase="retrying", retry_count=retry_count, **cleared_task)
                    await sleep(workflow_retry_delay_seconds(retry_count))
                    existing_task = None
                else:
                    await update(status="failed", error=error)
                    return

    async def work() -> str:
        for level in _levels(run):
            tasks = [asyncio.create_task(action(run["actions"][index])) for index in level]
            action_tasks.update(tasks)
            await asyncio.gather(*tasks)
            action_tasks.difference_update(tasks)
            if should_stop():
                assert_lease()
                return ended_status
        failed = any(item["status"] in {"failed", "blocked"} for item in run["actions"])
        return (await write(status="failed" if failed else "completed"))["status"]

    driver_tasks: set[asyncio.Task] = set()
    try:
        runner = action_runner_factory(run, assert_lease)
        global_slots = asyncio.Semaphore(WORKFLOW_ACTION_CONCURRENCY)
        lanes = {
            lane: asyncio.Semaphore(limit) for lane, limit in WORKFLOW_ACTION_LANE_LIMITS.items()
        }
        monitor_task = asyncio.create_task(monitor())
        work_task = asyncio.create_task(work())
        driver_tasks.update({monitor_task, work_task})
        done, _ = await asyncio.wait({monitor_task, work_task}, return_when=asyncio.FIRST_COMPLETED)
        if monitor_task in done:
            await monitor_task
            return result("lease_lost" if lease_lost else ended_status)
        return result(await work_task)
    except (ServerWorkflowLeaseLost, store.WorkflowRunLeaseConflict):
        lease_lost = True
        return result("lease_lost")
    except _RunEnded:
        return result(ended_status)
    finally:
        stopped.set()
        pending = driver_tasks | action_tasks | executing.keys()
        for task in pending:
            if not task.done():
                task.cancel()
        await asyncio.gather(*pending, return_exceptions=True)
