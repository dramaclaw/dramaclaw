#!/usr/bin/env python3
"""Validate the security-critical shape of the DramaClaw PR Gate workflow."""

from __future__ import annotations

import argparse
import re
import sys
import tomllib
from collections import deque
from pathlib import Path
from typing import Any

from ci_yaml import CIYamlError, load_yaml, require_mapping

PR_GATE_PATH = Path(".github/workflows/pr-gate.yml")
CHECKOUT_ACTION = (
    "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1"  # v7.0.1
)
SETUP_UV_ACTION = (
    "astral-sh/setup-uv@fac544c07dec837d0ccb6301d7b5580bf5edae39"  # v8.2.0
)
SETUP_NODE_ACTION = (
    "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020"  # v7.0.0
)
SETUP_PNPM_ACTION = (
    "pnpm/action-setup@0ebf47130e4866e96fce0953f49152a61190b271"  # v6.0.9
)
DEPENDENCY_REVIEW_ACTION = (
    "actions/dependency-review-action@"
    "a1d282b36b6f3519aa1f3fc636f609c47dddb294"  # v5.0.0
)
DEPENDENCY_REVIEW_CONFIG = "./.github/dependency-review-config.yml"
GATE_NAME = "dramaclaw-pr-gate"
UV_VERSION = "0.11.31"
UV_REQUIRED_VERSION = f"=={UV_VERSION}"
UV_UNIX_INSTALL_URL = f"https://astral.sh/uv/{UV_VERSION}/install.sh"
UV_WINDOWS_INSTALL_URL = f"https://astral.sh/uv/{UV_VERSION}/install.ps1"
UV_DOCUMENT_REQUIREMENTS = {
    Path("README.md"): (UV_UNIX_INSTALL_URL,),
    Path("readme/README_zh.md"): (UV_UNIX_INSTALL_URL,),
    Path("CONTRIBUTING.md"): (UV_UNIX_INSTALL_URL, UV_WINDOWS_INSTALL_URL),
    Path("docs/en/getting-started/installation.md"): (
        UV_UNIX_INSTALL_URL,
        UV_WINDOWS_INSTALL_URL,
    ),
    Path("docs/zh/getting-started/installation.md"): (
        UV_UNIX_INSTALL_URL,
        UV_WINDOWS_INSTALL_URL,
    ),
    Path("docs/en/guides/troubleshooting.md"): (UV_UNIX_INSTALL_URL,),
    Path("docs/zh/guides/troubleshooting.md"): (UV_UNIX_INSTALL_URL,),
}
FORBIDDEN_FLOATING_UV_INSTALLS = {
    "brew install uv",
    "winget install astral-sh.uv",
    "https://astral.sh/uv/install.sh",
    "https://astral.sh/uv/install.ps1",
}
GITLEAKS_VERSION = "8.30.1"
GITLEAKS_SHA256 = (
    "551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb"
)
DEPENDENCY_REVIEW_ASSERT_RUN = """\
set -euo pipefail
if [ "$APPLICABLE" = "true" ]; then
  [ "$CHECKOUT_OUTCOME" = "success" ]
  [ "$REVIEW_OUTCOME" = "success" ]
  [ "$NOOP_OUTCOME" = "skipped" ]
elif [ "$APPLICABLE" = "false" ]; then
  [ "$CHECKOUT_OUTCOME" = "skipped" ]
  [ "$REVIEW_OUTCOME" = "skipped" ]
  [ "$NOOP_OUTCOME" = "success" ]
else
  echo "::error::invalid Dependency Review applicability: $APPLICABLE"
  exit 1
fi
echo "verified=true" >> "$GITHUB_OUTPUT"
"""
GITLEAKS_INSTALL_RUN = """\
set -euo pipefail
archive="${RUNNER_TEMP}/gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz"
install_dir="${RUNNER_TEMP}/gitleaks-bin"
mkdir -p "$install_dir"
curl --fail --show-error --silent --location \\
  --output "$archive" \\
  "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz"
printf '%s  %s\\n' "$GITLEAKS_ARCHIVE_SHA256" "$archive" |
  sha256sum --check -
tar -xzf "$archive" -C "$install_dir" gitleaks
"$install_dir/gitleaks" version
echo "$install_dir" >> "$GITHUB_PATH"
"""
PR_POLICY_ASSERT_RUN = """\
set -euo pipefail
if [ "$APPLICABLE" = "true" ]; then
  [ "$CHECKOUT_OUTCOME" = "success" ]
  [ "$DCO_OUTCOME" = "success" ]
  [ "$NOOP_OUTCOME" = "skipped" ]
elif [ "$APPLICABLE" = "false" ]; then
  [ "$CHECKOUT_OUTCOME" = "skipped" ]
  [ "$DCO_OUTCOME" = "skipped" ]
  [ "$NOOP_OUTCOME" = "success" ]
else
  echo "::error::invalid DCO applicability: $APPLICABLE"
  exit 1
fi
echo "verified=true" >> "$GITHUB_OUTPUT"
"""
GATE_VERIFY_RUN = """\
set -euo pipefail
printf '%s\\n' "$NEEDS_JSON" | jq .
printf '%s\\n' "$NEEDS_JSON" |
  jq -e '
    all(.[]; .result == "success") and
    ."dependency-review".outputs.verified == "true" and
    ."pr-policy".outputs.verified == "true"
  '
"""
REQUIRED_GATE_NEEDS = {
    "backend",
    "ce-policy",
    "dependency-review",
    "frontend",
    "secret-scan",
    "pr-policy",
}
PINNED_EXTERNAL_USE = re.compile(r"^[^@\s]+@[0-9a-f]{40}$")
GITHUB_EXPRESSION = re.compile(r"\$\{\{(?P<body>.*?)\}\}", re.DOTALL)
SECRETS_CONTEXT = re.compile(
    r"(?<![A-Za-z0-9_])secrets(?![A-Za-z0-9_])",
    re.IGNORECASE,
)


class WorkflowPolicyError(ValueError):
    """Raised when the Gate workflow violates the approved baseline."""


def _label(path: Path, root: Path) -> str:
    try:
        return str(path.relative_to(root))
    except ValueError:
        return str(path)


def _normalise_command(command: Any, label: str) -> str:
    if not isinstance(command, str):
        raise WorkflowPolicyError(f"{label} must be a string")
    return " ".join(command.split())


def _require_list(value: Any, label: str) -> list[Any]:
    if not isinstance(value, list):
        raise WorkflowPolicyError(f"{label} must be a list")
    return value


def _check_no_input_env(raw_env: Any, label: str) -> None:
    if raw_env is None:
        return
    env = require_mapping(raw_env, label)
    forbidden = sorted(
        str(key) for key in env if str(key).upper().startswith("INPUT_")
    )
    if forbidden:
        raise WorkflowPolicyError(
            f"{label} must not inject GitHub Action INPUT_* variables: {forbidden!r}"
        )


def _check_no_failure_bypass(node: dict[Any, Any], label: str) -> None:
    if "continue-on-error" in node:
        raise WorkflowPolicyError(f"{label} must not set continue-on-error")
    run = node.get("run")
    if isinstance(run, str) and "|| true" in run:
        raise WorkflowPolicyError(f"{label} must not hide failures with '|| true'")
    if "shell" in node:
        raise WorkflowPolicyError(f"{label} must not override the runner shell")


def _contains_secret_reference(value: Any) -> bool:
    if isinstance(value, str):
        return any(
            SECRETS_CONTEXT.search(match.group("body"))
            for match in GITHUB_EXPRESSION.finditer(value)
        )
    if isinstance(value, dict):
        return any(
            _contains_secret_reference(key) or _contains_secret_reference(item)
            for key, item in value.items()
        )
    if isinstance(value, list):
        return any(_contains_secret_reference(item) for item in value)
    return False


def _resolve_local_use(root: Path, raw_use: str, expected_kind: str) -> Path:
    if "@" in raw_use:
        raise WorkflowPolicyError(
            f"local uses reference must not contain a ref: {raw_use!r}"
        )
    target = (root / raw_use.removeprefix("./")).resolve()
    root_resolved = root.resolve()
    if not target.is_relative_to(root_resolved):
        raise WorkflowPolicyError(f"local uses reference escapes repository: {raw_use!r}")

    if expected_kind == "action" and target.is_dir():
        candidates = [
            candidate
            for candidate in (target / "action.yml", target / "action.yaml")
            if candidate.is_file()
        ]
        if len(candidates) != 1:
            raise WorkflowPolicyError(
                f"local action {raw_use!r} must contain exactly one action.yml/action.yaml"
            )
        target = candidates[0]

    if not target.is_file():
        raise WorkflowPolicyError(f"local uses target does not exist: {raw_use!r}")
    return target


def _check_use(
    root: Path,
    raw_use: Any,
    expected_local_kind: str,
) -> tuple[Path, str] | None:
    if not isinstance(raw_use, str):
        raise WorkflowPolicyError("uses must be a string")
    if raw_use.startswith("./"):
        return _resolve_local_use(root, raw_use, expected_local_kind), expected_local_kind

    lowered = raw_use.lower()
    if lowered.startswith("gitleaks/gitleaks-action@"):
        raise WorkflowPolicyError("gitleaks-action is forbidden; use the pinned binary")
    if not PINNED_EXTERNAL_USE.fullmatch(raw_use):
        raise WorkflowPolicyError(
            f"external uses reference must end in a 40-character commit SHA: {raw_use!r}"
        )
    return None


def _check_runner(raw_runner: Any, label: str) -> None:
    if raw_runner != "ubuntu-24.04":
        raise WorkflowPolicyError(
            f"{label} must use the scalar runner 'ubuntu-24.04', got {raw_runner!r}"
        )


def _inspect_steps(
    root: Path,
    path: Path,
    raw_steps: Any,
    queue: deque[tuple[Path, str]],
    label: str,
) -> list[dict[Any, Any]]:
    steps = _require_list(raw_steps, f"{label}.steps")
    parsed_steps: list[dict[Any, Any]] = []
    for index, raw_step in enumerate(steps):
        step_label = f"{label}.steps[{index}]"
        step = require_mapping(raw_step, step_label)
        _check_no_input_env(step.get("env"), f"{step_label}.env")
        _check_no_failure_bypass(step, step_label)
        if "uses" in step:
            local = _check_use(root, step["uses"], "action")
            if local is not None:
                queue.append(local)
        parsed_steps.append(step)
    return parsed_steps


def _load_reachable_documents(
    root: Path,
) -> tuple[dict[Path, dict[Any, Any]], dict[Path, dict[Any, Any]]]:
    entry = (root / PR_GATE_PATH).resolve()
    queue: deque[tuple[Path, str]] = deque([(entry, "workflow")])
    seen: dict[Path, str] = {}
    workflows: dict[Path, dict[Any, Any]] = {}
    actions: dict[Path, dict[Any, Any]] = {}

    while queue:
        path, expected_kind = queue.popleft()
        previous_kind = seen.get(path)
        if previous_kind is not None:
            if previous_kind != expected_kind:
                raise WorkflowPolicyError(
                    f"{_label(path, root)} is referenced as both "
                    f"{previous_kind} and {expected_kind}"
                )
            continue
        seen[path] = expected_kind

        document = require_mapping(load_yaml(path), _label(path, root))
        if _contains_secret_reference(document):
            raise WorkflowPolicyError(
                f"{_label(path, root)} must not reference GitHub secrets"
            )
        _check_no_input_env(document.get("env"), f"{_label(path, root)}.env")
        if expected_kind == "workflow":
            if "env" in document or "defaults" in document:
                raise WorkflowPolicyError(
                    f"{_label(path, root)} must not define workflow-level env/defaults"
                )
            jobs = require_mapping(
                document.get("jobs"),
                f"{_label(path, root)}.jobs",
            )
            workflows[path] = document
            for job_id, raw_job in jobs.items():
                if not isinstance(job_id, str):
                    raise WorkflowPolicyError(
                        f"{_label(path, root)} job IDs must be strings"
                    )
                job_label = f"{_label(path, root)}.jobs.{job_id}"
                job = require_mapping(raw_job, job_label)
                _check_no_input_env(job.get("env"), f"{job_label}.env")
                _check_no_failure_bypass(job, job_label)
                if "env" in job:
                    raise WorkflowPolicyError(f"{job_label} must not set job-level env")
                for forbidden_key in ("defaults", "container", "services", "strategy"):
                    if forbidden_key in job:
                        raise WorkflowPolicyError(
                            f"{job_label} must not set {forbidden_key}"
                        )
                if "permissions" in job:
                    raise WorkflowPolicyError(
                        f"{job_label} must inherit workflow-level read-only permissions"
                    )
                if "environment" in job:
                    raise WorkflowPolicyError(
                        f"{job_label} must not bind a deployment environment"
                    )
                if "uses" in job:
                    local = _check_use(root, job["uses"], "workflow")
                    if local is not None:
                        queue.append(local)
                    continue
                _check_runner(job.get("runs-on"), f"{job_label}.runs-on")
                _inspect_steps(root, path, job.get("steps"), queue, job_label)
        else:
            runs = require_mapping(
                document.get("runs"),
                f"{_label(path, root)}.runs",
            )
            if runs.get("using") != "composite":
                raise WorkflowPolicyError(
                    f"local action {_label(path, root)} must use the composite runtime"
                )
            actions[path] = document
            _inspect_steps(
                root,
                path,
                runs.get("steps"),
                queue,
                f"{_label(path, root)}.runs",
            )
    return workflows, actions


def _jobs_by_id(
    workflows: dict[Path, dict[Any, Any]],
    root: Path,
    job_id: str,
) -> list[tuple[Path, dict[Any, Any]]]:
    matches: list[tuple[Path, dict[Any, Any]]] = []
    for path, workflow in workflows.items():
        jobs = require_mapping(workflow.get("jobs"), f"{_label(path, root)}.jobs")
        if job_id in jobs:
            matches.append(
                (
                    path,
                    require_mapping(
                        jobs[job_id],
                        f"{_label(path, root)}.jobs.{job_id}",
                    ),
                )
            )
    return matches


def _one_job(
    workflows: dict[Path, dict[Any, Any]],
    root: Path,
    job_id: str,
) -> tuple[Path, dict[Any, Any]]:
    matches = _jobs_by_id(workflows, root, job_id)
    if len(matches) != 1:
        raise WorkflowPolicyError(
            f"reachable Gate call chain must define exactly one {job_id!r} job; "
            f"found {len(matches)}"
        )
    return matches[0]


def _steps_by_id(job: dict[Any, Any], label: str) -> dict[str, dict[Any, Any]]:
    result: dict[str, dict[Any, Any]] = {}
    for index, raw_step in enumerate(_require_list(job.get("steps"), f"{label}.steps")):
        step = require_mapping(raw_step, f"{label}.steps[{index}]")
        step_id = step.get("id")
        if not isinstance(step_id, str):
            raise WorkflowPolicyError(f"{label}.steps[{index}] must have a static id")
        if step_id in result:
            raise WorkflowPolicyError(f"{label} contains duplicate step id {step_id!r}")
        result[step_id] = step
    return result


def _require_step_ids(
    job: dict[Any, Any],
    label: str,
    expected_ids: list[str],
) -> dict[str, dict[Any, Any]]:
    steps = _steps_by_id(job, label)
    if list(steps) != expected_ids:
        raise WorkflowPolicyError(
            f"{label} step IDs/order must be {expected_ids!r}, got {list(steps)!r}"
        )
    return steps


def _require_run(step: dict[Any, Any], expected: str, label: str) -> None:
    actual = _normalise_command(step.get("run"), f"{label}.run")
    expected_normalised = " ".join(expected.split())
    if actual != expected_normalised:
        raise WorkflowPolicyError(
            f"{label}.run must be {expected_normalised!r}, got {actual!r}"
        )


def _require_checkout(
    step: dict[Any, Any],
    label: str,
    *,
    full_history: bool = False,
) -> None:
    if step.get("uses") != CHECKOUT_ACTION:
        raise WorkflowPolicyError(f"{label} must use the approved checkout SHA")
    expected_with = {"persist-credentials": False}
    if full_history:
        expected_with = {
            "fetch-depth": 0,
            "persist-credentials": False,
        }
    if step.get("with") != expected_with:
        raise WorkflowPolicyError(
            f"{label}.with must be exactly {expected_with!r}"
        )


def _validate_uv_required_version(root: Path) -> None:
    path = root / "pyproject.toml"
    try:
        config = tomllib.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, tomllib.TOMLDecodeError) as exc:
        raise WorkflowPolicyError(f"cannot parse {path}: {exc}") from exc

    tool = config.get("tool")
    uv = tool.get("uv") if isinstance(tool, dict) else None
    actual = uv.get("required-version") if isinstance(uv, dict) else None
    if actual != UV_REQUIRED_VERSION:
        raise WorkflowPolicyError(
            "[tool.uv].required-version must be "
            f"{UV_REQUIRED_VERSION!r}, got {actual!r}"
        )


def _validate_uv_documentation(root: Path) -> None:
    for relative_path, required_snippets in UV_DOCUMENT_REQUIREMENTS.items():
        path = root / relative_path
        try:
            text = path.read_text(encoding="utf-8")
        except (OSError, UnicodeError) as exc:
            raise WorkflowPolicyError(f"cannot read {path}: {exc}") from exc

        missing = [
            snippet for snippet in required_snippets if snippet not in text
        ]
        forbidden = [
            snippet for snippet in FORBIDDEN_FLOATING_UV_INSTALLS if snippet in text
        ]
        if missing or forbidden:
            raise WorkflowPolicyError(
                f"{relative_path} must document pinned uv {UV_VERSION}; "
                f"missing={missing!r}, forbidden={forbidden!r}"
            )


def _validate_trigger_and_permissions(workflow: dict[Any, Any]) -> None:
    if workflow.get("name") != "pr-gate":
        raise WorkflowPolicyError("pr-gate workflow name must remain 'pr-gate'")
    triggers = require_mapping(workflow.get("on"), "pr-gate.on")
    if set(triggers) != {"pull_request", "push"}:
        raise WorkflowPolicyError(
            "pr-gate triggers must be exactly pull_request and push"
        )
    push = require_mapping(triggers.get("push"), "pr-gate.on.push")
    if push != {"branches": ["main"]}:
        raise WorkflowPolicyError("pr-gate push trigger must target only main")
    if triggers.get("pull_request") is not None:
        raise WorkflowPolicyError("pr-gate pull_request trigger must not use filters")
    if workflow.get("permissions") != {"contents": "read"}:
        raise WorkflowPolicyError("pr-gate permissions must be exactly contents: read")

    concurrency = require_mapping(workflow.get("concurrency"), "pr-gate.concurrency")
    if concurrency != {
        "group": "pr-gate-${{ github.event.pull_request.number || github.ref }}",
        "cancel-in-progress": True,
    }:
        raise WorkflowPolicyError("pr-gate concurrency policy has changed")


def _validate_backend(
    workflows: dict[Path, dict[Any, Any]],
    root: Path,
) -> None:
    path, job = _one_job(workflows, root, "backend")
    label = f"{_label(path, root)}.jobs.backend"
    if "if" in job:
        raise WorkflowPolicyError(f"{label} must be unconditional")
    steps = _require_step_ids(
        job,
        label,
        [
            "checkout",
            "setup_uv",
            "lockfile",
            "sync",
            "dependency_review_config",
            "gate_uniqueness",
            "workflow_policy",
            "port_closure",
            "ruff",
            "dependency_licenses",
            "pytest",
        ],
    )
    _require_checkout(steps["checkout"], f"{label}.checkout")
    if steps["setup_uv"].get("uses") != SETUP_UV_ACTION:
        raise WorkflowPolicyError(f"{label}.setup_uv must use the approved setup-uv SHA")
    if steps["setup_uv"].get("with") != {
        "version": UV_VERSION,
        "enable-cache": True,
        "cache-dependency-glob": "uv.lock",
    }:
        raise WorkflowPolicyError(f"{label}.setup_uv version/cache policy has changed")
    expected_runs = {
        "lockfile": "uv lock --check",
        "sync": "uv sync --frozen",
        "dependency_review_config": (
            "uv run python scripts/check_dependency_review_config.py"
        ),
        "gate_uniqueness": "uv run python scripts/check_ci_gate_uniqueness.py",
        "workflow_policy": "uv run python scripts/check_ci_workflow_policy.py",
        "port_closure": "uv run python scripts/check_ce_port_closure.py",
        "ruff": "uv run ruff check --output-format=github .",
        "dependency_licenses": (
            "uv run python scripts/check_dependency_licenses.py"
        ),
        "pytest": "uv run pytest -n auto",
    }
    for step_id, expected in expected_runs.items():
        _require_run(steps[step_id], expected, f"{label}.steps.{step_id}")
    if any("if" in step for step in steps.values()):
        raise WorkflowPolicyError(f"{label} must not conditionally skip required steps")
    if any("env" in step for step in steps.values()):
        raise WorkflowPolicyError(f"{label} steps must not override env")


def _validate_ce_policy(
    workflows: dict[Path, dict[Any, Any]],
    root: Path,
) -> None:
    path, job = _one_job(workflows, root, "ce-policy")
    label = f"{_label(path, root)}.jobs.ce-policy"
    if "if" in job:
        raise WorkflowPolicyError(f"{label} must be unconditional")
    steps = _require_step_ids(
        job,
        label,
        ["checkout", "ce_imports", "ce_allowlist", "ee_terms", "banned_words"],
    )
    _require_checkout(steps["checkout"], f"{label}.checkout")
    expected_runs = {
        "ce_imports": "python3 scripts/lint_ce_imports.py",
        "ce_allowlist": "python3 scripts/ce_allowlist.py",
        "ee_terms": "python3 scripts/lint_ee_terms.py",
        "banned_words": "python3 scripts/lint_banned_words.py",
    }
    for step_id, expected in expected_runs.items():
        _require_run(steps[step_id], expected, f"{label}.steps.{step_id}")
    if any("if" in step for step in steps.values()):
        raise WorkflowPolicyError(f"{label} must not conditionally skip required steps")
    if any("env" in step for step in steps.values()):
        raise WorkflowPolicyError(f"{label} steps must not override env")


def _validate_dependency_review(
    workflows: dict[Path, dict[Any, Any]],
    root: Path,
) -> None:
    path, job = _one_job(workflows, root, "dependency-review")
    label = f"{_label(path, root)}.jobs.dependency-review"
    if job.get("outputs") != {
        "verified": "${{ steps.assert_path.outputs.verified }}"
    }:
        raise WorkflowPolicyError(f"{label} must expose verified from assert_path")
    steps = _require_step_ids(
        job,
        label,
        ["checkout", "review", "no_op", "assert_path"],
    )
    review = steps["review"]
    if review.get("uses") != DEPENDENCY_REVIEW_ACTION:
        raise WorkflowPolicyError(
            f"{label}.steps.review must use {DEPENDENCY_REVIEW_ACTION}"
        )
    if review.get("if") != "github.event_name == 'pull_request'":
        raise WorkflowPolicyError(f"{label}.steps.review has an unsafe condition")
    if review.get("with") != {"config-file": DEPENDENCY_REVIEW_CONFIG}:
        raise WorkflowPolicyError(
            f"{label}.steps.review.with must contain only the approved config-file"
        )
    if "env" in review:
        raise WorkflowPolicyError(f"{label}.steps.review must not set env overrides")
    _require_checkout(steps["checkout"], f"{label}.checkout")
    if steps["checkout"].get("if") != "github.event_name == 'pull_request'":
        raise WorkflowPolicyError(f"{label}.checkout has an unsafe condition")
    if "env" in steps["checkout"] or "env" in steps["no_op"]:
        raise WorkflowPolicyError(f"{label} non-assertion steps must not override env")
    if steps["no_op"].get("if") != "github.event_name != 'pull_request'":
        raise WorkflowPolicyError(f"{label}.no_op has an unsafe condition")
    _require_run(
        steps["no_op"],
        'echo "Dependency Review applies to pull requests only."',
        f"{label}.steps.no_op",
    )
    if steps["assert_path"].get("if") != "always()":
        raise WorkflowPolicyError(f"{label}.assert_path must always run")
    if steps["assert_path"].get("env") != {
        "APPLICABLE": "${{ github.event_name == 'pull_request' }}",
        "CHECKOUT_OUTCOME": "${{ steps.checkout.outcome }}",
        "REVIEW_OUTCOME": "${{ steps.review.outcome }}",
        "NOOP_OUTCOME": "${{ steps.no_op.outcome }}",
    }:
        raise WorkflowPolicyError(f"{label}.assert_path env contract has changed")
    _require_run(
        steps["assert_path"],
        DEPENDENCY_REVIEW_ASSERT_RUN,
        f"{label}.steps.assert_path",
    )


def _validate_frontend(
    workflows: dict[Path, dict[Any, Any]],
    root: Path,
) -> None:
    path, job = _one_job(workflows, root, "frontend")
    label = f"{_label(path, root)}.jobs.frontend"
    if "if" in job:
        raise WorkflowPolicyError(f"{label} must be unconditional")
    steps = _require_step_ids(
        job,
        label,
        ["checkout", "setup_pnpm", "setup_node", "install", "build", "test"],
    )
    _require_checkout(steps["checkout"], f"{label}.checkout")
    if steps["setup_pnpm"].get("uses") != SETUP_PNPM_ACTION:
        raise WorkflowPolicyError(f"{label}.setup_pnpm uses an unapproved Action")
    if steps["setup_pnpm"].get("with") != {
        "package_json_file": "frontend/package.json"
    }:
        raise WorkflowPolicyError(f"{label}.setup_pnpm configuration has changed")
    if steps["setup_node"].get("uses") != SETUP_NODE_ACTION:
        raise WorkflowPolicyError(f"{label}.setup_node uses an unapproved Action")
    if steps["setup_node"].get("with") != {
        "node-version": "22",
        "cache": "pnpm",
        "cache-dependency-path": "frontend/pnpm-lock.yaml",
    }:
        raise WorkflowPolicyError(f"{label}.setup_node configuration has changed")
    _require_run(
        steps["install"],
        "pnpm install --frozen-lockfile",
        f"{label}.steps.install",
    )
    _require_run(steps["build"], "pnpm build", f"{label}.steps.build")
    _require_run(steps["test"], "pnpm test", f"{label}.steps.test")
    for step_id in ("install", "build", "test"):
        if steps[step_id].get("working-directory") != "frontend":
            raise WorkflowPolicyError(
                f"{label}.steps.{step_id} must run in frontend"
            )
    for step_id in ("checkout", "setup_pnpm", "setup_node"):
        if "working-directory" in steps[step_id]:
            raise WorkflowPolicyError(
                f"{label}.steps.{step_id} must not change working-directory"
            )
    if any("if" in step for step in steps.values()):
        raise WorkflowPolicyError(f"{label} must not conditionally skip required steps")
    if any("env" in step for step in steps.values()):
        raise WorkflowPolicyError(f"{label} steps must not override env")


def _validate_secret_scan(
    workflows: dict[Path, dict[Any, Any]],
    root: Path,
) -> None:
    path, job = _one_job(workflows, root, "secret-scan")
    label = f"{_label(path, root)}.jobs.secret-scan"
    if "if" in job:
        raise WorkflowPolicyError(f"{label} must be unconditional")
    steps = _require_step_ids(job, label, ["checkout", "install_gitleaks", "scan"])
    checkout = steps["checkout"]
    _require_checkout(checkout, f"{label}.checkout", full_history=True)

    install = steps["install_gitleaks"]
    if install.get("env") != {
        "GITLEAKS_VERSION": GITLEAKS_VERSION,
        "GITLEAKS_ARCHIVE_SHA256": GITLEAKS_SHA256,
    }:
        raise WorkflowPolicyError(
            f"{label}.install_gitleaks must pin the approved version and checksum"
        )
    _require_run(
        install,
        GITLEAKS_INSTALL_RUN,
        f"{label}.steps.install_gitleaks",
    )

    _require_run(
        steps["scan"],
        (
            "gitleaks git . -c .gitleaks.toml --redact --no-banner "
            "--exit-code 1"
        ),
        f"{label}.steps.scan",
    )
    if "env" in checkout or "env" in steps["scan"]:
        raise WorkflowPolicyError(f"{label} checkout/scan must not override env")
    if any("if" in step for step in steps.values()):
        raise WorkflowPolicyError(f"{label} must not conditionally skip required steps")


def _validate_pr_policy(
    workflows: dict[Path, dict[Any, Any]],
    root: Path,
) -> None:
    path, job = _one_job(workflows, root, "pr-policy")
    label = f"{_label(path, root)}.jobs.pr-policy"
    if job.get("outputs") != {
        "verified": "${{ steps.assert_path.outputs.verified }}"
    }:
        raise WorkflowPolicyError(f"{label} must expose verified from assert_path")
    steps = _require_step_ids(job, label, ["checkout", "dco", "no_op", "assert_path"])
    checkout = steps["checkout"]
    _require_checkout(checkout, f"{label}.checkout", full_history=True)
    if checkout.get("if") != "github.event_name == 'pull_request'":
        raise WorkflowPolicyError(f"{label}.checkout has an unsafe condition")
    if steps["dco"].get("if") != "github.event_name == 'pull_request'":
        raise WorkflowPolicyError(f"{label}.dco has an unsafe condition")
    if any("env" in steps[step_id] for step_id in ("checkout", "dco", "no_op")):
        raise WorkflowPolicyError(f"{label} non-assertion steps must not override env")
    dco_command = _normalise_command(steps["dco"].get("run"), f"{label}.dco.run")
    for required_text in (
        "python3 scripts/check_dco.py",
        "${{ github.event.pull_request.base.sha }}..${{ github.event.pull_request.head.sha }}",
    ):
        if required_text not in dco_command:
            raise WorkflowPolicyError(f"{label}.dco is missing {required_text!r}")
    if steps["no_op"].get("if") != "github.event_name != 'pull_request'":
        raise WorkflowPolicyError(f"{label}.no_op has an unsafe condition")
    _require_run(
        steps["no_op"],
        'echo "DCO applies to pull requests only."',
        f"{label}.steps.no_op",
    )
    if steps["assert_path"].get("if") != "always()":
        raise WorkflowPolicyError(f"{label}.assert_path must always run")
    if steps["assert_path"].get("env") != {
        "APPLICABLE": "${{ github.event_name == 'pull_request' }}",
        "CHECKOUT_OUTCOME": "${{ steps.checkout.outcome }}",
        "DCO_OUTCOME": "${{ steps.dco.outcome }}",
        "NOOP_OUTCOME": "${{ steps.no_op.outcome }}",
    }:
        raise WorkflowPolicyError(f"{label}.assert_path env contract has changed")
    _require_run(
        steps["assert_path"],
        PR_POLICY_ASSERT_RUN,
        f"{label}.steps.assert_path",
    )


def _validate_gate(
    workflows: dict[Path, dict[Any, Any]],
    root: Path,
) -> None:
    path, job = _one_job(workflows, root, "gate")
    if path.resolve() != (root / PR_GATE_PATH).resolve():
        raise WorkflowPolicyError("gate job must be defined in pr-gate.yml")
    label = f"{_label(path, root)}.jobs.gate"
    if job.get("name") != GATE_NAME:
        raise WorkflowPolicyError(f"{label}.name must be {GATE_NAME!r}")
    if job.get("if") != "always()":
        raise WorkflowPolicyError(f"{label} must use if: always()")
    needs = job.get("needs")
    if (
        not isinstance(needs, list)
        or len(needs) != len(REQUIRED_GATE_NEEDS)
        or set(needs) != REQUIRED_GATE_NEEDS
    ):
        raise WorkflowPolicyError(
            f"{label}.needs must be exactly {sorted(REQUIRED_GATE_NEEDS)!r}"
        )
    steps = _require_step_ids(job, label, ["verify"])
    verify = steps["verify"]
    if verify.get("env") != {"NEEDS_JSON": "${{ toJson(needs) }}"}:
        raise WorkflowPolicyError(f"{label}.verify must receive toJson(needs)")
    _require_run(verify, GATE_VERIFY_RUN, f"{label}.steps.verify")


def validate_workflow_policy(root: Path) -> None:
    _validate_uv_required_version(root)
    _validate_uv_documentation(root)
    workflows, _actions = _load_reachable_documents(root)
    entry = (root / PR_GATE_PATH).resolve()
    workflow = workflows.get(entry)
    if workflow is None:
        raise WorkflowPolicyError(f"{PR_GATE_PATH} is not a workflow")
    _validate_trigger_and_permissions(workflow)
    _validate_backend(workflows, root)
    _validate_ce_policy(workflows, root)
    _validate_dependency_review(workflows, root)
    _validate_frontend(workflows, root)
    _validate_secret_scan(workflows, root)
    _validate_pr_policy(workflows, root)
    _validate_gate(workflows, root)


def _parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--root",
        type=Path,
        default=Path(__file__).resolve().parents[1],
        help="repository root (defaults to the current script's repository)",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv or [])
    try:
        validate_workflow_policy(args.root.resolve())
    except (CIYamlError, WorkflowPolicyError) as exc:
        print(f"✖ PR Gate workflow policy failed: {exc}", file=sys.stderr)
        return 1
    print("✓ PR Gate workflow and reachable Action call chain match the baseline.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
