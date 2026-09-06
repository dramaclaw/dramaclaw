"""Character extraction straight from source text, without a knowledge graph.

The legacy path asks Cognee for graph context and lets a model name whoever it
finds there.  Structured extraction inverts that: the model only reports what a
specific span of text supports, and every candidate it returns must quote the
span it came from.  A quote that is not in the chunk is dropped, and a name the
imported source never writes is dropped, so a name invented outright has no
route into the character table.

What that does *not* establish is that the right quote was attached to the
right name.  A model can pair a real name with a real sentence about someone
else, and no check here can tell; the guards bound what may enter, not who a
line is about.  Attribution is left to the conservative merging below and to
whoever reads the result.

Merging is deliberately conservative.  A character's name is simultaneously a
SQLite primary key, a REST identifier and an asset directory name, so a wrong
merge is expensive to undo and a wrong split is cheap.  Rules therefore only
merge what the text states outright, and anything genuinely ambiguous is left
as separate candidates rather than guessed at.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
from dataclasses import dataclass, field
from types import SimpleNamespace
from typing import Any, Callable, Iterable, Optional

from pydantic import BaseModel, Field

from novelvideo.story_analysis import SourceChunk
from novelvideo.utils.bounded_concurrency import (
    default_llm_concurrency,
    map_bounded,
)
from novelvideo.utils.source_language import (
    AssetLanguage,
    asset_language_instruction,
    detect_asset_language,
)

# Titles and kinship terms refer to whoever is on stage at the time. The same
# word in two chapters is routinely two different people, so they never merge
# across chunks on their own and never become aliases automatically.
GENERIC_ADDRESS_TERMS = {
    "母亲", "父亲", "爸爸", "妈妈", "娘", "爹", "儿子", "女儿",
    "哥哥", "姐姐", "弟弟", "妹妹", "爷爷", "奶奶", "外公", "外婆",
    "医生", "护士", "老师", "司机", "老板", "警察", "士兵", "侍卫",
    "陛下", "殿下", "大人", "公子", "小姐", "夫人", "先生", "少爷",
    "掌柜", "伙计", "路人", "村民", "宫女", "太监", "将军", "丫鬟",
    "男人", "女人", "老人", "孩子", "少年", "少女", "他", "她",
    # Role labels from a treatment or cast list, not names anyone is called by.
    "女主", "男主", "主角", "配角", "反派",
    "大小姐", "少爷", "小少爷", "校霸", "狗腿子", "保镖", "佣人",
}

# Job titles and honorifics that a script attaches to a name: "校长吴显德",
# "孙海教授". A name plus only these tokens is the same person under a fuller
# form, so the two may be merged.
#
# Kinship terms are deliberately absent. "郑玉琴的女儿" minus "郑玉琴" leaves a
# kinship remainder, and that names a *different* person — merging on it would
# collapse a parent and a child into one character.
TITLE_TOKENS = (
    "董事长", "总经理", "副总裁", "总裁", "副总", "总监", "经理", "主管",
    "校长", "主任", "教授", "老师", "医生", "护士", "律师", "警官",
    "管家", "秘书", "助理", "司机", "保安", "店长", "老板", "厂长",
    "学校", "公司", "集团", "郑氏", "先生", "女士", "小姐", "太太",
    # Scripts also prefix a name with the role a character plays in the story,
    # as in "校霸张小倩" or "佣人王妈".
    "校霸", "佣人", "保镖", "学生", "狗腿子", "项目",
)

# Pronouns and possessives a script puts in front of a kinship word, giving
# "你妈" or "他的母亲". These are the same non-characters as the bare terms.
_POSSESSIVE_PREFIX_RE = re.compile(r"^(?:你|我|他|她|您|咱|其)(?:的)?")

# Explicit alias statements. Only these license an alias link; a model asserting
# two names are the same without the text saying so is not enough.
_ALIAS_PATTERNS = [
    re.compile(r"(?P<a>[一-鿿]{2,6})\s*(?:又名|本名|原名|真名|化名|人称|人称是|即)\s*(?P<b>[一-鿿]{2,6})"),
    re.compile(r"(?P<a>[一-鿿]{2,6})\s*(?:又|也)\s*(?:叫|称|唤)(?:作|做)?\s*(?P<b>[一-鿿]{2,6})"),
    re.compile(r"(?P<a>[一-鿿]{2,6})\s*(?:小名|乳名|别号|外号|绰号)\s*(?:叫|是|为)?\s*(?P<b>[一-鿿]{2,6})"),
]


class CharacterEvidence(BaseModel):
    quote: str = Field(description="原文中的一句完整引用，必须逐字来自输入文本")
    kind: str = Field(default="mention", description="mention / dialogue / description")


class CharacterCandidate(BaseModel):
    name: str = Field(description="角色在本片段中的称呼，保持原文写法")
    aliases: list[str] = Field(default_factory=list, description="仅限本片段原文明确写出的别名")
    appellations: list[str] = Field(
        default_factory=list,
        description="本片段中用来称呼该角色的其他说法（昵称、职务、称号），必须逐字出现在本片段原文中",
    )
    gender: str = Field(default="", description="male / female / 空字符串表示未知")
    description: str = Field(default="", description="本片段支持的简短描述")
    evidence: list[CharacterEvidence] = Field(default_factory=list)


class ChunkCharacterOutput(BaseModel):
    characters: list[CharacterCandidate] = Field(default_factory=list)


CHARACTER_EXTRACTION_SYSTEM_PROMPT = """你是剧本/小说的角色抽取器。输入是作品中的一个片段。

只根据本片段判断，不要推测片段以外的信息。

规则：
- name 用本片段原文中出现的称呼，保持原文写法，不要翻译或改写。
- 每个角色至少给出一条 evidence.quote，必须是本片段原文中逐字出现的一句话。
- 不要编造引用。找不到原文依据的角色不要输出。
- aliases 只填本片段原文明确写出的别名，例如“林默又名小默”。
- appellations 填本片段中明显用来称呼这个角色的其他说法：昵称、职务、称号。
  例如本片段里“郑太”“郑总”都指郑玉琴，就写进郑玉琴的 appellations。
  每一个都必须逐字出现在本片段原文中，不要编造。
  只有在本片段的上下文里能看出指向该角色时才填；看不出来就不要填。
- 不确定两个称呼是不是同一个人时，分别输出两个角色，不要合并。
- 旁白、画外音、镜头提示不是角色。
- 群体（众人、士兵们、村民们）不是角色。"""


@dataclass
class MergedCharacter:
    """One character after deterministic merging across chunks."""

    name: str
    aliases: set[str] = field(default_factory=set)
    gender: str = ""
    description: str = ""
    evidence: list[dict] = field(default_factory=list)
    chunk_ids: set[str] = field(default_factory=set)
    # Names seen in the same text that could be this character but were never
    # stated to be. Surfaced as suggestions; never merged automatically.
    ambiguous_with: set[str] = field(default_factory=set)


STRUCTURED_OUTPUT_MODE_ENV = "STRUCTURED_OUTPUT_MODE"
STRUCTURED_OUTPUT_MODES = ("auto", "tool", "prompted")


def structured_output_mode() -> str:
    """How structured extraction asks the model for JSON.

    ``tool`` is PydanticAI's default: the schema travels as a function
    definition and the model must answer with a tool call.  ``prompted`` puts
    the schema in the prompt and parses JSON out of plain text, which survives
    relays that rewrite or drop function calls.  ``auto`` tries ``tool`` and
    falls back to ``prompted`` for the chunk when the model exhausts its output
    retries (issue #490).
    """
    raw = os.getenv(STRUCTURED_OUTPUT_MODE_ENV, "auto").strip().lower() or "auto"
    if raw not in STRUCTURED_OUTPUT_MODES:
        raise ValueError(
            f"{STRUCTURED_OUTPUT_MODE_ENV} must be one of {STRUCTURED_OUTPUT_MODES}, got {raw!r}"
        )
    return raw


def describe_output_failure(exc: BaseException, messages: list[Any]) -> str:
    """One line a task log can show for a failed structured run.

    PydanticAI raises ``Exceeded maximum output retries (N)`` for both "the
    model never called the output tool" and "the arguments failed validation",
    and keeps the reason in the retry prompts it sent and in ``__cause__``.
    Surface both; without them the log line is undiagnosable.
    """
    from pydantic_ai.messages import ModelRequest, RetryPromptPart

    parts = [str(exc)]
    cause = exc.__cause__
    if cause is not None and str(cause) and str(cause) != str(exc):
        parts.append(f"cause: {type(cause).__name__}: {cause}")
    retries: list[str] = []
    for message in messages:
        if not isinstance(message, ModelRequest):
            continue
        for part in message.parts:
            if isinstance(part, RetryPromptPart):
                text = " ".join(part.model_response().split())
                retries.append(text[:400])
    if retries:
        parts.append("retry prompts: " + " | ".join(retries[-2:]))
    return "; ".join(parts)


class StructuredOutputFailure(RuntimeError):
    """A structured run failed; ``str()`` carries the diagnosis."""


def _create_character_extraction_agent(agent: Any = None, *, output_mode: str = "tool"):
    if agent is not None:
        return agent

    from pydantic_ai import Agent
    from pydantic_ai.output import PromptedOutput

    from novelvideo.config import (
        get_newapi_structured_output_model_settings,
        get_newapi_text_pydantic_model,
    )
    from novelvideo.model_gateway_runtime import model_gateway_output_retries

    if output_mode == "prompted":
        output_type: Any = PromptedOutput(ChunkCharacterOutput)
        name = "Structured Character Extractor (prompted)"
    else:
        output_type = ChunkCharacterOutput
        name = "Structured Character Extractor"

    return Agent(
        get_newapi_text_pydantic_model(
            "CHARACTER_BUILD_MODEL",
            "gemini-3-flash-preview",
            capability="text.generate.agent",
        ),
        system_prompt=CHARACTER_EXTRACTION_SYSTEM_PROMPT,
        model_settings=get_newapi_structured_output_model_settings(),
        output_type=output_type,
        retries={"output": model_gateway_output_retries(2)},
        name=name,
    )


async def _run_structured(agent: Any, prompt: str) -> Any:
    """Run ``agent`` and turn an exhausted output retry into a diagnosable error."""
    from pydantic_ai import capture_run_messages
    from pydantic_ai.exceptions import UnexpectedModelBehavior

    with capture_run_messages() as messages:
        try:
            return (await agent.run(prompt)).output
        except UnexpectedModelBehavior as exc:
            raise StructuredOutputFailure(
                describe_output_failure(exc, list(messages))
            ) from exc


def normalize_character_name(value: str) -> str:
    """Collapse spacing and punctuation noise without altering the name."""
    cleaned = (value or "").replace("　", " ").strip()
    cleaned = cleaned.strip("：:，,。.、·「」『』\"'()（）【】[]")
    return " ".join(cleaned.split())


def is_generic_address(name: str) -> bool:
    """Whether a name refers to a role rather than a specific person.

    A possessive prefix does not make a kinship term specific: "你妈" and
    "他的母亲" name whoever is on stage, exactly as "母亲" does.
    """
    normalized = normalize_character_name(name)
    if normalized in GENERIC_ADDRESS_TERMS:
        return True
    stripped = _POSSESSIVE_PREFIX_RE.sub("", normalized, count=1)
    return bool(stripped) and stripped in GENERIC_ADDRESS_TERMS


def title_qualified_of(long_name: str, short_name: str) -> bool:
    """Whether ``long_name`` is ``short_name`` plus only job titles.

    Scripts routinely introduce someone as "校长吴显德" and then call them
    "吴显德". Treating those as two people would create duplicate characters,
    each with its own primary key and asset directory.
    """
    long_normalized = normalize_character_name(long_name)
    short_normalized = normalize_character_name(short_name)
    if (
        not short_normalized
        or long_normalized == short_normalized
        or short_normalized not in long_normalized
    ):
        return False

    remainder = long_normalized.replace(short_normalized, "", 1)
    remainder = remainder.replace("的", "")
    # Peel off known titles until nothing is left. Anything that survives is not
    # a title, so the two names are not the same person.
    changed = True
    while remainder and changed:
        changed = False
        for token in TITLE_TOKENS:
            if remainder.startswith(token):
                remainder = remainder[len(token):]
                changed = True
                break
            if remainder.endswith(token):
                remainder = remainder[: -len(token)]
                changed = True
                break
    return not remainder


def _resolve_side(capture: str, known: dict[str, str], *, suffix: bool) -> str:
    """Trim one side of an alias match down to a name that was actually found.

    The patterns take 2-6 characters either side of the marker, and in running
    prose that window opens mid-sentence: "大家都知道林默又名小默" captured
    "家都知道林默" as a name. Matching against the names extraction really
    produced turns that back into "林默"; ``suffix`` says which end of the
    capture the name sits at, since the left side runs up to the marker and the
    right side away from it.
    """
    text = normalize_character_name(capture)
    if not text:
        return ""
    if text in known:
        return known[text]
    best = ""
    for candidate in known:
        matches = text.endswith(candidate) if suffix else text.startswith(candidate)
        if matches and len(candidate) > len(best):
            best = candidate
    return known.get(best, "")


def find_explicit_aliases(
    text: str, known_names: Iterable[str] = ()
) -> set[tuple[str, str]]:
    """Return alias pairs the text states outright.

    Only an explicit statement licenses an alias link, because merging two names
    rewrites a primary key that assets and REST paths already point at.

    Both sides must resolve to a name the extraction actually found. The
    patterns cannot tell where a name begins in running prose, so an unresolved
    capture is prose, not a name — and an alias built from prose is written to
    the character table as though the text had stated it.

    The cost is a real alias going unrecorded when only one of its two names was
    ever extracted. That is the trade this module makes everywhere: a missing
    alias leaves a visible duplicate someone can merge, a wrong one silently
    renames a character.
    """
    known = {
        normalized: normalized
        for normalized in (
            normalize_character_name(name) for name in known_names
        )
        if normalized
    }
    if not known:
        return set()

    pairs: set[tuple[str, str]] = set()
    for pattern in _ALIAS_PATTERNS:
        for match in pattern.finditer(text or ""):
            first = _resolve_side(match.group("a"), known, suffix=True)
            second = _resolve_side(match.group("b"), known, suffix=False)
            if first and second and first != second:
                pairs.add((first, second))
    return pairs


def verify_evidence(
    quote: str, chunk: SourceChunk
) -> tuple[int, int] | None:
    """Locate a quote inside the chunk and return its absolute source offsets.

    A quote that is not present verbatim is rejected. This establishes that the
    line exists in this span, and nothing more — not that it is about the
    character it was returned for.
    """
    needle = (quote or "").strip()
    if not needle:
        return None
    local = chunk.text.find(needle)
    if local < 0:
        # Whitespace inside a quote is not meaningful in Chinese prose, and
        # models routinely normalize it. Retry ignoring it before rejecting.
        compact_needle = re.sub(r"\s+", "", needle)
        compact_text = re.sub(r"\s+", "", chunk.text)
        if not compact_needle or compact_needle not in compact_text:
            return None
        return (chunk.source_start, chunk.source_end)
    return (chunk.source_start + local, chunk.source_start + local + len(needle))


async def extract_characters_from_chunks(
    chunks: list[SourceChunk],
    *,
    agent: Any = None,
    concurrency: int | None = None,
    cached_outcomes: Optional[list] = None,
    source_text: str = "",
    roster: Optional[set] = None,
    adjudicate: bool = True,
    adjudication_agent: Any = None,
    fallback_agent: Any = None,
    on_log: Optional[Callable[[str], None]] = None,
    on_chunk_done: Optional[Callable[[SourceChunk, ChunkCharacterOutput], Any]] = None,
    on_chunk_failed: Optional[Callable[[SourceChunk, BaseException], Any]] = None,
    output_language: AssetLanguage | None = None,
) -> tuple[list[MergedCharacter], list[tuple[SourceChunk, BaseException]]]:
    """Extract and merge characters across chunks.

    Chunks are independent, so they run in parallel up to ``concurrency``. A
    chunk that fails is reported and skipped rather than failing the build: one
    unparseable scene must not discard every other scene's characters.

    In ``auto`` output mode (see :func:`structured_output_mode`) a chunk whose
    tool-call run exhausts its output retries is tried once more with
    ``fallback_agent`` (prompted JSON) before it counts as failed.
    """

    def log(message: str) -> None:
        if on_log:
            on_log(message)

    replayed = list(cached_outcomes or [])
    language = output_language or detect_asset_language(
        source_text
        or "\n".join(
            [
                *(chunk.text for chunk in chunks),
                *(chunk.text for chunk, _ in replayed),
            ]
        )
    )
    if not chunks:
        # Everything was replayed from a previous run; merging still has to run,
        # because merging is what turns per-chunk candidates into characters.
        merged = merge_character_candidates(replayed)
        if adjudicate:
            merged = await adjudicate_characters(
                merged, source_text=source_text, roster=roster,
                agent=adjudication_agent, on_log=log,
            )
        return merged, []

    mode = structured_output_mode()
    runner = _create_character_extraction_agent(
        agent, output_mode="prompted" if mode == "prompted" else "tool"
    )
    if mode != "auto":
        fallback = None
    elif fallback_agent is not None:
        fallback = fallback_agent
    elif agent is None:
        fallback = _create_character_extraction_agent(output_mode="prompted")
    else:
        fallback = None

    async def analyse(chunk: SourceChunk) -> tuple[SourceChunk, ChunkCharacterOutput]:
        prompt = (
            f"{asset_language_instruction(language)}\n\n"
            f"【片段 {chunk.section_label}】\n{chunk.text}"
        )
        try:
            output = await _run_structured(runner, prompt)
        except StructuredOutputFailure as exc:
            if fallback is None:
                raise
            log(
                f"⚠️ 片段 {chunk.section_label} tool call 结构化输出失败，"
                f"改用 prompted JSON 重试: {exc}"
            )
            output = await _run_structured(fallback, prompt)
        if on_chunk_done:
            await _maybe_await(on_chunk_done(chunk, output))
        return chunk, output

    failures: list[tuple[SourceChunk, BaseException]] = []

    def record_failure(chunk: SourceChunk, exc: BaseException) -> None:
        log(f"⚠️ 片段 {chunk.section_label} 抽取失败，已跳过: {exc}")
        failures.append((chunk, exc))

    outcomes = await map_bounded(
        chunks,
        analyse,
        limit=default_llm_concurrency() if concurrency is None else concurrency,
        on_error=record_failure,
    )
    # Reported after the batch so the callback may be async without turning the
    # error path inside map_bounded into an awaiting one.
    for chunk, exc in failures:
        if on_chunk_failed:
            await _maybe_await(on_chunk_failed(chunk, exc))

    succeeded = [outcome for outcome in outcomes if outcome is not None]
    log(f"片段抽取完成: {len(succeeded)}/{len(chunks)} 成功")

    # Replayed chunks merge alongside fresh ones, so a resumed build produces
    # the same characters as an uninterrupted one.
    merged = merge_character_candidates(replayed + succeeded)
    if adjudicate:
        # Rules cannot see across chunks; this can. One call over the candidate
        # set, not another pass over the source.
        merged = await adjudicate_characters(
            merged, source_text=source_text, roster=roster,
            agent=adjudication_agent, on_log=log,
        )
    return merged, failures


def _source_of(outcomes: list[tuple[SourceChunk, ChunkCharacterOutput]]) -> str:
    """The text a name has to appear in, plus the cast lists the author wrote.

    Joined with a separator so a name cannot be formed across a chunk seam.
    """
    parts: list[str] = []
    for chunk, _output in outcomes:
        parts.append(chunk.text)
        parts.extend(str(listed) for listed in (chunk.characters or []))
    return "\n\x00\n".join(parts)


def name_is_attested(name: str, source: str) -> bool:
    """Whether the imported source writes this name at all.

    Verifying the quote does not establish this. A model can return a real
    sentence and attach a name that appears nowhere:

        text  : 林默回到了家
        model : name=王五, evidence="林默回到了家"

    The quote verifies, so 王五 used to be accepted, and became a row in the
    character table — a primary key, a REST identifier and an asset directory,
    invented out of nothing.

    Checked against the whole source rather than the chunk that proposed the
    name, and that is the deliberate half of it. The stricter rule was measured
    against stored per-chunk outputs on both spines and dropped nothing at all,
    because the extraction prompt already asks for a form used in this span and
    the model obeys — so it buys little. What it changes is the direction of
    failure: in-chunk fails closed, and a misjudgement there deletes a real
    character that someone then has to re-enter. Source-wide fails open, and a
    misjudgement there files one quote against the wrong name — a provenance
    record, not a rename.

    Misattribution is not free, and it is worth naming what it can still do: an
    appellation offered by a single owner is taken at face value, so a name
    bound to the wrong line can put an alias on the wrong character. Only a
    contested appellation has to win a vote. That is a model-quality risk, and
    the way to reduce it is a better prompt or an adjudicator, not a guard that
    deletes characters when it is wrong.

    So the line drawn here is: invention cannot get in, misattribution can.
    Moving it further needs Chinese NER and would still be wrong sometimes.
    """
    normalized = normalize_character_name(name)
    if not normalized:
        return False
    return normalized in source or str(name or "").strip() in source


def merge_character_candidates(
    outcomes: list[tuple[SourceChunk, ChunkCharacterOutput]],
) -> list[MergedCharacter]:
    """Merge per-chunk candidates using rules only, no model judgement.

    Identical names merge. Explicit alias statements merge. Everything else stays
    separate, because a wrong merge silently destroys data while a wrong split
    is a visible duplicate the user can fix.
    """
    merged: dict[str, MergedCharacter] = {}
    alias_pairs: set[tuple[str, str]] = set()
    # Only names that survive attestation may anchor an alias statement, and
    # they are pooled across chunks so a statement in one chunk can still
    # resolve a name another chunk established. Pooling the raw model output
    # instead would let a bad capture anchor itself: the model proposing
    # "家都知道林默" would license exactly the pair the anchoring exists to stop.
    source = _source_of(outcomes)
    # Only names that survive attestation may anchor an alias statement. Pooling
    # raw model output instead would let a bad capture anchor itself.
    proposed_names = {
        candidate.name
        for _chunk, output in outcomes
        for candidate in output.characters
        if name_is_attested(candidate.name, source)
        and not is_generic_address(normalize_character_name(candidate.name))
    }
    # appellation -> character -> the source positions attributing it there.
    appellation_claims: dict[str, dict[str, set[tuple[int, int]]]] = {}

    for chunk, output in outcomes:
        alias_pairs |= find_explicit_aliases(chunk.text, proposed_names)

        for candidate in output.characters:
            name = normalize_character_name(candidate.name)
            if not name or is_generic_address(name):
                continue

            # The name needs its own attestation, not just a verifiable quote.
            # Otherwise a real sentence can carry an invented name into the
            # table, which is the exact failure the quote check exists to stop.
            if not name_is_attested(name, source):
                continue

            verified: list[dict] = []
            for item in candidate.evidence:
                span = verify_evidence(item.quote, chunk)
                if span is None:
                    continue
                verified.append(
                    {
                        "chunk_id": chunk.chunk_id,
                        "source_start": span[0],
                        "source_end": span[1],
                        "evidence_kind": item.kind or "mention",
                        "evidence_text": item.quote.strip(),
                    }
                )

            # No verifiable quote means nothing in the source supports this
            # character. Drop it rather than trusting the model's assertion.
            if not verified:
                continue

            entry = merged.get(name)
            if entry is None:
                entry = MergedCharacter(name=name)
                merged[name] = entry

            entry.evidence.extend(verified)
            entry.chunk_ids.add(chunk.chunk_id)
            if not entry.gender and candidate.gender in {"male", "female"}:
                entry.gender = candidate.gender
            if not entry.description and candidate.description.strip():
                entry.description = candidate.description.strip()

            # An appellation is asserted with the whole chunk in view, which is
            # far more reliable than guessing across chunks — but it still has
            # to appear in the text, or it is not something anyone was called.
            # Attribution is settled later: a packed chunk holds several
            # characters, and the model does mix up who is called what.
            for appellation in candidate.appellations:
                normalized = normalize_character_name(appellation)
                if (
                    not normalized
                    or normalized == name
                    or is_generic_address(normalized)
                ):
                    continue
                # Votes are counted per position in the source, not per chunk.
                # Chunks overlap, so one occurrence sitting in an overlap would
                # otherwise be counted twice and clear the margin on its own.
                local = chunk.text.find(normalized)
                if local < 0:
                    continue
                span = (
                    chunk.source_start + local,
                    chunk.source_start + local + len(normalized),
                )
                appellation_claims.setdefault(normalized, {}).setdefault(
                    name, set()
                ).add(span)

            for alias in candidate.aliases:
                normalized_alias = normalize_character_name(alias)
                if not normalized_alias or normalized_alias == name:
                    continue
                # A model-proposed alias is only a suggestion unless the text
                # states it. Record it as ambiguity for the user to resolve.
                if (name, normalized_alias) in alias_pairs or (
                    normalized_alias,
                    name,
                ) in alias_pairs:
                    entry.aliases.add(normalized_alias)
                elif not is_generic_address(normalized_alias):
                    entry.ambiguous_with.add(normalized_alias)

    _apply_appellation_claims(merged, appellation_claims)
    _apply_explicit_alias_merges(merged, alias_pairs)
    _apply_title_qualified_merges(merged)
    return sorted(merged.values(), key=lambda item: (-len(item.evidence), item.name))


def _apply_appellation_claims(
    merged: dict[str, MergedCharacter],
    claims: dict[str, dict[str, set[tuple[int, int]]]],
) -> None:
    """Award a contested appellation to whoever the text repeatedly supports.

    One claimant is taken at face value. When several characters are offered the
    same nickname, the winner is decided by how many *distinct positions in the
    source* attributed it there — not by how much evidence each character has
    overall, which would simply hand every ambiguous form to the lead, and not
    by chunk count, since chunks overlap and one occurrence can fall in two.

    A win has to be decisive: at least two distinct occurrences, and a clear
    margin over the runner-up. Anything closer stays unassigned, because a wrong
    alias resolves confidently to the wrong person while a missing one merely
    fails to resolve.
    """
    for appellation, owners in claims.items():
        if appellation in merged:
            # Already a character in its own right, not an alias for anyone.
            continue
        live = {
            name: chunks for name, chunks in owners.items() if name in merged
        }
        if not live:
            continue
        if len(live) == 1:
            merged[next(iter(live))].aliases.add(appellation)
            continue

        ranked = sorted(live.items(), key=lambda kv: len(kv[1]), reverse=True)
        (winner, won), (_, runner_up) = ranked[0], ranked[1]
        if len(won) < _APPELLATION_MIN_OCCURRENCES:
            continue
        if len(won) < max(len(runner_up) * 2, len(runner_up) + 1):
            continue
        merged[winner].aliases.add(appellation)


def _apply_title_qualified_merges(merged: dict[str, MergedCharacter]) -> None:
    """Fold "校长吴显德" into "吴显德" and keep the fuller form as an alias.

    Unlike the model-proposed aliases held back as suggestions, this is a purely
    textual containment test with a closed title vocabulary, so it cannot merge
    two people who merely share a surname.

    The better-evidenced name wins, which is usually the one the script actually
    uses in dialogue rather than the one-off formal introduction.
    """
    names = sorted(merged, key=len, reverse=True)
    for long_name in names:
        long_entry = merged.get(long_name)
        if long_entry is None:
            continue
        for short_name in names:
            short_entry = merged.get(short_name)
            if (
                short_entry is None
                or short_entry is long_entry
                or not title_qualified_of(long_name, short_name)
            ):
                continue

            primary, secondary = (
                (long_entry, short_entry)
                if len(long_entry.evidence) >= len(short_entry.evidence)
                else (short_entry, long_entry)
            )
            primary.aliases.add(secondary.name)
            primary.aliases |= secondary.aliases
            primary.aliases.discard(primary.name)
            primary.evidence.extend(secondary.evidence)
            primary.chunk_ids |= secondary.chunk_ids
            primary.ambiguous_with |= secondary.ambiguous_with
            primary.ambiguous_with.discard(primary.name)
            primary.ambiguous_with -= primary.aliases
            if not primary.gender:
                primary.gender = secondary.gender
            if not primary.description:
                primary.description = secondary.description
            merged.pop(secondary.name, None)
            break


def _apply_explicit_alias_merges(
    merged: dict[str, MergedCharacter], alias_pairs: set[tuple[str, str]]
) -> None:
    """Fold explicitly-stated aliases into their primary entry.

    The entry with more evidence wins the primary name, so the canonical record
    is the one the text actually develops rather than a passing nickname.
    """
    for first, second in alias_pairs:
        left = merged.get(first)
        right = merged.get(second)
        if left is None or right is None or left is right:
            # An alias statement naming someone who was never extracted still
            # registers on whichever side exists.
            if left is not None and second not in merged:
                left.aliases.add(second)
            elif right is not None and first not in merged:
                right.aliases.add(first)
            continue

        primary, secondary = (
            (left, right) if len(left.evidence) >= len(right.evidence) else (right, left)
        )
        primary.aliases.add(secondary.name)
        primary.aliases |= secondary.aliases
        primary.aliases.discard(primary.name)
        primary.evidence.extend(secondary.evidence)
        primary.chunk_ids |= secondary.chunk_ids
        primary.ambiguous_with |= secondary.ambiguous_with
        primary.ambiguous_with.discard(primary.name)
        primary.ambiguous_with -= primary.aliases
        if not primary.gender:
            primary.gender = secondary.gender
        if not primary.description:
            primary.description = secondary.description
        merged.pop(secondary.name, None)


async def _maybe_await(value: Any) -> Any:
    if hasattr(value, "__await__"):
        return await value
    return value


# ── ambiguity adjudication ──────────────────────────────────────────────────

# A candidate the model may fold into another. Anything better attested than
# this stands on its own: a wrong merge destroys a character silently, while a
# wrong split leaves a visible duplicate the user can remove.
_MERGEABLE_EVIDENCE_CEILING = 2

# Same idea for locations, counted in scenes rather than evidence spans.
_MERGEABLE_SCENE_OCCURRENCES = 2

# Enough of the text to recognise who is being talked about, without resending
# the script.
_ADJUDICATION_SAMPLE_QUOTES = 3

# Below this many mentions, a candidate is more likely an alias than a person in
# its own right, so it gets source context rather than a bare quote.
_CONTEXT_WINDOW_EVIDENCE_THRESHOLD = 6
_CONTEXT_WINDOW_CHARS = 220

# A contested appellation needs this many distinct source positions before it
# is awarded to anyone. A single occurrence is one turn of phrase, which is
# not enough to overrule a competing claim.
_APPELLATION_MIN_OCCURRENCES = 2


class SamePersonGroup(BaseModel):
    canonical_name: str = Field(description="该组的主名，必须来自候选列表")
    alias_names: list[str] = Field(
        default_factory=list, description="指向同一人的其他候选名，必须来自候选列表"
    )
    reason: str = Field(default="", description="判定依据，引用证据中的线索")


class CharacterAdjudication(BaseModel):
    groups: list[SamePersonGroup] = Field(default_factory=list)
    non_characters: list[str] = Field(
        default_factory=list, description="根本不是人物的候选，例如称号、群体、骂人的话"
    )


ADJUDICATION_SYSTEM_PROMPT = """你是角色归一裁决器。

输入是从同一部作品中逐段抽取出的角色候选，每个候选附带它在原文中的出现次数和几条原文引用。

你的任务只有两件：
1. 判断哪些候选其实指向同一个人，把它们归为一组，并选出主名。
2. 指出哪些候选根本不是人物。

规则：
- 只能使用输入中出现过的候选名，不许发明新名字。
- canonical_name 必须是该组候选之一，优先选原文中出现次数最多、最像正式姓名的那个。
- 只有证据确实支持时才合并。"陈总"和"陈青"要有线索表明是同一人才能合并。
- 两个都有大量独立证据、且看不出关联的候选，不要合并。
- 称号、职务、群体、骂人的话（如"大小姐""校霸""扫把星"）如果只是用来称呼某个已知角色，
  应该并入那个角色；如果无法确定指向谁，放进 non_characters。
- 不确定就不要合并，也不要放进 non_characters。漏合并只是留下重复项，错合并会毁掉数据。"""


def _create_adjudication_agent(agent: Any = None):
    if agent is not None:
        return agent

    from pydantic_ai import Agent

    from novelvideo.config import (
        get_newapi_structured_output_model_settings,
        get_newapi_text_pydantic_model,
    )

    return Agent(
        get_newapi_text_pydantic_model(
            "CHARACTER_BUILD_MODEL",
            "gemini-3-flash-preview",
            capability="text.generate.agent",
        ),
        system_prompt=ADJUDICATION_SYSTEM_PROMPT,
        model_settings=get_newapi_structured_output_model_settings(),
        output_type=CharacterAdjudication,
        name="Structured Character Adjudicator",
    )


def _adjudication_prompt(
    merged: list[MergedCharacter], source_text: str = ""
) -> str:
    """Describe every candidate, with enough context to link nicknames to names.

    A quote on its own rarely proves identity: "小阳，你又闯祸了" does not
    contain "郑旭阳". What does prove it is the surrounding text, where the
    formal name almost always appears nearby. Rarely-seen candidates therefore
    get a window of the source around their occurrences — the same co-occurrence
    signal a graph search would surface, taken straight from the text.
    """
    lines: list[str] = []
    for item in merged:
        detail = f"- {item.name}（出现 {len(item.evidence)} 次）"
        if item.gender:
            detail += f"，性别 {item.gender}"
        if item.description:
            detail += f"，{item.description}"
        lines.append(detail)

        rare = len(item.evidence) <= _CONTEXT_WINDOW_EVIDENCE_THRESHOLD
        shown = item.evidence if rare else item.evidence[:_ADJUDICATION_SAMPLE_QUOTES]
        for evidence in shown:
            if rare and source_text:
                start = max(0, int(evidence["source_start"]) - _CONTEXT_WINDOW_CHARS)
                end = min(len(source_text), int(evidence["source_end"]) + _CONTEXT_WINDOW_CHARS)
                window = source_text[start:end].replace("\n", " ")
                lines.append(f"    上下文：…{window}…")
            else:
                lines.append(f"    原文：{evidence['evidence_text']}")
    return (
        "以下是同一部作品的角色候选。出现次数少的候选通常是某个主要角色的"
        "昵称、职务或称号，请利用上下文判断它指向谁：\n" + "\n".join(lines)
    )


def _roster_protects(name: str, roster: set[str]) -> bool:
    """Whether a scene's cast list names this character.

    A cast list is written by the author, not inferred, so a name appearing in
    one is a fact about the script. Such a character is never merged away.
    """
    if not name:
        return False
    return any(name == entry or name in entry for entry in roster)


async def adjudicate_characters(
    merged: list[MergedCharacter],
    *,
    source_text: str = "",
    roster: Optional[set[str]] = None,
    agent: Any = None,
    on_log: Optional[Callable[[str], None]] = None,
) -> list[MergedCharacter]:
    """Resolve cross-chunk identity that per-chunk extraction cannot see.

    Rules can merge identical names and stated aliases, but nothing in a single
    chunk reveals that "郑太" is "郑玉琴" — that only shows up when the whole
    candidate set is considered at once. This is one call over the candidates
    and their evidence, not another pass over the source.

    The adjudicator may only group names it was given, so it cannot invent a
    character, and it cannot delete a well-evidenced one.
    """

    def log(message: str) -> None:
        if on_log:
            on_log(message)

    if len(merged) < 2:
        return merged

    by_name = {item.name: item for item in merged}
    try:
        result = (await _create_adjudication_agent(agent).run(
            _adjudication_prompt(merged, source_text)
        )).output
    except Exception as exc:  # noqa: BLE001 - degrade to the rule-only result
        log(f"⚠️ 归一裁决失败，保留规则归一结果: {exc}")
        return merged

    cast = roster or set()
    removed: set[str] = set()

    def may_merge_away(candidate: MergedCharacter) -> bool:
        """Whether this candidate is weak enough to be folded into another."""
        if _roster_protects(candidate.name, cast):
            return False
        return len(candidate.evidence) <= _MERGEABLE_EVIDENCE_CEILING

    for group in result.groups:
        members = [
            by_name[name]
            for name in (
                normalize_character_name(n)
                for n in [group.canonical_name, *group.alias_names]
            )
            if name in by_name and by_name[name].name not in removed
        ]
        if len(members) < 2:
            continue

        # The canonical name is decided here, not by the model: a cast-list name
        # wins, then the best-attested one. Left to the model, a formal name can
        # end up folded into a passing nickname.
        primary = max(
            members,
            key=lambda item: (
                _roster_protects(item.name, cast),
                len(item.evidence),
            ),
        )
        for secondary in members:
            if secondary is primary or secondary.name in removed:
                continue
            if not may_merge_away(secondary):
                log(
                    f"  拒绝归并 {secondary.name} → {primary.name}："
                    f"证据 {len(secondary.evidence)} 条"
                    f"{'，且出现在场次人物栏' if _roster_protects(secondary.name, cast) else ''}"
                )
                continue
            primary.aliases.add(secondary.name)
            primary.aliases |= secondary.aliases
            primary.aliases.discard(primary.name)
            primary.evidence.extend(secondary.evidence)
            primary.chunk_ids |= secondary.chunk_ids
            primary.ambiguous_with |= secondary.ambiguous_with
            primary.ambiguous_with -= primary.aliases
            primary.ambiguous_with.discard(primary.name)
            if not primary.gender:
                primary.gender = secondary.gender
            if not primary.description:
                primary.description = secondary.description
            removed.add(secondary.name)
            log(f"  归并 {secondary.name} → {primary.name}")

    # Reported, never acted on. Every candidate here already survived
    # verification against the source, so discarding one trades a visible
    # duplicate for an invisible omission — the wrong way round for a first
    # release. Surfacing the call lets the rule be tuned on real data first.
    for name in result.non_characters:
        item = by_name.get(normalize_character_name(name))
        if item is not None and item.name not in removed:
            log(f"  裁决认为不是角色（仅记录，未删除）：{item.name}")

    survivors = [item for item in merged if item.name not in removed]
    log(f"裁决完成: {len(merged)} → {len(survivors)} 个角色")
    return sorted(survivors, key=lambda item: (-len(item.evidence), item.name))


# ── character appearance ────────────────────────────────────────────────────
#
# Extraction and appearance are two different contracts, deliberately kept
# apart.  Extraction is evidence-bound: every field it reports has to appear
# verbatim in the span it came from, which is what stops an invented character
# from entering the table.  A face prompt, a role, a build and an age band are
# none of them quotable — a screenplay writes "郑家悦" and what she does, not
# what her jaw looks like — so folding them into CharacterCandidate would mean
# relaxing the very guard that makes extraction trustworthy.
#
# So this stage runs after the cast is settled, takes only names that already
# survived verification, and is allowed to write what the source implies rather
# than what it states.  It is the half of legacy's CharacterEnrichment that
# structured extraction never carried over; scenes have had their equivalent
# since the beginning (``enrich_scene_environments_batched``), which is why
# scene builds produce usable prompts and character builds did not.


class CharacterAppearance(BaseModel):
    name: str = Field(description="角色主名，必须与给出的角色名完全一致")
    role: str = Field(default="", description="角色定位，如：主角、闺蜜、前男友、皇后")
    is_main: bool = Field(default=False, description="是否为解说主角/第一人称叙述者")
    age_group: str = Field(
        default="youth", description="年龄段，必须是 child / youth / middle / elder 之一"
    )
    body_type: str = Field(default="", description="体型描述，如：纤细高挑、健壮魁梧、娇小玲珑")
    face_prompt: str = Field(
        default="", description="纯面部特征描述（发型、眼睛、肤色、脸型），不含服装"
    )


class CharacterAppearanceList(BaseModel):
    characters: list[CharacterAppearance] = Field(default_factory=list)


CHARACTER_APPEARANCE_SYSTEM_PROMPT = """你是角色形象设定师。输入是一部作品中已经确认的角色，以及原文中关于他们的片段。

为每个角色补全形象设定。这一步允许合理推断，但推断必须与给出的原文片段一致，不要与原文冲突。
role、body_type、face_prompt 必须使用用户消息指定的输出语言。

对每个角色给出：
1. name: 必须与输入给出的角色名逐字一致，不要改写、翻译或合并。
2. role: 角色定位（如：主角、闺蜜、前男友、皇后、班主任）。
3. is_main: 是否为解说主角/第一人称叙述者。整批里最多只有一个 true；判断不了就全填 false。
4. age_group: 必须是 child（儿童）/ youth（青年）/ middle（中年）/ elder（老年）之一。
   同一角色的幼年/老年形态不拆分，取他在故事中最主要时期对应的年龄段。
5. body_type: 体型描述。
6. face_prompt: 纯面部特征描述。
   格式：[性别]，[年龄段]，[发型发色]，[眼睛特征]，[肤色]，[脸型/骨骼]
   示例："女性，二十多岁，黑色长发马尾，黑色杏眼，小麦肤色，瓜子脸"
   ⚠️ 绝对不要在 face_prompt 中描述服装、配饰或场景。服装由后续身份规划单独处理。

不要新增角色，不要删除角色，不要合并角色。输入给几个就返回几个。"""


def _create_character_appearance_agent(agent: Any = None):
    if agent is not None:
        return agent

    from pydantic_ai import Agent

    from novelvideo.config import (
        get_newapi_structured_output_model_settings,
        get_newapi_text_pydantic_model,
    )

    return Agent(
        get_newapi_text_pydantic_model(
            "CHARACTER_BUILD_MODEL",
            "gemini-3-flash-preview",
            capability="text.generate.agent",
        ),
        system_prompt=CHARACTER_APPEARANCE_SYSTEM_PROMPT,
        model_settings=get_newapi_structured_output_model_settings(),
        output_type=CharacterAppearanceList,
        name="Structured Character Appearance",
    )


# Bump whenever the prompt, the accepted age bands, or the way an answer is
# turned into stored fields changes.  It is part of every cache key, so a bump
# retires stored results rather than mixing two contracts.
#
# 2: ``is_main`` left the payload for the cast-level key below.
CHARACTER_APPEARANCE_CACHE_VERSION = 3

CHARACTER_APPEARANCE_CACHE_TYPE = "character_appearance"

AGE_GROUPS = ("child", "youth", "middle", "elder")

_APPEARANCE_BATCH_SIZE = 5

# How many evidence quotes one character contributes to the prompt. Enough to
# place them in the story, few enough that a batch of five stays short.
_APPEARANCE_SAMPLE_QUOTES = 4


def normalize_age_group(value: str) -> str:
    """Coerce a model answer to one of the four bands stored on a character.

    The band is not free text: ``get_fish_voice_id`` selects a voice from it
    and identity planning derives per-identity bands from it, so an unknown
    value would silently disable both rather than fail loudly.
    """
    cleaned = str(value or "").strip().lower()
    return cleaned if cleaned in AGE_GROUPS else "youth"


def character_appearance_cache_key(
    item: "MergedCharacter",
    synopsis: str = "",
    output_language: AssetLanguage | None = None,
) -> str:
    """Hash the exact input one character's appearance call is made from.

    Every field the model sees, plus the contract version.  Quotes are included
    in the order and count the prompt actually sends: a character whose
    evidence changed is a character the model would answer differently about.
    The synopsis is project-wide, so editing a script's character bios retires
    every stored appearance — which is right, since that block is what most of
    them were written from.
    """
    language = output_language or detect_asset_language(
        "\n".join(
            [
                item.name,
                item.description,
                *sorted(item.aliases),
                *_appearance_quotes(item),
                str(synopsis or ""),
            ]
        )
    )
    payload = {
        "v": CHARACTER_APPEARANCE_CACHE_VERSION,
        "language": language,
        "name": item.name,
        "aliases": sorted(item.aliases),
        "gender": item.gender,
        "description": item.description,
        "quotes": _appearance_quotes(item),
        "synopsis": str(synopsis or ""),
    }
    canonical = json.dumps(payload, ensure_ascii=False, sort_keys=True)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _appearance_quotes(item: "MergedCharacter") -> list[str]:
    quotes: list[str] = []
    for entry in item.evidence:
        quote = str((entry or {}).get("quote") or "").strip()
        if quote:
            quotes.append(quote)
        if len(quotes) >= _APPEARANCE_SAMPLE_QUOTES:
            break
    return quotes


def appearance_to_cache_payload(appearance: CharacterAppearance) -> str:
    """Store everything about a character except who the narrator is.

    Every other field is a property of one character and is keyed on that
    character's own inputs, so a stored answer stays true for as long as those
    inputs do.  ``is_main`` is not: it ranks one character against the whole
    cast, and the key cannot see the cast.  Adding, removing or re-adjudicating
    somebody else would leave the key identical and replay a nomination that
    the new cast may have overtaken — and ``_enforce_single_main`` would then
    keep the stale one, because it settles ties rather than re-deciding.

    So the nomination is never stored.  A character served from the cache
    abstains, and only characters actually asked this run can claim it.
    """
    return json.dumps(
        {
            "name": appearance.name,
            "role": appearance.role,
            "age_group": appearance.age_group,
            "body_type": appearance.body_type,
            "face_prompt": appearance.face_prompt,
        },
        ensure_ascii=False,
    )


def is_usable_appearance(appearance: CharacterAppearance) -> bool:
    """Whether an answer is worth storing and publishing.

    The face prompt is the field the portrait runner refuses to work without
    (``task_backend/runners/character_image.py``), so an answer that omits it
    has not done the job.  Caching one would make the omission permanent, the
    same trap ``is_cacheable_scene_prompt`` guards against on the scene side.
    """
    return bool(str(appearance.face_prompt or "").strip())


def appearance_from_cache_payload(payload: str) -> CharacterAppearance | None:
    """Rebuild an appearance from a stored row, or None if it is unusable.

    A row that no longer parses, or that carries an answer the current contract
    would reject, is treated as a miss: a cache must never publish something
    the live path would have thrown away.
    """
    try:
        data = json.loads(payload)
    except (TypeError, ValueError):
        return None
    if not isinstance(data, dict):
        return None
    appearance = CharacterAppearance(
        name=str(data.get("name") or ""),
        role=str(data.get("role") or ""),
        # Stated rather than left to a missing key: a nomination never comes
        # from a per-character row, for the reason the payload docstring gives.
        is_main=False,
        age_group=normalize_age_group(data.get("age_group", "")),
        body_type=str(data.get("body_type") or ""),
        face_prompt=str(data.get("face_prompt") or ""),
    )
    return appearance if is_usable_appearance(appearance) else None


CHARACTER_NARRATOR_CACHE_TYPE = "character_narrator"


def narrator_cache_key(fingerprints: list[str]) -> str:
    """Hash every input the cast decision was made from, in cast order.

    The per-character cache keys, not the names.  Names alone survive a changed
    description, a changed quote and an edited character bible, so a run whose
    fresh answers happened to nominate nobody could fall back on a decision
    made from inputs that no longer exist.  Each fingerprint already covers one
    character's whole input including the shared synopsis, so the ordered list
    of them is the cast decision's full dependency.
    """
    payload = {"v": CHARACTER_APPEARANCE_CACHE_VERSION, "cast": list(fingerprints)}
    canonical = json.dumps(payload, ensure_ascii=False, sort_keys=True)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _nominee(appearances: dict[str, CharacterAppearance], order: list[str]) -> str:
    """The nominated character earliest in cast order, or "" for none."""
    for name in order:
        appearance = appearances.get(name)
        if appearance is not None and appearance.is_main:
            return name
    return ""


def narrator_vote_key(cast_key: str, character_key: str) -> str:
    """One key per (cast, nominee), so batches cannot overwrite each other.

    A single shared key made the surviving nomination a function of which
    batch finished last.  Batches run concurrently and each sees only its own
    five characters, so more than one may legitimately nominate; the last
    writer is not the cast-order winner, and a crash before the run could
    settle them would recover whoever happened to be last.

    Giving every nominee its own key removes the race instead of resolving it
    afterwards: nothing is overwritten, and the reduce happens on read, in
    cast order, which is the same rule ``_enforce_single_main`` applies in
    memory.  The cast fingerprint is part of the key, so a changed cast retires
    every vote with it.
    """
    payload = {
        "v": CHARACTER_APPEARANCE_CACHE_VERSION,
        "cast": cast_key,
        "character": character_key,
    }
    canonical = json.dumps(payload, ensure_ascii=False, sort_keys=True)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


async def _record_narrator_votes(
    cache: Any,
    cast_key: str,
    keys: dict[str, str],
    produced: dict[str, CharacterAppearance],
    order: list[str],
) -> None:
    """Persist this batch's nominations, ahead of the rows that replay it."""
    rows = {
        narrator_vote_key(cast_key, keys[name]): json.dumps(
            {"name": name}, ensure_ascii=False
        )
        for name in order
        if name in produced and produced[name].is_main
    }
    if rows:
        await _maybe_await(cache.save(CHARACTER_NARRATOR_CACHE_TYPE, rows))


async def _recover_narrator(
    cache: Any,
    cast_key: str,
    keys: dict[str, str],
    order: list[str],
    answered: dict[str, CharacterAppearance],
) -> str:
    """The earliest nominee in cast order that any attempt ever recorded.

    Restricted to characters this run actually has an appearance for: a vote
    for somebody adjudication has since merged away, or whose own row failed
    this time, must not resurrect them.
    """
    by_name = {
        name: narrator_vote_key(cast_key, keys[name])
        for name in order
        if name in answered
    }
    stored = await _maybe_await(
        cache.get(CHARACTER_NARRATOR_CACHE_TYPE, list(by_name.values()))
    )
    for name in order:
        if name in by_name and by_name[name] in (stored or {}):
            return name
    return ""


async def _settle_narrator_nomination(
    appearances: dict[str, CharacterAppearance],
    order: list[str],
    cache: Any,
    cast_key: str,
    keys: dict[str, str],
) -> None:
    """Decide the narrator from every vote this cast has ever attracted.

    Nominations are not kept in the per-character rows, so a character
    replayed from the cache abstains in memory however loudly an earlier
    attempt nominated it.  Reading the votes only when this run happens to
    nominate nobody is therefore not enough: a build stopped partway records
    an early character's vote and its row, and the retry pairs that silent
    replay with a freshly nominated later character.  Taking the in-memory
    answer there would hand a resumed build a different narrator from an
    uninterrupted one, for no reason the source text supports.

    Batches write their votes ahead of the rows that make them look finished,
    so by the time this runs the votes are a superset of what is in memory.
    Reducing over them in cast order — the same rule ``_enforce_single_main``
    applies — is what makes the answer independent of where a build was
    interrupted, and of the order its batches happened to finish in.
    """
    _enforce_single_main(appearances, order)
    if cache is None or not order:
        return
    winner = await _recover_narrator(cache, cast_key, keys, order, appearances)
    for name, appearance in appearances.items():
        appearance.is_main = name == winner


def _enforce_single_main(
    appearances: dict[str, CharacterAppearance],
    order: list[str],
) -> None:
    """Keep at most one narrator, in a batch-independent order.

    Characters are enriched in batches that run concurrently, so "the first one
    the model marked" is not a stable answer.  Resolving in the caller's order
    makes a rebuild pick the same narrator a fresh build did.
    """
    seen = False
    for name in order:
        appearance = appearances.get(name)
        if appearance is None or not appearance.is_main:
            continue
        if seen:
            appearance.is_main = False
        else:
            seen = True


async def enrich_character_appearances(
    merged: list["MergedCharacter"],
    *,
    synopsis: str = "",
    agent: Any = None,
    cache: Any = None,
    on_log: Optional[Callable[[str], None]] = None,
    concurrency: Optional[int] = None,
    output_language: AssetLanguage | None = None,
) -> dict[str, CharacterAppearance]:
    """Write the creative half of a character: face, role, build, age band.

    Returns one entry per character the stage could answer for.  A character
    the model failed on is simply absent rather than filled with a placeholder:
    an empty face prompt is a visible, fixable gap, while boilerplate is an
    invisible one that every later rebuild would replay.

    With a ``cache``, a character whose input already produced a usable answer
    is served from it and never sent to the model, so an interrupted build
    keeps everything it has already paid for.
    """

    def log(message: str) -> None:
        if on_log:
            on_log(message)

    if not merged:
        return {}

    language = output_language or detect_asset_language(
        "\n".join(
            [
                str(synopsis or ""),
                *(
                    value
                    for item in merged
                    for value in [
                        item.name,
                        item.description,
                        *sorted(item.aliases),
                        *_appearance_quotes(item),
                    ]
                ),
            ]
        )
    )
    order = [item.name for item in merged]
    keys = {
        item.name: character_appearance_cache_key(item, synopsis, language)
        for item in merged
    }
    results: dict[str, CharacterAppearance] = {}

    if cache is not None:
        stored = await _maybe_await(
            cache.get(CHARACTER_APPEARANCE_CACHE_TYPE, list(keys.values()))
        )
        for item in merged:
            payload = (stored or {}).get(keys[item.name])
            appearance = appearance_from_cache_payload(payload) if payload else None
            if appearance is not None:
                results[item.name] = appearance
        if results:
            log(f"复用 {len(results)} 个角色形象设定，未调用模型")

    pending = [item for item in merged if item.name not in results]
    narrator_key = narrator_cache_key([keys[name] for name in order])

    if not pending:
        await _settle_narrator_nomination(results, order, cache, narrator_key, keys)
        return results

    llm = _create_character_appearance_agent(agent)
    # A screenplay's pre-scene block is its character bible — it names hair,
    # build and bearing outright. Extraction already chunks it, but only as one
    # span among many; handing it to this stage whole is what legacy did, and
    # it is the densest appearance source the source text has.
    synopsis_section = f"\n\n【剧本梗概与人物设定原文】\n{synopsis}" if synopsis else ""

    def describe(item: "MergedCharacter") -> str:
        aliases = "、".join(sorted(item.aliases)) or "无"
        quotes = "\n".join(f"- {quote}" for quote in _appearance_quotes(item)) or "- 无"
        return (
            f"### 角色：{item.name}\n"
            f"别名：{aliases}\n"
            f"性别：{item.gender or '未知'}\n"
            f"已知描述：{item.description or '无'}\n"
            f"原文片段：\n{quotes}"
        )

    async def run_batch(batch: list["MergedCharacter"]) -> dict[str, CharacterAppearance]:
        prompt = (
            asset_language_instruction(language)
            + "\n\n请为下面每一个角色补全形象设定，"
            "name 必须与给出的角色名完全一致，不要合并或遗漏：\n\n"
            + "\n\n".join(describe(item) for item in batch)
            + synopsis_section
        )
        produced: dict[str, CharacterAppearance] = {}
        try:
            result = (await llm.run(prompt)).output
            by_name = {
                normalize_character_name(entry.name): entry
                for entry in (result.characters or [])
            }
        except Exception as exc:  # noqa: BLE001 - a failed batch degrades, never raises
            log(f"⚠️ 角色形象设定失败（{len(batch)} 个角色）：{exc}")
            return produced

        for item in batch:
            entry = by_name.get(normalize_character_name(item.name))
            if entry is None:
                continue
            # The model answers under whatever spelling it echoed back; the
            # stored row is keyed by the settled name, which is a primary key.
            appearance = CharacterAppearance(
                name=item.name,
                role=entry.role,
                is_main=entry.is_main,
                age_group=normalize_age_group(entry.age_group),
                body_type=entry.body_type,
                face_prompt=entry.face_prompt,
            )
            if is_usable_appearance(appearance):
                produced[item.name] = appearance

        if cache is not None and produced:
            # Order matters between these two writes. A batch's rows are what
            # make it look finished to the next run, and the nomination is not
            # in them, so writing the rows first opens a window where a crash
            # leaves every character replayable and the answer gone — the retry
            # then abstains with nothing left to consult. Writing the
            # nomination first inverts that: a crash in between leaves the
            # batch pending, and the retry asks the question again.
            await _record_narrator_votes(cache, narrator_key, keys, produced, order)
            # Written per batch rather than once at the end, so a build killed
            # halfway keeps what it already paid for.
            await _maybe_await(
                cache.save(
                    CHARACTER_APPEARANCE_CACHE_TYPE,
                    {
                        keys[name]: appearance_to_cache_payload(appearance)
                        for name, appearance in produced.items()
                    },
                )
            )
        return produced

    batches = [
        pending[start : start + _APPEARANCE_BATCH_SIZE]
        for start in range(0, len(pending), _APPEARANCE_BATCH_SIZE)
    ]
    outcomes = await map_bounded(
        batches,
        run_batch,
        limit=default_llm_concurrency() if concurrency is None else concurrency,
    )
    for outcome in outcomes:
        if isinstance(outcome, dict):
            results.update(outcome)

    missing = [item.name for item in merged if item.name not in results]
    if missing:
        log(f"⚠️ {len(missing)} 个角色未取得形象设定，面部提示词留空：{'、'.join(missing[:5])}")
    log(f"形象设定完成: {len(results)}/{len(merged)} 个角色")

    await _settle_narrator_nomination(results, order, cache, narrator_key, keys)
    return results


# ── scene adjudication ──────────────────────────────────────────────────────


class SameLocationGroup(BaseModel):
    canonical_name: str = Field(description="该组的主名，必须来自候选列表")
    alias_names: list[str] = Field(
        default_factory=list, description="指向同一地点的其他候选名，必须来自候选列表"
    )
    reason: str = Field(default="", description="判定依据")


class SceneAdjudication(BaseModel):
    groups: list[SameLocationGroup] = Field(default_factory=list)


SCENE_ADJUDICATION_SYSTEM_PROMPT = """你是场景归一裁决器。

输入是从同一部剧本的场次头中解析出的地点候选，每个附带它在剧本中出现的场次数。

你的任务只有一件：判断哪些候选其实是同一个物理地点，把它们归为一组并选出主名。

规则：
- 只能使用输入中出现过的候选名，不许发明新名字。
- canonical_name 必须是该组候选之一，优先选出现场次最多、最完整具体的那个。
- 同一地点的不同写法要合并，例如“舞蹈室镜子前”和“舞蹈室照镜子”，
  “郑玉琴办公室”和“郑玉琴办公室内”，“学校教室”和“名门高级人才学院教室”。
- 同一建筑里的不同房间是不同地点，绝不能合并：
  “郑家别墅客厅”和“郑家别墅餐厅”是两个场景，“郑家别墅外”和“郑家别墅客厅”也是。
- 时间、天气、损毁状态不构成新地点，但这里的候选都已经是基础地点，不用管这些。
- 不确定就不要合并。多留一个重复场景只是资产冗余，错误合并会让两处戏共用一个场景图。"""


def _create_scene_adjudication_agent(agent: Any = None):
    if agent is not None:
        return agent

    from pydantic_ai import Agent

    from novelvideo.config import (
        get_newapi_structured_output_model_settings,
        get_newapi_text_pydantic_model,
    )

    return Agent(
        get_newapi_text_pydantic_model(
            "SCENE_BUILD_MODEL",
            "gemini-3-flash-preview",
            capability="text.generate.agent",
        ),
        system_prompt=SCENE_ADJUDICATION_SYSTEM_PROMPT,
        model_settings=get_newapi_structured_output_model_settings(),
        output_type=SceneAdjudication,
        name="Structured Scene Adjudicator",
    )


SCENE_ADJUDICATION_CACHE_VERSION = 1

SCENE_ADJUDICATION_CACHE_TYPE = "scene_adjudication"


async def adjudicate_scenes(
    scenes: list,
    *,
    occurrences: Optional[dict] = None,
    agent: Any = None,
    on_log: Optional[Callable[[str], None]] = None,
    cache: Any = None,
) -> list:
    """Fold differently-written spellings of one location into a single scene.

    Scene headings are written by hand, so the same room appears as
    "郑玉琴办公室" and "郑玉琴办公室内". Each spelling otherwise becomes its own
    base scene with its own generated art.

    Unlike character adjudication this never drops a candidate. A duplicate
    scene is redundant art; a missing one leaves shots with no location asset,
    and nothing in the UI would show what went missing.
    """

    def log(message: str) -> None:
        if on_log:
            on_log(message)

    if len(scenes) < 2:
        return scenes

    counts = occurrences or {}
    by_name = {scene.name: scene for scene in scenes}
    listing = "\n".join(
        f"- {scene.name}（出现 {counts.get(scene.name, 0)} 场）"
        f"{'，别名 ' + '、'.join(scene.aliases) if scene.aliases else ''}"
        for scene in scenes
    )

    # Only the model's grouping is cached, never the merge that follows it. The
    # occurrence ceiling and the canonical-name choice are code, so re-applying
    # them to a cached grouping is free and always uses the current rules.
    cache_key = hashlib.sha256(
        json.dumps(
            {"v": SCENE_ADJUDICATION_CACHE_VERSION, "listing": listing},
            ensure_ascii=False,
            sort_keys=True,
        ).encode("utf-8")
    ).hexdigest()

    groups: list | None = None
    if cache is not None:
        payload = (
            await cache.get(SCENE_ADJUDICATION_CACHE_TYPE, [cache_key])
        ).get(cache_key)
        if payload:
            try:
                groups = [
                    SimpleNamespace(
                        canonical_name=str(item.get("canonical_name") or ""),
                        alias_names=list(item.get("alias_names") or []),
                    )
                    for item in json.loads(payload)
                ]
            except (TypeError, ValueError, AttributeError):
                groups = None
            if groups is not None:
                log(f"复用上次场景裁决分组：{len(groups)} 组，未调用模型")

    if groups is None:
        try:
            result = (await _create_scene_adjudication_agent(agent).run(
                "以下是同一部剧本的地点候选：\n" + listing
            )).output
        except Exception as exc:  # noqa: BLE001 - degrade to the unmerged result
            log(f"⚠️ 场景归一裁决失败，保留原始场景: {exc}")
            return scenes
        groups = list(result.groups)
        if cache is not None:
            await cache.save(
                SCENE_ADJUDICATION_CACHE_TYPE,
                {
                    cache_key: json.dumps(
                        [
                            {
                                "canonical_name": group.canonical_name,
                                "alias_names": list(group.alias_names or []),
                            }
                            for group in groups
                        ],
                        ensure_ascii=False,
                    )
                },
            )

    removed: set[str] = set()
    for group in groups:
        members = [
            by_name[name]
            for name in (
                str(n or "").strip()
                for n in [group.canonical_name, *group.alias_names]
            )
            if name in by_name and by_name[name].name not in removed
        ]
        if len(members) < 2:
            continue

        # Decided here rather than by the model: the spelling the script uses
        # most is the canonical one.
        primary = max(members, key=lambda s: counts.get(s.name, 0))
        for secondary in members:
            if secondary is primary or secondary.name in removed:
                continue
            # A location the script keeps returning to is a real place, not a
            # spelling variant. Folding one away would leave those scenes
            # pointing at another room's art.
            if counts.get(secondary.name, 0) > _MERGEABLE_SCENE_OCCURRENCES:
                log(
                    f"  拒绝归并场景 {secondary.name} → {primary.name}："
                    f"出现 {counts.get(secondary.name, 0)} 场"
                )
                continue
            merged_aliases = list(primary.aliases)
            for candidate in [secondary.name, *secondary.aliases]:
                if candidate != primary.name and candidate not in merged_aliases:
                    merged_aliases.append(candidate)
            primary.aliases = merged_aliases
            removed.add(secondary.name)
            log(f"  归并场景 {secondary.name} → {primary.name}")

    survivors = [scene for scene in scenes if scene.name not in removed]
    log(f"场景裁决完成: {len(scenes)} → {len(survivors)} 个")
    return survivors
