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
        retryable = diagnostics["retryable"] and not ambiguous
        if category == "input_missing":
            next_action = "fix_input_before_retry"
        elif ambiguous:
            next_action = "reconcile_before_retry"
        elif retryable:
            next_action = "retry_after_confirmation"
        elif action.get("status") == "blocked":
            next_action = "resolve_dependency"
        elif category == "invalid_request":
            next_action = "correct_parameters"
        elif category in {"authentication", "quota_exhausted"}:
            next_action = "resolve_access_or_quota"
        else:
            next_action = "review_failure"
        problems.append(
            {
                "node_id": action.get("node_id"),
                "action": action.get("action"),
                "error_category": category,
                "message": diagnostics["user_error"],
                "retryable": retryable,
                "automatic_retry": False,
                "next_action": next_action,
                **({
                    "agent_instruction": (
                        "Tell the user this reason. Do not ask the user to confirm another paid "
                        "run for this node, and do not change the canvas to try a different "
                        "approach, until this cause is fixed."
                    ),
                } if not retryable else {}),
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
