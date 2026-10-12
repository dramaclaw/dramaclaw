#!/usr/bin/env python3
"""Install the bundled Workflow Skill into one local agent host."""

from __future__ import annotations

import argparse
import shutil
from pathlib import Path


DEFAULT_ROOTS = {
    "codex": Path.home() / ".agents" / "skills",
    "claude-code": Path.home() / ".claude" / "skills",
    "hermes": Path.home() / ".hermes" / "skills",
}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", choices=[*sorted(DEFAULT_ROOTS), "custom"], required=True)
    parser.add_argument("--target", help="Exact destination skill directory")
    parser.add_argument("--replace", action="store_true")
    args = parser.parse_args()

    kit_root = Path(__file__).resolve().parents[1]
    source = kit_root / "skills" / "dramaclaw-workflows"
    target = (
        Path(args.target).expanduser()
        if args.target
        else DEFAULT_ROOTS.get(args.host, Path()) / "dramaclaw-workflows"
    )
    if args.host == "custom" and not args.target:
        raise SystemExit("--target is required for host=custom")
    if target.exists():
        if not args.replace:
            raise SystemExit(f"Destination already exists: {target}; use --replace after review")
        if target.is_symlink() or target.is_file():
            target.unlink()
        else:
            shutil.rmtree(target)
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(source, target)
    print(target.resolve())


if __name__ == "__main__":
    main()
