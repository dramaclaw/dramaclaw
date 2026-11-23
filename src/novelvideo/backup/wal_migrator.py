"""Locate SQLite files under state/ for the daily snapshot job.

Nothing converts journal modes here: Litestream switches every database it
replicates to WAL, and data.db is switched by ensure_sqlite_schema.
"""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

_SQLITE_MAGIC = b"SQLite format 3\x00"
_SIDECAR_SUFFIXES = ("-wal", "-shm", "-journal", ".snapshot", ".snapshot.tmp")


def _is_sidecar_or_litestream(path: Path) -> bool:
    if any(path.name.endswith(suffix) for suffix in _SIDECAR_SUFFIXES):
        return True
    return any(part.endswith("-litestream") for part in path.parts)


def iter_sqlite_files(state_dir: Path) -> Iterator[Path]:
    for path in sorted(Path(state_dir).rglob("*")):
        if not path.is_file() or _is_sidecar_or_litestream(path):
            continue
        try:
            with path.open("rb") as file:
                if file.read(len(_SQLITE_MAGIC)) != _SQLITE_MAGIC:
                    continue
        except OSError:
            continue
        yield path
