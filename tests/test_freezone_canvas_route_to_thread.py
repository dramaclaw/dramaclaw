"""HTTP 路径上的画布保存必须通过异步适配器移出事件循环。

`save_canvas` 会同步等待当前配置的画布写互斥并执行同步文件 I/O。四个异步 HTTP
handler 必须 `await canvas_store.save_canvas_async(...)`，不得直接调用同步的
`save_canvas`；互斥的等待算法和作用范围由注入的端口实现决定，不属于本模块契约。

两条用例分工：

1. `test_put_canvas_keeps_the_event_loop_alive_while_lock_is_held` —— 真锁争用
   ＋ 真 handler，证 `:11639` 那处确实走了线程。心跳探针沿用
   `tests/test_freezone_canvas_save_to_thread.py` 的形状，那边的对照组
   `test_sync_save_canvas_freezes_the_event_loop` 已经证明它够灵敏
   （同步路径下心跳恰好是 0 次）。
2. `test_freezone_routes_never_call_save_canvas_synchronously` —— AST 不变量，
   把另外三处（`:10868` / `:11055` / `:11193`，其请求体要跑完整套 preset /
   projection 组装才够得到保存）一并钉死，并防回潮。形制照
   `tests/test_billing_fatal_predicate_invariant.py:19`。
"""

from __future__ import annotations

import ast
import asyncio
import json
import threading
import time
from pathlib import Path

import pytest

from novelvideo.api.routes import freezone as freezone_routes
from novelvideo.api.schemas import CanvasPayload
from novelvideo.freezone.canvas_lock import canvas_write_lock
from novelvideo.project_context import ProjectContext

HOLD_SECONDS = 0.3
TICK_SECONDS = 0.01

ROUTES_SOURCE = Path("src/novelvideo/api/routes/freezone.py")


def _project_ctx(tmp_path: Path) -> ProjectContext:
    """照 `tests/test_freezone_image_backend.py:53` 的既有形状。"""

    return ProjectContext(
        project_id="proj_freezone",
        project_name="demo",
        owner_type="user",
        owner_id="owner_1",
        owner_username="admin",
        requester_user_id="owner_1",
        requester_username="admin",
        requester_principals=(("user", "owner_1"),),
        effective_role="editor",
        home_node_id="node_a",
        output_dir=tmp_path / "output" / "admin" / "demo",
        state_dir=tmp_path / "state" / "admin" / "demo",
        runtime_dir=tmp_path / "runtime" / "admin" / "demo",
        is_home_node=True,
    )


def _patch_freezone_project(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Path:
    """打桩项目解析，返回画布真正落盘的那个目录（`:9581` 取的是 `ctx.state_dir`）。"""

    ctx = _project_ctx(tmp_path)

    async def fake_resolve_freezone_project(*_args, **_kwargs):
        return ctx, "admin", "58", tmp_path / "project", str(tmp_path / "output")

    monkeypatch.setattr(freezone_routes, "_resolve_freezone_project", fake_resolve_freezone_project)
    return Path(ctx.state_dir)


def _seed_canvas(canvas_project_dir: Path) -> Path:
    canvas_file = canvas_project_dir / "freezone" / "canvases" / "default.json"
    canvas_file.parent.mkdir(parents=True, exist_ok=True)
    canvas_file.write_text(
        json.dumps(
            {
                "schema_version": 2,
                "canvas_id": "default",
                "project_id": "proj_freezone",
                "canvas_scope": "default",
                "revision": 1,
                "nodes": [{"id": "old"}],
                "edges": [],
                "metadata": {},
            }
        ),
        encoding="utf-8",
    )
    return canvas_file


def _hold_lock_for(canvas_project_dir: Path, seconds: float) -> threading.Thread:
    """另一个持有者占住画布锁，模拟被争用的保存。"""

    acquired = threading.Event()

    def hold() -> None:
        with canvas_write_lock(canvas_project_dir, "default"):
            acquired.set()
            time.sleep(seconds)

    holder = threading.Thread(target=hold, name="canvas-lock-holder")
    holder.start()
    assert acquired.wait(timeout=5.0)
    return holder


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


async def test_put_canvas_keeps_the_event_loop_alive_while_lock_is_held(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`:11639` 的判据：保存被争用时，同一 worker 上别的工作照常推进。"""

    canvas_project_dir = _patch_freezone_project(monkeypatch, tmp_path)
    canvas_file = _seed_canvas(canvas_project_dir)
    holder = _hold_lock_for(canvas_project_dir, HOLD_SECONDS)

    async with _Heartbeat() as heartbeat:
        heartbeat.ticks = 0
        started = time.monotonic()
        result = await freezone_routes.put_canvas(
            project="proj_freezone",
            canvas_id="default",
            body=CanvasPayload(
                nodes=[{"id": "saved_off_loop"}],
                edges=[],
                metadata={},
                base_revision=1,
            ),
            user={"username": "admin", "id": "owner_1"},
        )
        blocked_seconds = time.monotonic() - started

        assert result["data"]["revision"] == 2
        assert blocked_seconds >= HOLD_SECONDS / 2
        # 0.3s / 10ms ≈ 30 次；压到 10 次仍然只有「循环没停」才可能达到。
        assert heartbeat.ticks >= 10

    holder.join(timeout=5.0)
    assert json.loads(canvas_file.read_text(encoding="utf-8"))["nodes"] == [
        {"id": "saved_off_loop"}
    ]


def test_freezone_routes_never_call_save_canvas_synchronously() -> None:
    """四个调用点必须全是 `await canvas_store.save_canvas_async(...)`。

    `save_canvas` 本体保留且仍是同步函数（B2-8：CLI / 备份进程照旧直接调它），
    这条只管路由模块。
    """

    tree = ast.parse(ROUTES_SOURCE.read_text(encoding="utf-8"), filename=str(ROUTES_SOURCE))

    sync_calls: list[int] = []
    awaited_async_calls: list[int] = []
    bare_async_calls: list[int] = []

    awaited = {
        node.value
        for node in ast.walk(tree)
        if isinstance(node, ast.Await) and isinstance(node.value, ast.Call)
    }
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call) or not isinstance(node.func, ast.Attribute):
            continue
        if node.func.attr == "save_canvas":
            sync_calls.append(node.lineno)
        elif node.func.attr == "save_canvas_async":
            (awaited_async_calls if node in awaited else bare_async_calls).append(node.lineno)

    assert sync_calls == []
    assert bare_async_calls == []
    assert len(awaited_async_calls) == 4
