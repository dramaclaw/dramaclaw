from __future__ import annotations

import pytest

from novelvideo.piko import backend


def _clear_backend_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("PIKO_WORLD_BACKEND", raising=False)
    monkeypatch.delenv("ST_CONTROL_PLANE_DSN", raising=False)
    monkeypatch.delenv("ST_REDIS_URL", raising=False)


def test_piko_backend_defaults_to_demo_without_shared_infrastructure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _clear_backend_environment(monkeypatch)

    assert backend.configured_backend() == "demo"


def test_piko_backend_uses_distributed_mode_with_shared_infrastructure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _clear_backend_environment(monkeypatch)
    monkeypatch.setenv("ST_CONTROL_PLANE_DSN", "postgresql://control-plane")
    monkeypatch.setenv("ST_REDIS_URL", "redis://shared")

    assert backend.configured_backend() == "distributed"


@pytest.mark.parametrize(
    ("name", "value", "missing"),
    [
        ("ST_CONTROL_PLANE_DSN", "postgresql://control-plane", "ST_REDIS_URL"),
        ("ST_REDIS_URL", "redis://shared", "ST_CONTROL_PLANE_DSN"),
    ],
)
def test_partial_shared_infrastructure_fails_instead_of_splitting_rooms(
    monkeypatch: pytest.MonkeyPatch,
    name: str,
    value: str,
    missing: str,
) -> None:
    _clear_backend_environment(monkeypatch)
    monkeypatch.setenv(name, value)

    assert backend.configured_backend() == "distributed"
    with pytest.raises(RuntimeError, match=missing):
        backend.build_backend()


def test_explicit_demo_mode_overrides_auto_selection(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("PIKO_WORLD_BACKEND", "demo")
    monkeypatch.setenv("ST_CONTROL_PLANE_DSN", "postgresql://control-plane")
    monkeypatch.setenv("ST_REDIS_URL", "redis://shared")

    assert backend.configured_backend() == "demo"


def test_piko_backend_rejects_unknown_mode(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PIKO_WORLD_BACKEND", "fallback")
    with pytest.raises(RuntimeError, match="PIKO_WORLD_BACKEND"):
        backend.configured_backend()


def test_distributed_backend_requires_existing_infrastructure_urls(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("PIKO_WORLD_BACKEND", "distributed")
    monkeypatch.delenv("ST_CONTROL_PLANE_DSN", raising=False)
    monkeypatch.delenv("ST_REDIS_URL", raising=False)
    with pytest.raises(RuntimeError, match="ST_CONTROL_PLANE_DSN, ST_REDIS_URL"):
        backend.build_backend()
