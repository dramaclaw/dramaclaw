# SPDX-License-Identifier: Elastic-2.0
# Copyright (c) 2026 ClaymoreLab
"""Process-local counters without canvas content or identity labels."""

from collections import Counter
import threading

_counts: Counter[str] = Counter()
_lock = threading.Lock()


def count(name: str) -> None:
    with _lock:
        _counts[name] += 1


def metrics_snapshot() -> dict[str, int]:
    with _lock:
        return dict(_counts)
