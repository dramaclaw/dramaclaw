"""Exercise HTTP validation before SSE, not only the formatter's Python entry."""

import json
from types import SimpleNamespace

import httpx
import pytest
from fastapi import FastAPI, HTTPException
from pydantic import ValidationError

from novelvideo.api.schemas import FreezoneTextGenerateRequest
from novelvideo.freezone import h3_prompt_optimizer, text_node
from novelvideo.local_model_catalog import LocalModelCatalog


def format_body(count=14, model="ark::doubao-seed-evolving"):
    kinds = ["image", "video", "audio"] + ["image"] * (count - 3)
    refs = [
        {"node_id": f"ref-{i}", "text": f"binding {i + 1}",
         **({f"{kind}_url": f"/static/not-needed-{i}.bin"} if kind != "audio" else {})}
        for i, kind in enumerate(kinds)
    ]
    return {
        "prompt": f"人物：{{{{Mixed {count}}}}}\n【镜头1】\n时长：5秒\n固定镜头，原样保留描述。",
        "model": model,
        "references": refs + [{"node_id": "upstream-text-context", "text": "上游完整文本"}],
        "h3_options": {"mode": "allReference", "duration_sec": 5, "reference_order": kinds},
    }


@pytest.fixture
def reference_app(monkeypatch, tmp_path):
    from novelvideo.api import egress_binding
    from novelvideo.api.routes import freezone

    monkeypatch.setenv("DRAMACLAW_LOCAL_CONFIG_DIR", str(tmp_path / "config"))
    catalog = LocalModelCatalog(tmp_path / "config")
    calls = []

    async def resolve(*a, **kw):
        return SimpleNamespace(requester_user_id="u", project_id="p"), "u", "p", tmp_path, str(tmp_path)

    async def admit(**kw):
        return None

    async def generate(**kw):
        calls.append(kw)
        # The real service does the same binding conversion before constructing
        # model input. No image/video decoding is needed for formatting.
        bindings = text_node.text_writer_request_references(kw["model"], kw["references"], kw["h3_options"])
        assert len(bindings) == len(kw["references"])
        assert not any(ref.get("image_url") or ref.get("video_url") for ref in bindings)
        result = h3_prompt_optimizer.local_format_prompt(kw["prompt"], kw["h3_options"])
        await kw["on_text"](result)
        return kw["model"], result

    monkeypatch.setattr(freezone, "_resolve_freezone_project", resolve)
    monkeypatch.setattr(egress_binding, "build_request_egress_context", admit)
    monkeypatch.setattr(freezone, "generate_freezone_text", generate)
    monkeypatch.setattr(h3_prompt_optimizer, "skill_system_prompt", lambda _: "Format only")
    app = FastAPI()
    app.dependency_overrides[freezone.get_api_user] = lambda: {}
    app.include_router(freezone.router)
    return app, calls, catalog, freezone, tmp_path


@pytest.mark.asyncio
@pytest.mark.parametrize("model", ["ark::doubao-seed-evolving", "ark::deepseek-v4.1-flash", "siliconflow::deepseek-ai/DeepSeek-V4-Flash"])
@pytest.mark.parametrize("count", [14, 20, 64])
async def test_local_and_streamed_http_format_preserve_all_bindings(reference_app, model, count):
    app, calls, *_ = reference_app
    body = format_body(count, model)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        local = await client.post("/projects/p/freezone/text/format-h3", json=body)
        stream = await client.post("/projects/p/freezone/text/stream-h3", json=body)
    assert local.status_code == stream.status_code == 200
    events = [json.loads(line[6:]) for line in stream.text.splitlines() if line.startswith("data: ")]
    assert events[-1]["type"] == "done"
    assert events[-1]["generated_text"] == local.json()["data"]["generated_text"]
    assert f"{{{{Mixed {count}}}}}" in events[-1]["generated_text"]
    assert calls[0]["references"][-1]["text"] == "上游完整文本"
    assert calls[0]["h3_options"]["reference_order"] == body["h3_options"]["reference_order"]


@pytest.mark.asyncio
@pytest.mark.parametrize("fault", ["missing", "wrong_order", "extra_media", "ambiguous", "unavailable"])
async def test_both_format_routes_reject_invalid_bindings_before_model(reference_app, fault):
    app, calls, *_ = reference_app
    body = format_body()
    if fault == "missing":
        body["references"] = body["references"][:1]
    elif fault == "wrong_order":
        body["h3_options"]["reference_order"][0] = "video"
    elif fault == "extra_media":
        body["references"][-1]["image_url"] = "/static/extra.png"
    elif fault == "ambiguous":
        body["references"][0]["video_url"] = "/static/extra.mp4"
    else:
        body["prompt"] = "{{Mixed 15}} 固定镜头。"
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        for route in ["format-h3", "stream-h3"]:
            result = await client.post(f"/projects/p/freezone/text/{route}", json=body)
            assert result.status_code == 400, result.text
    assert not calls


def test_schema_keeps_format_and_generation_limits_separate():
    FreezoneTextGenerateRequest(**format_body(64))
    with pytest.raises(ValidationError, match="64"):
        FreezoneTextGenerateRequest(**format_body(65))
    with pytest.raises(ValidationError, match="at most 16"):
        FreezoneTextGenerateRequest(prompt="write", references=[{"node_id": str(i)} for i in range(17)])


def test_default_model_resolves_before_normal_reference_validation(reference_app, monkeypatch):
    _, _, catalog, routes, tmp_path = reference_app
    catalog.update([], {"text": "ark::doubao-seed-evolving"})
    image = tmp_path / "image.png"
    image.write_bytes(b"test")
    monkeypatch.setattr(routes, "resolve_static_url_to_path", lambda *_: image)
    body = FreezoneTextGenerateRequest(prompt="describe", references=[{"node_id": "i", "image_url": "/static/image.png"}])
    _, model, refs, _ = routes._validate_text_generate_request(body, tmp_path)
    assert model == "ark::doubao-seed-evolving"
    assert refs[0]["image_url"] == "/static/image.png"
    catalog.update([], {"text": "siliconflow::deepseek-ai/DeepSeek-V4-Flash"})
    with pytest.raises(HTTPException, match="vision model"):
        routes._validate_text_generate_request(body, tmp_path)


@pytest.mark.parametrize("kind,count", [("image", 9), ("video", 3)])
def test_actual_multimodal_generation_keeps_media_limits(reference_app, kind, count):
    _, _, _, routes, tmp_path = reference_app
    body = FreezoneTextGenerateRequest(prompt="describe", model="ark::doubao-seed-evolving", references=[
        {"node_id": str(i), f"{kind}_url": f"/static/{i}"} for i in range(count)
    ])
    with pytest.raises(HTTPException, match="too many"):
        routes._validate_text_generate_request(body, tmp_path)


def test_normal_reference_still_checks_file_and_model(reference_app):
    _, _, _, routes, tmp_path = reference_app
    body = FreezoneTextGenerateRequest(prompt="describe", model="ark::doubao-seed-evolving", references=[
        {"node_id": "i", "image_url": "/static/missing.png"}
    ])
    with pytest.raises(HTTPException, match="invalid text reference"):
        routes._validate_text_generate_request(body, tmp_path)
    body.model = "ark::unknown"
    with pytest.raises(HTTPException, match="unsupported text model"):
        routes._validate_text_generate_request(body, tmp_path)


@pytest.mark.asyncio
async def test_normal_writing_preserves_text_images_and_ordered_video_frames(monkeypatch, tmp_path):
    from novelvideo.freezone import jobs, paths, vision_gateway
    from pydantic_ai import BinaryContent

    monkeypatch.setattr(paths, "resolve_static_url_to_path", lambda url, root: root / url)

    async def sample(path, destination, count):
        assert path == tmp_path / "clip.mp4"
        assert count == 6
        return [tmp_path / "frame1.png", tmp_path / "frame2.png"]

    async def images(files):
        return [SimpleNamespace(data=f.name.encode(), media_type="image/png") for f in files]

    monkeypatch.setattr(jobs, "_sample_evenly", sample)
    monkeypatch.setattr(vision_gateway, "load_compact_vision_inputs", images)
    parts = await text_node._text_writer_reference_parts([
        {"node_id": "text", "text": "all upstream words"},
        {"node_id": "image", "image_url": "character.png"},
        {"node_id": "video", "video_url": "clip.mp4"},
    ], tmp_path)
    assert "all upstream words" in parts[0]
    assert [p.data for p in parts if isinstance(p, BinaryContent)] == [b"character.png", b"frame1.png", b"frame2.png"]
    assert any("Reference 3" in p and "chronological order" in p for p in parts if isinstance(p, str))


@pytest.mark.asyncio
async def test_format_rejects_disabled_provider_model_before_call(reference_app):
    app, calls, catalog, *_ = reference_app
    catalog.update([{"id": "ark::doubao-seed-evolving", "enabled": False}])
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        result = await client.post("/projects/p/freezone/text/stream-h3", json=format_body())
    assert result.status_code == 400
    assert not calls
