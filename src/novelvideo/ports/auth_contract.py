"""Authentication DTOs shared by control-plane and data-plane code."""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Any, Dict, Optional

DEFAULT_EXTERNAL_AGENT_SCOPES = [
    "projects:read",
    "projects:write",
    "tasks:submit",
    "tasks:poll",
    "media:read",
    "assets:read",
]


class TokenSource(str, Enum):
    COOKIE = "cookie"


class AuthFailureReason(str, Enum):
    MISSING = "missing"
    INVALID = "invalid"
    REVOKED = "revoked"
    EXPIRED = "expired"
    USER_SUSPENDED = "suspended"


class AuthError(Exception):
    """Raised when credential verification fails."""

    def __init__(self, reason: AuthFailureReason, detail: str = ""):
        self.reason = reason
        self.detail = detail
        super().__init__(f"{reason.value}: {detail}" if detail else reason.value)


@dataclass(frozen=True)
class AuthenticatedUser:
    id: str
    username: str
    role: str
    status: str = "active"

    def to_legacy_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "user_id": self.id,
            "username": self.username,
            "role": self.role,
        }


@dataclass(frozen=True)
class AgentAuthenticatedUser(AuthenticatedUser):
    agent_session_id: str = ""
    agent_kind: str = "agent"
    worker_id: Optional[str] = None
    scopes: tuple[str, ...] = ()
    current_scope_kind: str = "home"
    current_project_id: Optional[str] = None
    parent_session_id: Optional[str] = None
    # Set only by the auth session port for external agent key exchanges;
    # never taken from client input.
    external_agent_key_id: Optional[str] = None

    def to_legacy_dict(self) -> Dict[str, Any]:
        data = super().to_legacy_dict()
        data.update(
            {
                "credential_kind": "agent_session",
                "agent_session_id": self.agent_session_id,
                "agent_kind": self.agent_kind,
                "worker_id": self.worker_id,
                "scopes": list(self.scopes),
                "current_scope_kind": self.current_scope_kind,
                "current_project_id": self.current_project_id,
                "parent_session_id": self.parent_session_id,
            }
        )
        if isinstance(self.external_agent_key_id, str) and self.external_agent_key_id.strip():
            data["external_agent_key_id"] = self.external_agent_key_id.strip()
        return data


@dataclass(frozen=True)
class AgentSessionToken:
    value: str
    session_id: str
    user: str
    scopes: tuple[str, ...]
    exp: int
    worker_id: str
    agent_kind: str = "agent"


@dataclass(frozen=True)
class ExternalAgentKey:
    id: str
    user_id: str
    username: str
    role: str
    status: str
    label: str
    agent_kind: str
    scopes: tuple[str, ...]
    max_ttl_seconds: int
    allowed_projects: tuple[str, ...]


@dataclass(frozen=True)
class ExternalAgentKeyToken:
    value: str
    key_id: str
    user: str
    label: str
    agent_kind: str
    scopes: tuple[str, ...]
    max_ttl_seconds: int


@dataclass(frozen=True)
class LoginResult:
    user: AuthenticatedUser
    session_id: str
    raw_cookie: str


__all__ = [
    "DEFAULT_EXTERNAL_AGENT_SCOPES",
    "AgentAuthenticatedUser",
    "AgentSessionToken",
    "AuthError",
    "AuthFailureReason",
    "AuthenticatedUser",
    "ExternalAgentKey",
    "ExternalAgentKeyToken",
    "LoginResult",
    "TokenSource",
]
