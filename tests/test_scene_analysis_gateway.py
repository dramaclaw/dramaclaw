from __future__ import annotations

import json
from types import SimpleNamespace

import httpx
import pytest
from pydantic_ai.models.openai import OpenAIChatModel
from pydantic_ai.providers.openai import OpenAIProvider

from novelvideo import config
from novelvideo.director_world import (
    scene_analysis_gateway,
    scene_overlap_analyzer,
    scene_spatial_contract,
)


@pytest.mark.parametrize(
    ("module", "model_env", "alias", "tokens"),
    [
        (
            scene_overlap_analyzer,
            "SCENE_OVERLAP_ANALYSIS_MODEL",
            "DC-scene-overlap-analyzer-LLM",
            2200,
        ),
        (
            scene_spatial_contract,
            "SCENE_SPATIAL_CONTRACT_MODEL",
            "DC-scene-spatial-contract-LLM",
            16000,
        ),
    ],
)
async def test_analysis_sends_image_and_business_alias_to_gateway(
    monkeypatch,
    tmp_path,
    module,
    model_env,
    alias,
    tokens,
):
    requests = []
    factory_calls = []
    image = tmp_path / "sheet.jpg"
    image.write_bytes(b"reference-sheet")
    monkeypatch.setenv("OPENROUTER_API_KEY", "unused-legacy-key")
    monkeypatch.setenv("OPENROUTER_VISION_MODEL", "unused-legacy-model")

    def respond(request):
        requests.append(request)
        return httpx.Response(
            200,
            json={
                "id": "gateway-analysis",
                "object": "chat.completion",
                "created": 0,
                "model": alias,
                "choices": [
                    {
                        "index": 0,
                        "finish_reason": "stop",
                        "message": {
                            "role": "assistant",
                            "content": '{"confidence":0.8}',
                        },
                    }
                ],
                "usage": {
                    "prompt_tokens": 10,
                    "completion_tokens": 5,
                    "total_tokens": 15,
                },
            },
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:

        def gateway_model(env, default_model, **kwargs):
            factory_calls.append((env, default_model, kwargs))
            return OpenAIChatModel(
                default_model,
                provider=OpenAIProvider(
                    base_url="https://gateway.invalid/v1",
                    api_key="gateway-test-key",
                    http_client=client,
                ),
            )

        monkeypatch.setattr(config, "get_newapi_text_pydantic_model", gateway_model)
        kwargs = {"image_path": image, "prompt": "Analyze references"}
        if module is scene_spatial_contract:
            kwargs["max_tokens"] = tokens
        result = await module.ask_gateway(**kwargs)

    assert json.loads(result) == {"confidence": 0.8}
    assert len(requests) == 1
    assert str(requests[0].url) == "https://gateway.invalid/v1/chat/completions"
    assert requests[0].headers["authorization"] == "Bearer gateway-test-key"
    payload = json.loads(requests[0].content)
    assert payload["model"] == alias
    assert payload["messages"][0]["content"][1]["image_url"]["url"].startswith(
        "data:image/jpeg;base64,"
    )
    assert payload["response_format"] == {"type": "json_object"}
    assert payload["max_completion_tokens"] == tokens
    assert payload["reasoning_effort"] == "none"
    assert factory_calls[0][:2] == (model_env, alias)
    assert factory_calls[0][2]["capability"] == "vision.analyze"


async def test_gateway_rejection_preserves_status_and_reason(monkeypatch, tmp_path):
    image = tmp_path / "sheet.jpg"
    image.write_bytes(b"reference-sheet")
    transport = httpx.MockTransport(
        lambda request: httpx.Response(
            403,
            json={
                "error": {"message": "Model access denied", "type": "permission_error"}
            },
        )
    )
    async with httpx.AsyncClient(transport=transport) as client:
        monkeypatch.setattr(
            config,
            "get_newapi_text_pydantic_model",
            lambda *a, **kw: OpenAIChatModel(
                "DC-scene-overlap-analyzer-LLM",
                provider=OpenAIProvider(
                    base_url="https://gateway.invalid/v1",
                    api_key="gateway-test-key",
                    http_client=client,
                ),
            ),
        )
        with pytest.raises(Exception, match="403.*Model access denied"):
            await scene_overlap_analyzer.ask_gateway(image_path=image, prompt="Analyze")


def test_analysis_checks_effective_gateway_credentials(monkeypatch):
    from novelvideo import model_gateway_settings

    monkeypatch.setattr(
        model_gateway_settings,
        "get_effective_llm_config",
        lambda: SimpleNamespace(
            api_key="effective-key", base_url="https://gateway.invalid/v1"
        ),
    )
    calls = []

    def credentials(**kwargs):
        calls.append(kwargs)
        return "effective-key", "https://gateway.invalid/v1"

    monkeypatch.setattr(config, "get_newapi_runtime_credentials", credentials)
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    assert scene_analysis_gateway.scene_analysis_gateway_configured()
    assert calls[0]["api_key_override"] == "effective-key"
    monkeypatch.setattr(config, "get_newapi_runtime_credentials", lambda **kw: ("", ""))
    assert not scene_analysis_gateway.scene_analysis_gateway_configured()


@pytest.mark.parametrize("module", [scene_overlap_analyzer, scene_spatial_contract])
def test_cli_defaults_do_not_inherit_legacy_openrouter_model(monkeypatch, module):
    import sys

    monkeypatch.setattr(sys, "argv", ["scene-analysis"])
    monkeypatch.setenv("OPENROUTER_VISION_MODEL", "legacy-direct-model")
    monkeypatch.delenv("SCENE_OVERLAP_ANALYSIS_MODEL", raising=False)
    monkeypatch.delenv("SCENE_SPATIAL_CONTRACT_MODEL", raising=False)
    assert module.parse_args().model == ""
