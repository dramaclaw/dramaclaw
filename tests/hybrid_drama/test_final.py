import hashlib
import json
import subprocess

import pytest

from novelvideo.hybrid_drama.runner import finalize_delivery


def _make_final(path):
    subprocess.run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "color=c=black:s=720x1280:r=24:d=0.25",
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


def _review():
    return {
        "passed": True,
        "audible_defects": [],
        "visual": {
            "event_order": "event order matches adopted beats",
            "identity_continuity": "identity and appearance remain continuous",
            "motion": "motion and anatomy inspected",
            "joins": "all joins inspected",
            "overlays": "all overlays inspected",
        },
        "dialogue_present": True,
    }


def test_final_delivery_requires_complete_dialogue_and_av_review(tmp_path):
    output = tmp_path / "final.mp4"
    _make_final(output)
    digest = hashlib.sha256(output.read_bytes()).hexdigest()
    assembly_path = f"assemblies/{digest}.json"
    (tmp_path / "assemblies").mkdir()
    (tmp_path / assembly_path).write_text(
        json.dumps({"media_sha256": digest, "output_path": str(output)})
    )
    (tmp_path / "state.json").write_text(
        json.dumps(
            {
                "version": 1,
                "tasks": [{"beat_key": "p:e:1", "has_dialogue": True}],
                "reviews": [],
                "assemblies": [{"path": assembly_path, "media_sha256": digest}],
            }
        )
    )
    review = _review()

    with pytest.raises(ValueError, match="voice"):
        finalize_delivery(tmp_path, output, review)
    assert not (tmp_path / "delivery.json").exists()

    review["voices"] = {
        "exact_words": {"passed": True, "evidence": "every spoken word checked against script"},
        "speaker": {"passed": True, "evidence": "speaker ownership checked"},
        "timing": {"passed": True, "evidence": "dialogue timing checked"},
        "voice_consistency": {"passed": True, "evidence": "voice consistency checked"},
        "lip_sync": {"passed": True, "evidence": "lip-sync checked"},
    }
    delivery = finalize_delivery(tmp_path, output, review)

    assert delivery["status"] == "complete"
    assert delivery["media_sha256"] == digest
    assert delivery["qc"]["full_decode"] is True
    final_review = json.loads((tmp_path / delivery["review_path"]).read_text())
    assert final_review["review"]["audible_defects"] == []
    assert final_review["review"]["voices"]["lip_sync"]["passed"] is True
