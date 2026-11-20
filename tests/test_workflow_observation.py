import json

import pytest

from novelvideo.freezone.workflow_observation import summarize_workflow_run
from novelvideo.freezone.workflow_runs import classify_workflow_error
from test_freezone_workflow_runs import MISSING_INPUT_ERROR

FIX_CAUSE_INSTRUCTION = (
    "Tell the user this reason. Do not ask the user to confirm another paid run for this "
    "node, and do not change the canvas to try a different approach, until this cause is fixed."
)


@pytest.mark.parametrize(
    "error,next_action,retryable",
    [
        ("HTTP 503 unavailable", "retry_after_confirmation", True),
        ("HTTP 504 timeout", "reconcile_before_retry", False),
        ("HTTP 401 invalid token", "resolve_access_or_quota", False),
        ("InvalidParameter model", "correct_parameters", False),
    ],
)
def test_recovery_does_not_automatically_repeat_generation(
    error, next_action, retryable
):
    result = summarize_workflow_run(
        {
            "run_id": "run_1",
            "status": "failed",
            "actions": [
                {
                    "node_id": "image",
                    "action": "generate_image",
                    "status": "failed",
                    "error": error,
                },
            ],
        }
    )
    problem = result["problems"][0]
    assert problem["next_action"] == next_action
    assert problem["retryable"] is retryable
    assert problem["automatic_retry"] is False
    assert result["terminal"] is True
    if retryable:
        assert "agent_instruction" not in problem
    else:
        assert problem["agent_instruction"] == FIX_CAUSE_INSTRUCTION


def test_progress_token_ignores_heartbeats_and_sensitive_provider_error_text():
    run = {
        "run_id": "run_1",
        "status": "running",
        "actions": [
            {"node_id": "image", "status": "failed", "error": "HTTP 503 secret=hidden"},
        ],
    }
    first = summarize_workflow_run(run)
    run["updated_at"] = "later"
    assert (
        summarize_workflow_run(run)["observation_token"] == first["observation_token"]
    )
    assert "hidden" not in json.dumps(first)
    run["actions"][0]["status"] = "running"
    assert (
        summarize_workflow_run(run)["observation_token"] != first["observation_token"]
    )


@pytest.mark.parametrize(
    "message", ["request id: req401abc", "job_503_failed", "image_429_size"]
)
def test_numeric_identifiers_are_not_http_statuses(message):
    assert classify_workflow_error(message) == ("execution", False)


def test_missing_input_problem_explains_recovery_without_changing_summary_shape():
    summary = summarize_workflow_run({
        "run_id": "run_1", "status": "failed", "actions": [
            {"node_id": "video", "action": "generate_video", "status": "failed",
             "error": MISSING_INPUT_ERROR},
            {"node_id": "image", "action": "generate_image", "status": "failed",
             "error": "HTTP 503 upstream unavailable"},
        ],
    })
    assert summary.keys() == {
        "ok", "status", "run_id", "run_status", "terminal", "counts", "total_count",
        "progress", "problems", "observation_token", "next_action", "automatic_retry",
    }
    missing, transient = summary["problems"]
    assert transient["retryable"] is True
    assert "agent_instruction" not in transient
    assert missing["next_action"] == "fix_input_before_retry"
    assert missing["retryable"] is False
    assert missing["agent_instruction"] == FIX_CAUSE_INSTRUCTION


@pytest.mark.parametrize(
    "error,signal,category,message",
    [
        (
            "HTTP 403: this parameter value is restricted",
            {"upstream_status": 403},
            "upstream_rejected",
            "上游服务拒绝了本次请求（HTTP 403）。",
        ),
        (
            "could not connect to database: too many clients",
            {"failure_kind": "server_fault", "failure_exception": "OperationalError"},
            "server_fault",
            "服务端处理本次生成时发生内部错误；可稍后重试，持续出现请联系管理员或部署方。",
        ),
    ],
)
def test_summary_matches_stored_failure_without_task_metadata(error, signal, category, message):
    action = {
        "node_id": "image", "action": "generate_image", "status": "failed", "error": error,
        "failure_signal": signal, "error_category": category, "user_error": message,
    }
    summary = summarize_workflow_run({"run_id": "run_1", "status": "failed", "actions": [action]})
    (problem,) = summary["problems"]
    assert problem["error_category"] == action["error_category"]
    assert problem["message"] == action["user_error"]
    assert problem["fixable_by"] == "operator"
    assert problem["retryable"] is False


def test_summary_merges_stored_signal_with_task_metadata():
    action = {
        "node_id": "image", "action": "generate_image", "status": "failed",
        "error": "request refused", "task_key": "task:image",
        "failure_signal": {"upstream_status": 403, "failure_exception": "HTTPStatusError"},
    }
    summary = summarize_workflow_run(
        {"run_id": "run_1", "status": "failed", "actions": [action]},
        tasks_by_key={"task:image": {"metadata": {"upstream_status": 429}}},
    )
    (problem,) = summary["problems"]
    assert problem["error_category"] == "transient_upstream"
    assert problem["diagnostics"]["upstream_status"] == 429
    assert problem["diagnostics"]["exception"] == "HTTPStatusError"
