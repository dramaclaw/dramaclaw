import importlib

import pytest


def _registry():
    import novelvideo.ports.registry as registry

    return importlib.reload(registry)


@pytest.fixture(autouse=True)
def _reset_registry_after_test():
    yield
    _registry()


def test_register_and_get_port() -> None:
    registry = _registry()
    impl = object()

    registry.register_port("auth", impl)

    assert registry.get_port("auth") is impl


def test_get_port_fails_closed_when_unregistered() -> None:
    registry = _registry()

    with pytest.raises(registry.PortNotRegistered) as exc:
        registry.get_port("auth")

    assert "auth" in str(exc.value)
    assert "ensure_bootstrap" in str(exc.value)


def test_ensure_bootstrap_registers_local_ports_for_explicit_ce(monkeypatch) -> None:
    registry = _registry()
    monkeypatch.delenv("ST_CONTROL_PLANE_DSN", raising=False)
    monkeypatch.setenv("ST_EDITION", "ce")

    registry.ensure_bootstrap()

    assert registry.get_port("auth") is not None
    assert registry.get_port("auth_session") is not None
    assert registry.get_port("project_registry") is not None
    assert registry.get_port("project_access") is not None
    assert registry.get_port("usage_meter") is not None
    assert registry.get_port("provider_instrumentation") is not None
    assert registry.get_port("task_backend") is not None
    assert registry.get_port("cancellation_store") is not None
    assert registry.get_port("audit_sink") is not None
    assert registry.get_port("lifecycle") is not None
    assert registry.get_port("model_credentials") is not None
    assert registry.get_port("authz") is not None
    assert registry.get_port("egress") is not None


def test_ensure_bootstrap_rejects_dsn_and_ce_conflict(monkeypatch) -> None:
    registry = _registry()
    monkeypatch.setenv("ST_CONTROL_PLANE_DSN", "postgresql://example")
    monkeypatch.setenv("ST_EDITION", "ce")

    with pytest.raises(RuntimeError, match="矛盾配置"):
        registry.ensure_bootstrap()


def test_ensure_bootstrap_dsn_without_ce_uses_ee(monkeypatch) -> None:
    registry = _registry()
    monkeypatch.setenv("ST_CONTROL_PLANE_DSN", "postgresql://example")
    monkeypatch.delenv("ST_EDITION", raising=False)
    called = False

    class EntryPoint:
        def load(self):
            def register():
                nonlocal called
                called = True
                for name in registry._EE_REQUIRED_PORTS:
                    registry.register_port(name, object())

            return register

    monkeypatch.setattr(registry, "entry_points", lambda *, group: [EntryPoint()], raising=False)

    registry.ensure_bootstrap()

    assert called is True
    for name in registry._EE_REQUIRED_PORTS:
        assert registry.get_port(name) is not None


def test_ensure_bootstrap_reports_all_missing_ee_ports_when_entry_points_empty(monkeypatch) -> None:
    registry = _registry()
    monkeypatch.setenv("ST_CONTROL_PLANE_DSN", "postgresql://example")
    monkeypatch.delenv("ST_EDITION", raising=False)
    monkeypatch.setattr(registry, "entry_points", lambda *, group: [], raising=False)

    with pytest.raises(RuntimeError) as exc:
        registry.ensure_bootstrap()

    message = str(exc.value)
    for name in (
        "auth",
        "auth_session",
        "project_registry",
        "project_access",
        "usage_meter",
        "lifecycle",
        "model_credentials",
        "authz",
        "egress",
    ):
        assert name in message
    assert "novelvideo.ports_bootstrap" in message


def test_ensure_bootstrap_reports_partially_registered_ee_ports(monkeypatch) -> None:
    registry = _registry()
    monkeypatch.setenv("ST_CONTROL_PLANE_DSN", "postgresql://example")
    monkeypatch.delenv("ST_EDITION", raising=False)

    class EntryPoint:
        def load(self):
            return lambda: registry.register_port("lifecycle", object())

    monkeypatch.setattr(registry, "entry_points", lambda *, group: [EntryPoint()], raising=False)

    with pytest.raises(RuntimeError) as exc:
        registry.ensure_bootstrap()

    message = str(exc.value)
    assert "lifecycle" not in message
    for name in ("auth", "auth_session", "project_registry", "project_access", "usage_meter"):
        assert name in message


def test_ensure_bootstrap_requires_provider_instrumentation_for_ee(monkeypatch) -> None:
    registry = _registry()
    monkeypatch.setenv("ST_CONTROL_PLANE_DSN", "postgresql://example")
    monkeypatch.delenv("ST_EDITION", raising=False)

    class EntryPoint:
        def load(self):
            def register():
                for name in registry._EE_REQUIRED_PORTS:
                    if name != "provider_instrumentation":
                        registry.register_port(name, object())

            return register

    monkeypatch.setattr(registry, "entry_points", lambda *, group: [EntryPoint()], raising=False)

    with pytest.raises(RuntimeError) as exc:
        registry.ensure_bootstrap()

    assert "provider_instrumentation" in str(exc.value)


def test_ensure_bootstrap_requires_task_backend_ports_for_ee(monkeypatch) -> None:
    registry = _registry()
    monkeypatch.setenv("ST_CONTROL_PLANE_DSN", "postgresql://example")
    monkeypatch.delenv("ST_EDITION", raising=False)

    class EntryPoint:
        def load(self):
            def register():
                for name in registry._EE_REQUIRED_PORTS:
                    if name not in {"task_backend", "cancellation_store"}:
                        registry.register_port(name, object())

            return register

    monkeypatch.setattr(registry, "entry_points", lambda *, group: [EntryPoint()], raising=False)

    with pytest.raises(RuntimeError) as exc:
        registry.ensure_bootstrap()

    message = str(exc.value)
    assert "task_backend" in message
    assert "cancellation_store" in message


def test_ensure_bootstrap_requires_audit_sink_for_ee(monkeypatch) -> None:
    registry = _registry()
    monkeypatch.setenv("ST_CONTROL_PLANE_DSN", "postgresql://example")
    monkeypatch.delenv("ST_EDITION", raising=False)

    class EntryPoint:
        def load(self):
            def register():
                for name in registry._EE_REQUIRED_PORTS:
                    if name != "audit_sink":
                        registry.register_port(name, object())

            return register

    monkeypatch.setattr(registry, "entry_points", lambda *, group: [EntryPoint()], raising=False)

    with pytest.raises(RuntimeError) as exc:
        registry.ensure_bootstrap()

    assert "audit_sink" in str(exc.value)


def test_ensure_bootstrap_requires_credit_quote_for_ee(monkeypatch) -> None:
    registry = _registry()
    monkeypatch.setenv("ST_CONTROL_PLANE_DSN", "postgresql://example")
    monkeypatch.delenv("ST_EDITION", raising=False)

    class EntryPoint:
        def load(self):
            def register():
                for name in registry._EE_REQUIRED_PORTS:
                    if name != "credit_quote":
                        registry.register_port(name, object())

            return register

    monkeypatch.setattr(registry, "entry_points", lambda *, group: [EntryPoint()], raising=False)

    with pytest.raises(RuntimeError) as exc:
        registry.ensure_bootstrap()

    assert "credit_quote" in str(exc.value)


def test_ensure_bootstrap_requires_explicit_ce_without_control_plane(monkeypatch) -> None:
    registry = _registry()
    monkeypatch.delenv("ST_CONTROL_PLANE_DSN", raising=False)
    monkeypatch.delenv("ST_EDITION", raising=False)

    with pytest.raises(RuntimeError, match="ST_EDITION=ce"):
        registry.ensure_bootstrap()
