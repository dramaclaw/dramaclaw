"""Hermes ACP shape knowledge stays in the adapter; the application reads stamped flags."""

from __future__ import annotations

import re
from pathlib import Path

from novelvideo.chat import (
    display_fallback,
    hermes_events,
    hermes_sdk,
    media_presentation,
    presentation_mapping,
    presentation_text,
    runtime_event_evidence,
    runtime_event_mapper,
    service,
)
from novelvideo.chat.runtime_port import ChatBackendEvent

_ACP_SHAPE = re.compile(r"sessionUpdate|toolCallId|rawInput|rawOutput")


def _thread(tmp_path) -> hermes_sdk.HermesSdkThread:
    return hermes_sdk.HermesSdkThread(
        cli_path=tmp_path / "hermes",
        cwd=tmp_path,
        env={},
        model=None,
        username="local",
        session_id="session-1",
    )


def _update(thread, update: dict, names: dict[str, str] | None = None):
    return thread._translate_notification(
        {"method": "session/update", "params": {"update": update}},
        "turn-1",
        tool_name_by_call_id=names,
    )


def test_application_modules_do_not_mention_acp_shapes() -> None:
    for module in (
        service,
        runtime_event_evidence,
        runtime_event_mapper,
        presentation_mapping,
        presentation_text,
        media_presentation,
        display_fallback,
    ):
        source = Path(module.__file__).read_text(encoding="utf-8")
        assert not _ACP_SHAPE.search(source), module.__name__


def test_service_reads_stamped_flags_instead_of_raw_predicates() -> None:
    source = Path(service.__file__).read_text(encoding="utf-8")
    body = "\n".join(
        line for line in source.splitlines() if not line.lstrip().startswith("_is_")
    )
    for legacy in (
        "_is_anonymous_hermes_tool_call_update(",
        "_is_hermes_lifecycle_tool_update(",
        "_suppress_freezone_tool_lifecycle_error(",
        'raw.get("reason")',
    ):
        assert legacy not in body, legacy
    for stamped in ("lifecycle_only", "transient_failure", '"guard"', "native_kind"):
        assert stamped in source, stamped


def test_port_defaults_are_neutral() -> None:
    event = ChatBackendEvent(type="tool_updated")
    assert event.native_kind is None
    assert event.lifecycle_only is False
    assert event.transient_failure is False
    assert event.guard is None


def test_adapter_marks_tool_start_as_lifecycle_only(tmp_path) -> None:
    started = _update(
        _thread(tmp_path),
        {
            "sessionUpdate": "tool_call",
            "toolCallId": "tc-1",
            "title": "freezone_get_canvas_context",
        },
    )
    assert started.type == "tool_started"
    assert started.native_kind == "tool_call"
    assert started.lifecycle_only is True
    assert started.transient_failure is False


def test_adapter_marks_status_ping_and_anonymous_update_as_lifecycle_only(
    tmp_path,
) -> None:
    thread = _thread(tmp_path)
    _update(
        thread, {"sessionUpdate": "tool_call", "toolCallId": "tc-1", "title": "read"}
    )
    ping = _update(
        thread,
        {
            "sessionUpdate": "tool_call_update",
            "toolCallId": "tc-1",
            "status": "in_progress",
        },
    )
    assert ping.lifecycle_only is True

    anonymous = _update(
        _thread(tmp_path),
        {
            "sessionUpdate": "tool_call_update",
            "toolCallId": "tc-unknown",
            "status": "failed",
        },
    )
    assert anonymous.name is None
    assert anonymous.lifecycle_only is True


def test_adapter_keeps_result_bearing_update_visible(tmp_path) -> None:
    thread = _thread(tmp_path)
    _update(
        thread, {"sessionUpdate": "tool_call", "toolCallId": "tc-1", "title": "read"}
    )
    done = _update(
        thread,
        {
            "sessionUpdate": "tool_call_update",
            "toolCallId": "tc-1",
            "status": "completed",
            "content": [{"type": "content", "content": {"type": "text", "text": "ok"}}],
        },
    )
    assert done.lifecycle_only is False
    assert done.transient_failure is False
    assert done.native_kind == "tool_call_update"


def test_adapter_marks_payload_less_and_bridge_settled_failures_transient(
    tmp_path,
) -> None:
    thread = _thread(tmp_path)
    _update(
        thread,
        {
            "sessionUpdate": "tool_call",
            "toolCallId": "tc-1",
            "title": "freezone_emit_canvas_command",
        },
    )
    bare = _update(
        thread,
        {"sessionUpdate": "tool_call_update", "toolCallId": "tc-1", "status": "failed"},
    )
    assert bare.transient_failure is True

    bridge_payload = (
        '{"ok": false, "tool_call_status": "failed", "canvas_apply_status": "failed", '
        '"user_message": "节点动作完成但未产出 imageUrl。"}'
    )
    settled = _update(
        thread,
        {
            "sessionUpdate": "tool_call_update",
            "toolCallId": "tc-1",
            "status": "failed",
            "content": [
                {"type": "content", "content": {"type": "text", "text": bridge_payload}}
            ],
        },
    )
    assert settled.transient_failure is True

    business = _update(
        thread,
        {
            "sessionUpdate": "tool_call_update",
            "toolCallId": "tc-1",
            "status": "failed",
            "result": {"status": "failed", "error": "前端桥接执行失败"},
        },
    )
    assert business.transient_failure is False


def test_legacy_entrypoints_delegate_to_hermes_events() -> None:
    update = {
        "sessionUpdate": "tool_call_update",
        "toolCallId": "tc-1",
        "status": "failed",
    }
    assert presentation_mapping._suppress_freezone_tool_lifecycle_error(
        update, tool_mode="freezone_canvas"
    )
    assert not presentation_mapping._suppress_freezone_tool_lifecycle_error(
        update, tool_mode="default"
    )
    assert hermes_events.is_transient_tool_failure(update)
    assert not hermes_events.is_transient_tool_failure({"sessionUpdate": "tool_call"})
    assert not hermes_events.is_lifecycle_only_tool_update(
        "done", {"sessionUpdate": "plan"}
    )
