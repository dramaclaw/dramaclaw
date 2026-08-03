"""Deployment gate for legacy local service operations."""

from __future__ import annotations

from novelvideo.shared.runtime_env import is_ce_effective

SERVICE_OPERATION_DENIED = "ORG_SERVICE_EGRESS_DENIED"


class ServiceOperationExcluded(RuntimeError):
    """Stable denial outside the legacy effective CE-local runtime."""

    code = SERVICE_OPERATION_DENIED

    def __init__(self) -> None:
        super().__init__(SERVICE_OPERATION_DENIED)


def require_legacy_local_service_operation() -> None:
    """Allow existing platform/ops mutations only in effective CE-local runtime."""

    if not is_ce_effective():
        raise ServiceOperationExcluded()
