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

        yield SimpleNamespace(call=call, project_dir=project_dir, enqueued=enqueued)


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
