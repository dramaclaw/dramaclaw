"""P0-3: 项目生命周期/永久删除必须与 projects:write 拆分为独立 scope。

安全目标:Hermes / 外部 agent 默认只持有读写与任务 scope,永不持有
``projects:lifecycle`` 或 ``projects:purge``。因此 agent 请求归档/删除/恢复/
purge 时必须收到明确的 403,而浏览器用户(无 scopes)照常放行。
"""

from __future__ import annotations

import pytest
from fastapi import HTTPException

from types import SimpleNamespace

from novelvideo.api.auth import _enforce_agent_request_boundary, require_scope

LIFECYCLE_SCOPE = "projects:lifecycle"
PURGE_SCOPE = "projects:purge"


def _agent_user(*scopes: str) -> dict:
    return {
        "credential_kind": "agent_session",
        "username": "alice",
        "scopes": list(scopes),
        "current_scope_kind": "project",
        "current_project_id": "demo",
    }


def _browser_user() -> dict:
    # 浏览器会话不带 scopes 字段,由常规项目访问校验授权。
    return {"credential_kind": "browser", "username": "alice"}


async def _run(scope: str, user: dict) -> dict:
    check = require_scope(scope)
    return await check(user=user)


@pytest.mark.asyncio
@pytest.mark.parametrize("scope", [LIFECYCLE_SCOPE, PURGE_SCOPE])
async def test_write_scoped_agent_is_rejected_for_lifecycle_and_purge(scope: str) -> None:
    user = _agent_user("projects:read", "projects:write", "tasks:submit")
    with pytest.raises(HTTPException) as excinfo:
        await _run(scope, user)
    assert excinfo.value.status_code == 403
    assert scope in str(excinfo.value.detail)


@pytest.mark.asyncio
@pytest.mark.parametrize("scope", [LIFECYCLE_SCOPE, PURGE_SCOPE])
async def test_browser_session_passes_lifecycle_and_purge(scope: str) -> None:
    user = _browser_user()
    assert await _run(scope, user) is user


@pytest.mark.asyncio
async def test_lifecycle_scope_does_not_imply_purge() -> None:
    # 持有 lifecycle 的 token 仍不能 purge:两个 scope 相互独立。
    user = _agent_user("projects:read", "projects:write", LIFECYCLE_SCOPE)
    with pytest.raises(HTTPException) as excinfo:
        await _run(PURGE_SCOPE, user)
    assert excinfo.value.status_code == 403


@pytest.mark.asyncio
async def test_explicitly_scoped_agent_is_allowed() -> None:
    user = _agent_user("projects:read", PURGE_SCOPE)
    assert await _run(PURGE_SCOPE, user) is user


def _request(method: str, path: str) -> SimpleNamespace:
    # _enforce_agent_request_boundary only touches request.method and
    # request.url.path — a namespace is enough and keeps the test hermetic.
    return SimpleNamespace(method=method, url=SimpleNamespace(path=path))


def test_central_guard_admits_purge_only_agent_on_unsafe_write() -> None:
    """Regression for the AGENT_WRITE_SCOPES gap.

    ``_enforce_agent_request_boundary`` runs inside ``get_api_user`` *before* the
    route's own ``require_scope`` check. It rejects any agent unsafe write whose
    scopes are disjoint from ``AGENT_WRITE_SCOPES``. When that set only listed
    ``projects:write``/``tasks:submit``, a token holding exactly the scope the
    purge route requires — ``[projects:read, projects:purge]`` — was 403'd here
    before its route ever ran. The per-route ``require_scope`` tests stayed green
    and never saw this, which is why the bug shipped. This asserts the central
    guard now lets the correctly-scoped token through.
    """
    user = {
        "credential_kind": "agent_session",
        "username": "alice",
        "scopes": ["projects:read", PURGE_SCOPE],
        "current_scope_kind": "project",
        "current_project_id": "demo",
    }
    # Must not raise: the guard admits it, the route-level scope check enforces
    # the exact scope afterwards.
    _enforce_agent_request_boundary(_request("DELETE", "/api/v1/projects/demo/purge"), user)


def test_central_guard_admits_lifecycle_only_agent_on_unsafe_write() -> None:
    user = {
        "credential_kind": "agent_session",
        "username": "alice",
        "scopes": ["projects:read", LIFECYCLE_SCOPE],
        "current_scope_kind": "project",
        "current_project_id": "demo",
    }
    _enforce_agent_request_boundary(
        _request("POST", "/api/v1/projects/demo/archive"), user
    )


def test_central_guard_still_rejects_agent_without_any_write_scope() -> None:
    # A read-only agent token must still be blocked by the backstop on writes.
    user = {
        "credential_kind": "agent_session",
        "username": "alice",
        "scopes": ["projects:read"],
        "current_scope_kind": "project",
        "current_project_id": "demo",
    }
    with pytest.raises(HTTPException) as excinfo:
        _enforce_agent_request_boundary(
            _request("DELETE", "/api/v1/projects/demo/purge"), user
        )
    assert excinfo.value.status_code == 403


def test_agent_write_scopes_covers_every_split_route_scope() -> None:
    # If a future split adds a new precise write scope to a route but forgets the
    # central backstop, that route becomes unreachable for its own token. Pin the
    # invariant: every scope the split routes require is admitted by the backstop.
    from novelvideo.api.auth import AGENT_WRITE_SCOPES

    assert {LIFECYCLE_SCOPE, PURGE_SCOPE} <= AGENT_WRITE_SCOPES


def test_default_agent_scope_lists_exclude_lifecycle_and_purge() -> None:
    from novelvideo.chat.hermes_pool import HERMES_DEFAULT_SCOPES
    from novelvideo.chat.service import PAGE_AGENT_SCOPES
    from novelvideo.ports.auth_contract import DEFAULT_EXTERNAL_AGENT_SCOPES

    for scopes in (
        HERMES_DEFAULT_SCOPES,
        PAGE_AGENT_SCOPES,
        DEFAULT_EXTERNAL_AGENT_SCOPES,
    ):
        assert LIFECYCLE_SCOPE not in scopes
        assert PURGE_SCOPE not in scopes


def test_lifecycle_and_purge_routes_use_split_scopes() -> None:
    # 直接从路由依赖里读回 scope,防止有人把守卫改回 projects:write。
    from novelvideo.api.routes import projects as projects_routes

    wanted = {
        "archive_project": LIFECYCLE_SCOPE,
        "unarchive_project": LIFECYCLE_SCOPE,
        "soft_delete_project": LIFECYCLE_SCOPE,
        "restore_project": LIFECYCLE_SCOPE,
        "purge_project": PURGE_SCOPE,
    }
    routes = {r.name: r for r in projects_routes.router.routes if getattr(r, "name", None) in wanted}
    assert set(routes) == set(wanted), f"missing routes: {set(wanted) - set(routes)}"
    for name, scope in wanted.items():
        scopes = {
            getattr(dep.call, "_required_scope", None)
            for dep in routes[name].dependant.dependencies
        }
        assert scope in scopes, f"{name} should require {scope}, got {scopes}"
