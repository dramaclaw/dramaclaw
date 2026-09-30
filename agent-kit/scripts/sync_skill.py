#!/usr/bin/env python3
"""Synchronize the publishable Skill with its canonical CE source."""

from __future__ import annotations

import argparse
import filecmp
import shutil
from pathlib import Path


def _same_tree(source: Path, target: Path) -> bool:
    comparison = filecmp.dircmp(source, target)
    if comparison.left_only or comparison.right_only or comparison.funny_files:
        return False
    if any(not filecmp.cmp(source / name, target / name, shallow=False) for name in comparison.common_files):
        return False
    return all(
        _same_tree(source / name, target / name)
        for name in comparison.common_dirs
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()

    kit_root = Path(__file__).resolve().parents[1]
    ce_root = kit_root.parent
    source = ce_root / "src" / "novelvideo" / "agent_skills" / "dramaclaw-workflows"
    target = kit_root / "skills" / "dramaclaw-workflows"
    if args.check:
        if not target.is_dir() or not _same_tree(source, target):
            raise SystemExit("Published Skill differs from the canonical CE Skill")
        print("Skill is synchronized")
        return
    if target.exists():
        shutil.rmtree(target)
    shutil.copytree(source, target)
    print("Skill synchronized")


if __name__ == "__main__":
    main()
