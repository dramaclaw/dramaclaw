"""File-backed bridge for frontend-executed Freezone canvas commands.

Hermes tools run on the backend, while Freezone canvas commands are applied by
the browser.  This bridge lets the tool call wait for the browser to report
whether the command was applied, cancelled, or failed.
"""

from __future__ import annotations

import hashlib
import json
import os
import tempfile
import time
from pathlib import Path
from typing import Any


def _bridge_dir(bridge_dir: str | Path | None = None) -> Path:
    if bridge_dir:
        return Path(bridge_dir)
    root = os.environ.get("DRAMACLAW_CANVAS_COMMAND_BRIDGE_DIR", "").strip()
    if root:
        return Path(root)
    return Path(tempfile.gettempdir()) / "supertale_canvas_command_bridge"


def _canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str)


def canvas_command_bridge_key(
    *,
    project_id: str | None,
    canvas_id: str | None,
    commands: list[Any],
) -> str:
    payload = {
        "kind": "canvas_command",
        "project_id": project_id or "",
        "canvas_id": canvas_id or "",
        "commands": commands,
        "nonce": time.time_ns(),
    }
    return hashlib.sha256(_canonical_json(payload).encode("utf-8")).hexdigest()[:32]


def canvas_command_idempotency_key(
    *,
    project_id: str | None,
    canvas_id: str | None,
    commands: list[Any],
) -> str:
    """Return a stable key for replaying the same workflow write.

    Ordinary canvas commands keep the nonce-bearing bridge key above so each
    user action remains independent. Workflow submissions pass an explicit
    ``workflowInstanceId`` in every create-node command and use this stable
    variant to make transport retries idempotent.
    """
    payload = {
        "kind": "canvas_command_idempotency",
        "project_id": project_id or "",
        "canvas_id": canvas_id or "",
        "commands": commands,
    }
    return hashlib.sha256(_canonical_json(payload).encode("utf-8")).hexdigest()[:32]


def canvas_context_bridge_key(
    *,
    project_id: str | None,
    canvas_id: str | None,
    requests: list[Any],
) -> str:
    payload = {
        "kind": "canvas_context_request",
        "project_id": project_id or "",
        "canvas_id": canvas_id or "",
        "requests": requests,
        "nonce": time.time_ns(),
    }
    return hashlib.sha256(_canonical_json(payload).encode("utf-8")).hexdigest()[:32]


def skill_studio_bridge_key(
    *,
    project_id: str | None,
    canvas_id: str | None,
    event: dict[str, Any],
) -> str:
    payload = {
        "kind": "skill_studio_event",
        "project_id": project_id or "",
        "canvas_id": canvas_id or "",
        "event": event,
        "nonce": time.time_ns(),
    }
    return hashlib.sha256(_canonical_json(payload).encode("utf-8")).hexdigest()[:32]


def clarification_bridge_key(
    *,
    project_id: str | None,
    canvas_id: str | None,
    event: dict[str, Any],
) -> str:
    payload = {
        "kind": "clarification_event",
        "project_id": project_id or "",
        "canvas_id": canvas_id or "",
        "event": event,
        "nonce": time.time_ns(),
    }
    return hashlib.sha256(_canonical_json(payload).encode("utf-8")).hexdigest()[:32]


def _path(kind: str, key: str, bridge_dir: str | Path | None = None) -> Path:
    safe_key = "".join(ch for ch in key if ch.isalnum() or ch in {"-", "_"})[:128]
    return _bridge_dir(bridge_dir) / f"{safe_key}.{kind}.json"


def _write_json(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + f".{os.getpid()}.tmp")
    tmp.write_text(_canonical_json(data), encoding="utf-8")
    tmp.replace(path)


def _read_json(path: Path) -> dict[str, Any] | None:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None
    except Exception:
        return None
    return data if isinstance(data, dict) else None


def _unlink_if_exists(path: Path) -> None:
    try:
        path.unlink()
    except FileNotFoundError:
        return


def put_pending_canvas_command(
    *,
    key: str,
    project_id: str | None,
    canvas_id: str | None,
    commands: list[Any],
    envelope: dict[str, Any],
    bridge_dir: str | Path | None = None,
) -> None:
    # Defensive cleanup keeps explicitly reused keys from consuming an older result.
    _unlink_if_exists(_path("result", key, bridge_dir))
    _write_json(
        _path("pending", key, bridge_dir),
        {
            "key": key,
            "project_id": project_id,
            "canvas_id": canvas_id,
            "commands": commands,
            "envelope": envelope,
            "created_at": time.time(),
        },
    )


def put_pending_canvas_context(
    *,
    key: str,
    project_id: str | None,
    canvas_id: str | None,
    requests: list[Any],
    envelope: dict[str, Any],
    bridge_dir: str | Path | None = None,
) -> None:
    _unlink_if_exists(_path("result", key, bridge_dir))
    _write_json(
        _path("pending", key, bridge_dir),
        {
            "key": key,
            "project_id": project_id,
            "canvas_id": canvas_id,
            "requests": requests,
            "envelope": envelope,
            "created_at": time.time(),
        },
    )


def put_pending_skill_studio_event(
    *,
    key: str,
    project_id: str | None,
    canvas_id: str | None,
    event: dict[str, Any],
    bridge_dir: str | Path | None = None,
) -> None:
    _unlink_if_exists(_path("result", key, bridge_dir))
    _write_json(
        _path("pending", key, bridge_dir),
        {
            "key": key,
            "kind": "skill_studio_event",
            "project_id": project_id,
            "canvas_id": canvas_id,
            "event": event,
            "created_at": time.time(),
        },
    )


def put_pending_clarification_event(
    *,
    key: str,
    project_id: str | None,
    canvas_id: str | None,
    event: dict[str, Any],
    bridge_dir: str | Path | None = None,
) -> None:
    _unlink_if_exists(_path("result", key, bridge_dir))
    _write_json(
        _path("pending", key, bridge_dir),
        {
            "key": key,
            "kind": "clarification_event",
            "project_id": project_id,
            "canvas_id": canvas_id,
            "event": event,
            "created_at": time.time(),
        },
    )


def resolve_canvas_command(
    key: str,
    result: dict[str, Any],
    *,
    bridge_dir: str | Path | None = None,
) -> dict[str, Any]:
    result_path = _path("result", key, bridge_dir)
    existing = _read_json(result_path)
    if existing is not None:
        # A background workflow reports "accepted" immediately, while the
        # browser continues executing it. A duplicate recovered approval may
        # later expire; that late cancellation must not overwrite the result
        # already consumed by the waiting tool call.
        _unlink_if_exists(_path("pending", key, bridge_dir))
        return existing
    payload = {
        "key": key,
        "resolved_at": time.time(),
        **result,
    }
    _write_json(result_path, payload)
    _unlink_if_exists(_path("pending", key, bridge_dir))
    return payload


def resolve_canvas_context(
    key: str,
    result: dict[str, Any],
    *,
    bridge_dir: str | Path | None = None,
) -> dict[str, Any]:
    return resolve_canvas_command(key, result, bridge_dir=bridge_dir)


def resolve_skill_studio_result(
    key: str,
    result: dict[str, Any],
    *,
    bridge_dir: str | Path | None = None,
) -> dict[str, Any]:
    return resolve_canvas_command(key, result, bridge_dir=bridge_dir)


def resolve_clarification_result(
    key: str,
    result: dict[str, Any],
    *,
    bridge_dir: str | Path | None = None,
) -> dict[str, Any]:
    return resolve_canvas_command(key, result, bridge_dir=bridge_dir)


def wait_canvas_command_result(
    key: str,
    timeout_seconds: float,
    poll_seconds: float = 0.2,
    *,
    bridge_dir: str | Path | None = None,
    timeout_result: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    deadline = time.time() + max(0.0, timeout_seconds)
    while time.time() <= deadline:
        result = _read_json(_path("result", key, bridge_dir))
        if result is not None:
            return result
        time.sleep(max(0.05, poll_seconds))
    if timeout_result is not None:
        return resolve_canvas_command(key, timeout_result, bridge_dir=bridge_dir)
    return None


def wait_canvas_context_result(
    key: str,
    timeout_seconds: float,
    poll_seconds: float = 0.2,
    *,
    bridge_dir: str | Path | None = None,
    timeout_result: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    return wait_canvas_command_result(
        key,
        timeout_seconds=timeout_seconds,
        poll_seconds=poll_seconds,
        bridge_dir=bridge_dir,
        timeout_result=timeout_result,
    )


def wait_skill_studio_result(
    key: str,
    timeout_seconds: float,
    poll_seconds: float = 0.2,
    *,
    bridge_dir: str | Path | None = None,
) -> dict[str, Any] | None:
    return wait_canvas_command_result(
        key,
        timeout_seconds=timeout_seconds,
        poll_seconds=poll_seconds,
        bridge_dir=bridge_dir,
    )


def wait_clarification_result(
    key: str,
    timeout_seconds: float,
    poll_seconds: float = 0.2,
    *,
    bridge_dir: str | Path | None = None,
) -> dict[str, Any] | None:
    return wait_canvas_command_result(
        key,
        timeout_seconds=timeout_seconds,
        poll_seconds=poll_seconds,
        bridge_dir=bridge_dir,
    )
