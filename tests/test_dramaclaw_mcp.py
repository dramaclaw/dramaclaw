from __future__ import annotations

import asyncio
from copy import deepcopy
import json

import pytest
from jsonschema import Draft202012Validator
from jsonschema.exceptions import ValidationError

from novelvideo.chat import dramaclaw_mcp
from novelvideo.interactive_story.models import (
    StoryCharacter,
    StoryChoice,
    StoryChoiceAnchor,
    StoryChoiceChanges,
    StoryChoiceInteraction,
    StoryChoiceLoop,
    StoryDraftV2,
    StoryFlag,
    StoryMediaRef,
    StorySegment,
    StorySegmentChanges,
    StoryVariable,
)


def _story_tool_schemas():
    return {
        tool.name: tool.inputSchema for tool in asyncio.run(dramaclaw_mcp.list_tools())
    }


def test_mcp_bridge_exposes_interactive_story_plugin_tools(monkeypatch):
    monkeypatch.setenv("DRAMACLAW_PROJECT_ID", "project-a")
    monkeypatch.setenv("DRAMACLAW_CANVAS_ID", "canvas-a")
    monkeypatch.setenv("DRAMACLAW_CHAT_SURFACE", "freezone")
    expected = {
        "dramaclaw_create_interactive_story",
        "dramaclaw_get_interactive_story",
        "dramaclaw_patch_interactive_story",
        "dramaclaw_validate_interactive_story",
    }

    assert expected <= dramaclaw_mcp._agent_tools().keys()
    listed = {tool.name: tool for tool in asyncio.run(dramaclaw_mcp.list_tools())}
    assert expected <= listed.keys()
    assert "dramaclaw_get_freezone_canvas" in listed
    assert "dramaclaw_post" not in listed
    assert "dramaclaw_save_freezone_canvas" not in listed
    assert listed["dramaclaw_patch_interactive_story"].inputSchema["required"] == [
        "story_id",
        "base_revision",
        "idempotency_key",
        "operations",
    ]
    assert listed["dramaclaw_validate_interactive_story"].inputSchema["required"] == [
        "story_id"
    ]


def test_patch_schema_describes_strict_operation_envelopes(monkeypatch):
    monkeypatch.setenv("DRAMACLAW_PROJECT_ID", "project-a")
    monkeypatch.setenv("DRAMACLAW_CANVAS_ID", "canvas-a")
    monkeypatch.setenv("DRAMACLAW_CHAT_SURFACE", "freezone")
    listed = {
        tool.name: tool for tool in asyncio.run(dramaclaw_mcp.list_tools())
    }

    operations = listed["dramaclaw_patch_interactive_story"].inputSchema[
        "properties"
    ]["operations"]["items"]
    choices = [
        entry for entry in operations["oneOf"]
        if entry["properties"]["op"].get("const") == "add_choice"
    ]
    assert len(choices) == 1
    add_choice = choices[0]
    assert add_choice["required"] == ["op", "choice"]
    choice = add_choice["properties"]["choice"]
    assert choice["additionalProperties"] is False
    assert choice["required"] == [
        "id",
        "source_segment_id",
        "target_segment_id",
        "mode",
        "text",
        "order",
    ]


def test_create_schema_exposes_complete_story_contract(monkeypatch):
    monkeypatch.setenv("DRAMACLAW_PROJECT_ID", "project-a")
    monkeypatch.setenv("DRAMACLAW_CANVAS_ID", "canvas-a")
    monkeypatch.setenv("DRAMACLAW_CHAT_SURFACE", "freezone")
    create = _story_tool_schemas()["dramaclaw_create_interactive_story"]
    story = create["properties"]["story"]

    assert story["additionalProperties"] is False
    assert set(story["properties"]) == set(StoryDraftV2.model_fields)
    assert set(story["properties"]["characters"]["items"]["properties"]) == set(
        StoryCharacter.model_fields
    )
    assert set(story["properties"]["variables"]["items"]["properties"]) == set(
        StoryVariable.model_fields
    )
    assert set(story["properties"]["flags"]["items"]["properties"]) == set(
        StoryFlag.model_fields
    )
    assert set(story["properties"]["segments"]["items"]["properties"]) == set(
        StorySegment.model_fields
    )
    assert set(story["properties"]["choices"]["items"]["properties"]) == set(
        StoryChoice.model_fields
    )
    segment = story["properties"]["segments"]["items"]
    assert set(segment["properties"]["media"]["properties"]) == set(
        StoryMediaRef.model_fields
    )
    choice_loop = segment["properties"]["choice_loop"]["oneOf"][0]
    assert set(choice_loop["properties"]) == set(StoryChoiceLoop.model_fields)
    choice = story["properties"]["choices"]["items"]
    assert set(choice["properties"]["interaction"]["properties"]) == set(
        StoryChoiceInteraction.model_fields
    )
    anchor = choice["properties"]["interaction"]["properties"]["anchor"]["oneOf"][0]
    assert set(anchor["properties"]) == set(StoryChoiceAnchor.model_fields)

    payload = {
        "base_revision": 0,
        "idempotency_key": "create-story-01",
        "story": {
            "story_id": "story-a",
            "title": "午夜站台",
            "start_segment_id": "ending-a",
            "segments": [
                {
                    "id": "ending-a",
                    "title": "天亮",
                    "script": "第一班车驶入晨雾。",
                    "kind": "ending",
                    "ending_label": "等候者",
                }
            ],
        },
    }
    Draft202012Validator(create).validate(payload)
    StoryDraftV2.model_validate(payload["story"])


def test_patch_nested_schemas_match_domain_change_fields(monkeypatch):
    monkeypatch.setenv("DRAMACLAW_PROJECT_ID", "project-a")
    monkeypatch.setenv("DRAMACLAW_CANVAS_ID", "canvas-a")
    monkeypatch.setenv("DRAMACLAW_CHAT_SURFACE", "freezone")
    patch = _story_tool_schemas()["dramaclaw_patch_interactive_story"]
    variants = {
        item["properties"]["op"]["const"]: item
        for item in patch["properties"]["operations"]["items"]["oneOf"]
    }

    assert set(variants) == {
        "update_story_metadata",
        "set_story_start",
        "add_segment",
        "update_segment",
        "remove_segment",
        "add_choice",
        "update_choice",
        "remove_choice",
        "upsert_variable",
        "remove_variable",
        "upsert_flag",
        "remove_flag",
        "upsert_character",
        "remove_character",
    }
    assert set(variants["update_segment"]["properties"]["changes"]["properties"]) == set(
        StorySegmentChanges.model_fields
    )
    assert set(variants["update_choice"]["properties"]["changes"]["properties"]) == set(
        StoryChoiceChanges.model_fields
    )


def test_story_schemas_reject_recurring_agent_payload_mistakes(monkeypatch):
    monkeypatch.setenv("DRAMACLAW_PROJECT_ID", "project-a")
    monkeypatch.setenv("DRAMACLAW_CANVAS_ID", "canvas-a")
    monkeypatch.setenv("DRAMACLAW_CHAT_SURFACE", "freezone")
    schemas = _story_tool_schemas()
    create = schemas["dramaclaw_create_interactive_story"]
    patch = schemas["dramaclaw_patch_interactive_story"]
    base = {
        "story_id": "story-a",
        "base_revision": 1,
        "idempotency_key": "patch-story-01",
        "operations": [
            {
                "op": "add_choice",
                "choice": {
                    "id": "auto-a",
                    "source_segment_id": "scene-a",
                    "target_segment_id": "scene-b",
                    "mode": "automatic",
                    "text": "",
                    "order": 0,
                    "is_default": False,
                },
            }
        ],
    }

    Draft202012Validator(patch).validate(base)
    invalid_payloads = []
    wrong_envelope = deepcopy(base)
    wrong_envelope["operations"] = [{"operation": "remove_choice", "choice_id": "a"}]
    invalid_payloads.append(wrong_envelope)
    automatic_default = deepcopy(base)
    automatic_default["operations"][0]["choice"]["is_default"] = True
    invalid_payloads.append(automatic_default)
    null_interaction = deepcopy(base)
    null_interaction["operations"][0]["choice"]["interaction"] = None
    invalid_payloads.append(null_interaction)
    missing_choice_wrapper = deepcopy(base)
    missing_choice_wrapper["operations"] = [
        {"op": "add_choice", "id": "a", "source_segment_id": "b"}
    ]
    invalid_payloads.append(missing_choice_wrapper)
    invalid_change_field = deepcopy(base)
    invalid_change_field["operations"] = [
        {"op": "update_segment", "segment_id": "a", "changes": {"durationSec": 12}}
    ]
    invalid_payloads.append(invalid_change_field)

    for payload in invalid_payloads:
        with pytest.raises(ValidationError):
            Draft202012Validator(patch).validate(payload)

    create_with_null_feedback = {
        "base_revision": 0,
        "idempotency_key": "create-story-01",
        "story": {
            "story_id": "story-a",
            "title": "测试",
            "start_segment_id": "scene-a",
            "segments": [{"id": "scene-a", "title": "开始", "script": "开始"}],
            "choices": [
                {
                    "id": "choice-a",
                    "source_segment_id": "scene-a",
                    "target_segment_id": "scene-a",
                    "mode": "visible",
                    "text": "继续",
                    "order": 0,
                    "feedback_text": None,
                }
            ],
        },
    }
    with pytest.raises(ValidationError):
        Draft202012Validator(create).validate(create_with_null_feedback)


@pytest.mark.parametrize("tool_name", [
    "dramaclaw_create_interactive_story", "dramaclaw_get_interactive_story",
    "dramaclaw_patch_interactive_story", "dramaclaw_validate_interactive_story",
    "dramaclaw_get_freezone_canvas",
])
@pytest.mark.parametrize("override", [{"project_id": "other"}, {"canvas_id": "other"}])
def test_freezone_story_tools_reject_scope_override(monkeypatch, tool_name, override):
    monkeypatch.setenv("DRAMACLAW_PROJECT_ID", "project-a")
    monkeypatch.setenv("DRAMACLAW_CANVAS_ID", "canvas-a")
    plugin = dramaclaw_mcp._plugin("freezone")
    calls = []
    monkeypatch.setattr(plugin, "_request", lambda *a, **kw: calls.append((a, kw)))
    handler = dramaclaw_mcp._plugin_tools("freezone")[tool_name][1]
    raw = handler({"story_id": "story-a", **override})
    result = json.loads(raw) if isinstance(raw, str) else raw
    assert result["ok"] is False
    assert "bound" in result["error"]
    assert calls == []


def test_freezone_story_canvas_read_preserves_revision(monkeypatch):
    monkeypatch.setenv("DRAMACLAW_PROJECT_ID", "project-a")
    monkeypatch.setenv("DRAMACLAW_CANVAS_ID", "canvas-a")
    monkeypatch.setenv("DRAMACLAW_TOOL_MODE", "freezone_canvas")
    plugin = dramaclaw_mcp._plugin("freezone")
    calls = []
    def request(method, path, **kwargs):
        calls.append((method, path))
        return {"ok": True, "data": {"nodes": [], "edges": [], "revision": 7}}
    monkeypatch.setattr(plugin, "_request", request)
    result = asyncio.run(dramaclaw_mcp.call_tool("dramaclaw_get_freezone_canvas", {}))
    assert result.isError is False
    assert result.structuredContent["revision"] == 7
    assert result.structuredContent["canvas_id"] == "canvas-a"
    assert calls == [("GET", "/api/v1/projects/project-a/freezone/canvases/canvas-a")]


@pytest.mark.parametrize("tool_name", [
    "dramaclaw_create_interactive_story", "dramaclaw_patch_interactive_story",
])
def test_hermes_recovers_story_write_receipt(monkeypatch, tmp_path, tool_name):
    from novelvideo.chat.hermes_sdk import _load_recent_freezone_tool_result
    monkeypatch.setenv("DRAMACLAW_PROJECT_ID", "project-a")
    monkeypatch.setenv("DRAMACLAW_CANVAS_ID", "canvas-a")
    monkeypatch.setenv("DRAMACLAW_FREEZONE_TOOL_RESULT_DIR", str(tmp_path))
    plugin = dramaclaw_mcp._plugin("freezone")
    receipt = {"ok": True, "story_id": "story-a", "canvas_id": "canvas-a",
               "revision": 1, "refresh_canvas": True}
    monkeypatch.setattr(plugin, "_request", lambda *a, **kw: receipt)
    handler = dramaclaw_mcp._plugin_tools("freezone")[tool_name][1]
    arguments = {
        "story_id": "story-a",
        "base_revision": 0,
        "idempotency_key": "story-key-01",
        "story": {},
        "operations": [],
    }
    handler(arguments)
    assert _load_recent_freezone_tool_result(
        str(tmp_path), tool_name, tool_input=arguments
    ) == receipt


@pytest.mark.parametrize("missing", ["DRAMACLAW_PROJECT_ID", "DRAMACLAW_CANVAS_ID"])
def test_freezone_story_create_requires_bound_scope(monkeypatch, missing):
    monkeypatch.setenv("DRAMACLAW_PROJECT_ID", "project-a")
    monkeypatch.setenv("DRAMACLAW_CANVAS_ID", "canvas-a")
    monkeypatch.delenv(missing)
    plugin = dramaclaw_mcp._plugin("freezone")
    calls = []
    monkeypatch.setattr(plugin, "_request", lambda *a, **kw: calls.append((a, kw)))
    handler = dramaclaw_mcp._plugin_tools("freezone")["dramaclaw_create_interactive_story"][1]
    raw = handler({"project_id": "project-a", "canvas_id": "canvas-a"})
    result = json.loads(raw) if isinstance(raw, str) else raw
    assert result["ok"] is False
    assert "bound" in result["error"]
    assert calls == []


@pytest.mark.parametrize("interaction", [{}, StoryChoiceInteraction().model_dump(), {"presentation": "overlay"}])
def test_automatic_choice_accepts_domain_defaults(monkeypatch, interaction):
    monkeypatch.setenv("DRAMACLAW_PROJECT_ID", "project-a")
    monkeypatch.setenv("DRAMACLAW_CHAT_SURFACE", "freezone")
    schema = _story_tool_schemas()["dramaclaw_patch_interactive_story"]
    choice = StoryChoice(id="c", source_segment_id="a", target_segment_id="b", mode="automatic", order=0).model_dump(mode="json")
    choice["interaction"] = interaction
    base = {"story_id": "s", "base_revision": 1, "idempotency_key": "roundtrip-01", "operations": [{"op": "add_choice", "choice": choice}]}
    Draft202012Validator(schema).validate(base)
    base["operations"] = [{"op": "update_choice", "choice_id": "c", "changes": {"mode": "automatic", "text": "", "feedback_text": "", "is_default": False, "interaction": interaction}}]
    Draft202012Validator(schema).validate(base)
    for invalid in ({"motion": "pop"}, {"anchor": {"x": 0.5, "y": 0.5}}, {"ui_style": "warning"}):
        base["operations"][0]["changes"]["interaction"] = invalid
        with pytest.raises(ValidationError):
            Draft202012Validator(schema).validate(base)
