#!/usr/bin/env python3
"""Remove legacy persistent HTML export ZIPs after old workers are drained."""

from __future__ import annotations

import argparse
from pathlib import Path

from novelvideo.freezone.html_artifacts import ArtifactStore


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "project_dirs",
        metavar="PROJECT_DIR",
        nargs="+",
        type=Path,
        help="Project directories whose legacy HTML export caches should be removed",
    )
    args = parser.parse_args()
    total = 0
    for project_dir in args.project_dirs:
        removed = ArtifactStore(project_dir).cleanup_legacy_exports()
        total += removed
        print(f"{project_dir.resolve()}: removed {removed} legacy export file(s)")
    print(f"Removed {total} legacy export file(s) from {len(args.project_dirs)} project(s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
