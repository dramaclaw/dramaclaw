"""Delivery regressions use invented facts, never a user's private manuscript."""

import copy
import json
from pathlib import Path

import pytest

from novelvideo.director.documents import object_hash, render_markdown
from novelvideo.director.outline import parse_outline, render_outline, validate_outline
from novelvideo.director.schemas.documents import DocumentAST

FIXTURE = Path(__file__).parents[1] / "fixtures/director/outline-v3/delivery.json"


@pytest.fixture
def case():
    value = json.loads(FIXTURE.read_text())
    value["root"]["outlineDeliveryContext"] = value["context"]
    return value


def test_five_sections_are_an_explicit_host_contract(case):
    validated = validate_outline(case["draft"], case["root"])
    text = render_outline(validated, case["root"])
    assert len([line for line in text.splitlines() if line.startswith("## ")]) == 5
    assert "Craft notes" not in text
    assert "No intentional opponent" not in text
    assert "1 / 600s / 600s" in text


def test_decoder_exposes_cross_field_rules_before_provider_call(case):
    import jsonschema
    from novelvideo.director.outline_delivery import delivery_schema

    schema = delivery_schema(case["root"], case["context"])
    jsonschema.validate(case["draft"], schema)
    invalid = copy.deepcopy(case["draft"])
    invalid["overview"]["logline"]["nature"] = "proposed_change"
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate(invalid, schema)
    invalid = copy.deepcopy(case["draft"])
    point = invalid["craftNotes"]["actualCost"]
    point.update(applicability="applicable", evidence=invalid["overview"]["logline"], reason="Must be null when applicable")
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate(invalid, schema)


def test_ast_projection_is_lossless_and_index_is_bound_to_it(case):
    from novelvideo.director.outline_delivery import (
        build_outline_candidate,
        validate_index,
    )

    candidate = build_outline_candidate(case["draft"], case["root"], case["context"])
    ast = DocumentAST.from_wire(candidate["ast"])
    assert render_markdown(ast) == render_outline(case["draft"], case["root"])
    assert candidate["bindings"]["astHash"] == object_hash(candidate["ast"])
    assert len(candidate["bindings"]["sections"]) == 5
    validate_index(ast, candidate["bindings"])
    changed = ast.model_copy(update={"blocks": ast.blocks[:-1]})
    with pytest.raises(ValueError, match="OUTLINE_INDEX_STALE"):
        validate_index(changed, candidate["bindings"])


def test_model_cannot_invent_authorization(case):
    case["draft"]["adaptation"]["approvedChanges"] = ["invent a marriage"]
    with pytest.raises(ValueError):
        validate_outline(case["draft"], case["root"])


def test_storyplan_v2_is_not_silently_relabelled_as_five_sections(case):
    from tests.director.test_outline import sample

    old, root = sample()
    assert (
        len(
            [
                line
                for line in render_outline(
                    validate_outline(old, root), root
                ).splitlines()
                if line.startswith("## ")
            ]
        )
        == 11
    )
    with pytest.raises(ValueError):
        validate_outline(old, case["root"])


@pytest.mark.parametrize(
    "field", ["overview", "adaptation", "chapters", "hooks", "boundaries", "craftNotes"]
)
def test_missing_sections_fail_instead_of_being_padded(case, field):
    del case["draft"][field]
    with pytest.raises(ValueError):
        validate_outline(case["draft"], case["root"])


@pytest.mark.parametrize("field", ["claimIds", "eventIds"])
def test_unknown_grounding_references_fail(case, field):
    case["draft"]["overview"]["synopsis"][0][field] = ["not-in-source"]
    with pytest.raises(ValueError, match="OUTLINE_REFERENCE_MISSING"):
        validate_outline(case["draft"], case["root"])


def test_duplicate_json_keys_are_not_silently_overwritten(case):
    raw = json.dumps(case["draft"])
    raw = raw[:-1] + ', "contract": "adaptation-outline/3.0.0"}'
    with pytest.raises(ValueError, match="OUTLINE_DUPLICATE_JSON_KEY"):
        parse_outline(raw, case["root"])


def test_input_is_not_mutated_by_projection(case):
    before = copy.deepcopy(case)
    render_outline(validate_outline(case["draft"], case["root"]), case["root"])
    assert case == before


@pytest.mark.parametrize(
    "language,headings",
    [
        (
            "zh-CN",
            [
                "【一】概要设计",
                "【二】这次改写怎么处理原文",
                "【三】篇章划分",
                "【四】钩子预设",
                "【五】改写禁区",
            ],
        ),
        (
            "en",
            [
                "[1] Overview design",
                "[2] Adaptation treatment",
                "[3] Chapter breakdown",
                "[4] Planned hooks",
                "[5] Adaptation boundaries",
            ],
        ),
        (
            "vi",
            [
                "[1] Thiết kế tổng quan",
                "[2] Cách chuyển thể nguyên tác",
                "[3] Phân chia chương",
                "[4] Móc câu dự kiến",
                "[5] Giới hạn chuyển thể",
            ],
        ),
    ],
)
def test_all_locales_have_exactly_the_five_host_owned_sections(
    case, language, headings
):
    case["root"]["preset"]["output_language"] = language
    text = render_outline(case["draft"], case["root"])
    assert [
        line[3:] for line in text.splitlines() if line.startswith("## ")
    ] == headings
    assert "event-1" not in text
    assert "claim-1" not in text
    assert "source-1" not in text


@pytest.mark.parametrize("seconds", [1, 600, 5400])
def test_host_duration_is_not_written_or_limited_by_model(case, seconds):
    case["root"]["preset"]["duration_seconds"] = seconds
    assert f"1 / {seconds}s / {seconds}s" in render_outline(case["draft"], case["root"])
    case["draft"]["overview"]["durationSeconds"] = seconds + 1
    with pytest.raises(ValueError):
        validate_outline(case["draft"], case["root"])


@pytest.mark.parametrize("value", [0, -1, 1.5, True, "600"])
def test_invalid_host_duration_is_not_coerced(case, value):
    case["root"]["preset"]["duration_seconds"] = value
    with pytest.raises(ValueError, match="PLANNING_SPEC_MISMATCH"):
        validate_outline(case["draft"], case["root"])


@pytest.mark.parametrize(
    "path,replacement,code",
    [
        (("overview", "title"), "  \n\t", "string_pattern_mismatch"),
        (("overview", "synopsis"), [], "too_short"),
        (("overview", "logline", "text"), "\t\n", "string_pattern_mismatch"),
        (
            ("overview", "logline", "claimIds"),
            ["claim-1", "claim-1"],
            "OUTLINE_DUPLICATE_REFERENCE",
        ),
        (
            ("overview", "logline", "nature"),
            "proposed_change",
            "OUTLINE_PROPOSAL_OUTSIDE_TREATMENT",
        ),
        (("chapters", 0, "episodeIds"), ["ep-2"], "OUTLINE_REFERENCE_MISSING"),
        (("chapters", 0, "key"), "warning", "OUTLINE_DUPLICATE_CHAPTER_KEY"),
        (("chapters", 0, "mustKeepEventIds"), [], "OUTLINE_REQUIRED_EVENT_MISSING"),
        (
            ("chapters", 0, "position", "eventIds"),
            ["event-404"],
            "OUTLINE_REFERENCE_MISSING",
        ),
        (
            ("hooks", "episodeHighlights", 0, "episodeId"),
            "ep-2",
            "PLANNING_EPISODES_MISMATCH",
        ),
        (("hooks", "openings", 0, "episodeId"), "ep-2", "OUTLINE_REFERENCE_MISSING"),
        (
            ("hooks", "openings", 0, "image", "eventIds"),
            ["event-2"],
            "OUTLINE_OPENING_OUTSIDE_SCOPE",
        ),
        (
            ("adaptation", "preserveClaimIds"),
            ["claim-1"],
            "OUTLINE_REQUIRED_CLAIM_MISSING",
        ),
        (("adaptation", "unresolvedClaimIds"), [], "OUTLINE_UNRESOLVED_CLAIM_MISMATCH"),
        (("craftNotes", "causalChain"), ["event-1"], "OUTLINE_CAUSAL_EVENT_MISSING"),
        (("craftNotes", "actualCost", "reason"), " ", "string_pattern_mismatch"),
    ],
)
def test_broken_model_contract_is_rejected(case, path, replacement, code):
    target = case["draft"]
    for key in path[:-1]:
        target = target[key]
    target[path[-1]] = replacement
    with pytest.raises(ValueError, match=code):
        validate_outline(case["draft"], case["root"])


def test_closed_story_cannot_sneak_in_unresolved_setup(case):
    setup = case["draft"]["hooks"]["setups"][0]
    setup.update(payoff=None, openReason="Leave it for a sequel.")
    with pytest.raises(ValueError, match="OUTLINE_CLOSED_UNRESOLVED_SETUP"):
        validate_outline(case["draft"], case["root"])
    case["root"]["preset"]["ending_type"] = "open"
    assert "Leave it for a sequel" in render_outline(case["draft"], case["root"])


def test_non_agentic_resistance_does_not_require_a_fictitious_strategy(case):
    point = case["draft"]["craftNotes"]["oppositionStrategy"]
    point.update(
        applicability="applicable",
        evidence=case["draft"]["overview"]["resistance"],
        reason=None,
    )
    with pytest.raises(ValueError, match="OUTLINE_NON_AGENTIC_STRATEGY"):
        validate_outline(case["draft"], case["root"])


def test_proposals_stay_separate_from_authorization(case):
    case["draft"]["adaptation"]["proposedChanges"] = [
        {
            "text": "Add a new meeting.",
            "claimIds": [],
            "eventIds": [],
            "nature": "proposed_change",
        }
    ]
    text = render_outline(case["draft"], case["root"])
    assert "No new plot changes authorized" in text
    assert "Proposed changes (not authorized, awaiting confirmation)" in text
    assert "Add a new meeting" in text
    assert "Add a new meeting" not in text.split("## [2]")[0]
    case["context"]["authorizedChanges"] = [
        {"id": "decision-1", "text": "Change only the season."}
    ]
    assert "Change only the season" in render_outline(case["draft"], case["root"])


def test_no_grounding_cannot_look_like_a_source_fact(case):
    case["draft"]["overview"]["logline"].update(claimIds=[], eventIds=[])
    with pytest.raises(ValueError, match="OUTLINE_GROUNDING_REQUIRED"):
        validate_outline(case["draft"], case["root"])


def test_existing_quotes_do_not_prove_semantic_truth(case):
    # Valid IDs cannot detect a lie: B02/B06 must independently check support.
    case["draft"]["overview"]["synopsis"][2]["text"] = (
        "The visitor returns BEFORE the friend knocks."
    )
    from novelvideo.director.outline_delivery import build_outline_candidate

    candidate = build_outline_candidate(case["draft"], case["root"], case["context"])
    assert "auditStatus" not in candidate
    assert "qualityPassed" not in candidate
    assert "semanticVerdict" not in candidate


def test_three_chapters_can_all_belong_to_one_episode(case):
    assert len(validate_outline(case["draft"], case["root"])["chapters"]) == 3
    case["context"]["chapterKeys"] = ["return", "warning", "arrival"]
    with pytest.raises(ValueError, match="OUTLINE_CHAPTER_LAYOUT_MISMATCH"):
        validate_outline(case["draft"], case["root"])


def test_multiepisode_coverage_and_order(case):
    case["root"]["preset"]["episode_count"] = 2
    case["root"]["episodes"].append({"id": "ep-2", "deliveryLabel": "Episode 2"})
    case["draft"]["chapters"][2]["episodeIds"] = ["ep-1", "ep-2"]
    highlight = copy.deepcopy(case["draft"]["hooks"]["episodeHighlights"][0])
    highlight["episodeId"] = "ep-2"
    case["draft"]["hooks"]["episodeHighlights"].append(highlight)
    assert "2 / 600s / 1200s" in render_outline(case["draft"], case["root"])
    case["draft"]["chapters"][2]["episodeIds"].reverse()
    with pytest.raises(ValueError, match="OUTLINE_CHAPTER_EPISODE_ORDER"):
        validate_outline(case["draft"], case["root"])


def test_cannot_drop_host_context_or_guess_contract(case):
    root = case["root"]
    del root["outlineDeliveryContext"]
    with pytest.raises(ValueError, match="OUTLINE_DELIVERY_CONTEXT_REQUIRED"):
        validate_outline(case["draft"], root)
    with pytest.raises(ValueError, match="OUTLINE_DELIVERY_CONTEXT_REQUIRED"):
        render_outline(case["draft"], root)
    root["outlineContract"] = "invented/99"
    with pytest.raises(ValueError, match="OUTLINE_CONTRACT_UNSUPPORTED"):
        validate_outline(case["draft"], root)
    del root["outlineContract"]
    with pytest.raises(ValueError):
        validate_outline(case["draft"], root)


def test_original_cannot_be_reinterpreted_as_adaptation(case):
    case["root"]["preset"]["mode"] = "original"
    with pytest.raises(ValueError, match="OUTLINE_ADAPTATION_REQUIRED"):
        validate_outline(case["draft"], case["root"])


@pytest.mark.parametrize(
    "text",
    [
        "# Evil title\n## Inserted section",
        "<script>alert(1)</script>",
        "[click](javascript:alert(1))",
        "**bold** and `code`",
        "~~~\n```\n> quoted\n- bullet",
        "同文 😀 e\u0301\n\n同文 😀 e\u0301",
        "A & B <img src=x onerror=alert(1)>",
    ],
)
def test_model_text_cannot_inject_structure_or_executable_markup(case, text):
    from novelvideo.director.outline_delivery import (
        build_outline_candidate,
        validate_index,
    )

    case["draft"]["overview"]["title"] = text
    case["draft"]["overview"]["synopsis"][0]["text"] = text
    candidate = build_outline_candidate(case["draft"], case["root"], case["context"])
    ast = DocumentAST.from_wire(candidate["ast"])
    markdown = render_markdown(ast)
    assert len([b for b in ast.blocks if b.attrs.level == 2]) == 5
    assert "<script>" not in markdown and "<img " not in markdown
    assert "[click](javascript:" not in markdown
    assert all("\n" not in b.text for b in ast.blocks)
    validate_index(ast, candidate["bindings"])


def test_multiline_paragraphs_bind_all_lines_and_preserve_ids_on_rebuild(case):
    from novelvideo.director.outline_delivery import build_outline_candidate

    case["draft"]["overview"]["synopsis"][0]["text"] = "Same 😀\n\nSame 😀"
    first = build_outline_candidate(case["draft"], case["root"], case["context"])
    ast = DocumentAST.from_wire(first["ast"])
    binding = next(
        p
        for p in first["bindings"]["sections"][0]["paragraphs"]
        if p["path"] == "overview.synopsis.0"
    )
    ids = [b.id for b in ast.blocks]
    assert ids.index(binding["endBlockId"]) - ids.index(binding["startBlockId"]) == 2
    second = build_outline_candidate(
        case["draft"], case["root"], case["context"], previous=ast
    )
    assert first == second
    third_ast = DocumentAST.from_wire(json.loads(json.dumps(first["ast"])))
    assert render_markdown(third_ast) == render_markdown(ast)


@pytest.mark.parametrize(
    "mutation", ["section", "overlap", "paragraph", "protected", "missing_paragraphs"]
)
def test_forged_or_stale_index_is_rejected(case, mutation):
    from novelvideo.director.outline_delivery import (
        build_outline_candidate,
        validate_index,
    )

    candidate = build_outline_candidate(case["draft"], case["root"], case["context"])
    index = candidate["bindings"]
    if mutation == "section":
        index["sections"][0]["key"] = "hooks"
    elif mutation == "overlap":
        index["sections"][1]["blockIds"].insert(0, index["sections"][0]["blockIds"][-1])
    elif mutation == "paragraph":
        index["sections"][0]["paragraphs"][0]["endBlockId"] = index["sections"][1][
            "headingBlockId"
        ]
    elif mutation == "protected":
        index["protectedBlockIds"] = []
    else:
        index["sections"][0]["paragraphs"] = []
    with pytest.raises(ValueError, match="OUTLINE_INDEX_INVALID"):
        validate_index(DocumentAST.from_wire(candidate["ast"]), index)


def test_provider_schema_and_host_use_same_contract_and_frozen_ids(case):
    import jsonschema
    from novelvideo.director.outline_delivery import delivery_schema

    schema = delivery_schema(case["root"], case["context"])
    jsonschema.Draft202012Validator.check_schema(schema)
    jsonschema.validate(case["draft"], schema)
    assert schema["additionalProperties"] is False
    assert schema["$defs"]["GroundedText"]["properties"]["claimIds"]["items"][
        "enum"
    ] == ["claim-1", "claim-2", "claim-3"]
    assert schema["$defs"]["EpisodeHighlight"]["properties"]["episodeId"]["enum"] == [
        "ep-1"
    ]
    case["draft"]["overview"]["logline"]["eventIds"] = ["unknown-event"]
    with pytest.raises(jsonschema.ValidationError):
        jsonschema.validate(case["draft"], schema)


@pytest.mark.parametrize("field", ["claims", "events", "authorizedChanges"])
def test_duplicate_host_ids_cannot_choose_an_arbitrary_fact(case, field):
    if field == "authorizedChanges":
        case["context"][field] = [
            {"id": "decision-1", "text": "Only change the season."}
        ]
    case["context"][field].append(copy.deepcopy(case["context"][field][0]))
    with pytest.raises(ValueError, match="OUTLINE_DUPLICATE_HOST_ID"):
        validate_outline(case["draft"], case["root"])


def test_frontend_golden_is_the_actual_host_projection_not_a_handwritten_mock():
    from novelvideo.director.outline_delivery import render_delivery

    case = json.loads(FIXTURE.read_text())
    golden = json.loads(FIXTURE.with_name("projections.json").read_text())
    assert golden["fixtureHash"] == object_hash(case)
    for row in golden["projections"]:
        root = copy.deepcopy(case["root"])
        root["preset"]["output_language"] = row["language"]
        assert row["markdown"] == render_delivery(case["draft"], root, case["context"])
    case["draft"]["overview"]["synopsis"][0]["text"] = (
        "<img src=x onerror=alert(1)> [click](javascript:alert(1))\n## Fake heading\n😀"
    )
    assert golden["safetyMarkdown"] == render_delivery(
        case["draft"], case["root"], case["context"]
    )


@pytest.mark.parametrize(
    "field,value,code",
    [
        ("output_language", "unknown-language", "OUTLINE_LANGUAGE_UNSUPPORTED"),
        ("structure", "invented-structure", "PLANNING_SPEC_MISMATCH"),
        ("ending_type", "invented-ending", "PLANNING_SPEC_MISMATCH"),
    ],
)
def test_host_settings_fail_before_projection(case, field, value, code):
    case["root"]["preset"][field] = value
    with pytest.raises(ValueError, match=code):
        validate_outline(case["draft"], case["root"])


def test_explicit_no_hooks_is_valid_without_inventing_a_cliffhanger(case):
    case["draft"]["hooks"].update(
        openings=[], setups=[], inapplicableReason="A quiet resolved story."
    )
    assert "A quiet resolved story" in render_outline(case["draft"], case["root"])
    case["draft"]["hooks"]["inapplicableReason"] = None
    with pytest.raises(ValueError, match="OUTLINE_HOOK_DISPOSITION_REQUIRED"):
        validate_outline(case["draft"], case["root"])


def test_scope_empty_is_not_scope_unrestricted(case):
    case["context"]["openingEventIds"] = []
    with pytest.raises(ValueError, match="OUTLINE_OPENING_OUTSIDE_SCOPE"):
        validate_outline(case["draft"], case["root"])
    case["context"]["openingEventIds"] = None
    validate_outline(case["draft"], case["root"])


def test_candidate_does_not_share_mutable_craft_notes_with_raw_response(case):
    from novelvideo.director.outline_delivery import build_outline_candidate

    candidate = build_outline_candidate(case["draft"], case["root"], case["context"])
    candidate["craftNotes"]["causalChain"].clear()
    assert len(case["draft"]["craftNotes"]["causalChain"]) == 3
