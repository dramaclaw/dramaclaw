# SPDX-License-Identifier: Elastic-2.0
# Copyright (c) 2026 ClaymoreLab
"""Server canvas creation contracts exercised against the real Node worker."""

import asyncio
from copy import deepcopy
from contextlib import contextmanager
from dataclasses import replace
import json
from pathlib import Path
import threading
from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest

from canvas_core_requirements import CANVAS_CORE_BUNDLE, requires_canvas_core_bundle
from novelvideo.api.auth import get_api_user
from novelvideo.api.routes import freezone as routes
from novelvideo.freezone import canvas_store
from novelvideo.freezone.canvas_core_pool import CanvasCoreError, CanvasCorePool
from novelvideo.ports import get_canvas_write_mutex
from novelvideo.ports import registry as ports_registry
from novelvideo.project_context import ProjectContext

pytestmark = requires_canvas_core_bundle

BROWSER = {"id": "u-alice", "username": "alice"}
AGENT_SESSION = {**BROWSER, "credential_kind": "agent_session"}
LOCAL_AGENT = {**BROWSER, "credential_kind": "local_trusted_agent"}
ORIGIN = {"chat_canvas_id": "chat-1", "turn_id": "turn-1"}
FIXTURE = Path(__file__).resolve().parents[1] / (
    "frontend/src/__tests__/features/canvas-core/__parity__/canvas-creation.json"
)
CASES = json.loads(FIXTURE.read_text(encoding="utf-8"))["cases"]


class RecordingPool(CanvasCorePool):
    def __init__(self):
        super().__init__(CANVAS_CORE_BUNDLE, size=2)
        self.calls = []

    def call(self, op, payload):
        self.calls.append((op, deepcopy(payload)))
        return super().call(op, payload)


@pytest.fixture
def pool():
    worker = RecordingPool()
    try:
        yield worker
    finally:
        worker.close()


@pytest.fixture
def creation(monkeypatch, tmp_path, pool):
    ctx = ProjectContext(
        project_id="proj",
        project_name="demo",
        owner_type="user",
        owner_id="u-alice",
        owner_username="alice",
        requester_user_id="u-alice",
        requester_username="alice",
        requester_principals=(("user", "u-alice"),),
        effective_role="editor",
        home_node_id="node-a",
        output_dir=tmp_path / "output",
        state_dir=tmp_path / "state",
        runtime_dir=tmp_path / "runtime",
        is_home_node=False,
    )
    harness = SimpleNamespace(
        ctx=ctx,
        root=ctx.state_dir,
        pool=pool,
        events=[],
        resolutions=[],
        monkeypatch=monkeypatch,
    )

    async def resolve(project, user, **kwargs):
        assert project == "proj"
        harness.resolutions.append(kwargs)
        return (
            harness.ctx,
            "alice",
            "demo",
            tmp_path / "output",
            str(tmp_path / "output"),
        )

    append_event = routes._append_canvas_event

    def record_event(**kwargs):
        harness.events.append(deepcopy(kwargs))
        return append_event(**kwargs)

    monkeypatch.setattr(routes, "_resolve_freezone_project", resolve)
    monkeypatch.setattr(routes, "_append_canvas_event", record_event)
    return harness


def _use_creation_pool(harness):
    from novelvideo.freezone import canvas_creation

    harness.monkeypatch.setattr(
        canvas_creation, "get_canvas_core_pool", lambda: harness.pool
    )


async def _create(harness, name="New plan", request_id="request-1", user=None, **body):
    from novelvideo.api.schemas import CanvasCreateRequest

    _use_creation_pool(harness)
    response = await routes.create_canvas(
        "proj",
        CanvasCreateRequest(name=name, request_id=request_id, **body),
        user or BROWSER,
    )
    assert response["ok"] is True
    return response["data"]


def _wire(case):
    source = case["input"]
    wire = {
        "project_id": source["projectId"],
        "name": source["name"],
        "request_id": source["requestId"],
        "save_source": source["saveSource"],
        "env": {"locale": case["locale"]},
    }
    for old, new in (("creatorUsername", "creator_username"), ("canvases", "canvases")):
        if old in source:
            wire[new] = source[old]
    if "origin" in source:
        wire["origin"] = {
            "chat_canvas_id": source["origin"]["chatCanvasId"],
            "turn_id": source["origin"]["turnId"],
        }
    return wire


def _plan(pool, name, request_id="request-1"):
    return pool.call(
        "plan_canvas_creation",
        {
            "project_id": "proj",
            "name": name,
            "creator_username": "alice",
            "request_id": request_id,
            "save_source": "manual_save",
            "canvases": [],
            "env": {"locale": "en"},
        },
    )


def _seed(root, canvas_id, *, name="Seed", creator="alice", metadata=None):
    return canvas_store.save_canvas(
        root,
        canvas_id,
        base_revision=None,
        build_payload=lambda _: {
            "schema_version": 2,
            "canvas_id": canvas_id,
            "project_id": "proj",
            "revision": 1,
            "nodes": [],
            "edges": [],
            "metadata": metadata
            if metadata is not None
            else {
                "canvas_origin": "user_created",
                "display_name": name,
                "creator_username": creator,
            },
        },
    ).payload


def _seed_quota(root, count):
    for index in range(count):
        _seed(root, f"canvas_seed_{index}", name=f"Seed {index}")


def _files(root):
    return {
        path.name: path.read_bytes()
        for path in (root / "freezone" / "canvases").glob("*.json")
    }


def _owned(root):
    return [
        item
        for item in canvas_store.list_canvases(root)
        if (item.get("metadata") or {}).get("canvas_origin") == "user_created"
        and item["metadata"].get("creator_username") == "alice"
    ]


def _plan_wires(pool):
    return [payload for op, payload in pool.calls if op == "plan_canvas_creation"]


def _same_first_snapshot(monkeypatch, pool):
    """Hold the first two completed plans until both have used the initial list."""
    barrier = threading.Barrier(2, timeout=10)
    count_lock = threading.Lock()
    original = pool.call
    calls = 0

    def call(op, payload):
        nonlocal calls
        with count_lock:
            synchronize = op == "plan_canvas_creation" and calls < 2
            if op == "plan_canvas_creation":
                calls += 1
        result = original(op, payload)
        if synchronize:
            barrier.wait()
        return result

    monkeypatch.setattr(pool, "call", call)


def test_creation_fixture_has_thirty_cases():
    assert len(CASES) == 30


@pytest.mark.parametrize("case", CASES, ids=lambda case: case["name"])
def test_creation_worker_matches_browser_fixture(pool, case):
    assert pool.call("plan_canvas_creation", _wire(case)) == case["expected"]


def test_describe_worker_returns_display_rows_and_creator_quota(pool):
    stamp = "2026-11-01T00:00:00Z"
    canvases = [
        {"id": "default", "modified_at": stamp, "metadata": {}},
        {
            "id": "canvas_alice",
            "modified_at": stamp,
            "metadata": {
                "canvas_origin": "user_created",
                "display_name": "Plan",
                "creator_username": "alice",
                "agent_origin": ORIGIN,
            },
        },
        {
            "id": "canvas_bob",
            "modified_at": stamp,
            "metadata": {
                "canvas_origin": "user_created",
                "display_name": "Draft",
                "creator_username": "bob",
            },
        },
        {
            "id": "copy_recovery",
            "modified_at": stamp,
            "metadata": {"canvas_origin": "conflict_copy"},
        },
    ]
    rows = [
        {
            "canvasId": canvas_id,
            "displayName": name,
            "kind": kind,
            "creatorUsername": creator,
            "createdByViewer": owned,
            "createdFromThisChat": from_chat,
            "modifiedAt": stamp,
        }
        for canvas_id, name, kind, creator, owned, from_chat in [
            ("default", "Default canvas", "default", None, False, False),
            ("canvas_alice", "alice · Plan", "blank", "alice", True, True),
            ("canvas_bob", "bob · Draft", "blank", "bob", False, False),
            ("copy_recovery", "Conflict copy", "other", None, False, False),
        ]
    ]
    assert pool.call(
        "describe_canvases",
        {
            "canvases": canvases,
            "viewer": {"username": "alice", "chat_canvas_id": "chat-1"},
            "env": {"locale": "en"},
        },
    ) == {"canvases": rows, "quota": {"status": "available", "used": 1, "limit": 25}}


@pytest.mark.parametrize(
    "change", [{"name": 3}, {"canvases": {}}, {"save_source": "autosave"}]
)
def test_creation_worker_rejects_malformed_payload(pool, change):
    wire = _wire(CASES[0])
    with pytest.raises(CanvasCoreError) as exc:
        pool.call("plan_canvas_creation", {**wire, **change})
    assert exc.value.code == "invalid_request"


async def test_browser_create_saves_trimmed_name_and_one_event(creation):
    data = await _create(creation, name="  New plan  ", locale="en")
    assert data == {
        "status": "created",
        "canvas_id": data["canvas_id"],
        "display_name": "New plan",
        "revision": 1,
    }
    assert data["canvas_id"].startswith("canvas_")
    saved = canvas_store.read_canvas(creation.root, data["canvas_id"])
    assert saved["metadata"] == {
        "canvas_origin": "user_created",
        "display_name": "New plan",
        "creator_username": "alice",
        "create_request_id": "request-1",
    }
    assert saved["save_source"] == "manual_save"
    assert len(canvas_store.list_canvases(creation.root)) == 1
    assert len(creation.events) == 1
    assert creation.events[0]["event_type"] == "canvas.saved"
    assert creation.events[0]["canvas_id"] == data["canvas_id"]
    wire = _plan_wires(creation.pool)[0]
    assert wire["creator_username"] == "alice"
    assert wire["save_source"] == "manual_save"
    assert "origin" not in wire
    assert wire["env"]["locale"] == "en"
    assert creation.resolutions[0]["require_home_node"] is False
    assert creation.resolutions[0].get("required_role", "editor") == "editor"


async def test_replay_returns_existing_canvas_without_writing(creation):
    first = await _create(creation)
    before = _files(creation.root)
    second = await _create(creation)
    assert second == {**first, "status": "exists"}
    assert _files(creation.root) == before
    assert len(canvas_store.list_canvases(creation.root)) == 1
    assert len(creation.events) == 1


async def test_replay_uses_current_revision_after_idempotency_history_expires(creation):
    first = await _create(creation)
    canvas_id = first["canvas_id"]
    for revision in range(1, 56):
        canvas_store.save_canvas(
            creation.root,
            canvas_id,
            base_revision=revision,
            client_save_id=f"later-{revision}",
            request_hash=f"hash-{revision}",
            build_payload=lambda existing: {
                **existing,
                "revision": existing["revision"] + 1,
            },
        )
    assert (
        canvas_store.find_idempotency_entry(creation.root, canvas_id, "request-1")
        is None
    )
    before = _files(creation.root)
    assert await _create(creation) == {**first, "status": "exists", "revision": 56}
    assert _files(creation.root) == before
    assert len(canvas_store.list_canvases(creation.root)) == 1
    assert len(creation.events) == 1


@pytest.mark.parametrize(
    "code",
    ["quota_unknown", "quota_reached", "name_required", "duplicate_name", "id_taken"],
)
async def test_rejected_creation_never_writes_or_emits(creation, code):
    name = "New plan"
    expected = {"code": code}
    if code == "quota_unknown":
        creation.ctx = replace(creation.ctx, requester_username="")
    elif code == "quota_reached":
        _seed_quota(creation.root, 25)
        expected["limit"] = 25
    elif code == "name_required":
        name = "   "
    elif code == "duplicate_name":
        _seed(creation.root, "canvas_bob", name="  NEW   PLAN ", creator="bob")
        expected.update(name=name, existing_canvas_id="canvas_bob")
    elif code == "id_taken":
        canvas_id = _plan(creation.pool, name)["canvasId"]
        _seed(creation.root, canvas_id, name="Unrelated", creator="bob")
        expected.update(name=name, canvas_id=canvas_id)
    before = _files(creation.root)
    assert await _create(creation, name=name) == {
        "status": "rejected",
        "canvas_id": None,
        "display_name": None,
        "revision": None,
        "rejection": expected,
    }
    assert _files(creation.root) == before
    assert creation.events == []


@pytest.mark.parametrize("hidden", [False, True], ids=["listed", "hidden-from-list"])
async def test_legacy_file_without_revision_is_never_overwritten(
    creation, monkeypatch, hidden
):
    name = "New plan"
    canvas_id = _plan(creation.pool, name)["canvasId"]
    path = creation.root / "freezone" / "canvases" / f"{canvas_id}.json"
    path.parent.mkdir(parents=True)
    path.write_text(
        json.dumps({"nodes": [], "edges": [], "metadata": {"display_name": "Legacy"}})
    )
    before = path.read_bytes()
    if hidden:
        list_canvases = canvas_store.list_canvases
        monkeypatch.setattr(
            canvas_store,
            "list_canvases",
            lambda *a, **kw: [
                item for item in list_canvases(*a, **kw) if item["id"] != canvas_id
            ],
        )
    assert await _create(creation, name=name) == {
        "status": "rejected",
        "canvas_id": None,
        "display_name": None,
        "revision": None,
        "rejection": {"code": "id_taken", "name": name, "canvas_id": canvas_id},
    }
    assert path.read_bytes() == before
    assert creation.events == []


def test_http_ignores_forged_creator_and_metadata(creation):
    _use_creation_pool(creation)
    app = FastAPI()
    app.include_router(routes.router, prefix="/api/v1")
    app.dependency_overrides[get_api_user] = lambda: BROWSER
    with TestClient(app) as client:
        response = client.post(
            "/api/v1/projects/proj/freezone/canvases:create",
            json={
                "name": "New plan",
                "request_id": "request-1",
                "locale": "en",
                "creator_username": "mallory",
                "metadata": {
                    "creator_username": "mallory",
                    "custom": "forged",
                    "create_request_id": "forged",
                    "agent_origin": ORIGIN,
                },
            },
        )
    assert response.status_code == 200, response.text
    saved = canvas_store.read_canvas(
        creation.root, response.json()["data"]["canvas_id"]
    )
    assert saved["metadata"] == {
        "canvas_origin": "user_created",
        "display_name": "New plan",
        "creator_username": "alice",
        "create_request_id": "request-1",
    }


async def test_concurrent_same_name_creates_exactly_one_canvas(creation, monkeypatch):
    _same_first_snapshot(monkeypatch, creation.pool)
    results = await asyncio.gather(
        *[_create(creation, request_id=f"request-{index}") for index in range(2)]
    )
    assert sorted(data["status"] for data in results) == ["created", "rejected"]
    rejection = next(
        data["rejection"] for data in results if data["status"] == "rejected"
    )
    assert rejection["code"] in {"duplicate_name", "id_taken"}
    assert [item["metadata"]["display_name"] for item in _owned(creation.root)] == [
        "New plan"
    ]
    assert len(creation.events) == 1
    first, second = _plan_wires(creation.pool)[:2]
    assert first["canvases"] == second["canvases"]


async def test_concurrent_creates_cannot_exceed_creator_quota(creation, monkeypatch):
    _seed_quota(creation.root, 24)
    _same_first_snapshot(monkeypatch, creation.pool)
    results = await asyncio.gather(
        *[
            _create(creation, name=f"New {index}", request_id=f"request-{index}")
            for index in range(2)
        ]
    )
    assert sorted(data["status"] for data in results) == ["created", "rejected"]
    assert next(
        data["rejection"] for data in results if data["status"] == "rejected"
    ) == {
        "code": "quota_reached",
        "limit": 25,
    }
    assert len(_owned(creation.root)) == 25
    assert len(creation.events) == 1
    first, second = _plan_wires(creation.pool)[:2]
    assert first["canvases"] == second["canvases"]


async def test_replay_at_quota_returns_exists(creation):
    _seed_quota(creation.root, 24)
    first = await _create(creation)
    before = _files(creation.root)
    assert await _create(creation) == {**first, "status": "exists"}
    assert _files(creation.root) == before
    assert len(_owned(creation.root)) == 25
    assert len(creation.events) == 1


async def test_concurrent_identical_request_creates_once_and_replays(
    creation, monkeypatch
):
    _same_first_snapshot(monkeypatch, creation.pool)
    results = await asyncio.gather(_create(creation), _create(creation))
    assert sorted(data["status"] for data in results) == ["created", "exists"]
    assert results[0]["canvas_id"] == results[1]["canvas_id"]
    assert results[0]["revision"] == results[1]["revision"] == 1
    assert len(canvas_store.list_canvases(creation.root)) == 1
    assert len(creation.events) == 1


async def test_creation_computes_outside_mutex_and_reserves_create_lock(
    creation, monkeypatch
):
    delegate = get_canvas_write_mutex()
    active = []
    acquired = []

    class TrackingMutex:
        @contextmanager
        def write_mutex(self, root, canvas_id, **kwargs):
            with delegate.write_mutex(root, canvas_id, **kwargs) as guard:
                acquired.append(canvas_id)
                active.append(canvas_id)
                try:
                    yield guard
                finally:
                    active.pop()

    ports_registry.register_port("canvas_write_mutex", TrackingMutex())
    call = creation.pool.call

    def outside_lock(op, payload):
        assert active == [], "Node computation must run outside canvas write mutexes"
        return call(op, payload)

    monkeypatch.setattr(creation.pool, "call", outside_lock)
    data = await _create(creation)
    assert data["status"] == "created"
    assert "__create__" in acquired
    assert canvas_store.read_canvas(creation.root, data["canvas_id"]) is not None


@pytest.mark.parametrize(
    "field", ["id", "canvas_origin", "creator_username", "display_name"]
)
async def test_creation_replans_when_list_fingerprint_changes(
    creation, monkeypatch, field
):
    _seed(creation.root, "canvas_seed", name="Seed", creator="bob")
    call = creation.pool.call
    changed = False

    def change_after_plan(op, payload):
        nonlocal changed
        result = call(op, payload)
        if op == "plan_canvas_creation" and not changed:
            changed = True
            if field == "id":
                directory = creation.root / "freezone" / "canvases"
                (directory / "canvas_seed.json").rename(directory / "canvas_moved.json")
            else:
                value = {
                    "canvas_origin": "conflict_copy",
                    "creator_username": "alice",
                    "display_name": "New plan",
                }[field]
                canvas_store.save_canvas(
                    creation.root,
                    "canvas_seed",
                    base_revision=1,
                    build_payload=lambda existing: {
                        **existing,
                        "revision": 2,
                        "metadata": {**existing["metadata"], field: value},
                    },
                )
        return result

    monkeypatch.setattr(creation.pool, "call", change_after_plan)
    data = await _create(creation)
    wires = _plan_wires(creation.pool)
    assert len(wires) == 2
    assert wires[0]["canvases"] != wires[1]["canvases"]
    if field == "display_name":
        assert data["rejection"] == {
            "code": "duplicate_name",
            "name": "New plan",
            "existing_canvas_id": "canvas_seed",
        }
        assert creation.events == []
    else:
        assert data["status"] == "created"
        assert len(creation.events) == 1


async def test_creation_stops_after_three_changed_snapshots(creation, monkeypatch):
    from fastapi import HTTPException

    _seed(creation.root, "canvas_seed", creator="bob")
    call = creation.pool.call

    def always_change(op, payload):
        result = call(op, payload)
        if op == "plan_canvas_creation":
            current = canvas_store.read_canvas(creation.root, "canvas_seed")
            canvas_store.save_canvas(
                creation.root,
                "canvas_seed",
                base_revision=current["revision"],
                build_payload=lambda existing: {
                    **existing,
                    "revision": existing["revision"] + 1,
                    "metadata": {
                        **existing["metadata"],
                        "display_name": f"Changed {existing['revision']}",
                    },
                },
            )
        return result

    monkeypatch.setattr(creation.pool, "call", always_change)
    with pytest.raises(HTTPException) as exc:
        await _create(creation)
    assert exc.value.status_code == 503
    assert exc.value.detail["code"] == "canvas_lock_busy"
    assert len(_plan_wires(creation.pool)) == 3
    assert [item["id"] for item in canvas_store.list_canvases(creation.root)] == [
        "canvas_seed"
    ]
    assert creation.events == []


async def test_browser_origin_is_ignored(creation):
    data = await _create(creation, origin=ORIGIN)
    saved = canvas_store.read_canvas(creation.root, data["canvas_id"])
    assert saved["save_source"] == "manual_save"
    assert "agent_origin" not in saved["metadata"]
    assert all(
        "origin" not in wire and wire["save_source"] == "manual_save"
        for wire in _plan_wires(creation.pool)
    )


@pytest.mark.parametrize(
    "user", [AGENT_SESSION, LOCAL_AGENT], ids=["agent-session", "local-agent"]
)
async def test_agent_without_origin_uses_manual_save(creation, user):
    data = await _create(creation, user=user)
    saved = canvas_store.read_canvas(creation.root, data["canvas_id"])
    assert saved["save_source"] == "manual_save"
    assert "agent_origin" not in saved["metadata"]
    assert all(
        "origin" not in wire and wire["save_source"] == "manual_save"
        for wire in _plan_wires(creation.pool)
    )


@pytest.mark.parametrize(
    "user", [AGENT_SESSION, LOCAL_AGENT], ids=["agent-session", "local-agent"]
)
async def test_agent_with_origin_records_agent_creation(creation, user):
    data = await _create(creation, user=user, origin=ORIGIN)
    saved = canvas_store.read_canvas(creation.root, data["canvas_id"])
    assert saved["save_source"] == "agent_create"
    assert saved["metadata"]["agent_origin"] == ORIGIN
    assert all(
        wire["save_source"] == "agent_create" and wire["origin"] == ORIGIN
        for wire in _plan_wires(creation.pool)
    )


@pytest.mark.parametrize(
    "recorded,explicit,expected",
    [("en", None, "en"), ("en", "vi", "vi"), (None, None, "zh")],
)
async def test_create_locale_precedence(creation, recorded, explicit, expected):
    if recorded is not None:
        path = creation.root / "freezone" / "ui_locale.json"
        path.parent.mkdir(parents=True)
        path.write_text(json.dumps({"locale": recorded}))
    await _create(creation, locale=explicit)
    assert _plan_wires(creation.pool)[0]["env"]["locale"] == expected


async def test_agent_view_describes_canvases_for_requester_and_chat(creation):
    created = await _create(creation, user=AGENT_SESSION, origin=ORIGIN)
    _seed(creation.root, "canvas_bob", name="Bob plan", creator="bob")
    response = await routes.get_canvas_agent_view(
        "proj",
        chat_canvas_id="chat-1",
        locale="en",
        user=BROWSER,
    )
    assert response["ok"] is True
    data = response["data"]
    assert data["quota"] == {"status": "available", "used": 1, "limit": 25}
    assert canvas_store.read_canvas(creation.root, "default") is not None
    summaries = {item["id"]: item for item in canvas_store.list_canvases(creation.root)}
    rows = {row["canvas_id"]: row for row in data["canvases"]}
    assert set(rows) == {"default", "canvas_bob", created["canvas_id"]}
    for canvas_id, name, kind, creator, owned, chat in [
        ("default", "Default canvas", "default", None, False, False),
        ("canvas_bob", "bob · Bob plan", "blank", "bob", False, False),
        (created["canvas_id"], "alice · New plan", "blank", "alice", True, True),
    ]:
        assert rows[canvas_id] == {
            "canvas_id": canvas_id,
            "display_name": name,
            "kind": kind,
            "creator_username": creator,
            "created_by_viewer": owned,
            "created_from_this_chat": chat,
            "modified_at": summaries[canvas_id]["modified_at"],
        }
    wire = next(
        payload for op, payload in creation.pool.calls if op == "describe_canvases"
    )
    assert wire["viewer"] == {"username": "alice", "chat_canvas_id": "chat-1"}
    assert wire["env"]["locale"] == "en"
    assert creation.resolutions[-1]["required_role"] == "viewer"
    assert creation.resolutions[-1]["require_home_node"] is False
