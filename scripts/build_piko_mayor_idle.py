#!/usr/bin/env python3
# SPDX-License-Identifier: Elastic-2.0
"""Deterministic pixel production from the user-approved mayor master.

Run with .venv/bin/python scripts/build_piko_mayor_idle.py.
Only writes versioned review artifacts; never changes the runtime character.
"""
from pathlib import Path
import hashlib
import json

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "piko-world/art/review/mayor-idle-v1"
SOURCE = OUTPUT / "approved-reference.png"
PALETTE_HEX = (
    "11152e", "17183d", "263653", "354664", "53627b",
    "fffdf5", "f6f3ea", "e8d5ad", "c6b995",
    "236b35", "438f35", "6fb943", "91d154",
    "6b3528", "8d492c", "b06b37", "d39855",
    "9c6c24", "d69c29", "f5c340", "ffe289",
)
PALETTE = [tuple(bytes.fromhex(value)) for value in PALETTE_HEX]


def make_master() -> Image.Image:
    """Normalize the selected silhouette, remove edge alpha, lock shared palette."""
    original = Image.open(SOURCE).convert("RGBA")
    bounds = original.getchannel("A").point(lambda a: 255 if a >= 128 else 0).getbbox()
    if bounds is None:
        raise ValueError("Source is empty")
    crop = original.crop(bounds)
    width = round(crop.width * 48 / crop.height)
    reduced = crop.resize((width, 48), Image.Resampling.NEAREST)
    master = Image.new("RGBA", (64, 64))
    offset_x = 32 - width // 2
    for y in range(48):
        for x in range(width):
            r, g, b, a = reduced.getpixel((x, y))
            if a < 128:
                continue
            color = min(PALETTE, key=lambda c: sum((v - w) ** 2 for v, w in zip(c, (r, g, b))))
            master.putpixel((offset_x + x, 10 + y), (*color, 255))
    # Repair pale edge samples from the enlarged generated reference.
    original_pixels = master.copy()
    for y in range(1, 63):
        for x in range(1, 63):
            if original_pixels.getpixel((x, y))[3] and any(
                original_pixels.getpixel((x + dx, y + dy))[3] == 0
                for dx, dy in ((0, -1), (0, 1), (-1, 0), (1, 0))
            ):
                master.putpixel((x, y), (*PALETTE[0], 255))
    draw = ImageDraw.Draw(master)
    # Equal-width eyes and identical one-pixel highlights remain readable at 1x.
    for x in (26, 35):
        draw.rectangle((x, 28, x + 3, 36), fill=(*PALETTE[6], 255))
        draw.rectangle((x, 29, x + 3, 35), fill=(*PALETTE[1], 255))
        draw.point((x + 1, 30), fill=(*PALETTE[5], 255))
    return master


def is_leaf(x: int, y: int) -> bool:
    return (x >= 40 and 11 <= y <= 19) or (x >= 38 and 12 <= y <= 14)


def pose(master: Image.Image, rise: int = 0, leaf_rise: int = 0,
         leaf_tip: int = 0, eye: str = "open") -> Image.Image:
    """Integer pixel cut-and-place only; the coat hem and feet never move."""
    painted = master.copy()
    if eye != "open":
        draw = ImageDraw.Draw(painted)
        for x in (26, 35):
            draw.rectangle((x, 29, x + 3, 35), fill=(*PALETTE[6], 255))
            if eye == "half":
                draw.rectangle((x, 32, x + 3, 35), fill=(*PALETTE[1], 255))
                draw.point((x + 1, 32), fill=(*PALETTE[5], 255))
            else:
                draw.line((x, 34, x + 3, 34), fill=(*PALETTE[1], 255))
    result = Image.new("RGBA", (64, 64))
    for y in range(64):
        for x in range(64):
            pixel = painted.getpixel((x, y))
            if not pixel[3] or is_leaf(x, y):
                continue
            target_y = y - rise if y < 53 else y
            result.putpixel((x, target_y), pixel)
    # Fill the single coat seam exposed by raising the upper body.
    if rise:
        for x in range(64):
            pixel = painted.getpixel((x, 52))
            if pixel[3]:
                result.putpixel((x, 52), pixel)
    for y in range(20):
        for x in range(38, 64):
            pixel = painted.getpixel((x, y))
            if pixel[3] and is_leaf(x, y):
                # The root follows the head; the free tip responds one frame later.
                delta = rise if x < 42 else leaf_rise
                if x >= 44:
                    delta -= leaf_tip
                result.putpixel((x, y - delta), pixel)
    return result


FRAME_SPECS = [
    ("rest", {}),
    ("inhale-leaf-lag", {"rise": 1}),
    ("inhale", {"rise": 1, "leaf_rise": 1}),
    ("inhale-leaf-settle", {"rise": 1, "leaf_rise": 1, "leaf_tip": 1}),
    ("exhale-leaf-lag", {"leaf_rise": 1}),
    ("blink-half", {"eye": "half"}),
    ("blink-closed", {"eye": "closed"}),
]
# Long relaxed holds, short blinks; a complete cycle starts and ends on rest.
TIMELINE = [(0, 900), (1, 180), (2, 360), (3, 180), (4, 180), (0, 850),
            (5, 80), (6, 100), (5, 80), (0, 950), (1, 180), (2, 360),
            (3, 180), (4, 180), (0, 520)]


def split_layers(frame: Image.Image, spec: dict) -> dict[str, Image.Image]:
    """Export aligned semantic layers, including all shifted leaf pixels."""
    layers = {name: Image.new("RGBA", frame.size) for name in ("body", "outfit", "prop", "leaf")}
    for y in range(64):
        for x in range(64):
            rgba = frame.getpixel((x, y))
            if not rgba[3]:
                continue
            if x >= 38 and y < 20 and (rgba[:3] in PALETTE[9:13] or x >= 40):
                name = "leaf"
            elif x <= 23 and y >= 37 - spec.get("rise", 0) and y <= 52:
                name = "prop"
            elif y < 36 - spec.get("rise", 0) or y >= 56 or rgba[:3] in PALETTE[5:9]:
                name = "body"
            else:
                name = "outfit"
            layers[name].putpixel((x, y), rgba)
    return layers


def validate_frames(master: Image.Image, frames: list[Image.Image]) -> dict:
    for frame in frames:
        assert frame.size == (64, 64)
        assert set(frame.getchannel("A").tobytes()) <= {0, 255}
        assert frame.getchannel("A").getbbox()[3] == 58
        assert frame.crop((0, 53, 64, 64)).tobytes() == master.crop((0, 53, 64, 64)).tobytes()
        assert {frame.getpixel((x, y))[:3] for y in range(64) for x in range(64)
                if frame.getpixel((x, y))[3]} <= set(PALETTE)
    assert len({frame.tobytes() for frame in frames}) == len(frames)
    return {"frameCount": len(frames), "size": [64, 64], "binaryAlpha": True,
            "paletteLimit": len(PALETTE), "fixedFootBaseline": 57,
            "unchangedHemAndFeet": True, "cycleDurationMs": sum(ms for _, ms in TIMELINE)}


def main() -> None:
    OUTPUT.mkdir(parents=True, exist_ok=True)
    master = make_master()
    master.save(OUTPUT / "mayor-south-master-64.png")
    master.resize((512, 512), Image.Resampling.NEAREST).save(OUTPUT / "master-preview-8x.png")
    frames = [pose(master, **spec) for _, spec in FRAME_SPECS]
    report = validate_frames(master, frames)
    sheet = Image.new("RGBA", (64 * len(frames), 64))
    layer_sheets = {name: Image.new("RGBA", sheet.size) for name in ("body", "outfit", "prop", "leaf")}
    for index, (frame, (_, spec)) in enumerate(zip(frames, FRAME_SPECS)):
        frame.save(OUTPUT / f"frame-{index:02}.png")
        sheet.paste(frame, (index * 64, 0))
        layers = split_layers(frame, spec)
        recomposed = Image.new("RGBA", (64, 64))
        for name, layer in layers.items():
            layer_sheets[name].paste(layer, (index * 64, 0))
            recomposed.alpha_composite(layer)
        assert recomposed.tobytes() == frame.tobytes()
    sheet.save(OUTPUT / "mayor-idle-sheet.png")
    sheet.resize((sheet.width * 4, 256), Image.Resampling.NEAREST).save(OUTPUT / "frames-preview-4x.png")
    for name, layer in layer_sheets.items():
        layer.save(OUTPUT / f"mayor-idle-{name}-sheet.png")
    # Opaque neutral preview background avoids GIF transparency/disposal artifacts.
    preview_frames = []
    for frame_index, _ in TIMELINE:
        bg = Image.new("RGBA", (64, 64), (48, 58, 53, 255))
        bg.alpha_composite(frames[frame_index])
        preview_frames.append(bg.convert("RGB").resize((384, 384), Image.Resampling.NEAREST))
    preview_frames[0].save(OUTPUT / "idle-preview-6x.gif", save_all=True,
                           append_images=preview_frames[1:], duration=[ms for _, ms in TIMELINE],
                           loop=0, disposal=2, optimize=False)
    metadata = {
        "status": "review-only", "image": "mayor-idle-sheet.png", "direction": "SOUTH",
        "sourceSha256": hashlib.sha256(SOURCE.read_bytes()).hexdigest(),
        "frameSize": {"w": 64, "h": 64}, "pivot": {"x": 32, "y": 57},
        "palette": list(PALETTE_HEX),
        "frames": [{"name": name, "rect": {"x": i * 64, "y": 0, "w": 64, "h": 64},
                    "leafAttachment": {"x": 39, "y": 13 - spec.get("rise", 0)}}
                   for i, (name, spec) in enumerate(FRAME_SPECS)],
        "timeline": [{"frame": i, "durationMs": ms} for i, ms in TIMELINE],
        "validation": report,
    }
    (OUTPUT / "mayor-idle.json").write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + "\n")
    # External classic script allows the local review HTML to work without a server.
    (OUTPUT / "preview-data.js").write_text("window.mayorIdle = " + json.dumps(metadata) + ";\n")
    print(json.dumps(report))
    print(f"Review artifacts saved to {OUTPUT}")


if __name__ == "__main__":
    main()
