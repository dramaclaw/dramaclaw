"""Local filesystem implementation of project output cleanup."""

from __future__ import annotations

import shutil
from pathlib import Path

import anyio

from novelvideo.ports.project import ProjectRecord


class LocalProjectOutputPurger:
    async def purge(self, project: ProjectRecord) -> None:
        path = Path(project.output_dir)
        if path.is_symlink():
            raise ValueError("project output path is a symlink")
        if path.exists():
            await anyio.to_thread.run_sync(shutil.rmtree, path)
        if path.exists() or path.is_symlink():
            raise OSError("project output still exists after purge")

    async def has_current_data(self, project: ProjectRecord) -> bool:
        path = Path(project.output_dir)
        return path.exists() or path.is_symlink()
