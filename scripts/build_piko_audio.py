#!/usr/bin/env python3
# SPDX-License-Identifier: Elastic-2.0
"""Extract short UI sounds and unapproved grass-step candidates; keep originals."""
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DESKTOP = ROOT.parent


def extract(source, target, start, duration):
    target.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run([
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-i", str(DESKTOP / source), "-vn", "-map", "0:a:0",
        "-af", f"atrim=start={start}:duration={duration},asetpts=PTS-STARTPTS,"
        f"afade=t=in:d=0.002,afade=t=out:st={duration - 0.012}:d=0.012",
        "-ac", "1", "-ar", "44100", "-c:a", "pcm_s16le", str(target),
    ], check=True)


if __name__ == "__main__":
    runtime = ROOT / "frontend/public/piko/world/audio"
    review = ROOT / "piko-world/art/review/audio-v1"
    extract("按钮点击.mp4", runtime / "ui-open-v1.wav", 0, 0.162)
    extract("dragon-studio-button-press-382713.mp3", runtime / "ui-close-v1.wav", 0, 0.29)
    for index, start in enumerate((0.99, 2.29, 4.32), 1):
        extract("freesound_community-footsteps-in-grass-and-picking-82739.mp3",
                review / f"grass-step-candidate-{index}.wav", start, 0.28)
        extract("freesound_community-footsteps-in-grass-and-picking-82739.mp3",
                runtime / f"grass-step-{index}-v1.wav", start, 0.28)
