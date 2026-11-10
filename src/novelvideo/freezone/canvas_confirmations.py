# SPDX-License-Identifier: Elastic-2.0
# Copyright (c) 2026 ClaymoreLab
"""Store canvas command confirmation policy, targets, and durable decisions."""

from __future__ import annotations

from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile
from typing import Iterator, Literal
from uuid import uuid4

import portalocker

CONFIRMATION_TTL_SECONDS = 30 * 60
CONFIRMATIONS_DIRNAME = "mcp_canvas_approvals"

_ID_PATTERN = re.compile(r"cc_[0-9a-f]{32}")
_KIND_ORDER = ("delete_nodes", "clear_canvas", "paid_generation")
_FREE_COMMAND_TYPES = {
    "create_node", "add_next_node", "create_edge", "delete_edges", "update_node_data",
    "move_nodes", "layout_nodes", "group_nodes", "select_nodes", "html_artifact",
    "open_mainline_projection",
}
_FREE_NODE_ACTIONS = {
    "update_source", "select_version", "restore", "open", "export", "upload",
    "download_image", "download_video", "download_audio", "run_matting_tool",
    "run_audio_separate", "run_video_depth_capture", "capture_video_first_frame",
    "capture_video_last_frame", "capture_pano_current_view", "capture_pano_2x2_views",
    "capture_pano_4x3_views", "set_pano_current_view_as_background", "reset_pano_view",
}


class CanvasConfirmationError(Exception):
    code: str
    record: dict | None

    def __init__(self, code: str, message: str, record: dict | None = None):
        super().__init__(message)
        self.code = code
        self.record = record


def _command_kind(command: dict) -> str | None:
    kind = command["type"]
    if kind in _FREE_COMMAND_TYPES:
        return None
    if kind in {"delete_nodes", "clear_canvas"}:
        return kind
    if kind == "run_workflow":
        return "paid_generation"
    if kind != "run_node_action":
        raise ValueError(f"Unknown canvas command type: {kind}")
    action = command["action"]
    if action in _FREE_NODE_ACTIONS:
        return None
    if action.startswith("open_") and action != "open_video_compose_modal":
        return None
    if (
        action == "run_video_breakdown"
        and command.get("parameters", {}).get("auto_start") is not True
    ):
        return None
    return "paid_generation"


def confirmation_kinds(commands: list[dict]) -> list[str]:
    kinds = {_command_kind(command) for command in commands}
    return [kind for kind in _KIND_ORDER if kind in kinds]


def command_hash(project_id: str, canvas_id: str, commands: list[dict]) -> str:
    payload = json.dumps(
        {"project_id": project_id, "canvas_id": canvas_id, "commands": commands},
        sort_keys=True, separators=(",", ":"), ensure_ascii=False,
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _whole_canvas(command: dict) -> bool:
    return command["type"] == "clear_canvas" or (
        command["type"] == "run_workflow"
        and command.get("scope") == "canvas"
        and not command.get("node_ids")
    )


def confirmation_targets(canvas: dict, commands: list[dict]) -> list[dict]:
    nodes = {node["id"]: node for node in canvas.get("nodes", [])}
    targets = []
    seen = set()
    missing = set()
    for command in commands:
        if _command_kind(command) is None:
            continue
        kind = command["type"]
        action = command["action"] if kind == "run_node_action" else kind
        if _whole_canvas(command):
            node_ids = list(nodes)
        elif kind == "run_node_action":
            node_ids = [command["node_id"]]
        else:
            node_ids = command.get("node_ids", [])
        for node_id in node_ids:
            if node_id not in nodes:
                missing.add(node_id)
                continue
            if (node_id, action) in seen:
                continue
            seen.add((node_id, action))
            node = nodes[node_id]
            data = node.get("data", {})
            title = next((
                value.strip() for key in ("label", "displayName", "title", "name")
                if isinstance(value := data.get(key), str) and value.strip()
            ), "")
            targets.append({
                "node_id": node_id, "title": title,
                "node_type": node.get("type") or "", "action": action,
            })
    if missing:
        raise CanvasConfirmationError(
            "targets_missing", "Canvas nodes missing: " + ", ".join(sorted(missing))
        )
    return targets


def changed_targets(canvas: dict, record: dict) -> list[str]:
    current = {node["id"] for node in canvas.get("nodes", [])}
    shown = {target["node_id"] for target in record["targets"]}
    changed = shown - current
    if any(_whole_canvas(command) for command in record["commands"]):
        changed |= current - shown
    return sorted(changed)


@contextmanager
def _directory_lock(directory: Path) -> Iterator[None]:
    with (directory / ".lock").open("a+") as lock_file:
        portalocker.lock(lock_file, portalocker.LOCK_EX)
        try:
            yield
        finally:
            portalocker.unlock(lock_file)


def _save(directory: Path, record: dict) -> None:
    with tempfile.NamedTemporaryFile(
        mode="w", encoding="utf-8", dir=directory, delete=False,
    ) as tmp:
        temporary_path = Path(tmp.name)
        try:
            json.dump(record, tmp, ensure_ascii=False)
            tmp.close()
            os.replace(temporary_path, directory / f"{record['id']}.json")
        finally:
            temporary_path.unlink(missing_ok=True)


def create_confirmation(
    directory: str | Path, *, project_id: str, canvas_id: str, agent_id: str,
    username: str, turn_id: str | None, commands: list[dict], targets: list[dict], now: float,
) -> dict:
    record = {
        "id": "cc_" + uuid4().hex, "project_id": project_id, "canvas_id": canvas_id,
        "agent_id": agent_id, "username": username, "turn_id": turn_id,
        "commands": commands, "command_hash": command_hash(project_id, canvas_id, commands),
        "kinds": confirmation_kinds(commands), "targets": targets,
        "created_at": now, "expires_at": now + CONFIRMATION_TTL_SECONDS,
        "updated_at": now, "status": "pending", "decided_via": None, "outcome": None,
    }
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    with _directory_lock(directory):
        _save(directory, record)
    return record


def read_confirmation(directory: str | Path, confirmation_id: str) -> dict | None:
    if not _ID_PATTERN.fullmatch(confirmation_id):
        return None
    try:
        with (Path(directory) / f"{confirmation_id}.json").open(encoding="utf-8") as source:
            return json.load(source)
    except FileNotFoundError:
        return None


def list_pending(
    directory: str | Path, *, project_id: str, canvas_id: str, now: float,
) -> list[dict]:
    records = []
    for path in Path(directory).glob("cc_*.json"):
        record = read_confirmation(directory, path.stem)
        if (
            record is not None and record["project_id"] == project_id
            and record["canvas_id"] == canvas_id and record["status"] == "pending"
            and record["turn_id"] is not None and now < record["expires_at"]
        ):
            records.append(record)
    return sorted(records, key=lambda record: record["created_at"])


@contextmanager
def _locked_record(directory: Path, confirmation_id: str) -> Iterator[dict]:
    if not _ID_PATTERN.fullmatch(confirmation_id) or not directory.is_dir():
        raise CanvasConfirmationError("not_found", "Canvas confirmation not found")
    with _directory_lock(directory):
        record = read_confirmation(directory, confirmation_id)
        if record is None:
            raise CanvasConfirmationError("not_found", "Canvas confirmation not found")
        yield record


def claim(
    directory: str | Path, confirmation_id: str, *, decision: Literal["confirmed", "refused"],
    via: Literal["card", "conversation"], username: str, agent_id: str, turn_id: str | None,
    command_hash: str | None = None, now: float,
) -> dict:
    directory = Path(directory)
    with _locked_record(directory, confirmation_id) as record:
        if username != record["username"] or agent_id != record["agent_id"]:
            raise CanvasConfirmationError("agent_mismatch", "Confirmation belongs to another agent")
        if record["status"] == "expired":
            raise CanvasConfirmationError("expired", "Confirmation expired", record)
        if record["status"] != "pending":
            raise CanvasConfirmationError("already_handled", "Confirmation already handled", record)
        if now >= record["expires_at"]:
            record.update(status="expired", updated_at=now)
            _save(directory, record)
            raise CanvasConfirmationError("expired", "Confirmation expired", record)
        if via == "card":
            if record["turn_id"] is None:
                raise CanvasConfirmationError("turn_required", "Card confirmation requires a turn")
            if turn_id != record["turn_id"]:
                raise CanvasConfirmationError("turn_mismatch", "Confirmation turn differs")
            if command_hash != record["command_hash"]:
                raise CanvasConfirmationError("command_mismatch", "Confirmation commands differ")
        elif record["turn_id"] is not None:
            if turn_id is None or turn_id == record["turn_id"]:
                raise CanvasConfirmationError(
                    "user_reply_required", "A later user reply is required"
                )
        elif turn_id is not None:
            raise CanvasConfirmationError("turn_mismatch", "Confirmation has no turn")
        record.update(status=decision, decided_via=via, updated_at=now)
        _save(directory, record)
        return record


def verify_confirmed(
    directory: str | Path, confirmation_id: str, *, command_hash: str, turn_id: str | None,
) -> dict:
    record = read_confirmation(directory, confirmation_id)
    if record is None:
        raise CanvasConfirmationError("not_found", "Canvas confirmation not found")
    if record["status"] != "confirmed":
        raise CanvasConfirmationError("not_confirmed", "Canvas command is not confirmed")
    if command_hash != record["command_hash"]:
        raise CanvasConfirmationError("command_mismatch", "Confirmation commands differ")
    if turn_id != record["turn_id"]:
        raise CanvasConfirmationError("turn_mismatch", "Confirmation turn differs")
    return record


def void_confirmation(
    directory: str | Path, confirmation_id: str, *, reason: str, now: float,
) -> dict:
    directory = Path(directory)
    with _locked_record(directory, confirmation_id) as record:
        record.update(status="voided", outcome={"reason": reason}, updated_at=now)
        _save(directory, record)
        return record


def finish_confirmation(
    directory: str | Path, confirmation_id: str, *, outcome: dict, now: float,
) -> dict:
    directory = Path(directory)
    with _locked_record(directory, confirmation_id) as record:
        if record["status"] != "confirmed":
            raise CanvasConfirmationError("not_confirmed", "Canvas command is not confirmed")
        record.update(status="executed", outcome=outcome, updated_at=now)
        _save(directory, record)
        return record


def expire_due(directory: str | Path, *, now: float) -> list[dict]:
    directory = Path(directory)
    if not directory.is_dir():
        return []
    expired = []
    with _directory_lock(directory):
        for path in directory.glob("cc_*.json"):
            record = read_confirmation(directory, path.stem)
            if record is None:
                continue
            if record["status"] == "pending":
                if now >= record["expires_at"]:
                    record.update(status="expired", updated_at=now)
                    _save(directory, record)
                    expired.append(record)
            elif record["updated_at"] < now - 24 * 3600:
                path.unlink()
    return expired
