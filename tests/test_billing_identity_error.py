import pytest
from fastapi.testclient import TestClient

from novelvideo.api.app import create_app
from novelvideo.shared.billing_errors import (
    FEATURE_BILLING_IDENTITY_INVALID_CODE,
    FEATURE_BILLING_IDENTITY_INVALID_MESSAGE,
    FEATURE_BILLING_IDENTITY_REASON_MAX_LENGTH,
    BillingError,
    FeatureBillingIdentityError,
    billing_error_payload,
)


def test_feature_billing_identity_error_contract() -> None:
    error = FeatureBillingIdentityError(internal_reason="missing billing principal")

    assert isinstance(error, BillingError)
    assert error.error_code == FEATURE_BILLING_IDENTITY_INVALID_CODE
    assert error.error_code == "FEATURE_BILLING_IDENTITY_INVALID"
    assert error.http_status == 409
    assert error.user_message == FEATURE_BILLING_IDENTITY_INVALID_MESSAGE
    assert error.user_message == "计费身份无效或无法确定，请联系管理员"


def test_feature_billing_identity_payload_redacts_internal_reason() -> None:
    error = FeatureBillingIdentityError(internal_reason="ambiguous principal")

    assert "ambiguous principal" in str(error)
    assert billing_error_payload(error) == {
        "error_code": FEATURE_BILLING_IDENTITY_INVALID_CODE,
        "message": FEATURE_BILLING_IDENTITY_INVALID_MESSAGE,
    }


def test_feature_billing_identity_error_survives_hostile_reason_rendering() -> None:
    class HostileReason:
        def __str__(self) -> str:
            raise RuntimeError("hostile __str__")

        def __repr__(self) -> str:
            raise RuntimeError("hostile __repr__")

    error = FeatureBillingIdentityError(internal_reason=HostileReason())  # type: ignore[arg-type]

    assert isinstance(error, FeatureBillingIdentityError)
    assert str(error) == "feature billing identity is invalid"


def test_feature_billing_identity_error_truncates_long_reason() -> None:
    error = FeatureBillingIdentityError(internal_reason="x" * 10_000)

    rendered = str(error)
    assert len(rendered) == FEATURE_BILLING_IDENTITY_REASON_MAX_LENGTH
    assert rendered.endswith("...")


def test_feature_billing_identity_error_rejects_identity_context_kwargs() -> None:
    with pytest.raises(TypeError):
        FeatureBillingIdentityError(
            internal_reason="principal mismatch",
            user_id="user-secret",  # type: ignore[call-arg]
            org_id="org-secret",
        )


def test_feature_billing_identity_error_uses_generic_http_handler() -> None:
    app = create_app()

    @app.get("/__feature-billing-identity-error")
    async def raise_feature_billing_identity_error() -> None:
        raise FeatureBillingIdentityError(
            internal_reason="principal mismatch",
        )

    response = TestClient(app, raise_server_exceptions=False).get(
        "/__feature-billing-identity-error"
    )

    assert response.status_code == 409
    assert response.json() == {
        "ok": False,
        "error": FEATURE_BILLING_IDENTITY_INVALID_MESSAGE,
        "data": {
            "error_code": FEATURE_BILLING_IDENTITY_INVALID_CODE,
            "message": FEATURE_BILLING_IDENTITY_INVALID_MESSAGE,
        },
    }
