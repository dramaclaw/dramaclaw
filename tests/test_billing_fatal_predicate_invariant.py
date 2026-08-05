from __future__ import annotations

import ast
from collections import Counter
from pathlib import Path


SOURCE_ROOT = Path("src/novelvideo")

# The helper composes the narrow predicate; R2 keeps its narrow renderer first;
# video keeps two guarded redaction-boundary calls.
ALLOWED_POSITIONAL_CALLS = {
    Path("shared/billing_errors.py"): 1,
    Path("task_backend/run_core.py"): 1,
    Path("generators/video_generator.py"): 2,
}


def test_fail_closed_paths_do_not_use_narrow_billing_predicate() -> None:
    positional_calls: Counter[Path] = Counter()

    for source_path in SOURCE_ROOT.rglob("*.py"):
        tree = ast.parse(source_path.read_text(encoding="utf-8"), filename=source_path)
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call) or not node.args:
                continue
            if not isinstance(node.func, ast.Name):
                continue
            if node.func.id != "is_insufficient_credits_error":
                continue
            positional_calls[source_path.relative_to(SOURCE_ROOT)] += 1

    unexpected = {
        path: count
        for path, count in positional_calls.items()
        if path not in ALLOWED_POSITIONAL_CALLS
    }

    assert unexpected == {}
    assert positional_calls == Counter(ALLOWED_POSITIONAL_CALLS)
