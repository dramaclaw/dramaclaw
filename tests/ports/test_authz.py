from dataclasses import FrozenInstanceError
from inspect import signature

import pytest


def _snapshot(**overrides):
    from novelvideo.ports.authz import AuthzSnapshot

    values = {
        "requester_user_id": "user_1",
        "org_id": "org_1",
        "membership_id": "mem_1",
        "role": "org_member",
        "membership_status": "active",
        "org_status": "active",
        "authz_version": 7,
    }
    values.update(overrides)
    return AuthzSnapshot(**values)


def test_authz_snapshot_is_frozen_and_accepts_active_membership():
    snapshot = _snapshot()

    snapshot.require_active(expected_authz_version=7)
    with pytest.raises(FrozenInstanceError):
        snapshot.authz_version = 8


@pytest.mark.parametrize(
    ("overrides", "code"),
    [
        ({"membership_status": "suspended"}, "ORG_MEMBERSHIP_INACTIVE"),
        ({"membership_status": "inactive"}, "ORG_MEMBERSHIP_INACTIVE"),
        ({"org_status": "suspended"}, "ORG_MEMBERSHIP_INACTIVE"),
    ],
)
def test_authz_snapshot_rejects_inactive_or_suspended_access(overrides, code):
    from novelvideo.ports.authz import AuthzError

    with pytest.raises(AuthzError) as exc:
        _snapshot(**overrides).require_active()

    assert exc.value.code == code
    assert "user_1" not in repr(exc.value)
    assert "org_1" not in repr(exc.value)


def test_authz_snapshot_rejects_stale_version():
    from novelvideo.ports.authz import AuthzError

    with pytest.raises(AuthzError) as exc:
        _snapshot().require_active(expected_authz_version=8)

    assert exc.value.code == "ORG_AUTHZ_STALE"


@pytest.mark.parametrize(
    ("exception_name", "failure_kind"),
    [
        ("AuthzServiceUnavailable", "unavailable"),
        ("AuthzServiceFault", "fault"),
    ],
)
def test_authz_service_failures_have_safe_fixed_public_contract(
    exception_name, failure_kind
):
    from novelvideo.ports import authz

    exception_type = getattr(authz, exception_name)
    exc = exception_type()

    assert isinstance(exc, authz.AuthzError)
    assert exc.code == "ORG_AUTHZ_UNAVAILABLE"
    assert exc.failure_kind == failure_kind
    assert exc.http_status == 503
    assert exc.user_message == "授权服务暂时不可用，请稍后重试"
    assert str(exc) == "organization authorization service is unavailable"
    assert "postgres" not in repr(exc).lower()


def test_authz_service_fault_is_a_specialized_unavailable_failure() -> None:
    from novelvideo.ports.authz import AuthzServiceFault, AuthzServiceUnavailable

    assert issubclass(AuthzServiceFault, AuthzServiceUnavailable)


def test_authz_error_base_constructor_remains_code_only() -> None:
    from novelvideo.ports.authz import AuthzError

    assert tuple(signature(AuthzError).parameters) == ("code",)


@pytest.mark.parametrize("authz_version", [True, False, 0, -1, "1", 1.0])
def test_authz_snapshot_requires_strict_positive_integer_version(authz_version):
    with pytest.raises(ValueError, match="authz_version"):
        _snapshot(authz_version=authz_version)


def test_authz_snapshot_allows_opaque_large_version_and_compares_for_staleness():
    from novelvideo.ports.authz import AuthzError

    snapshot = _snapshot(authz_version=999)
    snapshot.require_active(expected_authz_version=999)

    with pytest.raises(AuthzError) as exc:
        snapshot.require_active(expected_authz_version=1000)

    assert exc.value.code == "ORG_AUTHZ_STALE"


@pytest.mark.asyncio
async def test_local_authz_snapshot_check_fails_closed():
    from novelvideo.ports.authz import AuthzError
    from novelvideo.ports.local import LocalAuthz

    snapshot = _snapshot()
    with pytest.raises(AuthzError) as exc:
        await LocalAuthz().check(snapshot=snapshot)

    assert exc.value.code == "ORG_CONTEXT_REQUIRED"


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("requester_user_id", ""),
        ("org_id", ""),
        ("membership_id", ""),
        ("role", ""),
        ("authz_version", 0),
    ],
)
def test_authz_snapshot_requires_complete_identity(field, value):
    with pytest.raises(ValueError, match=field):
        _snapshot(**{field: value})


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
            authz_version=1,
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


@pytest.mark.parametrize("authz_version", [True, False, 0, -1, "1", 1.0])
def test_organization_admission_requires_strict_positive_integer_version(authz_version):
    from novelvideo.ports.authz import AdmissionContext, BillingPrincipal
    from novelvideo.ports.model_credentials import CredentialReference

    with pytest.raises(ValueError, match="authz_version"):
        AdmissionContext(
            requester_user_id="user_1",
            billing_principal=BillingPrincipal(kind="organization", id="org_1"),
            credential=CredentialReference("organization", "cred_1", 2, "org_1"),
            admission_id="adm_1",
            root_task_id="task_1",
            admitted_at="2026-07-28T00:00:00Z",
            membership_id="mem_1",
            authz_version=authz_version,
        )


def test_organization_admission_allows_opaque_large_authz_version():
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
        authz_version=999,
    )

    assert context.authz_version == 999


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
