"""Unit tests for the `runpod_qwen21_compose` entry in `config.py` — the
sketch-free Qwen-Image 2.1 "compose" render mode (added 2026-10-18). No
DB, no network."""

from __future__ import annotations

from novelvideo import config


def test_selection_exists_with_correct_provider():
    entry = config.IMAGE_GENERATION_SELECTIONS["runpod_qwen21_compose"]
    assert entry["provider"] == "runpod_qwen21_compose"
    assert entry["model"] == "qwen-image-2.1"


def test_image_provider_config_resolves_runpod_api_key(monkeypatch):
    monkeypatch.setattr(config, "RUNPOD_API_KEY", "test-runpod-key")
    cfg = config._image_provider_config(
        "runpod_qwen21_compose", selection_override="runpod_qwen21_compose"
    )
    assert cfg["api_key"] == "test-runpod-key"
    assert cfg["provider"] == "runpod_qwen21_compose"
    assert cfg["model"] == "qwen-image-2.1"


def test_not_in_render_review_selection_keys():
    # v1 deliberately has no RenderReviewStrategy — see this tuple's own
    # docstring for why (the review dialog's rewrite adapters are
    # hardcoded to exactly 2 images; compose's count varies per beat).
    assert "runpod_qwen21_compose" not in config.RENDER_REVIEW_SELECTION_KEYS


def test_visibility_gated_on_runpod_qwen21_render_configured(monkeypatch):
    monkeypatch.setattr(config, "_runpod_qwen21_render_configured", lambda: False)
    assert config._visible_image_generation_selection("runpod_qwen21_compose") == ""

    monkeypatch.setattr(config, "_runpod_qwen21_render_configured", lambda: True)
    assert config._visible_image_generation_selection("runpod_qwen21_compose") == "runpod_qwen21_compose"


def test_options_include_label_only_when_configured(monkeypatch):
    monkeypatch.setattr(config, "_runpod_qwen21_render_configured", lambda: False)
    assert "runpod_qwen21_compose" not in config.image_generation_selection_options()

    monkeypatch.setattr(config, "_runpod_qwen21_render_configured", lambda: True)
    options = config.image_generation_selection_options()
    assert "runpod_qwen21_compose" in options
    assert options["runpod_qwen21_compose"] == config.IMAGE_GENERATION_SELECTIONS["runpod_qwen21_compose"]["label"]
