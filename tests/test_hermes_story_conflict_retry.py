"""Exercise the story retry exception through the real ACP stream guard."""

import asyncio
import copy
import importlib.util
import json
import sys
import types
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from novelvideo.chat import hermes_sdk


PATCH = "dramaclaw_patch_interactive_story"
CREATE = "dramaclaw_create_interactive_story"
GET = "dramaclaw_get_interactive_story"
CANVAS = "dramaclaw_get_freezone_canvas"
SAVE_OUTLINE = "dramaclaw_save_interactive_story_outline"
CONFIRM_OUTLINE = "dramaclaw_confirm_interactive_story_outline"
CONFIRM_STAGES = "dramaclaw_confirm_interactive_story_stages"
GET_OUTLINE = "dramaclaw_get_interactive_story_outline"


def start(name, call_id, args):
    return {"sessionUpdate": "tool_call", "toolCallId": call_id,
            "title": name, "status": "pending", "rawInput": args}


def finish(call_id, result, status="completed"):
    return {"sessionUpdate": "tool_call_update", "toolCallId": call_id,
            "status": status, "rawOutput": result}


def recovery(write=PATCH):
    args = {"base_revision": 1, "idempotency_key": "story-original-01"}
    if write == PATCH:
        args.update(story_id="story-a", operations=[{"op": "update_story_metadata", "changes": {"title": "New"}}])
    else:
        args["story"] = {"story_id": "story-a"}
    read = {"ok": True, "canvas_id": "canvas-a"}
    if write == PATCH:
        read["story"] = {"story_id": "story-a", "revision": 2}
    else:
        read["revision"] = 2
    return [
        start(write, "write-1", args),
        finish("write-1", {"ok": False, "code": "revision_conflict", "story_id": "story-a", "current_revision": 2}),
        start(GET if write == PATCH else CANVAS, "read-1", {"story_id": "story-a"} if write == PATCH else {}),
        finish("read-1", read),
        start(write, "write-2", {**args, "base_revision": 2, "idempotency_key": "story-rebased-02"}),
    ]


async def run_stream(monkeypatch, updates, *, env=None):
    thread = hermes_sdk.HermesSdkThread(
        cli_path=Path("hermes"), cwd=Path("."), model=None, username="user",
        session_id="session-a",
        env=env if env is not None else {
            "DRAMACLAW_PROJECT_ID": "project-a", "DRAMACLAW_CANVAS_ID": "canvas-a"
        },
    )
    reader = asyncio.StreamReader()
    for update in updates:
        reader.feed_data((json.dumps({"method": "session/update", "params": {"update": update}}) + "\n").encode())
    reader.feed_data(b'{"id": 99, "result": {}}\n')
    reader.feed_eof()
    thread._proc = SimpleNamespace(stdout=reader)
    monkeypatch.setattr(thread, "_prepare", AsyncMock())
    monkeypatch.setattr(thread, "_send", AsyncMock(return_value=99))
    monkeypatch.setattr(thread, "close", AsyncMock())
    monkeypatch.setattr(hermes_sdk, "_issue_turn_capability", lambda **kwargs: None)
    events = [event async for event in thread.stream("修改当前互动故事")]
    return events, thread.close


@pytest.mark.parametrize("write", [CREATE, PATCH])
@pytest.mark.parametrize("envelope", ["direct", "http", "text", "content_list"])
async def test_allows_one_confirmed_story_conflict_recovery(monkeypatch, write, envelope):
    updates = recovery(write)
    for index in (1, 3):
        payload = updates[index]["rawOutput"]
        if envelope == "http":
            updates[index]["rawOutput"] = {"ok": payload["ok"], "data": payload}
        elif envelope == "text":
            updates[index]["rawOutput"] = {"content": [{"type": "text", "text": json.dumps(payload)}]}
        elif envelope == "content_list":
            updates[index]["rawOutput"] = [{"type": "text", "text": json.dumps(payload)}]
    events, close = await run_stream(monkeypatch, updates)
    assert any(e.type == "tool_started" and e.call_id == "write-2" for e in events)
    close.assert_not_called()


@pytest.mark.parametrize("write", [CREATE, PATCH])
async def test_conflict_receipt_allows_direct_rebased_retry_without_get(monkeypatch, write):
    updates = recovery(write)
    del updates[2:4]
    events, close = await run_stream(monkeypatch, updates)
    assert any(e.type == "tool_started" and e.call_id == "write-2" for e in events)
    close.assert_not_called()


@pytest.mark.parametrize("case", [
    "success", "unknown", "idempotency_conflict", "invalid_story", "cancelled",
    "wrong_conflict_call", "wrong_conflict_story", "missing_conflict_revision",
    "wrong_story", "wrong_project", "stale_revision", "same_key", "other_write",
    "boolean_revision", "mainline_write", "cached_conflict",
])
async def test_keeps_unsafe_or_unrelated_retries_blocked(monkeypatch, case):
    updates = recovery()
    if case == "success":
        updates[1]["rawOutput"] = {"ok": True, "revision": 2, "refresh_canvas": True}
    elif case == "unknown":
        updates[1]["rawOutput"] = {"error": "network timeout"}
    elif case in {"idempotency_conflict", "invalid_story"}:
        updates[1]["rawOutput"]["code"] = case
    elif case == "cancelled":
        updates[1]["status"] = "cancelled"
    elif case == "wrong_conflict_call":
        updates[1]["toolCallId"] = "unrelated"
    elif case == "wrong_conflict_story":
        updates[1]["rawOutput"]["story_id"] = "story-b"
        del updates[2:4]
    elif case == "missing_conflict_revision":
        del updates[1]["rawOutput"]["current_revision"]
        del updates[2:4]
    elif case == "wrong_story":
        updates[-1]["rawInput"]["story_id"] = "story-b"
    elif case == "wrong_project":
        updates[-1]["rawInput"]["project_id"] = "other"
    elif case == "stale_revision":
        updates[-1]["rawInput"]["base_revision"] = 1
    elif case == "same_key":
        updates[-1]["rawInput"]["idempotency_key"] = "story-original-01"
    elif case == "other_write":
        updates[-1]["title"] = "dramaclaw_start_single_video"
    elif case == "boolean_revision":
        updates[-1]["rawInput"]["base_revision"] = True
    elif case == "mainline_write":
        updates[0]["title"] = "dramaclaw_generate_script"
        updates[-1]["title"] = "dramaclaw_start_single_video"
    elif case == "cached_conflict":
        cached = updates[1].pop("rawOutput")
        monkeypatch.setattr(
            hermes_sdk,
            "_load_recent_freezone_tool_result",
            lambda *args, **kwargs: cached,
        )
    events, close = await run_stream(monkeypatch, updates)
    assert not any(e.type == "tool_started" and e.call_id == "write-2" for e in events)
    close.assert_awaited_once()


async def test_incomplete_create_receipt_does_not_allow_production_patch(monkeypatch):
    updates = recovery(CREATE)
    updates[1]["rawOutput"] = {"ok": True, "revision": 2, "refresh_canvas": True}
    updates[-1] = start(PATCH, "write-2", {"story_id": "story-a", "base_revision": 2,
                                         "idempotency_key": "production-02", "operations": []})
    events, close = await run_stream(monkeypatch, updates)
    assert not any(e.type == "tool_started" and e.call_id == "write-2" for e in events)
    close.assert_awaited_once()


async def test_conflict_retry_budget_is_one_per_turn(monkeypatch):
    updates = recovery()
    updates += [finish("write-2", {"ok": False, "code": "revision_conflict", "story_id": "story-a", "current_revision": 3})]
    next_read = copy.deepcopy(updates[2:4])
    for item in next_read:
        item["toolCallId"] = "read-2"
    next_read[1]["rawOutput"]["story"]["revision"] = 3
    updates += next_read
    updates.append(start(PATCH, "write-3", {"story_id": "story-a", "base_revision": 3,
                                          "idempotency_key": "story-third-03", "operations": []}))
    events, close = await run_stream(monkeypatch, updates)
    assert any(e.type == "tool_started" and e.call_id == "write-2" for e in events)
    assert not any(e.type == "tool_started" and e.call_id == "write-3" for e in events)
    close.assert_awaited_once()


def successful_stage(call_id, revision):
    return finish(call_id, {"ok": True, "story_id": "story-a", "canvas_id": "canvas-a",
                            "revision": revision, "refresh_canvas": True})


async def test_allows_fresh_same_story_stages_after_success(monkeypatch):
    updates = recovery(CREATE)[:1]
    updates += [successful_stage("write-1", 2),
                start(GET, "read-1", {"story_id": "story-a"}),
                finish("read-1", {"ok": True, "canvas_id": "canvas-a",
                                  "story": {"story_id": "story-a", "revision": 2}}),
                start(PATCH, "write-2", {"story_id": "story-a", "base_revision": 2,
                    "idempotency_key": "stage-two", "operations": [{"op": "update_segment",
                    "segment_id": "a", "changes": {"video_prompt": "First clip"}}]}),
                successful_stage("write-2", 3),
                start(GET, "read-2", {"story_id": "story-a"}),
                finish("read-2", {"ok": True, "canvas_id": "canvas-a",
                                  "story": {"story_id": "story-a", "revision": 3}}),
                start(PATCH, "write-3", {"story_id": "story-a", "base_revision": 3,
                    "idempotency_key": "stage-three", "operations": [{"op": "update_segment",
                    "segment_id": "b", "changes": {"video_prompt": "Next clip"}}]})]
    events, close = await run_stream(monkeypatch, updates)
    assert {e.call_id for e in events if e.type == "tool_started"} >= {"write-2", "write-3"}
    close.assert_not_called()


@pytest.mark.parametrize("case", ["no_read", "wrong_story", "wrong_scope", "same_payload", "other_tool", "ambiguous"])
async def test_success_continuation_remains_scoped(monkeypatch, case):
    updates = recovery()
    updates[1] = successful_stage("write-1", 2)
    updates[-1]["rawInput"]["operations"] = [{"op": "update_story_metadata", "changes": {"title": "Next"}}]
    if case == "no_read":
        del updates[2:4]
    elif case == "wrong_story":
        updates[-1]["rawInput"]["story_id"] = "other"
    elif case == "wrong_scope":
        updates[-1]["rawInput"]["project_id"] = "other"
    elif case == "same_payload":
        updates[-1]["rawInput"]["operations"] = updates[0]["rawInput"]["operations"]
    elif case == "other_tool":
        updates[-1]["title"] = "dramaclaw_generate_script"
    elif case == "ambiguous":
        updates[1]["rawOutput"] = {"ok": True}
    events, close = await run_stream(monkeypatch, updates)
    assert not any(e.type == "tool_started" and e.call_id == "write-2" for e in events)
    close.assert_awaited_once()


@pytest.mark.parametrize("write", [CREATE, PATCH])
async def test_validation_correction_allows_unchanged_revision_once(monkeypatch, write):
    updates = recovery(write)
    path = ["story", "title"] if write == CREATE else ["operations", 0, "changes", "title"]
    updates[1] = finish("write-1", {"ok": False, "error": "tool_arguments_invalid", "phase": "tool_validation",
                                  "invalid_argument_paths": [path], "argument_corrections_complete": True})
    if write == CREATE:
        updates[3]["rawOutput"]["revision"] = 1
        updates[-1]["rawInput"]["story"] = {"story_id": "story-a", "title": "Corrected"}
    else:
        updates[3]["rawOutput"]["story"]["revision"] = 1
        updates[-1]["rawInput"]["operations"] = [{"op": "update_story_metadata", "changes": {"title": "Corrected"}}]
    updates[-1]["rawInput"]["base_revision"] = 1
    updates += [finish("write-2", {"ok": False, "error": "tool_arguments_invalid", "phase": "tool_validation"})]
    more = copy.deepcopy(updates[2:5])
    more[0]["toolCallId"] = more[1]["toolCallId"] = "read-2"
    more[2]["toolCallId"] = "write-3"
    more[2]["rawInput"]["idempotency_key"] = "third-key"
    updates += more
    events, close = await run_stream(monkeypatch, updates)
    assert any(e.type == "tool_started" and e.call_id == "write-2" for e in events)
    assert not any(e.type == "tool_started" and e.call_id == "write-3" for e in events)
    close.assert_awaited_once()


@pytest.mark.parametrize("case", ["no_read", "same_payload", "wrong_phase", "cancelled", "cached", "wrong_story"])
async def test_validation_correction_requires_fresh_definite_failure(monkeypatch, case):
    updates = recovery()
    updates[1] = finish("write-1", {"ok": False, "error": "tool_arguments_invalid", "phase": "tool_validation",
                                  "invalid_argument_paths": [["operations", 0, "changes", "title"]],
                                  "argument_corrections_complete": True})
    updates[-1]["rawInput"]["operations"] = [{"op": "update_story_metadata", "changes": {"title": "Corrected"}}]
    if case == "no_read":
        del updates[2:4]
    elif case == "same_payload":
        updates[-1]["rawInput"]["operations"] = updates[0]["rawInput"]["operations"]
    elif case == "wrong_phase":
        updates[1]["rawOutput"]["phase"] = "execution"
    elif case == "cancelled":
        updates[1]["status"] = "cancelled"
    elif case == "cached":
        payload = updates[1].pop("rawOutput")
        monkeypatch.setattr(hermes_sdk, "_load_recent_freezone_tool_result", lambda *a, **kw: payload)
    elif case == "wrong_story":
        updates[-1]["rawInput"]["story_id"] = "other"
    events, close = await run_stream(monkeypatch, updates)
    assert not any(e.type == "tool_started" and e.call_id == "write-2" for e in events)
    close.assert_awaited_once()


def additional_story_validation_recovery(write):
    common = {"base_revision": 1, "idempotency_key": "initial-key"}
    if write == SAVE_OUTLINE:
        initial = {**common, "outline": {"outline_id": "outline-a", "title": "Piko"}}
        corrected = {**initial, "outline": {**initial["outline"], "kind": "ad"}}
        path = ["outline", "kind"]
        read_name, read_args = GET_OUTLINE, {}
        read = {"ok": True, "canvas_id": "canvas-a", "revision": 1,
                "outline": {"outline_id": "outline-a"}}
        success = {"ok": True, "project_id": "project-a", "canvas_id": "canvas-a", "outline_id": "outline-a",
                   "revision": 2, "refresh_canvas": True}
    elif write == CONFIRM_OUTLINE:
        initial = dict(common)
        corrected = {**initial, "outline_id": "outline-a"}
        path = ["outline_id"]
        read_name, read_args = GET_OUTLINE, {}
        read = {"ok": True, "canvas_id": "canvas-a", "revision": 1,
                "outline": {"outline_id": "outline-a"}}
        success = {"ok": True, "canvas_id": "canvas-a", "outline_id": "outline-a",
                   "revision": 2, "refresh_canvas": True}
    elif write == CONFIRM_STAGES:
        initial = {**common, "story_id": "story-a", "stages": ["characters"]}
        corrected = {**initial, "action": "confirm"}
        path = ["action"]
        read_name, read_args = GET, {"story_id": "story-a"}
        read = {"ok": True, "canvas_id": "canvas-a",
                "story": {"story_id": "story-a", "revision": 1}}
        success = {"ok": True, "canvas_id": "canvas-a", "story_id": "story-a",
                   "revision": 2, "refresh_canvas": True}
    else:
        raise AssertionError(write)
    corrected["idempotency_key"] = "corrected-key"
    error = {"ok": False, "error": "tool_arguments_invalid", "phase": "tool_validation",
             "invalid_argument_paths": [path], "argument_corrections_complete": True}
    return [start(write, "write-1", initial), finish("write-1", error),
            start(read_name, "read-1", read_args), finish("read-1", read),
            start(write, "write-2", corrected), finish("write-2", success)]


@pytest.mark.parametrize("write", [SAVE_OUTLINE, CONFIRM_OUTLINE, CONFIRM_STAGES])
async def test_additional_story_writes_allow_proven_validation_retry(monkeypatch, write):
    events, close = await run_stream(monkeypatch, additional_story_validation_recovery(write))
    assert any(e.type == "tool_started" and e.call_id == "write-2" for e in events)
    assert any(e.type == "tool_updated" and e.call_id == "write-2" for e in events)
    close.assert_not_called()


@pytest.mark.parametrize("write", [CREATE, PATCH, SAVE_OUTLINE, CONFIRM_OUTLINE, CONFIRM_STAGES])
@pytest.mark.parametrize("direction", ["explicit_on_retry", "omitted_on_retry"])
async def test_validation_retry_accepts_equivalent_bound_scope(monkeypatch, write, direction):
    if write in {CREATE, PATCH}:
        updates = recovery(write)
        path = ["story", "title"] if write == CREATE else ["operations", 0, "changes", "title"]
        updates[1] = finish("write-1", {
            "ok": False, "error": "tool_arguments_invalid", "phase": "tool_validation",
            "invalid_argument_paths": [path], "argument_corrections_complete": True,
        })
        updates[-1]["rawInput"] = copy.deepcopy(updates[-1]["rawInput"])
        if write == CREATE:
            updates[-1]["rawInput"]["story"]["title"] = "Corrected"
        else:
            updates[-1]["rawInput"]["operations"][0]["changes"]["title"] = "Corrected"
    else:
        updates = additional_story_validation_recovery(write)
    scope = {"project_id": "project-a", "canvas_id": "canvas-a"}
    if direction == "explicit_on_retry":
        updates[-1 if write in {CREATE, PATCH} else -2]["rawInput"].update(scope)
    else:
        updates[0]["rawInput"].update(scope)
    events, close = await run_stream(monkeypatch, updates)
    assert any(e.type == "tool_started" and e.call_id == "write-2" for e in events)
    close.assert_not_called()


@pytest.mark.parametrize("case", [
    "requested_replacement", "changed_requested_id", "wrong_project", "wrong_canvas",
    "stale_revision", "both_wrong_project", "both_wrong_canvas",
])
async def test_outline_validation_retry_preserves_requested_replacement(monkeypatch, case):
    updates = additional_story_validation_recovery(SAVE_OUTLINE)
    # The current outline is A, but both attempts intentionally save B.
    updates[3]["rawOutput"]["outline"]["outline_id"] = "outline-a"
    updates[0]["rawInput"]["outline"]["outline_id"] = "outline-b"
    updates[4]["rawInput"]["outline"]["outline_id"] = "outline-b"
    updates[5]["rawOutput"]["outline_id"] = "outline-b"
    if case == "changed_requested_id":
        updates[4]["rawInput"]["outline"]["outline_id"] = "outline-c"
    elif case == "wrong_project":
        updates[4]["rawInput"]["project_id"] = "project-other"
    elif case == "wrong_canvas":
        updates[4]["rawInput"]["canvas_id"] = "canvas-other"
    elif case == "stale_revision":
        updates[4]["rawInput"]["base_revision"] = 0
    elif case == "both_wrong_project":
        for index in (0, 2, 4):
            updates[index]["rawInput"]["project_id"] = "project-other"
        updates[3]["rawOutput"]["project_id"] = "project-other"
    elif case == "both_wrong_canvas":
        for index in (0, 2, 4):
            updates[index]["rawInput"]["canvas_id"] = "canvas-other"
        updates[3]["rawOutput"]["canvas_id"] = "canvas-other"
    events, close = await run_stream(monkeypatch, updates)
    retried = any(e.type == "tool_started" and e.call_id == "write-2" for e in events)
    assert retried is (case == "requested_replacement")
    if case == "requested_replacement":
        assert any(e.type == "tool_updated" and e.call_id == "write-2" for e in events)
        close.assert_not_called()
    else:
        close.assert_awaited_once()


@pytest.mark.parametrize("missing", ["DRAMACLAW_PROJECT_ID", "DRAMACLAW_CANVAS_ID"])
async def test_validation_retry_requires_bound_project_and_canvas(monkeypatch, missing):
    updates = additional_story_validation_recovery(SAVE_OUTLINE)
    scope = {"project_id": "project-a", "canvas_id": "canvas-a"}
    for index in (0, 2, 4):
        updates[index]["rawInput"].update(scope)
    updates[3]["rawOutput"]["project_id"] = "project-a"
    env = {"DRAMACLAW_PROJECT_ID": "project-a", "DRAMACLAW_CANVAS_ID": "canvas-a"}
    del env[missing]
    events, close = await run_stream(monkeypatch, updates, env=env)
    assert not any(e.type == "tool_started" and e.call_id == "write-2" for e in events)
    close.assert_awaited_once()


@pytest.mark.parametrize("change_title", [False, True])
async def test_outline_retry_accepts_explicit_default_version_only(monkeypatch, change_title):
    updates = additional_story_validation_recovery(SAVE_OUTLINE)
    retry_outline = updates[-2]["rawInput"]["outline"]
    retry_outline["schema_version"] = "pending_story_outline.v1"
    if change_title:
        retry_outline["title"] = "Another plan"
    events, close = await run_stream(monkeypatch, updates)
    retried = any(e.type == "tool_started" and e.call_id == "write-2" for e in events)
    assert retried is not change_title
    if change_title:
        close.assert_awaited_once()
    else:
        close.assert_not_called()


async def test_validation_retry_allows_new_story_id_after_fresh_canvas_read(monkeypatch):
    updates = [
        start(CREATE, "write-1", {"base_revision": 1, "idempotency_key": "initial-key",
                                  "story": {"title": "Plan"}}),
        finish("write-1", {"ok": False, "error": "tool_arguments_invalid", "phase": "tool_validation",
                           "invalid_argument_paths": [["story", "story_id"]],
                           "argument_corrections_complete": True}),
        start(CANVAS, "read-1", {}),
        finish("read-1", {"ok": True, "canvas_id": "canvas-a", "revision": 1}),
        start(CREATE, "write-2", {"base_revision": 1, "idempotency_key": "corrected-key",
                                  "story": {"story_id": "story-a", "title": "Plan"}}),
        finish("write-2", {"ok": True, "canvas_id": "canvas-a", "story_id": "story-a",
                           "revision": 2, "refresh_canvas": True}),
    ]
    events, close = await run_stream(monkeypatch, updates)
    assert any(e.type == "tool_started" and e.call_id == "write-2" for e in events)
    close.assert_not_called()


async def test_native_hermes_validation_receipt_allows_real_correction(monkeypatch):
    tools = types.ModuleType("tools")
    registry = types.ModuleType("tools.registry")
    registry.tool_error = lambda value: value
    registry.tool_result = lambda value: value
    monkeypatch.setitem(sys.modules, "tools", tools)
    monkeypatch.setitem(sys.modules, "tools.registry", registry)
    monkeypatch.setenv("DRAMACLAW_PROJECT_ID", "project-a")
    monkeypatch.setenv("DRAMACLAW_CANVAS_ID", "canvas-a")
    plugin_path = Path(__file__).resolve().parents[1] / ".hermes/plugins/freezone/__init__.py"
    spec = importlib.util.spec_from_file_location("story_validation_plugin_test", plugin_path)
    plugin = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(plugin)
    calls = []
    monkeypatch.setattr(plugin, "_request", lambda method, path, **kwargs: calls.append((method, path, kwargs)) or {
        "ok": True, "project_id": "project-a", "canvas_id": "canvas-a", "outline_id": "outline-a",
        "status": "confirmed", "revision": 2, "refresh_canvas": True,
    })
    handler = next(handler for name, _, handler in plugin.TOOLS if name == CONFIRM_OUTLINE)
    initial = {"base_revision": 1, "idempotency_key": "initial-key"}
    rejection = handler(initial)
    assert rejection["error"] == "tool_arguments_invalid"
    assert rejection["argument_corrections_complete"] is True
    assert ["outline_id"] in rejection["invalid_argument_paths"]
    assert calls == []
    corrected = {**initial, "outline_id": "outline-a", "idempotency_key": "corrected-key"}
    receipt = handler(corrected)
    assert receipt["ok"] is True and len(calls) == 1
    updates = [
        start(CONFIRM_OUTLINE, "write-1", initial), finish("write-1", rejection),
        start(GET_OUTLINE, "read-1", {}),
        finish("read-1", {"ok": True, "canvas_id": "canvas-a", "revision": 1,
                          "outline": {"outline_id": "outline-a"}}),
        start(CONFIRM_OUTLINE, "write-2", corrected), finish("write-2", receipt),
    ]
    events, close = await run_stream(monkeypatch, updates)
    assert any(e.type == "tool_updated" and e.call_id == "write-2" for e in events)
    close.assert_not_called()


@pytest.mark.parametrize("case", [
    "no_read", "wrong_scope", "wrong_outline", "changed_other_field", "wrong_tool",
    "incomplete_diagnostic", "wrong_phase", "same_key", "wrong_revision", "missing_outline_read",
])
async def test_outline_validation_retry_rejects_unproven_operations(monkeypatch, case):
    updates = additional_story_validation_recovery(CONFIRM_OUTLINE)
    if case == "no_read":
        del updates[2:4]
    elif case == "wrong_scope":
        updates[-2]["rawInput"]["project_id"] = "another-project"
    elif case == "wrong_outline":
        updates[-2]["rawInput"]["outline_id"] = "another-outline"
    elif case == "changed_other_field":
        updates[-2]["rawInput"]["status"] = "pending"
    elif case == "wrong_tool":
        updates[-2]["title"] = SAVE_OUTLINE
    elif case == "incomplete_diagnostic":
        updates[1]["rawOutput"]["argument_corrections_complete"] = False
    elif case == "wrong_phase":
        updates[1]["rawOutput"]["phase"] = "execution"
    elif case == "same_key":
        updates[-2]["rawInput"]["idempotency_key"] = "initial-key"
    elif case == "wrong_revision":
        updates[-2]["rawInput"]["base_revision"] = 2
    elif case == "missing_outline_read":
        del updates[3]["rawOutput"]["outline"]
    events, close = await run_stream(monkeypatch, updates)
    assert not any(e.type == "tool_started" and e.call_id == "write-2" for e in events)
    close.assert_awaited_once()


@pytest.mark.parametrize("generated_id", [False, True])
async def test_outline_saved_after_retry_can_be_confirmed_with_fresh_read(monkeypatch, generated_id):
    updates = additional_story_validation_recovery(SAVE_OUTLINE)
    if generated_id:
        for item in (updates[0], updates[4]):
            item["rawInput"]["outline"].pop("outline_id")
        updates[3]["rawOutput"]["revision"] = 0
        updates[3]["rawOutput"]["outline"] = None
        updates[0]["rawInput"]["base_revision"] = 0
        updates[4]["rawInput"]["base_revision"] = 0
        updates[5]["rawOutput"]["revision"] = 1
    saved_revision = updates[5]["rawOutput"]["revision"]
    updates += [
        start(GET_OUTLINE, "read-2", {}),
        finish("read-2", {"ok": True, "canvas_id": "canvas-a", "revision": saved_revision,
                          "outline": {"outline_id": "outline-a"}}),
        start(CONFIRM_OUTLINE, "confirm", {"outline_id": "outline-a",
            "base_revision": saved_revision, "idempotency_key": "confirm-key"}),
        finish("confirm", {"ok": True, "canvas_id": "canvas-a", "outline_id": "outline-a",
                           "revision": saved_revision + 1, "refresh_canvas": True}),
    ]
    events, close = await run_stream(monkeypatch, updates)
    assert {e.call_id for e in events if e.type == "tool_started"} >= {"write-2", "confirm"}
    close.assert_not_called()


@pytest.mark.parametrize("case", ["no_read", "wrong_id", "changed_revision", "wrong_scope", "bad_receipt", "bad_project_receipt"])
async def test_outline_saved_after_retry_confirmation_requires_exact_receipt(monkeypatch, case):
    updates = additional_story_validation_recovery(SAVE_OUTLINE)
    updates += [
        start(GET_OUTLINE, "read-2", {}),
        finish("read-2", {"ok": True, "canvas_id": "canvas-a", "revision": 2,
                          "outline": {"outline_id": "outline-a"}}),
        start(CONFIRM_OUTLINE, "confirm", {"outline_id": "outline-a",
            "base_revision": 2, "idempotency_key": "confirm-key"}),
    ]
    if case == "no_read":
        del updates[6:8]
    elif case == "wrong_id":
        updates[-1]["rawInput"]["outline_id"] = "another-outline"
    elif case == "changed_revision":
        updates[-2]["rawOutput"]["revision"] = 3
        updates[-1]["rawInput"]["base_revision"] = 3
    elif case == "wrong_scope":
        updates[-1]["rawInput"]["canvas_id"] = "another-canvas"
    elif case == "bad_receipt":
        updates[5]["rawOutput"]["outline_id"] = "another-outline"
    elif case == "bad_project_receipt":
        updates[5]["rawOutput"]["project_id"] = "another-project"
    events, close = await run_stream(monkeypatch, updates)
    assert any(e.type == "tool_started" and e.call_id == "write-2" for e in events)
    assert not any(e.type == "tool_started" and e.call_id == "confirm" for e in events)
    close.assert_awaited_once()
