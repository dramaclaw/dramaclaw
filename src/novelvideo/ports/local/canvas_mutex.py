"""Local canvas write mutex adapter: 今天那把文件锁，逐字不变。

CE 是单机部署，`flock` 在单机上是完整答案（B2-9：取锁语义不换、`canvas_lock.py`
不删）。这个适配器只是把既有的 `canvas_write_lock` 摆进端口的形状里，一行行为都
不加：同样的锁文件、同样的自旋、同样的 `CanvasLockBusy`。
"""

from __future__ import annotations

from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

from novelvideo.freezone.canvas_lock import canvas_write_lock

# `canvas_write_lock` 的默认等待上限。写在这里是为了让「不传 timeout」有一个可读的
# 出处；改这个数不等于改 CE 的行为，因为下面显式传的就是同一个值。
FILE_LOCK_WAIT_SECONDS = 3.0


class FileLockCanvasWriteGuard:
    """文件锁不会中途丢，所以围栏无事可做。"""

    def reassert(self) -> None:
        return None


class FileLockCanvasWriteMutex:
    @contextmanager
    def write_mutex(
        self,
        project_dir: Path,
        canvas_id: str,
        *,
        actor: str | None = None,
        timeout_seconds: float | None = None,
        **kwargs,
    ) -> Iterator[FileLockCanvasWriteGuard]:
        _ = actor  # 文件锁不记谁在持有：锁的生命周期就是进程的生命周期。
        with canvas_write_lock(
            project_dir,
            canvas_id,
            timeout_seconds=(
                FILE_LOCK_WAIT_SECONDS if timeout_seconds is None else timeout_seconds
            ),
            **kwargs,
        ):
            yield FileLockCanvasWriteGuard()
