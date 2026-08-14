"""Local task projection adapter: project nothing.

The default inline backend runs the task in the same process that enqueued it,
so there is nothing to carry the state across -- the worker reads it directly,
exactly as it always has.  Returning ``None`` keeps the payload identical to
one built before this port existed.
"""

from __future__ import annotations

from typing import Any, Mapping


class NoOpTaskProjection:
    async def build(
        self, store: Any, config: Mapping[str, Any], *, task_type: str
    ) -> dict[str, Any] | None:
        _ = (store, config, task_type)
        return None
