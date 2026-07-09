import json
import struct
from pathlib import Path

import pytest


pytestmark = pytest.mark.m09


def _write_png(path: Path, *, width: int = 512, height: int = 768) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    header = b"\x89PNG\r\n\x1a\n"
    ihdr = b"IHDR" + struct.pack(">II", width, height) + b"\x08\x02\x00\x00\x00"
    path.write_bytes(header + struct.pack(">I", len(ihdr) - 4) + ihdr)


def test_drama_narration_panel_sends_audio_only_when_prompt_references_it(
    tmp_path, monkeypatch
):
    from novelvideo import project_config as pc
    from novelvideo.seedance2_i2v.panel_service import build_seedance2_video_panel_state

    monkeypatch.setattr(pc, "OUTPUT_DIR", tmp_path / "state")
    project_dir = tmp_path / "output" / "alice" / "project"
    frame = project_dir / "frames" / "ep001" / "beat_01.png"
    scene = project_dir / "assets" / "scenes" / "旧书店" / "master.png"
    narrator_audio = project_dir / "assets" / "narrator" / "voice.mp3"
    uploaded_audio = (
        project_dir / "seedance2_uploads" / "ep001" / "beat_01" / "audios" / "custom.wav"
    )
    for image_path in (frame, scene):
        _write_png(image_path)
    narrator_audio.parent.mkdir(parents=True, exist_ok=True)
    narrator_audio.write_bytes(b"project narrator")
    uploaded_audio.parent.mkdir(parents=True, exist_ok=True)
    uploaded_audio.write_bytes(b"user uploaded audio")
    pc.update_project_config_file(
        "alice",
        "project",
        lambda config: config.update({"spine_template": "drama"}),
    )
    pc.set_narrator_reference_audio(
        "alice",
        "project",
        relative_path="assets/narrator/voice.mp3",
        sha256="sha",
        updated_at="2026-05-29T00:00:00+00:00",
    )

    state = build_seedance2_video_panel_state(
        project_dir=project_dir,
        episode=1,
        beat={
            "beat_number": 1,
            "audio_type": "narration",
            "scene_ref": {"scene_id": "旧书店"},
            "narration_segment": "画外音响起。",
            "seedance2_config_json": json.dumps(
                {"reference_audio_paths": [str(uploaded_audio)]}
            ),
        },
    )

    selected_audio = [
        asset for asset in state.assets if asset.media_type == "audio" and asset.selected
    ]
    audio_assets = [asset for asset in state.assets if asset.media_type == "audio"]
    assert selected_audio == []
    assert [(asset.reference_label, asset.path) for asset in audio_assets] == [
        ("音频1", narrator_audio),
        ("音频2", uploaded_audio),
    ]

    state = build_seedance2_video_panel_state(
        project_dir=project_dir,
        episode=1,
        beat={
            "beat_number": 1,
            "audio_type": "narration",
            "scene_ref": {"scene_id": "旧书店"},
            "narration_segment": "画外音响起。",
            "seedance2_config_json": json.dumps(
                {
                    "final_prompt": "参考@音频2声线。",
                    "reference_audio_paths": [str(uploaded_audio)],
                }
            ),
        },
    )

    selected_audio = [
        asset for asset in state.assets if asset.media_type == "audio" and asset.selected
    ]
    assert [asset.path for asset in selected_audio] == [uploaded_audio]
    assert selected_audio[0].key.startswith("user_audio:")
