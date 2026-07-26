"""Process-local port registry."""

from __future__ import annotations

import os
from importlib.metadata import entry_points
from typing import Any


class PortNotRegistered(RuntimeError):
    def __init__(self, name: str) -> None:
        super().__init__(f"port {name!r} is not registered; call ensure_bootstrap() first")
        self.name = name


_PORTS: dict[str, Any] = {}
_BOOTSTRAPPED = False
_EE_REQUIRED_PORTS = (
    "auth",
    "auth_session",
    "project_registry",
    "project_access",
    "audit_sink",
    "credit_quote",
    "usage_meter",
    "provider_instrumentation",
    "task_backend",
    "cancellation_store",
    "lifecycle",
)


def register_port(name: str, impl) -> None:
    _PORTS[name] = impl


def get_port(name: str):
    try:
        return _PORTS[name]
    except KeyError:
        raise PortNotRegistered(name) from None


def ensure_bootstrap() -> None:
    global _BOOTSTRAPPED
    if _BOOTSTRAPPED:
        return
    dsn = os.environ.get("ST_CONTROL_PLANE_DSN", "").strip()
    edition = os.environ.get("ST_EDITION", "").strip().lower()
    if dsn and edition == "ce":
        raise RuntimeError(
            "ST_CONTROL_PLANE_DSN and ST_EDITION=ce are both set (contradictory config): "
            "a control-plane DSN implies EE, while declaring CE means no DSN — pick one"
        )
    if dsn:
        for ep in entry_points(group="novelvideo.ports_bootstrap"):
            ep.load()()
        missing = [name for name in _EE_REQUIRED_PORTS if name not in _PORTS]
        if missing:
            raise RuntimeError(
                "ST_CONTROL_PLANE_DSN is set but the EE ports are incomplete, missing: "
                + ", ".join(missing)
                + " (entry-point group novelvideo.ports_bootstrap not found or not fully registered)"
            )
        _BOOTSTRAPPED = True
        return
    if edition == "ce":
        from novelvideo.ports.local import register_local_ports

        register_local_ports()
        _BOOTSTRAPPED = True
        return
    raise RuntimeError("Missing ST_CONTROL_PLANE_DSN and ST_EDITION=ce not explicitly set; refusing to start")
