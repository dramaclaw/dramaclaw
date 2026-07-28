from dataclasses import FrozenInstanceError

import pytest


def _organization_admission():
    from novelvideo.ports.authz import AdmissionContext, BillingPrincipal
    from novelvideo.ports.model_credentials import CredentialReference

    return AdmissionContext(
        requester_user_id="user_1",
        billing_principal=BillingPrincipal(kind="organization", id="org_1"),
        credential=CredentialReference("organization", "cred_1", 1, "org_1"),
        admission_id="adm_1",
        root_task_id="task_1",
        admitted_at="2026-07-28T00:00:00Z",
        membership_id="mem_1",
        authz_version=1,
    )


def test_egress_operation_spec_is_frozen_and_validates_stable_identity():
    from novelvideo.ports.egress import EgressOperationSpec

    spec = EgressOperationSpec(
        operation_id="op_1",
        workflow_version="v1",
        stable_step_path="episode/1/beat/2/image",
        logical_sequence=1,
        input_digest="sha256:abc",
    )
    with pytest.raises(FrozenInstanceError):
        spec.logical_sequence = 2

    with pytest.raises(ValueError, match="stable_step_path"):
        EgressOperationSpec("op_2", "v1", "", 1, "sha256:abc")


def test_egress_result_reference_contains_no_credentials():
    from novelvideo.ports.egress import EgressResultReference

    assert "api_key" not in EgressResultReference.__dataclass_fields__


def test_egress_port_exposes_claim_and_consume_contracts():
    from novelvideo.ports.egress import EgressPort

    assert callable(getattr(EgressPort, "claim"))
    assert callable(getattr(EgressPort, "consume"))


@pytest.mark.asyncio
async def test_local_egress_rejects_organization_claim_without_control_plane():
    from novelvideo.ports.egress import EgressError, EgressOperationSpec
    from novelvideo.ports.local import LocalEgress

    with pytest.raises(EgressError) as exc:
        await LocalEgress().claim(
            admission=_organization_admission(),
            spec=EgressOperationSpec(
                operation_id="op_1",
                workflow_version="v1",
                stable_step_path="episode/1/beat/2/image",
                logical_sequence=1,
                input_digest="sha256:abc",
            ),
        )

    assert exc.value.code == "ORG_CONTEXT_REQUIRED"
    assert "cred_1" not in repr(exc.value)


@pytest.mark.asyncio
async def test_local_egress_rejects_organization_result_consumption():
    from novelvideo.ports.egress import EgressError, EgressResultReference
    from novelvideo.ports.local import LocalEgress

    with pytest.raises(EgressError) as exc:
        await LocalEgress().consume(
            admission=_organization_admission(),
            result=EgressResultReference(operation_id="op_1", result_ref="result_1"),
        )

    assert exc.value.code == "ORG_CONTEXT_REQUIRED"
