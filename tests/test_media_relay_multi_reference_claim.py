"""Each relayed object must claim its own durable egress operation.

The ledger keys an operation by {org, project, root_task, business_task,
capability} and deliberately leaves request_digest out, so that the same key
arriving with a different payload is reported as a conflict rather than
silently becoming a second operation. That is the same contract Stripe states
for idempotency keys, and it means the caller owes the ledger one key per side
effect. Relaying N reference images under a single key breaks that side of the
bargain, and the ledger correctly refuses the second image.

The double this uses models the claim verdict an EgressOperationPort
implementation is required to return, rather than a fixed verdict, because a
stateless double cannot express the very behaviour under test. It lives in
tests/support/egress_ledger.py because the same contract is under test from a
second direction in tests/test_p0g4e_cognee_concurrent_egress.py.
"""

from __future__ import annotations

import pytest
from support.egress_ledger import LedgerDouble

from novelvideo.egress_context import TrustedEgressContext
from novelvideo.ports.authz import BillingPrincipal
from novelvideo.ports.egress_operations import OperationSpec
from novelvideo.ports.model_credentials import CredentialReference


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
