"""Biographies need grounded identities as well as a localized readable roster."""

import copy
import json

import pytest

from novelvideo.director.characters import (
    LABELS,
    parse_characters,
    render_characters,
    validate_characters,
)
from novelvideo.director.dispatch import dispatch_writing
from novelvideo.director.models import CreateWork, DirectorPreset, GenerateDraft
from novelvideo.director.schemas.planning import Character, CharacterDocument
from novelvideo.director.skills.runtime import load_package
from novelvideo.director.writing import compile_generation
from tests.director.test_execution import command
from tests.director.test_execution import runtime as runtime


def sample():
    package = load_package("M08")
    bible = json.loads(package["files"][package["manifest"].fixtures])[0]["value"]
    value = {key: bible[key] for key in ("characterVersion", "characters", "relations")}
    root = {
        "preset": DirectorPreset(mode="original", episode_count=1).model_dump(),
        "episodes": [{"id": "ep-1", "orderKey": 1, "deliveryLabel": "EP02"}],
    }
    return value, root


@pytest.mark.parametrize("field", list(Character.model_fields))
def test_every_character_element_is_required_even_when_explicitly_unknown(field):
    value, root = sample()
    del value["characters"][0][Character.model_fields[field].alias]
    with pytest.raises(ValueError):
        validate_characters(value, root)


@pytest.mark.parametrize(
    "mutate",
    [
        lambda v: v["characters"][0].update(role="hero"),
        lambda v: v["characters"][0].update(tags=[]),
        lambda v: v["characters"][0].update(firstEpisodeId="EP02"),
        lambda v: v["characters"][0].update(keyEpisodeIds=["ep-1", "ep-1"]),
        lambda v: v["characters"][0].update(setting="  "),
        lambda v: v["characters"].append(copy.deepcopy(v["characters"][0])),
        lambda v: v["relations"].append(
            {"fromId": "char-1", "toId": "missing", "description": "friend"}
        ),
        lambda v: v.update(locations=[]),
    ],
)
def test_invalid_or_cross_contract_result_is_rejected(mutate):
    value, root = sample()
    mutate(value)
    with pytest.raises(ValueError):
        validate_characters(value, root)


def test_episode_order_and_first_appearance_are_host_bound():
    value, root = sample()
    root["preset"]["episode_count"] = 2
    root["episodes"].append({"id": "ep-2", "orderKey": 2, "deliveryLabel": "EP03"})
    character = value["characters"][0]
    character.update(firstEpisodeId="ep-2", keyEpisodeIds=["ep-2"])
    assert "EP03" in render_characters(validate_characters(value, root), root)
    character["keyEpisodeIds"] = ["ep-1", "ep-2"]
    with pytest.raises(ValueError, match="ORDER_INVALID"):
        validate_characters(value, root)
    character.update(firstEpisodeId="ep-1", keyEpisodeIds=["ep-2", "ep-1"])
    with pytest.raises(ValueError, match="ORDER_INVALID"):
        validate_characters(value, root)


@pytest.mark.parametrize("language,locale", [("zh-CN", 0), ("en", 1), ("vi", 2)])
def test_visible_field_order_labels_unknowns_and_no_internal_keys(language, locale):
    value, root = sample()
    root["preset"]["output_language"] = language
    text = render_characters(value, root)
    keys = [
        "role",
        "setting",
        "dramaticFunction",
        "tags",
        "voice",
        "memorableDetail",
        "arc",
        "pressureResponse",
        "firstEpisodeId",
        "keyEpisodeIds",
    ]
    positions = [text.index("**" + LABELS[key][locale] + "**") for key in keys]
    assert positions == sorted(positions)
    assert "ep-1" not in text and "char-1" not in text and "firstEpisodeId" not in text
    assert "EP02" in text and "## Lin" in text
    assert LABELS["speechFlaw"][locale] not in text
    assert text.startswith("# " + LABELS["list"][locale])


def test_supporting_roster_stays_compact_without_erasing_machine_knowledge():
    value, root = sample()
    character = value["characters"][0]
    character["role"] = "supporting"
    text = render_characters(value, root)
    assert "**类型**：次要" in text and "**首次出场**" in text
    assert "**语言风格**" not in text and character["knowledge"]
    assert len([line for line in text.splitlines() if line.startswith("- ")]) == 6


def test_render_does_not_let_model_prose_inject_markup():
    value, root = sample()
    value["characters"][0]["names"] = ["Same\n## forged <img> [link](url)"]
    text = render_characters(value, root)
    assert "\n## forged" not in text and "<img>" not in text and "[link]" not in text


def test_legacy_read_is_lossless_in_meaning_and_does_not_fabricate_new_fields():
    value, root = sample()
    del value["characterVersion"]
    old = copy.deepcopy(value)
    text = render_characters(value, root)
    assert "**外形**" in text and "**类型**" not in text
    assert value == old


def test_duplicate_json_is_retained_as_invalid_not_last_value_wins():
    value, root = sample()
    raw = json.dumps(value)[:-1] + ',"relations":[]}'
    with pytest.raises(ValueError, match="DUPLICATE_JSON_KEY"):
        parse_characters(raw, root)


def test_episode_compilation_reads_saved_characters_and_binds_their_version(runtime):
    store, work = runtime[:2]
    store.put_document(work["id"], "outline", "# Confirmed outline", 0)
    store.put_document(work["id"], "characters", "# Roster\n\nLin does not speak.", 0)
    request = GenerateDraft(kind="episode", episode_ordinal=1, expected_version=0)
    before = compile_generation(store, work["id"], request)
    assert "Lin does not speak." in before["prompt"]
    assert before["parameters"]["characters_version"] == 1
    store.put_document(work["id"], "characters", "# Roster\n\nLin speaks softly.", 1)
    after = compile_generation(store, work["id"], request)
    assert after["input_sha256"] != before["input_sha256"]
    assert after["parameters"]["characters_version"] == 2


def test_single_document_adaptation_loads_same_skill_with_only_character_schema(
    runtime,
):
    store = runtime[0]
    work = store.create_work(
        CreateWork(
            title="Synthetic adaptation",
            brief="Preserve the source.",
            source_text="A nurse named Lin remains silent. Age is unknown. Only EP02 is supplied.",
            preset=DirectorPreset(
                mode="adaptation", adapt_direction="condense", episode_count=1
            ),
        )
    )
    compiled = compile_generation(
        store, work["id"], GenerateDraft(kind="characters", expected_version=0)
    )
    params = compiled["parameters"]
    assert (
        params["skill_key"] == "studio/character-bible"
        and params["skill_version"] == "2.4.2"
    )
    from novelvideo.director.fact_guard import constrain_schema, schema as fact_schema
    expected_schema = CharacterDocument.model_json_schema(by_alias=True)
    expected_schema["properties"]["sourceProofs"] = fact_schema()
    expected_schema["required"].append("sourceProofs")
    constrain_schema(expected_schema, params["factBoundary"], params["output_language"])
    assert params["responseSchema"] == expected_schema
    assert params["response_format"] == {"type": "json_object"}
    assert "Only EP02 is supplied" in compiled["prompt"]
    assert "Routed short-drama character craft" in compiled["prompt"]


@pytest.mark.parametrize("valid", [True, False, "unsupported-fact"])
async def test_real_execution_path_retains_response_and_only_proposes_characters(
    runtime, valid
):
    store, work, _, repo, service = runtime
    store.put_document(work["id"], "outline", "Lin opens the box with a key.", 0)

    def send(payload):
        cmd = command(work, payload, revision=store.get_work(work["id"])["revision"])
        cmd = cmd.model_copy(
            update={
                "expected": cmd.expected.model_copy(
                    update={"document_versions": {"characters": 0}}
                )
            }
        )
        return service.execute("writer", cmd)["result"]

    quote = send(
        {
            "type": "cost.quote",
            "kind": "characters",
            "instruction": "Preserve Lin.",
            "maxOutputTokens": 1024,
        }
    )
    operation = send(
        {
            "type": "approval.grant",
            "quoteId": quote["quoteId"],
            "requestHash": quote["requestHash"],
            "unknownCostConsent": True,
        }
    )
    with store._connect() as db:
        snapshot = repo.snapshot(db, operation["id"])
    value, _ = sample()
    ep = snapshot["parameters"]["characterRoot"]["episodes"][0]["id"]
    value["characters"][0].update(firstEpisodeId=ep, keyEpisodeIds=[ep])
    for character in value["characters"]:
        character.update(memorableDetail="未确认", pressureResponse="未确认", addressRules=None, voice="未确认")
    value["sourceProofs"] = []
    if valid == "unsupported-fact":
        value["characters"][0]["addressRules"] = "称主任为爷爷"
    raw = json.dumps(value) if valid else '{"bad": true}'
    accepted = valid is True
    calls = []

    async def model(prompt, name, tokens):
        calls.append((prompt, name, tokens))
        return raw

    result = await dispatch_writing(repo, work["id"], operation["id"], model)
    assert result["status"] == ("succeeded" if accepted else "failed")
    assert (
        len(calls) == 1
        and repo.retained_result(work["id"], operation["id"])["output"] == raw
    )
    assert store.get_document(work["id"], "characters")["version"] == 0
    assert store.get_document(work["id"], "outline")["version"] == 1
    changes = store.list_changes(work["id"])
    assert len(changes) == int(accepted)
    if valid == "unsupported-fact":
        retained = repo.retained_result(work["id"], operation["id"])
        assert not retained["factAudit"]["passed"]
        assert retained["factAudit"]["issues"][0]["field"] == "addressRules"
    if accepted:
        assert (
            changes[0]["doc_key"] == "characters"
            and "# 人物清单" in changes[0]["content"]
        )
