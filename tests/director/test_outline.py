"""Element parity is a data contract, not a test for a few attractive headings."""

import copy
import json

import pytest

from novelvideo.director import writing
from novelvideo.director.dispatch import dispatch_writing
from novelvideo.director.models import DirectorPreset, GenerateDraft
from novelvideo.director.outline import (
    LABELS,
    render_outline,
    validate_outline,
    parse_outline,
)
from novelvideo.director.planning import planning_documents
from novelvideo.director.schemas.planning import StoryPlan
from novelvideo.director.skills.runtime import load_package
from tests.director.test_execution import grant, outline_output
from tests.director.test_execution import runtime as runtime


def sample():
    package = load_package("M07")
    value = json.loads(package["files"][package["manifest"].fixtures])[0]["value"]
    return value, {
        "preset": DirectorPreset(
            mode="original", episode_count=1, duration_seconds=30
        ).model_dump(),
        "episodes": [{"id": "ep-1", "orderKey": 1, "deliveryLabel": "第1集"}],
        "brief": "A locked box, a birthday note and repaired glasses.",
    }


@pytest.mark.parametrize("field", list(StoryPlan.model_fields))
def test_every_outline_element_is_required_not_silently_defaulted(field):
    value, root = sample()
    alias = StoryPlan.model_fields[field].alias
    del value[alias]
    with pytest.raises(ValueError):
        validate_outline(value, root)


@pytest.mark.parametrize("seconds", [1, 5, 30, 60, 120, 300, 3600, 5400])
def test_duration_is_user_setting_not_a_thirty_second_skill_limit(seconds):
    value, root = sample()
    root["preset"] = DirectorPreset(
        mode="original", episode_count=1, duration_seconds=seconds
    ).model_dump()
    value["totalDurationSeconds"] = seconds
    text = render_outline(validate_outline(value, root), root)
    assert f"1 / {seconds}s / {seconds}s" in text


@pytest.mark.parametrize("seconds", [0, -1, 1.5, True, "30", None])
def test_duration_rejects_invalid_input_without_coercing_or_defaulting(seconds):
    with pytest.raises(ValueError):
        DirectorPreset(mode="original", duration_seconds=seconds)


@pytest.mark.parametrize("seconds", [1, 120, 5400])
def test_user_duration_survives_storage_and_actual_outline_compilation(runtime, seconds):
    from novelvideo.director.models import CreateWork

    store = runtime[0]
    work = store.create_work(
        CreateWork(
            title="User duration",
            brief="A friendship story.",
            preset=DirectorPreset(mode="original", duration_seconds=seconds),
        )
    )
    compiled = writing.compile_generation(
        store, work["id"], GenerateDraft(kind="outline", expected_version=0)
    )
    assert compiled["parameters"]["outlineRoot"]["preset"]["duration_seconds"] == seconds
    assert compiled["parameters"]["duration_seconds"] == seconds


def test_adaptation_direct_edit_uses_same_skill_and_keeps_source(runtime):
    from novelvideo.director.models import CreateWork

    store = runtime[0]
    source = "An original source with a red key, not a blue key."
    work = store.create_work(
        CreateWork(
            title="Synthetic adaptation",
            brief="Preserve all source facts.",
            source_text=source,
            preset=DirectorPreset(
                mode="adaptation", adapt_direction="condense", duration_seconds=120
            ),
        )
    )
    compiled = writing.compile_generation(
        store, work["id"], GenerateDraft(kind="outline", expected_version=0)
    )
    assert compiled["parameters"]["skill_key"] == "studio/story-plan"
    assert compiled["parameters"]["outlineRoot"]["preset"]["duration_seconds"] == 120
    assert source in compiled["prompt"]


def test_seed_outline_revision_does_not_overflow_from_duplicate_decoder_schema(runtime, monkeypatch):
    from novelvideo.director.models import CreateWork

    monkeypatch.setattr(writing, "resolve_director_model", lambda _: "ark::doubao-seed-evolving")
    store = runtime[0]
    source = "A red key opens the box; the letter inside changes the ending."
    work = store.create_work(CreateWork(
        title="Short source revision", brief="Preserve the story.", source_text=source,
        preset=DirectorPreset(mode="adaptation", adapt_direction="condense", duration_seconds=600),
    ))
    current = "# Existing outline\n" + "A red key opens the box. " * 420 + "SOURCE-END"
    store.put_document(work["id"], "outline", current, 0)
    compiled = writing.compile_generation(store, work["id"], GenerateDraft(
        kind="outline", expected_version=1, instruction="Keep the event order without new actions.",
    ), max_output_tokens=16384)
    assert "SOURCE-END" in compiled["prompt"]
    assert source in compiled["prompt"]
    assert compiled["parameters"]["response_format"]["json_schema"]["strict"] is True
    assert '"schemaHash"' in compiled["prompt"]
    assert len(compiled["prompt"]) < writing.MAX_MODEL_INPUT_CHARS


@pytest.mark.parametrize("language,locale", [("zh-CN", 0), ("en", 1), ("vi", 2)])
def test_projection_contains_all_elements_in_observed_order_without_internal_keys(
    language, locale
):
    value, root = sample()
    root["preset"]["output_language"] = language
    text = render_outline(validate_outline(value, root), root)
    sections = [
        "summary",
        "synopsis",
        "background",
        "pressure",
        "segments",
        "watch",
        "hooks",
        "setups",
        "reversals",
        "bans",
    ]
    positions = [text.index("## " + LABELS[key][locale]) for key in sections]
    assert positions == sorted(positions)
    assert all(text.count("## " + LABELS[key][locale] + "\n") == 1 for key in sections)
    for content in (
        value["synopsis"],
        value["emotionalCurve"],
        value["pressure"]["cannotRetreat"],
        value["segments"][0]["cost"],
        value["reversalsNote"],
        value["creativeBans"][0],
    ):
        assert content in text
    assert "1 / 30s / 30s" in text
    assert (
        "storyPlan" not in text
        and "episodeDirectory" not in text
        and "ep-1" not in text
    )
    assert "第1集" in text and "fs-01" in text


@pytest.mark.parametrize(
    "mutate",
    [
        lambda v: v.update(totalDurationSeconds=31),
        lambda v: v.update(structureId="five_act"),
        lambda v: v["whyWatch"].append(v["whyWatch"][0]),
        lambda v: v["hooks"][0].update(episodeId="invented"),
        lambda v: v["setups"][0].update(payoffEpisodeId="ep-2"),
        lambda v: v["setups"][0].update(payoffEpisodeId=None),
        lambda v: v["segments"][0].update(setupIds=[]),
        lambda v: v["segments"][0].update(episodeIds=["ep-1", "ep-1"]),
        lambda v: v["hooks"][0].update(id="fs-01"),
        lambda v: v.update(coreHighlights=[]),
        lambda v: v.update(synopsis="  "),
        lambda v: v.update(creativeBans=[]),
        lambda v: v.update(reversalsNote=None),
    ],
)
def test_rejects_missing_empty_duplicate_or_unbound_elements(mutate):
    value, root = sample()
    mutate(value)
    with pytest.raises(ValueError):
        validate_outline(value, root)


def test_two_episode_order_payoff_and_no_forced_long_series():
    value, root = sample()
    root["preset"].update(episode_count=2, structure="loop")
    root["episodes"].append({"id": "ep-2", "orderKey": 2, "deliveryLabel": "第2集"})
    value.update(totalDurationSeconds=60, structureId="loop")
    value["segments"][0]["episodeIds"].append("ep-2")
    value["whyWatch"].append(
        {"episodeId": "ep-2", "reason": "See the promised payoff."}
    )
    value["setups"][0]["payoffEpisodeId"] = "ep-2"
    validate_outline(value, root)
    invalid = copy.deepcopy(value)
    invalid["whyWatch"].reverse()
    with pytest.raises(ValueError, match="EPISODES_MISMATCH"):
        validate_outline(invalid, root)
    value["setups"][0].update(plantEpisodeId="ep-2", payoffEpisodeId="ep-1")
    with pytest.raises(ValueError, match="PRECEDES_PLANT"):
        validate_outline(value, root)


def test_open_setup_and_explained_absence_are_not_fabricated():
    value, root = sample()
    root["preset"]["ending_type"] = "open"
    value["setups"][0]["payoffEpisodeId"] = None
    text = render_outline(validate_outline(value, root), root)
    assert "未收束（开放结局）" in text
    value.update(
        setups=[],
        setupsNote="A direct action resolves now; no separate setup is needed.",
    )
    value["segments"][0]["setupIds"] = []
    assert value["setupsNote"] in render_outline(validate_outline(value, root), root)


def test_duplicate_json_key_never_silently_overwrites_a_valid_answer():
    value, root = sample()
    raw = json.dumps(value)[:-1] + ', "synopsis": "overwrite"}'
    with pytest.raises(ValueError, match="DUPLICATE_JSON_KEY"):
        parse_outline(raw, root)


@pytest.mark.parametrize("model_name", ["test-model", "ark::doubao-seed-evolving", "ark::deepseek-v4.1-flash"])
@pytest.mark.parametrize("strict", [False, True])
async def test_json_mode_reaches_wire_and_raw_content_is_retained(monkeypatch, model_name, strict):
    import httpx
    from openai import AsyncOpenAI
    from pydantic_ai.models.openai import OpenAIChatModel
    from pydantic_ai.providers.openai import OpenAIProvider

    requests = []
    from novelvideo.director.structured_output import response_format, decoder_schema
    schema = StoryPlan.model_json_schema(by_alias=True)
    wire_format = response_format(model_name, schema, name="director_m07") if strict else {"type": "json_object"}
    raw = '{"badField": null, "badField": true}'

    def respond(request):
        requests.append(json.loads(request.content))
        return httpx.Response(
            200,
            json={
                "id": "synthetic",
                "object": "chat.completion",
                "created": 1,
                "model": "test-model",
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": raw},
                        "finish_reason": "stop",
                    }
                ],
                "usage": {
                    "prompt_tokens": 10,
                    "completion_tokens": 5,
                    "total_tokens": 15,
                },
            },
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as http:
        client = AsyncOpenAI(
            api_key="synthetic-test-only",
            base_url="https://test.invalid/v1",
            http_client=http,
            max_retries=0,
        )
        model = OpenAIChatModel(
            "test-model", provider=OpenAIProvider(openai_client=client)
        )
        monkeypatch.setattr(
            writing, "get_newapi_text_pydantic_model", lambda *_a, **_k: model
        )
        result = await writing.run_bounded_outline_model(
            "Return JSON only.", model_name, 512, response_format=wire_format
        )
    assert len(requests) == 1
    assert requests[0]["response_format"] == wire_format
    if strict and model_name.startswith("ark::"):
        assert wire_format["json_schema"]["strict"] is True
        assert wire_format["json_schema"]["schema"] == decoder_schema(schema)
    if model_name.startswith("ark::"):
        assert "max_completion_tokens" not in requests[0]
    else:
        assert requests[0]["max_completion_tokens"] == 512
    assert requests[0]["max_tokens"] == 512
    assert result.text == raw  # No SDK repair, coercion or duplicate-key loss.
    assert result.requests == 1 and result.output_tokens == 5


@pytest.mark.parametrize("name", ["ark::doubao-seed-evolving", "ark::deepseek-v4.1-flash"])
def test_direct_outline_freezes_exact_host_schema_for_verified_routes(runtime, monkeypatch, name):
    from novelvideo.director.structured_output import decoder_schema
    monkeypatch.setattr(writing, "resolve_director_model", lambda _: name)
    store, work, _, _, _ = runtime
    params = writing.compile_generation(store, work["id"], GenerateDraft(kind="outline", expected_version=0))["parameters"]
    assert params["response_format"]["type"] == "json_schema"
    assert params["response_format"]["json_schema"]["schema"] == decoder_schema(params["responseSchema"])
    assert "carryIn" in params["responseSchema"]["$defs"]["StorySegment"]["required"]
    assert "stageGoal" in params["responseSchema"]["$defs"]["StorySegment"]["required"]
    assert params["responseSchema"]["$defs"]["WatchReason"]["additionalProperties"] is False


def test_validation_receipts_explain_fields_without_serializing_private_values():
    from novelvideo.director.output_validation import validation_receipt
    value, root = sample()
    del value["segments"][0]["carryIn"]
    del value["segments"][0]["stageGoal"]
    value["whyWatch"][0]["reasonId"] = "private-user-value-never-in-error"
    try:
        validate_outline(value, root)
    except ValueError as error:
        receipt = validation_receipt(error)
    assert receipt["issueCount"] == 3
    assert receipt["issues"] == [
        {"path": "segments.0.carryIn", "code": "missing"},
        {"path": "segments.0.stageGoal", "code": "missing"},
        {"path": "whyWatch.0.reasonId", "code": "extra_forbidden"},
    ]
    assert "private-user-value" not in json.dumps(receipt)


@pytest.mark.parametrize("text", ["", " ", "\n\t", "朱", "一段完整的故事。", "\n A complete\nparagraph. \n"])
def test_decoder_nonblank_pattern_preserves_multichar_and_multiline_semantics(text):
    import re
    from novelvideo.director.structured_output import decoder_schema
    schema = StoryPlan.model_json_schema(by_alias=True)
    before = copy.deepcopy(schema)
    adapted = decoder_schema(schema)
    host_pattern = schema["properties"]["synopsis"]["pattern"]
    wire_pattern = adapted["properties"]["synopsis"]["pattern"]
    assert bool(re.search(host_pattern, text)) == bool(re.fullmatch(wire_pattern, text))
    assert schema == before
    assert adapted["$defs"]["StoryHook"]["properties"]["id"] == schema["$defs"]["StoryHook"]["properties"]["id"]


def test_systemically_collapsed_prose_is_not_an_adoptable_outline():
    value, root = sample()
    for field in ("logline", "synopsis", "ending"):
        value[field] = "字"
    for segment in value["segments"]:
        segment.update(action="字", result="字")
    with pytest.raises(ValueError, match="OUTLINE_NARRATIVE_COLLAPSED"):
        validate_outline(value, root)


def test_old_artifact_remains_readable_and_unmodified():
    old = {"titleCandidates": ["Old"], "logline": "Existing draft"}
    artifacts = {
        "M07": old,
        "M08": {
            "characters": [],
            "relations": [],
            "worldRules": [],
            "locations": [],
            "props": [],
        },
        "M09": {"entries": []},
    }
    before = copy.deepcopy(artifacts)
    assert "Existing draft" in planning_documents(artifacts)["outline"]
    assert artifacts == before
    assert "outlineVersion" not in old


def test_reference_hashes_and_craft_reach_both_paths(runtime):
    store, work, _, _, _ = runtime
    compiled = writing.compile_generation(
        store, work["id"], GenerateDraft(kind="outline", expected_version=0)
    )
    params = compiled["parameters"]
    assert params["skill_version"] == "2.3.2"
    assert params["skill_key"] == "studio/story-plan"
    package = load_package("M07")
    for ref in package["manifest"].required_references:
        assert ref.sha256 in compiled["prompt"]
    for text in (
        "short-drama",
        "synopsis",
        "creativeBans",
        "satisfaction-matrix",
        "prior model options",
    ):
        assert text in compiled["prompt"]


async def test_direct_outline_keeps_raw_json_but_offers_identical_rendered_candidate(
    runtime,
):
    store, work, _, repo, _ = runtime
    _, run = grant(runtime)
    raw = outline_output(runtime)

    async def model(*_):
        return raw

    result = await dispatch_writing(repo, work["id"], run["id"], model)
    assert result["status"] == "succeeded"
    with store._connect() as db:
        snapshot = repo.snapshot(db, run["id"])
    expected = render_outline(json.loads(raw), snapshot["parameters"]["outlineRoot"])
    assert store.list_changes(work["id"])[0]["content"] == expected
    assert repo.retained_result(work["id"], run["id"])["output"] == raw
    assert store.get_document(work["id"], "outline")["version"] == 0


async def test_invalid_direct_outline_retained_without_proposal_or_retry(runtime):
    store, work, _, repo, _ = runtime
    _, run = grant(runtime)
    calls = []

    async def model(*_):
        calls.append(1)
        return '{"synopsis": "Incomplete"}'

    result = await dispatch_writing(repo, work["id"], run["id"], model)
    assert result["status"] == "failed"
    assert result["errorCode"] == "PLANNING_OUTPUT_INVALID"
    assert store.list_changes(work["id"]) == []
    assert repo.retained_result(work["id"], run["id"])["output"]
    await dispatch_writing(repo, work["id"], run["id"], model)
    assert calls == [1]
