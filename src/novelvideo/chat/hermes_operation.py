"""Close out the egress operation for one Hermes turn.

The claim is created per business turn — ``authorize_credentialed_hermes`` takes
the prompt and digests it — but until now only one terminal transition existed,
for a credential that failed to decrypt. Every successful turn stayed
``dispatching`` forever, and so did every timeout, cancellation and crash.

Two rules shape everything here.

**Only a proof of non-submission may say "rejected".** Once the prompt has been
written to the ACP stream, DramaClaw cannot know whether Hermes reached the
gateway, so anything after that point is ``unknown``. That makes ``unknown``
more common than intuition suggests, which is the honest outcome: an operation
that might have spent money must not be recorded as one that certainly did not.

**Settling the ledger must never cause a second provider call.** A failure to
write the ledger is logged and dropped. The alternative — retrying the turn
because the bookkeeping failed — would charge twice for one request.
"""

from __future__ import annotations

import logging
from typing import Any, Optional

_log = logging.getLogger(__name__)

#: How a turn ended, decided by the streaming loop rather than by matching text.
DISPOSITION_COMPLETED = "completed"
DISPOSITION_TIMEOUT = "timeout"
DISPOSITION_CANCELLED = "cancelled"
DISPOSITION_FAILED = "failed"


class TurnOperationFinalizer:
    """Owns one claim for the lifetime of one business turn.

    Retries live inside that lifetime: a session reset or a tool-guard recovery
    re-sends the prompt but is still the same turn, so it reuses this finalizer
    and must not claim again. ``accepted`` therefore happens at most once even
    though ``submitted()`` may be called several times.
    """

    def __init__(self, operation_port: Any, claim: Any) -> None:
        self._port = operation_port
        self._operation_id = claim.operation.operation_id
        self._transition_token = str(claim.transition_token)
        # Each transition returns a new snapshot; using the claim's version for
        # a later call would fail the optimistic check.
        self._version = claim.operation.version
        self._submitted = False
        self._finalized = False

    @property
    def submitted(self) -> bool:
        return self._submitted

    @property
    def finalized(self) -> bool:
        return self._finalized

    async def submitted_to_agent(self) -> None:
        """Record that the prompt reached the ACP stream. Idempotent."""
        if self._submitted or self._finalized:
            return
        self._submitted = True
        snapshot = await self._guard(
            self._port.mark_accepted,
            operation_id=self._operation_id,
            transition_token=self._transition_token,
            expected_version=self._version,
        )
        self._advance(snapshot)

    async def finish(self, disposition: str) -> None:
        """Settle the operation exactly once."""
        if self._finalized:
            return
        self._finalized = True
        if not self._submitted:
            # Nothing was written to the agent, so this is provably a
            # non-submission whatever went wrong.
            await self._guard(
                self._port.mark_rejected_before_submit,
                operation_id=self._operation_id,
                transition_token=self._transition_token,
                expected_version=self._version,
            )
            return
        if disposition == DISPOSITION_COMPLETED:
            await self._guard(
                self._port.mark_completed,
                operation_id=self._operation_id,
                transition_token=self._transition_token,
                expected_version=self._version,
            )
            return
        # Submitted, and the outcome is not a proven success. Whether the
        # gateway was reached is unknowable from here.
        await self._guard(
            self._port.mark_unknown,
            operation_id=self._operation_id,
            transition_token=self._transition_token,
            expected_version=self._version,
        )

    async def _guard(self, transition: Any, **kwargs: Any) -> Optional[Any]:
        """Run one ledger transition, swallowing its failure.

        A ledger write that fails must not propagate: the caller's only
        reasonable reaction would be to retry the turn, which would call the
        provider a second time for one business request.
        """
        try:
            return await transition(**kwargs)
        except Exception:
            # The operation id is a correlation handle; the transition token is
            # a capability and is never logged.
            _log.warning(
                "could not settle egress operation %s", self._operation_id, exc_info=True)
            return None

    def _advance(self, snapshot: Any) -> None:
        version = getattr(snapshot, "version", None)
        if isinstance(version, int):
            self._version = version


def disposition_for(event: Any) -> str:
    """Classify a terminal streaming event.

    ``complete`` alone proves nothing: the worker synthesises one for a timeout
    too. The event carries an explicit disposition for exactly that reason, and
    only its absence on a genuine completion means success.
    """
    declared = getattr(event, "disposition", None)
    if isinstance(declared, str) and declared:
        return declared
    return DISPOSITION_COMPLETED
