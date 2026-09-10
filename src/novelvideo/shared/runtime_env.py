"""Runtime environment helpers for data-plane code."""

from __future__ import annotations

import os

from novelvideo.env import load_project_dotenv


def _load_env() -> None:
    load_project_dotenv(override=False)


def task_backend() -> str:
    _load_env()
    return os.environ.get("ST_TASK_BACKEND", "celery").strip() or "celery"


def edition() -> str:
    """Resolve CE by default; a control-plane DSN selects EE when unspecified.

    Preserve explicit values so bootstrap can reject conflicting or invalid
    configuration instead of silently falling back to a different edition.
    """
    _load_env()
    configured = os.environ.get("ST_EDITION", "").strip().lower()
    if configured:
        return configured
    return "ee" if os.environ.get("ST_CONTROL_PLANE_DSN", "").strip() else "ce"


def is_ce() -> bool:
    return edition() == "ce"


def is_ce_effective() -> bool:
    return edition() == "ce" and not os.environ.get("ST_CONTROL_PLANE_DSN", "").strip()


def _env_bool(name: str, default: bool = False) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def cookie_secure() -> bool:
    _load_env()
    # Secure-by-default so a misconfigured deploy can't ship
    # non-Secure admin cookies. Local HTTP dev MUST explicitly
    # opt out via ``ST_COOKIE_SECURE=0`` — the admin cookie is
    # also SameSite=Strict, so a Secure cookie on plain http
    # localhost is silently dropped by the browser.
    return _env_bool("ST_COOKIE_SECURE", default=True)
