"""Resuming a scene build instead of paying for it twice.

Each scene's description is an independent model call and a screenplay has
dozens of them, so a build killed at scene 60 of 68 used to discard all sixty.
Results are cached per scene, keyed by a hash of the exact input that produced
them, so the retry only pays for what is actually missing.
"""

from __future__ import annotations

import pytest

from novelvideo.cognee.pipeline import (
    SCENE_ENRICHMENT_CACHE_TYPE,
    SCENE_FALLBACK_FINGERPRINT,
    StoreSceneBuildCache,
    _ensure_directional_environment_prompt,
    enrich_scene_environments_batched,
    is_cacheable_scene_prompt,
    normalize_scene_environment_prompt,
    scene_enrichment_cache_key,
    scene_from_cache_payload,
    scene_to_cache_payload,
)
from novelvideo.models import NovelScene

# The model answers on one line; the contract validator rewrites a valid answer
# one section per line, so that normalised form is what gets stored and cached.
VALID_PROMPT = (
    "正面：主墙平整素雅，中央悬挂单位标识，下方为办公桌。"
    "左侧：浅色实体墙连接前后，靠前设磨砂玻璃木门。"
    "右侧：墙面延伸至后方，设大面积窗户与百叶帘。"
    "背面：与主墙相对的墙面完整平直，设嵌入式资料柜。"
)
STORED_PROMPT = normalize_scene_environment_prompt(VALID_PROMPT)

# What the code writes when it could not use the model's answer. It satisfies
# the 360 contract by construction, which is exactly why a validity check alone
# is not enough to decide whether a result is worth caching.
FALLBACK_PROMPT = _ensure_directional_environment_prompt(
    prompt="",
    scene_name="场景0",
    scene_type="interior",
    time_of_day="",
    context_lines=["▲场景0里灯亮着。"],
)


def _candidate(name: str, **overrides) -> dict:
    candidate = {
        "name": name,
        "aliases": [],
        "scene_type": "interior",
        "time_of_day": "",
        "interior": True,
        "episodes": [1],
        "characters": ["林默"],
        "context_lines": [f"▲{name}里灯亮着。"],
    }
    candidate.update(overrides)
    return candidate


class DictCache:
    def __init__(self) -> None:
        self.data: dict[str, dict[str, str]] = {}
        self.saves = 0

    def bucket(self, artifact_type: str) -> dict[str, str]:
        return self.data.get(artifact_type, {})

    async def get(self, artifact_type, cache_keys):
        bucket = self.data.setdefault(artifact_type, {})
        return {key: bucket[key] for key in cache_keys if key in bucket}

    async def save(self, artifact_type, results):
        self.saves += 1
        self.data.setdefault(artifact_type, {}).update(results)


class FakeAgent:
    """Answers every scene in a batch, unless told to fail."""

    def __init__(self, *, fail_on: set[str] | None = None) -> None:
        self.prompts: list[str] = []
        self.fail_on = fail_on or set()

    async def run(self, prompt: str):
        self.prompts.append(prompt)
        for name in self.fail_on:
            if f"### 场景：{name}\n" in prompt:
                raise RuntimeError(f"batch carrying {name} failed")

        from types import SimpleNamespace

        names = [
            line.removeprefix("### 场景：")
            for line in prompt.splitlines()
            if line.startswith("### 场景：")
        ]
        return SimpleNamespace(
            output=SimpleNamespace(
                scenes=[
                    SimpleNamespace(
                        name=name,
                        scene_type="interior",
                        environment_prompt=VALID_PROMPT,
                        description=f"{name} 的描述",
                    )
                    for name in names
                ]
            )
        )


def _scenes_named(prompts: list[str]) -> set[str]:
    return {
        line.removeprefix("### 场景：")
        for prompt in prompts
        for line in prompt.splitlines()
        if line.startswith("### 场景：")
    }


# ── the key ─────────────────────────────────────────────────────────────────


def test_identical_input_produces_the_same_key():
    assert scene_enrichment_cache_key(_candidate("办公室")) == (
        scene_enrichment_cache_key(_candidate("办公室"))
    )


@pytest.mark.parametrize(
    "overrides",
    [
        {"interior": False},
        {"scene_type": "exterior"},
        {"characters": ["林默", "张秉权"]},
        {"context_lines": ["▲另一段完全不同的原文。"]},
        {"aliases": ["主任办公室"]},
        # Read only by the per-scene retry, never by the batch. A scene can be
        # answered by either call and the result is stored under one key, so a
        # field either reads has to be able to invalidate it.
        {"time_of_day": "夜晚"},
        {"episodes": [2, 3]},
    ],
)
def test_every_input_the_call_depends_on_changes_the_key(overrides):
    """Anything left out of the key would replay a result built from other input."""
    assert scene_enrichment_cache_key(_candidate("办公室")) != (
        scene_enrichment_cache_key(_candidate("办公室", **overrides))
    )


def test_a_different_scene_name_changes_the_key():
    assert scene_enrichment_cache_key(_candidate("办公室")) != (
        scene_enrichment_cache_key(_candidate("会议室"))
    )


def test_the_synopsis_is_part_of_the_key():
    base = _candidate("办公室")
    assert scene_enrichment_cache_key(base) != scene_enrichment_cache_key(
        base, "换了一份梗概"
    )


def test_context_the_per_scene_retry_reads_still_changes_the_key():
    """The batch truncates at 24 lines, the per-scene retry at 50.

    The key follows the larger one. Keying on 24 meant a change at line 25
    left the key identical and replayed a result built from the old context.
    """
    base = [f"第{i}行" for i in range(50)]
    changed = base[:24] + ["改过的一行"] + base[25:]
    assert scene_enrichment_cache_key(
        _candidate("办公室", context_lines=base)
    ) != scene_enrichment_cache_key(_candidate("办公室", context_lines=changed))


def test_context_beyond_what_either_call_sees_does_not_change_the_key():
    """Neither call reads past 50 lines, so those must not force a rebuild."""
    base = [f"第{i}行" for i in range(50)]
    assert scene_enrichment_cache_key(
        _candidate("办公室", context_lines=base)
    ) == scene_enrichment_cache_key(
        _candidate("办公室", context_lines=base + ["第51行"])
    )


def test_the_contract_version_is_part_of_the_key(monkeypatch):
    """A bump must retire every stored result rather than mix contracts."""
    from novelvideo.cognee import pipeline

    before = scene_enrichment_cache_key(_candidate("办公室"))
    monkeypatch.setattr(pipeline, "SCENE_ENRICHMENT_CACHE_VERSION", 99)
    assert scene_enrichment_cache_key(_candidate("办公室")) != before


# ── the payload ─────────────────────────────────────────────────────────────


def test_a_payload_round_trips():
    scene = NovelScene(
        name="办公室",
        aliases=["主任办公室"],
        scene_type="interior",
        environment_prompt=VALID_PROMPT,
        description="描述",
    )
    restored = scene_from_cache_payload(scene_to_cache_payload(scene))
    assert restored.name == scene.name
    assert restored.aliases == scene.aliases
    assert restored.environment_prompt == VALID_PROMPT
    assert restored.description == "描述"


@pytest.mark.parametrize(
    "payload",
    [
        "not json at all",
        "[]",
        '{"name": "办公室", "environment_prompt": ""}',
        '{"name": "办公室", "environment_prompt": "正面：只有一个方向"}',
    ],
)
def test_an_unusable_payload_reads_as_a_miss(payload):
    """A cache must never publish what the live path would have rejected."""
    assert scene_from_cache_payload(payload) is None


# ── resuming ────────────────────────────────────────────────────────────────


async def test_a_cold_cache_calls_the_model_for_every_scene():
    candidates = [_candidate(f"场景{i}") for i in range(7)]
    cache = DictCache()
    agent = FakeAgent()

    scenes = await enrich_scene_environments_batched(
        candidates, enrichment_agent=agent, cache=cache
    )

    assert [scene.name for scene in scenes] == [c["name"] for c in candidates]
    assert _scenes_named(agent.prompts) == {c["name"] for c in candidates}
    assert len(cache.bucket(SCENE_ENRICHMENT_CACHE_TYPE)) == 7


async def test_a_second_run_over_unchanged_input_calls_no_model_at_all():
    candidates = [_candidate(f"场景{i}") for i in range(7)]
    cache = DictCache()
    await enrich_scene_environments_batched(
        candidates, enrichment_agent=FakeAgent(), cache=cache
    )

    second = FakeAgent()
    scenes = await enrich_scene_environments_batched(
        candidates, enrichment_agent=second, cache=cache
    )

    assert second.prompts == []
    assert [scene.name for scene in scenes] == [c["name"] for c in candidates]
    assert all(scene.environment_prompt == STORED_PROMPT for scene in scenes)


async def test_a_retry_only_pays_for_the_scenes_that_are_missing():
    """The point of the whole thing: an interrupted build resumes."""
    candidates = [_candidate(f"场景{i}") for i in range(7)]
    cache = DictCache()

    # First attempt: the batch carrying 场景5 fails, so it falls back per scene
    # — and that per-scene call fails too, leaving boilerplate uncached.
    async def failing_per_scene(**kwargs):
        # Exactly what the real per-scene path produces when it too fails.
        return NovelScene(
            name=kwargs["scene_name"],
            scene_type="interior",
            environment_prompt=_ensure_directional_environment_prompt(
                prompt="",
                scene_name=kwargs["scene_name"],
                scene_type="interior",
                time_of_day="",
                context_lines=list(kwargs.get("context_lines") or []),
            ),
        )

    from novelvideo.cognee import pipeline

    original = pipeline.enrich_scene_environment_from_context
    pipeline.enrich_scene_environment_from_context = failing_per_scene
    try:
        await enrich_scene_environments_batched(
            candidates, enrichment_agent=FakeAgent(fail_on={"场景5"}), cache=cache
        )
    finally:
        pipeline.enrich_scene_environment_from_context = original

    # 场景5 and 场景6 shared the failed batch; neither result is usable, so
    # neither was cached.
    assert len(cache.bucket(SCENE_ENRICHMENT_CACHE_TYPE)) == 5

    retry = FakeAgent()
    scenes = await enrich_scene_environments_batched(
        candidates, enrichment_agent=retry, cache=cache
    )

    assert _scenes_named(retry.prompts) == {"场景5", "场景6"}
    assert [scene.name for scene in scenes] == [c["name"] for c in candidates]
    assert all(scene.environment_prompt == STORED_PROMPT for scene in scenes)


async def test_results_are_written_per_batch_not_once_at_the_end():
    """A build killed halfway must keep everything it already paid for."""
    candidates = [_candidate(f"场景{i}") for i in range(12)]
    cache = DictCache()

    await enrich_scene_environments_batched(
        candidates, enrichment_agent=FakeAgent(), cache=cache
    )

    assert cache.saves > 1


async def test_a_failed_scene_is_never_cached():
    """Boilerplate must not be frozen in as the permanent answer."""
    candidates = [_candidate("场景0")]
    cache = DictCache()

    async def failing_per_scene(**kwargs):
        # Exactly what the real per-scene path produces when it too fails.
        return NovelScene(
            name=kwargs["scene_name"],
            scene_type="interior",
            environment_prompt=_ensure_directional_environment_prompt(
                prompt="",
                scene_name=kwargs["scene_name"],
                scene_type="interior",
                time_of_day="",
                context_lines=list(kwargs.get("context_lines") or []),
            ),
        )

    from novelvideo.cognee import pipeline

    original = pipeline.enrich_scene_environment_from_context
    pipeline.enrich_scene_environment_from_context = failing_per_scene
    try:
        await enrich_scene_environments_batched(
            candidates, enrichment_agent=FakeAgent(fail_on={"场景0"}), cache=cache
        )
    finally:
        pipeline.enrich_scene_environment_from_context = original

    assert cache.bucket(SCENE_ENRICHMENT_CACHE_TYPE) == {}


async def test_cached_scenes_are_reported_as_progress():
    """A resumed build must not look like it is stalled at zero."""
    candidates = [_candidate(f"场景{i}") for i in range(4)]
    cache = DictCache()
    await enrich_scene_environments_batched(
        candidates, enrichment_agent=FakeAgent(), cache=cache
    )

    seen: list[str] = []
    await enrich_scene_environments_batched(
        candidates,
        enrichment_agent=FakeAgent(),
        cache=cache,
        on_scene=lambda candidate, scene: seen.append(candidate["name"]),
    )
    assert seen == [c["name"] for c in candidates]


async def test_without_a_cache_nothing_changes():
    """The cache is optional; the legacy call path passes none."""
    candidates = [_candidate(f"场景{i}") for i in range(3)]
    agent = FakeAgent()
    scenes = await enrich_scene_environments_batched(candidates, enrichment_agent=agent)
    assert [scene.name for scene in scenes] == [c["name"] for c in candidates]
    assert _scenes_named(agent.prompts) == {c["name"] for c in candidates}


# ── the store behind the cache ──────────────────────────────────────────────


async def test_the_store_cache_survives_reopening_the_project(tmp_path):
    """Resuming happens in a new process, so the cache has to be on disk."""
    from novelvideo.sqlite_store import SQLiteStore

    state_dir = tmp_path / "user" / "project"
    state_dir.mkdir(parents=True)

    store = SQLiteStore(
        "user/project", output_dir=str(state_dir), state_dir=str(state_dir)
    )
    await store.initialize()
    try:
        await StoreSceneBuildCache(store).save(
            SCENE_ENRICHMENT_CACHE_TYPE, {"k1": "v1", "k2": "v2"}
        )
    finally:
        await store.close()

    reopened = SQLiteStore(
        "user/project", output_dir=str(state_dir), state_dir=str(state_dir)
    )
    await reopened.initialize()
    try:
        cache = StoreSceneBuildCache(reopened)
        assert await cache.get(
            SCENE_ENRICHMENT_CACHE_TYPE, ["k1", "k2", "missing"]
        ) == {"k1": "v1", "k2": "v2"}
    finally:
        await reopened.close()


async def test_the_store_cache_is_not_scoped_to_a_run(tmp_path):
    """A new run must reuse what an abandoned one finished."""
    from novelvideo.sqlite_store import SQLiteStore

    state_dir = tmp_path / "user" / "project"
    state_dir.mkdir(parents=True)
    store = SQLiteStore(
        "user/project", output_dir=str(state_dir), state_dir=str(state_dir)
    )
    await store.initialize()
    try:
        await store.save_analysis_item_cache(SCENE_ENRICHMENT_CACHE_TYPE, {"k": "v"})
        assert await store.get_analysis_item_cache(
            SCENE_ENRICHMENT_CACHE_TYPE, ["k"]
        ) == {"k": "v"}
        # A different artifact type must not see it.
        assert await store.get_analysis_item_cache("characters", ["k"]) == {}
    finally:
        await store.close()


async def test_the_store_cache_handles_more_keys_than_sqlite_allows_parameters(
    tmp_path,
):
    """A feature-length screenplay can exceed the host-parameter cap."""
    from novelvideo.sqlite_store import SQLiteStore

    state_dir = tmp_path / "user" / "project"
    state_dir.mkdir(parents=True)
    store = SQLiteStore(
        "user/project", output_dir=str(state_dir), state_dir=str(state_dir)
    )
    await store.initialize()
    try:
        entries = {f"key{i}": f"value{i}" for i in range(1500)}
        await store.save_analysis_item_cache(SCENE_ENRICHMENT_CACHE_TYPE, entries)
        found = await store.get_analysis_item_cache(
            SCENE_ENRICHMENT_CACHE_TYPE, list(entries)
        )
        assert found == entries
    finally:
        await store.close()


# ── end to end through the builder ──────────────────────────────────────────


async def test_build_scenes_structured_passes_the_projects_own_cache(
    tmp_path, monkeypatch
):
    """The wiring, not the mechanism: a builder with no cache resumes nothing."""
    import json

    from novelvideo import structured_builders
    from novelvideo.cognee import pipeline
    from novelvideo.knowledge_pipeline import (
        KNOWLEDGE_PIPELINE_KEY,
        KNOWLEDGE_PIPELINE_STRUCTURED,
    )
    from novelvideo.sqlite_store import SQLiteStore

    state_dir = tmp_path / "user" / "project"
    state_dir.mkdir(parents=True)
    (state_dir / "project_config.json").write_text(
        json.dumps(
            {
                KNOWLEDGE_PIPELINE_KEY: KNOWLEDGE_PIPELINE_STRUCTURED,
                "spine_template": "drama",
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    store = SQLiteStore(
        "user/project", output_dir=str(state_dir), state_dir=str(state_dir)
    )
    await store.initialize()
    await store.load_graph_state()
    store.save_novel_content("第1场 主任办公室 日 内\n▲张秉权翻看文件。\n")

    seen: dict = {}

    async def fake_extract(novel_text, on_progress=None, on_log=None, cache=None):
        seen["cache"] = cache
        return [
            NovelScene(
                name="主任办公室",
                scene_type="interior",
                environment_prompt=VALID_PROMPT,
            )
        ]

    monkeypatch.setattr(pipeline, "extract_scenes_from_script", fake_extract)
    try:
        result = await structured_builders.build_scenes_structured(store)
        assert result["added_scenes"] == 1
        assert isinstance(seen["cache"], StoreSceneBuildCache)
        # It has to be this project's store, not a detached one.
        await seen["cache"].save(SCENE_ENRICHMENT_CACHE_TYPE, {"probe": "value"})
        assert await store.get_analysis_item_cache(
            SCENE_ENRICHMENT_CACHE_TYPE, ["probe"]
        ) == {"probe": "value"}
    finally:
        await store.close()


# ── what may be cached ──────────────────────────────────────────────────────


def test_a_real_answer_is_cacheable():
    assert is_cacheable_scene_prompt(STORED_PROMPT)


def test_the_generated_fallback_is_never_cacheable():
    """It satisfies the contract by construction, so validity alone is no test.

    Caching it would freeze boilerplate in as the permanent answer: every later
    rebuild would replay it and never retry the model.
    """
    assert SCENE_FALLBACK_FINGERPRINT in FALLBACK_PROMPT
    assert not is_cacheable_scene_prompt(FALLBACK_PROMPT)


def test_a_stored_fallback_reads_back_as_a_miss():
    """Belt and braces: even if one were stored, it must not be replayed."""
    scene = NovelScene(
        name="场景0", scene_type="interior", environment_prompt=FALLBACK_PROMPT
    )
    assert scene_from_cache_payload(scene_to_cache_payload(scene)) is None


@pytest.mark.parametrize("prompt", ["", "   ", "正面：只有一个方向", "没有分区的描述"])
def test_an_invalid_prompt_is_never_cacheable(prompt):
    assert not is_cacheable_scene_prompt(prompt)


# ── the stage that used to cost the most ────────────────────────────────────


def _parsed(name, **overrides):
    from types import SimpleNamespace

    block = {
        "name": name,
        "time_of_day": "夜",
        "interior": True,
        "episodes": [1],
        "characters": ["林默"],
        "context_lines": [f"▲{name}里灯亮着。"],
    }
    block.update(overrides)
    return SimpleNamespace(**block)


def test_a_parsed_block_becomes_a_candidate_with_no_model_call():
    """A standard heading already states everything a candidate needs."""
    from novelvideo.cognee.pipeline import _candidate_from_parsed_block

    candidate = _candidate_from_parsed_block(_parsed("主任办公室", interior=True))
    assert candidate["name"] == "主任办公室"
    assert candidate["scene_type"] == "interior"
    assert candidate["time_of_day"] == "夜晚"
    assert candidate["characters"] == ["林默"]
    assert candidate["context_lines"] == ["▲主任办公室里灯亮着。"]


def test_an_exterior_block_keeps_its_type():
    from novelvideo.cognee.pipeline import _candidate_from_parsed_block

    assert (
        _candidate_from_parsed_block(_parsed("郑家别墅外", interior=False))["scene_type"]
        == "exterior"
    )


# ── the recall guard ────────────────────────────────────────────────────────


def test_a_faithful_normalization_is_accepted():
    from novelvideo.cognee.pipeline import _scene_recall_is_covered

    covered, gap = _scene_recall_is_covered(
        [{"name": "主任办公室", "aliases": []}, {"name": "楼梯间", "aliases": []}],
        [_parsed("主任办公室"), _parsed("楼梯间")],
    )
    assert covered, gap


def test_a_location_kept_only_as_an_alias_still_counts_as_covered():
    """Folding a spelling into an alias is the normalizer working, not a loss."""
    from novelvideo.cognee.pipeline import _scene_recall_is_covered

    covered, _ = _scene_recall_is_covered(
        [{"name": "主任办公室", "aliases": ["主任的办公室"]}],
        [_parsed("主任办公室"), _parsed("主任的办公室")],
    )
    assert covered


def test_a_heading_marker_difference_alone_is_not_a_loss():
    from novelvideo.cognee.pipeline import _scene_recall_is_covered

    covered, _ = _scene_recall_is_covered(
        [{"name": "演武场外墙", "aliases": []}],
        [_parsed("演武场外墙·夜")],
    )
    assert covered


def test_a_dropped_location_trips_the_guard():
    """The one thing the guard exists to catch."""
    from novelvideo.cognee.pipeline import _scene_recall_is_covered

    covered, gap = _scene_recall_is_covered(
        [{"name": "主任办公室", "aliases": []}],
        [_parsed("主任办公室"), _parsed("郑氏集团实验室")],
    )
    assert not covered
    assert "郑氏集团实验室" in gap


def test_fewer_scenes_alone_no_longer_trips_the_guard():
    """The old test compared counts, so a correct merge read as lost recall.

    That rejection cost a per-block model call for every scene in the script —
    on a real screenplay, more than half the build's wall clock — to rebuild a
    catalogue the normalizer had already produced.
    """
    from novelvideo.cognee.pipeline import _scene_recall_is_covered

    normalized = [{"name": "主任办公室", "aliases": ["主任办公室·夜"]}]
    parsed = [_parsed("主任办公室"), _parsed("主任办公室·夜")]
    assert len(normalized) < len(parsed)
    covered, _ = _scene_recall_is_covered(normalized, parsed)
    assert covered


# ── the screenplay normalizer, cached by source ─────────────────────────────


async def test_the_normalizer_runs_once_per_source_text(monkeypatch):
    """Not for its own few seconds, but for what its variance costs downstream.

    Its answer differs between runs, so left uncached it reshuffles the
    candidates — and every scene-description key derived from them misses.
    """
    from novelvideo.cognee import pipeline

    calls = {"n": 0}

    async def fake_normalize(_text):
        calls["n"] += 1
        return ["block"]

    monkeypatch.setattr(pipeline, "normalize_screenplay_scenes", fake_normalize)
    monkeypatch.setattr(
        pipeline,
        "_scene_candidates_from_normalized_blocks",
        lambda _blocks: [_candidate("主任办公室")],
    )

    cache = DictCache()
    first = await pipeline._normalized_scene_blocks_cached("剧本正文", cache)
    second = await pipeline._normalized_scene_blocks_cached("剧本正文", cache)

    assert calls["n"] == 1
    assert first == second


async def test_changed_source_text_runs_the_normalizer_again(monkeypatch):
    from novelvideo.cognee import pipeline

    calls = {"n": 0}

    async def fake_normalize(_text):
        calls["n"] += 1
        return ["block"]

    monkeypatch.setattr(pipeline, "normalize_screenplay_scenes", fake_normalize)
    monkeypatch.setattr(
        pipeline,
        "_scene_candidates_from_normalized_blocks",
        lambda _blocks: [_candidate("主任办公室")],
    )

    cache = DictCache()
    await pipeline._normalized_scene_blocks_cached("剧本正文", cache)
    await pipeline._normalized_scene_blocks_cached("改过的剧本正文", cache)
    assert calls["n"] == 2


async def test_an_empty_normalization_is_not_cached(monkeypatch):
    """Nothing produced by a call that came back empty is worth replaying."""
    from novelvideo.cognee import pipeline

    calls = {"n": 0}

    async def fake_normalize(_text):
        calls["n"] += 1
        return []

    monkeypatch.setattr(pipeline, "normalize_screenplay_scenes", fake_normalize)
    monkeypatch.setattr(
        pipeline, "_scene_candidates_from_normalized_blocks", lambda _blocks: []
    )

    cache = DictCache()
    await pipeline._normalized_scene_blocks_cached("剧本正文", cache)
    await pipeline._normalized_scene_blocks_cached("剧本正文", cache)
    assert calls["n"] == 2
