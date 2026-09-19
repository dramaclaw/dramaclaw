"""Optional DA3-Small inference worker. Run with ST_DA3_PYTHON, not the API process."""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import tempfile
from fractions import Fraction
from pathlib import Path


# 每档清晰度各自的帧数上限。
#
# 成本是「像素数 × 帧数」两项相乘，所以上限不该是一个跨档位的常数：
# 原本 750 帧一刀切，480P 明明能跑更长却被 720P 的成本曲线拖着一起限死
# （30fps 下两档都只有 25 秒）。分档之后 480P 放宽到 1500 帧（约 50 秒），
# 720P 维持 750，单帧成本高的那档仍然收紧。
#
# 参照 LibTV 的做法：它对 720P 单独设了更严的秒级上限，而不是全局一个数。
RESOLUTION_FRAME_LIMITS: dict[str, int] = {
    "480p": 1500,
    "720p": 750,
}
DEFAULT_RESOLUTION = "720p"


def frame_limit_for(resolution: str) -> int:
    return RESOLUTION_FRAME_LIMITS.get(str(resolution or "").lower(),
                                       RESOLUTION_FRAME_LIMITS[DEFAULT_RESOLUTION])


def _too_long_message(limit: int, resolution: str) -> str:
    """报错要给可行动的下一步，而不是只说「不支持」。"""
    other = "480p" if resolution == "720p" else "720p"
    hint = ""
    if RESOLUTION_FRAME_LIMITS.get(other, 0) > limit:
        hint = f"；换成 {other.upper()} 可支持到 {RESOLUTION_FRAME_LIMITS[other]} 帧"
    return f"{resolution.upper()} 最多支持 {limit} 帧，请先裁剪长视频{hint}"


def _scene_bounds(paths: list[Path], threshold: float = 0.34) -> list[tuple[int, int]]:
    """Detect hard cuts using thumbnail RGB differences; no temporal blending across cuts."""
    import numpy as np
    from PIL import Image

    starts = [0]
    previous = None
    for index, path in enumerate(paths):
        with Image.open(path) as image:
            thumb = np.asarray(image.convert("RGB").resize((64, 36)), dtype=np.float32)
        if previous is not None and np.mean(np.abs(thumb - previous)) / 255 >= threshold:
            starts.append(index)
        previous = thumb
    return list(zip(starts, starts[1:] + [len(paths)]))


def _stable_letterbox(paths: list[Path]) -> tuple[int, int]:
    """Find only consistently almost-black top/bottom rows; return crop margins."""
    import numpy as np
    from PIL import Image

    margins = []
    for path in (paths[0], paths[len(paths) // 2], paths[-1]):
        with Image.open(path) as image:
            pixels = np.asarray(image.convert("RGB"), dtype=np.uint8)
        black_rows = np.mean(np.all(pixels < 12, axis=2), axis=1) >= 0.98
        top = 0
        while top < len(black_rows) and black_rows[top]:
            top += 1
        bottom = 0
        while bottom < len(black_rows) - top and black_rows[-bottom - 1]:
            bottom += 1
        margins.append((top, bottom))
    top = min(item[0] for item in margins)
    bottom = min(item[1] for item in margins)
    if top + bottom > pixels.shape[0] // 2:
        return 0, 0
    return top, bottom


def _align_overlap(current, previous):
    """Affine-align one window's depth to the preceding window via shared pixels."""
    import numpy as np

    a = np.concatenate([item.ravel()[::64] for item in current])
    b = np.concatenate([item.ravel()[::64] for item in previous])
    a25, a75 = np.percentile(a, [25, 75])
    b25, b75 = np.percentile(b, [25, 75])
    scale = float(np.clip((b75 - b25) / max(a75 - a25, 1e-6), 0.25, 4))
    offset = float(np.median(b) - scale * np.median(a))
    return scale, offset


def _infer_frames(model, frame_paths: list[Path], *, chunk_size: int = 16, overlap: int = 3):
    """Produce per-frame z-depth; refit each short window within the same shot."""
    import numpy as np

    aligned: list = []
    for start, end in _scene_bounds(frame_paths):
        shot: list = []
        index = start
        while index < end:
            stop = min(index + chunk_size, end)
            prediction = model.inference(
                [str(path) for path in frame_paths[index:stop]],
                ref_view_strategy="middle",
                process_res=504,
                process_res_method="upper_bound_resize",
            )
            depth = np.asarray(prediction.depth, dtype=np.float32)
            if depth.shape[0] != stop - index:
                raise RuntimeError("DA3 返回的深度帧数与输入不一致")
            shared = min(len(shot), overlap) if index > start else 0
            if shared:
                scale, offset = _align_overlap(depth[:shared], shot[-shared:])
                depth = depth * scale + offset
                shot.extend(depth[shared:])
            else:
                shot.extend(depth)
            if stop == end:
                break
            index = stop - overlap
        aligned.append((start, end, shot))
    return aligned


def _write_gray_frames(
    shot_depths, frames_dir: Path, *, width: int, height: int,
    source_height: int, crop_top: int = 0, crop_bottom: int = 0,
):
    """Normalize within a shot; DA3 z-depth high=far → near white, far black."""
    import numpy as np
    from PIL import Image

    for start, end, depths in shot_depths:
        samples = np.concatenate([
            np.asarray(depth, dtype=np.float32).ravel()[::64]
            for depth in depths
        ])
        finite = samples[np.isfinite(samples)]
        if finite.size == 0:
            raise RuntimeError("DA3 未返回有效深度值")
        near, far = np.percentile(finite, [2, 98])
        span = max(float(far - near), 1e-6)
        output_top = round(height * crop_top / source_height)
        output_bottom = round(height * crop_bottom / source_height)
        for frame_index, depth in zip(range(start, end), depths):
            gray = (1 - np.clip((np.nan_to_num(depth, nan=far) - near) / span, 0, 1)) * 255
            image = Image.fromarray(gray.astype(np.uint8))
            content = image.resize((width, height - output_top - output_bottom),
                                   Image.Resampling.BILINEAR)
            canvas = Image.new("L", (width, height), 0)
            canvas.paste(content, (0, output_top))
            canvas.save(frames_dir / f"depth_{frame_index + 1:06d}.png")


def run(*, source: Path, output: Path, model_dir: Path, resolution: str) -> dict:
    if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
        raise RuntimeError("ffmpeg/ffprobe 未安装")
    try:
        import torch
        from depth_anything_3.api import DepthAnything3
    except ImportError as exc:
        raise RuntimeError("DA3 运行环境未安装 torch 和 depth_anything_3；请配置 ST_DA3_PYTHON") from exc

    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
         "stream=width,height,avg_frame_rate,r_frame_rate,nb_frames:format=duration",
         "-of", "json", str(source)],
        capture_output=True, text=True, check=True,
    )
    probe_data = json.loads(probe.stdout)
    stream = probe_data["streams"][0]
    fps = Fraction(stream["avg_frame_rate"])
    raw_fps = Fraction(stream["r_frame_rate"])
    if fps <= 0 or abs(float(fps - raw_fps)) / float(fps) > 0.01:
        raise RuntimeError("当前深度捕捉仅支持恒定帧率视频；可先转为 CFR 再提交")
    source_width, source_height = int(stream["width"]), int(stream["height"])
    if source_width <= 0 or source_height <= 0 or source_width > 3840 or source_height > 2160:
        raise RuntimeError("输入视频画幅超过一期支持范围（最大 3840×2160）")
    # 在抽帧**之前**就拦掉超长视频。原本这道限制只在抽完全部帧之后才生效，
    # 一段 10 分钟的视频会先白白抽出上万张 PNG、写满磁盘，然后才报错。
    limit = frame_limit_for(resolution)
    reported_frames = stream.get("nb_frames")
    duration = probe_data.get("format", {}).get("duration")
    if (reported_frames and reported_frames != "N/A" and int(reported_frames) > limit) or (
        duration and duration != "N/A" and float(duration) * float(fps) > limit + 1
    ):
        raise RuntimeError(_too_long_message(limit, resolution))
    target_height = 720 if resolution == "720p" else 480
    target_width = max(2, 2 * round(source_width * target_height / source_height / 2))
    # The official DA3 inference path uses CUDA autocast; CPU/MPS have not been
    # validated for this worker. Fail explicitly instead of producing bad output.
    if not torch.cuda.is_available():
        raise RuntimeError("DA3-Small 当前实现需要 NVIDIA CUDA GPU；CPU/MPS 尚未验证")
    device = "cuda"
    model = DepthAnything3.from_pretrained(str(model_dir)).to(device=device).eval()

    with tempfile.TemporaryDirectory(prefix="da3-motion-") as temp:
        temp_dir = Path(temp)
        rgb_dir = temp_dir / "rgb"
        gray_dir = temp_dir / "gray"
        rgb_dir.mkdir()
        gray_dir.mkdir()
        subprocess.run(
            ["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", str(source),
             "-map", "0:v:0", "-an", "-fps_mode", "passthrough",
             str(rgb_dir / "frame_%06d.png")],
            capture_output=True, text=True, check=True,
        )
        frames = sorted(rgb_dir.glob("frame_*.png"))
        if not frames:
            raise RuntimeError("抽帧后没有任何帧，视频可能没有视频轨")
        if len(frames) > limit:
            # probe 报的帧数可能不准（某些容器 nb_frames 是 N/A 或估算值），
            # 这里按真实帧数再兜一次。
            raise RuntimeError(_too_long_message(limit, resolution))
        crop_top, crop_bottom = _stable_letterbox(frames)
        inference_frames = frames
        if crop_top or crop_bottom:
            from PIL import Image

            cropped = temp_dir / "cropped"
            cropped.mkdir()
            inference_frames = []
            for path in frames:
                target = cropped / path.name
                with Image.open(path) as image:
                    image.crop((0, crop_top, image.width,
                                image.height - crop_bottom)).save(target)
                inference_frames.append(target)
        shots = _infer_frames(model, inference_frames)
        _write_gray_frames(shots, gray_dir, width=target_width,
                           height=target_height, source_height=source_height,
                           crop_top=crop_top, crop_bottom=crop_bottom)
        output.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(
            ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-framerate",
             f"{fps.numerator}/{fps.denominator}", "-i", str(gray_dir / "depth_%06d.png"),
             "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18",
             "-movflags", "+faststart", str(output)],
            capture_output=True, text=True, check=True,
        )
        meta = {
            "schema": "depth_motion.v1", "model": "DA3-SMALL", "depth_type": "relative_z",
            "polarity": "near_white_far_black", "resolution": resolution,
            "width": target_width, "height": target_height,
            "fps": f"{fps.numerator}/{fps.denominator}", "frame_count": len(frames),
            "shot_ranges": [[start, end] for start, end, _ in shots],
            "letterbox_crop_px": {"top": crop_top, "bottom": crop_bottom},
            "audio": False, "device": device, "frame_limit": limit,
        }
        output.with_suffix(".json").write_text(
            json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        return meta


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--model-dir", type=Path, required=True)
    parser.add_argument("--resolution", choices=("480p", "720p"), required=True)
    args = parser.parse_args()
    run(source=args.source, output=args.output, model_dir=args.model_dir,
        resolution=args.resolution)


if __name__ == "__main__":
    main()
