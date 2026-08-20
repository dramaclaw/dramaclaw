"""Authorization and immutable admission contracts."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

from novelvideo.ports.model_credentials import CredentialReference

# Redacted exception text. This is what lands in a failed task's `error`
# column (see ports/local/tasks.py and the EE task backend), so it must cover
# every code the admission definer can reject with — a missing entry degrades
# into the generic string below and makes two unrelated root causes read
# identically. Credential wording is kept identical to
# model_credentials.py::_CREDENTIAL_ERROR_MESSAGES on purpose.
_AUTHZ_ERROR_MESSAGES = {
    "ORG_CONTEXT_REQUIRED": "organization authorization context is required",
    "ORG_MEMBERSHIP_INACTIVE": "organization membership is inactive",
    "ORG_AUTHZ_STALE": "organization authorization snapshot is stale",
    "MODEL_ACCESS_DENIED": "organization model access is denied",
    "ORG_CREDENTIAL_MISSING": "organization credential is missing",
    "ORG_CREDENTIAL_DISABLED": "organization credential is disabled",
    "ORG_CREDENTIAL_VERSION_MISMATCH": "organization credential version mismatch",
    "ORG_CREDENTIAL_DECRYPT_FAILED": "organization credential could not be resolved",
    "ORG_AUTHZ_UNAVAILABLE": "organization authorization service is unavailable",
    "P0_GRAY_DISABLED": "organization task rollout is disabled",
}

_GENERIC_AUTHZ_ERROR_MESSAGE = "organization authorization failed"

# Frozen HTTP contract: docs/b2b-org-tenant/frontend-spec.md §12 (EE repo).
# MODEL_ACCESS_DENIED and P0_GRAY_DISABLED are not in that table; they are
# pinned here as the access-decision and deployment-fail-closed members of the
# same taxonomy. An unmapped code fails closed to 403.
AUTHZ_ERROR_HTTP_STATUS = {
    "ORG_CONTEXT_REQUIRED": 403,
    "ORG_MEMBERSHIP_INACTIVE": 403,
    "MODEL_ACCESS_DENIED": 403,
    "ORG_AUTHZ_STALE": 409,
    "ORG_CREDENTIAL_MISSING": 409,
    "ORG_CREDENTIAL_DISABLED": 409,
    "ORG_CREDENTIAL_VERSION_MISMATCH": 409,
    "ORG_CREDENTIAL_DECRYPT_FAILED": 503,
    "ORG_AUTHZ_UNAVAILABLE": 503,
    "P0_GRAY_DISABLED": 503,
}

_AUTHZ_ERROR_FALLBACK_STATUS = 403

# User-facing copy, mirroring the 默认提示 column of the same §12 table.
_AUTHZ_USER_MESSAGES = {
    "ORG_CONTEXT_REQUIRED": "当前请求缺少有效组织身份",
    "ORG_MEMBERSHIP_INACTIVE": "组织成员身份已暂停或失效",
    "MODEL_ACCESS_DENIED": "当前组织未开通该模型能力，请联系组织管理员",
    "ORG_AUTHZ_STALE": "权限已变化，请刷新后重试",
    "ORG_CREDENTIAL_MISSING": "组织尚无可用 Key，请联系组织管理员绑定",
    "ORG_CREDENTIAL_DISABLED": "组织 Key 当前不可用，请联系组织管理员",
    "ORG_CREDENTIAL_VERSION_MISMATCH": "Key 状态已更新，请刷新后重试",
    "ORG_CREDENTIAL_DECRYPT_FAILED": "凭证服务异常，请联系支持",
    "ORG_AUTHZ_UNAVAILABLE": "授权服务暂时不可用，请稍后重试",
    "P0_GRAY_DISABLED": "组织任务功能当前未开放，请联系支持",
}

_GENERIC_AUTHZ_USER_MESSAGE = "组织授权校验未通过，请联系组织管理员"


def authz_error_http_status(code: str) -> int:
    """Contracted HTTP status for a stable authz code; unknown fails closed."""
    return AUTHZ_ERROR_HTTP_STATUS.get(code, _AUTHZ_ERROR_FALLBACK_STATUS)


def authz_error_user_message(code: str) -> str:
    """User-facing copy for a stable authz code, free of identity details."""
    return _AUTHZ_USER_MESSAGES.get(code, _GENERIC_AUTHZ_USER_MESSAGE)


class AuthzError(RuntimeError):
    """Stable authorization failure without identity or credential details."""

    def __init__(self, code: str) -> None:
        super().__init__(_AUTHZ_ERROR_MESSAGES.get(code, _GENERIC_AUTHZ_ERROR_MESSAGE))
        self.code = code

    @property
    def http_status(self) -> int:
        return authz_error_http_status(self.code)

    @property
    def user_message(self) -> str:
        return authz_error_user_message(self.code)


class AuthzServiceUnavailable(AuthzError):
    """Retryable authorization dependency outage with a redacted surface."""

    failure_kind = "unavailable"

    def __init__(self) -> None:
        super().__init__("ORG_AUTHZ_UNAVAILABLE")


class AuthzServiceFault(AuthzError):
    """Unexpected authorization service response with a redacted surface."""

    failure_kind = "fault"

    def __init__(self) -> None:
        super().__init__("ORG_AUTHZ_UNAVAILABLE")


def detach_authz_error(error: AuthzError) -> AuthzError:
    """Remove internal exception state before an authz error crosses a boundary."""
    error.__cause__ = None
    error.__context__ = None
    error.__traceback__ = None
    return error


def authz_error_payload(exc: AuthzError) -> dict[str, str]:
    """Rendered payload for an authz denial. Carries no identity or credential."""
    return {"error_code": exc.code, "message": exc.user_message}


def find_authz_error(exc: BaseException | None) -> AuthzError | None:
    """Locate an authz denial wrapped anywhere in an exception chain."""
    from novelvideo.shared.billing_errors import iter_exception_chain

    for item in iter_exception_chain(exc):
        if isinstance(item, AuthzError):
            return item
    return None


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
                raise ValueError(
                    "organization admission requires organization credential"
                )
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

    async def admit_model_task(
        self, *, user_id: str, root_task_id: str
    ) -> AdmissionContext: ...
