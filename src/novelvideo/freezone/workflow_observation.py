"""Compact workflow progress and conservative recovery decisions, without execution authority."""

import hashlib
import json
import re
from collections import Counter
from typing import Any

from novelvideo.freezone.workflow_runs import workflow_error_diagnostics
from novelvideo.shared.failure_signals import CONFIGURATION
from novelvideo.utils.error_redaction import redact_error_detail

TERMINAL_STATES = {"completed", "failed", "cancelled", "interrupted"}

_TRANSIENT_MESSAGE = "上游模型服务暂时不可用，系统可稍后重试。"
_TEXT_STATUS_CATEGORIES = frozenset({"authentication", "transient_upstream"})
_FIXABLE_BY = {
    "input_missing": "user",
    "invalid_request": "user",
    "content_policy": "user",
    "model_unavailable": "user",
    "artifact_missing": "user",
    "attempt_ended": "user",
    "transient_upstream": "retry_later",
    "authentication": "operator",
    "quota_exhausted": "operator",
    CONFIGURATION: "operator",
}


def _diagnostic_code(value: Any) -> str | None:
    if isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9_.:-]{1,80}", value):
        return value
    return None


def summarize_workflow_run(
    run: dict[str, Any], *, tasks_by_key: dict[str, dict[str, Any]] | None = None
) -> dict[str, Any]:
    actions = run.get("actions") or []
    counts = Counter(str(action.get("status") or "pending") for action in actions)
    problems = []
    dependency_problems = []
    non_blocked_owners: set[str] = set()
    for action in actions:
        status = action.get("status")
        if status not in {"failed", "blocked"}:
            continue
        task_key = action.get("task_key")
        task = (tasks_by_key or {}).get(task_key) or {}
        signal = task.get("metadata")
        if not isinstance(signal, dict):
            signal = {}
        upstream_status = signal.get("upstream_status")
        if type(upstream_status) is not int:
            upstream_status = None
        error = action.get("error")
        diagnostics = workflow_error_diagnostics(error)
        category = diagnostics["error_category"]
        message = diagnostics["user_error"]
        retryable = diagnostics["retryable"]
        # A transient transport error does not prove the provider rejected the request.
        ambiguous = any(
            marker in str(error or "").lower()
            for marker in (
                "timeout",
                "timed out",
                "econnreset",
                "connection reset",
                "504",
            )
        )
        generic_category = category in {"execution", "unknown"}
        if generic_category and status == "blocked":
            category = "dependency_blocked"
            message = "上游节点未成功完成，本节点未执行；请先处理上游节点的问题。"
            retryable = False
        elif generic_category and signal.get("failure_kind") == CONFIGURATION:
            category = CONFIGURATION
            message = (
                "服务端配置或部署问题导致生成失败，不是节点输入的问题；"
                "重试或修改画布都无法解决，需要管理员或部署方处理。"
            )
            retryable = False
        elif (
            (generic_category or category in _TEXT_STATUS_CATEGORIES)
            and upstream_status is not None
            and 400 <= upstream_status < 600
        ):
            ambiguous = ambiguous or upstream_status in {408, 504}
            if upstream_status in {408, 429} or upstream_status >= 500:
                category, message, retryable = "transient_upstream", _TRANSIENT_MESSAGE, True
            else:
                category = "upstream_rejected"
                message = f"上游服务拒绝了本次请求（HTTP {upstream_status}）。"
                retryable = False
        elif category == "execution":
            message = "生成失败，原因未知。原始错误见 detail，可凭 diagnostics 中的编号排查。"
        retryable = retryable and not ambiguous
        if category == "input_missing":
            next_action = "fix_input_before_retry"
        elif category == CONFIGURATION:
            next_action = "contact_operator"
        elif ambiguous:
            next_action = "reconcile_before_retry"
        elif retryable:
            next_action = "retry_after_confirmation"
        elif status == "blocked":
            next_action = "resolve_dependency"
        elif category == "invalid_request":
            next_action = "correct_parameters"
        elif category in {"authentication", "quota_exhausted"}:
            next_action = "resolve_access_or_quota"
        else:
            next_action = "review_failure"
        fixable_by = _FIXABLE_BY.get(category, "unknown")
        if category == "upstream_rejected" and upstream_status in {401, 403}:
            fixable_by = "operator"
        detail = redact_error_detail(task.get("error") or error or "")
        identifiers = {
            "run_id": run["run_id"],
            "task_key": task_key,
            "job_id": action.get("job_id"),
            "request_id": diagnostics["error_request_id"],
            "error_code": _diagnostic_code(signal.get("error_code")),
            "upstream_status": upstream_status,
            "exception": _diagnostic_code(signal.get("failure_exception")),
        }
        problems.append(
            {
                "node_id": action.get("node_id"),
                "action": action.get("action"),
                "error_category": category,
                "message": message,
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
                "fixable_by": fixable_by,
                **({"detail": detail} if detail else {}),
                "diagnostics": {
                    key: value for key, value in identifiers.items()
                    if value is not None and value != ""
                },
            }
        )
        if status != "blocked":
            non_blocked_owners.add(fixable_by)
        elif category == "dependency_blocked":
            dependency_problems.append(problems[-1])
    if len(non_blocked_owners) == 1:
        owner = non_blocked_owners.pop()
        for problem in dependency_problems:
            problem["fixable_by"] = owner
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
