"""验证同步画布保存的异步适配器不会阻塞事件循环（B2-10）。

`save_canvas` 会同步等待当前配置的画布写互斥并执行同步文件 I/O；异步调用方必须
通过 `save_canvas_async` 把完整保存路径移出事件循环。本模块使用 CE 文件锁的定频
重试制造可控争用；文件锁只是测试手段，不代表其它互斥实现的等待算法或作用范围。

测试策略：

1. 用事件循环心跳代表与保存无关的工作，锁争用期间心跳仍须推进。
2. 持有文件锁 0.3 秒，既能稳定暴露同步阻塞，又不会触发文件锁自己的等待上限。
3. 保留同步调用的对照组，证明同一个心跳探针对阻塞足够敏感。
"""

from __future__ import annotations

import asyncio
import json
import threading
import time
from pathlib import Path

import pytest

from novelvideo.freezone import canvas_store
from novelvideo.freezone.canvas_lock import CanvasLockBusy, canvas_write_lock

HOLD_SECONDS = 0.3
TICK_SECONDS = 0.01


def _seed_canvas(project_dir: Path) -> None:
    canvas_file = project_dir / "freezone" / "canvases" / "default.json"
    canvas_file.parent.mkdir(parents=True, exist_ok=True)
    canvas_file.write_text(
        json.dumps(
            {
                "schema_version": 2,
                "canvas_id": "default",
                "project_id": "proj",
                "revision": 1,
                "nodes": [],
                "edges": [],
            }
        ),
        encoding="utf-8",
    )


def _save_kwargs() -> dict:
    return {
        "base_revision": 1,
        "build_payload": lambda _existing: {
            "schema_version": 2,
            "canvas_id": "default",
            "project_id": "proj",
            "revision": 2,
            "nodes": [{"id": "saved_off_loop"}],
            "edges": [],
        },
    }


def _hold_lock_for(project_dir: Path, seconds: float) -> tuple[threading.Thread, threading.Event]:
    """另一个持有者占住画布锁 `seconds` 秒，模拟被争用的保存。"""

    acquired = threading.Event()

    def hold() -> None:
        with canvas_write_lock(project_dir, "default"):
            acquired.set()
            time.sleep(seconds)

    holder = threading.Thread(target=hold, name="canvas-lock-holder")
    holder.start()
    assert acquired.wait(timeout=5.0)
    return holder, acquired


class _Heartbeat:
    """在事件循环上每 10ms 跳一次；循环被冻住时它一次都跳不了。"""

    def __init__(self) -> None:
        self.ticks = 0
        self._task: asyncio.Task | None = None

    async def __aenter__(self) -> "_Heartbeat":
        async def beat() -> None:
            while True:
                await asyncio.sleep(TICK_SECONDS)
                self.ticks += 1

        self._task = asyncio.create_task(beat())
        await asyncio.sleep(TICK_SECONDS * 2)
        return self

    async def __aexit__(self, *_exc) -> None:
        assert self._task is not None
        self._task.cancel()
        try:
            await self._task
        except asyncio.CancelledError:
            pass


async def test_sync_save_canvas_freezes_the_event_loop(tmp_path: Path) -> None:
    """对照组：同步调用会把循环整个冻住（§3.9 N3 的危害本体）。

    这条**不是**要被修掉的行为——`save_canvas` 仍然是同步函数，CLI 与备份进程
    照旧直接调它（B2-8 CE 行为零变化）。它在这里是为了证明心跳测得够灵敏。
    """

    project_dir = tmp_path / "project"
    _seed_canvas(project_dir)
    holder, _ = _hold_lock_for(project_dir, HOLD_SECONDS)

    async with _Heartbeat() as heartbeat:
        heartbeat.ticks = 0
        started = time.monotonic()
        result = canvas_store.save_canvas(project_dir, "default", **_save_kwargs())
        blocked_seconds = time.monotonic() - started

        assert result.payload["revision"] == 2
        assert blocked_seconds >= HOLD_SECONDS / 2
        assert heartbeat.ticks == 0

    holder.join(timeout=5.0)


async def test_save_canvas_async_keeps_the_event_loop_alive(tmp_path: Path) -> None:
    """B2-10 的判据：保存被争用时，事件循环照常推进别的工作。"""

    project_dir = tmp_path / "project"
    _seed_canvas(project_dir)
    holder, _ = _hold_lock_for(project_dir, HOLD_SECONDS)

    async with _Heartbeat() as heartbeat:
        heartbeat.ticks = 0
        started = time.monotonic()
        result = await canvas_store.save_canvas_async(
            project_dir, "default", **_save_kwargs()
        )
        blocked_seconds = time.monotonic() - started

        assert result.payload["revision"] == 2
        assert blocked_seconds >= HOLD_SECONDS / 2
        # 0.3s / 10ms ≈ 30 次；压到 10 次仍然只有「循环没停」才可能达到。
        assert heartbeat.ticks >= 10

    holder.join(timeout=5.0)
    assert json.loads(
        (project_dir / "freezone" / "canvases" / "default.json").read_text(encoding="utf-8")
    )["nodes"] == [{"id": "saved_off_loop"}]


async def test_save_canvas_async_returns_the_same_result_as_the_sync_call(
    tmp_path: Path,
) -> None:
    """接缝只换执行位置，不换返回形状（B2-6 HTTP 契约零变化的前提）。"""

    async_dir = tmp_path / "async_project"
    sync_dir = tmp_path / "sync_project"
    _seed_canvas(async_dir)
    _seed_canvas(sync_dir)

    from_async = await canvas_store.save_canvas_async(async_dir, "default", **_save_kwargs())
    from_sync = canvas_store.save_canvas(sync_dir, "default", **_save_kwargs())

    assert type(from_async) is type(from_sync)
    assert from_async.payload == from_sync.payload
    assert from_async.response_cache == from_sync.response_cache
    assert from_async.idempotent == from_sync.idempotent


async def test_save_canvas_async_propagates_canvas_lock_busy(
    tmp_path: Path, monkeypatch
) -> None:
    """负向：错误面不许被包装改写，`CanvasLockBusy` 必须原样穿出来。

    路由那 10 处 `except (CanvasStoreError, CanvasLockBusy)` 靠的就是这一点；
    接缝把它换成别的异常（或裹一层 `ExceptionGroup`），503 就会变成 500。
    打桩取锁而不是真的等满 3s 自旋——超时本身已由
    `tests/test_freezone_canvas_store.py:331` 覆盖，这里要证的是穿透。
    （打桩手法照 `tests/test_backup_files_sync.py:204` 的既有形状。）

    `TCP-EU-C4` 把取锁挪到了 `canvas_write_mutex` 端口后面（B2 §3.8 版本接缝），
    打桩点跟着挪到端口上（`TCP-P41`）。要证的东西一个字没变：取不到锁时抛出来的
    还是那个 `CanvasLockBusy`，没有被包装、也没有被裹进 `ExceptionGroup`。
    """

    project_dir = tmp_path / "project"
    _seed_canvas(project_dir)

    class _BusyMutex:
        def write_mutex(self, *_args, **_kwargs):
            raise CanvasLockBusy("default")

    monkeypatch.setattr(canvas_store, "get_canvas_write_mutex", lambda: _BusyMutex())

    with pytest.raises(CanvasLockBusy) as excinfo:
        await canvas_store.save_canvas_async(project_dir, "default", **_save_kwargs())

    assert excinfo.value.canvas_id == "default"
