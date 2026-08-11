"""OI-43: organization authorization denials must render as the contracted 4xx.

Before this contract existed, every ``AuthzError`` escaped ``create_app()``
unhandled, so Starlette's ``ServerErrorMiddleware`` answered with a 21-byte
``text/plain`` ``Internal Server Error``. The product frontend could not read a
stable code out of that, so "organization has no gateway key bound" was
indistinguishable from any other 500.

The status codes below are the frozen contract in
``docs/b2b-org-tenant/frontend-spec.md`` §12 (EE repo). ``MODEL_ACCESS_DENIED``
and ``P0_GRAY_DISABLED`` are absent from that table; they are pinned here as the
access-decision and deployment-fail-closed members of the same taxonomy.
"""

from __future__ import annotations

import logging

import pytest
from fastapi.testclient import TestClient

from novelvideo.api.routes import freezone as freezone_routes
from novelvideo.ports.authz import (
    AUTHZ_ERROR_HTTP_STATUS,
    AuthzError,
    authz_error_payload,
    authz_error_user_message,
)

# Mirrors novelvideo_ee/authz/admission_repository.py::_REJECTION_CODES plus the
# two codes raised outside the admission definer (config.py's gray switch and
# the credential port's decrypt failure). EE is not importable from CE tests, so
# this set is restated rather than imported.
CONTRACTED_STATUS = {
    "ORG_CONTEXT_REQUIRED": 403,
    "ORG_MEMBERSHIP_INACTIVE": 403,
    "MODEL_ACCESS_DENIED": 403,
    "ORG_AUTHZ_STALE": 409,
    "ORG_CREDENTIAL_MISSING": 409,
    "ORG_CREDENTIAL_DISABLED": 409,
    "ORG_CREDENTIAL_VERSION_MISMATCH": 409,
    "ORG_CREDENTIAL_DECRYPT_FAILED": 503,
    "P0_GRAY_DISABLED": 503,
}


def test_status_table_matches_the_frozen_error_contract() -> None:
    """Whole-table equality: a new code must not land without a decided status."""
    assert AUTHZ_ERROR_HTTP_STATUS == CONTRACTED_STATUS


@pytest.mark.parametrize("code", sorted(CONTRACTED_STATUS))
def test_every_code_carries_its_own_message(code: str) -> None:
    """No code may degrade into the generic "organization authorization failed"."""
    generic = str(AuthzError("__UNKNOWN__"))

    assert str(AuthzError(code)) != generic
    assert authz_error_user_message(code) != authz_error_user_message("__UNKNOWN__")


@pytest.mark.parametrize(("code", "status"), sorted(CONTRACTED_STATUS.items()))
def test_http_handler_renders_every_authz_code(code: str, status: int) -> None:
    from novelvideo.api.app import create_app

    app = create_app()

    @app.get(f"/__authz-error/{code}")
    async def authz_error() -> None:
        raise AuthzError(code)

    response = TestClient(app, raise_server_exceptions=False).get(
        f"/__authz-error/{code}"
    )

    assert response.status_code == status
    assert response.headers["content-type"].startswith("application/json")
    assert response.json() == {
        "ok": False,
        "error": authz_error_user_message(code),
        "data": {"error_code": code, "message": authz_error_user_message(code)},
    }


def test_http_handler_fails_closed_on_an_unknown_code() -> None:
    from novelvideo.api.app import create_app

    app = create_app()

    @app.get("/__authz-error-unknown")
    async def authz_error() -> None:
        raise AuthzError("SOME_FUTURE_CODE")

    response = TestClient(app, raise_server_exceptions=False).get(
        "/__authz-error-unknown"
    )

    assert response.status_code == 403
    assert response.json()["data"]["error_code"] == "SOME_FUTURE_CODE"


def test_http_handler_logs_the_denial_with_its_code(caplog) -> None:
    """The 2026-08-11 triage cost hours because this path logged nothing."""
    from novelvideo.api.app import create_app

    app = create_app()

    @app.get("/__authz-error-logged")
    async def authz_error() -> None:
        raise AuthzError("ORG_CREDENTIAL_MISSING")

    with caplog.at_level(logging.WARNING, logger="novelvideo.api.app"):
        TestClient(app, raise_server_exceptions=False).get("/__authz-error-logged")

    messages = [
        record.getMessage()
        for record in caplog.records
        if record.levelno == logging.WARNING
    ]
    assert any("ORG_CREDENTIAL_MISSING" in message for message in messages)
    assert all("Internal Server Error" not in message for message in messages)


def test_authz_error_payload_carries_no_identity() -> None:
    payload = authz_error_payload(AuthzError("ORG_MEMBERSHIP_INACTIVE"))

    assert payload == {
        "error_code": "ORG_MEMBERSHIP_INACTIVE",
        "message": authz_error_user_message("ORG_MEMBERSHIP_INACTIVE"),
    }


def test_task_start_runtime_error_reraises_authz_error() -> None:
    """Sibling task-start routes must not swallow the denial into a bare 503.

    ``_handle_task_start_runtime_error`` already re-raises the typed billing
    family so the app-level handler can render it; ``AuthzError`` is a
    ``RuntimeError`` subclass and was falling through to ``logger.warning``,
    after which callers raise 503 with no machine code.
    """
    denial = AuthzError("ORG_CREDENTIAL_MISSING")
    wrapper = RuntimeError("failed to start task")
    wrapper.__cause__ = denial

    with pytest.raises(AuthzError) as caught:
        freezone_routes._handle_task_start_runtime_error("start failed", wrapper)

    assert caught.value is denial
