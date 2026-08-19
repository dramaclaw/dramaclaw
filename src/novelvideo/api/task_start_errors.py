"""Preserve typed task-start failures for application-level HTTP handlers."""

from __future__ import annotations

import logging

from novelvideo.ports.authz import find_authz_error
from novelvideo.shared.billing_errors import (
    find_billing_error,
    find_billing_rule_not_configured_error,
    find_insufficient_credits_error,
    iter_exception_chain,
)
from novelvideo.task_backend.limits import (
    ChannelTaskLimitExceeded,
    GlobalLaneQueueLimitExceeded,
    ProjectTaskLimitExceeded,
    ProjectUserTaskLimitExceeded,
    UserTaskLimitExceeded,
)

_TASK_LIMIT_ERRORS = (
    ProjectTaskLimitExceeded,
    ProjectUserTaskLimitExceeded,
    GlobalLaneQueueLimitExceeded,
    ChannelTaskLimitExceeded,
    UserTaskLimitExceeded,
)


def handle_task_start_runtime_error(
    logger: logging.Logger,
    message: str,
    exc: RuntimeError,
) -> None:
    """Re-raise typed failures and log ordinary task-start runtime errors."""
    for item in iter_exception_chain(exc):
        if isinstance(item, _TASK_LIMIT_ERRORS):
            raise item

    billing = find_insufficient_credits_error(exc)
    if billing is None:
        billing = find_billing_rule_not_configured_error(exc)
    if billing is None:
        billing = find_billing_error(exc)
    if billing is not None:
        raise billing

    authz_denial = find_authz_error(exc)
    if authz_denial is not None:
        raise authz_denial

    logger.warning("%s: %s", message, exc, exc_info=True)
