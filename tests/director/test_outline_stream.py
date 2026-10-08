"""Unfinished JSON never proves schema or semantic validity."""

import json

import pytest

from novelvideo.director.outline_stream import OutlinePreview
from novelvideo.director.output_validation import parse_model_json
from tests.director.test_outline_pipeline import runtime as runtime, start, provider
from tests.director.test_outline_changes import execute, patch_value
from tests.director.test_workflow import decide
from tests.director.test_workflow import runtime as workflow_fixture, grant, output_for
from novelvideo.director.workflow import dispatch_planning


@pytest.fixture(name="original_runtime")
def direction_runtime(tmp_path, monkeypatch):
    return workflow_fixture.__wrapped__(tmp_path, monkeypatch)


@pytest.mark.parametrize("width", [1, 2, 7, 10000])
def test_split_unicode_and_quotes_preview_only_reader_fields(width):
    raw = json.dumps({"overview": {"logline": {"text": '雨中“你好” \n 😀 \\ 尾', "claimIds": ["secret-id"]},
                      "internal": {"text": "Never project unknown fields."}},
                      "craftNotes": {"text": "not for publication"}}, ensure_ascii=True)
    preview = OutlinePreview("M07")
    events = []
    for offset in range(0, len(raw), width):
        events.extend(preview.feed(raw[offset:offset + width]))
    assert events[-1]["text"] == '雨中“你好” \n 😀 \\ 尾'
    assert all(e["provisional"] and e["blockKey"] == "overview.logline.text" for e in events)
    assert preview.raw == raw


def test_partial_fields_are_visible_before_response_finishes_but_duplicates_still_fail():
    preview = OutlinePreview("M07")
    assert preview.feed('{"overview":{"logline":{"text":"One')[0]["text"] == "One"
    events = preview.feed('","text":"Other"}}}')
    assert events[0]["text"] == "Other"
    with pytest.raises(ValueError, match="DUPLICATE_JSON_KEY"):
        parse_model_json(preview.raw)


def test_patch_preview_has_no_reason_summary_or_raw_model_ids():
    preview = OutlinePreview("M14")
    events = preview.feed(json.dumps({"hunks": [{"sectionKey": "chapters", "reason": "private reasoning",
        "afterBlocks": [{"type": "paragraph", "text": "The visible proposed story."}]}],
        "changeSummary": [{"text": "Still provisional; do not publish as a completed action."}]}))
    assert len(events) == 1 and events[0]["text"] == "The visible proposed story."
    assert not OutlinePreview("M12").feed('{"units":[{"text":"Internal audit"}]}')


def test_incomplete_response_is_not_repaired_by_preview():
    preview = OutlinePreview("M07")
    preview.feed('{"overview":{"logline":{"text":"Draft')
    with pytest.raises(json.JSONDecodeError):
        parse_model_json(preview.raw)


def test_direction_preview_uses_wire_names_and_never_projects_private_fields():
    raw = json.dumps({"options": [{"id": "private-id", "logline": "曹操抉择",
        "goal": "保住盟约", "productionRisks": ["需要群演"], "internal": "hidden"}],
        "specQuestions": [{"id": "private-question", "question": "采用哪种史实边界？",
                           "choices": ["明确标注虚构"]}], "audit": "hidden"}, ensure_ascii=True)
    preview = OutlinePreview("M03")
    events = []
    for index in range(0, len(raw), 3):
        events.extend(preview.feed(raw[index:index + 3]))
    assert {event["blockKey"] for event in events} == {
        "options.0.logline", "options.0.goal", "options.0.productionRisks.0",
        "specQuestions.0.question", "specQuestions.0.choices.0",
    }
    assert all(event["provisional"] for event in events)
    assert not any("private-id" in event["text"] or "hidden" in event["text"] for event in events)


async def test_first_direction_call_streams_previews_but_rejects_incomplete_final_output(
    original_runtime, monkeypatch
):
    from novelvideo.director import dispatch, writing

    plan = grant(original_runtime)
    assert plan["phase"] == "EXEC"
    with original_runtime[0]._connect() as db:
        run_id = original_runtime[3].list_operations(original_runtime[1])[0]["id"]
        snapshot = original_runtime[3].snapshot(db, run_id)
    assert snapshot["parameters"]["stream"] is True
    raw_value = output_for(original_runtime, "M03")
    raw_value["options"][3].pop("obstacle")
    raw = json.dumps(raw_value, ensure_ascii=False)

    async def model(*args, response_format, on_delta):
        assert response_format == snapshot["parameters"]["response_format"]
        for position in range(0, len(raw), 29):
            await on_delta(raw[position:position + 29])
        return writing.WritingResult(raw, 100, 200, 1, "stop", "test-model")

    monkeypatch.setattr(dispatch, "run_bounded_outline_model", model)
    await dispatch_planning(original_runtime[3], original_runtime[1])
    events = original_runtime[3].events(original_runtime[1])["events"]
    assert any(e["type"] == "model.started" and e["payload"]["stream"] for e in events)
    assert any(e["type"] == "outline.section.preview" and
               e["payload"]["blockKey"] == "options.0.logline" for e in events)
    assert not any(e["type"] == "text.delta" for e in events)
    state = original_runtime[-1].projection(original_runtime[1])
    assert state["phase"] == "FAILED_RECOVERABLE"
    assert not state["artifacts"].get("M03")


@pytest.mark.parametrize("disconnect", [False, True])
async def test_structured_dispatch_preserves_schema_and_partial_bytes(runtime, monkeypatch, disconnect):
    from novelvideo.director import dispatch, writing

    await start(runtime, [])
    await dispatch_planning(runtime[3], runtime[1], provider(runtime, []))
    decide(runtime, "adopt")
    quote = execute(runtime, {"type": "cost.quote", "kind": "outline", "instruction": "Clarify two passages."})
    assert quote["parameters"]["stream"]
    run = execute(runtime, {"type": "approval.grant", "quoteId": quote["quoteId"],
                           "requestHash": quote["requestHash"], "unknownCostConsent": True})
    with runtime[0]._connect() as db:
        snapshot = runtime[3].snapshot(db, run["id"])
    raw = json.dumps(patch_value(snapshot))

    async def model(*args, response_format, on_delta):
        assert response_format == snapshot["parameters"]["response_format"]
        for position in range(0, len(raw), 17):
            await on_delta(raw[position:position + 17])
            assert runtime[0].get_document(runtime[1], "outline")["version"] == 1
            if disconnect and position > len(raw) / 2:
                raise ConnectionError("A synthetic transport failure")
        return writing.WritingResult(raw, 100, 200, 1, "stop", "test-model")

    monkeypatch.setattr(dispatch, "run_bounded_outline_model", model)
    result = await dispatch.dispatch_writing(runtime[3], runtime[1], run["id"])
    assert result["status"] == ("unknown" if disconnect else "succeeded")
    retained = runtime[3].retained_result(runtime[1], run["id"])
    assert raw.startswith(retained["output"])
    assert result["response"].get("partial", False) == disconnect
    events = runtime[3].events(runtime[1])["events"]
    assert any(e["type"] == "outline.section.preview" for e in events)
    assert not any(e["type"] == "text.delta" for e in events)
    assert runtime[0].get_document(runtime[1], "outline")["version"] == 1
