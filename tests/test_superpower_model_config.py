from __future__ import annotations

import importlib

import pytest


class FakeAgent:
    def __init__(self, model, **kwargs):
        self.model = model
        self.kwargs = kwargs


def _capture_model_calls(monkeypatch):
    from novelvideo import config

    calls: list[dict[str, str | None]] = []

    def fake_get_pydantic_model(
        provider_override: str | None = None,
        model_name_override: str | None = None,
    ):
        calls.append(
            {
                "provider_override": provider_override,
                "model_name_override": model_name_override,
            }
        )
        return object()

    monkeypatch.setattr(config, "get_pydantic_model", fake_get_pydantic_model)
    return calls


@pytest.mark.parametrize(
    ("module_name", "factory_name", "provider_env", "model_env"),
    [
        (
            "novelvideo.agents.global_video_optimizer",
            "create_global_video_reviewer_agent",
            "GLOBAL_VIDEO_PROVIDER",
            "GLOBAL_VIDEO_MODEL",
        ),
        (
            "novelvideo.agents.video_prompt_builder",
            "create_video_prompt_builder_agent",
            "VIDEO_PROMPT_PROVIDER",
            "VIDEO_PROMPT_MODEL",
        ),
    ],
)
def test_superpower_prompt_agents_use_default_model_provider_unless_overridden(
    monkeypatch,
    module_name,
    factory_name,
    provider_env,
    model_env,
):
    calls = _capture_model_calls(monkeypatch)
    module = importlib.import_module(module_name)
    monkeypatch.setattr(module, "Agent", FakeAgent)
    for env_name in (
        provider_env,
        model_env,
        "SUPERPOWER_PROVIDER",
        "SUPERPOWER_MODEL_PROVIDER",
        "SUPERPOWER_MODEL",
        "SUPERPOWER_MODEL_NAME",
    ):
        monkeypatch.delenv(env_name, raising=False)

    getattr(module, factory_name)()

    assert calls == [{"provider_override": None, "model_name_override": None}]


def test_global_video_reviewer_superpower_can_use_feature_specific_model_override(monkeypatch):
    calls = _capture_model_calls(monkeypatch)
    from novelvideo.agents import global_video_optimizer

    monkeypatch.setattr(global_video_optimizer, "Agent", FakeAgent)
    monkeypatch.setenv("GLOBAL_VIDEO_PROVIDER", "openrouter")
    monkeypatch.setenv("GLOBAL_VIDEO_MODEL", "gemini-3.5-flash")

    global_video_optimizer.create_global_video_reviewer_agent()

    assert calls == [
        {
            "provider_override": "openrouter",
            "model_name_override": "gemini-3.5-flash",
        }
    ]


def test_keyframe_prompt_builder_uses_video_optimizer_model(monkeypatch):
    from novelvideo import config
    from novelvideo.agents import keyframe_prompt_builder

    calls: list[tuple[str, str]] = []

    def fake_get_newapi_text_pydantic_model(model_env: str, default_model: str):
        calls.append((model_env, default_model))
        return object()

    monkeypatch.setattr(
        config,
        "get_newapi_text_pydantic_model",
        fake_get_newapi_text_pydantic_model,
    )
    monkeypatch.setattr(keyframe_prompt_builder, "Agent", FakeAgent)

    keyframe_prompt_builder.create_keyframe_prompt_builder_agent()

    assert calls == [
        ("KEYFRAME_PROMPT_MODEL", "DC-video-prompt-optimizer-LLM")
    ]
