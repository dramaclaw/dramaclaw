"""Global video agents use the same structured-output mode as the other agents.

Structured results go through a tool call rather than ``response_format``
JSON schema, so they work on any model behind a text alias, including models
that reject ``json_schema`` response formats.
"""

from __future__ import annotations

import json

import httpx
import pytest


def _wire_model(monkeypatch, requests, arguments):
    from novelvideo import config

    def handler(request):
        payload = json.loads(request.content)
        requests.append(payload)
        tools = payload.get("tools") or []
        if not tools:
            return httpx.Response(
                400,
                json={
                    "error": {
                        "message": "`json_schema` is not supported by this model."
                    }
                },
            )
        return httpx.Response(
            200,
            json={
                "id": "wire-test",
                "object": "chat.completion",
                "created": 1,
                "model": "DC-wire-test",
                "choices": [
                    {
                        "index": 0,
                        "finish_reason": "tool_calls",
                        "message": {
                            "role": "assistant",
                            "content": None,
                            "tool_calls": [
                                {
                                    "id": "output-call",
                                    "type": "function",
                                    "function": {
                                        "name": tools[0]["function"]["name"],
                                        "arguments": json.dumps(arguments),
                                    },
                                }
                            ],
                        },
                    }
                ],
                "usage": {
                    "prompt_tokens": 10,
                    "completion_tokens": 10,
                    "total_tokens": 20,
                },
            },
        )

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
        "DC-wire-test",
        api_key="test-key",
        base_url="https://example.test/v1",
        timeout_seconds=5,
        profile=None,
    )


@pytest.mark.asyncio
async def test_reviewer_returns_structured_result_through_tool_call(monkeypatch):
    from novelvideo import config
    from novelvideo.agents import global_video_optimizer

    requests: list[dict] = []
    model = _wire_model(
        monkeypatch,
        requests,
        {"needs_fix": False, "reason": "ok", "prompt": "camera pushes in"},
    )
    monkeypatch.setattr(
        config, "get_superpower_pydantic_model", lambda **_kwargs: model
    )

    result = await global_video_optimizer.create_global_video_reviewer_agent().run(
        "review"
    )

    assert result.output == global_video_optimizer.ReviewResult(
        needs_fix=False, reason="ok", prompt="camera pushes in"
    )
    assert "response_format" not in requests[0]
    assert requests[0]["reasoning_effort"] == "none"


@pytest.mark.asyncio
async def test_identity_detector_returns_structured_result_through_tool_call(
    monkeypatch,
):
    from novelvideo import config
    from novelvideo.agents import global_video_optimizer

    requests: list[dict] = []
    model = _wire_model(
        monkeypatch,
        requests,
        {"response": [{"beat_number": 1, "identities": ["hero"]}]},
    )
    monkeypatch.setattr(
        config, "get_newapi_text_pydantic_model", lambda *_args, **_kwargs: model
    )

    result = await global_video_optimizer._create_identity_detector_agent().run(
        "detect"
    )

    assert result.output == [
        global_video_optimizer.BeatIdentity(beat_number=1, identities=["hero"])
    ]
    assert "response_format" not in requests[0]
    assert requests[0]["reasoning_effort"] == "none"
