"""Partial decisions rebuild from an immutable base, never from shifting strings."""

from __future__ import annotations

from difflib import SequenceMatcher

from .documents import object_hash, semantic_hash
from .outline_delivery import SECTION_ORDER, validate_index
from .schemas.common import require_unique
from .schemas.documents import Block, BlockAttrs, DocumentAST
from .schemas.outline_changes import OutlinePatchDraft


def index_current(ast: DocumentAST, original: dict) -> dict:
    """User edits are current authority; old M07 prose is never used to rebuild them."""
    headings = [(i, b) for i, b in enumerate(ast.blocks) if b.type == "heading" and b.attrs.level == 2]
    if len(headings) != 5 or any(b.children for b in ast.blocks):
        raise ValueError("OUTLINE_CONVERSION_REQUIRED")
    expected = [s["headingBlockId"] for s in original["sections"]]
    if [b.id for _, b in headings] != expected:
        raise ValueError("OUTLINE_CONVERSION_REQUIRED")
    current_ids = {b.id for b in ast.blocks}
    protected = set(original["protectedBlockIds"]) & current_ids
    sections = []
    from .outline_candidate_review import evidence_role

    metadata = {}
    for section in original["sections"]:
        ids = section["blockIds"]
        for paragraph in section["paragraphs"]:
            start, end = (ids.index(paragraph[key]) for key in ("startBlockId", "endBlockId"))
            for bid in ids[start:end + 1]:
                metadata[bid] = paragraph
    for pos, ((start, heading), key) in enumerate(zip(headings, SECTION_ORDER, strict=True)):
        end = headings[pos + 1][0] if pos + 1 < len(headings) else len(ast.blocks)
        protected.add(heading.id)
        members = ast.blocks[start:end]
        def binding(block):
            prior = next((metadata[bid] for bid in [block.id, *block.lineage] if bid in metadata), None)
            role = ((prior.get("evidenceRole") or evidence_role(prior["path"])) if prior
                    else "narrative" if key in {"overview", "chapters", "hooks"} and block.type != "heading" else "commentary")
            return {"path": key + ".block." + block.id, "startBlockId": block.id, "endBlockId": block.id,
                    "claimIds": prior["claimIds"] if prior else [], "eventIds": prior["eventIds"] if prior else [],
                    "nature": "host" if block.id in protected else prior["nature"] if prior else "interpretation",
                    "evidenceRole": role, "protected": block.id in protected}
        sections.append({"key": key, "headingBlockId": heading.id,
                         "blockIds": [b.id for b in members], "paragraphs": [binding(b) for b in members]})
    value = {**original, "astHash": object_hash(ast.model_dump(by_alias=True)),
             "semanticHash": semantic_hash(ast), "protectedBlockIds": sorted(protected), "sections": sections}
    validate_index(ast, value)
    return value


def patch_context(ast: DocumentAST, bindings: dict, version: int, claim_ids: list[str]) -> dict:
    validate_index(ast, bindings)
    return {"baseVersion": version, "baseAstHash": object_hash(ast.model_dump(by_alias=True)),
            "baseSemanticHash": semantic_hash(ast), "baseAst": ast.model_dump(by_alias=True),
            "bindings": bindings, "claimIds": claim_ids, "allowedSections": list(SECTION_ORDER)}


def validate_patch(value: dict, frozen: dict) -> dict:
    patch = OutlinePatchDraft.from_wire(value)
    ast = DocumentAST.from_wire(frozen["baseAst"])
    validate_index(ast, frozen["bindings"])
    if (patch.base_version != frozen["baseVersion"] or patch.base_ast_hash != frozen["baseAstHash"]
            or patch.base_semantic_hash != frozen["baseSemanticHash"]
            or patch.base_ast_hash != object_hash(ast.model_dump(by_alias=True))
            or patch.base_semantic_hash != semantic_hash(ast)):
        raise ValueError("OUTLINE_REVIEW_HEAD_CHANGED")
    require_unique([h.id for h in patch.hunks], "OUTLINE_DUPLICATE_HUNK")
    sections = {s["key"]: set(s["blockIds"]) for s in frozen["bindings"]["sections"]}
    slots = {b.id: i for i, b in enumerate(ast.blocks)}
    protected = set(frozen["bindings"]["protectedBlockIds"])
    touched = set()
    for hunk in patch.hunks:
        targets = set(hunk.target_block_ids)
        if (hunk.section_key not in frozen["allowedSections"] or targets & touched
                or targets & protected or not targets <= sections[hunk.section_key]
                or len(targets) != len(hunk.target_block_ids)):
            raise ValueError("OUTLINE_PATCH_SCOPE_OR_OVERLAP")
        positions = [slots[key] for key in hunk.target_block_ids]
        if positions != list(range(positions[0], positions[-1] + 1)):
            raise ValueError("OUTLINE_PATCH_TARGET_INVALID")
        before = [ast.blocks[i].model_dump(by_alias=True) for i in positions]
        if object_hash(before) != hunk.before_hash:
            raise ValueError("OUTLINE_PATCH_TARGET_INVALID")
        before_prose = [{"type": b["type"], "text": b["text"], "level": b["attrs"]["level"],
                         "lineBreak": b["attrs"]["lineBreak"]} for b in before]
        if before_prose == [b.model_dump(by_alias=True) for b in hunk.after_blocks]:
            raise ValueError("OUTLINE_PATCH_NO_CHANGE")
        if not set(hunk.changed_claim_ids) <= set(frozen["claimIds"]):
            raise ValueError("OUTLINE_PATCH_UNKNOWN_CLAIM")
        touched.update(targets)
    known = {h.id for h in patch.hunks}
    summarized = set()
    for summary in patch.change_summary:
        if not set(summary.hunk_ids) <= known:
            raise ValueError("OUTLINE_SUMMARY_UNKNOWN_HUNK")
        summarized.update(summary.hunk_ids)
    if summarized != known:
        raise ValueError("OUTLINE_SUMMARY_INCOMPLETE")
    # Group related factual changes transitively, independent of response order.
    remaining = {h.id: h for h in patch.hunks}
    groups = []
    while remaining:
        seed = min(remaining, key=lambda key: slots[remaining[key].target_block_ids[0]])
        members = [remaining.pop(seed)]
        changed = True
        while changed:
            claims = {key for h in members for key in h.changed_claim_ids}
            related = [key for key, h in remaining.items() if claims & set(h.changed_claim_ids)]
            changed = bool(related)
            members.extend(remaining.pop(key) for key in related)
        members.sort(key=lambda h: slots[h.target_block_ids[0]])
        ids = [h.id for h in members]
        groups.append({"id": "group-" + object_hash(ids)[:24], "hunkIds": ids,
                       "sectionKeys": [s for s in SECTION_ORDER if s in {h.section_key for h in members}],
                       "requiresGroupIds": []})
    return {"patch": patch.model_dump(by_alias=True), "groups": groups,
            "base": frozen, "proposalHash": object_hash(patch.model_dump(by_alias=True))}


def replacement_blocks(proposal: dict, hunk: dict) -> list[Block]:
    """Formatting belongs to the host AST, not to a model's unmarked prose.

    Preserve only entire marks within unchanged runs of a one-to-one block
    replacement. Never extend emphasis over new words or infer new formatting.
    """
    before = {b["id"]: Block.from_wire(b) for b in proposal["base"]["baseAst"]["blocks"]}
    targets = [before[key] for key in hunk["targetBlockIds"]]
    blocks = []
    for i, after in enumerate(hunk["afterBlocks"]):
        marks = []
        if len(targets) == len(hunk["afterBlocks"]) and targets[i].type == after["type"]:
            prior = targets[i]
            equal = SequenceMatcher(None, prior.text, after["text"], autojunk=False).get_matching_blocks()
            for mark in prior.marks:
                match = next((m for m in equal if m.a <= mark.start and mark.end <= m.a + m.size), None)
                if match is not None:
                    marks.append(mark.model_copy(update={"start": mark.start + match.b - match.a,
                                                         "end": mark.end + match.b - match.a}))
        blocks.append(Block(id="block-" + object_hash([proposal["proposalHash"], hunk["id"], i])[:24],
            type=after["type"], text=after["text"], marks=marks,
            attrs=BlockAttrs(level=after["level"], line_break=after["lineBreak"]),
            lineage=list(dict.fromkeys([*hunk["targetBlockIds"], *(bid for b in targets for bid in b.lineage)]))))
    return blocks


def apply_groups(proposal: dict, accepted_group_ids: list[str]) -> dict:
    require_unique(accepted_group_ids, "OUTLINE_DUPLICATE_GROUP")
    known = {g["id"] for g in proposal["groups"]}
    if not set(accepted_group_ids) <= known:
        raise ValueError("OUTLINE_UNKNOWN_GROUP")
    selected = {h for g in proposal["groups"] if g["id"] in accepted_group_ids for h in g["hunkIds"]}
    base = proposal["base"]
    original = DocumentAST.from_wire(base["baseAst"])
    hunks = {h["targetBlockIds"][0]: h for h in proposal["patch"]["hunks"] if h["id"] in selected}
    blocks, cursor = [], 0
    while cursor < len(original.blocks):
        block = original.blocks[cursor]
        hunk = hunks.get(block.id)
        if hunk is None:
            blocks.append(block)
            cursor += 1
            continue
        blocks.extend(replacement_blocks(proposal, hunk))
        cursor += len(hunk["targetBlockIds"])
    ast = DocumentAST(blocks=blocks)
    return {"ast": ast.model_dump(by_alias=True), "bindings": index_current(ast, base["bindings"]),
            "craftNotes": {}, "acceptedGroupIds": sorted(accepted_group_ids)}
