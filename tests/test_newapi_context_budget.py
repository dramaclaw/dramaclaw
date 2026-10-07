"""Request budgets include prompts, output schemas and validation retries."""

from __future__ import annotations

import json
from typing import Literal

import httpx
import pytest
from pydantic import BaseModel, Field
from pydantic_ai import Agent


def _model(monkeypatch, handler):
    from novelvideo import config

    monkeypatch.setenv("NEWAPI_TEXT_CONTEXT_TOKENS", "4096")
    monkeypatch.setenv("NEWAPI_TEXT_OUTPUT_TOKENS", "512")
    monkeypatch.setattr(
        config,
        "_newapi_text_http_client_factory",
        lambda *, timeout_seconds: (
            lambda: httpx.AsyncClient(
                transport=httpx.MockTransport(handler), timeout=timeout_seconds
            )
        ),
    )
    return config._newapi_text_openai_model(
        "DC-budget-test",
        api_key="test-key",
        base_url="https://example.test/v1",
        timeout_seconds=5,
        profile=None,
    )


def _response(payload, arguments='{"value":"ok"}'):
    return httpx.Response(
        200,
        json={
            "id": "budget-test",
            "object": "chat.completion",
            "created": 1,
            "model": "DC-budget-test",
            "choices": [
                {
                    "index": 0,
                    "finish_reason": "tool_calls",
                    "message": {
                        "role": "assistant",
                        "content": None,
                        "tool_calls": [
                            {
                                "id": "output-test",
                                "type": "function",
                                "function": {
                                    "name": payload["tools"][0]["function"]["name"],
                                    "arguments": arguments,
                                },
                            }
                        ],
                    },
                }
            ],
            "usage": {"prompt_tokens": 10, "completion_tokens": 10, "total_tokens": 20},
        },
    )


class Result(BaseModel):
    value: Literal["ok"]


@pytest.mark.asyncio
@pytest.mark.parametrize("oversized_part", ["user", "system", "schema"])
async def test_context_budget_blocks_before_network(monkeypatch, oversized_part):
    requests = []

    def handler(request):
        payload = json.loads(request.content)
        requests.append(payload)
        return _response(payload)

    class LargeSchema(BaseModel):
        value: str = Field(description="设定" * 2000)

    agent = Agent(
        _model(monkeypatch, handler),
        system_prompt="设定" * 2000 if oversized_part == "system" else "check",
        output_type=LargeSchema if oversized_part == "schema" else Result,
    )
    with pytest.raises(ValueError, match="MODEL_CONTEXT_BUDGET_EXCEEDED"):
        await agent.run("正文" * 2000 if oversized_part == "user" else "short")
    assert requests == []


@pytest.mark.asyncio
async def test_context_budget_counts_retry_history(monkeypatch):
    requests = []

    def handler(request):
        payload = json.loads(request.content)
        requests.append(payload)
        return _response(payload, json.dumps({"value": "x" * 5000}))

    agent = Agent(_model(monkeypatch, handler), output_type=Result, output_retries=2)
    with pytest.raises(ValueError, match="MODEL_CONTEXT_BUDGET_EXCEEDED"):
        await agent.run("short")
    # The first request fits, but its invalid answer makes the retry too large.
    assert len(requests) == 1


@pytest.mark.asyncio
async def test_context_budget_reserves_and_caps_output(monkeypatch):
    requests = []

    def handler(request):
        payload = json.loads(request.content)
        requests.append(payload)
        return _response(payload)

    result = await Agent(_model(monkeypatch, handler), output_type=Result).run("short")
    assert result.output == Result(value="ok")
    assert requests[0]["max_completion_tokens"] == 512


@pytest.mark.asyncio
async def test_context_budget_checks_streaming_before_network(monkeypatch):
    from pydantic_ai.messages import ModelRequest, UserPromptPart
    from pydantic_ai.models import ModelRequestParameters

    def forbidden(_request):
        pytest.fail("oversized streaming prompt must not reach transport")

    model = _model(monkeypatch, forbidden)
    with pytest.raises(ValueError, match="MODEL_CONTEXT_BUDGET_EXCEEDED"):
        async with model.request_stream(
            [ModelRequest(parts=[UserPromptPart(content="正文" * 2000)])],
            None,
            ModelRequestParameters(),
        ):
            pytest.fail("stream must not start")


@pytest.mark.asyncio
@pytest.mark.parametrize("max_output", ["settings", "extra_body"])
async def test_context_budget_includes_explicit_output_limit(monkeypatch, max_output):
    def forbidden(_request):
        pytest.fail("output reservation must be checked before transport")

    settings = (
        {"max_tokens": 4096}
        if max_output == "settings"
        else {"extra_body": {"max_completion_tokens": 4096}}
    )
    with pytest.raises(ValueError, match="MODEL_CONTEXT_BUDGET_EXCEEDED"):
        await Agent(
            _model(monkeypatch, forbidden), output_type=Result, model_settings=settings
        ).run("short")
