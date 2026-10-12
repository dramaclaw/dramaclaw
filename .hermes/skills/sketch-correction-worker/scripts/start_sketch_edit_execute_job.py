"""Start an episode-level sketch_edit_execute actor job for a SuperTale project."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[4]
SRC_ROOT = REPO_ROOT / "src"
if str(SRC_ROOT) not in sys.path:
    sys.path.insert(0, str(SRC_ROOT))

from novelvideo.task_jobs import start_sketch_edit_execute_job  # noqa: E402

from _api_runtime import api_enabled, start_edit_execute_via_api  # noqa: E402


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Start sketch_edit_execute actor job.")
    parser.add_argument("project_dir", help="SuperTale project directory, e.g. output/admin/new")
    parser.add_argument("--episode-num", type=int, required=True, help="Episode number")
    parser.add_argument("--labels-name", default="labels.jsonl")
    return parser.parse_args()


def _load_summary(summary_path: Path, labels_path: Path) -> dict:
    if not summary_path.exists():
        raise SystemExit(
            json.dumps(
                {
                    "ok": False,
                    "reason": "missing_labels_summary",
                    "labels_jsonl": str(labels_path),
                    "summary_json": str(summary_path),
                },
                ensure_ascii=False,
                indent=2,
            )
        )
    payload = json.loads(summary_path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise SystemExit(
            json.dumps(
                {
                    "ok": False,
                    "reason": "invalid_labels_summary_shape",
                    "labels_jsonl": str(labels_path),
                    "summary_json": str(summary_path),
                },
                ensure_ascii=False,
                indent=2,
            )
        )
    label_count = int(payload.get("label_count") or 0)
    actual_count = sum(1 for line in labels_path.read_text(encoding="utf-8").splitlines() if line.strip())
    if label_count != actual_count:
        raise SystemExit(
            json.dumps(
                {
                    "ok": False,
                    "reason": "labels_count_mismatch",
                    "labels_jsonl": str(labels_path),
                    "summary_json": str(summary_path),
                    "label_count": label_count,
                    "actual_count": actual_count,
                },
                ensure_ascii=False,
                indent=2,
            )
        )
    return payload


def main() -> int:
    args = parse_args()
    project_dir = Path(args.project_dir).expanduser().resolve()
    labels_path = (
        project_dir / "verify_reports" / f"ep{args.episode_num:03d}" / args.labels_name
    ).resolve()
    summary_path = labels_path.with_name(labels_path.stem + "_summary.json")
    summary_payload = _load_summary(summary_path, labels_path)
    if int(summary_payload.get("label_count") or 0) == 0:
        print(
            json.dumps(
                {
                    "task_type": "sketch_edit_execute",
                    "episode": args.episode_num,
                    "labels_jsonl": str(labels_path),
                    "summary_json": str(summary_path),
                    "skipped": True,
                    "reason": "labels.jsonl is empty; nothing to edit",
                },
                ensure_ascii=False,
                indent=2,
            )
        )
        return 0
    config = {
        "labels_name": args.labels_name,
    }
    if api_enabled(project_dir):
        payload = start_edit_execute_via_api(project_dir, args.episode_num, config)
    else:
        payload = start_sketch_edit_execute_job(project_dir, args.episode_num, config)
    payload["summary_json"] = str(summary_path)
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
