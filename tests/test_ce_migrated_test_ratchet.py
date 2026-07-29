from __future__ import annotations

import ast
import csv
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PROVENANCE = ROOT / "docs/test-governance/ee-split-migrated-tests.tsv"


def _rows() -> list[dict[str, str]]:
    with PROVENANCE.open(encoding="utf-8", newline="") as handle:
        reader = csv.DictReader(handle, delimiter="\t")
        assert reader.fieldnames == ["id", "source_node", "target_node"]
        return list(reader)


def test_ee_split_migrated_nodes_remain_present_in_ce() -> None:
    rows = _rows()
    assert len(rows) == 36
    assert len({row["id"] for row in rows}) == len(rows)
    assert len({row["source_node"] for row in rows}) == len(rows)
    assert len({row["target_node"] for row in rows}) == len(rows)

    missing: list[str] = []
    for row in rows:
        path_text, separator, function_name = row["target_node"].partition("::")
        assert separator and function_name.startswith("test_")
        path = ROOT / path_text
        if not path.is_file():
            missing.append(f'{row["id"]}: missing file {path_text}')
            continue
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=path_text)
        functions = {
            node.name
            for node in ast.walk(tree)
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
        }
        if function_name not in functions:
            missing.append(f'{row["id"]}: missing node {row["target_node"]}')

    assert missing == []
