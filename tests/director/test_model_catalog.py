"""Freeze the same provider/model the user selected; never substitute quota lanes."""

from types import SimpleNamespace

import pytest

from novelvideo.director import writing
from novelvideo.director.models import CreateWork, DirectorPreset, GenerateDraft
from novelvideo.director.store import DirectorStore
from novelvideo.local_model_catalog import LocalModelCatalog, secret_path


@pytest.fixture
def catalog(tmp_path, monkeypatch):
    value = LocalModelCatalog(tmp_path / "router")
    for provider in ("ark", "siliconflow"):
        key = secret_path(value.root, provider)
        key.parent.mkdir(parents=True, exist_ok=True)
        key.touch()
    value.update([], {"text": "ark::doubao-seed-evolving"})
    monkeypatch.setattr(writing, "get_effective_newapi_gateway_config", lambda: SimpleNamespace(base_url="http://localhost:3001/v1"))
    monkeypatch.setattr("novelvideo.local_gateway.router_config", lambda: SimpleNamespace(root=value.root, port=3001))
    return value


@pytest.mark.parametrize("model", ["ark::doubao-seed-evolving", "ark::deepseek-v4.1-flash"])
def test_selected_model_is_frozen_with_exact_provider(catalog, tmp_path, model):
    store = DirectorStore(tmp_path / "project")
    work = store.create_work(CreateWork(title="Catalog", brief="A traveller returns home.", preset=DirectorPreset(mode="original", model_name=model, episode_count=1)))
    request = writing.compile_generation(store, work["id"], GenerateDraft(kind="outline", expected_version=0))
    assert request["parameters"]["model_name"] == model
    assert writing.resolve_director_model("") == "ark::doubao-seed-evolving"


def test_default_change_does_not_replace_explicit_selection(catalog):
    catalog.update([], {"text": "ark::deepseek-v4.1-flash"})
    assert writing.resolve_director_model("") == "ark::deepseek-v4.1-flash"
    assert writing.resolve_director_model("ark::doubao-seed-evolving") == "ark::doubao-seed-evolving"


@pytest.mark.parametrize("model", ["deepseek-v4.1-flash", "ark::made-up", "MiniMax-H3", "ark::ark-code-latest"])
def test_unknown_bare_ark_wrong_modality_disabled_are_not_fallbacks(catalog, model):
    with pytest.raises(ValueError):
        writing.resolve_director_model(model)


def test_refresh_rejects_a_previously_visible_disabled_model(catalog):
    selected = "ark::deepseek-v4.1-flash"
    assert selected in {item["id"] for item in writing.director_model_contract()["options"]}
    catalog.update([{"id": selected, "enabled": False}])
    assert selected not in {item["id"] for item in writing.director_model_contract()["options"]}
    with pytest.raises(ValueError, match="disabled"):
        writing.resolve_director_model(selected)


def test_legacy_siliconflow_identity_is_canonical_not_ark(catalog):
    model = next(item for item in catalog.models(enabled_only=True) if item["provider"] == "siliconflow" and item["kind"] == "text")
    assert writing.resolve_director_model(model["upstreamModel"]) == model["id"]


def test_unconfigured_provider_is_hidden_and_cannot_execute(catalog):
    secret_path(catalog.root, "ark").unlink()
    assert not any(item["id"].startswith("ark::") for item in writing.director_model_contract()["options"])
    with pytest.raises(ValueError, match="not configured"):
        writing.resolve_director_model("ark::doubao-seed-evolving")


def test_remote_gateway_keeps_its_own_model_contract(catalog, monkeypatch):
    monkeypatch.setattr(writing, "get_effective_newapi_gateway_config", lambda: SimpleNamespace(base_url="https://example.invalid/v1"))
    monkeypatch.setattr(writing, "get_newapi_text_model_name", lambda *args: "remote-default")
    assert writing.director_model_contract() == {"model_name": "remote-default", "locked": False}
    assert writing.resolve_director_model("remote-chosen") == "remote-chosen"
