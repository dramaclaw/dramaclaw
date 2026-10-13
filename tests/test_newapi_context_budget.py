"""Request budgets include prompts, output schemas and validation retries."""

from __future__ import annotations

import json
import io
import random
from typing import Literal
from types import SimpleNamespace

import httpx
import pytest
from pydantic import BaseModel, Field, create_model
from pydantic_ai import Agent, NativeOutput


def _model(monkeypatch, handler):
    from novelvideo import config, brainclaw_outcome_runtime

    monkeypatch.setenv("NEWAPI_TEXT_CONTEXT_TOKENS", "4096")
    monkeypatch.setenv("NEWAPI_TEXT_OUTPUT_TOKENS", "512")
    monkeypatch.setattr(
        config,
        "_newapi_text_http_client_factory",
        lambda *, timeout_seconds: (
            lambda: httpx.AsyncClient(
                transport=httpx.MockTransport(handler),
                timeout=timeout_seconds,
                event_hooks={
                    "response": [brainclaw_outcome_runtime.capture_brainclaw_receipt]
                },
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
@pytest.mark.parametrize("description_source", ["override", "docstring"])
async def test_context_budget_counts_native_output_description(
    monkeypatch, description_source
):
    requests = []
    description = "正文 " * 5000
    result_type = create_model(
        "DescribedResult",
        __doc__=description if description_source == "docstring" else None,
        value=(Literal["ok"], ...),
    )

    def handler(request):
        requests.append(json.loads(request.content))
        return httpx.Response(
            200,
            json={
                "id": "native-budget-test",
                "object": "chat.completion",
                "created": 1,
                "model": "DC-budget-test",
                "choices": [
                    {
                        "index": 0,
                        "finish_reason": "stop",
                        "message": {"role": "assistant", "content": '{"value":"ok"}'},
                    }
                ],
            },
        )

    agent = Agent(
        _model(monkeypatch, handler),
        output_type=NativeOutput(
            result_type,
            description=description if description_source == "override" else None,
        ),
    )
    with pytest.raises(ValueError, match="MODEL_CONTEXT_BUDGET_EXCEEDED"):
        await agent.run("short")
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


@pytest.mark.asyncio
async def test_context_budget_preserves_large_visual_input(monkeypatch, tmp_path):
    """JPEG transport encoding must not be treated as text tokens."""
    import base64

    from PIL import Image
    from novelvideo.agents import global_video_optimizer
    from novelvideo import config

    pixels = random.Random(7).randbytes(1024 * 1536 * 3)
    image_path = tmp_path / "sketch.png"
    Image.frombytes("RGB", (1024, 1536), pixels).save(image_path)
    requests = []

    def handler(request):
        payload = json.loads(request.content)
        requests.append(payload)
        return httpx.Response(
            200,
            json={
                "id": "vision-budget-test",
                "object": "chat.completion",
                "created": 1,
                "model": "DC-budget-test",
                "choices": [
                    {
                        "index": 0,
                        "finish_reason": "stop",
                        "message": {
                            "role": "assistant",
                            "content": '{"response":[{"beat_number":1,"identities":["Hero_Main"]}]}',
                        },
                    }
                ],
                "usage": {
                    "prompt_tokens": 2500,
                    "completion_tokens": 20,
                    "total_tokens": 2520,
                },
            },
        )

    model = _model(monkeypatch, handler)
    monkeypatch.setattr(
        config, "get_newapi_text_pydantic_model", lambda *a, **kw: model
    )
    result = await global_video_optimizer.detect_identities_by_ai(
        sketch_image_paths=[str(image_path)],
        color_identity_map={"#ff0000 RED": "Hero_Main"},
        total_beats=1,
    )

    assert result == {1: ["Hero_Main"]}
    parts = requests[0]["messages"][-1]["content"]
    image_url = next(
        part["image_url"]["url"] for part in parts if part["type"] == "image_url"
    )
    encoded = image_url.split(",", 1)[1]
    assert len(encoded) > 500_000
    actual_image = base64.b64decode(encoded)
    expected = io.BytesIO()
    with Image.open(image_path) as image:
        image.save(expected, format="JPEG", quality=70, optimize=True)
    assert actual_image == expected.getvalue()
    assert requests[0]["max_completion_tokens"] == 512


@pytest.mark.asyncio
async def test_context_budget_still_blocks_large_text_next_to_image(monkeypatch):
    from pydantic_ai import BinaryContent

    def forbidden(_request):
        pytest.fail("oversized text with an image must not reach transport")

    with pytest.raises(ValueError, match="MODEL_CONTEXT_BUDGET_EXCEEDED"):
        await Agent(_model(monkeypatch, forbidden), output_type=Result).run(
            [
                "正文" * 2000,
                BinaryContent(data=b"image-bytes", media_type="image/jpeg"),
            ]
        )


@pytest.mark.asyncio
async def test_context_budget_counts_data_uri_when_sent_as_text(monkeypatch):
    def forbidden(_request):
        pytest.fail("data URI in text is still text, not a visual content part")

    with pytest.raises(ValueError, match="MODEL_CONTEXT_BUDGET_EXCEEDED"):
        await Agent(_model(monkeypatch, forbidden), output_type=Result).run(
            "data:image/jpeg;base64," + "a" * 5000
        )


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", [False, True])
async def test_budgeted_request_reports_outcome_and_restores_outer_receipts(
    monkeypatch, failure
):
    from pydantic_ai.exceptions import ModelHTTPError
    from novelvideo import brainclaw_outcome_runtime as runtime

    recorded = []
    requests = []
    monkeypatch.setattr(
        runtime,
        "outcome_runtime",
        lambda: SimpleNamespace(
            enqueue=lambda receipt, passed: recorded.append((receipt, passed))
        ),
    )

    def handler(request):
        payload = json.loads(request.content)
        requests.append(payload)
        response = (
            httpx.Response(500, json={"error": {"message": "fixture failure"}})
            if failure
            else _response(payload)
        )
        response.headers["x-brainclaw-outcome-receipt"] = "v1.current.sig"
        return response

    outer = runtime._receipts.set(("v1.outer.sig",))
    try:
        agent = Agent(_model(monkeypatch, handler), output_type=Result)
        if failure:
            with pytest.raises(ModelHTTPError):
                await agent.run("short")
        else:
            assert (await agent.run("short")).output == Result(value="ok")
        assert runtime._receipts.get() == ("v1.outer.sig",)
    finally:
        runtime._receipts.reset(outer)
    assert len(requests) == 1
    assert requests[0]["max_completion_tokens"] == 512
    assert recorded == [("v1.current.sig", not failure)]


@pytest.mark.asyncio
@pytest.mark.parametrize("streaming", [False, True])
async def test_budget_rejection_does_not_report_an_outer_request(
    monkeypatch, streaming
):
    from pydantic_ai.messages import ModelRequest, UserPromptPart
    from pydantic_ai.models import ModelRequestParameters
    from novelvideo import brainclaw_outcome_runtime as runtime

    recorded = []
    monkeypatch.setattr(
        runtime,
        "outcome_runtime",
        lambda: SimpleNamespace(
            enqueue=lambda receipt, passed: recorded.append((receipt, passed))
        ),
    )

    def forbidden(_request):
        pytest.fail("over-budget request must not reach transport")

    outer = runtime._receipts.set(("v1.outer.sig",))
    try:
        model = _model(monkeypatch, forbidden)
        with pytest.raises(ValueError, match="MODEL_CONTEXT_BUDGET_EXCEEDED"):
            if streaming:
                async with model.request_stream(
                    [ModelRequest(parts=[UserPromptPart(content="正文" * 2000)])],
                    None,
                    ModelRequestParameters(),
                ):
                    pytest.fail("stream must not start")
            else:
                await Agent(model, output_type=Result).run("正文" * 2000)
        assert runtime._receipts.get() == ("v1.outer.sig",)
    finally:
        runtime._receipts.reset(outer)
    assert recorded == []


@pytest.mark.asyncio
@pytest.mark.parametrize("cancelled", [False, True])
async def test_budgeted_stream_reports_outcome_and_restores_outer_receipts(
    monkeypatch, cancelled
):
    import asyncio
    from pydantic_ai.messages import ModelRequest, UserPromptPart
    from pydantic_ai.models import ModelRequestParameters
    from novelvideo import brainclaw_outcome_runtime as runtime

    recorded = []
    requests = []
    monkeypatch.setattr(
        runtime,
        "outcome_runtime",
        lambda: SimpleNamespace(
            enqueue=lambda receipt, passed: recorded.append((receipt, passed))
        ),
    )

    def handler(request):
        requests.append(json.loads(request.content))
        chunks = [
            {"delta": {"content": "ok"}, "finish_reason": None},
            {"delta": {}, "finish_reason": "stop"},
        ]
        body = (
            "".join(
                "data: "
                + json.dumps(
                    {
                        "id": "stream-budget-test",
                        "object": "chat.completion.chunk",
                        "created": 1,
                        "model": "DC-budget-test",
                        "choices": [{"index": 0, **choice}],
                    }
                )
                + "\n\n"
                for choice in chunks
            )
            + "data: [DONE]\n\n"
        )
        return httpx.Response(
            200,
            content=body,
            headers={
                "content-type": "text/event-stream",
                "x-brainclaw-outcome-receipt": "v1.stream.sig",
            },
        )

    outer = runtime._receipts.set(("v1.outer.sig",))
    try:
        model = _model(monkeypatch, handler)

        async def consume():
            async with model.request_stream(
                [ModelRequest(parts=[UserPromptPart(content="short")])],
                None,
                ModelRequestParameters(),
            ) as response:
                if cancelled:
                    raise asyncio.CancelledError()
                async for _ in response:
                    pass

        if cancelled:
            with pytest.raises(asyncio.CancelledError):
                await consume()
        else:
            await consume()
        assert runtime._receipts.get() == ("v1.outer.sig",)
    finally:
        runtime._receipts.reset(outer)
    assert requests[0]["max_completion_tokens"] == 512
    assert recorded == [("v1.stream.sig", not cancelled)]
