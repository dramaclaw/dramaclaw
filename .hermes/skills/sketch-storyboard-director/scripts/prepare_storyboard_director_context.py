"""Prepare overview-first context for storyboard directing."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[4]
SRC_ROOT = REPO_ROOT / "src"
if str(SRC_ROOT) not in sys.path:
    sys.path.insert(0, str(SRC_ROOT))

from novelvideo.verification.sketch_select_context import (  # noqa: E402
    prepare_storyboard_director_context,
)


def parse_beat_numbers(raw: str) -> list[int] | None:
    text = str(raw or "").strip()
    if not text:
        return None
    values: list[int] = []
    for token in text.split(","):
        item = token.strip()
        if not item:
            continue
        values.append(int(item))
    return values or None


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Prepare storyboard director context.")
    parser.add_argument("project_dir", help="SuperTale project directory, e.g. output/admin/new")
    parser.add_argument("--episode-num", type=int, required=True, help="Episode number")
    parser.add_argument(
        "--beats",
        default="",
        help="Optional comma-separated beat subset, e.g. 4,7,9",
    )
    parser.add_argument(
        "--output",
        default="",
        help=(
            "Output JSON path; defaults to verify_reports/epXXX/storyboard_director_run/"
            "director_context.json under the project"
        ),
    )
    parser.add_argument("--limit", type=int, default=0, help="Optional max beat count for quick checks")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    project_dir = Path(args.project_dir).expanduser().resolve()
    if str(args.output or "").strip():
        output_candidate = Path(args.output).expanduser()
        if not output_candidate.is_absolute():
            output_candidate = project_dir / output_candidate
        output_path = output_candidate.resolve()
    else:
        output_path = (
            project_dir
            / "verify_reports"
            / f"ep{args.episode_num:03d}"
            / "storyboard_director_run"
            / "director_context.json"
        )
    beat_numbers = parse_beat_numbers(args.beats)
    summary = prepare_storyboard_director_context(
        project_dir=project_dir,
        episode_num=args.episode_num,
        output_path=output_path,
        limit=args.limit,
        beat_numbers=beat_numbers,
    )
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
