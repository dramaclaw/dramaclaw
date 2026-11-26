from __future__ import annotations

import json
from types import SimpleNamespace

import httpx
import pytest
from pydantic_ai.exceptions import UnexpectedModelBehavior
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


ORG_KEY = "org-gateway-key"
ORG_BASE_URL = "https://org-gateway.invalid/v1"


class _StopAfterFactory(Exception):
    pass


async def test_org_child_uses_injected_credential_as_explicit_override(
    monkeypatch, tmp_path
):
    """组织子进程必须把父进程交来的组织凭证显式传给传输层，不走平台解析。"""

    image = tmp_path / "sheet.jpg"
    image.write_bytes(b"reference-sheet")
    monkeypatch.setenv("ST_ORG_EGRESS_MODE", "1")
    monkeypatch.setenv("ST_ORG_GATEWAY_API_KEY", ORG_KEY)
    monkeypatch.setenv("ST_ORG_GATEWAY_BASE_URL", ORG_BASE_URL)
    seen = []

    def factory(env, default_model, **kwargs):
        seen.append(kwargs)
        raise _StopAfterFactory

    monkeypatch.setattr(config, "get_newapi_text_pydantic_model", factory)

    with pytest.raises(_StopAfterFactory):
        await scene_overlap_analyzer.ask_gateway(image_path=image, prompt="Analyze")

    assert seen[0]["credential_override"] == (ORG_KEY, ORG_BASE_URL)


async def test_org_child_without_credential_fails_closed(monkeypatch, tmp_path):
    """带组织标记却没拿到凭证：报 ORG_CONTEXT_REQUIRED，绝不建平台传输。"""

    image = tmp_path / "sheet.jpg"
    image.write_bytes(b"reference-sheet")
    monkeypatch.setenv("ST_ORG_EGRESS_MODE", "1")
    monkeypatch.delenv("ST_ORG_GATEWAY_API_KEY", raising=False)
    monkeypatch.delenv("ST_ORG_GATEWAY_BASE_URL", raising=False)

    def factory(*_args, **_kwargs):
        raise AssertionError("org mode must never build a platform transport")

    monkeypatch.setattr(config, "get_newapi_text_pydantic_model", factory)

    with pytest.raises(Exception) as failed:
        await scene_spatial_contract.ask_gateway(
            image_path=image, prompt="Analyze", max_tokens=4000
        )

    assert getattr(failed.value, "code", None) == "ORG_CONTEXT_REQUIRED"


async def test_platform_child_keeps_platform_transport(monkeypatch, tmp_path):
    image = tmp_path / "sheet.jpg"
    image.write_bytes(b"reference-sheet")
    monkeypatch.delenv("ST_ORG_EGRESS_MODE", raising=False)
    monkeypatch.setenv("ST_ORG_GATEWAY_API_KEY", ORG_KEY)
    seen = []

    def factory(env, default_model, **kwargs):
        seen.append(kwargs)
        raise _StopAfterFactory

    monkeypatch.setattr(config, "get_newapi_text_pydantic_model", factory)

    with pytest.raises(_StopAfterFactory):
        await scene_overlap_analyzer.ask_gateway(image_path=image, prompt="Analyze")

    assert seen[0].get("credential_override") is None


@pytest.mark.parametrize("local_ce", [True, False])
def test_text_model_credential_override_bypasses_platform_resolution(
    monkeypatch, local_ce
):
    """显式凭证覆盖在 CE/EE 两种运行时都直连该凭证，不碰平台凭证解析。"""

    from novelvideo import model_gateway_settings

    monkeypatch.setattr(config, "uses_local_ce_runtime", lambda: local_ce)
    monkeypatch.setattr(
        model_gateway_settings,
        "get_effective_llm_config",
        lambda: SimpleNamespace(
            api_key="platform-key",
            base_url="https://platform.invalid/v1",
            is_brainclaw=False,
        ),
    )

    def platform(**_kwargs):
        raise AssertionError("override must not resolve platform credentials")

    monkeypatch.setattr(config, "get_newapi_runtime_credentials", platform)
    built = []

    def delegate(model_name, **kwargs):
        built.append((model_name, kwargs))
        return "transport"

    monkeypatch.setattr(config, "_newapi_text_openai_model", delegate)

    transport = config.get_newapi_text_pydantic_model(
        "SCENE_OVERLAP_ANALYSIS_MODEL",
        "DC-scene-overlap-analyzer-LLM",
        credential_override=(ORG_KEY, ORG_BASE_URL),
        capability="vision.analyze",
    )

    assert transport == "transport"
    assert built[0][1]["api_key"] == ORG_KEY
    assert built[0][1]["base_url"] == ORG_BASE_URL


def _non_json_then_valid(requests):
    def respond(request):
        requests.append(request)
        content = "not json at all" if len(requests) == 1 else '{"ok": true}'
        return httpx.Response(
            200,
            json={
                "id": f"analysis-{len(requests)}",
                "object": "chat.completion",
                "created": 0,
                "model": "DC-scene-overlap-analyzer-LLM",
                "choices": [
                    {
                        "index": 0,
                        "finish_reason": "stop",
                        "message": {"role": "assistant", "content": content},
                    }
                ],
            },
        )

    return respond


async def test_org_child_submits_once_and_fails_on_invalid_output(
    monkeypatch, tmp_path
):
    """一次组织出网占用只能对应一次网关提交：输出校验失败直接报错，不重试再计费。"""

    image = tmp_path / "sheet.jpg"
    image.write_bytes(b"reference-sheet")
    monkeypatch.setenv("ST_ORG_EGRESS_MODE", "1")
    monkeypatch.setenv("ST_ORG_GATEWAY_API_KEY", ORG_KEY)
    monkeypatch.setenv("ST_ORG_GATEWAY_BASE_URL", ORG_BASE_URL)
    requests = []
    transport = httpx.MockTransport(_non_json_then_valid(requests))
    async with httpx.AsyncClient(transport=transport) as client:

        def factory(env, default_model, **kwargs):
            assert kwargs["credential_override"] == (ORG_KEY, ORG_BASE_URL)
            return OpenAIChatModel(
                default_model,
                provider=OpenAIProvider(
                    base_url=ORG_BASE_URL, api_key=ORG_KEY, http_client=client
                ),
            )

        monkeypatch.setattr(config, "get_newapi_text_pydantic_model", factory)
        with pytest.raises(UnexpectedModelBehavior):
            await scene_overlap_analyzer.ask_gateway(image_path=image, prompt="Analyze")

    assert len(requests) == 1


async def test_platform_child_keeps_default_output_retry(monkeypatch, tmp_path):
    image = tmp_path / "sheet.jpg"
    image.write_bytes(b"reference-sheet")
    monkeypatch.delenv("ST_ORG_EGRESS_MODE", raising=False)
    monkeypatch.delenv("ST_ORG_GATEWAY_API_KEY", raising=False)
    monkeypatch.delenv("ST_ORG_GATEWAY_BASE_URL", raising=False)
    requests = []
    transport = httpx.MockTransport(_non_json_then_valid(requests))
    async with httpx.AsyncClient(transport=transport) as client:
        monkeypatch.setattr(
            config,
            "get_newapi_text_pydantic_model",
            lambda env, default_model, **kw: OpenAIChatModel(
                default_model,
                provider=OpenAIProvider(
                    base_url="https://gateway.invalid/v1",
                    api_key="gateway-test-key",
                    http_client=client,
                ),
            ),
        )
        result = await scene_overlap_analyzer.ask_gateway(
            image_path=image, prompt="Analyze"
        )

    assert json.loads(result) == {"ok": True}
    assert len(requests) == 2
