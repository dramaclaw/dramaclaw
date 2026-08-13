"""B2 §6.4 步 7：`normalize_queue_kind` 的静默回落改为抛异常。

依据：B2 §2.6（`task_backend/queues.py:8-10` 对未知值静默回落 `"default"`，
拼错的 lane 名会悄悄跑进 default 池）与 B2 §6.4 步 7 的 RED
（「拼错的 lane 名 → 抛异常，而不是静默落进 `default`」）。
合法值的行为必须逐字不变。
"""

from __future__ import annotations

import pytest

from novelvideo.task_backend.queues import (
    QUEUE_KINDS,
    normalize_queue_kind,
    queue_name,
)


@pytest.mark.parametrize("bogus", ["vidoe", "canvas", "worlds", "DEFAULTS", "ffmpeg2"])
def test_normalize_queue_kind_rejects_unknown_lane(bogus: str) -> None:
    with pytest.raises(ValueError) as excinfo:
        normalize_queue_kind(bogus)
    assert bogus in str(excinfo.value)


@pytest.mark.parametrize("lane", sorted(QUEUE_KINDS))
def test_normalize_queue_kind_keeps_known_lanes_verbatim(lane: str) -> None:
    assert normalize_queue_kind(lane) == lane
    assert normalize_queue_kind(f"  {lane.upper()}  ") == lane


@pytest.mark.parametrize("absent", [None, "", "   "])
def test_normalize_queue_kind_treats_absent_as_default(absent: str | None) -> None:
    """缺省仍然回落 `default` —— 今天 `(kind or "default")` 就是这个语义。

    抛异常针对的是「拼错的 lane 名」，不是「没写 lane」。
    """
    assert normalize_queue_kind(absent) == "default"


def test_queue_name_propagates_unknown_lane() -> None:
    with pytest.raises(ValueError):
        queue_name("node-1", "vidoe")


@pytest.mark.parametrize("lane", sorted(QUEUE_KINDS))
def test_queue_name_for_known_lane_unchanged(lane: str) -> None:
    assert queue_name("node-1", lane) == f"node.node-1.{lane}"


def test_queue_name_without_lane_uses_default() -> None:
    assert queue_name("node-1") == "node.node-1.default"
