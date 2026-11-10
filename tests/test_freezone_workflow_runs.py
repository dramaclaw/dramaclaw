from __future__ import annotations

import sqlite3
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from novelvideo.freezone.workflow_runs import (
    WorkflowRunIdempotencyConflict,
    WorkflowRunLeaseConflict,
    classify_workflow_error,
    create_workflow_run,
    interrupt_stale_workflow_runs,
    list_workflow_runs,
    prune_workflow_runs,
    read_workflow_run,
    reconcile_workflow_runs_with_canvas_nodes,
    reconcile_workflow_runs_with_canvas_results,
    reconcile_workflow_runs_with_tasks,
    update_workflow_run,
    workflow_runs_db_path,
    workflow_error_diagnostics,
)


def _set_run_timestamps(
    project_dir: Path,
    run_id: str,
    *,
    updated_at: str,
    completed_at: str | None = None,
) -> None:
    with sqlite3.connect(workflow_runs_db_path(project_dir)) as conn:
        conn.execute(
            """
            UPDATE workflow_runs
            SET updated_at = ?, completed_at = COALESCE(?, completed_at)
            WHERE run_id = ?
            """,
            (updated_at, completed_at, run_id),
        )


def test_run_list_batches_actions_without_per_run_queries(tmp_path):
    from novelvideo.freezone.workflow_runs import _list_runs_in_transaction

    expected = []
    for index in range(3):
        run = create_workflow_run(
            project_dir=tmp_path, project_id="project-a", canvas_id="default",
            actions=[{"node_id": f"image-{index}", "action": "generate_image"}], actor_id="alice",
        )
        expected.append(run["run_id"])
    statements = []
    with sqlite3.connect(workflow_runs_db_path(tmp_path)) as conn:
        conn.row_factory = sqlite3.Row
        conn.set_trace_callback(statements.append)
        runs = _list_runs_in_transaction(conn, canvas_id="default")
    assert {run["run_id"] for run in runs} == set(expected)
    assert all(len(run["actions"]) == 1 for run in runs)
    assert len(statements) == 2


def test_workflow_run_tracks_actions_and_completion(tmp_path: Path) -> None:
    run = create_workflow_run(
        project_dir=tmp_path,
        project_id="project-a",
        canvas_id="default",
        actions=[
            {"node_id": "image-1", "action": "save"},
            {"node_id": "video-1", "action": "generate_video"},
        ],
        actor_id="alice",
    )

    updated = update_workflow_run(
        project_dir=tmp_path,
        canvas_id="default",
        run_id=run["run_id"],
        action_updates=[
            {"node_id": "image-1", "action": "save", "status": "completed"},
            {"node_id": "video-1", "action": "generate_video", "status": "blocked"},
        ],
        status="failed",
    )

    assert updated is not None
    assert updated["status"] == "failed"
    assert updated["resumable"] is True
    assert updated["completed_at"]
    assert [item["status"] for item in updated["actions"]] == ["completed", "blocked"]
    assert (
        read_workflow_run(
            project_dir=tmp_path, canvas_id="default", run_id=run["run_id"]
        )
        == updated
    )
    assert workflow_runs_db_path(tmp_path).is_file()
    assert not (tmp_path / "freezone" / "_workflow_runs").exists()


def test_workflow_runs_are_listed_newest_first(tmp_path: Path) -> None:
    first = create_workflow_run(
        project_dir=tmp_path,
        project_id="project-a",
        canvas_id="default",
        actions=[{"node_id": "one", "action": "generate_image"}],
    )
    second = create_workflow_run(
        project_dir=tmp_path,
        project_id="project-a",
        canvas_id="default",
        actions=[{"node_id": "two", "action": "generate_video"}],
    )

    listed = list_workflow_runs(project_dir=tmp_path, canvas_id="default")

    assert [item["run_id"] for item in listed] == [second["run_id"], first["run_id"]]


def test_workflow_run_creation_is_idempotent(tmp_path: Path) -> None:
    first = create_workflow_run(
        project_dir=tmp_path,
        project_id="project-a",
        canvas_id="default",
        actions=[{"node_id": "one", "action": "generate_image"}],
        idempotency_key="canvas-run:request-1",
    )
    duplicate = create_workflow_run(
        project_dir=tmp_path,
        project_id="project-a",
        canvas_id="default",
        actions=[{"node_id": "one", "action": "generate_image"}],
        idempotency_key="canvas-run:request-1",
    )

    assert duplicate["run_id"] == first["run_id"]
    assert len(list_workflow_runs(project_dir=tmp_path, canvas_id="default")) == 1


def test_workflow_run_idempotency_key_rejects_a_different_request(
    tmp_path: Path,
) -> None:
    create_workflow_run(
        project_dir=tmp_path,
        project_id="project-a",
        canvas_id="default",
        actions=[{"node_id": "one", "action": "generate_image"}],
        idempotency_key="canvas-run:request-1",
    )

    with pytest.raises(WorkflowRunIdempotencyConflict, match="different request"):
        create_workflow_run(
            project_dir=tmp_path,
            project_id="project-a",
            canvas_id="default",
            actions=[{"node_id": "two", "action": "generate_video"}],
            idempotency_key="canvas-run:request-1",
        )


def test_concurrent_workflow_run_creation_is_idempotent(tmp_path: Path) -> None:
    def create() -> dict:
        return create_workflow_run(
            project_dir=tmp_path,
            project_id="project-a",
            canvas_id="default",
            actions=[{"node_id": "one", "action": "generate_image"}],
            idempotency_key="canvas-run:concurrent-request",
        )

    with ThreadPoolExecutor(max_workers=2) as executor:
        runs = list(executor.map(lambda _: create(), range(2)))

    assert runs[0]["run_id"] == runs[1]["run_id"]
    assert len(list_workflow_runs(project_dir=tmp_path, canvas_id="default")) == 1


def test_active_runner_lease_prevents_second_runner(tmp_path: Path) -> None:
    create_workflow_run(
        project_dir=tmp_path,
        project_id="project-a",
        canvas_id="default",
        actions=[{"node_id": "one", "action": "generate_image"}],
        runner_id="runner-one",
    )

    with pytest.raises(WorkflowRunLeaseConflict, match="another workflow runner"):
        create_workflow_run(
            project_dir=tmp_path,
            project_id="project-a",
            canvas_id="default",
            actions=[{"node_id": "two", "action": "generate_video"}],
            runner_id="runner-two",
        )


def test_runner_lease_protects_updates_and_tracks_task_reference(
    tmp_path: Path,
) -> None:
    run = create_workflow_run(
        project_dir=tmp_path,
        project_id="project-a",
        canvas_id="default",
        actions=[{"node_id": "one", "action": "generate_image"}],
        runner_id="runner-one",
    )

    with pytest.raises(WorkflowRunLeaseConflict, match="active runner"):
        update_workflow_run(
            project_dir=tmp_path,
            canvas_id="default",
            run_id=run["run_id"],
            status="running",
            runner_id="runner-two",
        )

    updated = update_workflow_run(
        project_dir=tmp_path,
        canvas_id="default",
        run_id=run["run_id"],
        runner_id="runner-one",
        action_updates=[
            {
                "node_id": "one",
                "action": "generate_image",
                "status": "running",
                "task_key": "image_generation:node-one",
                "task_type": "image_generation",
                "job_id": "job-one",
                "retry_count": 2,
            }
        ],
    )

    assert updated is not None
    assert updated["actions"][0]["task_key"] == "image_generation:node-one"
    assert updated["actions"][0]["task_type"] == "image_generation"
    assert updated["actions"][0]["job_id"] == "job-one"
    assert updated["actions"][0]["retry_count"] == 2


def test_expired_runner_lease_cannot_be_revived_by_a_late_heartbeat(
    tmp_path: Path,
) -> None:
    run = create_workflow_run(
        project_dir=tmp_path,
        project_id="project-a",
        canvas_id="default",
        actions=[{"node_id": "one", "action": "generate_image"}],
        runner_id="runner-one",
    )
    expired = (
        (datetime.now(timezone.utc) - timedelta(seconds=1))
        .isoformat()
        .replace("+00:00", "Z")
    )
    with sqlite3.connect(workflow_runs_db_path(tmp_path)) as conn:
        conn.execute(
            "UPDATE workflow_runs SET lease_expires_at = ? WHERE run_id = ?",
            (expired, run["run_id"]),
        )

    with pytest.raises(WorkflowRunLeaseConflict, match="active runner"):
        update_workflow_run(
            project_dir=tmp_path,
            canvas_id="default",
            run_id=run["run_id"],
            status="running",
            runner_id="runner-one",
        )


def test_browser_cannot_complete_generation_without_durable_artifact(
    tmp_path: Path,
) -> None:
    run = create_workflow_run(
        project_dir=tmp_path,
        project_id="project-a",
        canvas_id="default",
        actions=[{"node_id": "one", "action": "generate_image"}],
    )

    updated = update_workflow_run(
        project_dir=tmp_path,
        canvas_id="default",
        run_id=run["run_id"],
        action_updates=[
            {"node_id": "one", "action": "generate_image", "status": "completed"}
        ],
        status="completed",
    )

    assert updated is not None
    assert updated["status"] == "running"
    assert updated["actions"][0]["status"] == "running"


@pytest.mark.parametrize(
    ("error", "category", "retryable"),
    [
        ("HTTP 503 upstream unavailable", "transient_upstream", True),
        ("read ECONNRESET", "transient_upstream", True),
        ("Recipe 文本生成超时：模型未返回结果", "transient_upstream", True),
        ("HTTP 401: Invalid token", "authentication", False),
        ("model_not_found", "model_unavailable", False),
        ("HTTP 429: token-plan quota has been exhausted", "quota_exhausted", False),
    ],
)
def test_workflow_error_classification(
    error: str,
    category: str,
    retryable: bool,
) -> None:
    assert classify_workflow_error(error) == (category, retryable)


def test_workflow_error_diagnostics_extracts_request_id_and_user_message() -> None:
    diagnostics = workflow_error_diagnostics(
        "freezone video generation failed: [InvalidParameter] parameter video total "
        "duration must be <= 15.2. Request id: 02178540585944116abc"
    )

    assert diagnostics == {
        "error_category": "invalid_request",
        "retryable": False,
        "error_request_id": "02178540585944116abc",
        "error_fingerprint": "request:02178540585944116abc",
        "user_error": "输入视频总时长超过当前模型限制，请缩短素材或拆分生成。",
    }


def test_workflow_error_diagnostics_humanizes_output_safety_review() -> None:
    diagnostics = workflow_error_diagnostics(
        "freezone video generation failed: "
        "[OutputVideoSensitiveContentDetected] The output may contain sensitive "
        "information. Request id: output-review-123"
    )

    assert diagnostics["error_category"] == "content_policy"
    assert diagnostics["retryable"] is False
    assert diagnostics["error_request_id"] == "output-review-123"
    assert diagnostics["user_error"] == (
        "内容安全审核未通过（输出视频）：模型拒绝了本次生成结果，"
        "请调整敏感情节或画面描述后重试。"
    )


def test_failed_action_persists_normalized_error_diagnostics(tmp_path: Path) -> None:
    run = create_workflow_run(
        project_dir=tmp_path,
        project_id="project-a",
        canvas_id="default",
        actions=[{"node_id": "one", "action": "generate_audio"}],
    )

    updated = update_workflow_run(
        project_dir=tmp_path,
        canvas_id="default",
        run_id=run["run_id"],
        action_updates=[
            {
                "node_id": "one",
                "action": "generate_audio",
                "status": "failed",
                "error": "HTTP 503 timeout (request id: req-123)",
            }
        ],
    )

    assert updated is not None
    action = updated["actions"][0]
    assert action["error_category"] == "transient_upstream"
    assert action["retryable"] is True
    assert action["error_request_id"] == "req-123"
    assert action["error_fingerprint"] == "request:req-123"
    assert action["user_error"] == "上游模型服务暂时不可用，系统可稍后重试。"

    retried = update_workflow_run(
        project_dir=tmp_path,
        canvas_id="default",
        run_id=run["run_id"],
        action_updates=[
            {
                "node_id": "one",
                "action": "generate_audio",
                "status": "running",
            }
        ],
    )

    assert retried is not None
    retried_action = retried["actions"][0]
    assert retried_action["status"] == "running"
    assert retried_action["error"] is None
    assert "error_category" not in retried_action
    assert "error_fingerprint" not in retried_action
    assert "user_error" not in retried_action


@pytest.mark.parametrize("initial_status", ["running", "completed"])
def test_task_reconciliation_completes_run_with_existing_artifact(
    tmp_path: Path, initial_status: str
) -> None:
    output_path = tmp_path / "freezone" / "_outputs" / "image.png"
    output_path.parent.mkdir(parents=True)
    output_path.write_bytes(b"image")
    run = create_workflow_run(
        project_dir=tmp_path,
        project_id="project-a",
        canvas_id="default",
        actions=[{"node_id": "one", "action": "generate_image"}],
    )
    update_workflow_run(
        project_dir=tmp_path,
        canvas_id="default",
        run_id=run["run_id"],
        action_updates=[
            {
                "node_id": "one",
                "action": "generate_image",
                "status": initial_status,
                "task_key": "task:image-one",
            }
        ],
    )

    changed = reconcile_workflow_runs_with_tasks(
        project_dir=tmp_path,
        canvas_id="default",
        tasks_by_key={
            "task:image-one": {
                "status": "completed",
                "result": {"image_path": str(output_path)},
                "error": None,
            }
        },
    )

    assert changed == [run["run_id"]]
    reconciled = read_workflow_run(
        project_dir=tmp_path, canvas_id="default", run_id=run["run_id"]
    )
    assert reconciled is not None
    assert reconciled["status"] == "completed"
    assert reconciled["actions"][0]["artifact_status"] == "valid"


def test_late_browser_progress_does_not_reopen_reconciled_compose_action(
    tmp_path: Path,
) -> None:
    run = create_workflow_run(
        project_dir=tmp_path,
        project_id="project-a",
        canvas_id="default",
        actions=[
            {"node_id": "compose", "action": "auto_compose_video"},
            {"node_id": "publish", "action": "save"},
        ],
    )
    update_workflow_run(
        project_dir=tmp_path,
        canvas_id="default",
        run_id=run["run_id"],
        action_updates=[
            {
                "node_id": "compose",
                "action": "auto_compose_video",
                "status": "running",
                "task_key": "task:compose-one",
                "task_type": "freezone_video_compose",
                "job_id": "compose-one",
            }
        ],
    )

    reconcile_workflow_runs_with_tasks(
        project_dir=tmp_path,
        canvas_id="default",
        tasks_by_key={
            "task:compose-one": {
                "status": "completed",
                "result": {"video_url": "/static/project/final.mp4"},
                "error": None,
            }
        },
    )

    late_progress = update_workflow_run(
        project_dir=tmp_path,
        canvas_id="default",
        run_id=run["run_id"],
        action_updates=[
            {
                "node_id": "compose",
                "action": "auto_compose_video",
                "status": "running",
                "phase": "syncing_result",
            }
        ],
    )

    assert late_progress is not None
    compose_action = late_progress["actions"][0]
    assert compose_action["status"] == "completed"
    assert compose_action["artifact_status"] == "valid"
    assert compose_action["phase"] == "waiting_dependencies"
    assert late_progress["status"] == "running"


def test_task_reconciliation_rejects_missing_artifact(tmp_path: Path) -> None:
    input_path = tmp_path / "inputs" / "source.png"
    input_path.parent.mkdir(parents=True)
    input_path.write_bytes(b"input")
    run = create_workflow_run(
        project_dir=tmp_path,
        project_id="project-a",
        canvas_id="default",
        actions=[{"node_id": "one", "action": "generate_video"}],
    )
    update_workflow_run(
        project_dir=tmp_path,
        canvas_id="default",
        run_id=run["run_id"],
        action_updates=[
            {
                "node_id": "one",
                "action": "generate_video",
                "status": "running",
                "task_key": "task:video-one",
            }
        ],
    )

    reconcile_workflow_runs_with_tasks(
        project_dir=tmp_path,
        canvas_id="default",
        tasks_by_key={
            "task:video-one": {
                "status": "completed",
                "result": {
                    "input_image_path": str(input_path),
                    "video_path": "freezone/_outputs/missing.mp4",
                },
                "error": None,
            }
        },
    )

    reconciled = read_workflow_run(
        project_dir=tmp_path, canvas_id="default", run_id=run["run_id"]
    )
    assert reconciled is not None
    assert reconciled["status"] == "failed"
    assert reconciled["actions"][0]["artifact_status"] == "missing"
    assert reconciled["actions"][0]["error_category"] == "artifact_missing"
    assert reconciled["actions"][0]["retryable"] is False
    assert (
        reconcile_workflow_runs_with_tasks(
            project_dir=tmp_path,
            canvas_id="default",
            tasks_by_key={
                "task:video-one": {
                    "status": "completed",
                    "result": {
                        "input_image_path": str(input_path),
                        "video_path": "freezone/_outputs/missing.mp4",
                    },
                    "error": None,
                }
            },
        )
        == []
    )


def test_task_reconciliation_rejects_unverifiable_artifact(tmp_path: Path) -> None:
    run = create_workflow_run(
        project_dir=tmp_path,
        project_id="project-a",
        canvas_id="default",
        actions=[{"node_id": "one", "action": "generate_image"}],
    )
    update_workflow_run(
        project_dir=tmp_path,
        canvas_id="default",
        run_id=run["run_id"],
        action_updates=[
            {
                "node_id": "one",
                "action": "generate_image",
                "status": "running",
                "task_key": "task:image-one",
            }
        ],
    )

    reconcile_workflow_runs_with_tasks(
        project_dir=tmp_path,
        canvas_id="default",
        tasks_by_key={
            "task:image-one": {"status": "completed", "result": {}, "error": None}
        },
    )

    reconciled = read_workflow_run(
        project_dir=tmp_path, canvas_id="default", run_id=run["run_id"]
    )
    assert reconciled is not None
    assert reconciled["status"] == "failed"
    assert reconciled["actions"][0]["artifact_status"] == "unverified"


def test_task_reconciliation_classifies_task_failure(tmp_path: Path) -> None:
    run = create_workflow_run(
        project_dir=tmp_path,
        project_id="project-a",
        canvas_id="default",
        actions=[{"node_id": "one", "action": "generate_audio"}],
    )
    update_workflow_run(
        project_dir=tmp_path,
        canvas_id="default",
        run_id=run["run_id"],
        action_updates=[
            {
                "node_id": "one",
                "action": "generate_audio",
                "status": "running",
                "task_key": "task:audio-one",
            }
        ],
    )

    reconcile_workflow_runs_with_tasks(
        project_dir=tmp_path,
        canvas_id="default",
        tasks_by_key={
            "task:audio-one": {
                "status": "failed",
                "result": None,
                "error": "HTTP 503 upstream unavailable",
            }
        },
    )

    reconciled = read_workflow_run(
        project_dir=tmp_path, canvas_id="default", run_id=run["run_id"]
    )
    assert reconciled is not None
    assert reconciled["actions"][0]["error_category"] == "transient_upstream"
    assert reconciled["actions"][0]["retryable"] is True


@pytest.mark.parametrize("terminal_status", ["completed", "failed", "interrupted"])
def test_late_heartbeat_does_not_reopen_terminal_run(
    tmp_path: Path,
    terminal_status: str,
) -> None:
    run = create_workflow_run(
        project_dir=tmp_path,
        project_id="project-a",
        canvas_id="default",
        actions=[{"node_id": "one", "action": "save"}],
    )
    update_workflow_run(
        project_dir=tmp_path,
        canvas_id="default",
        run_id=run["run_id"],
        status=terminal_status,
        action_updates=(
            [{"node_id": "one", "action": "save", "status": "completed"}]
            if terminal_status == "completed"
            else None
        ),
    )

    late_heartbeat = update_workflow_run(
        project_dir=tmp_path,
        canvas_id="default",
        run_id=run["run_id"],
        status="running",
    )

    assert late_heartbeat is not None
    assert late_heartbeat["status"] == terminal_status


def test_new_workflow_run_supersedes_overlapping_resumable_run(tmp_path: Path) -> None:
    first = create_workflow_run(
        project_dir=tmp_path,
        project_id="project-a",
        canvas_id="default",
        actions=[
            {"node_id": "shared", "action": "generate_image"},
            {"node_id": "old-only", "action": "generate_video"},
        ],
    )
    second = create_workflow_run(
        project_dir=tmp_path,
        project_id="project-a",
        canvas_id="default",
        actions=[{"node_id": "shared", "action": "generate_image"}],
    )

    superseded = read_workflow_run(
        project_dir=tmp_path,
        canvas_id="default",
        run_id=first["run_id"],
    )
    assert superseded is not None
    assert superseded["status"] == "cancelled"
    assert superseded["resumable"] is False
    assert superseded["metadata"]["superseded_by_run_id"] == second["run_id"]

    stale_update = update_workflow_run(
        project_dir=tmp_path,
        canvas_id="default",
        run_id=first["run_id"],
        status="completed",
    )
    assert stale_update is not None
    assert stale_update["status"] == "cancelled"


def test_new_workflow_run_supersedes_disjoint_active_run_on_same_canvas(
    tmp_path: Path,
) -> None:
    first = create_workflow_run(
        project_dir=tmp_path,
        project_id="project-a",
        canvas_id="default",
        actions=[{"node_id": "one", "action": "generate_image"}],
    )
    create_workflow_run(
        project_dir=tmp_path,
        project_id="project-a",
        canvas_id="default",
        actions=[{"node_id": "two", "action": "generate_video"}],
    )

    preserved = read_workflow_run(
        project_dir=tmp_path,
        canvas_id="default",
        run_id=first["run_id"],
    )
    assert preserved is not None
    assert preserved["status"] == "cancelled"
    assert preserved["resumable"] is False


def test_reconcile_cancels_run_after_all_unfinished_nodes_are_deleted(
    tmp_path: Path,
) -> None:
    run = create_workflow_run(
        project_dir=tmp_path,
        project_id="project-a",
        canvas_id="default",
        actions=[
            {"node_id": "completed", "action": "save"},
            {"node_id": "pending", "action": "generate_image"},
        ],
    )
    update_workflow_run(
        project_dir=tmp_path,
        canvas_id="default",
        run_id=run["run_id"],
        action_updates=[
            {"node_id": "completed", "action": "save", "status": "completed"}
        ],
    )

    cancelled = reconcile_workflow_runs_with_canvas_nodes(
        project_dir=tmp_path,
        canvas_id="default",
        existing_node_ids={"completed"},
    )

    assert cancelled == [run["run_id"]]
    reconciled = read_workflow_run(
        project_dir=tmp_path, canvas_id="default", run_id=run["run_id"]
    )
    assert reconciled is not None
    assert reconciled["status"] == "cancelled"
    assert reconciled["metadata"]["cancel_reason"] == "workflow_nodes_deleted"

    late_heartbeat = update_workflow_run(
        project_dir=tmp_path,
        canvas_id="default",
        run_id=run["run_id"],
        status="running",
    )
    assert late_heartbeat is not None
    assert late_heartbeat["status"] == "cancelled"


def test_reconcile_keeps_run_when_an_unfinished_node_still_exists(
    tmp_path: Path,
) -> None:
    run = create_workflow_run(
        project_dir=tmp_path,
        project_id="project-a",
        canvas_id="default",
        actions=[{"node_id": "pending", "action": "generate_image"}],
    )

    cancelled = reconcile_workflow_runs_with_canvas_nodes(
        project_dir=tmp_path,
        canvas_id="default",
        existing_node_ids={"pending"},
    )

    assert cancelled == []
    preserved = read_workflow_run(
        project_dir=tmp_path, canvas_id="default", run_id=run["run_id"]
    )
    assert preserved is not None
    assert preserved["status"] == "running"


def test_reconcile_can_exclude_active_runs_during_read_cleanup(tmp_path: Path) -> None:
    run = create_workflow_run(
        project_dir=tmp_path,
        project_id="project-a",
        canvas_id="default",
        actions=[{"node_id": "pending", "action": "generate_image"}],
    )

    cancelled = reconcile_workflow_runs_with_canvas_nodes(
        project_dir=tmp_path,
        canvas_id="default",
        existing_node_ids=set(),
        run_statuses={"failed", "interrupted"},
    )

    assert cancelled == []
    preserved = read_workflow_run(
        project_dir=tmp_path, canvas_id="default", run_id=run["run_id"]
    )
    assert preserved is not None
    assert preserved["status"] == "running"


def test_reconcile_completes_taskless_text_from_durable_canvas_result(
    tmp_path: Path,
) -> None:
    run = create_workflow_run(
        project_dir=tmp_path,
        project_id="project-a",
        canvas_id="default",
        actions=[{"node_id": "text-1", "action": "generate_text"}],
    )
    update_workflow_run(
        project_dir=tmp_path,
        canvas_id="default",
        run_id=run["run_id"],
        action_updates=[
            {"node_id": "text-1", "action": "generate_text", "status": "completed"}
        ],
        status="completed",
    )

    changed = reconcile_workflow_runs_with_canvas_results(
        project_dir=tmp_path,
        canvas_id="default",
        canvas_nodes=[
            {
                "id": "text-1",
                "type": "textAnnotationNode",
                "data": {
                    "content": "A durable generated result",
                    "workflowTextGenerated": True,
                },
            }
        ],
    )

    assert changed == [run["run_id"]]
    reconciled = read_workflow_run(
        project_dir=tmp_path, canvas_id="default", run_id=run["run_id"]
    )
    assert reconciled is not None
    assert reconciled["status"] == "completed"
    assert reconciled["resumable"] is False
    assert reconciled["actions"][0]["status"] == "completed"
    assert reconciled["actions"][0]["artifact_status"] == "valid"
    assert reconciled["metadata"]["last_canvas_result_reconciliation_at"]


def test_reconcile_completes_taskless_story_script_from_durable_canvas_result(
    tmp_path: Path,
) -> None:
    run = create_workflow_run(
        project_dir=tmp_path,
        project_id="project-a",
        canvas_id="default",
        actions=[{"node_id": "script-1", "action": "generate_story_script"}],
    )

    changed = reconcile_workflow_runs_with_canvas_results(
        project_dir=tmp_path,
        canvas_id="default",
        canvas_nodes=[
            {
                "id": "script-1",
                "type": "scriptNode",
                "data": {"scriptResult": {"rows": [{"narration": "Scene one"}]}},
            }
        ],
    )

    assert changed == [run["run_id"]]
    reconciled = read_workflow_run(
        project_dir=tmp_path, canvas_id="default", run_id=run["run_id"]
    )
    assert reconciled is not None
    assert reconciled["status"] == "completed"
    assert reconciled["actions"][0]["artifact_status"] == "valid"


def test_reconcile_keeps_task_backed_text_authoritative(tmp_path: Path) -> None:
    run = create_workflow_run(
        project_dir=tmp_path,
        project_id="project-a",
        canvas_id="default",
        actions=[{"node_id": "text-1", "action": "generate_text"}],
    )
    update_workflow_run(
        project_dir=tmp_path,
        canvas_id="default",
        run_id=run["run_id"],
        action_updates=[
            {
                "node_id": "text-1",
                "action": "generate_text",
                "status": "running",
                "task_key": "task:recipe_result:project:project-a:0:operation-1",
            }
        ],
    )

    changed = reconcile_workflow_runs_with_canvas_results(
        project_dir=tmp_path,
        canvas_id="default",
        canvas_nodes=[
            {
                "id": "text-1",
                "data": {
                    "content": "Canvas delivery is not task authority",
                    "workflowTextGenerated": True,
                },
            }
        ],
    )

    assert changed == []
    preserved = read_workflow_run(
        project_dir=tmp_path, canvas_id="default", run_id=run["run_id"]
    )
    assert preserved is not None
    assert preserved["status"] == "running"
    assert preserved["actions"][0]["status"] == "running"
    assert preserved["actions"][0].get("artifact_status") is None


@pytest.mark.parametrize(
    ("action", "node_data"),
    [
        (
            "generate_text",
            {"content": "User-authored text without a generation marker"},
        ),
        (
            "generate_image",
            {"imageUrl": "https://cdn.example.test/unverified.png"},
        ),
    ],
)
def test_reconcile_does_not_accept_unproven_canvas_results(
    tmp_path: Path,
    action: str,
    node_data: dict,
) -> None:
    run = create_workflow_run(
        project_dir=tmp_path,
        project_id="project-a",
        canvas_id="default",
        actions=[{"node_id": "node-1", "action": action}],
    )

    changed = reconcile_workflow_runs_with_canvas_results(
        project_dir=tmp_path,
        canvas_id="default",
        canvas_nodes=[{"id": "node-1", "data": node_data}],
    )

    assert changed == []
    preserved = read_workflow_run(
        project_dir=tmp_path, canvas_id="default", run_id=run["run_id"]
    )
    assert preserved is not None
    assert preserved["status"] == "running"
    assert preserved["actions"][0]["status"] == "pending"
    assert preserved["actions"][0].get("artifact_status") is None


def test_stale_running_workflow_is_marked_interrupted(tmp_path: Path) -> None:
    now = datetime(2026, 7, 22, 12, 0, tzinfo=timezone.utc)
    run = create_workflow_run(
        project_dir=tmp_path,
        project_id="project-a",
        canvas_id="default",
        actions=[{"node_id": "pending", "action": "generate_image"}],
    )
    old_timestamp = (now - timedelta(seconds=61)).isoformat().replace("+00:00", "Z")
    _set_run_timestamps(tmp_path, run["run_id"], updated_at=old_timestamp)

    interrupted = interrupt_stale_workflow_runs(
        project_dir=tmp_path,
        canvas_id="default",
        stale_after_seconds=60,
        now=now,
    )

    assert interrupted == [run["run_id"]]
    recovered = read_workflow_run(
        project_dir=tmp_path, canvas_id="default", run_id=run["run_id"]
    )
    assert recovered is not None
    assert recovered["status"] == "interrupted"
    assert recovered["metadata"]["interrupt_reason"] == "runner_heartbeat_expired"


def test_runner_lease_survives_background_timer_throttling(tmp_path: Path) -> None:
    run = create_workflow_run(
        project_dir=tmp_path,
        project_id="project-a",
        canvas_id="default",
        actions=[{"node_id": "video-1", "action": "generate_video"}],
        runner_id="runner-a",
    )
    last_heartbeat = datetime.fromisoformat(run["updated_at"].replace("Z", "+00:00"))

    # Background tabs fire the 15s heartbeat about once per minute (issue #730).
    assert (
        interrupt_stale_workflow_runs(
            project_dir=tmp_path,
            canvas_id="default",
            stale_after_seconds=60,
            now=last_heartbeat + timedelta(seconds=60),
        )
        == []
    )
    assert (
        interrupt_stale_workflow_runs(
            project_dir=tmp_path,
            canvas_id="default",
            stale_after_seconds=60,
            now=last_heartbeat + timedelta(seconds=181),
        )
        == [run["run_id"]]
    )


def test_cancelled_run_skips_unfinished_actions_without_runner_lease(
    tmp_path: Path,
) -> None:
    run = create_workflow_run(
        project_dir=tmp_path,
        project_id="project-a",
        canvas_id="default",
        actions=[
            {"node_id": "done", "action": "save"},
            {"node_id": "pending", "action": "generate_image"},
        ],
        runner_id="runner-one",
    )
    update_workflow_run(
        project_dir=tmp_path,
        canvas_id="default",
        run_id=run["run_id"],
        runner_id="runner-one",
        action_updates=[{"node_id": "done", "action": "save", "status": "completed"}],
    )

    cancelled = update_workflow_run(
        project_dir=tmp_path,
        canvas_id="default",
        run_id=run["run_id"],
        status="cancelled",
    )

    assert cancelled is not None
    assert cancelled["status"] == "cancelled"
    assert [item["status"] for item in cancelled["actions"]] == ["completed", "skipped"]
    assert cancelled["metadata"]["cancel_requested_at"]


def test_prune_workflow_runs_only_removes_old_non_resumable_records(
    tmp_path: Path,
) -> None:
    now = datetime(2026, 7, 27, 12, 0, tzinfo=timezone.utc)
    run_ids: dict[str, str] = {}
    for label, status in (
        ("completed", "completed"),
        ("cancelled", "cancelled"),
        ("failed", "failed"),
        ("interrupted", "interrupted"),
    ):
        run = create_workflow_run(
            project_dir=tmp_path,
            project_id="project-a",
            canvas_id="default",
            actions=[{"node_id": label, "action": "save"}],
        )
        update_workflow_run(
            project_dir=tmp_path,
            canvas_id="default",
            run_id=run["run_id"],
            status=status,
            action_updates=(
                [{"node_id": label, "action": "save", "status": "completed"}]
                if status == "completed"
                else None
            ),
        )
        old_timestamp = (now - timedelta(days=31)).isoformat().replace("+00:00", "Z")
        _set_run_timestamps(
            tmp_path,
            run["run_id"],
            updated_at=old_timestamp,
            completed_at=old_timestamp,
        )
        run_ids[label] = run["run_id"]

    deleted = prune_workflow_runs(
        project_dir=tmp_path,
        canvas_id="default",
        retention_days=30,
        now=now,
    )

    assert set(deleted) == {run_ids["completed"], run_ids["cancelled"]}
    remaining = {
        item["run_id"]
        for item in list_workflow_runs(project_dir=tmp_path, canvas_id="default")
    }
    assert run_ids["failed"] in remaining
    assert run_ids["interrupted"] in remaining


@pytest.mark.parametrize(
    ("actions", "message"),
    [([], "at least one action"), (["bad"], "must be an object")],
)
def test_workflow_run_rejects_invalid_actions(
    tmp_path: Path, actions: list, message: str
) -> None:
    with pytest.raises(ValueError, match=message):
        create_workflow_run(
            project_dir=tmp_path,
            project_id="project-a",
            canvas_id="default",
            actions=actions,
        )


def test_workflow_run_rejects_unknown_action_update(tmp_path: Path) -> None:
    run = create_workflow_run(
        project_dir=tmp_path,
        project_id="project-a",
        canvas_id="default",
        actions=[{"node_id": "one", "action": "generate_image"}],
    )

    with pytest.raises(ValueError, match="workflow action not found"):
        update_workflow_run(
            project_dir=tmp_path,
            canvas_id="default",
            run_id=run["run_id"],
            action_updates=[
                {"node_id": "other", "action": "generate_image", "status": "completed"}
            ],
        )


RUN_CLOCK = datetime(2026, 1, 1, tzinfo=timezone.utc)


def _create_owned_run(project_dir, *, canvas_id="default", **kwargs):
    return create_workflow_run(
        project_dir=project_dir,
        project_id="project-a",
        canvas_id=canvas_id,
        actions=[{"node_id": "text-1", "action": "generate_text"}],
        **kwargs,
    )


@pytest.mark.parametrize("owner_kind", ["server", "browser_legacy"])
def test_run_owner_is_fixed_at_creation(tmp_path, owner_kind):
    run = _create_owned_run(
        tmp_path, owner_kind=owner_kind,
        metadata={"owner_kind": "browser_legacy" if owner_kind == "server" else "server"},
    )
    assert run["owner_kind"] == owner_kind
    assert run["metadata"]["owner_kind"] == owner_kind
    assert read_workflow_run(
        project_dir=tmp_path, canvas_id="default", run_id=run["run_id"]
    )["owner_kind"] == owner_kind


def test_run_owner_defaults_to_browser_and_legacy_rows_read_as_browser(tmp_path):
    run = _create_owned_run(tmp_path, metadata={"owner_kind": "server"})
    assert run["owner_kind"] == "browser_legacy"
    assert run["metadata"]["owner_kind"] == "browser_legacy"
    with sqlite3.connect(workflow_runs_db_path(tmp_path)) as conn:
        conn.execute("UPDATE workflow_runs SET metadata_json = '{}' WHERE run_id = ?",
                     (run["run_id"],))
    legacy = read_workflow_run(
        project_dir=tmp_path, canvas_id="default", run_id=run["run_id"]
    )
    assert legacy["owner_kind"] == "browser_legacy"
    assert legacy["metadata"] == {}


def test_run_owner_rejects_invalid_kind(tmp_path):
    with pytest.raises(ValueError, match="owner_kind"):
        _create_owned_run(tmp_path, owner_kind="unknown")


@pytest.mark.parametrize("runner_id", ["", "old-runner"])
def test_running_server_run_blocks_creation_even_without_live_lease(tmp_path, runner_id):
    run = _create_owned_run(
        tmp_path, owner_kind="server", runner_id=runner_id, now=RUN_CLOCK,
        idempotency_key="server-request",
    )
    replay = _create_owned_run(
        tmp_path, idempotency_key="server-request", now=RUN_CLOCK + timedelta(days=1),
    )
    assert replay["run_id"] == run["run_id"]
    assert replay["owner_kind"] == "server"
    with pytest.raises(
        WorkflowRunLeaseConflict, match="^another workflow runner is active on this canvas$"
    ):
        _create_owned_run(tmp_path, now=RUN_CLOCK + timedelta(days=1))
    persisted = read_workflow_run(
        project_dir=tmp_path, canvas_id="default", run_id=run["run_id"]
    )
    assert persisted == replay
    assert persisted["status"] == "running"


def test_server_run_acquisition_renewal_and_repeated_takeover(tmp_path):
    from novelvideo.freezone.workflow_runs import acquire_server_workflow_run

    run = _create_owned_run(tmp_path, owner_kind="server", now=RUN_CLOCK)
    assert run["metadata"]["takeover_count"] == 0
    args = {"project_dir": tmp_path, "canvas_id": "default", "run_id": run["run_id"]}
    first = acquire_server_workflow_run(**args, runner_id="one", now=RUN_CLOCK)
    assert first["acquired"] is True
    assert first["took_over"] is False
    assert first["run"]["runner_id"] == "one"
    assert first["run"]["lease_expires_at"] == "2026-01-01T00:03:00Z"
    assert first["run"]["metadata"]["takeover_count"] == 0
    renewed = acquire_server_workflow_run(
        **args, runner_id="one", now=RUN_CLOCK + timedelta(seconds=60),
    )
    assert renewed["acquired"] is True
    assert renewed["took_over"] is False
    assert renewed["run"]["lease_expires_at"] == "2026-01-01T00:04:00Z"
    with pytest.raises(WorkflowRunLeaseConflict):
        acquire_server_workflow_run(
            **args, runner_id="two", now=RUN_CLOCK + timedelta(seconds=239),
        )
    second = acquire_server_workflow_run(
        **args, runner_id="two", now=RUN_CLOCK + timedelta(seconds=240),
    )
    assert second["acquired"] is True
    assert second["took_over"] is True
    assert second["run"]["runner_id"] == "two"
    assert second["run"]["lease_expires_at"] == "2026-01-01T00:07:00Z"
    assert second["run"]["metadata"]["takeover_count"] == 1
    assert second["run"]["metadata"]["last_takeover_at"] == "2026-01-01T00:04:00Z"
    third = acquire_server_workflow_run(
        **args, runner_id="three", now=RUN_CLOCK + timedelta(seconds=421), lease_seconds=60,
    )
    assert third["acquired"] is True
    assert third["took_over"] is True
    assert third["run"]["runner_id"] == "three"
    assert third["run"]["lease_expires_at"] == "2026-01-01T00:08:01Z"
    assert third["run"]["metadata"]["takeover_count"] == 2
    assert third["run"]["metadata"]["last_takeover_at"] == "2026-01-01T00:07:01Z"
    assert read_workflow_run(**args) == third["run"]


def test_server_acquisition_missing_browser_and_terminal_runs(tmp_path):
    from novelvideo.freezone.workflow_runs import (
        WorkflowRunOwnerConflict,
        acquire_server_workflow_run,
    )

    args = {"project_dir": tmp_path, "canvas_id": "default", "runner_id": "one",
            "now": RUN_CLOCK}
    assert acquire_server_workflow_run(**args, run_id="missing") is None
    browser = _create_owned_run(tmp_path)
    with pytest.raises(WorkflowRunOwnerConflict):
        acquire_server_workflow_run(**args, run_id=browser["run_id"])
    server = create_workflow_run(
        project_dir=tmp_path, project_id="project-a", canvas_id="terminal",
        actions=[{"node_id": "one", "action": "save"}], owner_kind="server", now=RUN_CLOCK,
    )
    completed = update_workflow_run(
        project_dir=tmp_path, canvas_id="terminal", run_id=server["run_id"],
        owner_kind="server", status="completed", now=RUN_CLOCK,
        action_updates=[{"node_id": "one", "action": "save", "status": "completed"}],
    )
    assert completed["status"] == "completed"
    result = acquire_server_workflow_run(
        **{**args, "canvas_id": "terminal"}, run_id=server["run_id"],
    )
    assert result == {"run": completed, "acquired": False, "took_over": False}


@pytest.mark.parametrize("owner_kind", ["server", "browser_legacy"])
def test_run_updates_reject_other_executor_except_cancellation(tmp_path, owner_kind):
    from novelvideo.freezone.workflow_runs import WorkflowRunOwnerConflict

    run = _create_owned_run(tmp_path, owner_kind=owner_kind)
    caller = {} if owner_kind == "server" else {"owner_kind": "server"}
    args = {"project_dir": tmp_path, "canvas_id": "default", "run_id": run["run_id"], **caller}
    updates = [{"node_id": "text-1", "action": "generate_text", "status": "running"}]
    with pytest.raises(
        WorkflowRunOwnerConflict, match="^workflow run is driven by another executor$"
    ):
        update_workflow_run(**args, action_updates=updates)
    with pytest.raises(WorkflowRunOwnerConflict):
        update_workflow_run(**args, status="cancelled", action_updates=updates)
    cancelled = update_workflow_run(**args, status="cancelled", now=RUN_CLOCK)
    assert cancelled["status"] == "cancelled"
    assert cancelled["owner_kind"] == owner_kind
    assert cancelled["metadata"]["owner_kind"] == owner_kind
    assert cancelled["actions"][0]["status"] == "skipped"


@pytest.mark.parametrize("owner_kind", ["server", "browser_legacy"])
def test_matching_runner_renews_with_injected_clock(tmp_path, owner_kind):
    run = _create_owned_run(tmp_path, owner_kind=owner_kind, runner_id="one", now=RUN_CLOCK)
    args = {"project_dir": tmp_path, "canvas_id": "default", "run_id": run["run_id"],
            "owner_kind": owner_kind, "runner_id": "one"}
    renewed = update_workflow_run(**args, now=RUN_CLOCK + timedelta(seconds=60))
    assert renewed["lease_expires_at"] == "2026-01-01T00:04:00Z"
    assert renewed["updated_at"] == "2026-01-01T00:01:00Z"
    with pytest.raises(WorkflowRunLeaseConflict):
        update_workflow_run(**args, now=RUN_CLOCK + timedelta(seconds=240))


def test_stale_cleanup_preserves_expired_server_runs(tmp_path):
    server = _create_owned_run(
        tmp_path, owner_kind="server", runner_id="old", now=RUN_CLOCK,
    )
    browser = _create_owned_run(
        tmp_path, canvas_id="browser", runner_id="old", now=RUN_CLOCK,
    )
    server = read_workflow_run(
        project_dir=tmp_path, canvas_id="default", run_id=server["run_id"]
    )
    future = RUN_CLOCK + timedelta(days=30)
    assert interrupt_stale_workflow_runs(
        project_dir=tmp_path, canvas_id="default", stale_after_seconds=60, now=future,
    ) == []
    assert interrupt_stale_workflow_runs(
        project_dir=tmp_path, canvas_id="browser", stale_after_seconds=60, now=future,
    ) == [browser["run_id"]]
    assert read_workflow_run(
        project_dir=tmp_path, canvas_id="default", run_id=server["run_id"]
    ) == server
    assert read_workflow_run(
        project_dir=tmp_path, canvas_id="browser", run_id=browser["run_id"]
    )["status"] == "interrupted"


@pytest.mark.parametrize("reconciler", ["nodes", "results", "tasks"])
@pytest.mark.parametrize("owner_kind", ["server", "browser_legacy"])
def test_reconcilers_only_modify_browser_runs(tmp_path, reconciler, owner_kind):
    run = _create_owned_run(tmp_path, owner_kind=owner_kind, now=RUN_CLOCK)
    args = {"project_dir": tmp_path, "canvas_id": "default"}
    run = read_workflow_run(**args, run_id=run["run_id"])
    if reconciler == "nodes":
        changed = reconcile_workflow_runs_with_canvas_nodes(**args, existing_node_ids=set())
        expected_status = "cancelled"
    elif reconciler == "results":
        changed = reconcile_workflow_runs_with_canvas_results(
            **args, canvas_nodes=[{"id": "text-1", "data": {
                "content": "Durable text", "workflowTextGenerated": True,
            }}],
        )
        expected_status = "completed"
    else:
        run = update_workflow_run(
            **args, run_id=run["run_id"], owner_kind=owner_kind, now=RUN_CLOCK,
            action_updates=[{"node_id": "text-1", "action": "generate_text",
                             "status": "running", "task_key": "task-one"}],
        )
        changed = reconcile_workflow_runs_with_tasks(
            **args, tasks_by_key={"task-one": {"status": "failed", "error": "invalid request"}},
        )
        expected_status = "failed"
    persisted = read_workflow_run(**args, run_id=run["run_id"])
    if owner_kind == "server":
        assert changed == []
        assert persisted == run
        assert persisted["status"] == "running"
    else:
        assert changed == [run["run_id"]]
        assert persisted["status"] == expected_status


def test_list_server_runs_needing_driver_filters_owner_status_and_lease(tmp_path):
    from novelvideo.freezone.workflow_runs import list_server_workflow_runs_needing_driver

    unowned = _create_owned_run(tmp_path, owner_kind="server", now=RUN_CLOCK)
    expired = _create_owned_run(
        tmp_path, canvas_id="expired", owner_kind="server", runner_id="old", now=RUN_CLOCK,
    )
    _create_owned_run(
        tmp_path, canvas_id="live", owner_kind="server", runner_id="live",
        now=RUN_CLOCK + timedelta(seconds=60),
    )
    _create_owned_run(tmp_path, canvas_id="browser", now=RUN_CLOCK)
    terminal = _create_owned_run(
        tmp_path, canvas_id="terminal", owner_kind="server", now=RUN_CLOCK,
    )
    update_workflow_run(
        project_dir=tmp_path, canvas_id="terminal", run_id=terminal["run_id"],
        owner_kind="server", status="cancelled", now=RUN_CLOCK,
    )
    listed = list_server_workflow_runs_needing_driver(
        project_dir=tmp_path, now=RUN_CLOCK + timedelta(seconds=180),
    )
    assert sorted(run["canvas_id"] for run in listed) == ["default", "expired"]
    assert {run["run_id"] for run in listed} == {unowned["run_id"], expired["run_id"]}
    assert [run["status"] for run in listed] == ["running", "running"]
