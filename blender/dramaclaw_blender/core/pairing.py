"""配对轮询的状态机。

刻意不发请求：发请求要在 Blender 的定时器里做，而定时器里的代码很难测。这里只回答
「还该不该再问一次」和「结束时该跟用户说什么」，UI 层照做。
"""

from __future__ import annotations


class PairingSession:
    MAX_CONSECUTIVE_FAILURES = 5
    POLL_INTERVAL_SECONDS = 2.0

    def __init__(self, *, pairing_id: str, code: str, deadline: float) -> None:
        self.pairing_id = pairing_id
        self.code = code
        self.deadline = deadline
        self.token: str | None = None
        self.error: str | None = None
        self.finished = False
        self._failures = 0

    def should_poll(self, *, now: float) -> bool:
        if self.finished:
            return False
        if now > self.deadline:
            self.finished = True
            self.error = "配对码已过期，请重新点「连接」"
            return False
        return True

    def apply(self, payload: dict, *, now: float) -> None:
        """消化一次轮询的回应。"""
        self._failures = 0
        status = str(payload.get("status") or "")

        if status == "approved":
            self.token = str(payload.get("token") or "")
            self.finished = True
            return
        if status == "expired":
            self.finished = True
            self.error = "配对码已过期，请重新点「连接」"
            return
        if status == "consumed":
            self.finished = True
            self.error = "这个配对码已经用过了，请重新点「连接」"
            return
        # pending 或任何没见过的状态：继续等，让 deadline 去收尾。
        self.should_poll(now=now)

    def fail_once(self, message: str) -> None:
        """一次传输失败。

        网抖一下不该让用户重开配对——码还没过期。连着失败到一定次数才放弃，
        免得在一个已经断掉的连接上空转到码过期。
        """
        self._failures += 1
        if self._failures >= self.MAX_CONSECUTIVE_FAILURES:
            self.finished = True
            self.error = message
