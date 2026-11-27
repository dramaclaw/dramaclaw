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

    # Agent keys. Optional: an installation without an agent key service leaves both
    # methods out, and callers must treat their absence as "agent keys unsupported".
    # Both raise ``AuthError`` for a credential decision; any other exception means the
    # decision could not be made and must not be reported as a rejected key.

    async def check_agent_key(self, raw_key: str) -> None:
        """Confirm that an agent key is still usable, on every request it makes.

        Returns ``None`` while the key is neither revoked nor expired and its user is
        active, and raises ``AuthError`` (``INVALID``, ``REVOKED``, ``EXPIRED`` or
        ``USER_SUSPENDED``) otherwise.
        """
        ...

    async def exchange_agent_key(
        self,
        raw_key: str,
        *,
        ttl_seconds: int | None = None,
        worker_id: str | None = None,
        current_scope_kind: str = "home",
        current_project_id: str | None = None,
    ) -> AgentSessionToken:
        """Exchange an agent key for a short-lived agent session in the given scope.

        Raises ``AuthError`` with the reasons of ``check_agent_key``, and with
        ``FORBIDDEN`` when the key is valid but may not be used on
        ``current_project_id``. Raises ``PROJECT_DELETED`` when the key may be used
        on the project but it has been deleted, checked after the allow-list and
        the project role.
        """
        ...
