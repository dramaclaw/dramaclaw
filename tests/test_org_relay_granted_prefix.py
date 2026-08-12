"""The organization relay must write where its credential is actually allowed.

The relay credential is scoped to the `relay/` prefix of the relay bucket. The
organization path was written to `tenants/{org}/projects/{proj}/objects/...`,
outside that grant, and nothing in either repository ever declared `tenants/*`
as a required permission — so the write was refused in every environment that
provisions the credential as documented. Measured against the deployed bucket:
a HEAD under `relay/` answers 404 NoSuchKey, the same HEAD under `tenants/`
answers 403 AccessDenied.

The fix keeps the key shape and moves it inside the grant. These tests pin the
three properties that matter rather than the literal key, so a future rename
that keeps them stays green and a future move back outside the grant does not.
"""

from __future__ import annotations

import hashlib

import pytest

from novelvideo.egress_context import TrustedEgressContext
from novelvideo.ports.authz import BillingPrincipal
from novelvideo.ports.model_credentials import CredentialReference

# What the deployed credential is allowed to write. `AliyunOSSRelay.upload_bytes`
# uses the same prefix for its own generated keys, so this is the one grant the
# relay needs, not two.
GRANTED_PREFIX = "relay/"

ORG_ID = "org-prefix-canary"
PROJECT_ID = "project-prefix-canary"
OBJECT_ID = "object-id-never-persist"


def _org_context() -> TrustedEgressContext:
    return TrustedEgressContext(
        envelope_id="envelope-prefix",
        project_id=PROJECT_ID,
        task_type="image.edit",
        requester_user_id="user-prefix",
        root_task_id="root-prefix",
        admission_id="admission-prefix",
        admitted_at="2026-08-12T02:30:00Z",
        membership_id="membership-prefix",
        authz_version=4,
        billing_principal=BillingPrincipal(kind="organization", id=ORG_ID),
        credential=CredentialReference(
            source="organization",
            credential_id="credential-prefix",
            key_version=9,
            org_id=ORG_ID,
        ),
    )


class _RecordingRelay:
    """Captures the object key instead of reaching object storage."""

    def __init__(self) -> None:
        self.object_keys: list[str] = []

    def upload_bytes(self, data, *, ext, ttl, object_key):
        self.object_keys.append(object_key)
        return "https://relay.example/signed-url"


class _PassingOperations:
    """The claim ledger reduced to what the relay call needs to get through."""

    async def claim(self, *, spec):
        from novelvideo.ports.egress_operations import (
            OperationClaimResult,
            OperationSnapshot,
            OperationState,
        )

        return OperationClaimResult(
            won=True,
            operation=OperationSnapshot(
                operation_id="op-prefix",
                operation_key=spec.operation_key,
                state=OperationState.DISPATCHING,
                version=1,
            ),
            transition_token="transition-prefix",
        )

    async def _advance(self, kwargs, state):
        from novelvideo.ports.egress_operations import OperationSnapshot

        return OperationSnapshot(
            operation_id=kwargs["operation_id"],
            operation_key="operation-key",
            state=state,
            version=kwargs["expected_version"] + 1,
        )

    async def mark_accepted(self, **kwargs):
        from novelvideo.ports.egress_operations import OperationState

        return await self._advance(kwargs, OperationState.ACCEPTED)

    async def mark_completed(self, **kwargs):
        from novelvideo.ports.egress_operations import OperationState

        return await self._advance(kwargs, OperationState.COMPLETED)

    async def mark_unknown(self, **kwargs):
        from novelvideo.ports.egress_operations import OperationState

        return await self._advance(kwargs, OperationState.UNKNOWN)


async def _relay_once(object_id: str = OBJECT_ID) -> str:
    from novelvideo.storage.media_relay import (
        StorageRelayIdentity,
        relay_tenant_image_bytes,
    )

    recorder = _RecordingRelay()
    await relay_tenant_image_bytes(
        b"image-bytes",
        ext="png",
        ttl=60,
        object_id=object_id,
        context=_org_context(),
        identity=StorageRelayIdentity(
            credential_id="svc-media-relay",
            credential_version=3,
            organization_id=ORG_ID,
            project_id=PROJECT_ID,
        ),
        operations=_PassingOperations(),
        relay=recorder,
    )
    assert len(recorder.object_keys) == 1
    return recorder.object_keys[0]


@pytest.mark.asyncio
async def test_organization_object_key_stays_inside_the_granted_prefix():
    object_key = await _relay_once()

    assert object_key.startswith(GRANTED_PREFIX), (
        f"organization relay writes to {object_key!r}, outside the "
        f"{GRANTED_PREFIX!r} grant — object storage refuses this with 403"
    )


@pytest.mark.asyncio
async def test_organization_object_key_still_separates_tenants_and_projects():
    object_key = await _relay_once()

    # Moving inside the grant must not flatten one organization's objects into
    # another's, which is the reason the key carried these segments at all.
    assert f"/{ORG_ID}/" in object_key
    assert f"/{PROJECT_ID}/" in object_key


@pytest.mark.asyncio
async def test_organization_object_key_stays_content_addressed_and_secret_free():
    object_key = await _relay_once()

    # The claim ledger relies on a retry recomputing the same key, so the name
    # has to come from the object's digest — and only the digest, since the
    # object id itself is not safe to persist in a bucket listing.
    assert hashlib.sha256(OBJECT_ID.encode("utf-8")).hexdigest() in object_key
    assert OBJECT_ID not in object_key
    assert await _relay_once() == object_key
