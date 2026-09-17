#!/usr/bin/env python3
"""Measure bounded Recipe retrieval against synthetic, diverse catalog snapshots.

This intentionally benchmarks local catalog construction and matching only.  It
does not call a model or persist an import record.
"""

from __future__ import annotations

import argparse
import json
import math
import resource
import sys
import tempfile
import time
from pathlib import Path
from statistics import median
from typing import Any

from novelvideo.freezone.agent_workflows.registry import CatalogSearch
from novelvideo.freezone.skill_import_retrieval import MAX_CANDIDATES, find_candidates

TASK_COUNT = 16
QUERIES_PER_TASK = 3


def _recipe(index: int) -> dict[str, Any]:
    kinds = ("text", "image", "video", "audio", "html")
    kind = kinds[index % len(kinds)]
    labels = {
        "text": ("script translation", "翻译 剧本 字幕"),
        "image": ("character turnaround", "角色 双视图 人物"),
        "video": ("video reference endframe", "视频参考 末帧 连续镜头"),
        "audio": ("voice narration", "旁白 音轨 配乐"),
        "html": ("interactive storyboard", "分镜 交互 html"),
    }
    label, chinese = labels[kind]
    return {
        "id": f"benchmark-{kind}-{index:05d}",
        "version": 1,
        "name": f"{label} {index}",
        "description": f"{label}; {chinese}; recipe {index}",
        "enabled": True,
        "output_kind": "text" if kind == "html" else kind,
        **({"output_format": "html"} if kind == "html" else {}),
        "action_keys": [f"{kind}.generate"],
        "system_prompt": (f"Synthetic benchmark definition {index}: {label} {chinese}\n" + ("输入媒体必须来自已连接素材；输出一条完整生成提示词；遵守确认的结构与禁止事项。" * 40)),
    }


def make_recipes(size: int) -> list[dict[str, Any]]:
    if size < TASK_COUNT:
        raise ValueError(f"size must be at least {TASK_COUNT}")
    recipes = [_recipe(index) for index in range(size)]
    # The expected records cover Chinese, end-frame, and video-reference recall.
    recipes[0].update(
        id="benchmark-video-reference-endframe",
        name="视频参考末帧视频生成",
        description="视频参考 输入 与 末帧 图片 连续镜头 视频生成",
        output_kind="video",
    )
    recipes[1].update(
        id="benchmark-character-dual-view",
        name="角色双视图 image",
        description="角色 单张 左右双视图 人物 image",
        output_kind="image",
    )
    recipes[2].update(
        id="benchmark-narration-bgm",
        name="旁白与背景音乐",
        description="旁白 配乐 BGM 音轨 连续",
        output_kind="audio",
    )
    return recipes


def make_tasks() -> list[dict[str, Any]]:
    templates = (
        ("video", ["视频参考 末帧", "连续镜头 视频", "video reference endframe"], "benchmark-video-reference-endframe"),
        ("image", ["角色 双视图", "人物 左右", "character turnaround"], "benchmark-character-dual-view"),
        ("audio", ["旁白 配乐", "BGM 音轨", "voice narration"], "benchmark-narration-bgm"),
        ("text", ["翻译 剧本", "字幕", "script translation"], "benchmark-text-00005"),
    )
    tasks: list[dict[str, Any]] = []
    for index in range(TASK_COUNT):
        kind, queries, expected_id = templates[index % len(templates)]
        tasks.append(
            {
                "id": f"task-{index:02d}",
                "output_kinds": [kind],
                "queries": queries,
                "expected_id": expected_id,
            }
        )
    return tasks


def _percentiles(samples: list[float]) -> dict[str, float]:
    ordered = sorted(samples)
    return {
        "p50": median(ordered),
        "p95": ordered[math.ceil(len(ordered) * 0.95) - 1],
    }


def _process_memory_bytes() -> int:
    maximum = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return maximum if sys.platform == "darwin" else maximum * 1024


def _cold_directory_load(recipes: list[dict[str, Any]]) -> float:
    with tempfile.TemporaryDirectory(prefix="skill-import-search-") as temp_dir:
        root = Path(temp_dir)
        for recipe in recipes:
            (root / f"{recipe['id']}.json").write_text(
                json.dumps(recipe, ensure_ascii=False), encoding="utf-8"
            )
        started = time.perf_counter()
        loaded = [
            json.loads(path.read_text(encoding="utf-8"))
            for path in sorted(root.glob("*.json"))
        ]
        elapsed = time.perf_counter() - started
    if len(loaded) != len(recipes):
        raise AssertionError("cold directory load did not read every generated Recipe")
    return elapsed


def run_benchmark(*, size: int, repeats: int) -> dict[str, Any]:
    if repeats < 3:
        raise ValueError("repeats must be at least 3")
    recipes = make_recipes(size)
    recipes_by_id = {recipe["id"]: recipe for recipe in recipes}
    tasks = make_tasks()
    hot_samples: list[float] = []
    cold_samples: list[float] = []
    maximum_results = 0
    maximum_candidates = 0
    candidate_definitions: dict[str, dict[str, Any]] = {}
    expected_ids_found = True

    for _ in range(repeats):
        started = time.perf_counter()
        index = CatalogSearch(recipes, "recipes")
        for task in tasks:
            for query in task["queries"]:
                results = index.search(query, MAX_CANDIDATES)
                maximum_results = max(maximum_results, len(results))
                if len(results) > MAX_CANDIDATES:
                    raise AssertionError("query exceeded bounded result limit")
            candidate_ids = find_candidates(index, task, set(), task["queries"])
            maximum_candidates = max(maximum_candidates, len(candidate_ids))
            if len(candidate_ids) > MAX_CANDIDATES:
                raise AssertionError("task exceeded bounded candidate limit")
            expected_ids_found = expected_ids_found and task["expected_id"] in candidate_ids
            for recipe_id in candidate_ids:
                candidate_definitions[recipe_id] = recipes_by_id[recipe_id]
        hot_samples.append(time.perf_counter() - started)
        cold_samples.append(_cold_directory_load(recipes))

    if not expected_ids_found:
        raise AssertionError("expected benchmark Recipes were not retrieved")
    if len(candidate_definitions) > TASK_COUNT * MAX_CANDIDATES:
        raise AssertionError("model candidate snapshot exceeded task-level bound")
    snapshot_bytes = len(
        json.dumps(list(candidate_definitions.values()), ensure_ascii=False).encode("utf-8")
    )
    return {
        "size": size,
        "repeats": repeats,
        "tasks": TASK_COUNT,
        "queries_per_task": QUERIES_PER_TASK,
        "expected_ids_found": expected_ids_found,
        "max_results_per_query": maximum_results,
        "max_candidates_per_task": maximum_candidates,
        "unique_model_candidates": len(candidate_definitions),
        "snapshot_selected_bytes": snapshot_bytes,
        "process_memory_bytes": _process_memory_bytes(),
        "hot_search_seconds": _percentiles(hot_samples),
        "cold_directory_load_seconds": _percentiles(cold_samples),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sizes", nargs="+", type=int, default=[1000, 10000, 50000])
    parser.add_argument("--repeats", type=int, default=3)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    reports = [run_benchmark(size=size, repeats=args.repeats) for size in args.sizes]
    output = json.dumps({"benchmarks": reports}, ensure_ascii=False, indent=2) + "\n"
    if args.output:
        args.output.write_text(output, encoding="utf-8")
    else:
        print(output, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
