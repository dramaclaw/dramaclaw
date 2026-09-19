from __future__ import annotations


def test_image_generation_selection_normalizes_legacy_values_to_visible_newapi_options():
    from novelvideo.config import (
        image_generation_selection_options,
        normalize_image_generation_selection,
    )

    options = image_generation_selection_options()

    assert normalize_image_generation_selection("huimeng_image2_official") == "newapi_gpt_image2"
    assert normalize_image_generation_selection("huimeng_gpt_image2") == "newapi_gpt_image2"
    assert normalize_image_generation_selection("huimeng_nanobanana2") == "newapi_nanobanana2"
    assert normalize_image_generation_selection("openrouter_nanobanana2") == "newapi_nanobanana2"
    assert normalize_image_generation_selection("unknown") in options


def test_local_qwen_image_is_an_explicit_catalog_selection():
    from novelvideo.config import (
        IMAGE_GENERATION_SELECTIONS,
    )

    assert IMAGE_GENERATION_SELECTIONS["newapi_qwen_image_local"]["label"] == (
        "Qwen Image（本地 ComfyUI）"
    )
    assert IMAGE_GENERATION_SELECTIONS["newapi_qwen_image_local"]["model"] == (
        "Qwen-Image-local"
    )


def test_local_krea2_turbo_is_an_explicit_catalog_selection():
    from novelvideo.config import (
        IMAGE_GENERATION_SELECTIONS,
    )

    assert IMAGE_GENERATION_SELECTIONS["newapi_krea2_local"]["label"] == (
        "Krea 2 Turbo（本地 Int8，Mac 实验）"
    )
    assert IMAGE_GENERATION_SELECTIONS["newapi_krea2_local"]["model"] == (
        "Krea-2-Turbo-local"
    )


def test_character_image_selection_normalizes_legacy_values_to_visible_newapi_options():
    from novelvideo.config import (
        character_image_selection_options,
        normalize_character_image_selection,
    )

    options = character_image_selection_options()

    assert normalize_character_image_selection("huimeng_gpt_image2") == "newapi_gpt_image2"
    assert normalize_character_image_selection("huimeng_nanobanana2") == "newapi_nanobanana2"
    assert normalize_character_image_selection("seedream") in options
