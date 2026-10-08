import json

import httpx
import pytest

from novelvideo.local_model_catalog import LocalModelCatalog, _sf_record


def test_provider_identity_plan_limits_and_preferences_persist(tmp_path):
    catalog = LocalModelCatalog(tmp_path)
    ark = catalog.resolve("ark::deepseek-v4.1-flash", kind="text")
    assert ark["provider"] == "ark"
    assert ark["inputModalities"] == ["text", "image"]
    assert ark["videoInput"] == "sampled_frames"
    with pytest.raises(ValueError):
        catalog.resolve("ark::doubao-seedance-2.5", kind="video")
    catalog.update([], {"text": ark["id"]})
    catalog.update([{"id": "siliconflow::deepseek-ai/DeepSeek-V4-Flash", "enabled": False}])
    reopened = LocalModelCatalog(tmp_path)
    assert reopened.setting("default:text") == ark["id"]
    with pytest.raises(ValueError):
        reopened.resolve("deepseek-ai/DeepSeek-V4-Flash")
    with pytest.raises(ValueError):
        reopened.resolve("unknown-model")


def test_default_update_is_atomic_and_cannot_leave_disabled_default(tmp_path):
    catalog = LocalModelCatalog(tmp_path)
    with pytest.raises(ValueError):
        catalog.update([{"id": "MiniMax-H3", "enabled": False}])
    assert catalog.resolve("MiniMax-H3")["enabled"]
    with pytest.raises(ValueError):
        catalog.update([], {"text": "MiniMax-H3"})


@pytest.mark.asyncio
async def test_refresh_preserves_switches_and_failed_refresh_keeps_cache(tmp_path, monkeypatch):
    catalog = LocalModelCatalog(tmp_path)
    (tmp_path / "secrets").mkdir()
    (tmp_path / "secrets/siliconflow.key").write_text("sk-test")
    mid = "siliconflow::zai-org/GLM-4.5V"
    catalog.update([{"id": mid, "enabled": False}])
    original = httpx.AsyncClient
    response = {"data": [{"id": "zai-org/GLM-4.5V"}, {"id": "Qwen/Qwen-Image"}, {"id": "deepseek-ai/DeepSeek-V4-Flash"}]}
    def handler(request):
        assert request.url.host == "api.siliconflow.cn"
        if request.url.params:
            kind = request.url.params.get("type", "text")
            names = {"image": ["Qwen/Qwen-Image"], "video": [], "text": ["zai-org/GLM-4.5V", "deepseek-ai/DeepSeek-V4-Flash"]}[kind]
            return httpx.Response(200, json={"data": [{"id": name} for name in names]})
        return httpx.Response(200, json=response)
    monkeypatch.setattr(httpx, "AsyncClient", lambda **kw: original(transport=httpx.MockTransport(handler), **kw))
    await catalog.refresh("siliconflow")
    assert not catalog.resolve(mid, require_enabled=False)["enabled"]
    assert not catalog.resolve("siliconflow::Qwen/Qwen-Image", require_enabled=False)["enabled"]
    assert catalog.setting("sync:siliconflow")
    before = catalog.models()
    response.clear()
    with pytest.raises(ValueError, match="retained"):
        await catalog.refresh("siliconflow")
    assert before == catalog.models()


def test_cloud_media_catalog_uses_transport_identity_and_rejects_disabled(tmp_path):
    catalog = LocalModelCatalog(tmp_path)
    catalog.update([{"id": "ark::doubao-seedream-5.0-lite", "enabled": True}])
    entries = catalog.merge_media("image", [{"id": "Qwen-Image-local", "providerId": "newapi"}])
    assert entries[0]["sourceProvider"] == "local"
    assert entries[1]["providerId"] == "newapi"
    assert entries[1]["sourceProvider"] == "ark"
    assert entries[1]["apiModel"] == "ark::doubao-seedream-5.0-lite"
    assert entries[1]["referenceImageMax"] == 14
    catalog.update([], {"image": entries[1]["id"]})
    reordered = catalog.merge_media("image", [{"id": "Qwen-Image-local"}])
    assert reordered[0]["id"] == entries[1]["id"]
    assert reordered[0]["isDefault"]


def test_text_vision_validation_uses_catalog_and_h3_format_uses_bindings(tmp_path, monkeypatch):
    monkeypatch.setenv("DRAMACLAW_LOCAL_CONFIG_DIR", str(tmp_path))
    from novelvideo.freezone.text_node import validate_text_writer_references_model, text_writer_request_references
    refs = [{"node_id": "a", "image_url": "test.png"}, {"node_id": "b", "video_url": "test.mp4"}]
    validate_text_writer_references_model("ark::doubao-seed-evolving", refs)
    validate_text_writer_references_model("ark::deepseek-v4.1-flash", refs)
    with pytest.raises(ValueError):
        validate_text_writer_references_model("siliconflow::deepseek-ai/DeepSeek-V4-Flash", refs)
    formatted_refs = text_writer_request_references("ark::deepseek-v4.1-flash", refs, {"reference_order": ["image", "video"]})
    assert all(not ref.get("image_url") and not ref.get("video_url") for ref in formatted_refs)
    assert "Picture 1" in formatted_refs[0]["text"]


def test_ark_catalog_refresh_does_not_claim_live_account_entitlements(tmp_path):
    catalog = LocalModelCatalog(tmp_path)
    provider = next(p for p in catalog.snapshot()["providers"] if p["id"] == "ark")
    assert provider["source"] == "official_catalog"
    assert provider["catalogDate"]
    assert not provider["configured"]
    assert "api_key" not in json.dumps(catalog.snapshot())
    assert _sf_record("Wan-AI/Wan2.2-I2V-A14B")["kind"] == "video"


@pytest.mark.asyncio
async def test_implicit_text_request_uses_saved_provider_default(tmp_path, monkeypatch):
    from types import SimpleNamespace
    from novelvideo.freezone import text_node
    monkeypatch.setenv("DRAMACLAW_LOCAL_CONFIG_DIR", str(tmp_path))
    mid = "ark::deepseek-v4.1-flash"
    LocalModelCatalog(tmp_path).update([], {"text": mid})
    seen = []
    class Agent:
        async def run(self, prompt):
            return SimpleNamespace(output="OK")
    def create(model):
        seen.append(model)
        return Agent()
    monkeypatch.setattr(text_node, "create_freezone_text_writer_agent", create)
    model, output = await text_node.generate_freezone_text(prompt="Reply OK")
    assert (model, output) == (mid, "OK")
    assert seen == [mid]
