from __future__ import annotations

import sys
from pathlib import Path

import yaml

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "scripts"))

from check_dependency_licenses import audit, classify  # noqa: E402


def test_classify_denies_strong_copyleft() -> None:
    """强 copyleft 的各种写法（SPDX 表达式 / 分类器全称）都必须拦下。"""
    for text in (
        "GPL-3.0-only",
        "GPL-2.0-or-later",
        "AGPL-3.0-only",
        "GNU General Public License v3 (GPLv3)",
        "GNU Affero General Public License v3",
        "SSPL-1.0",
    ):
        assert classify(text) == "denied", text


def test_classify_allows_permissive_and_weak_copyleft() -> None:
    """宽松许可放行；LGPL/MPL 属弱 copyleft，放行但归为 notice。"""
    for text in ("MIT", "Apache-2.0", "BSD-3-Clause", "MIT OR Apache-2.0", "Elastic-2.0"):
        assert classify(text) == "ok", text
    for text in (
        "LGPL-3.0-only",
        "GNU Lesser General Public License v3 (LGPLv3)",
        "GNU Library or Lesser General Public License (LGPL)",
        "Mozilla Public License 2.0 (MPL 2.0)",
    ):
        assert classify(text) == "notice", text


def test_classify_flags_missing_metadata() -> None:
    assert classify("UNKNOWN") == "unknown"


def test_dependency_tree_has_no_license_violations() -> None:
    """依赖树许可证门（DEP-11，硬零）：当前环境（=uv.lock 全树）不得含
    强 copyleft / 无豁免的 UNKNOWN，豁免表不得腐烂。CI 守门见
    .github/workflows/dependency-review.yml。"""
    violations, _notices, rotten = audit()
    assert violations == [], "依赖许可证违规：\n" + "\n".join(violations)
    assert rotten == [], "腐烂豁免：\n" + "\n".join(rotten)


def test_dependency_review_action_requires_dependency_graph_guard() -> None:
    workflow_path = REPO_ROOT / ".github/workflows/dependency-review.yml"
    workflow = yaml.safe_load(workflow_path.read_text(encoding="utf-8"))
    steps = workflow["jobs"]["dependency-review"]["steps"]

    guard_step = next(step for step in steps if step.get("id") == "dependency-graph")
    assert "/dependency-graph/compare/" in guard_step["run"]

    review_step = next(
        step for step in steps if step.get("uses") == "actions/dependency-review-action@v4"
    )
    assert review_step["if"] == "steps.dependency-graph.outputs.enabled == 'true'"
