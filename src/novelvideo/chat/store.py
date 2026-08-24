"""Scoped chat persistence shared by NiceGUI and the React WebSocket API.

Lovart-style split:
    * home scope: user-level conversation before a project exists.
    * project scope: project/canvas conversation and iteration history.

The project chat DB path intentionally matches ``chat_service.py`` so existing
NiceGUI history remains readable by the future React UI.
"""

from __future__ import annotations

import json
import os
import re
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

from novelvideo.sqlite_pragmas import configure_sqlite_connection


def _assistant_prefix_candidates(previous_assistant: object) -> list[str]:
    if isinstance(previous_assistant, (list, tuple)):
        items = [str(item or "").strip() for item in previous_assistant if str(item or "").strip()]
        candidates = ["".join(items[index:]) for index in range(len(items))]
        candidates.extend(items)
        return sorted(set(candidates), key=len, reverse=True)
    prefix = str(previous_assistant or "").strip()
    return [prefix] if prefix else []


def _strip_replayed_assistant_prefix(content: str, previous_assistant: object) -> str:
    text = str(content or "")
    for prefix in _assistant_prefix_candidates(previous_assistant):
        if text.startswith(prefix):
            return text[len(prefix):].lstrip()
        compact_prefix = "".join(prefix.split())
        if not compact_prefix:
            continue
        matched = 0
        end_index = 0
        for index, char in enumerate(text):
            if char.isspace():
                continue
            if matched >= len(compact_prefix) or char != compact_prefix[matched]:
                break
            matched += 1
            end_index = index + 1
            if matched == len(compact_prefix):
                return text[end_index:].lstrip()
    return text


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[3]


def _state_root() -> Path:
    configured = os.environ.get("NOVELVIDEO_STATE_DIR", "").strip()
    if configured:
        return Path(configured).expanduser()
    return _repo_root() / "state"


@dataclass(frozen=True)
class ChatScope:
    kind: Literal["home", "project", "freezone", "asset", "task"]
    id: str | None = None
    surface: str | None = None
    canvas_id: str | None = None
    agent_id: str | None = None
    # Server-resolved project state root. This is deliberately omitted from
    # ``to_dict`` so filesystem topology never becomes a browser contract.
    state_dir: str | None = None

    @classmethod
    def from_payload(cls, payload: dict[str, Any] | None) -> "ChatScope":
        payload = payload or {"kind": "home"}
        kind = str(payload.get("kind") or "home")
        if kind not in {"home", "project", "freezone", "asset", "task"}:
            raise ValueError(f"unsupported chat scope: {kind}")
        raw_id = payload.get("id")
        scope_id = str(raw_id).strip() if raw_id is not None else None
        raw_surface = payload.get("surface")
        surface = str(raw_surface).strip() if raw_surface is not None else None
        raw_canvas_id = payload.get("canvasId", payload.get("canvas_id"))
        canvas_id = str(raw_canvas_id).strip() if raw_canvas_id is not None else None
        raw_agent_id = payload.get("agentId", payload.get("agent_id"))
        agent_id = str(raw_agent_id).strip() if raw_agent_id is not None else None
        if kind == "home":
            scope_id = None
            surface = None
            canvas_id = None
            agent_id = None
        if kind != "home" and not scope_id:
            raise ValueError(f"scope id is required for {kind}")
        if kind == "project":
            surface = surface or "director"
            if surface not in {"director", "freezone"}:
                raise ValueError(f"unsupported project chat surface: {surface}")
            if surface != "freezone":
                canvas_id = None
                agent_id = None
            else:
                agent_id = agent_id or "main"
                if not re.fullmatch(r"[A-Za-z0-9_-]+", agent_id):
                    raise ValueError("unsupported freezone agent id")
        else:
            surface = None
            canvas_id = None
            agent_id = None
        return cls(kind=kind, id=scope_id, surface=surface, canvas_id=canvas_id, agent_id=agent_id)

    def to_dict(self) -> dict[str, str | None]:
        data: dict[str, str | None] = {"kind": self.kind, "id": self.id}
        if self.surface:
            data["surface"] = self.surface
        if self.canvas_id:
            data["canvasId"] = self.canvas_id
        if self.agent_id:
            data["agentId"] = self.agent_id
        return data


class ChatStore:
    @staticmethod
    def _project_root(username: str, scope: ChatScope) -> Path:
        if scope.state_dir:
            return Path(scope.state_dir)
        return _state_root() / username / str(scope.id)

    def db_for(self, username: str, scope: ChatScope) -> Path:
        if scope.kind == "home":
            return _state_root() / username / "_home" / "chat.db"
        if scope.kind == "project":
            if (scope.surface or "director") == "director" and not scope.canvas_id:
                return self._project_root(username, scope) / "chat.db"
            surface = scope.surface or "director"
            if surface == "freezone" and scope.canvas_id:
                agent_id = scope.agent_id or "main"
                return (
                    self._project_root(username, scope)
                    / "_chat"
                    / surface
                    / str(scope.canvas_id)
                    / "agents"
                    / agent_id
                    / "chat.db"
                )
            return self._project_root(username, scope) / "_chat" / surface / "chat.db"
        if scope.kind == "freezone":
            return _state_root() / username / "_freezone" / str(scope.id) / "chat.db"
        return _state_root() / username / f"_{scope.kind}" / str(scope.id) / "chat.db"

    def _legacy_freezone_canvas_db_for(self, username: str, scope: ChatScope) -> Path | None:
        if scope.kind != "project" or scope.surface != "freezone" or not scope.canvas_id:
            return None
        if scope.agent_id not in {None, "", "main"}:
            return None
        return (
            _state_root()
            / username
            / str(scope.id)
            / "_chat"
            / "freezone"
            / str(scope.canvas_id)
            / "chat.db"
        )

    def _pre_authoritative_freezone_db_for(
        self, username: str, scope: ChatScope
    ) -> Path | None:
        if (
            not scope.state_dir
            or scope.kind != "project"
            or scope.surface != "freezone"
            or not scope.canvas_id
        ):
            return None
        return (
            _state_root()
            / username
            / str(scope.id)
            / "_chat"
            / "freezone"
            / str(scope.canvas_id)
            / "agents"
            / (scope.agent_id or "main")
            / "chat.db"
        )

    def read_db_for(self, username: str, scope: ChatScope) -> Path:
        db_path = self.db_for(username, scope)
        pre_authoritative = self._pre_authoritative_freezone_db_for(username, scope)
        if (
            pre_authoritative is not None
            and not db_path.exists()
            and pre_authoritative.exists()
        ):
            return pre_authoritative
        legacy_db_path = self._legacy_freezone_canvas_db_for(username, scope)
        if legacy_db_path is not None and not db_path.exists() and legacy_db_path.exists():
            return legacy_db_path
        return db_path

    def _freezone_canvas_agents_dir(
        self,
        username: str,
        *,
        project_id: str,
        canvas_id: str,
        project_state_dir: str | Path | None = None,
    ) -> Path:
        project_root = (
            Path(project_state_dir)
            if project_state_dir is not None
            else _state_root() / username / str(project_id)
        )
        return (
            project_root
            / "_chat"
            / "freezone"
            / str(canvas_id)
            / "agents"
        )

    def _freezone_canvas_legacy_db(
        self,
        username: str,
        *,
        project_id: str,
        canvas_id: str,
    ) -> Path:
        return (
            _state_root()
            / username
            / str(project_id)
            / "_chat"
            / "freezone"
            / str(canvas_id)
            / "chat.db"
        )

    @staticmethod
    def _timestamp_ms(value: str) -> int:
        try:
            normalized = value.replace("Z", "+00:00")
            return int(datetime.fromisoformat(normalized).timestamp() * 1000)
        except Exception:
            return 0

    def _freezone_agent_summary_from_db(self, agent_id: str, db_path: Path) -> dict[str, Any] | None:
        if not db_path.exists():
            return None
        conn = sqlite3.connect(db_path)
        conn.row_factory = sqlite3.Row
        try:
            tables = {
                str(row["name"])
                for row in conn.execute(
                    "SELECT name FROM sqlite_master WHERE type='table'"
                ).fetchall()
            }
            if "chat_messages" not in tables:
                return None
            latest = conn.execute(
                """
                SELECT content, created_at
                  FROM chat_messages
                 WHERE role <> 'trace'
                 ORDER BY id DESC
                 LIMIT 1
                """
            ).fetchone()
            if latest is None:
                return None
            first_user = conn.execute(
                """
                SELECT content
                  FROM chat_messages
                 WHERE role = 'user'
                 ORDER BY id ASC
                 LIMIT 1
                """
            ).fetchone()
        finally:
            conn.close()
        title = str(first_user["content"] if first_user is not None else latest["content"] or "").strip()
        title = re.sub(r"\s+", " ", title) or agent_id
        if len(title) > 32:
            title = f"{title[:31]}…"
        timestamp = self._timestamp_ms(str(latest["created_at"] or ""))
        return {
            "id": agent_id,
            "name": title,
            "createdAt": timestamp,
            "lastActiveAt": timestamp,
        }

    def list_freezone_canvas_agent_summaries(
        self,
        username: str,
        *,
        project_id: str,
        canvas_id: str,
        limit: int = 20,
        project_state_dir: str | Path | None = None,
    ) -> list[dict[str, Any]]:
        agents_dir = self._freezone_canvas_agents_dir(
            username,
            project_id=project_id,
            canvas_id=canvas_id,
            project_state_dir=project_state_dir,
        )
        candidates: list[tuple[str, Path]] = []
        if agents_dir.exists():
            candidates.extend(
                (path.parent.name, path)
                for path in agents_dir.glob("*/chat.db")
                if path.parent.name
            )
        if project_state_dir is not None:
            previous_agents_dir = self._freezone_canvas_agents_dir(
                username,
                project_id=project_id,
                canvas_id=canvas_id,
            )
            if previous_agents_dir != agents_dir and previous_agents_dir.exists():
                candidates.extend(
                    (path.parent.name, path)
                    for path in previous_agents_dir.glob("*/chat.db")
                    if path.parent.name
                )
        legacy_db = self._freezone_canvas_legacy_db(
            username,
            project_id=project_id,
            canvas_id=canvas_id,
        )
        main_db = agents_dir / "main" / "chat.db"
        if legacy_db.exists() and not main_db.exists():
            candidates.append(("main", legacy_db))

        summaries: list[dict[str, Any]] = []
        seen: set[str] = set()
        for agent_id, db_path in candidates:
            if agent_id in seen:
                continue
            seen.add(agent_id)
            summary = self._freezone_agent_summary_from_db(agent_id, db_path)
            if summary is not None:
                summaries.append(summary)
        bounded_limit = max(1, min(int(limit), 100))
        return sorted(
            summaries,
            key=self._freezone_agent_summary_sort_key,
            reverse=True,
        )[:bounded_limit]

    @staticmethod
    def _freezone_agent_summary_sort_key(summary: dict[str, Any]) -> tuple[int, int, str]:
        agent_id = str(summary.get("id") or "")
        match = re.fullmatch(r"agent-(\d+)", agent_id)
        agent_rank = int(match.group(1)) if match else -1
        return (int(summary.get("lastActiveAt") or 0), agent_rank, agent_id)

    def connect(self, username: str, scope: ChatScope, *, db_path: Path | None = None) -> sqlite3.Connection:
        if db_path is None:
            db_path = self.db_for(username, scope)
            legacy_db = self._pre_authoritative_freezone_db_for(username, scope)
            if legacy_db is None or not legacy_db.exists():
                legacy_db = self._legacy_freezone_canvas_db_for(username, scope)
            if (
                scope.state_dir
                and legacy_db is not None
                and legacy_db != db_path
                and legacy_db.exists()
                and not db_path.exists()
            ):
                from novelvideo.utils.state_index_files import index_file_lock

                with index_file_lock(db_path):
                    if not db_path.exists():
                        db_path.parent.mkdir(parents=True, exist_ok=True)
                        source = sqlite3.connect(legacy_db)
                        destination = sqlite3.connect(db_path)
                        try:
                            source.backup(destination)
                        finally:
                            destination.close()
                            source.close()
        db_path.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(db_path)
        conn.row_factory = sqlite3.Row
        configure_sqlite_connection(conn)
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS chat_messages (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              role TEXT NOT NULL,
              content TEXT NOT NULL,
              media_json TEXT NOT NULL DEFAULT '[]',
              turn_id TEXT,
              metadata_json TEXT NOT NULL DEFAULT '{}',
              created_at TEXT NOT NULL
            )
            """
        )
        columns = {
            str(row["name"])
            for row in conn.execute("PRAGMA table_info(chat_messages)").fetchall()
        }
        if "turn_id" not in columns:
            conn.execute("ALTER TABLE chat_messages ADD COLUMN turn_id TEXT")
        if "metadata_json" not in columns:
            conn.execute("ALTER TABLE chat_messages ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}'")
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS chat_ui_events (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              turn_id TEXT NOT NULL,
              event_type TEXT NOT NULL,
              payload_json TEXT NOT NULL,
              created_at TEXT NOT NULL
            )
            """
        )
        conn.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_chat_ui_events_turn_id
              ON chat_ui_events(turn_id, id)
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS chat_settings (
              key TEXT PRIMARY KEY,
              value TEXT NOT NULL,
              updated_at TEXT NOT NULL
            )
            """
        )
        conn.commit()
        return conn

    def append_message(
        self,
        username: str,
        scope: ChatScope,
        role: str,
        content: str,
        media: list[dict[str, Any]] | None = None,
        *,
        turn_id: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        media = media or []
        metadata = metadata or {}
        created_at = datetime.now(timezone.utc).isoformat()
        conn = self.connect(username, scope)
        try:
            cursor = conn.execute(
                """
                INSERT INTO chat_messages(role, content, media_json, turn_id, metadata_json, created_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    role,
                    content,
                    json.dumps(media, ensure_ascii=False),
                    turn_id,
                    json.dumps(metadata, ensure_ascii=False),
                    created_at,
                ),
            )
            conn.commit()
            return {
                "id": int(cursor.lastrowid),
                "role": role,
                "content": content,
                "media": media,
                "attachments": media,
                **({"turn_id": turn_id} if turn_id else {}),
                **({"metadata": metadata} if metadata else {}),
                "created_at": created_at,
            }
        finally:
            conn.close()

    def append_ui_event(
        self,
        username: str,
        scope: ChatScope,
        turn_id: str,
        event: dict[str, Any],
    ) -> dict[str, Any]:
        turn_id = str(turn_id or "").strip()
        if not turn_id:
            raise ValueError("turn_id is required")
        event_type = str(event.get("type") or event.get("event_type") or "ui_event").strip()
        created_at = datetime.now(timezone.utc).isoformat()
        conn = self.connect(username, scope)
        try:
            cursor = conn.execute(
                """
                INSERT INTO chat_ui_events(turn_id, event_type, payload_json, created_at)
                VALUES (?, ?, ?, ?)
                """,
                (turn_id, event_type, json.dumps(event, ensure_ascii=False), created_at),
            )
            conn.commit()
            return {
                "id": int(cursor.lastrowid),
                "turn_id": turn_id,
                "type": event_type,
                "payload": event,
                "created_at": created_at,
            }
        finally:
            conn.close()

    def _load_ui_events(self, conn: sqlite3.Connection) -> dict[str, list[dict[str, Any]]]:
        rows = conn.execute(
            """
            SELECT id, turn_id, event_type, payload_json, created_at
              FROM chat_ui_events
             ORDER BY id ASC
            """
        ).fetchall()
        events_by_turn: dict[str, list[dict[str, Any]]] = {}
        for row in rows:
            turn_id = str(row["turn_id"] or "").strip()
            if not turn_id:
                continue
            try:
                payload = json.loads(row["payload_json"] or "{}")
            except json.JSONDecodeError:
                payload = {}
            if not isinstance(payload, dict):
                payload = {"value": payload}
            payload = {
                "id": int(row["id"]),
                "type": str(row["event_type"] or payload.get("type") or "ui_event"),
                "turn_id": turn_id,
                "created_at": str(row["created_at"]),
                **payload,
            }
            events_by_turn.setdefault(turn_id, []).append(payload)
        return events_by_turn

    @staticmethod
    def _message_part_key(part: Any) -> str | None:
        if not isinstance(part, dict):
            return None
        part_id = str(part.get("id") or "").strip()
        if part_id:
            return part_id
        event = part.get("event")
        if not isinstance(event, dict):
            return None
        event_type = str(event.get("type") or "").strip()
        stable_id = (
            str(event.get("bridge_key") or "").strip()
            or str(event.get("skill_studio_session_id") or "").strip()
            or str(event.get("clarification_id") or "").strip()
        )
        if event_type and stable_id:
            return f"{event_type}:{stable_id}"
        return None

    @staticmethod
    def _is_transient_message_part(part: Any) -> bool:
        if not isinstance(part, dict):
            return False
        if str(part.get("type") or "") != "skill_studio":
            return False
        event = part.get("event")
        return isinstance(event, dict) and str(event.get("type") or "") == "skill_studio.status"

    @classmethod
    def _merge_message_parts_snapshots(cls, snapshots: list[list[Any]]) -> list[Any]:
        merged: list[Any] = []
        for snapshot in snapshots:
            if not isinstance(snapshot, list):
                continue
            snapshot_keys = {
                key
                for part in snapshot
                if (key := cls._message_part_key(part))
            }
            preserved: list[Any] = []
            for part in merged:
                if not isinstance(part, dict):
                    continue
                part_type = str(part.get("type") or "")
                key = cls._message_part_key(part)
                if part_type == "canvas_approval":
                    continue
                if cls._is_transient_message_part(part):
                    continue
                if part_type == "text" and key not in snapshot_keys:
                    continue
                if key and key in snapshot_keys:
                    continue
                preserved.append(part)
            merged = [*preserved, *snapshot]
        return merged

    @staticmethod
    def _attach_ui_events_to_messages(
        messages: list[dict[str, Any]],
        events_by_turn: dict[str, list[dict[str, Any]]],
    ) -> None:
        if not messages or not events_by_turn:
            return
        for turn_id, events in events_by_turn.items():
            if not events:
                continue
            target_index: int | None = None
            for index, message in enumerate(messages):
                if message.get("role") == "assistant" and message.get("turn_id") == turn_id:
                    target_index = index
                    break
            if target_index is None:
                user_index = next(
                    (
                        index
                        for index, message in enumerate(messages)
                        if message.get("role") == "user" and message.get("turn_id") == turn_id
                    ),
                    None,
                )
                if user_index is not None:
                    for index in range(user_index + 1, len(messages)):
                        if messages[index].get("role") == "assistant":
                            target_index = index
                            break
                    if target_index is None:
                        target_index = user_index
            if target_index is None:
                # Some tool-only turns do not produce an assistant message, for example
                # when Hermes returns no natural-language content after a canvas approval.
                # Keep the UI events visible by anchoring them to the user message for
                # that turn; the frontend expands tool_activity events beside it.
                target_index = next(
                    (
                        index
                        for index, message in enumerate(messages)
                        if message.get("role") == "user" and message.get("turn_id") == turn_id
                    ),
                    None,
                )
            if target_index is None:
                first_event = events[0]
                messages.append(
                    {
                        "id": f"ui-events:{turn_id}",
                        "role": "assistant",
                        "content": "",
                        "media": [],
                        "attachments": [],
                        "turn_id": turn_id,
                        "created_at": str(first_event.get("created_at") or ""),
                        "ui_events": [],
                    }
                )
                target_index = len(messages) - 1
            parts_events = [
                event
                for event in events
                if str(event.get("type") or "") == "assistant.message_parts"
                and isinstance(event.get("parts"), list)
            ]
            visible_events = [
                event
                for event in events
                if str(event.get("type") or "") != "assistant.message_parts"
            ]
            if parts_events:
                messages[target_index]["parts"] = ChatStore._merge_message_parts_snapshots(
                    [
                        event["parts"]
                        for event in parts_events
                        if isinstance(event.get("parts"), list)
                    ]
                )
            existing = messages[target_index].get("ui_events")
            if not isinstance(existing, list):
                existing = []
            messages[target_index]["ui_events"] = [*existing, *visible_events]

    def list_messages(
        self,
        username: str,
        scope: ChatScope,
        *,
        limit: int = 50,
    ) -> list[dict[str, Any]]:
        conn = self.connect(username, scope, db_path=self.read_db_for(username, scope))
        try:
            rows = conn.execute(
                """
                SELECT id, role, content, media_json, turn_id, metadata_json, created_at
                  FROM chat_messages
                 WHERE role <> 'trace'
                 ORDER BY id DESC
                 LIMIT ?
                """,
                (limit,),
            ).fetchall()
            events_by_turn = self._load_ui_events(conn)
        finally:
            conn.close()
        messages: list[dict[str, Any]] = []
        previous_assistants: list[str] = []
        for row in reversed(rows):
            try:
                media = json.loads(row["media_json"] or "[]")
            except json.JSONDecodeError:
                media = []
            role = str(row["role"])
            content = str(row["content"])
            if role == "assistant":
                raw_content = content
                content = _strip_replayed_assistant_prefix(content, previous_assistants)
                previous_assistants.append(raw_content)
            else:
                previous_assistants = []
            try:
                metadata = json.loads(row["metadata_json"] or "{}")
            except json.JSONDecodeError:
                metadata = {}
            if not isinstance(metadata, dict):
                metadata = {}
            messages.append(
                {
                    "id": int(row["id"]),
                    "role": role,
                    "content": content,
                    "media": media if isinstance(media, list) else [],
                    "attachments": media if isinstance(media, list) else [],
                    **({"turn_id": str(row["turn_id"])} if row["turn_id"] else {}),
                    **metadata,
                    "created_at": str(row["created_at"]),
                }
            )
        visible_turn_ids = {
            str(message.get("turn_id") or "").strip()
            for message in messages
            if str(message.get("turn_id") or "").strip()
        }
        self._attach_ui_events_to_messages(
            messages,
            {
                turn_id: events
                for turn_id, events in events_by_turn.items()
                if turn_id in visible_turn_ids
            },
        )
        return messages


chat_store = ChatStore()
