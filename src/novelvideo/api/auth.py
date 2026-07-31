"""API credential authentication.

Final runtime contract:
1. Browser UI uses the HttpOnly ``st_session`` cookie backed by PG sessions.
2. Agents use short-lived ``Authorization: Bearer`` agent session tokens.

Long-lived external agent keys are deliberately not accepted here. They are
only provisioning credentials for ``POST /api/v1/agent/sessions``.
"""

from __future__ import annotations

import logging
import re
from typing import Callable, Optional
from urllib.parse import unquote

from fastapi import Depends, HTTPException, Request

from novelvideo.ports import get_auth_port, get_auth_session_port
from novelvideo.ports import registry as port_registry
from novelvideo.ports.auth_contract import AuthError, AuthFailureReason

logger = logging.getLogger("novelvideo.api.auth")

AUTH_COOKIE_NAME = "st_session"

UNSAFE_METHODS = {"POST", "PUT", "PATCH", "DELETE"}
AGENT_WRITE_SCOPES = {"projects:write", "tasks:submit"}
PROJECT_PATH_RE = re.compile(r"/projects/([^/]+)")
UNSUPPORTED_QUERY_CREDENTIALS = {"token", "access_token", "api_key"}
_EFFECTIVE_ACCESS_DENIED = "effective access denied"


def _bearer_token_from_request(request: Request) -> Optional[str]:
    value = request.headers.get("Authorization", "").strip()
    if not value:
        return None
    scheme, _, token = value.partition(" ")
    if scheme.lower() != "bearer" or not token.strip():
        return None
    return token.strip()


async def _verify_browser_session(raw_cookie: str | None) -> dict:
    """Verify the browser session cookie."""
    try:
        return await get_auth_port().verify_session(raw_cookie)
    except port_registry.PortNotRegistered:
        raise HTTPException(status_code=503, detail="auth backend not initialised")
    except AuthError as exc:
        if exc.reason == AuthFailureReason.MISSING:
            raise HTTPException(
                status_code=401, detail="Missing session or agent token"
            )
        if (
            exc.reason == AuthFailureReason.USER_SUSPENDED
            or exc.detail == _EFFECTIVE_ACCESS_DENIED
        ):
            raise HTTPException(status_code=403, detail="Access denied")
        raise HTTPException(status_code=401, detail="Invalid session")
    except Exception:
        raise HTTPException(
            status_code=503, detail="Authentication service unavailable"
        ) from None


async def _verify_agent_bearer(token: str) -> dict:
    """Verify an agent session token. No legacy fallback by design."""
    try:
        return await get_auth_session_port().verify_agent_session(token)
    except port_registry.PortNotRegistered:
        raise HTTPException(
            status_code=401, detail="Agent sessions require control plane"
        )
    except AuthError as exc:
        if (
            exc.reason == AuthFailureReason.USER_SUSPENDED
            or exc.detail == _EFFECTIVE_ACCESS_DENIED
        ):
            raise HTTPException(status_code=403, detail="Access denied")
        raise HTTPException(status_code=401, detail="Invalid agent session")
    except Exception:
        raise HTTPException(
            status_code=503, detail="Authentication service unavailable"
        ) from None


def _reject_unsupported_credential_classes(request: Request) -> None:
    if request.headers.get("X-API-Key"):
        raise HTTPException(status_code=401, detail="Unsupported credential")
    if any(name in request.query_params for name in UNSUPPORTED_QUERY_CREDENTIALS):
        raise HTTPException(status_code=401, detail="Unsupported credential")


def _enforce_agent_request_boundary(request: Request, user: dict) -> None:
    """Central guard for agent sessions on legacy routes.

    Route-level ``require_scope`` is still preferred because it gives precise
    business intent. This guard prevents gaps while existing routes are migrated:
    an agent cannot access a different project than its server-assigned scope,
    and it cannot perform unsafe writes without a write scope.
    """

    if user.get("credential_kind") != "agent_session":
        return

    match = PROJECT_PATH_RE.search(request.url.path)
    if match:
        requested_project = unquote(match.group(1))
        current_kind = str(user.get("current_scope_kind") or "home")
        current_project = user.get("current_project_id")
        if current_kind != "project" or current_project != requested_project:
            raise HTTPException(
                status_code=403,
                detail="Agent session scope mismatch",
            )

    if request.method.upper() in UNSAFE_METHODS:
        scopes = set(user.get("scopes") or [])
        if scopes.isdisjoint(AGENT_WRITE_SCOPES):
            raise HTTPException(status_code=403, detail="agent write scope missing")


async def get_api_user(
    request: Request,
) -> dict:
    """Verify browser session or agent session credentials."""
    _reject_unsupported_credential_classes(request)
    bearer = _bearer_token_from_request(request)
    if bearer:
        user = await _verify_agent_bearer(bearer)
        _enforce_agent_request_boundary(request, user)
        return user

    return await _verify_browser_session(request.cookies.get(AUTH_COOKIE_NAME))


async def get_api_user_or_query(
    request: Request,
) -> dict:
    """SSE/EventSource variant.

    Browser EventSource authenticates with the same HttpOnly cookie. Agents
    should use normal HTTP polling or fetch streaming with Authorization.
    """
    return await get_api_user(request)


def resolve_auth_cookie_from_request(request: Request) -> Optional[str]:
    """Resolve the browser session cookie outside FastAPI dependency injection."""
    return request.cookies.get(AUTH_COOKIE_NAME)


def require_scope(needed: str) -> Callable[[dict], dict]:
    """FastAPI dependency factory for scoped credentials.

    Browser sessions return no ``scopes`` field and are authorized by normal
    project access checks. Agent sessions carry scopes and must include
    ``needed``.
    """

    async def _check(user: dict = Depends(get_api_user)) -> dict:
        scopes = user.get("scopes")
        if scopes is None:
            return user
        if needed not in scopes:
            raise HTTPException(
                status_code=403,
                detail=f"scope missing: '{needed}' (token has {scopes})",
            )
        return user

    return _check


def require_project_scope(needed: str) -> Callable[[str, dict], dict]:
    """Scoped write dependency for ``/projects/{project}/...`` endpoints.

    Browser sessions retain current behavior. Agent sessions must both carry
    ``needed`` and have their server-maintained active scope set to the same
    project. The active scope is updated by the chat orchestrator when the user
    switches canvases/projects, not by agent input.
    """

    async def _check(project: str, user: dict = Depends(require_scope(needed))) -> dict:
        if user.get("credential_kind") != "agent_session":
            return user
        current_kind = str(user.get("current_scope_kind") or "home")
        current_project = user.get("current_project_id")
        if current_kind != "project" or current_project != project:
            raise HTTPException(
                status_code=403,
                detail=(
                    "agent session scope mismatch: "
                    f"current={current_kind}:{current_project}, requested=project:{project}"
                ),
            )
        return user

    return _check


async def verify_credential_for_request(request: Request) -> dict | None:
    """Best-effort credential recheck for middleware / long-lived streams."""
    try:
        return await get_api_user(request)
    except Exception:  # noqa: BLE001 - middleware fallback path
        return None
