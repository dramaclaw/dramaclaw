#!/usr/bin/env python3
"""Require one static, repository-unique DramaClaw PR Gate check name."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Any

from ci_yaml import CIYamlError, load_yaml, require_mapping

GATE_NAME = "dramaclaw-pr-gate"
WORKFLOW_DIR = Path(".github/workflows")


class GateUniquenessError(ValueError):
    """Raised when the required Gate name is missing or ambiguous."""


def _workflow_paths(root: Path) -> list[Path]:
    workflow_dir = root / WORKFLOW_DIR
    return sorted({*workflow_dir.glob("*.yml"), *workflow_dir.glob("*.yaml")})


def find_gate_jobs(root: Path) -> list[str]:
    matches: list[str] = []
    workflow_paths = _workflow_paths(root)
    if not workflow_paths:
        raise GateUniquenessError(f"no workflows found under {WORKFLOW_DIR}")

    for path in workflow_paths:
        workflow = require_mapping(load_yaml(path), str(path))
        jobs = require_mapping(workflow.get("jobs"), f"{path}: jobs")
        for job_id, raw_job in jobs.items():
            if not isinstance(job_id, str):
                raise GateUniquenessError(f"{path}: job IDs must be strings")
            job = require_mapping(raw_job, f"{path}: jobs.{job_id}")
            effective_name: Any = job.get("name", job_id)
            if not isinstance(effective_name, str):
                raise GateUniquenessError(
                    f"{path}: jobs.{job_id}.name must be a static string"
                )
            if "${{" in effective_name:
                raise GateUniquenessError(
                    f"{path}: jobs.{job_id}.name is dynamic and cannot be "
                    "proven unique"
                )
            if effective_name == GATE_NAME:
                matches.append(f"{path.relative_to(root)}:jobs.{job_id}")
    return matches


def validate_gate_uniqueness(root: Path) -> None:
    matches = find_gate_jobs(root)
    if len(matches) != 1:
        raise GateUniquenessError(
            f"expected exactly one effective job name {GATE_NAME!r}; "
            f"found {len(matches)}: {matches!r}"
        )


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
        validate_gate_uniqueness(args.root.resolve())
    except (CIYamlError, GateUniquenessError) as exc:
        print(f"✖ CI Gate uniqueness policy failed: {exc}", file=sys.stderr)
        return 1
    print(f"✓ Exactly one static {GATE_NAME!r} job is defined.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
