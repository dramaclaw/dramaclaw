"""Read the current SQLite task_state row for a local actor job."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[4]
SRC_ROOT = REPO_ROOT / "src"
if str(SRC_ROOT) not in sys.path:
    sys.path.insert(0, str(SRC_ROOT))

from novelvideo.task_jobs import (  # noqa: E402
    read_task_result,
    resolve_user_project_from_context,
)

from _api_runtime import api_enabled, read_task_result_via_api  # noqa: E402


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Read a task_state row from local SQLite.")
    parser.add_argument("project_dir", help="SuperTale project directory, e.g. output/admin/new")
    parser.add_argument("--task-type", required=True, help="Task type, e.g. sketch_edit_execute")
    parser.add_argument("--episode-num", type=int, required=True, help="Episode number")
    parser.add_argument("--scope", default=None, help="Optional task scope returned by the start script")
    parser.add_argument("--beat-num", type=int, default=None)
    parser.add_argument(
        "--require-terminal",
        action="store_true",
        help="Fail unless task status is completed or failed",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    project_dir = Path(args.project_dir)
    if api_enabled(project_dir):
        snapshot = read_task_result_via_api(
            project_dir,
            task_type=args.task_type,
            episode_num=args.episode_num,
            beat_num=args.beat_num if args.beat_num is not None else None,
            scope=args.scope if args.scope is not None else None,
            require_terminal=args.require_terminal,
        )
    else:
        username, project = resolve_user_project_from_context(project_dir)
        snapshot = read_task_result(
            task_type=args.task_type,
            username=username,
            project=project,
            episode=args.episode_num,
            beat_num=args.beat_num if args.beat_num is not None else None,
            scope=args.scope if args.scope is not None else None,
            require_terminal=args.require_terminal,
        )
    print(json.dumps(snapshot, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
