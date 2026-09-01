from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from novelvideo import config
from novelvideo.api.routes import model_gateway
from novelvideo.brainclaw_contract import (
    PROFILE_HEADER,
    PROFILE_VARIANT_HEADER,
    PROFILE_VERSION,
    PROFILE_VERSION_HEADER,
    RECIPE_PROFILE_VARIANT_VERSION,
    BrainClawProfile,
    BrainClawProfileVariant,
    builtin_text_recipe_profile_variant,
    merge_brainclaw_headers,
)
from novelvideo.model_gateway_settings import (
    CUSTOM_LLM_MODE_ADVANCED,
    CUSTOM_LLM_MODE_RELAYCLAW_BRAINCLAW,
    get_effective_llm_config,
    get_effective_newapi_config,
    save_custom_newapi_gateway,
    save_official_newapi_key,
    save_relayclaw_brainclaw_key,
    set_custom_llm_mode,
    set_model_gateway_mode,
)
from novelvideo.official_defaults import (
    ADVANCED_TEXT_MODEL_BY_ENV,
    DEFAULT_COGNEE_LLM_MODEL,
    DEFAULT_TEXT_MODEL_BY_ENV,
    OFFICIAL_NEWAPI_BASE_URL,
)


def _isolate_settings_db(monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
    monkeypatch.setattr(config, "STATE_DIR", str(tmp_path / "state"))
    monkeypatch.setenv("ST_EDITION", "ce")
    monkeypatch.delenv("ST_CONTROL_PLANE_DSN", raising=False)


def _configure_custom_media() -> None:
    save_custom_newapi_gateway(
        base_url="http://local-newapi:3000",
        api_key="sk-custom-media-secret",
        activate=True,
    )


def test_mixed_mode_routes_llm_to_relayclaw_without_changing_media(
    monkeypatch, tmp_path
):
    _isolate_settings_db(monkeypatch, tmp_path)
    _configure_custom_media()
    save_relayclaw_brainclaw_key(api_key="sk-relay-secret", activate=True)

    llm = get_effective_llm_config()
    media = get_effective_newapi_config()

    assert llm.mode == CUSTOM_LLM_MODE_RELAYCLAW_BRAINCLAW
    assert llm.base_url == OFFICIAL_NEWAPI_BASE_URL
    assert llm.api_key == "sk-relay-secret"
    assert llm.model == "brainclaw"
    assert llm.is_brainclaw is True
    assert media.base_url == "http://local-newapi:3000/v1"
    assert media.api_key == "sk-custom-media-secret"


def test_cognee_legacy_llm_and_embedding_ignore_brainclaw_selector(
    monkeypatch, tmp_path
):
    _isolate_settings_db(monkeypatch, tmp_path)
    _configure_custom_media()
    save_relayclaw_brainclaw_key(api_key="sk-relay-secret", activate=True)

    from novelvideo.cognee import config as cognee_config

    assert cognee_config._effective_newapi_gateway() == (
        "sk-custom-media-secret",
        "http://local-newapi:3000/v1",
    )
    assert (
        cognee_config._get_endpoint_env(
            "newapi", "COGNEE_LLM_ENDPOINT", "LLM_ENDPOINT"
        )
        == "http://local-newapi:3000/v1"
    )
    assert (
        cognee_config._get_endpoint_env(
            "newapi", "COGNEE_EMBEDDING_ENDPOINT", "EMBEDDING_ENDPOINT"
        )
        == "http://local-newapi:3000/v1"
    )
    assert (
        cognee_config._resolve_llm_api_key("newapi", "DC-cognee-LLM")
        == "sk-custom-media-secret"
    )
    assert cognee_config._resolve_llm_model("newapi") == "openai/DC-cognee-LLM"


def test_advanced_mode_preserves_custom_llm_model_and_has_no_profile_headers(
    monkeypatch, tmp_path
):
    _isolate_settings_db(monkeypatch, tmp_path)
    _configure_custom_media()
    set_custom_llm_mode(CUSTOM_LLM_MODE_ADVANCED)
    captured: dict[str, object] = {}

    def fake_model(model_name, **kwargs):
        captured.update(model_name=model_name, **kwargs)
        return "model"

    monkeypatch.setattr(config, "_newapi_text_openai_model", fake_model)
    result = config.get_newapi_text_pydantic_model(
        "CONTENT_REWRITER_MODEL",
        model_name_override="custom-text-model",
        brainclaw_profile=BrainClawProfile.CONTENT_REWRITE,
    )

    assert result == "model"
    assert captured["model_name"] == "custom-text-model"
    assert captured["base_url"] == "http://local-newapi:3000/v1"
    assert captured["api_key"] == "sk-custom-media-secret"
    assert captured["default_headers"] == {}


def test_advanced_mode_preserves_historical_dc_alias_default(monkeypatch, tmp_path):
    _isolate_settings_db(monkeypatch, tmp_path)
    _configure_custom_media()
    set_custom_llm_mode(CUSTOM_LLM_MODE_ADVANCED)
    captured: dict[str, object] = {}

    def fake_model(model_name, **kwargs):
        captured.update(model_name=model_name, **kwargs)
        return "model"

    monkeypatch.setattr(config, "_newapi_text_openai_model", fake_model)
    config.get_newapi_text_pydantic_model("CONTENT_REWRITER_MODEL")

    assert captured["model_name"] == "DC-content-rewriter-LLM"


def test_effective_text_defaults_cover_freezone_advanced_paths(monkeypatch, tmp_path):
    _isolate_settings_db(monkeypatch, tmp_path)
    _configure_custom_media()
    set_custom_llm_mode(CUSTOM_LLM_MODE_ADVANCED)

    assert config.get_effective_newapi_text_model_name(
        "FREEZONE_VISION_MODEL"
    ) == "DC-freezone-vision-LLM"
    assert config.get_effective_newapi_text_model_name(
        "FREEZONE_RECIPE_COMPILER_MODEL"
    ) == "DC-freezone-recipe-compiler-LLM"


def test_advanced_mode_rejects_an_unmapped_fixed_task(monkeypatch, tmp_path):
    _isolate_settings_db(monkeypatch, tmp_path)
    _configure_custom_media()
    set_custom_llm_mode(CUSTOM_LLM_MODE_ADVANCED)
    monkeypatch.delenv("UNDECLARED_FIXED_MODEL", raising=False)

    with pytest.raises(
        ValueError,
        match="Missing required CE Advanced model route: UNDECLARED_FIXED_MODEL",
    ):
        config.get_effective_newapi_text_model_name("UNDECLARED_FIXED_MODEL")


def test_ee_route_follows_env_even_when_the_relay_is_brainclaw(monkeypatch):
    """EE never binds a route to BrainClaw; the model env owns the choice."""
    monkeypatch.setenv("ST_EDITION", "ee")
    # Keep this deterministic even when importing ``novelvideo.config`` lazily
    # loads a developer's local .env after the monkeypatch is applied.
    monkeypatch.setenv("NEWAPI_BASE_URL", OFFICIAL_NEWAPI_BASE_URL)
    monkeypatch.setenv("EPISODE_SCENE_PLANNER_MODEL", "DC-ee-scene-planner")

    assert get_effective_llm_config().is_brainclaw is True
    assert (
        config.get_effective_newapi_text_model_name("EPISODE_SCENE_PLANNER_MODEL")
        == "DC-ee-scene-planner"
    )

    monkeypatch.setenv("EPISODE_SCENE_PLANNER_MODEL", "brainclaw")
    assert (
        config.get_effective_newapi_text_model_name("EPISODE_SCENE_PLANNER_MODEL")
        == "brainclaw"
    )


def test_ee_fixed_task_uses_declared_env_model(monkeypatch):
    monkeypatch.setenv("ST_EDITION", "ee")
    monkeypatch.setenv("EPISODE_SCENE_PLANNER_MODEL", "DC-ee-scene-planner")

    assert (
        config.get_effective_newapi_text_model_name("EPISODE_SCENE_PLANNER_MODEL")
        == "DC-ee-scene-planner"
    )


def test_ee_always_declares_the_profile_regardless_of_relay(monkeypatch):
    """EE hands a logical alias to NewAPI and cannot know which upstream that
    alias maps to, so it always declares the Profile and lets NewAPI/BrainClaw
    decide whether to act on it."""
    monkeypatch.setenv("ST_EDITION", "ee")
    monkeypatch.delenv("ST_CONTROL_PLANE_DSN", raising=False)
    monkeypatch.setenv("NEWAPI_BASE_URL", "http://self-hosted-newapi:3000")
    monkeypatch.setenv("CONTENT_REWRITER_MODEL", "DC-content-rewriter-LLM")
    captured: dict[str, object] = {}

    from novelvideo import model_gateway_runtime

    def fake_gateway_model(**kwargs):
        captured.update(kwargs)
        return "model"

    monkeypatch.setattr(
        model_gateway_runtime,
        "create_request_scoped_gateway_model",
        fake_gateway_model,
    )

    # The relay is explicitly not BrainClaw, so nothing can be inferred.
    assert get_effective_llm_config().is_brainclaw is False

    result = config.get_newapi_text_pydantic_model(
        "CONTENT_REWRITER_MODEL",
        brainclaw_profile=BrainClawProfile.CONTENT_REWRITE,
    )

    assert result == "model"
    assert captured["model_name"] == "DC-content-rewriter-LLM"
    assert captured["default_headers"] == {
        PROFILE_HEADER: "content_rewrite",
        PROFILE_VERSION_HEADER: PROFILE_VERSION,
    }


def test_ee_fixed_task_rejects_missing_env_model(monkeypatch):
    monkeypatch.setenv("ST_EDITION", "ee")
    monkeypatch.delenv("UNDECLARED_FIXED_MODEL", raising=False)

    with pytest.raises(
        ValueError,
        match="Missing required EE model route: UNDECLARED_FIXED_MODEL",
    ):
        config.get_effective_newapi_text_model_name("UNDECLARED_FIXED_MODEL")


def test_ee_generic_route_can_keep_an_explicit_api_default(monkeypatch):
    monkeypatch.setenv("ST_EDITION", "ee")
    monkeypatch.delenv("GENERIC_PROVIDER_MODEL", raising=False)

    assert (
        config.get_effective_newapi_text_model_name(
            "GENERIC_PROVIDER_MODEL",
            "provider-default",
        )
        == "provider-default"
    )


def test_official_text_defaults_are_brainclaw_and_advanced_tasks_are_distinct():
    assert DEFAULT_COGNEE_LLM_MODEL == "DC-cognee-LLM"
    assert DEFAULT_TEXT_MODEL_BY_ENV["COGNEE_LLM_MODEL"] == "DC-cognee-LLM"
    assert {
        value
        for key, value in DEFAULT_TEXT_MODEL_BY_ENV.items()
        if key != "COGNEE_LLM_MODEL"
    } == {"brainclaw"}
    assert (
        ADVANCED_TEXT_MODEL_BY_ENV["FREEZONE_RECIPE_COMPILER_MODEL"]
        == "DC-freezone-recipe-compiler-LLM"
    )
    assert (
        ADVANCED_TEXT_MODEL_BY_ENV["FREEZONE_RECIPE_COMPILER_MODEL"]
        != ADVANCED_TEXT_MODEL_BY_ENV["FREEZONE_STORY_SCRIPT_MODEL"]
    )


def test_env_example_uses_the_dedicated_advanced_recipe_compiler_alias():
    env_example = (
        Path(__file__).resolve().parents[1] / ".env.example"
    ).read_text(encoding="utf-8")

    assert (
        "FREEZONE_RECIPE_COMPILER_MODEL="
        f"{ADVANCED_TEXT_MODEL_BY_ENV['FREEZONE_RECIPE_COMPILER_MODEL']}"
    ) in env_example.splitlines()


def test_recipe_compilation_has_a_dedicated_declared_profile():
    assert (
        BrainClawProfile.FREEZONE_RECIPE_COMPILATION.value
        == "freezone_recipe_compilation"
    )


def test_recipe_text_generation_has_a_dedicated_declared_profile():
    assert (
        BrainClawProfile.FREEZONE_RECIPE_TEXT_GENERATION.value
        == "freezone_recipe_text_generation"
    )


def test_freezone_text_generation_has_a_dedicated_declared_profile():
    assert (
        BrainClawProfile.FREEZONE_TEXT_GENERATION.value
        == "freezone_text_generation"
    )


def test_graph_ingest_is_external_and_event_segmentation_uses_its_real_name():
    declared = {profile.value for profile in BrainClawProfile}

    assert "cognee_graph_ingest" not in declared
    assert "episode_event_segmentation" in declared
    assert "cognee_event_extraction" not in declared


def test_builtin_text_recipe_builds_a_trusted_profile_variant():
    variant = builtin_text_recipe_profile_variant(
        {
            "id": "general-text",
            "output_kind": "text",
            "_catalog_source": "builtin",
        },
        has_supplemental_recipes=False,
    )

    assert variant == BrainClawProfileVariant(
        f"recipe/general-text@{RECIPE_PROFILE_VARIANT_VERSION}"
    )


@pytest.mark.parametrize(
    "recipe,has_supplemental_recipes",
    [
        (
            {
                "id": "general-text",
                "output_kind": "text",
                "_catalog_source": "user",
            },
            False,
        ),
        (
            {
                "id": "general-text",
                "output_kind": "text",
                "_catalog_source": "builtin",
            },
            True,
        ),
        (
            {
                "id": "general-text",
                "output_kind": "image",
                "_catalog_source": "builtin",
            },
            False,
        ),
    ],
)
def test_untrusted_recipe_shapes_do_not_build_a_profile_variant(
    recipe, has_supplemental_recipes
):
    assert (
        builtin_text_recipe_profile_variant(
            recipe,
            has_supplemental_recipes=has_supplemental_recipes,
        )
        is None
    )


def test_recipe_variant_header_requires_recipe_text_profile():
    with pytest.raises(ValueError, match="requires the Recipe text profile"):
        merge_brainclaw_headers(
            {},
            BrainClawProfile.CONTENT_REWRITE,
            profile_variant=BrainClawProfileVariant(
                "recipe/general-text@1.0.0"
            ),
            brainclaw_active=True,
        )


def test_effective_text_defaults_force_brainclaw_for_mixed_mode(monkeypatch, tmp_path):
    _isolate_settings_db(monkeypatch, tmp_path)
    _configure_custom_media()
    save_relayclaw_brainclaw_key(api_key="sk-relay-secret", activate=True)

    assert config.get_effective_newapi_text_model_name(
        "FREEZONE_VISION_MODEL",
        "DC-freezone-vision-LLM",
        model_name_override="custom-vision-model",
    ) == "brainclaw"
    assert config.get_effective_newapi_text_model_name(
        "FREEZONE_RECIPE_COMPILER_MODEL",
        "DC-freezone-story-script-writer-LLM",
    ) == "brainclaw"

    from novelvideo.freezone.vision_gateway import resolve_freezone_vision_model

    assert resolve_freezone_vision_model("custom-vision-model") == "brainclaw"


def test_brainclaw_factory_forces_model_and_central_profile_headers(
    monkeypatch, tmp_path
):
    _isolate_settings_db(monkeypatch, tmp_path)
    _configure_custom_media()
    save_relayclaw_brainclaw_key(api_key="sk-relay-secret", activate=True)
    captured: dict[str, object] = {}

    def fake_model(model_name, **kwargs):
        captured.update(model_name=model_name, **kwargs)
        return "model"

    monkeypatch.setattr(config, "_newapi_text_openai_model", fake_model)
    result = config.get_newapi_text_pydantic_model(
        "CONTENT_REWRITER_MODEL",
        "ignored-model",
        model_name_override="also-ignored",
        brainclaw_profile=BrainClawProfile.CONTENT_REWRITE,
    )

    assert result == "model"
    assert captured["model_name"] == "brainclaw"
    assert captured["base_url"] == OFFICIAL_NEWAPI_BASE_URL
    assert captured["api_key"] == "sk-relay-secret"
    assert captured["default_headers"] == {
        PROFILE_HEADER: "content_rewrite",
        PROFILE_VERSION_HEADER: PROFILE_VERSION,
    }


def test_brainclaw_factory_emits_trusted_recipe_variant_header(monkeypatch, tmp_path):
    _isolate_settings_db(monkeypatch, tmp_path)
    _configure_custom_media()
    save_relayclaw_brainclaw_key(api_key="sk-relay-secret", activate=True)
    captured: dict[str, object] = {}

    monkeypatch.setattr(
        config,
        "_newapi_text_openai_model",
        lambda model_name, **kwargs: captured.update(model_name=model_name, **kwargs)
        or "model",
    )
    result = config.get_newapi_text_pydantic_model(
        "FREEZONE_RECIPE_COMPILER_MODEL",
        "ignored-model",
        brainclaw_profile=BrainClawProfile.FREEZONE_RECIPE_TEXT_GENERATION,
        brainclaw_profile_variant=BrainClawProfileVariant(
            "recipe/general-text@1.0.0"
        ),
    )

    assert result == "model"
    assert captured["default_headers"] == {
        PROFILE_HEADER: "freezone_recipe_text_generation",
        PROFILE_VERSION_HEADER: PROFILE_VERSION,
        PROFILE_VARIANT_HEADER: "recipe/general-text@1.0.0",
    }


def test_hermes_brainclaw_has_no_fixed_profile(monkeypatch, tmp_path):
    _isolate_settings_db(monkeypatch, tmp_path)
    _configure_custom_media()
    save_relayclaw_brainclaw_key(api_key="sk-relay-secret", activate=True)

    from novelvideo.chat import hermes_workspace

    assert hermes_workspace._hermes_model_default() == "brainclaw"
    assert hermes_workspace.effective_gateway_credentials() == (
        "sk-relay-secret",
        OFFICIAL_NEWAPI_BASE_URL,
    )
    assert merge_brainclaw_headers({"X-Caller": "kept"}, brainclaw_active=True) == {
        "X-Caller": "kept"
    }


@pytest.mark.asyncio
async def test_cognee_litellm_request_has_no_brainclaw_profile(monkeypatch):
    from novelvideo import brainclaw_contract, llm_instrumentation

    captured: dict[str, object] = {}

    async def fake_acompletion(*args, **kwargs):
        captured.update(kwargs)
        return "response"

    fake_litellm = SimpleNamespace(acompletion=fake_acompletion)
    monkeypatch.setattr(llm_instrumentation, "_litellm_acompletion_patched", False)
    monkeypatch.setattr(brainclaw_contract, "is_brainclaw_runtime", lambda: True)
    llm_instrumentation._patch_litellm_acompletion(fake_litellm)

    result = await fake_litellm.acompletion(
        model="openai/DC-cognee-LLM",
        messages=[{"role": "user", "content": "hello"}],
        tools=[{"type": "function", "function": {"name": "lookup"}}],
        response_format={"type": "json_object"},
        stream=True,
        extra_headers={"X-Caller": "kept"},
    )

    assert result == "response"
    assert captured["tools"] == [{"type": "function", "function": {"name": "lookup"}}]
    assert captured["response_format"] == {"type": "json_object"}
    assert captured["stream"] is True
    assert captured["extra_headers"] == {"X-Caller": "kept"}


def test_brainclaw_api_accepts_custom_newapi_endpoint_and_masks_key(
    monkeypatch, tmp_path
):
    _isolate_settings_db(monkeypatch, tmp_path)
    monkeypatch.setenv("NEWAPI_PROVISIONER_ENABLED", "true")
    _configure_custom_media()
    monkeypatch.setattr(
        model_gateway,
        "refresh_model_gateway_runtime",
        lambda: {"refreshed": True},
    )
    app = FastAPI()
    app.include_router(model_gateway.router)
    client = TestClient(app)

    response = client.post(
        "/model-gateway/custom/brainclaw/config",
        json={
            "newApiApiKey": "sk-user-relay-secret",
            "newApiBaseUrl": "http://127.0.0.1:8317",
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["data"]["llmEffective"]["baseUrl"] == "http://127.0.0.1:8317/v1"
    assert payload["data"]["llmEffective"]["model"] == "brainclaw"
    assert payload["data"]["llmEffective"]["brainclaw"] is True
    assert payload["data"]["brainclaw"]["baseUrl"] == "http://127.0.0.1:8317/v1"
    assert "sk-user-relay-secret" not in response.text


def test_custom_brainclaw_endpoint_does_not_replace_official_gateway(
    monkeypatch, tmp_path
):
    _isolate_settings_db(monkeypatch, tmp_path)
    save_official_newapi_key(api_key="sk-official-secret")
    save_relayclaw_brainclaw_key(
        api_key="sk-local-secret",
        base_url="http://127.0.0.1:8317",
        activate=True,
    )

    custom_llm = get_effective_llm_config()
    assert custom_llm.base_url == "http://127.0.0.1:8317/v1"
    assert custom_llm.api_key == "sk-local-secret"
    assert custom_llm.model == "brainclaw"

    set_model_gateway_mode("official")
    official_llm = get_effective_llm_config()
    assert official_llm.base_url == OFFICIAL_NEWAPI_BASE_URL
    assert official_llm.api_key == "sk-official-secret"
    assert official_llm.model == "brainclaw"


def test_custom_llm_mode_accepts_dedicated_brainclaw_without_official_key(
    monkeypatch, tmp_path
):
    _isolate_settings_db(monkeypatch, tmp_path)
    monkeypatch.setenv("NEWAPI_PROVISIONER_ENABLED", "true")
    _configure_custom_media()
    save_relayclaw_brainclaw_key(
        api_key="sk-local-secret",
        base_url="http://127.0.0.1:8317",
        activate=False,
    )
    monkeypatch.setattr(
        model_gateway,
        "refresh_model_gateway_runtime",
        lambda: {"refreshed": True},
    )
    app = FastAPI()
    app.include_router(model_gateway.router)
    client = TestClient(app)

    response = client.post(
        "/model-gateway/custom/llm-mode",
        json={"mode": CUSTOM_LLM_MODE_RELAYCLAW_BRAINCLAW},
    )

    assert response.status_code == 200
    assert response.json()["data"]["llmEffective"]["baseUrl"] == (
        "http://127.0.0.1:8317/v1"
    )
