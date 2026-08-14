"""Durable file-backed storage for Freezone canvases."""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import shutil
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

from novelvideo.freezone.paths import canvas_path, canvases_dir
from novelvideo.ports import get_canvas_write_mutex
from novelvideo.utils.async_ops import call_blocking

CANVAS_HISTORY_TS_FORMAT = "%Y%m%d_%H%M%S_%f"
HISTORY_RETENTION_LIMIT = 100
IDEMPOTENCY_LIMIT = 50
IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60
# 「最近有别人写过这张画布」的提示窗口(秒)。取值与 EE 的租约 TTL 对齐:一个写者
# 持有租约期间他的 `updated_at` 一定落在这个窗口里,所以窗口口径 ≈「他还持着」,
# 而窗口过后提示自然消失,不需要任何一次额外查询(§3.9 O2 要求零额外往返)。
CANVAS_EDITING_HINT_WINDOW_SECONDS = 60
CANVAS_PAYLOAD_SIZE_LIMIT_BYTES = int(
    os.environ.get("FREEZONE_CANVAS_PAYLOAD_LIMIT_BYTES") or 5 * 1024 * 1024
)
CANVAS_PAYLOAD_DIAGNOSTIC_LIMIT = 8

logger = logging.getLogger(__name__)


def utc_iso(dt: datetime) -> str:
    """Return an absolute ISO timestamp for API/persisted canvas metadata."""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def utc_now_iso() -> str:
    return utc_iso(datetime.now(timezone.utc))


def timestamp_utc_iso(timestamp: float) -> str:
    return utc_iso(datetime.fromtimestamp(timestamp, tz=timezone.utc))


def parse_canvas_iso(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def canvas_editing_hint(
    payload: dict | None,
    *,
    viewer_id: str,
    now: datetime | None = None,
) -> str | None:
    """「最近 N 秒内有另一个人写过这张画布」——没有就返回 `None`（§3.9 O2）。

    读路径**不许新增数据库往返**,所以这条提示只用读画布时已经在手里的东西:
    载荷自己的 `updated_by` / `updated_at`。它回答的是「谁刚写过」而不是
    「谁此刻持着写锁」——两者在 CE(没有租约表)与 EE 里是同一段代码、同一个口径,
    代价是提示的消失点从「释放锁」变成「窗口过去」(TCP-P40)。

    看不懂的时间戳一律当成「没有提示」:这是个 UI 提示,不是判据,宁可不显示。
    """

    if not isinstance(payload, dict):
        return None
    updated_by = str(payload.get("updated_by") or "").strip()
    if not updated_by or updated_by == str(viewer_id or "").strip():
        return None
    raw_updated_at = payload.get("updated_at")
    if not isinstance(raw_updated_at, str) or not raw_updated_at:
        return None
    try:
        updated_at = parse_canvas_iso(raw_updated_at)
    except ValueError:
        return None
    reference = now or datetime.now(timezone.utc)
    # 多 Pod 之间的时钟偏移可以让 `updated_at` 落在「未来」几秒。用绝对值兜住,
    # 否则一台机器快两秒就再也不会给出提示了。
    age = abs((reference - updated_at).total_seconds())
    if age > CANVAS_EDITING_HINT_WINDOW_SECONDS:
        return None
    return updated_by


class CanvasStoreError(RuntimeError):
    """Base class for canvas storage errors."""


class CanvasCorruptError(CanvasStoreError):
    def __init__(self, message: str):
        super().__init__(message)


class CanvasBaseRevisionRequired(CanvasStoreError):
    def __init__(self):
        super().__init__("canvas base_revision is required")


class CanvasRevisionConflict(CanvasStoreError):
    def __init__(self, *, current_revision: int, base_revision: int | None):
        super().__init__("canvas revision conflict")
        self.current_revision = current_revision
        self.base_revision = base_revision


class CanvasIdempotencyConflict(CanvasStoreError):
    def __init__(self, *, client_save_id: str):
        super().__init__("canvas idempotency key reused for a different payload")
        self.client_save_id = client_save_id


class CanvasInvalidHistoryId(CanvasStoreError):
    def __init__(self):
        super().__init__("invalid history_id")


class CanvasHistoryNotFound(CanvasStoreError):
    def __init__(self):
        super().__init__("canvas history not found")


class DangerousEmptyCanvasOverwrite(CanvasStoreError):
    def __init__(self, *, old_nodes: int, new_nodes: int, save_source: str):
        super().__init__("dangerous empty canvas overwrite")
        self.old_nodes = old_nodes
        self.new_nodes = new_nodes
        self.save_source = save_source


@dataclass(frozen=True)
class CanvasSaveResult:
    payload: dict
    existing: dict | None
    backup_path: Path | None
    idempotent: bool = False
    response_cache: dict | None = None


@dataclass(frozen=True)
class CanvasRestoreResult:
    payload: dict
    existing: dict | None
    history_payload: dict
    backup_path: Path | None


@dataclass(frozen=True)
class CanvasDeleteResult:
    existing: dict | None
    deleted_path: Path | None


@dataclass(frozen=True)
class CanvasEnsureResult:
    payload: dict
    created: bool


def load_canvas_json(path: Path) -> dict | None:
    if not path.exists():
        return None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise CanvasCorruptError(f"corrupt canvas json: {exc}") from exc
    return payload if isinstance(payload, dict) else None


def read_canvas(project_dir: Path, canvas_id: str) -> dict | None:
    return load_canvas_json(canvas_path(project_dir, canvas_id))


def default_canvas_payload(
    *,
    project_id: str,
    actor_id: str = "",
    now: datetime | None = None,
) -> dict:
    timestamp = utc_iso(now) if now is not None else utc_now_iso()
    actor = str(actor_id or "")
    return {
        "schema_version": 2,
        "canvas_id": "default",
        "project_id": project_id,
        "canvas_scope": "default",
        "revision": 1,
        "nodes": [],
        "edges": [],
        "viewport": None,
        "metadata": None,
        "owner_principal_type": "user",
        "owner_principal_id": actor,
        "access_model": "project_role",
        "min_project_role": "editor",
        "created_by": actor,
        "created_at": timestamp,
        "updated_by": actor,
        "updated_at": timestamp,
        "save_source": "system_default",
    }


def ensure_default_canvas(
    project_dir: Path,
    *,
    project_id: str,
    actor_id: str = "",
) -> CanvasEnsureResult:
    with get_canvas_write_mutex().write_mutex(project_dir, "default", actor=actor_id) as guard:
        path = canvas_path(project_dir, "default")
        existing = load_canvas_json(path)
        if isinstance(existing, dict):
            return CanvasEnsureResult(payload=existing, created=False)
        tombstone = path.with_name("default.deleted.json")
        deleted = load_canvas_json(tombstone)
        if isinstance(deleted, dict):
            return CanvasEnsureResult(payload=deleted, created=False)
        payload = default_canvas_payload(project_id=project_id, actor_id=actor_id)
        atomic_write_json(path, payload, fence=guard.reassert)
        return CanvasEnsureResult(payload=payload, created=True)


def atomic_write_json(
    path: Path,
    payload: dict,
    *,
    fence: Callable[[], None] | None = None,
) -> None:
    """写临时文件 → fsync → rename。`fence` 挂在 rename 之前的最后一刻。

    `os.replace` 是这条路径上唯一不可逆的一步:过了它,别人的内容就被覆盖了,
    而且覆盖是原子的、没有中间态可以回退。所以「我此刻是否仍然独占这张画布」
    这个问题必须在**它的前一行**问,而不是函数开头(那时距离落盘还有一整段
    可能跑几百毫秒的 I/O)、也不是它之后(那时问了也没用)。

    `fence` 抛异常 = 这次写没有发生:正式文件一个字节没动,临时文件由 `finally`
    清掉。调用方拿到的是与「一开始就没拿到锁」完全同类的失败(§3.3.3)。
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.{uuid.uuid4().hex}.tmp")
    data = json.dumps(payload, ensure_ascii=False, indent=2)
    try:
        with tmp.open("w", encoding="utf-8") as fh:
            fh.write(data)
            fh.flush()
            os.fsync(fh.fileno())
        if fence is not None:
            fence()
        tmp.replace(path)
        try:
            dir_fd = os.open(str(path.parent), os.O_RDONLY)
        except OSError:
            dir_fd = None
        if dir_fd is not None:
            try:
                os.fsync(dir_fd)
            finally:
                os.close(dir_fd)
    finally:
        if tmp.exists():
            tmp.unlink(missing_ok=True)


def serialized_canvas_size_bytes(payload: dict) -> int:
    data = json.dumps(payload, ensure_ascii=False, indent=2)
    return len(data.encode("utf-8"))


def canvas_request_hash(payload: dict) -> str:
    data = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(data.encode("utf-8")).hexdigest()


def _json_size_bytes(value) -> int:
    return len(json.dumps(value, ensure_ascii=False, indent=2).encode("utf-8"))


def oversized_canvas_diagnostics(payload: dict, *, limit: int) -> list[dict]:
    """Return the largest canvas node/data fields without including field values."""
    rows: list[dict] = []
    nodes = payload.get("nodes")
    if isinstance(nodes, list):
        for index, node in enumerate(nodes):
            if not isinstance(node, dict):
                continue
            node_id = str(node.get("id") or "")
            node_type = str(node.get("type") or "")
            rows.append(
                {
                    "path": f"nodes[{index}]",
                    "node_id": node_id,
                    "node_type": node_type,
                    "bytes": _json_size_bytes(node),
                }
            )
            data = node.get("data")
            if isinstance(data, dict):
                for key, value in data.items():
                    rows.append(
                        {
                            "path": f"nodes[{index}].data.{key}",
                            "node_id": node_id,
                            "node_type": node_type,
                            "bytes": _json_size_bytes(value),
                        }
                    )
    rows.sort(key=lambda row: int(row.get("bytes") or 0), reverse=True)
    result = []
    for row in rows[:limit]:
        size = int(row["bytes"])
        result.append(
            {
                **row,
                "kb": round(size / 1024, 1),
            }
        )
    return result


def canvas_payload_size_warning(payload: dict) -> dict | None:
    limit = CANVAS_PAYLOAD_SIZE_LIMIT_BYTES
    if limit <= 0:
        return None
    actual = serialized_canvas_size_bytes(payload)
    if actual <= limit:
        return None
    top_fields = oversized_canvas_diagnostics(
        payload,
        limit=CANVAS_PAYLOAD_DIAGNOSTIC_LIMIT,
    )
    logger.warning(
        "freezone_canvas_payload_too_large actual_bytes=%s limit_bytes=%s top_fields=%s",
        actual,
        limit,
        top_fields,
    )
    return {
        "code": "canvas_payload_large",
        "actual_kb": (actual + 1023) // 1024,
        "limit_kb": (limit + 1023) // 1024,
        "top_fields": top_fields,
    }


def canvas_history_dir_for_path(path: Path) -> Path:
    return path.parent / "_history"


def canvas_deleted_dir_for_path(path: Path) -> Path:
    return path.parent / "_deleted" / path.stem


def canvas_idempotency_dir(project_dir: Path) -> Path:
    return project_dir / "freezone" / "canvas_idempotency"


def canvas_idempotency_path(project_dir: Path, canvas_id: str) -> Path:
    return canvas_idempotency_dir(project_dir) / f"{canvas_id}.json"


def canvas_history_filename(
    path: Path,
    existing: dict | None,
    *,
    now: datetime | None = None,
) -> str:
    revision = existing.get("revision") if isinstance(existing, dict) else None
    rev_text = f"rev{revision}" if isinstance(revision, int) else "rev_unknown"
    ts = (now or datetime.now()).strftime(CANVAS_HISTORY_TS_FORMAT)
    return f"{path.stem}.{rev_text}.{ts}.json"


def canvas_deleted_filename(existing: dict | None, *, now: datetime | None = None) -> str:
    revision = existing.get("revision") if isinstance(existing, dict) else None
    rev_text = f"rev{revision}" if isinstance(revision, int) else "rev_unknown"
    ts = (now or datetime.now()).strftime(CANVAS_HISTORY_TS_FORMAT)
    return f"{ts}_{rev_text}.json"


def backup_canvas_snapshot(path: Path, existing: dict | None) -> Path | None:
    if not path.exists():
        return None
    history_dir = canvas_history_dir_for_path(path)
    history_dir.mkdir(parents=True, exist_ok=True)
    target = history_dir / canvas_history_filename(path, existing)
    shutil.copy2(path, target)
    return target


def relative_project_path(project_dir: Path, path: Path | None) -> str | None:
    if path is None:
        return None
    try:
        return path.relative_to(project_dir).as_posix()
    except ValueError:
        return path.as_posix()


def load_canvas_idempotency(project_dir: Path, canvas_id: str) -> dict:
    path = canvas_idempotency_path(project_dir, canvas_id)
    payload = load_canvas_json(path)
    if not isinstance(payload, dict):
        return {"canvas_id": canvas_id, "entries": []}
    entries = payload.get("entries")
    if not isinstance(entries, list):
        payload["entries"] = []
    payload["canvas_id"] = canvas_id
    return payload


def _entry_is_fresh(entry: dict, *, now: datetime) -> bool:
    accepted_at = entry.get("accepted_at")
    if not isinstance(accepted_at, str):
        return False
    try:
        accepted = parse_canvas_iso(accepted_at)
    except ValueError:
        return False
    comparable_now = now if now.tzinfo is not None else now.replace(tzinfo=timezone.utc)
    return (comparable_now.astimezone(timezone.utc) - accepted).total_seconds() <= IDEMPOTENCY_TTL_SECONDS


def prune_idempotency_entries(entries: list, *, now: datetime) -> list[dict]:
    fresh = [
        entry for entry in entries if isinstance(entry, dict) and _entry_is_fresh(entry, now=now)
    ]
    fresh.sort(key=lambda entry: str(entry.get("accepted_at") or ""), reverse=True)
    return fresh[:IDEMPOTENCY_LIMIT]


def find_idempotency_entry(project_dir: Path, canvas_id: str, client_save_id: str) -> dict | None:
    now = datetime.now(timezone.utc)
    payload = load_canvas_idempotency(project_dir, canvas_id)
    for entry in prune_idempotency_entries(payload.get("entries") or [], now=now):
        if entry.get("client_save_id") == client_save_id:
            return entry
    return None


def append_idempotency_entry(
    project_dir: Path,
    canvas_id: str,
    *,
    client_save_id: str,
    revision: int | None,
    request_hash: str | None,
    response_cache: dict,
) -> None:
    now = datetime.now(timezone.utc)
    payload = load_canvas_idempotency(project_dir, canvas_id)
    entries = [
        entry
        for entry in prune_idempotency_entries(payload.get("entries") or [], now=now)
        if entry.get("client_save_id") != client_save_id
    ]
    entries.insert(
        0,
        {
            "client_save_id": client_save_id,
            "revision": revision,
            "request_hash": request_hash,
            "accepted_at": utc_iso(now),
            "response_cache": response_cache,
        },
    )
    payload = {"canvas_id": canvas_id, "entries": entries[:IDEMPOTENCY_LIMIT]}
    atomic_write_json(canvas_idempotency_path(project_dir, canvas_id), payload)


def canvas_history_pattern(canvas_id: str) -> re.Pattern[str]:
    return re.compile(
        rf"^{re.escape(canvas_id)}\.rev(?P<revision>\d+|unknown)\."
        rf"(?P<timestamp>\d{{8}}_\d{{6}}_\d{{6}})\.json$"
    )


def history_id_from_path(path: Path) -> str:
    return path.name.removesuffix(".json")


def resolve_canvas_history_file(project_dir: Path, canvas_id: str, history_id: str) -> Path:
    raw = str(history_id or "").strip()
    if not raw or "/" in raw or "\\" in raw or ".." in raw:
        raise CanvasInvalidHistoryId()
    filename = raw if raw.endswith(".json") else f"{raw}.json"
    if not canvas_history_pattern(canvas_id).match(filename):
        raise CanvasInvalidHistoryId()
    history_dir = canvas_history_dir_for_path(canvas_path(project_dir, canvas_id)).resolve()
    candidate = (history_dir / filename).resolve()
    try:
        candidate.relative_to(history_dir)
    except ValueError as exc:
        raise CanvasInvalidHistoryId() from exc
    if not candidate.exists():
        raise CanvasHistoryNotFound()
    return candidate


def canvas_history_entry(path: Path, canvas_id: str) -> dict | None:
    match = canvas_history_pattern(canvas_id).match(path.name)
    if not match:
        return None
    payload = load_canvas_json(path) or {}
    revision_text = match.group("revision")
    timestamp_text = match.group("timestamp")
    try:
        created_at = utc_iso(datetime.strptime(timestamp_text, CANVAS_HISTORY_TS_FORMAT))
    except ValueError:
        created_at = timestamp_utc_iso(path.stat().st_mtime)
    revision: int | None = int(revision_text) if revision_text.isdigit() else None
    return {
        "history_id": history_id_from_path(path),
        "filename": path.name,
        "revision": revision,
        "created_at": created_at,
        "node_count": len(payload.get("nodes") or []),
        "edge_count": len(payload.get("edges") or []),
        "size": path.stat().st_size,
    }


def list_canvases(project_dir: Path) -> list[dict]:
    target = canvases_dir(project_dir)
    if not target.exists():
        return []
    items: list[dict] = []
    for path in target.glob("*.json"):
        if path.name.endswith(".deleted.json"):
            continue
        payload = load_canvas_json(path) or {}
        metadata = payload.get("metadata") if isinstance(payload.get("metadata"), dict) else None
        preset = metadata.get("preset") if isinstance(metadata, dict) else None
        preset_scope = preset.get("scope") if isinstance(preset, dict) else None
        preset_created_at = preset.get("created_at") if isinstance(preset, dict) else None
        canvas_scope = payload.get("canvas_scope") or preset_scope
        episode = payload.get("episode")
        if episode is None and isinstance(preset, dict):
            episode = preset.get("episode")
        beat = payload.get("beat")
        if beat is None and isinstance(preset, dict):
            beat = preset.get("beat")
        created_at = (
            payload.get("created_at")
            or preset_created_at
            or timestamp_utc_iso(path.stat().st_mtime)
        )
        items.append(
            {
                "id": path.stem,
                "created_at": created_at,
                "modified_at": timestamp_utc_iso(path.stat().st_mtime),
                "size": path.stat().st_size,
                "schema_version": payload.get("schema_version"),
                "canvas_scope": canvas_scope,
                "episode": episode,
                "beat": beat,
                "asset_target": payload.get("asset_target"),
                "revision": payload.get("revision"),
                "metadata": metadata,
            }
        )
    def scope_rank(item: dict) -> int:
        if item.get("id") == "default":
            return 0
        if item.get("canvas_scope") == "beat":
            return 1
        if item.get("canvas_scope") == "asset":
            return 2
        return 3

    def numeric_or_last(value: object) -> int:
        try:
            return int(value)
        except (TypeError, ValueError):
            return 1_000_000_000

    items.sort(
        key=lambda item: (
            scope_rank(item),
            numeric_or_last(item.get("episode")),
            numeric_or_last(item.get("beat")),
            str(item.get("created_at") or ""),
            str(item.get("id") or ""),
        )
    )
    return items


def list_canvas_history(project_dir: Path, canvas_id: str) -> list[dict]:
    history_dir = canvas_history_dir_for_path(canvas_path(project_dir, canvas_id))
    if not history_dir.exists():
        return []
    entries = [
        entry
        for path in history_dir.glob(f"{canvas_id}.rev*.json")
        if (entry := canvas_history_entry(path, canvas_id)) is not None
    ]
    entries.sort(key=lambda item: str(item.get("created_at") or ""), reverse=True)
    return entries


def _check_revision(existing: dict | None, base_revision: int | None) -> None:
    current_revision = existing.get("revision") if isinstance(existing, dict) else None
    if not isinstance(current_revision, int):
        return
    if base_revision is None:
        raise CanvasBaseRevisionRequired()
    if base_revision != current_revision:
        raise CanvasRevisionConflict(
            current_revision=current_revision,
            base_revision=base_revision,
        )


def _node_count(payload: dict | None) -> int:
    nodes = payload.get("nodes") if isinstance(payload, dict) else None
    return len(nodes) if isinstance(nodes, list) else 0


def check_dangerous_empty_overwrite(
    *,
    existing: dict | None,
    payload: dict,
    save_source: str,
    allow_empty_overwrite: bool,
) -> None:
    old_nodes = _node_count(existing)
    new_nodes = _node_count(payload)
    # The only legal way to shrink a non-empty canvas to empty is an
    # explicit ``manual_clear`` with ``allow_empty_overwrite=true``. Any
    # other combination (autosave + flag, manual_save with/without flag,
    # manual_clear without flag) is rejected as defense-in-depth — a
    # buggy / refactored / malicious client cannot wipe user data by
    # mislabeling its request.
    if old_nodes > 0 and new_nodes == 0 and not (
        save_source in {"manual_clear", "projection_remove"} and allow_empty_overwrite
    ):
        raise DangerousEmptyCanvasOverwrite(
            old_nodes=old_nodes,
            new_nodes=new_nodes,
            save_source=save_source,
        )


def prune_canvas_history(
    project_dir: Path,
    canvas_id: str,
    *,
    keep: int = HISTORY_RETENTION_LIMIT,
) -> None:
    history_dir = canvas_history_dir_for_path(canvas_path(project_dir, canvas_id))
    if keep <= 0 or not history_dir.exists():
        return
    files = [
        path
        for path in history_dir.glob(f"{canvas_id}.rev*.json")
        if canvas_history_pattern(canvas_id).match(path.name)
    ]
    files.sort(key=lambda path: path.stat().st_mtime, reverse=True)
    for stale in files[keep:]:
        stale.unlink(missing_ok=True)


def latest_preset_canvas(project_dir: Path, preset_key: str) -> str | None:
    candidates = [
        path
        for path in canvases_dir(project_dir).glob("*.json")
        if not path.name.endswith(".deleted.json")
    ]
    candidates.sort(key=lambda path: path.stat().st_mtime, reverse=True)
    for path in candidates:
        try:
            payload = load_canvas_json(path) or {}
        except CanvasStoreError:
            continue
        key = (
            ((payload.get("metadata") or {}).get("preset") or {}).get("preset_key")
            if isinstance(payload, dict)
            else None
        )
        if key == preset_key:
            return path.stem
    return None


def save_canvas(
    project_dir: Path,
    canvas_id: str,
    *,
    base_revision: int | None,
    build_payload: Callable[[dict | None], dict],
    skip_if: Callable[[dict | None], dict | None] | None = None,
    enforce_revision: bool = True,
    client_save_id: str | None = None,
    request_hash: str | None = None,
    save_source: str = "autosave",
    allow_empty_overwrite: bool = False,
) -> CanvasSaveResult:
    with get_canvas_write_mutex().write_mutex(project_dir, canvas_id) as guard:
        path = canvas_path(project_dir, canvas_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        existing = load_canvas_json(path)
        normalized_client_save_id = str(client_save_id or "").strip()
        if normalized_client_save_id:
            entry = find_idempotency_entry(project_dir, canvas_id, normalized_client_save_id)
            if entry is not None:
                stored_request_hash = entry.get("request_hash")
                if (
                    request_hash
                    and isinstance(stored_request_hash, str)
                    and stored_request_hash != request_hash
                ):
                    raise CanvasIdempotencyConflict(
                        client_save_id=normalized_client_save_id,
                    )
                response_cache = entry.get("response_cache")
                return CanvasSaveResult(
                    payload=response_cache if isinstance(response_cache, dict) else {},
                    existing=existing,
                    backup_path=None,
                    idempotent=True,
                    response_cache=response_cache if isinstance(response_cache, dict) else None,
                )
        if skip_if is not None:
            response_cache = skip_if(existing)
            if response_cache is not None:
                return CanvasSaveResult(
                    payload=existing if isinstance(existing, dict) else {},
                    existing=existing,
                    backup_path=None,
                    response_cache=response_cache,
                )
        if enforce_revision:
            _check_revision(existing, base_revision)
        payload = build_payload(existing)
        # Strip reserved (`__`-prefixed) metadata keys before persisting.
        # Clients must not be able to shadow / forge system fields by
        # injecting metadata like ``__save_log`` or ``__system``.
        meta = payload.get("metadata") if isinstance(payload, dict) else None
        if isinstance(meta, dict):
            payload["metadata"] = {
                k: v for k, v in meta.items()
                if not (isinstance(k, str) and k.startswith("__"))
            }
        check_dangerous_empty_overwrite(
            existing=existing,
            payload=payload,
            save_source=save_source,
            allow_empty_overwrite=allow_empty_overwrite,
        )
        size_warning = canvas_payload_size_warning(payload)
        backup_path = backup_canvas_snapshot(path, existing)
        atomic_write_json(path, payload, fence=guard.reassert)
        prune_canvas_history(project_dir, canvas_id)
        response_cache = {
            "saved": True,
            "revision": payload.get("revision"),
            "updated_at": payload.get("updated_at"),
            "client_save_id": normalized_client_save_id or None,
        }
        if size_warning is not None:
            response_cache["warning"] = size_warning
        if normalized_client_save_id:
            append_idempotency_entry(
                project_dir,
                canvas_id,
                client_save_id=normalized_client_save_id,
                revision=(
                    payload.get("revision") if isinstance(payload.get("revision"), int) else None
                ),
                request_hash=request_hash,
                response_cache=response_cache,
            )
        return CanvasSaveResult(
            payload=payload,
            existing=existing,
            backup_path=backup_path,
            response_cache=response_cache,
        )


async def save_canvas_async(*args, **kwargs) -> CanvasSaveResult:
    """在线程中执行同步画布保存，避免阻塞调用方的事件循环。

    `save_canvas` 会等待当前配置的画布写互斥，并执行同步文件 I/O；互斥的等待
    策略及作用范围由注入的 `CanvasWriteMutex` 实现决定。

    参数、返回值和异常均由 `save_canvas` 透传。事件循环上的调用方应 await
    本函数；同步调用方可直接调用 `save_canvas`。
    """

    return await call_blocking(save_canvas, *args, **kwargs)


def restore_canvas_version(
    project_dir: Path,
    canvas_id: str,
    *,
    history_id: str,
    base_revision: int | None,
    build_payload: Callable[[dict | None, dict], dict],
) -> CanvasRestoreResult:
    with get_canvas_write_mutex().write_mutex(project_dir, canvas_id) as guard:
        path = canvas_path(project_dir, canvas_id)
        existing = load_canvas_json(path)
        _check_revision(existing, base_revision)
        history_file = resolve_canvas_history_file(project_dir, canvas_id, history_id)
        history_payload = load_canvas_json(history_file) or {"nodes": [], "edges": []}
        payload = build_payload(existing, history_payload)
        backup_path = backup_canvas_snapshot(path, existing)
        atomic_write_json(path, payload, fence=guard.reassert)
        prune_canvas_history(project_dir, canvas_id)
        return CanvasRestoreResult(
            payload=payload,
            existing=existing,
            history_payload=history_payload,
            backup_path=backup_path,
        )


def soft_delete_canvas(
    project_dir: Path,
    canvas_id: str,
    *,
    deleted_by: str,
) -> CanvasDeleteResult:
    with get_canvas_write_mutex().write_mutex(project_dir, canvas_id, actor=deleted_by) as guard:
        path = canvas_path(project_dir, canvas_id)
        existing = load_canvas_json(path)
        if not path.exists():
            return CanvasDeleteResult(existing=existing, deleted_path=None)
        deleted_dir = canvas_deleted_dir_for_path(path)
        deleted_dir.mkdir(parents=True, exist_ok=True)
        target = deleted_dir / canvas_deleted_filename(existing)
        # 这一次落盘不走 `atomic_write_json`,所以围栏要在这里**显式**再挂一道:
        # `path.replace(target)` 同样是不可逆的一步(§3.3.3)。下面的墓碑跟在它
        # 之后,已经过了不可逆点,再挂围栏只会把「删成了但没写墓碑」变成
        # 「删成了且抛异常」,所以那一处故意不挂。
        guard.reassert()
        path.replace(target)
        tombstone = path.with_name(f"{path.stem}.deleted.json")
        revision = existing.get("revision") if isinstance(existing, dict) else None
        atomic_write_json(
            tombstone,
            {
                "schema_version": "canvas_tombstone.v1",
                "canvas_id": canvas_id,
                "deleted": True,
                "deleted_at": utc_now_iso(),
                "deleted_by": deleted_by,
                "revision": revision if isinstance(revision, int) else None,
                "deleted_snapshot": relative_project_path(project_dir, target),
            },
        )
        # Drop the idempotency cache for this canvas. Once the canvas is
        # tombstoned, any future save that reuses a stale client_save_id from
        # the cached entries would either replay a now-meaningless response or
        # falsely look like a "different payload" idempotency conflict if the
        # canvas is later recreated under the same id.
        idem_path = canvas_idempotency_path(project_dir, canvas_id)
        if idem_path.exists():
            try:
                idem_path.unlink()
            except FileNotFoundError:
                pass
        return CanvasDeleteResult(existing=existing, deleted_path=target)


def prune_orphan_locks(project_dir: Path) -> list[Path]:
    """Remove lock files whose canvas no longer exists.

    A lock is considered orphan when there is no live canvas JSON for its id
    in the canvases directory. Tombstones (``<id>.deleted.json``) do not count
    as a live canvas — they mark a deleted canvas.

    Returns the list of lock paths that were removed.
    """

    from novelvideo.freezone.canvas_lock import canvas_locks_dir as _locks_dir

    locks_dir = _locks_dir(project_dir)
    if not locks_dir.exists():
        return []
    canvas_dir = canvases_dir(project_dir)
    removed: list[Path] = []
    for lock_path in sorted(locks_dir.glob("*.lock")):
        canvas_id = lock_path.stem
        live_canvas = canvas_dir / f"{canvas_id}.json"
        if live_canvas.exists():
            continue
        try:
            lock_path.unlink()
        except FileNotFoundError:
            continue
        removed.append(lock_path)
    return removed
