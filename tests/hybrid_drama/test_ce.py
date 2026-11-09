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


def test_ce_client_fetches_real_beat_and_identity_records():
    import httpx

    from novelvideo.hybrid_drama.ce import CEClient

    requests = []

    def handler(request):
        requests.append(request)
        payloads = {
            "/api/v1/projects/project-1": {
                "ok": True,
                "data": {"project_id": "project-1", "name": "Demo"},
            },
            "/api/v1/projects/project-1/episodes/2": {
                "ok": True,
                "data": {"number": 2, "title": "Second"},
            },
            "/api/v1/projects/project-1/episodes/2/beats": {
                "ok": True,
                "data": [
                    {
                        "beat_number": 3,
                        "visual_description": "{{Mia_mia_default}} waits.",
                        "narration_segment": "Wait.",
                        "speaker": "Mia_mia",
                        "speaker_kind": "character",
                        "detected_identities": ["Mia_mia"],
                    }
                ],
            },
            "/api/v1/projects/project-1/characters": {
                "ok": True,
                "data": [{"name": "Mia", "identity_ids": ["Mia_mia"]}],
            },
            "/api/v1/projects/project-1/characters/Mia/identities": {
                "ok": True,
                "data": [
                    {
                        "identity_id": "Mia_mia",
                        "identity_name": "mia",
                        "appearance_details": "red coat",
                    }
                ],
            },
        }
        return httpx.Response(200, json=payloads[request.url.path])

    client = CEClient(
        "http://ce.test",
        token="agent-token",
        http_client=httpx.Client(transport=httpx.MockTransport(handler)),
    )

    prepared = client.fetch_beat_prompt("project-1", 2, 3)

    assert prepared["beat_key"] == "project-1:2:3"
    assert prepared["project"]["name"] == "Demo"
    assert prepared["episode"]["title"] == "Second"
    assert prepared["identities"]["Mia_mia"]["name"] == "Mia"
    assert prepared["identities"]["Mia_mia"]["appearance_details"] == "red coat"
    assert prepared["reference_ids"] == ["Mia_mia"]
    assert 'Dialogue (Mia): "Wait."' in prepared["prompt"]
    assert all(request.headers["Authorization"] == "Bearer agent-token" for request in requests)
