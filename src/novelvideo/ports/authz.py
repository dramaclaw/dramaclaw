"""Authorization and immutable admission contracts."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

from novelvideo.ports.model_credentials import CredentialReference


_AUTHZ_ERROR_MESSAGES = {
    "ORG_CONTEXT_REQUIRED": "organization authorization context is required",
    "ORG_MEMBERSHIP_INACTIVE": "organization membership is inactive",
    "ORG_AUTHZ_STALE": "organization authorization snapshot is stale",
}


class AuthzError(RuntimeError):
    """Stable authorization failure without identity or credential details."""

    def __init__(self, code: str) -> None:
        super().__init__(_AUTHZ_ERROR_MESSAGES.get(code, "organization authorization failed"))
        self.code = code


@dataclass(frozen=True)
class BillingPrincipal:
    kind: str
    id: str

    def __post_init__(self) -> None:
        if self.kind not in {"platform", "organization", "local"}:
            raise ValueError("unsupported billing principal kind")
        if not self.id:
            raise ValueError("billing principal id is required")


@dataclass(frozen=True)
class AuthzSnapshot:
    requester_user_id: str
    org_id: str
    membership_id: str
    role: str
    membership_status: str
    org_status: str
    authz_version: int

    def __post_init__(self) -> None:
        for field_name in ("requester_user_id", "org_id", "membership_id", "role"):
            if not getattr(self, field_name):
                raise ValueError(f"{field_name} is required")
        if self.membership_status not in {"active", "inactive", "suspended", "left"}:
            raise ValueError("unsupported membership_status")
        if self.org_status not in {"active", "suspended", "inactive"}:
            raise ValueError("unsupported org_status")
        if type(self.authz_version) is not int or self.authz_version < 1:
            raise ValueError("authz_version must be positive")

    def require_active(self, *, expected_authz_version: int | None = None) -> None:
        if self.membership_status != "active" or self.org_status != "active":
            raise AuthzError("ORG_MEMBERSHIP_INACTIVE")
        if (
            expected_authz_version is not None
            and self.authz_version != expected_authz_version
        ):
            raise AuthzError("ORG_AUTHZ_STALE")


@dataclass(frozen=True)
class AdmissionContext:
    requester_user_id: str
    billing_principal: BillingPrincipal
    credential: CredentialReference
    admission_id: str
    root_task_id: str
    admitted_at: str
    membership_id: str | None = None
    authz_version: int = 0

    def __post_init__(self) -> None:
        if not all(
            (
                self.requester_user_id,
                self.admission_id,
                self.root_task_id,
                self.admitted_at,
            )
        ):
            raise ValueError("admission identity fields are required")
        if type(self.authz_version) is not int or self.authz_version < 1:
            raise ValueError("authz_version must be positive")
        if self.billing_principal.kind == "organization":
            if not self.membership_id:
                raise ValueError("organization admission requires membership_id")
            if self.credential.source != "organization":
                raise ValueError("organization admission requires organization credential")
            if self.credential.org_id != self.billing_principal.id:
                raise ValueError("organization admission credential org mismatch")


class AuthzPort(Protocol):
    async def snapshot(self, *, user_id: str) -> AuthzSnapshot: ...

    async def check(
        self,
        *,
        snapshot: AuthzSnapshot,
        expected_authz_version: int | None = None,
    ) -> None: ...

    async def admit_model_task(self, *, user_id: str, root_task_id: str) -> AdmissionContext: ...
