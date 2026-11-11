"""Local CE authentication port implementations."""

from __future__ import annotations

import hashlib
import json
import os
import time
from collections.abc import Callable
from dataclasses import asdict, replace
from pathlib import Path

from ulid import ULID

from novelvideo.config import RUNTIME_DIR
from novelvideo.ports.auth_contract import (
    AgentAuthenticatedUser,
    AgentSessionToken,
    AuthenticatedUser,
    AuthError,
    AuthFailureReason,
)
from novelvideo.utils.state_index_files import write_json_atomic


class FileAuthPort:
    async def verify_session(self, raw_cookie: str | None) -> dict:
        username = os.environ.get("ST_LOCAL_USERNAME", "").strip() or "local"
        return AuthenticatedUser(id="local", username=username, role="owner").to_legacy_dict()

    async def revoke_session(self, raw_cookie: str) -> None:
        return None


class LocalAuthSession:
    def __init__(
        self,
        root: str | Path | None = None,
        *,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self._root = Path(root) if root is not None else Path(RUNTIME_DIR) / "agent_sessions"
        self._clock = clock

    def _session_path(self, token_value: str) -> Path:
        return self._root / f"{hashlib.sha256(token_value.encode()).hexdigest()}.json"

    def _load_session(self, token_value: str) -> tuple[AgentAuthenticatedUser, int]:
        path = self._session_path(token_value)
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            if not isinstance(data, dict):
                raise ValueError("invalid session data")
            exp = data.pop("exp")
            expired = exp <= self._clock()
            data["scopes"] = tuple(data["scopes"])
            session = AgentAuthenticatedUser(**data)
        except (OSError, ValueError, TypeError, KeyError):
            raise AuthError(AuthFailureReason.INVALID, "agent session not found") from None
        if expired:
            path.unlink(missing_ok=True)
            raise AuthError(AuthFailureReason.EXPIRED, "agent session expired")
        return session, exp

    def _write_session(self, token_value: str, session: AgentAuthenticatedUser, exp: int) -> None:
        self._root.mkdir(parents=True, exist_ok=True)
        self._root.chmod(0o700)
        write_json_atomic(self._session_path(token_value), {**asdict(session), "exp": exp})

    async def create_agent_session(
        self,
        *,
        username: str,
        scopes,
        ttl_seconds: int | None = None,
        agent_kind: str = "agent",
        worker_id: str | None = None,
        parent_session_id: str | None = None,
        current_scope_kind: str = "home",
        current_project_id: str | None = None,
        metadata: dict | None = None,
    ) -> AgentSessionToken:
        session_id = str(ULID())
        token_value = f"local-{ULID()}"
        exp = int(self._clock()) + int(ttl_seconds or 2 * 3600)
        normalized_scopes = tuple(scopes or ())
        session = AgentAuthenticatedUser(
            id="local",
            username=username,
            role="owner",
            agent_session_id=session_id,
            agent_kind=agent_kind,
            worker_id=worker_id,
            scopes=normalized_scopes,
            current_scope_kind=current_scope_kind,
            current_project_id=current_project_id,
            parent_session_id=parent_session_id,
        )
        for path in self._root.glob("*.json"):
            try:
                expired = json.loads(path.read_text(encoding="utf-8"))["exp"] <= self._clock()
            except (OSError, ValueError, TypeError, KeyError):
                continue
            if expired:
                path.unlink(missing_ok=True)
        self._write_session(token_value, session, exp)
        return AgentSessionToken(
            value=token_value,
            session_id=session_id,
            user=username,
            scopes=normalized_scopes,
            exp=exp,
            worker_id=worker_id or "",
            agent_kind=agent_kind,
        )

    async def verify_agent_session(self, token: str) -> dict:
        session, _ = self._load_session(token)
        return session.to_legacy_dict()

    async def update_agent_session_scope(
        self,
        token_value: str,
        *,
        scope_kind: str,
        project_id: str | None,
    ) -> None:
        session, exp = self._load_session(token_value)
        updated = replace(
            session,
            current_scope_kind=scope_kind,
            current_project_id=project_id,
        )
        self._write_session(token_value, updated, exp)

    async def revoke_agent_session(self, token_value: str) -> None:
        self._session_path(token_value).unlink(missing_ok=True)
