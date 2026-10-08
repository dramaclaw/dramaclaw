"""Object continuity must survive projection and dispatch, not just a prompt."""

import copy
import json

import pytest

from novelvideo.director.dispatch import dispatch_writing
from novelvideo.director.models import CreateWork, DirectorPreset, GenerateDraft
from novelvideo.director.planning import planning_documents, validate_planning
from novelvideo.director.props import LABELS, parse_props, render_props, validate_props
from novelvideo.director.schemas.planning import Prop, PropDocument
from novelvideo.director.skills.runtime import load_package
from novelvideo.director.writing import compile_generation
from tests.director.test_execution import command
from tests.director.test_execution import runtime as runtime


def sample():
    package = load_package("M08")
    bible = json.loads(package["files"][package["manifest"].fixtures])[0]["value"]
    value = {key: bible[key] for key in ("propVersion", "props", "emptyReason")}
    root = {
        "preset": DirectorPreset(mode="original", episode_count=1).model_dump(),
        "episodes": [{"id": "ep-1", "orderKey": 1, "deliveryLabel": "EP02"}],
    }
    return value, root


@pytest.mark.parametrize("field", list(Prop.model_fields))
def test_no_prop_element_may_be_omitted(field):
    value, root = sample()
    del value["props"][0][Prop.model_fields[field].alias]
    with pytest.raises(ValueError):
        validate_props(value, root)


@pytest.mark.parametrize(
    "change",
    [
        lambda v: v.update(propVersion=2),
        lambda v: v.update(characters=[]),
        lambda v: v.update(props=[]),
        lambda v: v.update(emptyReason="Unexpected with nonempty list"),
        lambda v: v["props"].append(copy.deepcopy(v["props"][0])),
        lambda v: v["props"][0].update(keyEpisodeIds=[]),
        lambda v: v["props"][0].update(keyEpisodeIds=["EP02"]),
        lambda v: v["props"][0].update(keyEpisodeIds=["ep-1", "ep-1"]),
        lambda v: v["props"][0].update(firstEpisodeId="source-2"),
        lambda v: v["props"][0].update(usageBoundary="  "),
        lambda v: v["props"][0].update(type=3),
    ],
)
def test_contract_rejects_invalid_identity_episode_and_cross_document_content(change):
    value, root = sample()
    change(value)
    with pytest.raises(ValueError):
        validate_props(value, root)


def test_first_appearance_can_precede_but_not_follow_key_episode():
    value, root = sample()
    root["preset"]["episode_count"] = 2
    root["episodes"].append({"id": "ep-2", "deliveryLabel": "EP03"})
    prop = value["props"][0]
    prop["keyEpisodeIds"] = ["ep-2", "ep-1"]
    with pytest.raises(ValueError, match="ORDER_INVALID"):
        validate_props(value, root)
    prop.update(firstEpisodeId="ep-2", keyEpisodeIds=["ep-1"])
    with pytest.raises(ValueError, match="KEY_BEFORE_FIRST"):
        validate_props(value, root)
    prop.update(firstEpisodeId="ep-1", keyEpisodeIds=["ep-2"])
    text = render_props(validate_props(value, root), root)
    assert "**首次出场**：EP02" in text and "**关键集次**：EP03" in text
    with pytest.raises(ValueError, match="DUPLICATE_JSON_KEY"):
        parse_props(json.dumps(value)[:-1] + ',"props":[]}', root)


def test_empty_props_have_reason_not_invented_objects_and_legacy_is_read_only():
    _, root = sample()
    value = {"propVersion": 1, "props": [], "emptyReason": "No story-relevant objects."}
    assert (
        render_props(validate_props(value, root), root)
        == "# 道具清单\n\nNo story-relevant objects.\n"
    )
    legacy = {
        "props": [{"id": "legacy-id", "name": "Box", "description": "Old description."}]
    }
    before = copy.deepcopy(legacy)
    text = render_props(legacy)
    assert "Old description." in text and "**使用边界**" not in text
    assert "legacy-id" not in text and legacy == before
    assert render_props({"props": []}) == "# 道具清单\n"


@pytest.mark.parametrize("language,index", [("zh-CN", 0), ("en", 1), ("vi", 2)])
def test_exact_five_fields_order_and_no_technical_ids(language, index):
    value, root = sample()
    root["preset"]["output_language"] = language
    text = render_props(value, root)
    fields = [
        "type",
        "dramaticFunction",
        "usageBoundary",
        "firstEpisodeId",
        "keyEpisodeIds",
    ]
    positions = [text.index("**" + LABELS[key][index] + "**") for key in fields]
    assert positions == sorted(positions) and text.count("- **") == 5
    assert text.startswith("# " + LABELS["list"][index])
    assert "EP02" in text and "ep-1" not in text and "prop-1" not in text


def test_distinct_same_named_objects_not_merged_and_markup_not_executable():
    value, root = sample()
    value["props"].append(
        {
            **value["props"][0],
            "id": "prop-2",
            "usageBoundary": "Held by a different person; not the original.",
        }
    )
    valid = validate_props(value, root)
    assert len(valid["props"]) == 2
    assert render_props(valid, root).count("## Box") == 2
    value["props"][0]["name"] = "Box\n## Forged <img> [link](url)"
    text = render_props(value, root)
    assert "\n## Forged" not in text and "<img>" not in text and "[link]" not in text


def test_preparation_and_single_document_share_projection_and_validation():
    value, root = sample()
    package = load_package("M08")
    bible = json.loads(package["files"][package["manifest"].fixtures])[0]["value"]
    validate_planning("M08", json.dumps(bible), root, {})
    docs = planning_documents({"M07": {}, "M08": bible, "M09": {}}, root)
    assert docs["props"] == render_props(value, root)
    bible["props"][0]["firstEpisodeId"] = "missing"
    with pytest.raises(ValueError, match="PROP_EPISODE_MISSING"):
        validate_planning("M08", json.dumps(bible), root, {})


def test_props_need_outline_or_source(runtime):
    with pytest.raises(ValueError, match="PROP_OUTLINE_OR_SOURCE_REQUIRED"):
        compile_generation(
            runtime[0],
            runtime[1]["id"],
            GenerateDraft(kind="props", expected_version=0),
        )


def test_prop_generation_loads_actual_schema_craft_source_and_saved_context(runtime):
    store = runtime[0]
    work = store.create_work(
        CreateWork(
            title="Synthetic prop source",
            brief="Preserve the shown actions.",
            source_text="The TV shows an unsigned letter. Ada holds a different letter.",
            preset=DirectorPreset(
                mode="adaptation", adapt_direction="condense", episode_count=1
            ),
        )
    )
    store.put_document(work["id"], "characters", "Ada never signs the letter.", 0)
    store.put_document(work["id"], "scenes", "The TV remains in the room.", 0)
    result = compile_generation(
        store, work["id"], GenerateDraft(kind="props", expected_version=0)
    )
    params = result["parameters"]
    assert params["output_contract"] == "prop-design/1.0.0"
    assert params["responseSchema"] == PropDocument.model_json_schema(by_alias=True)
    assert params["response_format"] == {"type": "json_object"}
    assert params["skill_version"] == "2.4.2"
    assert "Routed short-drama prop craft" in result["prompt"]
    assert "Routed short-drama character craft" not in result["prompt"]
    assert "Routed short-drama scene craft" not in result["prompt"]
    for fact in ("unsigned letter", "Ada never signs", "TV remains"):
        assert fact in result["prompt"]
    assert params["characters_version"] == params["scenes_version"] == 1
    assert set(params["responseSchema"]["properties"]) == {
        "propVersion",
        "props",
        "emptyReason",
    }


def test_episode_consumes_saved_props_with_version_and_hash(runtime):
    store, work = runtime[:2]
    store.put_document(work["id"], "props", "The box remains locked.", 0)
    cmd = GenerateDraft(kind="episode", episode_ordinal=1, expected_version=0)
    before = compile_generation(store, work["id"], cmd)
    assert "box remains locked" in before["prompt"]
    assert before["parameters"]["props_version"] == 1
    store.put_document(work["id"], "props", "Ada opens the box with the key.", 1)
    after = compile_generation(store, work["id"], cmd)
    assert after["parameters"]["props_version"] == 2
    assert after["input_sha256"] != before["input_sha256"]
    assert (
        after["parameters"]["props_content_hash"]
        != before["parameters"]["props_content_hash"]
    )


def send_for(runtime, payload, kind="props"):
    store, work, _, _, service = runtime
    cmd = command(work, payload, revision=store.get_work(work["id"])["revision"])
    cmd = cmd.model_copy(
        update={
            "expected": cmd.expected.model_copy(update={"document_versions": {kind: 0}})
        }
    )
    return service.execute("writer", cmd)["result"]


@pytest.mark.parametrize("valid", [True, False])
async def test_dispatch_retains_paid_response_no_rebuy_and_no_other_doc_overwrite(
    runtime, valid
):
    store, work, _, repo, _ = runtime
    store.put_document(work["id"], "outline", "Box on table, key handed to Ada.", 0)
    store.put_document(work["id"], "characters", "# Keep roster", 0)
    store.put_document(work["id"], "scenes", "# Keep scenes", 0)
    quote = send_for(
        runtime, {"type": "cost.quote", "kind": "props", "maxOutputTokens": 1024}
    )
    op = send_for(
        runtime,
        {
            "type": "approval.grant",
            "quoteId": quote["quoteId"],
            "requestHash": quote["requestHash"],
            "unknownCostConsent": True,
        },
    )
    with store._connect() as db:
        snapshot = repo.snapshot(db, op["id"])
    value, _ = sample()
    episode = snapshot["parameters"]["propRoot"]["episodes"][0]["id"]
    value["props"][0].update(firstEpisodeId=episode, keyEpisodeIds=[episode])
    raw = json.dumps(value) if valid else '{"bad":true}'
    calls = []

    async def model(*args):
        calls.append(args)
        return raw

    result = await dispatch_writing(repo, work["id"], op["id"], model)
    assert result["status"] == ("succeeded" if valid else "failed")
    assert (
        len(calls) == 1 and repo.retained_result(work["id"], op["id"])["output"] == raw
    )
    assert store.get_document(work["id"], "props")["version"] == 0
    changes = store.list_changes(work["id"])
    assert len(changes) == int(valid)
    if valid:
        assert (
            changes[0]["doc_key"] == "props" and "# 道具清单" in changes[0]["content"]
        )
    assert store.get_document(work["id"], "characters")["content"] == "# Keep roster"
    assert store.get_document(work["id"], "scenes")["content"] == "# Keep scenes"


async def test_prop_edit_invalidates_already_approved_episode_before_spending(runtime):
    store, work, _, repo, _ = runtime
    store.put_document(work["id"], "props", "Key held by Ada.", 0)
    quote = send_for(
        runtime,
        {
            "type": "cost.quote",
            "kind": "episode",
            "episodeOrdinal": 1,
            "maxOutputTokens": 1024,
        },
        "episode-001",
    )
    op = send_for(
        runtime,
        {
            "type": "approval.grant",
            "quoteId": quote["quoteId"],
            "requestHash": quote["requestHash"],
            "unknownCostConsent": True,
        },
        "episode-001",
    )
    store.put_document(work["id"], "props", "Key left on the table by Ada.", 1)

    async def not_called(*_):
        pytest.fail("Changed prop context must not reach provider")

    result = await dispatch_writing(repo, work["id"], op["id"], not_called)
    assert result["errorCode"] == "INPUT_CHANGED_BEFORE_SEND"
    assert result["cost"]["actualMinor"] == 0
