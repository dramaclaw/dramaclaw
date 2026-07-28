from dataclasses import FrozenInstanceError

import pytest


def test_admission_context_is_frozen():
    from novelvideo.ports.authz import AdmissionContext, BillingPrincipal
    from novelvideo.ports.model_credentials import CredentialReference

    context = AdmissionContext(
        requester_user_id="user_1",
        billing_principal=BillingPrincipal(kind="organization", id="org_1"),
        credential=CredentialReference("organization", "cred_1", 2, "org_1"),
        admission_id="adm_1",
        root_task_id="task_1",
        admitted_at="2026-07-28T00:00:00Z",
        membership_id="mem_1",
        authz_version=7,
    )

    with pytest.raises(FrozenInstanceError):
        context.authz_version = 8


def test_organization_admission_requires_membership_and_org_credential():
    from novelvideo.ports.authz import AdmissionContext, BillingPrincipal
    from novelvideo.ports.model_credentials import CredentialReference

    with pytest.raises(ValueError, match="membership_id"):
        AdmissionContext(
            requester_user_id="user_1",
            billing_principal=BillingPrincipal(kind="organization", id="org_1"),
            credential=CredentialReference("platform", "platform", 1, None),
            admission_id="adm_1",
            root_task_id="task_1",
            admitted_at="2026-07-28T00:00:00Z",
        )


@pytest.mark.parametrize(
    ("membership_id", "authz_version", "message"),
    [
        (None, 1, "membership_id"),
        ("mem_1", 0, "authz_version"),
    ],
)
def test_organization_admission_requires_complete_authz_snapshot(
    membership_id, authz_version, message
):
    from novelvideo.ports.authz import AdmissionContext, BillingPrincipal
    from novelvideo.ports.model_credentials import CredentialReference

    with pytest.raises(ValueError, match=message):
        AdmissionContext(
            requester_user_id="user_1",
            billing_principal=BillingPrincipal(kind="organization", id="org_1"),
            credential=CredentialReference("organization", "cred_1", 2, "org_1"),
            admission_id="adm_1",
            root_task_id="task_1",
            admitted_at="2026-07-28T00:00:00Z",
            membership_id=membership_id,
            authz_version=authz_version,
        )


def test_organization_admission_rejects_cross_org_credential():
    from novelvideo.ports.authz import AdmissionContext, BillingPrincipal
    from novelvideo.ports.model_credentials import CredentialReference

    with pytest.raises(ValueError, match="org mismatch"):
        AdmissionContext(
            requester_user_id="user_1",
            billing_principal=BillingPrincipal(kind="organization", id="org_1"),
            credential=CredentialReference("organization", "cred_1", 2, "org_2"),
            admission_id="adm_1",
            root_task_id="task_1",
            admitted_at="2026-07-28T00:00:00Z",
            membership_id="mem_1",
            authz_version=1,
        )
