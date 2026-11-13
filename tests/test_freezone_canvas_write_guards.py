# SPDX-License-Identifier: Elastic-2.0
# Copyright (c) 2026 ClaymoreLab
"""Canvas write boundaries and creation route wiring without a Node dependency."""

from copy import deepcopy
from contextlib import contextmanager
from functools import partial
from types import SimpleNamespace

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from pydantic import ValidationError
import pytest

from novelvideo.api.auth import get_api_user
from novelvideo.api.routes import freezone as routes
from novelvideo.api.schemas import (
    AgentCanvasCommandsRequest,
    CanvasConfirmationDecisionRequest,
    CanvasConfirmationRequest,
    CanvasPayload,
    ProjectionPresetCanvasRequest,
)
from novelvideo.freezone import agent_canvas, canvas_core_pool, canvas_store, paths
from novelvideo.freezone.canvas_core_pool import CanvasCoreError
from novelvideo.freezone.canvas_lock import CanvasLockBusy
from novelvideo.ports import registry as ports_registry
from novelvideo.ports.project import require_role_value
from novelvideo.project_context import ProjectContext

USER = {"id": "u-alice", "username": "alice"}
ORIGIN = {"chat_canvas_id": "chat-1", "turn_id": "turn-1"}
PROTECTED_METADATA = {
    "canvas_origin": "user_created",
    "creator_username": "alice",
    "agent_origin": ORIGIN,
    "create_request_id": "original-request",
}
FORGED_METADATA = {
    "canvas_origin": "conflict_copy",
    "creator_username": "mallory",
    "agent_origin": {"chat_canvas_id": "forged-chat", "turn_id": "forged-turn"},
    "create_request_id": "forged-request",
}
ENVELOPES = [
    {"version": "canvas_chat_commands.v1", "commands": [{"type": "create_node"}]}
]


def _project_ctx(tmp_path, role="editor"):
    return ProjectContext(
        project_id="proj",
        project_name="demo",
        owner_type="user",
        owner_id="u-alice",
        owner_username="alice",
        requester_user_id="u-alice",
        requester_username="alice",
        requester_principals=(("user", "u-alice"),),
        effective_role=role,
        home_node_id="node-a",
        output_dir=tmp_path / "output",
        state_dir=tmp_path / "state",
        runtime_dir=tmp_path / "runtime",
        is_home_node=False,
    )


@pytest.fixture
def project(monkeypatch, tmp_path):
    ctx = _project_ctx(tmp_path)
    harness = SimpleNamespace(ctx=ctx, root=ctx.state_dir, events=[], resolutions=[])

    async def resolve(project, user, **kwargs):
        harness.resolutions.append(kwargs)
        return ctx, "alice", "demo", ctx.output_dir, str(ctx.output_dir)

    def record_event(**kwargs):
        harness.events.append(kwargs)

    monkeypatch.setattr(routes, "_resolve_freezone_project", resolve)
    monkeypatch.setattr(routes, "_append_canvas_event", record_event)
    return harness


def _seed(root, canvas_id, metadata=None):
    return canvas_store.save_canvas(
        root,
        canvas_id,
        base_revision=None,
        build_payload=lambda _: {
            "schema_version": 2,
            "project_id": "proj",
            "canvas_id": canvas_id,
            "revision": 1,
            "nodes": [],
            "edges": [],
            "metadata": deepcopy(metadata or {}),
        },
    ).payload


async def test_put_update_keeps_server_metadata_and_merges_custom_fields(project):
    _seed(project.root, "canvas_abc", {**PROTECTED_METADATA, "display_name": "A"})
    response = await routes.put_canvas(
        "proj",
        "canvas_abc",
        CanvasPayload(
            base_revision=1,
            nodes=[],
            edges=[],
            metadata={
                **FORGED_METADATA,
                "display_name": "Renamed",
                "custom": "kept",
            },
        ),
        USER,
    )
    assert response["data"]["revision"] == 2
    assert canvas_store.read_canvas(project.root, "canvas_abc")["metadata"] == {
        **PROTECTED_METADATA,
        "display_name": "Renamed",
        "custom": "kept",
    }


async def test_put_update_cannot_add_missing_server_metadata(project):
    _seed(project.root, "default", {"display_name": "A"})
    await routes.put_canvas(
        "proj",
        "default",
        CanvasPayload(
            base_revision=1,
            nodes=[],
            edges=[],
            metadata={**FORGED_METADATA, "custom": "kept"},
        ),
        USER,
    )
    assert canvas_store.read_canvas(project.root, "default")["metadata"] == {
        "display_name": "A",
        "custom": "kept",
    }


def test_put_can_still_create_with_legacy_creator_metadata(project):
    app = FastAPI()
    app.include_router(routes.router, prefix="/api/v1")
    app.dependency_overrides[get_api_user] = lambda: USER
    with TestClient(app) as client:
        response = client.put(
            "/api/v1/projects/proj/freezone/canvases/canvas_legacy",
            json={
                "nodes": [],
                "edges": [],
                "metadata": {**PROTECTED_METADATA, "display_name": "Legacy"},
            },
        )
    assert response.status_code == 200, response.text
    assert response.json()["ok"] is True
    assert response.json()["data"]["revision"] == 1
    assert canvas_store.read_canvas(project.root, "canvas_legacy")["metadata"] == {
        "canvas_origin": "user_created",
        "creator_username": "alice",
        "display_name": "Legacy",
    }


@pytest.mark.parametrize(
    "raw", [False, True], ids=["body-writer", "raw-payload-writer"]
)
@pytest.mark.parametrize(
    "stored", [PROTECTED_METADATA, {}], ids=["attributed", "legacy"]
)
def test_shared_write_preparation_preserves_only_stored_server_metadata(raw, stored):
    incoming = {
        "nodes": [],
        "edges": [],
        "metadata": {**FORGED_METADATA, "custom": "kept"},
    }
    payload = routes._prepare_canvas_payload_for_write(
        project_id="proj",
        canvas_id="canvas_abc",
        user=USER,
        existing={"revision": 1, "metadata": deepcopy(stored)},
        body=None if raw else CanvasPayload(**incoming),
        **({"raw_payload": incoming} if raw else {}),
    )
    assert payload["metadata"] == {**stored, "custom": "kept"}


@pytest.mark.parametrize(
    "handler",
    [
        "put_canvas",
        "agent_canvas_commands",
        "create_canvas_confirmation",
        "decide_canvas_confirmation",
        "project_canvas_from_preset",
    ],
)
async def test_reserved_create_id_is_rejected_before_project_resolution(
    monkeypatch, tmp_path, handler
):
    resolutions = []

    async def resolve(*args, **kwargs):
        resolutions.append((args, kwargs))
        raise HTTPException(599, "Project resolution must not be reached")

    monkeypatch.setattr(routes, "_resolve_freezone_project", resolve)
    bodies = {
        "put_canvas": CanvasPayload(nodes=[], edges=[]),
        "agent_canvas_commands": AgentCanvasCommandsRequest(envelopes=ENVELOPES),
        "create_canvas_confirmation": CanvasConfirmationRequest(
            commands=[{"type": "delete_nodes", "node_ids": ["n1"]}]
        ),
        "decide_canvas_confirmation": CanvasConfirmationDecisionRequest(
            decision="confirmed", via="card"
        ),
        "project_canvas_from_preset": ProjectionPresetCanvasRequest(
            scope="blank",
            projection_key="blank:user",
            base_revision=0,
        ),
    }
    with pytest.raises(HTTPException) as exc:
        await getattr(routes, handler)(
            project="proj",
            canvas_id="__create__",
            body=bodies[handler],
            user=USER,
            **(
                {"confirmation_id": "confirmation-1"}
                if handler == "decide_canvas_confirmation"
                else {}
            ),
        )
    assert exc.value.status_code == 400
    if handler == "decide_canvas_confirmation":
        assert exc.value.detail["code"] == "invalid_canvas_id"
    else:
        assert exc.value.detail == "invalid canvas_id"
    assert resolutions == []
    assert list(tmp_path.rglob("__create__.json")) == []


async def test_normal_non_reserved_id_still_works_through_put(project):
    response = await routes.put_canvas(
        "proj", "fresh_canvas", CanvasPayload(nodes=[], edges=[]), USER
    )
    assert response["ok"] is True
    assert response["data"]["revision"] == 1
    assert canvas_store.read_canvas(project.root, "fresh_canvas") is not None


@pytest.mark.parametrize(
    "canvas_id,expected",
    [
        ("__create__", False),
        ("default", True),
        ("canvas_x", True),
        ("bad id", False),
    ],
)
def test_writable_canvas_id_excludes_reserved_and_invalid_ids(canvas_id, expected):
    assert paths.is_writable_canvas_id(canvas_id) is expected


def test_create_mutex_id_is_reserved():
    assert paths.CANVAS_CREATE_LOCK_ID == "__create__"
    assert paths.RESERVED_CANVAS_IDS == frozenset({"__create__"})


class FakePool:
    def __init__(self):
        self.calls = []

    def call(self, op, payload):
        assert op == "apply_commands"
        self.calls.append((op, deepcopy(payload)))
        return {
            "status": "applied",
            "canvas": {
                "nodes": payload["canvas"]["nodes"] + [{"id": "agent"}],
                "edges": [],
            },
            "changes": {"created_node_ids": ["agent"]},
            "receipt": {"canvas_apply_status": "applied"},
            "host_command_types": [],
        }


@pytest.fixture
def executor(project, monkeypatch):
    monkeypatch.setenv("DRAMACLAW_AGENT_CANVAS_EXECUTOR", "server")
    monkeypatch.setenv("DRAMACLAW_CANVAS_PATCH_PUSH", "1")

    async def catalog(_requester_user_id):
        return [{"id": "model"}]

    monkeypatch.setattr(routes, "_freezone_image_models_data", catalog)
    monkeypatch.setattr(routes, "_freezone_video_models_data", catalog)
    pool = FakePool()
    monkeypatch.setattr(agent_canvas, "get_canvas_core_pool", lambda: pool)
    return project, pool


async def _commands(canvas_id):
    return await routes.agent_canvas_commands(
        "proj",
        canvas_id,
        AgentCanvasCommandsRequest(envelopes=ENVELOPES, locale="en"),
        USER,
    )


async def test_missing_user_created_canvas_returns_not_found_without_node_call(
    executor,
):
    project, pool = executor
    with pytest.raises(HTTPException) as exc:
        await _commands("canvas_missing_1")
    assert exc.value.status_code == 404
    assert exc.value.detail == {
        "code": "canvas_not_found",
        "canvas_id": "canvas_missing_1",
    }
    assert pool.calls == []
    assert canvas_store.read_canvas(project.root, "canvas_missing_1") is None
    assert canvas_store.list_canvases(project.root) == []
    assert project.events == []


async def test_existing_user_created_canvas_accepts_agent_commands(executor):
    project, pool = executor
    _seed(project.root, "canvas_present_1", PROTECTED_METADATA)
    response = await _commands("canvas_present_1")
    assert response["data"]["status"] == "applied"
    assert response["data"]["revision"] == 2
    assert len(pool.calls) == 1
    assert canvas_store.read_canvas(project.root, "canvas_present_1")["nodes"] == [
        {"id": "agent"}
    ]


async def test_missing_non_prefixed_canvas_keeps_implicit_agent_creation(executor):
    project, pool = executor
    response = await _commands("user_bob_fresh")
    assert response["data"]["status"] == "applied"
    assert response["data"]["revision"] == 1
    assert len(pool.calls) == 1
    assert canvas_store.read_canvas(project.root, "user_bob_fresh")["nodes"] == [
        {"id": "agent"}
    ]


async def test_dispatch_raises_typed_not_found_before_computation(executor):
    project, pool = executor
    with pytest.raises(agent_canvas.CanvasNotFoundError) as exc:
        await agent_canvas.dispatch_agent_canvas(
            project="proj",
            canvas_id="canvas_missing_1",
            project_dir=project.root,
            envelopes=ENVELOPES,
            env={"locale": "en", "catalogs": {}},
            build_payload=partial(
                routes._canvas_payload_builder,
                project="proj",
                canvas_id="canvas_missing_1",
                user=USER,
                ctx=project.ctx,
            ),
            after_save=partial(
                routes._after_canvas_save,
                project="proj",
                canvas_id="canvas_missing_1",
                canvas_project_dir=project.root,
                user=USER,
            ),
        )
    assert isinstance(exc.value, RuntimeError)
    assert exc.value.code == "canvas_not_found"
    assert exc.value.canvas_id == "canvas_missing_1"
    assert pool.calls == []
    assert canvas_store.read_canvas(project.root, "canvas_missing_1") is None
    assert project.events == []


def _patch_creation_pool(monkeypatch, pool):
    from novelvideo.freezone import canvas_creation

    monkeypatch.setattr(canvas_creation, "get_canvas_core_pool", lambda: pool)


@pytest.mark.parametrize(
    "code,status,detail_code",
    [
        ("canvas_core_unavailable", 503, "canvas_core_unavailable"),
        ("invalid_request", 422, "invalid_canvas_create_request"),
        ("canvas_core_timeout", 503, "canvas_core_timeout"),
    ],
)
async def test_create_maps_core_errors_without_writing(
    project, monkeypatch, code, status, detail_code
):
    from novelvideo.api.schemas import CanvasCreateRequest

    class ErrorPool:
        def call(self, op, payload):
            raise CanvasCoreError(code, "Canvas test failure")

    _patch_creation_pool(monkeypatch, ErrorPool())
    with pytest.raises(HTTPException) as exc:
        await routes.create_canvas(
            "proj", CanvasCreateRequest(name="New plan", request_id="req-1"), USER
        )
    assert exc.value.status_code == status
    assert exc.value.detail["code"] == detail_code
    assert isinstance(exc.value.detail["message"], str)
    if status == 503:
        assert "pnpm run build:canvas-server" in exc.value.detail["message"]
    assert canvas_store.list_canvases(project.root) == []
    assert project.events == []


class CreationPool:
    """Return explicit core plans so HTTP tests depend on no Node installation."""

    def __init__(self):
        self.calls = []

    def call(self, op, payload):
        self.calls.append((op, deepcopy(payload)))
        if op == "describe_canvases":
            return {
                "canvases": [],
                "quota": {"status": "available", "used": 0, "limit": 25},
            }
        assert op == "plan_canvas_creation"
        return {
            "status": "ready",
            "canvasId": "canvas_new_test",
            "payload": {
                "schema_version": 2,
                "canvas_id": "canvas_new_test",
                "project_id": payload["project_id"],
                "base_revision": None,
                "client_save_id": payload["request_id"],
                "save_source": payload["save_source"],
                "nodes": [],
                "edges": [],
                "viewport": None,
                "metadata": {
                    "canvas_origin": "user_created",
                    "display_name": payload["name"].strip(),
                    "creator_username": payload["creator_username"],
                    "create_request_id": payload["request_id"],
                },
            },
        }


async def test_create_lock_busy_returns_service_unavailable_without_saving(
    project, monkeypatch
):
    from novelvideo.api.schemas import CanvasCreateRequest

    class BusyMutex:
        @contextmanager
        def write_mutex(self, root, canvas_id, **kwargs):
            assert canvas_id == "__create__"
            raise CanvasLockBusy(canvas_id)
            yield  # The mutex interface returns a context manager.

    ports_registry.register_port("canvas_write_mutex", BusyMutex())
    _patch_creation_pool(monkeypatch, CreationPool())
    with pytest.raises(HTTPException) as exc:
        await routes.create_canvas(
            "proj", CanvasCreateRequest(name="New plan", request_id="req-1"), USER
        )
    assert exc.value.status_code == 503
    assert exc.value.detail["code"] == "canvas_lock_busy"
    assert canvas_store.list_canvases(project.root) == []
    assert project.events == []


def _http_app(monkeypatch, tmp_path, *, role, user):
    ctx = _project_ctx(tmp_path, role)
    resolutions = []

    async def resolve(*, user, project_id, required_role="editor"):
        assert project_id == "proj"
        resolutions.append(required_role)
        require_role_value(ctx.effective_role, required_role)
        return ctx

    monkeypatch.setattr(routes, "resolve_project_context", resolve)
    monkeypatch.setattr(routes, "_append_canvas_event", lambda **kwargs: None)
    pool = CreationPool()
    _patch_creation_pool(monkeypatch, pool)
    app = FastAPI()
    app.include_router(routes.router, prefix="/api/v1")
    app.dependency_overrides[get_api_user] = lambda: user
    return app, ctx, pool, resolutions


def test_http_viewer_can_read_agent_view_but_cannot_create(monkeypatch, tmp_path):
    app, ctx, pool, resolutions = _http_app(
        monkeypatch, tmp_path, role="viewer", user=USER
    )
    with TestClient(app) as client:
        rejected = client.post(
            "/api/v1/projects/proj/freezone/canvases:create",
            json={"name": "New plan", "request_id": "req-1"},
        )
        assert rejected.status_code == 403, rejected.text
        response = client.get(
            "/api/v1/projects/proj/freezone/canvases:agent-view?locale=en"
        )
    assert response.status_code == 200, response.text
    assert response.json()["ok"] is True
    assert resolutions == ["editor", "viewer"]
    assert [op for op, _ in pool.calls] == ["describe_canvases"]
    assert canvas_store.read_canvas(ctx.state_dir, "canvas_new_test") is None


def test_http_editor_can_create_on_non_home_node(monkeypatch, tmp_path):
    app, ctx, pool, resolutions = _http_app(
        monkeypatch, tmp_path, role="editor", user=USER
    )
    assert ctx.is_home_node is False
    with TestClient(app) as client:
        response = client.post(
            "/api/v1/projects/proj/freezone/canvases:create",
            json={"name": "New plan", "request_id": "req-1"},
        )
    assert response.status_code == 200, response.text
    assert response.json()["data"]["status"] == "created"
    assert canvas_store.read_canvas(ctx.state_dir, "canvas_new_test")["revision"] == 1
    assert resolutions == ["editor"]
    assert any(op == "plan_canvas_creation" for op, _ in pool.calls)


@pytest.mark.parametrize(
    "scopes,current_project",
    [
        (["projects:read"], "proj"),
        (["projects:read", "projects:write"], "another-project"),
    ],
    ids=["read-only-agent", "different-active-project"],
)
def test_http_agent_create_enforces_scope_and_active_project(
    monkeypatch, tmp_path, scopes, current_project
):
    user = {
        **USER,
        "credential_kind": "agent_session",
        "scopes": scopes,
        "current_scope_kind": "project",
        "current_project_id": current_project,
    }
    app, ctx, pool, resolutions = _http_app(
        monkeypatch, tmp_path, role="editor", user=user
    )
    with TestClient(app) as client:
        response = client.post(
            "/api/v1/projects/proj/freezone/canvases:create",
            json={"name": "New plan", "request_id": "req-1"},
        )
    assert response.status_code == 403, response.text
    assert resolutions == []
    assert pool.calls == []
    assert canvas_store.list_canvases(ctx.state_dir) == []


@pytest.mark.parametrize(
    "name,method,path,scope",
    [
        (
            "create_canvas",
            "POST",
            "/projects/{project}/freezone/canvases:create",
            "projects:write",
        ),
        (
            "get_canvas_agent_view",
            "GET",
            "/projects/{project}/freezone/canvases:agent-view",
            "projects:read",
        ),
    ],
)
def test_creation_routes_declare_project_scopes(name, method, path, scope):
    matches = [route for route in routes.router.routes if route.name == name]
    assert len(matches) == 1, f"Missing route: {name}"
    route = matches[0]
    assert route.path == path
    assert method in route.methods

    def scopes(dependant):
        return {getattr(dependant.call, "_required_scope", None)} | {
            value
            for dependency in dependant.dependencies
            for value in scopes(dependency)
        }

    assert scope in scopes(route.dependant)


@pytest.mark.parametrize("state", ["missing-bundle", "missing-node", "available"])
def test_unavailable_reason_checks_prerequisites_without_creating_pool(
    monkeypatch, tmp_path, state
):
    bundle = tmp_path / "worker.mjs"
    if state != "missing-bundle":
        bundle.write_text("// Test bundle placeholder\n")
    monkeypatch.setenv("DRAMACLAW_CANVAS_CORE_BUNDLE", str(bundle))
    monkeypatch.setattr(
        canvas_core_pool.shutil,
        "which",
        lambda name: None if state == "missing-node" else "/test/bin/node",
    )
    existing_pool = canvas_core_pool._pool

    def forbidden_pool():
        pytest.fail("Prerequisite inspection must not create a canvas core pool")

    monkeypatch.setattr(canvas_core_pool, "get_canvas_core_pool", forbidden_pool)
    reason = canvas_core_pool.canvas_core_unavailable_reason()
    if state == "available":
        assert reason is None
    elif state == "missing-bundle":
        assert "pnpm run build:canvas-server" in reason
        assert "bundle" in reason.lower()
    else:
        assert "node" in reason.lower()
    assert canvas_core_pool._pool is existing_pool


@pytest.mark.parametrize(
    "changes",
    [
        {"name": "x" * 101},
        {"request_id": ""},
        {"request_id": "r" * 129},
        {"name": 3},
        {"locale": "fr"},
        {"origin": {"chat_canvas_id": "chat-1"}},
    ],
)
def test_create_schema_rejects_invalid_body(changes):
    from novelvideo.api.schemas import CanvasCreateRequest

    with pytest.raises(ValidationError):
        CanvasCreateRequest(**{"name": "New plan", "request_id": "req-1", **changes})


def test_create_schema_accepts_limits_and_ignores_extra_fields():
    from novelvideo.api.schemas import CanvasCreateOrigin, CanvasCreateRequest

    body = CanvasCreateRequest(
        name="n" * 100,
        request_id="r" * 128,
        creator_username="mallory",
        metadata={"custom": "forged"},
        origin=ORIGIN,
    )
    assert body.locale is None
    assert isinstance(body.origin, CanvasCreateOrigin)
    assert body.origin.model_dump() == ORIGIN
    assert set(body.model_dump()) == {"name", "request_id", "locale", "origin"}
    assert CanvasCreateRequest(name="N", request_id="r").origin is None
