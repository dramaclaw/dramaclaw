"""A reconnect is not a new paid intent.

Return a recovery instruction only; authorization, durable dispatch and provider
calls belong to the later repository/outbox layer.
"""

from typing import Literal

from .schemas.foundation import ProviderAttempt

RecoveryAction = Literal[
    "dispatch_once",
    "wait_for_dispatch",
    "query_existing",
    "manual_reconciliation",
    "retry_ingestion",
    "none",
]


def recovery_action(attempt: ProviderAttempt) -> RecoveryAction:
    if attempt.status == "ingestion_failed":
        return "retry_ingestion"
    if attempt.status in {"succeeded", "failed", "cancelled"}:
        return "none"
    if attempt.provider_task_id is not None:
        return "query_existing"
    if attempt.status == "unknown":
        return "manual_reconciliation"
    if attempt.status == "dispatching":
        return "wait_for_dispatch"
    return "dispatch_once"
