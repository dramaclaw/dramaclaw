"""限流拒绝的统一日志接缝。

住在这里而不是 ``api/app.py``:撞闸有两条出口 —— 全局 exception handler
(渲染 429),以及扇出循环的本地捕获(已投出 k > 0 个时吞掉异常、返回 200 ＋
``rejected``)。日志只挂在前者就漏掉后者,而后者恰是最值得看的一类事件:
用户拿到 200、面板上一条记录都没有。

本模块只依赖 ``limits`` 里的异常定义,两条出口都能 import,不会绕成环。
"""

from __future__ import annotations

import logging

logger = logging.getLogger(__name__)

# 字段顺序固定,便于 grep 与按 pattern 切分;缺失的填 "-" 而不是省略,
# 免得下游按位置解析时错位。除 ``limit_scope`` 外全部逐字对应异常的属性名。
_LOG_FIELDS = (
    "limit_scope",
    "scope_kind",
    "org_id",
    "queue_kind",
    "limit",
    "active",
    "queued",
    "requester_user_id",
    "project_id",
)


def _render(value: object) -> str:
    return "-" if value is None else str(value)


def log_task_limit_rejection(exc: BaseException, *, limit_scope: str) -> None:
    """把一次撞闸写成一行可 grep 的 WARNING。

    ``limit_scope`` 由调用方给:它在两条出口各有一份算法(handler 的
    ``limit_scope`` 与扇出的 ``rejected.reason``),两侧同算法是它们之间的
    漂移探测器,不能在这里合并掉。其余字段一律从异常自身取,故两条出口
    记出来的行逐字同形。只记业务 ID,不记用户名/项目名。
    """
    rendered = " ".join(
        "%s=%s"
        % (
            name,
            _render(limit_scope if name == "limit_scope" else getattr(exc, name, None)),
        )
        for name in _LOG_FIELDS
    )
    logger.warning("task lane limit rejected %s", rendered)
