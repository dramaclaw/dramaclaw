from __future__ import annotations

import shutil
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "scripts"))

from check_ci_gate_uniqueness import (  # noqa: E402
    GateUniquenessError,
    validate_gate_uniqueness,
)
from check_ci_workflow_policy import (  # noqa: E402
    WorkflowPolicyError,
    validate_workflow_policy,
)
from check_dependency_review_config import (  # noqa: E402
    DependencyReviewConfigError,
    validate_config,
)
from ci_yaml import CIYamlError, load_yaml  # noqa: E402


VALID_DEPENDENCY_REVIEW_CONFIG = """\
vulnerability-check: false
license-check: true
deny-licenses:
  - AGPL-1.0-only
  - AGPL-1.0-or-later
  - AGPL-3.0-only
  - AGPL-3.0-or-later
  - GPL-1.0-only
  - GPL-1.0-or-later
  - GPL-2.0-only
  - GPL-2.0-or-later
  - GPL-3.0-only
  - GPL-3.0-or-later
  - SSPL-1.0
"""


def _write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def _copy_pr_gate(root: Path) -> Path:
    target = root / ".github/workflows/pr-gate.yml"
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(REPO_ROOT / ".github/workflows/pr-gate.yml", target)
    shutil.copyfile(REPO_ROOT / "pyproject.toml", root / "pyproject.toml")
    return target


def _mutate_pr_gate(root: Path, old: str, new: str) -> None:
    path = _copy_pr_gate(root)
    text = path.read_text(encoding="utf-8")
    assert old in text
    path.write_text(text.replace(old, new, 1), encoding="utf-8")


def test_repository_ci_policies_pass() -> None:
    validate_config(REPO_ROOT)
    validate_gate_uniqueness(REPO_ROOT)
    validate_workflow_policy(REPO_ROOT)


def test_strict_loader_preserves_github_on_key(tmp_path: Path) -> None:
    path = tmp_path / "workflow.yml"
    _write(path, "on:\n  pull_request:\n")
    assert load_yaml(path) == {"on": {"pull_request": None}}


def test_strict_loader_rejects_duplicate_keys(tmp_path: Path) -> None:
    path = tmp_path / "duplicate.yml"
    _write(path, "license-check: true\nlicense-check: false\n")
    with pytest.raises(CIYamlError, match="duplicate key"):
        load_yaml(path)


@pytest.mark.parametrize(
    "extra_field",
    [
        "warn-only: true\n",
        "allow-dependencies-licenses:\n  - pkg:pypi/example\n",
    ],
)
def test_dependency_review_config_rejects_policy_bypass_fields(
    tmp_path: Path,
    extra_field: str,
) -> None:
    _write(
        tmp_path / ".github/dependency-review-config.yml",
        VALID_DEPENDENCY_REVIEW_CONFIG + extra_field,
    )
    with pytest.raises(DependencyReviewConfigError, match="top-level keys"):
        validate_config(tmp_path)


def test_dependency_review_config_rejects_duplicate_policy_key(
    tmp_path: Path,
) -> None:
    _write(
        tmp_path / ".github/dependency-review-config.yml",
        VALID_DEPENDENCY_REVIEW_CONFIG + "license-check: false\n",
    )
    with pytest.raises(CIYamlError, match="duplicate key"):
        validate_config(tmp_path)


@pytest.mark.parametrize(
    "name_literal",
    [
        "dramaclaw-pr-gate",
        "'dramaclaw-pr-gate'",
        '"dramaclaw-pr-gate"',
    ],
)
def test_gate_uniqueness_counts_all_yaml_quoting_styles(
    tmp_path: Path,
    name_literal: str,
) -> None:
    _write(
        tmp_path / ".github/workflows/gate.yml",
        f"jobs:\n  gate:\n    name: {name_literal}\n",
    )
    validate_gate_uniqueness(tmp_path)


def test_gate_uniqueness_uses_job_id_when_name_is_absent(tmp_path: Path) -> None:
    _write(
        tmp_path / ".github/workflows/gate.yml",
        "jobs:\n  dramaclaw-pr-gate:\n    runs-on: ubuntu-24.04\n",
    )
    validate_gate_uniqueness(tmp_path)


def test_gate_uniqueness_rejects_second_same_name(tmp_path: Path) -> None:
    _write(
        tmp_path / ".github/workflows/one.yml",
        "jobs:\n  gate:\n    name: dramaclaw-pr-gate\n",
    )
    _write(
        tmp_path / ".github/workflows/two.yaml",
        'jobs:\n  other:\n    name: "dramaclaw-pr-gate"\n',
    )
    with pytest.raises(GateUniquenessError, match="found 2"):
        validate_gate_uniqueness(tmp_path)


def test_gate_uniqueness_rejects_dynamic_job_names(tmp_path: Path) -> None:
    _write(
        tmp_path / ".github/workflows/gate.yml",
        "jobs:\n  gate:\n    name: ${{ inputs.check_name }}\n",
    )
    with pytest.raises(GateUniquenessError, match="dynamic"):
        validate_gate_uniqueness(tmp_path)


@pytest.mark.parametrize(
    "extra_input",
    [
        "          warn-only: true\n",
        "          allow-dependencies-licenses: pkg:pypi/example\n",
    ],
)
def test_workflow_policy_rejects_dependency_review_inline_overrides(
    tmp_path: Path,
    extra_input: str,
) -> None:
    _mutate_pr_gate(
        tmp_path,
        "          config-file: ./.github/dependency-review-config.yml\n",
        "          config-file: ./.github/dependency-review-config.yml\n"
        + extra_input,
    )
    with pytest.raises(WorkflowPolicyError, match="contain only"):
        validate_workflow_policy(tmp_path)


def test_workflow_policy_rejects_action_input_env_injection(tmp_path: Path) -> None:
    _mutate_pr_gate(
        tmp_path,
        "permissions:\n  contents: read\n",
        "permissions:\n  contents: read\nenv:\n  INPUT_WARN-ONLY: 'true'\n",
    )
    with pytest.raises(WorkflowPolicyError, match=r"INPUT_\*"):
        validate_workflow_policy(tmp_path)


def test_workflow_policy_rejects_dependency_review_action_drift(
    tmp_path: Path,
) -> None:
    _mutate_pr_gate(
        tmp_path,
        "a1d282b36b6f3519aa1f3fc636f609c47dddb294",
        "0000000000000000000000000000000000000000",
    )
    with pytest.raises(WorkflowPolicyError, match="must use"):
        validate_workflow_policy(tmp_path)


def test_workflow_policy_rejects_unpinned_external_action(tmp_path: Path) -> None:
    _mutate_pr_gate(
        tmp_path,
        "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
        "actions/checkout@v7",
    )
    with pytest.raises(WorkflowPolicyError, match="40-character"):
        validate_workflow_policy(tmp_path)


def test_workflow_policy_rejects_gitleaks_action(tmp_path: Path) -> None:
    _mutate_pr_gate(
        tmp_path,
        "      - name: Verify lockfile\n",
        "      - name: Forbidden gitleaks Action\n"
        "        id: forbidden_gitleaks\n"
        "        uses: gitleaks/gitleaks-action@"
        "0000000000000000000000000000000000000000\n\n"
        "      - name: Verify lockfile\n",
    )
    with pytest.raises(WorkflowPolicyError, match="gitleaks-action is forbidden"):
        validate_workflow_policy(tmp_path)


def test_workflow_policy_rejects_gitleaks_checksum_drift(tmp_path: Path) -> None:
    _mutate_pr_gate(
        tmp_path,
        "551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb",
        "0000000000000000000000000000000000000000000000000000000000000000",
    )
    with pytest.raises(WorkflowPolicyError, match="version and checksum"):
        validate_workflow_policy(tmp_path)


def test_workflow_policy_rejects_checksum_after_extraction(tmp_path: Path) -> None:
    path = _copy_pr_gate(tmp_path)
    text = path.read_text(encoding="utf-8")
    checksum = (
        "          printf '%s  %s\\n' \"$GITLEAKS_ARCHIVE_SHA256\" \"$archive\" |\n"
        "            sha256sum --check -\n"
    )
    extract = '          tar -xzf "$archive" -C "$install_dir" gitleaks\n'
    assert checksum in text and extract in text
    text = text.replace(checksum + extract, extract + checksum, 1)
    path.write_text(text, encoding="utf-8")
    with pytest.raises(WorkflowPolicyError, match="install_gitleaks.run must be"):
        validate_workflow_policy(tmp_path)


def test_workflow_policy_rejects_early_success_in_gate(tmp_path: Path) -> None:
    _mutate_pr_gate(
        tmp_path,
        "          set -euo pipefail\n"
        "          printf '%s\\n' \"$NEEDS_JSON\" | jq .\n",
        "          set -euo pipefail\n"
        "          exit 0\n"
        "          printf '%s\\n' \"$NEEDS_JSON\" | jq .\n",
    )
    with pytest.raises(WorkflowPolicyError, match="steps.verify.run must be"):
        validate_workflow_policy(tmp_path)


def test_workflow_policy_rejects_job_permission_escalation(
    tmp_path: Path,
) -> None:
    _mutate_pr_gate(
        tmp_path,
        "  backend:\n    runs-on: ubuntu-24.04\n",
        "  backend:\n"
        "    runs-on: ubuntu-24.04\n"
        "    permissions:\n"
        "      contents: write\n",
    )
    with pytest.raises(WorkflowPolicyError, match="read-only permissions"):
        validate_workflow_policy(tmp_path)


@pytest.mark.parametrize(
    "secret_reference",
    [
        "${{ secrets.PRODUCTION_TOKEN }}",
        "${{ secrets['PRODUCTION_TOKEN'] }}",
        "${{ secrets [ 'PRODUCTION_TOKEN' ] }}",
        "${{ toJson(secrets) }}",
    ],
)
def test_workflow_policy_rejects_secret_references(
    tmp_path: Path,
    secret_reference: str,
) -> None:
    _mutate_pr_gate(
        tmp_path,
        "        with:\n"
        "          persist-credentials: false\n"
        "\n"
        "      - name: Install uv\n",
        "        with:\n"
        "          persist-credentials: false\n"
        f"          token: {secret_reference}\n"
        "\n"
        "      - name: Install uv\n",
    )
    with pytest.raises(WorkflowPolicyError, match="must not reference GitHub secrets"):
        validate_workflow_policy(tmp_path)


def test_workflow_policy_allows_plaintext_word_secrets(tmp_path: Path) -> None:
    _mutate_pr_gate(
        tmp_path,
        "      - name: Checkout\n",
        "      - name: Checkout without persisted secrets\n",
    )
    validate_workflow_policy(tmp_path)


def test_workflow_policy_rejects_extra_checkout_inputs(tmp_path: Path) -> None:
    _mutate_pr_gate(
        tmp_path,
        "        with:\n"
        "          persist-credentials: false\n"
        "\n"
        "      - name: Install uv\n",
        "        with:\n"
        "          persist-credentials: false\n"
        "          ref: main\n"
        "\n"
        "      - name: Install uv\n",
    )
    with pytest.raises(WorkflowPolicyError, match=r"checkout\.with must be exactly"):
        validate_workflow_policy(tmp_path)


def test_workflow_policy_rejects_uv_action_version_drift(tmp_path: Path) -> None:
    _mutate_pr_gate(
        tmp_path,
        '          version: "0.11.31"\n',
        '          version: "0.11.30"\n',
    )
    with pytest.raises(WorkflowPolicyError, match="version/cache policy"):
        validate_workflow_policy(tmp_path)


def test_workflow_policy_rejects_local_uv_version_drift(tmp_path: Path) -> None:
    _copy_pr_gate(tmp_path)
    path = tmp_path / "pyproject.toml"
    text = path.read_text(encoding="utf-8")
    path.write_text(
        text.replace(
            'required-version = "==0.11.31"',
            'required-version = ">=0.11.31"',
            1,
        ),
        encoding="utf-8",
    )
    with pytest.raises(WorkflowPolicyError, match=r"\[tool\.uv\]\.required-version"):
        validate_workflow_policy(tmp_path)


def test_workflow_policy_ignores_unreachable_legacy_workflow(
    tmp_path: Path,
) -> None:
    _copy_pr_gate(tmp_path)
    _write(
        tmp_path / ".github/workflows/legacy.yml",
        "jobs:\n  legacy:\n    runs-on: ubuntu-latest\n"
        "    steps:\n      - uses: actions/checkout@v4\n",
    )
    validate_workflow_policy(tmp_path)
