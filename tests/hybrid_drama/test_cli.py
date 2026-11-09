import json

from novelvideo.hybrid_drama.cli import _api_key, main


def test_cli_builds_a_prepared_ce_beat(tmp_path):
    ce = {
        "project": {"id": "p"},
        "episode": {"id": "e", "number": 1},
        "beats": [
            {
                "beat_number": 1,
                "visual_description": "{{Mia_mia_default}} enters.",
                "narration_segment": "Wait.",
                "speaker": "Mia_mia",
                "speaker_kind": "character",
                "detected_identities": ["Mia_mia"],
            }
        ],
        "identities": {"Mia_mia": {"name": "Mia"}},
    }
    source = tmp_path / "ce.json"
    output = tmp_path / "prepared.json"
    source.write_text(json.dumps(ce))

    assert main(["build-prompt", "--ce", str(source), "--beat-number", "1", "--out", str(output)]) == 0

    prepared = json.loads(output.read_text())
    assert prepared["beat_key"] == "p:e:1"
    assert prepared["reference_ids"] == ["Mia_mia"]
    assert 'Dialogue (Mia): "Wait."' in prepared["prompt"]


def test_api_key_strips_dotenv_whitespace_and_quotes(monkeypatch):
    monkeypatch.setenv("BYTEPLUS_MODEL_ARK_API_KEY", '  "secret-value  "  ')

    assert _api_key() == "secret-value"


def test_cli_builds_a_prompt_directly_from_ce_api(monkeypatch, tmp_path):
    import novelvideo.hybrid_drama.cli as cli

    calls = []

    class Client:
        def __init__(self, base_url, *, token):
            calls.append((base_url, token))

        def fetch_beat_prompt(self, project, episode, beat):
            calls.append((project, episode, beat))
            return {
                "beat_key": "p:2:3",
                "beat_number": 3,
                "project": {"id": "p"},
                "episode": {"id": 2},
                "beat": {"beat_number": 3},
                "prompt": "Fetched from CE",
                "reference_ids": [],
                "has_dialogue": False,
            }

    monkeypatch.setattr(cli, "CEClient", Client)
    monkeypatch.setenv("DRAMACLAW_AGENT_TOKEN", "agent-token")
    output = tmp_path / "prepared.json"

    assert main(
        [
            "build-prompt",
            "--ce-base-url",
            "http://ce.test",
            "--project",
            "p",
            "--episode",
            "2",
            "--beat-number",
            "3",
            "--out",
            str(output),
        ]
    ) == 0

    assert calls == [("http://ce.test", "agent-token"), ("p", 2, 3)]
    assert json.loads(output.read_text())["prompt"] == "Fetched from CE"
