from __future__ import annotations

import sqlite3
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from novelvideo.freezone.workflow_runs import (
    WorkflowRunLeaseConflict,
    classify_workflow_error,
    create_workflow_run,
    interrupt_stale_workflow_runs,
    list_workflow_runs,
    prune_workflow_runs,
    read_workflow_run,
    reconcile_workflow_runs_with_canvas_nodes,
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


def test_workflow_run_tracks_actions_and_completion(tmp_path: Path) -> None:
    run = create_workflow_run(
        project_dir=tmp_path,
        project_id="project-a",
        canvas_id="default",
        actions=[
            {"node_id": "image-1", "action": "generate_image"},
            {"node_id": "video-1", "action": "generate_video"},
        ],
        actor_id="alice",
    )

    updated = update_workflow_run(
        project_dir=tmp_path,
        canvas_id="default",
        run_id=run["run_id"],
        action_updates=[
            {"node_id": "image-1", "action": "generate_image", "status": "completed"},
            {"node_id": "video-1", "action": "generate_video", "status": "blocked"},
        ],
        status="failed",
    )

    assert updated is not None
    assert updated["status"] == "failed"
    assert updated["resumable"] is True
    assert updated["completed_at"]
    assert [item["status"] for item in updated["actions"]] == ["completed", "blocked"]
    assert read_workflow_run(
        project_dir=tmp_path, canvas_id="default", run_id=run["run_id"]
    ) == updated
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

    with pytest.raises(WorkflowRunLeaseConflict, match="another runner"):
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


@pytest.mark.parametrize(
    ("error", "category", "retryable"),
    [
        ("HTTP 503 upstream unavailable", "transient_upstream", True),
        ("read ECONNRESET", "transient_upstream", True),
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

    completed = update_workflow_run(
        project_dir=tmp_path,
        canvas_id="default",
        run_id=run["run_id"],
        action_updates=[
            {
                "node_id": "one",
                "action": "generate_audio",
                "status": "completed",
            }
        ],
    )

    assert completed is not None
    completed_action = completed["actions"][0]
    assert completed_action["error"] is None
    assert "error_category" not in completed_action
    assert "error_fingerprint" not in completed_action
    assert "user_error" not in completed_action


def test_task_reconciliation_completes_run_with_existing_artifact(tmp_path: Path) -> None:
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
                "status": "running",
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
    assert reconcile_workflow_runs_with_tasks(
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
    ) == []


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
        actions=[{"node_id": "one", "action": "generate_image"}],
    )
    update_workflow_run(
        project_dir=tmp_path,
        canvas_id="default",
        run_id=run["run_id"],
        status=terminal_status,
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


def test_new_workflow_run_supersedes_disjoint_active_run_on_same_canvas(tmp_path: Path) -> None:
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


def test_reconcile_cancels_run_after_all_unfinished_nodes_are_deleted(tmp_path: Path) -> None:
    run = create_workflow_run(
        project_dir=tmp_path,
        project_id="project-a",
        canvas_id="default",
        actions=[
            {"node_id": "completed", "action": "generate_text"},
            {"node_id": "pending", "action": "generate_image"},
        ],
    )
    update_workflow_run(
        project_dir=tmp_path,
        canvas_id="default",
        run_id=run["run_id"],
        action_updates=[
            {"node_id": "completed", "action": "generate_text", "status": "completed"}
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


def test_reconcile_keeps_run_when_an_unfinished_node_still_exists(tmp_path: Path) -> None:
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


def test_cancelled_run_skips_unfinished_actions_without_runner_lease(
    tmp_path: Path,
) -> None:
    run = create_workflow_run(
        project_dir=tmp_path,
        project_id="project-a",
        canvas_id="default",
        actions=[
            {"node_id": "done", "action": "generate_text"},
            {"node_id": "pending", "action": "generate_image"},
        ],
        runner_id="runner-one",
    )
    update_workflow_run(
        project_dir=tmp_path,
        canvas_id="default",
        run_id=run["run_id"],
        runner_id="runner-one",
        action_updates=[
            {"node_id": "done", "action": "generate_text", "status": "completed"}
        ],
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
            actions=[{"node_id": label, "action": "generate_image"}],
        )
        update_workflow_run(
            project_dir=tmp_path,
            canvas_id="default",
            run_id=run["run_id"],
            status=status,
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
