"""The seam that decides whether payloads carry a projection at all.

Installing a projector is what turns projection on; not installing one is the
rollback. That only works if the port has a fallback -- a required port would
make a build without it refuse to start, and "do not install it" would stop
being a thing anyone can do.
"""

from __future__ import annotations

import pytest


def test_task_projection_is_not_a_required_port() -> None:
    """Listing it would destroy the rollback: no projector, no start."""
    from novelvideo.ports import registry

    assert "task_projection" not in registry._EE_REQUIRED_PORTS


def test_unregistered_projection_port_returns_the_empty_projector() -> None:
    from novelvideo.ports import get_task_projection
    from novelvideo.ports.local.projection import NoOpTaskProjection
    from novelvideo.ports.registry import _PORTS

    _PORTS.pop("task_projection", None)

    assert isinstance(get_task_projection(), NoOpTaskProjection)


def test_registered_projection_port_is_returned_as_is() -> None:
    from novelvideo.ports import get_task_projection
    from novelvideo.ports.registry import register_port

    impl = object()
    register_port("task_projection", impl)

    assert get_task_projection() is impl


@pytest.mark.asyncio
async def test_empty_projector_builds_nothing_for_every_task_type() -> None:
    """``None`` means the caller writes no ``projection`` key, so the payload is
    exactly what it would have been without this module at all."""
    from novelvideo.ports.local.projection import NoOpTaskProjection
    from novelvideo.task_backend.projection import PROJECTION_REQUIREMENTS

    projector = NoOpTaskProjection()
    for task_type in PROJECTION_REQUIREMENTS:
        assert await projector.build(object(), {}, task_type=task_type) is None


def test_get_task_projection_is_exported() -> None:
    import novelvideo.ports as ports

    assert "get_task_projection" in ports.__all__
