from __future__ import annotations

from types import SimpleNamespace

import pytest

from novelvideo.freezone.agent_product_operations import (
    AgentProductSettlementPending,
    bind_agent_product_model_execution,
    bind_agent_product_task,
    create_agent_product_operation,
    finish_agent_product_operation,
    read_agent_generation_session,
    read_agent_product_operation,
    save_agent_generation_session,
)


def _create(project_dir, *, key="stable-key", kind="workflow_result"):
    return create_agent_product_operation(
        project_dir=project_dir,
        project_id="project-a",
        product_kind=kind,
        idempotency_key=key,
        generation_session_id="generation-a",
        canvas_id="canvas-a",
        artifact_id="artifact-a",
        metadata={"source": "agent"},
    )


def test_agent_product_operation_is_durable_and_idempotent(tmp_path):
    first = _create(tmp_path)
    second = _create(tmp_path)

    assert second["operation_id"] == first["operation_id"]
    assert second["status"] == "admitting"
    assert (
        read_agent_product_operation(
            project_dir=tmp_path, operation_id=first["operation_id"]
        )
        == second
    )


@pytest.mark.parametrize(
    "mode", ["timeout_fallback", "memory_cache", "persistent_cache", "deterministic"]
)
def test_server_recipe_delivery_is_immutable_and_requires_server_authority(
    tmp_path, mode
):
    operation = _create(tmp_path, kind="recipe_result")
    operation_id = operation["operation_id"]
    bind_agent_product_task(
        project_dir=tmp_path,
        operation_id=operation_id,
        task_id="task-a",
        root_task_id="task-a",
    )
    receipt = {
        "kind": "recipe_compile_result",
        "id": operation_id,
        "reason": mode,
        "content": "usable prompt",
    }
    kwargs = {
        "project_dir": tmp_path,
        "operation_id": operation_id,
        "outcome": "delivered",
        "expected_task_id": "task-a",
        "result_ref": receipt,
    }
    with pytest.raises(ValueError, match="trusted server delivery"):
        finish_agent_product_operation(**kwargs)
    delivered = finish_agent_product_operation(**kwargs, server_recipe_compile=True)
    assert delivered["model_evidence"] == {}
    assert delivered["status"] == "delivered"
    assert (
        finish_agent_product_operation(**kwargs, server_recipe_compile=True)
        == delivered
    )
    with pytest.raises(ValueError, match="result reference mismatch"):
        finish_agent_product_operation(
            **{**kwargs, "result_ref": {**receipt, "content": "different"}},
            server_recipe_compile=True,
        )


@pytest.mark.parametrize("kind", ["recipe_result", "workflow_result"])
@pytest.mark.parametrize(
    "bad_field,value",
    [
        ("content", "   "),
        ("reason", "unknown"),
        ("id", "another-operation"),
    ],
)
def test_invalid_server_recipe_receipt_cannot_be_delivered(
    tmp_path, kind, bad_field, value
):
    operation = _create(tmp_path, kind=kind)
    operation_id = operation["operation_id"]
    bind_agent_product_task(
        project_dir=tmp_path,
        operation_id=operation_id,
        task_id="task-a",
        root_task_id="task-a",
    )
    receipt = {
        "kind": "recipe_compile_result",
        "id": operation_id,
        "reason": "timeout_fallback",
        "content": "usable prompt",
        bad_field: value,
    }
    with pytest.raises(ValueError, match="trusted server delivery"):
        finish_agent_product_operation(
            project_dir=tmp_path,
            operation_id=operation_id,
            outcome="delivered",
            expected_task_id="task-a",
            result_ref=receipt,
            server_recipe_compile=True,
        )


def test_agent_product_operation_rejects_idempotency_key_rebinding(tmp_path):
    _create(tmp_path)

    with pytest.raises(ValueError, match="bound to another operation"):
        create_agent_product_operation(
            project_dir=tmp_path,
            project_id="project-a",
            product_kind="recipe_result",
            idempotency_key="stable-key",
            generation_session_id="generation-a",
            artifact_id="artifact-a",
        )


def test_delivered_operation_requires_execution_evidence_and_result(tmp_path):
    operation = _create(tmp_path)
    bound = bind_agent_product_task(
        project_dir=tmp_path,
        operation_id=operation["operation_id"],
        task_id="task-a",
        root_task_id="task-a",
    )
    assert bound["status"] == "reserved"

    with pytest.raises(ValueError, match="execution evidence"):
        finish_agent_product_operation(
            project_dir=tmp_path,
            operation_id=operation["operation_id"],
            outcome="delivered",
            expected_task_id="task-a",
            result_ref={"kind": "workflow_draft", "id": "draft-a"},
        )

    bind_agent_product_model_execution(
        project_dir=tmp_path,
        operation_id=operation["operation_id"],
        model_call_id="response-a",
        executed_at=1.0,
        source="server_observed_agent_turn",
    )

    delivered = finish_agent_product_operation(
        project_dir=tmp_path,
        operation_id=operation["operation_id"],
        outcome="delivered",
        expected_task_id="task-a",
        result_ref={"kind": "workflow_draft", "id": "draft-a"},
    )
    repeated = finish_agent_product_operation(
        project_dir=tmp_path,
        operation_id=operation["operation_id"],
        outcome="delivered",
        expected_task_id="task-a",
        result_ref={"kind": "workflow_draft", "id": "draft-a"},
    )

    assert delivered["status"] == "delivered"
    assert repeated == delivered

    with pytest.raises(ValueError, match="result reference mismatch"):
        finish_agent_product_operation(
            project_dir=tmp_path,
            operation_id=operation["operation_id"],
            outcome="delivered",
            expected_task_id="task-a",
            result_ref={"kind": "workflow_draft", "id": "different-draft"},
        )


def test_terminal_operation_requires_a_new_generation_attempt(tmp_path):
    operation = _create(tmp_path, key="completed-attempt", kind="workflow_generate")
    bind_agent_product_task(
        project_dir=tmp_path,
        operation_id=operation["operation_id"],
        task_id="task-a",
        root_task_id="task-a",
    )
    bind_agent_product_model_execution(
        project_dir=tmp_path,
        operation_id=operation["operation_id"],
        model_call_id="response-a",
        executed_at=1.0,
        source="server_observed_agent_turn",
    )
    finish_agent_product_operation(
        project_dir=tmp_path,
        operation_id=operation["operation_id"],
        outcome="delivered",
        expected_task_id="task-a",
        result_ref={"kind": "workflow_skill_definition", "id": "skill-a"},
    )

    with pytest.raises(ValueError, match="new generation_attempt_id"):
        _create(tmp_path, key="completed-attempt", kind="workflow_generate")


def test_recipe_delivery_requires_fresh_model_compile_evidence(tmp_path):
    operation = _create(tmp_path, key="recipe-key", kind="recipe_result")
    bind_agent_product_task(
        project_dir=tmp_path,
        operation_id=operation["operation_id"],
        task_id="task-recipe",
        root_task_id="task-recipe",
    )
    bind_agent_product_model_execution(
        project_dir=tmp_path,
        operation_id=operation["operation_id"],
        model_call_id="cached-result",
        executed_at=1.0,
        source="server_recipe_compiler",
        compile_mode="memory_cache",
    )

    with pytest.raises(ValueError, match="model Recipe compilation"):
        finish_agent_product_operation(
            project_dir=tmp_path,
            operation_id=operation["operation_id"],
            outcome="delivered",
            expected_task_id="task-recipe",
            result_ref={"kind": "recipe_result", "id": "result-a"},
        )


@pytest.mark.parametrize("pending", ["accepted", "submitted", "running"])
def test_late_provider_states_remain_non_terminal(tmp_path, pending):
    operation = _create(tmp_path, key=f"key-{pending}", kind="recipe_result")
    bind_agent_product_task(
        project_dir=tmp_path,
        operation_id=operation["operation_id"],
        task_id=f"task-{pending}",
        root_task_id=f"task-{pending}",
    )

    result = finish_agent_product_operation(
        project_dir=tmp_path,
        operation_id=operation["operation_id"],
        outcome=pending,
        expected_task_id=f"task-{pending}",
    )

    assert result["status"] == pending
    assert result["completed_at"] is None


def test_generation_manifest_and_draft_survive_process_memory_loss(tmp_path):
    saved = save_agent_generation_session(
        project_dir=tmp_path,
        generation_session_id="generation-a",
        project_id="project-a",
        canvas_id="canvas-a",
        manifest={"artifact_mode": "recipe_only", "recipes": [{"id": "recipe-a"}]},
        draft={"recipes": {"0": {"id": "recipe-a"}}},
    )
    loaded = read_agent_generation_session(
        project_dir=tmp_path, generation_session_id="generation-a"
    )

    assert loaded is not None
    assert loaded["manifest"] == saved["manifest"]
    assert loaded["draft"] == saved["draft"]


@pytest.mark.asyncio
async def test_admission_tool_call_is_not_model_generation_evidence(tmp_path):
    from novelvideo.chat import service

    operation = _create(tmp_path, key="observed-turn")
    await service._bind_server_observed_agent_product_execution(
        SimpleNamespace(
            type="tool_updated",
            name="freezone_begin_agent_product_generation",
            status="completed",
            error=None,
            turn_id="turn-a",
            call_id="call-a",
            input={"operation_id": operation["operation_id"]},
            structured={"ok": True, "operation_id": operation["operation_id"]},
            output=None,
        ),
        project_dir=tmp_path,
        project_state_dir=tmp_path,
    )

    stored = read_agent_product_operation(
        project_dir=tmp_path,
        operation_id=operation["operation_id"],
    )
    assert not stored["model_evidence"]


@pytest.mark.asyncio
async def test_admission_cannot_deliver_until_result_tool_binds_evidence(tmp_path):
    from novelvideo.chat import service

    operation = _create(tmp_path, key="admission-then-result")
    bind_agent_product_task(
        project_dir=tmp_path,
        operation_id=operation["operation_id"],
        task_id="task-a",
        root_task_id="task-a",
    )

    await service._bind_server_observed_agent_product_execution(
        SimpleNamespace(
            type="tool_updated",
            name="freezone_begin_agent_product_generation",
            status="completed",
            error=None,
            turn_id="turn-admission",
            call_id="call-admission",
            input={"operation_id": operation["operation_id"]},
            structured={"ok": True, "operation_id": operation["operation_id"]},
            output=None,
        ),
        project_dir=tmp_path,
        project_state_dir=tmp_path,
    )

    with pytest.raises(ValueError, match="execution evidence"):
        finish_agent_product_operation(
            project_dir=tmp_path,
            operation_id=operation["operation_id"],
            outcome="delivered",
            expected_task_id="task-a",
            result_ref={"kind": "workflow_draft", "id": "draft-a"},
        )

    await service._bind_server_observed_agent_product_execution(
        SimpleNamespace(
            type="tool_started",
            name="freezone_prepare_workflow_draft",
            status="pending",
            error=None,
            turn_id="turn-result",
            call_id="call-result",
            input={"operation_id": operation["operation_id"], "intent": {"title": "A"}},
            structured=None,
            output=None,
        ),
        project_dir=tmp_path,
        project_state_dir=tmp_path,
    )

    delivered = finish_agent_product_operation(
        project_dir=tmp_path,
        operation_id=operation["operation_id"],
        outcome="delivered",
        expected_task_id="task-a",
        result_ref={"kind": "workflow_draft", "id": "draft-a"},
    )
    repeated = finish_agent_product_operation(
        project_dir=tmp_path,
        operation_id=operation["operation_id"],
        outcome="delivered",
        expected_task_id="task-a",
        result_ref={"kind": "workflow_draft", "id": "draft-a"},
    )

    assert delivered["model_evidence"]["tool_call_id"] == "call-result"
    assert delivered["model_evidence"]["turn_id"] == "turn-result"
    assert repeated == delivered


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("status", "error", "structured"),
    [
        ("running", None, None),
        ("completed", None, {"ok": False}),
        ("failed", "provider error", {"ok": False}),
    ],
)
async def test_unsuccessful_result_update_does_not_bind_model_evidence(
    tmp_path, status, error, structured
):
    from novelvideo.chat import service

    operation = _create(tmp_path, key=f"result-{status}-{bool(error)}")
    await service._bind_server_observed_agent_product_execution(
        SimpleNamespace(
            type="tool_updated",
            name="freezone_prepare_workflow_draft",
            status=status,
            error=error,
            turn_id="turn-result",
            call_id="call-result",
            input={"operation_id": operation["operation_id"], "intent": {"title": "A"}},
            structured=structured,
            output=None,
        ),
        project_dir=tmp_path,
        project_state_dir=tmp_path,
    )

    stored = read_agent_product_operation(
        project_dir=tmp_path,
        operation_id=operation["operation_id"],
    )
    assert not stored["model_evidence"]


@pytest.mark.asyncio
@pytest.mark.parametrize("tool_name", [
    "freezone_prepare_workflow", "freezone_prepare_workflow_draft",
    "freezone_prepare_workflow_plan_draft",
])
async def test_workflow_result_tool_binds_server_observed_model_execution(tmp_path, tool_name):
    from novelvideo.chat import service

    operation = _create(tmp_path, key="observed-workflow-result")
    await service._bind_server_observed_agent_product_execution(
        SimpleNamespace(
            type="tool_started",
            name=tool_name,
            status="pending",
            error=None,
            turn_id="turn-a",
            call_id="call-result",
            input={"operation_id": operation["operation_id"], "intent": {"title": "A"}},
            structured=None,
            output=None,
        ),
        project_dir=tmp_path,
        project_state_dir=tmp_path,
    )

    stored = read_agent_product_operation(
        project_dir=tmp_path,
        operation_id=operation["operation_id"],
    )
    assert stored["model_evidence"] == {
        "model_call_id": "agent-turn:turn-a:tool:call-result",
        "executed_at": stored["model_evidence"]["executed_at"],
        "source": "server_observed_agent_turn",
        "turn_id": "turn-a",
        "tool_call_id": "call-result",
    }


@pytest.mark.asyncio
async def test_conflicting_model_evidence_binding_is_counted(tmp_path, monkeypatch):
    from novelvideo.chat import evidence_metrics, service

    observed_metrics: list[str] = []
    monkeypatch.setattr(evidence_metrics, "observe", observed_metrics.append)
    operation = _create(tmp_path, key="conflicting-evidence")
    bind_agent_product_model_execution(
        project_dir=tmp_path,
        operation_id=operation["operation_id"],
        model_call_id="agent-turn:first",
        executed_at=1.0,
        source="server_observed_agent_turn",
    )

    await service._bind_server_observed_agent_product_execution(
        SimpleNamespace(
            type="tool_started",
            name="freezone_prepare_workflow_draft",
            status="pending",
            error=None,
            turn_id="turn-second",
            call_id="call-second",
            input={"operation_id": operation["operation_id"]},
            structured=None,
            output=None,
        ),
        project_dir=tmp_path,
        project_state_dir=tmp_path,
    )

    assert observed_metrics == ["agent_product_binding_failed"]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("tool_name", "kind", "operation_key", "tool_input"),
    [
        (
            "freezone_put_agent_catalog_skill",
            "workflow_generate",
            "skill",
            {
                "skill_studio_session_id": "generation-a",
                "skill": {"id": "artifact-a"},
            },
        ),
        (
            "freezone_put_agent_catalog_recipe",
            "recipe_generate",
            "recipe",
            {
                "skill_studio_session_id": "generation-a",
                "index": 0,
                "recipe": {"id": "artifact-a"},
            },
        ),
    ],
)
async def test_catalog_result_tool_binds_its_generation_operation(
    tmp_path, tool_name, kind, operation_key, tool_input
):
    from novelvideo.chat import service

    operation = _create(tmp_path, key=f"observed-{kind}", kind=kind)
    operations = (
        {"skill": operation, "recipes": {}}
        if operation_key == "skill"
        else {"recipes": {0: operation}}
    )
    save_agent_generation_session(
        project_dir=tmp_path,
        generation_session_id="generation-a",
        project_id="project-a",
        canvas_id="canvas-a",
        manifest={"artifact_mode": "recipe_only"},
        draft={"operations": operations},
    )

    await service._bind_server_observed_agent_product_execution(
        SimpleNamespace(
            type="tool_started",
            name=tool_name,
            status="pending",
            error=None,
            turn_id="turn-catalog",
            call_id=f"call-{operation_key}",
            input=tool_input,
            structured=None,
            output=None,
        ),
        project_dir=tmp_path,
        project_state_dir=tmp_path,
    )

    stored = read_agent_product_operation(
        project_dir=tmp_path,
        operation_id=operation["operation_id"],
    )
    assert stored["model_evidence"]["model_call_id"] == (
        f"agent-turn:turn-catalog:tool:call-{operation_key}"
    )


@pytest.mark.asyncio
async def test_product_task_waits_for_durable_delivery_before_success(
    tmp_path, monkeypatch
):
    from novelvideo.task_backend.runners import freezone as freezone_runner

    operation = _create(tmp_path)
    bind_agent_product_task(
        project_dir=tmp_path,
        operation_id=operation["operation_id"],
        task_id="task-a",
        root_task_id="task-a",
    )
    sleep_calls = 0

    async def deliver_after_wait(_seconds):
        nonlocal sleep_calls
        sleep_calls += 1
        bind_agent_product_model_execution(
            project_dir=tmp_path,
            operation_id=operation["operation_id"],
            model_call_id="response-a",
            executed_at=1.0,
            source="server_observed_agent_turn",
        )
        finish_agent_product_operation(
            project_dir=tmp_path,
            operation_id=operation["operation_id"],
            outcome="delivered",
            expected_task_id="task-a",
            result_ref={"kind": "workflow_draft", "id": "draft-a"},
        )

    monkeypatch.setattr(freezone_runner.asyncio, "sleep", deliver_after_wait)
    result = await freezone_runner._run_freezone_agent_product_async(
        {
            "task_type": "freezone_agent_workflow_result",
            "__run_task_id": "task-a",
            "payload": {
                "operation_id": operation["operation_id"],
                "product_kind": "workflow_result",
            },
        },
        SimpleNamespace(state_dir=tmp_path),
    )

    assert sleep_calls == 1
    assert result["delivery_status"] == "delivered"
    assert result["result_ref"]["id"] == "draft-a"


@pytest.mark.asyncio
async def test_product_task_fails_when_operation_has_no_result(tmp_path):
    from novelvideo.task_backend.runners import freezone as freezone_runner

    operation = _create(tmp_path)
    bind_agent_product_task(
        project_dir=tmp_path,
        operation_id=operation["operation_id"],
        task_id="task-a",
        root_task_id="task-a",
    )
    finish_agent_product_operation(
        project_dir=tmp_path,
        operation_id=operation["operation_id"],
        outcome="failed",
        expected_task_id="task-a",
    )

    with pytest.raises(RuntimeError, match="without delivery"):
        await freezone_runner._run_freezone_agent_product_async(
            {
                "task_type": "freezone_agent_workflow_result",
                "__run_task_id": "task-a",
                "payload": {
                    "operation_id": operation["operation_id"],
                    "product_kind": "workflow_result",
                },
            },
            SimpleNamespace(state_dir=tmp_path),
        )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("run_status", "pending_status"),
    [
        ("cancelled", "workflow_cancelled"),
        ("interrupted", "workflow_interrupted"),
        ("failed", "workflow_failed"),
        ("completed", "workflow_completed"),
        ("running", "workflow_lease_expired"),
    ],
)
async def test_recipe_waiter_releases_worker_after_workflow_ends(
    tmp_path, monkeypatch, run_status, pending_status
):
    from novelvideo.freezone import workflow_runs
    from novelvideo.task_backend.runners import freezone as freezone_runner

    operation = create_agent_product_operation(
        project_dir=tmp_path,
        project_id="project-a",
        product_kind="recipe_result",
        idempotency_key=f"recipe-{run_status}",
        generation_session_id="run-a",
        canvas_id="canvas-a",
        artifact_id="image-a",
        metadata={"workflow_run_id": "run-a", "node_id": "image-a"},
    )
    bind_agent_product_task(
        project_dir=tmp_path,
        operation_id=operation["operation_id"],
        task_id="task-a",
        root_task_id="task-a",
    )
    monkeypatch.setattr(
        workflow_runs,
        "read_workflow_run",
        lambda **_kwargs: {
            "status": run_status,
            "lease_expires_at": "2000-01-01T00:00:00Z",
        },
    )
    envelope = {
        "task_type": "freezone_agent_recipe_result",
        "__run_task_id": "task-a",
        "payload": {
            "operation_id": operation["operation_id"],
            "product_kind": "recipe_result",
        },
    }

    with pytest.raises(AgentProductSettlementPending) as exc_info:
        await freezone_runner._run_freezone_agent_product_async(
            envelope, SimpleNamespace(state_dir=tmp_path)
        )
    assert exc_info.value.status == pending_status
    assert read_agent_product_operation(
        project_dir=tmp_path, operation_id=operation["operation_id"]
    )["status"] == "reserved"

    # A provider result can still arrive after the worker has freed its slot.
    bind_agent_product_model_execution(
        project_dir=tmp_path,
        operation_id=operation["operation_id"],
        model_call_id="recipe-compiler:late-result",
        executed_at=1.0,
        source="server_recipe_compiler",
        compile_mode="model",
    )
    finish_agent_product_operation(
        project_dir=tmp_path,
        operation_id=operation["operation_id"],
        outcome="delivered",
        expected_task_id="task-a",
        result_ref={"kind": "recipe_result", "id": "image-a"},
    )
    result = await freezone_runner._run_freezone_agent_product_async(
        envelope, SimpleNamespace(state_dir=tmp_path)
    )
    assert result["delivery_status"] == "delivered"


@pytest.mark.asyncio
async def test_recipe_waiter_does_not_hold_worker_slot_while_run_is_live(
    tmp_path, monkeypatch
):
    # Issue #700: the waiter shares the default lane with the media task it
    # waits for. Holding the slot while the Run is live deadlocks small lanes.
    from novelvideo.freezone import workflow_runs
    from novelvideo.task_backend.runners import freezone as freezone_runner

    operation = create_agent_product_operation(
        project_dir=tmp_path,
        project_id="project-a",
        product_kind="recipe_result",
        idempotency_key="recipe-live-run",
        generation_session_id="run-a",
        canvas_id="canvas-a",
        artifact_id="image-a",
        metadata={"workflow_run_id": "run-a", "node_id": "image-a"},
    )
    bind_agent_product_task(
        project_dir=tmp_path,
        operation_id=operation["operation_id"],
        task_id="task-a",
        root_task_id="task-a",
    )
    monkeypatch.setattr(
        workflow_runs,
        "read_workflow_run",
        lambda **_kwargs: {
            "status": "running",
            "lease_expires_at": "2999-01-01T00:00:00Z",
        },
    )

    async def must_not_wait(_seconds):
        raise AssertionError("recipe waiter held its worker slot")

    monkeypatch.setattr(freezone_runner.asyncio, "sleep", must_not_wait)

    with pytest.raises(AgentProductSettlementPending) as exc_info:
        await freezone_runner._run_freezone_agent_product_async(
            {
                "task_type": "freezone_agent_recipe_result",
                "__run_task_id": "task-a",
                "payload": {
                    "operation_id": operation["operation_id"],
                    "product_kind": "recipe_result",
                },
            },
            SimpleNamespace(state_dir=tmp_path),
        )
    assert exc_info.value.status == "awaiting_delivery"
    assert read_agent_product_operation(
        project_dir=tmp_path, operation_id=operation["operation_id"]
    )["status"] == "reserved"


def test_product_task_timeout_preserves_pending_operation(tmp_path, monkeypatch):
    from novelvideo.task_backend.cancel import TaskTimedOut
    from novelvideo.task_backend.runners import freezone as freezone_runner

    operation = _create(tmp_path, kind="recipe_result")
    bind_agent_product_task(
        project_dir=tmp_path,
        operation_id=operation["operation_id"],
        task_id="task-a",
        root_task_id="task-a",
    )
    finish_agent_product_operation(
        project_dir=tmp_path,
        operation_id=operation["operation_id"],
        outcome="submitted",
        expected_task_id="task-a",
    )

    def time_out(_envelope, coro, **_kwargs):
        coro.close()
        raise TaskTimedOut(timeout_seconds=1)

    monkeypatch.setattr(freezone_runner, "_run_cancellable", time_out)

    with pytest.raises(AgentProductSettlementPending) as exc_info:
        freezone_runner.run_freezone_agent_product(
            {
                "task_type": "freezone_agent_recipe_result",
                "__run_task_id": "task-a",
                "payload": {
                    "operation_id": operation["operation_id"],
                    "product_kind": "recipe_result",
                },
            },
            SimpleNamespace(state_dir=tmp_path),
        )

    assert exc_info.value.operation_id == operation["operation_id"]
    assert exc_info.value.status == "submitted"
