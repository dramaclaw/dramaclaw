"""P0G-4T service-operation exclusion contract tests."""

from __future__ import annotations

import os
from collections.abc import Callable
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from typer.testing import CliRunner

from novelvideo.api.routes import model_gateway
from novelvideo.backup import cli as backup_cli
from novelvideo.backup import db_daily, files_sync
from novelvideo.cli import app as novelvideo_app
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
        "BACKUP_OSS_AK": "backup-ak-canary",
        "BACKUP_OSS_SK": "backup-sk-canary",
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


class SecretReadGuard(dict[str, str]):
    """Track forbidden service-operation environment reads."""

    def __init__(self, values: dict[str, str], calls: dict[str, int]) -> None:
        super().__init__(values)
        self._calls = calls

    @staticmethod
    def _is_forbidden(key: object) -> bool:
        return isinstance(key, str) and (
            key.startswith("BACKUP_")
            or key in {"NOVELVIDEO_STATE_DIR", "NOVELVIDEO_OUTPUT_DIR"}
        )

    def _record(self, key: object) -> None:
        if self._is_forbidden(key):
            name = f"env:{key}"
            self._calls[name] = self._calls.get(name, 0) + 1
            raise AssertionError(f"secret/path environment reached: {key}")

    def __getitem__(self, key: str) -> str:
        self._record(key)
        return super().__getitem__(key)

    def get(self, key: str, default: str | None = None) -> str | None:
        self._record(key)
        return super().get(key, default)

    def __contains__(self, key: object) -> bool:
        self._record(key)
        return super().__contains__(key)


def _install_backup_side_effect_spies(
    monkeypatch: pytest.MonkeyPatch,
    edition: str,
    dsn: str,
) -> dict[str, int]:
    calls: dict[str, int] = {}
    guarded_env = SecretReadGuard(dict(os.environ), calls)
    guarded_env["ST_EDITION"] = edition
    if dsn:
        guarded_env["ST_CONTROL_PLANE_DSN"] = dsn
    else:
        guarded_env.pop("ST_CONTROL_PLANE_DSN", None)
    for name, value in {
        "BACKUP_OSS_AK": "backup-ak-secret-canary",
        "BACKUP_OSS_SK": "backup-sk-secret-canary",
        "BACKUP_OSS_BUCKET": "backup-bucket-canary",
        "BACKUP_OSS_ENDPOINT": "backup-endpoint-canary.invalid",
        "BACKUP_OSS_PREFIX": "backup/object-path-canary",
        "NOVELVIDEO_STATE_DIR": "/tmp/state-path-canary",
        "NOVELVIDEO_OUTPUT_DIR": "/tmp/output-path-canary",
    }.items():
        dict.__setitem__(guarded_env, name, value)
    monkeypatch.setattr(os, "environ", guarded_env)

    def deny(name: str) -> Callable[..., None]:
        def _deny(*_args: object, **_kwargs: object) -> None:
            calls[name] = calls.get(name, 0) + 1
            raise AssertionError(f"side effect reached: {name}")

        return _deny

    monkeypatch.setattr(backup_cli.tempfile, "NamedTemporaryFile", deny("tempfile"))
    monkeypatch.setattr(backup_cli.subprocess, "run", deny("subprocess"))
    monkeypatch.setattr(backup_cli, "build_rclone_env", deny("build_rclone_env"))
    monkeypatch.setattr(files_sync, "build_rclone_env", deny("build_rclone_env"))
    monkeypatch.setattr(db_daily.sqlite3, "connect", deny("sqlite3.connect"))
    monkeypatch.setattr(Path, "mkdir", deny("Path.mkdir"))
    monkeypatch.setattr(Path, "rglob", deny("Path.rglob"))
    monkeypatch.setattr(Path, "write_text", deny("Path.write_text"))
    monkeypatch.setattr(Path, "write_bytes", deny("Path.write_bytes"))
    monkeypatch.setattr(registry, "ensure_bootstrap", deny("registry.ensure_bootstrap"))
    monkeypatch.setattr(registry, "get_port", deny("registry.get_port"))
    return calls


@pytest.mark.parametrize(("edition", "dsn"), PROFILE_CASES)
@pytest.mark.parametrize(
    ("cli_app", "args"),
    (
        (
            novelvideo_app,
            [
                "backup",
                "restore-cell",
                "--user",
                "command-argument-canary",
                "--project",
                "project",
            ],
        ),
        (
            backup_cli.backup_app,
            [
                "restore-cell",
                "--user",
                "command-argument-canary",
                "--project",
                "project",
            ],
        ),
    ),
)
def test_backup_typer_entrypoints_are_excluded_before_any_side_effect(
    monkeypatch: pytest.MonkeyPatch,
    edition: str,
    dsn: str,
    cli_app: object,
    args: list[str],
) -> None:
    calls = _install_backup_side_effect_spies(monkeypatch, edition, dsn)

    result = CliRunner().invoke(cli_app, args)

    assert result.exit_code == 2
    assert result.output == f"{SERVICE_OPERATION_DENIED}\n"
    assert calls == {}
    assert result.exception is not None
    exception_chain: list[BaseException] = []
    current = result.exception
    while current is not None and current not in exception_chain:
        exception_chain.append(current)
        current = current.__cause__ or current.__context__
    rendered = result.output + " ".join(
        f"{exception!s} {exception!r}" for exception in exception_chain
    )
    for canary in (
        "backup-ak-secret-canary",
        "backup-sk-secret-canary",
        "backup-endpoint-canary.invalid",
        "backup/object-path-canary",
        "state-path-canary",
        "output-path-canary",
        "command-argument-canary",
    ):
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
    backup_calls = _install_backup_side_effect_spies(
        monkeypatch,
        "ee",
        "postgresql://no-replay-dsn-secret-canary",
    )
    monkeypatch.setattr(registry, "get_port", port.get)
    cli_result = CliRunner().invoke(
        backup_cli.backup_app,
        [
            "restore-cell",
            "--user",
            "no-replay-command-canary",
            "--project",
            "project",
        ],
    )

    assert cli_result.exit_code == 2
    assert cli_result.output == f"{SERVICE_OPERATION_DENIED}\n"
    assert backup_calls == {}
    assert port.calls == {}
    rendered = response.text + cli_result.output
    for canary in (
        "no-replay-dsn-secret-canary",
        "no-replay-admin-password-canary",
        "no-replay-command-canary",
    ):
        assert canary not in rendered


@pytest.mark.parametrize(("edition", "dsn"), PROFILE_CASES)
@pytest.mark.parametrize("entrypoint", (db_daily.main, files_sync.main))
def test_backup_module_entrypoints_are_excluded_before_any_side_effect(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    edition: str,
    dsn: str,
    entrypoint: Callable[..., int],
) -> None:
    calls = _install_backup_side_effect_spies(monkeypatch, edition, dsn)

    result = entrypoint()

    captured = capsys.readouterr()
    assert result == 2
    assert captured.out == ""
    assert captured.err == f"{SERVICE_OPERATION_DENIED}\n"
    assert calls == {}
    rendered = captured.out + captured.err
    for canary in (
        "backup-ak-secret-canary",
        "backup-sk-secret-canary",
        "backup-endpoint-canary.invalid",
        "backup/object-path-canary",
        "state-path-canary",
        "output-path-canary",
    ):
        assert canary not in rendered
