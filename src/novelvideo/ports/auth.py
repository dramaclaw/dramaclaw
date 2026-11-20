"""Authentication ports."""

from __future__ import annotations

from typing import Protocol

from novelvideo.ports.auth_contract import AgentSessionToken


class AuthPort(Protocol):
    async def verify_session(self, raw_cookie: str | None) -> dict: ...

    async def check_session(self, *, session_id: str | None, user_id: str) -> None:
        """Re-check a browser session by id, without its raw cookie.

        Returns ``None`` while the session is usable and its user is active, and
        raises ``AuthError`` with the same reasons ``verify_session`` uses
        otherwise. ``session_id`` is ``None`` when the verified user carried no
        session id; the user must still be validated.
        """
        ...

    async def revoke_session(self, raw_cookie: str) -> None: ...


class AuthSessionPort(Protocol):
    async def verify_agent_session(self, token: str) -> dict: ...

    async def check_agent_session(self, *, agent_session_id: str) -> None:
        """Re-check an agent session by id, without its raw token.

        Returns ``None`` while the session is usable and its user is active, and
        raises ``AuthError`` with the same reasons ``verify_agent_session`` uses
        otherwise.
        """
        ...

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
    ) -> AgentSessionToken: ...

    async def update_agent_session_scope(
        self,
        token_value: str,
        *,
        scope_kind: str,
        project_id: str | None,
    ) -> None: ...

    async def revoke_agent_session(self, token_value: str) -> None: ...
