import pytest


def test_scene_360_provider_defaults_to_newapi_when_env_is_empty(monkeypatch):
    from novelvideo import stage_asset_tasks

    monkeypatch.setenv("SCENE_360_IMAGE_PROVIDER", "")
    monkeypatch.setenv("SCENE_360_PROVIDER", "")
    monkeypatch.setenv("NANOBANANA_PROVIDER", "")

    assert stage_asset_tasks.resolve_scene_360_image_provider() == "newapi"


def test_scene_360_model_accepts_registered_gateway_model_for_provider():
    from novelvideo import stage_asset_tasks
    from novelvideo.config import NEWAPI_IMAGE_MODEL

    assert (
        stage_asset_tasks.resolve_scene_360_image_model(
            provider="newapi",
            model=NEWAPI_IMAGE_MODEL,
        )
        == NEWAPI_IMAGE_MODEL
    )


def test_scene_360_model_rejects_unknown_selection_instead_of_raw_passthrough():
    from novelvideo import stage_asset_tasks

    with pytest.raises(
        stage_asset_tasks.Scene360ImageModelSelectionError,
        match="unknown scene 360 image model selection",
    ):
        stage_asset_tasks.resolve_scene_360_image_model(
            provider="newapi",
            model="attacker-controlled-model",
        )


def test_scene_360_model_rejects_provider_mismatch_instead_of_raw_passthrough():
    from novelvideo import stage_asset_tasks

    with pytest.raises(
        stage_asset_tasks.Scene360ImageModelSelectionError,
        match="does not use provider",
    ):
        stage_asset_tasks.resolve_scene_360_image_model(
            provider="openai",
            model="newapi_gpt_image2",
        )
