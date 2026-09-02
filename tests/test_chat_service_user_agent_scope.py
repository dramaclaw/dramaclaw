import asyncio
import json
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace

import pytest

from novelvideo.api.routes import chat as chat_routes
from novelvideo.chat import backend_sdk
from novelvideo.chat import hermes_sdk
from novelvideo.chat import service as chat_service
from novelvideo.chat.store import ChatScope, chat_store


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.mark.anyio
async def test_human_billing_confirmation_phrase_issues_trusted_context(
    monkeypatch, tmp_path
):
    seen = {}

    def fake_confirm(**kwargs):
        seen.update(kwargs)
        return {
            "quote_id": "billing_quote_a",
            "receipt": "billing_receipt_a",
            "operation_kind": "workflow_planning_create",
            "expires_at": 9999999999,
        }

    monkeypatch.setattr(chat_routes, "confirm_billing_quote", fake_confirm)
    result = await chat_routes._trusted_billing_confirmation_for_message(
        project_ctx=SimpleNamespace(
            state_dir=tmp_path,
            requester_user_id="user-a",
            project_id="project-a",
        ),
        user={"id": "user-a", "credential_kind": "browser_session"},
        scope=ChatScope(
            kind="project",
            id="project-a",
            surface="freezone",
            canvas_id="canvas-a",
        ),
        display_text="确认规划费用 billing_quote_a",
        surface_context=None,
    )

    assert result == {
        "quote_id": "billing_quote_a",
        "confirmation_receipt": "billing_receipt_a",
        "operation_kind": "workflow_planning_create",
        "expires_at": 9999999999,
    }
    assert seen["user_id"] == "user-a"
    assert seen["project_id"] == "project-a"
    assert seen["canvas_id"] == "canvas-a"
    assert seen["quote_id"] == "billing_quote_a"
    assert seen["expected_operation_kind"] == "workflow_planning_create"


@pytest.mark.anyio
@pytest.mark.parametrize(
    ("message", "credential_kind"),
    [
        ("确认规划费用。", "browser_session"),
        ("确认规划费用", "agent_session"),
        ("确认规划费用", "local_trusted_agent"),
    ],
)
async def test_untrusted_or_inexact_billing_confirmation_does_not_issue_receipt(
    monkeypatch, tmp_path, message, credential_kind
):
    monkeypatch.setattr(
        chat_routes,
        "confirm_billing_quote",
        lambda **_kwargs: pytest.fail("must not confirm a quote"),
    )

    result = await chat_routes._trusted_billing_confirmation_for_message(
        project_ctx=SimpleNamespace(
            state_dir=tmp_path,
            requester_user_id="user-a",
            project_id="project-a",
        ),
        user={"id": "user-a", "credential_kind": credential_kind},
        scope=ChatScope(
            kind="project",
            id="project-a",
            surface="freezone",
            canvas_id="canvas-a",
        ),
        display_text=message,
        surface_context=None,
    )

    assert result is None


def test_chat_visible_text_redacts_local_filesystem_paths():
    content = (
        "前端目录 ~/Works/supertale-fe，"
        "后端目录 /Users/tao/Works/SuperTale/state/admin/.hermes。"
    )

    redacted = chat_service._redact_local_filesystem_paths(content)

    assert "~/Works/supertale-fe" not in redacted
    assert "/Users/tao/Works/SuperTale" not in redacted
    assert redacted.count("[本地路径]") == 2


def test_mainline_script_creation_still_requires_uploaded_script():
    prompt = "请创建一个30秒悬疑短剧工作流，生成完整脚本和分镜方案"

    routed = chat_service._script_creation_model_reply_prompt(
        prompt,
        tool_mode="default",
    )

    assert routed is not None
    assert "虾料" in routed


def test_freezone_workflow_can_expand_an_idea_into_script_nodes():
    prompt = "请创建一个30秒悬疑短剧工作流，生成完整脚本和分镜方案"

    routed = chat_service._script_creation_model_reply_prompt(
        prompt,
        tool_mode="freezone_canvas",
    )

    assert routed is None


@pytest.mark.anyio
async def test_hermes_session_load_null_result_falls_back_to_new_session(
    tmp_path, monkeypatch
):
    thread = hermes_sdk.HermesSdkThread(
        cli_path=tmp_path / "hermes",
        cwd=tmp_path,
        env={},
        model=None,
        username="local",
        session_id="stale-session",
    )
    sent_methods: list[str] = []

    async def fake_send(method: str, params: dict) -> int:  # noqa: ARG001
        sent_methods.append(method)
        return len(sent_methods)

    responses = iter(
        [
            ({"id": 1, "result": None}, []),
            ({"id": 2, "result": {"sessionId": "fresh-session"}}, []),
        ]
    )

    async def fake_read_until_id(target_id: int, timeout: float):  # noqa: ARG001
        return next(responses)

    monkeypatch.setattr(thread, "_send", fake_send)
    monkeypatch.setattr(thread, "_read_until_id", fake_read_until_id)

    await thread._ensure_session()

    assert sent_methods == ["session/load", "session/new"]
    assert thread.id == "fresh-session"


@pytest.mark.anyio
async def test_hermes_session_load_result_keeps_resumed_session(tmp_path, monkeypatch):
    thread = hermes_sdk.HermesSdkThread(
        cli_path=tmp_path / "hermes",
        cwd=tmp_path,
        env={},
        model=None,
        username="local",
        session_id="existing-session",
    )
    sent_methods: list[str] = []

    async def fake_send(method: str, params: dict) -> int:  # noqa: ARG001
        sent_methods.append(method)
        return len(sent_methods)

    async def fake_read_until_id(target_id: int, timeout: float):  # noqa: ARG001
        return {"id": target_id, "result": {"models": {}}}, []

    monkeypatch.setattr(thread, "_send", fake_send)
    monkeypatch.setattr(thread, "_read_until_id", fake_read_until_id)

    await thread._ensure_session()

    assert sent_methods == ["session/load"]


@pytest.mark.anyio
async def test_hermes_thread_serializes_concurrent_prompt_streams(
    tmp_path, monkeypatch
):
    thread = hermes_sdk.HermesSdkThread(
        cli_path=tmp_path / "hermes",
        cwd=tmp_path,
        env={},
        model=None,
        username="local",
        session_id="existing-session",
    )
    entered: list[str] = []
    first_entered = asyncio.Event()
    release_first = asyncio.Event()

    async def fake_stream_turn(
        prompt: str,
        *,
        current_project=None,  # noqa: ARG001
        trajectory_id=None,  # noqa: ARG001
        project_id=None,  # noqa: ARG001
        gateway_api_key=None,  # noqa: ARG001
    ):
        entered.append(prompt)
        if prompt == "first":
            first_entered.set()
            await release_first.wait()
        yield backend_sdk.ChatBackendEvent(type="complete", text=prompt)

    async def collect(prompt: str):
        return [event async for event in thread.stream(prompt)]

    monkeypatch.setattr(thread, "_stream_turn", fake_stream_turn)
    first_task = asyncio.create_task(collect("first"))
    await first_entered.wait()
    second_task = asyncio.create_task(collect("second"))
    await asyncio.sleep(0)

    assert entered == ["first"]

    release_first.set()
    first_events, second_events = await asyncio.gather(first_task, second_task)

    assert entered == ["first", "second"]
    assert first_events[-1].text == "first"
    assert second_events[-1].text == "second"
    assert thread.id == "existing-session"


def test_completion_notice_appends_without_replacing_existing_reply():
    existing = "我已经检查完前置条件，下一步会启动第 1 个任务。"
    notice = (
        "当前任务已开始处理。请稍后让我查看当前任务进度，或在任务完成后再继续下一步。"
    )

    merged = chat_service._completion_text_or_existing(notice, existing)

    assert merged.startswith(existing)
    assert notice in merged


def test_canvas_context_tool_result_infers_missing_status():
    payload = chat_routes.CanvasContextToolResultIn.model_validate(
        {
            "bridge_key": "bridge-a",
            "tool_call_status": "completed",
            "ok": True,
            "responses": [],
            "errors": [],
        }
    )

    assert payload.canvas_context_status is None


def test_hermes_tool_call_update_keeps_tool_call_id_attribution(tmp_path):
    thread = hermes_sdk.HermesSdkThread(
        cli_path=tmp_path / "hermes",
        cwd=tmp_path,
        env={},
        model=None,
        username="local",
        session_id="session-1",
    )
    tool_names: dict[str, str] = {}

    started = thread._translate_notification(
        {
            "method": "session/update",
            "params": {
                "update": {
                    "sessionUpdate": "tool_call",
                    "toolCallId": "tc-list",
                    "title": "freezone_get_workflow_skill",
                }
            },
        },
        "turn-1",
        tool_name_by_call_id=tool_names,
    )
    unrelated_failed = thread._translate_notification(
        {
            "method": "session/update",
            "params": {
                "update": {
                    "sessionUpdate": "tool_call_update",
                    "toolCallId": "tc-skill-view",
                    "status": "failed",
                    "content": [
                        {
                            "type": "content",
                            "content": {
                                "type": "text",
                                "text": "Skill view failed: Skill 'freezone:freezone' not found.",
                            },
                        }
                    ],
                }
            },
        },
        "turn-1",
        tool_name_by_call_id=tool_names,
    )
    completed = thread._translate_notification(
        {
            "method": "session/update",
            "params": {
                "update": {
                    "sessionUpdate": "tool_call_update",
                    "toolCallId": "tc-list",
                    "status": "completed",
                }
            },
        },
        "turn-1",
        tool_name_by_call_id=tool_names,
    )

    assert started is not None
    assert started.name == "freezone_get_workflow_skill"
    assert unrelated_failed is not None
    assert unrelated_failed.name is None
    assert completed is not None
    assert completed.name == "freezone_get_workflow_skill"


def test_hermes_tool_call_update_preserves_content_as_output(tmp_path):
    thread = hermes_sdk.HermesSdkThread(
        cli_path=tmp_path / "hermes",
        cwd=tmp_path,
        env={},
        model=None,
        username="local",
        session_id="session-1",
    )
    tool_names = {"tc-list": "freezone_get_workflow_skill"}

    result = thread._translate_notification(
        {
            "method": "session/update",
            "params": {
                "update": {
                    "sessionUpdate": "tool_call_update",
                    "toolCallId": "tc-list",
                    "status": "completed",
                    "content": [
                        {
                            "type": "content",
                            "content": {
                                "type": "text",
                                "text": '{"skills":[{"id":"pixar-ip-brand-ad"}]}',
                            },
                        }
                    ],
                }
            },
        },
        "turn-1",
        tool_name_by_call_id=tool_names,
    )

    assert result is not None
    assert result.type == "tool_updated"
    assert result.name == "freezone_get_workflow_skill"
    assert result.status == "completed"
    assert result.output == [
        {
            "type": "content",
            "content": {
                "type": "text",
                "text": '{"skills":[{"id":"pixar-ip-brand-ad"}]}',
            },
        }
    ]


def test_hermes_tool_call_update_attaches_recent_freezone_structured_result(tmp_path):
    result_dir = tmp_path / "freezone-tool-results"
    result_dir.mkdir()
    payload = {
        "tool_name": "freezone_get_workflow_skill",
        "created_at": datetime.now(tz=timezone.utc).timestamp(),
        "result": {"ok": True, "skills": [{"id": "pixar-ip-brand-ad"}]},
    }
    (result_dir / "freezone_get_workflow_skill-1-2.json").write_text(
        json.dumps(payload, ensure_ascii=False),
        encoding="utf-8",
    )
    thread = hermes_sdk.HermesSdkThread(
        cli_path=tmp_path / "hermes",
        cwd=tmp_path,
        env={"DRAMACLAW_FREEZONE_TOOL_RESULT_DIR": str(result_dir)},
        model=None,
        username="local",
        session_id="session-1",
    )
    tool_names = {"tc-list": "freezone_get_workflow_skill"}

    result = thread._translate_notification(
        {
            "method": "session/update",
            "params": {
                "update": {
                    "sessionUpdate": "tool_call_update",
                    "toolCallId": "tc-list",
                    "status": "completed",
                    "content": {
                        "text": "freezone_get_workflow_skill result\n- **count:** 1"
                    },
                }
            },
        },
        "turn-1",
        tool_name_by_call_id=tool_names,
    )

    assert result is not None
    assert result.type == "tool_updated"
    assert result.name == "freezone_get_workflow_skill"
    assert result.status == "completed"
    assert result.output == {
        "text": "freezone_get_workflow_skill result\n- **count:** 1"
    }
    assert result.structured == {"ok": True, "skills": [{"id": "pixar-ip-brand-ad"}]}


def test_anonymous_hermes_tool_call_update_is_not_user_visible():
    event = SimpleNamespace(
        name=None,
        raw={
            "sessionUpdate": "tool_call_update",
            "toolCallId": "tc-skill-view",
            "status": "failed",
        },
    )

    assert chat_service._is_anonymous_hermes_tool_call_update(event)


def test_hermes_lifecycle_tool_updates_are_not_user_visible():
    events = [
        SimpleNamespace(
            name="freezone_get_workflow_skill",
            text="",
            raw={"sessionUpdate": "tool_call"},
        ),
        SimpleNamespace(
            name="freezone_get_workflow_skill",
            text="completed",
            raw={"sessionUpdate": "tool_call_update", "status": "completed"},
        ),
    ]

    assert all(chat_service._is_hermes_lifecycle_tool_update(event) for event in events)


def test_infer_display_tool_call_recovers_sketch_display_promise():
    inferred = chat_service._infer_display_tool_call_from_text(
        "全部显示",
        "我来为您显示全部37个beat的草图。正在为您展示第1集前12个beat的草图：",
        [],
    )

    assert inferred == ("dramaclaw_get_sketches", {"episode": 1})


def test_infer_display_tool_call_uses_recent_context_for_short_reply():
    inferred = chat_service._infer_display_tool_call_from_text(
        "全部显示",
        "正在为您展示前12个。",
        ["如果您需要查看全部37个草图，我可以分页显示。"],
    )

    assert inferred == ("dramaclaw_get_sketches", {"episode": 1})


def test_infer_display_tool_call_ignores_progress_status_language():
    inferred = chat_service._infer_display_tool_call_from_text(
        "进度怎样了",
        "当前进度如下：草图生成已完成，下面展示进度表。",
        ["如果您需要查看全部37个草图，我可以分页显示。"],
    )

    assert inferred is None


def test_infer_display_tool_call_requires_user_sketch_display_intent():
    inferred = chat_service._infer_display_tool_call_from_text(
        "看一下第2集草图",
        "正在为您展示第2集草图。",
        [],
    )

    assert inferred == ("dramaclaw_get_sketches", {"episode": 2})


def test_infer_display_tool_call_uses_sketch_candidate_tool_for_pool_terms():
    inferred = chat_service._infer_display_tool_call_from_text(
        "看第1集 Beat 3 的草图候选池",
        "正在为您展示 Beat 3 的草图候选。",
        [],
    )

    assert inferred == ("dramaclaw_get_sketch_candidates", {"episode": 1, "beat": 3})


def test_extract_display_tool_call_uses_named_tool_field():
    inferred = chat_service._extract_display_tool_call(
        {
            "sessionUpdate": "tool_call",
            "title": "tool",
            "name": "dramaclaw_get_sketches",
            "content": [
                {
                    "type": "content",
                    "content": {"type": "text", "text": '{"episode": 1}'},
                }
            ],
        }
    )

    assert inferred == ("dramaclaw_get_sketches", {"episode": 1})


def test_backend_api_get_default_uses_ipv4_loopback(monkeypatch):
    seen = {}

    class FakeResponse:
        status = 200

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return None

        def read(self):
            return b'{"ok":true}'

    def fake_urlopen(req, timeout):
        seen["url"] = req.full_url
        return FakeResponse()

    monkeypatch.delenv("DRAMACLAW_API_URL", raising=False)
    monkeypatch.delenv("SUPERTALE_API_URL", raising=False)
    monkeypatch.delenv("NOVELVIDEO_API_URL", raising=False)
    monkeypatch.setenv("NOVELVIDEO_API_PORT", "8780")
    monkeypatch.setattr(chat_service, "urlopen", fake_urlopen)

    assert chat_service._backend_api_get("/api/v1/config", "token") == {"ok": True}
    assert seen["url"] == "http://127.0.0.1:8780/api/v1/config"


def test_backend_api_get_ignores_stale_legacy_supertale_url(monkeypatch):
    seen = {}

    class FakeResponse:
        status = 200

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return None

        def read(self):
            return b'{"ok":true}'

    def fake_urlopen(req, timeout):
        seen["url"] = req.full_url
        return FakeResponse()

    monkeypatch.delenv("DRAMACLAW_API_URL", raising=False)
    monkeypatch.delenv("NOVELVIDEO_API_URL", raising=False)
    monkeypatch.setenv("SUPERTALE_API_URL", "http://localhost:7860")
    monkeypatch.setenv("NOVELVIDEO_API_PORT", "8780")
    monkeypatch.setattr(chat_service, "urlopen", fake_urlopen)

    assert chat_service._backend_api_get("/api/v1/config", "token") == {"ok": True}
    assert seen["url"] == "http://127.0.0.1:8780/api/v1/config"


@pytest.mark.anyio
async def test_append_chat_notification_persists_project_assistant_message(
    monkeypatch, tmp_path
):
    seen = {}

    async def fake_project_context(user, scope):
        seen["scope"] = scope
        return SimpleNamespace(
            output_dir=tmp_path / "out", state_dir=tmp_path / "state"
        )

    def fake_add_assistant_message(
        username,
        project,
        content,
        media=None,
        *,
        project_dir=None,
        project_state_dir=None,
    ):
        seen.update(
            {
                "username": username,
                "project": project,
                "content": content,
                "project_dir": project_dir,
                "project_state_dir": project_state_dir,
            }
        )
        return {"id": "1", "role": "assistant", "content": content}

    monkeypatch.setattr(chat_routes, "_project_context_for_scope", fake_project_context)
    monkeypatch.setattr(
        chat_routes.chat_service,
        "add_assistant_message",
        fake_add_assistant_message,
    )

    result = await chat_routes.append_chat_notification(
        chat_routes.ChatNotificationIn(
            scope=chat_routes.ChatScopePayload(kind="project", id="demo"),
            text="  任务已完成。  ",
        ),
        user={"username": "alice"},
    )

    assert result == {
        "ok": True,
        "data": {"id": "1", "role": "assistant", "content": "任务已完成。"},
    }
    assert seen["username"] == "alice"
    assert seen["project"] == "demo"
    assert seen["content"] == "任务已完成。"
    assert seen["project_dir"] == tmp_path / "out"
    assert seen["project_state_dir"] == tmp_path / "state"


@pytest.mark.anyio
async def test_deterministic_stream_redacts_local_paths(monkeypatch, tmp_path):
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(tmp_path / "state"))
    monkeypatch.setenv("NOVELVIDEO_OUTPUT_DIR", str(tmp_path / "output"))
    events = []

    async def on_event(event):
        events.append(event)

    message = await chat_service._stream_deterministic_assistant_reply(
        "admin",
        "project-a",
        "临时路径：~/Works/supertale-fe/src",
        on_event,
    )

    assert "~/Works/supertale-fe" not in message["content"]
    assert message["content"] == "临时路径：[本地路径]"
    assert events[0]["type"] == "assistant_delta"
    assert events[0]["text"] == "临时路径：[本地路径]"


@pytest.mark.anyio
async def test_fallback_display_does_not_use_pool_sketch_as_current_sketch(
    monkeypatch,
    tmp_path,
):
    project_dir = tmp_path / "project"
    sketch_dir = project_dir / "grids" / "ep001" / "sketch"
    sketch_dir.mkdir(parents=True)
    (sketch_dir / "beat_01_t123.png").write_bytes(b"fake")

    monkeypatch.setattr(
        chat_service,
        "_backend_api_get",
        lambda path, token: {
            "ok": True,
            "beats": [
                {
                    "beat_number": 1,
                    "sketch_url": "",
                    "frame_url": "",
                }
            ],
        },
    )

    specs = await chat_service._fallback_display_tool_ui_specs(
        "admin",
        "project-a",
        "dramaclaw_get_sketches",
        {"episode": 1},
        token="token",
        project_dir=project_dir,
    )

    assert specs == []


@pytest.mark.anyio
async def test_fallback_display_prefers_api_project_id(monkeypatch):
    seen_paths = []

    def fake_backend_api_get(path, token):
        seen_paths.append(path)
        return {
            "ok": True,
            "beats": [
                {
                    "beat_number": 1,
                    "sketch_url": "/static/projects/api-project/sketch.png?v=1",
                    "frame_url": "",
                }
            ],
        }

    monkeypatch.setattr(chat_service, "_backend_api_get", fake_backend_api_get)

    specs = await chat_service._fallback_display_tool_ui_specs(
        "local",
        "chat-scope",
        "dramaclaw_get_sketches",
        {"episode": 1, "project_id": "api-project"},
        token="token",
    )

    assert seen_paths == ["/api/v1/projects/api-project/episodes/1/beats"]
    assert len(specs) == 1
    root = specs[0]["root"]
    first_child = specs[0]["elements"][root]["children"][0]
    assert (
        specs[0]["elements"][first_child]["props"]["src"]
        == "/static/projects/api-project/sketch.png?v=1"
    )


@pytest.mark.anyio
async def test_fallback_display_groups_all_final_videos_into_one_spec(monkeypatch):
    seen_paths = []

    def fake_backend_api_get(path, token):
        seen_paths.append(path)
        if path.endswith("/episodes"):
            return {"ok": True, "data": [{"number": 1}, {"number": 2}, {"number": 3}]}
        episode = int(path.split("/")[-2])
        return {
            "ok": True,
            "data": {
                "exists": True,
                "video_url": f"/static/projects/api-project/ep{episode:03d}.mp4",
            },
        }

    monkeypatch.setattr(chat_service, "_backend_api_get", fake_backend_api_get)

    specs = await chat_service._fallback_display_tool_ui_specs(
        "local",
        "chat-scope",
        "dramaclaw_get_final_video",
        {"project_id": "api-project"},
        token="token",
    )

    assert len(specs) == 1
    root = specs[0]["root"]
    assert len(specs[0]["elements"][root]["children"]) == 3
    assert seen_paths == [
        "/api/v1/projects/api-project/episodes",
        "/api/v1/projects/api-project/episodes/1/final",
        "/api/v1/projects/api-project/episodes/2/final",
        "/api/v1/projects/api-project/episodes/3/final",
    ]


@pytest.mark.anyio
@pytest.mark.parametrize(
    ("tool_name", "asset_path"),
    [
        ("dramaclaw_get_scene_images", "scenes"),
        ("dramaclaw_get_character_media", "characters"),
    ],
)
async def test_asset_display_tools_request_authoritative_media_details(
    monkeypatch, tool_name, asset_path
):
    seen_paths = []

    def fake_backend_api_get(path, token):
        seen_paths.append(path)
        return {"ok": True, "data": []}

    monkeypatch.setattr(chat_service, "_backend_api_get", fake_backend_api_get)

    await chat_service._fallback_display_tool_ui_specs(
        "admin",
        "project-a",
        tool_name,
        {},
        token="token",
    )

    assert seen_paths == [f"/api/v1/projects/project-a/{asset_path}?summary=false"]


def test_codex_sessions_are_project_scoped_and_backend_independent(
    monkeypatch, tmp_path
):
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(tmp_path / "state"))
    monkeypatch.setenv("NOVELVIDEO_OUTPUT_DIR", str(tmp_path / "output"))

    chat_service._set_claude_session_id("admin", "project-a", "claude-session-1")
    assert (
        chat_service._get_claude_session_id("admin", "project-b") == "claude-session-1"
    )
    assert chat_service._get_codex_thread_id("admin", "project-b") is None

    chat_service._set_codex_thread_id("admin", "project-a", "codex-thread-1")
    assert chat_service._get_claude_session_id("admin", "project-b") == (
        "claude-session-1"
    )
    assert chat_service._get_codex_thread_id("admin", "project-a") == ("codex-thread-1")
    assert chat_service._get_codex_thread_id("admin", "project-b") is None

    chat_service._set_codex_thread_id("admin", "project-b", "codex-thread-2")
    chat_service._set_codex_thread_id("admin", "", "codex-home-thread")
    assert chat_service._get_codex_thread_id("admin", "project-a") == ("codex-thread-1")
    assert chat_service._get_codex_thread_id("admin", "project-b") == ("codex-thread-2")
    assert chat_service._get_codex_thread_id("admin", "") == "codex-home-thread"

    state_file = tmp_path / "state" / "admin" / "agent_sessions.json"
    assert state_file.exists()
    home_state_file = tmp_path / "state" / "admin" / "codex_sessions.json"
    assert json.loads(home_state_file.read_text(encoding="utf-8")) == {
        "home": "codex-home-thread",
    }
    for project, thread_id in (
        ("project-a", "codex-thread-1"),
        ("project-b", "codex-thread-2"),
    ):
        project_state_file = (
            tmp_path
            / "state"
            / "admin"
            / project
            / "agents"
            / "codex"
            / "sessions.json"
        )
        assert json.loads(project_state_file.read_text(encoding="utf-8")) == {
            f"project:{project}": thread_id,
        }


def test_codex_freezone_threads_are_canvas_and_agent_scoped(monkeypatch, tmp_path):
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(tmp_path / "state"))

    scope = {
        "agent_profile": "freezone:agent-1",
        "canvas_id": "canvas-a",
    }
    chat_service._set_codex_thread_id("admin", "project-a", "thread-canvas-a", **scope)
    chat_service._set_codex_thread_id(
        "admin",
        "project-a",
        "thread-canvas-b",
        agent_profile="freezone:agent-1",
        canvas_id="canvas-b",
    )
    chat_service._set_codex_thread_id(
        "admin",
        "project-a",
        "thread-agent-2",
        agent_profile="freezone:agent-2",
        canvas_id="canvas-a",
    )

    assert (
        chat_service._get_codex_thread_id("admin", "project-a", **scope)
        == "thread-canvas-a"
    )
    assert (
        chat_service._get_codex_thread_id(
            "admin",
            "project-a",
            agent_profile="freezone:agent-1",
            canvas_id="canvas-b",
        )
        == "thread-canvas-b"
    )
    assert (
        chat_service._get_codex_thread_id(
            "admin",
            "project-a",
            agent_profile="freezone:agent-2",
            canvas_id="canvas-a",
        )
        == "thread-agent-2"
    )
    assert chat_service._get_codex_thread_id("admin", "project-a") is None

    state_file = (
        tmp_path
        / "state"
        / "admin"
        / "project-a"
        / "agents"
        / "codex"
        / "sessions.json"
    )
    protocol = chat_service._CODEX_FREEZONE_THREAD_PROTOCOL_VERSION
    assert json.loads(state_file.read_text(encoding="utf-8")) == {
        f'["freezone:agent-1","project","project-a","canvas-a","{protocol}"]': (
            "thread-canvas-a"
        ),
        f'["freezone:agent-1","project","project-a","canvas-b","{protocol}"]': (
            "thread-canvas-b"
        ),
        f'["freezone:agent-2","project","project-a","canvas-a","{protocol}"]': (
            "thread-agent-2"
        ),
    }


def test_codex_freezone_protocol_upgrade_does_not_resume_legacy_thread(
    monkeypatch, tmp_path
):
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(tmp_path / "state"))
    state_file = (
        tmp_path
        / "state"
        / "admin"
        / "project-a"
        / "agents"
        / "codex"
        / "sessions.json"
    )
    state_file.parent.mkdir(parents=True)
    state_file.write_text(
        json.dumps(
            {'["freezone:main","project","project-a","canvas-a"]': ("legacy-thread")}
        ),
        encoding="utf-8",
    )

    assert (
        chat_service._get_codex_thread_id(
            "admin",
            "project-a",
            agent_profile="freezone:main",
            canvas_id="canvas-a",
        )
        is None
    )


def test_codex_main_thread_key_stays_backward_compatible():
    assert chat_service._codex_scope_key("project-a") == "project:project-a"
    assert (
        chat_service._codex_scope_key("project-a", canvas_id="ignored-canvas")
        == "project:project-a"
    )
    assert chat_service._codex_scope_key("") == "home"


@pytest.mark.anyio
async def test_codex_canvas_archive_removes_only_matching_scope(monkeypatch, tmp_path):
    project_state = tmp_path / "project-state"
    sessions = project_state / "agents" / "codex" / "sessions.json"
    sessions.parent.mkdir(parents=True)
    canvas_a = chat_service._codex_scope_key(
        "project-a", agent_profile="freezone:main", canvas_id="canvas-a"
    )
    canvas_b = chat_service._codex_scope_key(
        "project-a", agent_profile="freezone:main", canvas_id="canvas-b"
    )
    canvas_a_agent_2 = chat_service._codex_scope_key(
        "project-a", agent_profile="freezone:agent-2", canvas_id="canvas-a"
    )
    mainline = chat_service._codex_scope_key("project-a")
    sessions.write_text(
        json.dumps(
            {
                canvas_a: "thread-a",
                canvas_a_agent_2: "thread-agent-2",
                canvas_b: "thread-b",
                mainline: "thread-mainline",
            }
        ),
        encoding="utf-8",
    )
    calls = []
    monkeypatch.setattr(
        chat_service,
        "_control_codex_thread",
        lambda operation, thread_id, turn_id=None: calls.append(
            (operation, thread_id, turn_id)
        )
        or True,
    )

    count = await chat_service.archive_codex_canvas_threads(
        "admin", "project-a", "canvas-a", project_state_dir=project_state
    )

    assert count == 2
    assert calls == [
        ("archive", "thread-a", None),
        ("archive", "thread-agent-2", None),
    ]
    assert json.loads(sessions.read_text(encoding="utf-8")) == {
        canvas_b: "thread-b",
        mainline: "thread-mainline",
    }


@pytest.mark.anyio
async def test_codex_project_delete_covers_unique_threads(monkeypatch, tmp_path):
    project_state = tmp_path / "project-state"
    sessions = project_state / "agents" / "codex" / "sessions.json"
    sessions.parent.mkdir(parents=True)
    sessions.write_text(
        json.dumps(
            {
                chat_service._codex_scope_key("project-a"): "thread-mainline",
                chat_service._codex_scope_key(
                    "project-a",
                    agent_profile="freezone:main",
                    canvas_id="canvas-a",
                ): "thread-freezone",
                chat_service._codex_scope_key(
                    "project-a",
                    agent_profile="freezone:agent-2",
                    canvas_id="canvas-a",
                ): "thread-freezone",
            }
        ),
        encoding="utf-8",
    )
    calls = []
    monkeypatch.setattr(
        chat_service,
        "_control_codex_thread",
        lambda operation, thread_id, turn_id=None: calls.append(
            (operation, thread_id, turn_id)
        )
        or True,
    )

    count = await chat_service.delete_codex_project_threads(
        "admin", "project-a", project_state_dir=project_state
    )

    assert count == 2
    assert calls == [
        ("delete", "thread-freezone", None),
        ("delete", "thread-mainline", None),
    ]


@pytest.mark.anyio
@pytest.mark.parametrize(
    ("tool_mode", "store_scope", "expected_profile", "expected_canvas"),
    [
        ("default", None, "main", None),
        (
            "freezone_canvas",
            ChatScope(
                kind="project",
                id="project-a",
                surface="freezone",
                canvas_id="canvas-a",
                agent_id="agent-2",
            ),
            "freezone:agent-2",
            "canvas-a",
        ),
    ],
)
async def test_codex_stream_passes_conversation_scope_to_thread_builder(
    monkeypatch,
    tmp_path,
    tool_mode,
    store_scope,
    expected_profile,
    expected_canvas,
):
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(tmp_path / "state"))
    monkeypatch.setenv("NOVELVIDEO_RUNTIME_DIR", str(tmp_path / "runtime"))
    captured: dict[str, object] = {}
    revoked: list[str] = []
    history_sentinel = "CHATDB_HISTORY_MUST_NOT_REACH_CODEX"
    if store_scope is not None:
        chat_store.append_message("admin", store_scope, "assistant", history_sentinel)

    class FakeAuthPort:
        async def revoke_agent_session(self, token):
            revoked.append(token)

    async def fake_create_token(*args, **kwargs):  # noqa: ARG001
        return "agent-token"

    class FakeThread:
        async def stream(self, prompt):
            captured["prompt"] = prompt
            yield SimpleNamespace(
                type="thread_started",
                thread_id="codex-thread",
                turn_id="codex-turn",
            )
            yield SimpleNamespace(
                type="turn_started",
                thread_id="codex-thread",
                turn_id="codex-turn",
                status="inProgress",
                raw={"runtime": "codex", "method": "turn/started"},
            )
            yield SimpleNamespace(
                type="plan_update",
                text="Inspect the project",
                entries=[{"step": "List projects", "status": "inProgress"}],
                raw={"runtime": "codex", "method": "turn/plan/updated"},
            )
            yield SimpleNamespace(
                type="thought_delta",
                text="Checking projects",
                name="reasoning_summary",
                raw={
                    "runtime": "codex",
                    "method": "item/reasoning/summaryTextDelta",
                },
            )
            yield SimpleNamespace(
                type="tool_started",
                text="",
                name="dramaclaw.list_projects",
                call_id="call-1",
                status="running",
                input={"limit": 1},
                output=None,
                error=None,
                structured=None,
                raw={"runtime": "codex", "method": "item/started"},
            )
            yield SimpleNamespace(
                type="usage_update",
                usage={"last": {"inputTokens": 10}},
                raw={"runtime": "codex", "method": "thread/tokenUsage/updated"},
            )
            yield SimpleNamespace(
                type="turn_completed",
                thread_id="codex-thread",
                turn_id="codex-turn",
                status="completed",
                disposition="completed",
                error=None,
                raw={"runtime": "codex", "method": "turn/completed"},
            )
            yield SimpleNamespace(
                type="complete",
                thread_id="codex-thread",
                text="done",
            )

    def fake_build_thread(*args, **kwargs):
        captured.update(kwargs)
        token_file = Path(kwargs["agent_token_file"])
        assert token_file.read_text(encoding="utf-8") == "agent-token"
        assert token_file.stat().st_mode & 0o777 == 0o600
        return FakeThread()

    monkeypatch.setattr(
        chat_service,
        "_create_page_agent_session_token",
        fake_create_token,
    )
    monkeypatch.setattr(chat_service, "_build_codex_thread", fake_build_thread)
    monkeypatch.setattr(chat_service, "get_auth_session_port", lambda: FakeAuthPort())
    monkeypatch.setattr(hermes_sdk, "_issue_turn_capability", lambda **kwargs: None)

    events = []

    async def collect_event(event):
        events.append(event)

    await chat_service._stream_assistant_reply_codex(
        "admin",
        "project-a",
        "hello",
        collect_event,
        project_state_dir=tmp_path / "state" / "admin" / "project-a",
        tool_mode=tool_mode,
        surface_context={"freezone_canvas_id": "canvas-a"},
        store_scope=store_scope,
        turn_id="business-turn",
        route_prompt="hello",
    )

    assert captured["agent_profile"] == expected_profile
    assert captured["tool_mode"] == tool_mode
    assert captured["canvas_id"] == expected_canvas
    assert history_sentinel not in str(captured["prompt"])
    assert not Path(captured["agent_token_file"]).exists()
    assert revoked == ["agent-token"]
    if tool_mode == "freezone_canvas":
        assert "[FREEZONE_CANVAS_ASSISTANT]" in captured["prompt"]
        assert "[FREEZONE_CANVAS_CONTEXT]" in captured["prompt"]
        assert "canvas_id: canvas-a" in captured["prompt"]
        assert "generation_parameter_round: business-turn" in captured["prompt"]
        assert "Historical clarification answers" in captured["prompt"]
        assert "they never count as confirmation for this round" in captured["prompt"]
        assert "references/custom-topology.md" in captured["prompt"]
        assert (
            "Do not use freezone_emit_canvas_command for a workflow"
            in captured["prompt"]
        )
        developer_instructions = chat_service._codex_developer_instructions(tool_mode)
        assert "concrete tools currently listed" in developer_instructions
        assert "dramaclaw_tool_search/describe/call" not in developer_instructions
        assert "custom-topology reference" in developer_instructions
        assert "freezone_prepare_workflow_plan_draft once" in developer_instructions
        assert "expected_node_count" in developer_instructions
        assert "placeholder graph such as A/B" in developer_instructions
        assert "short-drama production Skill" in developer_instructions
        assert "not a Workflow catalog skill_id" in developer_instructions
        assert (
            "never pass dramaclaw-workflows to workflow_skill_get"
            in developer_instructions
        )
        assert "call freezone_request_user_clarification once" in developer_instructions
        assert "applies only to image and video for now" in developer_instructions
        assert "run_after_create=true" in developer_instructions
    else:
        assert "[FREEZONE_CANVAS_ASSISTANT]" not in captured["prompt"]
        assert "concrete business tools" in chat_service._codex_developer_instructions(
            tool_mode
        )
    assert [event["type"] for event in events] == [
        "thread_started",
        "turn_started",
        "plan_update",
        "thought_delta",
        "tool_started",
        "usage_update",
        "turn_completed",
        "done",
    ]
    assert events[2] == {
        "type": "plan_update",
        "text": "Inspect the project",
        "entries": [{"step": "List projects", "status": "inProgress"}],
    }
    assert events[3] == {
        "type": "thought_delta",
        "text": "Checking projects",
        "source": "reasoning_summary",
    }
    assert events[4]["name"] == "dramaclaw.list_projects"
    assert events[4]["result_json"] is None
    assert events[5] == {
        "type": "usage_update",
        "usage": {"last": {"inputTokens": 10}},
    }
    assert all("raw" not in event for event in events)
    assert all("method" not in event for event in events)
    assert events[-1]["type"] == "done"


def test_codex_freezone_write_request_detection_ignores_injected_context_and_questions():
    assert chat_service._freezone_canvas_write_requested("创建一个图片节点") is True
    assert (
        chat_service._freezone_canvas_write_requested(
            "创建一个图片节点\n[SUPERTALE_CANVAS_ROUTING] canvas edits"
        )
        is True
    )
    assert chat_service._freezone_canvas_write_requested("怎么创建图片节点？") is False
    assert (
        chat_service._freezone_canvas_write_requested("能否帮我创建一个短视频工作流？")
        is True
    )
    assert (
        chat_service._freezone_canvas_write_requested("可不可以创建一个图片节点？")
        is True
    )
    assert (
        chat_service._freezone_canvas_write_requested("你们是否支持创建图片节点？")
        is False
    )
    assert (
        chat_service._freezone_canvas_write_requested(
            "生成下这个\n[SUPERTALE_CANVAS_NODE_REFERENCES] node_id: image-a"
        )
        is True
    )
    assert chat_service._freezone_canvas_write_requested("清空一下") is True
    assert (
        chat_service._freezone_canvas_write_requested(
            "你好\n[SUPERTALE_CANVAS_ROUTING] For canvas edits, use Freezone tools"
        )
        is False
    )
    assert chat_service._freezone_canvas_write_requested("生成一张图片") is True
    assert (
        chat_service._freezone_canvas_write_requested("生成一张赛博朋克风格的图片")
        is True
    )
    assert chat_service._freezone_canvas_write_requested("生成一段视频") is True
    assert (
        chat_service._freezone_canvas_write_requested("做一个女总裁复仇短视频") is True
    )
    assert chat_service._freezone_canvas_write_requested("生成一个视频脚本") is False
    assert (
        chat_service._freezone_canvas_write_requested("generate a video script")
        is False
    )
    assert (
        chat_service._freezone_canvas_write_requested("create an image prompt") is False
    )
    assert (
        chat_service._freezone_canvas_write_requested("生成这个工作流的文案") is False
    )
    assert chat_service._freezone_canvas_write_requested("生成一张带文案的图片") is True
    assert (
        chat_service._freezone_canvas_write_requested(
            "create an image from this prompt"
        )
        is True
    )
    assert (
        chat_service._freezone_canvas_write_requested(
            "Create an image showing a sunset"
        )
        is True
    )
    assert (
        chat_service._freezone_canvas_write_requested(
            "Generate a video showing our product"
        )
        is True
    )
    assert (
        chat_service._freezone_canvas_write_requested("根据这个提示词生成视频") is True
    )
    assert chat_service._freezone_canvas_write_requested("用这段描述生成一张图") is True
    assert (
        chat_service._freezone_canvas_write_requested(
            "请生成本集完整剧本。输出 20—25 个视觉 Beat，并描述旧图片与视频质感。"
        )
        is False
    )


def test_codex_freezone_write_receipt_accepts_durable_browser_result():
    event = SimpleNamespace(
        name="freezone_confirm_workflow_draft",
        status="completed",
        error=None,
        structured={
            "ok": True,
            "applied": True,
            "canvas_apply_status": "applied",
            "bridge_key": "bridge-a",
            "project_id": "project-a",
            "canvas_id": "canvas-a",
        },
        output=None,
    )

    assert chat_service._codex_freezone_write_result_succeeded(event) is True


def test_codex_freezone_write_receipt_rejects_counts_without_durable_identity():
    event = SimpleNamespace(
        name="freezone_confirm_workflow_draft",
        status="completed",
        error=None,
        structured={"ok": True, "created_node_count": 3, "status": "completed"},
        output=None,
    )

    assert chat_service._codex_freezone_write_result_succeeded(event) is False


def test_codex_freezone_instructions_forbid_invented_resource_uris():
    instructions = chat_service._CODEX_FREEZONE_DEVELOPER_INSTRUCTIONS

    assert "never invent a project:// Skill URI" in instructions
    assert "never request a canvas:// resource" in instructions
    assert "freezone_get_canvas_ontology" in instructions
    assert "one and only run request" in instructions
    assert "never call freezone_run_workflow again in the same turn" in instructions
    assert "not a Workflow catalog skill_id" in instructions
    assert "text-to-image-video" in instructions
    assert "Never ask for a duplicate 'create and run' confirmation" in instructions
    assert "the Freezone write tool creates that card" in instructions
    assert "never use the built-in request_user_input tool" in instructions
    assert "Never call create_goal for a canvas request" in instructions


def test_codex_freezone_write_result_error_preserves_canvas_validation_reason():
    event = SimpleNamespace(
        name="dramaclaw.freezone_confirm_workflow_draft",
        output={
            "content": [
                {
                    "type": "text",
                    "text": json.dumps(
                        {
                            "ok": False,
                            "status": "invalid_command_schema",
                            "error": (
                                "commands[0] create_node requires "
                                "textAnnotationNode content in data"
                            ),
                        }
                    ),
                }
            ]
        },
        structured=None,
        error=None,
    )

    assert chat_service._codex_freezone_write_result_error(event) == (
        "commands[0] create_node requires textAnnotationNode content in data"
    )


@pytest.mark.anyio
@pytest.mark.parametrize(
    "tool_outcome", ["missing", "success", "failure", "blocked", "draft_ready"]
)
async def test_codex_freezone_write_cannot_claim_success_without_tool_receipt(
    monkeypatch,
    tmp_path,
    tool_outcome,
):
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(tmp_path / "state"))
    monkeypatch.setenv("NOVELVIDEO_RUNTIME_DIR", str(tmp_path / "runtime"))
    events = []
    revoked = []

    async def fake_authorize(**_kwargs):
        return None

    async def fake_create_token(*_args, **_kwargs):
        return "agent-token"

    class FakeAuthPort:
        async def revoke_agent_session(self, token):
            revoked.append(token)

    class FakeThread:
        async def stream(self, _prompt):
            yield SimpleNamespace(
                type="thread_started",
                thread_id="codex-thread",
                turn_id="codex-turn",
            )
            if tool_outcome == "draft_ready":
                yield SimpleNamespace(
                    type="tool_updated",
                    text="[mcp:completed] dramaclaw.freezone_prepare_workflow_draft",
                    name="dramaclaw.freezone_prepare_workflow_draft",
                    call_id="call-draft",
                    status="completed",
                    input={
                        "quote_id": "billing_quote_a",
                        "confirmation_receipt": "billing_receipt_a",
                    },
                    output={
                        "content": [
                            {
                                "type": "text",
                                "text": json.dumps(
                                    {
                                        "ok": True,
                                        "status": "workflow_draft_ready",
                                        "draft_id": "draft-a",
                                        "revision": 1,
                                    }
                                ),
                            }
                        ]
                    },
                    error=None,
                    structured=None,
                )
            elif tool_outcome not in {"missing", "blocked"}:
                result_payload = (
                    {
                        "ok": True,
                        "canvas_apply_status": "applied",
                        "applied": True,
                        "bridge_key": "bridge-call-1",
                        "project_id": "project-a",
                        "canvas_id": "canvas-a",
                    }
                    if tool_outcome == "success"
                    else {
                        "ok": False,
                        "status": "invalid_command_schema",
                        "error": "文本节点缺少 content 字段",
                    }
                )
                yield SimpleNamespace(
                    type="tool_updated",
                    text="[mcp:completed] dramaclaw.freezone_emit_canvas_command",
                    name="dramaclaw.freezone_emit_canvas_command",
                    call_id="call-1",
                    status="completed",
                    input={"commands": [{"type": "create_node"}]},
                    output={
                        "content": [
                            {
                                "type": "text",
                                "text": json.dumps(result_payload),
                            }
                        ]
                    },
                    error=None,
                    structured=None,
                )
            assistant_reply = (
                "未能创建工作流：找不到匹配的 Workflow Skill。"
                if tool_outcome == "blocked"
                else "好的，已创建一个图片节点。"
            )
            yield SimpleNamespace(type="assistant_delta", text=assistant_reply)
            yield SimpleNamespace(
                type="complete",
                thread_id="codex-thread",
                text="",
            )

    monkeypatch.setattr(chat_service, "authorize_hermes_launch", fake_authorize)
    monkeypatch.setattr(
        chat_service, "_create_page_agent_session_token", fake_create_token
    )
    monkeypatch.setattr(
        chat_service, "_build_codex_thread", lambda *_args, **_kwargs: FakeThread()
    )
    monkeypatch.setattr(chat_service, "get_auth_session_port", lambda: FakeAuthPort())
    monkeypatch.setattr(hermes_sdk, "_issue_turn_capability", lambda **_kwargs: None)

    async def collect_event(event):
        events.append(event)

    scope = ChatScope(
        kind="project",
        id="project-a",
        surface="freezone",
        canvas_id="canvas-a",
        agent_id="main",
        state_dir=str(tmp_path / "state" / "admin" / "project-a"),
    )
    result = await chat_service._stream_assistant_reply_codex(
        "admin",
        "project-a",
        "创建一个图片节点",
        collect_event,
        project_state_dir=tmp_path / "state" / "admin" / "project-a",
        tool_mode="freezone_canvas",
        surface_context={"freezone_canvas_id": "canvas-a"},
        store_scope=scope,
        turn_id="business-turn",
        route_prompt="创建一个图片节点",
    )

    assistant_deltas = [
        event["text"] for event in events if event["type"] == "assistant_delta"
    ]
    if tool_outcome == "success":
        assert result["content"] == "好的，已创建一个图片节点。"
        assert assistant_deltas == ["好的，已创建一个图片节点。"]
    elif tool_outcome == "failure":
        assert result["content"] == "画布操作未完成：文本节点缺少 content 字段"
        assert assistant_deltas == [result["content"]]
    elif tool_outcome == "missing":
        assert "已创建" not in result["content"]
        assert result["content"] == "画布操作未完成：本轮没有执行画布写入，请重试。"
        assert assistant_deltas == [result["content"]]
    elif tool_outcome == "draft_ready":
        assert result["content"] == (
            "画布操作未完成：工作流草稿已准备完成，但本轮未提交确认创建，请重试。"
        )
        assert assistant_deltas == [result["content"]]
    else:
        assert result["content"] == (
            "画布操作未完成：未能创建工作流：找不到匹配的 Workflow Skill。"
        )
        assert assistant_deltas == [result["content"]]
    assert revoked == ["agent-token"]


@pytest.mark.anyio
async def test_codex_freezone_timeout_preserves_runtime_reason(monkeypatch, tmp_path):
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(tmp_path / "state"))
    events = []

    async def fake_authorize(**_kwargs):
        return None

    async def fake_create_token(*_args, **_kwargs):
        return "agent-token"

    class FakeAuthPort:
        async def revoke_agent_session(self, _token):
            return None

    class FakeThread:
        async def stream(self, _prompt):
            yield SimpleNamespace(
                type="thread_started",
                thread_id="codex-thread",
                turn_id="codex-turn",
            )
            yield SimpleNamespace(
                type="egress_disposition",
                disposition="timeout",
            )
            yield SimpleNamespace(
                type="complete",
                thread_id="codex-thread",
                turn_id="codex-turn",
                text="Codex App Server 响应超时，请重试。",
            )

    monkeypatch.setattr(chat_service, "authorize_hermes_launch", fake_authorize)
    monkeypatch.setattr(
        chat_service, "_create_page_agent_session_token", fake_create_token
    )
    monkeypatch.setattr(
        chat_service, "_build_codex_thread", lambda *_args, **_kwargs: FakeThread()
    )
    monkeypatch.setattr(chat_service, "get_auth_session_port", lambda: FakeAuthPort())
    monkeypatch.setattr(hermes_sdk, "_issue_turn_capability", lambda **_kwargs: None)

    async def collect_event(event):
        events.append(event)

    scope = ChatScope(
        kind="project",
        id="project-a",
        surface="freezone",
        canvas_id="canvas-a",
        agent_id="main",
        state_dir=str(tmp_path / "state" / "admin" / "project-a"),
    )
    result = await chat_service._stream_assistant_reply_codex(
        "admin",
        "project-a",
        "创建一个图片工作流",
        collect_event,
        project_state_dir=tmp_path / "state" / "admin" / "project-a",
        tool_mode="freezone_canvas",
        surface_context={"freezone_canvas_id": "canvas-a"},
        store_scope=scope,
        turn_id="business-turn",
        route_prompt="创建一个图片工作流",
    )

    assert result["content"] == "Codex App Server 响应超时，请重试。"
    assert [
        event["text"] for event in events if event["type"] == "assistant_delta"
    ] == ["Codex App Server 响应超时，请重试。"]


@pytest.mark.asyncio
async def test_codex_prompt_construction_failure_cleans_turn_credentials(
    monkeypatch,
    tmp_path,
):
    project_state = tmp_path / "state" / "admin" / "project-a"
    runtime_root = tmp_path / "runtime"
    monkeypatch.setenv("NOVELVIDEO_RUNTIME_DIR", str(runtime_root))
    captured: dict[str, Path] = {}
    revoked: list[str] = []
    finished: list[str] = []

    class FakeAuthPort:
        async def revoke_agent_session(self, token):
            revoked.append(token)

    class FakeTurnOperation:
        async def finish(self, disposition):
            finished.append(disposition)

    async def fake_authorize(**_kwargs):
        return SimpleNamespace()

    async def fake_create_token(*_args, **_kwargs):
        return "agent-token"

    def fake_build_thread(*_args, **kwargs):
        token_file = Path(kwargs["agent_token_file"])
        assert token_file.read_text(encoding="utf-8") == "agent-token"
        captured["token_file"] = token_file
        return SimpleNamespace()

    def fail_prompt(*_args, **_kwargs):
        raise RuntimeError("prompt construction failed")

    monkeypatch.setattr(chat_service, "authorize_hermes_launch", fake_authorize)
    monkeypatch.setattr(
        chat_service,
        "_turn_operation_finalizer",
        lambda _authorization: FakeTurnOperation(),
    )
    monkeypatch.setattr(
        chat_service,
        "_create_page_agent_session_token",
        fake_create_token,
    )
    monkeypatch.setattr(chat_service, "_build_codex_thread", fake_build_thread)
    monkeypatch.setattr(chat_service, "_prompt_with_user_context", fail_prompt)
    monkeypatch.setattr(chat_service, "get_auth_session_port", lambda: FakeAuthPort())
    monkeypatch.setattr(hermes_sdk, "_issue_turn_capability", lambda **_kwargs: None)

    async def collect_event(_event):
        raise AssertionError("prompt failure must happen before streaming")

    with pytest.raises(RuntimeError, match="prompt construction failed"):
        await chat_service._stream_assistant_reply_codex(
            "admin",
            "project-a",
            "hello",
            collect_event,
            project_state_dir=project_state,
            turn_id="business-turn",
        )

    assert not captured["token_file"].exists()
    assert revoked == ["agent-token"]
    assert finished == ["failed"]
    token_root = runtime_root / "codex" / "turn_tokens"
    assert list(token_root.iterdir()) == []
    assert token_root.stat().st_mode & 0o777 == 0o700
    assert not (project_state / "agents" / "codex" / "turn_tokens").exists()


@pytest.mark.asyncio
async def test_codex_turn_token_files_are_unique_and_cleanup_is_turn_local(
    tmp_path,
):
    token_root = tmp_path / "turn_tokens"
    scope_key = chat_service._codex_scope_key(
        "project-a",
        agent_profile="freezone:agent-2",
        canvas_id="canvas-a",
    )

    first, second = await asyncio.gather(
        asyncio.to_thread(
            chat_service._write_codex_turn_token,
            token_root,
            scope_key=scope_key,
            business_turn_id="retry-turn",
            token="token-first",
        ),
        asyncio.to_thread(
            chat_service._write_codex_turn_token,
            token_root,
            scope_key=scope_key,
            business_turn_id="retry-turn",
            token="token-second",
        ),
    )

    assert first != second
    assert first.read_text(encoding="utf-8") == "token-first"
    assert second.read_text(encoding="utf-8") == "token-second"
    assert first.stat().st_mode & 0o777 == 0o600
    assert second.stat().st_mode & 0o777 == 0o600

    first.unlink()
    assert not first.exists()
    assert second.read_text(encoding="utf-8") == "token-second"
    second.unlink()
    assert list(token_root.iterdir()) == []


def test_user_agent_workspace_is_not_project_workspace(monkeypatch, tmp_path):
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(tmp_path / "state"))
    monkeypatch.setenv("NOVELVIDEO_OUTPUT_DIR", str(tmp_path / "output"))
    monkeypatch.setenv(
        "DRAMACLAW_CODEX_HOME", str(tmp_path / "state" / ".codex-app-server")
    )

    chat_service.ensure_user_claude_workspace("admin", "project-a")
    codex_workspace, codex_home = chat_service.ensure_user_codex_workspace(
        "admin", "project-a"
    )
    freezone_workspace, freezone_home = chat_service.ensure_user_codex_workspace(
        "admin",
        "project-a",
        agent_profile="freezone:main",
    )

    workspace = chat_service._user_agent_workspace("admin")
    assert workspace == tmp_path / "state" / "admin" / ".chat_agents"
    assert (workspace / ".claude" / "settings.local.json").exists()
    assert (workspace / ".claude" / "skills").is_dir()
    project_agent_root = tmp_path / "state" / "admin" / "project-a" / "agents" / "codex"
    assert codex_workspace.parent == project_agent_root / "workspaces"
    assert codex_workspace.name.startswith("main-")
    assert freezone_workspace.parent == project_agent_root / "workspaces"
    assert freezone_workspace.name.startswith("freezone-main-")
    assert freezone_workspace != codex_workspace
    assert codex_home == tmp_path / "state" / ".codex-app-server"
    assert freezone_home == codex_home
    assert (codex_workspace / ".agents" / "skills").is_dir()
    assert (freezone_workspace / ".agents" / "skills").is_dir()
    assert (
        codex_workspace / ".agents" / "skills" / "dramaclaw-workflows" / "SKILL.md"
    ).is_file()
    assert (
        freezone_workspace / ".agents" / "skills" / "dramaclaw-workflows" / "SKILL.md"
    ).is_file()
    assert codex_home.is_dir()

    project_workspace = Path(tmp_path / "output" / "admin" / "project-a")
    assert not (project_workspace / ".claude").exists()
    assert not (project_workspace / ".codex").exists()


def test_freezone_skill_sync_refreshes_managed_skills_and_preserves_user_skills(
    monkeypatch, tmp_path
):
    source_root = tmp_path / "sources"
    mainline_source = source_root / "dramaclaw"
    workflow_source = source_root / "dramaclaw-workflows"
    mainline_source.mkdir(parents=True)
    workflow_source.mkdir(parents=True)
    (mainline_source / "SKILL.md").write_text("# Mainline\n", encoding="utf-8")
    (workflow_source / "SKILL.md").write_text("# Workflow v1\n", encoding="utf-8")
    monkeypatch.setattr(
        chat_service,
        "_skill_sources",
        lambda: [
            ("dramaclaw", mainline_source),
            ("dramaclaw-workflows", workflow_source),
        ],
    )

    skills_dir = tmp_path / "workspace" / ".agents" / "skills"
    stale_mainline = skills_dir / "dramaclaw"
    stale_workflow = skills_dir / "dramaclaw-workflows"
    user_skill = skills_dir / "my-private-skill"
    stale_mainline.mkdir(parents=True)
    stale_workflow.mkdir(parents=True)
    user_skill.mkdir(parents=True)
    (stale_mainline / "SKILL.md").write_text("# Stale mainline\n", encoding="utf-8")
    (stale_workflow / "SKILL.md").write_text("# Workflow stale\n", encoding="utf-8")
    (user_skill / "SKILL.md").write_text("# User-owned\n", encoding="utf-8")

    chat_service._sync_project_skills(skills_dir, agent_profile="freezone:main")

    assert not stale_mainline.exists()
    assert (stale_workflow / "SKILL.md").read_text(
        encoding="utf-8"
    ) == "# Workflow v1\n"
    assert (user_skill / "SKILL.md").read_text(encoding="utf-8") == "# User-owned\n"

    (workflow_source / "SKILL.md").write_text("# Workflow v2\n", encoding="utf-8")
    chat_service._sync_project_skills(skills_dir, agent_profile="freezone:main")

    assert (stale_workflow / "SKILL.md").read_text(
        encoding="utf-8"
    ) == "# Workflow v2\n"
    manifest = json.loads(
        (skills_dir / ".dramaclaw-managed-skills.json").read_text(encoding="utf-8")
    )
    assert set(manifest["skills"]) == {"dramaclaw-workflows"}


def test_managed_skill_sync_rejects_manifest_path_traversal_and_escape_symlink(
    monkeypatch, tmp_path
):
    skills_dir = tmp_path / "workspace" / ".agents" / "skills"
    skills_dir.mkdir(parents=True)
    outside_dir = tmp_path / "outside-project"
    outside_dir.mkdir()
    (outside_dir / "keep.txt").write_text("keep\n", encoding="utf-8")
    escape_link = skills_dir / "managed-escape"
    escape_link.symlink_to(outside_dir, target_is_directory=True)
    manifest = {
        "schema_version": 1,
        "skills": {
            "../outside-project": "malicious",
            str(outside_dir): "malicious",
            "nested/escape": "malicious",
            "nested\\escape": "malicious",
            "managed-escape": "malicious",
        },
    }
    (skills_dir / ".dramaclaw-managed-skills.json").write_text(
        json.dumps(manifest), encoding="utf-8"
    )
    monkeypatch.setattr(chat_service, "_skill_sources", lambda: [])

    chat_service._sync_project_skills(skills_dir, agent_profile="freezone:main")

    assert (outside_dir / "keep.txt").read_text(encoding="utf-8") == "keep\n"
    assert escape_link.is_symlink()
    rewritten = json.loads(
        (skills_dir / ".dramaclaw-managed-skills.json").read_text(encoding="utf-8")
    )
    assert rewritten["skills"] == {}


def test_remove_managed_skill_path_defends_its_root_boundary(tmp_path):
    skills_dir = tmp_path / "workspace" / ".agents" / "skills"
    outside_dir = tmp_path / "outside-project"
    skills_dir.mkdir(parents=True)
    outside_dir.mkdir()

    assert not chat_service._remove_managed_skill_path(outside_dir, root=skills_dir)
    assert outside_dir.is_dir()


def test_dramaclaw_mcp_server_config_is_agent_neutral():
    servers = chat_service._dramaclaw_mcp_servers()

    assert servers["dramaclaw"]["type"] == "stdio"
    assert servers["dramaclaw"]["args"] == ["-m", "novelvideo.chat.dramaclaw_mcp"]
    assert servers["dramaclaw"]["env_vars"] == [
        "DRAMACLAW_API_URL",
        "DRAMACLAW_AGENT_TOKEN_FILE",
        "DRAMACLAW_CANVAS_ID",
        "DRAMACLAW_CANVAS_COMMAND_BRIDGE_DIR",
        "DRAMACLAW_CHAT_SURFACE",
        "DRAMACLAW_EXTERNAL_MCP",
        "DRAMACLAW_MCP_DIRECT_CANVAS_APPLY",
        "DRAMACLAW_AGENT_PROFILE",
        "DRAMACLAW_PROJECT_ID",
        "DRAMACLAW_SKILLS_DIR",
        "DRAMACLAW_TOOL_MODE",
        "DRAMACLAW_USERNAME",
    ]


def test_freezone_adds_independent_workflow_mcp_without_changing_default():
    default_servers = chat_service._dramaclaw_mcp_servers()
    freezone_servers = chat_service._dramaclaw_mcp_servers("freezone_canvas")

    assert set(default_servers) == {"dramaclaw"}
    assert freezone_servers["dramaclaw"] == default_servers["dramaclaw"]
    assert freezone_servers["dramaclaw_workflows"] == {
        "type": "stdio",
        "command": __import__("sys").executable,
        "args": ["-m", "novelvideo.chat.workflow_mcp"],
        "env_vars": ["DRAMACLAW_USERNAME"],
    }


def test_chat_agent_api_url_defaults_to_rest_listener(monkeypatch):
    for name in (
        "DRAMACLAW_API_URL",
        "NOVELVIDEO_API_URL",
        "NOVELVIDEO_API_PORT",
        "SUPERTALE_API_URL",
        "NOVELVIDEO_UI_PORT",
    ):
        monkeypatch.delenv(name, raising=False)

    assert chat_service._load_api_url() == "http://127.0.0.1:8780"


def test_codex_client_carries_dramaclaw_mcp_servers(tmp_path):
    overrides = chat_service._codex_mcp_config_overrides(
        chat_service._dramaclaw_mcp_servers()
    )

    expected_command = json.dumps(__import__("sys").executable, ensure_ascii=False)
    assert f"mcp_servers.dramaclaw.command={expected_command}" in overrides
    assert (
        'mcp_servers.dramaclaw.args=["-m","novelvideo.chat.dramaclaw_mcp"]' in overrides
    )
    assert (
        'mcp_servers.dramaclaw.env_vars=["DRAMACLAW_API_URL",'
        '"DRAMACLAW_AGENT_TOKEN_FILE","DRAMACLAW_CANVAS_ID",'
        '"DRAMACLAW_CANVAS_COMMAND_BRIDGE_DIR","DRAMACLAW_CHAT_SURFACE",'
        '"DRAMACLAW_EXTERNAL_MCP",'
        '"DRAMACLAW_MCP_DIRECT_CANVAS_APPLY",'
        '"DRAMACLAW_AGENT_PROFILE","DRAMACLAW_PROJECT_ID",'
        '"DRAMACLAW_SKILLS_DIR","DRAMACLAW_TOOL_MODE",'
        '"DRAMACLAW_USERNAME"]' in overrides
    )
    assert "mcp_servers.dramaclaw.required=true" in overrides
    assert 'mcp_servers.dramaclaw.default_tools_approval_mode="approve"' in overrides

    client = backend_sdk.CodexClient(
        codex_bin=Path("/usr/local/bin/codex"),
        cwd=tmp_path,
        env={
            "DRAMACLAW_AGENT_TOKEN_FILE": "/tmp/turn.token",
            "DRAMACLAW_AGENT_PROFILE": "freezone:agent-2",
            "DRAMACLAW_CANVAS_ID": "canvas-a",
            "DRAMACLAW_TOOL_MODE": "freezone_canvas",
        },
        model="DC-codex-agent-LLM",
        model_provider="dramaclaw_gateway",
        developer_instructions="Use DramaClaw MCP only.",
        config_overrides=overrides,
    )

    thread = client.thread_start()

    assert thread._config_overrides == overrides
    assert thread._thread_config["mcp_servers.dramaclaw.env"] == {
        "DRAMACLAW_AGENT_TOKEN_FILE": "/tmp/turn.token",
        "DRAMACLAW_AGENT_PROFILE": "freezone:agent-2",
        "DRAMACLAW_CANVAS_ID": "canvas-a",
        "DRAMACLAW_TOOL_MODE": "freezone_canvas",
    }
    assert "mcp_servers.dramaclaw.env_vars" not in thread._thread_config
    assert thread._model == "DC-codex-agent-LLM"
    assert thread._model_provider == "dramaclaw_gateway"


def test_codex_client_carries_freezone_scope_into_mcp_process(tmp_path):
    overrides = chat_service._codex_mcp_config_overrides(
        chat_service._dramaclaw_mcp_servers()
    )
    client = backend_sdk.CodexClient(
        codex_bin=Path("/usr/local/bin/codex"),
        cwd=tmp_path,
        env={
            "DRAMACLAW_AGENT_TOKEN_FILE": "/tmp/turn.token",
            "DRAMACLAW_CANVAS_ID": "canvas-a",
            "DRAMACLAW_TOOL_MODE": "freezone_canvas",
        },
        model="DC-codex-agent-LLM",
        model_provider="dramaclaw_gateway",
        developer_instructions="Use DramaClaw MCP only.",
        config_overrides=overrides,
    )

    thread = client.thread_start()

    assert thread._thread_config["mcp_servers.dramaclaw.env"] == {
        "DRAMACLAW_AGENT_TOKEN_FILE": "/tmp/turn.token",
        "DRAMACLAW_CANVAS_ID": "canvas-a",
        "DRAMACLAW_TOOL_MODE": "freezone_canvas",
    }


def test_codex_client_binds_declared_env_for_independent_mcp(tmp_path):
    overrides = chat_service._codex_mcp_config_overrides(
        chat_service._dramaclaw_mcp_servers("freezone_canvas")
    )
    client = backend_sdk.CodexClient(
        codex_bin=Path("/usr/local/bin/codex"),
        cwd=tmp_path,
        env={
            "DRAMACLAW_USERNAME": "agent-a",
            "DRAMACLAW_TOOL_MODE": "freezone_canvas",
        },
        model="DC-codex-agent-LLM",
        model_provider="dramaclaw_gateway",
        developer_instructions="Use workflow MCP.",
        config_overrides=overrides,
    )

    thread = client.thread_start()

    assert thread._thread_config["mcp_servers.dramaclaw_workflows.env"] == {
        "DRAMACLAW_USERNAME": "agent-a"
    }
    assert "mcp_servers.dramaclaw_workflows.env_vars" not in thread._thread_config


def test_codex_client_keeps_gateway_credentials_in_turn_metadata(tmp_path):
    mcp_overrides = chat_service._codex_mcp_config_overrides(
        chat_service._dramaclaw_mcp_servers()
    )
    client = backend_sdk.CodexClient(
        codex_bin=Path("/usr/local/bin/codex"),
        cwd=tmp_path,
        env={"DRAMACLAW_AGENT_TOKEN_FILE": "/tmp/turn.token"},
        model="DC-codex-agent-LLM",
        model_provider="dramaclaw_gateway",
        developer_instructions="Use DramaClaw MCP only.",
        config_overrides=chat_service._codex_gateway_config_overrides(
            "https://gateway.example/v1"
        ),
        thread_config_overrides=mcp_overrides,
        turn_metadata={
            "dramaclaw_gateway_api_key": "turn-secret",
            "dramaclaw_control_context_capability": "turn-capability",
        },
    )

    thread = client.thread_start()
    assert thread._thread_config["mcp_servers.dramaclaw.env"] == {
        "DRAMACLAW_AGENT_TOKEN_FILE": "/tmp/turn.token"
    }
    assert thread._turn_metadata == {
        "dramaclaw_gateway_api_key": "turn-secret",
        "dramaclaw_control_context_capability": "turn-capability",
    }
    assert "turn-secret" not in "\n".join(thread._config_overrides)
    assert "turn-capability" not in "\n".join(thread._config_overrides)


def test_codex_gateway_overrides_use_responses_without_embedding_secret():
    overrides = chat_service._codex_gateway_config_overrides(
        "https://gateway.example/v1/"
    )
    rendered = "\n".join(overrides)

    assert (
        'model_providers.dramaclaw_gateway.base_url="https://gateway.example/v1"'
        in overrides
    )
    assert 'model_providers.dramaclaw_gateway.wire_api="responses"' in overrides
    assert (
        "model_providers.dramaclaw_gateway.experimental_bearer_token="
        '"dramaclaw-codex-per-turn-placeholder"' in overrides
    )
    assert "features.apps=false" in overrides
    assert "features.hooks=false" in overrides
    assert "features.memories=false" in overrides
    assert "features.multi_agent=false" in overrides
    assert "features.plugins=false" in overrides
    assert "features.shell_tool=false" in overrides
    assert "memories.generate_memories=false" in overrides
    assert "memories.use_memories=false" in overrides
    assert 'model_reasoning_effort="medium"' in overrides
    assert 'web_search="disabled"' in overrides
    catalog_override = next(
        item for item in overrides if item.startswith("model_catalog_json=")
    )
    catalog_path = Path(json.loads(catalog_override.split("=", 1)[1]))
    catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
    model = next(
        item for item in catalog["models"] if item["slug"] == "DC-codex-agent-LLM"
    )
    assert model["supports_search_tool"] is True
    assert model["base_instructions"]
    assert model["truncation_policy"] == {"mode": "tokens", "limit": 10000}
    assert "secret-value" not in rendered


def test_codex_gateway_fails_closed_for_incomplete_model_catalog(monkeypatch, tmp_path):
    catalog_path = tmp_path / "models.json"
    catalog_path.write_text(
        json.dumps(
            {
                "models": [
                    {
                        "slug": "DC-codex-agent-LLM",
                        "supports_search_tool": True,
                    }
                ]
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("DRAMACLAW_CODEX_MODEL_CATALOG_FILE", str(catalog_path))

    with pytest.raises(RuntimeError, match="no complete entry"):
        chat_service._codex_gateway_config_overrides("https://gateway.example/v1")


def test_codex_gateway_fails_closed_when_tool_search_is_disabled(monkeypatch, tmp_path):
    bundled = (
        Path(chat_service.__file__).resolve().parents[3]
        / "deploy"
        / "codex"
        / "dramaclaw-model-catalog.json"
    )
    catalog = json.loads(bundled.read_text(encoding="utf-8"))
    catalog["models"][0]["supports_search_tool"] = False
    catalog_path = tmp_path / "models.json"
    catalog_path.write_text(json.dumps(catalog), encoding="utf-8")
    monkeypatch.setenv("DRAMACLAW_CODEX_MODEL_CATALOG_FILE", str(catalog_path))

    with pytest.raises(RuntimeError, match="must enable supports_search_tool"):
        chat_service._codex_gateway_config_overrides("https://gateway.example/v1")


def test_codex_gateway_reasoning_effort_is_configurable(monkeypatch):
    monkeypatch.setenv("CODEX_REASONING_EFFORT", "high")

    overrides = chat_service._codex_gateway_config_overrides(
        "https://gateway.example/v1"
    )

    assert 'model_reasoning_effort="high"' in overrides


def test_codex_gateway_rejects_invalid_reasoning_effort(monkeypatch):
    monkeypatch.setenv("CODEX_REASONING_EFFORT", "disabled")

    with pytest.raises(RuntimeError, match="Unsupported CODEX_REASONING_EFFORT"):
        chat_service._codex_gateway_config_overrides("https://gateway.example/v1")


def test_codex_env_uses_effective_gateway_and_isolates_codex_home(
    monkeypatch, tmp_path
):
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(tmp_path / "state"))
    monkeypatch.setenv(
        "DRAMACLAW_CODEX_HOME", str(tmp_path / "state" / ".codex-app-server")
    )
    monkeypatch.setattr(
        "novelvideo.chat.hermes_workspace.effective_gateway_credentials",
        lambda: ("secret-value", "https://gateway.example/v1"),
    )

    project_state = tmp_path / "ee-project-state"
    env = chat_service._build_codex_env(
        "admin",
        "project-a",
        "agent-token",
        project_state_dir=project_state,
        agent_token_file=project_state / "turn.token",
    )

    assert env["CODEX_HOME"] == str(tmp_path / "state" / ".codex-app-server")
    assert env["DRAMACLAW_AGENT_SCOPE"] == "project"
    assert env["SUPERTALE_AGENT_SCOPE"] == "project"
    assert env["DRAMACLAW_AGENT_PROFILE"] == "main"
    assert env["DRAMACLAW_TOOL_MODE"] == "default"
    assert env["DRAMACLAW_SKILLS_DIR"].endswith(
        "/agents/codex/workspaces/main-0d6e4079e367/.agents/skills"
    )
    assert "DRAMACLAW_AGENT_TOKEN" not in env
    assert env["DRAMACLAW_AGENT_TOKEN_FILE"] == str(project_state / "turn.token")
    assert "DRAMACLAW_CANVAS_ID" not in env
    assert "DRAMACLAW_CODEX_GATEWAY_API_KEY" not in env
    assert "NEWAPI_API_KEY" not in env
    assert "OPENAI_API_KEY" not in env
    assert env["DRAMACLAW_CODEX_GATEWAY_BASE_URL"] == ("https://gateway.example/v1")

    freezone_env = chat_service._build_codex_env(
        "admin",
        "project-a",
        "agent-token",
        agent_profile="freezone:agent-2",
        tool_mode="freezone_canvas",
        canvas_id="canvas-a",
        project_state_dir=project_state,
    )
    assert freezone_env["DRAMACLAW_TOOL_MODE"] == "freezone_canvas"
    assert freezone_env["DRAMACLAW_CANVAS_ID"] == "canvas-a"
    assert freezone_env["DRAMACLAW_AGENT_PROFILE"] == "freezone:agent-2"
    assert freezone_env["DRAMACLAW_EXTERNAL_MCP"] == "1"
    assert freezone_env["DRAMACLAW_MCP_DIRECT_CANVAS_APPLY"] == "0"
    assert freezone_env["DRAMACLAW_CANVAS_COMMAND_BRIDGE_DIR"].endswith(
        "supertale_canvas_command_bridge/freezone_agent-2"
    )


def test_codex_freezone_env_fails_closed_when_canvas_bridge_is_unavailable(
    monkeypatch, tmp_path
):
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(tmp_path / "state"))
    monkeypatch.setattr(
        "novelvideo.chat.hermes_workspace.ensure_user_hermes_workspace",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            RuntimeError("bridge unavailable")
        ),
    )

    with pytest.raises(RuntimeError, match="bridge unavailable"):
        chat_service._build_codex_env(
            "admin",
            "project-a",
            agent_profile="freezone:agent-2",
            tool_mode="freezone_canvas",
            canvas_id="canvas-a",
        )


def test_codex_turn_gateway_credentials_reject_foreign_origin(monkeypatch):
    monkeypatch.setattr("novelvideo.shared.runtime_env.is_ce_effective", lambda: False)
    monkeypatch.setattr(
        "novelvideo.chat.hermes_workspace.effective_gateway_credentials",
        lambda: ("node-key", "https://gateway.example/v1"),
    )
    authorization = SimpleNamespace(
        credential=SimpleNamespace(
            api_key="turn-key",
            base_url="https://foreign.example/v1",
        )
    )

    from novelvideo.chat.hermes_pool import GatewayOriginMismatch

    with pytest.raises(GatewayOriginMismatch, match="different gateway origin"):
        chat_service._codex_turn_gateway_credentials(authorization)


def test_codex_turn_gateway_credentials_use_authorized_key(monkeypatch):
    monkeypatch.setattr("novelvideo.shared.runtime_env.is_ce_effective", lambda: False)
    monkeypatch.setattr(
        "novelvideo.chat.hermes_workspace.effective_gateway_credentials",
        lambda: ("node-key", "https://gateway.example/v1"),
    )
    authorization = SimpleNamespace(
        credential=SimpleNamespace(
            api_key="turn-key",
            base_url="https://gateway.example/another-path",
        )
    )

    assert chat_service._codex_turn_gateway_credentials(authorization) == (
        "turn-key",
        "https://gateway.example/v1",
    )


def test_ce_codex_turn_gateway_credentials_use_current_sqlite_config(monkeypatch):
    monkeypatch.setattr("novelvideo.shared.runtime_env.is_ce_effective", lambda: True)
    monkeypatch.setattr(
        "novelvideo.chat.hermes_workspace.effective_gateway_credentials",
        lambda: ("sqlite-key", "https://ce-gateway.example/v1"),
    )
    stale_ee_authorization = SimpleNamespace(
        credential=SimpleNamespace(
            api_key="stale-channel-key",
            base_url="https://foreign.example/v1",
        )
    )

    assert chat_service._codex_turn_gateway_credentials(stale_ee_authorization) == (
        "sqlite-key",
        "https://ce-gateway.example/v1",
    )


def test_codex_node_runtime_does_not_inherit_project_authority():
    from novelvideo.chat.codex_app_server import _node_process_env

    node_env = _node_process_env(
        {
            "CODEX_HOME": "/state/.codex-app-server",
            "DRAMACLAW_AGENT_TOKEN": "project-token",
            "DRAMACLAW_PROJECT_ID": "project-a",
            "DRAMACLAW_PROJECT_STATE_DIR": "/state/project-a",
            "ST_ORG_GATEWAY_API_KEY": "organization-token",
            "DRAMACLAW_CODEX_GATEWAY_API_KEY": "node-gateway-token",
            "NEWAPI_API_KEY": "newapi-token",
            "OPENAI_API_KEY": "openai-token",
            "UNLISTED_PROVIDER_SECRET": "must-not-cross-node-boundary",
            "PATH": "/usr/local/bin:/usr/bin",
            "DRAMACLAW_CODEX_GATEWAY_BASE_URL": "https://gateway.example/v1",
        }
    )

    assert node_env == {
        "CODEX_HOME": "/state/.codex-app-server",
        "DRAMACLAW_CODEX_GATEWAY_BASE_URL": "https://gateway.example/v1",
        "PATH": "/usr/local/bin:/usr/bin",
    }


def test_codex_model_defaults_to_gateway_alias(monkeypatch):
    monkeypatch.setattr("novelvideo.shared.runtime_env.is_ce_effective", lambda: False)
    monkeypatch.delenv("CODEX_MODEL", raising=False)

    assert chat_service._codex_model() == "DC-codex-agent-LLM"


def test_ce_codex_model_follows_sqlite_brainclaw_mode(monkeypatch):
    monkeypatch.setattr("novelvideo.shared.runtime_env.is_ce_effective", lambda: True)
    monkeypatch.setattr(
        "novelvideo.model_gateway_settings.get_effective_llm_config",
        lambda: SimpleNamespace(is_brainclaw=True),
    )
    monkeypatch.setenv("CODEX_MODEL", "must-not-control-ce")

    assert chat_service._codex_model() == "brainclaw"


def test_ce_codex_model_keeps_dc_alias_in_sqlite_advanced_mode(monkeypatch):
    monkeypatch.setattr("novelvideo.shared.runtime_env.is_ce_effective", lambda: True)
    monkeypatch.setattr(
        "novelvideo.model_gateway_settings.get_effective_llm_config",
        lambda: SimpleNamespace(is_brainclaw=False),
    )
    monkeypatch.setenv("CODEX_MODEL", "must-not-control-ce")

    assert chat_service._codex_model() == "DC-codex-agent-LLM"


def test_ee_codex_model_uses_environment(monkeypatch):
    monkeypatch.setattr("novelvideo.shared.runtime_env.is_ce_effective", lambda: False)
    monkeypatch.setenv("CODEX_MODEL", "DC-ee-codex-LLM")

    assert chat_service._codex_model() == "DC-ee-codex-LLM"


def test_explicit_codex_does_not_fallback_when_unavailable(monkeypatch):
    monkeypatch.setenv("DRAMACLAW_CHAT_BACKEND", "codex")
    monkeypatch.delenv("SUPERTALE_CHAT_BACKEND", raising=False)
    monkeypatch.setattr(chat_service, "is_codex_backend_available", lambda: False)
    monkeypatch.setattr(chat_service, "is_hermes_backend_available", lambda: True)
    monkeypatch.setattr(chat_service, "is_claude_backend_available", lambda: True)

    with pytest.raises(RuntimeError, match="DRAMACLAW_CHAT_BACKEND=codex requested"):
        chat_service._chat_backend()


def test_codex_backend_rejects_unsafe_sdk_runtime_by_default(monkeypatch):
    monkeypatch.delenv("CODEX_BIN", raising=False)
    monkeypatch.setattr(
        chat_service.importlib.util,
        "find_spec",
        lambda name: object() if name == "openai_codex" else None,
    )

    assert chat_service._codex_bin_path() is None
    assert chat_service.is_codex_backend_available() is False


def test_codex_backend_validates_explicit_binary(monkeypatch, tmp_path):
    missing_bin = tmp_path / "missing-codex"
    monkeypatch.setenv("CODEX_BIN", str(missing_bin))
    monkeypatch.setattr(
        chat_service.importlib.util,
        "find_spec",
        lambda name: object() if name == "openai_codex" else None,
    )

    assert chat_service._codex_bin_path() == missing_bin
    assert chat_service.is_codex_backend_available() is False


@pytest.mark.asyncio
async def test_cancel_interrupts_only_the_users_active_codex_turns(monkeypatch):
    calls = []
    monkeypatch.setattr(
        chat_service,
        "interrupt_live_codex_turn",
        lambda thread_id, turn_id: calls.append((thread_id, turn_id)) or True,
    )
    with chat_service._ACTIVE_CODEX_TURNS_LOCK:
        chat_service._ACTIVE_CODEX_TURNS.clear()
        chat_service._ACTIVE_CODEX_TURNS.update(
            {
                ("alice", "project-a"): ("thread-a", "turn-a"),
                ("alice", "project-b"): ("thread-b", "turn-b"),
                ("bob", "project-c"): ("thread-c", "turn-c"),
            }
        )
    try:
        assert await chat_service.interrupt_active_codex_turns("alice") is True
        assert sorted(calls) == [("thread-a", "turn-a"), ("thread-b", "turn-b")]
    finally:
        with chat_service._ACTIVE_CODEX_TURNS_LOCK:
            chat_service._ACTIVE_CODEX_TURNS.clear()


@pytest.mark.asyncio
async def test_cancel_reads_active_codex_turns_from_other_worker(monkeypatch, tmp_path):
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(tmp_path / "state"))
    chat_service._set_active_codex_turn(
        "alice", "project:project-a", ("thread-a", "turn-a")
    )
    calls = []
    monkeypatch.setattr(chat_service, "interrupt_live_codex_turn", lambda *_: False)
    monkeypatch.setattr(
        chat_service,
        "_control_codex_thread",
        lambda operation, thread_id, turn_id=None: calls.append(
            (operation, thread_id, turn_id)
        )
        or True,
    )

    assert await chat_service.interrupt_active_codex_turns("alice") is True
    assert calls == [("interrupt", "thread-a", "turn-a")]


def test_active_codex_turn_registry_keeps_mainline_and_freezone_scopes_separate(
    monkeypatch, tmp_path
):
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(tmp_path / "state"))
    mainline = chat_service._codex_scope_key("project-a")
    freezone = chat_service._codex_scope_key(
        "project-a",
        agent_profile="freezone:agent-2",
        canvas_id="canvas-a",
    )

    chat_service._set_active_codex_turn(
        "alice", mainline, ("thread-mainline", "turn-mainline")
    )
    chat_service._set_active_codex_turn(
        "alice", freezone, ("thread-freezone", "turn-freezone")
    )
    chat_service._set_active_codex_turn("alice", freezone, None)

    assert chat_service._load_active_codex_turns("alice") == {
        mainline: {
            "thread_id": "thread-mainline",
            "turn_id": "turn-mainline",
        }
    }


@pytest.mark.asyncio
async def test_disconnect_interrupts_only_its_exact_codex_turn(monkeypatch):
    disconnected = asyncio.Event()
    disconnected.set()
    calls = []

    async def interrupt(username, project, thread_id, turn_id, *, backend=None):
        calls.append((username, project, thread_id, turn_id, backend))
        return True

    monkeypatch.setattr(chat_service, "interrupt_chat_turn", interrupt)
    monkeypatch.setattr(
        chat_service,
        "get_chat_backend_name",
        lambda: (_ for _ in ()).throw(AssertionError("backend must be captured")),
    )

    await chat_routes._interrupt_agent_on_disconnect(
        disconnected,
        runtime_backend="codex",
        username="alice",
        project="project-a",
        agent_profile="freezone:main",
        runtime_ids={"thread_id": "thread-a", "turn_id": "turn-a"},
    )

    assert calls == [("alice", "project-a", "thread-a", "turn-a", "codex")]


@pytest.mark.asyncio
async def test_disconnect_closes_only_matching_hermes_thread(monkeypatch):
    from novelvideo.chat import hermes_pool

    disconnected = asyncio.Event()
    disconnected.set()
    calls = []

    class FakePool:
        async def close_user_thread(self, username, profile, thread_id):
            calls.append((username, profile, thread_id))
            return True

        async def close_user(self, _username):
            raise AssertionError("disconnect must not close every user worker")

    monkeypatch.setattr(hermes_pool, "pool", FakePool())

    await chat_routes._interrupt_agent_on_disconnect(
        disconnected,
        runtime_backend="hermes",
        username="alice",
        project="project-a",
        agent_profile="freezone:agent-2",
        runtime_ids={"thread_id": "session-a", "turn_id": "turn-a"},
    )

    assert calls == [("alice", "freezone:agent-2", "session-a")]


@pytest.mark.asyncio
async def test_interrupt_chat_turn_uses_captured_backend(monkeypatch):
    monkeypatch.setattr(
        chat_service,
        "_chat_backend",
        lambda: (_ for _ in ()).throw(AssertionError("must not re-read backend")),
    )
    monkeypatch.setattr(chat_service, "interrupt_live_codex_turn", lambda *_: True)

    assert await chat_service.interrupt_chat_turn(
        "alice",
        "project-a",
        "thread-a",
        "turn-a",
        backend="codex",
    )


def test_chat_run_lock_is_user_scoped(monkeypatch, tmp_path):
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(tmp_path / "state"))
    monkeypatch.setenv("NOVELVIDEO_OUTPUT_DIR", str(tmp_path / "output"))

    lock_id = chat_service._acquire_chat_run_lock("admin", "project-a")
    try:
        with pytest.raises(RuntimeError, match="当前用户已有 AI 对话"):
            chat_service._acquire_chat_run_lock("admin", "project-b")
    finally:
        chat_service._release_chat_run_lock("admin", "project-a", lock_id)

    next_lock_id = chat_service._acquire_chat_run_lock("admin", "project-b")
    chat_service._release_chat_run_lock("admin", "project-b", next_lock_id)


def test_freezone_chat_run_lock_is_agent_scoped(monkeypatch, tmp_path):
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(tmp_path / "state"))

    first_scope = ChatScope(
        kind="project",
        id="project-a",
        surface="freezone",
        canvas_id="canvas-a",
        agent_id="agent-1",
    )
    second_scope = ChatScope(
        kind="project",
        id="project-a",
        surface="freezone",
        canvas_id="canvas-a",
        agent_id="agent-2",
    )
    first_lock_project = chat_service._chat_run_lock_project_for_turn(
        "project-a",
        tool_mode="freezone_canvas",
        store_scope=first_scope,
    )
    second_lock_project = chat_service._chat_run_lock_project_for_turn(
        "project-a",
        tool_mode="freezone_canvas",
        store_scope=second_scope,
    )

    first_lock_id = chat_service._acquire_chat_run_lock("admin", first_lock_project)
    try:
        second_lock_id = chat_service._acquire_chat_run_lock(
            "admin", second_lock_project
        )
        chat_service._release_chat_run_lock(
            "admin", second_lock_project, second_lock_id
        )
    finally:
        chat_service._release_chat_run_lock("admin", first_lock_project, first_lock_id)


def test_director_chat_run_lock_remains_project_scoped(monkeypatch, tmp_path):
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(tmp_path / "state"))

    lock_project = chat_service._chat_run_lock_project_for_turn(
        "project-a",
        tool_mode="default",
        store_scope=ChatScope(
            kind="project",
            id="project-a",
            surface="director",
            agent_id="agent-2",
        ),
    )

    assert lock_project == "project-a"


def test_chat_run_lock_uses_named_agent_locks_dir(monkeypatch, tmp_path):
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(tmp_path / "state"))

    lock_path = chat_service._chat_run_lock_path("admin", "project-a")

    assert lock_path.parent == tmp_path / "state" / "admin" / "chat_agent_locks"
    assert lock_path.name.endswith(".lock")


def test_chat_run_lock_file_expires_after_ten_minutes(monkeypatch, tmp_path):
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(tmp_path / "state"))
    assert chat_service._CHAT_RUN_LOCK_TTL_SECONDS == 10 * 60

    lock_path = chat_service._chat_run_lock_path("admin", "project-a")
    stale_started_at = datetime.now(timezone.utc) - timedelta(seconds=10 * 60 + 1)
    lock_path.write_text(
        json.dumps(
            {
                "lock_id": "stale-lock",
                "owner_pid": os.getpid(),
                "started_at": stale_started_at.isoformat(),
            }
        ),
        encoding="utf-8",
    )

    lock_id = chat_service._acquire_chat_run_lock("admin", "project-a")
    try:
        assert lock_id != "stale-lock"
        assert lock_path.exists()
    finally:
        chat_service._release_chat_run_lock("admin", "project-a", lock_id)


def test_chat_run_lock_uses_updated_at_for_idle_timeout(monkeypatch, tmp_path):
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(tmp_path / "state"))

    lock_path = chat_service._chat_run_lock_path("admin", "project-a")
    old_started_at = datetime.now(timezone.utc) - timedelta(seconds=10 * 60 + 1)
    fresh_updated_at = datetime.now(timezone.utc)
    lock_path.write_text(
        json.dumps(
            {
                "lock_id": "active-long-run",
                "owner_pid": os.getpid(),
                "started_at": old_started_at.isoformat(),
                "updated_at": fresh_updated_at.isoformat(),
            }
        ),
        encoding="utf-8",
    )

    assert chat_service.chat_run_lock_is_active("admin", "project-a") is True
    with pytest.raises(RuntimeError, match="当前用户已有 AI 对话"):
        chat_service._acquire_chat_run_lock("admin", "project-a")


def test_chat_run_lock_still_has_max_runtime(monkeypatch, tmp_path):
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(tmp_path / "state"))

    lock_path = chat_service._chat_run_lock_path("admin", "project-a")
    too_old_started_at = datetime.now(timezone.utc) - timedelta(
        seconds=chat_service._CHAT_RUN_LOCK_MAX_SECONDS + 1
    )
    lock_path.write_text(
        json.dumps(
            {
                "lock_id": "too-old-lock",
                "owner_pid": os.getpid(),
                "started_at": too_old_started_at.isoformat(),
                "updated_at": datetime.now(timezone.utc).isoformat(),
            }
        ),
        encoding="utf-8",
    )

    lock_id = chat_service._acquire_chat_run_lock("admin", "project-a")
    try:
        assert lock_id != "too-old-lock"
    finally:
        chat_service._release_chat_run_lock("admin", "project-a", lock_id)


def test_chat_run_lock_heartbeat_refreshes_updated_at(monkeypatch, tmp_path):
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(tmp_path / "state"))
    atomic_writes = []
    original_atomic_write = chat_service._atomic_write_chat_run_lock_file

    def spy_atomic_write(path, payload):
        atomic_writes.append((path, payload))
        original_atomic_write(path, payload)

    monkeypatch.setattr(
        chat_service, "_atomic_write_chat_run_lock_file", spy_atomic_write
    )

    lock_id = chat_service._acquire_chat_run_lock("admin", "project-a")
    lock_path = chat_service._chat_run_lock_path("admin", "project-a")
    try:
        _current_lock_id, _owner_pid, started_at, updated_at = (
            chat_service._read_chat_run_lock_file(lock_path)
        )
        assert started_at is not None
        assert updated_at is not None
        old_updated_at = started_at - timedelta(seconds=30)
        lock_path.write_text(
            json.dumps(
                {
                    "lock_id": lock_id,
                    "owner_pid": os.getpid(),
                    "started_at": started_at.isoformat(),
                    "updated_at": old_updated_at.isoformat(),
                }
            ),
            encoding="utf-8",
        )

        assert (
            chat_service._heartbeat_chat_run_lock("admin", "project-a", lock_id) is True
        )
        assert len(atomic_writes) == 1
        assert atomic_writes[0][0] == lock_path
        assert json.loads(atomic_writes[0][1])["lock_id"] == lock_id
        refreshed_lock_id, _owner_pid, refreshed_started_at, refreshed_updated_at = (
            chat_service._read_chat_run_lock_file(lock_path)
        )
        assert refreshed_lock_id == lock_id
        assert refreshed_started_at == started_at
        assert refreshed_updated_at is not None
        assert refreshed_updated_at > old_updated_at
    finally:
        chat_service._release_chat_run_lock("admin", "project-a", lock_id)


def test_chat_run_lock_treats_new_empty_lock_as_active(monkeypatch, tmp_path):
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(tmp_path / "state"))
    lock_path = chat_service._chat_run_lock_path("admin", "project-a")
    lock_path.write_text("", encoding="utf-8")

    with pytest.raises(RuntimeError, match="当前用户已有 AI 对话"):
        chat_service._acquire_chat_run_lock("admin", "project-a")

    assert lock_path.exists()


def test_chat_run_lock_removes_old_invalid_lock(monkeypatch, tmp_path):
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(tmp_path / "state"))
    lock_path = chat_service._chat_run_lock_path("admin", "project-a")
    lock_path.write_text("", encoding="utf-8")
    old_mtime = (
        datetime.now(timezone.utc).timestamp()
        - chat_service._CHAT_RUN_LOCK_BIRTH_GRACE_SECONDS
        - 1
    )
    os.utime(lock_path, (old_mtime, old_mtime))

    lock_id = chat_service._acquire_chat_run_lock("admin", "project-a")
    try:
        assert lock_path.exists()
        assert chat_service._read_chat_run_lock_file(lock_path)[0] == lock_id
    finally:
        chat_service._release_chat_run_lock("admin", "project-a", lock_id)


@pytest.mark.anyio
async def test_reingest_confirmation_reply_bypasses_agent_backend(
    monkeypatch, tmp_path
):
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(tmp_path / "state"))
    monkeypatch.setattr(
        chat_service,
        "_chat_backend",
        lambda: pytest.fail("reingest confirmation should not call the agent backend"),
    )
    events = []

    async def on_event(event):
        events.append(event)

    result = await chat_service.stream_assistant_reply(
        "admin",
        "project-a",
        """创建视频

[DRAMACLAW_REINGEST_CONFIRMATION]
stage: choose_overwrite
dramaclaw_project_id: project-a
filename: novel.docx
[/DRAMACLAW_REINGEST_CONFIRMATION]""",
        on_event,
    )

    assert "当前项目已有摄入内容" in result["content"]
    assert "覆盖" in result["content"]
    assert "新建项目" not in result["content"]
    assert [event["type"] for event in events] == ["assistant_delta", "done"]


@pytest.mark.anyio
async def test_reingest_final_confirmation_reply_bypasses_agent_backend(
    monkeypatch, tmp_path
):
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(tmp_path / "state"))
    monkeypatch.setattr(
        chat_service,
        "_chat_backend",
        lambda: pytest.fail("reingest confirmation should not call the agent backend"),
    )

    async def on_event(event):
        pass

    result = await chat_service.stream_assistant_reply(
        "admin",
        "project-a",
        """覆盖

[DRAMACLAW_REINGEST_CONFIRMATION]
stage: confirm_clear
dramaclaw_project_id: project-a
filename: novel.docx
[/DRAMACLAW_REINGEST_CONFIRMATION]""",
        on_event,
    )

    assert "会清空/重建当前项目已有角色" in result["content"]
    assert "确定" in result["content"]
    assert "新建项目" not in result["content"]


def test_prompt_injects_json_render_contract(monkeypatch, tmp_path):
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(tmp_path / "state"))

    prompt = chat_service._prompt_with_user_context(
        "admin",
        "project-a",
        "查看肖像图片，用 json-render 显示",
    )

    assert "[RENDERING_CONTRACT]" in prompt
    assert "才需要调用对应的 DramaClaw 展示工具" in prompt
    assert "不要向用户解释内部渲染格式、渲染机制、工具调用过程或工具名" in prompt
    assert "不要用文字列表、文件名列表、Beat 名称列表或 URL 列表替代媒体展示" in prompt
    assert "必须调用对应展示工具" in prompt
    assert "若没有工具返回的可展示媒体，只说明当前暂无可展示媒体" in prompt
    assert "后端会自动把工具结果渲染为 json-render" not in prompt
    assert "不要手写、复制或粘贴 <ui-spec> JSON" not in prompt
    assert "dramaclaw_get_character_media" in prompt
    assert "dramaclaw_get_sketches" in prompt
    assert "dramaclaw_get_scene_images" in prompt
    assert "dramaclaw_get_episode_media" in prompt
    assert (
        "只有在回复需要展示图片、肖像、身份图、草图、首帧、视频、音频等可视/可播放媒体时"
        in prompt
    )
    assert "media_json" in prompt
    assert "不要猜测、拼接或改写静态资源路径" in prompt
    assert "禁止自行编造 /static/projects/{project_id}/..." in prompt
    assert "portrait_url" in prompt
    assert "image_url" in prompt
    assert "video_url" in prompt
    assert "不要使用 *_path" in prompt
    assert "发送前自检" in prompt
    assert (
        "角色列表、剧集规划、项目进度、任务状态、脚本/beat 摘要、表格、长篇正文、普通结构化说明默认使用 markdown"
        in prompt
    )
    assert "不要为纯文本、进度、脚本、表格、角色/剧集清单调用媒体展示工具" in prompt
    assert "[USER_PREFERENCES]" not in prompt
    assert "reused across projects" not in prompt
    assert not (tmp_path / "state" / "admin" / "preferences.md").exists()
    assert prompt.rstrip().endswith("查看肖像图片，用 json-render 显示")


def test_prompt_injects_one_step_execution_hint_for_explicit_continuation(
    monkeypatch, tmp_path
):
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(tmp_path / "state"))

    prompt = chat_service._prompt_with_user_context(
        "admin",
        "project-a",
        "下一步",
        route_prompt="下一步",
    )

    assert "[DRAMACLAW_CONTINUATION]" in prompt
    assert "start exactly one matching write" in prompt
    assert "dramaclaw_render_first_frames" in prompt
    assert "Do not reread identical status" in prompt
    assert prompt.rstrip().endswith("下一步")


def test_prompt_does_not_treat_continuation_question_as_write_authorization(
    monkeypatch, tmp_path
):
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(tmp_path / "state"))

    prompt = chat_service._prompt_with_user_context(
        "admin",
        "project-a",
        "为什么点击下一步不能继续？",
        route_prompt="为什么点击下一步不能继续？",
    )

    assert "[DRAMACLAW_CONTINUATION]" not in prompt


def test_prompt_does_not_inject_mainline_continuation_into_freezone(
    monkeypatch, tmp_path
):
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(tmp_path / "state"))

    prompt = chat_service._prompt_with_user_context(
        "admin",
        "project-a",
        "下一步",
        tool_mode="freezone_canvas",
        route_prompt="下一步",
    )

    assert "[DRAMACLAW_CONTINUATION]" not in prompt


def test_freezone_prompt_allows_creative_ideation_canvas_framework_without_mainline_generation(
    monkeypatch, tmp_path
):
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(tmp_path / "state"))

    prompt = chat_service._prompt_with_user_context(
        "admin",
        "project-a",
        "我想做个公益短片没思路",
        tool_mode="freezone_canvas",
        surface_context={"freezone_canvas_id": "canvas-a"},
    )

    assert "creative ideas into working canvas material" in prompt
    assert "answer in chat" in chat_service._CODEX_FREEZONE_DEVELOPER_INSTRUCTIONS
    assert (
        "do not call a canvas write tool merely because"
        in chat_service._CODEX_FREEZONE_DEVELOPER_INSTRUCTIONS
    )
    assert "answer in chat" not in chat_service._FREEZONE_CANVAS_ASSISTANT_INSTRUCTIONS
    assert "command catalog" in prompt
    assert "node create schema" in prompt
    assert "link type catalog" in prompt
    assert "call a Freezone write tool" in prompt
    assert "first assistant output MUST be that" in prompt
    assert "Skill/catalog reads required by the next rule" in prompt
    assert "prose first" in prompt
    assert "matching single-operation write tool" in prompt
    assert "successful same-turn frontend write result" in prompt
    assert "Validate" in prompt
    assert "batch only for several ordinary non-workflow" in prompt
    assert "freezone_prepare_workflow_plan_draft once" in prompt
    assert "not a Workflow catalog `skill_id`" in prompt
    assert "Do not ask for a second “创建并运行” confirmation" in prompt
    assert "the write tool creates it" in prompt
    assert "Never\n  use the host's built-in request_user_input" in prompt
    assert "canvas video/audio/composition nodes" in prompt
    assert "videoComposeNode is terminal" in prompt
    assert "never connect planning text or prompts to it" in prompt
    assert "Do not start, mutate, or use" in prompt
    assert "DramaClaw mainline production tools" in prompt
    assert "[RENDERING_CONTRACT]" not in prompt
    assert "dramaclaw_get_episode_media" not in prompt
    assert "do not generate/plan scripts" not in prompt


def test_freezone_prompt_defaults_canvas_execution_mode_to_manual_confirmation(
    monkeypatch, tmp_path
):
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(tmp_path / "state"))

    prompt = chat_service._prompt_with_user_context(
        "admin",
        "project-a",
        "生成一张图片",
        tool_mode="freezone_canvas",
        surface_context={"freezone_canvas_id": "canvas-a"},
    )

    assert "[FREEZONE_CANVAS_EXECUTION_MODE]" in prompt
    assert "mode: manual_confirm" in prompt
    assert "Do not ask a preliminary image/video parameter clarification" in prompt
    assert "approval card is where the user reviews and adjusts" in prompt


def test_freezone_prompt_injects_auto_execute_parameter_policy(monkeypatch, tmp_path):
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(tmp_path / "state"))

    prompt = chat_service._prompt_with_user_context(
        "admin",
        "project-a",
        "生成一段视频",
        tool_mode="freezone_canvas",
        surface_context={
            "freezone_canvas_id": "canvas-a",
            "canvas_command_execution_mode": "auto_execute",
        },
    )

    assert "mode: auto_execute" in prompt
    assert "ask once before the canvas write" in prompt
    assert "one structured question per missing field" in prompt
    assert "frontend auto-applies it" in prompt
    assert "without asking for another create/run confirmation" in prompt
    assert "never built-in request_user_input" in prompt


def test_codex_freezone_prompt_requires_fresh_parameter_selection_for_each_turn(
    monkeypatch, tmp_path
):
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(tmp_path / "state"))

    prompt = chat_service._prompt_with_user_context(
        "admin",
        "project-a",
        "继续生成视频",
        tool_mode="freezone_canvas",
        surface_context={
            "freezone_canvas_id": "canvas-a",
            "canvas_command_execution_mode": "manual_confirm",
        },
        turn_id="turn-current-123",
        require_generation_parameter_preflight=True,
    )

    assert "generation_parameter_round: turn-current-123" in prompt
    assert "For every new request in this round" in prompt
    assert "Historical clarification answers" in prompt
    assert "they never count as confirmation for this round" in prompt
    assert "never add a system-voice/custom-voice choice" in prompt
    assert "do not ask the user to choose system voice versus custom voice" in prompt
    assert "The normal approval card is still shown" in prompt
    assert "Do not ask a preliminary image/video parameter clarification" not in prompt


def test_freezone_prompt_omits_skill_studio_contract_for_normal_canvas_requests(
    monkeypatch, tmp_path
):
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(tmp_path / "state"))

    prompt = chat_service._prompt_with_user_context(
        "admin",
        "project-a",
        "加一个视频节点",
        tool_mode="freezone_canvas",
        surface_context={"freezone_canvas_id": "canvas-a"},
    )

    assert "[FREEZONE_SKILL_STUDIO]" not in prompt
    assert "freezone_present_agent_catalog_draft" not in prompt


def test_freezone_prompt_routes_skill_studio_by_user_text_not_canvas_context(
    monkeypatch, tmp_path
):
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(tmp_path / "state"))

    prompt = chat_service._prompt_with_user_context(
        "admin",
        "project-a",
        (
            "查看下当前节点详情然后返回ok\n\n"
            "[SUPERTALE_CANVAS_NODE_REFERENCES]\n"
            "node_type: skillNode\n"
            "available_actions: add_next_node, run_skill\n"
            "[/SUPERTALE_CANVAS_NODE_REFERENCES]"
        ),
        tool_mode="freezone_canvas",
        surface_context={"freezone_canvas_id": "canvas-a"},
        route_prompt="查看下当前节点详情然后返回ok",
    )

    assert "[FREEZONE_SKILL_STUDIO]" not in prompt
    assert "freezone_present_agent_catalog_draft" not in prompt
    assert "node_type: skillNode" in prompt
    assert "available_actions: add_next_node, run_skill" in prompt


def test_prompt_keeps_transport_context_out_of_user_message(monkeypatch, tmp_path):
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(tmp_path / "state"))
    transport_context = (
        "[SUPERTALE_CANVAS_NODE_REFERENCES]\n"
        "node_type: skillNode\n"
        "available_actions: add_next_node, run_skill\n"
        "[/SUPERTALE_CANVAS_NODE_REFERENCES]"
    )

    prompt = chat_service._prompt_with_user_context(
        "admin",
        "project-a",
        f"你是谁？\n\n{transport_context}",
        tool_mode="freezone_canvas",
        surface_context={"freezone_canvas_id": "canvas-a"},
        route_prompt="你是谁？",
    )

    assert "[DRAMACLAW_EXECUTION_CONTEXT]" in prompt
    assert transport_context in prompt
    assert prompt.index(transport_context) < prompt.index("[USER_MESSAGE]")
    assert prompt.rsplit("[USER_MESSAGE]\n", 1)[1] == "你是谁？"
    assert prompt.count(transport_context) == 1


def test_prompt_preserves_legacy_full_message_without_route_prompt(
    monkeypatch, tmp_path
):
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(tmp_path / "state"))
    legacy_prompt = "你是谁？\n\n[LEGACY_CONTEXT]\nlarge transport context"

    prompt = chat_service._prompt_with_user_context(
        "admin",
        "project-a",
        legacy_prompt,
    )

    assert "[DRAMACLAW_EXECUTION_CONTEXT]" not in prompt
    assert prompt.rsplit("[USER_MESSAGE]\n", 1)[1] == legacy_prompt


def test_freezone_prompt_includes_clarification_card_rule_for_interactive_questions(
    monkeypatch, tmp_path
):
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(tmp_path / "state"))

    prompt = chat_service._prompt_with_user_context(
        "admin",
        "project-a",
        "你给我提几个问题测试一下我对重庆了解多少",
        tool_mode="freezone_canvas",
        surface_context={"freezone_canvas_id": "canvas-a"},
    )

    assert "Clarification:" in prompt
    assert "freezone_request_user_clarification" in prompt
    assert (
        "not tool fields, node types, link_type, schema, or model parameters" in prompt
    )
    assert "[FREEZONE_SKILL_STUDIO]" not in prompt
    assert "freezone_present_agent_catalog_draft" not in prompt


def test_freezone_prompt_includes_skill_studio_contract_only_for_catalog_intent(
    monkeypatch, tmp_path
):
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(tmp_path / "state"))

    prompt = chat_service._prompt_with_user_context(
        "admin",
        "project-a",
        "帮我创建一个电商详情页 Skill",
        tool_mode="freezone_canvas",
        surface_context={"freezone_canvas_id": "canvas-a"},
    )

    assert "[FREEZONE_SKILL_STUDIO]" in prompt
    assert "freezone_request_user_clarification" in prompt
    assert "freezone_begin_agent_catalog_draft" in prompt
    assert "freezone_patch_agent_catalog_draft" in prompt
    assert "freezone_put_agent_catalog_recipe" in prompt
    assert "freezone_finish_agent_catalog_draft" in prompt
    assert "For local edits, prefer freezone_patch_agent_catalog_draft" in prompt
    assert "Do not regenerate unchanged Recipes" in prompt
    assert (
        "The top-level parameter is patch, not operation, operations, or patches"
        in prompt
    )
    assert 'patch=[{"op":"remove","path":""}]' in prompt
    assert "expected_recipe_count" in prompt
    assert "Use 0 when every Recipe is reused" in prompt
    assert "Do not pass the full Skill/Recipe catalog in one tool call" in prompt
    assert "skill_studio_session_id" in prompt
    assert "Do not claim the Skill or Recipe is saved" in prompt
    assert "Do not ask whether to\n  save the current draft" in prompt
    assert "save_now/save_current/confirm_save" in prompt
    assert "prompt/instruction generator" in prompt
    assert "不要直接生成最终内容" in prompt
    assert "送入对应节点" in prompt
    assert (
        "planning.planning_notes must start with an executable path summary" in prompt
    )
    assert "planning.conduct_rules must include hard execution rules" in prompt
    assert "Do not include workflow_templates" in prompt
    assert "complete dynamic freezone_workflow_plan.v1" in prompt
    assert "dynamic dependency rules" in prompt
    assert (
        "Recipe system_prompt must never be the final downstream prompt itself"
        in prompt
    )
    assert "重要：你的输出是一条提示词/指令" in prompt
    assert "终端生成型" not in prompt
    assert "不要把所有 Recipe 都写成 prompt compiler" not in prompt
    assert "must not emit Freezone canvas commands" in prompt
    assert (
        "All user-visible Skill Studio text must follow the user's current language"
        in prompt
    )
    assert "Do not mix languages casually" in prompt


def test_freezone_prompt_separates_new_skill_from_current_canvas_context(
    monkeypatch, tmp_path
):
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(tmp_path / "state"))

    prompt = chat_service._prompt_with_user_context(
        "admin",
        "project-a",
        "我想做一个制作公益短片的 skill",
        tool_mode="freezone_canvas",
        surface_context={"freezone_canvas_id": "canvas-a"},
    )

    assert "[FREEZONE_SKILL_STUDIO]" in prompt
    assert "new_from_user_brief" in prompt
    assert "current canvas is ambient context, not source evidence" in prompt
    assert "Do not ask whether to preserve current project details" in prompt
    assert (
        "topic/domain, audience/context, artifact scope, style/tone, and workflow granularity"
        in prompt
    )
    assert "distill_from_canvas" in prompt


def test_freezone_prompt_requires_summary_confirmation_for_canvas_workflow_skill(
    monkeypatch, tmp_path
):
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(tmp_path / "state"))

    prompt = chat_service._prompt_with_user_context(
        "admin",
        "project-a",
        "把当前流程保存成 Skill",
        tool_mode="freezone_canvas",
        surface_context={"freezone_canvas_id": "canvas-a"},
    )

    assert "[FREEZONE_SKILL_STUDIO]" in prompt
    assert "distill_from_canvas" in prompt
    assert (
        "current canvas, current flow, selected nodes, this project, this workflow, or existing workflow"
        in prompt
    )
    assert "call freezone_get_canvas_ontology before asking any question" in prompt
    assert (
        "Do not use canvas summary as the evidence source for Skill Studio questions"
        in prompt
    )
    assert "fetch only a few key node details with freezone_get_node_detail" in prompt
    assert "ask 2-4 high-quality confirmation questions first" in prompt
    assert "infer the reusable workflow and current production style" in prompt
    assert "Each question should usually provide 3-5 user-facing options" in prompt
    assert "decision matrix" in prompt
    assert "Do not merge these layers into one question" in prompt
    assert "Do not over-infer visual style from node names" in prompt
    assert 'Never present a vague phrase such as "光影风格广告"' in prompt
    assert (
        "The first question for canvas distillation should usually be about what workflow method to preserve"
        in prompt
    )
    assert "Each confirmation question must ask one decision only" in prompt
    assert "what style or quality rules must stay" in prompt
    assert (
        "Before showing a clarification card, briefly state the canvas evidence in plain user language"
        in prompt
    )
    assert (
        "Translate internal analysis labels into user-facing question titles" in prompt
    )
    assert "下次主要复用什么？" in prompt
    assert "下次可以替换哪些内容？" in prompt
    assert "哪些效果必须保持？" in prompt
    assert "每次开始前要确认什么？" in prompt
    assert (
        "Option text should describe the effect of choosing it, not the implementation"
        in prompt
    )
    assert "Do not always ask the same two questions" in prompt
    assert "do not expose internal terms such as Recipe, Recipes, 配方" in prompt
    assert "freezone_request_user_clarification" in prompt


def test_freezone_prompt_requires_canvas_workflow_distillation_rules(
    monkeypatch, tmp_path
):
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(tmp_path / "state"))

    prompt = chat_service._prompt_with_user_context(
        "admin",
        "project-a",
        "帮我把当前画布总结成一个 Skill",
        tool_mode="freezone_canvas",
        surface_context={"freezone_canvas_id": "canvas-a"},
    )

    assert "skill-studio-authoring-guide.md" in prompt
    assert "canvas_workflow_analysis" in prompt
    assert (
        "based on freezone_get_canvas_ontology evidence or key node detail evidence"
        in prompt
    )
    assert (
        "Do not call freezone_request_user_clarification for canvas distillation until you have canvas evidence"
        in prompt
    )
    assert "production_method" in prompt
    assert "visual_language" in prompt
    assert "case_variables" in prompt
    assert "reusable_protocol" in prompt
    assert "hard_constraints" in prompt
    assert "start_options" in prompt
    assert "applicability_scope" in prompt
    assert (
        "Only mention a concrete visual style when it is actually supported" in prompt
    )
    assert "not on the user's short request or canvas summary" in prompt
    assert "Do not read every node detail one by one" in prompt
    assert "Do not treat tool schemas as authoring guidance" in prompt
    assert "capability modeling" in prompt
    assert "schema fields are final serialization constraints" in prompt
    assert "Do not ask for Skill name, category, or fixed topology" in prompt
    assert "concrete case vs reusable Skill" in prompt
    assert "user-facing reuse mode" in prompt
    assert "Use product language such as" in prompt
    assert "Do not include workflow_templates" in prompt
    assert "Every Skill must include allowed_recipe_ids" in prompt
    assert "videoCompose may appear only as a terminal node" in prompt
    assert "Do not create a Recipe for videoCompose" in prompt
    assert (
        "Do not present videoCompose, final media composition, or final synthesis as a user-facing granularity option"
        in prompt
    )
    assert (
        "do not count the terminal composition step in the user-facing step count"
        in prompt
    )
    assert "textGeneration Recipe for a compose/timeline plan" in prompt
    assert "Extract hard constraints from repeated prompt text" in prompt
    assert "perform prompt_evidence_analysis before topology summarization" in prompt
    assert "domain_contract or creative_contract" in prompt
    assert (
        "repeated prompt phrases, media facts, source filenames, references, and edges"
        in prompt
    )
    assert "not from displayName or node type alone" in prompt
    assert (
        "Write the domain_contract or creative_contract into existing fields: planning_notes, conduct_rules, evaluation.domain_constraints, and Recipe quality standards"
        in prompt
    )
    assert "perform skill_identity_analysis after prompt_evidence_analysis" in prompt
    assert (
        "case_variables, reusable_protocol_terms, output_format_terms, use_case_terms, and workflow_method_terms"
        in prompt
    )
    assert "Skill name, id, description, and triggers.keywords" in prompt
    assert "remove case_variables but preserve reusable_protocol_terms" in prompt
    assert (
        "Do not let workflow_method_terms alone dominate the Skill identity" in prompt
    )
    assert (
        "keywords must cover protocol, output format, use case, and workflow method"
        in prompt
    )
    assert "Express it in generic layers first" in prompt
    assert (
        "global creative language, stage-specific exceptions, and inheritance rules"
        in prompt
    )
    assert (
        "For non-visual domains, the same contract may capture metric definitions, legal jurisdiction, teaching level, voice persona, or gameplay rules"
        in prompt
    )
    assert "Do not derive Recipes only from node types" in prompt


def test_tool_mode_infers_freezone_from_frontend_canvas_injection():
    prompt = """加个视频节点

[SUPERTALE_CANVAS_ROUTING]
Current surface is Freezone canvas.
[/SUPERTALE_CANVAS_ROUTING]"""

    assert chat_service._tool_mode_for_surface(None, prompt=prompt) == "freezone_canvas"


def test_tool_mode_infers_freezone_from_canvas_context():
    assert (
        chat_service._tool_mode_for_surface(
            None,
            surface_context={"freezone_canvas_id": "canvas-a"},
        )
        == "freezone_canvas"
    )


def test_project_media_uses_project_id_url_and_explicit_project_dir(tmp_path):
    project_dir = tmp_path / "output" / "admin" / "demo"
    image = project_dir / "frames" / "ep001" / "beat_01.png"
    image.parent.mkdir(parents=True)
    image.write_bytes(b"image")

    media = chat_service._extract_media(
        "use frames/ep001/beat_01.png",
        "admin",
        "01KS_PROJECT_ID",
        project_dir=project_dir,
    )

    assert media == [
        {
            "kind": "image",
            "url": f"/static/projects/01KS_PROJECT_ID/frames/ep001/beat_01.png?v={image.stat().st_mtime_ns}",
            "path": "frames/ep001/beat_01.png",
            "label": "beat_01.png",
        }
    ]


def test_markdown_project_image_is_not_duplicated_as_media(tmp_path):
    project_dir = tmp_path / "output" / "admin" / "demo"
    image = project_dir / "frames" / "ep001" / "beat_01.png"
    image.parent.mkdir(parents=True)
    image.write_bytes(b"image")

    media = chat_service._extract_media(
        "![frame](/static/projects/01KS_PROJECT_ID/frames/ep001/beat_01.png)",
        "admin",
        "01KS_PROJECT_ID",
        project_dir=project_dir,
    )

    assert media == []


def test_markdown_project_image_filters_normalized_media_item(tmp_path):
    project_dir = tmp_path / "output" / "admin" / "demo"
    image = project_dir / "frames" / "ep001" / "beat_01.png"
    image.parent.mkdir(parents=True)
    image.write_bytes(b"image")
    url = f"/static/projects/01KS_PROJECT_ID/frames/ep001/beat_01.png?v={image.stat().st_mtime_ns}"

    media = chat_service._filter_markdown_duplicate_images(
        "![frame](/static/projects/01KS_PROJECT_ID/frames/ep001/beat_01.png)",
        [
            {
                "kind": "image",
                "url": url,
                "path": "frames/ep001/beat_01.png",
                "label": "beat_01.png",
            }
        ],
    )

    assert media == []


def test_project_chat_storage_uses_resolved_project_state_dir(monkeypatch, tmp_path):
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(tmp_path / "state"))
    monkeypatch.setenv("NOVELVIDEO_OUTPUT_DIR", str(tmp_path / "output"))
    project_dir = tmp_path / "output" / "admin" / "demo"
    project_state_dir = tmp_path / "managed-state" / "projects" / "01KS_PROJECT_ID"
    project_dir.mkdir(parents=True)
    project_state_dir.mkdir(parents=True)

    chat_service.add_user_message(
        "admin",
        "01KS_PROJECT_ID",
        "hello",
        project_dir=project_dir,
        project_state_dir=project_state_dir,
    )

    assert (project_state_dir / "chat.db").exists()
    assert not (tmp_path / "state" / "admin" / "01KS_PROJECT_ID").exists()
    assert not (tmp_path / "output" / "admin" / "01KS_PROJECT_ID").exists()


def test_project_chat_storage_creates_missing_resolved_state_dir(monkeypatch, tmp_path):
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(tmp_path / "state"))
    project_state_dir = tmp_path / "managed-state" / "missing-project"

    chat_service.add_user_message(
        "admin",
        "01KS_PROJECT_ID",
        "hello",
        project_state_dir=project_state_dir,
    )

    assert (project_state_dir / "chat.db").exists()
    assert not (tmp_path / "state" / "admin" / "01KS_PROJECT_ID").exists()


def test_project_history_hides_trace_messages(monkeypatch, tmp_path):
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(tmp_path / "state"))
    monkeypatch.setenv("NOVELVIDEO_OUTPUT_DIR", str(tmp_path / "output"))

    chat_service.add_user_message("admin", "project-a", "你好")
    chat_service.add_trace_message(
        "admin", "project-a", "→ dramaclaw_pipeline_status\ncompleted"
    )
    chat_service.add_assistant_message("admin", "project-a", "你好！")

    messages = chat_service.list_messages("admin", "project-a")

    assert [message["role"] for message in messages] == ["user", "assistant"]
    assert all(
        "dramaclaw_pipeline_status" not in message["content"] for message in messages
    )


def test_project_history_defaults_to_last_50_messages(monkeypatch, tmp_path):
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(tmp_path / "state"))
    monkeypatch.setenv("NOVELVIDEO_OUTPUT_DIR", str(tmp_path / "output"))

    for index in range(60):
        chat_service.add_assistant_message("admin", "project-a", f"message-{index:02d}")

    messages = chat_service.list_messages("admin", "project-a")

    assert len(messages) == 50
    assert messages[0]["content"] == "message-10"
    assert messages[-1]["content"] == "message-59"


def test_home_history_hides_trace_messages(monkeypatch, tmp_path):
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(tmp_path / "state"))
    scope = ChatScope(kind="home")

    chat_store.append_message("admin", scope, "user", "你好")
    chat_store.append_message(
        "admin", scope, "trace", "→ dramaclaw_pipeline_status\ncompleted"
    )
    chat_store.append_message("admin", scope, "assistant", "你好！")

    messages = chat_store.list_messages("admin", scope)

    assert [message["role"] for message in messages] == ["user", "assistant"]
    assert all(
        "dramaclaw_pipeline_status" not in message["content"] for message in messages
    )


def test_chat_history_keeps_repeated_assistant_replies_across_turns(
    monkeypatch, tmp_path
):
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(tmp_path / "state"))
    scope = ChatScope(kind="home")

    chat_store.append_message("admin", scope, "user", "你好", turn_id="turn-1")
    chat_store.append_message(
        "admin", scope, "assistant", "你好！有什么可以帮你？", turn_id="turn-1"
    )
    chat_store.append_message("admin", scope, "user", "你好", turn_id="turn-2")
    chat_store.append_message(
        "admin", scope, "assistant", "你好！有什么可以帮你？", turn_id="turn-2"
    )

    messages = chat_store.list_messages("admin", scope)

    assert [message["role"] for message in messages] == [
        "user",
        "assistant",
        "user",
        "assistant",
    ]
    assert messages[1]["content"] == "你好！有什么可以帮你？"
    assert messages[3]["content"] == "你好！有什么可以帮你？"


def test_freezone_history_uses_separate_project_chat_db(monkeypatch, tmp_path):
    state_root = tmp_path / "state"
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(state_root))

    chat_service.add_user_message("admin", "project-a", "mainline")
    scope = ChatScope(
        kind="project", id="project-a", surface="freezone", canvas_id="canvas-a"
    )
    chat_store.append_message("admin", scope, "user", "canvas")

    assert chat_service.list_messages("admin", "project-a")[0]["content"] == "mainline"
    assert chat_store.list_messages("admin", scope)[0]["content"] == "canvas"
    assert (state_root / "admin" / "project-a" / "chat.db").exists()
    assert (
        state_root
        / "admin"
        / "project-a"
        / "_chat"
        / "freezone"
        / "canvas-a"
        / "agents"
        / "main"
        / "chat.db"
    ).exists()


def test_freezone_agent_history_uses_separate_chat_db(monkeypatch, tmp_path):
    state_root = tmp_path / "state"
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(state_root))

    main_scope = ChatScope(
        kind="project",
        id="project-a",
        surface="freezone",
        canvas_id="canvas-a",
        agent_id="main",
    )
    second_scope = ChatScope(
        kind="project",
        id="project-a",
        surface="freezone",
        canvas_id="canvas-a",
        agent_id="agent-2",
    )

    chat_store.append_message("admin", main_scope, "user", "main agent")
    chat_store.append_message("admin", second_scope, "user", "second agent")

    assert chat_store.list_messages("admin", main_scope)[0]["content"] == "main agent"
    assert (
        chat_store.list_messages("admin", second_scope)[0]["content"] == "second agent"
    )
    assert (
        state_root
        / "admin"
        / "project-a"
        / "_chat"
        / "freezone"
        / "canvas-a"
        / "agents"
        / "agent-2"
        / "chat.db"
    ).exists()


@pytest.mark.anyio
async def test_freezone_history_reads_project_name_storage_scope(monkeypatch, tmp_path):
    state_root = tmp_path / "state"
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(state_root))
    project_ctx = SimpleNamespace(project_name="readable-project")
    request_scope = ChatScope(
        kind="project",
        id="01PROJECTID",
        surface="freezone",
        canvas_id="canvas-a",
        agent_id="agent-2",
    )
    storage_scope = ChatScope(
        kind="project",
        id="readable-project",
        surface="freezone",
        canvas_id="canvas-a",
        agent_id="agent-2",
    )

    chat_store.append_message(
        "admin", storage_scope, "user", "stored under project name"
    )

    messages = await chat_routes._history(
        "admin", request_scope, project_ctx=project_ctx
    )

    assert [message["content"] for message in messages] == ["stored under project name"]
    assert not (
        state_root
        / "admin"
        / "01PROJECTID"
        / "_chat"
        / "freezone"
        / "canvas-a"
        / "agents"
        / "agent-2"
        / "chat.db"
    ).exists()


def test_freezone_chat_store_uses_only_authoritative_project_state(
    monkeypatch, tmp_path
):
    state_root = tmp_path / "state"
    authoritative = tmp_path / "mounted-project-state"
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(state_root))
    legacy_scope = ChatScope(
        kind="project",
        id="project-a",
        surface="freezone",
        canvas_id="canvas-a",
        agent_id="main",
    )
    chat_store.append_message("admin", legacy_scope, "user", "legacy history")
    authoritative_scope = ChatScope(
        kind="project",
        id="project-a",
        surface="freezone",
        canvas_id="canvas-a",
        agent_id="main",
        state_dir=str(authoritative),
    )

    chat_store.append_message("admin", authoritative_scope, "assistant", "new reply")

    assert [
        item["content"]
        for item in chat_store.list_messages("admin", authoritative_scope)
    ] == ["new reply"]
    assert (
        authoritative
        / "_chat"
        / "freezone"
        / "canvas-a"
        / "agents"
        / "main"
        / "chat.db"
    ).exists()


def test_freezone_canvas_agent_summaries_pick_recent_server_agent(
    monkeypatch, tmp_path
):
    state_root = tmp_path / "state"
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(state_root))

    main_scope = ChatScope(
        kind="project",
        id="project-a",
        surface="freezone",
        canvas_id="canvas-a",
        agent_id="main",
    )
    second_scope = ChatScope(
        kind="project",
        id="project-a",
        surface="freezone",
        canvas_id="canvas-a",
        agent_id="agent-2",
    )
    other_canvas_scope = ChatScope(
        kind="project",
        id="project-a",
        surface="freezone",
        canvas_id="canvas-b",
        agent_id="agent-3",
    )

    chat_store.append_message("admin", main_scope, "user", "主会话")
    chat_store.append_message("admin", other_canvas_scope, "user", "别的画布")
    chat_store.append_message(
        "admin", second_scope, "user", "最近的服务端会话标题很长需要截断"
    )
    chat_store.append_message("admin", second_scope, "assistant", "agent-2 reply")

    summaries = chat_store.list_freezone_canvas_agent_summaries(
        "admin",
        project_id="project-a",
        canvas_id="canvas-a",
    )

    assert [summary["id"] for summary in summaries] == ["agent-2", "main"]
    assert summaries[0]["name"] == "最近的服务端会话标题很长需要截断"
    assert summaries[0]["lastActiveAt"] > summaries[1]["lastActiveAt"]


def test_freezone_canvas_agent_summaries_default_to_latest_twenty(
    monkeypatch, tmp_path
):
    state_root = tmp_path / "state"
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(state_root))

    for index in range(25):
        scope = ChatScope(
            kind="project",
            id="project-a",
            surface="freezone",
            canvas_id="canvas-a",
            agent_id=f"agent-{index + 1}",
        )
        chat_store.append_message("admin", scope, "user", f"agent {index + 1}")

    summaries = chat_store.list_freezone_canvas_agent_summaries(
        "admin",
        project_id="project-a",
        canvas_id="canvas-a",
    )

    assert len(summaries) == 20
    assert summaries[0]["id"] == "agent-25"
    assert summaries[-1]["id"] == "agent-6"


def test_freezone_canvas_agent_summaries_tie_break_same_millisecond(
    monkeypatch, tmp_path
):
    state_root = tmp_path / "state"
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(state_root))

    for index in range(25):
        scope = ChatScope(
            kind="project",
            id="project-a",
            surface="freezone",
            canvas_id="canvas-a",
            agent_id=f"agent-{index + 1}",
        )
        chat_store.append_message("admin", scope, "user", f"agent {index + 1}")

    def same_time_summary(agent_id, _db_path):
        return {
            "id": agent_id,
            "name": agent_id,
            "createdAt": 1000,
            "lastActiveAt": 1000,
        }

    monkeypatch.setattr(
        chat_store, "_freezone_agent_summary_from_db", same_time_summary
    )

    summaries = chat_store.list_freezone_canvas_agent_summaries(
        "admin",
        project_id="project-a",
        canvas_id="canvas-a",
    )

    assert [summary["id"] for summary in summaries] == [
        f"agent-{index}" for index in range(25, 5, -1)
    ]


@pytest.mark.anyio
async def test_freezone_hermes_assistant_message_keeps_turn_id(monkeypatch, tmp_path):
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(tmp_path / "state"))
    monkeypatch.setenv("NOVELVIDEO_OUTPUT_DIR", str(tmp_path / "output"))
    monkeypatch.setenv("DRAMACLAW_CHAT_BACKEND", "hermes")

    scope = ChatScope(
        kind="project",
        id="project-a",
        surface="freezone",
        canvas_id="canvas-a",
        agent_id="agent-2",
    )
    events = []
    prompts: list[str] = []
    history_sentinel = "CHATDB_HISTORY_MUST_NOT_REACH_HERMES"
    chat_store.append_message("admin", scope, "assistant", history_sentinel)

    class FakeThread:
        async def stream(self, prompt, *, current_project=None, **_kwargs):
            prompts.append(prompt)
            yield backend_sdk.ChatBackendEvent(
                type="thread_started", thread_id="thread-a", turn_id="turn-a"
            )
            yield backend_sdk.ChatBackendEvent(type="assistant_delta", text="你好")
            yield backend_sdk.ChatBackendEvent(type="complete", text="")

    class FakePool:
        async def get_for_user(self, *_args, **_kwargs):
            return FakeThread()

    async def on_event(event):
        events.append(event)

    monkeypatch.setattr(chat_service, "is_hermes_backend_available", lambda: True)
    monkeypatch.setattr(
        chat_service, "_write_hermes_tool_mode", lambda *_args, **_kwargs: None
    )
    monkeypatch.setattr("novelvideo.chat.hermes_pool.pool", FakePool())

    result = await chat_service.stream_assistant_reply(
        "admin",
        "project-a",
        "你好",
        on_event,
        surface="freezone",
        surface_context={"canvasId": "canvas-a"},
        store_scope=scope,
        turn_id="turn-a",
    )

    assert result["turn_id"] == "turn-a"
    assert prompts and history_sentinel not in prompts[0]
    messages = chat_store.list_messages("admin", scope)
    assistant = next(
        message for message in messages if message.get("turn_id") == "turn-a"
    )
    assert assistant["turn_id"] == "turn-a"


@pytest.mark.anyio
async def test_freezone_hermes_retries_once_when_cached_session_is_unavailable(
    monkeypatch,
    tmp_path,
):
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(tmp_path / "state"))
    monkeypatch.setenv("NOVELVIDEO_OUTPUT_DIR", str(tmp_path / "output"))
    monkeypatch.setenv("DRAMACLAW_CHAT_BACKEND", "hermes")

    scope = ChatScope(
        kind="project",
        id="project-a",
        surface="freezone",
        canvas_id="canvas-a",
        agent_id="agent-2",
    )
    events = []

    class StaleThread:
        async def stream(self, _prompt, *, current_project=None, **_kwargs):
            raise hermes_sdk.HermesSessionUnavailableError("session stale not found")
            yield  # pragma: no cover

    class FreshThread:
        async def stream(self, _prompt, *, current_project=None, **_kwargs):
            yield backend_sdk.ChatBackendEvent(
                type="thread_started",
                thread_id="fresh-thread",
                turn_id="fresh-turn",
            )
            yield backend_sdk.ChatBackendEvent(type="assistant_delta", text="恢复好了")
            yield backend_sdk.ChatBackendEvent(type="complete", text="")

    class FakePool:
        def __init__(self) -> None:
            self.get_calls = 0
            self.reset_calls = 0

        async def get_for_user(self, *_args, **_kwargs):
            self.get_calls += 1
            return StaleThread()

        async def reset_for_user(self, *_args, **_kwargs):
            self.reset_calls += 1
            return FreshThread()

    fake_pool = FakePool()

    async def on_event(event):
        events.append(event)

    monkeypatch.setattr(chat_service, "is_hermes_backend_available", lambda: True)
    monkeypatch.setattr(
        chat_service, "_write_hermes_tool_mode", lambda *_args, **_kwargs: None
    )
    monkeypatch.setattr("novelvideo.chat.hermes_pool.pool", fake_pool)

    result = await chat_service.stream_assistant_reply(
        "admin",
        "project-a",
        "你好",
        on_event,
        surface="freezone",
        surface_context={"canvasId": "canvas-a"},
        store_scope=scope,
        turn_id="turn-a",
    )

    assert fake_pool.get_calls == 1
    assert fake_pool.reset_calls == 1
    assert result["content"] == "恢复好了"
    assert any(event.get("thread_id") == "fresh-thread" for event in events)


@pytest.mark.anyio
async def test_freezone_hermes_retries_once_when_prompt_completion_reports_stale_session(
    monkeypatch,
    tmp_path,
):
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(tmp_path / "state"))
    monkeypatch.setenv("NOVELVIDEO_OUTPUT_DIR", str(tmp_path / "output"))
    monkeypatch.setenv("DRAMACLAW_CHAT_BACKEND", "hermes")

    scope = ChatScope(
        kind="project",
        id="project-a",
        surface="freezone",
        canvas_id="canvas-a",
        agent_id="agent-2",
    )

    class StaleThread:
        async def stream(self, _prompt, *, current_project=None, **_kwargs):
            yield backend_sdk.ChatBackendEvent(
                type="thread_started",
                thread_id="stale-thread",
                turn_id="stale-turn",
            )
            yield backend_sdk.ChatBackendEvent(
                type="complete",
                text="error: prompt: session stale-thread not found",
            )

    class FreshThread:
        async def stream(self, _prompt, *, current_project=None, **_kwargs):
            yield backend_sdk.ChatBackendEvent(
                type="thread_started",
                thread_id="fresh-thread",
                turn_id="fresh-turn",
            )
            yield backend_sdk.ChatBackendEvent(type="assistant_delta", text="恢复好了")
            yield backend_sdk.ChatBackendEvent(type="complete", text="")

    class FakePool:
        def __init__(self) -> None:
            self.reset_calls = 0

        async def get_for_user(self, *_args, **_kwargs):
            return StaleThread()

        async def reset_for_user(self, *_args, **_kwargs):
            self.reset_calls += 1
            return FreshThread()

    fake_pool = FakePool()

    monkeypatch.setattr(chat_service, "is_hermes_backend_available", lambda: True)
    monkeypatch.setattr(
        chat_service, "_write_hermes_tool_mode", lambda *_args, **_kwargs: None
    )
    monkeypatch.setattr("novelvideo.chat.hermes_pool.pool", fake_pool)

    result = await chat_service.stream_assistant_reply(
        "admin",
        "project-a",
        "你好",
        lambda _event: None,
        surface="freezone",
        surface_context={"canvasId": "canvas-a"},
        store_scope=scope,
        turn_id="turn-a",
    )

    assert fake_pool.reset_calls == 1
    assert result["content"] == "恢复好了"


@pytest.mark.anyio
async def test_freezone_hermes_retries_once_when_stream_ends_before_completion(
    monkeypatch,
    tmp_path,
):
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(tmp_path / "state"))
    monkeypatch.setenv("NOVELVIDEO_OUTPUT_DIR", str(tmp_path / "output"))
    monkeypatch.setenv("DRAMACLAW_CHAT_BACKEND", "hermes")

    scope = ChatScope(
        kind="project",
        id="project-a",
        surface="freezone",
        canvas_id="canvas-a",
        agent_id="agent-2",
    )

    class BrokenThread:
        async def stream(self, _prompt, *, current_project=None, **_kwargs):
            yield backend_sdk.ChatBackendEvent(
                type="thread_started",
                thread_id="broken-thread",
                turn_id="broken-turn",
            )

    class FreshThread:
        async def stream(self, _prompt, *, current_project=None, **_kwargs):
            yield backend_sdk.ChatBackendEvent(
                type="thread_started",
                thread_id="fresh-thread",
                turn_id="fresh-turn",
            )
            yield backend_sdk.ChatBackendEvent(type="assistant_delta", text="恢复好了")
            yield backend_sdk.ChatBackendEvent(type="complete", text="")

    class FakePool:
        def __init__(self) -> None:
            self.reset_calls = 0

        async def get_for_user(self, *_args, **_kwargs):
            return BrokenThread()

        async def reset_for_user(self, *_args, **_kwargs):
            self.reset_calls += 1
            return FreshThread()

    fake_pool = FakePool()

    monkeypatch.setattr(chat_service, "is_hermes_backend_available", lambda: True)
    monkeypatch.setattr(
        chat_service, "_write_hermes_tool_mode", lambda *_args, **_kwargs: None
    )
    monkeypatch.setattr("novelvideo.chat.hermes_pool.pool", fake_pool)

    result = await chat_service.stream_assistant_reply(
        "admin",
        "project-a",
        "你好",
        lambda _event: None,
        surface="freezone",
        surface_context={"canvasId": "canvas-a"},
        store_scope=scope,
        turn_id="turn-a",
    )

    assert fake_pool.reset_calls == 1
    assert result["content"] == "恢复好了"


@pytest.mark.anyio
@pytest.mark.parametrize("guard_tool_name", ["skill", "freezone_get_canvas_context"])
async def test_freezone_hermes_recovers_once_from_repeated_read(
    monkeypatch,
    tmp_path,
    guard_tool_name,
):
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(tmp_path / "state"))
    monkeypatch.setenv("NOVELVIDEO_OUTPUT_DIR", str(tmp_path / "output"))
    monkeypatch.setenv("DRAMACLAW_CHAT_BACKEND", "hermes")

    scope = ChatScope(
        kind="project",
        id="project-a",
        surface="freezone",
        canvas_id="canvas-a",
        agent_id="agent-2",
    )
    prompts = []
    events = []

    class GuardedThread:
        async def stream(self, prompt, *, current_project=None, **_kwargs):
            prompts.append(prompt)
            yield backend_sdk.ChatBackendEvent(
                type="complete",
                text="本轮操作已停止：虾导重复读取同一项状态。",
                raw={
                    "reason": "tool_call_guard",
                    "guard_reason": "repeated_read",
                    "tool_name": guard_tool_name,
                    "had_write": False,
                },
            )

    class RecoveredThread:
        async def stream(self, prompt, *, current_project=None, **_kwargs):
            prompts.append(prompt)
            yield backend_sdk.ChatBackendEvent(
                type="assistant_delta", text="工作流草稿已创建"
            )
            yield backend_sdk.ChatBackendEvent(type="complete", text="")

    class FakePool:
        def __init__(self) -> None:
            self.reset_calls = 0

        async def get_for_user(self, *_args, **_kwargs):
            return GuardedThread()

        async def reset_for_user(self, *_args, **_kwargs):
            self.reset_calls += 1
            return RecoveredThread()

    fake_pool = FakePool()

    async def on_event(event):
        events.append(event)

    monkeypatch.setattr(chat_service, "is_hermes_backend_available", lambda: True)
    monkeypatch.setattr(
        chat_service, "_write_hermes_tool_mode", lambda *_args, **_kwargs: None
    )
    monkeypatch.setattr("novelvideo.chat.hermes_pool.pool", fake_pool)

    result = await chat_service.stream_assistant_reply(
        "admin",
        "project-a",
        "创建一个图片生成工作流",
        on_event,
        surface="freezone",
        surface_context={"canvasId": "canvas-a"},
        store_scope=scope,
        turn_id="turn-a",
    )

    assert fake_pool.reset_calls == 1
    assert len(prompts) == 2
    assert "创建一个图片生成工作流" in prompts[1]
    assert "FREEZONE_AUTOMATIC_RECOVERY" in prompts[1]
    assert "Workflow Skill 的草稿流程" in prompts[1]
    assert "不得使用 freezone_emit_canvas_command" in prompts[1]
    assert result["content"] == "工作流草稿已创建"
    assert all("重复读取同一项状态" not in str(event) for event in events)


@pytest.mark.anyio
async def test_freezone_hermes_does_not_replay_failed_workflow_draft_operation(
    monkeypatch,
    tmp_path,
):
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(tmp_path / "state"))
    monkeypatch.setenv("NOVELVIDEO_OUTPUT_DIR", str(tmp_path / "output"))
    monkeypatch.setenv("DRAMACLAW_CHAT_BACKEND", "hermes")

    scope = ChatScope(
        kind="project",
        id="project-a",
        surface="freezone",
        canvas_id="canvas-a",
        agent_id="agent-2",
    )

    class GuardedThread:
        async def stream(self, prompt, *, current_project=None, **_kwargs):
            yield backend_sdk.ChatBackendEvent(
                type="complete",
                text="本轮操作已停止：工作流草稿操作重复失败。",
                raw={
                    "reason": "tool_call_guard",
                    "guard_reason": "repeated_read",
                    "tool_name": "freezone_prepare_workflow_draft",
                    "had_write": False,
                },
            )

    class FakePool:
        def __init__(self) -> None:
            self.reset_calls = 0

        async def get_for_user(self, *_args, **_kwargs):
            return GuardedThread()

        async def reset_for_user(self, *_args, **_kwargs):
            self.reset_calls += 1
            return GuardedThread()

    fake_pool = FakePool()
    monkeypatch.setattr(chat_service, "is_hermes_backend_available", lambda: True)
    monkeypatch.setattr(
        chat_service, "_write_hermes_tool_mode", lambda *_args, **_kwargs: None
    )
    monkeypatch.setattr("novelvideo.chat.hermes_pool.pool", fake_pool)

    result = await chat_service.stream_assistant_reply(
        "admin",
        "project-a",
        "创建一个图片生成工作流",
        lambda _event: None,
        surface="freezone",
        surface_context={"canvasId": "canvas-a"},
        store_scope=scope,
        turn_id="turn-a",
    )

    assert fake_pool.reset_calls == 0
    assert "工作流草稿操作重复失败" in result["content"]


@pytest.mark.anyio
async def test_freezone_hermes_drops_mainline_media_ui_specs(monkeypatch, tmp_path):
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(tmp_path / "state"))
    monkeypatch.setenv("NOVELVIDEO_OUTPUT_DIR", str(tmp_path / "output"))
    monkeypatch.setenv("DRAMACLAW_CHAT_BACKEND", "hermes")

    scope = ChatScope(
        kind="project",
        id="project-a",
        surface="freezone",
        canvas_id="canvas-a",
        agent_id="agent-2",
    )
    sketch_spec = {
        "type": "sketch_gallery",
        "root": "root",
        "elements": {
            "root": {"type": "Stack", "props": {}, "children": ["sketch"]},
            "sketch": {
                "type": "Image",
                "props": {
                    "src": "/static/projects/project-a/sketches/ep001/beat_01.png",
                    "alt": "Beat 1 草图",
                },
                "children": [],
            },
        },
    }

    class FakeThread:
        async def stream(self, _prompt, *, current_project=None, **_kwargs):
            yield backend_sdk.ChatBackendEvent(
                type="thread_started", thread_id="thread-a", turn_id="turn-a"
            )
            yield backend_sdk.ChatBackendEvent(
                type="assistant_delta",
                text=(
                    "已为你触发了这张图片的生成。\n\n"
                    f"{chat_service._ui_spec_block(sketch_spec)}"
                ),
            )
            yield backend_sdk.ChatBackendEvent(
                type="tool_updated",
                text="completed",
                raw={
                    "sessionUpdate": "tool_call",
                    "name": "dramaclaw_get_sketches",
                    "arguments": {"episode": 1},
                },
            )
            yield backend_sdk.ChatBackendEvent(type="complete", text="")

    class FakePool:
        async def get_for_user(self, *_args, **_kwargs):
            return FakeThread()

    async def unexpected_fallback(*_args, **_kwargs):
        raise AssertionError("Freezone canvas must not request mainline media fallback")

    async def on_event(_event):
        return None

    monkeypatch.setattr(chat_service, "is_hermes_backend_available", lambda: True)
    monkeypatch.setattr(
        chat_service, "_write_hermes_tool_mode", lambda *_args, **_kwargs: None
    )
    monkeypatch.setattr(
        chat_service, "_fallback_display_tool_ui_specs", unexpected_fallback
    )
    monkeypatch.setattr("novelvideo.chat.hermes_pool.pool", FakePool())

    result = await chat_service.stream_assistant_reply(
        "admin",
        "project-a",
        "生成下这个",
        on_event,
        surface="freezone",
        surface_context={"canvasId": "canvas-a"},
        store_scope=scope,
        turn_id="turn-a",
    )

    assert result["role"] == "assistant"
    assert "已为你触发了这张图片的生成" in result["content"]
    assert "<ui-spec" not in result["content"]
    assert "sketch_gallery" not in result["content"]
    assert "Beat 1 草图" not in result["content"]
    assert result["media"] == []


def test_freezone_main_agent_reads_legacy_canvas_chat_db(monkeypatch, tmp_path):
    state_root = tmp_path / "state"
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(state_root))

    scope = ChatScope(
        kind="project",
        id="project-a",
        surface="freezone",
        canvas_id="canvas-a",
        agent_id="main",
    )
    legacy_db = (
        state_root
        / "admin"
        / "project-a"
        / "_chat"
        / "freezone"
        / "canvas-a"
        / "chat.db"
    )
    conn = chat_store.connect("admin", scope, db_path=legacy_db)
    try:
        conn.execute(
            """
            INSERT INTO chat_messages (role, content, media_json, turn_id, metadata_json, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                "user",
                "legacy canvas",
                "[]",
                None,
                "{}",
                datetime.now(timezone.utc).isoformat(),
            ),
        )
        conn.commit()
    finally:
        conn.close()

    assert chat_store.list_messages("admin", scope)[0]["content"] == "legacy canvas"

    chat_store.append_message("admin", scope, "user", "new main")

    assert chat_store.list_messages("admin", scope)[0]["content"] == "new main"
    assert (
        state_root
        / "admin"
        / "project-a"
        / "_chat"
        / "freezone"
        / "canvas-a"
        / "agents"
        / "main"
        / "chat.db"
    ).exists()


def test_director_history_path_ignores_agent_id(monkeypatch, tmp_path):
    state_root = tmp_path / "state"
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(state_root))

    scope = ChatScope.from_payload(
        {
            "kind": "project",
            "id": "project-a",
            "surface": "director",
            "agentId": "agent-2",
        }
    )
    chat_store.append_message("admin", scope, "user", "director")

    assert scope == ChatScope(kind="project", id="project-a", surface="director")
    assert (state_root / "admin" / "project-a" / "chat.db").exists()
    assert not (state_root / "admin" / "project-a" / "_chat").exists()


def test_chat_ui_events_attach_to_user_message_when_turn_has_no_assistant(
    monkeypatch, tmp_path
):
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(tmp_path / "state"))
    scope = ChatScope(
        kind="project", id="project-a", surface="freezone", canvas_id="canvas-a"
    )

    chat_store.append_message("admin", scope, "user", "加个视频节点", turn_id="turn-a")
    chat_store.append_ui_event(
        "admin",
        scope,
        "turn-a",
        {
            "type": "canvas_command_approval",
            "schema_version": "canvas_command_approval.v1",
            "canvas_id": "canvas-a",
            "bridge_key": "bridge-a",
            "envelopes": [],
        },
    )

    messages = chat_store.list_messages("admin", scope)

    assert messages[0]["role"] == "user"
    assert messages[0]["ui_events"][0]["type"] == "canvas_command_approval"


def test_chat_message_parts_keep_canvas_feedback_after_stale_snapshot(
    monkeypatch, tmp_path
):
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(tmp_path / "state"))
    scope = ChatScope(
        kind="project", id="project-a", surface="freezone", canvas_id="canvas-a"
    )

    chat_store.append_message("admin", scope, "user", "生成下分镜", turn_id="turn-a")
    chat_store.append_message("admin", scope, "assistant", "", turn_id="turn-a")
    context_part = {
        "id": "canvas_context:context:bridge-a:validation",
        "type": "canvas_context",
        "event": {
            "key": "context:bridge-a:validation",
            "bridgeKey": "bridge-a:validation",
            "status": "done",
            "errors": [],
        },
    }
    approval_part = {
        "id": "canvas_approval:bridge:bridge-a:turn:turn-a",
        "type": "canvas_approval",
        "event": {
            "key": "bridge:bridge-a:turn:turn-a",
            "bridgeKey": "bridge-a",
        },
    }
    feedback_part = {
        "id": "canvas_feedback:bridge:bridge-a:turn:turn-a",
        "type": "canvas_feedback",
        "event": {
            "key": "bridge:bridge-a:turn:turn-a",
            "errors": ["节点动作完成但未产出 imageUrl。"],
        },
    }

    chat_store.append_ui_event(
        "admin",
        scope,
        "turn-a",
        {"type": "assistant.message_parts", "parts": [context_part, approval_part]},
    )
    chat_store.append_ui_event(
        "admin",
        scope,
        "turn-a",
        {"type": "assistant.message_parts", "parts": [context_part, feedback_part]},
    )
    chat_store.append_ui_event(
        "admin",
        scope,
        "turn-a",
        {"type": "assistant.message_parts", "parts": [context_part]},
    )

    messages = chat_store.list_messages("admin", scope)
    assistant = next(message for message in messages if message["role"] == "assistant")
    part_types = [part["type"] for part in assistant["parts"]]
    feedback = next(
        part for part in assistant["parts"] if part["type"] == "canvas_feedback"
    )

    assert "canvas_feedback" in part_types
    assert "canvas_approval" not in part_types
    assert feedback["event"]["errors"] == ["节点动作完成但未产出 imageUrl。"]


def test_chat_message_parts_drop_stale_skill_studio_status_snapshot(
    monkeypatch, tmp_path
):
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(tmp_path / "state"))
    scope = ChatScope(
        kind="project", id="project-a", surface="freezone", canvas_id="canvas-a"
    )

    chat_store.append_message(
        "admin", scope, "user", "做一个公益短片 skill", turn_id="turn-a"
    )
    chat_store.append_message(
        "admin", scope, "assistant", "草稿已生成。", turn_id="turn-a"
    )
    question_part = {
        "id": "skill_studio.questions:question-key",
        "type": "skill_studio",
        "event": {
            "type": "skill_studio.questions",
            "bridge_key": "question-key",
            "submitted": True,
            "questions": [],
        },
    }
    status_part = {
        "id": "skill_studio.status:skill_studio.status",
        "type": "skill_studio",
        "event": {
            "type": "skill_studio.status",
            "status": "draft_patch_applied",
            "message": "已更新 Recipe: public-welfare-storyboard-images",
        },
    }
    text_part = {"id": "text-3", "type": "text", "text": "草稿已生成。"}

    chat_store.append_ui_event(
        "admin",
        scope,
        "turn-a",
        {"type": "assistant.message_parts", "parts": [status_part, question_part]},
    )
    chat_store.append_ui_event(
        "admin",
        scope,
        "turn-a",
        {"type": "assistant.message_parts", "parts": [question_part, text_part]},
    )

    messages = chat_store.list_messages("admin", scope)
    assistant = next(message for message in messages if message["role"] == "assistant")

    assert [part["type"] for part in assistant["parts"]] == ["skill_studio", "text"]
    assert [
        part.get("event", {}).get("type")
        for part in assistant["parts"]
        if part["type"] == "skill_studio"
    ] == ["skill_studio.questions"]


def test_chat_history_does_not_restore_orphan_parts_outside_message_limit(
    monkeypatch, tmp_path
):
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(tmp_path / "state"))
    scope = ChatScope(
        kind="project", id="project-a", surface="freezone", canvas_id="canvas-a"
    )

    chat_store.append_message("admin", scope, "user", "旧请求", turn_id="turn-old")
    chat_store.append_message(
        "admin", scope, "assistant", "完整旧回复", turn_id="turn-old"
    )
    chat_store.append_ui_event(
        "admin",
        scope,
        "turn-old",
        {
            "type": "assistant.message_parts",
            "parts": [{"id": "text-old", "type": "text", "text": "残缺旧回复"}],
        },
    )
    chat_store.append_message("admin", scope, "user", "新请求", turn_id="turn-new")
    chat_store.append_message(
        "admin", scope, "assistant", "完整新回复", turn_id="turn-new"
    )

    messages = chat_store.list_messages("admin", scope, limit=2)

    assert [message["content"] for message in messages] == ["新请求", "完整新回复"]
    assert all(message.get("turn_id") != "turn-old" for message in messages)


def test_chat_scope_round_trips_freezone_canvas_payload() -> None:
    scope = ChatScope.from_payload(
        {
            "kind": "project",
            "id": "project-a",
            "surface": "freezone",
            "canvasId": "canvas-a",
            "agentId": "agent-2",
        }
    )

    assert scope == ChatScope(
        kind="project",
        id="project-a",
        surface="freezone",
        canvas_id="canvas-a",
        agent_id="agent-2",
    )
    assert scope.to_dict() == {
        "kind": "project",
        "id": "project-a",
        "surface": "freezone",
        "canvasId": "canvas-a",
        "agentId": "agent-2",
    }


def test_chat_scope_defaults_freezone_agent_to_main() -> None:
    scope = ChatScope.from_payload(
        {
            "kind": "project",
            "id": "project-a",
            "surface": "freezone",
            "canvasId": "canvas-a",
        }
    )

    assert scope.agent_id == "main"
    assert scope.to_dict()["agentId"] == "main"


def test_hermes_workspace_profile_treats_freezone_agent_profiles_as_freezone() -> None:
    from novelvideo.chat import hermes_pool

    assert (
        hermes_pool._workspace_profile_for_agent(
            "freezone:agent-2", "freezone_canvas", "freezone"
        )
        == "freezone"
    )
    assert (
        hermes_pool._workspace_profile_for_agent("main", "default", None) == "director"
    )


def test_legacy_freezone_scope_still_uses_legacy_chat_db(monkeypatch, tmp_path):
    state_root = tmp_path / "state"
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(state_root))

    scope = ChatScope(kind="freezone", id="project-a")
    chat_store.append_message("admin", scope, "user", "legacy")

    assert chat_store.list_messages("admin", scope)[0]["content"] == "legacy"
    assert (state_root / "admin" / "_freezone" / "project-a" / "chat.db").exists()


def test_json_render_reply_normalizer_unwraps_fenced_ui_spec():
    content = """请查看：

```json-render
<ui-spec>
{
  "type": "character_showcase",
  "root": "root",
  "elements": {
    "root": {
      "type": "Stack",
      "props": {},
      "children": ["portrait"]
    },
    "portrait": {
      "type": "Image",
      "props": {"src": "/static/projects/demo/portrait.png", "alt": "肖像"},
      "children": []
    }
  }
}
</ui-spec>
```"""

    normalized = chat_service._normalize_json_render_reply(content)

    assert "```" not in normalized
    assert '<ui-spec type="character_showcase">' in normalized
    assert '"type": "Image"' in normalized


def test_json_render_reply_normalizer_repairs_missing_trailing_brace():
    content = """<ui-spec>{"type":"character_showcase","root":"root","elements":{"root":{"type":"Stack","props":{},"children":[]}}</ui-spec>"""

    normalized = chat_service._normalize_json_render_reply(content)

    assert "格式校验失败" not in normalized
    assert '"elements": {' in normalized
    assert normalized.rstrip().endswith("</ui-spec>")


def test_json_render_reply_normalizer_repairs_legacy_component_children_props():
    content = """<ui-spec>
{
  "type": "script_overview",
  "root": "root",
  "elements": {
    "root": {
      "type": "Stack",
      "props": {"row": false, "gap": 12},
      "children": ["heading", "badge", "body"]
    },
    "heading": {
      "type": "Heading",
      "props": {"level": 3, "children": "第 1 集脚本概览"},
      "children": []
    },
    "badge": {
      "type": "Badge",
      "props": {"children": "completed", "variant": "success"},
      "children": []
    },
    "body": {
      "type": "Text",
      "props": {"children": "脚本已经生成完成。", "variant": "body"},
      "children": []
    }
  }
}
</ui-spec>"""

    normalized = chat_service._normalize_json_render_reply(content)

    assert "格式校验失败" not in normalized
    assert '"direction": "column"' in normalized
    assert '"content": "第 1 集脚本概览"' in normalized
    assert '"label": "completed"' in normalized
    assert '"content": "脚本已经生成完成。"' in normalized
    assert '"children": "脚本已经生成完成。"' not in normalized


def test_json_render_reply_normalizer_blocks_invalid_ui_spec():
    content = "<ui-spec>{not json}</ui-spec>"

    normalized = chat_service._normalize_json_render_reply(content)

    assert "<ui-spec>" not in normalized
    assert "格式校验失败" in normalized


def test_json_render_reply_normalizer_accepts_media_bundle_array():
    spec_a = {
        "type": "character_showcase",
        "root": "root",
        "elements": {
            "root": {"type": "Stack", "props": {}, "children": ["portrait"]},
            "portrait": {
                "type": "Image",
                "props": {"src": "/static/projects/demo/portrait.png", "alt": "肖像"},
                "children": [],
            },
        },
    }
    spec_b = {
        "type": "sketch_gallery",
        "root": "root",
        "elements": {
            "root": {"type": "Stack", "props": {}, "children": ["sketch"]},
            "sketch": {
                "type": "Image",
                "props": {"src": "/static/projects/demo/sketch.png", "alt": "草图"},
                "children": [],
            },
        },
    }
    content = f'<ui-spec type="media_bundle">{json.dumps([spec_a, spec_b])}</ui-spec>'

    normalized = chat_service._normalize_json_render_reply(content)

    assert "格式校验失败" not in normalized
    assert normalized.count("<ui-spec") == 1
    assert '<ui-spec type="media_bundle">' in normalized
    assert '"type": "character_showcase"' in normalized
    assert '"type": "sketch_gallery"' in normalized


def test_json_render_reply_normalizer_wraps_embedded_canonical_json():
    spec = {
        "type": "sketch_gallery",
        "root": "root",
        "elements": {
            "root": {"type": "Stack", "props": {}, "children": ["sketch"]},
            "sketch": {
                "type": "Image",
                "props": {"src": "/static/projects/demo/sketch.png", "alt": "草图"},
                "children": [],
            },
        },
    }
    content = (
        f"已加载草图：\n\n{json.dumps(spec, ensure_ascii=False)}\n\n继续查看请告诉我。"
    )

    normalized = chat_service._normalize_json_render_reply(content)

    assert "已加载草图" in normalized
    assert "继续查看请告诉我" in normalized
    assert '<ui-spec type="sketch_gallery">' in normalized
    assert "/static/projects/demo/sketch.png" in normalized


def test_extract_tool_ui_specs_canonicalizes_tool_payload():
    payload = {
        "content": {
            "result": {
                "ok": True,
                "ui_spec": {
                    "type": "sketch_gallery",
                    "root": "root",
                    "elements": {
                        "root": {
                            "type": "Stack",
                            "props": {"row": True},
                            "children": ["image_1"],
                        },
                        "image_1": {
                            "type": "Image",
                            "props": {
                                "src": "/static/projects/demo/scene.png?v=1",
                                "alt": "场景",
                            },
                        },
                    },
                },
            }
        }
    }

    specs = chat_service._extract_tool_ui_specs(payload)

    assert len(specs) == 1
    assert specs[0]["type"] == "sketch_gallery"
    assert specs[0]["elements"]["root"]["props"]["direction"] == "row"
    assert specs[0]["elements"]["image_1"]["children"] == []


def test_extract_tool_ui_specs_parses_json_string_tool_result():
    payload = {
        "sessionUpdate": "tool_call_update",
        "content": json.dumps(
            {
                "ok": True,
                "ui_spec": {
                    "type": "sketch_gallery",
                    "root": "root",
                    "elements": {
                        "root": {
                            "type": "Stack",
                            "props": {"direction": "column"},
                            "children": ["image_1"],
                        },
                        "image_1": {
                            "type": "Image",
                            "props": {
                                "src": "/static/projects/demo/sketch.png?v=1",
                                "alt": "草图",
                            },
                        },
                    },
                },
            },
            ensure_ascii=False,
        ),
    }

    specs = chat_service._extract_tool_ui_specs(payload)

    assert len(specs) == 1
    assert specs[0]["type"] == "sketch_gallery"
    assert (
        specs[0]["elements"]["image_1"]["props"]["src"]
        == "/static/projects/demo/sketch.png?v=1"
    )


def test_extract_tool_chat_error_from_nested_tool_result_string():
    payload = {
        "sessionUpdate": "tool_call_update",
        "status": "completed",
        "result": json.dumps(
            {
                "ok": True,
                "data": [
                    {
                        "status": "failed",
                        "error": "Content filter triggered. Finish reason: 'content_filter'",
                        "chat_error": "模型内容安全过滤拦截了本次文本生成，请调整原文后重试。",
                    }
                ],
            },
            ensure_ascii=False,
        ),
    }

    assert (
        chat_service._extract_tool_chat_error(payload)
        == "模型内容安全过滤拦截了本次文本生成，请调整原文后重试。"
    )


def test_extract_tool_chat_error_ignores_raw_provider_error_without_hint():
    payload = {
        "sessionUpdate": "tool_call_update",
        "status": "completed",
        "result": {
            "error": "Content filter triggered. Finish reason: 'content_filter'",
            "provider_response_id": "resp_123",
        },
    }

    assert chat_service._extract_tool_chat_error(payload) is None


def test_extract_tool_chat_error_maps_render_prereq_task_error():
    raw_error = (
        "Render 重生未生成可用图片（mode=1x1_2-3, beats=[1, 2, 3]）："
        "Render 模式需要草图但未找到覆盖 beat 1-1 的草图"
    )
    payload = {
        "sessionUpdate": "tool_call_update",
        "status": "completed",
        "result": {
            "status": "failed",
            "error": raw_error,
        },
    }

    chat_error = chat_service._extract_tool_chat_error(payload)

    assert chat_error is not None
    assert "Render 任务没有生成可用图片" in chat_error
    assert "虾塘" in chat_error
    assert raw_error in chat_error


def test_extract_tool_chat_error_maps_generic_failed_task_error():
    payload = {
        "sessionUpdate": "tool_call_update",
        "status": "completed",
        "result": {
            "status": "failed",
            "error": "上游下载失败 token=secret-token provider_response_id=resp_123",
        },
    }

    chat_error = chat_service._extract_tool_chat_error(payload)

    assert chat_error is not None
    assert chat_error.startswith("任务执行失败：")
    assert "上游下载失败" in chat_error
    assert "secret-token" not in chat_error
    assert "resp_123" not in chat_error


def test_extract_tool_chat_error_maps_ok_false_without_error_text():
    payload = {
        "sessionUpdate": "tool_call_update",
        "status": "completed",
        "result": {"ok": False},
    }

    assert (
        chat_service._extract_tool_chat_error(payload)
        == "任务执行失败：接口返回 ok=false，但没有提供具体错误原因。"
    )


def test_freezone_suppresses_status_only_tool_lifecycle_failure():
    payload = {
        "sessionUpdate": "tool_call_update",
        "status": "failed",
    }

    assert chat_service._suppress_freezone_tool_lifecycle_error(
        payload,
        tool_mode="freezone_canvas",
    )
    assert not chat_service._suppress_freezone_tool_lifecycle_error(
        payload,
        tool_mode="default",
    )


def test_freezone_suppresses_canvas_bridge_tool_lifecycle_failure():
    payload = {
        "sessionUpdate": "tool_call_update",
        "status": "failed",
        "content": [
            {
                "type": "content",
                "content": {
                    "type": "text",
                    "text": json.dumps(
                        {
                            "ok": False,
                            "tool_call_status": "failed",
                            "canvas_apply_status": "failed",
                            "errors": ["节点动作完成但未产出 imageUrl。"],
                            "user_message": "节点动作完成但未产出 imageUrl。",
                        },
                        ensure_ascii=False,
                    ),
                },
            }
        ],
    }

    assert chat_service._suppress_freezone_tool_lifecycle_error(
        payload,
        tool_mode="freezone_canvas",
    )


def test_freezone_keeps_tool_lifecycle_failure_with_business_payload():
    payload = {
        "sessionUpdate": "tool_call_update",
        "status": "failed",
        "result": {
            "status": "failed",
            "error": "前端桥接执行失败",
        },
    }

    assert not chat_service._suppress_freezone_tool_lifecycle_error(
        payload,
        tool_mode="freezone_canvas",
    )


def test_freezone_strips_status_only_lifecycle_failure_prefix():
    text = "任务执行失败：当前状态为 failed。\n\n已触发「Sketch from selected background」技能。"

    assert (
        chat_service._strip_freezone_tool_lifecycle_failure_text(
            text,
            tool_mode="freezone_canvas",
        )
        == "已触发「Sketch from selected background」技能。"
    )
    assert (
        chat_service._strip_freezone_tool_lifecycle_failure_text(
            text,
            tool_mode="default",
        )
        == text
    )


def test_freezone_hides_generic_tool_lifecycle_failure_error():
    assert (
        chat_service._visible_tool_chat_error_for_mode(
            "任务执行失败：当前状态为 failed。",
            tool_mode="freezone_canvas",
        )
        is None
    )
    assert (
        chat_service._visible_tool_chat_error_for_mode(
            "任务执行失败：当前状态为 failed。",
            tool_mode="default",
        )
        == "任务执行失败：当前状态为 failed。"
    )


def test_append_tool_ui_specs_adds_block_when_model_did_not_write_one():
    spec = {
        "type": "character_showcase",
        "root": "root",
        "elements": {
            "root": {"type": "Stack", "props": {}, "children": ["portrait"]},
            "portrait": {
                "type": "Image",
                "props": {
                    "src": "/static/projects/demo/portrait.png?v=1",
                    "alt": "肖像",
                },
                "children": [],
            },
        },
    }

    content = chat_service._append_tool_ui_specs("已展示肖像。", [spec])

    assert content.startswith("已展示肖像。")
    assert '<ui-spec type="character_showcase">' in content
    assert "/static/projects/demo/portrait.png?v=1" in content


def test_append_tool_ui_specs_ignores_placeholder_ui_spec_chatter():
    spec = {
        "type": "character_showcase",
        "root": "root",
        "elements": {
            "root": {"type": "Stack", "props": {}, "children": ["portrait"]},
            "portrait": {
                "type": "Image",
                "props": {
                    "src": "/static/projects/demo/portrait.png?v=1",
                    "alt": "肖像",
                },
                "children": [],
            },
        },
    }

    content = chat_service._append_tool_ui_specs(
        "\n".join(
            [
                "首先，调用dramaclaw_get_character_media工具获取角色肖像信息：",
                "<ui-spec> JSON has been generated and will be automatically rendered by the backend.",
                "所有图片都已按规范渲染为UI画廊，您可以直接查看。",
                "如需查看其他内容，请告诉我。",
            ]
        ),
        [spec],
    )

    assert "dramaclaw_get_character_media" not in content
    assert "automatically rendered" not in content
    assert "UI画廊" not in content
    assert "如需查看其他内容" in content
    assert '<ui-spec type="character_showcase">' in content
    assert "/static/projects/demo/portrait.png?v=1" in content


def test_append_tool_ui_specs_replaces_truncated_embedded_media_json():
    spec = {
        "type": "sketch_gallery",
        "root": "root",
        "elements": {
            "root": {"type": "Stack", "props": {}, "children": ["sketch"]},
            "sketch": {
                "type": "Image",
                "props": {"src": "/static/projects/demo/sketch.png", "alt": "草图"},
                "children": [],
            },
        },
    }
    truncated_json = (
        '{"type": "sketch_gallery", "root": "root", "elements": '
        '{"root": {"type": "Stack", "props": {}, "children": ["sketch"]}}'
    )

    content = chat_service._append_tool_ui_specs(
        f"已为您展示草图：\n\n{truncated_json}\n\n继续查看请告诉我。",
        [spec],
    )

    assert "已为您展示草图" in content
    assert "继续查看请告诉我" in content
    assert truncated_json not in content
    assert '<ui-spec type="sketch_gallery">' in content
    assert "/static/projects/demo/sketch.png" in content


def test_ui_spec_json_is_generated_before_wrapping_tags():
    spec = {
        "type": "character_showcase",
        "root": "root",
        "elements": {
            "root": {"type": "Stack", "props": {}, "children": ["portrait"]},
            "portrait": {
                "type": "Image",
                "props": {
                    "src": "/static/projects/demo/portrait.png?v=1",
                    "alt": "肖像",
                },
                "children": [],
            },
        },
    }

    spec_type, json_text = chat_service._ui_spec_json(spec)
    wrapped = chat_service._wrap_ui_spec_json(spec_type, json_text)

    assert spec_type == "character_showcase"
    assert "<ui-spec" not in json_text
    assert "</ui-spec>" not in json_text
    assert wrapped.startswith('<ui-spec type="character_showcase">')
    assert wrapped.endswith("</ui-spec>")


def test_append_tool_ui_specs_keeps_image_specs_separate_and_ordered():
    portrait_spec = {
        "type": "character_showcase",
        "root": "root",
        "elements": {
            "root": {"type": "Stack", "props": {}, "children": ["portrait"]},
            "portrait": {
                "type": "Image",
                "props": {
                    "src": "/static/projects/demo/portrait.png?v=1",
                    "alt": "肖像",
                    "overlayTitle": "江念",
                },
                "children": [],
            },
        },
    }
    sketch_spec = {
        "type": "sketch_gallery",
        "root": "root",
        "elements": {
            "root": {"type": "Stack", "props": {}, "children": ["sketch"]},
            "sketch": {
                "type": "Image",
                "props": {
                    "src": "/static/projects/demo/sketch.png?v=1",
                    "alt": "草图",
                    "overlayTitle": "Beat 1 草图",
                },
                "children": [],
            },
        },
    }

    content = chat_service._append_tool_ui_specs(
        "已展示媒体。", [portrait_spec, sketch_spec]
    )

    assert content.count("<ui-spec") == 2
    assert '<ui-spec type="character_showcase">' in content
    assert '<ui-spec type="sketch_gallery">' in content
    assert '"type": "character_showcase"' in content
    assert '"type": "sketch_gallery"' in content
    assert content.index('<ui-spec type="character_showcase">') < content.index(
        '<ui-spec type="sketch_gallery">'
    )
    assert content.index("/static/projects/demo/portrait.png?v=1") < content.index(
        "/static/projects/demo/sketch.png?v=1"
    )


def test_append_tool_ui_specs_merges_adjacent_character_showcase_specs():
    first_spec = {
        "type": "character_showcase",
        "root": "root",
        "elements": {
            "root": {"type": "Stack", "props": {}, "children": ["portrait"]},
            "portrait": {
                "type": "Image",
                "props": {
                    "src": "/static/projects/demo/jiang-nian.png?v=1",
                    "alt": "江念",
                    "overlayTitle": "江念",
                },
                "children": [],
            },
        },
    }
    second_spec = {
        "type": "character_showcase",
        "root": "root",
        "elements": {
            "root": {"type": "Stack", "props": {}, "children": ["portrait"]},
            "portrait": {
                "type": "Image",
                "props": {
                    "src": "/static/projects/demo/luo-xi.png?v=1",
                    "alt": "洛曦",
                    "overlayTitle": "洛曦",
                },
                "children": [],
            },
        },
    }

    content = chat_service._append_tool_ui_specs(
        "已展示角色。", [first_spec, second_spec]
    )

    assert content.count('<ui-spec type="character_showcase">') == 1
    assert "/static/projects/demo/jiang-nian.png?v=1" in content
    assert "/static/projects/demo/luo-xi.png?v=1" in content
    assert '"portrait_2"' in content
    assert content.index("/static/projects/demo/jiang-nian.png?v=1") < content.index(
        "/static/projects/demo/luo-xi.png?v=1"
    )


def test_append_tool_ui_specs_merges_same_category_video_and_audio_specs():
    video_a = {
        "type": "keyframe_video",
        "root": "root",
        "elements": {
            "root": {"type": "Stack", "props": {}, "children": ["video"]},
            "video": {
                "type": "Video",
                "props": {"src": "/static/projects/demo/beat-1.mp4", "title": "Beat 1"},
                "children": [],
            },
        },
    }
    video_b = {
        "type": "keyframe_video",
        "root": "root",
        "elements": {
            "root": {"type": "Stack", "props": {}, "children": ["video"]},
            "video": {
                "type": "Video",
                "props": {"src": "/static/projects/demo/beat-2.mp4", "title": "Beat 2"},
                "children": [],
            },
        },
    }
    audio_a = {
        "type": "audio_list",
        "root": "root",
        "elements": {
            "root": {"type": "Stack", "props": {}, "children": ["audio"]},
            "audio": {
                "type": "Audio",
                "props": {"src": "/static/projects/demo/beat-1.mp3", "title": "Beat 1"},
                "children": [],
            },
        },
    }
    audio_b = {
        "type": "audio_list",
        "root": "root",
        "elements": {
            "root": {"type": "Stack", "props": {}, "children": ["audio"]},
            "audio": {
                "type": "Audio",
                "props": {"src": "/static/projects/demo/beat-2.mp3", "title": "Beat 2"},
                "children": [],
            },
        },
    }

    content = chat_service._append_tool_ui_specs(
        "已展示媒体。", [video_a, video_b, audio_a, audio_b]
    )

    assert content.count('<ui-spec type="keyframe_video">') == 1
    assert content.count('<ui-spec type="audio_list">') == 1
    assert content.index("/static/projects/demo/beat-1.mp4") < content.index(
        "/static/projects/demo/beat-2.mp4"
    )
    assert content.index("/static/projects/demo/beat-2.mp4") < content.index(
        "/static/projects/demo/beat-1.mp3"
    )
    assert content.index("/static/projects/demo/beat-1.mp3") < content.index(
        "/static/projects/demo/beat-2.mp3"
    )


def test_append_tool_ui_specs_keeps_same_src_across_different_categories():
    shared_src = "/static/projects/demo/shared.png?v=1"
    portrait_spec = {
        "type": "character_showcase",
        "root": "root",
        "elements": {
            "root": {"type": "Stack", "props": {}, "children": ["portrait"]},
            "portrait": {
                "type": "Image",
                "props": {"src": shared_src, "alt": "肖像", "overlayTitle": "角色肖像"},
                "children": [],
            },
        },
    }
    sketch_spec = {
        "type": "sketch_gallery",
        "root": "root",
        "elements": {
            "root": {"type": "Stack", "props": {}, "children": ["sketch"]},
            "sketch": {
                "type": "Image",
                "props": {"src": shared_src, "alt": "草图", "overlayTitle": "草图候选"},
                "children": [],
            },
        },
    }

    content = chat_service._append_tool_ui_specs(
        "已展示媒体。", [portrait_spec, sketch_spec]
    )

    assert content.count("<ui-spec") == 2
    assert content.count(shared_src) == 2
    assert "角色肖像" in content
    assert "草图候选" in content


def test_split_ui_specs_from_text_extracts_model_written_blocks():
    spec = {
        "type": "sketch_gallery",
        "root": "root",
        "elements": {
            "root": {"type": "Stack", "props": {}, "children": ["image"]},
            "image": {
                "type": "Image",
                "props": {"src": "/static/projects/demo/sketch.png", "alt": "草图"},
                "children": [],
            },
        },
    }
    content = (
        "以下是草图：\n\n"
        f"<ui-spec>{json.dumps(spec, ensure_ascii=False)}</ui-spec>\n\n"
        "展示完成。"
    )

    text, specs = chat_service._split_ui_specs_from_text(content)

    assert "<ui-spec" not in text
    assert text == "以下是草图：\n\n展示完成。"
    assert len(specs) == 1
    assert specs[0]["type"] == "sketch_gallery"
    assert specs[0]["elements"]["image"]["children"] == []


def test_append_tool_ui_specs_does_not_duplicate_existing_ui_spec():
    existing_spec = {
        "type": "character_showcase",
        "root": "root",
        "elements": {
            "root": {"type": "Stack", "props": {}, "children": ["portrait"]},
            "portrait": {
                "type": "Image",
                "props": {"src": "/static/projects/demo/portrait.png", "alt": "肖像"},
                "children": [],
            },
        },
    }
    tool_spec = {
        "type": "sketch_gallery",
        "root": "root",
        "elements": {
            "root": {"type": "Stack", "props": {}, "children": ["sketch"]},
            "sketch": {
                "type": "Image",
                "props": {"src": "/static/projects/demo/sketch.png", "alt": "草图"},
                "children": [],
            },
        },
    }

    content = chat_service._append_tool_ui_specs(
        f"已有展示\n<ui-spec>{json.dumps(existing_spec, ensure_ascii=False)}</ui-spec>",
        [tool_spec],
    )

    assert content.count("<ui-spec") == 1
    assert "已有展示" in content
    assert "/static/projects/demo/portrait.png" in content
    assert "/static/projects/demo/sketch.png" not in content


def test_dramaclaw_get_sketch_candidates_displays_pool_candidates(monkeypatch):
    from novelvideo.chat import dramaclaw_mcp

    plugin = dramaclaw_mcp.PLUGIN

    def fake_request(method, path, **kwargs):
        assert method == "GET"
        assert path == "/api/v1/projects/project-a/episodes/1/beats/3/sketch-candidates"
        return {
            "ok": True,
            "data": {
                "episode": 1,
                "beat": 3,
                "current_sketch_url": "/static/current.png",
                "candidate_count": 1,
                "candidates": [
                    {
                        "id": "sketch_pool",
                        "url": "/static/candidate.png",
                        "generated_at": "2026-01-01T00:00:00",
                        "stale": False,
                    }
                ],
            },
        }

    monkeypatch.setattr(plugin, "_request", fake_request)

    payload = json.loads(
        plugin._handle_get_sketch_candidates(
            {
                "project_id": "project-a",
                "episode": 1,
                "beat": 3,
            }
        )
    )

    assert payload["ok"] is True
    assert payload["media_kind"] == "sketch_candidate"
    assert payload["candidate_count"] == 1
    assert payload["ui_spec"]["type"] == "sketch_gallery"
    assert "candidate.png" in json.dumps(payload["ui_spec"], ensure_ascii=False)


def test_dramaclaw_get_sketches_does_not_use_pool_candidates(monkeypatch, tmp_path):
    from novelvideo.chat import dramaclaw_mcp

    plugin = dramaclaw_mcp.PLUGIN
    project_dir = tmp_path / "project"
    sketch_dir = project_dir / "grids" / "ep001" / "sketch"
    sketch_dir.mkdir(parents=True)
    (sketch_dir / "beat_01_t123.png").write_bytes(b"fake")

    monkeypatch.setenv("DRAMACLAW_PROJECT_OUTPUT_DIR", str(project_dir))
    monkeypatch.setattr(
        plugin,
        "_request",
        lambda method, path, **kwargs: {
            "ok": True,
            "beats": [
                {
                    "beat_number": 1,
                    "sketch_url": "",
                    "frame_url": "",
                }
            ],
        },
    )

    payload = json.loads(
        plugin._handle_get_sketches(
            {
                "project_id": "project-a",
                "episode": 1,
            }
        )
    )

    assert payload["ok"] is True
    assert payload["sketches"][0]["sketch_url"] == ""
    assert payload["ui_spec"] is None
