import base64
import importlib
import json

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


@pytest.mark.parametrize(
    "name", ["model_credentials", "authz", "egress", "egress_operations"]
)
def test_org_runtime_ports_fail_closed_when_unregistered(name) -> None:
    registry = _registry()

    with pytest.raises(registry.PortNotRegistered) as exc:
        registry.get_port(name)

    assert exc.value.name == name


def test_egress_operation_accessor_uses_the_stable_registry_name() -> None:
    from novelvideo.ports import get_egress_operation_port

    registry = _registry()
    implementation = object()
    registry.register_port("egress_operations", implementation)

    assert get_egress_operation_port() is implementation


def test_ensure_bootstrap_registers_local_ports_for_explicit_ce(monkeypatch) -> None:
    registry = _registry()
    monkeypatch.delenv("ST_CONTROL_PLANE_DSN", raising=False)
    monkeypatch.setenv("ST_EDITION", "ce")
    monkeypatch.setenv("ST_TASK_ENVELOPE_ACTIVE_KEY_ID", "registry-test-v1")
    monkeypatch.setenv(
        "ST_TASK_ENVELOPE_KEYRING_B64_JSON",
        json.dumps(
            {
                "registry-test-v1": base64.b64encode(b"registry-test-key" * 2).decode(
                    "ascii"
                )
            }
        ),
    )

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

    monkeypatch.setattr(
        registry, "entry_points", lambda *, group: [EntryPoint()], raising=False
    )

    registry.ensure_bootstrap()

    assert called is True
    for name in registry._EE_REQUIRED_PORTS:
        assert registry.get_port(name) is not None


def test_ensure_bootstrap_reports_all_missing_ee_ports_when_entry_points_empty(
    monkeypatch,
) -> None:
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

    monkeypatch.setattr(
        registry, "entry_points", lambda *, group: [EntryPoint()], raising=False
    )

    with pytest.raises(RuntimeError) as exc:
        registry.ensure_bootstrap()

    message = str(exc.value)
    assert "lifecycle" not in message
    for name in (
        "auth",
        "auth_session",
        "project_registry",
        "project_access",
        "usage_meter",
    ):
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

    monkeypatch.setattr(
        registry, "entry_points", lambda *, group: [EntryPoint()], raising=False
    )

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

    monkeypatch.setattr(
        registry, "entry_points", lambda *, group: [EntryPoint()], raising=False
    )

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

    monkeypatch.setattr(
        registry, "entry_points", lambda *, group: [EntryPoint()], raising=False
    )

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

    monkeypatch.setattr(
        registry, "entry_points", lambda *, group: [EntryPoint()], raising=False
    )

    with pytest.raises(RuntimeError) as exc:
        registry.ensure_bootstrap()

    assert "credit_quote" in str(exc.value)


def test_ensure_bootstrap_requires_explicit_ce_without_control_plane(
    monkeypatch,
) -> None:
    registry = _registry()
    monkeypatch.delenv("ST_CONTROL_PLANE_DSN", raising=False)
    monkeypatch.delenv("ST_EDITION", raising=False)

    with pytest.raises(RuntimeError, match="ST_EDITION=ce"):
        registry.ensure_bootstrap()


# ---------------------------------------------------------------------------
# _EE_REQUIRED_PORTS is a hand-maintained list in this repo describing what the
# EE package must register. Nothing links it to the ports this package actually
# fetches, so it can only drift — and it did: `egress_operations` was fetched
# bare on six generation paths while the boot check never asked for it, so a
# CE/EE version skew would pass startup and fail at the user's first request.
# The tests below derive the answer from the source instead of trusting the
# list, which is the only way the next port cannot repeat it.
# ---------------------------------------------------------------------------


def _package_root():
    import pathlib

    import novelvideo

    return pathlib.Path(novelvideo.__file__).resolve().parent


def _port_name_arg(call):
    """The literal port name in a ``get_port(...)`` call, or None."""
    import ast

    func = call.func
    name = func.attr if isinstance(func, ast.Attribute) else getattr(func, "id", None)
    if name != "get_port" or not call.args:
        return call if name == "get_port" else None
    first = call.args[0]
    if isinstance(first, ast.Constant) and isinstance(first.value, str):
        return first.value
    return call


def _classify_get_port_calls():
    """Split every ``get_port`` call into bare / fallback / dynamic.

    A call is *fallback* when an enclosing ``try`` names ``PortNotRegistered``
    in one of its handlers — either as the caught type or, as in
    ``get_release_feed_port``, as the class name the handler re-raises on.
    Anything else is *bare*: the error reaches the caller, so the port must be
    present before the process serves traffic.
    """
    import ast

    bare: dict[str, str] = {}
    fallback: set[str] = set()
    dynamic: list[str] = []

    for path in sorted(_package_root().rglob("*.py")):
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        parents = {}
        for node in ast.walk(tree):
            for child in ast.iter_child_nodes(node):
                parents[child] = node

        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            resolved = _port_name_arg(node)
            if resolved is None:
                continue
            where = f"{path.name}:{node.lineno}"
            if not isinstance(resolved, str):
                dynamic.append(where)
                continue

            guarded = False
            cursor = node
            while cursor in parents:
                cursor = parents[cursor]
                if isinstance(cursor, ast.Try) and any(
                    "PortNotRegistered" in ast.dump(handler)
                    for handler in cursor.handlers
                ):
                    guarded = True
                    break
            if guarded:
                fallback.add(resolved)
            else:
                bare.setdefault(resolved, where)

    return bare, fallback, dynamic


def test_every_unguarded_port_is_required_at_bootstrap() -> None:
    """A port fetched without a fallback must fail the boot check, not a user.

    Without this, an EE build that lags this package starts cleanly and only
    breaks when a request reaches the missing port — and for org-gated ports
    that means it breaks for tenants in production while personal traffic
    looks healthy.
    """
    registry = _registry()
    bare, _, _ = _classify_get_port_calls()

    missing = {name: where for name, where in bare.items()
               if name not in registry._EE_REQUIRED_PORTS}

    assert missing == {}, (
        "fetched without a PortNotRegistered fallback but absent from "
        f"_EE_REQUIRED_PORTS: {missing}"
    )


def test_required_ports_are_all_actually_fetched() -> None:
    """The list may not accumulate names this package never asks for.

    A dead entry makes EE provision something for nobody, and quietly turns
    the list into folklore instead of a derived contract.
    """
    registry = _registry()
    bare, _, _ = _classify_get_port_calls()

    assert not set(registry._EE_REQUIRED_PORTS) - set(bare), (
        "listed as required but never fetched unguarded: "
        f"{sorted(set(registry._EE_REQUIRED_PORTS) - set(bare))}"
    )


def test_port_names_stay_literal_so_the_check_can_see_them() -> None:
    """The two tests above read the source; a computed name would hide from them."""
    _, _, dynamic = _classify_get_port_calls()

    assert dynamic == [], f"get_port called with a non-literal name at {dynamic}"
