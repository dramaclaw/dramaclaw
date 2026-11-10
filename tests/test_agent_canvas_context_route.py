# SPDX-License-Identifier: Elastic-2.0
# Copyright (c) 2026 ClaymoreLab
from collections import Counter
import asyncio
from copy import deepcopy
import logging
import json
import threading
from types import SimpleNamespace

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
import pytest

from novelvideo.api.routes import characters, freezone as routes, html_artifacts
from novelvideo.freezone import agent_canvas, canvas_store
from novelvideo.freezone.agent_canvas_metrics import metrics_snapshot
from novelvideo.freezone.canvas_core_pool import CanvasCoreError

USER = {"id": "reader", "username": "requester"}
REQUESTS = [{"type": "describe_canvas", "query": "private-request-parameters"}]
RESULT = {"answers": [{"text": "canvas answer"}]}


class FakePool:
    def __init__(self):
        self.calls = []
        self.results = [{"status": "answered", "result": RESULT}]

    def call(self, op, payload):
        assert op == "answer_context"
        self.calls.append(deepcopy(payload))
        result = self.results.pop(0)
        if isinstance(result, Exception):
            raise result
        return result


@pytest.fixture
def setup(monkeypatch, tmp_path):
    monkeypatch.setenv("DRAMACLAW_AGENT_CANVAS_EXECUTOR", "server")
    ctx = SimpleNamespace(
        project_id="proj",
        state_dir=tmp_path,
        requester_user_id="reader",
        owner_username="owner",
        project_name="demo",
    )

    async def resolve(project, user, **kwargs):
        assert project == "proj"
        assert user["id"] == USER["id"] and user["username"] == USER["username"]
        assert kwargs == {"required_role": "viewer", "require_home_node": False}
        return ctx, "owner", "demo", tmp_path, str(tmp_path)

    async def catalog(requester_user_id):
        assert requester_user_id == "reader"
        return [{"id": "model"}]

    monkeypatch.setattr(routes, "_resolve_freezone_project", resolve)
    monkeypatch.setattr(routes, "_freezone_image_models_data", catalog)
    monkeypatch.setattr(routes, "_freezone_video_models_data", catalog)
    pool = FakePool()
    monkeypatch.setattr(agent_canvas, "get_canvas_core_pool", lambda: pool)
    canvas_store.save_canvas(
        tmp_path,
        "default",
        base_revision=None,
        build_payload=lambda _: {
            "nodes": [{"id": "original", "data": {"text": "private-canvas-text"}}],
            "edges": [],
            "revision": 1,
        },
    )
    return tmp_path, pool


async def dispatch(canvas_id="default", locale="en"):
    return await routes.agent_canvas_context(
        "proj",
        canvas_id,
        routes.AgentCanvasContextRequest(requests=REQUESTS, locale=locale),
        USER,
    )


@pytest.mark.parametrize(
    "recorded,body_locale,expected", [("en", None, "en"), ("en", "vi", "vi"), (None, None, "zh")],
)
async def test_context_locale_precedence(setup, monkeypatch, recorded, body_locale, expected):
    root, _ = setup
    state_dir = root / "state"
    if recorded is not None:
        path = state_dir / "freezone" / "ui_locale.json"
        path.parent.mkdir(parents=True)
        path.write_text(json.dumps({"locale": recorded}))
    monkeypatch.setattr(routes, "_canvas_state_project_dir", lambda *_: state_dir)
    captured = []

    async def answer_core(**kwargs):
        captured.append(kwargs["env"])
        return RESULT

    monkeypatch.setattr(routes, "answer_agent_canvas_context", answer_core)
    await dispatch(locale=body_locale)
    assert captured[0]["locale"] == expected


def client_for(user=USER):
    from novelvideo.api.auth import get_api_user

    app = FastAPI()
    app.include_router(routes.router)
    app.dependency_overrides[get_api_user] = lambda: user
    return TestClient(app)


async def test_browser_executor_does_not_call_pool(setup, monkeypatch):
    _, pool = setup
    monkeypatch.setenv("DRAMACLAW_AGENT_CANVAS_EXECUTOR", "browser")
    with pytest.raises(HTTPException) as error:
        await dispatch()
    assert error.value.status_code == 409
    assert error.value.detail == {"code": "agent_canvas_executor_browser"}
    assert pool.calls == []


@pytest.mark.parametrize(
    "scopes,project,status",
    [
        ([], "proj", 403),
        (["projects:write"], "other", 403),
        (["projects:write"], "proj", 200),
    ],
)
def test_agent_auth_scope(setup, scopes, project, status):
    user = {
        **USER,
        "credential_kind": "agent_session",
        "scopes": scopes,
        "current_scope_kind": "project",
        "current_project_id": project,
    }
    response = client_for(user).post(
        "/projects/proj/freezone/canvases/default/agent-context",
        json={"requests": REQUESTS},
    )
    assert response.status_code == status
    assert len(setup[1].calls) == (1 if status == 200 else 0)


async def test_pure_read_canvas_matches_browser_and_records_metrics(setup, caplog):
    root, pool = setup
    stored = canvas_store.read_canvas(root, "default")
    browser = await routes.get_canvas("proj", "default", USER)
    before = metrics_snapshot().get("agent_canvas_read.answered", 0)
    with caplog.at_level(logging.INFO):
        response = await dispatch()
    assert response == {"ok": True, "data": RESULT}
    assert len(pool.calls) == 1
    assert pool.calls[0] == {
        "canvas": browser["data"],
        "envelopes": [
            {
                "schema_version": "canvas_context_request.v1",
                "canvas_id": "default",
                "requests": REQUESTS,
            }
        ],
        "env": {
            "locale": "en",
            "project": "proj",
            "canvasId": "default",
            "username": "requester",
            "selectedNodeIds": [],
            "catalogs": {"image": [{"id": "model"}], "video": [{"id": "model"}]},
        },
    }
    logs = [record.getMessage() for record in caplog.records if "agent_canvas_read " in record.msg]
    assert len(logs) == 1
    assert "requests=describe_canvas" in logs[0]
    assert "result=answered" in logs[0]
    assert "passes=1" in logs[0]
    assert "duration_ms=" in logs[0] and "node_ms=" in logs[0]
    assert "private-canvas-text" not in logs[0]
    assert "private-request-parameters" not in logs[0]
    assert metrics_snapshot()["agent_canvas_read.answered"] == before + 1
    assert canvas_store.read_canvas(root, "default") == stored


async def test_fetches_unique_host_needs_and_unwraps_handler_data(setup, monkeypatch, caplog):
    _, pool = setup
    needs = [
        {"kind": "audio_references"},
        {"kind": "project_assets"},
        {"kind": "characters"},
        {"kind": "html_artifact", "artifact_id": "existing", "version": 2},
        {"kind": "html_artifact", "artifact_id": "existing"},
        {"kind": "html_artifact", "artifact_id": "missing"},
        {"kind": "html_versions", "artifact_id": "existing"},
    ]
    pool.results.insert(0, {"status": "needs_host_data", "needs": needs + deepcopy(needs)})
    calls = Counter()

    async def audio(project, user):
        assert project == "proj" and user is USER
        calls["audio"] += 1
        return {"ok": True, "data": ["audio"]}

    async def assets(project, user):
        assert project == "proj" and user is USER
        calls["assets"] += 1
        return {"ok": True, "data": ["asset"]}

    async def character(project, summary, names, user):
        assert project == "proj" and user is USER
        assert summary is False and names is None
        calls["characters"] += 1
        return {"ok": True, "data": ["character"]}

    async def artifact(project, artifact_id, version, user):
        assert project == "proj" and user is USER
        calls[f"{artifact_id}@{version}"] += 1
        if artifact_id == "missing":
            raise HTTPException(404, "artifact not found")
        return {"ok": True, "data": {"html": "private-html", "version": version}}

    async def versions(project, artifact_id, user):
        assert project == "proj" and artifact_id == "existing" and user is USER
        calls["versions"] += 1
        return {"ok": True, "data": {"versions": [1, 2]}}

    monkeypatch.setattr(routes, "freezone_audio_references", audio)
    monkeypatch.setattr(routes, "list_freezone_assets", assets)
    monkeypatch.setattr(characters, "list_characters", character)
    monkeypatch.setattr(html_artifacts, "get", artifact)
    monkeypatch.setattr(html_artifacts, "versions", versions)
    with caplog.at_level(logging.INFO):
        assert await dispatch() == {"ok": True, "data": RESULT}
    assert calls == Counter(
        {
            "audio": 1,
            "assets": 1,
            "characters": 1,
            "existing@2": 1,
            "existing@None": 1,
            "missing@None": 1,
            "versions": 1,
        }
    )
    assert len(pool.calls) == 2
    assert "hostData" not in pool.calls[0]["env"]
    assert pool.calls[1]["env"]["hostData"] == {
        "audio_references": ["audio"],
        "project_assets": ["asset"],
        "characters": ["character"],
        "html_artifacts": {
            "existing@2": {"html": "private-html", "version": 2},
            "existing@latest": {"html": "private-html", "version": None},
            "missing@latest": {"error": {"message": "artifact not found"}},
        },
        "html_versions": {"existing": {"versions": [1, 2]}},
    }
    assert pool.calls[0]["canvas"] == pool.calls[1]["canvas"]
    assert "passes=2" in caplog.text and "private-html" not in caplog.text


@pytest.mark.parametrize(
    "error",
    [
        LookupError("missing audio"),
        ValueError("invalid audio"),
        HTTPException(400, {"message": "bad audio"}),
    ],
)
async def test_host_fetch_error_is_data(setup, monkeypatch, error):
    _, pool = setup
    pool.results.insert(0, {"status": "needs_host_data", "needs": [{"kind": "audio_references"}]})

    async def audio(project, user):
        raise error

    monkeypatch.setattr(routes, "freezone_audio_references", audio)
    assert await dispatch() == {"ok": True, "data": RESULT}
    message = pool.calls[1]["env"]["hostData"]["audio_references"]["error"]["message"]
    assert (str(getattr(error, "detail", error))) == message


@pytest.mark.parametrize(
    "result",
    [
        {"status": "needs_host_data", "needs": []},
        {"status": "unexpected"},
        {"status": "answered"},
        None,
        {"status": "needs_host_data", "needs": [{"kind": "unknown"}]},
    ],
)
async def test_invalid_worker_result_is_protocol_error(setup, result):
    _, pool = setup
    pool.results = [result, result]
    with pytest.raises(HTTPException) as error:
        await dispatch()
    assert error.value.status_code == 503
    assert error.value.detail == {"code": "canvas_core_protocol"}
    assert len(pool.calls) <= 2


async def test_pool_error_mapping_and_metric(setup):
    _, pool = setup
    pool.results = [CanvasCoreError("canvas_core_timeout", "private-worker-error")]
    before = metrics_snapshot().get("agent_canvas_read.canvas_core_timeout", 0)
    with pytest.raises(HTTPException) as error:
        await dispatch()
    assert error.value.status_code == 503
    assert error.value.detail == {"code": "canvas_core_timeout"}
    assert metrics_snapshot()["agent_canvas_read.canvas_core_timeout"] == before + 1


@pytest.mark.parametrize("canvas_id", ["default", "missing"])
async def test_default_creation_and_empty_canvas_match_browser(setup, canvas_id):
    root, pool = setup
    if canvas_id == "default":
        canvas_store.soft_delete_canvas(root, "default", deleted_by="reader")
    await dispatch(canvas_id, locale=None)
    browser = await routes.get_canvas("proj", canvas_id, USER)
    assert pool.calls[0]["canvas"] == browser["data"]
    assert pool.calls[0]["env"]["locale"] == "zh"


async def test_refresh_and_static_url_migration_match_browser(setup, monkeypatch):
    _, pool = setup
    refresh_calls = []

    async def refresh(**kwargs):
        refresh_calls.append(kwargs["payload"])
        return {
            **kwargs["payload"],
            "nodes": [
                {
                    "id": "refreshed",
                    "data": {
                        "imageUrl": "/static/owner/demo/assets/image.png",
                    },
                }
            ],
        }

    monkeypatch.setattr(routes, "_refresh_preset_canvas_payload_on_read", refresh)
    browser = await routes.get_canvas("proj", "default", USER)
    await dispatch()
    assert len(refresh_calls) == 2
    assert pool.calls[0]["canvas"] == browser["data"]
    node = pool.calls[0]["canvas"]["nodes"][0]
    assert node == {
        "id": "refreshed",
        "data": {
            "imageUrl": "/static/projects/proj/assets/image.png",
        },
    }


async def test_orchestration_fetches_concurrently_and_calls_pool_off_event_loop(setup, monkeypatch):
    _, pool = setup
    pool.results.insert(
        0,
        {
            "status": "needs_host_data",
            "needs": [
                {"kind": "audio_references"},
                {"kind": "characters"},
                {"kind": "audio_references"},
            ],
        },
    )
    entered = set()
    ready = asyncio.Event()
    loop_thread = threading.get_ident()
    call = pool.call

    def threaded_call(op, payload):
        assert threading.get_ident() != loop_thread
        return call(op, payload)

    monkeypatch.setattr(pool, "call", threaded_call)

    async def fetch(need):
        entered.add(need["kind"])
        if len(entered) == 2:
            ready.set()
        await asyncio.wait_for(ready.wait(), timeout=2)
        return [need["kind"]]

    result = await agent_canvas.answer_agent_canvas_context(
        project="proj",
        canvas_id="default",
        canvas={"nodes": [], "edges": []},
        envelopes=[{"requests": REQUESTS}],
        env={},
        fetchers={"audio_references": fetch, "characters": fetch},
    )
    assert result == RESULT
    assert pool.calls[1]["env"]["hostData"] == {
        "audio_references": ["audio_references"],
        "characters": ["characters"],
    }


async def test_store_errors_match_browser_mapping(setup, monkeypatch):
    _, pool = setup

    def corrupt(*args, **kwargs):
        raise canvas_store.CanvasCorruptError("corrupt canvas")

    monkeypatch.setattr(canvas_store, "read_canvas", corrupt)
    with pytest.raises(HTTPException) as error:
        await dispatch()
    assert error.value.status_code == 500
    assert error.value.detail == "corrupt canvas"
    assert not pool.calls


async def test_locale_is_an_optional_string(setup):
    await dispatch(locale="fr")
    assert setup[1].calls[0]["env"]["locale"] == "fr"


async def test_invalid_request_type_is_not_logged_as_content(setup, caplog):
    with caplog.at_level(logging.INFO):
        await routes.agent_canvas_context(
            "proj",
            "default",
            routes.AgentCanvasContextRequest(
                requests=[
                    {
                        "type": {"prompt": "private-prompt"},
                        "parameters": "private-parameters",
                    }
                ]
            ),
            USER,
        )
    assert "private-prompt" not in caplog.text
    assert "private-parameters" not in caplog.text
    assert len(setup[1].calls) == 1


@pytest.mark.parametrize("requests", [[], REQUESTS * 21, ["invalid"]])
def test_request_validation(setup, requests):
    response = client_for().post(
        "/projects/proj/freezone/canvases/default/agent-context",
        json={"requests": requests},
    )
    assert response.status_code == 422
    assert not setup[1].calls


@pytest.mark.parametrize(
    "code,message,status,detail,outcome",
    [
        (
            "invalid_request",
            "commands[1] (create_edge) is not a valid canvas command",
            422,
            {
                "code": "invalid_agent_canvas_request",
                "message": "commands[1] (create_edge) is not a valid canvas command",
            },
            "invalid_agent_canvas_request",
        ),
        ("canvas_core_failed", "private", 503, {"code": "canvas_core_failed"}, "canvas_core_failed"),
    ],
)
async def test_worker_error_status_message_and_outcome(setup, caplog, code, message, status, detail, outcome):
    from novelvideo.freezone.agent_canvas_metrics import metrics_snapshot
    from novelvideo.freezone.canvas_core_pool import CanvasCoreError

    root, pool = setup
    stored = canvas_store.read_canvas(root, "default")
    pool.results = [CanvasCoreError(code, message)]
    metric = f"agent_canvas_read.{outcome}"
    before = metrics_snapshot().get(metric, 0)
    with caplog.at_level(logging.INFO), pytest.raises(HTTPException) as error:
        await dispatch()
    assert error.value.status_code == status
    assert error.value.detail == detail
    assert metrics_snapshot()[metric] == before + 1
    assert f"result={outcome}" in caplog.text
    assert canvas_store.read_canvas(root, "default") == stored


@pytest.mark.parametrize("canvas_id", ["default", "missing"])
def test_presence_route_reports_project_state_records(setup, canvas_id):
    from novelvideo.freezone.canvas_presence import touch_canvas_presence

    root, pool = setup
    path = f"/projects/proj/freezone/canvases/{canvas_id}/presence"
    client = client_for()
    assert client.get(path).json() == {"ok": True, "data": {"browser_open": False}}
    touch_canvas_presence(root, canvas_id, "sse-reader")
    assert client.get(path).json() == {"ok": True, "data": {"browser_open": True}}
    assert not pool.calls


def test_presence_route_rejects_invalid_canvas_id(setup):
    response = client_for().get("/projects/proj/freezone/canvases/invalid.canvas/presence")
    assert response.status_code == 400


@pytest.mark.parametrize("scopes,project,status", [
    ([], "proj", 403),
    (["projects:read"], "other", 403),
    (["projects:read"], "proj", 200),
])
def test_presence_route_requires_read_scope(setup, scopes, project, status):
    user = {
        **USER, "credential_kind": "agent_session", "scopes": scopes,
        "current_scope_kind": "project", "current_project_id": project,
    }
    response = client_for(user).get("/projects/proj/freezone/canvases/default/presence")
    assert response.status_code == status


async def test_presence_route_scans_state_off_event_loop(setup, monkeypatch):
    from novelvideo.freezone.canvas_presence import touch_canvas_presence

    root, _ = setup
    state = root / "state"
    monkeypatch.setattr(routes, "_canvas_state_project_dir", lambda *_: state)
    touch_canvas_presence(state, "default", "sse-reader")
    loop_thread = threading.get_ident()
    original_stat = type(root).stat

    def stat(path, *args, **kwargs):
        if "canvas_presence" in path.parts:
            assert threading.get_ident() != loop_thread
        return original_stat(path, *args, **kwargs)

    monkeypatch.setattr(type(root), "stat", stat)
    response = await routes.get_canvas_presence("proj", "default", USER)
    assert response == {"ok": True, "data": {"browser_open": True}}
