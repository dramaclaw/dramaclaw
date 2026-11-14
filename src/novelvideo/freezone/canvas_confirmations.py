# SPDX-License-Identifier: Elastic-2.0
# Copyright (c) 2026 ClaymoreLab
"""Store canvas command confirmation policy, targets, and durable decisions."""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager, contextmanager
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile
from typing import AsyncIterator, Iterator, Literal
from uuid import uuid4

import portalocker

CONFIRMATION_TTL_SECONDS = 30 * 60
CONFIRMATIONS_DIRNAME = "mcp_canvas_approvals"
SPLIT_LOCK_WAIT_SECONDS = 30.0
SPLIT_LOCK_HOLD_SECONDS = 90.0
SPLIT_REUSE_SECONDS = 24 * 3600

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


def _batch_nodes(commands: list[dict]) -> dict[str, dict]:
    nodes = {}
    for command in commands:
        client_id = command.get("client_id")
        if not isinstance(client_id, str):
            continue
        kind = command.get("type")
        if kind in {"create_node", "add_next_node"}:
            nodes[client_id] = {
                "type": command.get("node_type") or "", "data": command.get("data") or {},
            }
        elif kind == "html_artifact" and command.get("action") == "prepare":
            nodes[client_id] = {
                "type": "htmlArtifactNode", "data": command.get("workflow_data") or {},
            }
    return nodes


def node_title(data: dict) -> str:
    return next((
        value.strip() for key in ("label", "displayName", "title", "name")
        if isinstance(value := data.get(key), str) and value.strip()
    ), "")


def confirmation_targets(canvas: dict, commands: list[dict]) -> list[dict]:
    nodes = {node["id"]: node for node in canvas.get("nodes", [])}
    batch_nodes = _batch_nodes(commands)
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
            node = nodes.get(node_id, batch_nodes.get(node_id))
            if node is None:
                missing.add(node_id)
                continue
            if (node_id, action) in seen:
                continue
            seen.add((node_id, action))
            targets.append({
                "node_id": node_id, "title": node_title(node.get("data", {})),
                "node_type": node.get("type") or "", "action": action,
            })
    if missing:
        raise CanvasConfirmationError(
            "targets_missing", "Canvas nodes missing: " + ", ".join(sorted(missing))
        )
    return targets


def generation_settings(canvas: dict, commands: list[dict], targets: list[dict]) -> list[dict]:
    nodes = {**_batch_nodes(commands), **{node["id"]: node for node in canvas.get("nodes", [])}}
    settings = []
    for target in targets:
        if target["action"] in {"delete_nodes", "clear_canvas"}:
            continue
        entry = {key: target[key] for key in ("node_id", "title", "node_type", "action")}
        data = nodes.get(target["node_id"], {}).get("data", {})
        for source, destination in (
            ("model", "model"), ("aspectRatio", "aspect_ratio"), ("size", "resolution"),
            ("quality", "quality"), ("durationSec", "duration_seconds"),
            ("generateAudio", "generate_audio"), ("count", "count"),
        ):
            if source in data:
                entry[destination] = data[source]
        settings.append(entry)
    return settings


def changed_targets(canvas: dict, record: dict) -> list[str]:
    current = {node["id"] for node in canvas.get("nodes", [])}
    shown = {target["node_id"] for target in record["targets"]}
    changed = shown - current - _batch_nodes(record["commands"]).keys()
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


@asynccontextmanager
async def split_lock(directory: str | Path, source_command_hash: str) -> AsyncIterator[None]:
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    deadline = asyncio.get_running_loop().time() + SPLIT_LOCK_WAIT_SECONDS
    with (directory / f".split-{source_command_hash[:2]}.lock").open("a+") as lock_file:
        while True:
            try:
                portalocker.lock(lock_file, portalocker.LOCK_EX | portalocker.LOCK_NB)
                break
            except portalocker.exceptions.AlreadyLocked as exc:
                if asyncio.get_running_loop().time() >= deadline:
                    raise CanvasConfirmationError(
                        "busy", "Canvas confirmation is busy; retry the request"
                    ) from exc
                await asyncio.sleep(0.02)
        try:
            async with asyncio.timeout(SPLIT_LOCK_HOLD_SECONDS):
                yield
        finally:
            portalocker.unlock(lock_file)


def _save_json(path: Path, record: dict) -> None:
    with tempfile.NamedTemporaryFile(
        mode="w", encoding="utf-8", dir=path.parent, delete=False,
    ) as tmp:
        temporary_path = Path(tmp.name)
        try:
            json.dump(record, tmp, ensure_ascii=False)
            tmp.close()
            os.replace(temporary_path, path)
        finally:
            temporary_path.unlink(missing_ok=True)


def _save(directory: Path, record: dict) -> None:
    _save_json(directory / f"{record['id']}.json", record)


def save_split(
    directory: str | Path, *, project_id: str, canvas_id: str, source_command_hash: str,
    written: dict, commands: list[dict], canvas: dict, now: float,
) -> None:
    nodes = {node["id"]: node for node in canvas.get("nodes", [])}
    edges = {edge["id"]: edge for edge in canvas.get("edges", [])}
    marker = {
        "source_command_hash": source_command_hash, "project_id": project_id,
        "canvas_id": canvas_id, "created_at": now, "written": written, "commands": commands,
        "nodes": [
            {"id": node_id, "type": nodes[node_id]["type"], "data": nodes[node_id].get("data", {})}
            for node_id in written["created_node_ids"]
        ],
        "edges": [
            {key: edges[edge_id][key] for key in ("id", "source", "target")}
            for edge_id in written["created_edge_ids"]
        ],
    }
    _save_json(Path(directory) / f"split_{source_command_hash}.json", marker)


def find_reusable_split(
    directory: str | Path, *, project_id: str, canvas_id: str, source_command_hash: str,
    canvas: dict, now: float,
) -> dict | None:
    try:
        marker = json.loads(
            (Path(directory) / f"split_{source_command_hash}.json").read_text(encoding="utf-8")
        )
        if (
            marker["project_id"] != project_id or marker["canvas_id"] != canvas_id
            or marker["source_command_hash"] != source_command_hash
            or not now < marker["created_at"] + SPLIT_REUSE_SECONDS
            or not isinstance(marker["written"], dict)
            or not isinstance(marker["commands"], list)
        ):
            return None
        nodes = {node["id"]: node for node in canvas.get("nodes", [])}
        edges = {edge["id"]: edge for edge in canvas.get("edges", [])}
        for snapshot in marker["nodes"]:
            node = nodes.get(snapshot["id"])
            if node is None or node["type"] != snapshot["type"]:
                return None
            if not isinstance(snapshot["data"], dict):
                return None
            data = node.get("data", {})
            if any(
                key not in data or data[key] != value for key, value in snapshot["data"].items()
            ):
                return None
        for snapshot in marker["edges"]:
            edge = edges.get(snapshot["id"])
            if edge is None or any(edge[key] != snapshot[key] for key in ("source", "target")):
                return None
        return marker
    except (OSError, ValueError, KeyError, TypeError):
        return None


def create_confirmation(
    directory: str | Path, *, project_id: str, canvas_id: str, agent_id: str,
    username: str, turn_id: str | None, commands: list[dict], targets: list[dict], now: float,
    pre_applied: dict | None = None,
) -> dict:
    record = {
        "id": "cc_" + uuid4().hex, "project_id": project_id, "canvas_id": canvas_id,
        "agent_id": agent_id, "username": username, "turn_id": turn_id,
        "commands": commands, "command_hash": command_hash(project_id, canvas_id, commands),
        "kinds": confirmation_kinds(commands), "targets": targets,
        "created_at": now, "expires_at": now + CONFIRMATION_TTL_SECONDS,
        "updated_at": now, "status": "pending", "decided_via": None, "outcome": None,
    }
    if pre_applied is not None:
        record["pre_applied"] = pre_applied
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


def find_pre_applied(
    directory: str | Path, *, project_id: str, canvas_id: str,
    source_command_hash: str, now: float,
) -> dict | None:
    directory = Path(directory)
    if not directory.is_dir():
        return None
    with _directory_lock(directory):
        records = []
        for path in directory.glob("cc_*.json"):
            record = read_confirmation(directory, path.stem)
            if (
                record is not None and record["status"] == "pending"
                and now < record["expires_at"] and record["project_id"] == project_id
                and record["canvas_id"] == canvas_id
                and record.get("pre_applied", {}).get("source_command_hash") == source_command_hash
            ):
                records.append(record)
        return max(records, key=lambda record: record["created_at"], default=None)


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
        for path in directory.glob("split_*.json"):
            try:
                marker = json.loads(path.read_text(encoding="utf-8"))
                if now < marker["created_at"] + SPLIT_REUSE_SECONDS:
                    continue
            except (OSError, ValueError, KeyError, TypeError):
                pass
            path.unlink(missing_ok=True)
    return expired


def confirmations_dir(username: str, agent_id: str, project_state_dir: str | Path) -> Path:
    from novelvideo.chat.hermes_workspace import ensure_user_hermes_workspace
    from novelvideo.chat.hermes_pool import canvas_bridge_dir_for_profile

    home = ensure_user_hermes_workspace(
        username, profile="freezone", project_state_dir=project_state_dir,
    )
    return canvas_bridge_dir_for_profile(home, f"freezone:{agent_id}") / CONFIRMATIONS_DIRNAME


def request_confirmation(
    *, username: str, agent_id: str, project_id: str, canvas_id: str,
    project_state_dir: str | Path, turn_id: str | None, commands: list[dict], now: float,
    pre_applied: dict | None = None,
) -> dict:
    from novelvideo.freezone import canvas_store

    canvas = canvas_store.read_canvas(Path(project_state_dir), canvas_id) or {
        "nodes": [], "edges": []
    }
    if not confirmation_kinds(commands):
        raise CanvasConfirmationError("not_needed", "Canvas confirmation not needed")
    targets = confirmation_targets(canvas, commands)
    return create_confirmation(
        confirmations_dir(username, agent_id, project_state_dir),
        project_id=project_id, canvas_id=canvas_id, agent_id=agent_id,
        username=username, turn_id=turn_id, commands=commands, targets=targets, now=now,
        pre_applied=pre_applied,
    )
