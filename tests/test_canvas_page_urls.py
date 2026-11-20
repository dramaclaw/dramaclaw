# SPDX-License-Identifier: Elastic-2.0
# Copyright (c) 2026 ClaymoreLab
"""Public canvas links at the configuration and HTTP boundaries."""

import logging
from importlib import import_module
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import UUID

import pytest
from fastapi.testclient import TestClient

from novelvideo.api import freezone_server_workflow_start
from novelvideo.api.routes import freezone as routes
from novelvideo.freezone import canvas_confirmations
from novelvideo.freezone.canvas_presence import touch_canvas_presence
from test_canvas_confirmation_routes import BASE, DELETE, PAID, _harness, create, decide
from test_canvas_confirmation_routes import setup as setup
from test_freezone_plugin_canvas_create_tools import LOCAL_AGENT, _seed
from test_freezone_plugin_canvas_create_tools import agent as agent, pool as pool
from test_freezone_plugin import _restore_tools_registry_modules as _restore_tools_registry_modules

PUBLIC = "DRAMACLAW_PUBLIC_ORIGIN"
STUDIO = "SUPERTALE_OPENFILM_STUDIO_PUBLIC_ORIGIN"
ORIGIN = "https://app.example.com:8443"
FORGED = "https://forged.example"
FORGED_FIELDS = {key: FORGED for key in ("canvas_url", "origin", "public_origin")}
FORGED_HEADERS = {
    "Host": "forged.example",
    "Origin": FORGED,
    "X-Forwarded-Host": "forwarded.example",
    "X-Forwarded-Proto": "http",
}


@pytest.fixture(autouse=True)
def clear_origins(monkeypatch):
    from novelvideo.freezone import canvas_links

    monkeypatch.setattr(canvas_links, "_warned_values", set())
    for name in (PUBLIC, STUDIO, "SUPERTALE_OPENFILM_STUDIO_PREVIEW_ORIGIN"):
        monkeypatch.delenv(name, raising=False)


@pytest.mark.parametrize(("value", "expected"), [
    ("https://App.Example.com", "https://App.Example.com"),
    ("http://localhost:8780", "http://localhost:8780"),
    ("https://app.example.com/", "https://app.example.com"),
])
def test_public_origin_accepts_http_origins(monkeypatch, value, expected):
    from novelvideo.freezone import canvas_links

    monkeypatch.setenv(PUBLIC, value)
    assert canvas_links.public_origin() == expected


def test_public_origin_precedence_and_runtime_fallback(monkeypatch):
    from novelvideo.freezone import canvas_links

    assert canvas_links.public_origin() is None
    monkeypatch.setenv(STUDIO, "https://studio.example.com/")
    assert canvas_links.public_origin() == "https://studio.example.com"
    monkeypatch.setenv(PUBLIC, ORIGIN)
    assert canvas_links.public_origin() == ORIGIN
    monkeypatch.setenv(PUBLIC, "  ")
    assert canvas_links.public_origin() == "https://studio.example.com"


def test_invalid_public_origins_warn_once_without_falling_back(monkeypatch, caplog):
    from novelvideo.freezone import canvas_links

    monkeypatch.setenv(STUDIO, ORIGIN)
    invalid = (
        "https://bad.example/path", "https://bad.example/?token=private",
        "https://bad.example/#fragment", "https://user:private@bad.example",
        "ftp://bad.example", "https:///missing-host", "https://bad .example",
        "https://bad.example\n", "https://bad.example:65536", "https://bad.example:abc",
    )
    with caplog.at_level(logging.WARNING):
        for value in (*invalid, *invalid):
            monkeypatch.setenv(PUBLIC, value)
            assert canvas_links.public_origin() is None
    warnings = [record.message for record in caplog.records if record.levelno == logging.WARNING]
    assert len(warnings) == len(invalid)
    for warning in warnings:
        assert PUBLIC in warning and "invalid" in warning.lower()
        assert all(part not in warning for part in ("bad.example", "private", "missing-host"))


def test_canvas_page_url_percent_encodes_both_identifiers(monkeypatch):
    from novelvideo.freezone import canvas_links

    assert canvas_links.canvas_page_url("a", "b") is None
    monkeypatch.setenv(PUBLIC, ORIGIN)
    assert canvas_links.canvas_page_url("影片 /?", "a+b/#") == (
        f"{ORIGIN}/projects/%E5%BD%B1%E7%89%87%20%2F%3F/freezone?canvas=a%2Bb%2F%23"
    )


@pytest.mark.parametrize(("value", "reason"), [
    pytest.param("ftp://bad.example", "scheme must be http or https", id="scheme"),
    pytest.param("https:///missing-host", "has no host", id="host"),
    pytest.param("https://user:private@bad.example", "has user info", id="user-info"),
    pytest.param("https://bad.example/path", "has a path", id="path"),
    pytest.param("https://bad.example/?token=private", "has a query", id="query"),
    pytest.param("https://bad.example/#fragment", "has a fragment", id="fragment"),
    pytest.param("https://bad.example:65536", "has an invalid port", id="port"),
    pytest.param(
        "https://bad .example", "contains whitespace or control characters", id="whitespace",
    ),
])
def test_invalid_public_origin_warns_at_startup_and_suppresses_request_warning(
    setup, monkeypatch, caplog, value, reason,
):
    from novelvideo.freezone import canvas_links

    monkeypatch.setenv(PUBLIC, value)
    monkeypatch.setenv(STUDIO, ORIGIN)
    monkeypatch.setattr(routes, "execute_agent_canvas_envelopes", AsyncMock(return_value={
        "status": "applied", "revision": 7, "receipt": {"applied": True},
    }))

    canvas_links.warn_if_public_origin_invalid()

    warnings = caplog.record_tuples
    assert len(warnings) == 1
    _, level, message = warnings[0]
    assert level == logging.WARNING
    assert PUBLIC in message and reason in message
    assert "canvas_url" in message and "until" in message and "fixed" in message
    assert value not in message

    assert canvas_links.public_origin() is None
    assert canvas_links.canvas_page_url("demo", "default") is None
    data = _data(setup.client.post(
        BASE + "/agent-commands",
        json={"envelopes": [{"commands": [{"type": "select_nodes", "node_ids": ["n1"]}]}]},
    ))
    assert data["status"] == "applied"
    assert "canvas_url" not in data
    assert caplog.record_tuples == warnings

    canvas_links.warn_if_public_origin_invalid()
    assert caplog.record_tuples == warnings


def test_startup_warning_names_studio_fallback(monkeypatch, caplog):
    from novelvideo.freezone import canvas_links

    value = "https://studio.example.com/path"
    monkeypatch.setenv(STUDIO, value)

    canvas_links.warn_if_public_origin_invalid()

    [(_, level, message)] = caplog.record_tuples
    assert level == logging.WARNING
    assert STUDIO in message and PUBLIC not in message
    assert "has a path" in message
    assert value not in message


@pytest.mark.parametrize("value", [ORIGIN, None], ids=["valid", "unset"])
def test_startup_warning_is_silent_for_valid_or_unset_origin(monkeypatch, caplog, value):
    from novelvideo.freezone import canvas_links

    if value is not None:
        monkeypatch.setenv(PUBLIC, value)

    canvas_links.warn_if_public_origin_invalid()

    assert not caplog.records


async def test_api_startup_warns_about_invalid_public_origin_before_bootstrap(monkeypatch, caplog):
    from novelvideo.freezone import canvas_core_pool
    from novelvideo.ports import registry

    def stop_bootstrap():
        raise RuntimeError("stop at bootstrap")

    monkeypatch.setenv(PUBLIC, "https://bad.example/path")
    monkeypatch.setenv("DRAMACLAW_AGENT_CANVAS_EXECUTOR", "browser")
    monkeypatch.setattr(canvas_core_pool, "canvas_core_unavailable_reason", lambda: None)
    monkeypatch.setattr(registry, "ensure_bootstrap", stop_bootstrap)
    app = import_module("novelvideo.api.app").create_app()

    for _ in range(2):
        with pytest.raises(RuntimeError, match="stop at bootstrap"):
            async with app.router.lifespan_context(app):
                pytest.fail("Startup did not reach bootstrap")

    warnings = [message for _, level, message in caplog.record_tuples if level == logging.WARNING]
    assert len(warnings) == 1
    assert PUBLIC in warnings[0] and "has a path" in warnings[0]


def _link(project, canvas_id):
    return f"{ORIGIN}/projects/{project}/freezone?canvas={canvas_id}"


def _data(response):
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["ok"] is True, payload
    return payload["data"]


def _assert_link_only(before, after, expected):
    assert "canvas_url" not in before
    assert {key: value for key, value in after.items() if key != "canvas_url"} == before
    assert after["canvas_url"] == expected


@pytest.mark.parametrize("status", ["created", "exists", "rejected"])
def test_create_route_links_only_successful_creation(setup, monkeypatch, status):
    result = SimpleNamespace(
        status=status, canvas_id="canvas_a", display_name="Plan", revision=1,
        rejection={"code": "duplicate_name"},
        plan_payload={"schema_version": 2, "canvas_id": "canvas_a", "nodes": [], "edges": []},
        saved=None,
    )
    monkeypatch.setattr(routes, "create_user_canvas", AsyncMock(return_value=result))
    monkeypatch.setattr(routes, "_after_canvas_save", AsyncMock())

    def request():
        return _data(setup.client.post(
            "/projects/proj/freezone/canvases:create",
            json={"name": "Plan", "request_id": "plan"}, params=FORGED_FIELDS,
            headers=FORGED_HEADERS,
        ))

    before = request()
    monkeypatch.setenv(PUBLIC, ORIGIN)
    after = request()
    assert after["status"] == status
    if status == "rejected":
        assert "canvas_url" not in after
        assert after == before
    else:
        _assert_link_only(before, after, _link("proj", "canvas_a"))


def test_list_route_links_each_canvas(agent, monkeypatch):
    _seed(agent.root, "canvas_a")
    agent.user = dict(LOCAL_AGENT)

    def request():
        return agent.plugin._request("GET", "/api/v1/projects/proj/freezone/canvases:agent-view")

    before = request()
    monkeypatch.setenv(PUBLIC, ORIGIN)
    after = request()
    assert before["ok"] is after["ok"] is True
    before_rows = before["data"]["canvases"]
    after_rows = after["data"]["canvases"]
    assert {row["canvas_id"] for row in before_rows} == {"default", "canvas_a"}
    assert len(after_rows) == len(before_rows)
    assert {
        key: value for key, value in after["data"].items() if key != "canvases"
    } == {
        key: value for key, value in before["data"].items() if key != "canvases"
    }
    for old, new in zip(before_rows, after_rows, strict=True):
        _assert_link_only(old, new, _link("proj", old["canvas_id"]))


@pytest.mark.parametrize(("project", "canvas_id"), [("proj", "canvas_a"), ("other", "canvas_b")])
def test_command_route_uses_url_scope_and_ignores_request_origin(
    setup, monkeypatch, project, canvas_id,
):
    stored = {"status": "applied", "revision": 7, "receipt": {"applied": True}}
    execute = AsyncMock(return_value=stored)
    monkeypatch.setattr(routes, "execute_agent_canvas_envelopes", execute)

    def request():
        return _data(setup.client.post(
            f"/projects/{project}/freezone/canvases/{canvas_id}/agent-commands",
            params=FORGED_FIELDS, headers=FORGED_HEADERS,
            json={"envelopes": [{"commands": [{"type": "select_nodes", "node_ids": ["n1"]}]}],
                  **FORGED_FIELDS},
        ))

    before = request()
    monkeypatch.setenv(PUBLIC, ORIGIN)
    after = request()
    assert execute.call_args.kwargs["project"] == project
    assert execute.call_args.kwargs["canvas_id"] == canvas_id
    assert stored == before
    _assert_link_only(before, after, _link(project, canvas_id))


@pytest.mark.parametrize(
    "status", ["executed", "running", "submitted", "refused", "already_completed"],
)
def test_confirmation_route_links_only_confirmed_work(tmp_path, monkeypatch, status):
    monkeypatch.setattr(canvas_confirmations, "uuid4", lambda: UUID(int=1))
    if status == "running":
        monkeypatch.setattr(
            freezone_server_workflow_start, "start_server_workflow_run",
            AsyncMock(return_value={"run_id": "run_test"}),
        )

    def request(root):
        harness = _harness(root, monkeypatch.setattr, monkeypatch.setenv)
        if status == "submitted":
            monkeypatch.setenv("DRAMACLAW_AGENT_CANVAS_EXECUTOR", "browser")
            touch_canvas_presence(root, "default", "browser", now=1000)
        if status == "already_completed":
            harness.pool.plan.update(actions=[], levels=[], already_completed=True)
        commands = {
            "running": PAID, "submitted": PAID,
            "already_completed": [{"type": "run_workflow", "scope": "canvas"}],
        }.get(status, DELETE)
        with TestClient(harness.app) as client:
            harness.client = client
            created = create(harness, commands=commands)
            data = _data(decide(
                harness, created, decision="refused" if status == "refused" else "confirmed",
            ))
        assert data["status"] == status
        assert data["confirmation_id"] == created["confirmation_id"]
        assert harness.queued == []
        return data

    before = request(tmp_path / "before")
    monkeypatch.setenv(PUBLIC, ORIGIN)
    after = request(tmp_path / "after")
    if status in {"executed", "running", "submitted"}:
        _assert_link_only(before, after, _link("proj", "default"))
    else:
        assert "canvas_url" not in after
        assert after == before


@pytest.mark.parametrize("route", ["workflow", "context"])
def test_opt_in_routes_preserve_legacy_bytes(setup, monkeypatch, route):
    if route == "workflow":
        async def resolve(*_args, **_kwargs):
            return setup.ctx, "owner", "demo", setup.root, str(setup.root)

        monkeypatch.setattr(routes, "_resolve_freezone_project", resolve)
        monkeypatch.setattr(routes, "get_canvas_workflow_runs", AsyncMock())
        monkeypatch.setattr(routes, "read_workflow_run", lambda **_: {
            "run_id": "run_test", "status": "running", "actions": [],
        })

        def request(flag=None, view="summary"):
            params = {"view": view, **FORGED_FIELDS}
            if flag is not None:
                params["include_canvas_url"] = str(flag).lower()
            return setup.client.get(
                BASE + "/workflow-runs/run_test", params=params, headers=FORGED_HEADERS,
            )
    else:
        context = {"ok": True, "responses": [{"type": "canvas_summary"}], "errors": []}
        monkeypatch.setattr(routes, "_read_canvas_payload", AsyncMock(return_value={}))
        monkeypatch.setattr(routes, "answer_agent_canvas_context", AsyncMock(return_value=context))

        def request(flag=None):
            body = {"requests": [{"type": "canvas_summary"}], **FORGED_FIELDS}
            if flag is not None:
                body["include_canvas_url"] = flag
            return setup.client.post(BASE + "/agent-context", json=body, headers=FORGED_HEADERS)

    legacy = request()
    before = _data(legacy)
    assert "canvas_url" not in before
    assert request(True).content == legacy.content
    full = request(view="full").content if route == "workflow" else None
    monkeypatch.setenv(PUBLIC, ORIGIN)
    assert request().content == legacy.content
    assert request(False).content == legacy.content
    if route == "workflow":
        assert request(True, view="full").content == full
    _assert_link_only(before, _data(request(True)), _link("proj", "default"))


def test_external_create_tool_returns_the_real_api_link(agent, monkeypatch):
    monkeypatch.setenv("DRAMACLAW_EXTERNAL_MCP", "1")
    monkeypatch.delenv("DRAMACLAW_TURN_ID")
    monkeypatch.setenv(PUBLIC, ORIGIN)
    agent.user = dict(LOCAL_AGENT)
    result = agent.call("freezone_create_canvas", {"name": "Plan"})
    assert result["ok"] is True, result
    assert result["canvas_url"] == _link("proj", result["canvas_id"])


@pytest.mark.parametrize("origin", [None, ORIGIN], ids=["unset", "configured"])
def test_confirmation_creation_route_includes_configured_canvas_link(setup, monkeypatch, origin):
    if origin is not None:
        monkeypatch.setenv(PUBLIC, origin)

    data = create(setup)
    assert data["confirmation_id"]
    if origin is None:
        assert "canvas_url" not in data
    else:
        assert data["canvas_url"] == _link("proj", "default")
