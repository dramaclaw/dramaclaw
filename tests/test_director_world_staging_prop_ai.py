from __future__ import annotations

import pydantic_ai

from novelvideo import config
from novelvideo.director_world import staging_prop_ai


def test_create_staging_prop_agent_uses_request_model_config(monkeypatch) -> None:
    captured: dict[str, object] = {}
    model_instance = object()
    agent_instance = object()

    def fake_model(model_name, **kwargs):
        captured["model_name"] = model_name
        captured["model_kwargs"] = kwargs
        return model_instance

    def fake_agent(model, **kwargs):
        captured["agent_model"] = model
        return agent_instance

    monkeypatch.setenv("STAGING_PROP_TIMEOUT_SECONDS", "45")
    monkeypatch.setattr(config, "_newapi_text_openai_model", fake_model)
    monkeypatch.setattr(pydantic_ai, "Agent", fake_agent)

    result = staging_prop_ai.create_staging_prop_agent(
        model="request-model",
        api_key="request-key",
        base_url="https://request.example/v1",
    )

    assert result is agent_instance
    assert captured["model_name"] == "request-model"
    assert captured["model_kwargs"] == {
        "api_key": "request-key",
        "base_url": "https://request.example/v1",
        "timeout_seconds": 45.0,
        "profile": None,
    }
    assert captured["agent_model"] is model_instance


def test_generate_ai_staging_prop_uses_director_world_shape_hints(monkeypatch) -> None:
    captured: dict[str, object] = {}

    async def fake_run_staging_prop_agent(request, **kwargs):
        captured.update(kwargs)
        captured["task"] = staging_prop_ai.build_user_prompt(request)
        return {
            "prop_id": "horse_mount",
            "name": "可骑的马",
            "semantic_label": "horse",
            "shape_hint": "quadruped_mount",
            "position": [1, 0, 2],
            "scale": [1.4, 1.25, 2.2],
            "relation_intent": "mount_actor",
        }

    monkeypatch.setattr(staging_prop_ai, "run_staging_prop_agent", fake_run_staging_prop_agent)

    result = staging_prop_ai.generate_ai_staging_prop(
        {
            "api_key": "test-key",
            "base_url": "http://example.test/v1",
            "model": "test-model",
            "scene_id": "面馆",
            "user_hint": "让男青年骑一匹马",
            "crosshair_target": {"position": [1, 0, 2]},
        }
    )

    assert result["ok"] is True
    assert result["model"] == "test-model"
    assert result["prop"]["shape_hint"] == "quadruped_mount"
    assert result["prop"]["attachment_points"][0]["kind"] == "mount"
    assert captured["model"] == "test-model"
    assert "让男青年骑一匹马" in captured["task"]


def test_generate_ai_staging_prop_falls_back_to_shape_hint_inference(monkeypatch) -> None:
    async def fake_run_staging_prop_agent(_request, **_kwargs):
        return {"name": "一匹马"}

    monkeypatch.setattr(staging_prop_ai, "run_staging_prop_agent", fake_run_staging_prop_agent)

    result = staging_prop_ai.generate_ai_staging_prop(
        {"api_key": "test-key", "user_hint": "让他骑马", "crosshair_target": {}}
    )

    assert result["prop"]["semantic_label"] == "horse"
    assert result["prop"]["shape_hint"] == "quadruped_mount"
    assert result["prop"]["relation_intent"] == "mount_actor"


def test_resolve_model_config_defaults_to_staging_prop_dc_alias(monkeypatch) -> None:
    monkeypatch.delenv("STAGING_PROP_MODEL", raising=False)

    model, _api_key, _base_url = staging_prop_ai.resolve_model_config({})

    assert model == "DC-staging-prop-planner-LLM"
