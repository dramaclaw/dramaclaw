"""Model ranges are untrusted; partial adoption preserves every untouched block."""

import copy

import pytest

from novelvideo.director.documents import object_hash, render_markdown
from novelvideo.director.outline_delivery import build_outline_candidate, validate_index
from novelvideo.director.outline_patch import apply_groups, patch_context, validate_patch
from novelvideo.director.schemas.documents import DocumentAST
from tests.director.test_outline_delivery import case as case


def proposal(case):
    candidate = build_outline_candidate(case["draft"], case["root"], case["context"])
    ast = DocumentAST.from_wire(candidate["ast"])
    frozen = patch_context(ast, candidate["bindings"], 1, [c["id"] for c in case["context"]["claims"]])
    blocks = {b.id: b for b in ast.blocks}
    hunks = []
    for section in candidate["bindings"]["sections"][:3]:
        target = next(b for b in section["blockIds"] if b not in candidate["bindings"]["protectedBlockIds"])
        hunks.append({"id": "h-" + section["key"], "sectionKey": section["key"],
            "targetBlockIds": [target], "beforeHash": object_hash([blocks[target].model_dump(by_alias=True)]),
            "afterBlocks": [{"type": "paragraph", "text": "A revised, source-bound sentence.",
                             "level": None, "lineBreak": False}],
            "changedClaimIds": [], "reason": "Requested clarification."})
    draft = {"contract": "outline-patch/1.0.0", **{k: frozen[k] for k in ("baseVersion", "baseAstHash", "baseSemanticHash")},
        "hunks": hunks, "changeSummary": [{"text": "Clarify three passages.", "hunkIds": [h["id"] for h in hunks]}],
        "unresolvedRequests": []}
    return draft, frozen


def test_partial_patch_is_deterministic_and_untouched_ids_survive(case):
    raw, frozen = proposal(case)
    validated = validate_patch(raw, frozen)
    groups = [validated["groups"][0]["id"]]
    candidate = apply_groups(validated, groups)
    assert candidate == apply_groups(validated, groups)
    ast = DocumentAST.from_wire(candidate["ast"])
    validate_index(ast, candidate["bindings"])
    before = DocumentAST.from_wire(frozen["baseAst"])
    targets = set(raw["hunks"][0]["targetBlockIds"])
    after = {b.id: b for b in ast.blocks}
    for block in before.blocks:
        if block.id not in targets:
            assert after[block.id] == block
    assert len([b for b in ast.blocks if b.type == "heading" and b.attrs.level == 2]) == 5
    assert render_markdown(DocumentAST.from_wire(apply_groups(validated, [])["ast"])) == render_markdown(before)


@pytest.mark.parametrize("mutation", ["hash", "version", "protected", "overlap", "foreign", "summary", "new-fact", "extra"])
def test_malformed_ranges_never_reach_candidate(case, mutation):
    raw, frozen = proposal(case)
    if mutation == "hash":
        raw["hunks"][0]["beforeHash"] = "a" * 64
    elif mutation == "version":
        raw["baseVersion"] += 1
    elif mutation == "protected":
        raw["hunks"][0]["targetBlockIds"] = [frozen["bindings"]["sections"][0]["headingBlockId"]]
    elif mutation == "overlap":
        other = copy.deepcopy(raw["hunks"][0])
        other["id"] = "other"
        raw["hunks"].append(other)
    elif mutation == "foreign":
        raw["hunks"][0]["targetBlockIds"] = ["not-in-this-document"]
    elif mutation == "summary":
        raw["changeSummary"][0]["hunkIds"].pop()
    elif mutation == "new-fact":
        raw["hunks"][0]["changedClaimIds"] = ["invented-claim"]
    else:
        raw["inventedField"] = "reject"
    with pytest.raises(ValueError):
        validate_patch(raw, frozen)


def test_shared_claim_changes_form_atomic_dependency_group(case):
    raw, frozen = proposal(case)
    for h in raw["hunks"][:2]:
        h["changedClaimIds"] = [frozen["claimIds"][0]]
    validated = validate_patch(raw, frozen)
    assert len(validated["groups"]) == 2
    assert len(validated["groups"][0]["hunkIds"]) == 2
    with pytest.raises(ValueError, match="UNKNOWN_GROUP"):
        apply_groups(validated, [raw["hunks"][0]["id"]])


def test_identical_replacement_is_not_a_reviewable_change(case):
    raw, frozen = proposal(case)
    hunk = raw["hunks"][0]
    block = next(b for b in frozen["baseAst"]["blocks"] if b["id"] == hunk["targetBlockIds"][0])
    hunk["afterBlocks"] = [{"type": block["type"], "text": block["text"],
                            "level": block["attrs"]["level"], "lineBreak": block["attrs"]["lineBreak"]}]
    with pytest.raises(ValueError, match="OUTLINE_PATCH_NO_CHANGE"):
        validate_patch(raw, frozen)


def test_replacing_prose_preserves_unchanged_label_format(case):
    raw, frozen = proposal(case)
    hunk = raw["hunks"][0]
    block = next(b for b in frozen["baseAst"]["blocks"] if b["marks"]
                 and b["id"] in frozen["bindings"]["sections"][0]["blockIds"]
                 and b["id"] not in frozen["bindings"]["protectedBlockIds"])
    hunk.update(targetBlockIds=[block["id"]], beforeHash=object_hash([block]))
    assert block["marks"], "Use an actual marked field, not a synthetic rendered assertion"
    hunk["afterBlocks"] = [{"type": block["type"], "text": block["text"] + " Clarification.",
                            "level": block["attrs"]["level"], "lineBreak": block["attrs"]["lineBreak"]}]
    result = validate_patch(raw, frozen)
    candidate = apply_groups(result, [result["groups"][0]["id"]])
    after = next(b for b in candidate["ast"]["blocks"] if b["lineage"] == hunk["targetBlockIds"])
    assert after["marks"] == block["marks"]
