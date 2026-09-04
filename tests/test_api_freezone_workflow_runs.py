from __future__ import annotations

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


def test_metered_workflow_run_admits_each_model_recipe_before_run_creation(
    workflow_run_client: TestClient, monkeypatch
) -> None:
    from novelvideo.api.routes import freezone

    monkeypatch.setattr(freezone, "get_usage_meter", lambda: object())
    base = "/api/v1/projects/proj_demo/freezone/canvases/default/workflow-runs"

    rejected = workflow_run_client.post(
        base,
        json={"actions": [{"node_id": "image-1", "action": "generate_image"}]},
    )
    assert rejected.status_code == 400
    assert workflow_run_client.get(base).json()["data"]["runs"] == []

    request = {
        "idempotency_key": "run-attempt-a",
        "actions": [
            {
                "node_id": "image-1",
                "action": "generate_image",
                "recipe_id": "product-image",
                "recipe_version": "1.0.0",
                "generation_attempt_id": "attempt-a",
            },
            {"node_id": "save-1", "action": "save"},
        ],
    }
    first = workflow_run_client.post(base, json=request)
    duplicate = workflow_run_client.post(base, json=request)

    assert first.status_code == 200
    assert duplicate.status_code == 200
    first_data = first.json()["data"]
    assert duplicate.json()["data"]["run_id"] == first_data["run_id"]
    model_action, deterministic_action = first_data["actions"]
    assert model_action["product_operation_id"].startswith("agent_product_")
    assert not deterministic_action["product_operation_id"]


def test_metered_workflow_result_is_delivered_once_before_canvas_confirmation(
    workflow_run_client: TestClient, monkeypatch
) -> None:
    from novelvideo.api.routes import freezone

    monkeypatch.setattr(freezone, "get_usage_meter", lambda: object())
    operation_response = workflow_run_client.post(
        "/api/v1/projects/proj_demo/freezone/agent-product-operations",
        json={
            "product_kind": "workflow_result",
            "generation_session_id": "generation-a",
            "canvas_id": "default",
            "artifact_id": "video-ad@1.0.0",
            "normalized_inputs_hash": "inputs-a",
        },
    )
    assert operation_response.status_code == 200
    operation = operation_response.json()["data"]
    base = "/api/v1/projects/proj_demo/freezone/canvases/default/workflow-drafts"
    draft_request = {
        "operation_id": operation["operation_id"],
        "intent": {"skill_id": "video-ad", "user_goal": "广告"},
        "compiled": {
            "ok": True,
            "skill_id": "video-ad",
            "plan": {"nodes": [], "edges": [], "phases": []},
        },
    }

    first = workflow_run_client.post(base, json=draft_request)
    duplicate = workflow_run_client.post(base, json=draft_request)

    assert first.status_code == 200
    assert duplicate.status_code == 200
    draft = first.json()["data"]
    assert duplicate.json()["data"]["draft_id"] == draft["draft_id"]
    stored_operation = workflow_run_client.get(
        "/api/v1/projects/proj_demo/freezone/agent-product-operations/"
        + operation["operation_id"]
    ).json()["data"]
    assert stored_operation["status"] == "delivered"
    assert stored_operation["result_ref"]["id"] == draft["draft_id"]

    confirmed = workflow_run_client.post(
        f"{base}/{draft['draft_id']}/claim", json={"revision": draft["revision"]}
    )
    assert confirmed.status_code == 200
    after_confirm = workflow_run_client.get(
        "/api/v1/projects/proj_demo/freezone/agent-product-operations/"
        + operation["operation_id"]
    ).json()["data"]
    assert after_confirm["status"] == "delivered"


@pytest.mark.asyncio
async def test_late_agent_product_delivery_confirms_reserved_credit(
    monkeypatch,
) -> None:
    from novelvideo.api.routes import freezone

    settlements: list[tuple[str, str]] = []
    completions: list[dict] = []
    task = SimpleNamespace(
        task_id="product-task-a",
        status="failed",
        metadata={
            "feature_credit_reservation_id": "reservation-a",
            "error_code": "AGENT_PRODUCT_SETTLEMENT_PENDING",
        },
    )

    class UsageMeter:
        async def settle_feature_credit_reservation(
            self, reservation_id, *, action, metadata=None
        ):
            settlements.append((reservation_id, action))
            assert metadata["source"] == "agent_product_late_delivery"
            return {"status": "completed"}

    class Manager:
        def get_task_for_project(self, *_args, **_kwargs):
            return task

        def complete_task_for_project(self, *_args, **kwargs):
            completions.append(kwargs)
            return True

    monkeypatch.setattr(freezone, "get_usage_meter", lambda: UsageMeter())
    monkeypatch.setattr(freezone, "get_task_manager", lambda: Manager())

    await freezone._settle_delivered_agent_product_task(
        ctx=SimpleNamespace(project_id="proj_demo"),
        operation={
            "operation_id": "agent_product_a",
            "task_id": "product-task-a",
            "task_type": "freezone_agent_recipe_result",
            "product_kind": "recipe_result",
            "status": "delivered",
            "model_evidence": {"model_call_id": "provider-job-a"},
            "result_ref": {"kind": "recipe_result", "id": "asset-a"},
        },
    )

    assert settlements == [("reservation-a", "confirm")]
    assert completions[0]["metadata"]["settlement_status"] == "reconciled"


def test_canvas_revision_endpoint_returns_only_revision(
    workflow_run_client: TestClient,
) -> None:
    response = workflow_run_client.get(
        "/api/v1/projects/proj_demo/freezone/canvases/default/revision"
    )

    assert response.status_code == 200
    assert response.json()["data"] == {"canvas_id": "default", "revision": 1}


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


def test_workflow_confirmation_enqueues_non_monetary_durable_task(
    workflow_run_client: TestClient,
) -> None:
    base = "/api/v1/projects/proj_demo/freezone/canvases/default/workflow-drafts"
    created = workflow_run_client.post(
        base,
        json={
            "intent": {"skill_id": "video-ad", "user_goal": "广告"},
            "compiled": {
                "ok": True,
                "skill_id": "video-ad",
                "plan": {"nodes": [], "edges": [], "phases": []},
            },
        },
    ).json()["data"]

    response = workflow_run_client.post(
        f"{base}/{created['draft_id']}/claim",
        json={"revision": 1},
    )

    assert response.status_code == 200
    payload = response.json()["data"]
    assert payload["task_id"] == "workflow-task-1"
    assert payload["root_task_id"] == "workflow-task-1"
    assert "billing" not in payload
    assert "quote_id" not in payload


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
