"""Wait for storyboard director execute to reach a terminal state."""

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
    resolve_user_project_from_context,
    wait_for_task_terminal,
)

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "sketch-correction-worker" / "scripts"))
from _api_runtime import api_enabled, wait_for_task_result_via_api  # noqa: E402


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Wait for storyboard director execute.")
    parser.add_argument("project_dir", help="SuperTale project directory, e.g. output/admin/new")
    parser.add_argument("--episode-num", type=int, required=True, help="Episode number")
    parser.add_argument("--scope", default=None, help="Task scope returned by the start script")
    parser.add_argument("--timeout-seconds", type=float, default=900.0)
    parser.add_argument("--poll-interval", type=float, default=2.0)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    project_dir = Path(args.project_dir)
    if api_enabled(project_dir):
        snapshot = wait_for_task_result_via_api(
            project_dir,
            task_type="sketch_edit_execute",
            episode_num=args.episode_num,
            beat_num=None,
            scope=args.scope if args.scope is not None else None,
            timeout_seconds=args.timeout_seconds,
            poll_interval=args.poll_interval,
        )
    else:
        username, project = resolve_user_project_from_context(project_dir)
        snapshot = wait_for_task_terminal(
            task_type="sketch_edit_execute",
            username=username,
            project=project,
            episode=args.episode_num,
            beat_num=None,
            scope=args.scope if args.scope is not None else None,
            timeout_seconds=args.timeout_seconds,
            poll_interval=args.poll_interval,
        )
    print(json.dumps(snapshot, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
