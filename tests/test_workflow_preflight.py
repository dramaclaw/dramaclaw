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
