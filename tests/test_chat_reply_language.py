"""Chat reply-language helpers and prompt injection."""

from __future__ import annotations

from novelvideo.api.routes.chat import ChatMessageIn
from novelvideo.chat import hermes_sdk
from novelvideo.chat import service as chat_service


def test_chat_message_in_accepts_language_field() -> None:
    msg = ChatMessageIn.model_validate(
        {"type": "chat.message", "text": "hello", "language": "zh"}
    )
    assert msg.language == "zh"
    defaulted = ChatMessageIn.model_validate(
        {"type": "chat.message", "text": "hello"}
    )
    assert defaulted.language is None
    assert chat_service.normalize_chat_language(defaulted.language) == "en"


def test_hermes_stop_messages_default_to_english() -> None:
    assert "English" not in hermes_sdk._localized_stop_message("one_step", None)
    assert "started" in hermes_sdk._localized_stop_message("one_step", None).lower()
    assert "请稍后" in hermes_sdk._localized_stop_message("one_step", "zh")
    assert hermes_sdk._localized_stop_message("tool_limit", "en") == (
        hermes_sdk.DRAMACLAW_TOOL_LIMIT_STOP_MESSAGE_EN
    )


def test_normalize_chat_language_defaults_to_english() -> None:
    assert chat_service.normalize_chat_language(None) == "en"
    assert chat_service.normalize_chat_language("") == "en"
    assert chat_service.normalize_chat_language("fr-FR") == "en"
    assert chat_service.normalize_chat_language("en-US") == "en"
    assert chat_service.normalize_chat_language("zh-CN") == "zh"


def test_script_upload_guidance_is_english_by_default() -> None:
    guided = chat_service._script_creation_model_reply_prompt("帮我创建一个短剧剧本")
    assert guided is not None
    assert "reply to the user in natural english only" in guided.lower()
    assert "只用自然中文" not in guided


def test_script_upload_guidance_is_chinese_when_requested() -> None:
    guided = chat_service._script_creation_model_reply_prompt(
        "帮我创建一个短剧剧本",
        language="zh",
    )
    assert guided is not None
    assert "只用自然中文" in guided


def test_prompt_with_user_context_injects_english_reply_language(
    tmp_path, monkeypatch
) -> None:
    prefs = tmp_path / "USER.md"
    prefs.write_text("prefers short replies\n", encoding="utf-8")
    monkeypatch.setattr(chat_service, "load_user_preferences", lambda _u: prefs.read_text())

    prompt = chat_service._prompt_with_user_context("admin", "demo", "hello")
    assert "[DRAMACLAW_REPLY_LANGUAGE]" in prompt
    assert "Reply to the user in English." in prompt


def test_prompt_with_user_context_injects_chinese_reply_language(
    tmp_path, monkeypatch
) -> None:
    prefs = tmp_path / "USER.md"
    prefs.write_text("喜欢简短回复\n", encoding="utf-8")
    monkeypatch.setattr(chat_service, "load_user_preferences", lambda _u: prefs.read_text())

    prompt = chat_service._prompt_with_user_context(
        "admin", "demo", "你好", language="zh"
    )
    assert "请用自然中文回复用户。" in prompt


def test_prepare_home_agent_prompt_defaults_to_english() -> None:
    prompt = chat_service.prepare_home_agent_prompt("hello")
    assert "Reply to the user in English." in prompt


def test_reingest_confirm_copy_is_language_aware() -> None:
    zh = chat_service._frontend_context_reply(
        "[DRAMACLAW_REINGEST_CONFIRMATION]\nstage: confirm_clear\n[/DRAMACLAW_REINGEST_CONFIRMATION]",
        language="zh",
    )
    en = chat_service._frontend_context_reply(
        "[DRAMACLAW_REINGEST_CONFIRMATION]\nstage: confirm_clear\n[/DRAMACLAW_REINGEST_CONFIRMATION]",
        language="en",
    )
    assert zh is not None and "确定" in zh
    assert en is not None and "confirm" in en.lower()
