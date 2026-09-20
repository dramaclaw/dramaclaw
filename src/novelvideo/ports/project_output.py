"""Storage-specific project output cleanup."""

from __future__ import annotations

from typing import Protocol

from novelvideo.ports.project import ProjectRecord


class ProjectOutputPurger(Protocol):
    async def purge(self, project: ProjectRecord) -> None:
        """Remove and verify the project's current output data."""

    async def has_current_data(self, project: ProjectRecord) -> bool:
        """Return whether a new project would inherit current output data."""
