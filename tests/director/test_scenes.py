"""Scene structure cannot substitute for grounded spatial decisions."""

import copy
import json

import pytest

from novelvideo.director.dispatch import dispatch_writing
from novelvideo.director.models import CreateWork, DirectorPreset, GenerateDraft
from novelvideo.director.planning import planning_documents, validate_planning
from novelvideo.director.scenes import (
    LABELS,
    parse_scenes,
    render_scenes,
    validate_scenes,
)
from novelvideo.director.schemas.planning import Scene, SceneDocument
from novelvideo.director.skills.runtime import load_package
from novelvideo.director.writing import compile_generation
from tests.director.test_execution import command
from tests.director.test_execution import runtime as runtime


def sample():
    package = load_package("M08")
    bible = json.loads(package["files"][package["manifest"].fixtures])[0]["value"]
    value = {key: bible[key] for key in ("sceneVersion", "locations")}
    root = {
        "preset": DirectorPreset(mode="original", episode_count=1).model_dump(),
        "episodes": [{"id": "ep-1", "orderKey": 1, "deliveryLabel": "EP02"}],
    }
    return value, root


@pytest.mark.parametrize("field", list(Scene.model_fields))
def test_scene_elements_cannot_be_omitted(field):
    value, root = sample()
    del value["locations"][0][Scene.model_fields[field].alias]
    with pytest.raises(ValueError):
        validate_scenes(value, root)


@pytest.mark.parametrize(
    "change",
    [
        lambda v: v.update(sceneVersion=2),
        lambda v: v.update(characters=[]),
        lambda v: v.update(locations=[]),
        lambda v: v["locations"].append(copy.deepcopy(v["locations"][0])),
        lambda v: v["locations"][0].update(keyEpisodeIds=[]),
        lambda v: v["locations"][0].update(keyEpisodeIds=["EP02"]),
        lambda v: v["locations"][0].update(keyEpisodeIds=["ep-1", "ep-1"]),
        lambda v: v["locations"][0].update(type="room"),
        lambda v: v["locations"][0].update(spatialConstraints="  "),
    ],
)
def test_scene_contract_rejects_cross_document_or_incomplete_results(change):
    value, root = sample()
    change(value)
    with pytest.raises(ValueError):
        validate_scenes(value, root)


def test_host_episode_order_not_source_number_and_no_duplicate_json_keys():
    value, root = sample()
    root["preset"]["episode_count"] = 2
    root["episodes"].append({"id": "ep-2", "orderKey": 2, "deliveryLabel": "EP03"})
    value["locations"][0]["keyEpisodeIds"] = ["ep-2", "ep-1"]
    with pytest.raises(ValueError, match="ORDER_INVALID"):
        validate_scenes(value, root)
    value["locations"][0]["keyEpisodeIds"] = ["ep-1", "ep-2"]
    assert "EP02 / EP03" in render_scenes(validate_scenes(value, root), root)
    raw = json.dumps(value)[:-1] + ',"locations":[]}'
    with pytest.raises(ValueError, match="DUPLICATE_JSON_KEY"):
        parse_scenes(raw, root)


@pytest.mark.parametrize("language,index", [("zh-CN", 0), ("en", 1), ("vi", 2)])
def test_exact_five_fields_localized_and_in_source_order(language, index):
    value, root = sample()
    root["preset"]["output_language"] = language
    text = render_scenes(value, root)
    fields = [
        "type",
        "dramaticFunction",
        "spatialConstraints",
        "reusablePositions",
        "keyEpisodeIds",
    ]
    positions = [text.index("**" + LABELS[key][index] + "**") for key in fields]
    assert positions == sorted(positions)
    assert text.startswith("# " + LABELS["list"][index])
    assert text.count("- **") == 5
    assert "EP02" in text and "location-1" not in text and "ep-1" not in text
    assert "Entrances are not established" in text


def test_legacy_projection_preserves_text_without_inventing_spatial_facts():
    value = {
        "locations": [
            {
                "id": "old",
                "name": "Old room",
                "description": "Only a table is established.",
            }
        ]
    }
    before = copy.deepcopy(value)
    text = render_scenes(value)
    assert "## Old room" in text and "Only a table is established." in text
    assert "**类型**" not in text and "old" not in text and value == before


def test_model_prose_cannot_inject_extra_headings_or_images():
    value, root = sample()
    value["locations"][0]["name"] = "Room\n## Forged <img> [link](url)"
    text = render_scenes(value, root)
    assert "\n## Forged" not in text and "<img>" not in text and "[link]" not in text


def test_preparation_and_single_share_projection_and_episode_checks():
    value, root = sample()
    package = load_package("M08")
    bible = json.loads(package["files"][package["manifest"].fixtures])[0]["value"]
    validate_planning("M08", json.dumps(bible), root, {})
    docs = planning_documents({"M07": {}, "M08": bible, "M09": {}}, root)
    assert docs["scenes"] == render_scenes(value, root)
    bible["locations"][0]["keyEpisodeIds"] = ["nonexistent"]
    with pytest.raises(ValueError, match="SCENE_EPISODE_MISSING"):
        validate_planning("M08", json.dumps(bible), root, {})


def test_scene_entry_requires_confirmed_outline_or_source(runtime):
    with pytest.raises(ValueError, match="SCENE_OUTLINE_OR_SOURCE_REQUIRED"):
        compile_generation(
            runtime[0],
            runtime[1]["id"],
            GenerateDraft(kind="scenes", expected_version=0),
        )


def test_adaptation_loads_scene_schema_skill_and_full_source(runtime):
    store = runtime[0]
    work = store.create_work(
        CreateWork(
            title="Synthetic scene source",
            brief="Preserve all places.",
            source_text="A room at night. The bridge appears only in a letter, never as a visit.",
            preset=DirectorPreset(
                mode="adaptation", adapt_direction="condense", episode_count=1
            ),
        )
    )
    compiled = compile_generation(
        store, work["id"], GenerateDraft(kind="scenes", expected_version=0)
    )
    params = compiled["parameters"]
    assert params["output_contract"] == "scene-design/1.0.0"
    from novelvideo.director.fact_guard import constrain_schema, schema as fact_schema
    expected_schema = SceneDocument.model_json_schema(by_alias=True)
    expected_schema["properties"]["sourceProofs"] = fact_schema()
    expected_schema["required"].append("sourceProofs")
    constrain_schema(expected_schema, params["factBoundary"], params["output_language"])
    assert params["responseSchema"] == expected_schema
    assert params["skill_version"] == "2.4.2"
    assert "Routed short-drama scene craft" in compiled["prompt"]
    assert "Routed short-drama character craft" not in compiled["prompt"]
    assert "never as a visit" in compiled["prompt"]
    assert set(params["responseSchema"]["properties"]) == {"sceneVersion", "locations", "sourceProofs"}


def test_episode_reads_scene_document_with_version_and_content_hash(runtime):
    store, work = runtime[:2]
    store.put_document(work["id"], "scenes", "# Scenes\n\nDoor stays closed.", 0)
    request = GenerateDraft(kind="episode", episode_ordinal=1, expected_version=0)
    before = compile_generation(store, work["id"], request)
    assert "Door stays closed." in before["prompt"]
    assert before["parameters"]["scenes_version"] == 1
    store.put_document(work["id"], "scenes", "# Scenes\n\nOnly Ada opens the door.", 1)
    after = compile_generation(store, work["id"], request)
    assert after["parameters"]["scenes_version"] == 2
    assert after["input_sha256"] != before["input_sha256"]
    assert (
        after["parameters"]["scenes_content_hash"]
        != before["parameters"]["scenes_content_hash"]
    )


@pytest.mark.parametrize("valid", [True, False])
async def test_dispatch_retains_raw_without_rebuy_and_only_proposes_scenes(
    runtime, valid
):
    store, work, _, repo, service = runtime
    store.put_document(
        work["id"], "outline", "A table by the window holds a box and note.", 0
    )
    store.put_document(work["id"], "characters", "# Keep this roster", 0)
    store.put_document(work["id"], "props", "# Keep these props", 0)

    def send(payload):
        cmd = command(work, payload, revision=store.get_work(work["id"])["revision"])
        cmd = cmd.model_copy(
            update={
                "expected": cmd.expected.model_copy(
                    update={"document_versions": {"scenes": 0}}
                )
            }
        )
        return service.execute("writer", cmd)["result"]

    quote = send({"type": "cost.quote", "kind": "scenes", "maxOutputTokens": 1024})
    op = send(
        {
            "type": "approval.grant",
            "quoteId": quote["quoteId"],
            "requestHash": quote["requestHash"],
            "unknownCostConsent": True,
        }
    )
    with store._connect() as db:
        snapshot = repo.snapshot(db, op["id"])
    value, _ = sample()
    value["locations"][0]["keyEpisodeIds"] = [
        snapshot["parameters"]["sceneRoot"]["episodes"][0]["id"]
    ]
    for scene in value["locations"]:
        scene.update(type="unknown", spatialConstraints="未确认", reusablePositions="未确认")
    value["sourceProofs"] = []
    raw = json.dumps(value) if valid else '{"bad":true}'
    calls = []

    async def model(prompt, name, tokens):
        calls.append(prompt)
        return raw

    result = await dispatch_writing(repo, work["id"], op["id"], model)
    assert result["status"] == ("succeeded" if valid else "failed")
    assert (
        len(calls) == 1 and repo.retained_result(work["id"], op["id"])["output"] == raw
    )
    assert store.get_document(work["id"], "scenes")["version"] == 0
    changes = store.list_changes(work["id"])
    assert len(changes) == int(valid)
    if valid:
        assert (
            changes[0]["doc_key"] == "scenes" and "# 场景清单" in changes[0]["content"]
        )
    assert (
        store.get_document(work["id"], "characters")["content"] == "# Keep this roster"
    )
    assert store.get_document(work["id"], "props")["content"] == "# Keep these props"


@pytest.mark.parametrize(
    "kind,expected",
    [
        ("preparation", {"characters", "scenes", "props"}),
        ("characters", {"characters"}),
        ("scenes", {"scenes"}),
        ("props", {"props"}),
    ],
)
def test_m08_routes_only_applicable_craft_and_records_skipped_sources(kind, expected):
    from novelvideo.director.schemas.planning import CharacterMethodContext
    from novelvideo.director.skills.runtime import compile_method

    bundle = compile_method(
        CharacterMethodContext(
            schema_version=2,
            stage="M08",
            mode="original",
            episode_ordinal=1,
            total_episodes=1,
            ending_type="closed",
            parameters_hash="0" * 64,
            document_kind=kind,
        )
    )
    for key, title in [
        ("characters", "Routed short-drama character craft"),
        ("scenes", "Routed short-drama scene craft"),
        ("props", "Routed short-drama prop craft"),
    ]:
        assert (title in bundle["text"]) == (key in expected)
    assert len(bundle["binding"]["disabledReferences"]) == 3 - len(expected)


async def test_changed_scene_blocks_an_already_approved_episode_before_spending(
    runtime,
):
    store, work, _, repo, service = runtime
    store.put_document(work["id"], "scenes", "# Scene list\n\nDoor closed.", 0)

    def send(payload):
        cmd = command(work, payload, revision=store.get_work(work["id"])["revision"])
        cmd = cmd.model_copy(
            update={
                "expected": cmd.expected.model_copy(
                    update={"document_versions": {"episode-001": 0}}
                )
            }
        )
        return service.execute("writer", cmd)["result"]

    quote = send(
        {
            "type": "cost.quote",
            "kind": "episode",
            "episodeOrdinal": 1,
            "maxOutputTokens": 1024,
        }
    )
    op = send(
        {
            "type": "approval.grant",
            "quoteId": quote["quoteId"],
            "requestHash": quote["requestHash"],
            "unknownCostConsent": True,
        }
    )
    store.put_document(
        work["id"], "scenes", "# Scene list\n\nOnly Ada opens the door.", 1
    )

    async def not_called(*_):
        pytest.fail("Changed scene context must not reach the provider")

    result = await dispatch_writing(repo, work["id"], op["id"], not_called)
    assert result["errorCode"] == "INPUT_CHANGED_BEFORE_SEND"
    assert result["cost"]["actualMinor"] == 0
