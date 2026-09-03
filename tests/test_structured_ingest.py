"""structured_v1 import: deterministic chunking, no graph, resumable runs."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from novelvideo.knowledge_pipeline import KNOWLEDGE_PIPELINE_KEY, KNOWLEDGE_PIPELINE_STRUCTURED
from novelvideo.story_analysis import chunk_source_text, source_sha256

DRAMA_TEXT = """第一集

1-1 林家客厅 日 内
人物：林默、林母
林默推开门。
林母抬头看他。

1-2 巷口 夜 外
人物：林默
林默独自走过巷口。

1-3 林家客厅 夜 内
人物：林默
林默坐在沙发上发呆。
"""

NARRATED_TEXT = """第一章 归来

林默回到阔别十年的故乡。
街道还是老样子。

第二章 旧友

他在巷口遇见了旧友。

第三章 真相

旧友告诉他一个秘密。
"""


def _padded(body: str) -> str:
    """Pad a section past the packing target so it stays its own chunk."""
    return body + "\n" + "闲笔叙述。" * 640 + "\n"


DRAMA_LONG = (
    "第一集\n\n"
    + "1-1 林家客厅 日 内\n人物：林默、林母\n" + _padded("林默推开门。林母抬头看他。")
    + "\n1-2 巷口 夜 外\n人物：林默\n" + _padded("林默独自走过巷口。")
    + "\n1-3 林家客厅 夜 内\n人物：林默\n" + _padded("林默坐在沙发上发呆。")
)

NARRATED_LONG = (
    "第一章 归来\n\n" + _padded("林默回到阔别十年的故乡。街道还是老样子。")
    + "\n第二章 旧友\n\n" + _padded("他在巷口遇见了旧友。")
    + "\n第三章 真相\n\n" + _padded("旧友告诉他一个秘密。")
)


def _write_config(state_dir: Path, config: dict) -> None:
    state_dir.mkdir(parents=True, exist_ok=True)
    (state_dir / "project_config.json").write_text(
        json.dumps(config, ensure_ascii=False), encoding="utf-8"
    )


# ── chunking ────────────────────────────────────────────────────────────────


def _assert_offsets_are_exact(chunks, text):
    """Every chunk must quote the source exactly at the offsets it reports.

    This is what later extraction relies on to prove an entity is real, so a
    drifting offset has to fail here rather than silently validate invented
    evidence.
    """
    for chunk in chunks:
        assert chunk.source_start < chunk.source_end
        assert text[chunk.source_start : chunk.source_end] == chunk.text


def test_drama_chunks_split_on_scene_headings():
    chunks = chunk_source_text(DRAMA_LONG, "drama")
    assert len(chunks) >= 3
    assert all(chunk.section_type == "scene" for chunk in chunks)
    _assert_offsets_are_exact(chunks, DRAMA_LONG)


def test_drama_chunks_are_ordered_and_non_overlapping():
    chunks = chunk_source_text(DRAMA_LONG, "drama")
    for earlier, later in zip(chunks, chunks[1:]):
        assert earlier.source_end <= later.source_start


def test_drama_chunk_keeps_its_scene_body():
    chunks = chunk_source_text(DRAMA_LONG, "drama")
    joined = [chunk.text for chunk in chunks]
    assert any("林母抬头看他" in text for text in joined)
    assert any("林默独自走过巷口" in text for text in joined)


def test_narrated_chunks_split_on_chapters():
    chunks = chunk_source_text(NARRATED_LONG, "narrated")
    assert len(chunks) == 3
    assert all(chunk.section_type == "chapter" for chunk in chunks)
    _assert_offsets_are_exact(chunks, NARRATED_LONG)


def test_narrated_chapter_offsets_land_on_chapter_starts():
    chunks = chunk_source_text(NARRATED_LONG, "narrated")
    assert chunks[0].text.startswith("第一章")
    assert chunks[1].text.startswith("第二章")
    assert "旧友告诉他一个秘密" in chunks[2].text


def test_prose_without_chapter_markers_falls_back_to_windows():
    """A malformed import must still produce analysable chunks."""
    text = "没有任何章节标记的长文。" * 2000
    chunks = chunk_source_text(text, "narrated")
    assert chunks
    assert all(chunk.section_type == "window" for chunk in chunks)
    for chunk in chunks:
        assert text[chunk.source_start : chunk.source_end] == chunk.text


def test_window_fallback_overlaps_so_boundaries_are_not_lost():
    text = "甲" * 20000
    chunks = chunk_source_text(text, "narrated")
    assert len(chunks) > 1
    for earlier, later in zip(chunks, chunks[1:]):
        assert later.source_start < earlier.source_end


def test_empty_text_produces_no_chunks():
    assert chunk_source_text("   \n  ", "drama") == []


def test_chunk_hash_tracks_content():
    chunks = chunk_source_text(NARRATED_LONG, "narrated")
    assert chunks[0].source_hash != chunks[1].source_hash
    assert len(chunks[0].source_hash) == 64


# ── import ──────────────────────────────────────────────────────────────────


@pytest.fixture
async def structured_project(tmp_path):
    from novelvideo.sqlite_store import SQLiteStore

    state_dir = tmp_path / "user" / "structured"
    _write_config(state_dir, {KNOWLEDGE_PIPELINE_KEY: KNOWLEDGE_PIPELINE_STRUCTURED})
    store = SQLiteStore(
        "user/structured",
        output_dir=str(state_dir),
        state_dir=str(state_dir),
    )
    await store.initialize()
    try:
        yield store, state_dir
    finally:
        await store.close()


async def test_structured_import_records_run_and_chunks(structured_project, tmp_path):
    from novelvideo.structured_ingest import (
        STRUCTURED_ANALYSIS_VERSION,
        STRUCTURED_SCHEMA_VERSION,
        ingest_source_text_structured,
    )

    store, state_dir = structured_project
    novel = tmp_path / "novel.txt"
    novel.write_text(NARRATED_LONG, encoding="utf-8")

    result = await ingest_source_text_structured(
        store, str(novel), spine_template="narrated"
    )

    assert result["pipeline"] == "structured_v1"
    assert result["status"] == "source_ready"
    assert result["chunks"] == 3
    assert result["section_type"] == "chapter"

    run = await store.get_reusable_analysis_run(
        source_sha256=source_sha256(NARRATED_LONG),
        schema_version=STRUCTURED_SCHEMA_VERSION,
        pipeline_version=STRUCTURED_ANALYSIS_VERSION,
        spine_template="narrated",
    )
    assert run is not None and run["run_id"] == result["run_id"]

    chunks = await store.list_analysis_chunks(result["run_id"])
    assert len(chunks) == 3
    assert [chunk["status"] for chunk in chunks] == ["pending"] * 3
    assert [chunk["chunk_index"] for chunk in chunks] == [0, 1, 2]


async def test_structured_import_never_touches_cognee(
    structured_project, tmp_path, monkeypatch
):
    """The sentinel: import is where the legacy path spends its embedding time."""
    import cognee

    from novelvideo.structured_ingest import ingest_source_text_structured

    def _boom(*args, **kwargs):
        raise AssertionError("structured_v1 import must not touch Cognee")

    for name in ("add", "cognify", "memify", "search"):
        monkeypatch.setattr(cognee, name, _boom, raising=False)

    store, _ = structured_project
    novel = tmp_path / "novel.txt"
    novel.write_text(NARRATED_LONG, encoding="utf-8")

    await ingest_source_text_structured(store, str(novel), spine_template="narrated")


async def test_structured_import_writes_no_embedding_fields(
    structured_project, tmp_path
):
    from novelvideo.embedding_models import (
        PROJECT_EMBEDDING_DIMENSION_KEY,
        PROJECT_EMBEDDING_MODEL_KEY,
    )
    from novelvideo.structured_ingest import ingest_source_text_structured

    store, state_dir = structured_project
    novel = tmp_path / "novel.txt"
    novel.write_text(NARRATED_LONG, encoding="utf-8")

    await ingest_source_text_structured(store, str(novel), spine_template="narrated")

    config = json.loads((state_dir / "project_config.json").read_text(encoding="utf-8"))
    assert PROJECT_EMBEDDING_MODEL_KEY not in config
    assert PROJECT_EMBEDDING_DIMENSION_KEY not in config


async def test_reimporting_identical_text_reuses_the_run(structured_project, tmp_path):
    """Resume must not discard completed chunk work for unchanged text."""
    from novelvideo.structured_ingest import ingest_source_text_structured

    store, _ = structured_project
    novel = tmp_path / "novel.txt"
    novel.write_text(NARRATED_LONG, encoding="utf-8")

    first = await ingest_source_text_structured(
        store, str(novel), spine_template="narrated"
    )
    chunks = await store.list_analysis_chunks(first["run_id"])
    await store.mark_analysis_chunk_done(
        first["run_id"], chunks[0]["chunk_id"], json.dumps({"characters": ["林默"]})
    )

    second = await ingest_source_text_structured(
        store, str(novel), spine_template="narrated"
    )
    assert second["run_id"] == first["run_id"]

    after = await store.list_analysis_chunks(first["run_id"])
    done = [chunk for chunk in after if chunk["status"] == "done"]
    assert len(done) == 1
    assert json.loads(done[0]["result_json"]) == {"characters": ["林默"]}


async def test_pre_language_analysis_run_is_retained_but_not_reused(
    structured_project, tmp_path
):
    from novelvideo.structured_ingest import (
        STRUCTURED_SCHEMA_VERSION,
        ingest_source_text_structured,
    )

    store, _ = structured_project
    chunks = chunk_source_text(NARRATED_LONG, "narrated")
    digest = source_sha256(NARRATED_LONG)
    await store.start_analysis_run(
        run_id="pre-language-contract",
        pipeline_version="structured_v1",
        schema_version=STRUCTURED_SCHEMA_VERSION,
        spine_template="narrated",
        source_sha256=digest,
        source_length=len(NARRATED_LONG),
        chunks=chunks,
    )
    novel = tmp_path / "novel.txt"
    novel.write_text(NARRATED_LONG, encoding="utf-8")

    result = await ingest_source_text_structured(
        store, str(novel), spine_template="narrated"
    )

    assert result["pipeline"] == "structured_v1"
    assert result["run_id"] != "pre-language-contract"
    old = await store.get_reusable_analysis_run(
        source_sha256=digest,
        schema_version=STRUCTURED_SCHEMA_VERSION,
        pipeline_version="structured_v1",
        spine_template="narrated",
    )
    assert old is not None and old["run_id"] == "pre-language-contract"


async def test_changing_the_text_starts_a_new_run(structured_project, tmp_path):
    from novelvideo.structured_ingest import ingest_source_text_structured

    store, _ = structured_project
    novel = tmp_path / "novel.txt"

    novel.write_text(NARRATED_LONG, encoding="utf-8")
    first = await ingest_source_text_structured(
        store, str(novel), spine_template="narrated"
    )

    novel.write_text(NARRATED_LONG + "\n第四章 结局\n\n" + _padded("他终于释怀。"), encoding="utf-8")
    second = await ingest_source_text_structured(
        store, str(novel), spine_template="narrated"
    )

    assert second["run_id"] != first["run_id"]
    assert second["chunks"] == 4


async def test_novel_txt_is_not_written_when_import_fails(structured_project, tmp_path):
    """novel.txt is the public success marker and must not survive a failure."""
    from novelvideo.structured_ingest import ingest_source_text_structured

    store, state_dir = structured_project
    novel = tmp_path / "script.txt"
    novel.write_text("这是一段没有任何场景头的正文。\n", encoding="utf-8")

    with pytest.raises(ValueError):
        await ingest_source_text_structured(store, str(novel), spine_template="drama")

    assert not (Path(store.project_dir) / "novel.txt").exists()


async def test_empty_upload_is_rejected(structured_project, tmp_path):
    from novelvideo.structured_ingest import ingest_source_text_structured

    store, _ = structured_project
    novel = tmp_path / "empty.txt"
    novel.write_text("   \n\n", encoding="utf-8")

    with pytest.raises(ValueError):
        await ingest_source_text_structured(
            store, str(novel), spine_template="narrated"
        )


async def test_drama_import_chunks_by_scene(structured_project, tmp_path):
    from novelvideo.structured_ingest import ingest_source_text_structured

    store, _ = structured_project
    novel = tmp_path / "script.txt"
    novel.write_text(DRAMA_LONG, encoding="utf-8")

    result = await ingest_source_text_structured(
        store, str(novel), spine_template="drama"
    )
    assert result["section_type"] == "scene"
    assert result["chunks"] >= 3


# ── evidence ────────────────────────────────────────────────────────────────


async def test_entity_evidence_round_trips(structured_project, tmp_path):
    from novelvideo.structured_ingest import ingest_source_text_structured

    store, _ = structured_project
    novel = tmp_path / "novel.txt"
    novel.write_text(NARRATED_LONG, encoding="utf-8")
    result = await ingest_source_text_structured(
        store, str(novel), spine_template="narrated"
    )

    await store.replace_entity_evidence(
        result["run_id"],
        "character",
        "林默",
        [
            {
                "chunk_id": "chapter-0000",
                "source_start": 0,
                "source_end": 10,
                "evidence_kind": "mention",
                "evidence_text": "林默回到阔别十年的故乡",
            }
        ],
    )
    rows = await store.list_entity_evidence("character", "林默")
    assert len(rows) == 1
    assert rows[0]["evidence_text"] == "林默回到阔别十年的故乡"


async def test_replacing_evidence_does_not_accumulate_duplicates(
    structured_project, tmp_path
):
    """Re-running a chunk must not pile up repeated spans for one entity."""
    from novelvideo.structured_ingest import ingest_source_text_structured

    store, _ = structured_project
    novel = tmp_path / "novel.txt"
    novel.write_text(NARRATED_LONG, encoding="utf-8")
    result = await ingest_source_text_structured(
        store, str(novel), spine_template="narrated"
    )

    evidence = [
        {
            "chunk_id": "chapter-0000",
            "source_start": 0,
            "source_end": 10,
            "evidence_kind": "mention",
            "evidence_text": "林默",
        }
    ]
    await store.replace_entity_evidence(result["run_id"], "character", "林默", evidence)
    await store.replace_entity_evidence(result["run_id"], "character", "林默", evidence)

    assert len(await store.list_entity_evidence("character", "林默")) == 1


# ── AI planning rejection ───────────────────────────────────────────────────


async def test_structured_project_rejects_ai_planning_before_enqueue(
    tmp_path, monkeypatch
):
    """Reject before enqueue so the user gets an answer, not a doomed task.

    The AI planners read the Cognee graph, which structured projects do not
    have, and enqueueing would reserve credit for work that cannot succeed.
    """
    from types import SimpleNamespace

    from novelvideo.api.routes import episodes
    from novelvideo.api.schemas import EpisodePlanRequest
    from novelvideo.knowledge_pipeline import KnowledgePipelineUnsupported

    state_dir = tmp_path / "user" / "structured"
    _write_config(state_dir, {KNOWLEDGE_PIPELINE_KEY: KNOWLEDGE_PIPELINE_STRUCTURED})
    project_dir = tmp_path / "out"
    project_dir.mkdir()
    (project_dir / "novel.txt").write_text(NARRATED_TEXT, encoding="utf-8")

    async def resolve_project_scope(project, user, required_role="viewer"):
        return SimpleNamespace(
            ctx=SimpleNamespace(project_id="proj_1"),
            output_dir=str(project_dir),
            state_dir=str(state_dir),
            project_dir=str(project_dir),
        )

    async def reject_enqueue(*_args, **_kwargs):
        raise AssertionError("structured_v1 must not enqueue an AI planning task")

    monkeypatch.setattr(episodes, "resolve_project_scope", resolve_project_scope)
    monkeypatch.setattr(
        episodes,
        "get_task_backend",
        lambda: SimpleNamespace(enqueue_project_task=reject_enqueue),
    )

    response = await episodes.plan_episodes(
        project="proj_1",
        body=EpisodePlanRequest(target_episodes=10, planning_mode="ai"),
        user={"username": "admin"},
    )

    assert response["ok"] is False
    assert response["code"] == KnowledgePipelineUnsupported.error_code


async def test_structured_project_allows_deterministic_chapter_planning(
    tmp_path, monkeypatch
):
    """The mode the frontend actually uses must keep working."""
    from types import SimpleNamespace

    from novelvideo.api.routes import episodes
    from novelvideo.api.schemas import EpisodePlanRequest

    state_dir = tmp_path / "user" / "structured"
    _write_config(state_dir, {KNOWLEDGE_PIPELINE_KEY: KNOWLEDGE_PIPELINE_STRUCTURED})
    project_dir = tmp_path / "out"
    project_dir.mkdir()
    (project_dir / "novel.txt").write_text(NARRATED_TEXT, encoding="utf-8")

    enqueued = {}

    async def resolve_project_scope(project, user, required_role="viewer"):
        return SimpleNamespace(
            ctx=SimpleNamespace(project_id="proj_1"),
            output_dir=str(project_dir),
            state_dir=str(state_dir),
            project_dir=str(project_dir),
        )

    async def accept_enqueue(*_args, **kwargs):
        enqueued.update(kwargs)
        return SimpleNamespace(
            task_state=SimpleNamespace(task_id="task_1"),
            backend="celery",
            queue="default",
        )

    monkeypatch.setattr(episodes, "resolve_project_scope", resolve_project_scope)
    monkeypatch.setattr(
        episodes,
        "get_task_backend",
        lambda: SimpleNamespace(enqueue_project_task=accept_enqueue),
    )

    response = await episodes.plan_episodes(
        project="proj_1",
        body=EpisodePlanRequest(target_episodes=10, planning_mode="chapters"),
        user={"username": "admin"},
    )

    assert response["ok"] is True
    assert enqueued["payload"]["config"]["planning_mode"] == "chapters"


async def test_legacy_project_still_accepts_ai_planning(tmp_path, monkeypatch):
    """The gate must be invisible to legacy projects."""
    from types import SimpleNamespace

    from novelvideo.api.routes import episodes
    from novelvideo.api.schemas import EpisodePlanRequest

    state_dir = tmp_path / "user" / "legacy"
    _write_config(state_dir, {"user": "user"})
    project_dir = tmp_path / "out"
    project_dir.mkdir()
    (project_dir / "novel.txt").write_text(NARRATED_TEXT, encoding="utf-8")

    async def resolve_project_scope(project, user, required_role="viewer"):
        return SimpleNamespace(
            ctx=SimpleNamespace(project_id="proj_1"),
            output_dir=str(project_dir),
            state_dir=str(state_dir),
            project_dir=str(project_dir),
        )

    async def accept_enqueue(*_args, **_kwargs):
        return SimpleNamespace(
            task_state=SimpleNamespace(task_id="task_1"),
            backend="celery",
            queue="default",
        )

    monkeypatch.setattr(episodes, "resolve_project_scope", resolve_project_scope)
    monkeypatch.setattr(
        episodes,
        "get_task_backend",
        lambda: SimpleNamespace(enqueue_project_task=accept_enqueue),
    )

    response = await episodes.plan_episodes(
        project="proj_1",
        body=EpisodePlanRequest(target_episodes=10, planning_mode="ai"),
        user={"username": "admin"},
    )

    assert response["ok"] is True


def test_short_neighbouring_sections_are_packed_into_one_chunk():
    """A call costs the same round trip whether it carries 300 or 3000 chars.

    A screenplay of many short scenes would otherwise spend nearly all of its
    build time waiting on round trips rather than reading text.
    """
    chunks = chunk_source_text(DRAMA_TEXT, "drama")
    assert len(chunks) == 1
    assert chunks[0].source_start == 0
    assert chunks[0].text == DRAMA_TEXT
    # Everyone named across the packed scenes is still carried.
    assert "林母" in chunks[0].characters


def test_packing_stops_at_the_target_size():
    chunks = chunk_source_text(DRAMA_LONG, "drama")
    # The "第一集" line before the first scene heading is its own preamble chunk.
    assert len(chunks) == 4
    for chunk in chunks:
        assert DRAMA_LONG[chunk.source_start : chunk.source_end] == chunk.text


def test_packing_never_loses_or_duplicates_source():
    for text, spine in ((DRAMA_LONG, "drama"), (NARRATED_LONG, "narrated")):
        chunks = chunk_source_text(text, spine)
        assert chunks[0].source_start == 0
        assert chunks[-1].source_end == len(text)
        for earlier, later in zip(chunks, chunks[1:]):
            assert earlier.source_end == later.source_start


def test_text_before_the_first_scene_heading_is_still_analysed():
    """A synopsis or cast list is the densest description a script has."""
    script = (
        "《测试剧》\n\n人物小传：\n【林默】：22岁，性格沉静。\n\n"
        "1-1 林家客厅 日 内\n人物：林默\n林默推开门。\n"
    )
    chunks = chunk_source_text(script, "drama")
    assert chunks[0].source_start == 0
    assert "人物小传" in "".join(c.text for c in chunks)


def test_text_before_the_first_chapter_marker_is_still_analysed():
    """Prose sources carry a synopsis or cast list ahead of chapter one.

    The screenplay path already kept it; the chapter path was dropping it, and
    it is exactly the passage that names and describes the cast.
    """
    novel = (
        "《测试小说》\n\n人物小传：\n【林默】：22岁，性格沉静。\n\n"
        + NARRATED_LONG
    )
    chunks = chunk_source_text(novel, "narrated")
    assert chunks[0].source_start == 0
    assert "人物小传" in chunks[0].text


def test_every_spine_covers_the_whole_source_without_gaps():
    """Nothing may fall between two chunks, whichever way the source is cut."""
    for text, spine in (
        ("《剧》\n\n人物小传：\n【林默】\n\n" + DRAMA_LONG, "drama"),
        ("《书》\n\n人物小传：\n【林默】\n\n" + NARRATED_LONG, "narrated"),
    ):
        chunks = chunk_source_text(text, spine)
        assert chunks[0].source_start == 0
        assert chunks[-1].source_end == len(text)
        for earlier, later in zip(chunks, chunks[1:]):
            assert earlier.source_end == later.source_start
        assert sum(len(c.text) for c in chunks) == len(text)
