"""Exercise real /healthz ASGI middleware alongside many bridge subscribers.

The app lifespan is disabled to avoid starting unrelated workers. This measures
local HTTP handling, not ingress or the production service startup lifecycle.
"""

from __future__ import annotations

import argparse
import asyncio
import importlib.util
import json
import sqlite3
import tempfile
import time
from contextlib import AsyncExitStack
from pathlib import Path

from novelvideo.freezone import canvas_command_bridge as bridge
from novelvideo.freezone.canvas_command_watch import BridgeWatchHub


def percentile(values, fraction):
    return sorted(values)[min(int(len(values) * fraction), len(values) - 1)] if values else None


async def benchmark(duration, directories, subscribers, rate, legacy_module=None):
    import httpx
    from novelvideo.api.app import create_app

    app = create_app()
    health_times, loop_lags, delivery_times = [], [], []
    counts = {"opens": 0, "writes": 0, "sent": 0, "received": 0}
    hub = BridgeWatchHub()
    stop_producer = asyncio.Event()
    legacy = None
    if legacy_module:
        spec = importlib.util.spec_from_file_location("bridge_baseline", legacy_module)
        legacy = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(legacy)
    with tempfile.TemporaryDirectory(prefix="canvas-health-") as root:
        targets = [Path(root) / str(index) for index in range(directories)]
        for directory in targets:
            bridge.put_pending_canvas_command(
                key="init",
                project_id="p",
                canvas_id="c",
                commands=[],
                envelope={},
                bridge_dir=directory,
            )
            bridge.resolve_canvas_command("init", {"ok": True}, bridge_dir=directory)

        async def consume(wake, consumer):
            while True:
                await wake.wait()
                wake.clear()
                for directory in targets:
                    for pending in hub.pending(directory, "p", "c"):
                        key = pending["key"]
                        if await hub.run(
                            bridge.mark_bridge_message_delivered,
                            key,
                            consumer_id=consumer,
                            bridge_dir=directory,
                        ):
                            delivery_times.append((time.time() - pending["created_at"]) * 1000)
                            counts["received"] += 1
                            await hub.run(
                                bridge.resolve_canvas_command,
                                key,
                                {"ok": True},
                                bridge_dir=directory,
                            )

        async def legacy_consume():
            while True:
                await asyncio.sleep(0.4)
                for directory in targets:
                    # Preserve the previous event-loop scan behavior for a
                    # controlled local comparison against the supplied source.
                    for pending in legacy.list_pending_bridge_messages(
                        project_id="p", canvas_id="c", bridge_dir=directory
                    ):
                        key = pending["key"]
                        if legacy.mark_bridge_message_delivered(
                            key, consumer_id="legacy", bridge_dir=directory
                        ):
                            delivery_times.append((time.time() - pending["created_at"]) * 1000)
                            counts["received"] += 1
                            legacy.resolve_canvas_command(key, {"ok": True}, bridge_dir=directory)
                    tuple(directory.glob("*.pending.json"))

        async def produce():
            if not rate:
                return
            index = 0
            while not stop_producer.is_set():
                try:
                    await asyncio.wait_for(stop_producer.wait(), 1 / rate)
                    return
                except asyncio.TimeoutError:
                    pass
                directory = targets[index % len(targets)]
                await asyncio.to_thread(
                    bridge.put_pending_canvas_command,
                    key=f"load-{index}",
                    project_id="p",
                    canvas_id="c",
                    commands=[],
                    envelope={},
                    bridge_dir=directory,
                )
                counts["sent"] += 1
                index += 1

        async with AsyncExitStack() as stack:
            consumers = []
            for index in range(subscribers):
                if legacy:
                    consumers.append(asyncio.create_task(legacy_consume()))
                else:
                    wake = await stack.enter_async_context(hub.subscribe(targets))
                    consumers.append(asyncio.create_task(consume(wake, f"load-{index}")))
            await asyncio.sleep(2)
            original = sqlite3.connect

            def connect(*args, **kwargs):
                counts["opens"] += 1
                connection = original(*args, **kwargs)
                connection.set_trace_callback(
                    lambda sql: (
                        counts.__setitem__("writes", counts["writes"] + 1)
                        if sql.upper().startswith("BEGIN")
                        else None
                    )
                )
                return connection

            sqlite3.connect = connect
            producer = asyncio.create_task(produce())
            started, cpu = time.monotonic(), time.process_time()
            try:
                async with httpx.AsyncClient(
                    transport=httpx.ASGITransport(app=app), base_url="http://acceptance.local"
                ) as client:
                    while time.monotonic() - started < duration:
                        expected = time.monotonic() + 0.05
                        await asyncio.sleep(0.05)
                        loop_lags.append(max(0, time.monotonic() - expected) * 1000)
                        before = time.monotonic()
                        response = await client.get("/healthz")
                        response.raise_for_status()
                        assert response.json() == {"status": "ok"}
                        health_times.append((time.monotonic() - before) * 1000)
                # Let an admitted write finish before freezing the sent count.
                stop_producer.set()
                await producer
                end = time.monotonic() + 5
                while counts["received"] < counts["sent"] and time.monotonic() < end:
                    await asyncio.sleep(0.05)
                print(
                    json.dumps(
                        {
                            "mode": "legacy" if legacy else "push",
                            "transport": "ASGI_without_lifespan",
                            "duration_seconds": duration,
                            "directories": directories,
                            "subscribers_per_directory": subscribers,
                            "commands_per_second": rate,
                            **counts,
                            "health_requests": len(health_times),
                            "health_p99_ms": percentile(health_times, 0.99),
                            "loop_delay_p99_ms": percentile(loop_lags, 0.99),
                            "delivery_p99_ms": percentile(delivery_times, 0.99),
                            "cpu_seconds": time.process_time() - cpu,
                            "degraded": hub.degraded,
                        },
                        indent=2,
                    ),
                    flush=True,
                )
                if counts["received"] != counts["sent"]:
                    raise RuntimeError("Not all load commands were delivered")
            finally:
                sqlite3.connect = original
                producer.cancel()
                for task in consumers:
                    task.cancel()
                await asyncio.gather(producer, *consumers, return_exceptions=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--duration", type=float, default=60)
    parser.add_argument("--directories", type=int, default=32)
    parser.add_argument("--subscribers", type=int, default=4)
    parser.add_argument("--rate", type=float, default=0)
    parser.add_argument("--legacy-module", type=Path)
    args = parser.parse_args()
    if args.duration <= 0 or args.directories < 1 or args.subscribers < 1 or args.rate < 0:
        parser.error("duration/counts must be positive; rate must be non-negative")
    asyncio.run(
        benchmark(args.duration, args.directories, args.subscribers, args.rate, args.legacy_module)
    )
