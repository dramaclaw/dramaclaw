"""Mirror non-SQLite state/output files to OSS with rclone."""

from __future__ import annotations

import json
import os
import stat
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import BinaryIO

# Per-user .hermes dirs hold agent runtime state: keep only config/memory — never
# sync .env (secrets), caches, logs or tmp to the backup bucket. Hidden `.*.tmp`
# files are the short-lived side of atomic JSON writes and are never durable state.
_BASE_FILTER_RULES = (
    "- *.db",
    "- *.db-*",
    "- cognee_db",
    "- cognee_db-*",
    "- *-litestream/**",
    "- *.snapshot",
    "- *.snapshot.tmp",
    "- **/.*.tmp",
    "- .hermes/.env",
    "- .hermes/*_cache/**",
    "- .hermes/logs/**",
    "- .hermes/tmp/**",
    "- .hermes/.cache/**",
    "- .hermes/.local/**",
)

HOT_STATE_DIR_NAMES = ("canvases", "canvas_idempotency", "_canvas_events")
_HOT_STATE_PATTERNS = tuple(
    f"**/freezone/{directory}/**" for directory in HOT_STATE_DIR_NAMES
)


def _filter_text(*rules: str) -> str:
    return "\n".join(rules) + "\n"


# Restore uses this filter and must include the canonical hot-state files.
RCLONE_FILTER = _filter_text(*_BASE_FILTER_RULES, "+ **")

# The live-tree pass excludes hot state. Those files are copied from an immutable
# per-run staging tree with HOT_SNAPSHOT_FILTER instead.
LIVE_SYNC_FILTER = _filter_text(
    *_BASE_FILTER_RULES,
    *(f"- {pattern}" for pattern in _HOT_STATE_PATTERNS),
    "+ **",
)
HOT_SNAPSHOT_FILTER = _filter_text(
    *(f"+ {pattern}" for pattern in _HOT_STATE_PATTERNS),
    "- **",
)


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


def build_sync_cmd(
    *, src: str, dst: str, history_dst: str, filter_file: Path
) -> list[str]:
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
        # The live pass excludes high-churn files; the staged pass reads an immutable
        # local copy. Keep this as a final guard for other low-frequency live files.
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


def sync_db_snapshots(
    state_dir: Path,
    state_root: str,
    history_root: str,
    env: dict[str, str],
) -> int:
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


def _run_stage(cmd: list[str], env: dict[str, str], *, stage: str) -> int:
    print(f"backup_stage_start stage={stage}", flush=True)
    rc = _run(cmd, env)
    status = "complete" if rc == 0 else "failed"
    print(f"backup_stage_{status} stage={stage} exit={rc}", flush=True)
    return rc


def _copy_exact(
    source: BinaryIO,
    destination: BinaryIO,
    size: int,
    source_path: Path,
) -> None:
    """Copy exactly the size captured from an already-open source descriptor."""

    remaining = size
    while remaining:
        chunk = source.read(min(1024 * 1024, remaining))
        if not chunk:
            raise OSError(f"source truncated while snapshotting: {source_path}")
        destination.write(chunk)
        remaining -= len(chunk)


def _copy_stable_file(source_path: Path, destination_path: Path) -> int:
    """Copy one file from a stable open descriptor into the staging tree."""

    flags = os.O_RDONLY
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    source_fd = os.open(source_path, flags)
    with os.fdopen(source_fd, "rb") as source:
        source_stat = os.fstat(source.fileno())
        if not stat.S_ISREG(source_stat.st_mode):
            return 0

        destination_path.parent.mkdir(parents=True, exist_ok=True)
        temporary_path = destination_path.with_name(
            f".{destination_path.name}.snapshot.tmp"
        )
        try:
            with temporary_path.open("wb") as destination:
                _copy_exact(source, destination, source_stat.st_size, source_path)
            os.chmod(temporary_path, stat.S_IMODE(source_stat.st_mode))
            os.utime(
                temporary_path,
                ns=(source_stat.st_atime_ns, source_stat.st_mtime_ns),
                follow_symlinks=False,
            )
            temporary_path.replace(destination_path)
        finally:
            temporary_path.unlink(missing_ok=True)
    return source_stat.st_size


def snapshot_hot_state(state_dir: Path, snapshot_dir: Path) -> tuple[int, int, int]:
    """Create per-file-stable copies of the high-churn freezone state trees."""

    roots_seen = 0
    files_copied = 0
    bytes_copied = 0
    for freezone_dir in sorted(state_dir.glob("*/*/freezone")):
        if not freezone_dir.is_dir():
            continue
        for directory_name in HOT_STATE_DIR_NAMES:
            source_root = freezone_dir / directory_name
            if not source_root.is_dir():
                continue
            roots_seen += 1
            try:
                candidates = sorted(source_root.rglob("*"))
            except FileNotFoundError:
                continue
            for source_path in candidates:
                if source_path.name.startswith(".") and source_path.name.endswith(
                    ".tmp"
                ):
                    continue
                try:
                    if source_path.is_symlink() or not source_path.is_file():
                        continue
                    destination_path = snapshot_dir / source_path.relative_to(state_dir)
                    bytes_copied += _copy_stable_file(source_path, destination_path)
                except FileNotFoundError:
                    # A concurrent delete is a valid snapshot boundary. Atomic replaces
                    # remain readable because `_copy_stable_file` owns the old inode.
                    continue
                files_copied += 1
    return roots_seen, files_copied, bytes_copied


def main() -> int:
    bucket = os.environ["BACKUP_OSS_BUCKET"]
    prefix = os.environ["BACKUP_OSS_PREFIX"].strip("/")
    state_dir = os.environ["NOVELVIDEO_STATE_DIR"]
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    env = build_rclone_env()
    root = f"oss:{bucket}/{prefix}"
    stage_parent = Path(os.environ.get("BACKUP_STAGE_DIR", tempfile.gettempdir()))
    stage_parent.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix="files-sync-", dir=stage_parent) as run_dir:
        run_path = Path(run_dir)
        hot_snapshot_dir = run_path / "hot-state"
        live_filter_file = run_path / "live.filter"
        hot_filter_file = run_path / "hot.filter"
        restore_filter_file = run_path / "restore.filter"
        live_filter_file.write_text(LIVE_SYNC_FILTER, encoding="utf-8")
        hot_filter_file.write_text(HOT_SNAPSHOT_FILTER, encoding="utf-8")
        restore_filter_file.write_text(RCLONE_FILTER, encoding="utf-8")

        roots_seen, files_copied, bytes_copied = snapshot_hot_state(
            Path(state_dir),
            hot_snapshot_dir,
        )
        print(
            "backup_snapshot_complete "
            f"roots={roots_seen} files={files_copied} bytes={bytes_copied}",
            flush=True,
        )

        rc = 0
        if roots_seen:
            rc |= _run_stage(
                build_sync_cmd(
                    src=str(hot_snapshot_dir),
                    dst=f"{root}/state",
                    history_dst=f"{root}/files-history/{timestamp}/state",
                    filter_file=hot_filter_file,
                ),
                env,
                stage="hot-state-sync",
            )
        else:
            print(
                "backup_stage_skipped stage=hot-state-sync reason=no-hot-state",
                flush=True,
            )

        rc |= _run_stage(
            build_sync_cmd(
                src=state_dir,
                dst=f"{root}/state",
                history_dst=f"{root}/files-history/{timestamp}/state",
                filter_file=live_filter_file,
            ),
            env,
            stage="state-sync",
        )
        rc |= sync_db_snapshots(
            Path(state_dir),
            f"{root}/state",
            f"{root}/files-history/{timestamp}/state",
            env,
        )

        if os.environ.get("BACKUP_SYNC_OUTPUT") == "1":
            output_dir = os.environ["NOVELVIDEO_OUTPUT_DIR"]
            rc |= _run_stage(
                build_sync_cmd(
                    src=output_dir,
                    dst=f"{root}/output",
                    history_dst=f"{root}/files-history/{timestamp}/output",
                    filter_file=restore_filter_file,
                ),
                env,
                stage="output-sync",
            )

        if rc == 0:
            marker = json.dumps({"timestamp": timestamp, "job": "files-sync"})
            marker_cmd = ["rclone", "rcat", f"{root}/.last_success"]
            print("backup_stage_start stage=success-marker", flush=True)
            rc = subprocess.run(marker_cmd, input=marker.encode(), env=env).returncode
            status = "complete" if rc == 0 else "failed"
            print(
                f"backup_stage_{status} stage=success-marker exit={rc}",
                flush=True,
            )

    status = "success" if rc == 0 else "failed"
    print(f"backup_summary status={status} exit={rc}", flush=True)
    return rc


if __name__ == "__main__":
    sys.exit(main())
