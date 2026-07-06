"""Mirror non-SQLite state/output files to OSS with rclone."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

# Per-user .hermes dirs hold agent runtime state: keep only config/memory —
# never sync .env (secrets), caches, logs or tmp to the backup bucket.
RCLONE_FILTER = """\
- *.db
- *.db-*
- cognee_db
- cognee_db-*
- *-litestream/**
- *.snapshot
- *.snapshot.tmp
- .hermes/.env
- .hermes/*_cache/**
- .hermes/logs/**
- .hermes/tmp/**
- .hermes/.cache/**
- .hermes/.local/**
+ **
"""


def build_rclone_env() -> dict[str, str]:
    env = dict(os.environ)
    endpoint = os.environ["BACKUP_OSS_ENDPOINT"]
    env.update(
        RCLONE_CONFIG_OSS_TYPE="s3",
        RCLONE_CONFIG_OSS_PROVIDER="Alibaba",
        RCLONE_CONFIG_OSS_ACCESS_KEY_ID=os.environ["BACKUP_OSS_AK"],
        RCLONE_CONFIG_OSS_SECRET_ACCESS_KEY=os.environ["BACKUP_OSS_SK"],
        RCLONE_CONFIG_OSS_ENDPOINT=f"https://{endpoint}",
        RCLONE_S3_NO_CHECK_BUCKET="true",
    )
    return env


def build_sync_cmd(*, src: str, dst: str, history_dst: str, filter_file: Path) -> list[str]:
    return [
        "rclone",
        "sync",
        src,
        dst,
        "--filter-from",
        str(filter_file),
        "--backup-dir",
        history_dst,
        "--fast-list",
        "--transfers",
        "8",
        "--skip-links",
        # Hot files (freezone canvas json / _canvas_events jsonl / idempotency json)
        # keep being written during the sync; without this flag rclone flags them as
        # "corrupted on transfer: md5/size differ" and the whole job exits 1. They are
        # normal live-data churn, not corruption — skip the post-transfer recheck and
        # let the next sync round pick up the latest content.
        "--local-no-check-updated",
        "--log-level",
        "INFO",
    ]


SNAPSHOT_SUFFIX = ".snapshot"


def build_snapshot_copyto_cmd(*, src: Path, dst: str, history_dst: str) -> list[str]:
    return [
        "rclone",
        "copyto",
        str(src),
        dst,
        "--backup-dir",
        history_dst,
        "--log-level",
        "INFO",
    ]


def sync_db_snapshots(state_dir: Path, state_root: str, history_root: str, env: dict[str, str]) -> int:
    """Copy `<name>.snapshot` files to the remote mirror using their natural DB names."""

    rc = 0
    for snap in sorted(state_dir.rglob(f"*{SNAPSHOT_SUFFIX}")):
        if not snap.is_file():
            continue
        rel = snap.relative_to(state_dir).as_posix()[: -len(SNAPSHOT_SUFFIX)]
        rc |= _run(
            build_snapshot_copyto_cmd(
                src=snap,
                dst=f"{state_root}/{rel}",
                history_dst=f"{history_root}/{rel}.prev",
            ),
            env,
        )
    return rc


def _run(cmd: list[str], env: dict[str, str]) -> int:
    print("+", " ".join(cmd), flush=True)
    return subprocess.run(cmd, env=env).returncode


def main() -> int:
    bucket = os.environ["BACKUP_OSS_BUCKET"]
    prefix = os.environ["BACKUP_OSS_PREFIX"].strip("/")
    state_dir = os.environ["NOVELVIDEO_STATE_DIR"]
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    env = build_rclone_env()
    root = f"oss:{bucket}/{prefix}"

    with tempfile.NamedTemporaryFile("w", suffix=".filter", delete=False) as file:
        file.write(RCLONE_FILTER)
        filter_file = Path(file.name)

    rc = _run(
        build_sync_cmd(
            src=state_dir,
            dst=f"{root}/state",
            history_dst=f"{root}/files-history/{timestamp}/state",
            filter_file=filter_file,
        ),
        env,
    )
    rc |= sync_db_snapshots(
        Path(state_dir),
        f"{root}/state",
        f"{root}/files-history/{timestamp}/state",
        env,
    )

    if os.environ.get("BACKUP_SYNC_OUTPUT") == "1":
        output_dir = os.environ["NOVELVIDEO_OUTPUT_DIR"]
        rc |= _run(
            build_sync_cmd(
                src=output_dir,
                dst=f"{root}/output",
                history_dst=f"{root}/files-history/{timestamp}/output",
                filter_file=filter_file,
            ),
            env,
        )

    if rc == 0:
        marker = json.dumps({"timestamp": timestamp, "job": "files-sync"})
        rc = subprocess.run(
            ["rclone", "rcat", f"{root}/.last_success"],
            input=marker.encode(),
            env=env,
        ).returncode

    return rc


if __name__ == "__main__":
    sys.exit(main())
