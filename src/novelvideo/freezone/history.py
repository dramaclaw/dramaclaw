"""Per-node Freezone generation history storage.

The canvas graph is still owned by the frontend.  This module keeps a small
backend-side append-only history keyed by (canvas_id, node_id) so a frontend can
later recover completed/failed generation attempts without bloating canvas JSON.
"""

from __future__ import annotations

import copy
import json
import logging
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from novelvideo.freezone.paths import (
    CANVAS_ID_RE,
    freezone_root,
    resolve_static_url_to_path,
)
# Imported as a module, not by name: the prewarm call below must resolve through
# it at call time. Import-safe without Pillow — the renderer loads PIL lazily.
from novelvideo.utils import thumbnails

logger = logging.getLogger("novelvideo.freezone.history")

_SAFE_ID_RE = re.compile(r"[^a-zA-Z0-9_.-]+")
_DEFAULT_LIMIT = 100

# Cap the prompt stored per history attempt. History is append-only JSONL read
# whole into memory, so an uncapped prompt would bloat disk + the read response
# on heavily-regenerated nodes. The frontend only needs enough to identify the
# version, not the full multi-KB prompt.
MAX_HISTORY_PROMPT_CHARS = 4000


def build_node_history_record(
    *,
    task_type: str,
    job_id: str,
    task_key: str,
    status: str,
    media_type: str,
    result: dict[str, Any] | None = None,
    error: str | None = None,
    prompt: str | None = None,
    extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Build the canonical per-node generation-history record.

    Single owner of the record schema so every producer (image/text/video
    runners, the API-route helper, 3GS) stays consistent — a new field is added
    here once instead of in each call site. ``prompt`` is the text that produced
    this version; it is capped (see ``MAX_HISTORY_PROMPT_CHARS``) and is the
    field the frontend reads to show each version's own prompt.
    """
    record: dict[str, Any] = {
        "id": f"{task_type}:{job_id}",
        "task_type": task_type,
        "task_key": task_key,
        "job_id": job_id,
        "status": status,
        "media_type": media_type,
        **(extra or {}),
        "result": copy.deepcopy(result) if result else None,
        "error": error,
    }
    prompt = str(prompt or "").strip()
    if prompt:
        record["prompt"] = prompt[:MAX_HISTORY_PROMPT_CHARS]
    return record


def _safe_part(value: str) -> str:
    text = _SAFE_ID_RE.sub("_", str(value or "").strip()).strip("._-")
    return text[:128] or "unknown"


def generation_history_dir(project_dir: Path) -> Path:
    return freezone_root(project_dir) / "_generation_history"


def generation_history_path(project_dir: Path, canvas_id: str, node_id: str) -> Path:
    canvas = canvas_id.strip() or "default"
    if not CANVAS_ID_RE.match(canvas):
        raise ValueError(f"invalid canvas_id: {canvas_id!r}")
    node = _safe_part(node_id)
    return generation_history_dir(project_dir) / canvas / f"{node}.jsonl"


def append_generation_history(
    *,
    project_dir: Path,
    canvas_id: str | None,
    node_id: str | None,
    record: dict[str, Any],
) -> dict[str, Any] | None:
    """Append one generation attempt for a canvas node.

    Returns the normalized record, or None when no node_id is supplied.  Missing
    node_id means the caller is an older frontend or a non-node job.
    """

    if not node_id:
        return None
    normalized = {
        "schema_version": 1,
        "canvas_id": canvas_id or "default",
        "node_id": node_id,
        "recorded_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        **record,
    }
    path = generation_history_path(project_dir, normalized["canvas_id"], node_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(normalized, ensure_ascii=False, separators=(",", ":")) + "\n")
    prewarm_record_variants(project_dir, normalized)
    return normalized


# Enough to cover a multi-image result without letting a pathological payload
# turn one append into a scan; the read path covers whatever is skipped.
_PREWARM_MAX_URLS = 8
_PREWARM_MAX_DEPTH = 4


def prewarm_record_variants(project_dir: Path, record: dict[str, Any]) -> int:
    """Queue downscaled variants for whatever images this record points at.

    The history strip renders every record as a thumbnail, so the moment a
    record is written we already know which images the next reader will
    shrink. Doing it here means a freshly generated node has warm variants
    before anyone clicks it; the read path (``st_thumb``) still covers old
    records and anything skipped below.

    Walks the whole ``result`` payload instead of an allowlist of keys so a
    new result field is covered the day it is added — non-images are dropped
    by suffix, and anything resolving outside the project is dropped by
    ``resolve_static_url_to_path``. Best-effort: returns the number of jobs
    queued and never raises into the caller's write path.
    """

    result = record.get("result")
    if not isinstance(result, dict):
        return 0

    seen: set[str] = set()
    queued = 0

    def walk(value: Any, depth: int) -> None:
        nonlocal queued
        if depth > _PREWARM_MAX_DEPTH or len(seen) >= _PREWARM_MAX_URLS:
            return
        if isinstance(value, str):
            url = value.strip()
            # Cheap suffix gate first: a result payload also carries model
            # names, revised prompts and ids, and none of those should reach
            # the path resolver.
            if (
                not url
                or url in seen
                or not thumbnails.is_thumbnailable(Path(urlsplit(url).path))
            ):
                return
            seen.add(url)
            try:
                source = resolve_static_url_to_path(url, project_dir)
            except ValueError:
                return
            queued += thumbnails.prewarm(project_dir, source)
        elif isinstance(value, dict):
            for item in value.values():
                walk(item, depth + 1)
        elif isinstance(value, (list, tuple)):
            for item in value:
                walk(item, depth + 1)

    try:
        walk(result, 0)
    except Exception:
        logger.debug("thumbnail prewarm skipped for %s", record.get("id"), exc_info=True)
    return queued


def _read_history_file(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    records: list[dict[str, Any]] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            records.append(value)
    return records


def read_generation_history(
    *,
    project_dir: Path,
    canvas_id: str,
    node_id: str,
    limit: int = _DEFAULT_LIMIT,
) -> list[dict[str, Any]]:
    records = _read_history_file(generation_history_path(project_dir, canvas_id, node_id))
    if limit <= 0:
        return records
    return records[-limit:]


def read_canvas_generation_history(
    *,
    project_dir: Path,
    canvas_id: str,
    limit: int = _DEFAULT_LIMIT,
) -> list[dict[str, Any]]:
    """Aggregate every node's generation history for a whole canvas.

    Reads all per-node JSONL files under the canvas history dir and merges them,
    newest first. Unlike the per-node read, this is *not* scoped to nodes still
    present on the canvas — a node deleted from the canvas keeps its history file,
    so its past attempts stay recoverable here. Malformed lines/files are skipped.
    """
    canvas = (canvas_id or "").strip() or "default"
    if not CANVAS_ID_RE.match(canvas):
        raise ValueError(f"invalid canvas_id: {canvas_id!r}")
    canvas_dir = generation_history_dir(project_dir) / canvas
    if not canvas_dir.is_dir():
        return []
    records: list[dict[str, Any]] = []
    for path in canvas_dir.glob("*.jsonl"):
        records.extend(_read_history_file(path))
    # Newest first; records without a usable timestamp sort last (empty string).
    records.sort(key=lambda record: str(record.get("recorded_at") or ""), reverse=True)
    if limit <= 0:
        return records
    return records[:limit]
