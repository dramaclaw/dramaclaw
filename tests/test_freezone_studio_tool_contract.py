"""Studio contracts as received by an agent through MCP and the real HTTP routes."""

import asyncio
import io
import json
from contextlib import closing
from types import SimpleNamespace
from urllib.error import HTTPError
from urllib.parse import urlsplit

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from jsonschema import Draft202012Validator

from novelvideo.api.auth import get_api_user
from novelvideo.api.routes import freezone
from novelvideo.chat import dramaclaw_mcp
from novelvideo.freezone import canvas_store, studio
from tests.test_freezone_studio_agent import FakeStudio, _build_film, _write_canvas


@pytest.fixture()
def studio_agent(monkeypatch, tmp_path):
    for name, value in {
        "SUPERTALE_OPENFILM_STUDIO_ENABLED": "1",
        "DRAMACLAW_API_URL": "http://testserver",
        "DRAMACLAW_AGENT_TOKEN": "token",
        "DRAMACLAW_PROJECT_ID": "demo",
        "DRAMACLAW_CANVAS_ID": "canvas-1",
    }.items():
        monkeypatch.setenv(name, value)

    project_dir = tmp_path / "project"
    state_dir = tmp_path / "state"
    runtime_dir = tmp_path / "runtime"
    _build_film(project_dir)
    _write_canvas(state_dir)
    canvas = canvas_store.read_canvas(state_dir, "canvas-1")
    canvas["nodes"].append({"id": "node-2", "type": "videoComposeNode", "data": {}})
    canvas_store.atomic_write_json(canvas_store.canvas_path(state_dir, "canvas-1"), canvas)
    fake = FakeStudio(
        studio.studio_film_for_node(
            project_dir=project_dir,
            state_dir=state_dir,
            runtime_dir=runtime_dir,
            canvas_id="canvas-1",
            node_id="node-1",
        )
    )
    monkeypatch.setattr(studio, "_ensure_studio", fake.ensure)
    monkeypatch.setattr(studio, "_studio_post", fake.post)
    monkeypatch.setattr(studio, "_studio_request", fake.request)
    ctx = SimpleNamespace(
        project_id="proj_demo",
        requester_user_id="u-alice",
        owner_username="alice",
        project_name="demo",
        requester_username="alice",
        is_home_node=True,
        state_dir=state_dir,
        output_dir=project_dir,
        runtime_dir=runtime_dir,
    )

    async def resolve(project, user, **kwargs):
        return ctx, "alice", "demo", project_dir, str(project_dir)

    enqueued = []

    async def enqueue_project_task(ctx, **kwargs):
        enqueued.append(kwargs)
        return SimpleNamespace(
            backend="local", queue="ffmpeg", task_state=SimpleNamespace(task_id="task-1")
        )

    monkeypatch.setattr(freezone, "_resolve_freezone_project", resolve)
    monkeypatch.setattr(
        freezone,
        "get_task_backend",
        lambda: SimpleNamespace(enqueue_project_task=enqueue_project_task),
    )
    app = FastAPI()
    app.include_router(freezone.router, prefix="/api/v1")
    app.dependency_overrides[get_api_user] = lambda: {"id": "u-alice", "username": "alice"}
    plugin = dramaclaw_mcp._load_plugin("freezone")
    tool_index = dramaclaw_mcp._tool_index(plugin)

    with TestClient(app) as client:

        def urlopen(request, timeout):
            url = urlsplit(request.full_url)
            response = client.request(
                request.get_method(),
                url.path + (f"?{url.query}" if url.query else ""),
                headers=dict(request.header_items()),
                json=json.loads(request.data) if request.data is not None else None,
            )
            body = io.BytesIO(response.content)
            if not 200 <= response.status_code < 300:
                raise HTTPError(
                    request.full_url,
                    response.status_code,
                    response.reason_phrase,
                    response.headers,
                    body,
                )
            return closing(
                SimpleNamespace(status=response.status_code, read=body.read, close=body.close)
            )

        monkeypatch.setattr(plugin, "urlopen", urlopen)

        def call(name, **args):
            result = asyncio.run(dramaclaw_mcp.call_tool(name, args, tool_index=tool_index))
            assert result.structuredContent is not None
            return result

        yield SimpleNamespace(
            call=call,
            project_dir=project_dir,
            enqueued=enqueued,
            fake=fake,
            schemas={
                tool.name: tool.inputSchema for tool in dramaclaw_mcp.build_mcp_tools(tool_index)
            },
        )


def test_get_film_returns_the_current_revision(studio_agent):
    response = studio_agent.call("freezone_studio_get_film", node_id="node-1")
    result = response.structuredContent
    assert result["ok"] is True
    assert result["status"] == "studio_film"
    assert result["node_id"] == "node-1"
    assert result["rev"] == "rev-1"
    assert response.isError is False


def test_edit_film_returns_the_new_revision_and_applied_count(studio_agent):
    response = studio_agent.call(
        "freezone_studio_edit_film",
        node_id="node-1",
        base_rev="rev-1",
        ops=[{"op": "move", "clip": "clip-1", "at": 3}],
    )
    result = response.structuredContent
    assert result["ok"] is True
    assert result["status"] == "studio_film_edited"
    assert result["rev"] == "rev-2"
    assert result["ops_applied"] == 1
    assert response.isError is False


def test_import_media_returns_the_asset_and_canvas_source(studio_agent):
    response = studio_agent.call(
        "freezone_studio_import_media",
        node_id="node-1",
        source_node_id="video-a",
    )
    result = response.structuredContent
    assert result["ok"] is True
    assert result["status"] == "studio_media_imported"
    asset_path = result["asset_path"]
    assert asset_path.startswith("assets/import-")
    assert asset_path.endswith(".mp4")
    assert result["kind"] == "video"
    assert result["media"][0]["path"] == asset_path
    assert result["media"][0]["duration"] == 6.0
    assert result["source"] == {
        "source_url": "/freezone/_uploads/first.mp4",
        "node_id": "video-a",
        "label": "Clip A",
    }
    assert response.isError is False


def test_import_missing_media_does_not_claim_the_film_is_missing(studio_agent):
    response = studio_agent.call(
        "freezone_studio_import_media",
        node_id="node-1",
        source_url="/freezone/_uploads/missing.mp4",
    )
    result = response.structuredContent
    assert result["ok"] is False
    assert result["error"] == "media source not found: /freezone/_uploads/missing.mp4"
    assert "agent_instruction" not in result
    assert response.isError is True


def test_import_missing_canvas_node_does_not_claim_the_film_is_missing(studio_agent):
    response = studio_agent.call(
        "freezone_studio_import_media",
        node_id="node-1",
        source_node_id="missing-node",
    )
    result = response.structuredContent
    assert result["ok"] is False
    assert result["error"] == "canvas node not found: missing-node"
    assert "agent_instruction" not in result
    assert response.isError is True


def test_get_missing_film_asks_to_open_the_compose_workspace(studio_agent):
    response = studio_agent.call("freezone_studio_get_film", node_id="node-2")
    result = response.structuredContent
    assert result["ok"] is False
    assert result["code"] == "studio_film_missing"
    assert result["message"] == (
        "this compose node has no Studio film yet: open its compose workspace "
        "once so the timeline becomes a film"
    )
    assert "compose workspace" in result["agent_instruction"]
    assert response.isError is True


def test_export_film_returns_the_enqueued_task(studio_agent):
    response = studio_agent.call("freezone_studio_export_film", node_id="node-1")
    result = response.structuredContent
    assert result["ok"] is True
    assert result["status"] == "studio_export_started"
    assert isinstance(result["job_id"], str) and result["job_id"]
    assert isinstance(result["task_key"], str) and result["task_key"]
    assert result["task_type"] == "freezone_video_compose"
    assert result["backend"] == "local"
    assert result["task_id"] == "task-1"
    assert len(studio_agent.enqueued) == 1
    assert studio_agent.enqueued[0]["task_type"] == "freezone_video_compose"
    assert response.isError is False


def test_export_non_compose_node_does_not_claim_the_film_is_missing(studio_agent):
    film_dir = studio.film_dir_for_node(studio_agent.project_dir, "canvas-1", "video-a")
    film_dir.mkdir(parents=True)
    (film_dir / "film.html").write_text("<!doctype html><html></html>", encoding="utf-8")
    response = studio_agent.call("freezone_studio_export_film", node_id="video-a")
    result = response.structuredContent
    assert result["ok"] is False
    assert result["error"] == "compose node not found on canvas: video-a"
    assert studio_agent.enqueued == []
    assert "agent_instruction" not in result
    assert response.isError is True


def test_export_without_a_film_asks_to_open_the_compose_workspace(studio_agent):
    response = studio_agent.call("freezone_studio_export_film", node_id="node-2")
    result = response.structuredContent
    assert result["ok"] is False
    assert result["code"] == "studio_film_missing"
    assert result["message"] == (
        "this compose node has no Studio film yet: open its compose workspace first"
    )
    assert "compose workspace" in result["agent_instruction"]
    assert studio_agent.enqueued == []
    assert response.isError is True


def test_edit_without_a_film_asks_to_open_the_compose_workspace(studio_agent):
    response = studio_agent.call(
        "freezone_studio_edit_film",
        node_id="node-2",
        base_rev="rev-1",
        ops=[{"op": "move", "clip": "clip-1", "at": 3}],
    )
    result = response.structuredContent
    assert result["ok"] is False
    assert result["code"] == "studio_film_missing"
    assert "compose workspace" in result["agent_instruction"]
    assert response.isError is True


VALID_OPS = ["set", "move", "insert", "remove", "split", "props", "track", "reorder", "stage"]
MINIMAL_OPS = [
    {"op": "set", "clip": "clip-1", "field": "at", "value": 5},
    {"op": "set", "clip": "clip-1", "field": "time", "value": [0.5, 2.5]},
    {"op": "set", "clip": "clip-1", "field": "speed", "value": 1.5},
    {"op": "set", "clip": "clip-1", "field": "volume", "value": 0.8},
    {"op": "set", "clip": "clip-1", "field": "box", "value": {"x": 0, "y": 0, "w": 960, "h": 540}},
    {"op": "set", "clip": "clip-1", "field": "overrides", "value": None},
    {"op": "move", "clip": "clip-1", "at": 3},
    {"op": "insert", "clip": {"src": "assets/import-a.mp4", "at": 6}},
    {"op": "remove", "clip": "clip-0"},
    {"op": "split", "clip": "clip-0", "at": 2, "time": [0, 2], "restTime": [2, 4]},
    {"op": "props", "edits": [{"clip": "clip-1", "prop": "fade", "value": [0.5, 0.5]}]},
    {"op": "track", "track": 1, "field": "muted", "value": False},
    {"op": "reorder", "from": 1, "to": 0},
    {"op": "stage", "w": 1080, "h": 1920},
]


def _assert_refusal(studio_agent, response, tool, pairs, example):
    result = response.structuredContent
    assert response.isError is True
    assert not any(
        method == "POST" and path == "/api/projects/pid-1/edit"
        for method, path, _ in studio_agent.fake.calls
    )
    assert result["ok"] is False
    assert result["error"] == "tool_arguments_invalid"
    assert result["status"] == "tool_arguments_invalid"
    assert result["retryable"] is False
    errors = result["errors"]
    assert isinstance(errors, list)
    assert [(error["path"], error["problem"]) for error in errors] == pairs
    for error in errors:
        assert {"path", "problem", "message"} <= error.keys()
        assert error.keys() <= {"path", "problem", "message", "suggestion"}
        assert all(isinstance(value, str) for value in error.values())
        assert error["problem"] in {
            "missing_field", "unknown_field", "unknown_op", "invalid_value"
        }
        assert error["path"] in error["message"]
    assert result["message"] == "; ".join(error["message"] for error in errors)
    assert result["path"] == pairs[0][0]
    assert "Sending the same arguments again fails the same way." in result["agent_instruction"]
    assert result["example"] == example
    Draft202012Validator(studio_agent.schemas[tool]).validate(result["example"])
    if tool == "freezone_studio_edit_film":
        assert result["valid_ops"] == VALID_OPS
    else:
        assert "valid_ops" not in result


def _edit_example(node="node-1", rev="rev-1"):
    return {
        "node_id": node,
        "base_rev": rev,
        "ops": [{
            "op": "set", "clip": "<clip id from freezone_studio_get_film>",
            "field": "at", "value": 2,
        }],
    }


def test_recorded_edit_refusal_lists_all_problems_and_is_repeatable(studio_agent):
    args = {
        "canvas_id": "user_i1user_151c5ks", "node_id": "dCompose",
        "ops": [{"clipId": "clip-0", "rev": "c47514c9a6e35b08",
                 "type": "set_clip_at", "value": 0.2}],
    }
    tool = "freezone_studio_edit_film"
    response = studio_agent.call(tool, **args)
    repeated = studio_agent.call(tool, **args)
    assert repeated.structuredContent == response.structuredContent
    _assert_refusal(studio_agent, response, tool, [
        ("base_rev", "missing_field"), ("ops[0].op", "missing_field"),
        ("ops[0].clipId", "unknown_field"), ("ops[0].rev", "unknown_field"),
        ("ops[0].type", "unknown_field"),
    ], _edit_example("dCompose", "<rev from freezone_studio_get_film>"))
    assert {
        error["path"]: error["suggestion"]
        for error in response.structuredContent["errors"] if "suggestion" in error
    } == {"ops[0].clipId": "clip", "ops[0].rev": "base_rev", "ops[0].type": "op"}
    assert {
        error["path"]: error["message"]
        for error in response.structuredContent["errors"]
        if error["path"] in {"ops[0].rev", "ops[0].clipId"}
    } == {
        "ops[0].rev": (
            "ops[0].rev is not a known field. Did you mean the top-level base_rev argument?"
        ),
        "ops[0].clipId": "ops[0].clipId is not a known field. Did you mean clip?",
    }


@pytest.mark.parametrize(("ops", "pairs"), [
    ([{"op": "set_clip_at", "clip": "clip-0", "value": 0.2}],
     [("ops[0].op", "unknown_op")]),
    ([{"op": "move", "clip": "clip-1"}], [("ops[0].at", "missing_field")]),
    ([{"op": "set", "clip": "clip-1", "value": 1}], [("ops[0].field", "missing_field")]),
    ([{"op": "set", "clip": "clip-1", "field": "colour", "value": 1}],
     [("ops[0].field", "invalid_value")]),
    ([{"op": "set", "clip": "clip-1", "field": "at", "value": [1, 2]}],
     [("ops[0].value", "invalid_value")]),
    ([{"op": "insert", "clip": {"src": "assets/a.mp4", "kind": "video", "duration": 2}}],
     [("ops[0].clip.kind", "unknown_field"), ("ops[0].clip.duration", "unknown_field")]),
    ([{"op": "remove", "clip": "clip-0"},
      {"op": "props", "edits": [{"clip": "clip-1", "prop": "fade"}]}],
     [("ops[1].edits[0].value", "missing_field")]),
    ([], [("ops", "invalid_value")]),
], ids=["unknown-op", "move-at", "set-field", "set-colour", "set-value", "insert-clip",
        "props-value", "empty-ops"])
def test_edit_refusal_reports_exact_argument_problems(studio_agent, ops, pairs):
    tool = "freezone_studio_edit_film"
    response = studio_agent.call(tool, node_id="node-1", base_rev="rev-1", ops=ops)
    _assert_refusal(studio_agent, response, tool, pairs, _edit_example())


@pytest.mark.parametrize(("tool", "args", "pairs", "example"), [
    ("freezone_studio_get_film", {"node_id": "node-1", "clip": "clip-1"},
     [("clip", "unknown_field")], {"node_id": "node-1"}),
    ("freezone_studio_get_film", {}, [("node_id", "missing_field")],
     {"node_id": "<compose_node_id>"}),
    ("freezone_studio_export_film", {"node_id": "node-1", "fps": 500},
     [("fps", "invalid_value")], {"node_id": "node-1"}),
    ("freezone_studio_import_media", {"node_id": "node-1", "source": "video-a"},
     [("source", "unknown_field")],
     {"node_id": "node-1", "source_node_id": "<canvas node id with finished media>"}),
], ids=["get-unknown", "get-missing", "export-fps", "import-source"])
def test_other_studio_refusals_include_tool_specific_examples(studio_agent, tool, args,
                                                             pairs, example):
    response = studio_agent.call(tool, **args)
    _assert_refusal(studio_agent, response, tool, pairs, example)


@pytest.mark.parametrize("op", MINIMAL_OPS, ids=[
    "set-at", "set-time", "set-speed", "set-volume", "set-box", "set-overrides",
    "move", "insert", "remove", "split", "props", "track", "reorder", "stage",
])
def test_documented_op_validates_and_reaches_studio_unchanged(studio_agent, op):
    tool = "freezone_studio_edit_film"
    args = {"node_id": "node-1", "base_rev": "rev-1", "ops": [op]}
    Draft202012Validator(studio_agent.schemas[tool]).validate(args)
    response = studio_agent.call(tool, **args)
    assert response.structuredContent["ok"] is True
    assert response.structuredContent["status"] == "studio_film_edited"
    edits = [body for method, path, body in studio_agent.fake.calls
             if method == "POST" and path == "/api/projects/pid-1/edit"]
    assert edits[-1]["ops"] == [op]


def test_documented_ops_cover_all_variants_and_set_fields():
    assert {op["op"] for op in MINIMAL_OPS} == set(VALID_OPS)
    assert {op["field"] for op in MINIMAL_OPS if op["op"] == "set"} == {
        "at", "time", "speed", "volume", "box", "overrides"
    }


def _assert_typed_schema(schema, path, *, property_schema=False):
    if property_schema and "anyOf" in schema:
        assert all("type" in branch for branch in schema["anyOf"]), path
    else:
        assert "type" in schema, path


def _walk_schema(schema, path):
    schema_type = schema.get("type")
    if isinstance(schema_type, list):
        assert not {"array", "object"}.intersection(schema_type), path
    for name, child in schema.get("properties", {}).items():
        child_path = f"{path}.properties.{name}"
        _assert_typed_schema(child, child_path, property_schema=True)
        _walk_schema(child, child_path)
    if "items" in schema:
        _assert_typed_schema(schema["items"], f"{path}.items", property_schema=True)
        _walk_schema(schema["items"], f"{path}.items")
    for keyword in ("anyOf", "oneOf", "allOf"):
        for index, child in enumerate(schema.get(keyword, [])):
            child_path = f"{path}.{keyword}[{index}]"
            if keyword == "anyOf":
                _assert_typed_schema(child, child_path)
            _walk_schema(child, child_path)
    for name, child in schema.get("$defs", {}).items():
        _walk_schema(child, f"{path}.$defs.{name}")
    additional = schema.get("additionalProperties")
    if isinstance(additional, dict):
        _walk_schema(additional, f"{path}.additionalProperties")


@pytest.mark.parametrize("tool", [
    "freezone_studio_get_film", "freezone_studio_edit_film",
    "freezone_studio_import_media", "freezone_studio_export_film",
])
def test_studio_schema_preserves_types_in_codex(studio_agent, tool):
    schema = studio_agent.schemas[tool]
    assert not {"anyOf", "oneOf", "allOf"}.intersection(schema)
    _walk_schema(schema, tool)


def test_edit_schema_lists_closed_typed_op_variants(studio_agent):
    items = studio_agent.schemas["freezone_studio_edit_film"]["properties"]["ops"]["items"]
    variants = items["anyOf"]
    names = []
    for variant in variants:
        assert variant["type"] == "object"
        assert variant["additionalProperties"] is False
        op = variant["properties"]["op"]
        assert op["type"] == "string"
        names.append(op["const"])
    assert list(dict.fromkeys(names)) == VALID_OPS


@pytest.mark.parametrize(("args", "pairs", "example"), [
    ({}, [("node_id", "missing_field"), ("base_rev", "missing_field"),
          ("ops", "missing_field")],
     _edit_example("<compose_node_id>", "<rev from freezone_studio_get_film>")),
    ({"project_id": "demo", "canvas_id": "canvas-1", "node_id": "node-1",
      "base_rev": "rev-1", "ops": [{"op": "move", "clip_id": "clip-1", "at": 3}]},
     [("ops[0].clip", "missing_field"), ("ops[0].clip_id", "unknown_field")],
     _edit_example()),
], ids=["missing-arguments", "clip-id-suggestion"])
def test_edit_refusal_examples_preserve_only_node_and_revision(studio_agent, args, pairs,
                                                             example):
    tool = "freezone_studio_edit_film"
    response = studio_agent.call(tool, **args)
    _assert_refusal(studio_agent, response, tool, pairs, example)
    if args:
        assert response.structuredContent["errors"][1]["suggestion"] == "clip"
