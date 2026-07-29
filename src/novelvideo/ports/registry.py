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
            "ST_CONTROL_PLANE_DSN 与 ST_EDITION=ce 同时设置(矛盾配置):"
            "有控制面 DSN 即 EE,声明 CE 即应无 DSN——请二选一"
        )
    if dsn:
        for ep in entry_points(group="novelvideo.ports_bootstrap"):
            ep.load()()
        missing = [name for name in _EE_REQUIRED_PORTS if name not in _PORTS]
        if missing:
            raise RuntimeError(
                "ST_CONTROL_PLANE_DSN 已设置但 EE 端口不完整，缺失: "
                + ", ".join(missing)
                + "（入口点组 novelvideo.ports_bootstrap 未发现或注册不全）"
            )
        _BOOTSTRAPPED = True
        return
    if edition == "ce":
        from novelvideo.ports.local import register_local_ports

        register_local_ports()
        _BOOTSTRAPPED = True
        return
    raise RuntimeError("缺 ST_CONTROL_PLANE_DSN 且未显式 ST_EDITION=ce，拒绝启动")
