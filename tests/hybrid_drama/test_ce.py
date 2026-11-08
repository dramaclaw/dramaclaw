from novelvideo.hybrid_drama.ce import build_beat_prompt


def test_ce_beat_builds_direct_seedance_prompt_with_speaker_reference():
    project = {"id": "project-1", "visual_style": "realistic"}
    episode = {"id": "episode-1", "number": 1}
    beat = {
        "beat_number": 2,
        "visual_description": "{{Mia_mia_default}} waits; [[key_default]] is on the table. _default",
        "narration_segment": "Wait.",
        "speaker": "Mia_mia",
        "speaker_kind": "character",
        "detected_identities": ["Other_other", "Third_third", "Fourth_fourth"],
    }
    cast = {
        "Mia_mia": {"name": "Mia"},
        "Other_other": {"name": "Other"},
        "Third_third": {"name": "Third"},
        "Fourth_fourth": {"name": "Fourth"},
    }

    result = build_beat_prompt(project, episode, beat, cast)

    assert result["beat_key"] == "project-1:episode-1:2"
    assert result["reference_ids"] == ["Other_other", "Third_third", "Mia_mia"]
    assert 'Dialogue (Mia): "Wait."' in result["prompt"]
    assert "Mia waits;  is on the table." in result["prompt"]
    assert "{{" not in result["prompt"]
    assert "[[" not in result["prompt"]
    assert "_default" not in result["prompt"]
    assert "@Image3 is Mia — keep every face exactly consistent" in result["prompt"]
    assert result["has_dialogue"] is True


def test_ce_narration_uses_calm_voiceover_without_character_dialogue():
    result = build_beat_prompt(
        {"id": "p"},
        {"id": "e"},
        {
            "beat_number": 1,
            "visual_description": "Rain falls.",
            "narration_segment": "Later that night",
            "speaker": "narrator",
            "speaker_kind": "non_character",
        },
        {},
    )

    assert 'Narration (calm voiceover): "Later that night"' in result["prompt"]
    assert "Dialogue (" not in result["prompt"]
