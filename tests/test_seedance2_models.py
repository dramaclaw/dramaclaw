import pytest

from novelvideo.seedance2_i2v.models import (
    Seedance2I2VMode,
    Seedance2VideoConfig,
    dump_seedance2_config,
    parse_seedance2_config,
)


pytestmark = pytest.mark.m09


def test_seedance2_video_config_defaults_to_multimodal_reference():
    config = Seedance2VideoConfig()

    assert config.mode == Seedance2I2VMode.MULTIMODAL_REFERENCE
    assert config.duration == 4
    assert config.resolution == "720p"
    assert config.ratio == "9:16"
    assert config.generate_audio is True
    assert config.human_review is True


def test_parse_seedance2_config_treats_plain_string_as_final_prompt():
    config = parse_seedance2_config("  cinematic prompt  ")

    assert config.final_prompt == "cinematic prompt"
    assert config.mode == Seedance2I2VMode.MULTIMODAL_REFERENCE


def test_parse_seedance2_config_preserves_user_set_false_values():
    legacy_config = parse_seedance2_config({"generate_audio": False, "human_review": False})
    explicit_config = parse_seedance2_config(
        {
            "generate_audio": False,
            "generate_audio_user_set": True,
            "human_review": False,
            "human_review_user_set": True,
        }
    )

    assert legacy_config.generate_audio is True
    assert legacy_config.human_review is True
    assert explicit_config.generate_audio is False
    assert explicit_config.human_review is False


def test_parse_seedance2_config_preserves_scene_optimize():
    config = parse_seedance2_config({"scene_optimize": " anime "})

    assert config.scene_optimize == "anime"


def test_parse_seedance2_config_preserves_known_guidance_template_keys():
    config = parse_seedance2_config(
        {
            "prompt_guidance_template_keys": [
                " camera ",
                "camera",
                "unknown",
                "scene",
            ]
        }
    )

    assert config.model_dump().get("prompt_guidance_template_keys") == [
        "camera",
        "scene",
    ]


def test_dump_seedance2_config_round_trips_normalized_config():
    dumped = dump_seedance2_config(
        {
            "mode": "first_last_frame",
            "duration": "6",
            "reference_image_paths": ["frames/a.png", "frames/b.png"],
        }
    )
    config = parse_seedance2_config(dumped)

    assert config.mode == Seedance2I2VMode.FIRST_LAST_FRAME
    assert config.duration == 6
    assert config.reference_image_paths == ["frames/a.png", "frames/b.png"]
