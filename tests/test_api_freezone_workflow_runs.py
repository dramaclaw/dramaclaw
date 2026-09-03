from __future__ import annotations

import sqlite3
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient


@pytest.fixture()
def workflow_run_client(monkeypatch, tmp_path):
    from novelvideo.api.auth import get_api_user
    from novelvideo.api.routes import freezone

    ctx = SimpleNamespace(
        project_id="proj_demo",
        owner_username="alice",
        project_name="demo",
        output_dir=str(tmp_path),
        state_dir=str(tmp_path),
        runtime_dir=str(tmp_path / "_runtime"),
        is_home_node=True,
        requester_user_id="u-alice",
        enqueued_tasks=[],
    )

    class FakeTaskBackend:
        async def enqueue_project_task(self, _ctx, **kwargs):
            ctx.enqueued_tasks.append(kwargs)
            task_id = f"workflow-task-{len(ctx.enqueued_tasks)}"
            return SimpleNamespace(task_state=SimpleNamespace(task_id=task_id))

    task_backend = FakeTaskBackend()

    async def fake_resolve(
        project: str,
        user: dict,
        *,
        required_role: str = "editor",
        require_home_node: bool = True,
    ):
        del require_home_node
        return ctx, "alice", "demo", tmp_path, str(tmp_path)

    monkeypatch.setattr(freezone, "_resolve_freezone_project", fake_resolve)
    monkeypatch.setattr(freezone, "get_task_backend", lambda: task_backend)
    app = FastAPI()
    app.include_router(freezone.router, prefix="/api/v1")
    app.dependency_overrides[get_api_user] = lambda: {
        "id": "u-alice",
        "username": "alice",
    }
    return TestClient(app)


def test_workflow_run_api_lifecycle(workflow_run_client: TestClient) -> None:
    base = "/api/v1/projects/proj_demo/freezone/canvases/default/workflow-runs"
    created_response = workflow_run_client.post(
        base,
        json={"actions": [{"node_id": "image-1", "action": "generate_image"}]},
    )
    assert created_response.status_code == 200
    created = created_response.json()["data"]

    patched_response = workflow_run_client.patch(
        f"{base}/{created['run_id']}",
        json={
            "status": "completed",
            "action_updates": [
                {
                    "node_id": "image-1",
                    "action": "generate_image",
                    "status": "completed",
                    "phase": "syncing_result",
                }
            ],
        },
    )
    assert patched_response.status_code == 200
    assert patched_response.json()["data"]["status"] == "completed"
    assert patched_response.json()["data"]["actions"][0]["phase"] == "syncing_result"

    assert (
        workflow_run_client.get(f"{base}/{created['run_id']}").json()["data"]["run_id"]
        == created["run_id"]
    )
    assert (
        workflow_run_client.get(base).json()["data"]["runs"][0]["run_id"]
        == created["run_id"]
    )


def test_canvas_revision_endpoint_returns_only_revision(
    workflow_run_client: TestClient,
) -> None:
    response = workflow_run_client.get(
        "/api/v1/projects/proj_demo/freezone/canvases/default/revision"
    )

    assert response.status_code == 200
    assert response.json()["data"] == {"canvas_id": "default", "revision": 1}


def test_agent_planning_quote_is_non_reserving_and_exact(
    workflow_run_client: TestClient,
    monkeypatch,
) -> None:
    from novelvideo.api.routes import freezone

    seen = {}

    class Meter:
        async def require_feature_credit_balance(self, **kwargs):
            seen.update(kwargs)
            return {"required_balance": 15, "balance": 100, "allowed": True}

    monkeypatch.setattr(freezone, "get_usage_meter", lambda: Meter())
    response = workflow_run_client.post(
        "/api/v1/projects/proj_demo/freezone/agent-capability-quote",
        json={
            "feature_key": "freezone.agent.creative_planning",
            "canvas_id": "default",
            "operation_kind": "workflow_planning_create",
            "operation": {"intent": {"user_goal": "广告"}, "run_after_create": False},
        },
    )

    assert response.status_code == 200
    assert response.json()["data"]["display"] == "15 积分"
    assert response.json()["data"]["required_credits"] == 15
    assert response.json()["data"]["configured"] is True
    assert response.json()["data"]["billing_required"] is True
    assert response.json()["data"]["metering_enabled"] is True
    assert response.json()["data"]["quote_id"].startswith("billing_quote_")
    assert seen["feature_key"] == "freezone.agent.creative_planning"


def test_agent_planning_quote_does_not_create_confirmable_quote_when_insufficient(
    workflow_run_client: TestClient,
    monkeypatch,
) -> None:
    from novelvideo.api.routes import freezone

    class Meter:
        async def require_feature_credit_balance(self, **_kwargs):
            return {"required_balance": 15, "balance": 4, "allowed": False}

    monkeypatch.setattr(freezone, "get_usage_meter", lambda: Meter())
    response = workflow_run_client.post(
        "/api/v1/projects/proj_demo/freezone/agent-capability-quote",
        json={
            "feature_key": "freezone.agent.creative_planning",
            "canvas_id": "default",
            "operation_kind": "workflow_planning_create",
            "operation": {"intent": {"user_goal": "广告"}, "run_after_create": False},
        },
    )

    assert response.status_code == 200
    payload = response.json()["data"]
    assert payload["status"] == "agent_credit_insufficient"
    assert payload["allowed"] is False
    assert payload["required_credits"] == 15
    assert "quote_id" not in payload


def test_agent_planning_quote_falls_back_when_price_rule_is_missing(
    workflow_run_client: TestClient,
    monkeypatch,
) -> None:
    from novelvideo.api.routes import freezone
    from novelvideo.shared.billing_errors import BillingRuleNotConfiguredError

    class Meter:
        async def require_feature_credit_balance(self, **_kwargs):
            raise BillingRuleNotConfiguredError(
                kind="feature",
                key="freezone.agent.creative_planning",
            )

    monkeypatch.setattr(freezone, "get_usage_meter", lambda: Meter())
    response = workflow_run_client.post(
        "/api/v1/projects/proj_demo/freezone/agent-capability-quote",
        json={
            "feature_key": "freezone.agent.creative_planning",
            "canvas_id": "default",
            "operation_kind": "workflow_planning_create",
            "operation": {"intent": {"user_goal": "广告"}, "run_after_create": False},
        },
    )

    assert response.status_code == 200
    assert response.json()["data"]["configured"] is False
    assert response.json()["data"]["exact"] is False
    assert response.json()["data"]["required_credits"] is None


def test_agent_planning_quote_is_disabled_in_ce(
    workflow_run_client: TestClient,
) -> None:
    response = workflow_run_client.post(
        "/api/v1/projects/proj_demo/freezone/agent-capability-quote",
        json={"feature_key": "freezone.agent.creative_planning"},
    )

    assert response.status_code == 200
    assert response.json()["data"]["billing_required"] is False
    assert response.json()["data"]["metering_enabled"] is False


def test_workflow_draft_does_not_require_planning_credit_confirmation_in_ce(
    workflow_run_client: TestClient,
) -> None:
    response = workflow_run_client.post(
        "/api/v1/projects/proj_demo/freezone/canvases/default/workflow-drafts",
        json={
            "intent": {"skill_id": "video-ad", "user_goal": "广告"},
            "compiled": {
                "ok": True,
                "skill_id": "video-ad",
                "plan": {"nodes": [], "edges": [], "phases": []},
            },
        },
    )

    assert response.status_code == 200
    assert "agent_credit_estimate" not in response.json()["data"]
    assert "agent_planning_charge" not in response.json()["data"]


def test_model_forgeable_planning_confirmation_boolean_is_rejected(
    workflow_run_client: TestClient,
    monkeypatch,
) -> None:
    from novelvideo.api.routes import freezone

    monkeypatch.setattr(freezone, "get_usage_meter", lambda: object())
    response = workflow_run_client.post(
        "/api/v1/projects/proj_demo/freezone/canvases/default/workflow-drafts",
        json={
            "intent": {"skill_id": "video-ad", "user_goal": "广告"},
            "compiled": {
                "ok": True,
                "skill_id": "video-ad",
                "plan": {"nodes": [], "edges": [], "phases": []},
            },
            "planning_confirmed": True,
        },
    )

    assert response.status_code == 409
    assert "server-issued" in response.json()["detail"]


def test_patch_receipt_is_bound_to_exact_revision_intent_and_compiled_plan(
    workflow_run_client: TestClient,
    monkeypatch,
) -> None:
    from novelvideo.api.routes import freezone

    base = "/api/v1/projects/proj_demo/freezone/canvases/default/workflow-drafts"
    initial_compiled = {
        "ok": True,
        "skill_id": "video-ad",
        "plan": {"summary": "广告", "nodes": [], "edges": [], "phases": []},
    }
    draft = workflow_run_client.post(
        base,
        json={
            "intent": {"skill_id": "video-ad", "user_goal": "广告"},
            "compiled": initial_compiled,
        },
    ).json()["data"]

    class Meter:
        async def require_feature_credit_balance(self, **_kwargs):
            return {
                "required_balance": 8,
                "balance": 100,
                "allowed": True,
                "price_rule_version": "planning-v1",
            }

    async def fake_reserve(**_kwargs):
        return {"id": "patch-reservation", "cost": 8}

    async def fake_settle(*_args, **_kwargs):
        return None

    monkeypatch.setattr(freezone, "get_usage_meter", lambda: Meter())
    monkeypatch.setattr(freezone, "reserve_agent_capability_charge", fake_reserve)
    monkeypatch.setattr(freezone, "settle_agent_capability_charge", fake_settle)
    patched_intent = {
        "skill_id": "video-ad",
        "user_goal": "广告",
        "items": ["开场"],
    }
    patched_compiled = {
        **initial_compiled,
        "plan": {**initial_compiled["plan"], "summary": "带开场的广告"},
    }
    operation = {
        "draft_id": draft["draft_id"],
        "expected_revision": 1,
        "intent": patched_intent,
        "compiled": patched_compiled,
        "run_after_create": None,
    }
    quote = workflow_run_client.post(
        "/api/v1/projects/proj_demo/freezone/agent-capability-quote",
        json={
            "feature_key": "freezone.agent.creative_planning",
            "canvas_id": "default",
            "operation_kind": "workflow_planning_patch",
            "operation": operation,
        },
    ).json()["data"]
    confirmation = workflow_run_client.post(
        f"/api/v1/projects/proj_demo/freezone/agent-capability-quotes/{quote['quote_id']}/confirm",
        json={"canvas_id": "default"},
    ).json()["data"]
    patch_body = {
        "expected_revision": 1,
        "intent": patched_intent,
        "compiled": patched_compiled,
        "last_changes": {"items": ["开场"]},
        "quote_id": quote["quote_id"],
        "confirmation_receipt": confirmation["receipt"],
    }

    tampered = workflow_run_client.patch(
        f"{base}/{draft['draft_id']}",
        json={**patch_body, "intent": {**patched_intent, "items": ["收尾"]}},
    )
    assert tampered.status_code == 409

    accepted = workflow_run_client.patch(
        f"{base}/{draft['draft_id']}",
        json=patch_body,
    )
    assert accepted.status_code == 200
    assert accepted.json()["data"]["revision"] == 2


def test_agent_credentials_cannot_confirm_billing_quote(
    workflow_run_client: TestClient,
    tmp_path,
) -> None:
    from novelvideo.api.auth import get_api_user
    from novelvideo.freezone.agent_billing_state import create_billing_quote

    quote = create_billing_quote(
        project_dir=tmp_path,
        user_id="u-agent",
        project_id="proj_demo",
        canvas_id="default",
        feature_key="freezone.agent.creative_planning",
        operation_kind="workflow_planning_create",
        operation={"intent": {"user_goal": "广告"}},
        amount=8,
        price_version="planning-v1",
        display="8 积分",
    )
    workflow_run_client.app.dependency_overrides[get_api_user] = lambda: {
        "id": "u-agent",
        "username": "agent",
        "credential_kind": "agent_session",
    }

    response = workflow_run_client.post(
        f"/api/v1/projects/proj_demo/freezone/agent-capability-quotes/{quote['quote_id']}/confirm",
        json={"canvas_id": "default"},
    )

    assert response.status_code == 403


def test_workflow_run_api_rejects_invalid_action_phase(
    workflow_run_client: TestClient,
) -> None:
    base = "/api/v1/projects/proj_demo/freezone/canvases/default/workflow-runs"
    created = workflow_run_client.post(
        base,
        json={"actions": [{"node_id": "image-1", "action": "generate_image"}]},
    ).json()["data"]

    response = workflow_run_client.patch(
        f"{base}/{created['run_id']}",
        json={
            "action_updates": [
                {
                    "node_id": "image-1",
                    "action": "generate_image",
                    "status": "running",
                    "phase": "unknown_phase",
                }
            ]
        },
    )

    assert response.status_code == 400


def test_workflow_run_api_rejects_empty_actions(
    workflow_run_client: TestClient,
) -> None:
    response = workflow_run_client.post(
        "/api/v1/projects/proj_demo/freezone/canvases/default/workflow-runs",
        json={"actions": []},
    )

    assert response.status_code == 400


def test_workflow_run_api_reuses_idempotent_creation(
    workflow_run_client: TestClient,
) -> None:
    base = "/api/v1/projects/proj_demo/freezone/canvases/default/workflow-runs"
    request_body = {
        "actions": [{"node_id": "image-1", "action": "generate_image"}],
        "idempotency_key": "canvas-run:request-1",
    }

    first = workflow_run_client.post(base, json=request_body)
    duplicate = workflow_run_client.post(base, json=request_body)

    assert first.status_code == 200
    assert duplicate.status_code == 200
    assert duplicate.json()["data"]["run_id"] == first.json()["data"]["run_id"]
    assert len(workflow_run_client.get(base).json()["data"]["runs"]) == 1


def test_workflow_run_api_rejects_competing_runner(
    workflow_run_client: TestClient,
) -> None:
    base = "/api/v1/projects/proj_demo/freezone/canvases/default/workflow-runs"
    first = workflow_run_client.post(
        base,
        json={
            "actions": [{"node_id": "image-1", "action": "generate_image"}],
            "runner_id": "runner-one",
        },
    )
    competing = workflow_run_client.post(
        base,
        json={
            "actions": [{"node_id": "image-2", "action": "generate_image"}],
            "runner_id": "runner-two",
        },
    )

    assert first.status_code == 200
    assert competing.status_code == 409


def test_workflow_draft_api_lifecycle(workflow_run_client: TestClient) -> None:
    base = "/api/v1/projects/proj_demo/freezone/canvases/default/workflow-drafts"
    compiled = {
        "ok": True,
        "skill_id": "video-ad",
        "edge_count": 0,
        "plan": {
            "summary": "广告",
            "inputs": {},
            "phases": ["视频"],
            "nodes": [
                {
                    "id": "shot-1",
                    "name": "镜头 1",
                    "node_type": "videoNode",
                    "stage": "video",
                }
            ],
            "edges": [],
        },
    }
    created_response = workflow_run_client.post(
        base,
        json={
            "intent": {"skill_id": "video-ad", "user_goal": "广告"},
            "compiled": compiled,
        },
    )
    assert created_response.status_code == 200
    created = created_response.json()["data"]
    assert "agent_credit_estimate" not in created
    assert "agent_planning_charge" not in created
    assert "billing" not in created

    patched_response = workflow_run_client.patch(
        f"{base}/{created['draft_id']}",
        json={
            "expected_revision": 1,
            "intent": {
                "skill_id": "video-ad",
                "user_goal": "广告",
                "items": ["开场"],
            },
            "compiled": compiled,
            "last_changes": {"items": ["开场"]},
        },
    )
    assert patched_response.status_code == 200
    patched = patched_response.json()["data"]
    assert patched["revision"] == 2

    claimed_response = workflow_run_client.post(
        f"{base}/{created['draft_id']}/claim",
        json={"revision": 2},
    )
    assert claimed_response.json()["data"]["status"] == "confirming"
    assert claimed_response.json()["data"]["task_id"] == "workflow-task-1"
    assert claimed_response.json()["data"]["root_task_id"] == "workflow-task-1"

    finished_response = workflow_run_client.post(
        f"{base}/{created['draft_id']}/finish",
        json={"outcome": "confirmed"},
    )
    assert finished_response.json()["data"]["status"] == "confirmed"
    assert (
        workflow_run_client.get(f"{base}/{created['draft_id']}").json()["data"][
            "status"
        ]
        == "confirmed"
    )


def test_workflow_draft_confirmation_uses_durable_task_billing_contract(
    workflow_run_client: TestClient,
    monkeypatch,
) -> None:
    from novelvideo.api.routes import freezone

    reserved: list[dict] = []
    settled: list[tuple[str, bool]] = []

    async def fake_reserve(**kwargs):
        reserved.append(kwargs)
        if kwargs["charge"].feature_key.endswith("creative_planning"):
            return {"id": "planning-reservation-1", "cost": 8}
        return {"id": "workflow-reservation-1", "cost": 20}

    async def fake_settle(reservation_id, *, confirmed, metadata=None):
        del metadata
        settled.append((reservation_id, confirmed))

    class Meter:
        async def require_feature_credit_balance(self, **kwargs):
            feature_key = kwargs["feature_key"]
            return {
                "required_balance": (
                    8 if feature_key.endswith("creative_planning") else 20
                ),
                "balance": 100,
                "allowed": True,
                "price_rule_version": "test-v1",
            }

    monkeypatch.setattr(freezone, "reserve_agent_capability_charge", fake_reserve)
    monkeypatch.setattr(freezone, "settle_agent_capability_charge", fake_settle)
    monkeypatch.setattr(freezone, "get_usage_meter", lambda: Meter())
    base = "/api/v1/projects/proj_demo/freezone/canvases/default/workflow-drafts"
    compiled = {
        "ok": True,
        "skill_id": "video-ad",
        "edge_count": 0,
        "plan": {
            "summary": "广告",
            "inputs": {},
            "phases": ["视频"],
            "nodes": [
                {
                    "id": f"shot-{index}",
                    "name": f"镜头 {index}",
                    "node_type": "videoNode",
                    "stage": "video",
                }
                for index in range(6)
            ],
            "edges": [],
        },
    }
    intent = {"skill_id": "video-ad", "user_goal": "广告"}
    planning_operation = {
        "intent": intent,
        "compiled": compiled,
        "run_after_create": False,
    }
    planning_quote = workflow_run_client.post(
        "/api/v1/projects/proj_demo/freezone/agent-capability-quote",
        json={
            "feature_key": "freezone.agent.creative_planning",
            "canvas_id": "default",
            "operation_kind": "workflow_planning_create",
            "operation": planning_operation,
        },
    ).json()["data"]
    planning_confirmation = workflow_run_client.post(
        f"/api/v1/projects/proj_demo/freezone/agent-capability-quotes/{planning_quote['quote_id']}/confirm",
        json={"canvas_id": "default"},
    ).json()["data"]
    create_body = {
        "intent": intent,
        "compiled": compiled,
        "quote_id": planning_quote["quote_id"],
        "confirmation_receipt": planning_confirmation["receipt"],
    }
    tampered = workflow_run_client.post(
        base,
        json={
            **create_body,
            "compiled": {
                **compiled,
                "plan": {**compiled["plan"], "summary": "被篡改的方案"},
            },
        },
    )
    assert tampered.status_code == 409

    draft_response = workflow_run_client.post(
        base,
        json=create_body,
    )
    assert draft_response.status_code == 200
    draft = draft_response.json()["data"]

    repeated_draft = workflow_run_client.post(base, json=create_body).json()["data"]
    assert repeated_draft["draft_id"] == draft["draft_id"]
    assert reserved[0]["idempotency_key"] == reserved[1]["idempotency_key"]

    workflow_operation = {
        "draft_id": draft["draft_id"],
        "revision": 1,
        "plan_digest": draft["plan_digest"],
    }
    workflow_quote = workflow_run_client.post(
        "/api/v1/projects/proj_demo/freezone/agent-capability-quote",
        json={
            "feature_key": "freezone.agent.workflow_design.complex",
            "canvas_id": "default",
            "operation_kind": "workflow_create",
            "operation": workflow_operation,
        },
    ).json()["data"]
    workflow_confirmation = workflow_run_client.post(
        f"/api/v1/projects/proj_demo/freezone/agent-capability-quotes/{workflow_quote['quote_id']}/confirm",
        json={"canvas_id": "default"},
    ).json()["data"]
    mismatched_claim = workflow_run_client.post(
        f"{base}/{draft['draft_id']}/claim",
        json={
            "revision": 2,
            "quote_id": workflow_quote["quote_id"],
            "confirmation_receipt": workflow_confirmation["receipt"],
        },
    )
    assert mismatched_claim.status_code == 409
    claimed = workflow_run_client.post(
        f"{base}/{draft['draft_id']}/claim",
        json={
            "revision": 1,
            "quote_id": workflow_quote["quote_id"],
            "confirmation_receipt": workflow_confirmation["receipt"],
        },
    )
    finished = workflow_run_client.post(
        f"{base}/{draft['draft_id']}/finish",
        json={"outcome": "confirmed"},
    )

    assert claimed.status_code == 200
    assert finished.status_code == 200
    assert reserved[0]["charge"].feature_key.endswith("creative_planning")
    assert claimed.json()["data"]["task_id"] == "workflow-task-1"
    assert settled == [
        ("planning-reservation-1", True),
        ("planning-reservation-1", True),
    ]


def test_planning_settlement_failure_is_persisted_and_reconciled_on_read(
    workflow_run_client: TestClient,
    monkeypatch,
    tmp_path,
) -> None:
    from novelvideo.api.routes import freezone

    class Meter:
        async def require_feature_credit_balance(self, **_kwargs):
            return {
                "required_balance": 8,
                "balance": 100,
                "allowed": True,
                "price_rule_version": "planning-v1",
            }

    attempts = 0

    async def fake_reserve(**_kwargs):
        return {"id": "planning-reservation-retry", "cost": 8}

    async def flaky_settle(_reservation_id, *, confirmed, metadata=None):
        nonlocal attempts
        del confirmed, metadata
        attempts += 1
        if attempts == 1:
            raise RuntimeError("temporary billing outage")

    monkeypatch.setattr(freezone, "get_usage_meter", lambda: Meter())
    monkeypatch.setattr(freezone, "reserve_agent_capability_charge", fake_reserve)
    monkeypatch.setattr(freezone, "settle_agent_capability_charge", flaky_settle)
    base = "/api/v1/projects/proj_demo/freezone/canvases/default/workflow-drafts"
    intent = {"skill_id": "video-ad", "user_goal": "广告"}
    compiled = {
        "ok": True,
        "skill_id": "video-ad",
        "plan": {"summary": "广告", "nodes": [], "edges": [], "phases": []},
    }
    operation = {"intent": intent, "compiled": compiled, "run_after_create": False}
    quote = workflow_run_client.post(
        "/api/v1/projects/proj_demo/freezone/agent-capability-quote",
        json={
            "feature_key": "freezone.agent.creative_planning",
            "canvas_id": "default",
            "operation_kind": "workflow_planning_create",
            "operation": operation,
        },
    ).json()["data"]
    confirmation = workflow_run_client.post(
        f"/api/v1/projects/proj_demo/freezone/agent-capability-quotes/{quote['quote_id']}/confirm",
        json={"canvas_id": "default"},
    ).json()["data"]

    created = workflow_run_client.post(
        base,
        json={
            "intent": intent,
            "compiled": compiled,
            "quote_id": quote["quote_id"],
            "confirmation_receipt": confirmation["receipt"],
        },
    )
    assert created.status_code == 200
    draft = created.json()["data"]
    assert draft["agent_planning_charge"]["status"] == "settlement_pending"

    with sqlite3.connect(tmp_path / "data.db") as conn:
        row = conn.execute(
            "SELECT status, attempts FROM agent_billing_settlements "
            "WHERE reservation_id = 'planning-reservation-retry'"
        ).fetchone()
        assert row == ("pending", 1)
        conn.execute(
            "UPDATE agent_billing_settlements SET next_attempt_at = 0 "
            "WHERE reservation_id = 'planning-reservation-retry'"
        )

    refreshed = workflow_run_client.get(f"{base}/{draft['draft_id']}")
    assert refreshed.status_code == 200
    assert refreshed.json()["data"]["agent_planning_charge"]["status"] == "confirmed"
    assert attempts == 2


def test_changed_price_refunds_reservation_and_requires_a_new_quote(
    workflow_run_client: TestClient,
    monkeypatch,
    tmp_path,
) -> None:
    from novelvideo.api.routes import freezone

    class Meter:
        async def require_feature_credit_balance(self, **_kwargs):
            return {
                "required_balance": 8,
                "balance": 100,
                "allowed": True,
                "price_rule_version": "planning-v1",
            }

    settled = []

    async def fake_reserve(**_kwargs):
        return {"id": "repriced-reservation", "cost": 9}

    async def fake_settle(reservation_id, *, confirmed, metadata=None):
        settled.append((reservation_id, confirmed, metadata))

    monkeypatch.setattr(freezone, "get_usage_meter", lambda: Meter())
    monkeypatch.setattr(freezone, "reserve_agent_capability_charge", fake_reserve)
    monkeypatch.setattr(freezone, "settle_agent_capability_charge", fake_settle)
    intent = {"skill_id": "video-ad", "user_goal": "广告"}
    compiled = {
        "ok": True,
        "skill_id": "video-ad",
        "plan": {"summary": "广告", "nodes": [], "edges": [], "phases": []},
    }
    operation = {"intent": intent, "compiled": compiled, "run_after_create": False}
    quote = workflow_run_client.post(
        "/api/v1/projects/proj_demo/freezone/agent-capability-quote",
        json={
            "feature_key": "freezone.agent.creative_planning",
            "canvas_id": "default",
            "operation_kind": "workflow_planning_create",
            "operation": operation,
        },
    ).json()["data"]
    confirmation = workflow_run_client.post(
        f"/api/v1/projects/proj_demo/freezone/agent-capability-quotes/{quote['quote_id']}/confirm",
        json={"canvas_id": "default"},
    ).json()["data"]

    response = workflow_run_client.post(
        "/api/v1/projects/proj_demo/freezone/canvases/default/workflow-drafts",
        json={
            "intent": intent,
            "compiled": compiled,
            "quote_id": quote["quote_id"],
            "confirmation_receipt": confirmation["receipt"],
        },
    )

    assert response.status_code == 409
    assert "price changed" in response.json()["detail"]
    assert settled[0][0:2] == ("repriced-reservation", False)
    with sqlite3.connect(tmp_path / "data.db") as conn:
        assert conn.execute(
            "SELECT action, status FROM agent_billing_settlements "
            "WHERE reservation_id = 'repriced-reservation'"
        ).fetchone() == ("refund", "settled")


def test_workflow_run_list_reconciles_completed_project_task(
    workflow_run_client: TestClient,
    monkeypatch,
) -> None:
    from novelvideo.api.routes import freezone

    base = "/api/v1/projects/proj_demo/freezone/canvases/default/workflow-runs"
    created = workflow_run_client.post(
        base,
        json={"actions": [{"node_id": "image-1", "action": "generate_image"}]},
    ).json()["data"]
    workflow_run_client.patch(
        f"{base}/{created['run_id']}",
        json={
            "action_updates": [
                {
                    "node_id": "image-1",
                    "action": "generate_image",
                    "status": "running",
                    "task_key": "task:freezone_image:project:proj_demo:0:job-one",
                }
            ]
        },
    )
    task = SimpleNamespace(
        task_type="freezone_image",
        status="completed",
        progress=1.0,
        current_task="completed",
        episode=0,
        beat_num=None,
        scope="job-one",
        result={"image_url": "https://cdn.example.test/image.png"},
        error=None,
    )
    monkeypatch.setattr(
        freezone,
        "get_task_manager",
        lambda: SimpleNamespace(list_tasks_for_project=lambda _ctx: [task]),
    )

    runs = workflow_run_client.get(base).json()["data"]["runs"]

    reconciled = next(item for item in runs if item["run_id"] == created["run_id"])
    assert reconciled["status"] == "completed"
    assert reconciled["actions"][0]["artifact_status"] == "valid"


def test_workflow_run_cancel_stops_linked_active_project_task(
    workflow_run_client: TestClient,
    monkeypatch,
) -> None:
    from novelvideo.api.routes import freezone

    base = "/api/v1/projects/proj_demo/freezone/canvases/default/workflow-runs"
    task_key = "task:freezone_image:project:proj_demo:0:job-one"
    created = workflow_run_client.post(
        base,
        json={"actions": [{"node_id": "image-1", "action": "generate_image"}]},
    ).json()["data"]
    workflow_run_client.patch(
        f"{base}/{created['run_id']}",
        json={
            "action_updates": [
                {
                    "node_id": "image-1",
                    "action": "generate_image",
                    "status": "running",
                    "task_key": task_key,
                }
            ]
        },
    )
    task = SimpleNamespace(
        task_type="freezone_image",
        task_id="task-one",
        status="queued",
        progress=0.0,
        episode=0,
        beat_num=None,
        scope="job-one",
    )
    cancelled_tasks = []

    class FakeTaskBackend:
        async def cancel_project_task(self, _ctx, task_state):
            cancelled_tasks.append(task_state)
            return True

    monkeypatch.setattr(
        freezone,
        "get_task_manager",
        lambda: SimpleNamespace(list_tasks_for_project=lambda _ctx: [task]),
    )
    monkeypatch.setattr(freezone, "get_task_backend", FakeTaskBackend)

    response = workflow_run_client.patch(
        f"{base}/{created['run_id']}",
        json={"status": "cancelled"},
    )

    assert response.status_code == 200
    assert cancelled_tasks == [task]
    assert response.json()["data"]["actions"][0]["status"] == "skipped"


def test_workflow_run_list_cancels_orphaned_failed_record(
    workflow_run_client: TestClient,
    monkeypatch,
) -> None:
    from novelvideo.api.routes import freezone

    base = "/api/v1/projects/proj_demo/freezone/canvases/default/workflow-runs"
    created = workflow_run_client.post(
        base,
        json={"actions": [{"node_id": "deleted-node", "action": "generate_image"}]},
    ).json()["data"]
    workflow_run_client.patch(
        f"{base}/{created['run_id']}",
        json={
            "status": "failed",
            "action_updates": [
                {
                    "node_id": "deleted-node",
                    "action": "generate_image",
                    "status": "failed",
                }
            ],
        },
    )
    monkeypatch.setattr(
        freezone.canvas_store, "read_canvas", lambda *_args, **_kwargs: None
    )

    runs = workflow_run_client.get(base).json()["data"]["runs"]

    listed = next(item for item in runs if item["run_id"] == created["run_id"])
    assert listed["status"] == "cancelled"
    assert listed["resumable"] is False
    assert listed["metadata"]["cancel_reason"] == "workflow_nodes_deleted"
