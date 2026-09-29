"""Full-frame pixel gate: never resize, blur, mask, or silently align inputs.

Regions are diagnostic only. A passing crop cannot turn a failing page green.
Requires Pillow and numpy; captures stay in ignored local evidence directories.
"""

import argparse
import json
from pathlib import Path

import numpy as np
from PIL import Image


def metrics(reference: np.ndarray, actual: np.ndarray, channel_threshold: int = 16) -> dict:
    diff = np.abs(reference.astype(np.int16) - actual.astype(np.int16))
    changed = diff.max(axis=2) > channel_threshold
    ys, xs = np.where(changed)
    return {
        "pixels": int(changed.size), "changedPixels": int(changed.sum()),
        "changedRatio": float(changed.mean()), "meanAbsoluteError": float(diff.mean()),
        "maxChannelError": int(diff.max()),
        "changedBounds": [int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1] if len(xs) else None,
    }


def compare(reference: Path, actual: Path, output: Path, *, regions=(), threshold=16, allowed_ratio=.01) -> dict:
    if not 0 <= threshold <= 255 or not 0 <= allowed_ratio <= 1:
        raise ValueError("Invalid pixel thresholds")
    # Refuse overwriting evidence or reusing another run's comparison directory.
    if output.resolve() in (reference.resolve(), actual.resolve()):
        raise ValueError("Output must not replace a screenshot")
    with Image.open(reference) as a, Image.open(actual) as b:
        sizes = [a.size, b.size]
        left, right = np.array(a.convert("RGB")), np.array(b.convert("RGB"))
    report = {"reference": reference.name, "actual": actual.name, "sizes": sizes,
              "resized": False, "masked": False, "aligned": False,
              "channelThreshold": threshold, "allowedChangedRatio": allowed_ratio,
              "pass": False, "regions": {}}
    output.mkdir(parents=True, exist_ok=False)
    if sizes[0] != sizes[1]:
        report["reason"] = "DIMENSION_MISMATCH"
    else:
        full = metrics(left, right, threshold)
        report.update(full=full, **{"pass": full["changedRatio"] <= allowed_ratio})
        for name, x, y, width, height in regions:
            if min(x, y) < 0 or min(width, height) <= 0 or x + width > sizes[0][0] or y + height > sizes[0][1]:
                raise ValueError("Region exceeds screenshot")
            report["regions"][name] = metrics(left[y:y+height, x:x+width], right[y:y+height, x:x+width], threshold)
        diff = np.abs(left.astype(np.int16) - right.astype(np.int16)).astype(np.uint8)
        Image.fromarray(diff).save(output / "difference.png")
    (output / "report.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("reference", type=Path)
    parser.add_argument("actual", type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--region", action="append", default=[], help="name:x,y,width,height; diagnostic only")
    parser.add_argument("--channel-threshold", type=int, default=16)
    parser.add_argument("--allowed-ratio", type=float, default=.01)
    args = parser.parse_args()
    regions = []
    for raw in args.region:
        name, coordinates = raw.split(":", 1)
        regions.append((name, *map(int, coordinates.split(","))))
    report = compare(args.reference, args.actual, args.output, regions=regions,
                     threshold=args.channel_threshold, allowed_ratio=args.allowed_ratio)
    print(json.dumps(report, indent=2))
    raise SystemExit(0 if report["pass"] else 1)
