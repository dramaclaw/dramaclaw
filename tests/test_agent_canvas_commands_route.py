# SPDX-License-Identifier: Elastic-2.0
# Copyright (c) 2026 ClaymoreLab
import asyncio
from copy import deepcopy
import logging
import json
import threading
import time
from types import SimpleNamespace

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
import pytest

from novelvideo.api.routes import freezone as routes
from novelvideo.api.schemas import CanvasPayload
from novelvideo.freezone import canvas_store
from novelvideo.freezone.workflow_drafts import (
    bind_workflow_draft_task,
    claim_workflow_draft_confirmation,
    create_workflow_draft,
    read_workflow_draft,
)
from novelvideo.task_backend.runners import freezone as freezone_runner

USER = {"id": "owner", "username": "alice"}
ENVELOPES = [{"version": "canvas_chat_commands.v1", "commands": [{"type": "create_node"}]}]


class FakePool:
    def __init__(self):
        self.calls = []
        self.status = "applied"
        self.node = {"id": "agent"}
        self.error = None
        self.receipt = None
        self.blocked = threading.Event()
        self.release = threading.Event()
        self.block = False

    def call(self, op, payload):
        assert op == "apply_commands"
        self.calls.append(deepcopy(payload))
        if self.block and len(self.calls) == 1:
            self.blocked.set()
            assert self.release.wait(5)
        if self.error:
            raise self.error
        return {
            "status": self.status,
            "canvas": {"nodes": payload["canvas"]["nodes"] + [self.node], "edges": []},
            "changes": {"created_node_ids": ["agent"]},
            "receipt": (
                self.receipt if self.receipt is not None
                else {"canvas_apply_status": self.status}
            ),
            "host_command_types": ["generate_image"] if self.status == "host_required" else [],
        }


@pytest.fixture
def setup(monkeypatch, tmp_path):
    from novelvideo.freezone import agent_canvas

    monkeypatch.setenv("DRAMACLAW_AGENT_CANVAS_EXECUTOR", "server")
    monkeypatch.setenv("DRAMACLAW_CANVAS_PATCH_PUSH", "1")
    ctx = SimpleNamespace(project_id="proj", state_dir=tmp_path, requester_user_id="owner")

    async def resolve(project, user, **kwargs):
        assert kwargs["require_home_node"] is False
        return ctx, "alice", "demo", tmp_path, str(tmp_path)

    async def catalog(_requester_user_id):
        return [{"id": "model"}]

    events = []
    monkeypatch.setattr(routes, "_resolve_freezone_project", resolve)
    monkeypatch.setattr(routes, "_freezone_image_models_data", catalog)
    monkeypatch.setattr(routes, "_freezone_video_models_data", catalog)
    append_event = routes._append_canvas_event

    def record_event(**kwargs):
        events.append(kwargs)
        append_event(**kwargs)

    monkeypatch.setattr(routes, "_append_canvas_event", record_event)
    pool = FakePool()
    monkeypatch.setattr(agent_canvas, "get_canvas_core_pool", lambda: pool)
    canvas_store.save_canvas(
        tmp_path,
        "default",
        base_revision=None,
        build_payload=lambda _: {
            "nodes": [{"id": "original"}],
            "edges": [],
            "revision": 1,
            "project_id": "proj",
            "created_by": "creator",
            "metadata": {"custom": "kept"},
            "viewport": {"x": 1, "y": 2, "zoom": 1},
        },
    )
    return tmp_path, pool, events


async def dispatch():
    return await routes.agent_canvas_commands(
        "proj", "default", routes.AgentCanvasCommandsRequest(envelopes=ENVELOPES, locale="en"), USER
    )


@pytest.mark.parametrize(
    "recorded,body_locale,expected", [("en", None, "en"), ("en", "vi", "vi"), (None, None, "zh")],
)
async def test_commands_locale_precedence(setup, monkeypatch, recorded, body_locale, expected):
    root, _, _ = setup
    state_dir = root / "state"
    if recorded is not None:
        path = state_dir / "freezone" / "ui_locale.json"
        path.parent.mkdir(parents=True)
        path.write_text(json.dumps({"locale": recorded}))
    monkeypatch.setattr(routes, "_canvas_state_project_dir", lambda *_: state_dir)
    captured = []

    async def dispatch_core(**kwargs):
        captured.append(kwargs["env"])
        return {}

    monkeypatch.setattr(routes, "dispatch_agent_canvas", dispatch_core)
    await routes.agent_canvas_commands(
        "proj", "default",
        routes.AgentCanvasCommandsRequest(envelopes=ENVELOPES, locale=body_locale), USER,
    )
    assert captured[0]["locale"] == expected


async def test_applied_save_and_metrics(setup, caplog):
    from novelvideo.freezone.agent_canvas_metrics import metrics_snapshot

    root, pool, events = setup
    before = metrics_snapshot().get("agent_canvas_write.applied", 0)
    with caplog.at_level(logging.INFO):
        response = await dispatch()
    assert response["data"]["status"] == "applied"
    assert response["data"]["revision"] == 2
    assert response["data"]["recompute_count"] == 0
    saved = canvas_store.read_canvas(root, "default")
    assert saved["save_source"] == "agent_patch"
    assert saved["metadata"]["custom"] == "kept"
    assert saved["created_by"] == "creator"
    assert set(pool.calls[0]["canvas"]) == {"nodes", "edges", "viewport", "metadata", "revision"}
    assert saved["viewport"] == {"x": 1, "y": 2, "zoom": 1}
    assert events[0]["event_type"] == "canvas.saved"
    assert events[0]["payload"]["save_source"] == "agent_patch"
    record = json.loads(routes._canvas_event_log_path(root, "default").read_text())
    assert record["event_type"] == "canvas.saved"
    assert record["payload"]["save_source"] == "agent_patch"
    assert record["payload"]["revision"] == 2
    assert pool.calls[0]["env"] == {
        "locale": "en",
        "catalogs": {"image": [{"id": "model"}], "video": [{"id": "model"}]},
    }
    assert "agent_canvas_write project=proj canvas=default commands=create_node result=applied" in (
        caplog.text
    )
    assert metrics_snapshot()["agent_canvas_write.applied"] == before + 1


async def test_applied_preserves_stored_view_state(setup, monkeypatch):
    from novelvideo.freezone.canvas_changes import read_canvas_changes

    root, pool, _ = setup
    previous = canvas_store.save_canvas(
        root,
        "default",
        base_revision=1,
        build_payload=lambda existing: {
            **existing,
            "revision": 2,
            "nodes": [{"id": "original", "selected": True}, {"id": "other"}],
            "edges": [{"id": "e1", "source": "original", "target": "other"}],
        },
    ).payload
    output = {
        "nodes": [
            {"id": "original", "selected": False, "dragging": True},
            {"id": "other", "selected": True},
            {"id": "agent", "selected": True, "resizing": True},
        ],
        "edges": [{"id": "e1", "source": "original", "target": "other", "selected": True}],
    }
    original_output = deepcopy(output)
    compute = pool.call

    def apply_with_view_state(op, payload):
        result = compute(op, payload)
        result["canvas"] = output
        return result

    monkeypatch.setattr(pool, "call", apply_with_view_state)
    response = await dispatch()
    assert response["data"]["status"] == "applied"
    assert response["data"]["revision"] == previous["revision"] + 1
    saved = canvas_store.read_canvas(root, "default")
    assert saved["nodes"] == [
        {"id": "original", "selected": True},
        {"id": "other"},
        {"id": "agent"},
    ]
    assert saved["edges"] == previous["edges"]
    replay = read_canvas_changes(root, "default", previous["revision"])
    assert replay.reset_revision is None
    assert len(replay.entries) == 1
    frame = replay.entries[0]
    assert frame["revision"] == saved["revision"]
    assert frame["nodes"] == [{"id": "agent"}]
    assert frame["edges"] == []
    assert frame["deleted_node_ids"] == []
    assert frame["deleted_edge_ids"] == []
    assert output == original_output


async def test_node_computes_without_canvas_lock_and_recomputes(setup):
    root, pool, _ = setup
    pool.block = True
    task = asyncio.create_task(dispatch())
    try:
        assert await asyncio.to_thread(pool.blocked.wait, 2)
        started = time.monotonic()
        await routes.put_canvas(
            "proj",
            "default",
            CanvasPayload(
                nodes=[{"id": "original"}, {"id": "browser"}],
                edges=[],
                base_revision=1,
                save_source="autosave",
            ),
            USER,
        )
        assert time.monotonic() - started < 1
    finally:
        pool.release.set()
    result = await task
    assert result["data"]["recompute_count"] == 1
    assert result["data"]["revision"] == 3
    assert {node["id"] for node in canvas_store.read_canvas(root, "default")["nodes"]} == {
        "original",
        "browser",
        "agent",
    }
    assert len(pool.calls) == 2


async def test_three_conflicts(setup, monkeypatch):
    root, pool, events = setup
    compute = pool.call

    def race(op, payload):
        result = compute(op, payload)
        canvas_store.save_canvas(
            root,
            "default",
            base_revision=payload["canvas"]["revision"],
            build_payload=lambda existing: {
                **existing,
                "revision": existing["revision"] + 1,
                "nodes": existing["nodes"] + [{"id": f"browser-{len(pool.calls)}"}],
            },
        )
        return result

    monkeypatch.setattr(pool, "call", race)
    with pytest.raises(HTTPException) as error:
        await dispatch()
    assert error.value.status_code == 409
    assert error.value.detail["code"] == "canvas_revision_conflict"
    assert error.value.detail["current_revision"] == 4
    assert len(pool.calls) == 3
    assert not events
    saved = canvas_store.read_canvas(root, "default")
    assert saved["revision"] == 4
    assert [node["id"] for node in saved["nodes"]] == [
        "original",
        "browser-1",
        "browser-2",
        "browser-3",
    ]


@pytest.mark.parametrize("status", ["validation_failed", "host_required"])
async def test_no_write_results(setup, status):
    root, pool, events = setup
    pool.status = status
    response = await dispatch()
    assert response["data"]["status"] == status
    assert response["data"]["revision"] == 1
    if status == "host_required":
        assert response["data"]["host_command_types"] == ["generate_image"]
    assert response["data"]["receipt"]["canvas_apply_status"] == status
    assert not events
    assert canvas_store.read_canvas(root, "default")["revision"] == 1


@pytest.mark.parametrize(
    "url,code",
    [
        ("data:image/png;base64,AAAA", "canvas_inline_media"),
        ("/api/v1/projects/other/media/image.png", "canvas_media_scope_mismatch"),
    ],
)
async def test_media_rejected(setup, url, code):
    root, pool, events = setup
    pool.node = {"id": "agent", "data": {"imageUrl": url}}
    with pytest.raises(HTTPException) as error:
        await dispatch()
    assert error.value.status_code == 422
    assert error.value.detail["code"] == code
    if code == "canvas_inline_media":
        assert error.value.detail["fields"] == [{"node_id": "agent", "field": "imageUrl"}]
    assert not events
    assert canvas_store.read_canvas(root, "default")["revision"] == 1


async def test_node_error_leaves_save_available(setup):
    from novelvideo.freezone.canvas_core_pool import CanvasCoreError

    root, pool, _ = setup
    pool.error = CanvasCoreError("canvas_core_timeout", "timeout")
    with pytest.raises(HTTPException) as error:
        await dispatch()
    assert error.value.status_code == 503
    assert error.value.detail["code"] == "canvas_core_timeout"
    await routes.put_canvas(
        "proj",
        "default",
        CanvasPayload(
            nodes=[{"id": "browser"}],
            base_revision=1,
        ),
        USER,
    )
    assert canvas_store.read_canvas(root, "default")["revision"] == 2


async def test_browser_executor(setup, monkeypatch):
    monkeypatch.setenv("DRAMACLAW_AGENT_CANVAS_EXECUTOR", "browser")
    with pytest.raises(HTTPException) as error:
        await dispatch()
    assert error.value.status_code == 409
    assert error.value.detail == {"code": "agent_canvas_executor_browser"}


async def test_autosave_busy_metric(setup, caplog):
    from novelvideo.freezone.agent_canvas_metrics import metrics_snapshot
    from novelvideo.freezone.canvas_lock import canvas_write_lock

    root, _, _ = setup
    before = metrics_snapshot().get("canvas_autosave_lock_busy", 0)

    with (
        canvas_write_lock(root, "default"),
        caplog.at_level(logging.WARNING),
        pytest.raises(HTTPException) as error,
    ):
        await routes.put_canvas(
            "proj",
            "default",
            CanvasPayload(
                nodes=[{"id": "browser"}],
                base_revision=1,
            ),
            USER,
        )
    assert error.value.detail["code"] == "canvas_lock_busy"
    assert "canvas_autosave_lock_busy project=proj canvas=default" in caplog.text
    assert metrics_snapshot()["canvas_autosave_lock_busy"] == before + 1


@pytest.mark.parametrize(
    "user,status",
    [
        (
            {
                **USER,
                "credential_kind": "agent_session",
                "scopes": [],
                "current_scope_kind": "project",
                "current_project_id": "proj",
            },
            403,
        ),
        (
            {
                **USER,
                "credential_kind": "agent_session",
                "scopes": ["projects:write"],
                "current_scope_kind": "project",
                "current_project_id": "other",
            },
            403,
        ),
        (
            {
                **USER,
                "credential_kind": "agent_session",
                "scopes": ["projects:write"],
                "current_scope_kind": "project",
                "current_project_id": "proj",
            },
            200,
        ),
        (USER, 200),
    ],
)
@pytest.mark.parametrize("canvas_id", ["default", "fresh"])
def test_auth_dependency(setup, user, status, canvas_id):
    from novelvideo.api.auth import get_api_user

    app = FastAPI()
    app.include_router(routes.router)
    app.dependency_overrides[get_api_user] = lambda: user
    client = TestClient(app)
    response = client.post(
        f"/projects/proj/freezone/canvases/{canvas_id}/agent-commands",
        json={"envelopes": ENVELOPES}
    )
    assert response.status_code == status


@pytest.mark.parametrize(
    "body",
    [
        {"envelopes": []},
        {"envelopes": ENVELOPES * 21},
        {"envelopes": ENVELOPES, "locale": "fr"},
    ],
)
def test_request_validation(setup, body):
    from novelvideo.api.auth import get_api_user

    app = FastAPI()
    app.include_router(routes.router)
    app.dependency_overrides[get_api_user] = lambda: USER
    assert (
        TestClient(app)
        .post(
            "/projects/proj/freezone/canvases/default/agent-commands",
            json=body,
        )
        .status_code
        == 422
    )


async def test_invalid_commands_reach_worker_validation(setup):
    _, pool, events = setup
    pool.status = "validation_failed"
    response = await routes.agent_canvas_commands(
        "proj",
        "default",
        routes.AgentCanvasCommandsRequest(
            envelopes=[{"commands": None}],
        ),
        USER,
    )
    assert response["data"]["status"] == "validation_failed"
    assert not events


async def test_size_validator_applies_to_agent_result(setup, monkeypatch):
    from novelvideo.api import schemas

    root, _, events = setup
    monkeypatch.setattr(schemas, "CANVAS_MAX_NODES", 1)
    with pytest.raises(HTTPException) as error:
        await dispatch()
    assert error.value.status_code == 422
    assert error.value.detail["code"] == "canvas_payload_too_large"
    assert canvas_store.read_canvas(root, "default")["revision"] == 1
    assert not events


async def test_invalid_worker_result_is_protocol_error(setup, monkeypatch):
    root, pool, events = setup
    monkeypatch.setattr(pool, "call", lambda *_: {"status": "applied"})
    with pytest.raises(HTTPException) as error:
        await dispatch()
    assert error.value.status_code == 503
    assert error.value.detail["code"] == "canvas_core_protocol"
    assert canvas_store.read_canvas(root, "default")["revision"] == 1
    assert not events


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

    root, pool, events = setup
    stored = canvas_store.read_canvas(root, "default")
    pool.error = CanvasCoreError(code, message)
    metric = f"agent_canvas_write.{outcome}"
    before = metrics_snapshot().get(metric, 0)
    with caplog.at_level(logging.INFO), pytest.raises(HTTPException) as error:
        await dispatch()
    assert error.value.status_code == status
    assert error.value.detail == detail
    assert metrics_snapshot()[metric] == before + 1
    assert f"result={outcome}" in caplog.text
    assert canvas_store.read_canvas(root, "default") == stored
    assert not events


async def test_agent_write_creates_never_saved_canvas(setup):
    root, pool, events = setup
    response = await routes.agent_canvas_commands(
        "proj", "fresh",
        routes.AgentCanvasCommandsRequest(envelopes=ENVELOPES, locale="en"), USER,
    )
    assert response["data"]["status"] == "applied"
    assert response["data"]["revision"] == 1
    assert pool.calls[0]["canvas"] == {"nodes": [], "edges": []}
    saved = canvas_store.read_canvas(root, "fresh")
    assert saved["nodes"] == [{"id": "agent"}]
    assert saved["revision"] == 1
    assert saved["save_source"] == "agent_patch"
    assert saved["project_id"] == "proj"
    assert saved["canvas_id"] == "fresh"
    assert saved["canvas_scope"] == "default"
    assert saved["owner_principal_type"] == "user"
    assert saved["owner_principal_id"] == "owner"
    assert saved["access_model"] == "project_role"
    assert saved["min_project_role"] == "editor"
    assert saved["created_by"] == "owner"
    assert saved["updated_by"] == "owner"
    assert events[0]["event_type"] == "canvas.saved"
    assert events[0]["payload"]["revision"] == 1


async def test_agent_write_retries_when_new_canvas_appears_concurrently(setup, monkeypatch):
    root, pool, _ = setup
    compute = pool.call

    def race(op, payload):
        result = compute(op, payload)
        if len(pool.calls) == 1:
            canvas_store.save_canvas(
                root, "fresh", base_revision=None,
                build_payload=lambda _: {
                    "nodes": [{"id": "browser"}], "edges": [],
                    "revision": 1, "project_id": "proj",
                },
            )
        return result

    monkeypatch.setattr(pool, "call", race)
    response = await routes.agent_canvas_commands(
        "proj", "fresh",
        routes.AgentCanvasCommandsRequest(envelopes=ENVELOPES, locale="en"), USER,
    )
    assert response["data"]["status"] == "applied"
    assert response["data"]["revision"] == 2
    assert len(pool.calls) == 2
    assert pool.calls[1]["canvas"]["nodes"] == [{"id": "browser"}]
    saved = canvas_store.read_canvas(root, "fresh")
    assert [node["id"] for node in saved["nodes"]] == ["browser", "agent"]


def _claimed_server_workflow(root, pool, monkeypatch, *, task_status="running"):
    draft = create_workflow_draft(
        project_dir=root, project_id="proj", canvas_id="default",
        intent={"skill_id": "video-ad", "user_goal": "ad"},
        compiled={
            "ok": True, "skill_id": "video-ad", "edge_count": 0,
            "plan": {"summary": "ad", "nodes": [], "edges": [], "phases": []},
        },
    )
    draft_id = draft["draft_id"]
    claimed, error = claim_workflow_draft_confirmation(
        project_dir=root, canvas_id="default", draft_id=draft_id, revision=1, now=1_000,
    )
    assert error is None
    assert claimed is not None
    bound = bind_workflow_draft_task(
        project_dir=root, canvas_id="default", draft_id=draft_id,
        task_id="task-1", root_task_id="task-1",
    )
    assert bound is not None
    lookups = []

    def get_task_for_project(ctx, task_type, index, beat_num=None, scope=None):
        lookups.append((task_type, scope))
        return SimpleNamespace(task_id="task-1", status=task_status)

    monkeypatch.setattr(
        "novelvideo.task_state.get_task_manager",
        lambda: SimpleNamespace(get_task_for_project=get_task_for_project),
    )
    pool.receipt = {
        "tool_call_status": "completed", "canvas_apply_status": "applied",
        "applied": True, "cancelled": False, "errors": [],
    }
    request = routes.AgentCanvasCommandsRequest(envelopes=[{
        "version": "canvas_chat_commands.v1",
        "commands": [{
            "type": "create_node", "node_type": "textAnnotationNode",
            "data": {
                "workflowInstanceId": draft_id, "workflowDraftRevision": 1,
                "workflowConfirmationTaskId": "task-1",
            },
        }],
    }], locale="en")
    return draft, request, lookups


async def test_server_applied_workflow_commands_confirm_draft_and_finish_task(setup, monkeypatch):
    root, pool, _ = setup
    draft, request, lookups = _claimed_server_workflow(root, pool, monkeypatch)
    draft_id = draft["draft_id"]
    await routes.agent_canvas_commands("proj", "default", request, USER)
    assert read_workflow_draft(
        project_dir=root, canvas_id="default", draft_id=draft_id,
    )[0]["status"] == "confirmed"
    assert lookups[0] == ("freezone_workflow_confirm", f"default:{draft_id}:1:1000.0")

    async def unexpected_sleep(_seconds):
        raise AssertionError("An applied workflow must finish without polling")

    monkeypatch.setattr(freezone_runner.asyncio, "sleep", unexpected_sleep)
    envelope = {
        "task_type": "freezone_workflow_confirm", "__run_task_id": "task-1",
        "payload": {
            "canvas_id": "default", "draft_id": draft_id, "revision": 1,
            "plan_digest": draft["plan_digest"],
        },
    }
    result = await freezone_runner._run_freezone_workflow_confirm_async(
        envelope, SimpleNamespace(state_dir=root),
    )
    assert result["delivery_status"] == "canvas_applied"


async def test_server_workflow_commands_with_failed_receipt_release_draft(setup, monkeypatch):
    root, pool, _ = setup
    draft, request, _ = _claimed_server_workflow(root, pool, monkeypatch)
    pool.receipt["errors"] = [{"code": "x"}]
    await routes.agent_canvas_commands("proj", "default", request, USER)
    assert read_workflow_draft(
        project_dir=root, canvas_id="default", draft_id=draft["draft_id"],
    )[0]["status"] == "ready"


async def test_server_workflow_commands_ignore_inactive_task(setup, monkeypatch):
    root, pool, _ = setup
    draft, request, _ = _claimed_server_workflow(
        root, pool, monkeypatch, task_status="completed",
    )
    await routes.agent_canvas_commands("proj", "default", request, USER)
    assert read_workflow_draft(
        project_dir=root, canvas_id="default", draft_id=draft["draft_id"],
    )[0]["status"] == "confirming"


async def test_server_host_required_workflow_commands_leave_draft_claimed(setup, monkeypatch):
    root, pool, _ = setup
    draft, request, _ = _claimed_server_workflow(root, pool, monkeypatch)
    pool.status = "host_required"
    await routes.agent_canvas_commands("proj", "default", request, USER)
    assert read_workflow_draft(
        project_dir=root, canvas_id="default", draft_id=draft["draft_id"],
    )[0]["status"] == "confirming"
