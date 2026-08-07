#!/usr/bin/env python3
"""Validate the fail-closed Dependency Review license policy."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Any

from ci_yaml import CIYamlError, load_yaml, require_mapping

CONFIG_PATH = Path(".github/dependency-review-config.yml")
EXPECTED_KEYS = {
    "vulnerability-check",
    "license-check",
    "deny-licenses",
}
EXPECTED_DENY_LICENSES = {
    "AGPL-1.0-only",
    "AGPL-1.0-or-later",
    "AGPL-3.0-only",
    "AGPL-3.0-or-later",
    "GPL-1.0-only",
    "GPL-1.0-or-later",
    "GPL-2.0-only",
    "GPL-2.0-or-later",
    "GPL-3.0-only",
    "GPL-3.0-or-later",
    "SSPL-1.0",
}


class DependencyReviewConfigError(ValueError):
    """Raised when the Dependency Review policy can be bypassed."""


def validate_config_data(raw: Any) -> None:
    config = require_mapping(raw, str(CONFIG_PATH))
    actual_keys = set(config)
    if actual_keys != EXPECTED_KEYS:
        missing = sorted(EXPECTED_KEYS - actual_keys)
        extra = sorted(actual_keys - EXPECTED_KEYS)
        raise DependencyReviewConfigError(
            f"top-level keys must be exactly {sorted(EXPECTED_KEYS)!r}; "
            f"missing={missing!r}, extra={extra!r}"
        )

    vulnerability_check = config["vulnerability-check"]
    if type(vulnerability_check) is not bool or vulnerability_check is not False:
        raise DependencyReviewConfigError(
            "vulnerability-check must be the boolean false"
        )

    license_check = config["license-check"]
    if type(license_check) is not bool or license_check is not True:
        raise DependencyReviewConfigError("license-check must be the boolean true")

    deny_licenses = config["deny-licenses"]
    if not isinstance(deny_licenses, list) or any(
        not isinstance(item, str) for item in deny_licenses
    ):
        raise DependencyReviewConfigError(
            "deny-licenses must be an array containing only strings"
        )
    if len(deny_licenses) != len(set(deny_licenses)):
        raise DependencyReviewConfigError("deny-licenses must not contain duplicates")

    actual_licenses = set(deny_licenses)
    if actual_licenses != EXPECTED_DENY_LICENSES:
        missing = sorted(EXPECTED_DENY_LICENSES - actual_licenses)
        extra = sorted(actual_licenses - EXPECTED_DENY_LICENSES)
        raise DependencyReviewConfigError(
            "deny-licenses must match the approved 11-license policy; "
            f"missing={missing!r}, extra={extra!r}"
        )


def validate_config(root: Path) -> None:
    validate_config_data(load_yaml(root / CONFIG_PATH))


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
        validate_config(args.root.resolve())
    except (CIYamlError, DependencyReviewConfigError) as exc:
        print(f"✖ Dependency Review configuration policy failed: {exc}", file=sys.stderr)
        return 1
    print("✓ Dependency Review configuration matches the closed license policy.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
