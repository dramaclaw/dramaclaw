"""Exercise the story retry exception through the real ACP stream guard."""

import asyncio
import copy
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from novelvideo.chat import hermes_sdk


PATCH = "dramaclaw_patch_interactive_story"
CREATE = "dramaclaw_create_interactive_story"
GET = "dramaclaw_get_interactive_story"
CANVAS = "dramaclaw_get_freezone_canvas"


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
        finish("write-1", {"ok": False, "code": "revision_conflict", "current_revision": 2}),
        start(GET if write == PATCH else CANVAS, "read-1", {"story_id": "story-a"} if write == PATCH else {}),
        finish("read-1", read),
        start(write, "write-2", {**args, "base_revision": 2, "idempotency_key": "story-rebased-02"}),
    ]


async def run_stream(monkeypatch, updates):
    thread = hermes_sdk.HermesSdkThread(
        cli_path=Path("hermes"), cwd=Path("."), model=None, username="user",
        session_id="session-a",
        env={"DRAMACLAW_PROJECT_ID": "project-a", "DRAMACLAW_CANVAS_ID": "canvas-a"},
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


@pytest.mark.parametrize("case", [
    "success", "unknown", "idempotency_conflict", "invalid_story", "cancelled",
    "no_read", "read_before_conflict", "read_failed", "wrong_read_call",
    "wrong_conflict_call", "wrong_story", "wrong_canvas", "wrong_project",
    "stale_revision", "same_key", "other_write", "read_not_completed",
    "wrong_read_story", "wrong_read_canvas", "read_older_than_conflict",
    "boolean_revision", "mainline_write", "cached_conflict", "cached_read",
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
    elif case == "no_read":
        del updates[2:4]
    elif case == "read_before_conflict":
        updates = updates[2:4] + updates[:2] + updates[4:]
    elif case == "read_failed":
        updates[3]["rawOutput"]["ok"] = False
    elif case == "wrong_read_call":
        updates[3]["toolCallId"] = "unrelated"
    elif case == "wrong_conflict_call":
        updates[1]["toolCallId"] = "unrelated"
    elif case == "wrong_story":
        updates[-1]["rawInput"]["story_id"] = "story-b"
    elif case == "wrong_canvas":
        updates[2]["rawInput"]["canvas_id"] = "other"
    elif case == "wrong_project":
        updates[-1]["rawInput"]["project_id"] = "other"
    elif case == "stale_revision":
        updates[-1]["rawInput"]["base_revision"] = 1
    elif case == "same_key":
        updates[-1]["rawInput"]["idempotency_key"] = "story-original-01"
    elif case == "other_write":
        updates[-1]["title"] = "dramaclaw_start_single_video"
    elif case == "read_not_completed":
        updates[3]["status"] = "in_progress"
    elif case == "wrong_read_story":
        updates[3]["rawOutput"]["story"]["story_id"] = "story-b"
    elif case == "wrong_read_canvas":
        updates[3]["rawOutput"]["canvas_id"] = "canvas-b"
    elif case == "read_older_than_conflict":
        updates[3]["rawOutput"]["story"]["revision"] = 1
    elif case == "boolean_revision":
        updates[-1]["rawInput"]["base_revision"] = True
    elif case == "mainline_write":
        updates[0]["title"] = "dramaclaw_generate_script"
        updates[-1]["title"] = "dramaclaw_start_single_video"
    elif case in {"cached_conflict", "cached_read"}:
        index = 1 if case == "cached_conflict" else 3
        cached = updates[index].pop("rawOutput")
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
    updates += [finish("write-2", {"ok": False, "code": "revision_conflict", "current_revision": 3})]
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
    updates[1] = finish("write-1", {"ok": False, "error": "tool_arguments_invalid", "phase": "tool_validation"})
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
    updates[1] = finish("write-1", {"ok": False, "error": "tool_arguments_invalid", "phase": "tool_validation"})
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
