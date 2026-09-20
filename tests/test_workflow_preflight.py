from copy import deepcopy

import pytest

from novelvideo.freezone.agent_workflows.graph import build_workflow_graph_commands
from novelvideo.freezone.workflow_preflight import evaluate_workflow_preflight


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


def test_ready_video_catalog_id_remains_valid_in_canvas_command():
    plan = {
        "schema_version": "freezone_workflow_plan.v1",
        "workflow_type": "dynamic.video",
        "nodes": [
            {
                "id": "video",
                "node_type": "videoNode",
                "stage": "video",
                "data": {
                    "model": "seedance-2.0",
                    "durationSec": 5,
                    "quality": "720P",
                },
            }
        ],
        "edges": [],
    }
    catalog_entry = {
        "id": "seedance-2.0",
        "apiModel": "newapi_seedance-2.0",
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
    assert command["data"]["model"] != catalog_entry["apiModel"]


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
