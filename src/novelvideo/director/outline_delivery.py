"""Five-section delivery is a projection, never a second editable document.

The host supplies settings and provenance. Model craft notes are retained for
audit but cannot become eleven extra sections or an assertion of approval.
This module checks structure and referential integrity, not semantic truth.
"""

from __future__ import annotations

import html
import re
from copy import deepcopy
from collections.abc import Iterator

from .documents import normalize_text, object_hash, parse_markdown, semantic_hash
from .schemas.common import ContractModel, require_unique
from .schemas.documents import DocumentAST
from .schemas.outline_delivery import (
    DELIVERY_CONTRACT,
    AdaptationOutlineDraft,
    DeliveryContext,
    GroundedText,
    OutlineIndex,
)

SECTION_ORDER = ("overview", "adaptation", "chapters", "hooks", "boundaries")

# Generated document labels follow the requested output language, not UI locale.
LABELS = {
    "overview": ("【一】概要设计", "[1] Overview design", "[1] Thiết kế tổng quan"),
    "adaptation": (
        "【二】这次改写怎么处理原文",
        "[2] Adaptation treatment",
        "[2] Cách chuyển thể nguyên tác",
    ),
    "chapters": ("【三】篇章划分", "[3] Chapter breakdown", "[3] Phân chia chương"),
    "hooks": ("【四】钩子预设", "[4] Planned hooks", "[4] Móc câu dự kiến"),
    "boundaries": (
        "【五】改写禁区",
        "[5] Adaptation boundaries",
        "[5] Giới hạn chuyển thể",
    ),
    "genre": ("类型 / 口味", "Genre / treatment", "Thể loại / sắc thái"),
    "scale": (
        "集数 / 单集秒数 / 总秒数（目标）",
        "Episodes / seconds each / total seconds (target)",
        "Số tập / giây mỗi tập / tổng giây (mục tiêu)",
    ),
    "structure": ("叙事结构", "Narrative structure", "Cấu trúc tự sự"),
    "tone": ("基调", "Tone", "Sắc thái"),
    "style": ("画风", "Visual style", "Phong cách hình ảnh"),
    "logline": ("故事简介", "Logline", "Tóm tắt một câu"),
    "synopsis": ("故事简述", "Story synopsis", "Tóm tắt câu chuyện"),
    "protagonist": ("主角处境", "Protagonist situation", "Hoàn cảnh nhân vật chính"),
    "resistance": ("主要阻力", "Main resistance", "Trở lực chính"),
    "emotion": ("情绪走向", "Emotional progression", "Diễn tiến cảm xúc"),
    "source": ("来源 / 范围", "Source / scope", "Nguồn / phạm vi"),
    "full_text": (
        "完整文本（不代表已审计）",
        "Full text (not an audit result)",
        "Toàn văn (không phải kết quả kiểm tra)",
    ),
    "curated_summary": (
        "人工概要（非全文审计）",
        "Curated summary (not a full-source audit)",
        "Tóm tắt biên soạn (chưa kiểm tra toàn văn)",
    ),
    "brief": ("改编诉求", "Adaptation request", "Yêu cầu chuyển thể"),
    "approach": ("改写口径", "Approach", "Cách xử lý"),
    "authorized": ("已授权改动", "Authorized changes", "Thay đổi đã được cho phép"),
    "noAuthorization": (
        "未授权新增剧情改动",
        "No new plot changes authorized",
        "Chưa cho phép thêm thay đổi cốt truyện",
    ),
    "preserve": ("必须保留", "Must preserve", "Phải giữ lại"),
    "proposal": (
        "改动提案（未授权、待确认）",
        "Proposed changes (not authorized, awaiting confirmation)",
        "Đề xuất thay đổi (chưa được cho phép, chờ xác nhận)",
    ),
    "unresolved": ("未决项", "Unresolved claims", "Điểm chưa được giải quyết"),
    "episodes": ("对应集", "Episodes", "Các tập"),
    "position": ("篇章位置 / 承接", "Position / transition", "Vị trí / chuyển tiếp"),
    "keepEvents": ("不能丢的事件", "Required events", "Sự kiện phải giữ"),
    "highlights": ("本集看点", "Episode highlights", "Điểm hấp dẫn của tập"),
    "opening": ("开篇钩子", "Opening hook", "Móc câu mở đầu"),
    "question": ("引发的疑问", "Question raised", "Câu hỏi được gợi ra"),
    "plant": ("伏笔", "Setup", "Chi tiết được gieo"),
    "payoff": ("回收", "Payoff", "Thu chi tiết"),
    "openReason": ("开放保留原因", "Reason left open", "Lý do để ngỏ"),
    "inapplicable": ("不适用说明", "Inapplicability reason", "Lý do không áp dụng"),
    "locked": (
        "锁定事实 / 边界",
        "Locked facts / boundaries",
        "Dữ kiện / giới hạn đã khóa",
    ),
    "none": ("无", "None", "Không có"),
}


def _references(ids: list[str], allowed: set[str]) -> None:
    require_unique(ids, "OUTLINE_DUPLICATE_REFERENCE")
    if not set(ids) <= allowed:
        raise ValueError("OUTLINE_REFERENCE_MISSING")


def _context(value: dict) -> DeliveryContext:
    context = DeliveryContext.from_wire(value)
    claims, events = {r.id for r in context.claims}, {r.id for r in context.events}
    for rows in (context.claims, context.events, context.authorized_changes):
        require_unique([r.id for r in rows], "OUTLINE_DUPLICATE_HOST_ID")
    for ids in (context.required_claim_ids, context.unresolved_claim_ids):
        _references(ids, claims)
    _references(context.required_event_ids, events)
    if context.opening_event_ids is not None:
        _references(context.opening_event_ids, events)
    require_unique(context.chapter_keys, "OUTLINE_DUPLICATE_CHAPTER_KEY")
    return context


def _episodes(root: dict) -> list[str]:
    from .outline import STRUCTURES

    spec = root["preset"]
    if spec["mode"] != "adaptation":
        raise ValueError("OUTLINE_ADAPTATION_REQUIRED")
    if any(
        type(spec[key]) is not int or spec[key] < 1
        for key in ("episode_count", "duration_seconds")
    ):
        raise ValueError("PLANNING_SPEC_MISMATCH")
    ids = [ep["id"] for ep in root["episodes"]]
    if len(ids) != spec["episode_count"] or len(set(ids)) != len(ids):
        raise ValueError("PLANNING_EPISODES_MISMATCH")
    if any(
        not isinstance(ep["deliveryLabel"], str) or not ep["deliveryLabel"].strip()
        for ep in root["episodes"]
    ):
        raise ValueError("PLANNING_EPISODES_MISMATCH")
    if spec["ending_type"] not in {"open", "closed"}:
        raise ValueError("PLANNING_SPEC_MISMATCH")
    if spec["structure"] not in STRUCTURES:
        raise ValueError("PLANNING_SPEC_MISMATCH")
    if spec.get("output_language", "zh-CN").lower() not in {"zh", "zh-cn", "en", "vi"}:
        raise ValueError("OUTLINE_LANGUAGE_UNSUPPORTED")
    return ids


def _groundings(value: object, path: str = "") -> Iterator[tuple[str, GroundedText]]:
    if isinstance(value, GroundedText):
        yield path, value
    elif isinstance(value, ContractModel):
        for key in type(value).model_fields:
            yield from _groundings(
                getattr(value, key), f"{path}.{key}" if path else key
            )
    elif isinstance(value, list):
        for index, item in enumerate(value):
            yield from _groundings(item, f"{path}.{index}")


def validate_delivery(value: dict, root: dict, source_graph: dict) -> dict:
    draft = AdaptationOutlineDraft.from_wire(value)
    context = _context(source_graph)
    ordered = _episodes(root)
    claims, events = {r.id for r in context.claims}, {r.id for r in context.events}
    for path, text in _groundings(draft):
        from .output_validation import OutputContractError

        for key, ids, allowed in (("claimIds", text.claim_ids, claims), ("eventIds", text.event_ids, events)):
            try:
                _references(ids, allowed)
            except ValueError as exc:
                raise OutputContractError(str(exc), path + "." + key) from exc
        proposal = path.startswith("adaptation.proposed_changes.")
        if proposal != (text.nature == "proposed_change"):
            raise OutputContractError("OUTLINE_PROPOSAL_OUTSIDE_TREATMENT", path + ".nature")
        if not proposal and not (text.claim_ids or text.event_ids):
            raise ValueError("OUTLINE_GROUNDING_REQUIRED")
    treatment = draft.adaptation
    _references(treatment.preserve_claim_ids, claims)
    _references(treatment.unresolved_claim_ids, claims)
    if not set(context.required_claim_ids) <= set(treatment.preserve_claim_ids):
        raise ValueError("OUTLINE_REQUIRED_CLAIM_MISSING")
    if set(treatment.unresolved_claim_ids) != set(context.unresolved_claim_ids):
        raise ValueError("OUTLINE_UNRESOLVED_CLAIM_MISMATCH")
    keys = [chapter.key for chapter in draft.chapters]
    require_unique(keys, "OUTLINE_DUPLICATE_CHAPTER_KEY")
    if context.chapter_keys and keys != context.chapter_keys:
        raise ValueError("OUTLINE_CHAPTER_LAYOUT_MISMATCH")
    covered_episodes, covered_events = set(), set()
    for chapter in draft.chapters:
        _references(chapter.episode_ids, set(ordered))
        if chapter.episode_ids != sorted(chapter.episode_ids, key=ordered.index):
            raise ValueError("OUTLINE_CHAPTER_EPISODE_ORDER")
        _references(chapter.must_keep_event_ids, events)
        covered_episodes.update(chapter.episode_ids)
        covered_events.update(chapter.must_keep_event_ids)
    if (
        covered_episodes != set(ordered)
        or [r.episode_id for r in draft.hooks.episode_highlights] != ordered
    ):
        raise ValueError("PLANNING_EPISODES_MISMATCH")
    if not set(context.required_event_ids) <= covered_events:
        raise ValueError("OUTLINE_REQUIRED_EVENT_MISSING")
    _references(draft.craft_notes.causal_chain, events)
    if not set(context.required_event_ids) <= set(draft.craft_notes.causal_chain):
        raise ValueError("OUTLINE_CAUSAL_EVENT_MISSING")
    for rows in (draft.hooks.openings, draft.hooks.setups):
        require_unique([r.key for r in rows], "OUTLINE_DUPLICATE_HOOK_KEY")
    for hook in draft.hooks.openings:
        _references([hook.episode_id], set(ordered))
        if context.opening_event_ids is not None and (
            not hook.image.event_ids
            or not set(hook.image.event_ids) <= set(context.opening_event_ids)
        ):
            raise ValueError("OUTLINE_OPENING_OUTSIDE_SCOPE")
    if root["preset"]["ending_type"] == "closed" and any(
        s.payoff is None for s in draft.hooks.setups
    ):
        raise ValueError("OUTLINE_CLOSED_UNRESOLVED_SETUP")
    craft = draft.craft_notes
    if (
        craft.resistance_kind in {"condition", "internal", "none"}
        and craft.opposition_strategy.applicability != "not_applicable"
    ):
        raise ValueError("OUTLINE_NON_AGENTIC_STRATEGY")
    narratives = draft.overview.synopsis + [
        t for chapter in draft.chapters for t in chapter.story
    ]
    if all(len(t.text.strip()) <= 1 for t in narratives):
        raise ValueError("OUTLINE_NARRATIVE_COLLAPSED")
    return draft.model_dump(mode="json", by_alias=True)


def delivery_schema(root: dict, source_graph: dict) -> dict:
    """Use one Pydantic contract for decoder and host; IDs come from frozen input."""
    context = _context(source_graph)
    episodes = _episodes(root)
    schema = AdaptationOutlineDraft.model_json_schema(by_alias=True)
    claims, events = [r.id for r in context.claims], [r.id for r in context.events]
    for definition in schema["$defs"].values():
        for key, prop in definition.get("properties", {}).items():
            allowed = None
            if key in {"claimIds", "preserveClaimIds", "unresolvedClaimIds"}:
                allowed = claims
            elif key in {"eventIds", "mustKeepEventIds", "causalChain"}:
                allowed = events
            elif key in {"episodeIds", "episodeId"}:
                allowed = episodes
            if allowed is not None:
                if prop.get("type") == "array":
                    if allowed:
                        prop["items"]["enum"] = allowed
                    else:
                        prop["maxItems"] = 0
                else:
                    prop["enum"] = allowed
    # Pydantic after-validators are invisible to JSON Schema. Encode the same
    # conditional contract for the decoder instead of asking it to guess which
    # combinations a later host check will reject.
    definitions = schema["$defs"]
    proposed = deepcopy(definitions["GroundedText"])
    proposed["properties"]["nature"]["enum"] = ["proposed_change"]
    definitions["ProposedGroundedText"] = proposed
    definitions["GroundedText"]["properties"]["nature"]["enum"] = ["source", "interpretation"]
    definitions["AdaptationTreatment"]["properties"]["proposedChanges"]["items"] = {"$ref": "#/$defs/ProposedGroundedText"}
    definitions["SetupDraft"]["anyOf"] = [
        {"properties": {"payoff": {"type": "object"}, "openReason": {"type": "null"}}},
        {"properties": {"payoff": {"type": "null"}, "openReason": {"type": "string", "minLength": 1}}},
    ]
    definitions["CraftPoint"]["anyOf"] = [
        {"properties": {"applicability": {"const": "applicable"}, "evidence": {"type": "object"}, "reason": {"type": "null"}}},
        {"properties": {"applicability": {"const": "not_applicable"}, "evidence": {"type": "null"}, "reason": {"type": "string", "minLength": 1}}},
        {"properties": {"applicability": {"const": "uncertain"}, "reason": {"type": "string", "minLength": 1}}},
    ]
    return schema


def _escape(text: str) -> str:
    # A model/user title or paragraph cannot insert headings, links or HTML.
    return re.sub(
        r"([\\`*_{}\[\]()#+.!|>~\-])",
        r"\\\1",
        html.escape(normalize_text(text), quote=False),
    )


class _Composition:
    def __init__(self) -> None:
        self.lines: list[str] = []
        self.sections: list[dict] = []
        self.protected: set[int] = set()

    def add(
        self,
        text: str,
        path: str,
        grounding: GroundedText | None = None,
        *,
        protected: bool = False,
    ) -> None:
        start = len(self.lines)
        self.lines.extend(text.split("\n"))
        end = len(self.lines) - 1
        self.lines.append("")
        if protected:
            self.protected.update(range(start, end + 1))
        if self.sections:
            self.sections[-1]["paragraphs"].append(
                {
                    "path": path,
                    "start": start,
                    "end": end,
                    "claimIds": grounding.claim_ids if grounding else [],
                    "eventIds": grounding.event_ids if grounding else [],
                    "nature": grounding.nature if grounding else "host",
                    "protected": protected,
                }
            )

    def section(self, key: str, title: str) -> None:
        self.sections.append({"key": key, "start": len(self.lines), "paragraphs": []})
        self.add("## " + title, "section." + key, protected=True)


def _compose(value: dict, root: dict, source_graph: dict) -> _Composition:
    draft = AdaptationOutlineDraft.from_wire(
        validate_delivery(value, root, source_graph)
    )
    context = _context(source_graph)
    spec = root["preset"]
    language = spec.get("output_language", "zh-CN").lower()
    if language not in {"zh", "zh-cn", "en", "vi"}:
        raise ValueError("OUTLINE_LANGUAGE_UNSUPPORTED")
    locale = 1 if language == "en" else 2 if language == "vi" else 0
    from .outline import STRUCTURES

    if spec["structure"] not in STRUCTURES:
        raise ValueError("PLANNING_SPEC_MISMATCH")
    episodes = {ep["id"]: ep["deliveryLabel"] for ep in root["episodes"]}
    claims, events = (
        {r.id: r.text for r in context.claims},
        {r.id: r.text for r in context.events},
    )
    out = _Composition()

    def label(key: str) -> str:
        return LABELS[key][locale]

    def field(
        key: str,
        text: str,
        path: str,
        grounding: GroundedText | None = None,
        *,
        protected: bool = False,
    ) -> None:
        out.add(
            f"**{label(key)}**: {_escape(text)}", path, grounding, protected=protected
        )

    def grounded(key: str, text: GroundedText, path: str) -> None:
        field(key, text.text, path, text)

    def host(key: str, text: str, path: str) -> None:
        field(key, text or label("none"), path, protected=True)

    out.add(
        "# " + _escape(draft.overview.title).replace("\n", " "),
        "overview.title",
        protected=True,
    )
    out.section("overview", label("overview"))
    host(
        "genre",
        " / ".join(
            str(spec.get(k, ""))
            for k in ("primary_genre", "fusion_genre")
            if spec.get(k)
        ),
        "spec.genre",
    )
    count, seconds = spec["episode_count"], spec["duration_seconds"]
    host("scale", f"{count} / {seconds}s / {count * seconds}s", "spec.scale")
    host("structure", STRUCTURES[spec["structure"]][locale], "spec.structure")
    host("tone", spec.get("narrative_tone", ""), "spec.tone")
    host("style", spec.get("visual_style", ""), "spec.style")
    for key, text in (
        ("logline", draft.overview.logline),
        ("protagonist", draft.overview.protagonist),
        ("resistance", draft.overview.resistance),
        ("emotion", draft.overview.emotional_curve),
    ):
        grounded(key, text, "overview." + key)
    for i, text in enumerate(draft.overview.synopsis):
        grounded("synopsis", text, f"overview.synopsis.{i}")

    out.section("adaptation", label("adaptation"))
    host(
        "source",
        context.source_label + " / " + label(context.source_kind),
        "host.source",
    )
    host("brief", root.get("brief", ""), "host.brief")
    for i, text in enumerate(draft.adaptation.approach):
        grounded("approach", text, f"adaptation.approach.{i}")
    host(
        "authorized",
        "\n".join(r.text for r in context.authorized_changes)
        or label("noAuthorization"),
        "host.authorized",
    )
    host(
        "preserve",
        "\n".join(claims[key] for key in draft.adaptation.preserve_claim_ids),
        "host.preserve",
    )
    for i, text in enumerate(draft.adaptation.proposed_changes):
        grounded("proposal", text, f"adaptation.proposed_changes.{i}")
    host(
        "unresolved",
        "\n".join(claims[key] for key in context.unresolved_claim_ids),
        "host.unresolved",
    )

    out.section("chapters", label("chapters"))
    for i, chapter in enumerate(draft.chapters):
        out.add(
            "### " + _escape(chapter.title).replace("\n", " "),
            f"chapters.{i}.title",
            protected=True,
        )
        host(
            "episodes",
            " / ".join(episodes[key] for key in chapter.episode_ids),
            f"chapters.{i}.episodes",
        )
        grounded("position", chapter.position, f"chapters.{i}.position")
        for j, text in enumerate(chapter.story):
            out.add(_escape(text.text), f"chapters.{i}.story.{j}", text)
        host(
            "keepEvents",
            "\n".join(events[key] for key in chapter.must_keep_event_ids),
            f"chapters.{i}.events",
        )

    out.section("hooks", label("hooks"))
    for i, item in enumerate(draft.hooks.episode_highlights):
        field(
            "highlights",
            episodes[item.episode_id] + ": " + item.highlight.text,
            f"hooks.highlights.{i}",
            item.highlight,
        )
    for i, hook in enumerate(draft.hooks.openings):
        host("episodes", episodes[hook.episode_id], f"hooks.openings.{i}.episode")
        grounded("opening", hook.image, f"hooks.openings.{i}.image")
        field("question", hook.question, f"hooks.openings.{i}.question", hook.image)
    for i, setup in enumerate(draft.hooks.setups):
        grounded("plant", setup.plant, f"hooks.setups.{i}.plant")
        if setup.payoff:
            grounded("payoff", setup.payoff, f"hooks.setups.{i}.payoff")
        else:
            field("openReason", setup.open_reason, f"hooks.setups.{i}.reason")
    if draft.hooks.inapplicable_reason:
        field("inapplicable", draft.hooks.inapplicable_reason, "hooks.inapplicable")

    out.section("boundaries", label("boundaries"))
    host("locked", spec.get("locked_facts", ""), "host.locked")
    for i, text in enumerate(draft.boundaries):
        out.add(_escape(text.text), f"boundaries.{i}", text)
    return out


def render_delivery(value: dict, root: dict, source_graph: dict) -> str:
    return "\n".join(_compose(value, root, source_graph).lines) + "\n"


def build_outline_candidate(
    value: dict, root: dict, source_graph: dict, *, previous: DocumentAST | None = None
) -> dict:
    composition = _compose(value, root, source_graph)
    ast = parse_markdown("\n".join(composition.lines) + "\n", previous=previous)
    sections = []
    for i, section in enumerate(composition.sections):
        start = section["start"]
        end = (
            composition.sections[i + 1]["start"]
            if i + 1 < len(composition.sections)
            else len(ast.blocks)
        )
        sections.append(
            {
                "key": section["key"],
                "headingBlockId": ast.blocks[start].id,
                "blockIds": [block.id for block in ast.blocks[start:end]],
                "paragraphs": [
                    {
                        **{k: v for k, v in row.items() if k not in {"start", "end"}},
                        "startBlockId": ast.blocks[row["start"]].id,
                        "endBlockId": ast.blocks[row["end"]].id,
                    }
                    for row in section["paragraphs"]
                ],
            }
        )
    index = OutlineIndex.from_wire(
        {
            "contract": DELIVERY_CONTRACT,
            "astHash": object_hash(ast.model_dump(by_alias=True)),
            "semanticHash": semantic_hash(ast),
            "sourceVersionId": source_graph["sourceVersionId"],
            "sourceHash": source_graph["sourceHash"],
            "contextHash": object_hash(source_graph),
            "specHash": object_hash(
                {
                    "preset": root["preset"],
                    "episodes": root["episodes"],
                    "brief": root.get("brief", ""),
                }
            ),
            "sections": sections,
            "protectedBlockIds": [
                ast.blocks[i].id for i in sorted(composition.protected)
            ],
        }
    )
    bindings = index.model_dump(mode="json", by_alias=True)
    validate_index(ast, bindings)
    return {
        "ast": ast.model_dump(mode="json", by_alias=True),
        "bindings": bindings,
        "craftNotes": AdaptationOutlineDraft.from_wire(value).craft_notes.model_dump(
            mode="json", by_alias=True
        ),
    }


def validate_index(ast: DocumentAST, value: dict) -> None:
    index = OutlineIndex.from_wire(value)
    if index.ast_hash != object_hash(
        ast.model_dump(by_alias=True)
    ) or index.semantic_hash != semantic_hash(ast):
        raise ValueError("OUTLINE_INDEX_STALE")
    if (
        any(block.children for block in ast.blocks)
        or tuple(s.key for s in index.sections) != SECTION_ORDER
    ):
        raise ValueError("OUTLINE_INDEX_INVALID")
    slots = {b.id: i for i, b in enumerate(ast.blocks)}
    require_unique(index.protected_block_ids, "OUTLINE_INDEX_INVALID")
    if not set(index.protected_block_ids) <= set(slots):
        raise ValueError("OUTLINE_INDEX_INVALID")
    headings = [b.id for b in ast.blocks if b.type == "heading" and b.attrs.level == 2]
    if headings != [s.heading_block_id for s in index.sections]:
        raise ValueError("OUTLINE_INDEX_INVALID")
    covered, paths = [], []
    for section in index.sections:
        if (
            not set(section.block_ids) <= set(slots)
            or section.block_ids[0] != section.heading_block_id
        ):
            raise ValueError("OUTLINE_INDEX_INVALID")
        indices = [slots[key] for key in section.block_ids]
        if (
            indices != list(range(indices[0], indices[-1] + 1))
            or section.heading_block_id not in index.protected_block_ids
        ):
            raise ValueError("OUTLINE_INDEX_INVALID")
        covered.extend(section.block_ids)
        paragraph_slots = set()
        for paragraph in section.paragraphs:
            paths.append(paragraph.path)
            if (
                paragraph.start_block_id not in section.block_ids
                or paragraph.end_block_id not in section.block_ids
            ):
                raise ValueError("OUTLINE_INDEX_INVALID")
            start, end = slots[paragraph.start_block_id], slots[paragraph.end_block_id]
            if end < start or paragraph_slots.intersection(range(start, end + 1)):
                raise ValueError("OUTLINE_INDEX_INVALID")
            paragraph_slots.update(range(start, end + 1))
            if paragraph.protected and not {
                b.id for b in ast.blocks[start : end + 1]
            } <= set(index.protected_block_ids):
                raise ValueError("OUTLINE_INDEX_INVALID")
        if not {i for i in indices if ast.blocks[i].text.strip()} <= paragraph_slots:
            raise ValueError("OUTLINE_INDEX_INVALID")
    require_unique(paths, "OUTLINE_INDEX_INVALID")
    if covered != [b.id for b in ast.blocks[slots[headings[0]] :]]:
        raise ValueError("OUTLINE_INDEX_INVALID")
