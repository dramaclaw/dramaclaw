"""Canvas write mutex port.

一张画布同一时刻只能有一个写者。今天这条互斥由 `freezone/canvas_lock.py` 的
`flock` 提供，它在**一台机器**上成立：单机部署里这就是全部答案，而多 Pod 部署里
两个进程各自 `flock` 各自那份挂载视图，谁也拦不住谁——两次保存各写各的临时文件、
各自 `os.replace`，后 rename 的赢，前一次更新静默消失。

于是「用什么做互斥」是**部署问题**，不是运行时问题：装文件锁就得到今天的行为，
装一个跨机器成立的实现（EE 的 Postgres 短事务租约）就得到跨机器的互斥。所以它是
一个端口，而且**必须保留 `PortNotRegistered` 回退**、**不许进 `_EE_REQUIRED_PORTS`**：
「不注入」就是回滚动作，它得一直是合法状态。

## 为什么守卫上多一个 `reassert`

文件锁不会中途丢：进程活着，`flock` 就在。租约会——它有 TTL，超时之后别人可以
就地接管。所以关键区里存在一个文件锁没有的状态：**「我以为我还持有，其实已经不是
我的了」**。`reassert()` 是那道落盘围栏（B2-11），挂在「临时文件已 fsync、
`os.replace` 还没发生」之间：过了这一点写入就不可逆，过不了就什么也没发生。
CE 的实现里它是空操作——没有可丢的东西，也就没有什么要复验。
"""

from __future__ import annotations

from pathlib import Path
from typing import ContextManager, Protocol

from novelvideo.freezone.canvas_lock import CanvasLockBusy


class CanvasLeaseLost(CanvasLockBusy):
    """租约在关键区中途不再属于我们（取不到，或写到一半被接管）。

    继承 `CanvasLockBusy` 是有意的：对调用方来说这两件事的**处置完全一样**——
    这次写没发生，重试即可。于是 `api/routes/freezone.py` 的错误面一行不用改，
    既有的 503 + `canvas_lock_busy` + `Retry-After: 1` 自动接住它。

    类型上仍然可分，日志与用例要能把「等不到」和「写到一半丢了」分开统计。
    """

    def __init__(self, canvas_id: str):
        # 绕开 `CanvasLockBusy.__init__` 的文案，但保留它的 `canvas_id` 契约。
        RuntimeError.__init__(self, f"canvas write lease lost: {canvas_id}")
        self.canvas_id = canvas_id


class CanvasWriteGuard(Protocol):
    def reassert(self) -> None:
        """确认互斥此刻仍然属于我们，否则抛 `CanvasLeaseLost`。

        调用点是不可逆落盘的**前一行**。实现可以是空操作（文件锁）。
        """
        ...


class CanvasWriteMutex(Protocol):
    def write_mutex(
        self,
        project_dir: Path,
        canvas_id: str,
        *,
        actor: str | None = None,
        timeout_seconds: float | None = None,
    ) -> ContextManager[CanvasWriteGuard]:
        """独占这张画布的写权限，超时抛 `CanvasLockBusy` / `CanvasLeaseLost`。

        `timeout_seconds=None` 表示用实现自己的默认等待上限——CE 与 EE 的默认值
        不同（文件锁 3.0s vs `CANVAS_LOCK_WAIT_SECONDS`），调用方不该替它们选。
        """
        ...
