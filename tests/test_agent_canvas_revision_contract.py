"""Agent-facing canvas revision contracts.

These tests use the real MCP adapter and plugin handler, but replace HTTP calls.
They deliberately do not ask an LLM to infer a revision: a missing revision must
remain missing until the API supplies an authoritative value.
"""

from __future__ import annotations

import json

import pytest
from jsonschema import Draft202012Validator

from novelvideo.chat import dramaclaw_mcp
from novelvideo.freezone import canvas_store


CANVAS_ID = "canvas-a"
CANVAS_PATH = f"/api/v1/projects/project-a/freezone/canvases/{CANVAS_ID}"


@pytest.fixture(autouse=True)
def project_scope(monkeypatch):
    monkeypatch.setenv("DRAMACLAW_PROJECT_ID", "project-a")


@pytest.fixture
def canvas_mcp(project_scope):
    return dramaclaw_mcp._plugin("dramaclaw")


def _read_schema():
    return dramaclaw_mcp._output_schema_for_tool("dramaclaw_get_freezone_canvas")


def _canvas_response(*, revision=1, include_revision=True):
    data = {"nodes": [], "edges": [], "viewport": None, "metadata": None}
    if include_revision:
        data["revision"] = revision
    return {"ok": True, "data": data}


@pytest.mark.asyncio
@pytest.mark.parametrize("revision", [1, 2, 10, 2**31])
async def test_canvas_read_preserves_authoritative_revision(
    canvas_mcp, monkeypatch, revision
):
    calls = []

    def request(method, path, **kwargs):
        calls.append((method, path, kwargs))
        return _canvas_response(revision=revision)

    monkeypatch.setattr(canvas_mcp, "_request", request)
    result = await dramaclaw_mcp.call_tool(
        "dramaclaw_get_freezone_canvas", {"canvas_id": CANVAS_ID}
    )

    assert result.isError is False
    assert result.structuredContent["revision"] == revision
    assert result.structuredContent["canvas_id"] == CANVAS_ID
    assert calls == [("GET", CANVAS_PATH, {})]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "response",
    [
        _canvas_response(include_revision=False),
        _canvas_response(revision=None),
        _canvas_response(revision=0),
        _canvas_response(revision=-1),
        _canvas_response(revision=True),
        _canvas_response(revision="1"),
    ],
)
async def test_canvas_read_fails_closed_without_valid_revision(canvas_mcp, monkeypatch, response):
    monkeypatch.setattr(canvas_mcp, "_request", lambda *_args, **_kwargs: response)

    result = await dramaclaw_mcp.call_tool(
        "dramaclaw_get_freezone_canvas", {"canvas_id": CANVAS_ID}
    )

    assert result.isError is True
    assert result.structuredContent["ok"] is False
    assert "revision" not in result.structuredContent
    assert "do not infer" in result.structuredContent["error"]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "response",
    [None, {}, {"data": {"nodes": [], "edges": [], "revision": 1}}],
)
async def test_canvas_read_rejects_malformed_api_envelope(
    canvas_mcp, monkeypatch, response
):
    monkeypatch.setattr(canvas_mcp, "_request", lambda *_args, **_kwargs: response)
    result = await dramaclaw_mcp.call_tool(
        "dramaclaw_get_freezone_canvas", {"canvas_id": CANVAS_ID}
    )
    assert result.isError is True
    assert result.structuredContent["ok"] is False
    assert "invalid API response" in result.structuredContent["error"]


@pytest.mark.parametrize("revision", [1, 2, 10])
def test_read_output_schema_accepts_real_revisions(revision):
    payload = {
        "ok": True,
        "status": "completed",
        "canvas_id": CANVAS_ID,
        "nodes": [],
        "edges": [],
        "revision": revision,
    }
    Draft202012Validator(_read_schema()).validate(payload)


def test_agent_read_contract_rejects_missing_revision():
    payload = {
        "ok": True,
        "status": "completed",
        "canvas_id": CANVAS_ID,
        "nodes": [],
        "edges": [],
    }
    assert list(Draft202012Validator(_read_schema()).iter_errors(payload))


def test_agent_read_contract_rejects_null_revision():
    payload = {
        "ok": True,
        "status": "completed",
        "canvas_id": CANVAS_ID,
        "nodes": [],
        "edges": [],
        "revision": None,
    }
    assert list(Draft202012Validator(_read_schema()).iter_errors(payload))


def test_agent_read_contract_rejects_negative_revision():
    payload = {
        "ok": True,
        "status": "completed",
        "canvas_id": CANVAS_ID,
        "nodes": [],
        "edges": [],
        "revision": -1,
    }
    assert list(Draft202012Validator(_read_schema()).iter_errors(payload))


@pytest.mark.parametrize("revision", [False, True, "1", 1.5, [], {}])
def test_agent_read_contract_rejects_wrong_revision_types(revision):
    payload = {
        "ok": True,
        "status": "completed",
        "canvas_id": CANVAS_ID,
        "nodes": [],
        "edges": [],
        "revision": revision,
    }
    assert list(Draft202012Validator(_read_schema()).iter_errors(payload))


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "base_revision", [None, 0, -1, False, True, "0", "1", 1.5, [], {}]
)
async def test_canvas_save_rejects_untrusted_base_revision_before_http(
    canvas_mcp, monkeypatch, base_revision
):
    calls = []
    monkeypatch.setattr(
        canvas_mcp, "_request", lambda *args, **kwargs: calls.append((args, kwargs))
    )
    result = await dramaclaw_mcp.call_tool(
        "dramaclaw_save_freezone_canvas",
        {
            "canvas_id": CANVAS_ID,
            "payload": {
                "nodes": [],
                "edges": [],
                "viewport": None,
                "metadata": None,
                "base_revision": base_revision,
                "client_save_id": "save-1",
            },
        },
    )
    assert result.isError is True
    assert calls == []


@pytest.mark.asyncio
@pytest.mark.parametrize("base_revision", [1, 2, 10])
async def test_canvas_save_passes_explicit_revision_unchanged(
    canvas_mcp, monkeypatch, base_revision
):
    calls = []

    def request(method, path, *, body=None, **_kwargs):
        calls.append((method, path, body))
        return {"ok": True, "data": {"saved": True, "revision": base_revision + 1}}

    monkeypatch.setattr(canvas_mcp, "_request", request)
    result = await dramaclaw_mcp.call_tool(
        "dramaclaw_save_freezone_canvas",
        {
            "canvas_id": CANVAS_ID,
            "payload": {
                "nodes": [],
                "edges": [],
                "viewport": None,
                "metadata": None,
                "base_revision": base_revision,
                "client_save_id": "save-1",
            },
        },
    )
    assert result.isError is False
    assert calls[0][0:2] == ("PUT", CANVAS_PATH)
    assert calls[0][2]["base_revision"] == base_revision


@pytest.mark.asyncio
async def test_agent_can_create_read_then_save_without_guessing_revision(
    canvas_mcp, monkeypatch
):
    calls = []

    def request(method, path, *, body=None, **_kwargs):
        calls.append((method, path, body))
        if method == "POST" and path.endswith("/freezone/canvases:from-preset"):
            return {"ok": True, "data": {"canvas_id": CANVAS_ID, "revision": 1}}
        if method == "GET" and path == CANVAS_PATH:
            return _canvas_response(revision=1)
        if method == "PUT" and path == CANVAS_PATH:
            assert body["base_revision"] == 1
            return {"ok": True, "data": {"saved": True, "revision": 2}}
        raise AssertionError(f"unexpected request: {method} {path}")

    monkeypatch.setattr(canvas_mcp, "_request", request)
    created = await dramaclaw_mcp.call_tool(
        "dramaclaw_create_freezone_canvas_from_preset",
        {"preset": {"scope": "blank", "canvas_id": CANVAS_ID}},
    )
    assert created.isError is False
    read = await dramaclaw_mcp.call_tool(
        "dramaclaw_get_freezone_canvas", {"canvas_id": CANVAS_ID}
    )
    assert read.structuredContent["revision"] == 1
    saved = await dramaclaw_mcp.call_tool(
        "dramaclaw_save_freezone_canvas",
        {
            "canvas_id": CANVAS_ID,
            "payload": {
                "nodes": [],
                "edges": [],
                "viewport": None,
                "metadata": None,
                "base_revision": read.structuredContent["revision"],
                "client_save_id": "save-1",
            },
        },
    )
    assert saved.isError is False
    assert saved.structuredContent["revision"] == 2
    assert [call[0] for call in calls] == ["POST", "GET", "PUT"]


@pytest.mark.parametrize("current_revision", [1, 2, 10])
def test_store_rejects_agent_guess_zero_for_existing_canvas(current_revision):
    with pytest.raises(canvas_store.CanvasRevisionConflict) as error:
        canvas_store._check_revision({"revision": current_revision}, 0)
    assert error.value.current_revision == current_revision
    assert error.value.base_revision == 0


def test_default_canvas_starts_at_revision_one():
    assert canvas_store.default_canvas_payload(project_id="project-a")[
        "revision"
    ] == 1


@pytest.mark.parametrize(
    "response",
    [
        {"ok": False, "error": "not found"},
        {"ok": False, "message": "canvas read failed"},
    ],
)
@pytest.mark.asyncio
async def test_canvas_read_failure_is_not_reported_as_success(
    canvas_mcp, monkeypatch, response
):
    monkeypatch.setattr(canvas_mcp, "_request", lambda *_args, **_kwargs: response)
    result = await dramaclaw_mcp.call_tool(
        "dramaclaw_get_freezone_canvas", {"canvas_id": CANVAS_ID}
    )
    assert result.isError is True
    assert result.structuredContent["ok"] is False
    assert "revision" not in result.structuredContent


def test_missing_revision_is_explained_in_unmodified_tool_text(canvas_mcp, monkeypatch):
    monkeypatch.setattr(
        canvas_mcp, "_request", lambda *_args, **_kwargs: _canvas_response(include_revision=False)
    )
    raw = canvas_mcp._handle_get_freezone_canvas({"canvas_id": CANVAS_ID})
    assert json.loads(raw)["ok"] is False
    assert "do not infer" in json.loads(raw)["error"]
