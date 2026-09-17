from __future__ import annotations

import importlib.util
from pathlib import Path


def test_benchmark_runs_indexed_retrieval_with_bounded_candidates() -> None:
    path = Path("scripts/benchmarks/skill_import_search.py")
    spec = importlib.util.spec_from_file_location("skill_import_search_benchmark", path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    report = module.run_benchmark(size=100, repeats=3)

    assert report["size"] == 100
    assert report["expected_ids_found"] is True
    assert report["max_results_per_query"] <= 30
    assert report["max_candidates_per_task"] <= 30
    assert report["unique_model_candidates"] <= 16 * 30
    assert report["snapshot_selected_bytes"] > 0
    assert report["hot_search_seconds"]["p95"] >= 0
    assert report["cold_directory_load_seconds"]["p95"] >= 0


def test_benchmark_uses_realistic_full_recipe_bodies():
    path = Path('scripts/benchmarks/skill_import_search.py')
    spec = importlib.util.spec_from_file_location('skill_import_search_body', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    assert min(len(r['system_prompt']) for r in module.make_recipes(100)) >= 1000
