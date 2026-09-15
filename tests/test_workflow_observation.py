import json

import pytest

from novelvideo.freezone.workflow_observation import summarize_workflow_run
from novelvideo.freezone.workflow_runs import classify_workflow_error


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
