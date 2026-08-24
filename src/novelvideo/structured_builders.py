"""Project-level asset builds for structured_v1 projects.

Each build reads the imported source text and publishes to SQLite.  None of them
touch Cognee, an embedding model or the graph.

The three builds differ in how much they can usefully do up front:

* **Characters** are worth discovering across the whole work, for both formats.
* **Scenes** are worth discovering up front only for screenplays, where scene
  headings already name every location.  Narrated projects have no comparable
  marker, so their scenes accumulate per episode instead.
* **Props** are never worth a full-text sweep.  What matters is which objects
  carry story weight in a given episode, which is a per-episode judgement.
"""

from __future__ import annotations

from typing import Any, Callable, Optional

from novelvideo.novel_source import require_imported_novel
from novelvideo.project_config import load_project_config_file_from_state_dir
import json

from novelvideo.story_analysis import SourceChunk, chunk_source_text

PROP_BUILD_DEFERRED_MESSAGE = "道具将在分集规划时按需生成"
SCENE_BUILD_DEFERRED_MESSAGE = "解说剧场景将在分集规划时按需生成"


def spine_template_for(store: Any) -> str:
    config = load_project_config_file_from_state_dir(store.state_dir)
    return str(config.get("spine_template") or "drama").strip()


async def build_characters_structured(
    store: Any,
    *,
    on_progress: Optional[Callable[[float, str], None]] = None,
    on_log: Optional[Callable[[str], None]] = None,
) -> list[str]:
    """Discover characters from the source text and publish them atomically.

    Only missing characters are added.  An existing character may already carry
    user edits, a portrait, identities and voice bindings, so a rebuild must
    never overwrite one.
    """
    from novelvideo.structured_extraction import (
        ChunkCharacterOutput,
        MergedCharacter,
        extract_characters_from_chunks,
    )

    def report(progress: float, task: str) -> None:
        if on_progress:
            on_progress(progress, task)

    def log(message: str) -> None:
        if on_log:
            on_log(message)

    novel_text = require_imported_novel(store.project_dir)
    template = spine_template_for(store)

    report(0.1, "切分原文...")
    chunks = chunk_source_text(novel_text, template)
    if not chunks:
        log("⚠️ 原文切分结果为空")
        report(1.0, "无可分析内容")
        return []
    log(f"确定性切分: {len(chunks)} 个片段（{chunks[0].section_type}）")

    run = await _current_run(store, novel_text, template)
    run_id = run["run_id"] if run else ""

    # Resume: a retried task or a second click on "build characters" must not
    # pay for every chunk again. Chunks already recorded as done are replayed
    # from their stored result instead of being sent to the model.
    cached: list[tuple[SourceChunk, ChunkCharacterOutput]] = []
    pending = chunks
    if run_id:
        done = {
            row["chunk_id"]: row
            for row in await store.list_analysis_chunks(run_id, status="done")
        }
        by_id = {chunk.chunk_id: chunk for chunk in chunks}
        for chunk_id, row in done.items():
            chunk = by_id.get(chunk_id)
            # A stored result only applies if the span it was produced from is
            # byte-identical; otherwise the text moved and it must be redone.
            if chunk is None or row["source_hash"] != chunk.source_hash:
                continue
            try:
                cached.append(
                    (chunk, ChunkCharacterOutput.model_validate_json(row["result_json"]))
                )
            except Exception:
                continue
        replayed = {chunk.chunk_id for chunk, _ in cached}
        pending = [chunk for chunk in chunks if chunk.chunk_id not in replayed]
        if cached:
            log(f"复用 {len(cached)} 个已完成片段，仅重算 {len(pending)} 个")

    # A completed run replays its final cast rather than re-adjudicating. Chunk
    # caching alone still costs one adjudication call per rebuild, and a second
    # adjudication can decide differently — leaving an alias to reappear as its
    # own character, which add_characters_atomic would then insert as a new row.
    if run_id and not pending:
        stored = await store.get_analysis_artifact(run_id, "characters")
        if stored:
            try:
                payload = json.loads(stored)
            except ValueError:
                payload = None
            if payload:
                log(f"复用上次裁决结果：{len(payload)} 个角色，未调用模型")
                merged = [
                    MergedCharacter(
                        name=item["name"],
                        aliases=set(item.get("aliases") or []),
                        gender=item.get("gender", ""),
                        description=item.get("description", ""),
                        evidence=list(item.get("evidence") or []),
                    )
                    for item in payload
                ]
                return await _publish_characters(
                    store, merged, run_id, report, log
                )

    async def persist_done(chunk: SourceChunk, output: ChunkCharacterOutput) -> None:
        if run_id:
            await store.mark_analysis_chunk_done(
                run_id, chunk.chunk_id, output.model_dump_json()
            )

    async def persist_failed(chunk: SourceChunk, exc: BaseException) -> None:
        if run_id:
            await store.mark_analysis_chunk_failed(run_id, chunk.chunk_id, str(exc))

    report(0.2, "逐片段抽取角色...")
    merged, failures = await extract_characters_from_chunks(
        pending,
        on_log=log,
        cached_outcomes=cached,
        source_text=novel_text,
        # Cast lists come from every chunk, including ones replayed from cache,
        # so a resumed build protects the same characters a fresh one does.
        roster={name for chunk in chunks for name in chunk.characters},
        on_chunk_done=persist_done,
        on_chunk_failed=persist_failed,
    )
    async def finish(status_error: tuple[str, str]) -> None:
        if run_id:
            await store.finish_analysis_run(
                run_id, status=status_error[0], error=status_error[1]
            )

    outcome = (
        ("partial", f"{len(failures)} chunks failed") if failures else ("completed", "")
    )

    if not merged:
        # Nothing to publish, but the run still has to be closed out, or the
        # next build sees a run stuck at "pending" and cannot tell whether work
        # is outstanding.
        await finish(outcome)
        log("⚠️ 未抽取到有原文证据的角色，保留现有角色数据")
        report(1.0, "提取无结果")
        return []
    log(f"归一后得到 {len(merged)} 个角色候选")

    # A partial run must never store its cast as the run's final result. The
    # replay guard only checks that no chunk is still pending, so once the
    # failed chunks succeed on a later attempt, a stale artifact written here
    # would be replayed instead — publishing a cast that is missing exactly the
    # characters those chunks were carrying.
    if run_id and not failures:
        await store.save_analysis_artifact(
            run_id,
            "characters",
            json.dumps(
                [
                    {
                        "name": item.name,
                        "aliases": sorted(item.aliases),
                        "gender": item.gender,
                        "description": item.description,
                        "evidence": item.evidence,
                    }
                    for item in merged
                ],
                ensure_ascii=False,
            ),
        )

    return await _publish_characters(
        store, merged, run_id, report, log, outcome
    )



def _source_synopsis(store: Any) -> str:
    """The screenplay block before the first scene, or "" for prose.

    Read here rather than threaded in from the build, because a cast replayed
    from a stored run reaches publication without the source text in hand and
    must still be described from the same input a fresh build used.
    """
    from novelvideo.cognee.script_parser import extract_synopsis

    try:
        return extract_synopsis(require_imported_novel(store.project_dir))
    except Exception:  # noqa: BLE001 - a missing source only costs context
        return ""


def _apply_appearance(character: Any, appearance: Any, voice_for: Callable) -> None:
    """Write an appearance answer onto a character about to be created."""
    if appearance is None:
        return
    character.role = appearance.role
    character.is_main = appearance.is_main
    character.age_group = appearance.age_group
    character.body_type = appearance.body_type
    character.face_prompt = appearance.face_prompt
    character.fish_voice_id = voice_for(appearance.age_group, character.gender)


async def _repair_missing_appearances(
    store: Any,
    added: set,
    appearances: dict,
    voice_for: Callable,
) -> int:
    """Fill the appearance fields an existing character still lacks.

    Every field is guarded on its own emptiness, and on nothing else. Gating
    the whole repair on a missing face was wrong: someone who typed a face by
    hand and left the rest alone would never get a role or a build, because the
    one field they filled locked the others out. A rebuild adds what is absent
    and overwrites nothing.
    """
    # ``_apply_appearance`` has already written the newly inserted rows, so a
    # narrator claimed by a new character is visible here and is not claimed
    # twice. Only one entry in ``appearances`` can be the narrator to begin
    # with — ``_enforce_single_main`` settles that — so the only conflict left
    # is with a narrator somebody marked by hand.
    narrator = next(
        (item.name for item in store.get_all_characters() if item.is_main), None
    )
    repaired = 0
    for name, appearance in appearances.items():
        if name in added:
            continue
        existing = store.get_character(name)
        if existing is None:
            continue
        updates: dict[str, Any] = {}
        if not str(existing.face_prompt or "").strip():
            updates["face_prompt"] = appearance.face_prompt
        if not str(existing.role or "").strip() and appearance.role:
            updates["role"] = appearance.role
        if not str(existing.body_type or "").strip() and appearance.body_type:
            updates["body_type"] = appearance.body_type
        if not str(existing.fish_voice_id or "").strip():
            # The age band has no empty state — it defaults to "youth" — so an
            # unbound voice is what distinguishes a band nobody chose from one
            # somebody did. Where nothing is bound, the band and the voice it
            # selects are written together, so they cannot end up disagreeing.
            updates["age_group"] = appearance.age_group
            updates["fish_voice_id"] = voice_for(
                appearance.age_group, existing.gender
            )
        # is_main has no empty state either, and nothing binds to it, so an
        # unclaimed narrator is the only signal that nobody has decided. Left
        # unwritten, a project built before this stage keeps every character at
        # False and first-person narration fails with 未找到解说主角.
        if appearance.is_main and not existing.is_main and narrator is None:
            updates["is_main"] = True
            narrator = name
        if not updates:
            continue
        await store.update_character(name, **updates)
        repaired += 1
    return repaired


async def _publish_characters(
    store: Any,
    merged: list,
    run_id: str,
    report: Callable[[float, str], None],
    log: Callable[[str], None],
    outcome: tuple[str, str] = ("completed", ""),
) -> list[str]:
    """Publish a settled cast, whether freshly built or replayed from cache."""
    from novelvideo.cognee.pipeline import NovelCharacter, StoreAnalysisItemCache
    from novelvideo.config import get_fish_voice_id
    from novelvideo.structured_extraction import enrich_character_appearances

    # Extraction settles *who* exists; this settles what they look like. It runs
    # here rather than in the build so that a run replayed from its stored cast
    # fills faces too — otherwise a project built before this stage existed
    # could never acquire one without deleting its characters first.
    report(0.75, "补全角色形象...")
    appearances = await enrich_character_appearances(
        merged,
        synopsis=_source_synopsis(store),
        cache=StoreAnalysisItemCache(store),
        on_log=log,
    )

    report(0.8, "发布角色...")
    candidates = []
    for item in merged:
        character = NovelCharacter(
            name=item.name,
            aliases=sorted(item.aliases),
            gender=item.gender,
            description=item.description,
        )
        _apply_appearance(character, appearances.get(item.name), get_fish_voice_id)
        candidates.append(character)
    added = await store.add_characters_atomic(candidates, skip_existing=True)
    log(f"已新增 {len(added)} 个角色，跳过已有 {len(candidates) - len(added)} 个")

    # An existing character is an asset fact and a rebuild leaves it alone —
    # except for a face prompt it never had. Characters built before this stage
    # existed carry an empty one, and the portrait runner refuses to work
    # without it, so skipping them would strand those projects forever. Only
    # empty fields are written; anything the user typed is never touched.
    report(0.85, "补齐已有角色的空缺形象...")
    repaired = await _repair_missing_appearances(
        store, set(added), appearances, get_fish_voice_id
    )
    if repaired:
        log(f"已为 {repaired} 个已有角色补齐面部提示词")

    report(0.95, "记录角色证据...")
    if run_id:
        # Evidence is written for every merged character, not just the newly
        # added ones. Publishing characters and writing their evidence are two
        # steps: if the first succeeded and the second did not, a retry finds
        # the characters already present, so keying on "added" would leave them
        # permanently without provenance. Writing for all of them is idempotent
        # — replace_entity_evidence rewrites rather than appends — and never
        # touches the character rows a user may have edited.
        for item in merged:
            await store.replace_entity_evidence(
                run_id, "character", item.name, item.evidence
            )

    # Only now is the run genuinely finished. Marking it complete before
    # publishing would leave a run that claims success while its characters or
    # evidence never landed.
    if run_id:
        await store.finish_analysis_run(
            run_id, status=outcome[0], error=outcome[1]
        )

    report(1.0, "角色提取完成")
    return added


async def build_scenes_structured(
    store: Any,
    *,
    on_progress: Optional[Callable[[float, str], None]] = None,
    on_log: Optional[Callable[[str], None]] = None,
) -> dict:
    """Build base scenes from screenplay headings; defer for narrated projects.

    A screenplay names every location in its scene headings, so a full-text pass
    produces a genuinely reusable catalogue.  Narrated source has no equivalent
    marker: a full-text sweep would guess at locations, so those scenes are
    discovered per episode from that episode's own text instead.
    """
    from novelvideo.cognee.pipeline import (
        StoreSceneBuildCache,
        extract_scenes_from_script,
        should_repair_scene_placeholder,
    )
    from novelvideo.structured_extraction import adjudicate_scenes

    def report(progress: float, task: str) -> None:
        if on_progress:
            on_progress(progress, task)

    def log(message: str) -> None:
        if on_log:
            on_log(message)

    novel_text = require_imported_novel(store.project_dir)
    template = spine_template_for(store)

    if template != "drama":
        log(SCENE_BUILD_DEFERRED_MESSAGE)
        report(1.0, "无需提前构建场景")
        return {
            "scenes": 0,
            "added_scenes": 0,
            "mode": "episode_on_demand",
            "message": SCENE_BUILD_DEFERRED_MESSAGE,
        }

    report(0.1, "从场次头提取基础场景...")
    # Every stage below is a model call, and a screenplay has dozens of scenes.
    # Without a cache, a build that fails or is killed at scene 60 of 68 throws
    # away all sixty and the retry pays for them again.
    cache = StoreSceneBuildCache(store)
    scenes = await extract_scenes_from_script(
        novel_text,
        on_progress=lambda progress, task: report(0.1 + progress * 0.7, task),
        on_log=on_log,
        cache=cache,
    )
    if not scenes:
        log("⚠️ 未从场次头提取到场景，保留现有场景数据")
        report(1.0, "提取无结果")
        return {"scenes": 0, "added_scenes": 0, "mode": "script"}

    report(0.8, "归一同一地点的不同写法...")
    scenes = await adjudicate_scenes(
        scenes,
        occurrences=_scene_heading_counts(novel_text),
        on_log=log,
        cache=cache,
    )

    report(0.85, "保存新增场景...")
    added = 0
    skipped = 0
    repaired = 0
    for scene in scenes:
        # Existing base scenes and their derived plates are asset facts; a
        # rebuild adds what is missing and leaves the rest alone.
        existing = await store.get_scene(scene.name)
        if existing is None:
            await store.add_scene(scene)
            added += 1
            continue
        # One exception: a prompt this code generated because it could not use
        # the model's is not an asset fact, it is a placeholder. Those were
        # written for every scene while the contract validator rejected valid
        # single-line output, and skipping them would leave existing projects on
        # boilerplate forever. A prompt the user wrote or edited never matches
        # this fingerprint and is never touched.  Same predicate as the legacy
        # track, so both repair exactly the same rows.
        if should_repair_scene_placeholder(
            existing.environment_prompt, scene.environment_prompt
        ):
            await store.update_scene(
                existing.name, environment_prompt=scene.environment_prompt
            )
            repaired += 1
            continue
        skipped += 1
    log(
        f"已新增 {added} 个场景，修复占位描述 {repaired} 个，跳过已有 {skipped} 个"
    )

    report(1.0, "场景提取完成")
    return {
        "scenes": len(scenes),
        "added_scenes": added,
        "repaired_scenes": repaired,
        "mode": "script",
    }


async def build_props_structured(
    store: Any,
    *,
    on_progress: Optional[Callable[[float, str], None]] = None,
    on_log: Optional[Callable[[str], None]] = None,
) -> dict:
    """Report that props are discovered per episode, not swept up front.

    A full-text prop sweep cannot tell a story-bearing object from background
    furniture, because that distinction depends on what an episode does with it.
    This returns an explicit deferral rather than a silent no-op, so callers do
    not read "0 props" as "the analysis found nothing".
    """
    if on_log:
        on_log(PROP_BUILD_DEFERRED_MESSAGE)
    if on_progress:
        on_progress(1.0, "道具按分集生成")
    return {
        "props": 0,
        "mode": "episode_on_demand",
        "message": PROP_BUILD_DEFERRED_MESSAGE,
    }


def _scene_heading_counts(novel_text: str) -> dict[str, int]:
    """How many scenes each heading location covers.

    The adjudicator prefers the spelling the script actually uses most, which
    is a better canonical name than whichever variant happened to sort first.
    """
    from novelvideo.utils.screenplay_scene_parser import parse_scene_blocks

    counts: dict[str, int] = {}
    for block in parse_scene_blocks(novel_text):
        location = (block.location or "").strip()
        if location:
            counts[location] = counts.get(location, 0) + 1
    return counts


async def _current_run(store: Any, novel_text: str, spine_template: str) -> dict | None:
    """Find the analysis run recorded for the text now on disk.

    The spine template is part of the key: the same novel chunked as a
    screenplay and as narrated prose produces different chunk plans, so one
    must never inherit the other's results.
    """
    from novelvideo.story_analysis import source_sha256
    from novelvideo.structured_ingest import (
        STRUCTURED_PIPELINE_VERSION,
        STRUCTURED_SCHEMA_VERSION,
    )

    return await store.get_reusable_analysis_run(
        source_sha256=source_sha256(novel_text),
        schema_version=STRUCTURED_SCHEMA_VERSION,
        pipeline_version=STRUCTURED_PIPELINE_VERSION,
        spine_template=spine_template,
    )
