"""Workflow drafts delivered by external agent-key sessions under a metered runtime.

A session exchanged from a user-issued external agent key has no product chat
turn, so the server can never observe model execution evidence for it. Such a
session may deliver a workflow draft without an Agent product operation (no
Agent product fee). The server decides this only from the verified session it
resolved itself; every other credential keeps the operation + evidence gate,
and later generation is still admitted and charged to the session identity.
"""

from __future__ import annotations

import sqlite3
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

PROJECT = "proj_demo"
DRAFTS = f"/api/v1/projects/{PROJECT}/freezone/canvases/default/workflow-drafts"
RUNS = f"/api/v1/projects/{PROJECT}/freezone/canvases/default/workflow-runs"
OPERATIONS = f"/api/v1/projects/{PROJECT}/freezone/agent-product-operations"
# Obviously fake identifier: never a real key id, token or secret.
FAKE_EXTERNAL_KEY_ID = "test-external-key-id-not-a-secret"


def _agent_session_user(*, agent_kind: str = "codex", **extra) -> dict:
    """Legacy user dict shape returned by the auth session port for an agent."""
    user = {
        "id": "u-alice",
        "user_id": "u-alice",
        "username": "alice",
        "role": "owner",
        "credential_kind": "agent_session",
        "agent_session_id": f"test-session-{agent_kind}",
        "agent_kind": agent_kind,
        "worker_id": None,
        "scopes": ["projects:read", "projects:write"],
        "current_scope_kind": "project",
        "current_project_id": PROJECT,
        "parent_session_id": None,
    }
    user.update(extra)
    return user


EXTERNAL_KEY_SESSION = _agent_session_user(
    agent_kind="external-codex", external_agent_key_id=FAKE_EXTERNAL_KEY_ID
)
IN_PRODUCT_CODEX_SESSION = _agent_session_user(agent_kind="codex")


def _valid_draft_compiled() -> dict:
    return {
        "ok": True,
        "skill_id": "video-ad",
        "plan": {
            "schema_version": "freezone_workflow_plan.v1",
            "skill": {"id": "video-ad"},
            "inputs": {},
            "nodes": [
                {
                    "id": "brief",
                    "node_type": "textAnnotationNode",
                    "stage": "input",
                    "data": {"title": "广告", "content": "商品广告"},
                }
            ],
            "edges": [],
        },
    }


def _draft_request(**extra) -> dict:
    request = {
        "intent": {"skill_id": "video-ad", "user_goal": "广告"},
        "compiled": _valid_draft_compiled(),
    }
    request.update(extra)
    return request


def _table_rows(state_dir, sql: str) -> list[tuple]:
    db = state_dir / "data.db"
    if not db.exists():
        return []
    with sqlite3.connect(db) as conn:
        try:
            return conn.execute(sql).fetchall()
        except sqlite3.OperationalError as exc:
            if "no such table" in str(exc):
                return []
            raise


def _operation_rows(state_dir) -> list[tuple]:
    return _table_rows(
        state_dir,
        "SELECT operation_id, product_kind, status FROM freezone_agent_product_operations",
    )


def _draft_rows(state_dir) -> list[tuple]:
    return _table_rows(state_dir, "SELECT draft_id, operation_id, status FROM workflow_drafts")


@pytest.fixture()
def draft_client(monkeypatch, tmp_path):
    from novelvideo.api.auth import get_api_user
    from novelvideo.api.routes import freezone
    from novelvideo.freezone.agent_workflows import catalog

    real_list = catalog.list_user_agent_config_items

    def catalog_items(username, kind):
        items = real_list(username, kind)
        if kind == "skills":
            items = [item for item in items if item.get("id") != "video-ad"]
            items.append(
                {
                    "id": "video-ad",
                    "version": "1.0.0",
                    "enabled": True,
                    "triggers": {"node_scopes": ["textGeneration"]},
                }
            )
        return items

    monkeypatch.setattr(catalog, "list_user_agent_config_items", catalog_items)

    enqueued: list[dict] = []
    settled: list[tuple[str, str]] = []

    class RecordingTaskBackend:
        async def enqueue_project_task(self, ctx, **kwargs):
            enqueued.append({"requester_user_id": ctx.requester_user_id, **kwargs})
            task_id = f"workflow-task-{len(enqueued)}"
            return SimpleNamespace(task_state=SimpleNamespace(task_id=task_id))

    async def resolve_for_session(
        project: str,
        user: dict,
        *,
        required_role: str = "editor",
        require_home_node: bool = True,
    ):
        del required_role, require_home_node
        # The project context, and therefore every admission and charge made
        # with it, belongs to the identity of the verified session.
        ctx = SimpleNamespace(
            project_id=project,
            owner_username="alice",
            project_name="demo",
            output_dir=str(tmp_path),
            state_dir=str(tmp_path),
            runtime_dir=str(tmp_path / "_runtime"),
            is_home_node=True,
            requester_user_id=str(user["id"]),
        )
        return ctx, "alice", "demo", tmp_path, str(tmp_path)

    real_settle_delivered = freezone._settle_delivered_agent_product_task
    real_settle_failed = freezone._settle_failed_agent_product_task

    async def record_settle_delivered(*, ctx, operation):
        settled.append(("delivered", str(operation.get("operation_id") or "")))
        return await real_settle_delivered(ctx=ctx, operation=operation)

    async def record_settle_failed(*, ctx, operation, error):
        settled.append(("failed", str(operation.get("operation_id") or "")))
        return await real_settle_failed(ctx=ctx, operation=operation, error=error)

    observed_metrics: list[str] = []
    monkeypatch.setattr(freezone.evidence_metrics, "observe", observed_metrics.append)
    monkeypatch.setattr(freezone, "_resolve_freezone_project", resolve_for_session)
    monkeypatch.setattr(freezone, "get_task_backend", lambda: RecordingTaskBackend())
    monkeypatch.setattr(
        freezone, "_settle_delivered_agent_product_task", record_settle_delivered
    )
    monkeypatch.setattr(freezone, "_settle_failed_agent_product_task", record_settle_failed)
    # Metered runtime: the usage meter is not the no-op meter.
    monkeypatch.setattr(freezone, "get_usage_meter", lambda: object())

    app = FastAPI()
    app.include_router(freezone.router, prefix="/api/v1")
    current_user = {"value": dict(EXTERNAL_KEY_SESSION)}
    app.dependency_overrides[get_api_user] = lambda: dict(current_user["value"])
    client = TestClient(app)

    def use(user: dict) -> None:
        current_user["value"] = dict(user)

    client.use = use
    client.state_dir = tmp_path
    client.enqueued = enqueued
    client.settled = settled
    client.metrics = observed_metrics
    return client


def test_external_key_session_delivers_metered_draft_without_product_operation(
    draft_client: TestClient,
) -> None:
    draft_client.use(EXTERNAL_KEY_SESSION)

    response = draft_client.post(DRAFTS, json=_draft_request())

    assert response.status_code == 200, response.text
    draft = response.json()["data"]
    assert draft["draft_id"]
    assert _draft_rows(draft_client.state_dir) == [(draft["draft_id"], "", "ready")]
    # No Agent product operation, no product task admission, no settlement.
    assert _operation_rows(draft_client.state_dir) == []
    assert draft_client.enqueued == []
    assert draft_client.settled == []
    assert draft_client.metrics == []


def test_external_key_session_draft_then_run_charges_generation_to_session_identity(
    draft_client: TestClient,
) -> None:
    draft_client.use(EXTERNAL_KEY_SESSION)
    created = draft_client.post(DRAFTS, json=_draft_request())
    assert created.status_code == 200, created.text
    draft = created.json()["data"]

    claimed = draft_client.post(
        f"{DRAFTS}/{draft['draft_id']}/claim", json={"revision": draft["revision"]}
    )
    assert claimed.status_code == 200, claimed.text

    run = draft_client.post(
        RUNS,
        json={
            "idempotency_key": "external-run-a",
            "actions": [
                {
                    "node_id": "image-1",
                    "action": "generate_image",
                    "recipe_id": "product-image",
                    "recipe_version": "1.0.0",
                    "generation_attempt_id": "attempt-external-a",
                }
            ],
        },
    )

    assert run.status_code == 200, run.text
    action = run.json()["data"]["actions"][0]
    assert action["product_operation_id"].startswith("agent_product_")
    # Claiming the draft queues the ordinary (non-generating) confirmation task.
    confirms = [
        task for task in draft_client.enqueued
        if task["task_type"] == "freezone_workflow_confirm"
    ]
    assert len(confirms) == 1
    assert confirms[0]["payload"]["draft_id"] == draft["draft_id"]
    # Generation goes through the existing Recipe admission, charged to the
    # session identity (the key creator), exactly like any other caller.
    generations = [
        task for task in draft_client.enqueued
        if task["task_type"] != "freezone_workflow_confirm"
    ]
    assert len(generations) == 1
    admitted = generations[0]
    assert admitted["task_type"] == "freezone_agent_recipe_result"
    assert admitted["requester_user_id"] == "u-alice"
    assert admitted["payload"]["product_kind"] == "recipe_result"
    assert admitted["payload"]["operation_id"] == action["product_operation_id"]
    kinds = sorted(row[1] for row in _operation_rows(draft_client.state_dir))
    assert kinds == ["recipe_result"]


def test_external_key_session_direct_run_still_requires_recipe_admission(
    draft_client: TestClient,
) -> None:
    draft_client.use(EXTERNAL_KEY_SESSION)

    rejected = draft_client.post(
        RUNS,
        json={
            "actions": [
                {
                    "node_id": "image-1",
                    "action": "generate_image",
                    "recipe_id": "product-image",
                }
            ]
        },
    )

    assert rejected.status_code == 400
    assert draft_client.enqueued == []
    assert _operation_rows(draft_client.state_dir) == []


@pytest.mark.parametrize(
    "user",
    [
        pytest.param(IN_PRODUCT_CODEX_SESSION, id="in-product-codex-session"),
        pytest.param(_agent_session_user(agent_kind="hermes"), id="in-product-hermes-session"),
        pytest.param(
            _agent_session_user(agent_kind="external-hermes"),
            id="external-agent-kind-without-server-key-marker",
        ),
        pytest.param(
            _agent_session_user(agent_kind="external-codex", external_agent_key_id=""),
            id="empty-key-marker",
        ),
        pytest.param(
            _agent_session_user(agent_kind="external-codex", external_agent_key_id="   "),
            id="blank-key-marker",
        ),
        pytest.param(
            {"id": "u-alice", "user_id": "u-alice", "username": "alice", "role": "owner"},
            id="browser-session",
        ),
        pytest.param(
            {
                "id": "u-alice",
                "user_id": "u-alice",
                "username": "alice",
                "role": "owner",
                "external_agent_key_id": FAKE_EXTERNAL_KEY_ID,
            },
            id="browser-session-with-key-marker",
        ),
        pytest.param(
            {
                "id": "local",
                "user_id": "local",
                "username": "alice",
                "role": "owner",
                "credential_kind": "local_trusted_agent",
                "agent_kind": "local_mcp",
            },
            id="local-trusted-agent",
        ),
        pytest.param(
            {
                "id": "local",
                "user_id": "local",
                "username": "alice",
                "role": "owner",
                "credential_kind": "local_trusted_agent",
                "agent_kind": "local_mcp",
                "external_agent_key_id": FAKE_EXTERNAL_KEY_ID,
            },
            id="local-trusted-agent-with-key-marker",
        ),
    ],
)
def test_other_credentials_still_need_product_operation_under_metering(
    draft_client: TestClient, user: dict
) -> None:
    draft_client.use(user)

    response = draft_client.post(DRAFTS, json=_draft_request())

    assert response.status_code == 400
    assert response.json()["detail"] == "workflow result operation_id is required"
    assert _draft_rows(draft_client.state_dir) == []
    assert _operation_rows(draft_client.state_dir) == []
    assert draft_client.enqueued == []


@pytest.mark.parametrize(
    "self_reported",
    [
        {"external_agent_key_id": FAKE_EXTERNAL_KEY_ID},
        {"external_agent": True},
        {"credential_kind": "agent_session", "external_agent_key_id": FAKE_EXTERNAL_KEY_ID},
    ],
)
def test_in_product_session_cannot_self_report_external_in_request_body(
    draft_client: TestClient, self_reported: dict
) -> None:
    draft_client.use(IN_PRODUCT_CODEX_SESSION)

    response = draft_client.post(DRAFTS, json=_draft_request(**self_reported))

    assert response.status_code == 400
    assert response.json()["detail"] == "workflow result operation_id is required"
    assert _draft_rows(draft_client.state_dir) == []


def test_external_key_session_with_operation_keeps_evidence_gate(
    draft_client: TestClient,
) -> None:
    draft_client.use(EXTERNAL_KEY_SESSION)
    operation = draft_client.post(
        OPERATIONS,
        json={
            "product_kind": "workflow_result",
            "generation_session_id": "external-generation-a",
            "canvas_id": "default",
            "artifact_id": "video-ad@1.0.0",
            "normalized_inputs_hash": "inputs-external-a",
            "metadata": {"skill_id": "video-ad", "skill_version": "1.0.0"},
        },
    )
    assert operation.status_code == 200, operation.text
    operation_id = operation.json()["data"]["operation_id"]

    rejected = draft_client.post(DRAFTS, json=_draft_request(operation_id=operation_id))

    assert rejected.status_code == 409
    assert "no server-observed model execution evidence" in rejected.text
    assert draft_client.metrics == ["agent_product_evidence_rejected"]
    assert _draft_rows(draft_client.state_dir) == []


def test_in_product_session_with_operation_and_evidence_is_delivered_and_settled(
    draft_client: TestClient,
) -> None:
    from novelvideo.freezone.agent_product_operations import (
        bind_agent_product_model_execution,
        read_agent_product_operation,
    )

    draft_client.use(IN_PRODUCT_CODEX_SESSION)
    operation = draft_client.post(
        OPERATIONS,
        json={
            "product_kind": "workflow_result",
            "generation_session_id": "in-product-generation-a",
            "canvas_id": "default",
            "artifact_id": "video-ad@1.0.0",
            "normalized_inputs_hash": "inputs-in-product-a",
            "metadata": {"skill_id": "video-ad", "skill_version": "1.0.0"},
        },
    ).json()["data"]
    operation_id = operation["operation_id"]
    bind_agent_product_model_execution(
        project_dir=draft_client.state_dir,
        operation_id=operation_id,
        model_call_id="agent-turn:turn-a:tool:call-a",
        executed_at=1.0,
        source="server_observed_agent_turn",
        turn_id="turn-a",
        tool_call_id="call-a",
    )

    response = draft_client.post(DRAFTS, json=_draft_request(operation_id=operation_id))

    assert response.status_code == 200, response.text
    draft = response.json()["data"]
    stored = read_agent_product_operation(
        project_dir=draft_client.state_dir, operation_id=operation_id
    )
    assert stored["status"] == "delivered"
    assert stored["result_ref"]["id"] == draft["draft_id"]
    assert draft_client.settled == [("delivered", operation_id)]
    assert _draft_rows(draft_client.state_dir) == [(draft["draft_id"], operation_id, "ready")]


@pytest.mark.parametrize(
    ("path", "body"),
    [
        (
            "/api/v1/freezone/recipes/compile",
            {"recipe_id": "product-image", "node_kind": "image", "prompt_strategy": "template"},
        ),
        (
            "/api/v1/freezone/recipes/compile-batch",
            {
                "items": [
                    {
                        "request_id": "request-a",
                        "recipe_id": "product-image",
                        "node_kind": "image",
                        "prompt_strategy": "template",
                    }
                ]
            },
        ),
        (
            "/api/v1/freezone/recipes/generate-text",
            {"recipe_id": "product-image", "node_kind": "text", "prompt_strategy": "template"},
        ),
    ],
)
def test_external_key_session_recipe_model_calls_still_need_admission(
    draft_client: TestClient, monkeypatch, path: str, body: dict
) -> None:
    from novelvideo.api.routes import freezone

    async def must_not_run(*_args, **_kwargs):
        raise AssertionError("model work must not run without product admission")

    monkeypatch.setattr(freezone, "compile_recipe_prompt_result", must_not_run)
    monkeypatch.setattr(freezone, "compile_recipe_prompt_batch", must_not_run)
    monkeypatch.setattr(freezone, "generate_recipe_text", must_not_run)
    draft_client.use(EXTERNAL_KEY_SESSION)

    response = draft_client.post(path, json=body)

    assert response.status_code == 400
    assert "product_operation_id is required" in response.json()["detail"]
    assert draft_client.enqueued == []
