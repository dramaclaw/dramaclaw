from __future__ import annotations

from types import SimpleNamespace

import pytest

from novelvideo.freezone.agent_product_operations import (
    AgentProductSettlementPending,
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

    delivered = finish_agent_product_operation(
        project_dir=tmp_path,
        operation_id=operation["operation_id"],
        outcome="delivered",
        expected_task_id="task-a",
        model_evidence={"model_call_id": "response-a", "executed_at": 1.0},
        result_ref={"kind": "workflow_draft", "id": "draft-a"},
    )
    repeated = finish_agent_product_operation(
        project_dir=tmp_path,
        operation_id=operation["operation_id"],
        outcome="delivered",
        expected_task_id="task-a",
        model_evidence={"model_call_id": "ignored", "executed_at": 2.0},
        result_ref={"kind": "workflow_draft", "id": "ignored"},
    )

    assert delivered["status"] == "delivered"
    assert repeated == delivered


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
        finish_agent_product_operation(
            project_dir=tmp_path,
            operation_id=operation["operation_id"],
            outcome="delivered",
            expected_task_id="task-a",
            model_evidence={"model_call_id": "response-a", "executed_at": 1.0},
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
