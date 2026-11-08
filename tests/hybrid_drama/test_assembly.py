import hashlib
import json
from pathlib import Path
import subprocess

import pytest

from novelvideo.hybrid_drama.media import inspect_media
from novelvideo.hybrid_drama.runner import assemble_episode, review_candidate


def _clip(path: Path, color: str) -> None:
    subprocess.run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            f"color=c={color}:s=720x1280:r=24:d=0.25",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:sample_rate=48000:duration=0.25",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-shortest",
            str(path),
        ],
        check=True,
        capture_output=True,
    )


def _evidence():
    return {
        "contact_sheet": "all chronological frames inspected",
        "motion_strip": "full motion strip inspected",
        "audio": "full audio inspected",
    }


def test_assembly_requires_adoption_for_every_candidate_and_runs_final_qc(tmp_path):
    candidates = tmp_path / "candidates"
    candidates.mkdir()
    first = candidates / "first.mp4"
    second = candidates / "second.mp4"
    _clip(first, "blue")
    _clip(second, "red")
    tasks = []
    for index, path in enumerate((first, second), 1):
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        tasks.append(
            {
                "beat_key": f"p:e:{index}",
                "beat_number": index,
                "request_sha256": f"request-{index}",
                "candidate": {"path": f"candidates/{path.name}", "sha256": digest},
            }
        )
    (tmp_path / "state.json").write_text(
        json.dumps({"version": 1, "tasks": tasks, "reviews": []})
    )
    review_candidate(tmp_path, first, decision="adopt", evidence=_evidence())

    output = tmp_path / "episode.mp4"
    with pytest.raises(ValueError, match="adopted"):
        assemble_episode(tmp_path, output)
    assert not output.exists()

    review_candidate(tmp_path, second, decision="adopt", evidence=_evidence())
    assembly = assemble_episode(tmp_path, output)

    assert output.is_file()
    assert assembly["candidate_sha256"] == [
        hashlib.sha256(first.read_bytes()).hexdigest(),
        hashlib.sha256(second.read_bytes()).hexdigest(),
    ]
    assert assembly["media_sha256"] == hashlib.sha256(output.read_bytes()).hexdigest()
    assert assembly["qc"]["full_decode"] is True
    probe = inspect_media(output, full_decode=True)
    video = next(stream for stream in probe["streams"] if stream["codec_type"] == "video")
    assert (video["width"], video["height"]) == (720, 1280)
    assert any(stream["codec_type"] == "audio" for stream in probe["streams"])
