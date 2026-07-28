from dataclasses import FrozenInstanceError

import pytest


def test_request_credential_is_frozen_and_never_reprs_secret():
    from novelvideo.ports.model_credentials import CredentialReference, RequestCredential

    reference = CredentialReference(
        source="organization",
        credential_id="cred_1",
        key_version=3,
        org_id="org_1",
    )
    credential = RequestCredential(
        reference=reference,
        api_key="dc-secret-value",
        base_url="https://gateway.example/v1",
    )

    assert "dc-secret-value" not in repr(credential)
    assert credential.reference == reference
    with pytest.raises(FrozenInstanceError):
        credential.api_key = "changed"


def test_credential_reference_cannot_contain_secret():
    from novelvideo.ports.model_credentials import CredentialReference

    assert "api_key" not in CredentialReference.__dataclass_fields__


def test_credential_error_uses_stable_secret_free_message():
    from novelvideo.ports.model_credentials import ModelCredentialError

    error = ModelCredentialError("ORG_CREDENTIAL_VERSION_MISMATCH", "secret-value")

    assert error.code == "ORG_CREDENTIAL_VERSION_MISMATCH"
    assert str(error) == "organization credential version mismatch"
    assert "secret-value" not in repr(error)


@pytest.mark.parametrize(
    ("source", "org_id", "key_version", "message"),
    [
        ("organization", None, 1, "org_id"),
        ("organization", "org_1", 0, "key_version"),
    ],
)
def test_organization_credential_reference_requires_complete_identity(
    source, org_id, key_version, message
):
    from novelvideo.ports.model_credentials import CredentialReference

    with pytest.raises(ValueError, match=message):
        CredentialReference(source, "cred_1", key_version, org_id)


@pytest.mark.parametrize("key_version", [True, False, 0, -1, "1", 1.0])
def test_credential_reference_requires_strict_positive_integer_version(key_version):
    from novelvideo.ports.model_credentials import CredentialReference

    with pytest.raises(ValueError, match="key_version"):
        CredentialReference("organization", "cred_1", key_version, "org_1")


@pytest.mark.asyncio
async def test_local_adapter_preserves_existing_gateway_resolution(monkeypatch):
    from novelvideo.ports.authz import AdmissionContext, BillingPrincipal
    from novelvideo.ports.local import LocalModelCredentials
    from novelvideo.ports.model_credentials import CredentialReference
    import novelvideo.config as config

    monkeypatch.setattr(
        config,
        "get_newapi_runtime_credentials",
        lambda: ("existing-key", "https://gateway.example/v1"),
    )
    admission = AdmissionContext(
        requester_user_id="local",
        billing_principal=BillingPrincipal(kind="local", id="local"),
        credential=CredentialReference("local", "local-newapi", 1),
        admission_id="adm_1",
        root_task_id="task_1",
        admitted_at="2026-07-28T00:00:00Z",
        authz_version=1,
    )

    resolved = await LocalModelCredentials().resolve(admission)

    assert resolved.api_key == "existing-key"
    assert resolved.base_url == "https://gateway.example/v1"


@pytest.mark.asyncio
async def test_local_adapter_does_not_fallback_for_organization_admission(monkeypatch):
    from novelvideo.ports.authz import AdmissionContext, BillingPrincipal
    from novelvideo.ports.local import LocalModelCredentials
    from novelvideo.ports.model_credentials import (
        CredentialReference,
        ModelCredentialError,
    )
    import novelvideo.config as config

    monkeypatch.setattr(
        config,
        "get_newapi_runtime_credentials",
        lambda: pytest.fail("organization resolution must not read global gateway credentials"),
    )

    admission = AdmissionContext(
        requester_user_id="user_1",
        billing_principal=BillingPrincipal(kind="organization", id="org_1"),
        credential=CredentialReference("organization", "cred_1", 1, "org_1"),
        admission_id="adm_1",
        root_task_id="task_1",
        admitted_at="2026-07-28T00:00:00Z",
        membership_id="mem_1",
        authz_version=1,
    )

    with pytest.raises(ModelCredentialError) as exc:
        await LocalModelCredentials().resolve(admission)

    assert exc.value.code == "ORG_CREDENTIAL_MISSING"
    assert "cred_1" not in repr(exc.value)
