"""Validate sketch edit label JSONL rows."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[4]
SRC_ROOT = REPO_ROOT / "src"
if str(SRC_ROOT) not in sys.path:
    sys.path.insert(0, str(SRC_ROOT))

from novelvideo.verification.sketch_edit_label_validation import (  # noqa: E402
    LabelsValidationError,
    validate_labels_jsonl,
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Validate sketch edit label JSONL rows.")
    parser.add_argument("labels_jsonl", help="Path to labels.jsonl")
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
    path = Path(args.labels_jsonl).expanduser().resolve()
    summary_path = path.with_name(path.stem + "_summary.json")
    summary_payload = _load_summary(summary_path, path)
    try:
        result_payload = validate_labels_jsonl(path)
    except LabelsValidationError as exc:
        raise SystemExit(json.dumps(exc.payload, ensure_ascii=False, indent=2)) from exc
    result_payload["summary_json"] = str(summary_path)
    result_payload["label_count"] = int(summary_payload.get("label_count") or 0)
    print(json.dumps(result_payload, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
