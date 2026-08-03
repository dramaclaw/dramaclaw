"""Mirror non-SQLite state/output files to OSS with rclone."""

from __future__ import annotations

import json
import inspect
import os
import subprocess
import sys
import tempfile
from dataclasses import dataclass
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
    env = {
        name: os.environ[name]
        for name in BACKUP_SUBPROCESS_ENV_ALLOWLIST
        if name in os.environ
    }
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

BACKUP_SUBPROCESS_ENV_ALLOWLIST = (
    "PATH",
    "LANG",
    "LC_ALL",
    "TZ",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
)


class BackupServiceEgressDenied(RuntimeError):
    """Stable denial for an invalid backup execution boundary."""

    code = "ORG_SERVICE_EGRESS_DENIED"

    def __init__(self) -> None:
        super().__init__("organization service egress is denied")


class BackupOperationNotReplayable(RuntimeError):
    """Raised when a durable backup operation was already claimed."""


class BackupInvocationFailed(RuntimeError):
    """Secret-free failure after a claimed backup invocation."""

    def __init__(self) -> None:
        super().__init__("backup operation failed")


@dataclass(frozen=True, slots=True)
class BackupServiceIdentity:
    credential_id: str
    credential_version: int

    def __post_init__(self) -> None:
        if type(self.credential_id) is not str or not self.credential_id.strip():
            raise ValueError("credential_id is required")
        if type(self.credential_version) is not int or self.credential_version < 1:
            raise ValueError("credential_version must be positive")


@dataclass(frozen=True, slots=True)
class BackupExecutionContext:
    source: str
    identity: BackupServiceIdentity
    root_operation_id: str
    request_context: object | None = None

    def __post_init__(self) -> None:
        if self.source not in {"cli", "operations"}:
            return
        if type(self.identity) is not BackupServiceIdentity:
            raise TypeError("identity must be a BackupServiceIdentity")
        if (
            type(self.root_operation_id) is not str
            or not self.root_operation_id.strip()
        ):
            raise ValueError("root_operation_id is required")


def trusted_backup_cli_context(root_operation_id: str) -> BackupExecutionContext:
    """Construct the explicit service identity used only by backup CLI entrypoints."""

    return BackupExecutionContext(
        source="cli",
        identity=BackupServiceIdentity(
            credential_id="svc-backup",
            credential_version=1,
        ),
        root_operation_id=root_operation_id,
    )


def require_backup_execution_context(context: BackupExecutionContext) -> None:
    if (
        type(context) is not BackupExecutionContext
        or context.source not in {"cli", "operations"}
        or type(context.identity) is not BackupServiceIdentity
        or context.request_context is not None
    ):
        raise BackupServiceEgressDenied()


async def run_backup_operation(
    *,
    context: BackupExecutionContext,
    capability: str,
    business_task_id: str,
    request: object,
    operations,
    invoke,
):
    """Run one CLI/operations-only backup side effect under a durable claim."""

    from novelvideo.egress_context import TrustedEgressContext
    from novelvideo.ports.egress_operations import (
        OperationSpec,
        canonical_request_digest,
    )

    require_backup_execution_context(context)
    if (
        type(capability) is not str
        or not capability.startswith("backup.storage.")
        or not business_task_id
        or not callable(getattr(operations, "claim", None))
    ):
        raise BackupServiceEgressDenied()
    if (
        type(context.request_context) is TrustedEgressContext
        and context.request_context.is_organization
    ):
        raise BackupServiceEgressDenied()

    claim = await operations.claim(
        spec=OperationSpec(
            organization_id="service:backup",
            project_id="operations",
            root_task_id=context.root_operation_id,
            business_task_id=business_task_id,
            capability=capability,
            credential_id=context.identity.credential_id,
            credential_version=context.identity.credential_version,
            request_digest=canonical_request_digest(request),
        )
    )
    if not claim.won:
        raise BackupOperationNotReplayable("backup operation already claimed")

    try:
        result = invoke()
        if inspect.isawaitable(result):
            result = await result
    except Exception:
        try:
            await operations.mark_unknown(
                operation_id=claim.operation.operation_id,
                transition_token=claim.transition_token,
                expected_version=claim.operation.version,
            )
        except Exception:
            pass
        raise BackupInvocationFailed() from None
    await operations.mark_completed(
        operation_id=claim.operation.operation_id,
        transition_token=claim.transition_token,
        expected_version=claim.operation.version,
        result_ref="service-operation-completed",
    )
    return result


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
    state_dir: Path, state_root: str, history_root: str, env: dict[str, str]
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


def main(*, execution_context: BackupExecutionContext | None = None) -> int:
    require_backup_execution_context(
        execution_context or trusted_backup_cli_context("files-sync-cli")
    )
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
