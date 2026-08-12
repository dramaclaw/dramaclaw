"""Mirror non-SQLite state/output files to OSS with rclone."""

from __future__ import annotations

import json
import inspect
import os
import stat
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import BinaryIO

from novelvideo.freezone.canvas_lock import canvas_write_lock
from novelvideo.freezone.paths import CANVAS_ID_RE
from novelvideo.service_operation_gate import (
    ServiceOperationExcluded,
    require_legacy_local_service_operation,
)

# Per-user .hermes dirs hold agent runtime state: keep only config/memory — never
# sync .env (secrets), caches, logs, lock files or tmp to the backup bucket.
# Atomic writers use both hidden and non-hidden `*.tmp` names, so exclude the
# suffix rather than relying on a leading dot.
_BASE_FILTER_RULES = (
    "- *.db",
    "- *.db-*",
    "- cognee_db",
    "- cognee_db-*",
    "- *-litestream/**",
    "- *.snapshot",
    "- *.snapshot.tmp",
    "- *.tmp",
    "- **/freezone/canvases/_locks/**",
    "- .hermes/.env",
    "- .hermes/*_cache/**",
    "- .hermes/logs/**",
    "- .hermes/tmp/**",
    "- .hermes/.cache/**",
    "- .hermes/.local/**",
)

_HOT_STATE_SPECS = (
    ("canvases", "*.json"),
    ("canvas_idempotency", "*.json"),
    ("_canvas_events", "*.jsonl"),
    ("_skill_runs", "*.json"),
    ("_skill_run_idempotency", "*.json"),
    ("", "stale_marks.json"),
)
_HOT_STATE_PATTERNS = tuple(
    (f"**/freezone/{directory}/{pattern}" if directory else f"**/freezone/{pattern}")
    for directory, pattern in _HOT_STATE_SPECS
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
    *_BASE_FILTER_RULES,
    *(f"+ {pattern}" for pattern in _HOT_STATE_PATTERNS),
    "- **",
)


class HotSnapshotError(RuntimeError):
    """The local hot-state snapshot could not be proven complete."""


@dataclass(frozen=True)
class HotStateInventory:
    root_identities: tuple[tuple[Path, int, int], ...]
    files: frozenset[Path]

    @property
    def roots_seen(self) -> int:
        return len(self.root_identities)


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
        HandleKind,
        OperationSpec,
        canonical_request_digest,
        record_unknown_outcome,
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
            handle_kind=HandleKind.NONE,
        )
    )
    if not claim.won:
        raise BackupOperationNotReplayable("backup operation already claimed")

    try:
        result = invoke()
        if inspect.isawaitable(result):
            result = await result
    except Exception:
        await record_unknown_outcome(operations, claim=claim, capability=capability)
        raise BackupInvocationFailed() from None
    # `completed` 只能来自 `accepted`（`0039:294-338`）。原先从 `dispatching` 直跳
    # completed，真库上必抛 P0001；替身没有状态机才一直是绿的。
    accepted = await operations.mark_accepted(
        operation_id=claim.operation.operation_id,
        transition_token=claim.transition_token,
        expected_version=claim.operation.version,
        provider_job_id=None,
    )
    await operations.mark_completed(
        operation_id=accepted.operation_id,
        transition_token=claim.transition_token,
        expected_version=accepted.version,
        result_ref=None,
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
    state_dir: Path,
    state_root: str,
    history_root: str,
    env: dict[str, str],
) -> int:
    """Copy `<name>.snapshot` files to the remote mirror using their natural DB names."""

    snapshots = [
        snap
        for snap in sorted(state_dir.rglob(f"*{SNAPSHOT_SUFFIX}"))
        if snap.is_file() and not snap.is_symlink()
    ]
    print(
        f"backup_stage_start stage=db-snapshots-sync files={len(snapshots)}",
        flush=True,
    )
    rc = 0
    copied = 0
    for snap in snapshots:
        rel = snap.relative_to(state_dir).as_posix()[: -len(SNAPSHOT_SUFFIX)]
        rc = _run(
            build_snapshot_copyto_cmd(
                src=snap,
                dst=f"{state_root}/{rel}",
                history_dst=f"{history_root}/{rel}.prev",
            ),
            env,
        )
        if rc != 0:
            break
        copied += 1
    status = "complete" if rc == 0 else "failed"
    print(
        f"backup_stage_{status} stage=db-snapshots-sync "
        f"files={len(snapshots)} copied={copied} exit={rc}",
        flush=True,
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
            raise HotSnapshotError(
                f"source truncated while snapshotting: {source_path}"
            )
        destination.write(chunk)
        remaining -= len(chunk)


def _copy_stable_file(
    source_path: Path,
    destination_path: Path,
    *,
    allow_append: bool = False,
    validate_json: bool = False,
) -> int:
    """Copy one file from a stable open descriptor into the staging tree."""

    flags = os.O_RDONLY | getattr(os, "O_NONBLOCK", 0) | getattr(os, "O_CLOEXEC", 0)
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        source_fd = os.open(source_path, flags)
    except OSError as exc:
        raise HotSnapshotError(
            f"source changed before it could be snapshotted: {source_path}"
        ) from exc
    with os.fdopen(source_fd, "rb") as source:
        source_stat = os.fstat(source.fileno())
        if not stat.S_ISREG(source_stat.st_mode):
            raise HotSnapshotError(
                f"snapshot source is not a regular file: {source_path}"
            )

        destination_path.parent.mkdir(parents=True, exist_ok=True)
        temporary_path = destination_path.with_name(
            f".{destination_path.name}.snapshot.tmp"
        )
        try:
            with temporary_path.open("wb") as destination:
                _copy_exact(source, destination, source_stat.st_size, source_path)
            final_stat = os.fstat(source.fileno())
            initial_identity = (
                source_stat.st_dev,
                source_stat.st_ino,
                source_stat.st_size,
                source_stat.st_mtime_ns,
                source_stat.st_ctime_ns,
            )
            final_identity = (
                final_stat.st_dev,
                final_stat.st_ino,
                final_stat.st_size,
                final_stat.st_mtime_ns,
                final_stat.st_ctime_ns,
            )
            try:
                current_path_stat = source_path.stat(follow_symlinks=False)
            except OSError as exc:
                raise HotSnapshotError(
                    f"source path changed while it was being snapshotted: {source_path}"
                ) from exc
            if not stat.S_ISREG(current_path_stat.st_mode):
                raise HotSnapshotError(
                    f"source path changed while it was being snapshotted: {source_path}"
                )
            path_was_atomically_replaced = (
                current_path_stat.st_dev,
                current_path_stat.st_ino,
            ) != (source_stat.st_dev, source_stat.st_ino)
            if path_was_atomically_replaced:
                # Replacing the pathname changes the old inode's ctime because its
                # link count drops. Size+mtime on the still-open inode prove that
                # the old complete version itself remained stable while copied.
                stable = (
                    final_stat.st_dev == source_stat.st_dev
                    and final_stat.st_ino == source_stat.st_ino
                    and final_stat.st_size == source_stat.st_size
                    and final_stat.st_mtime_ns == source_stat.st_mtime_ns
                )
            elif allow_append:
                stable = (
                    final_stat.st_dev == source_stat.st_dev
                    and final_stat.st_ino == source_stat.st_ino
                    and final_stat.st_size >= source_stat.st_size
                    and (
                        final_stat.st_size > source_stat.st_size
                        or final_identity == initial_identity
                    )
                )
            else:
                stable = final_identity == initial_identity
            if not stable:
                raise HotSnapshotError(
                    f"source changed while it was being snapshotted: {source_path}"
                )
            if validate_json:
                try:
                    with temporary_path.open("r", encoding="utf-8") as staged_json:
                        json.load(staged_json)
                except (OSError, UnicodeError, json.JSONDecodeError) as exc:
                    raise HotSnapshotError(
                        f"source was not complete JSON while snapshotting: {source_path}"
                    ) from exc
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


def _iter_freezone_dirs(source_dir: Path) -> list[Path]:
    """Find project freezone roots without assuming a fixed owner/project depth."""

    def raise_walk_error(exc: OSError) -> None:
        raise HotSnapshotError("failed to enumerate source tree") from exc

    freezone_dirs: list[Path] = []
    for current, directory_names, _ in os.walk(
        source_dir,
        topdown=True,
        onerror=raise_walk_error,
        followlinks=False,
    ):
        current_path = Path(current)
        symlink_directories = {
            name for name in directory_names if (current_path / name).is_symlink()
        }
        hot_directory_names = {name for name, _ in _HOT_STATE_SPECS if name}
        unsafe_symlinks = {
            name
            for name in symlink_directories
            if name == "freezone"
            or (current_path.name == "freezone" and name in hot_directory_names)
        }
        if unsafe_symlinks:
            raise HotSnapshotError(
                "hot-state directory is a symlink: "
                f"{current_path / sorted(unsafe_symlinks)[0]}"
            )
        directory_names[:] = sorted(
            name for name in directory_names if name not in symlink_directories
        )
        if current_path.name != "freezone":
            continue
        freezone_dirs.append(current_path)
        # A project freezone cannot contain another project freezone. Pruning here
        # avoids walking large media/history trees just to discover snapshot roots.
        directory_names[:] = []
    return sorted(freezone_dirs)


def _hot_state_inventory(source_dir: Path) -> HotStateInventory:
    root_identities: list[tuple[Path, int, int]] = []
    files: set[Path] = set()
    for freezone_dir in _iter_freezone_dirs(source_dir):
        for directory_name, pattern in _HOT_STATE_SPECS:
            source_root = freezone_dir / directory_name
            try:
                before_stat = source_root.stat(follow_symlinks=False)
            except FileNotFoundError:
                # Missing sibling roots are valid. A root that existed during a
                # completed inventory but later disappears is caught by the final
                # before/after inventory comparison.
                continue
            if not stat.S_ISDIR(before_stat.st_mode):
                raise HotSnapshotError(
                    f"hot-state root is not a regular directory: {source_root}"
                )
            root_rel = source_root.relative_to(source_dir)
            try:
                candidates = sorted(source_root.glob(pattern))
            except OSError as exc:
                raise HotSnapshotError(
                    f"failed to enumerate hot-state directory: {source_root}"
                ) from exc
            for source_path in candidates:
                try:
                    source_stat = source_path.stat(follow_symlinks=False)
                except FileNotFoundError as exc:
                    raise HotSnapshotError(
                        f"hot-state file disappeared during inventory: {source_path}"
                    ) from exc
                if not stat.S_ISREG(source_stat.st_mode):
                    raise HotSnapshotError(
                        f"hot-state path is not a regular file: {source_path}"
                    )
                files.add(source_path.relative_to(source_dir))
            try:
                after_stat = source_root.stat(follow_symlinks=False)
            except FileNotFoundError as exc:
                raise HotSnapshotError(
                    f"hot-state directory disappeared during inventory: {source_root}"
                ) from exc
            if (before_stat.st_dev, before_stat.st_ino) != (
                after_stat.st_dev,
                after_stat.st_ino,
            ):
                raise HotSnapshotError(
                    f"hot-state directory was replaced during inventory: {source_root}"
                )
            root_identities.append((root_rel, after_stat.st_dev, after_stat.st_ino))
    return HotStateInventory(tuple(sorted(root_identities)), frozenset(files))


def _canvas_id_for_hot_path(relative_path: Path) -> str | None:
    parts = relative_path.parts
    try:
        freezone_index = len(parts) - 1 - parts[::-1].index("freezone")
    except ValueError:
        return None
    suffix = parts[freezone_index + 1 :]
    if len(suffix) != 2:
        return None
    directory_name, filename = suffix
    if directory_name == "canvas_idempotency" and filename.endswith(".json"):
        candidate = filename.removesuffix(".json")
    elif directory_name == "canvases" and filename.endswith(".deleted.json"):
        candidate = filename.removesuffix(".deleted.json")
    elif directory_name == "canvases" and filename.endswith(".json"):
        candidate = filename.removesuffix(".json")
    else:
        return None
    return candidate if CANVAS_ID_RE.fullmatch(candidate) else None


def _copy_hot_file(source_dir: Path, snapshot_dir: Path, relative_path: Path) -> int:
    is_event_log = "_canvas_events" in relative_path.parts
    return _copy_stable_file(
        source_dir / relative_path,
        snapshot_dir / relative_path,
        allow_append=is_event_log,
        validate_json=relative_path.suffix == ".json",
    )


def snapshot_hot_state(state_dir: Path, snapshot_dir: Path) -> tuple[int, int, int]:
    """Create transaction-safe copies of current high-churn Freezone state.

    Current canvas JSON and its idempotency record are copied while holding the
    same writer lock used by ``save_canvas``. Event logs are copied up to the size
    observed on their open descriptor. A before/after inventory rejects path-set
    changes, so rclone never interprets a transiently missed file as a deletion.
    """

    snapshot_dir.mkdir(parents=True, exist_ok=True)
    before = _hot_state_inventory(state_dir)
    for root_rel, _, _ in before.root_identities:
        (snapshot_dir / root_rel).mkdir(parents=True, exist_ok=True)

    files_copied = 0
    bytes_copied = 0
    copied_paths: set[Path] = set()

    canvas_paths_by_project: dict[Path, dict[str, set[Path]]] = {}
    for relative_path in before.files:
        canvas_id = _canvas_id_for_hot_path(relative_path)
        if canvas_id is None:
            continue
        parts = relative_path.parts
        freezone_index = len(parts) - 1 - parts[::-1].index("freezone")
        project_rel = Path(*parts[:freezone_index])
        canvas_paths_by_project.setdefault(project_rel, {}).setdefault(
            canvas_id,
            set(),
        ).add(relative_path)

    for project_rel, paths_by_canvas in sorted(canvas_paths_by_project.items()):
        project_dir = state_dir / project_rel
        for canvas_id, relative_paths in sorted(paths_by_canvas.items()):
            # Idempotency-only remnants have no active Canvas transaction to pair
            # with. They are copied below with inventory validation instead of
            # creating a new canvases/_locks tree in otherwise empty projects.
            has_canvas_record = any(
                "canvases" in relative_path.parts for relative_path in relative_paths
            )
            if not has_canvas_record:
                continue
            with canvas_write_lock(
                project_dir,
                canvas_id,
                timeout_seconds=10.0,
            ):
                for relative_path in sorted(relative_paths):
                    bytes_copied += _copy_hot_file(
                        state_dir,
                        snapshot_dir,
                        relative_path,
                    )
                    copied_paths.add(relative_path)
                    files_copied += 1

    for relative_path in sorted(before.files - copied_paths):
        bytes_copied += _copy_hot_file(state_dir, snapshot_dir, relative_path)
        files_copied += 1

    after = _hot_state_inventory(state_dir)
    if before != after:
        added = len(after.files - before.files)
        removed = len(before.files - after.files)
        raise HotSnapshotError(
            "hot-state path set changed during snapshot "
            f"(added={added}, removed={removed})"
        )
    return before.roots_seen, files_copied, bytes_copied


def _required_source_dir(env_name: str) -> Path:
    raw_value = os.environ.get(env_name, "").strip()
    if not raw_value:
        raise ValueError(f"{env_name} must name an existing directory")
    source_dir = Path(raw_value).expanduser().resolve()
    if not source_dir.is_dir():
        raise ValueError(f"{env_name} must name an existing directory")
    return source_dir


def _stage_parent(source_dirs: list[Path]) -> Path:
    configured = os.environ.get("BACKUP_STAGE_DIR", "").strip()
    stage_parent = Path(configured or tempfile.gettempdir()).expanduser().resolve()
    for source_dir in source_dirs:
        if stage_parent == source_dir or stage_parent.is_relative_to(source_dir):
            raise ValueError(
                "BACKUP_STAGE_DIR must not be inside a synchronized source tree"
            )
    stage_parent.mkdir(parents=True, exist_ok=True)
    if not stage_parent.is_dir():
        raise ValueError("BACKUP_STAGE_DIR must name a directory")
    return stage_parent


def _sync_snapshot_and_live(
    *,
    source_name: str,
    source_dir: Path,
    snapshot_dir: Path,
    remote_root: str,
    history_root: str,
    live_filter_file: Path,
    hot_filter_file: Path,
    env: dict[str, str],
) -> int:
    rc = _run_stage(
        build_sync_cmd(
            src=str(snapshot_dir),
            dst=remote_root,
            history_dst=history_root,
            filter_file=hot_filter_file,
        ),
        env,
        stage=f"hot-{source_name}-sync",
    )
    if rc != 0:
        return rc
    return _run_stage(
        build_sync_cmd(
            src=str(source_dir),
            dst=remote_root,
            history_dst=history_root,
            filter_file=live_filter_file,
        ),
        env,
        stage=f"{source_name}-sync",
    )


def main(*, execution_context: BackupExecutionContext | None = None) -> int:
    try:
        require_legacy_local_service_operation()
    except ServiceOperationExcluded as exc:
        print(exc.code, file=sys.stderr, flush=True)
        return 2
    require_backup_execution_context(
        execution_context or trusted_backup_cli_context("files-sync-cli")
    )
    bucket = os.environ["BACKUP_OSS_BUCKET"]
    prefix = os.environ["BACKUP_OSS_PREFIX"].strip("/")
    state_dir = _required_source_dir("NOVELVIDEO_STATE_DIR")
    sync_output = os.environ.get("BACKUP_SYNC_OUTPUT") == "1"
    output_dir = _required_source_dir("NOVELVIDEO_OUTPUT_DIR") if sync_output else None
    source_dirs = [state_dir]
    if output_dir is not None:
        source_dirs.append(output_dir)
    stage_parent = _stage_parent(source_dirs)
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    root = f"oss:{bucket}/{prefix}"

    with tempfile.TemporaryDirectory(
        prefix="files-sync-",
        dir=stage_parent,
        ignore_cleanup_errors=True,
    ) as run_dir:
        run_path = Path(run_dir)
        snapshot_dirs = {"state": run_path / "hot-state"}
        if output_dir is not None:
            snapshot_dirs["output"] = run_path / "hot-output"
        live_filter_file = run_path / "live.filter"
        hot_filter_file = run_path / "hot.filter"
        live_filter_file.write_text(LIVE_SYNC_FILTER, encoding="utf-8")
        hot_filter_file.write_text(HOT_SNAPSHOT_FILTER, encoding="utf-8")

        snapshot_sources = [("state", state_dir)]
        if output_dir is not None:
            snapshot_sources.append(("output", output_dir))
        for source_name, source_dir in snapshot_sources:
            print(f"backup_snapshot_start source={source_name}", flush=True)
            try:
                roots_seen, files_copied, bytes_copied = snapshot_hot_state(
                    source_dir,
                    snapshot_dirs[source_name],
                )
            except Exception as exc:
                error_detail = " ".join(str(exc).splitlines())[:500]
                print(
                    "backup_snapshot_failed "
                    f"source={source_name} error_type={type(exc).__name__} "
                    f"error={json.dumps(error_detail)}",
                    flush=True,
                )
                raise
            print(
                "backup_snapshot_complete "
                f"source={source_name} roots={roots_seen} "
                f"files={files_copied} bytes={bytes_copied}",
                flush=True,
            )

        # Credentials and remote commands are intentionally initialized only after
        # every requested local snapshot has completed successfully.
        env = build_rclone_env()
        rc = _sync_snapshot_and_live(
            source_name="state",
            source_dir=state_dir,
            snapshot_dir=snapshot_dirs["state"],
            remote_root=f"{root}/state",
            history_root=f"{root}/files-history/{timestamp}/state",
            live_filter_file=live_filter_file,
            hot_filter_file=hot_filter_file,
            env=env,
        )
        if rc == 0:
            rc = sync_db_snapshots(
                state_dir,
                f"{root}/state",
                f"{root}/files-history/{timestamp}/state",
                env,
            )
        if rc == 0 and output_dir is not None:
            rc = _sync_snapshot_and_live(
                source_name="output",
                source_dir=output_dir,
                snapshot_dir=snapshot_dirs["output"],
                remote_root=f"{root}/output",
                history_root=f"{root}/files-history/{timestamp}/output",
                live_filter_file=live_filter_file,
                hot_filter_file=hot_filter_file,
                env=env,
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
