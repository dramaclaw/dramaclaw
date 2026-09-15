"""Compact workflow progress and conservative recovery decisions, without execution authority."""

import hashlib
import json
from collections import Counter
from typing import Any

from novelvideo.freezone.workflow_runs import workflow_error_diagnostics

TERMINAL_STATES = {"completed", "failed", "cancelled", "interrupted"}


def summarize_workflow_run(run: dict[str, Any]) -> dict[str, Any]:
    actions = run.get("actions") or []
    counts = Counter(str(action.get("status") or "pending") for action in actions)
    problems = []
    for action in actions:
        if action.get("status") not in {"failed", "blocked"}:
            continue
        diagnostics = workflow_error_diagnostics(action.get("error"))
        category = diagnostics["error_category"]
        # A transient transport error does not prove the provider rejected the request.
        ambiguous = any(
            marker in str(action.get("error") or "").lower()
            for marker in (
                "timeout",
                "timed out",
                "econnreset",
                "connection reset",
                "504",
            )
        )
        next_action = (
            "reconcile_before_retry"
            if ambiguous
            else (
                "retry_after_confirmation"
                if diagnostics["retryable"]
                else (
                    "resolve_dependency"
                    if action.get("status") == "blocked"
                    else (
                        "correct_parameters"
                        if category == "invalid_request"
                        else (
                            "resolve_access_or_quota"
                            if category in {"authentication", "quota_exhausted"}
                            else "review_failure"
                        )
                    )
                )
            )
        )
        problems.append(
            {
                "node_id": action.get("node_id"),
                "action": action.get("action"),
                "error_category": category,
                "message": diagnostics["user_error"],
                "retryable": diagnostics["retryable"] and not ambiguous,
                "automatic_retry": False,
                "next_action": next_action,
            }
        )
    state = str(run.get("status") or "unknown")
    terminal = state in TERMINAL_STATES
    progress = [
        {
            "node_id": action.get("node_id"),
            "action": action.get("action"),
            "status": action.get("status"),
            "phase": action.get("phase"),
            "retry_count": action.get("retry_count", 0),
            "artifact_status": action.get("artifact_status"),
        }
        for action in actions
    ]
    token = hashlib.sha256(
        json.dumps(
            [state, progress, problems], sort_keys=True, ensure_ascii=False
        ).encode()
    ).hexdigest()[:24]
    return {
        "ok": True,
        "status": "workflow_run_observed",
        "run_id": run["run_id"],
        "run_status": state,
        "terminal": terminal,
        "counts": dict(counts),
        "total_count": len(actions),
        "progress": progress,
        "problems": problems,
        "observation_token": token,
        "next_action": (
            "inspect_results"
            if state == "completed"
            else "review_recovery" if terminal else "observe_same_run"
        ),
        "automatic_retry": False,
    }
