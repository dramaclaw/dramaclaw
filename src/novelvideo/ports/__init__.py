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


async def update_current_model_call_log(
    *,
    request_payload: dict | None = None,
    response_payload: dict | None = None,
    error_message: str = "",
) -> None:
    """Best-effort observability that can never gate model execution."""
    updater = getattr(get_usage_meter(), "update_current_model_call_log", None)
    if not callable(updater):
        return
    try:
        await updater(
            request_payload=request_payload,
            response_payload=response_payload,
            error_message=error_message,
        )
    except Exception:
        return


def get_provider_instrumentation():
    return get_port("provider_instrumentation")


def get_task_backend():
    return get_port("task_backend")


def get_task_envelope_consumer():
    return get_port("task_envelope_consumer")


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


def get_task_projection():
    # Deliberately falls back instead of failing closed: not installing a
    # projector is the rollback, so it has to stay a legal state. See
    # ports/projection.py and the comment above _EE_REQUIRED_PORTS.
    try:
        return get_port("task_projection")
    except Exception as exc:
        if exc.__class__.__name__ != "PortNotRegistered":
            raise
        from novelvideo.ports.local.projection import NoOpTaskProjection

        return NoOpTaskProjection()


def get_canvas_write_mutex():
    # Deliberately falls back instead of failing closed: on a single machine the
    # file lock is the complete answer, so "no cross-machine mutex installed" is
    # both the CE steady state and the EE rollback. See ports/canvas_mutex.py
    # and the comment above _EE_REQUIRED_PORTS.
    try:
        return get_port("canvas_write_mutex")
    except Exception as exc:
        if exc.__class__.__name__ != "PortNotRegistered":
            raise
        from novelvideo.ports.local.canvas_mutex import FileLockCanvasWriteMutex

        return FileLockCanvasWriteMutex()


def get_product_surface_access():
    return get_port("product_surface_access")


def get_model_credentials():
    return get_port("model_credentials")


def get_authz_port():
    return get_port("authz")


def get_egress_port():
    return get_port("egress")


def get_egress_operation_port():
    return get_port("egress_operations")


__all__ = [
    "get_audit_sink",
    "get_auth_port",
    "get_auth_session_port",
    "get_authz_port",
    "get_cancellation_store",
    "get_canvas_write_mutex",
    "get_credit_quote",
    "get_egress_operation_port",
    "get_egress_port",
    "get_lifecycle_port",
    "get_model_credentials",
    "get_product_surface_access",
    "get_project_access",
    "get_project_registry",
    "get_provider_instrumentation",
    "get_release_feed_port",
    "get_task_backend",
    "get_task_envelope_consumer",
    "get_task_projection",
    "get_usage_meter",
]
