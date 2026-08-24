"""structured_v1 project-level builds: characters, scenes, props.

The rules under test are the conservative ones. A character name is at once a
SQLite primary key, a REST identifier and an asset directory name, so the
merging rules must refuse to guess, and evidence must be verifiable against the
source or the candidate never reaches the table.
"""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from novelvideo.knowledge_pipeline import KNOWLEDGE_PIPELINE_KEY, KNOWLEDGE_PIPELINE_STRUCTURED
from novelvideo.story_analysis import SourceChunk, chunk_source_text
from novelvideo.structured_extraction import (
    CharacterCandidate,
    CharacterEvidence,
    ChunkCharacterOutput,
    extract_characters_from_chunks,
    find_explicit_aliases,
    is_generic_address,
    merge_character_candidates,
    normalize_character_name,
    verify_evidence,
)

NARRATED_TEXT = """第一章 归来

林默回到阔别十年的故乡。街道还是老样子。
他的母亲在门口等他。

第二章 旧友

林默又名小默，村里人都这么叫他。
他在巷口遇见了苏晴。

第三章 真相

苏晴告诉林默一个秘密。
他的母亲听完沉默了很久。
"""


def _padded(body: str) -> str:
    """Pad a chapter past the packing target so it stays its own chunk."""
    return body + "\n" + "闲笔叙述。" * 640 + "\n"


NARRATED_MULTI = (
    "第一章 归来\n\n" + _padded("林默回到阔别十年的故乡。他的母亲在门口等他。")
    + "\n第二章 旧友\n\n" + _padded("林默又名小默，村里人都这么叫他。他在巷口遇见了苏晴。")
    + "\n第三章 真相\n\n" + _padded("苏晴告诉林默一个秘密。他的母亲听完沉默了很久。")
)


def _chunk(text: str, *, chunk_id="c0", start=0) -> SourceChunk:
    return SourceChunk(
        chunk_id=chunk_id,
        chunk_index=0,
        section_type="chapter",
        section_label="第一章",
        source_start=start,
        source_end=start + len(text),
        text=text,
    )


def _candidate(name, *, quotes=(), aliases=(), gender="", description=""):
    return CharacterCandidate(
        name=name,
        aliases=list(aliases),
        gender=gender,
        description=description,
        evidence=[CharacterEvidence(quote=quote) for quote in quotes],
    )


# ── name normalization ──────────────────────────────────────────────────────


def test_normalize_strips_punctuation_noise_without_altering_the_name():
    assert normalize_character_name("　林默：") == "林默"
    assert normalize_character_name("「苏晴」") == "苏晴"
    assert normalize_character_name("林 默") == "林 默"


def test_titles_and_kinship_terms_are_generic():
    for term in ("母亲", "陛下", "医生", "他", "少年"):
        assert is_generic_address(term)
    assert not is_generic_address("林默")


# ── evidence verification ───────────────────────────────────────────────────


def test_evidence_resolves_to_absolute_source_offsets():
    chunk = _chunk("林默回到故乡。", start=100)
    span = verify_evidence("林默回到故乡。", chunk)
    assert span == (100, 100 + len("林默回到故乡。"))


def test_evidence_not_present_in_the_chunk_is_rejected():
    """This check is what stops an invented character reaching the table."""
    chunk = _chunk("林默回到故乡。")
    assert verify_evidence("林默其实是皇帝的私生子。", chunk) is None


def test_evidence_tolerates_whitespace_the_model_normalized():
    chunk = _chunk("林默  回到   故乡。")
    assert verify_evidence("林默 回到 故乡。", chunk) is not None


def test_empty_quote_is_rejected():
    assert verify_evidence("   ", _chunk("林默回到故乡。")) is None


# ── explicit alias detection ────────────────────────────────────────────────


def test_explicit_alias_statements_are_detected():
    assert ("林默", "小默") in find_explicit_aliases(
        "林默又名小默，村里人都这么叫他。", ["林默", "小默"]
    )
    assert ("萧玦", "陛下") in find_explicit_aliases("萧玦人称陛下。", ["萧玦", "陛下"])


def test_an_alias_statement_mid_sentence_does_not_swallow_the_prose():
    """The patterns take 2-6 characters either side and cannot see where a name
    begins, so in running prose the window opens mid-sentence."""
    assert find_explicit_aliases(
        "大家都知道林默又名小默，昨天回家。", ["林默", "小默"]
    ) == {("林默", "小默")}
    assert find_explicit_aliases("据说林默也叫小默。", ["林默", "小默"]) == {
        ("林默", "小默")
    }
    # And forwards, where nothing punctuates the end of the second name.
    assert find_explicit_aliases("林默又名小默昨天回家", ["林默", "小默"]) == {
        ("林默", "小默")
    }


def test_a_pair_neither_side_of_which_was_extracted_is_dropped():
    """An unresolved capture is prose, not a name.

    Left in, it reaches the character table as an alias the text never stated —
    "家都知道林默" was being persisted as one.
    """
    assert find_explicit_aliases("大家都知道林默又名小默。") == set()
    assert find_explicit_aliases("大家都知道林默又名小默。", ["小默"]) == set()


def test_an_invented_name_cannot_ride_in_on_a_real_quote():
    """The module promises a hallucinated name has no route into the table.

    Verifying the quote alone did not deliver that: a real sentence with a name
    attached that appears nowhere in the source was accepted.
    """
    chunk = _chunk("林默回到了家", chunk_id="c0", start=0)
    invented = ChunkCharacterOutput(
        characters=[
            CharacterCandidate(
                name="王五", evidence=[CharacterEvidence(quote="林默回到了家")]
            )
        ]
    )
    assert merge_character_candidates([(chunk, invented)]) == []


def test_a_name_the_source_writes_elsewhere_is_still_accepted():
    """Attestation is against the source, not the chunk.

    A character is named once and called 她 or 郑太 for pages after; requiring
    the name in the chunk that mentions her would drop exactly the candidates
    cross-chunk appellation resolution depends on.
    """
    named = _chunk("郑玉琴走进客厅。", chunk_id="c0", start=0)
    pronoun = _chunk("郑太点了点头。", chunk_id="c1", start=8)
    outcomes = [
        (
            named,
            ChunkCharacterOutput(
                characters=[
                    CharacterCandidate(
                        name="郑玉琴",
                        evidence=[CharacterEvidence(quote="郑玉琴走进客厅。")],
                    )
                ]
            ),
        ),
        (
            pronoun,
            ChunkCharacterOutput(
                characters=[
                    CharacterCandidate(
                        name="郑玉琴",
                        evidence=[CharacterEvidence(quote="郑太点了点头。")],
                    )
                ]
            ),
        ),
    ]
    assert [item.name for item in merge_character_candidates(outcomes)] == ["郑玉琴"]


def test_a_name_only_the_scene_heading_lists_is_accepted():
    """A screenplay names its cast in the heading; the body may only say 他."""
    chunk = SourceChunk(
        chunk_id="c0",
        chunk_index=0,
        section_type="scene",
        section_label="第1场",
        source_start=0,
        source_end=5,
        text="他推开门。",
        characters=["林默"],
    )
    outcomes = [
        (
            chunk,
            ChunkCharacterOutput(
                characters=[
                    CharacterCandidate(
                        name="林默", evidence=[CharacterEvidence(quote="他推开门。")]
                    )
                ]
            ),
        )
    ]
    assert [item.name for item in merge_character_candidates(outcomes)] == ["林默"]


def test_two_names_merely_appearing_together_is_not_an_alias():
    """Co-occurrence is not identity — that is how wrong merges happen."""
    assert find_explicit_aliases("林默看着苏晴，两人都没说话。") == set()


# ── merging ─────────────────────────────────────────────────────────────────


def test_identical_names_across_chunks_merge():
    text_a = "林默回到故乡。"
    text_b = "林默走进屋子。"
    outcomes = [
        (
            _chunk(text_a, chunk_id="c0"),
            ChunkCharacterOutput(characters=[_candidate("林默", quotes=[text_a])]),
        ),
        (
            _chunk(text_b, chunk_id="c1", start=50),
            ChunkCharacterOutput(characters=[_candidate("林默", quotes=[text_b])]),
        ),
    ]
    merged = merge_character_candidates(outcomes)
    assert [item.name for item in merged] == ["林默"]
    assert len(merged[0].evidence) == 2
    assert merged[0].chunk_ids == {"c0", "c1"}


def test_candidates_without_verifiable_evidence_are_dropped():
    text = "林默回到故乡。"
    outcomes = [
        (
            _chunk(text),
            ChunkCharacterOutput(
                characters=[
                    _candidate("林默", quotes=[text]),
                    _candidate("皇帝", quotes=["林默是皇帝的儿子。"]),
                ]
            ),
        )
    ]
    merged = merge_character_candidates(outcomes)
    assert [item.name for item in merged] == ["林默"]


def test_generic_address_terms_never_become_characters():
    text = "他的母亲在门口等他。"
    outcomes = [
        (
            _chunk(text),
            ChunkCharacterOutput(characters=[_candidate("母亲", quotes=[text])]),
        )
    ]
    assert merge_character_candidates(outcomes) == []


def test_explicitly_stated_alias_merges_into_one_character():
    text = "林默又名小默，村里人都这么叫他。"
    outcomes = [
        (
            _chunk(text),
            ChunkCharacterOutput(
                characters=[
                    _candidate("林默", quotes=[text]),
                    _candidate("小默", quotes=[text]),
                ]
            ),
        )
    ]
    merged = merge_character_candidates(outcomes)
    assert len(merged) == 1
    assert merged[0].name == "林默"
    assert "小默" in merged[0].aliases


def test_model_proposed_alias_without_textual_support_stays_a_suggestion():
    """A wrong merge destroys data silently; a wrong split is a visible duplicate."""
    text = "林默看着苏晴。"
    outcomes = [
        (
            _chunk(text),
            ChunkCharacterOutput(
                characters=[_candidate("林默", quotes=[text], aliases=["苏晴"])]
            ),
        )
    ]
    merged = merge_character_candidates(outcomes)
    assert merged[0].aliases == set()
    assert "苏晴" in merged[0].ambiguous_with


def test_same_generic_term_in_two_chunks_does_not_merge_into_one_person():
    """"母亲" in chapter one and chapter three need not be the same woman."""
    outcomes = [
        (
            _chunk("他的母亲在门口等他。", chunk_id="c0"),
            ChunkCharacterOutput(
                characters=[_candidate("母亲", quotes=["他的母亲在门口等他。"])]
            ),
        ),
        (
            _chunk("他的母亲听完沉默了。", chunk_id="c1", start=80),
            ChunkCharacterOutput(
                characters=[_candidate("母亲", quotes=["他的母亲听完沉默了。"])]
            ),
        ),
    ]
    assert merge_character_candidates(outcomes) == []


def test_alias_merge_keeps_the_better_evidenced_name_as_primary():
    alias_text = "林默又名小默。"
    outcomes = [
        (
            _chunk(alias_text, chunk_id="c0"),
            ChunkCharacterOutput(
                characters=[
                    _candidate("小默", quotes=[alias_text]),
                    _candidate("林默", quotes=[alias_text]),
                ]
            ),
        ),
        (
            _chunk("林默走进屋子。", chunk_id="c1", start=60),
            ChunkCharacterOutput(
                characters=[_candidate("林默", quotes=["林默走进屋子。"])]
            ),
        ),
    ]
    merged = merge_character_candidates(outcomes)
    assert len(merged) == 1
    assert merged[0].name == "林默"
    assert merged[0].aliases == {"小默"}


# ── extraction over chunks ──────────────────────────────────────────────────


class FakeAgent:
    """Returns a scripted output per chunk label, or raises for one of them."""

    def __init__(self, by_label, fail_labels=()):
        self.by_label = by_label
        self.fail_labels = set(fail_labels)
        self.seen = []

    async def run(self, prompt: str):
        label = next(
            (key for key in list(self.by_label) + list(self.fail_labels) if key in prompt),
            "",
        )
        self.seen.append(label)
        if label in self.fail_labels:
            raise RuntimeError("boom")
        return SimpleNamespace(
            output=self.by_label.get(label, ChunkCharacterOutput())
        )


async def test_extraction_runs_over_every_chunk():
    chunks = chunk_source_text(NARRATED_MULTI, "narrated")
    agent = FakeAgent(
        {
            "第一章": ChunkCharacterOutput(
                characters=[_candidate("林默", quotes=["林默回到阔别十年的故乡。"])]
            ),
            "第二章": ChunkCharacterOutput(
                characters=[_candidate("苏晴", quotes=["他在巷口遇见了苏晴。"])]
            ),
        }
    )
    merged, _ = await extract_characters_from_chunks(chunks, agent=agent, adjudicate=False)
    assert {item.name for item in merged} == {"林默", "苏晴"}


async def test_one_failing_chunk_does_not_discard_the_others():
    """A single unparseable scene must not take the whole build down with it."""
    chunks = chunk_source_text(NARRATED_MULTI, "narrated")
    agent = FakeAgent(
        {
            "第一章": ChunkCharacterOutput(
                characters=[_candidate("林默", quotes=["林默回到阔别十年的故乡。"])]
            )
        },
        fail_labels=["第二章"],
    )
    logs: list[str] = []
    merged, failures = await extract_characters_from_chunks(
        chunks, agent=agent, on_log=logs.append, adjudicate=False
    )
    assert [item.name for item in merged] == ["林默"]
    assert any("失败" in line for line in logs)
    # The failure is reported back so the caller can persist it against the run.
    assert [chunk.section_label for chunk, _ in failures]


async def test_extraction_is_bounded_but_not_serial():
    """Chunks are independent, so they must not run one at a time."""
    import asyncio

    in_flight = 0
    peak = 0

    class SlowAgent:
        async def run(self, prompt: str):
            nonlocal in_flight, peak
            in_flight += 1
            peak = max(peak, in_flight)
            await asyncio.sleep(0.01)
            in_flight -= 1
            return SimpleNamespace(output=ChunkCharacterOutput())

    chunks = [
        _chunk(f"片段{index}", chunk_id=f"c{index}", start=index * 10)
        for index in range(12)
    ]
    await extract_characters_from_chunks(
        chunks, agent=SlowAgent(), concurrency=4, adjudicate=False
    )
    assert peak > 1
    assert peak <= 4


# ── builders ────────────────────────────────────────────────────────────────


@pytest.fixture
async def structured_store(tmp_path):
    from novelvideo.sqlite_store import SQLiteStore

    state_dir = tmp_path / "user" / "structured"
    state_dir.mkdir(parents=True)
    (state_dir / "project_config.json").write_text(
        json.dumps({KNOWLEDGE_PIPELINE_KEY: KNOWLEDGE_PIPELINE_STRUCTURED, "spine_template": "narrated"}),
        encoding="utf-8",
    )
    (state_dir / "novel.txt").write_text(NARRATED_MULTI, encoding="utf-8")
    store = SQLiteStore(
        "user/structured", output_dir=str(state_dir), state_dir=str(state_dir)
    )
    await store.initialize()
    await store.load_graph_state()
    try:
        yield store, state_dir
    finally:
        await store.close()


async def test_atomic_publish_leaves_nothing_behind_on_failure(structured_store):
    """add_character commits per row; a build must publish all or nothing."""
    from novelvideo.cognee.pipeline import NovelCharacter

    store, _ = structured_store
    db = await store._ensure_db()
    original_execute = db.execute
    calls = {"n": 0}

    async def fail_on_second_insert(sql, *args, **kwargs):
        if sql.strip().startswith("INSERT INTO characters"):
            calls["n"] += 1
            if calls["n"] == 2:
                raise RuntimeError("boom")
        return await original_execute(sql, *args, **kwargs)

    db.execute = fail_on_second_insert
    try:
        with pytest.raises(RuntimeError):
            await store.add_characters_atomic(
                [NovelCharacter(name="林默"), NovelCharacter(name="苏晴")]
            )
    finally:
        db.execute = original_execute

    # The first insert must not survive the second one's failure.
    assert await store.list_characters() == []


async def test_atomic_publish_never_overwrites_an_existing_character(structured_store):
    """An existing character may already carry portraits, identities and voice."""
    from novelvideo.cognee.pipeline import NovelCharacter

    store, _ = structured_store
    await store.add_character(
        NovelCharacter(name="林默", description="用户编辑过的描述", face_prompt="portrait")
    )

    added = await store.add_characters_atomic(
        [NovelCharacter(name="林默", description="重扫生成的描述"), NovelCharacter(name="苏晴")]
    )

    assert added == ["苏晴"]
    assert store.get_character("林默").description == "用户编辑过的描述"
    assert store.get_character("林默").face_prompt == "portrait"


async def test_narrated_scene_build_defers_instead_of_guessing(structured_store):
    """Narrated source has no scene headings; a full sweep would invent places."""
    from novelvideo.structured_builders import build_scenes_structured

    store, _ = structured_store
    result = await build_scenes_structured(store)
    assert result["mode"] == "episode_on_demand"
    assert result["added_scenes"] == 0
    assert await store.list_scenes() == []


async def test_prop_build_reports_deferral_rather_than_a_silent_zero(structured_store):
    """"0 props" must not read as "the analysis found nothing"."""
    from novelvideo.structured_builders import build_props_structured

    store, _ = structured_store
    result = await build_props_structured(store)
    assert result["props"] == 0
    assert result["mode"] == "episode_on_demand"
    assert result["message"]


async def test_character_build_publishes_and_records_evidence(
    structured_store, monkeypatch
):
    from novelvideo import structured_builders
    from novelvideo.structured_ingest import ingest_source_text_structured

    store, state_dir = structured_store
    source = state_dir / "source.txt"
    source.write_text(NARRATED_MULTI, encoding="utf-8")
    run = await ingest_source_text_structured(
        store, str(source), spine_template="narrated"
    )

    agent = FakeAgent(
        {
            "第一章": ChunkCharacterOutput(
                characters=[_candidate("林默", quotes=["林默回到阔别十年的故乡。"])]
            )
        }
    )

    real_extract = extract_characters_from_chunks

    async def fake_extract(chunks, **kwargs):
        kwargs.pop("agent", None)
        kwargs.setdefault("adjudicate", False)
        return await real_extract(chunks, agent=agent, **kwargs)

    monkeypatch.setattr(
        "novelvideo.structured_extraction.extract_characters_from_chunks",
        fake_extract,
    )

    added = await structured_builders.build_characters_structured(store)
    assert added == ["林默"]

    evidence = await store.list_entity_evidence("character", "林默")
    assert evidence
    assert evidence[0]["run_id"] == run["run_id"]
    quoted = NARRATED_MULTI[
        evidence[0]["source_start"] : evidence[0]["source_end"]
    ]
    assert quoted == "林默回到阔别十年的故乡。"


async def test_character_build_never_touches_cognee(structured_store, monkeypatch):
    import cognee

    from novelvideo import structured_builders

    def _boom(*args, **kwargs):
        raise AssertionError("structured character build must not touch Cognee")

    for name in ("add", "cognify", "memify", "search"):
        monkeypatch.setattr(cognee, name, _boom, raising=False)

    store, _ = structured_store
    agent = FakeAgent({})

    real_extract = extract_characters_from_chunks

    async def fake_extract(chunks, **kwargs):
        kwargs.pop("agent", None)
        kwargs.setdefault("adjudicate", False)
        return await real_extract(chunks, agent=agent, **kwargs)

    monkeypatch.setattr(
        "novelvideo.structured_extraction.extract_characters_from_chunks",
        fake_extract,
    )
    await structured_builders.build_characters_structured(store)


# ── resume, chunk bounds and concurrency defaults ───────────────────────────


async def test_completed_chunks_are_replayed_instead_of_re_billed(
    structured_store, monkeypatch
):
    """A retry or a second click must not pay for every chunk again."""
    from novelvideo import structured_builders
    from novelvideo.structured_extraction import extract_characters_from_chunks
    from novelvideo.structured_ingest import ingest_source_text_structured

    store, state_dir = structured_store
    source = state_dir / "source.txt"
    source.write_text(NARRATED_MULTI, encoding="utf-8")
    await ingest_source_text_structured(store, str(source), spine_template="narrated")

    outputs = {
        "第一章": ChunkCharacterOutput(
            characters=[_candidate("林默", quotes=["林默回到阔别十年的故乡。"])]
        ),
        "第二章": ChunkCharacterOutput(
            characters=[_candidate("苏晴", quotes=["他在巷口遇见了苏晴。"])]
        ),
    }
    agent = FakeAgent(outputs)
    real_extract = extract_characters_from_chunks

    async def fake_extract(chunks, **kwargs):
        kwargs.pop("agent", None)
        kwargs.setdefault("adjudicate", False)
        return await real_extract(chunks, agent=agent, **kwargs)

    monkeypatch.setattr(
        "novelvideo.structured_extraction.extract_characters_from_chunks", fake_extract
    )

    first = await structured_builders.build_characters_structured(store)
    assert set(first) == {"林默", "苏晴"}
    first_calls = len(agent.seen)
    assert first_calls > 0

    agent.seen.clear()
    second = await structured_builders.build_characters_structured(store)

    # Everything was replayed from stored results, so no chunk went to the model.
    assert agent.seen == []
    # And the characters are unchanged: they already exist, so nothing is added.
    assert second == []


async def test_a_failed_chunk_leaves_the_run_partial(structured_store, monkeypatch):
    """A partial run must not look finished to the next build."""
    from novelvideo import structured_builders
    from novelvideo.structured_extraction import extract_characters_from_chunks
    from novelvideo.structured_ingest import ingest_source_text_structured

    store, state_dir = structured_store
    source = state_dir / "source.txt"
    source.write_text(NARRATED_MULTI, encoding="utf-8")
    run = await ingest_source_text_structured(
        store, str(source), spine_template="narrated"
    )

    agent = FakeAgent(
        {
            "第一章": ChunkCharacterOutput(
                characters=[_candidate("林默", quotes=["林默回到阔别十年的故乡。"])]
            )
        },
        fail_labels=["第二章"],
    )
    real_extract = extract_characters_from_chunks

    async def fake_extract(chunks, **kwargs):
        kwargs.pop("agent", None)
        kwargs.setdefault("adjudicate", False)
        return await real_extract(chunks, agent=agent, **kwargs)

    monkeypatch.setattr(
        "novelvideo.structured_extraction.extract_characters_from_chunks", fake_extract
    )
    await structured_builders.build_characters_structured(store)

    failed = await store.list_analysis_chunks(run["run_id"], status="failed")
    assert failed, "the failing chunk was not recorded"
    from novelvideo.story_analysis import source_sha256
    from novelvideo.structured_ingest import (
        STRUCTURED_PIPELINE_VERSION,
        STRUCTURED_SCHEMA_VERSION,
    )

    stored = await store.get_reusable_analysis_run(
        source_sha256=source_sha256(NARRATED_MULTI),
        schema_version=STRUCTURED_SCHEMA_VERSION,
        pipeline_version=STRUCTURED_PIPELINE_VERSION,
        spine_template="narrated",
    )
    assert stored["status"] == "partial"


async def test_a_partial_run_never_stores_its_cast_as_the_final_result(
    structured_store, monkeypatch
):
    """The replay guard only checks that nothing is still pending.

    So once the failed chunks succeed on a later attempt, an artifact written by
    the partial run would be replayed instead of the freshly built cast — and it
    is missing exactly the characters those chunks were carrying.
    """
    from novelvideo import structured_builders
    from novelvideo.structured_extraction import extract_characters_from_chunks
    from novelvideo.structured_ingest import ingest_source_text_structured

    store, state_dir = structured_store
    source = state_dir / "source.txt"
    source.write_text(NARRATED_MULTI, encoding="utf-8")
    run = await ingest_source_text_structured(
        store, str(source), spine_template="narrated"
    )

    agent = FakeAgent(
        {
            "第一章": ChunkCharacterOutput(
                characters=[_candidate("林默", quotes=["林默回到阔别十年的故乡。"])]
            )
        },
        fail_labels=["第二章"],
    )
    real_extract = extract_characters_from_chunks

    async def fake_extract(chunks, **kwargs):
        kwargs.pop("agent", None)
        kwargs.setdefault("adjudicate", False)
        return await real_extract(chunks, agent=agent, **kwargs)

    monkeypatch.setattr(
        "novelvideo.structured_extraction.extract_characters_from_chunks", fake_extract
    )
    await structured_builders.build_characters_structured(store)

    assert await store.get_analysis_artifact(run["run_id"], "characters") == ""


def test_an_oversized_chapter_is_split_further():
    """A chapter boundary says where to cut, not how big the piece may be."""
    text = "第一章 归来\n\n" + "林默回到故乡。" * 3000 + "\n\n第二章 旧友\n\n短章节。\n"
    chunks = chunk_source_text(text, "narrated")

    assert len(chunks) > 2
    assert max(len(chunk.text) for chunk in chunks) <= 6000
    for chunk in chunks:
        assert text[chunk.source_start : chunk.source_end] == chunk.text
    assert [chunk.chunk_index for chunk in chunks] == list(range(len(chunks)))


def test_oversized_parts_keep_a_recognisable_section_label():
    text = "第一章 归来\n\n" + "林默回到故乡。" * 3000
    chunks = chunk_source_text(text, "narrated")
    assert all(chunk.chunk_id.startswith("chapter-0000-p") for chunk in chunks)
    assert all("第1章" in chunk.section_label for chunk in chunks)


def test_short_chapters_are_packed_into_one_call():
    """A call costs the same round trip whether it carries 300 or 3000 chars."""
    chunks = chunk_source_text(NARRATED_TEXT, "narrated")
    assert len(chunks) == 1
    assert chunks[0].source_start == 0
    assert chunks[0].text == NARRATED_TEXT


def test_chapters_past_the_target_stay_separate():
    chunks = chunk_source_text(NARRATED_MULTI, "narrated")
    assert len(chunks) == 3
    for chunk in chunks:
        assert NARRATED_MULTI[chunk.source_start : chunk.source_end] == chunk.text


def test_llm_concurrency_defaults_to_the_project_baseline(monkeypatch):
    """A second pool running deeper than COGNEE_LLM_CONCURRENCY would trip the
    same gateway limits that setting exists to avoid."""
    from novelvideo.utils.bounded_concurrency import default_llm_concurrency

    monkeypatch.delenv("STRUCTURED_LLM_CONCURRENCY", raising=False)
    assert default_llm_concurrency() == 2

    monkeypatch.setenv("STRUCTURED_LLM_CONCURRENCY", "5")
    assert default_llm_concurrency() == 5

    monkeypatch.setenv("STRUCTURED_LLM_CONCURRENCY", "0")
    with pytest.raises(ValueError):
        default_llm_concurrency()


async def test_reuse_key_separates_drama_from_narrated(structured_store, tmp_path):
    """The same text chunked two ways must not share a chunk plan."""
    from novelvideo.structured_ingest import ingest_source_text_structured

    store, state_dir = structured_store
    source = state_dir / "source.txt"
    source.write_text(NARRATED_MULTI, encoding="utf-8")

    narrated = await ingest_source_text_structured(
        store, str(source), spine_template="narrated"
    )
    again = await ingest_source_text_structured(
        store, str(source), spine_template="narrated"
    )
    assert again["run_id"] == narrated["run_id"]

    # Same bytes, different spine: a fresh plan, not the chapter-based one.
    drama = await ingest_source_text_structured(
        store, str(source), spine_template=""
    )
    assert drama["run_id"] != narrated["run_id"]


async def test_evidence_is_backfilled_when_the_characters_already_exist(
    structured_store, monkeypatch
):
    """Publishing characters and writing evidence are two steps.

    If the first succeeds and the second fails, a retry finds the characters
    already present. Keying evidence on "newly added" would leave them without
    provenance forever.
    """
    from novelvideo import structured_builders
    from novelvideo.cognee.pipeline import NovelCharacter
    from novelvideo.structured_extraction import extract_characters_from_chunks
    from novelvideo.structured_ingest import ingest_source_text_structured

    store, state_dir = structured_store
    source = state_dir / "source.txt"
    source.write_text(NARRATED_MULTI, encoding="utf-8")
    await ingest_source_text_structured(store, str(source), spine_template="narrated")

    # Stand in for a previous build that published the character but died
    # before its evidence landed.
    await store.add_character(NovelCharacter(name="林默"))
    assert await store.list_entity_evidence("character", "林默") == []

    agent = FakeAgent(
        {
            "第一章": ChunkCharacterOutput(
                characters=[_candidate("林默", quotes=["林默回到阔别十年的故乡。"])]
            )
        }
    )
    real_extract = extract_characters_from_chunks

    async def fake_extract(chunks, **kwargs):
        kwargs.pop("agent", None)
        kwargs.setdefault("adjudicate", False)
        return await real_extract(chunks, agent=agent, **kwargs)

    monkeypatch.setattr(
        "novelvideo.structured_extraction.extract_characters_from_chunks", fake_extract
    )

    added = await structured_builders.build_characters_structured(store)
    assert added == []  # nothing new to publish
    assert await store.list_entity_evidence("character", "林默"), (
        "evidence was never backfilled for an already-published character"
    )


async def test_a_run_with_no_characters_is_still_closed_out(
    structured_store, monkeypatch
):
    """A run left at "pending" tells the next build nothing about what remains."""
    from novelvideo import structured_builders
    from novelvideo.story_analysis import source_sha256
    from novelvideo.structured_extraction import extract_characters_from_chunks
    from novelvideo.structured_ingest import (
        STRUCTURED_PIPELINE_VERSION,
        STRUCTURED_SCHEMA_VERSION,
        ingest_source_text_structured,
    )

    store, state_dir = structured_store
    source = state_dir / "source.txt"
    source.write_text(NARRATED_MULTI, encoding="utf-8")
    await ingest_source_text_structured(store, str(source), spine_template="narrated")

    agent = FakeAgent({})  # every chunk yields nothing
    real_extract = extract_characters_from_chunks

    async def fake_extract(chunks, **kwargs):
        kwargs.pop("agent", None)
        kwargs.setdefault("adjudicate", False)
        return await real_extract(chunks, agent=agent, **kwargs)

    monkeypatch.setattr(
        "novelvideo.structured_extraction.extract_characters_from_chunks", fake_extract
    )
    assert await structured_builders.build_characters_structured(store) == []

    stored = await store.get_reusable_analysis_run(
        source_sha256=source_sha256(NARRATED_MULTI),
        schema_version=STRUCTURED_SCHEMA_VERSION,
        pipeline_version=STRUCTURED_PIPELINE_VERSION,
        spine_template="narrated",
    )
    assert stored["status"] == "completed"


# ── ambiguity adjudication ──────────────────────────────────────────────────


def _merged(name, count, *, aliases=()):
    from novelvideo.structured_extraction import MergedCharacter

    return MergedCharacter(
        name=name,
        aliases=set(aliases),
        evidence=[
            {
                "chunk_id": "c0",
                "source_start": index,
                "source_end": index + 1,
                "evidence_kind": "mention",
                "evidence_text": name,
            }
            for index in range(count)
        ],
    )


class AdjudicatorAgent:
    """Returns a scripted adjudication and records the prompt it received."""

    def __init__(self, groups=(), non_characters=(), explode=False):
        from novelvideo.structured_extraction import (
            CharacterAdjudication,
            SamePersonGroup,
        )

        self.explode = explode
        self.prompt = ""
        self.result = CharacterAdjudication(
            groups=[
                SamePersonGroup(canonical_name=c, alias_names=list(a))
                for c, a in groups
            ],
            non_characters=list(non_characters),
        )

    async def run(self, prompt: str):
        self.prompt = prompt
        if self.explode:
            raise RuntimeError("adjudicator unavailable")
        return SimpleNamespace(output=self.result)


async def test_adjudication_merges_a_nickname_into_its_character():
    """Per-chunk extraction cannot see that 小阳 is 郑旭阳; this step can."""
    from novelvideo.structured_extraction import adjudicate_characters

    merged = [_merged("郑旭阳", 38), _merged("小阳", 1)]
    agent = AdjudicatorAgent(groups=[("郑旭阳", ["小阳"])])

    result = await adjudicate_characters(merged, agent=agent)
    assert [item.name for item in result] == ["郑旭阳"]
    assert result[0].aliases == {"小阳"}
    assert len(result[0].evidence) == 39


async def test_adjudication_cannot_invent_a_character():
    """It may only group names it was given."""
    from novelvideo.structured_extraction import adjudicate_characters

    merged = [_merged("郑旭阳", 38), _merged("小阳", 1)]
    agent = AdjudicatorAgent(groups=[("查无此人", ["小阳"])])

    result = await adjudicate_characters(merged, agent=agent)
    assert {item.name for item in result} == {"郑旭阳", "小阳"}


async def test_adjudication_never_deletes_a_candidate():
    """Every candidate here already survived verification against the source.

    Discarding one trades a visible duplicate for an invisible omission, which
    is the wrong way round: the user can delete a duplicate but cannot see an
    omission.
    """
    from novelvideo.structured_extraction import adjudicate_characters

    merged = [_merged("郑玉琴", 96), _merged("郑家悦", 96), _merged("路人", 1)]
    logs: list[str] = []
    agent = AdjudicatorAgent(non_characters=["郑玉琴", "路人"])

    result = await adjudicate_characters(merged, agent=agent, on_log=logs.append)
    assert {item.name for item in result} == {"郑玉琴", "郑家悦", "路人"}
    assert any("仅记录，未删除" in line for line in logs)


async def test_adjudication_cannot_merge_two_well_attested_characters():
    """The model may not fold one lead into another, however it groups them."""
    from novelvideo.structured_extraction import adjudicate_characters

    merged = [_merged("郑玉琴", 96), _merged("郑家悦", 96)]
    agent = AdjudicatorAgent(groups=[("郑玉琴", ["郑家悦"])])

    result = await adjudicate_characters(merged, agent=agent)
    assert {item.name for item in result} == {"郑玉琴", "郑家悦"}


async def test_a_character_named_in_a_cast_list_is_never_merged_away():
    """A cast list is authored, not inferred, so it outranks the model."""
    from novelvideo.structured_extraction import adjudicate_characters

    merged = [_merged("郑玉琴", 96), _merged("王妈", 1)]
    agent = AdjudicatorAgent(groups=[("郑玉琴", ["王妈"])])

    result = await adjudicate_characters(
        merged, roster={"佣人王妈"}, agent=agent
    )
    assert {item.name for item in result} == {"郑玉琴", "王妈"}


async def test_the_canonical_name_is_chosen_by_the_code_not_the_model():
    """Left to the model, a formal name can end up folded into a nickname."""
    from novelvideo.structured_extraction import adjudicate_characters

    merged = [_merged("郑旭阳", 38), _merged("小阳", 1)]
    # The model nominates the nickname as canonical.
    agent = AdjudicatorAgent(groups=[("小阳", ["郑旭阳"])])

    result = await adjudicate_characters(merged, agent=agent)
    assert [item.name for item in result] == ["郑旭阳"]
    assert result[0].aliases == {"小阳"}


async def test_adjudication_failure_keeps_the_rule_result():
    """A degraded adjudicator must not lose the characters rules already found."""
    from novelvideo.structured_extraction import adjudicate_characters

    merged = [_merged("郑玉琴", 96), _merged("郑太", 5)]
    logs: list[str] = []

    result = await adjudicate_characters(
        merged, agent=AdjudicatorAgent(explode=True), on_log=logs.append
    )
    assert {item.name for item in result} == {"郑玉琴", "郑太"}
    assert any("裁决失败" in line for line in logs)


async def test_rarely_seen_candidates_get_source_context():
    """A bare quote rarely proves identity; the surrounding text usually does."""
    from novelvideo.structured_extraction import adjudicate_characters

    source = "▲郑旭阳走进来。郑玉琴皱眉。\n郑玉琴：小阳，你又闯祸了。\n"
    start = source.index("小阳")
    rare = _merged("小阳", 0)
    rare.evidence.append(
        {
            "chunk_id": "c0",
            "source_start": start,
            "source_end": start + 2,
            "evidence_kind": "dialogue",
            "evidence_text": "小阳",
        }
    )
    agent = AdjudicatorAgent()

    await adjudicate_characters(
        [_merged("郑旭阳", 38), rare], source_text=source, agent=agent
    )
    assert "上下文" in agent.prompt
    # The formal name sits next to the nickname, which is what makes the link
    # inferable at all.
    assert "郑旭阳" in agent.prompt


async def test_a_single_candidate_needs_no_adjudication():
    from novelvideo.structured_extraction import adjudicate_characters

    merged = [_merged("郑玉琴", 96)]
    agent = AdjudicatorAgent(non_characters=["郑玉琴"])
    assert await adjudicate_characters(merged, agent=agent) == merged


# ── scene adjudication ──────────────────────────────────────────────────────


def _scene(name, *, aliases=()):
    from novelvideo.models import NovelScene

    return NovelScene(name=name, aliases=list(aliases))


class SceneAdjudicatorAgent:
    def __init__(self, groups=(), explode=False):
        from novelvideo.structured_extraction import (
            SameLocationGroup, SceneAdjudication,
        )

        self.explode = explode
        self.prompt = ""
        self.result = SceneAdjudication(
            groups=[
                SameLocationGroup(canonical_name=c, alias_names=list(a))
                for c, a in groups
            ]
        )

    async def run(self, prompt: str):
        self.prompt = prompt
        if self.explode:
            raise RuntimeError("adjudicator unavailable")
        return SimpleNamespace(output=self.result)


async def test_scene_adjudication_merges_spellings_of_one_location():
    """Hand-written headings spell one room several ways."""
    from novelvideo.structured_extraction import adjudicate_scenes

    scenes = [_scene("郑玉琴办公室"), _scene("郑玉琴办公室内")]
    agent = SceneAdjudicatorAgent(groups=[("郑玉琴办公室", ["郑玉琴办公室内"])])

    result = await adjudicate_scenes(scenes, agent=agent)
    assert [s.name for s in result] == ["郑玉琴办公室"]
    assert "郑玉琴办公室内" in result[0].aliases


async def test_scene_adjudication_never_drops_a_location():
    """A duplicate is redundant art; a missing scene leaves shots with no asset.

    Unlike characters, there is no removal path here at all, so a model that
    proposes nothing simply leaves every scene standing.
    """
    from novelvideo.structured_extraction import adjudicate_scenes

    scenes = [_scene("郑家别墅客厅"), _scene("郑家别墅餐厅"), _scene("郑家别墅外")]
    result = await adjudicate_scenes(scenes, agent=SceneAdjudicatorAgent())
    assert {s.name for s in result} == {name.name for name in scenes}


async def test_scene_adjudication_cannot_invent_a_location():
    from novelvideo.structured_extraction import adjudicate_scenes

    scenes = [_scene("郑玉琴办公室"), _scene("郑玉琴办公室内")]
    agent = SceneAdjudicatorAgent(groups=[("查无此地", ["郑玉琴办公室内"])])

    result = await adjudicate_scenes(scenes, agent=agent)
    assert len(result) == 2


async def test_scene_adjudication_failure_keeps_every_scene():
    from novelvideo.structured_extraction import adjudicate_scenes

    scenes = [_scene("郑玉琴办公室"), _scene("郑玉琴办公室内")]
    logs: list[str] = []
    result = await adjudicate_scenes(
        scenes, agent=SceneAdjudicatorAgent(explode=True), on_log=logs.append
    )
    assert len(result) == 2
    assert any("裁决失败" in line for line in logs)


async def test_scene_prompt_reports_how_often_each_heading_is_used():
    """The most-used spelling is the better canonical name."""
    from novelvideo.structured_extraction import adjudicate_scenes

    scenes = [_scene("主任办公室"), _scene("郑家别墅客厅")]
    agent = SceneAdjudicatorAgent()
    await adjudicate_scenes(
        scenes, occurrences={"主任办公室": 18, "郑家别墅客厅": 16}, agent=agent
    )
    assert "出现 18 场" in agent.prompt
    assert "出现 16 场" in agent.prompt


def test_scene_heading_counts_come_from_the_script():
    from novelvideo.structured_builders import _scene_heading_counts

    script = (
        "第一集\n\n"
        "1-1 林家客厅 日 内\n人物：林默\n林默推开门。\n\n"
        "1-2 巷口 夜 外\n人物：林默\n林默走过巷口。\n\n"
        "1-3 林家客厅 夜 内\n人物：林默\n林默坐下。\n"
    )
    counts = _scene_heading_counts(script)
    assert counts.get("林家客厅") == 2
    assert counts.get("巷口") == 1


# ── resume after an outage, and source-change invalidation ──────────────────


class FlakyAgent:
    """Fails for a set of chunk labels, then can be repaired."""

    def __init__(self, outputs, failing=()):
        self.outputs = outputs
        self.failing = set(failing)
        # Keep the label vocabulary stable across repair, so a recovered agent
        # still recognises the chunk it previously refused.
        self.labels = list(outputs) + list(failing)
        self.calls: list[str] = []

    def repair(self):
        self.failing.clear()

    async def run(self, prompt: str):
        label = next((k for k in self.labels if k in prompt), "")
        self.calls.append(label)
        if label in self.failing:
            raise RuntimeError("gateway down")
        return SimpleNamespace(
            output=self.outputs.get(label, ChunkCharacterOutput())
        )


async def _ingested(store, state_dir, text=NARRATED_MULTI):
    from novelvideo.structured_ingest import ingest_source_text_structured

    source = state_dir / "source.txt"
    source.write_text(text, encoding="utf-8")
    return await ingest_source_text_structured(
        store, str(source), spine_template="narrated"
    )


def _patched_extract(monkeypatch, agent):
    from novelvideo.structured_extraction import extract_characters_from_chunks

    real = extract_characters_from_chunks

    async def fake(chunks, **kwargs):
        kwargs.pop("agent", None)
        kwargs.setdefault("adjudicate", False)
        return await real(chunks, agent=agent, **kwargs)

    monkeypatch.setattr(
        "novelvideo.structured_extraction.extract_characters_from_chunks", fake
    )


async def test_a_chunk_that_failed_is_retried_while_others_are_not(
    structured_store, monkeypatch
):
    """An outage mid-build must cost only the chunks it actually broke."""
    from novelvideo import structured_builders

    store, state_dir = structured_store
    run = await _ingested(store, state_dir, NARRATED_MULTI)

    agent = FlakyAgent(
        outputs={
            "第一章": ChunkCharacterOutput(
                characters=[_candidate("林默", quotes=["林默回到阔别十年的故乡。"])]
            ),
            "第三章": ChunkCharacterOutput(
                characters=[_candidate("苏晴", quotes=["苏晴告诉林默一个秘密。"])]
            ),
        },
        failing=["第二章"],
    )
    _patched_extract(monkeypatch, agent)

    await structured_builders.build_characters_structured(store)
    assert len(agent.calls) == 3
    failed = await store.list_analysis_chunks(run["run_id"], status="failed")
    assert [row["chunk_id"] for row in failed] == ["chapter-0001"]

    # The gateway comes back and the user clicks build again.
    agent.repair()
    agent.calls.clear()
    await structured_builders.build_characters_structured(store)

    assert agent.calls == ["第二章"], "a healthy chunk was paid for twice"
    assert not await store.list_analysis_chunks(run["run_id"], status="failed")


async def test_editing_the_source_discards_the_stored_plan(
    structured_store, monkeypatch
):
    """A result produced from text that has since changed is not a result."""
    from novelvideo import structured_builders

    store, state_dir = structured_store
    await _ingested(store, state_dir, NARRATED_MULTI)

    outputs = {
        "第一章": ChunkCharacterOutput(
            characters=[_candidate("林默", quotes=["林默回到阔别十年的故乡。"])]
        )
    }
    agent = FlakyAgent(outputs=outputs)
    _patched_extract(monkeypatch, agent)

    await structured_builders.build_characters_structured(store)
    first_calls = len(agent.calls)
    assert first_calls > 0

    # Rewriting novel.txt without re-importing: the hash no longer matches any
    # recorded run, so nothing may be replayed.
    (Path(store.project_dir) / "novel.txt").write_text(
        NARRATED_MULTI + "\n第四章 结局\n\n他终于释怀。\n", encoding="utf-8"
    )
    agent.calls.clear()
    await structured_builders.build_characters_structured(store)

    assert agent.calls, "stale results were replayed for text that changed"


# ── appellations ────────────────────────────────────────────────────────────


def _candidate_with_appellations(name, quotes, appellations):
    c = _candidate(name, quotes=quotes)
    c.appellations = list(appellations)
    return c


def test_an_appellation_only_one_character_claims_becomes_an_alias():
    """Packed chunks hold several scenes, so nicknames surface alongside names."""
    text = "郑玉琴走进客厅。刘管家喊了一声郑太。"
    outcomes = [
        (
            _chunk(text),
            ChunkCharacterOutput(
                characters=[
                    _candidate_with_appellations("郑玉琴", [text], ["郑太"]),
                    _candidate("刘管家", quotes=[text]),
                ]
            ),
        )
    ]
    merged = {m.name: m for m in merge_character_candidates(outcomes)}
    assert merged["郑玉琴"].aliases == {"郑太"}
    assert merged["刘管家"].aliases == set()


def _claim(chunk_id, start, name, appellation, text):
    return (
        _chunk(text, chunk_id=chunk_id, start=start),
        ChunkCharacterOutput(
            characters=[_candidate_with_appellations(name, [text], [appellation])]
        ),
    )


def test_a_contested_appellation_goes_to_whoever_the_text_keeps_supporting():
    """Decided by how many independent chunks say so, not by overall evidence.

    Ranking by total evidence would hand every ambiguous form to the lead,
    which is the opposite of evidence-driven.
    """
    text = "郑玉琴走进客厅。刘管家喊了一声郑太。"
    outcomes = [
        _claim("c0", 0, "郑玉琴", "郑太", text),
        _claim("c1", 60, "郑玉琴", "郑太", text),
        _claim("c2", 120, "郑玉琴", "郑太", text),
        _claim("c3", 180, "刘管家", "郑太", text),
    ]
    merged = {m.name: m for m in merge_character_candidates(outcomes)}
    assert merged["郑玉琴"].aliases == {"郑太"}
    assert merged["刘管家"].aliases == set()


def test_a_contested_appellation_with_a_narrow_lead_is_dropped():
    """Leading is not enough; three-to-two leaves it unassigned.

    A wrong alias resolves confidently to the wrong person, while a missing one
    merely fails to resolve — so a close call is left alone.
    """
    text = "郑玉琴走进客厅。刘管家喊了一声郑太。"
    outcomes = [
        _claim("c0", 0, "郑玉琴", "郑太", text),
        _claim("c1", 60, "郑玉琴", "郑太", text),
        _claim("c2", 120, "郑玉琴", "郑太", text),
        _claim("c3", 180, "刘管家", "郑太", text),
        _claim("c4", 240, "刘管家", "郑太", text),
    ]
    for item in merge_character_candidates(outcomes):
        assert "郑太" not in item.aliases


def test_a_contested_appellation_seen_in_only_one_chunk_is_dropped():
    """One chunk is one author's phrasing, not grounds to overrule a rival."""
    text = "郑玉琴走进客厅。刘管家喊了一声郑太。"
    outcomes = [
        _claim("c0", 0, "郑玉琴", "郑太", text),
        _claim("c1", 60, "刘管家", "郑太", text),
    ]
    for item in merge_character_candidates(outcomes):
        assert "郑太" not in item.aliases


def test_an_appellation_that_is_itself_a_character_never_becomes_an_alias():
    text = "郑玉琴走进客厅。刘管家跟在后面。"
    outcomes = [
        (
            _chunk(text),
            ChunkCharacterOutput(
                characters=[
                    _candidate_with_appellations("郑玉琴", [text], ["刘管家"]),
                    _candidate("刘管家", quotes=[text]),
                ]
            ),
        )
    ]
    merged = {m.name: m for m in merge_character_candidates(outcomes)}
    assert "刘管家" in merged
    assert merged["郑玉琴"].aliases == set()


def test_an_appellation_absent_from_the_chunk_is_rejected():
    text = "郑玉琴走进客厅。"
    outcomes = [
        (
            _chunk(text),
            ChunkCharacterOutput(
                characters=[
                    _candidate_with_appellations("郑玉琴", [text], ["女王陛下"])
                ]
            ),
        )
    ]
    assert merge_character_candidates(outcomes)[0].aliases == set()


def test_a_generic_appellation_is_not_recorded_as_an_alias():
    text = "郑玉琴走进客厅。她的母亲在门口。"
    outcomes = [
        (
            _chunk(text),
            ChunkCharacterOutput(
                characters=[
                    _candidate_with_appellations("郑玉琴", [text], ["母亲"])
                ]
            ),
        )
    ]
    assert merge_character_candidates(outcomes)[0].aliases == set()


async def test_a_frequently_used_location_is_never_merged_away():
    """A place the script keeps returning to is real, not a spelling variant.

    Folding it away would leave those scenes pointing at another room's art.
    """
    from novelvideo.structured_extraction import adjudicate_scenes

    scenes = [_scene("主任办公室"), _scene("郑家别墅客厅")]
    agent = SceneAdjudicatorAgent(groups=[("主任办公室", ["郑家别墅客厅"])])

    result = await adjudicate_scenes(
        scenes, occurrences={"主任办公室": 18, "郑家别墅客厅": 16}, agent=agent
    )
    assert {s.name for s in result} == {"主任办公室", "郑家别墅客厅"}


async def test_the_canonical_location_is_the_spelling_the_script_uses_most():
    from novelvideo.structured_extraction import adjudicate_scenes

    scenes = [_scene("郑玉琴办公室"), _scene("郑玉琴办公室内")]
    # The model nominates the rarer spelling.
    agent = SceneAdjudicatorAgent(groups=[("郑玉琴办公室内", ["郑玉琴办公室"])])

    result = await adjudicate_scenes(
        scenes,
        occurrences={"郑玉琴办公室": 2, "郑玉琴办公室内": 1},
        agent=agent,
    )
    assert [s.name for s in result] == ["郑玉琴办公室"]
    assert "郑玉琴办公室内" in result[0].aliases


async def test_a_completed_build_replays_without_any_model_call(
    structured_store, monkeypatch
):
    """Caching chunk results is not enough on its own.

    Merging is free, but adjudication is a further model call, and a second
    adjudication can decide differently — an alias could reappear as its own
    character and be inserted as a new row. A finished build therefore replays
    its settled cast.
    """
    from novelvideo import structured_builders
    from novelvideo.structured_extraction import (
        CharacterAdjudication,
    )

    store, state_dir = structured_store
    await _ingested(store, state_dir, NARRATED_MULTI)

    extraction = FlakyAgent(
        outputs={
            "第一章": ChunkCharacterOutput(
                characters=[_candidate("林默", quotes=["林默回到阔别十年的故乡。"])]
            ),
            "第二章": ChunkCharacterOutput(
                characters=[_candidate("苏晴", quotes=["他在巷口遇见了苏晴。"])]
            ),
        }
    )

    class CountingAdjudicator:
        def __init__(self):
            self.calls = 0

        async def run(self, prompt: str):
            self.calls += 1
            return SimpleNamespace(
                output=CharacterAdjudication(groups=[])
            )

    adjudicator = CountingAdjudicator()
    from novelvideo.structured_extraction import extract_characters_from_chunks

    real = extract_characters_from_chunks

    async def fake(chunks, **kwargs):
        kwargs.pop("agent", None)
        kwargs.pop("adjudication_agent", None)
        return await real(chunks, agent=extraction, adjudication_agent=adjudicator, **kwargs)

    monkeypatch.setattr(
        "novelvideo.structured_extraction.extract_characters_from_chunks", fake
    )

    await structured_builders.build_characters_structured(store)
    assert extraction.calls, "the first build should have done real work"
    assert adjudicator.calls == 1

    extraction.calls.clear()
    await structured_builders.build_characters_structured(store)

    assert extraction.calls == [], "chunks were re-extracted"
    assert adjudicator.calls == 1, "adjudication ran again on a finished build"


async def test_replaying_a_build_cannot_split_an_alias_back_into_a_character(
    structured_store, monkeypatch
):
    """A second, differently-deciding adjudication must not add a row.

    Without a stored final result, an alias folded in on the first run could
    come back as its own candidate, and add_characters_atomic — which only
    checks primary names — would insert it alongside the character that already
    lists it as an alias.
    """
    from novelvideo import structured_builders
    from novelvideo.structured_extraction import (
        CharacterAdjudication, SamePersonGroup, extract_characters_from_chunks,
    )

    store, state_dir = structured_store
    await _ingested(store, state_dir, NARRATED_MULTI)

    extraction = FlakyAgent(
        outputs={
            "第一章": ChunkCharacterOutput(
                characters=[_candidate("林默", quotes=["林默回到阔别十年的故乡。"])]
            ),
            "第二章": ChunkCharacterOutput(
                characters=[_candidate("苏晴", quotes=["他在巷口遇见了苏晴。"])]
            ),
        }
    )

    class DriftingAdjudicator:
        """Merges on the first call, then changes its mind."""

        def __init__(self):
            self.calls = 0

        async def run(self, prompt: str):
            self.calls += 1
            groups = (
                [SamePersonGroup(canonical_name="林默", alias_names=["苏晴"])]
                if self.calls == 1
                else []
            )
            return SimpleNamespace(output=CharacterAdjudication(groups=groups))

    real = extract_characters_from_chunks

    async def fake(chunks, **kwargs):
        kwargs.pop("agent", None)
        kwargs.pop("adjudication_agent", None)
        return await real(
            chunks, agent=extraction, adjudication_agent=DriftingAdjudicator(), **kwargs
        )

    monkeypatch.setattr(
        "novelvideo.structured_extraction.extract_characters_from_chunks", fake
    )

    await structured_builders.build_characters_structured(store)
    first = {c.name for c in await store.list_characters()}

    await structured_builders.build_characters_structured(store)
    second = {c.name for c in await store.list_characters()}

    assert second == first, "a rebuild changed the cast for unchanged source"
    assert "苏晴" not in second


def test_one_occurrence_in_an_overlap_counts_once():
    """Chunks overlap, so a single mention can appear in two of them.

    Counting chunks would let that one occurrence clear the two-to-one margin by
    itself and hand the appellation to whoever happened to sit on the seam.
    """
    source = "郑玉琴走进客厅。刘管家喊了一声郑太。她没有回头。"
    seam = source.index("郑太")
    # Two chunks whose spans overlap across the mention, exactly as
    # _split_oversized produces them.
    left = SourceChunk(
        chunk_id="c0", chunk_index=0, section_type="chapter", section_label="上",
        source_start=0, source_end=seam + 6, text=source[: seam + 6],
    )
    right = SourceChunk(
        chunk_id="c1", chunk_index=1, section_type="chapter", section_label="下",
        source_start=seam - 4, source_end=len(source), text=source[seam - 4 :],
    )
    assert right.source_start < left.source_end, "the fixture must overlap"

    def claim(chunk, owner):
        return (
            chunk,
            ChunkCharacterOutput(
                characters=[
                    _candidate_with_appellations(owner, [chunk.text], ["郑太"])
                ]
            ),
        )

    # 郑玉琴 is claimed twice, but both are the same mention seen from either
    # side of the seam. 刘管家 is claimed once, elsewhere.
    elsewhere = _chunk("刘管家看着郑太离开。", chunk_id="c2", start=400)
    outcomes = [
        claim(left, "郑玉琴"),
        claim(right, "郑玉琴"),
        claim(elsewhere, "刘管家"),
    ]

    for item in merge_character_candidates(outcomes):
        assert "郑太" not in item.aliases, (
            "an overlapped mention was counted twice and won the vote"
        )


def test_the_same_appellation_at_two_real_positions_still_wins():
    """Deduplicating by position must not silently disable voting."""
    source = "郑玉琴走进客厅。郑太点头。稍后郑太又开口。"
    first = _chunk(source[:12], chunk_id="c0", start=0)
    second = _chunk(source[12:], chunk_id="c1", start=12)

    def claim(chunk, owner):
        return (
            chunk,
            ChunkCharacterOutput(
                characters=[
                    _candidate_with_appellations(owner, [chunk.text], ["郑太"])
                ]
            ),
        )

    outcomes = [
        claim(first, "郑玉琴"),
        claim(second, "郑玉琴"),
        claim(_chunk("刘管家在门口。郑太走了。", chunk_id="c2", start=400), "刘管家"),
    ]
    merged = {m.name: m for m in merge_character_candidates(outcomes)}
    assert merged["郑玉琴"].aliases == {"郑太"}


# ── repairing placeholder environment prompts ───────────────────────────────


DRAMA_SCRIPT = (
    "第一集\n\n"
    "1-1 林家客厅 日 内\n人物：林默\n林默推开门。\n"
)


async def _drama_project(tmp_path, script):
    from novelvideo.knowledge_pipeline import (
        KNOWLEDGE_PIPELINE_KEY, KNOWLEDGE_PIPELINE_STRUCTURED,
    )
    from novelvideo.sqlite_store import SQLiteStore

    state = tmp_path / "user" / "drama"
    state.mkdir(parents=True)
    (state / "project_config.json").write_text(
        json.dumps(
            {KNOWLEDGE_PIPELINE_KEY: KNOWLEDGE_PIPELINE_STRUCTURED,
             "spine_template": "drama"}
        ),
        encoding="utf-8",
    )
    (state / "novel.txt").write_text(script, encoding="utf-8")
    store = SQLiteStore("user/drama", output_dir=str(state), state_dir=str(state))
    await store.initialize()
    await store.load_graph_state()
    return store


def _fresh_scene(name):
    from novelvideo.models import NovelScene

    return NovelScene(
        name=name,
        scene_type="interior",
        environment_prompt="正面：主墙平整\n左侧：木门\n右侧：窗户\n背面：资料柜",
    )


async def test_a_placeholder_prompt_is_replaced_on_rebuild(tmp_path, monkeypatch):
    """A prompt this code generated is a placeholder, not an asset fact.

    Skipping every existing scene would leave projects built while the contract
    validator was broken on boilerplate for good, since nothing else rewrites
    those prompts.
    """
    from novelvideo import structured_builders
    from novelvideo.cognee.pipeline import _ensure_directional_environment_prompt
    from novelvideo.models import NovelScene

    store = await _drama_project(tmp_path, DRAMA_SCRIPT)
    try:
        placeholder = _ensure_directional_environment_prompt(
            prompt="", scene_name="林家客厅", scene_type="interior",
            time_of_day="", context_lines=["▲林默推开门。"],
        )
        await store.add_scene(
            NovelScene(name="林家客厅", environment_prompt=placeholder)
        )

        async def fake_extract(text, **kwargs):
            return [_fresh_scene("林家客厅")]

        monkeypatch.setattr(
            "novelvideo.cognee.pipeline.extract_scenes_from_script", fake_extract
        )
        # Imported inside the builder, so it is patched at its source.
        monkeypatch.setattr(
            "novelvideo.structured_extraction.adjudicate_scenes",
            lambda scenes, **kwargs: _async_value(scenes),
        )

        result = await structured_builders.build_scenes_structured(store)
        assert result["repaired_scenes"] == 1

        stored = await store.get_scene("林家客厅")
        assert "主墙平整" in stored.environment_prompt
    finally:
        await store.close()


async def test_a_user_written_prompt_is_never_replaced(tmp_path, monkeypatch):
    """Only the known generated placeholder is overwritten."""
    from novelvideo import structured_builders
    from novelvideo.models import NovelScene

    store = await _drama_project(tmp_path, DRAMA_SCRIPT)
    try:
        mine = "正面：我自己写的描述\n左侧：也是我写的\n右侧：我写的\n背面：我写的"
        await store.add_scene(NovelScene(name="林家客厅", environment_prompt=mine))

        async def fake_extract(text, **kwargs):
            return [_fresh_scene("林家客厅")]

        monkeypatch.setattr(
            "novelvideo.cognee.pipeline.extract_scenes_from_script", fake_extract
        )
        # Imported inside the builder, so it is patched at its source.
        monkeypatch.setattr(
            "novelvideo.structured_extraction.adjudicate_scenes",
            lambda scenes, **kwargs: _async_value(scenes),
        )

        result = await structured_builders.build_scenes_structured(store)
        assert result["repaired_scenes"] == 0

        stored = await store.get_scene("林家客厅")
        assert stored.environment_prompt == mine
    finally:
        await store.close()


def _async_value(value):
    async def _call():
        return value

    return _call()


# ── character appearance ────────────────────────────────────────────────────
#
# Extraction settles who exists; this stage settles what they look like. It is
# the half of legacy's CharacterEnrichment that structured extraction shipped
# without, which is why every structured project's characters carried an empty
# 面部提示词 and the portrait runner refused to draw them.


class FakeAppearanceAgent:
    """Returns scripted appearances, recording every prompt it was sent."""

    def __init__(self, by_name, fail=False):
        self.by_name = by_name
        self.fail = fail
        self.prompts = []

    async def run(self, prompt: str):
        from novelvideo.structured_extraction import CharacterAppearanceList

        self.prompts.append(prompt)
        if self.fail:
            raise RuntimeError("boom")
        return SimpleNamespace(
            output=CharacterAppearanceList(
                characters=[
                    item for name, item in self.by_name.items() if name in prompt
                ]
            )
        )


def _appearance(name, *, face="女性，二十多岁，黑色长发，杏眼", **kwargs):
    from novelvideo.structured_extraction import CharacterAppearance

    return CharacterAppearance(name=name, face_prompt=face, **kwargs)


def _cast_member(name, *, gender="female", description="", quotes=("他回来了。",)):
    from novelvideo.structured_extraction import MergedCharacter

    return MergedCharacter(
        name=name,
        gender=gender,
        description=description,
        evidence=[{"quote": quote} for quote in quotes],
    )


class RecordingCache:
    def __init__(self, rows=None):
        self.rows = dict(rows or {})
        self.saved = []

    async def get(self, artifact_type, cache_keys):
        return {
            key: self.rows[(artifact_type, key)]
            for key in cache_keys
            if (artifact_type, key) in self.rows
        }

    async def save(self, artifact_type, results):
        self.saved.append((artifact_type, dict(results)))
        for key, payload in results.items():
            self.rows[(artifact_type, key)] = payload


async def test_appearance_stage_fills_the_fields_extraction_cannot_quote():
    """A face, a role and a build are inferred, not quoted, so extraction skips them."""
    from novelvideo.structured_extraction import enrich_character_appearances

    agent = FakeAppearanceAgent(
        {
            "郑家悦": _appearance(
                "郑家悦", role="主角", body_type="纤细高挑", age_group="youth"
            )
        }
    )
    result = await enrich_character_appearances([_cast_member("郑家悦")], agent=agent)

    assert result["郑家悦"].face_prompt == "女性，二十多岁，黑色长发，杏眼"
    assert result["郑家悦"].role == "主角"
    assert result["郑家悦"].body_type == "纤细高挑"


async def test_an_answer_without_a_face_is_dropped_rather_than_published():
    """An empty face prompt is a visible gap; boilerplate would be an invisible one."""
    from novelvideo.structured_extraction import enrich_character_appearances

    agent = FakeAppearanceAgent({"郑家悦": _appearance("郑家悦", face="  ", role="主角")})
    cache = RecordingCache()
    result = await enrich_character_appearances(
        [_cast_member("郑家悦")], agent=agent, cache=cache
    )

    assert result == {}
    assert cache.saved == []


async def test_an_unusable_age_band_falls_back_instead_of_reaching_the_column():
    """The band drives voice selection, so an unknown value would silently disable it."""
    from novelvideo.structured_extraction import enrich_character_appearances

    agent = FakeAppearanceAgent({"郑家悦": _appearance("郑家悦", age_group="middle-aged")})
    result = await enrich_character_appearances([_cast_member("郑家悦")], agent=agent)

    assert result["郑家悦"].age_group == "youth"


async def test_a_cached_appearance_is_never_sent_to_the_model_again():
    from novelvideo.structured_extraction import enrich_character_appearances

    cache = RecordingCache()
    item = _cast_member("郑家悦")
    first = FakeAppearanceAgent({"郑家悦": _appearance("郑家悦", role="主角")})
    await enrich_character_appearances([item], agent=first, cache=cache)
    assert len(first.prompts) == 1

    second = FakeAppearanceAgent({})
    result = await enrich_character_appearances([item], agent=second, cache=cache)
    assert second.prompts == []
    assert result["郑家悦"].role == "主角"


async def test_a_changed_description_retires_the_cached_appearance():
    """The description is in the prompt, so a changed one is a different question."""
    from novelvideo.structured_extraction import character_appearance_cache_key

    before = character_appearance_cache_key(_cast_member("郑家悦", description="遭受校园霸凌"))
    after = character_appearance_cache_key(_cast_member("郑家悦", description="已经毕业工作"))
    assert before != after


async def test_a_changed_quote_retires_the_cached_appearance():
    from novelvideo.structured_extraction import character_appearance_cache_key

    before = character_appearance_cache_key(_cast_member("郑家悦", quotes=("她低下头。",)))
    after = character_appearance_cache_key(_cast_member("郑家悦", quotes=("她抬起头。",)))
    assert before != after


async def test_only_one_narrator_survives_a_batch_split():
    """Batches run concurrently, so "whoever answered first" is not a stable answer."""
    from novelvideo.structured_extraction import enrich_character_appearances

    agent = FakeAppearanceAgent(
        {
            "郑家悦": _appearance("郑家悦", is_main=True),
            "郑玉琴": _appearance("郑玉琴", is_main=True),
        }
    )
    result = await enrich_character_appearances(
        [_cast_member("郑家悦"), _cast_member("郑玉琴")], agent=agent
    )

    assert [name for name, item in result.items() if item.is_main] == ["郑家悦"]


async def test_a_failed_appearance_call_still_leaves_the_cast_published(
    structured_store, monkeypatch
):
    """Losing a face must not lose the character it belonged to."""
    from novelvideo import structured_builders

    store, _ = structured_store
    monkeypatch.setattr(
        "novelvideo.structured_extraction._create_character_appearance_agent",
        lambda agent=None: FakeAppearanceAgent({}, fail=True),
    )
    added = await structured_builders._publish_characters(
        store, [_cast_member("郑家悦")], "", lambda *_: None, lambda *_: None
    )

    assert added == ["郑家悦"]
    assert store.get_character("郑家悦").face_prompt == ""


async def test_a_new_character_is_published_with_its_face_and_voice(
    structured_store, monkeypatch
):
    from novelvideo import structured_builders

    store, _ = structured_store
    monkeypatch.setenv("FISH_VOICE_YOUTH_FEMALE", "voice-yf")
    monkeypatch.setattr(
        "novelvideo.config.FISH_VOICE_PRESETS",
        {"youth_female": "voice-yf", "youth_male": "voice-ym"},
    )
    monkeypatch.setattr(
        "novelvideo.structured_extraction._create_character_appearance_agent",
        lambda agent=None: FakeAppearanceAgent(
            {"郑家悦": _appearance("郑家悦", role="主角", body_type="纤细高挑")}
        ),
    )
    await structured_builders._publish_characters(
        store, [_cast_member("郑家悦")], "", lambda *_: None, lambda *_: None
    )

    character = store.get_character("郑家悦")
    assert character.face_prompt == "女性，二十多岁，黑色长发，杏眼"
    assert character.role == "主角"
    assert character.body_type == "纤细高挑"
    # "female", not "女": the structured extractor writes the English form, and
    # a lookup that only knows the Chinese one gives every woman a male voice.
    assert character.fish_voice_id == "voice-yf"


async def test_a_rebuild_fills_a_face_an_existing_character_never_had(
    structured_store, monkeypatch
):
    """Characters built before this stage existed would otherwise stay faceless."""
    from novelvideo import structured_builders
    from novelvideo.cognee.pipeline import NovelCharacter

    store, _ = structured_store
    await store.add_characters_atomic(
        [NovelCharacter(name="郑家悦", gender="female")], skip_existing=False
    )
    assert store.get_character("郑家悦").face_prompt == ""

    monkeypatch.setattr(
        "novelvideo.config.FISH_VOICE_PRESETS",
        {"elder_female": "voice-ef", "elder_male": "voice-em"},
    )
    monkeypatch.setattr(
        "novelvideo.structured_extraction._create_character_appearance_agent",
        lambda agent=None: FakeAppearanceAgent(
            {"郑家悦": _appearance("郑家悦", role="主角", age_group="elder")}
        ),
    )
    added = await structured_builders._publish_characters(
        store, [_cast_member("郑家悦")], "", lambda *_: None, lambda *_: None
    )

    assert added == []
    repaired = store.get_character("郑家悦")
    assert repaired.face_prompt == "女性，二十多岁，黑色长发，杏眼"
    assert repaired.role == "主角"
    assert repaired.age_group == "elder"
    assert repaired.fish_voice_id == "voice-ef"


async def test_a_rebuild_leaves_an_age_band_a_bound_voice_depends_on(
    structured_store, monkeypatch
):
    """A bound voice means somebody chose the band; the repair must not move it."""
    from novelvideo import structured_builders
    from novelvideo.cognee.pipeline import NovelCharacter

    store, _ = structured_store
    await store.add_characters_atomic(
        [
            NovelCharacter(
                name="郑家悦",
                gender="female",
                age_group="youth",
                fish_voice_id="chosen-by-hand",
            )
        ],
        skip_existing=False,
    )
    monkeypatch.setattr(
        "novelvideo.structured_extraction._create_character_appearance_agent",
        lambda agent=None: FakeAppearanceAgent(
            {"郑家悦": _appearance("郑家悦", age_group="elder")}
        ),
    )
    await structured_builders._publish_characters(
        store, [_cast_member("郑家悦")], "", lambda *_: None, lambda *_: None
    )

    repaired = store.get_character("郑家悦")
    assert repaired.face_prompt == "女性，二十多岁，黑色长发，杏眼"
    assert repaired.age_group == "youth"
    assert repaired.fish_voice_id == "chosen-by-hand"


async def test_a_rebuild_never_overwrites_a_face_the_user_wrote(
    structured_store, monkeypatch
):
    from novelvideo import structured_builders
    from novelvideo.cognee.pipeline import NovelCharacter

    store, _ = structured_store
    await store.add_characters_atomic(
        [
            NovelCharacter(
                name="郑家悦", gender="female", face_prompt="我自己写的脸", role="配角"
            )
        ],
        skip_existing=False,
    )
    monkeypatch.setattr(
        "novelvideo.structured_extraction._create_character_appearance_agent",
        lambda agent=None: FakeAppearanceAgent(
            {"郑家悦": _appearance("郑家悦", role="主角")}
        ),
    )
    await structured_builders._publish_characters(
        store, [_cast_member("郑家悦")], "", lambda *_: None, lambda *_: None
    )

    assert store.get_character("郑家悦").face_prompt == "我自己写的脸"
    assert store.get_character("郑家悦").role == "配角"


def test_the_voice_lookup_reads_both_spellings_of_a_gender(monkeypatch):
    """legacy writes 男/女, structured_v1 writes male/female; both select a voice."""
    from novelvideo.config import get_fish_voice_id

    monkeypatch.setattr(
        "novelvideo.config.FISH_VOICE_PRESETS",
        {"youth_female": "voice-yf", "youth_male": "voice-ym"},
    )
    assert get_fish_voice_id("youth", "female") == "voice-yf"
    assert get_fish_voice_id("youth", "女") == "voice-yf"
    assert get_fish_voice_id("youth", "male") == "voice-ym"
    assert get_fish_voice_id("youth", "男") == "voice-ym"


async def test_the_character_bible_reaches_the_stage_that_writes_faces():
    """A screenplay's pre-scene block names hair and build outright; legacy sent it."""
    from novelvideo.structured_extraction import enrich_character_appearances

    agent = FakeAppearanceAgent({"郑家悦": _appearance("郑家悦")})
    await enrich_character_appearances(
        [_cast_member("郑家悦")], synopsis="郑家悦：短发，清瘦。", agent=agent
    )

    assert "郑家悦：短发，清瘦。" in agent.prompts[0]


async def test_an_edited_character_bible_retires_every_stored_appearance():
    from novelvideo.structured_extraction import character_appearance_cache_key

    item = _cast_member("郑家悦")
    before = character_appearance_cache_key(item, "郑家悦：短发，清瘦。")
    after = character_appearance_cache_key(item, "郑家悦：长发，圆脸。")
    assert before != after


async def test_a_drama_build_reads_the_bible_from_the_imported_source(
    structured_store, monkeypatch
):
    """_publish_characters reaches publication without the source text in hand."""
    from novelvideo import structured_builders

    store, state_dir = structured_store
    (state_dir / "novel.txt").write_text(
        "郑家悦：短发，清瘦。\n\n1-1 教室 日 内\n\n郑家悦坐下。\n", encoding="utf-8"
    )
    agent = FakeAppearanceAgent({"郑家悦": _appearance("郑家悦")})
    monkeypatch.setattr(
        "novelvideo.structured_extraction._create_character_appearance_agent",
        lambda a=None: agent,
    )
    await structured_builders._publish_characters(
        store, [_cast_member("郑家悦")], "", lambda *_: None, lambda *_: None
    )

    assert "郑家悦：短发，清瘦。" in agent.prompts[0]


async def test_a_rebuild_marks_the_narrator_an_existing_project_never_had(
    structured_store, monkeypatch
):
    """Without it, first-person narration fails with 未找到解说主角 forever."""
    from novelvideo import structured_builders
    from novelvideo.cognee.pipeline import NovelCharacter

    store, _ = structured_store
    await store.add_characters_atomic(
        [NovelCharacter(name="郑家悦", gender="female")], skip_existing=False
    )
    monkeypatch.setattr(
        "novelvideo.structured_extraction._create_character_appearance_agent",
        lambda agent=None: FakeAppearanceAgent(
            {"郑家悦": _appearance("郑家悦", is_main=True)}
        ),
    )
    await structured_builders._publish_characters(
        store, [_cast_member("郑家悦")], "", lambda *_: None, lambda *_: None
    )

    assert store.get_character("郑家悦").is_main is True


async def test_a_narrator_marked_by_hand_is_not_joined_by_a_second_one(
    structured_store, monkeypatch
):
    """Nothing binds to is_main, so an unclaimed narrator is the only signal."""
    from novelvideo import structured_builders
    from novelvideo.cognee.pipeline import NovelCharacter

    store, _ = structured_store
    await store.add_characters_atomic(
        [
            NovelCharacter(name="郑玉琴", gender="female", is_main=True),
            NovelCharacter(name="郑家悦", gender="female"),
        ],
        skip_existing=False,
    )
    monkeypatch.setattr(
        "novelvideo.structured_extraction._create_character_appearance_agent",
        lambda agent=None: FakeAppearanceAgent(
            {"郑家悦": _appearance("郑家悦", is_main=True)}
        ),
    )
    await structured_builders._publish_characters(
        store, [_cast_member("郑家悦")], "", lambda *_: None, lambda *_: None
    )

    assert store.get_character("郑家悦").is_main is False
    assert store.get_character("郑玉琴").is_main is True


async def test_a_face_written_by_hand_does_not_lock_out_the_other_fields(
    structured_store, monkeypatch
):
    """Gating the whole repair on a missing face punished the one field filled in."""
    from novelvideo import structured_builders
    from novelvideo.cognee.pipeline import NovelCharacter

    store, _ = structured_store
    await store.add_characters_atomic(
        [NovelCharacter(name="郑家悦", gender="female", face_prompt="我自己写的脸")],
        skip_existing=False,
    )
    monkeypatch.setattr(
        "novelvideo.config.FISH_VOICE_PRESETS",
        {"elder_female": "voice-ef", "elder_male": "voice-em"},
    )
    monkeypatch.setattr(
        "novelvideo.structured_extraction._create_character_appearance_agent",
        lambda agent=None: FakeAppearanceAgent(
            {
                "郑家悦": _appearance(
                    "郑家悦", role="主角", body_type="纤细高挑", age_group="elder"
                )
            }
        ),
    )
    await structured_builders._publish_characters(
        store, [_cast_member("郑家悦")], "", lambda *_: None, lambda *_: None
    )

    repaired = store.get_character("郑家悦")
    assert repaired.face_prompt == "我自己写的脸"
    assert repaired.role == "主角"
    assert repaired.body_type == "纤细高挑"
    assert repaired.fish_voice_id == "voice-ef"


async def test_a_character_with_nothing_missing_is_left_untouched(
    structured_store, monkeypatch
):
    """Every field guarded, so a settled character costs no write at all."""
    from novelvideo import structured_builders
    from novelvideo.cognee.pipeline import NovelCharacter

    store, _ = structured_store
    await store.add_characters_atomic(
        [
            NovelCharacter(
                name="郑家悦",
                gender="female",
                face_prompt="已有的脸",
                role="已有定位",
                body_type="已有身形",
                fish_voice_id="已有声音",
            )
        ],
        skip_existing=False,
    )
    writes = []
    original = store.update_character

    async def recording(name, **updates):
        writes.append((name, updates))
        await original(name, **updates)

    monkeypatch.setattr(store, "update_character", recording)
    monkeypatch.setattr(
        "novelvideo.structured_extraction._create_character_appearance_agent",
        lambda agent=None: FakeAppearanceAgent(
            {"郑家悦": _appearance("郑家悦", role="主角", body_type="纤细高挑")}
        ),
    )
    await structured_builders._publish_characters(
        store, [_cast_member("郑家悦")], "", lambda *_: None, lambda *_: None
    )

    assert writes == []


async def test_a_newly_discovered_character_cannot_become_a_second_narrator(
    structured_store, monkeypatch
):
    """The insert lands before the repair path ever looks for a narrator."""
    from novelvideo import structured_builders
    from novelvideo.cognee.pipeline import NovelCharacter

    store, _ = structured_store
    await store.add_characters_atomic(
        [NovelCharacter(name="郑玉琴", gender="female", is_main=True)],
        skip_existing=False,
    )
    monkeypatch.setattr(
        "novelvideo.structured_extraction._create_character_appearance_agent",
        lambda agent=None: FakeAppearanceAgent(
            {"林某": _appearance("林某", is_main=True)}
        ),
    )
    await structured_builders._publish_characters(
        store, [_cast_member("林某")], "", lambda *_: None, lambda *_: None
    )

    narrators = [c.name for c in store.get_all_characters() if c.is_main]
    assert narrators == ["郑玉琴"]


async def test_a_stale_narrator_opinion_is_not_replayed_from_the_cache():
    """is_main depends on the whole cast; a per-character key cannot invalidate it."""
    from novelvideo.structured_extraction import enrich_character_appearances

    cache = RecordingCache()
    old = FakeAppearanceAgent({"郑家悦": _appearance("郑家悦", is_main=True)})
    await enrich_character_appearances([_cast_member("郑家悦")], agent=old, cache=cache)

    # The cast changed: someone else is the narrator now, and 郑家悦's own
    # inputs are untouched, so her row is served straight from the cache.
    new = FakeAppearanceAgent({"林某": _appearance("林某", is_main=True)})
    result = await enrich_character_appearances(
        [_cast_member("郑家悦"), _cast_member("林某")], agent=new, cache=cache
    )

    assert [name for name, item in result.items() if item.is_main] == ["林某"]


async def test_a_nomination_stored_under_the_old_contract_is_not_read_back():
    """Belt and braces beside the version bump: the field is never trusted."""
    import json

    from novelvideo.structured_extraction import appearance_from_cache_payload

    restored = appearance_from_cache_payload(
        json.dumps(
            {
                "name": "郑家悦",
                "role": "主角",
                "is_main": True,
                "age_group": "youth",
                "body_type": "纤细高挑",
                "face_prompt": "女性，二十多岁",
            },
            ensure_ascii=False,
        )
    )

    assert restored is not None
    assert restored.is_main is False
    # Everything that is genuinely per-character still survives the round trip.
    assert restored.role == "主角"
    assert restored.body_type == "纤细高挑"


async def test_the_build_still_seeds_a_narrator_when_the_project_has_none(
    structured_store, monkeypatch
):
    """Refusing to fight an existing choice must not mean never making one."""
    from novelvideo import structured_builders

    store, _ = structured_store
    monkeypatch.setattr(
        "novelvideo.structured_extraction._create_character_appearance_agent",
        lambda agent=None: FakeAppearanceAgent(
            {"郑家悦": _appearance("郑家悦", is_main=True)}
        ),
    )
    await structured_builders._publish_characters(
        store, [_cast_member("郑家悦")], "", lambda *_: None, lambda *_: None
    )

    assert [c.name for c in store.get_all_characters() if c.is_main] == ["郑家悦"]
