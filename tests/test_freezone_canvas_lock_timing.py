"""B2 步 1 · `canvas_write_lock` 的等待/持有耗时埋点。

判据来自 `B2-canvas-placement-free.md` §3.3.1 步 B ＋ §6.4 步 1：

- 开关 `ST_CANVAS_LOCK_TIMING` **默认关**，关闭时零输出（B2-8 / 总图 F8「CE 行为零变化」）；
- 开启时**每次取锁一行**、字段齐（`canvas_id` / `wait_ms` / `held_ms`）；
- 通道必须是 **stdout `print(flush=True)`**，不是 `logging` —— §3.3.1 的告警框实测：
  api 进程 root logger 是裸的，`logger.info` 在 logger 层就被丢弃，一行都到不了 Loki。
  所以「默认关 / 开启有输出」这两条**用子进程验**，才同时盖住 env 解析与 stdout 通道。
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
import threading
import time
from pathlib import Path

from novelvideo.freezone import canvas_lock
from novelvideo.freezone.canvas_lock import canvas_write_lock

TIMING_LINE_RE = re.compile(
    r"^canvas\.lock canvas_id=(?P<canvas_id>\S+) "
    r"wait_ms=(?P<wait_ms>[0-9.]+) held_ms=(?P<held_ms>[0-9.]+)$"
)

_CHILD_SCRIPT = """
import sys
from pathlib import Path

from novelvideo.freezone.canvas_lock import canvas_write_lock

project_dir = Path(sys.argv[1])
for _ in range(2):
    with canvas_write_lock(project_dir, "default"):
        pass
print("child_done", flush=True)
"""


def _run_child(tmp_path: Path, *, timing: str | None) -> list[str]:
    env = dict(os.environ)
    env.pop("ST_CANVAS_LOCK_TIMING", None)
    if timing is not None:
        env["ST_CANVAS_LOCK_TIMING"] = timing
    proc = subprocess.run(
        [sys.executable, "-c", _CHILD_SCRIPT, str(tmp_path / "project")],
        capture_output=True,
        text=True,
        env=env,
        timeout=180,
        check=True,
    )
    assert "child_done" in proc.stdout, proc.stderr
    return [line for line in proc.stdout.splitlines() if line.startswith("canvas.lock ")]


def test_canvas_lock_timing_is_silent_when_switch_is_unset(tmp_path: Path) -> None:
    """开关未设置 → 零输出（CE 单机默认路径，B2-8）。"""

    assert _run_child(tmp_path, timing=None) == []


def test_canvas_lock_timing_is_silent_when_switch_is_not_one(tmp_path: Path) -> None:
    """只有精确的 `1` 才开；`0` 一律当关（不留一个模糊的开关面）。"""

    assert _run_child(tmp_path, timing="0") == []


def test_canvas_lock_timing_emits_one_complete_line_per_acquire(tmp_path: Path) -> None:
    """开启时每次取锁一行、字段齐，且走的是 stdout（子进程里 logging 拿不到）。"""

    lines = _run_child(tmp_path, timing="1")

    assert len(lines) == 2
    for line in lines:
        match = TIMING_LINE_RE.match(line)
        assert match is not None, line
        assert match.group("canvas_id") == "default"
        assert float(match.group("wait_ms")) >= 0.0
        assert float(match.group("held_ms")) >= 0.0


def test_canvas_lock_timing_measures_wait_and_held_separately(
    tmp_path: Path, capsys, monkeypatch
) -> None:
    """`wait_ms` 量争用、`held_ms` 量关键区 —— 两个数各定一件事（§3.3.1 第四个决定）。

    `held_ms` 定 TTL，`wait_ms` 定「3s 自旋上限够不够」，所以它们必须是两个独立的数。
    """

    monkeypatch.setattr(canvas_lock, "_TIMING", True)
    project_dir = tmp_path / "project"
    holder_acquired = threading.Event()

    def hold() -> None:
        with canvas_write_lock(project_dir, "default"):
            holder_acquired.set()
            time.sleep(0.15)

    holder = threading.Thread(target=hold)
    holder.start()
    assert holder_acquired.wait(timeout=5.0)

    with canvas_write_lock(project_dir, "default"):
        time.sleep(0.05)
    holder.join(timeout=5.0)

    parsed = [
        TIMING_LINE_RE.match(line)
        for line in capsys.readouterr().out.splitlines()
        if line.startswith("canvas.lock ")
    ]
    assert len(parsed) == 2
    assert all(match is not None for match in parsed)
    waits = sorted(float(match.group("wait_ms")) for match in parsed)
    helds = sorted(float(match.group("held_ms")) for match in parsed)

    # 持有者零等待；争用者等到持有者放手（0.15s 减去 set() 之前的那一小段）。
    assert waits[0] < 50.0
    assert waits[1] >= 80.0
    # 关键区耗时：争用者睡 0.05s，持有者睡 0.15s，两个数不许被糊成一个。
    assert helds[0] >= 40.0
    assert helds[1] >= 140.0
