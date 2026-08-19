from __future__ import annotations

from types import SimpleNamespace

import pytest

from novelvideo import llm_instrumentation
from novelvideo import ports
from novelvideo.generators import video_generator


def test_json_log_value_keeps_diagnostic_fields_json_safe() -> None:
    class Result:
        def model_dump(self, *, mode: str):
            assert mode == "json"
            return {
                "api_key": "hm-7neo-rDyL-example",
                "prompt": "保留完整提示词",
                "binary": b"not-stored-verbatim",
            }

    assert llm_instrumentation._json_log_value(Result()) == {
        "api_key": "hm-7neo-rDyL-example",
        "prompt": "保留完整提示词",
        "binary": {"type": "bytes", "length": 19},
    }


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
