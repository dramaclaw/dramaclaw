from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any

import pytest
from pydantic import ValidationError

from novelvideo.director.checkpoints import decide_question
from novelvideo.director.duration import evaluate_duration
from novelvideo.director.recovery import recovery_action
from novelvideo.director.references import compile_reference_manifest
from novelvideo.director.schemas.common import DirectorContractError
from novelvideo.director.schemas.foundation import (
    ChangeSelection,
    ConfirmedSpec,
    DurationInput,
    EpisodeIdentity,
    ProviderAttempt,
    QuestionCheckpoint,
    QuestionDecision,
    ReferenceInput,
    SkillInvocation,
    SkillRunReceipt,
    SourceAuditInput,
)
from novelvideo.director.semantic_validator import (
    prepare_change_selection,
    validate_episode_binding,
    validate_source_audit,
    verify_skill_receipt,
)

FIXTURE_ROOT = Path(__file__).resolve().parents[1] / "fixtures" / "director" / "cases"
CASE_IDS = ("F01", "F03", "F05", "F11", "F17", "F19", "F23", "F27", "F28")


def read_case(case_id: str) -> dict[str, Any]:
    return json.loads(
        (FIXTURE_ROOT / f"{case_id.lower()}.json").read_text(encoding="utf-8")
    )


CASES = [
    pytest.param(variant, id=f"{case_id}/{variant['id']}")
    for case_id in CASE_IDS
    for variant in read_case(case_id)["variants"]
]


def execute(operation: str, payload: dict[str, Any]) -> Any:
    if operation == "confirm_spec":
        return ConfirmedSpec.from_wire(payload).model_dump(by_alias=True)
    if operation == "episode_binding":
        original = EpisodeIdentity.from_wire(payload["original"])
        candidate = EpisodeIdentity.from_wire(payload["candidate"])
        validate_episode_binding(original, candidate)
        return candidate.model_dump(by_alias=True)
    if operation == "source_audit":
        return validate_source_audit(SourceAuditInput.from_wire(payload)).model_dump(
            by_alias=True
        )
    if operation == "change_selection":
        return list(prepare_change_selection(ChangeSelection.from_wire(payload)))
    if operation == "duration":
        return evaluate_duration(DurationInput.from_wire(payload)).model_dump(
            by_alias=True
        )
    if operation == "recovery":
        return recovery_action(ProviderAttempt.from_wire(payload))
    if operation == "references":
        result = compile_reference_manifest(ReferenceInput.from_wire(payload))
        return {
            "refIds": [slot.ref_id for slot in result.entries],
            "mentionIndices": [slot.mention_index for slot in result.entries],
            "namespaces": [slot.namespace for slot in result.entries],
            "manifestHash": result.manifest_hash,
        }
    if operation == "skill_receipt":
        verify_skill_receipt(
            SkillInvocation.from_wire(payload["invocation"]),
            SkillRunReceipt.from_wire(payload["receipt"]),
        )
        return {"verified": True}
    if operation == "question":
        return decide_question(
            QuestionCheckpoint.from_wire(payload["checkpoint"]),
            QuestionDecision.from_wire(payload["decision"]),
        ).model_dump(by_alias=True)
    raise AssertionError(f"Unregistered fixture operation: {operation}")


@pytest.mark.parametrize("case", CASES)
def test_executable_foundation_fixture(case: dict[str, Any]) -> None:
    original = copy.deepcopy(case["input"])
    expected_error = case.get("expectedError")
    if expected_error == "SCHEMA_INVALID":
        with pytest.raises(ValidationError) as failure:
            execute(case["operation"], case["input"])
        if "errorPath" in case:
            assert any(
                case["errorPath"] in err["loc"] for err in failure.value.errors()
            )
    elif expected_error:
        with pytest.raises(DirectorContractError) as failure:
            execute(case["operation"], case["input"])
        assert failure.value.code == expected_error
    else:
        result = execute(case["operation"], case["input"])
        expected = case["expected"]
        if isinstance(expected, dict):
            for key, value in expected.items():
                assert result[key] == value, key
        else:
            assert result == expected
    assert case["input"] == original, "A preflight must not mutate its evidence/input"


@pytest.mark.parametrize("case_id", CASE_IDS)
def test_fixture_has_anonymous_versioned_positive_and_negative_evidence(
    case_id: str,
) -> None:
    fixture = read_case(case_id)
    assert fixture["schemaVersion"] == 1
    assert fixture["caseId"] == case_id
    assert fixture["source"] == "synthetic"
    assert any("expectedError" in variant for variant in fixture["variants"])
    assert any("expected" in variant for variant in fixture["variants"])
    assert len({variant["id"] for variant in fixture["variants"]}) == len(
        fixture["variants"]
    )


@pytest.mark.parametrize(
    "model",
    [
        ConfirmedSpec,
        EpisodeIdentity,
        SourceAuditInput,
        ChangeSelection,
        DurationInput,
        ReferenceInput,
        SkillInvocation,
        SkillRunReceipt,
        QuestionCheckpoint,
        QuestionDecision,
        ProviderAttempt,
    ],
)
def test_contract_schemas_disallow_unknown_properties(model: Any) -> None:
    schema = model.model_json_schema(by_alias=True)
    assert schema["additionalProperties"] is False
    for definition in schema.get("$defs", {}).values():
        if definition.get("type") == "object" and "properties" in definition:
            assert definition["additionalProperties"] is False


def test_wire_spelling_is_canonical_without_breaking_internal_constructors() -> None:
    value = copy.deepcopy(read_case("F01")["variants"][0]["input"])
    value["total_episodes"] = value.pop("totalEpisodes")
    with pytest.raises(ValidationError):
        ConfirmedSpec.from_wire(value)
    model = ConfirmedSpec.model_validate(value)
    assert model.model_dump(by_alias=True)["totalEpisodes"] == 1


def test_confirmed_spec_round_trip_preserves_every_parameter() -> None:
    value = read_case("F01")["variants"][0]["input"]
    model = ConfirmedSpec.from_wire(value)
    assert model.model_dump(by_alias=True) == value
    assert (
        ConfirmedSpec.model_validate_json(model.model_dump_json(by_alias=True)) == model
    )


def test_spec_cannot_omit_or_contradict_parameter_provenance() -> None:
    value = copy.deepcopy(read_case("F01")["variants"][0]["input"])
    del value["provenance"]["totalEpisodes"]
    with pytest.raises(ValidationError, match="SPEC_PROVENANCE_INCOMPLETE"):
        ConfirmedSpec.from_wire(value)

    value["provenance"]["totalEpisodes"] = "user"
    value["narrativeTone"]["provenance"] = "template"
    with pytest.raises(ValidationError, match="SPEC_PROVENANCE_MISMATCH"):
        ConfirmedSpec.from_wire(value)


def test_reference_manifest_changes_for_reorder_delete_replace_not_resolution_order() -> (
    None
):
    value = copy.deepcopy(read_case("F23")["variants"][0]["input"])
    first = compile_reference_manifest(ReferenceInput.from_wire(value))
    value["resolved"].reverse()
    assert compile_reference_manifest(ReferenceInput.from_wire(value)) == first

    value["orderedRefIds"][1], value["orderedRefIds"][3] = (
        value["orderedRefIds"][3],
        value["orderedRefIds"][1],
    )
    reordered = compile_reference_manifest(ReferenceInput.from_wire(value))
    assert reordered.manifest_hash != first.manifest_hash
    assert reordered.entries[1].ref_id == "ref-3"
    assert reordered.entries[1].kind == "audio"
    assert reordered.entries[1].mention_index == 1
    assert reordered.entries[0].mention_index == 1

    value["orderedRefIds"].remove("ref-3")
    value["resolved"] = [r for r in value["resolved"] if r["refId"] != "ref-3"]
    deleted = compile_reference_manifest(ReferenceInput.from_wire(value))
    assert [slot.mention_index for slot in deleted.entries[1:]] == list(range(1, 9))
    assert deleted.manifest_hash != reordered.manifest_hash

    value["resolved"][0]["version"] = 2
    value["resolved"][0]["contentHash"] = "b" * 64
    assert (
        compile_reference_manifest(ReferenceInput.from_wire(value)).manifest_hash
        != deleted.manifest_hash
    )


def test_dependency_selection_requires_explicit_closure_not_silent_autoaccept() -> None:
    value = copy.deepcopy(read_case("F11")["variants"][0]["input"])
    value["groups"] = [
        {
            "id": "a",
            "hunkIds": ["a1"],
            "targetDocumentIds": ["characters"],
            "requiresGroupIds": [],
        },
        {
            "id": "b",
            "hunkIds": ["b1"],
            "targetDocumentIds": ["episode"],
            "requiresGroupIds": ["a"],
        },
    ]
    value["acceptedHunkIds"] = ["b1"]
    with pytest.raises(DirectorContractError, match="DEPENDENCY_GROUP_INCOMPLETE"):
        prepare_change_selection(ChangeSelection.from_wire(value))
    value["acceptedHunkIds"] = ["b1", "a1"]
    assert prepare_change_selection(ChangeSelection.from_wire(value)) == ("a1", "b1")
    value["groups"][0]["requiresGroupIds"] = ["b"]
    with pytest.raises(DirectorContractError, match="DEPENDENCY_CYCLE"):
        prepare_change_selection(ChangeSelection.from_wire(value))


def test_independent_edit_can_be_partially_accepted() -> None:
    value = copy.deepcopy(read_case("F11")["variants"][0]["input"])
    value["groups"] = [
        {
            "id": "a",
            "hunkIds": ["a1"],
            "targetDocumentIds": ["characters"],
            "requiresGroupIds": [],
        },
        {
            "id": "b",
            "hunkIds": ["b1"],
            "targetDocumentIds": ["episode"],
            "requiresGroupIds": [],
        },
    ]
    value["acceptedHunkIds"] = ["b1"]
    assert prepare_change_selection(ChangeSelection.from_wire(value)) == ("b1",)


def test_actual_chunk_character_coverage_not_successful_request_fraction() -> None:
    value = copy.deepcopy(read_case("F05")["variants"][0]["input"])
    value["chunks"][0]["status"] = "failed"
    result = validate_source_audit(SourceAuditInput.from_wire(value))
    assert result.read_coverage == pytest.approx(
        (len(value["normalizedText"]) - value["chunks"][0]["end"])
        / len(value["normalizedText"])
    )
    assert result.read_coverage != pytest.approx(2 / 3)
    assert not result.ready_for_planning


@pytest.mark.parametrize(
    "mutation,code",
    [
        ("gap", "SOURCE_OWNERSHIP_GAP_OR_OVERLAP"),
        ("overlap", "SOURCE_OWNERSHIP_GAP_OR_OVERLAP"),
    ],
)
def test_source_ownership_must_cover_exactly_once(mutation: str, code: str) -> None:
    value = copy.deepcopy(read_case("F05")["variants"][0]["input"])
    value["chunks"][1]["start"] += 1 if mutation == "gap" else -1
    with pytest.raises(DirectorContractError, match=code):
        validate_source_audit(SourceAuditInput.from_wire(value))


def test_an_unfinished_audit_cannot_claim_ready() -> None:
    value = copy.deepcopy(read_case("F05")["variants"][0]["input"])
    value["auditCompleted"] = False
    result = validate_source_audit(SourceAuditInput.from_wire(value))
    assert result.read_coverage == 1
    assert not result.audit_complete
    assert not result.ready_for_planning


def test_duration_risk_and_measured_are_not_production_ready() -> None:
    value = copy.deepcopy(read_case("F17")["variants"][0]["input"])
    value["targetSeconds"] = 9
    value["beats"][0]["estimate"]["maximum"] = 10
    result = evaluate_duration(DurationInput.from_wire(value))
    assert result.status == "CAPACITY_RISK"
    value["beats"][0]["estimate"]["maximum"] = 8
    for beat in value["beats"]:
        beat["timingStatus"] = "measured"
        beat["measurement"] = {
            "documentVersion": value["documentVersion"],
            "semanticHash": value["semanticHash"],
            "artifactRef": "synthetic-measurement",
            "method": "timeline_preview",
        }
    result = evaluate_duration(DurationInput.from_wire(value))
    assert result.status == "MEASURED"
    assert not result.production_ready


def test_measured_flag_requires_version_bound_evidence() -> None:
    value = copy.deepcopy(read_case("F17")["variants"][0]["input"])
    value["beats"][0]["timingStatus"] = "measured"
    with pytest.raises(ValidationError, match="MEASUREMENT_EVIDENCE_REQUIRED"):
        DurationInput.from_wire(value)
    value["beats"][0]["measurement"] = {
        "documentVersion": 2,
        "semanticHash": value["semanticHash"],
        "artifactRef": "synthetic-measurement",
        "method": "speech_readthrough",
    }
    with pytest.raises(DirectorContractError, match="STALE_TIMING_EVIDENCE"):
        evaluate_duration(DurationInput.from_wire(value))


@pytest.mark.parametrize("estimate", [0, -1, float("inf"), float("nan"), True, "8"])
def test_invalid_or_coerced_duration_cannot_cross_schema(estimate: Any) -> None:
    value = copy.deepcopy(read_case("F17")["variants"][0]["input"])
    value["beats"][0]["estimate"]["minimum"] = estimate
    with pytest.raises(ValidationError):
        DurationInput.from_wire(value)


@pytest.mark.parametrize(
    "field", ["checkpointId", "questionVersion", "toolCallId", "expectedRevision"]
)
def test_every_checkpoint_identity_field_is_checked(field: str) -> None:
    value = copy.deepcopy(read_case("F28")["variants"][0]["input"])
    old = value["decision"][field]
    value["decision"][field] = old + 1 if isinstance(old, int) else "other"
    with pytest.raises(DirectorContractError, match="STALE_CHECKPOINT"):
        execute("question", value)


def test_free_text_remains_an_explicit_answer_not_first_option() -> None:
    value = copy.deepcopy(read_case("F28")["variants"][0]["input"])
    value["decision"]["answers"][0] = {
        "questionId": "direction",
        "optionIds": [],
        "freeText": "Choose an independent direction.",
    }
    assert execute("question", value)["status"] == "answered"
    assert value["decision"]["answers"][0]["optionIds"] == []


@pytest.mark.parametrize("status", ["succeeded", "failed", "cancelled"])
def test_terminal_attempt_never_automatically_creates_new_task(status: str) -> None:
    value = copy.deepcopy(read_case("F19")["variants"][0]["input"])
    value.update(status=status, providerTaskId="provider-one")
    assert recovery_action(ProviderAttempt.from_wire(value)) == "none"
