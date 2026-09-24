from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from threading import Barrier

import pytest

from novelvideo.freezone.agent_workflows import catalog
from novelvideo.freezone.workflow_transactions import (
    WorkflowOperationError,
    bind_workflow_inputs,
    prepare_workflow_source,
    revise_workflow_source,
    update_workflow_steps,
)
from novelvideo.freezone.workflow_preflight import evaluate_workflow_preflight


def _plan():
    return {
        "nodes": [
            {
                "id": "brief",
                "node_type": "textAnnotationNode",
                "data": {"content": "Planning", "semanticOutputRole": "planning_text"},
            },
            {
                "id": "image",
                "node_type": "imageGenNode",
                "data": {"prompt": "Original"},
            },
        ],
        "edges": [],
    }


def _exact_media_plan():
    return {
        "schema_version": "freezone_workflow_plan.v1",
        "workflow_type": "dynamic.custom_items",
        "title": "parameter contract",
        "summary": "parameter contract",
        "skill": {"id": "text-to-image-video", "version": 2},
        "mode": "custom_items",
        "nodes": [
            {
                "id": "image",
                "node_type": "imageGenNode",
                "stage": "generation",
                "data": {
                    "prompt": "make image",
                    "workflowCatalog": {"recipeId": "general-image"},
                    "model": "LingShan-G2",
                    "aspect_ratio": "16:9",
                    "resolution": "2K",
                    "quality": "medium",
                    "variants": 1,
                },
            },
            {
                "id": "video",
                "node_type": "videoNode",
                "stage": "generation",
                "data": {
                    "prompt": "make video",
                    "workflowCatalog": {"recipeId": "general-video"},
                    "model": "seedance-2.0",
                    "aspect_ratio": "16:9",
                    "resolution": "720P",
                    "duration_seconds": 5,
                    "generate_audio": False,
                    "generation_mode": "imageToVideo",
                    "variants": 1,
                },
            },
        ],
        "edges": [
            {"source": "image", "target": "video", "link_type": "media_input_for"}
        ],
        "expected_node_count": 2,
        "expected_node_counts": {"imageGenNode": 1, "videoNode": 1},
    }


def test_prepared_exact_plan_uses_confirmation_runtime_parameter_names():
    prepared = prepare_workflow_source({"plan": _exact_media_plan()}, username="tester")

    image, video = prepared["compiled"]["plan"]["nodes"]
    assert image["data"] == {
        "prompt": "make image",
        "workflowCatalog": {"recipeId": "general-image"},
        "model": "LingShan-G2",
        "aspectRatio": "16:9",
        "size": "2K",
        "quality": "medium",
        "count": 1,
    }
    assert video["data"] == {
        "prompt": "make video",
        "workflowCatalog": {"recipeId": "general-video"},
        "model": "seedance-2.0",
        "aspectRatio": "16:9",
        "quality": "720P",
        "durationSec": 5,
        "generateAudio": False,
        "genMode": "imageToVideo",
        "count": 1,
    }
    assert prepared["intent"]["plan"] == prepared["compiled"]["plan"]


def test_prepared_exact_plan_rejects_conflicting_parameter_aliases():
    plan = _exact_media_plan()
    plan["nodes"][0]["data"]["aspectRatio"] = "1:1"

    with pytest.raises(
        WorkflowOperationError,
        match="conflicting settings aspect_ratio and aspectRatio for image",
    ):
        prepare_workflow_source({"plan": plan}, username="tester")


def test_step_revision_uses_the_same_generation_mode_mapping_as_preparation():
    revised = update_workflow_steps(
        _exact_media_plan(),
        [
            {
                "node_id": "video",
                "settings": {"generation_mode": "firstLastFrame"},
            }
        ],
    )

    video = revised["nodes"][1]
    assert video["data"]["genMode"] == "firstLastFrame"


@pytest.mark.parametrize(
    ("node_index", "field", "value", "message"),
    [
        (0, "variants", True, "variants must be 1, 2 or 4"),
        (1, "duration_seconds", 0, "duration_seconds must be positive"),
    ],
)
def test_prepared_exact_plan_rejects_invalid_semantic_parameters(
    node_index, field, value, message
):
    plan = _exact_media_plan()
    plan["nodes"][node_index]["data"][field] = value

    with pytest.raises(WorkflowOperationError, match=message):
        prepare_workflow_source({"plan": plan}, username="tester")


def test_prepared_exact_plan_normalizes_portable_generation_input_names():
    plan = _exact_media_plan()
    image_data, video_data = [node["data"] for node in plan["nodes"]]
    image_data.update(
        {
            "image_model": image_data.pop("model"),
            "image_aspect_ratio": image_data.pop("aspect_ratio"),
            "image_resolution": image_data.pop("resolution"),
            "image_quality": image_data.pop("quality"),
            "image_variants_per_node": image_data.pop("variants"),
        }
    )
    video_data.update(
        {
            "video_model": video_data.pop("model"),
            "video_aspect_ratio": video_data.pop("aspect_ratio"),
            "video_resolution": video_data.pop("resolution"),
            "video_duration_seconds": video_data.pop("duration_seconds"),
            "video_generate_audio": video_data.pop("generate_audio"),
            "video_generation_mode": video_data.pop("generation_mode"),
            "video_variants_per_node": video_data.pop("variants"),
        }
    )

    prepared = prepare_workflow_source({"plan": plan}, username="tester")

    image, video = prepared["compiled"]["plan"]["nodes"]
    assert image["data"]["model"] == "LingShan-G2"
    assert image["data"]["aspectRatio"] == "16:9"
    assert image["data"]["size"] == "2K"
    assert image["data"]["quality"] == "medium"
    assert image["data"]["count"] == 1
    assert video["data"]["model"] == "seedance-2.0"
    assert video["data"]["aspectRatio"] == "16:9"
    assert video["data"]["quality"] == "720P"
    assert video["data"]["durationSec"] == 5
    assert video["data"]["generateAudio"] is False
    assert video["data"]["genMode"] == "imageToVideo"
    assert video["data"]["count"] == 1
    assert not any("image_" in key for key in image["data"])
    assert not any("video_" in key for key in video["data"])


def test_prepared_exact_plan_applies_confirmed_shared_inputs_to_media_nodes():
    plan = _exact_media_plan()
    image_data, video_data = [node["data"] for node in plan["nodes"]]
    for key in ("model", "aspect_ratio", "resolution", "quality", "variants"):
        image_data.pop(key)
    for key in (
        "model",
        "aspect_ratio",
        "resolution",
        "duration_seconds",
        "generate_audio",
        "generation_mode",
        "variants",
    ):
        video_data.pop(key)
    plan["inputs"] = {
        "image_model": "LingShan-G2",
        "image_aspect_ratio": "16:9",
        "image_resolution": "2K",
        "image_quality": "medium",
        "image_variants_per_node": 1,
        "video_model": "seedance-2.0",
        "video_aspect_ratio": "16:9",
        "video_resolution": "720P",
        "video_duration_seconds": 5,
        "video_generate_audio": False,
        "video_generation_mode": "imageToVideo",
        "video_variants_per_node": 1,
    }

    prepared = prepare_workflow_source({"plan": plan}, username="tester")

    image, video = prepared["compiled"]["plan"]["nodes"]
    assert {
        key: image["data"].get(key)
        for key in ("model", "aspectRatio", "size", "quality", "count")
    } == {
        "model": "LingShan-G2",
        "aspectRatio": "16:9",
        "size": "2K",
        "quality": "medium",
        "count": 1,
    }
    assert {
        key: video["data"].get(key)
        for key in (
            "model",
            "aspectRatio",
            "quality",
            "durationSec",
            "generateAudio",
            "genMode",
            "count",
        )
    } == {
        "model": "seedance-2.0",
        "aspectRatio": "16:9",
        "quality": "720P",
        "durationSec": 5,
        "generateAudio": False,
        "genMode": "imageToVideo",
        "count": 1,
    }


@pytest.mark.parametrize("node_key", ["duration_seconds", "durationSec"])
def test_prepared_exact_plan_node_setting_wins_over_shared_input(node_key):
    """Issue #677: shared plan inputs only fill fields a node leaves unset, so the
    server entry point agrees with the plugin entry point and the standard
    planner: an explicit node value (either spelling) is never overridden."""
    plan = _exact_media_plan()
    video_data = plan["nodes"][1]["data"]
    video_data.pop("duration_seconds", None)
    video_data[node_key] = 3
    plan["inputs"] = {"video_duration_seconds": 10, "video_generation_mode": "firstLastFrame"}

    prepared = prepare_workflow_source({"plan": plan}, username="tester")

    video = prepared["compiled"]["plan"]["nodes"][1]
    assert video["data"]["durationSec"] == 3
    # A field the node did not state is still filled from the shared inputs
    # (the fixture states generation_mode itself, so it keeps its own value).
    assert video["data"]["genMode"] == "imageToVideo"
    assert "duration_seconds" not in video["data"]


def test_binding_preserves_planning_and_is_idempotent():
    plan = _plan()
    before = deepcopy(plan)
    binding = [
        {
            "source": "brief",
            "target": "image",
            "usage": "prompt",
            "prompt": "Actual prompt",
        }
    ]
    result = bind_workflow_inputs(plan, binding)
    assert plan == before
    assert result["nodes"][0] == before["nodes"][0]
    assert result["nodes"][2]["data"]["semanticOutputRole"] == "input_text"
    assert [edge["link_type"] for edge in result["edges"]] == [
        "context_for",
        "prompt_for",
    ]
    assert bind_workflow_inputs(result, binding) == result


@pytest.mark.parametrize(
    "patch",
    [
        {"usage": []},
        {"source": "missing"},
        {"prompt": ""},
        {"semanticOutputRole": "input_text"},
        {"usage": "context", "prompt": "not a prompt"},
    ],
)
def test_invalid_binding_rejects_without_mutating(patch):
    plan = _plan()
    before = deepcopy(plan)
    with pytest.raises(WorkflowOperationError):
        bind_workflow_inputs(
            plan, [{"source": "brief", "target": "image", "usage": "prompt", **patch}]
        )
    assert plan == before


def test_step_patch_only_changes_requested_node():
    plan = _plan()
    result = update_workflow_steps(
        plan, [{"node_id": "image", "prompt": "Changed", "settings": {"variants": 2}}]
    )
    assert result["nodes"][0] == plan["nodes"][0]
    assert result["edges"] == plan["edges"]
    assert result["nodes"][1]["data"] == {"prompt": "Changed", "count": 2}
    assert plan["nodes"][1]["data"] == {"prompt": "Original"}


def test_step_patch_marks_valid_custom_voice_available():
    plan = _plan()
    plan["nodes"].append(
        {
            "id": "speech",
            "node_type": "audioNode",
            "data": {
                "audioKind": "speech",
                "speechMode": "clone",
                "voiceAvailable": False,
            },
        }
    )

    result = update_workflow_steps(
        plan,
        [
            {
                "node_id": "speech",
                "settings": {
                    "voice_ref": {"scope": "user_custom", "voice_id": "fv_viewer"}
                },
            }
        ],
    )

    assert result["nodes"][2]["data"]["voiceRef"] == {
        "scope": "user_custom",
        "voiceId": "fv_viewer",
    }
    assert result["nodes"][2]["data"]["voiceAvailable"] is True
    assert plan["nodes"][2]["data"]["voiceAvailable"] is False


@pytest.mark.parametrize(
    "voice_ref",
    [
        {},
        {"scope": "user_custom"},
        {"scope": "unknown"},
        {"scope": "project_narrator", "path": "/tmp/untrusted.wav"},
    ],
)
def test_step_patch_rejects_invalid_voice_ref(voice_ref):
    plan = _plan()
    plan["nodes"].append(
        {"id": "speech", "node_type": "audioNode", "data": {"voiceAvailable": False}}
    )

    with pytest.raises(WorkflowOperationError, match="voice_ref"):
        update_workflow_steps(
            plan,
            [{"node_id": "speech", "settings": {"voice_ref": voice_ref}}],
        )

    assert plan["nodes"][2]["data"] == {"voiceAvailable": False}


@pytest.mark.parametrize(
    "settings",
    [{"variants": True}, {"model": []}, {"semanticOutputRole": "input_text"}],
)
def test_step_settings_cannot_change_role_or_accept_bad_types(settings):
    with pytest.raises(WorkflowOperationError):
        update_workflow_steps(_plan(), [{"node_id": "image", "settings": settings}])


def test_authenticated_catalog_isolation_and_scope_cleanup(monkeypatch):
    barrier = Barrier(2)
    monkeypatch.setattr(
        catalog,
        "list_user_agent_config_items",
        lambda user, kind: [{"id": user, "enabled": True, "version": 1}],
    )

    def read(user):
        with catalog.workflow_catalog_scope(user):
            barrier.wait(timeout=5)
            ids = [
                item["id"]
                for item in catalog._load_agent_config_items(
                    "skills", catalog._SKILLS_DIR
                )
            ]
        assert catalog._REQUEST_CATALOG.get() is None
        return ids

    with ThreadPoolExecutor(max_workers=2) as pool:
        a, b = [pool.submit(read, user) for user in ("alice", "bob")]
        assert a.result() == ["alice"]
        assert b.result() == ["bob"]


def test_exact_plan_restating_the_template_becomes_the_standard_compilation(monkeypatch):
    """Issue #678: the draft's source plan is the standard planner's output,
    so intent and compiled agree when the draft is claimed."""
    compiled = catalog.compile_workflow_intent(
        {"skill_id": "text-to-image-video", "user_goal": "赛博城市",
         "planner": {"mode": "standard", "item_count": 1}}
    )
    plan = deepcopy(compiled["plan"])
    plan.pop("planner", None)
    plan.pop("layout", None)

    prepared = prepare_workflow_source({"plan": plan}, username="tester")

    assert prepared["compiled"]["planner"]["selected_by"] == "template_isomorphic"
    assert prepared["intent"]["schema_version"] == "freezone_workflow_plan_draft.v1"
    assert prepared["intent"]["plan"] == prepared["compiled"]["plan"]
    assert prepared["intent"]["plan"]["planner"]["mode"] == "deterministic_standard"


def test_source_rejects_mixed_input_without_compiling(monkeypatch):
    monkeypatch.setattr(catalog, "list_user_agent_config_items", lambda *_: [])
    with pytest.raises(WorkflowOperationError, match="exactly one"):
        prepare_workflow_source({"intent": {}, "plan": {}}, username="alice")


def test_text_prompt_update_does_not_leave_old_recipe_prompt():
    plan = _plan()
    plan["nodes"][0]["data"]["prompt"] = "Old recipe prompt"
    result = update_workflow_steps(
        plan, [{"node_id": "brief", "prompt": "New instruction"}]
    )
    assert result["nodes"][0]["data"]["content"] == "New instruction"
    assert result["nodes"][0]["data"]["prompt"] == "New instruction"
    assert result["nodes"][0]["data"]["semanticOutputRole"] == "planning_text"


def test_compact_intent_preparation_and_revision_use_authenticated_catalog(monkeypatch):
    from novelvideo.freezone.workflow_transactions import revise_workflow_source

    calls = []

    def items(user, kind):
        calls.append((user, kind))
        if kind == "skills":
            return [
                {
                    "id": "sample",
                    "name": "Sample",
                    "version": 1,
                    "enabled": True,
                    "triggers": {"node_scopes": ["imageGeneration"]},
                    "allowed_recipe_ids": ["sample-image"],
                }
            ]
        return [
            {
                "id": "sample-image",
                "name": "Image",
                "version": 1,
                "enabled": True,
                "output_kind": "image",
                "requires_source_media": False,
            }
        ]

    monkeypatch.setattr(catalog, "list_user_agent_config_items", items)
    monkeypatch.setenv("DRAMACLAW_USERNAME", "wrong-process-user")
    intent = {
        "skill_id": "sample",
        "user_goal": "商品图",
        "include_compose": False,
        "items": [{"id": "hero", "title": "商品", "recipe_id": "sample-image"}],
    }
    prepared = prepare_workflow_source({"intent": intent}, username="alice")
    assert prepared["compiled"]["ok"]
    revised = revise_workflow_source(prepared, {"title": "新标题"}, username="alice")
    assert revised["intent"]["title"] == "新标题"
    assert all(user == "alice" for user, _ in calls)
    assert catalog._REQUEST_CATALOG.get() is None
@pytest.mark.parametrize("source", ["compact", "exact"])
def test_revise_execution_policy_preserves_workflow_source(source):
    from novelvideo.freezone.workflow_transactions import revise_workflow_source
    plan = _plan()
    payload = {"intent": {"plan": plan} if source == "exact" else {"skill_id": "video-ad"},
               "compiled": {"ok": True, "plan": plan}, "run_after_create": False}
    before = deepcopy(payload)
    result = revise_workflow_source(payload, {"run_after_create": True}, username="tester")
    assert result["run_after_create"] is True
    assert result["intent"] == before["intent"]
    assert result["compiled"] == before["compiled"]
    assert result["last_changes"] == {"run_after_create": True}
    assert payload == before


@pytest.mark.parametrize("value", ["true", 1, None])
def test_revise_execution_policy_rejects_non_boolean(value):
    from novelvideo.freezone.workflow_transactions import revise_workflow_source
    with pytest.raises(WorkflowOperationError, match="boolean"):
        revise_workflow_source({"intent": {}, "compiled": {}}, {"run_after_create": value}, username="tester")
def test_legacy_patch_execution_policy_does_not_recompile_source():
    from novelvideo.freezone.agent_workflows.drafts import build_workflow_draft_patch
    payload = {"intent": {"skill_id": "video-ad"}, "compiled": {"ok": True, "plan": _plan()}}
    result, error = build_workflow_draft_patch(
        payload=payload, changes={"run_after_create": True},
        compile_intent=lambda _: pytest.fail("policy change must not recompile topology"),
    )
    assert error is None
    assert result["run_after_create"] is True
    assert result["compiled"] == payload["compiled"]
    assert result["intent"] == payload["intent"]


def _mode_codes(compiled):
    return [
        blocker["code"]
        for blocker in (compiled.get("preflight") or {}).get("blockers") or []
        if str(blocker.get("path", "")).endswith(".genMode")
    ]


def _video_runtime_models():
    return {
        "videoNode": {
            "ok": True,
            "data": [
                {
                    "id": "seedance-2.0",
                    "ratioOptions": ["16:9"],
                    "resolutionOptions": ["720P"],
                    "minDuration": 4,
                    "maxDuration": 15,
                    "supportsGenerateAudio": True,
                    "supportedModes": [
                        "text_to_video", "first_frame", "image_to_video", "first_last_frame",
                    ],
                }
            ],
        }
    }


def test_issue_711_node_mode_without_stated_mode_is_not_ready():
    """Issue #711 r210 shape: the agent dropped video_generation_mode and pinned
    firstFrame on the node. Plan and runtime preflight must both block, even
    though the selected model supports first_frame."""
    plan = _exact_media_plan()
    plan["nodes"][1]["data"]["generation_mode"] = "firstFrame"

    prepared = prepare_workflow_source({"plan": plan}, username="tester")

    compiled = prepared["compiled"]
    assert compiled["plan"]["nodes"][1]["data"]["genMode"] == "firstFrame"
    assert _mode_codes(compiled) == ["video_generation_mode_unconfirmed"]
    runtime = evaluate_workflow_preflight(
        compiled,
        model_responses=_video_runtime_models(),
        limits={"ok": True, "data": {"video": {"limit": 2, "remaining": 2}}},
    )
    assert runtime["status"] == "blocked"
    assert "video_generation_mode_unconfirmed" in [b["code"] for b in runtime["blockers"]]


@pytest.mark.parametrize("mode", ["imageToVideo", "firstFrame"])
def test_stated_video_mode_keeps_input_and_node_consistent(mode):
    plan = _exact_media_plan()
    plan["nodes"][1]["data"].pop("generation_mode")
    plan["inputs"] = {"video_generation_mode": mode}

    prepared = prepare_workflow_source({"plan": plan}, username="tester")

    compiled = prepared["compiled"]
    assert compiled["plan"]["nodes"][1]["data"]["genMode"] == mode
    assert _mode_codes(compiled) == []
    runtime = evaluate_workflow_preflight(
        compiled,
        model_responses=_video_runtime_models(),
        limits={"ok": True, "data": {"video": {"limit": 2, "remaining": 2}}},
    )
    assert not [b for b in runtime["blockers"] if b["path"].endswith(".genMode")]


def test_revised_node_mode_is_recorded_as_that_nodes_confirmed_mode():
    """A step revision is how one shot legitimately differs from the shared
    mode; it is recorded on the node instead of tripping the #711 check."""
    plan = _exact_media_plan()
    plan["nodes"][1]["data"].pop("generation_mode")
    plan["inputs"] = {"video_generation_mode": "imageToVideo"}
    prepared = prepare_workflow_source({"plan": plan}, username="tester")

    revised = revise_workflow_source(
        prepared,
        {"step_updates": [
            {"node_id": "video", "settings": {"generation_mode": "firstLastFrame"}}
        ]},
        username="tester",
    )

    video = revised["compiled"]["plan"]["nodes"][1]["data"]
    assert video["genMode"] == "firstLastFrame"
    assert video["workflowCatalog"]["confirmedInputs"]["video_generation_mode"] == (
        "firstLastFrame"
    )
    assert _mode_codes(revised["compiled"]) == []


@pytest.mark.parametrize(
    ("shared", "code"),
    [
        ("imageToVideo", "video_generation_mode_conflict"),
        (None, "video_generation_mode_unconfirmed"),
    ],
)
def test_caller_written_node_mode_confirmation_is_not_trusted(shared, code):
    """Review of #714: a submitted plan cannot confirm its own swapped mode by
    filling workflowCatalog.confirmedInputs; only a stored-draft revision can."""
    plan = _exact_media_plan()
    video = plan["nodes"][1]["data"]
    video["generation_mode"] = "firstFrame"
    video["workflowCatalog"]["confirmedInputs"] = {"video_generation_mode": "firstFrame"}
    if shared:
        plan["inputs"] = {"video_generation_mode": shared}

    prepared = prepare_workflow_source({"plan": plan}, username="tester")

    compiled = prepared["compiled"]
    node = compiled["plan"]["nodes"][1]["data"]
    assert node["genMode"] == "firstFrame"
    assert "video_generation_mode" not in node["workflowCatalog"].get("confirmedInputs", {})
    assert _mode_codes(compiled) == [code]
    runtime = evaluate_workflow_preflight(
        compiled,
        model_responses=_video_runtime_models(),
        limits={"ok": True, "data": {"video": {"limit": 2, "remaining": 2}}},
    )
    assert runtime["status"] == "blocked"
    assert code in [b["code"] for b in runtime["blockers"]]


def test_revised_node_mode_confirmation_survives_later_revisions():
    plan = _exact_media_plan()
    plan["nodes"][1]["data"].pop("generation_mode")
    plan["inputs"] = {"video_generation_mode": "imageToVideo"}
    prepared = prepare_workflow_source({"plan": plan}, username="tester")
    revised = revise_workflow_source(
        prepared,
        {"step_updates": [
            {"node_id": "video", "settings": {"generation_mode": "firstLastFrame"}}
        ]},
        username="tester",
    )

    again = revise_workflow_source(
        revised,
        {"step_updates": [{"node_id": "video", "prompt": "make a calmer video"}]},
        username="tester",
    )

    video = again["compiled"]["plan"]["nodes"][1]["data"]
    assert video["genMode"] == "firstLastFrame"
    assert _mode_codes(again["compiled"]) == []
