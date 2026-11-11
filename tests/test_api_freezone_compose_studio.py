"""HTTP contract for opening an OpenFilm Studio compose session."""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient


@pytest.fixture()
def studio_client(monkeypatch, tmp_path: Path) -> TestClient:
    from novelvideo.api.auth import get_api_user
    from novelvideo.api.routes import freezone

    ctx = SimpleNamespace(
        project_id="proj_demo",
        requester_user_id="u-alice",
        output_dir=tmp_path,
        state_dir=tmp_path / "state",
        runtime_dir=tmp_path / "runtime",
    )
    app_state = {"calls": []}
    monkeypatch.setenv("SUPERTALE_OPENFILM_STUDIO_ENABLED", "1")

    async def fake_resolve(project: str, user: dict, **_kwargs):
        return ctx, "alice", "demo", tmp_path, str(tmp_path)

    def fake_build(**kwargs):
        del kwargs
        return tmp_path / "film"

    async def fake_session(film_dir: Path, **kwargs):
        assert film_dir.root == tmp_path / "freezone/studio/canvas-1/node-1"
        assert film_dir.state_dir == tmp_path / "state/openfilm/canvas-1/node-1"
        assert film_dir.runtime_dir == tmp_path / "runtime/openfilm/canvas-1/node-1"
        app_state["calls"].append(kwargs)
        return {
            "url": "http://127.0.0.1:4747/open?key=k",
            "origin": "http://127.0.0.1:4747",
        }

    monkeypatch.setattr(freezone, "_resolve_freezone_project", fake_resolve)
    monkeypatch.setattr(freezone, "build_studio_film", fake_build)
    monkeypatch.setattr(freezone, "ensure_studio_session", fake_session)

    app = FastAPI()
    app.state.studio_calls = app_state["calls"]
    app.include_router(freezone.router, prefix="/api/v1")
    app.dependency_overrides[get_api_user] = lambda: {
        "id": "u-alice",
        "username": "alice",
    }
    return TestClient(app)


def test_studio_route_is_hidden_when_feature_is_disabled(
    studio_client: TestClient, monkeypatch
):
    monkeypatch.delenv("SUPERTALE_OPENFILM_STUDIO_ENABLED", raising=False)
    response = studio_client.post(
        "/api/v1/projects/demo/freezone/video/compose/studio",
        json={"canvas_id": "canvas-1", "node_id": "node-1", "tracks": []},
    )
    assert response.status_code == 404
    assert studio_client.app.state.studio_calls == []


def test_studio_route_returns_the_canonical_envelope(studio_client: TestClient):
    response = studio_client.post(
        "/api/v1/projects/demo/freezone/video/compose/studio",
        json={
            "canvas_id": "canvas-1",
            "node_id": "node-1",
            "tracks": [
                {
                    "track_id": "video-1",
                    "kind": "video",
                    "items": [
                        {
                            "item_id": "clip-1",
                            "source_url": "/freezone/_uploads/a.mp4",
                            "source_end": 1.0,
                        }
                    ],
                }
            ],
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    assert body["data"] == {
        "url": "http://127.0.0.1:4747/open?key=k",
        "origin": "http://127.0.0.1:4747",
    }


def test_studio_route_forwards_the_host_language(studio_client: TestClient):
    response = studio_client.post(
        "/api/v1/projects/demo/freezone/video/compose/studio",
        json={
            "canvas_id": "canvas-1",
            "node_id": "node-1",
            "lang": "zh",
            "tracks": [
                {
                    "track_id": "video-1",
                    "kind": "video",
                    "items": [
                        {
                            "item_id": "clip-1",
                            "source_url": "/freezone/_uploads/a.mp4",
                            "source_end": 1.0,
                        }
                    ],
                }
            ],
        },
    )

    assert response.status_code == 200
    calls = studio_client.app.state.studio_calls
    assert calls[-1]["lang"] == "zh"


def test_studio_route_lets_the_host_ask_before_replacing_an_edited_film(
    studio_client: TestClient, monkeypatch
):
    """The editor saves cuts straight into the film folder, so replacing one needs consent — the
    host shows its own confirmation on this status and retries with `rebuild`."""
    from novelvideo.api.routes import freezone
    from novelvideo.freezone.studio import StudioError

    def refuse(**_kwargs):
        raise StudioError(
            "the film was edited in Studio; pass rebuild to replace it", 409
        )

    monkeypatch.setattr(freezone, "build_studio_film", refuse)

    response = studio_client.post(
        "/api/v1/projects/demo/freezone/video/compose/studio",
        json={
            "canvas_id": "canvas-1",
            "node_id": "node-1",
            "tracks": [
                {
                    "track_id": "video-1",
                    "kind": "video",
                    "items": [
                        {
                            "item_id": "clip-1",
                            "source_url": "/freezone/_uploads/a.mp4",
                            "source_end": 1.0,
                        }
                    ],
                }
            ],
        },
    )

    assert response.status_code == 409
    assert "edited in Studio" in response.json()["detail"]


def test_studio_request_requires_canvas_and_node_ids():
    from pydantic import ValidationError

    from novelvideo.api.schemas import FreezoneVideoComposeStudioRequest

    with pytest.raises(ValidationError):
        FreezoneVideoComposeStudioRequest()
    with pytest.raises(ValidationError):
        FreezoneVideoComposeStudioRequest(canvas_id="canvas-1")


def test_compose_items_reject_non_finite_numbers():
    from pydantic import ValidationError

    from novelvideo.api.schemas import FreezoneVideoComposeItem

    with pytest.raises(ValidationError):
        FreezoneVideoComposeItem(
            item_id="clip",
            source_url="/freezone/_uploads/a.mp4",
            source_end=float("inf"),
        )


# ---------------------------------------------------------------------------
# Agent routes: the compose node's film through Studio.
# ---------------------------------------------------------------------------


@pytest.fixture()
def agent_client(monkeypatch, tmp_path: Path) -> tuple[TestClient, dict]:
    from novelvideo.api.auth import get_api_user
    from novelvideo.api.routes import freezone
    from novelvideo.freezone import canvas_store

    state_dir = tmp_path / "state"
    ctx = SimpleNamespace(
        project_id="proj_demo",
        requester_user_id="u-alice",
        owner_username="alice",
        project_name="demo",
        requester_username="alice",
        is_home_node=True,
        state_dir=state_dir,
        output_dir=tmp_path,
        runtime_dir=tmp_path / "runtime",
    )
    seen: dict = {"state_dir": state_dir, "project_dir": tmp_path, "ctx": ctx}
    monkeypatch.setenv("SUPERTALE_OPENFILM_STUDIO_ENABLED", "1")

    async def fake_resolve(project: str, user: dict, **_kwargs):
        return ctx, "alice", "demo", tmp_path, str(tmp_path)

    monkeypatch.setattr(freezone, "_resolve_freezone_project", fake_resolve)
    canvas_store.atomic_write_json(
        canvas_store.canvas_path(state_dir, "canvas-1"),
        {
            "schema_version": 2,
            "canvas_id": "canvas-1",
            "revision": 4,
            "nodes": [
                {"id": "video-a", "type": "videoNode", "data": {"label": "Clip A", "videoUrl": "/freezone/_uploads/a.mp4"}},
                {"id": "text-a", "type": "textAnnotationNode", "data": {"text": "notes"}},
                {"id": "node-1", "type": "videoComposeNode", "data": {}},
            ],
            "edges": [],
        },
    )

    app = FastAPI()
    app.include_router(freezone.router, prefix="/api/v1")
    app.dependency_overrides[get_api_user] = lambda: {"id": "u-alice", "username": "alice"}
    return TestClient(app), seen


def test_agent_studio_route_is_hidden_when_feature_is_disabled(
    agent_client, monkeypatch
):
    from novelvideo.api.routes import freezone

    client, seen = agent_client

    async def fake_read(**kwargs):
        seen["read"] = kwargs
        return {"ok": True}

    monkeypatch.setattr(freezone, "read_studio_film", fake_read)
    monkeypatch.delenv("SUPERTALE_OPENFILM_STUDIO_ENABLED", raising=False)
    response = client.get(
        "/api/v1/projects/demo/freezone/canvases/canvas-1/compose/node-1/studio/film"
    )
    assert response.status_code == 404
    assert "read" not in seen


def test_film_route_returns_the_studio_summary(agent_client, monkeypatch):
    from novelvideo.api.routes import freezone

    client, seen = agent_client

    async def fake_read(**kwargs):
        seen["read"] = kwargs
        return {"ok": True, "status": "studio_film", "rev": "r1", "film": {"tracks": []}}

    monkeypatch.setattr(freezone, "read_studio_film", fake_read)
    response = client.get(
        "/api/v1/projects/demo/freezone/canvases/canvas-1/compose/node-1/studio/film"
    )
    assert response.status_code == 200
    assert response.json()["rev"] == "r1"
    assert seen["read"]["canvas_id"] == "canvas-1" and seen["read"]["node_id"] == "node-1"
    assert seen["read"]["state_dir"] == seen["state_dir"]


@pytest.mark.parametrize(
    "node_data,task_status,task_error,expected",
    [
        pytest.param(
            {
                "generationTaskKey": "task:freezone_video_compose:project:proj_demo:0:export-1",
                "generationTaskJobId": "export-1",
                "generationError": "previous error",
                "resultVideoUrl": "/static/previous.mp4",
            },
            task_status,
            None,
            {
                "status": "running", "job_id": "export-1",
                "task_key": "task:freezone_video_compose:project:proj_demo:0:export-1",
                "error": None, "video_url": None,
            },
            id=task_status,
        )
        for task_status in ("submitting", "queued", "running")
    ]
    + [
        pytest.param(
            {
                "generationTaskKey": "task:freezone_video_compose:project:proj_demo:0:export-1",
                "generationTaskJobId": "export-1",
                "generationError": "stale canvas error",
                "resultVideoUrl": "/static/previous.mp4",
            },
            "failed",
            "执行该任务的服务进程已退出,任务已中断,请重新发起",
            {
                "status": "failed", "job_id": "export-1",
                "task_key": "task:freezone_video_compose:project:proj_demo:0:export-1",
                "error": "执行该任务的服务进程已退出,任务已中断,请重新发起",
                "video_url": None,
            },
            id="failed-row-error",
        ),
        pytest.param(
            {
                "generationTaskKey": "task:freezone_video_compose:project:proj_demo:0:export-1",
                "generationTaskJobId": "export-1",
                "generationError": "canvas export error",
            },
            "failed",
            None,
            {
                "status": "failed", "job_id": "export-1",
                "task_key": "task:freezone_video_compose:project:proj_demo:0:export-1",
                "error": "canvas export error", "video_url": None,
            },
            id="failed-row-fallback",
        ),
        pytest.param(
            {
                "generationTaskKey": "task:freezone_video_compose:project:proj_demo:0:export-1",
                "generationTaskJobId": "export-1",
            },
            "cancelled",
            None,
            {
                "status": "failed", "job_id": "export-1",
                "task_key": "task:freezone_video_compose:project:proj_demo:0:export-1",
                "error": None, "video_url": None,
            },
            id="cancelled-row",
        ),
        pytest.param(
            {
                "generationTaskKey": "task:freezone_video_compose:project:proj_demo:0:export-1",
                "generationTaskJobId": "export-1",
                "resultVideoUrl": "/static/final.mp4",
            },
            "completed",
            None,
            {
                "status": "completed", "job_id": "export-1",
                "task_key": "task:freezone_video_compose:project:proj_demo:0:export-1",
                "error": None, "video_url": "/static/final.mp4",
            },
            id="completed-row",
        ),
        pytest.param(
            {
                "generationTaskKey": "task:freezone_video_compose:project:proj_demo:0:export-1",
                "generationTaskJobId": "export-1",
                "generationError": "canvas export error",
                "resultVideoUrl": "/static/previous.mp4",
            },
            None,
            None,
            {
                "status": "unknown", "job_id": "export-1",
                "task_key": "task:freezone_video_compose:project:proj_demo:0:export-1",
                "error": "canvas export error", "video_url": None,
            },
            id="missing-row",
        ),
        pytest.param(
            {
                "generationTaskKey": "task:freezone_video_compose:project:proj_demo:0:other-job",
                "generationTaskJobId": "export-1",
            },
            "failed",
            "error from a different export",
            {
                "status": "unknown", "job_id": "export-1",
                "task_key": "task:freezone_video_compose:project:proj_demo:0:other-job",
                "error": None, "video_url": None,
            },
            id="mismatched-task-key",
        ),
        pytest.param(
            {"generationError": "canvas export error", "resultVideoUrl": "/static/previous.mp4"},
            None,
            None,
            {
                "status": "failed", "job_id": None, "task_key": None,
                "error": "canvas export error", "video_url": None,
            },
            id="node-error-only",
        ),
        pytest.param(
            {"resultVideoUrl": "/static/final.mp4", "generationTaskJobId": "export-1"},
            None,
            None,
            {
                "status": "completed", "job_id": "export-1", "task_key": None,
                "error": None, "video_url": "/static/final.mp4",
            },
            id="node-video-only",
        ),
        pytest.param(
            {}, None, None,
            {
                "status": "none", "job_id": None, "task_key": None,
                "error": None, "video_url": None,
            },
            id="no-export",
        ),
    ],
)
def test_film_route_reports_latest_export(
    agent_client, monkeypatch, node_data, task_status, task_error, expected
):
    from novelvideo.api.routes import freezone
    from novelvideo.freezone import canvas_store
    from novelvideo.task_state import TaskStateManager

    client, seen = agent_client

    async def fake_read(**_kwargs):
        return {"ok": True, "status": "studio_film", "rev": "r1", "film": {"tracks": []}}

    monkeypatch.setattr(freezone, "read_studio_film", fake_read)
    manager = TaskStateManager()
    monkeypatch.setattr(freezone, "get_task_manager", lambda: manager)
    if task_status is not None:
        manager.create_task_for_project(
            seen["ctx"], "freezone_video_compose", 0, scope="export-1", status=task_status
        )
        if task_error is not None:
            manager.fail_task_for_project(
                seen["ctx"], "freezone_video_compose", 0, scope="export-1", error=task_error
            )
    canvas = canvas_store.read_canvas(seen["state_dir"], "canvas-1")
    canvas["nodes"][2]["data"] = node_data
    canvas_store.atomic_write_json(
        canvas_store.canvas_path(seen["state_dir"], "canvas-1"), canvas
    )

    response = client.get(
        "/api/v1/projects/demo/freezone/canvases/canvas-1/compose/node-1/studio/film"
    )

    assert response.status_code == 200
    assert response.json() == {
        "ok": True, "status": "studio_film", "rev": "r1", "film": {"tracks": []},
        "export": expected,
    }


@pytest.mark.parametrize("canvas_problem", ["missing", "invalid-json", "unreadable"])
def test_film_route_reports_no_export_when_canvas_cannot_be_read(
    agent_client, monkeypatch, canvas_problem
):
    from novelvideo.api.routes import freezone
    from novelvideo.freezone import canvas_store

    client, seen = agent_client

    async def fake_read(**_kwargs):
        return {"ok": True, "status": "studio_film", "rev": "r1", "film": {"tracks": []}}

    monkeypatch.setattr(freezone, "read_studio_film", fake_read)
    path = canvas_store.canvas_path(seen["state_dir"], "canvas-1")
    if canvas_problem == "missing":
        path.unlink()
    elif canvas_problem == "invalid-json":
        path.write_text("{", encoding="utf-8")
    else:
        path.unlink()
        path.mkdir()

    response = client.get(
        "/api/v1/projects/demo/freezone/canvases/canvas-1/compose/node-1/studio/film"
    )

    assert response.status_code == 200
    assert response.json() == {
        "ok": True, "status": "studio_film", "rev": "r1", "film": {"tracks": []},
        "export": {
            "status": "none", "job_id": None, "task_key": None,
            "error": None, "video_url": None,
        },
    }


def test_film_route_rejects_bad_ids(agent_client):
    client, _seen = agent_client
    response = client.get(
        "/api/v1/projects/demo/freezone/canvases/bad%20canvas/compose/node-1/studio/film"
    )
    assert response.status_code == 400
    response = client.get(
        "/api/v1/projects/demo/freezone/canvases/canvas-1/compose/bad%24node/studio/film"
    )
    assert response.status_code == 400


def test_film_route_says_when_there_is_no_film_yet(agent_client, monkeypatch):
    from novelvideo.api.routes import freezone
    from novelvideo.freezone.studio import StudioError

    client, _seen = agent_client

    async def missing(**_kwargs):
        raise StudioError(
            "this compose node has no Studio film yet", 404, code="studio_film_missing"
        )

    monkeypatch.setattr(freezone, "read_studio_film", missing)
    response = client.get(
        "/api/v1/projects/demo/freezone/canvases/canvas-1/compose/node-1/studio/film"
    )
    assert response.status_code == 404
    assert response.json()["detail"] == {
        "code": "studio_film_missing",
        "message": "this compose node has no Studio film yet",
    }


def test_edit_route_returns_conflicts_as_a_200_body(agent_client, monkeypatch):
    from novelvideo.api.routes import freezone

    client, seen = agent_client

    async def fake_edit(**kwargs):
        seen["edit"] = kwargs
        return {"ok": False, "status": "studio_edit_conflict", "rev": "r9", "retryable": True}

    monkeypatch.setattr(freezone, "edit_studio_film", fake_edit)
    response = client.post(
        "/api/v1/projects/demo/freezone/canvases/canvas-1/compose/node-1/studio/edit",
        json={"base_rev": "r1", "ops": [{"op": "remove", "clip": "clip-0"}]},
    )
    assert response.status_code == 200
    assert response.json()["status"] == "studio_edit_conflict"
    assert seen["edit"]["base_rev"] == "r1"
    assert seen["edit"]["ops"] == [{"op": "remove", "clip": "clip-0"}]


def test_edit_route_requires_ops(agent_client):
    client, _seen = agent_client
    response = client.post(
        "/api/v1/projects/demo/freezone/canvases/canvas-1/compose/node-1/studio/edit",
        json={"base_rev": "r1", "ops": []},
    )
    assert response.status_code == 422


def test_media_route_resolves_a_canvas_node_into_its_media(agent_client, monkeypatch):
    from novelvideo.api.routes import freezone

    client, seen = agent_client

    async def fake_import(**kwargs):
        seen["import"] = kwargs
        return {"ok": True, "status": "studio_media_imported", "asset_path": "assets/import-x.mp4"}

    monkeypatch.setattr(freezone, "import_media_to_film", fake_import)
    response = client.post(
        "/api/v1/projects/demo/freezone/canvases/canvas-1/compose/node-1/studio/media",
        json={"source_node_id": "video-a"},
    )
    assert response.status_code == 200
    assert seen["import"]["source_url"] == "/freezone/_uploads/a.mp4"
    assert seen["import"]["source_node_id"] == "video-a"
    assert seen["import"]["label"] == "Clip A"

    response = client.post(
        "/api/v1/projects/demo/freezone/canvases/canvas-1/compose/node-1/studio/media",
        json={"source_node_id": "text-a"},
    )
    assert response.status_code == 409
    response = client.post(
        "/api/v1/projects/demo/freezone/canvases/canvas-1/compose/node-1/studio/media",
        json={"source_node_id": "ghost"},
    )
    assert response.status_code == 404
    response = client.post(
        "/api/v1/projects/demo/freezone/canvases/canvas-1/compose/node-1/studio/media",
        json={"label": "nothing"},
    )
    assert response.status_code == 422


def test_export_route_claims_the_node_and_enqueues_a_studio_render(agent_client, monkeypatch):
    from novelvideo.api.routes import freezone
    from novelvideo.freezone import canvas_store
    from novelvideo.task_identity import project_task_state_key

    client, seen = agent_client
    film_dir = seen["project_dir"] / "freezone" / "studio" / "canvas-1" / "node-1"
    film_dir.mkdir(parents=True)
    (film_dir / "film.html").write_text("<!doctype html><html></html>", encoding="utf-8")

    async def fake_enqueue(**kwargs):
        seen["enqueue"] = kwargs
        return {"ok": True, "data": {"task_type": kwargs["task_type"], "job_id": kwargs["job_id"], "task_key": "tk"}}

    monkeypatch.setattr(freezone, "_enqueue_or_start_freezone_media_job", fake_enqueue)
    response = client.post(
        "/api/v1/projects/demo/freezone/canvases/canvas-1/compose/node-1/studio/export",
        json={"fps": 24, "title": "Final"},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["status"] == "studio_export_started" and body["task_key"] == "tk"
    payload = seen["enqueue"]["payload"]
    assert payload["studio_export"] is True
    assert payload["fps"] == 24 and payload["node_id"] == "node-1" and payload["tracks"] == []

    canvas = canvas_store.read_canvas(seen["state_dir"], "canvas-1")
    node = next(node for node in canvas["nodes"] if node["id"] == "node-1")
    expected_key = project_task_state_key(
        "freezone_video_compose", "proj_demo", 0, scope=seen["enqueue"]["job_id"]
    )
    assert node["data"]["isGenerating"] is True
    assert node["data"]["generationTaskKey"] == expected_key
    assert node["data"]["generationTaskJobId"] == seen["enqueue"]["job_id"]
    assert canvas["revision"] == 5


def test_export_route_needs_a_film_and_a_compose_node(agent_client, monkeypatch):
    from novelvideo.api.routes import freezone

    client, seen = agent_client
    response = client.post(
        "/api/v1/projects/demo/freezone/canvases/canvas-1/compose/node-1/studio/export",
        json={},
    )
    assert response.status_code == 404
    assert response.json()["detail"] == {
        "code": "studio_film_missing",
        "message": "this compose node has no Studio film yet: open its compose workspace first",
    }

    film_dir = seen["project_dir"] / "freezone" / "studio" / "canvas-1" / "video-a"
    film_dir.mkdir(parents=True)
    (film_dir / "film.html").write_text("<!doctype html><html></html>", encoding="utf-8")

    async def never(**_kwargs):
        raise AssertionError("must not enqueue for a non-compose node")

    monkeypatch.setattr(freezone, "_enqueue_or_start_freezone_media_job", never)
    response = client.post(
        "/api/v1/projects/demo/freezone/canvases/canvas-1/compose/video-a/studio/export",
        json={},
    )
    assert response.status_code == 404
    assert "compose node not found" in response.json()["detail"]


def test_compose_export_only_switches_to_studio_for_a_hand_cut_film(agent_client, monkeypatch):
    """The browser's export keeps its ffmpeg timeline path unless the film was cut by hand."""
    from novelvideo.api.routes import freezone

    client, seen = agent_client
    (seen["project_dir"] / "freezone" / "_uploads").mkdir(parents=True)
    (seen["project_dir"] / "freezone" / "_uploads" / "a.mp4").write_bytes(b"a")

    async def fake_enqueue(**kwargs):
        seen["enqueue"] = kwargs
        return {
            "ok": True,
            "data": {
                "task_type": kwargs["task_type"],
                "job_id": kwargs["job_id"],
                "task_key": "tk",
            },
        }

    monkeypatch.setattr(freezone, "_enqueue_or_start_freezone_media_job", fake_enqueue)
    body = {
        "canvas_id": "canvas-1",
        "node_id": "node-1",
        "tracks": [
            {
                "track_id": "video-1",
                "kind": "video",
                "items": [{"item_id": "clip-1", "source_url": "/freezone/_uploads/a.mp4", "source_end": 1.0}],
            }
        ],
    }
    monkeypatch.setattr(freezone, "studio_export_film_dir", lambda *_args: None)
    response = client.post("/api/v1/projects/demo/freezone/video/compose", json=body)
    assert response.status_code == 200, response.text
    assert seen["enqueue"]["payload"]["studio_export"] is False
    assert seen["enqueue"]["payload"]["tracks"][0]["items"][0]["item_id"] == "clip-1"

    film_dir = seen["project_dir"] / "freezone" / "studio" / "canvas-1" / "node-1"
    monkeypatch.setattr(freezone, "studio_export_film_dir", lambda *_args: film_dir)
    response = client.post("/api/v1/projects/demo/freezone/video/compose", json=body)
    assert response.status_code == 200, response.text
    assert seen["enqueue"]["payload"]["studio_export"] is True


def test_compose_export_skips_studio_film_when_feature_is_disabled(agent_client, monkeypatch):
    from novelvideo.api.routes import freezone

    client, seen = agent_client
    (seen["project_dir"] / "freezone" / "_uploads").mkdir(parents=True)
    (seen["project_dir"] / "freezone" / "_uploads" / "a.mp4").write_bytes(b"a")

    async def fake_enqueue(**kwargs):
        seen["enqueue"] = kwargs
        return {
            "ok": True,
            "data": {"task_type": kwargs["task_type"], "job_id": kwargs["job_id"], "task_key": "tk"},
        }

    def unexpected_studio_film(*_args):
        raise AssertionError("disabled Studio film must not be inspected")

    monkeypatch.setattr(freezone, "_enqueue_or_start_freezone_media_job", fake_enqueue)
    monkeypatch.setattr(freezone, "studio_export_film_dir", unexpected_studio_film)
    monkeypatch.delenv("SUPERTALE_OPENFILM_STUDIO_ENABLED", raising=False)
    response = client.post(
        "/api/v1/projects/demo/freezone/video/compose",
        json={
            "canvas_id": "canvas-1",
            "node_id": "node-1",
            "tracks": [
                {
                    "track_id": "video-1",
                    "kind": "video",
                    "items": [
                        {
                            "item_id": "clip-1",
                            "source_url": "/freezone/_uploads/a.mp4",
                            "source_end": 1.0,
                        }
                    ],
                }
            ],
        },
    )
    assert response.status_code == 200, response.text
    assert seen["enqueue"]["payload"]["studio_export"] is False
