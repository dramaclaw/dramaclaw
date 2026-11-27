"""Authentication DTOs shared by control-plane and data-plane code."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from enum import Enum
from typing import Any, Dict, Optional

AGENT_KEY_PROJECT_DELETED_CODE = "agent_key_project_deleted"
AGENT_KEY_PROJECT_DELETED_MESSAGE = (
    "The agent key is valid, but this project has been deleted. Only the project owner can "
    "restore it in the web app, after which the same key works again without needing to replace it."
)

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
    # The credential is valid but may not be used for what it was presented for,
    # such as an agent key presented for a project it is not allowed on.
    FORBIDDEN = "forbidden"
    # The credential is valid and allowed on the project, which was deleted and can be restored.
    PROJECT_DELETED = "project_deleted"


class AuthError(Exception):
    """Raised when credential verification fails."""

    def __init__(self, reason: AuthFailureReason, detail: str = ""):
        self.reason = reason
        self.detail = detail
        super().__init__(f"{reason.value}: {detail}" if detail else reason.value)


def is_external_agent_key_session(user: object) -> bool:
    """Recognize agent sessions using only the server-written external key marker.

    The marker comes only from the verified session returned by the auth session
    port; client input cannot establish an external agent key session.
    """
    if not isinstance(user, Mapping) or user.get("credential_kind") != "agent_session":
        return False
    key_id = user.get("external_agent_key_id")
    return isinstance(key_id, str) and bool(key_id.strip())


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
    # Set only by the auth session port. An empty tuple adds no restriction.
    allowed_projects: tuple[str, ...] = ()

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
        if self.allowed_projects:
            data["allowed_projects"] = list(self.allowed_projects)
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
    "AGENT_KEY_PROJECT_DELETED_CODE",
    "AGENT_KEY_PROJECT_DELETED_MESSAGE",
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
    "is_external_agent_key_session",
]
