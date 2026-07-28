"""Authorization and immutable admission contracts."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

from novelvideo.ports.model_credentials import CredentialReference


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
        if self.billing_principal.kind == "organization":
            if not self.membership_id:
                raise ValueError("organization admission requires membership_id")
            if self.authz_version < 1:
                raise ValueError("organization admission requires authz_version")
            if self.credential.source != "organization":
                raise ValueError("organization admission requires organization credential")
            if self.credential.org_id != self.billing_principal.id:
                raise ValueError("organization admission credential org mismatch")


class AuthzPort(Protocol):
    async def admit_model_task(self, *, user_id: str, root_task_id: str) -> AdmissionContext: ...
