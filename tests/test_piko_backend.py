from __future__ import annotations

import pytest

from novelvideo.piko import backend


def test_piko_backend_defaults_to_demo(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("PIKO_WORLD_BACKEND", raising=False)
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
