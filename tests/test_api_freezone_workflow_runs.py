from __future__ import annotations

from copy import deepcopy
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
    client = TestClient(app)
    client.state_dir = tmp_path
    return client


def _recipe_generation_session_payload(
    client: TestClient,
    *,
    session_id: str,
    reused_recipe_id: str = "outdoor-stage-duel-storyboard",
    operation_session_id: str | None = None,
    operation_kind: str = "recipe_generate",
    operation_artifact_id: str | None = None,
) -> tuple[dict, dict]:
    generated_recipe_id = f"generated-{session_id}"
    manifest = {
        "generation_session_id": session_id,
        "generation_attempt_id": f"attempt-{session_id}",
        "artifact_mode": "recipe_only",
        "skill": {"generate": False, "id": ""},
        "recipes": [
            {
                "generate": True,
                "id": generated_recipe_id,
                "generation_attempt_id": f"attempt-{session_id}",
                "output_index": 0,
            },
            {"reuse": True, "id": reused_recipe_id},
        ],
    }
    operation_response = client.post(
        "/api/v1/projects/proj_demo/freezone/agent-product-operations",
        json={
            "product_kind": operation_kind,
            "generation_session_id": operation_session_id or session_id,
            "canvas_id": "default",
            "artifact_id": operation_artifact_id or generated_recipe_id,
            "normalized_inputs_hash": f"inputs-{session_id}",
            "metadata": {"manifest": manifest, "recipe_index": 0},
        },
    )
    assert operation_response.status_code == 200
    operation = operation_response.json()["data"]
    draft = {
        "project_id": "proj_demo",
        "canvas_id": "default",
        "expected_recipe_count": 1,
        "outline": {
            "expected_recipe_count": 1,
            "stages": [
                {
                    "id": generated_recipe_id,
                    "recipe_id": generated_recipe_id,
                    "reuse": "new",
                },
                {
                    "id": reused_recipe_id,
                    "recipe_id": reused_recipe_id,
                    "reuse": "existing",
                },
            ],
        },
        "manifest": manifest,
        "operations": {"recipes": {"0": operation}},
        "recipes": {},
    }
    return manifest, draft


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

    observed_metrics: list[str] = []
    monkeypatch.setattr(freezone.evidence_metrics, "observe", observed_metrics.append)
    monkeypatch.setattr(freezone, "get_usage_meter", lambda: object())
    operation_response = workflow_run_client.post(
        "/api/v1/projects/proj_demo/freezone/agent-product-operations",
        json={
            "product_kind": "workflow_result",
            "generation_session_id": "generation-a",
            "canvas_id": "default",
            "artifact_id": "video-ad@1.0.0",
            "normalized_inputs_hash": "inputs-a",
            "metadata": {"skill_id": "video-ad", "skill_version": "1.0.0"},
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

    rejected = workflow_run_client.post(base, json=draft_request)
    assert rejected.status_code == 409
    assert observed_metrics == ["agent_product_evidence_rejected"]

    from novelvideo.freezone.agent_product_operations import (
        bind_agent_product_model_execution,
    )

    bind_agent_product_model_execution(
        project_dir=workflow_run_client.state_dir,
        operation_id=operation["operation_id"],
        model_call_id="agent-turn:turn-a:tool:call-a",
        executed_at=1.0,
        source="server_observed_agent_turn",
        turn_id="turn-a",
        tool_call_id="call-a",
    )
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


def test_workflow_result_rejects_operation_for_another_compiled_skill(
    workflow_run_client: TestClient,
) -> None:
    from novelvideo.freezone.agent_product_operations import (
        bind_agent_product_model_execution,
    )

    operation = workflow_run_client.post(
        "/api/v1/projects/proj_demo/freezone/agent-product-operations",
        json={
            "product_kind": "workflow_result",
            "generation_session_id": "wrong-skill-session",
            "canvas_id": "default",
            "artifact_id": "other-skill@1.0.0",
            "normalized_inputs_hash": "wrong-skill-inputs",
            "metadata": {"skill_id": "other-skill", "skill_version": "1.0.0"},
        },
    ).json()["data"]
    bind_agent_product_model_execution(
        project_dir=workflow_run_client.state_dir,
        operation_id=operation["operation_id"],
        model_call_id="agent-turn:wrong-skill",
        executed_at=1.0,
        source="server_observed_agent_turn",
    )

    response = workflow_run_client.post(
        "/api/v1/projects/proj_demo/freezone/canvases/default/workflow-drafts",
        json={
            "operation_id": operation["operation_id"],
            "intent": {"skill_id": "video-ad", "user_goal": "广告"},
            "compiled": {
                "ok": True,
                "skill_id": "video-ad",
                "plan": {"nodes": [], "edges": [], "phases": []},
            },
        },
    )

    assert response.status_code == 400
    assert "does not match compiled Skill" in response.json()["detail"]


def test_generation_session_validates_manifest_against_durable_operations(
    workflow_run_client: TestClient,
) -> None:
    session_id = "validated-session"
    manifest, draft = _recipe_generation_session_payload(
        workflow_run_client,
        session_id=session_id,
    )

    response = workflow_run_client.put(
        f"/api/v1/projects/proj_demo/freezone/agent-generation-sessions/{session_id}",
        json={"canvas_id": "default", "manifest": manifest, "draft": draft},
    )

    assert response.status_code == 200
    saved = response.json()["data"]
    assert saved["manifest"] == manifest
    assert saved["draft"]["operations"]["recipes"]["0"]["product_kind"] == (
        "recipe_generate"
    )


def test_generation_session_rejects_unavailable_reused_recipe(
    workflow_run_client: TestClient,
) -> None:
    session_id = "missing-reuse-session"
    manifest, draft = _recipe_generation_session_payload(
        workflow_run_client,
        session_id=session_id,
        reused_recipe_id="recipe-that-does-not-exist",
    )

    response = workflow_run_client.put(
        f"/api/v1/projects/proj_demo/freezone/agent-generation-sessions/{session_id}",
        json={"canvas_id": "default", "manifest": manifest, "draft": draft},
    )

    assert response.status_code == 400
    assert "reused Recipe is unavailable" in response.json()["detail"]


@pytest.mark.parametrize(
    ("mutation", "expected_error"),
    [
        ("missing_operation", "operation count does not match"),
        ("wrong_recipe_result", "submitted Recipe does not match"),
    ],
)
def test_generation_session_rejects_manifest_draft_mismatches(
    workflow_run_client: TestClient,
    mutation: str,
    expected_error: str,
) -> None:
    session_id = f"mismatch-{mutation}"
    manifest, draft = _recipe_generation_session_payload(
        workflow_run_client,
        session_id=session_id,
    )
    draft = deepcopy(draft)
    if mutation == "missing_operation":
        draft["operations"]["recipes"] = {}
    else:
        draft["recipes"] = {"0": {"id": "another-recipe"}}

    response = workflow_run_client.put(
        f"/api/v1/projects/proj_demo/freezone/agent-generation-sessions/{session_id}",
        json={"canvas_id": "default", "manifest": manifest, "draft": draft},
    )

    assert response.status_code == 400
    assert expected_error in response.json()["detail"]


@pytest.mark.parametrize(
    ("operation_overrides", "expected_error"),
    [
        ({"operation_session_id": "another-session"}, "operation is unavailable"),
        ({"operation_kind": "workflow_generate"}, "operation kind does not match"),
        ({"operation_artifact_id": "another-artifact"}, "artifact does not match"),
    ],
)
def test_generation_session_rejects_wrong_operation_identity(
    workflow_run_client: TestClient,
    operation_overrides: dict,
    expected_error: str,
) -> None:
    session_id = f"operation-identity-{expected_error.split()[0]}"
    manifest, draft = _recipe_generation_session_payload(
        workflow_run_client,
        session_id=session_id,
        **operation_overrides,
    )

    response = workflow_run_client.put(
        f"/api/v1/projects/proj_demo/freezone/agent-generation-sessions/{session_id}",
        json={"canvas_id": "default", "manifest": manifest, "draft": draft},
    )

    assert response.status_code == 400
    assert expected_error in response.json()["detail"]


@pytest.mark.asyncio
async def test_late_agent_product_delivery_confirms_reserved_credit(
    monkeypatch,
) -> None:
    from novelvideo.api.routes import freezone

    settlements: list[tuple[str, str]] = []
    completions: list[dict] = []
    observed_metrics: list[str] = []
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
    monkeypatch.setattr(freezone.evidence_metrics, "observe", observed_metrics.append)

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
    assert observed_metrics == ["agent_product_reconciled"]


@pytest.mark.asyncio
async def test_recipe_compile_binds_only_fresh_model_evidence(
    workflow_run_client: TestClient,
) -> None:
    from novelvideo.api.routes import freezone
    from novelvideo.api.schemas import FreezoneRecipeCompileRequest
    from novelvideo.freezone.agent_product_operations import (
        read_agent_product_operation,
    )
    from novelvideo.freezone.recipe_runtime import RecipeCompileResult

    def admit(session_id: str) -> dict:
        response = workflow_run_client.post(
            "/api/v1/projects/proj_demo/freezone/agent-product-operations",
            json={
                "product_kind": "recipe_result",
                "generation_session_id": session_id,
                "canvas_id": "default",
                "artifact_id": "image-1",
                "normalized_inputs_hash": session_id,
                "metadata": {"recipe_id": "product-image"},
            },
        )
        assert response.status_code == 200
        return response.json()["data"]

    def request(operation_id: str) -> FreezoneRecipeCompileRequest:
        return FreezoneRecipeCompileRequest(
            project_id="proj_demo",
            product_operation_id=operation_id,
            recipe_id="product-image",
            node_kind="image",
        )

    model_operation = admit("model-compile")
    await freezone._record_recipe_compile_product_evidence(
        body=request(model_operation["operation_id"]),
        compiled=RecipeCompileResult(
            "compiled",
            "model",
            ("product-image",),
            model_call_id="recipe-compiler:call-a",
            executed_at=1.0,
        ),
        user={"id": "u-alice", "username": "alice"},
    )
    stored_model = read_agent_product_operation(
        project_dir=workflow_run_client.state_dir,
        operation_id=model_operation["operation_id"],
    )
    assert stored_model["model_evidence"]["compile_mode"] == "model"

    cached_operation = admit("cached-compile")
    await freezone._record_recipe_compile_product_evidence(
        body=request(cached_operation["operation_id"]),
        compiled=RecipeCompileResult(
            "cached",
            "memory_cache",
            ("product-image",),
        ),
        user={"id": "u-alice", "username": "alice"},
    )
    stored_cached = read_agent_product_operation(
        project_dir=workflow_run_client.state_dir,
        operation_id=cached_operation["operation_id"],
    )
    assert stored_cached["status"] == "failed"
    assert stored_cached["model_evidence"] == {}


def test_metered_model_recipe_compile_requires_operation_before_compiler(
    workflow_run_client: TestClient,
    monkeypatch,
) -> None:
    from novelvideo.api.routes import freezone

    compiler_called = False

    async def fake_compile(**_kwargs):
        nonlocal compiler_called
        compiler_called = True
        raise AssertionError("compiler must not run without product admission")

    monkeypatch.setattr(freezone, "get_usage_meter", lambda: object())
    monkeypatch.setattr(freezone, "compile_recipe_prompt_result", fake_compile)

    response = workflow_run_client.post(
        "/api/v1/freezone/recipes/compile",
        json={"recipe_id": "product-image", "node_kind": "image"},
    )

    assert response.status_code == 400
    assert "product_operation_id is required" in response.json()["detail"]
    assert compiler_called is False


def test_metered_model_recipe_compile_batch_fails_before_any_compiler_call(
    workflow_run_client: TestClient,
    monkeypatch,
) -> None:
    from novelvideo.api.routes import freezone

    compiler_called = False

    async def fake_compile_batch(_items):
        nonlocal compiler_called
        compiler_called = True
        raise AssertionError("batch compiler must not run with an unadmitted item")

    monkeypatch.setattr(freezone, "get_usage_meter", lambda: object())
    monkeypatch.setattr(freezone, "compile_recipe_prompt_batch", fake_compile_batch)

    response = workflow_run_client.post(
        "/api/v1/freezone/recipes/compile-batch",
        json={
            "items": [
                {
                    "request_id": "request-a",
                    "recipe_id": "product-image",
                    "node_kind": "image",
                }
            ]
        },
    )

    assert response.status_code == 400
    assert "product_operation_id is required" in response.json()["detail"]
    assert compiler_called is False


def test_metered_deterministic_recipe_compile_does_not_require_product_operation(
    workflow_run_client: TestClient,
    monkeypatch,
) -> None:
    from novelvideo.api.routes import freezone
    from novelvideo.freezone.recipe_runtime import RecipeCompileResult

    async def fake_compile(**_kwargs):
        return RecipeCompileResult(
            "deterministic prompt",
            "deterministic",
            ("product-image",),
        )

    monkeypatch.setattr(freezone, "get_usage_meter", lambda: object())
    monkeypatch.setattr(freezone, "compile_recipe_prompt_result", fake_compile)

    response = workflow_run_client.post(
        "/api/v1/freezone/recipes/compile",
        json={
            "recipe_id": "product-image",
            "node_kind": "image",
            "prompt_strategy": "template",
        },
    )

    assert response.status_code == 200
    assert response.json()["data"]["compile_mode"] == "deterministic"


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


def test_recipe_result_does_not_use_media_task_id_as_model_evidence(
    workflow_run_client: TestClient,
    monkeypatch,
) -> None:
    from novelvideo.api.routes import freezone
    from novelvideo.freezone.agent_product_operations import (
        read_agent_product_operation,
    )

    monkeypatch.setattr(freezone, "get_usage_meter", lambda: object())
    base = "/api/v1/projects/proj_demo/freezone/canvases/default/workflow-runs"
    created = workflow_run_client.post(
        base,
        json={
            "idempotency_key": "media-proof-is-not-model-proof",
            "actions": [
                {
                    "node_id": "image-1",
                    "action": "generate_image",
                    "recipe_id": "product-image",
                    "recipe_version": "1.0.0",
                    "generation_attempt_id": "attempt-a",
                }
            ],
        },
    ).json()["data"]
    operation_id = created["actions"][0]["product_operation_id"]
    task_key = "task:freezone_image:project:proj_demo:0:media-provider-job"
    workflow_run_client.patch(
        f"{base}/{created['run_id']}",
        json={
            "action_updates": [
                {
                    "node_id": "image-1",
                    "action": "generate_image",
                    "status": "running",
                    "task_key": task_key,
                    "job_id": "media-provider-job",
                }
            ]
        },
    )
    media_task = SimpleNamespace(
        task_type="freezone_image",
        status="completed",
        progress=1.0,
        current_task="completed",
        episode=0,
        beat_num=None,
        scope="media-provider-job",
        result={"image_url": "https://cdn.example.test/image.png"},
        error=None,
    )
    monkeypatch.setattr(
        freezone,
        "get_task_manager",
        lambda: SimpleNamespace(list_tasks_for_project=lambda _ctx: [media_task]),
    )

    response = workflow_run_client.get(base)

    assert response.status_code == 200
    operation = read_agent_product_operation(
        project_dir=workflow_run_client.state_dir,
        operation_id=operation_id,
    )
    assert operation["status"] == "failed"
    assert operation["model_evidence"] == {}


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
