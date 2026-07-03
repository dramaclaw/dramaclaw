"""Stable data-plane ports."""

from __future__ import annotations

from novelvideo.ports.registry import get_port


def get_auth_port():
    return get_port("auth")


def get_auth_session_port():
    return get_port("auth_session")


def get_project_registry():
    return get_port("project_registry")


def get_project_access():
    return get_port("project_access")


def get_usage_meter():
    try:
        meter = get_port("usage_meter")
    except Exception as exc:
        if exc.__class__.__name__ != "PortNotRegistered":
            raise
        from novelvideo.ports.local.usage import NoOpUsageMeter

        return NoOpUsageMeter()
    if not hasattr(meter, "reserve_current_model_call_credit"):
        from novelvideo.ports.local.usage import NoOpUsageMeter

        return NoOpUsageMeter()
    return meter


def get_provider_instrumentation():
    return get_port("provider_instrumentation")


def get_task_backend():
    return get_port("task_backend")


def get_cancellation_store():
    return get_port("cancellation_store")


def get_audit_sink():
    return get_port("audit_sink")


def get_credit_quote():
    return get_port("credit_quote")


def get_lifecycle_port():
    return get_port("lifecycle")


def get_release_feed_port():
    try:
        return get_port("release_feed")
    except Exception as exc:
        if exc.__class__.__name__ != "PortNotRegistered":
            raise
        from novelvideo.ports.local.release_feed import NoOpReleaseFeed

        return NoOpReleaseFeed()


__all__ = [
    "get_audit_sink",
    "get_auth_port",
    "get_auth_session_port",
    "get_cancellation_store",
    "get_credit_quote",
    "get_lifecycle_port",
    "get_project_access",
    "get_project_registry",
    "get_provider_instrumentation",
    "get_release_feed_port",
    "get_task_backend",
    "get_usage_meter",
]
