"""Daily in-place SQLite snapshots via VACUUM INTO."""

from __future__ import annotations

import os
import sqlite3
import sys
from pathlib import Path

from novelvideo.backup.wal_migrator import iter_sqlite_files

SNAPSHOT_SUFFIX = ".snapshot"


def snapshot_state_tree(state_dir: Path) -> tuple[int, int]:
    """Create `<db>.snapshot` next to every SQLite database under state_dir."""

    ok = 0
    failed = 0
    for db_path in iter_sqlite_files(state_dir):
        # Hermes owns its own SQLite settings; keep the top-level state.db daily
        # snapshot, but skip cache/session SQLite files in deeper subdirectories.
        if ".hermes" in db_path.parts and db_path.parent.name != ".hermes":
            continue
        target = db_path.with_name(db_path.name + SNAPSHOT_SUFFIX)
        tmp = db_path.with_name(db_path.name + SNAPSHOT_SUFFIX + ".tmp")
        tmp.unlink(missing_ok=True)
        try:
            conn = sqlite3.connect(db_path, timeout=30)
            try:
                conn.execute("PRAGMA busy_timeout=30000")
                conn.execute("VACUUM INTO ?", (str(tmp),))
            finally:
                conn.close()
            tmp.replace(target)
            ok += 1
        except sqlite3.Error as exc:
            print(f"snapshot failed: {db_path}: {exc}", file=sys.stderr, flush=True)
            tmp.unlink(missing_ok=True)
            failed += 1
    return ok, failed


def main() -> int:
    state_dir = Path(os.environ["NOVELVIDEO_STATE_DIR"])

    if not state_dir.is_dir():
        print(f"state dir missing: {state_dir}", file=sys.stderr, flush=True)
        return 1

    ok, failed = snapshot_state_tree(state_dir)
    print(f"db-daily snapshots: ok={ok} failed={failed}", flush=True)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
