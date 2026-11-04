#!/usr/bin/env python3
# SPDX-License-Identifier: Elastic-2.0
"""Pack new high-resolution seated poses at the existing logical seat geometry."""
import argparse
import json

from PIL import Image

from build_piko_player_three_frame_motion import ART, REGENERATED, extract_row, head_width, opaque


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    outputs = {}
    measurements = {}
    for gender in ("male", "female"):
        poses = extract_row(Image.open(REGENERATED / f"{gender}-sit.png"), 2)
        widths = [head_width(pose) for pose in poses]
        if max(widths) / min(widths) > 1.04:
            raise ValueError(f"{gender}: inconsistent seated head widths: {widths}")
        scale = 200 / max(pose.height for pose in poses)
        measurements[gender] = {"sourceHeadWidths": widths, "scale": scale}
        for name, pose in zip(("front", "idle"), poses):
            resized = pose.resize((round(pose.width * scale), round(pose.height * scale)), Image.Resampling.LANCZOS)
            if resized.width > 256:
                raise ValueError("Seated figure would be clipped")
            frame = Image.new("RGBA", (256, 256))
            frame.alpha_composite(resized, (round((256 - resized.width) / 2), 216 - resized.height))
            outputs[f"player-{gender}-sit-{name}-v2.png"] = frame
            if opaque(frame).getbbox() is None:
                raise ValueError("Empty seated frame")
    manifest = {
        "frameSize": 256, "logicalFrameSize": 64, "pivot": [128, 128],
        "footY": 216, "measurements": measurements, "outputs": list(outputs),
    }
    manifest_path = REGENERATED / "seated-manifest.json"
    for filename, frame in outputs.items():
        if args.check:
            with Image.open(ART / filename) as saved:
                if saved.mode != frame.mode or saved.size != frame.size or saved.tobytes() != frame.tobytes():
                    raise SystemExit(f"Stale seated frame: {filename}")
        else:
            frame.save(ART / filename)
    if args.check:
        if json.loads(manifest_path.read_text()) != manifest:
            raise SystemExit("Stale seated manifest")
    else:
        manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    print("Verified" if args.check else "Built", "four high-resolution seated frames")


if __name__ == "__main__":
    main()
