"""Locate SQLite files under state/ for the daily snapshot job.

Nothing converts journal modes here: Litestream switches every database it
replicates to WAL, and data.db is switched by ensure_sqlite_schema.

The state tree is mostly Freezone history (canvas snapshots, generation and
event logs), and that part grows with use. So the walk prunes those trees,
only opens files named like a database, and confirms each by its header,
rather than opening every file under state/.
"""

from __future__ import annotations

import os
from collections.abc import Iterator
from pathlib import Path, PurePath

from novelvideo.backup.scope import is_deprecated_cognee_path

_SQLITE_MAGIC = b"SQLite format 3\x00"
# Every database the app creates under state/ uses one of these suffixes
# (data.db, chat.db, settings.db, *.sqlite3, ...). WAL/SHM/journal sidecars and
# our own .snapshot files end differently, so they drop out here too.
_SQLITE_SUFFIXES = frozenset({".db", ".sqlite", ".sqlite3"})
# Freezone's append-only history: per-canvas snapshots, deleted-canvas archives,
# per-node generation logs and canvas event logs. JSON/JSONL only, never SQLite.
_HISTORY_DIRS = frozenset({"_history", "_deleted", "_generation_history", "_canvas_events"})
# Hermes owns its cache/session databases; only its top-level state.db is ours.
_HERMES_HOME = ".hermes"


def _skip_dir(relative: PurePath) -> bool:
    name = relative.name
    if name in _HISTORY_DIRS or name.endswith("-litestream"):
        return True
    # Deprecated Cognee stores are skipped; see novelvideo.backup.scope.
    return is_deprecated_cognee_path(relative / "_")


def _has_sqlite_magic(path: Path) -> bool:
    try:
        with path.open("rb") as file:
            return file.read(len(_SQLITE_MAGIC)) == _SQLITE_MAGIC
    except OSError:
        return False


def iter_sqlite_files(state_dir: Path) -> Iterator[Path]:
    root = Path(state_dir)
    found: list[Path] = []
    for dirpath, dirnames, filenames in os.walk(root):
        current = Path(dirpath)
        if current.name == _HERMES_HOME:
            dirnames.clear()
        else:
            relative = current.relative_to(root)
            dirnames[:] = [name for name in dirnames if not _skip_dir(relative / name)]
        for name in filenames:
            if PurePath(name).suffix not in _SQLITE_SUFFIXES:
                continue
            path = current / name
            if path.is_file() and _has_sqlite_magic(path):
                found.append(path)
    yield from sorted(found)
