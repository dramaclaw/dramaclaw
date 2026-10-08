"""Partial model text must arrive early, remain untrusted, and be cancellable."""

import asyncio
import json
from types import SimpleNamespace

import pytest
from pydantic_ai import Agent
from pydantic_ai.models.function import FunctionModel

from novelvideo.freezone import h3_prompt_optimizer, text_node

SOURCE = "镜头保持固定，人物缓慢向左转身，窗外的光照和背景陈设保持不变。"
OPTIONS = {"mode": "textToVideo", "duration_sec": 12, "reference_order": []}
DRAFT = (f"integrated_multimodal_description: [Shot 1] {SOURCE}\n"
         "overall_soundscape: N/A\nnon_diegetic_music: N/A")


@pytest.mark.asyncio
@pytest.mark.parametrize("valid", [True, False])
async def test_service_streams_before_completion_without_hidden_retries(monkeypatch, valid):
    calls, chunks = [], []

    async def stream(messages, info):
        calls.append(messages)
        assert info.model_settings["extra_body"]["enable_thinking"] is False
        yield "integrated_multimodal_description: 1\n"
        await asyncio.sleep(0.08)
        assert chunks  # A final-only or buffered implementation fails here.
        yield "overall_soundscape: N/A\nnon_diegetic_music: N/A\n" if valid else "changed original scene"

    monkeypatch.setattr(h3_prompt_optimizer, "skill_system_prompt", lambda _: "Format only")
    monkeypatch.setattr(text_node, "create_freezone_text_writer_agent",
                        lambda *a, **kw: Agent(FunctionModel(stream_function=stream), output_type=str))

    async def collect(delta):
        chunks.append(delta)

    request = text_node.generate_freezone_text(
        prompt=SOURCE, model="deepseek-ai/DeepSeek-V4-Flash",
        h3_options=OPTIONS, on_text=collect,
    )
    if valid:
        _, result = await request
        assert SOURCE in result
        assert "".join(chunks).strip() == result
    else:
        with pytest.raises(ValueError):
            await request
    assert len(calls) == 1


@pytest.mark.parametrize("wire,match", [
    ("integrated_multimodal_description: 2\n", "unavailable source"),
    ("integrated_multimodal_description: rewritten prose\n", "only source line"),
    ("summary: 1\n", "field order"),
    ("integrated_multimodal_description: 1,1\n", "source order"),
    ("integrated_multimodal_description: N/A\noverall_soundscape: N/A\nnon_diegetic_music: N/A\n", "omitted original"),
    ("integrated_multimodal_description: N/A\noverall_soundscape: 1\nnon_diegetic_music: N/A\n", "omitted shot"),
    ("integrated_multimodal_description: 1\n", "incomplete"),
])
def test_plan_rejects_omissions_rewrites_and_invalid_ranges(monkeypatch, wire, match):
    monkeypatch.setattr(h3_prompt_optimizer, "skill_system_prompt", lambda _: "Format only")
    plan = h3_prompt_optimizer.H3FormatPlan(SOURCE, OPTIONS)
    with pytest.raises(ValueError, match=match):
        plan.feed(wire)
        plan.finish()


def test_full_reference_plan_copies_every_word_and_derives_only_explicit_times(monkeypatch):
    monkeypatch.setattr(h3_prompt_optimizer, "skill_system_prompt", lambda _: "Format only")
    source = "人物：{{Mixed 1}}\n共用条件：保持角色原位。\n【镜头1】\n时长：5秒\n固定镜头。\n【镜头2】\n时长：7秒\n对白：别走。"
    options = dict(OPTIONS, mode="allReference", reference_order=["image"])
    plan = h3_prompt_optimizer.H3FormatPlan(source, options)
    wire = "subject_definitions: 1\nsummary: 2\nretention_analysis: N/A\ndetailed_description: 3-8\noverall_soundscape: N/A\nnon_diegetic_music: N/A"
    for char in wire:
        plan.feed(char)
    result = plan.finish()
    assert all(line in result for line in source.splitlines())
    assert "[Shot 1] At 00:00.000" in result
    assert "[Shot 2] At 00:05.000" in result
    assert "<Picture" not in result


@pytest.mark.parametrize("mode", ["firstFrame", "imageToVideo", "firstLastFrame"])
def test_plan_keyframe_alignment(monkeypatch, mode):
    monkeypatch.setattr(h3_prompt_optimizer, "skill_system_prompt", lambda _: "Format only")
    plan = h3_prompt_optimizer.H3FormatPlan(SOURCE, dict(OPTIONS, mode=mode, reference_order=["image", "image"]))
    plan.feed("integrated_multimodal_description: 1\noverall_soundscape: N/A\nnon_diegetic_music: N/A")
    result = plan.finish()
    assert "{{Mixed 1}}" in result
    if mode == "firstLastFrame":
        assert "{{Mixed 2}}" in result
        assert "12.00-second" in result


@pytest.mark.asyncio
async def test_already_formatted_stream_is_idempotent_without_model_call(monkeypatch):
    monkeypatch.setattr(h3_prompt_optimizer, "skill_system_prompt", lambda _: "Format only")
    def unexpected_model(*args, **kwargs):
        raise AssertionError("Already formatted text must not call a model")
    monkeypatch.setattr(text_node, "create_freezone_text_writer_agent", unexpected_model)
    chunks = []
    async def collect(text):
        chunks.append(text)
    _, result = await text_node.generate_freezone_text(prompt=DRAFT, h3_options=OPTIONS, on_text=collect)
    assert result == DRAFT
    assert chunks == [DRAFT]


@pytest.fixture
def stream_endpoint(monkeypatch, tmp_path):
    from novelvideo.api import egress_binding
    from novelvideo.api.routes import freezone
    from novelvideo.api.schemas import FreezoneTextGenerateRequest

    async def resolve(*args, **kwargs):
        return SimpleNamespace(requester_user_id="verified-user", project_id="verified-project"), "u", "p", tmp_path, str(tmp_path)

    async def admit(**kwargs):
        assert kwargs == dict(requester_user_id="verified-user", project_id="verified-project", task_type="freezone_text_generate")
        return None

    monkeypatch.setattr(freezone, "_resolve_freezone_project", resolve)
    monkeypatch.setattr(egress_binding, "build_request_egress_context", admit)
    monkeypatch.setattr(h3_prompt_optimizer, "skill_system_prompt", lambda _: "Format only")
    body = FreezoneTextGenerateRequest(prompt=SOURCE, model="deepseek-ai/DeepSeek-V4-Flash", h3_options=OPTIONS)
    return freezone, body


@pytest.mark.asyncio
@pytest.mark.parametrize("fail", [False, True])
async def test_endpoint_only_marks_validated_results_done(monkeypatch, stream_endpoint, fail):
    routes, body = stream_endpoint

    async def generate(**kwargs):
        assert kwargs["egress_context"] is None
        await kwargs["on_text"]("partial")
        if fail:
            raise ValueError("unavailable reference")
        return "selected", DRAFT

    monkeypatch.setattr(routes, "generate_freezone_text", generate)
    response = await routes.freezone_text_stream_h3("untrusted-url-id", body, {})
    events = [json.loads(item["data"]) async for item in response.body_iterator]
    assert events[0]["type"] == "start"
    assert events[1] == {"type": "delta", "text": "partial"}
    assert events[-1]["type"] == ("error" if fail else "done")


@pytest.mark.asyncio
async def test_closing_stream_cancels_model(monkeypatch, stream_endpoint):
    routes, body = stream_endpoint
    cancelled = asyncio.Event()

    async def generate(**kwargs):
        try:
            await kwargs["on_text"]("first")
            await asyncio.Event().wait()
        finally:
            cancelled.set()

    monkeypatch.setattr(routes, "generate_freezone_text", generate)
    response = await routes.freezone_text_stream_h3("p", body, {})
    await anext(response.body_iterator)
    await anext(response.body_iterator)
    await response.body_iterator.aclose()
    assert cancelled.is_set()


@pytest.mark.asyncio
async def test_stream_admission_failure_never_calls_model(monkeypatch, stream_endpoint):
    from novelvideo.api import egress_binding
    routes, body = stream_endpoint

    async def deny(**kwargs):
        raise RuntimeError("admission denied")

    monkeypatch.setattr(egress_binding, "build_request_egress_context", deny)
    with pytest.raises(RuntimeError, match="admission denied"):
        await routes.freezone_text_stream_h3("p", body, {})
