"""P0G-4T service-operation exclusion contract tests."""

from __future__ import annotations

from collections.abc import Callable

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from novelvideo.api.routes import model_gateway
from novelvideo import newapi_provisioner
from novelvideo.ports import registry
from novelvideo.service_operation_gate import (
    SERVICE_OPERATION_DENIED,
    ServiceOperationExcluded,
    require_legacy_local_service_operation,
)


@pytest.mark.parametrize(
    ("edition", "dsn", "allowed"),
    [
        ("ce", "", True),
        ("ee", "postgresql://organization-dsn-canary", False),
        ("ce", "postgresql://contradictory-dsn-canary", False),
        ("", "", False),
    ],
)
def test_service_operation_gate_allows_only_effective_ce_local(
    monkeypatch: pytest.MonkeyPatch,
    edition: str,
    dsn: str,
    allowed: bool,
) -> None:
    monkeypatch.setenv("ST_EDITION", edition)
    if dsn:
        monkeypatch.setenv("ST_CONTROL_PLANE_DSN", dsn)
    else:
        monkeypatch.delenv("ST_CONTROL_PLANE_DSN", raising=False)

    if allowed:
        assert require_legacy_local_service_operation() is None
        return

    with pytest.raises(ServiceOperationExcluded) as caught:
        require_legacy_local_service_operation()

    rendered = f"{caught.value!s} {caught.value!r}"
    assert SERVICE_OPERATION_DENIED in rendered
    assert dsn not in rendered or not dsn


def test_service_operation_gate_error_contains_only_stable_code(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    secret_canaries = {
        "MODEL_API_KEY": "model-secret-canary",
        "NEWAPI_API_KEY": "newapi-secret-canary",
    }
    monkeypatch.setenv("ST_EDITION", "organization-edition-canary")
    monkeypatch.setenv("ST_CONTROL_PLANE_DSN", "postgresql://dsn-secret-canary")
    for name, value in secret_canaries.items():
        monkeypatch.setenv(name, value)

    with pytest.raises(ServiceOperationExcluded) as caught:
        require_legacy_local_service_operation()

    assert str(caught.value) == SERVICE_OPERATION_DENIED
    assert (
        repr(caught.value) == f"ServiceOperationExcluded('{SERVICE_OPERATION_DENIED}')"
    )
    rendered = f"{caught.value!s} {caught.value!r}"
    for canary in (
        "organization-edition-canary",
        "postgresql://dsn-secret-canary",
        *secret_canaries.values(),
    ):
        assert canary not in rendered


PROFILE_CASES = (
    ("ee", "postgresql://organization-profile-dsn-canary"),
    ("ce", "postgresql://contradictory-profile-dsn-canary"),
    ("invalid-edition-canary", ""),
)

NEWAPI_MUTATION_CASES = (
    (
        "/model-gateway/custom/newapi/init",
        {
            "newApiBaseUrl": "https://newapi-url-canary.invalid",
            "database": {"sqlDsn": "postgresql://request-dsn-canary"},
            "setupUsername": "admin-user-canary",
            "setupPassword": "admin-password-canary",
            "setupConfirmPassword": "admin-password-canary",
        },
    ),
    (
        "/model-gateway/custom/newapi/provider-channels",
        {
            "channels": [
                {
                    "provider": "ali",
                    "upstreamKey": "provider-key-canary",
                    "baseUrl": "https://provider-url-canary.invalid",
                }
            ]
        },
    ),
    (
        "/model-gateway/custom/newapi/provider-channel/sync",
        {
            "provider": "ali",
            "upstreamKey": "sync-key-canary",
            "baseUrl": "https://sync-url-canary.invalid",
        },
    ),
    (
        "/model-gateway/custom/newapi/channels",
        {
            "provider": "ali",
            "upstreamKey": "single-channel-key-canary",
            "modelMapping": {"internal-model": "upstream-model-canary"},
        },
    ),
    (
        "/model-gateway/custom/newapi/channels/batch",
        {
            "channels": [
                {
                    "provider": "ali",
                    "upstreamKey": "batch-channel-key-canary",
                    "modelMapping": {"internal-model": "batch-model-canary"},
                }
            ]
        },
    ),
    (
        "/model-gateway/custom/newapi/embedding-model",
        {
            "provider": "ali",
            "upstreamModel": "embedding-model-canary",
            "dimension": 1024,
        },
    ),
    (
        "/model-gateway/custom/newapi/media-models",
        {
            "models": {
                "LingShan-G2": {
                    "provider": "ali",
                    "upstreamModel": "media-model-canary",
                }
            }
        },
    ),
)

REQUEST_SECRET_CANARIES = (
    "organization-profile-dsn-canary",
    "contradictory-profile-dsn-canary",
    "request-dsn-canary",
    "admin-password-canary",
    "provider-key-canary",
    "sync-key-canary",
    "single-channel-key-canary",
    "batch-channel-key-canary",
    "newapi-admin-token-canary",
    "model-api-key-canary",
)


def _install_newapi_side_effect_spies(
    monkeypatch: pytest.MonkeyPatch,
) -> dict[str, int]:
    calls: dict[str, int] = {}

    def deny(name: str) -> Callable[..., None]:
        def _deny(*_args: object, **_kwargs: object) -> None:
            calls[name] = calls.get(name, 0) + 1
            raise AssertionError(f"side effect reached: {name}")

        return _deny

    for name in (
        "require_provisioner_enabled",
        "get_provisioner_config",
        "ensure_newapi_setup",
        "ensure_admin_access_token",
        "create_or_reuse_relay_token",
        "get_newapi_provider_channel",
        "update_provider_channel_credentials",
        "upsert_channel",
        "save_newapi_provider_channels",
        "save_newapi_embedding_model_config",
        "save_newapi_media_model_mappings",
        "save_custom_newapi_gateway",
        "save_newapi_database_config",
        "refresh_model_gateway_runtime",
    ):
        monkeypatch.setattr(model_gateway, name, deny(name))
    monkeypatch.setattr(newapi_provisioner, "open_newapi_db", deny("open_newapi_db"))
    monkeypatch.setattr(newapi_provisioner.httpx, "Client", deny("httpx.Client"))
    monkeypatch.setattr(registry, "get_port", deny("registry.get_port"))
    return calls


@pytest.mark.parametrize(("edition", "dsn"), PROFILE_CASES)
@pytest.mark.parametrize(("route", "payload"), NEWAPI_MUTATION_CASES)
def test_newapi_mutations_are_excluded_before_any_side_effect(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
    edition: str,
    dsn: str,
    route: str,
    payload: dict[str, object],
) -> None:
    monkeypatch.setenv("ST_EDITION", edition)
    if dsn:
        monkeypatch.setenv("ST_CONTROL_PLANE_DSN", dsn)
    else:
        monkeypatch.delenv("ST_CONTROL_PLANE_DSN", raising=False)
    monkeypatch.setenv("NEWAPI_PROVISIONER_ENABLED", "true")
    monkeypatch.setenv("NEWAPI_API_KEY", "newapi-admin-token-canary")
    monkeypatch.setenv("MODEL_API_KEY", "model-api-key-canary")
    calls = _install_newapi_side_effect_spies(monkeypatch)
    app = FastAPI()
    app.include_router(model_gateway.router)

    response = TestClient(app).post(route, json=payload)

    assert response.status_code == 403
    assert response.json() == {"detail": SERVICE_OPERATION_DENIED}
    assert calls == {}
    rendered = response.text + caplog.text
    for canary in REQUEST_SECRET_CANARIES:
        assert canary not in rendered


class CanaryOperationPort:
    """A fake durable port that must remain completely untouched."""

    def __init__(self, state: str) -> None:
        self.state = state
        self.calls: dict[str, int] = {}

    def get(self, *_args: object, **_kwargs: object) -> "CanaryOperationPort":
        self.calls["get_port"] = self.calls.get("get_port", 0) + 1
        return self

    async def claim(self, *_args: object, **_kwargs: object) -> object:
        self.calls["claim"] = self.calls.get("claim", 0) + 1
        raise AssertionError(f"claim reached for {self.state}")

    async def mark_completed(self, *_args: object, **_kwargs: object) -> None:
        self.calls["mark_completed"] = self.calls.get("mark_completed", 0) + 1

    async def mark_unknown(self, *_args: object, **_kwargs: object) -> None:
        self.calls["mark_unknown"] = self.calls.get("mark_unknown", 0) + 1


@pytest.mark.parametrize(
    "operation_state", ("conflict", "accepted", "completed", "unknown")
)
def test_excluded_service_operations_never_consult_or_replay_durable_state(
    monkeypatch: pytest.MonkeyPatch,
    operation_state: str,
) -> None:
    monkeypatch.setenv("ST_EDITION", "ee")
    monkeypatch.setenv(
        "ST_CONTROL_PLANE_DSN", "postgresql://no-replay-dsn-secret-canary"
    )
    newapi_calls = _install_newapi_side_effect_spies(monkeypatch)
    port = CanaryOperationPort(operation_state)
    registry._PORTS["egress_operations"] = port
    monkeypatch.setattr(registry, "get_port", port.get)
    app = FastAPI()
    app.include_router(model_gateway.router)

    response = TestClient(app).post(
        "/model-gateway/custom/newapi/init",
        json={"setupPassword": "no-replay-admin-password-canary"},
    )

    assert response.status_code == 403
    assert response.json() == {"detail": SERVICE_OPERATION_DENIED}
    assert newapi_calls == {}
    assert port.calls == {}
    rendered = response.text
    for canary in (
        "no-replay-dsn-secret-canary",
        "no-replay-admin-password-canary",
    ):
        assert canary not in rendered
