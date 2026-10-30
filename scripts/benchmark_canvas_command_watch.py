"""Measure local idle bridge IO and event-loop delay; no running API required.

Run from the checkout with PYTHONPATH=src. This is a local diagnostic, not a
substitute for ingress, multi-worker or production-disk acceptance.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import resource
import sqlite3
import tempfile
import threading
import time
from contextlib import AsyncExitStack
from pathlib import Path

from novelvideo.freezone.canvas_command_bridge import (
    put_pending_canvas_command,
    resolve_canvas_command,
)
from novelvideo.freezone.canvas_command_watch import BridgeWatchHub


async def benchmark(duration: float, directories: int, subscribers: int) -> None:
    with tempfile.TemporaryDirectory(prefix="canvas-watch-benchmark-") as root:
        targets = [Path(root) / str(index) for index in range(directories)]
        for target in targets:
            put_pending_canvas_command(
                key="warmup",
                project_id="p",
                canvas_id="c",
                commands=[],
                envelope={},
                bridge_dir=target,
            )
            resolve_canvas_command("warmup", {"ok": True}, bridge_dir=target)
        hub = BridgeWatchHub()
        async with AsyncExitStack() as stack:
            for _ in range(subscribers):
                await stack.enter_async_context(hub.subscribe(targets))
            await asyncio.sleep(2)
            reads, writes, scans = [], [], []
            original_connect, original_glob = sqlite3.connect, Path.glob

            def connect(database, *args, **kwargs):
                reads.append((str(database), time.monotonic()))
                connection = original_connect(database, *args, **kwargs)
                connection.set_trace_callback(
                    lambda sql: (
                        writes.append(sql)
                        if sql.upper().startswith(
                            ("BEGIN", "UPDATE", "INSERT", "DELETE", "CREATE")
                        )
                        else None
                    )
                )
                return connection

            def glob(path, pattern):
                scans.append(str(path))
                return original_glob(path, pattern)

            sqlite3.connect, Path.glob = connect, glob
            started = time.monotonic()
            cpu_start = time.process_time()
            lags = []
            try:
                while time.monotonic() - started < duration:
                    expected = time.monotonic() + 0.05
                    await asyncio.sleep(0.05)
                    lags.append(max(0, time.monotonic() - expected))
                elapsed = time.monotonic() - started
                per_directory = {}
                for database, at in reads:
                    per_directory.setdefault(database, []).append(at)
                summary = {
                    "elapsed_seconds": round(elapsed, 3),
                    "directories": directories,
                    "subscribers_per_directory": subscribers,
                    "readonly_opens": sum("mode=ro" in path for path, _ in reads),
                    "other_opens": sum("mode=ro" not in path for path, _ in reads),
                    "write_statements": len(writes),
                    "directory_scans": len(scans),
                    "max_opens_per_directory": max(
                        map(len, per_directory.values()), default=0
                    ),
                    "minimum_open_interval_seconds": round(
                        min(
                            (
                                b - a
                                for times in per_directory.values()
                                for a, b in zip(times, times[1:])
                            ),
                            default=0,
                        ),
                        3,
                    ),
                    "process_cpu_seconds": round(time.process_time() - cpu_start, 3),
                    "python_threads": threading.active_count(),
                    "loop_delay_max_ms": round(max(lags, default=0) * 1000, 3),
                    "loop_delay_p99_ms": round(
                        sorted(lags)[int(len(lags) * 0.99)] * 1000, 3
                    ),
                    "max_rss": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,
                    "hub": hub.metrics,
                    "degraded": hub.degraded,
                }
                print(json.dumps(summary, indent=2), flush=True)
            finally:
                sqlite3.connect, Path.glob = original_connect, original_glob


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--duration", type=float, default=600)
    parser.add_argument("--directories", type=int, default=32)
    parser.add_argument("--subscribers", type=int, default=4)
    args = parser.parse_args()
    asyncio.run(benchmark(args.duration, args.directories, args.subscribers))
