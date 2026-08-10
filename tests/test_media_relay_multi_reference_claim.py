"""Each relayed object must claim its own durable egress operation.

The ledger keys an operation by {org, project, root_task, business_task,
capability} and deliberately leaves request_digest out, so that the same key
arriving with a different payload is reported as a conflict rather than
silently becoming a second operation. That is the same contract Stripe states
for idempotency keys, and it means the caller owes the ledger one key per side
effect. Relaying N reference images under a single key breaks that side of the
bargain, and the ledger correctly refuses the second image.

The double below mirrors product_claim_egress_operation
(0039_p0_gray_egress_operations.py:192-215) rather than returning a fixed
verdict, because a stateless double cannot express the very behaviour under
test.
"""

from __future__ import annotations

import pytest

from novelvideo.egress_context import TrustedEgressContext
from novelvideo.ports.authz import BillingPrincipal
from novelvideo.ports.egress_operations import (
    EgressOperationError,
    OperationClaimResult,
    OperationSnapshot,
    OperationSpec,
    OperationState,
)
from novelvideo.ports.model_credentials import CredentialReference


class LedgerDouble:
    """Key-addressed stand-in for the durable operation authority.

    Mirrors the definer: first claim on a key inserts and wins; a later claim
    on the same key replays when the request digest matches and raises
    EGRESS_OPERATION_CONFLICT when it does not.
    """

    def __init__(self) -> None:
        self.rows: dict[str, dict] = {}
        self.claims: list[OperationSpec] = []

    async def claim(self, *, spec: OperationSpec) -> OperationClaimResult:
        self.claims.append(spec)
        key = spec.operation_key
        existing = self.rows.get(key)
        if existing is None:
            row = {
                "operation_id": f"op-{len(self.rows) + 1}",
                "request_digest": spec.request_digest,
                "state": OperationState.DISPATCHING,
                "version": 1,
                "transition_token": f"token-{len(self.rows) + 1}",
            }
            self.rows[key] = row
            return OperationClaimResult(
                won=True,
                operation=OperationSnapshot(
                    operation_id=row["operation_id"],
                    operation_key=key,
                    state=row["state"],
                    version=row["version"],
                ),
                transition_token=row["transition_token"],
            )
        if existing["request_digest"] != spec.request_digest:
            raise EgressOperationError("EGRESS_OPERATION_CONFLICT")
        return OperationClaimResult(
            won=False,
            operation=OperationSnapshot(
                operation_id=existing["operation_id"],
                operation_key=key,
                state=existing["state"],
                version=existing["version"],
            ),
            transition_token=None,
        )

    def _transition(self, kwargs, state: OperationState) -> OperationSnapshot:
        for key, row in self.rows.items():
            if row["operation_id"] == kwargs["operation_id"]:
                row["state"] = state
                row["version"] = kwargs["expected_version"] + 1
                return OperationSnapshot(
                    operation_id=row["operation_id"],
                    operation_key=key,
                    state=state,
                    version=row["version"],
                )
        raise EgressOperationError("EGRESS_OPERATION_INVALID_TRANSITION")

    async def mark_completed(self, **kwargs) -> OperationSnapshot:
        return self._transition(kwargs, OperationState.COMPLETED)

    async def mark_unknown(self, **kwargs) -> OperationSnapshot:
        return self._transition(kwargs, OperationState.UNKNOWN)


class RelayDouble:
    def __init__(self) -> None:
        self.object_keys: list[str] = []

    def upload_bytes(self, data, *, ext, ttl, object_key) -> str:
        self.object_keys.append(object_key)
        return f"https://relay.example/{len(self.object_keys)}"


def _org_context() -> TrustedEgressContext:
    return TrustedEgressContext(
        envelope_id="envelope-multi-ref",
        project_id="project-multi-ref",
        task_type="image.edit",
        requester_user_id="user-multi-ref",
        root_task_id="root-multi-ref",
        admission_id="admission-multi-ref",
        admitted_at="2026-08-03T04:05:00Z",
        membership_id="membership-multi-ref",
        authz_version=1,
        billing_principal=BillingPrincipal(kind="organization", id="org-multi-ref"),
        credential=CredentialReference(
            source="organization",
            credential_id="org-gateway-key",
            key_version=3,
            org_id="org-multi-ref",
        ),
    )


@pytest.fixture
def wired(monkeypatch):
    """Real relay code, doubled ledger and transport."""
    from novelvideo import ports
    from novelvideo.storage import media_relay

    ledger = LedgerDouble()
    relay = RelayDouble()
    monkeypatch.setattr(ports, "get_egress_operation_port", lambda: ledger)
    monkeypatch.setattr(media_relay, "get_media_relay", lambda: relay)
    return ledger, relay


async def _relay(images: list[bytes]) -> list[str]:
    from novelvideo.generators import nanobanana_grid

    return await nanobanana_grid._relay_reference_images_for_newapi(
        images,
        egress_context=_org_context(),
    )


@pytest.mark.asyncio
async def test_every_reference_image_claims_its_own_operation(wired):
    ledger, relay = wired

    urls = await _relay([b"first-reference", b"second-reference", b"third-reference"])

    assert len(urls) == 3
    assert len(relay.object_keys) == 3
    assert len({spec.operation_key for spec in ledger.claims}) == 3


@pytest.mark.asyncio
async def test_repeating_one_image_in_a_request_still_claims_separate_operations(
    wired,
):
    """Guards the tempting wrong fix of keying on the image bytes alone."""
    ledger, _ = wired

    urls = await _relay([b"same-reference", b"same-reference"])

    assert len(urls) == 2
    assert len({spec.operation_key for spec in ledger.claims}) == 2


@pytest.mark.asyncio
async def test_the_envelope_stays_readable_in_the_business_task_id(wired):
    """Operators find a task's rows by envelope prefix; keep that greppable."""
    ledger, _ = wired

    await _relay([b"first-reference", b"second-reference"])

    assert all(
        spec.business_task_id.startswith("envelope-multi-ref")
        for spec in ledger.claims
    )


@pytest.mark.asyncio
async def test_relaying_the_same_object_twice_is_a_replay_not_a_conflict(wired):
    """A retry must recompute the identical key, or idempotency buys nothing."""
    from novelvideo.storage import media_relay

    ledger, _ = wired
    context = _org_context()

    async def once():
        return await media_relay.relay_tenant_image_bytes_from_context(
            b"stable-bytes",
            object_id="stable-object-id",
            context=context,
        )

    await once()
    with pytest.raises(media_relay.ServiceOperationNotReplayable):
        await once()

    assert len({spec.operation_key for spec in ledger.claims}) == 1


def test_operation_key_still_ignores_the_request_digest():
    """Pins the rejected alternative fix.

    Folding the digest into the key would let a nondeterministic retry open a
    second operation instead of surfacing a mismatch, trading a loud error for
    duplicate egress. The discriminator belongs in business_task_id.
    """

    def spec(digest: str) -> OperationSpec:
        return OperationSpec(
            organization_id="org",
            project_id="project",
            root_task_id="root",
            business_task_id="business",
            capability="storage.media.relay",
            credential_id="credential",
            credential_version=1,
            request_digest=digest,
        )

    assert spec("a" * 64).operation_key == spec("b" * 64).operation_key
