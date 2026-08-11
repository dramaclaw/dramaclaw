"""OI-45: an organization relay failure must say which failure it was.

The organization branch of `_call_newapi_image_api` collapses every relay
failure into one sentence and logs nothing, so `media relay upload failed`
covers at least three unrelated causes: a denied egress boundary, an operation
claim that was already taken, and an upstream storage call that failed. They
need different fixes — a missing port registration, a retry, an object-storage
policy — and today nobody downstream can tell which one happened.

The suppression itself stays. These three exception types are secret-free by
construction (no-arg constructors, `raise ... from None`), so naming *which*
one fired leaks nothing; anything else stays opaque because an arbitrary
exception may carry a signed URL or a key.
"""

from __future__ import annotations

import logging

import pytest

from novelvideo.egress_context import TrustedEgressContext
from novelvideo.ports.authz import BillingPrincipal
from novelvideo.ports.model_credentials import CredentialReference

CANARY = "secret-key-and-signed-url-canary"


def _org_context() -> TrustedEgressContext:
    return TrustedEgressContext(
        envelope_id="envelope-oi45",
        project_id="project-oi45",
        task_type="image.edit",
        requester_user_id="user-oi45",
        root_task_id="root-oi45",
        admission_id="admission-oi45",
        admitted_at="2026-08-11T04:05:00Z",
        membership_id="membership-oi45",
        authz_version=4,
        billing_principal=BillingPrincipal(kind="organization", id="org-oi45"),
        credential=CredentialReference(
            source="organization",
            credential_id="credential-oi45",
            key_version=9,
            org_id="org-oi45",
        ),
    )


async def _call_with_relay_failure(monkeypatch, exc: BaseException) -> str:
    """Run the organization relay branch with `exc` raised by the relay."""

    from novelvideo.generators import nanobanana_grid

    async def _boom(*_args, **_kwargs):
        raise exc

    monkeypatch.setattr(nanobanana_grid, "_relay_reference_images_for_newapi", _boom)
    _, _, error = await nanobanana_grid._call_newapi_image_api(
        api_key=CANARY,
        model="image-model",
        prompt="reference edit",
        reference_images=[b"reference-bytes"],
        base_url=f"https://{CANARY}.invalid/v1",
        egress_context=_org_context(),
    )
    return error


def test_the_three_relay_failures_carry_distinct_stable_codes():
    from novelvideo.storage.media_relay import (
        ServiceEgressDenied,
        ServiceInvocationFailed,
        ServiceOperationNotReplayable,
    )

    codes = [
        ServiceEgressDenied.code,
        ServiceOperationNotReplayable.code,
        ServiceInvocationFailed.code,
    ]
    assert len(set(codes)) == 3
    assert all(code == code.upper() and code.startswith("ORG_SERVICE_") for code in codes)


def test_egress_denial_names_the_boundary_that_refused():
    """`ServiceEgressDenied` has five raise sites needing five different fixes."""

    from novelvideo.storage.media_relay import ServiceEgressDenied

    denial = ServiceEgressDenied("operation-port")
    assert denial.reason == "operation-port"
    # The reason is a fixed slug, never interpolated request data.
    assert ServiceEgressDenied().reason is None


@pytest.mark.asyncio
async def test_missing_operation_port_is_reported_as_a_port_denial(monkeypatch):
    from novelvideo import ports
    from novelvideo.ports.registry import PortNotRegistered
    from novelvideo.storage import media_relay

    monkeypatch.setattr(
        ports,
        "get_egress_operation_port",
        lambda: (_ for _ in ()).throw(PortNotRegistered("egress_operations")),
    )

    with pytest.raises(media_relay.ServiceEgressDenied) as exc_info:
        await media_relay.relay_tenant_image_bytes_from_context(
            b"image", object_id="object-oi45", context=_org_context()
        )

    assert exc_info.value.reason == "operation-port"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("factory", "expected_code"),
    [
        (lambda m: m.ServiceEgressDenied(), "ORG_SERVICE_EGRESS_DENIED"),
        (
            lambda m: m.ServiceOperationNotReplayable("service operation already claimed"),
            "ORG_SERVICE_OPERATION_NOT_REPLAYABLE",
        ),
        (lambda m: m.ServiceInvocationFailed(), "ORG_SERVICE_INVOCATION_FAILED"),
    ],
)
async def test_organization_relay_error_names_which_failure_it_was(
    monkeypatch, factory, expected_code
):
    from novelvideo.storage import media_relay

    error = await _call_with_relay_failure(monkeypatch, factory(media_relay))

    assert "media relay upload failed" in error
    assert expected_code in error
    assert CANARY not in error


@pytest.mark.asyncio
async def test_unknown_relay_exception_stays_opaque_on_the_organization_path(monkeypatch):
    """An arbitrary exception may carry a signed URL or a key — keep hiding it."""

    error = await _call_with_relay_failure(
        monkeypatch, RuntimeError(f"upload to https://bucket.invalid/x?sig={CANARY}")
    )

    assert error == "media relay upload failed"
    assert CANARY not in error


@pytest.mark.asyncio
async def test_organization_relay_failure_is_logged_without_secrets(monkeypatch, caplog):
    from novelvideo.storage import media_relay

    with caplog.at_level(logging.WARNING, logger="novelvideo.generators.nanobanana_grid"):
        await _call_with_relay_failure(monkeypatch, media_relay.ServiceInvocationFailed())

    assert "ORG_SERVICE_INVOCATION_FAILED" in caplog.text
    assert CANARY not in caplog.text
