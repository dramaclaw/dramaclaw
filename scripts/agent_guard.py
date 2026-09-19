#!/usr/bin/env python3
"""Fail-closed guard for multi-agent work in a dirty repository.

The Markdown ledgers explain intent to humans.  Per-task TOML scopes give every
agent the same machine-readable answer to two narrower questions: which paths a
task may write, and which active tasks intentionally share a path.  A local
atomic lock then prevents two sessions from writing overlapping scopes at once.

This script deliberately uses only the Python standard library so a newly
arrived agent can run it before installing project dependencies.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import socket
import subprocess
import sys
import tomllib
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path, PurePosixPath
from typing import Iterable

VALID_STATUSES = {
    "提案中",
    "方案就绪",
    "执行中",
    "待验收",
    "已阻塞",
    "已完成",
    "已归档",
}
WRITABLE_STATUS = "执行中"
VALID_MODES = {"exclusive", "shared", "read-only", "coordination"}
WRITE_MODES = {"exclusive", "shared"}
REQUIRED_HEADINGS = (
    "目标",
    "非目标",
    "写入边界",
    "协调与冲突",
    "实施方案",
    "风险与回退",
    "验收标准",
    "进展记录",
    "已定下来的决策",
    "待办",
    "阻塞",
    "交接摘要",
)
STATUS_RE = re.compile(r"^\*\*状态\*\*：\s*(.+?)\s*$", re.MULTILINE)
BASELINE_RE = re.compile(r"^\*\*基线\*\*：\s*`([0-9a-fA-F]{7,40})`", re.MULTILINE)
HEADING_RE = re.compile(r"^##\s+(.+?)\s*$", re.MULTILINE)
STATE_ROW_RE = re.compile(
    r"^\|\s*\[([^]]+)]\(tasks/([^)]+)\)\s*\|[^|]*\|\s*([^|]+?)\s*\|",
    re.MULTILINE,
)
OWNER_RE = re.compile(r"^[A-Za-z0-9._-]+/[A-Za-z0-9._:-]+$")


class GuardError(RuntimeError):
    """A violation that must stop the agent before it writes."""


@dataclass(frozen=True)
class Claim:
    path: str
    mode: str
    shared_with: frozenset[str]
    reason: str

    @property
    def is_directory(self) -> bool:
        return self.path.endswith("/**")

    @property
    def base_path(self) -> str:
        return self.path[:-3] if self.is_directory else self.path

    @property
    def writable(self) -> bool:
        return self.mode in WRITE_MODES

    @property
    def allows_write(self) -> bool:
        return self.mode != "read-only"


@dataclass(frozen=True)
class Workstream:
    slug: str
    ledger: str
    baseline: str
    claims: tuple[Claim, ...]
    manifest_path: Path


@dataclass(frozen=True)
class Ledger:
    slug: str
    path: Path
    status: str
    baseline: str
    headings: tuple[str, ...]


@dataclass(frozen=True)
class RepositoryModel:
    root: Path
    workstreams: dict[str, Workstream]
    ledgers: dict[str, Ledger]
    state_statuses: dict[str, str]
    head: str


def _run_git(root: Path, *args: str) -> str:
    process = subprocess.run(
        ["git", "-C", str(root), *args],
        check=False,
        capture_output=True,
        text=True,
    )
    if process.returncode != 0:
        detail = process.stderr.strip() or process.stdout.strip()
        raise GuardError(f"git {' '.join(args)} failed: {detail}")
    return process.stdout.strip()


def repository_root(value: str | None) -> Path:
    candidate = Path(value).resolve() if value else Path(__file__).resolve().parents[1]
    root = _run_git(candidate, "rev-parse", "--show-toplevel")
    return Path(root).resolve()


def normalize_claim_path(raw: str) -> str:
    value = raw.strip().replace("\\", "/")
    if not value or value in {".", "./", "/", "/**", "**"}:
        raise GuardError(f"claim path is too broad or empty: {raw!r}")
    if value.startswith("/"):
        raise GuardError(f"claim path must be repository-relative: {raw!r}")
    if any(char in value for char in "*?[") and not value.endswith("/**"):
        raise GuardError(f"only a trailing '/**' directory claim is supported: {raw!r}")
    base = value[:-3] if value.endswith("/**") else value
    parts = PurePosixPath(base).parts
    if not parts or any(part in {"", ".", ".."} for part in parts):
        raise GuardError(f"claim path contains an unsafe segment: {raw!r}")
    normalized = PurePosixPath(*parts).as_posix()
    return f"{normalized}/**" if value.endswith("/**") else normalized


def claims_overlap(left: Claim, right: Claim) -> bool:
    left_path = left.base_path
    right_path = right.base_path
    if left_path == right_path:
        return True
    if left.is_directory and right_path.startswith(f"{left_path}/"):
        return True
    if right.is_directory and left_path.startswith(f"{right_path}/"):
        return True
    return False


def claim_covers(claim: Claim, path: str) -> bool:
    normalized = normalize_claim_path(path)
    if normalized.endswith("/**"):
        return claims_overlap(claim, Claim(normalized, claim.mode, frozenset(), ""))
    return claim.base_path == normalized or (
        claim.is_directory and normalized.startswith(f"{claim.base_path}/")
    )


def _shared_permission(claim: Claim, other_slug: str) -> bool:
    return "*" in claim.shared_with or other_slug in claim.shared_with


def load_workstream(path: Path) -> Workstream:
    try:
        data = tomllib.loads(path.read_text(encoding="utf-8"))
    except (OSError, tomllib.TOMLDecodeError) as exc:
        raise GuardError(f"cannot read {path}: {exc}") from exc

    if data.get("version") != 1:
        raise GuardError(f"{path}: version must be 1")
    slug = str(data.get("slug", "")).strip()
    ledger = str(data.get("ledger", "")).strip()
    baseline = str(data.get("baseline", "")).strip().lower()
    if not slug or path.stem != slug:
        raise GuardError(f"{path}: slug must equal the manifest filename")
    if ledger != f"docs/agent/tasks/{slug}.md":
        raise GuardError(f"{path}: ledger must be docs/agent/tasks/{slug}.md")
    if not re.fullmatch(r"[0-9a-f]{7,40}", baseline):
        raise GuardError(f"{path}: baseline must be a 7-40 character commit hash")

    raw_claims = data.get("claims")
    if not isinstance(raw_claims, list) or not raw_claims:
        raise GuardError(f"{path}: at least one [[claims]] entry is required")

    claims: list[Claim] = []
    for index, raw_claim in enumerate(raw_claims, start=1):
        if not isinstance(raw_claim, dict):
            raise GuardError(f"{path}: claims entry {index} must be a table")
        claim_path = normalize_claim_path(str(raw_claim.get("path", "")))
        mode = str(raw_claim.get("mode", "")).strip()
        reason = str(raw_claim.get("reason", "")).strip()
        shared_raw = raw_claim.get("shared_with", [])
        if mode not in VALID_MODES:
            raise GuardError(f"{path}: invalid mode {mode!r} for {claim_path}")
        if not isinstance(shared_raw, list) or not all(
            isinstance(item, str) and item.strip() for item in shared_raw
        ):
            raise GuardError(f"{path}: shared_with for {claim_path} must be a string list")
        if mode == "shared" and not shared_raw:
            raise GuardError(f"{path}: shared claim {claim_path} needs shared_with")
        if mode != "shared" and shared_raw:
            raise GuardError(f"{path}: only shared claims may set shared_with")
        if not reason:
            raise GuardError(f"{path}: claim {claim_path} needs a reason")
        claims.append(
            Claim(
                path=claim_path,
                mode=mode,
                shared_with=frozenset(item.strip() for item in shared_raw),
                reason=reason,
            )
        )

    for index, left in enumerate(claims):
        for right in claims[index + 1 :]:
            if claims_overlap(left, right):
                raise GuardError(
                    f"{path}: overlapping claims inside one task: {left.path} and {right.path}"
                )
    return Workstream(slug, ledger, baseline, tuple(claims), path)


def load_ledger(root: Path, workstream: Workstream) -> Ledger:
    path = root / workstream.ledger
    if not path.is_file():
        raise GuardError(f"missing ledger for {workstream.slug}: {workstream.ledger}")
    text = path.read_text(encoding="utf-8")
    status_match = STATUS_RE.search(text)
    baseline_match = BASELINE_RE.search(text)
    if not status_match:
        raise GuardError(f"{workstream.ledger}: missing **状态** field")
    if not baseline_match:
        raise GuardError(f"{workstream.ledger}: missing commit hash in **基线** field")
    status = status_match.group(1).strip()
    baseline = baseline_match.group(1).lower()
    if status not in VALID_STATUSES:
        raise GuardError(f"{workstream.ledger}: unsupported status {status!r}")
    if baseline != workstream.baseline:
        raise GuardError(
            f"{workstream.slug}: ledger baseline {baseline} != manifest {workstream.baseline}"
        )
    headings = tuple(HEADING_RE.findall(text))
    for required in REQUIRED_HEADINGS:
        if not any(heading.startswith(required) for heading in headings):
            raise GuardError(f"{workstream.ledger}: missing heading starting with '## {required}'")
    return Ledger(workstream.slug, path, status, baseline, headings)


def load_state(root: Path) -> dict[str, str]:
    path = root / "docs/agent/STATE.md"
    if not path.is_file():
        raise GuardError("docs/agent/STATE.md is missing")
    text = path.read_text(encoding="utf-8")
    statuses: dict[str, str] = {}
    for label, filename, status in STATE_ROW_RE.findall(text):
        slug = Path(filename).stem
        if label != slug or filename != f"{slug}.md":
            raise GuardError(f"STATE task link must use its slug verbatim: {label} -> {filename}")
        normalized_status = status.strip()
        if normalized_status not in VALID_STATUSES:
            raise GuardError(f"STATE has unsupported status for {slug}: {normalized_status!r}")
        if slug in statuses:
            raise GuardError(f"STATE lists {slug} more than once")
        statuses[slug] = normalized_status
    if not statuses:
        raise GuardError("STATE does not list any active workstreams")
    return statuses


def load_repository(root: Path, *, require_current_baseline: bool) -> RepositoryModel:
    claims_dir = root / "docs/agent/claims"
    manifests = sorted(claims_dir.glob("*.toml"))
    if not manifests:
        raise GuardError("docs/agent/claims has no task manifests")
    workstreams = {item.slug: item for item in (load_workstream(path) for path in manifests)}
    if len(workstreams) != len(manifests):
        raise GuardError("duplicate workstream slug in claims manifests")

    state_statuses = load_state(root)
    if set(workstreams) != set(state_statuses):
        missing = sorted(set(state_statuses) - set(workstreams))
        orphaned = sorted(set(workstreams) - set(state_statuses))
        raise GuardError(f"STATE / claims mismatch; missing={missing}, orphaned={orphaned}")

    ledgers = {slug: load_ledger(root, stream) for slug, stream in workstreams.items()}
    for slug, ledger in ledgers.items():
        if ledger.status != state_statuses[slug]:
            raise GuardError(
                f"{slug}: ledger status {ledger.status} != STATE status {state_statuses[slug]}"
            )

    validate_cross_task_claims(workstreams)
    head = _run_git(root, "rev-parse", "HEAD").lower()
    if require_current_baseline:
        stale = sorted(
            slug for slug, stream in workstreams.items() if not head.startswith(stream.baseline)
        )
        if stale:
            raise GuardError(
                "current HEAD differs from recorded baseline for: "
                + ", ".join(stale)
                + "; re-audit scopes before writing"
            )
    model = RepositoryModel(root, workstreams, ledgers, state_statuses, head)
    validate_dirty_coverage(model)
    return model


def validate_cross_task_claims(workstreams: dict[str, Workstream]) -> None:
    items = sorted(workstreams.items())
    for index, (left_slug, left_stream) in enumerate(items):
        for right_slug, right_stream in items[index + 1 :]:
            for left in left_stream.claims:
                if not left.writable:
                    continue
                for right in right_stream.claims:
                    if not right.writable or not claims_overlap(left, right):
                        continue
                    if left.mode == right.mode == "shared":
                        if _shared_permission(left, right_slug) and _shared_permission(
                            right, left_slug
                        ):
                            continue
                        raise GuardError(
                            f"shared claim is not mutual: {left_slug}:{left.path} <-> "
                            f"{right_slug}:{right.path}"
                        )
                    raise GuardError(
                        f"unsafe write overlap: {left_slug}:{left.path} ({left.mode}) <-> "
                        f"{right_slug}:{right.path} ({right.mode})"
                    )


def validate_dirty_coverage(model: RepositoryModel) -> None:
    """Every existing dirty path must be protected, even when its owner is unknown."""
    all_claims = [
        claim for workstream in model.workstreams.values() for claim in workstream.claims
    ]
    unclaimed = sorted(
        path
        for path in dirty_paths(model.root)
        if not any(claim_covers(claim, path) for claim in all_claims)
    )
    if unclaimed:
        preview = ", ".join(unclaimed[:12])
        remainder = len(unclaimed) - 12
        suffix = f" (+{remainder} more)" if remainder > 0 else ""
        raise GuardError(
            "dirty paths have no workstream claim: "
            f"{preview}{suffix}; attribute or quarantine them before writing"
        )


def writable_scopes_overlap(left: Workstream, right: Workstream) -> list[tuple[str, str]]:
    overlaps: list[tuple[str, str]] = []
    for left_claim in left.claims:
        if not left_claim.writable:
            continue
        for right_claim in right.claims:
            if right_claim.writable and claims_overlap(left_claim, right_claim):
                overlaps.append((left_claim.path, right_claim.path))
    return overlaps


def lock_root(root: Path) -> Path:
    return root / ".agent-locks"


def _read_lock(path: Path) -> dict[str, object]:
    metadata = path / "lock.json"
    if not metadata.is_file():
        return {"owner": "unknown", "slug": path.name, "created_at": "unknown"}
    try:
        data = json.loads(metadata.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"owner": "unreadable", "slug": path.name, "created_at": "unknown"}
    if not isinstance(data, dict):
        return {"owner": "unreadable", "slug": path.name, "created_at": "unknown"}
    return data


def file_digest(path: Path) -> str:
    if not path.is_file():
        return "<missing>"
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def snapshot_claimed_dirty(model: RepositoryModel, stream: Workstream) -> dict[str, str]:
    return {
        path: file_digest(model.root / path)
        for path in sorted(dirty_paths(model.root))
        if any(claim.allows_write and claim_covers(claim, path) for claim in stream.claims)
    }


class LockMutex:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.path = root / ".mutex"

    def __enter__(self) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        try:
            self.path.mkdir()
        except FileExistsError as exc:
            raise GuardError("another agent is changing locks; retry after it finishes") from exc

    def __exit__(self, exc_type: object, exc: object, traceback: object) -> None:
        try:
            self.path.rmdir()
        except FileNotFoundError:
            pass


def require_workstream(model: RepositoryModel, slug: str) -> Workstream:
    try:
        return model.workstreams[slug]
    except KeyError as exc:
        raise GuardError(f"unknown workstream {slug!r}; read docs/agent/STATE.md") from exc


def require_owner(owner: str) -> str:
    normalized = owner.strip()
    if not OWNER_RE.fullmatch(normalized):
        raise GuardError(
            "--owner must be a stable '<client>/<session-id>' using letters, numbers, "
            "'_', '-', '.', or ':'"
        )
    return normalized


def require_writable_status(model: RepositoryModel, slug: str) -> None:
    status = model.ledgers[slug].status
    if status != WRITABLE_STATUS:
        raise GuardError(
            f"{slug} is {status}, not {WRITABLE_STATUS}; update its reviewed plan before writing"
        )


def require_lockable_status(model: RepositoryModel, slug: str) -> None:
    status = model.ledgers[slug].status
    if status == "已归档":
        raise GuardError(f"{slug} is archived; open a new workstream instead of reviving it")


def require_task_baseline(model: RepositoryModel, slug: str) -> None:
    baseline = model.workstreams[slug].baseline
    if not model.head.startswith(baseline):
        raise GuardError(
            f"{slug} baseline {baseline} differs from HEAD {model.head[:12]}; "
            "re-audit this task's scope before writing"
        )


def acquire(model: RepositoryModel, slug: str, owner: str) -> None:
    stream = require_workstream(model, slug)
    require_lockable_status(model, slug)
    owner = require_owner(owner)
    root = lock_root(model.root)
    target = root / slug
    with LockMutex(root):
        if target.exists():
            data = _read_lock(target)
            raise GuardError(
                f"{slug} is already locked by {data.get('owner')} since "
                f"{data.get('created_at')}"
            )
        for other_path in sorted(root.iterdir()):
            if not other_path.is_dir() or other_path.name.startswith("."):
                continue
            other = model.workstreams.get(other_path.name)
            if other is None:
                raise GuardError(f"unknown stale lock exists: {other_path}")
            data = _read_lock(other_path)
            overlaps = writable_scopes_overlap(stream, other)
            detail = ""
            if overlaps:
                formatted = ", ".join(f"{left} <-> {right}" for left, right in overlaps)
                detail = f"; overlapping scopes: {formatted}"
            raise GuardError(
                f"this checkout already has writer {other.slug} owned by "
                f"{data.get('owner')}{detail}; use a separate worktree for parallel work"
            )
        target.mkdir()
        metadata = {
            "slug": slug,
            "owner": owner,
            "created_at": datetime.now(UTC).isoformat(),
            "host": socket.gethostname(),
            "head": model.head,
            "ledger_sha256": file_digest(model.ledgers[slug].path),
            "claimed_hashes": snapshot_claimed_dirty(model, stream),
        }
        (target / "lock.json").write_text(
            json.dumps(metadata, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )


def require_lock(model: RepositoryModel, slug: str, owner: str) -> dict[str, object]:
    owner = require_owner(owner)
    path = lock_root(model.root) / slug
    if not path.is_dir():
        raise GuardError(f"{slug} has no lock; run acquire before preflight")
    data = _read_lock(path)
    if data.get("owner") != owner:
        raise GuardError(f"{slug} lock belongs to {data.get('owner')}, not {owner}")
    if data.get("head") != model.head:
        raise GuardError(f"{slug} lock was acquired at another HEAD; release and re-audit")
    return data


def release(model: RepositoryModel, slug: str, owner: str, *, force: bool) -> None:
    owner = require_owner(owner)
    if not force:
        handoff(model, slug, owner)
    root = lock_root(model.root)
    target = root / slug
    with LockMutex(root):
        if not target.is_dir():
            raise GuardError(f"{slug} has no lock")
        data = _read_lock(target)
        if not force and data.get("owner") != owner:
            raise GuardError(
                f"{slug} lock belongs to {data.get('owner')}; verify that session ended "
                "before using --force"
            )
        shutil.rmtree(target)


def preflight(model: RepositoryModel, slug: str, owner: str, paths: Iterable[str]) -> None:
    stream = require_workstream(model, slug)
    require_lock(model, slug, owner)
    requested = list(paths)
    if not requested:
        raise GuardError("preflight requires at least one --path")
    for raw_path in requested:
        path = normalize_claim_path(raw_path)
        matches = [
            claim
            for claim in stream.claims
            if claim.allows_write and claim_covers(claim, path)
        ]
        if not matches:
            raise GuardError(f"{slug} has no writable claim for {path}; update the plan first")
        if any(claim.writable for claim in matches):
            require_writable_status(model, slug)
            require_task_baseline(model, slug)


def dirty_paths(root: Path) -> set[str]:
    paths: set[str] = set()
    for args in (
        ("diff", "--name-only"),
        ("diff", "--cached", "--name-only"),
        ("ls-files", "--others", "--exclude-standard"),
    ):
        output = _run_git(root, "-c", "core.quotepath=false", *args)
        paths.update(line for line in output.splitlines() if line)
    return paths


def handoff(model: RepositoryModel, slug: str, owner: str) -> list[str]:
    stream = require_workstream(model, slug)
    lock = require_lock(model, slug, owner)
    ledger = model.ledgers[slug]
    initial_hashes = lock.get("claimed_hashes")
    initial_ledger_hash = lock.get("ledger_sha256")
    if not isinstance(initial_hashes, dict) or not isinstance(initial_ledger_hash, str):
        raise GuardError(
            f"{slug} lock predates handoff snapshots; verify the owner ended, then force-release "
            "and reacquire with the current guard"
        )
    current_hashes = snapshot_claimed_dirty(model, stream)
    changed_since_acquire = sorted(
        path
        for path in set(initial_hashes) | set(current_hashes)
        if initial_hashes.get(path) != current_hashes.get(path)
    )
    if changed_since_acquire and file_digest(ledger.path) == initial_ledger_hash:
        raise GuardError(
            f"{slug} changed claimed files after acquire but did not update its ledger: "
            f"{', '.join(changed_since_acquire)}"
        )
    return sorted(current_hashes)


def list_locks(model: RepositoryModel) -> list[dict[str, object]]:
    root = lock_root(model.root)
    if not root.is_dir():
        return []
    return [
        _read_lock(path)
        for path in sorted(root.iterdir())
        if path.is_dir() and not path.name.startswith(".")
    ]


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", help="repository root (defaults to this script's repository)")
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("check", help="validate STATE, ledgers, scopes, and overlaps")
    subparsers.add_parser("status", help="show local agent locks")

    for name in ("acquire", "preflight", "handoff", "release"):
        command = subparsers.add_parser(name)
        command.add_argument("slug")
        command.add_argument("--owner", required=True)
        if name == "preflight":
            command.add_argument("--path", action="append", default=[])
        if name == "release":
            command.add_argument("--force", action="store_true")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        root = repository_root(args.repo)
        model = load_repository(root, require_current_baseline=False)
        if args.command == "check":
            print(
                f"OK: {len(model.workstreams)} workstreams, "
                f"{sum(len(item.claims) for item in model.workstreams.values())} claims"
            )
        elif args.command == "status":
            locks = list_locks(model)
            if not locks:
                print("No active agent locks.")
            for lock in locks:
                print(
                    f"{lock.get('slug')}: owner={lock.get('owner')} "
                    f"since={lock.get('created_at')} head={lock.get('head')}"
                )
        elif args.command == "acquire":
            acquire(model, args.slug, args.owner)
            print(f"Acquired {args.slug} for {args.owner}.")
        elif args.command == "preflight":
            preflight(model, args.slug, args.owner, args.path)
            print(f"Preflight passed for {args.slug}: {', '.join(args.path)}")
        elif args.command == "handoff":
            claimed = handoff(model, args.slug, args.owner)
            print(f"Handoff passed for {args.slug}; claimed dirty paths: {len(claimed)}")
        elif args.command == "release":
            release(model, args.slug, args.owner, force=args.force)
            print(f"Released {args.slug}.")
        return 0
    except GuardError as exc:
        print(f"BLOCKED: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
