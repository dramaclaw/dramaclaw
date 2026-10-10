"""Prepare per-beat sketch edit teacher tasks from a SuperTale project."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[4]
SRC_ROOT = REPO_ROOT / "src"
if str(SRC_ROOT) not in sys.path:
    sys.path.insert(0, str(SRC_ROOT))

from novelvideo.verification.sketch_edit_tasks import prepare_sketch_edit_tasks  # noqa: E402


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Prepare sketch-edit teacher tasks from a project path and episode number."
    )
    parser.add_argument("project_dir", help="SuperTale project directory, e.g. /path/to/project")
    parser.add_argument("--episode-num", type=int, required=True, help="Episode number to prepare")
    parser.add_argument("--output", required=True, help="Output tasks JSONL path")
    parser.add_argument("--limit", type=int, default=0, help="Optional max beat count for quick checks")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    project_dir = Path(args.project_dir).expanduser().resolve()
    output_path = Path(args.output).expanduser().resolve()
    summary = prepare_sketch_edit_tasks(
        project_dir=project_dir,
        episode_num=args.episode_num,
        output_path=output_path,
        limit=args.limit,
    )

    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
