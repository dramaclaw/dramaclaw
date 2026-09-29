import io
import json

import httpx
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from starlette.datastructures import UploadFile, Headers

from novelvideo import local_gateway
from novelvideo.local_model_catalog import LocalModelCatalog
from novelvideo.local_provider_api import cloud_image, cloud_video_status


@pytest.mark.parametrize("provider", ["ark", "siliconflow"])
def test_settings_replace_only_selected_key_and_never_return_keys(tmp_path, monkeypatch, provider):
    from fastapi import FastAPI
    from novelvideo.api.routes import model_gateway
    from novelvideo.local_model_catalog import read_key

    config(tmp_path)
    catalog = LocalModelCatalog(tmp_path)
    monkeypatch.setattr(model_gateway, "_local_catalog", lambda: catalog)
    app = FastAPI()
    app.include_router(model_gateway.router, prefix="/api/v1")
    client = TestClient(app)
    previous = {p: read_key(tmp_path, p) for p in ("ark", "siliconflow")}
    replacement = "sk-test-replacement" if provider == "siliconflow" else "test-replacement"
    response = client.post(f"/api/v1/model-gateway/local/providers/{provider}/key", json={"api_key": replacement})
    assert response.status_code == 200
    assert read_key(tmp_path, provider) == replacement
    other = "ark" if provider == "siliconflow" else "siliconflow"
    assert read_key(tmp_path, other) == previous[other]
    assert all(key not in response.text for key in [replacement, *previous.values()])
    restored = client.get("/api/v1/model-gateway/local/catalog")
    assert restored.status_code == 200
    saved = next(p for p in restored.json()["data"]["providers"] if p["id"] == provider)
    assert saved["configured"] and saved["baseUrl"].startswith("https://")
    invalid = client.post(f"/api/v1/model-gateway/local/providers/{provider}/key", json={"api_key": " "})
    assert invalid.status_code == 400
    assert read_key(tmp_path, provider) == replacement


def config(tmp_path):
    cfg = local_gateway.RouterConfig(tmp_path, "127.0.0.1", 3001, "http://127.0.0.1:8188", "https://api.siliconflow.cn/v1", "deepseek-ai/DeepSeek-V4-Flash", "embedding", "tts")
    cfg.secrets_dir.mkdir()
    cfg.router_token_file.write_text("test-router")
    cfg.siliconflow_key_file.write_text("sk-test-sf")
    (cfg.secrets_dir / "ark-agent-plan.key").write_text("test-ark-only")
    return cfg


def test_explicit_models_route_to_the_correct_host_and_key(tmp_path, monkeypatch):
    cfg = config(tmp_path)
    seen = []
    original = httpx.AsyncClient
    def handler(request):
        seen.append((str(request.url), request.headers["authorization"], json.loads(request.content)))
        return httpx.Response(200, json={"choices": [{"message": {"content": "OK"}}]})
    monkeypatch.setattr(httpx, "AsyncClient", lambda **kw: original(transport=httpx.MockTransport(handler), **kw))
    client = TestClient(local_gateway.create_app(cfg))
    headers = {"Authorization": "Bearer test-router"}
    for mid in ["ark::doubao-seed-evolving", "ark::deepseek-v4.1-flash", "siliconflow::deepseek-ai/DeepSeek-V4-Flash"]:
        assert client.post("/v1/chat/completions", headers=headers, json={"model": mid, "messages": []}).status_code == 200
    assert all(url.startswith("https://ark.cn-beijing.volces.com/api/plan/v3/") and key == "Bearer test-ark-only" for url, key, _ in seen[:2])
    assert seen[1][2]["model"] == "deepseek-v4.1-flash"
    assert seen[1][2]["thinking"] == {"type": "disabled"}
    assert seen[2][0].startswith("https://api.siliconflow.cn/v1/")
    assert seen[2][1] == "Bearer sk-test-sf"
    assert client.post("/v1/chat/completions", headers=headers, json={"model": "typo"}).status_code == 400
    LocalModelCatalog(tmp_path).update([{"id": "ark::doubao-seed-evolving", "enabled": False}])
    assert client.post("/v1/chat/completions", headers=headers, json={"model": "ark::doubao-seed-evolving"}).status_code == 400
    assert len(seen) == 3


def test_ark_stream_keeps_protocol_and_does_not_forward_thinking_toggle(tmp_path, monkeypatch):
    cfg = config(tmp_path)
    original = httpx.AsyncClient
    def handler(request):
        body = json.loads(request.content)
        assert body["stream"] is True and "enable_thinking" not in body
        assert body["model"] == "deepseek-v4.1-flash"
        return httpx.Response(200, text='data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: [DONE]\n\n', headers={"content-type": "text/event-stream"})
    monkeypatch.setattr(httpx, "AsyncClient", lambda **kw: original(transport=httpx.MockTransport(handler), **kw))
    response = TestClient(local_gateway.create_app(cfg)).post("/v1/chat/completions", headers={"Authorization": "Bearer test-router"}, json={"model": "ark::deepseek-v4.1-flash", "stream": True, "enable_thinking": False})
    assert response.status_code == 200 and "data: [DONE]" in response.text
    assert response.headers["x-accel-buffering"] == "no"


@pytest.mark.asyncio
async def test_ark_edit_forwards_actual_attachment_bytes_in_order(tmp_path, monkeypatch):
    config(tmp_path)
    catalog = LocalModelCatalog(tmp_path)
    catalog.update([{"id": "ark::doubao-seedream-5.0-lite", "enabled": True}])
    original = httpx.AsyncClient
    def handler(request):
        payload = json.loads(request.content)
        assert request.url.path.endswith("/images/generations")
        assert payload["model"] == "doubao-seedream-5.0-lite"
        assert payload["image"] == ["data:image/png;base64,b25l", "data:image/png;base64,dHdv"]
        assert payload["size"] == "2560x1440"
        return httpx.Response(200, json={"data": [{"url": "https://example.invalid/result.png"}]})
    monkeypatch.setattr(httpx, "AsyncClient", lambda **kw: original(transport=httpx.MockTransport(handler), **kw))
    uploads = [UploadFile(io.BytesIO(b), filename="ref.png", headers=Headers({"content-type": "image/png"})) for b in [b"one", b"two"]]
    result = await cloud_image(catalog, {"model": "ark::doubao-seedream-5.0-lite", "prompt": "edit", "width": 2560, "height": 1440}, uploads)
    assert result["data"][0]["url"].endswith("result.png")


@pytest.mark.asyncio
async def test_video_poll_retains_provider_id_and_normalizes_result(tmp_path, monkeypatch):
    config(tmp_path)
    original = httpx.AsyncClient
    def handler(request):
        assert request.url.path == "/v1/video/status"
        assert json.loads(request.content) == {"requestId": "job123"}
        return httpx.Response(200, json={"status": "Succeed", "results": {"videos": [{"url": "https://example.invalid/video.mp4"}]}})
    monkeypatch.setattr(httpx, "AsyncClient", lambda **kw: original(transport=httpx.MockTransport(handler), **kw))
    result = await cloud_video_status(LocalModelCatalog(tmp_path), "siliconflow~job123")
    assert result["status"] == "completed"
    assert result["video_url"].endswith("video.mp4")
    with pytest.raises(HTTPException):
        await cloud_video_status(LocalModelCatalog(tmp_path), "unknown~job123")


@pytest.mark.asyncio
async def test_siliconflow_video_submit_uses_documented_resolution_field(tmp_path, monkeypatch):
    from novelvideo.local_provider_api import cloud_video_submit
    from novelvideo.local_model_catalog import _sf_record
    config(tmp_path)
    catalog = LocalModelCatalog(tmp_path)
    record = _sf_record("Wan-AI/Wan2.2-T2V-A14B")
    with catalog.connect() as db:
        db.execute("INSERT INTO models VALUES (?,?,?)", (record["id"], json.dumps(record), 1))
    original = httpx.AsyncClient
    def handler(request):
        body = json.loads(request.content)
        assert body == {"model": record["upstreamModel"], "prompt": "test", "image_size": "720x1280"}
        return httpx.Response(200, json={"requestId": "test-job"})
    monkeypatch.setattr(httpx, "AsyncClient", lambda **kw: original(transport=httpx.MockTransport(handler), **kw))
    payload = {"model": record["id"], "prompt": "test", "metadata": {"ratio": "9:16", "resolution": "720p"}}
    assert (await cloud_video_submit(catalog, payload))["id"] == "siliconflow~test-job"
    with pytest.raises(HTTPException, match="5 seconds"):
        await cloud_video_submit(catalog, {**payload, "duration": 15})


@pytest.mark.asyncio
async def test_siliconflow_edit_omits_unsupported_size_and_preserves_refs(tmp_path, monkeypatch):
    from novelvideo.local_model_catalog import _sf_record
    config(tmp_path)
    catalog = LocalModelCatalog(tmp_path)
    record = _sf_record("Qwen/Qwen-Image-Edit-2509")
    with catalog.connect() as db:
        db.execute("INSERT INTO models VALUES (?,?,?)", (record["id"], json.dumps(record), 1))
    original = httpx.AsyncClient
    def handler(request):
        body = json.loads(request.content)
        assert "image_size" not in body and "size" not in body
        assert body["image"] == "one" and body["image2"] == "two"
        return httpx.Response(200, json={"images": [{"url": "https://example.invalid/edit.png"}]})
    monkeypatch.setattr(httpx, "AsyncClient", lambda **kw: original(transport=httpx.MockTransport(handler), **kw))
    await cloud_image(catalog, {"model": record["id"], "prompt": "edit", "image": ["one", "two"]})
    with pytest.raises(HTTPException, match="requires a reference"):
        await cloud_image(catalog, {"model": record["id"], "prompt": "edit"})
