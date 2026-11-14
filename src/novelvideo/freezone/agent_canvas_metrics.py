# SPDX-License-Identifier: Elastic-2.0
# Copyright (c) 2026 ClaymoreLab
"""Process-local counters without canvas content or identity labels."""

from collections import Counter
import threading

_counts: Counter[str] = Counter()
_observations: dict[str, dict] = {}
_lock = threading.Lock()


def count(name: str) -> None:
    with _lock:
        _counts[name] += 1


def metrics_snapshot() -> dict[str, int]:
    with _lock:
        return dict(_counts)


def observe(name: str, value: float) -> None:
    value = float(value)
    with _lock:
        observation = _observations.setdefault(name, {"count": 0, "total": 0.0, "max": value})
        observation["count"] += 1
        observation["total"] += value
        observation["max"] = max(observation["max"], value)


def observations_snapshot() -> dict[str, dict]:
    with _lock:
        return {name: dict(value) for name, value in _observations.items()}
