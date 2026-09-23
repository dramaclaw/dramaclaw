from copy import deepcopy

import pytest

from novelvideo.freezone.agent_workflows.graph import build_workflow_graph_commands
from novelvideo.freezone.workflow_preflight import (
    evaluate_workflow_preflight,
    generation_clarification_request,
    preflight_failure_blocker,
)


def _check(data, entry=None):
    return evaluate_workflow_preflight(
        {"plan": {"nodes": [{"id": "video", "node_type": "videoNode", "data": data}]}},
        model_responses={
            "videoNode": {
                "ok": True,
                "data": [
                    entry
                    or {
                        "id": "video-model",
                        "ratioOptions": ["16:9"],
                        "resolutionOptions": ["720P"],
                        "minDuration": 2,
                        "maxDuration": 10,
                        "supportsGenerateAudio": False,
                    }
                ],
            }
        },
        limits={"ok": True, "data": {"video": {"limit": 2, "remaining": 1}}},
    )


def test_recommended_model_materializes_one_scoped_catalog_configuration():
    plan = {"nodes": [{
        "id": "image", "node_type": "imageGenNode",
        "data": {"model": "recommended", "aspectRatio": "9:16"},
    }]}
    catalog = [
        {"id": "first-but-not-default", "ratioOptions": ["9:16"],
         "resolutionOptions": ["1K"], "qualityOptions": ["medium"]},
        {"id": "LingShan-G2", "aliases": ["newapi_gpt_image2"],
         "ratioOptions": ["9:16"], "resolutionOptions": ["2K", "1K"],
         "qualityOptions": ["high", "medium"]},
    ]
    result = evaluate_workflow_preflight(
        {"plan": plan},
        model_responses={"imageGenNode": {"ok": True, "data": catalog}},
        limits={"ok": True, "data": {"default": {"limit": 2, "remaining": 1}}},
    )
    assert result["status"] == "ready"
    assert plan["nodes"][0]["data"] == {
        "model": "LingShan-G2", "aspectRatio": "9:16", "size": "1K",
        "quality": "medium", "count": 1,
    }


def test_recommended_model_rejects_incompatible_explicit_ratio():
    plan = {"nodes": [{
        "id": "image", "node_type": "imageGenNode",
        "data": {"model": "recommended", "aspectRatio": "21:9"},
    }]}
    result = evaluate_workflow_preflight(
        {"plan": plan},
        model_responses={"imageGenNode": {"ok": True, "data": [{
            "id": "LingShan-G2", "aliases": ["newapi_gpt_image2"],
            "ratioOptions": ["9:16"], "resolutionOptions": ["1K"],
        }]}},
        limits={"ok": True, "data": {"default": {"limit": 2, "remaining": 1}}},
    )
    assert result["status"] == "blocked"
    assert any(blocker["code"] == "model_capability_unsupported" for blocker in result["blockers"])


def test_recommended_model_keeps_explicit_catalog_supported_tenant_options():
    plan = {"nodes": [{
        "id": "image", "node_type": "imageGenNode",
        "data": {
            "model": "recommended", "aspectRatio": "21:9",
            "size": "3K", "quality": "ultra",
        },
    }]}
    result = evaluate_workflow_preflight(
        {"plan": plan},
        model_responses={"imageGenNode": {"ok": True, "data": [{
            "id": "LingShan-G2", "aliases": ["newapi_gpt_image2"],
            "ratioOptions": ["21:9"], "resolutionOptions": ["3K"],
            "qualityOptions": ["ultra"],
        }]}},
        limits={"ok": True, "data": {"default": {"limit": 2, "remaining": 1}}},
    )
    assert result["status"] == "ready"
    assert plan["nodes"][0]["data"] == {
        "model": "LingShan-G2", "aspectRatio": "21:9",
        "size": "3K", "quality": "ultra", "count": 1,
    }


def test_recommended_model_does_not_fall_back_to_first_visible_model():
    plan = {"nodes": [{
        "id": "image", "node_type": "imageGenNode", "data": {"model": "recommended"},
    }]}
    result = evaluate_workflow_preflight(
        {"plan": plan},
        model_responses={"imageGenNode": {"ok": True, "data": [{
            "id": "some-other-model", "ratioOptions": ["9:16"],
            "resolutionOptions": ["1K"],
        }]}},
        limits={"ok": True, "data": {"default": {"limit": 2, "remaining": 1}}},
    )
    assert result["status"] == "blocked"
    assert result["blockers"][0]["code"] == "recommended_model_unavailable"
    assert plan["nodes"][0]["data"]["model"] == "recommended"


def test_recommended_video_uses_video_capabilities_and_concrete_resolution():
    plan = {"nodes": [{
        "id": "video", "node_type": "videoNode",
        "data": {"model": "recommended", "quality": "recommended"},
    }]}
    result = evaluate_workflow_preflight(
        {"plan": plan},
        model_responses={"videoNode": {"ok": True, "data": [{
            "id": "seedance-2.0-fast", "aliases": ["newapi_seedance-2.0-fast"],
            "ratioOptions": ["16:9", "9:16"], "resolutionOptions": ["480P", "720P"],
            "minDuration": 4, "maxDuration": 15,
            "supportsGenerateAudio": False,
        }]}},
        limits={"ok": True, "data": {"video": {"limit": 2, "remaining": 1}}},
    )
    assert result["status"] == "ready"
    assert plan["nodes"][0]["data"] == {
        "model": "seedance-2.0-fast", "aspectRatio": "9:16",
        "quality": "720P", "durationSec": 5, "count": 1,
    }


@pytest.mark.parametrize("ratio_options", [None, []])
def test_recommended_video_without_catalog_ratio_options_still_resolves(ratio_options):
    """Issue #674: a catalog entry that declares no ratioOptions is unconstrained,
    exactly as runtime preflight already treats aspectRatio, so the remaining
    recommendations resolve and the ratio falls back to the product default."""
    entry = {
        "id": "seedance-2.0-fast", "aliases": ["newapi_seedance-2.0-fast"],
        "resolutionOptions": ["480P", "720P"],
        "minDuration": 4, "maxDuration": 15, "supportsGenerateAudio": False,
    }
    if ratio_options is not None:
        entry["ratioOptions"] = ratio_options
    plan = {"nodes": [{
        "id": "video", "node_type": "videoNode",
        "data": {"model": "recommended", "aspectRatio": "recommended", "quality": "recommended"},
    }]}
    result = evaluate_workflow_preflight(
        {"plan": plan},
        model_responses={"videoNode": {"ok": True, "data": [entry]}},
        limits={"ok": True, "data": {"video": {"limit": 2, "remaining": 1}}},
    )
    assert result["status"] == "ready", result["blockers"]
    assert plan["nodes"][0]["data"] == {
        "model": "seedance-2.0-fast", "aspectRatio": "9:16",
        "quality": "720P", "durationSec": 5, "count": 1,
    }


def test_recommended_image_without_catalog_ratio_options_still_resolves():
    plan = {"nodes": [{
        "id": "image", "node_type": "imageGenNode",
        "data": {"model": "recommended"},
    }]}
    result = evaluate_workflow_preflight(
        {"plan": plan},
        model_responses={"imageGenNode": {"ok": True, "data": [{
            "id": "LingShan-G2", "aliases": ["newapi_gpt_image2"],
            "resolutionOptions": ["1K"], "qualityOptions": ["medium"],
        }]}},
        limits={"ok": True, "data": {"default": {"limit": 2, "remaining": 1}}},
    )
    assert result["status"] == "ready", result["blockers"]
    assert plan["nodes"][0]["data"] == {
        "model": "LingShan-G2", "aspectRatio": "9:16", "size": "1K",
        "quality": "medium", "count": 1,
    }


def test_recommended_ratio_still_requires_a_declared_catalog_option_when_constrained():
    """A declared ratio list without a preferred value keeps blocking recommendations."""
    plan = {"nodes": [{
        "id": "video", "node_type": "videoNode",
        "data": {"model": "recommended", "quality": "recommended"},
    }]}
    result = evaluate_workflow_preflight(
        {"plan": plan},
        model_responses={"videoNode": {"ok": True, "data": [{
            "id": "seedance-2.0-fast", "aliases": ["newapi_seedance-2.0-fast"],
            "ratioOptions": ["21:9", "4:3"], "resolutionOptions": ["720P"],
            "minDuration": 4, "maxDuration": 15, "supportsGenerateAudio": False,
        }]}},
        limits={"ok": True, "data": {"video": {"limit": 2, "remaining": 1}}},
    )
    assert result["status"] == "blocked"
    assert any(
        blocker["code"] == "recommended_parameters_unavailable" for blocker in result["blockers"]
    )


def test_video_mode_must_match_live_model_capabilities():
    entry = {
        "id": "newapi_seedance-2.0",
        "supportedModes": [
            "text_to_video", "all_reference", "first_last_frame", "image_reference",
        ],
    }
    blocked = _check({"model": entry["id"], "genMode": "imageToVideo", "durationSec": 5}, entry)
    assert blocked["status"] == "blocked"
    assert blocked["blockers"][0]["path"] == "runtime.models.video.genMode"
    assert blocked["blockers"][0]["code"] == "model_capability_unsupported"
    assert "imageReference" in blocked["blockers"][0]["allowed_values"]
    assert _check(
        {"model": entry["id"], "genMode": "imageReference", "durationSec": 5}, entry
    )["status"] == "ready"


def test_video_node_without_planned_duration_asks_for_clarification():
    """Issue #677: an agent-authored video node that pins a model but no
    durationSec would run as a 0-second shot; preflight blocks and names the
    portable choice the agent must collect."""
    result = _check({"model": "video-model", "quality": "720P"})
    assert result["status"] == "blocked"
    blocker = next(b for b in result["blockers"] if b["path"].endswith(".durationSec"))
    assert blocker["code"] == "generation_parameters_required"
    assert blocker["required_choices"] == {"video": ["duration_seconds"]}
    # Still fine once the duration is stated.
    assert _check({"model": "video-model", "quality": "720P", "durationSec": 5})["status"] == "ready"


def test_missing_duration_is_reported_without_a_live_catalog():
    """Duration existence does not depend on model capabilities: a voiced or
    plain video node with a model but no durationSec blocks even when the
    runtime catalog cannot be checked."""
    plan = {"nodes": [{
        "id": "shot", "node_type": "videoNode",
        "data": {"model": "video-model", "workflowCatalog": {"recipeId": "dialogue-continuity-shot-video"}},
    }]}
    result = evaluate_workflow_preflight(
        {"plan": plan}, model_responses={}, limits={"ok": False}, runtime_available=False
    )
    assert result["status"] == "blocked"
    codes = [(b["code"], b["path"]) for b in result["blockers"]]
    assert ("generation_parameters_required", "runtime.models.shot.durationSec") in codes
    # The audio question needs the catalog and is not asked blind.
    assert not any(path.endswith(".generateAudio") for _code, path in codes)


_AUDIO_CAPABLE_ENTRY = {
    "id": "video-model",
    "ratioOptions": ["16:9"],
    "resolutionOptions": ["720P"],
    "minDuration": 2,
    "maxDuration": 10,
    "supportsGenerateAudio": True,
}


def _voiced(data, *, recipe="dialogue-continuity-shot-video", role=None):
    catalog = {"recipeId": recipe}
    if role:
        catalog["timelineRole"] = role
    return {"model": "video-model", "durationSec": 5, "workflowCatalog": catalog, **data}


def test_voiced_shot_must_state_generate_audio_explicitly():
    """Issue #677: a dialogue/voice-over shot with generateAudio left unset would
    render silent under the runtime default, so preflight asks for the choice."""
    result = _check(_voiced({}), _AUDIO_CAPABLE_ENTRY)
    assert result["status"] == "blocked"
    blocker = next(b for b in result["blockers"] if b["path"].endswith(".generateAudio"))
    assert blocker["code"] == "generation_parameters_required"
    assert blocker["required_choices"] == {"video": ["generate_audio"]}
    # An explicit answer either way is accepted.
    assert _check(_voiced({"generateAudio": True}), _AUDIO_CAPABLE_ENTRY)["status"] == "ready"
    assert _check(_voiced({"generateAudio": False}), _AUDIO_CAPABLE_ENTRY)["status"] == "ready"


@pytest.mark.parametrize(
    "data",
    [
        _voiced({}, recipe="drama-shot-voice"),
        _voiced({}, recipe="general-video", role="voiceover"),
        {
            "model": "video-model", "durationSec": 5,
            "workflowCatalog": {"recipeId": "general-video",
                                "recipePipeline": [{"id": "dialogue-drama-storyboard-plan"}]},
        },
    ],
)
def test_voiced_signal_comes_from_recipe_ids_or_timeline_role(data):
    result = _check(data, _AUDIO_CAPABLE_ENTRY)
    assert any(b["path"].endswith(".generateAudio") for b in result["blockers"])


def test_generate_audio_is_not_required_for_plain_shots_or_silent_models():
    # A shot that carries no dialogue signal keeps today's behaviour.
    assert _check(_voiced({}, recipe="general-video"), _AUDIO_CAPABLE_ENTRY)["status"] == "ready"
    # A model that cannot generate audio has nothing to ask.
    silent_entry = {**_AUDIO_CAPABLE_ENTRY, "supportsGenerateAudio": False}
    assert _check(_voiced({}), silent_entry)["status"] == "ready"


@pytest.mark.parametrize(
    "field,value",
    [
        ("aspectRatio", "7:3"),
        ("quality", "4K"),
        ("durationSec", 11),
        ("durationSec", True),
        ("durationSec", "5"),
        ("durationSec", float("nan")),
        ("generateAudio", True),
        ("generateAudio", "false"),
        ("count", True),
        ("count", 3),
    ],
)
def test_live_parameter_validation_rejects_invalid_values(field, value):
    result = _check({"model": "video-model", field: value})
    assert result["status"] == "blocked"
    assert any(item["path"].endswith("." + field) for item in result["blockers"])


def test_parameter_types_checked_even_before_model_selection():
    result = _check({"durationSec": False})
    assert result["blockers"][0]["code"] == "generation_parameter_invalid"


def test_valid_parameters_remain_unchanged():
    data = {
        "model": "video-model",
        "durationSec": 5,
        "quality": "720p",
        "count": 2,
        "generateAudio": False,
    }
    before = deepcopy(data)
    assert _check(data)["status"] == "ready"
    assert data == before


def test_canvas_catalog_id_is_valid_when_live_entry_has_separate_backend_api_model():
    result = _check(
        {"model": "seedance-2.0", "durationSec": 5},
        {
            "id": "seedance-2.0",
            "apiModel": "newapi_seedance-2.0",
            "minDuration": 2,
            "maxDuration": 10,
        },
    )

    assert result["status"] == "ready"
    assert result["runtime_checks"]["videoNode.models"] == {
        "requested": ["seedance-2.0"],
        "available": True,
    }


@pytest.mark.parametrize("model_id", ["seedance-2.0", "newapi_seedance-2.0"])
def test_ready_video_catalog_id_remains_valid_in_canvas_command(model_id):
    plan = {
        "schema_version": "freezone_workflow_plan.v1",
        "workflow_type": "dynamic.video",
        "nodes": [
            {
                "id": "video",
                "node_type": "videoNode",
                "stage": "video",
                "data": {
                    "model": model_id,
                    "genMode": "imageReference",
                    "durationSec": 5,
                    "quality": "720P",
                },
            }
        ],
        "edges": [],
    }
    catalog_entry = {
        "id": model_id,
        "apiModel": "newapi_seedance-2.0",
        "supportedModes": ["text_to_video", "image_reference"],
        "resolutionOptions": ["720P"],
        "minDuration": 4,
        "maxDuration": 15,
    }

    preflight = evaluate_workflow_preflight(
        {"plan": plan},
        model_responses={"videoNode": {"ok": True, "data": [catalog_entry]}},
        limits={"ok": True, "data": {"video": {"limit": 2, "remaining": 1}}},
    )
    assert preflight["status"] == "ready"

    graph = build_workflow_graph_commands({"plan": plan, "run_after_create": True})
    command = next(item for item in graph["commands"] if item["type"] == "create_node")
    assert command["data"]["model"] == catalog_entry["id"]


def test_live_catalog_failure_is_not_a_successful_preflight():
    result = evaluate_workflow_preflight(
        {
            "plan": {
                "nodes": [
                    {
                        "id": "video",
                        "node_type": "videoNode",
                        "data": {"model": "missing"},
                    }
                ]
            }
        },
        model_responses={"videoNode": {"ok": False}},
        limits={"ok": False},
    )
    assert result["blockers"][0]["code"] == "model_catalog_unavailable"



def _image_check(data, *, fill_missing):
    from novelvideo.freezone.workflow_preflight import resolve_generation_recommendations

    node = {"id": "image", "node_type": "imageGenNode", "data": data}
    blockers = resolve_generation_recommendations(
        [node],
        {"imageGenNode": {"ok": True, "data": [
            {
                "id": "LingShan-G2", "aliases": ["newapi_gpt_image2"],
                "ratioOptions": ["9:16"], "resolutionOptions": ["2K", "1K"],
                "qualityOptions": ["medium"],
            },
            {
                "id": "Other-Wide", "ratioOptions": ["21:9", "16:9"],
                "resolutionOptions": ["4K"], "qualityOptions": [],
            },
        ]}},
        fill_missing=fill_missing,
    )
    return blockers, node["data"]


def test_concrete_model_with_missing_fields_is_not_defaulted_by_preflight():
    blockers, data = _image_check({"model": "Other-Wide"}, fill_missing=False)
    assert blockers == []
    assert data == {"model": "Other-Wide"}


def test_fill_missing_completes_concrete_model_from_its_own_catalog_entry():
    blockers, data = _image_check({"model": "Other-Wide", "size": "4K"}, fill_missing=True)
    assert blockers == []
    assert data == {"model": "Other-Wide", "aspectRatio": "16:9", "size": "4K", "count": 1}


def test_fill_missing_still_blocks_unknown_concrete_model():
    blockers, data = _image_check({"model": "Missing-Model"}, fill_missing=True)
    assert blockers == []  # unknown concrete ids are reported by the capability check
    assert data == {"model": "Missing-Model"}


def test_fill_missing_resolves_a_catalog_alias_to_its_entry():
    """A node keeps a legal alias (the sketch default) and still gets its fields."""
    blockers, data = _image_check({"model": "newapi_gpt_image2"}, fill_missing=True)
    assert blockers == []
    assert data == {
        "model": "newapi_gpt_image2", "aspectRatio": "9:16", "size": "1K",
        "quality": "medium", "count": 1,
    }


def test_recommended_fields_on_an_alias_model_resolve_without_fill_missing():
    blockers, data = _image_check(
        {"model": "newapi_gpt_image2", "aspectRatio": "recommended"}, fill_missing=False,
    )
    assert blockers == []
    assert data["aspectRatio"] == "9:16"
    assert data["model"] == "newapi_gpt_image2"


_ALIAS_IMAGE_CATALOG = {"imageGenNode": {"ok": True, "data": [{
    "id": "LingShan-G2", "aliases": ["newapi_gpt_image2"],
    "ratioOptions": ["9:16"], "resolutionOptions": ["1K"], "qualityOptions": ["medium"],
}]}}


def _image_preflight(data):
    node = {"id": "image", "node_type": "imageGenNode", "data": data}
    result = evaluate_workflow_preflight(
        {"plan": {"nodes": [node]}},
        model_responses=_ALIAS_IMAGE_CATALOG,
        limits={"ok": True, "data": {"default": {"limit": 4, "remaining": 4}}},
    )
    return result, node["data"]


def test_full_preflight_accepts_a_legal_catalog_alias_for_recommended_fields():
    """An alias model (the sketch default) must not be reported as unavailable."""
    result, data = _image_preflight({
        "model": "newapi_gpt_image2", "aspectRatio": "recommended",
        "size": "1K", "quality": "medium", "count": 1,
    })
    assert result["status"] == "ready", result["blockers"]
    assert result["runtime_checks"]["imageGenNode.models"] == {
        "requested": ["newapi_gpt_image2"], "available": True,
    }
    assert data["aspectRatio"] == "9:16"
    assert data["model"] == "newapi_gpt_image2"


def test_full_preflight_checks_alias_model_capabilities_against_its_entry():
    result, _data = _image_preflight({
        "model": "newapi_gpt_image2", "aspectRatio": "21:9",
        "size": "1K", "quality": "medium", "count": 1,
    })
    assert result["status"] == "blocked"
    assert all(blocker["code"] != "model_unavailable" for blocker in result["blockers"])
    assert any("21:9" in str(blocker) for blocker in result["blockers"])


def test_full_preflight_still_rejects_an_unknown_model():
    result, _data = _image_preflight({
        "model": "not-in-catalog", "aspectRatio": "9:16",
        "size": "1K", "quality": "medium", "count": 1,
    })
    assert result["status"] == "blocked"
    assert result["blockers"][0]["code"] == "model_unavailable"
    assert [item["id"] for item in result["blockers"][0]["available_models"]] == ["LingShan-G2"]


def test_generation_clarification_request_merges_blockers_per_node():
    preflight = {"blockers": [
        {"path": "runtime.models.shot-1.durationSec", "code": "generation_parameters_required",
         "message": "m", "required_choices": {"video": ["duration_seconds"]}},
        {"path": "runtime.models.shot-1.generateAudio", "code": "generation_parameters_required",
         "message": "m", "required_choices": {"video": ["generate_audio"]}},
        {"path": "runtime.models.shot-2.durationSec", "code": "generation_parameters_required",
         "message": "m", "required_choices": {"video": ["duration_seconds"]}},
    ]}
    request = generation_clarification_request(preflight)
    assert request is not None
    assert request["status"] == "clarification_required"
    assert request["code"] == "generation_parameters_required"
    assert request["media_types"] == ["video"]
    assert request["required_choices"] == {"video": ["duration_seconds", "generate_audio"]}
    assert request["missing_parameters"] == [
        {"node_id": "shot-1", "node_type": "videoNode", "fields": ["durationSec", "generateAudio"]},
        {"node_id": "shot-2", "node_type": "videoNode", "fields": ["durationSec"]},
    ]
    assert generation_clarification_request({"blockers": []}) is None
    assert generation_clarification_request({"blockers": [
        {"path": "runtime.models", "code": "model_catalog_unavailable", "message": "x"},
    ]}) is None


def test_generation_clarification_request_declines_mixed_blockers():
    """A clarification is retryable; beside a blocker no answer can fix it would
    make the agent ask the user and only then fail. Mixed preflights stay a
    plain failure that names the non-answerable blocker first."""
    questions = [
        {"path": "runtime.models.shot-1.generateAudio", "code": "generation_parameters_required",
         "message": "audio", "required_choices": {"video": ["generate_audio"]}},
        {"path": "runtime.models.shot-1.durationSec", "code": "generation_parameters_required",
         "message": "duration", "required_choices": {"video": ["duration_seconds"]}},
    ]
    for hard in (
        {"path": "runtime.queue_capacity.video", "code": "queue_disabled",
         "message": "video generation queue is disabled"},
        {"path": "runtime.models.shot-1.model", "code": "model_unavailable", "message": "gone"},
        {"path": "runtime.models", "code": "model_catalog_unavailable", "message": "no catalog"},
    ):
        preflight = {"blockers": [questions[0], hard, questions[1]]}
        assert generation_clarification_request(preflight) is None
        assert preflight_failure_blocker(preflight) is hard
    assert preflight_failure_blocker({"blockers": questions}) is questions[0]
    assert preflight_failure_blocker({"blockers": []}) == {}


def test_generation_clarification_request_keeps_dotted_node_ids():
    request = generation_clarification_request({"blockers": [
        {"path": "runtime.models.scene.1.shot.2.durationSec",
         "code": "generation_parameters_required", "message": "m",
         "required_choices": {"video": ["duration_seconds"]}},
    ]})
    assert request is not None
    assert request["missing_parameters"] == [
        {"node_id": "scene.1.shot.2", "node_type": "videoNode", "fields": ["durationSec"]},
    ]
