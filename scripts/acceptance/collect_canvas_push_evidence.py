"""Collect read-only Linux/HTTP rollout evidence without logging credentials."""

from __future__ import annotations

import argparse
import http.cookiejar
import json
import os
import platform
import time
from pathlib import Path
from urllib.parse import urlsplit
from urllib.request import HTTPCookieProcessor, Request, build_opener


def linux_counters(device, proc_root=Path("/proc")):
    result = {"cpu_ticks": None, "disk": None}
    stat = proc_root / "stat"
    if stat.exists():
        fields = stat.read_text().splitlines()[0].split()
        # user,nice,system,idle,iowait,irq,softirq,steal; guest already included.
        result["cpu_ticks"] = [int(value) for value in fields[1:9]]
    diskstats = proc_root / "diskstats"
    if diskstats.exists():
        for line in diskstats.read_text().splitlines():
            fields = line.split()
            if fields[2] == device:
                result["disk"] = {
                    "device": device,
                    "read_sectors": int(fields[5]),
                    "write_sectors": int(fields[9]),
                    "io_ms": int(fields[12]),
                }
                break
    return result


def delta(before, after):
    result = {"host_cpu_busy_percent": None, "disk": None}
    if before["cpu_ticks"] is not None and after["cpu_ticks"] is not None:
        ticks = [b - a for a, b in zip(before["cpu_ticks"], after["cpu_ticks"])]
        if sum(ticks) > 0:
            result["host_cpu_busy_percent"] = 100 * (sum(ticks) - ticks[3] - ticks[4]) / sum(ticks)
    if before["disk"] is not None and after["disk"] is not None:
        result["disk"] = {
            "device": after["disk"]["device"],
            **{
                key: after["disk"][key] - before["disk"][key]
                for key in ("read_sectors", "write_sectors", "io_ms")
            },
        }
    return result


def process_counters(pid, proc_root=Path("/proc")):
    if pid is None:
        return None
    try:
        fields = (proc_root / str(pid) / "stat").read_text().rpartition(")")[2].split()
        io = dict(
            line.split(":", 1) for line in (proc_root / str(pid) / "io").read_text().splitlines()
        )
        return {
            "pid": pid,
            "start_ticks": int(fields[19]),
            "cpu_ticks": int(fields[11]) + int(fields[12]),
            "read_bytes": int(io["read_bytes"]),
            "write_bytes": int(io["write_bytes"]),
        }
    except (FileNotFoundError, PermissionError):
        return None


def collect(duration, interval, device, url=None, cookie_file=None, pid=None):
    jar = http.cookiejar.MozillaCookieJar()
    if cookie_file:
        jar.load(str(cookie_file), ignore_discard=True)
    opener = build_opener(HTTPCookieProcessor(jar))
    start = time.monotonic()
    before = linux_counters(device)
    process_before = process_counters(pid)
    samples = []
    while time.monotonic() - start < duration:
        sample = {"elapsed_seconds": time.monotonic() - start}
        if url:
            request_start = time.monotonic()
            with opener.open(url.rstrip("/") + "/healthz", timeout=10) as response:
                if json.load(response).get("status") != "ok":
                    raise RuntimeError("healthz failed")
            sample["health_ms"] = 1000 * (time.monotonic() - request_start)
            request = Request(url.rstrip("/") + "/api/v1/diagnostics/canvas-command-push")
            with opener.open(request, timeout=10) as response:
                payload = json.load(response)
            if payload.get("ok") is not True:
                raise RuntimeError("diagnostics failed")
            data = payload["data"]
            sample["worker"] = {
                key: data[key]
                for key in ("worker_pid", "counters", "degraded", "directories", "subscriptions")
            }
        samples.append(sample)
        time.sleep(min(interval, max(0, duration - (time.monotonic() - start))))
    process_after = process_counters(pid)
    process_delta = None
    if (
        process_before is not None
        and process_after is not None
        and process_before["start_ticks"] == process_after["start_ticks"]
    ):
        process_delta = {
            "pid": pid,
            "cpu_seconds": (process_after["cpu_ticks"] - process_before["cpu_ticks"])
            / os.sysconf("SC_CLK_TCK"),
            **{
                key: process_after[key] - process_before[key]
                for key in ("read_bytes", "write_bytes")
            },
        }
    result = {
        "kernel": platform.release(),
        "platform": platform.system(),
        "elapsed_seconds": time.monotonic() - start,
        "system_delta": delta(before, linux_counters(device)),
        "local_process_delta": process_delta,
        "samples": samples,
        "limitations": [
            "CPU/disk counters describe this host, not API-only usage",
            "Absent devices/counters are null, never treated as zero",
            "diagnostic counters are per worker and reset on restart",
        ],
    }
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--duration", type=float, default=60)
    parser.add_argument("--interval", type=float, default=1)
    parser.add_argument("--device", default="sda")
    parser.add_argument("--url")
    parser.add_argument("--cookie-file", type=Path)
    parser.add_argument("--pid", type=int, help="API PID in this Linux process namespace")
    args = parser.parse_args()
    if args.duration <= 0 or args.interval <= 0:
        parser.error("duration and interval must be positive")
    if args.url:
        parsed = urlsplit(args.url)
        if (
            parsed.scheme not in {"http", "https"}
            or not parsed.hostname
            or parsed.username
            or parsed.password
        ):
            parser.error("url must be an HTTP(S) base URL without credentials")
        if parsed.query or parsed.fragment:
            parser.error("url must not contain a query or fragment")
    collect(args.duration, args.interval, args.device, args.url, args.cookie_file, args.pid)
