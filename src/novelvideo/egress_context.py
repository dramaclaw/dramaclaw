"""Request-scoped, secret-free identity for egress adapters."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from novelvideo.ports.authz import BillingPrincipal
from novelvideo.ports.model_credentials import CredentialReference

TRUSTED_EGRESS_CONTEXT_KEY = "__trusted_egress_context"


class TrustedRunnerEnvelope(dict[str, Any]):
    """Internal runner envelope constructed by the verified task core."""

    __slots__ = ()


@dataclass(frozen=True, slots=True)
class TrustedEgressContext:
    """Identity copied only from a verified task delivery by the task core."""

    envelope_id: str
    project_id: str
    task_type: str
    requester_user_id: str
    root_task_id: str
    admission_id: str
    admitted_at: str
    membership_id: str | None
    authz_version: int
    billing_principal: BillingPrincipal
    credential: CredentialReference

    def __post_init__(self) -> None:
        for field_name in (
            "envelope_id",
            "project_id",
            "task_type",
            "requester_user_id",
            "root_task_id",
            "admission_id",
        ):
            value = getattr(self, field_name)
            if type(value) is not str or not value:
                raise ValueError(f"{field_name} is required")
        if type(self.admitted_at) is not str:
            raise TypeError("admitted_at must be a string")
        if not self.admitted_at:
            raise ValueError("admitted_at is required")
        if self.membership_id is not None and (
            type(self.membership_id) is not str or not self.membership_id
        ):
            raise ValueError("membership_id must be a non-empty string or None")
        if type(self.authz_version) is not int or self.authz_version < 1:
            raise ValueError("authz_version must be positive")
        if type(self.billing_principal) is not BillingPrincipal:
            raise TypeError("billing_principal must be a BillingPrincipal")
        if type(self.credential) is not CredentialReference:
            raise TypeError("credential must be a CredentialReference")

    @property
    def is_organization(self) -> bool:
        return self.billing_principal.kind == "organization"
