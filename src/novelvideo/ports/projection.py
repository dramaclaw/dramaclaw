"""Task projection port.

Whether a task payload carries a projection is a deployment question, not a
runtime one: the default inline backend does not need one (enqueue and
execution are the same process on the same machine), while a non-inline backend
does.  So the decision lives in a port -- install a projector and payloads get
one, install none and they do not.

That also makes rollback a deployment action rather than a code change, which
is why this port must keep a ``PortNotRegistered`` fallback and must not be
added to ``ports/registry.py``'s required list.  A required port would make a
build without a projector refuse to start, and "just don't install it" would
stop being a thing anyone can do.

Nothing on the read side needs a port: ``task_backend.projection.read_projection``
is a pure function over the payload.
"""

from __future__ import annotations

from typing import Any, Mapping, Protocol


class TaskProjection(Protocol):
    async def build(
        self, store: Any, config: Mapping[str, Any], *, task_type: str
    ) -> dict[str, Any] | None:
        """Collect the project state ``task_type`` needs, or ``None`` for none.

        ``None`` means the caller writes no ``projection`` key at all, leaving
        the payload byte-for-byte what it would have been.
        """
        ...
