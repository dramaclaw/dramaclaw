import json

from novelvideo.hybrid_drama.cli import main


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
