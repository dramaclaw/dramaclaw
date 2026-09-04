from __future__ import annotations

import base64
import json
from types import SimpleNamespace

import pytest
from pydantic import BaseModel, ConfigDict
from pydantic_ai import BinaryContent, BinaryImage
from pydantic_ai.messages import ModelRequest, UserPromptPart

from novelvideo import llm_instrumentation
from novelvideo import ports
from novelvideo.generators import video_generator


def test_json_log_value_keeps_diagnostic_fields_json_safe() -> None:
    class Result:
        def model_dump(self, *, mode: str):
            assert mode == "python"
            return {
                "api_key": "hm-7neo-rDyL-example",
                "prompt": "保留完整提示词",
                "binary": b"not-stored-verbatim",
            }

    assert llm_instrumentation._json_log_value(Result()) == {
        "api_key": "hm-7neo-rDyL-example",
        "prompt": "保留完整提示词",
        "binary": {"type": "bytes", "size_bytes": 19},
    }


def test_json_log_value_summarizes_binary_content_without_image_bytes() -> None:
    png_bytes = b"\x89PNG\r\n\x1a\n" + (b"frame-data" * 128)
    frames = [BinaryContent(data=png_bytes, media_type="image/png") for _ in range(10)]

    logged = llm_instrumentation._json_log_value(["分析这些视频关键帧", *frames])

    assert logged[0] == "分析这些视频关键帧"
    assert logged[1:] == [
        {
            "type": "BinaryContent",
            "media_type": "image/png",
            "size_bytes": len(png_bytes),
        }
        for _ in range(10)
    ]
    serialized = json.dumps(logged)
    assert "frame-data" not in serialized
    assert "BinaryContent(data=" not in serialized
    assert llm_instrumentation._json_log_value(frames[0], depth=8) == logged[1]


def test_json_log_value_summarizes_other_binary_data_wrappers() -> None:
    image = BinaryImage(data=b"image-data", media_type="image/webp")

    assert llm_instrumentation._json_log_value(image) == {
        "type": "BinaryImage",
        "media_type": "image/webp",
        "size_bytes": 10,
    }
    assert llm_instrumentation._json_log_value(memoryview(b"audio")) == {
        "type": "bytes",
        "size_bytes": 5,
    }


def test_json_log_value_recurses_through_message_history_dataclasses() -> None:
    png_bytes = b"\x89PNG\r\n\x1a\n" + (b"private-frame-data" * 128)
    request = ModelRequest(
        parts=[
            UserPromptPart(
                content=[
                    "保留完整提示词",
                    BinaryContent(data=png_bytes, media_type="image/png"),
                ]
            )
        ]
    )

    logged = llm_instrumentation._json_log_value({"message_history": [request]})

    content = logged["message_history"][0]["fields"]["parts"][0]["fields"][
        "content"
    ]
    assert content == [
        "保留完整提示词",
        {
            "type": "BinaryContent",
            "media_type": "image/png",
            "size_bytes": len(png_bytes),
        },
    ]
    serialized = json.dumps(logged, ensure_ascii=False)
    assert "保留完整提示词" in serialized
    assert "private-frame-data" not in serialized
    assert "BinaryContent(data=" not in serialized


def test_json_log_value_summarizes_binary_nested_in_pydantic_model() -> None:
    class RequestDeps(BaseModel):
        model_config = ConfigDict(arbitrary_types_allowed=True)

        prompt: str
        attachment: BinaryContent

    media_bytes = b"private-pydantic-media" * 256
    deps = RequestDeps(
        prompt="保留 Pydantic 提示词",
        attachment=BinaryContent(data=media_bytes, media_type="image/png"),
    )

    logged = llm_instrumentation._json_log_value(deps)

    assert logged["prompt"] == "保留 Pydantic 提示词"
    assert logged["attachment"]["data"] == {
        "type": "bytes",
        "size_bytes": len(media_bytes),
    }
    assert logged["attachment"]["media_type"] == "image/png"
    serialized = json.dumps(logged, ensure_ascii=False)
    assert base64.b64encode(media_bytes).decode("ascii") not in serialized
    assert "private-pydantic-media" not in serialized


def test_failure_log_metadata_keeps_only_normalized_provider_http_status() -> None:
    class ProviderRejection(RuntimeError):
        status_code = 429

    rejected = llm_instrumentation._failure_log_metadata(
        ProviderRejection("rate limited")
    )
    unknown = llm_instrumentation._failure_log_metadata(RuntimeError("timeout"))

    assert rejected["provider_http_status"] == 429
    assert "provider_http_status" not in unknown


@pytest.mark.asyncio
async def test_meter_refund_forwards_log_metadata_without_changing_reservation_id(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[tuple[str, dict | None]] = []

    class Meter:
        async def refund_model_call_credit_reservation(
            self, reservation_id: str, *, metadata: dict | None = None
        ) -> None:
            calls.append((reservation_id, metadata))

    monkeypatch.setattr(ports, "get_usage_meter", lambda: Meter())

    metadata = llm_instrumentation._failure_log_metadata(
        RuntimeError("provider failed")
    )
    await llm_instrumentation._meter_refund("reservation_1", metadata=metadata)

    assert calls == [("reservation_1", metadata)]
    assert metadata["error_message"] == "provider failed"
    assert metadata["response_payload"]["status"] == "failed"


@pytest.mark.asyncio
async def test_video_failure_forwards_empty_reservation_for_observability(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[tuple[str, dict | None]] = []

    class Meter:
        async def refund_model_call_credit_reservation(
            self, reservation_id: str, *, metadata: dict | None = None
        ) -> None:
            calls.append((reservation_id, metadata))

    monkeypatch.setattr(video_generator, "get_usage_meter", lambda: Meter())

    await video_generator._refund_video_model_call(
        "",
        source="seedance_2",
        error="provider unavailable",
    )

    assert calls == [
        (
            "",
            {"source": "seedance_2", "error": "provider unavailable"},
        )
    ]


@pytest.mark.asyncio
async def test_feature_included_agent_and_litellm_share_one_instrumentation_scope(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from pydantic_ai import Agent

    events: list[tuple[str, object]] = []
    fake_litellm = SimpleNamespace()

    async def provider_acompletion(*args, **kwargs):
        events.append(
            (
                "provider",
                llm_instrumentation._MODEL_CALL_INSTRUMENTATION_ACTIVE.get(),
            )
        )
        return SimpleNamespace(id="response_1", usage={})

    fake_litellm.acompletion = provider_acompletion

    async def original_agent_run(self, *args, **kwargs):
        await fake_litellm.acompletion(model="gateway-text-model", messages=[])
        return SimpleNamespace(output="ok")

    async def reserve_feature_included(**kwargs):
        events.append(("reserve", kwargs["metadata"]["source"]))
        return ""

    async def forward_agent_usage(self, result, *, credit_reservation_id: str):
        events.append(("finish", credit_reservation_id))

    monkeypatch.setattr(Agent, "run", original_agent_run)
    monkeypatch.setattr(llm_instrumentation, "_agent_run_patched", False)
    monkeypatch.setattr(llm_instrumentation, "_litellm_acompletion_patched", False)
    monkeypatch.setattr(llm_instrumentation, "_meter_reserve", reserve_feature_included)
    monkeypatch.setattr(
        llm_instrumentation, "_forward_agent_usage", forward_agent_usage
    )

    llm_instrumentation._patch_litellm_acompletion(fake_litellm)
    llm_instrumentation._install_agent_run_patch()

    result = await Agent.run(SimpleNamespace(model="gateway-text-model"), "prompt")

    assert result.output == "ok"
    assert events == [
        ("reserve", "pydantic_ai_agent_run"),
        ("provider", True),
        ("finish", ""),
    ]
    assert llm_instrumentation._MODEL_CALL_INSTRUMENTATION_ACTIVE.get() is False
