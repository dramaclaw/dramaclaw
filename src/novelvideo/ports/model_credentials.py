"""Request-scoped model credential contracts."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Protocol


class ModelCredentialError(RuntimeError):
    """Stable, secret-free credential resolution failure."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class CredentialReference:
    source: str
    credential_id: str
    key_version: int
    org_id: str | None = None

    def __post_init__(self) -> None:
        if self.source not in {"platform", "organization", "local"}:
            raise ValueError("unsupported credential source")
        if not self.credential_id:
            raise ValueError("credential_id is required")
        if self.key_version < 1:
            raise ValueError("key_version must be positive")
        if self.source == "organization" and not self.org_id:
            raise ValueError("organization credential requires org_id")


@dataclass(frozen=True)
class RequestCredential:
    reference: CredentialReference
    api_key: str = field(repr=False)
    base_url: str

    def __post_init__(self) -> None:
        if not self.api_key:
            raise ValueError("api_key is required")
        if not self.base_url:
            raise ValueError("base_url is required")


class ModelCredentialPort(Protocol):
    async def resolve(self, admission) -> RequestCredential: ...
