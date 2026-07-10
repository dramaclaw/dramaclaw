"""草图颜色交叉验证。"""

import logging
from pathlib import Path

from novelvideo.generators.sketch_color_detector import detect_sketch_colors
from novelvideo.models import extract_char_identities_from_markers

from .models import ColorMismatch, ColorVerifyBeatResult, ColorVerifyResult
from .utils import find_sketch_for_beat

logger = logging.getLogger(__name__)


def _parse_color_entry(color_str: str) -> tuple[str, str]:
    parts = color_str.split(" ", 1)
    hex_code = parts[0]
    color_name = parts[1] if len(parts) > 1 else ""
    return hex_code, color_name


def verify_episode_sketch_colors(
    project_dir: Path,
    episode_num: int,
    beats: list[dict],
    sketch_colors: dict[str, str],
    missing_threshold: float = 0.008,
    extra_threshold: float = 0.015,
) -> ColorVerifyResult:
    """对整集所有 beat 执行颜色交叉验证。"""
    beat_results: list[ColorVerifyBeatResult] = []
    passed_count = 0
    failed_count = 0
    warned_count = 0
    failed_beat_numbers: list[int] = []

    for idx, beat in enumerate(beats):
        beat_num = beat.get("beat_number") or (idx + 1)
        visual_desc = beat.get("visual_description", "") or ""

        try:
            char_identities = extract_char_identities_from_markers(visual_desc, strict=False)
        except Exception:
            char_identities = {}

        expected_ids = set(char_identities.values())
        if not expected_ids:
            beat_results.append(
                ColorVerifyBeatResult(
                    beat_number=beat_num,
                    status="pass",
                    expected=[],
                    detected=[],
                    missing=[],
                    extra=[],
                )
            )
            passed_count += 1
            continue

        expected_color_map = {
            identity_id: sketch_colors[identity_id]
            for identity_id in expected_ids
            if identity_id in sketch_colors
        }
        if not expected_color_map:
            beat_results.append(
                ColorVerifyBeatResult(
                    beat_number=beat_num,
                    status="pass",
                    expected=sorted(expected_ids),
                    detected=[],
                    missing=[],
                    extra=[],
                )
            )
            passed_count += 1
            continue

        sketch_path = find_sketch_for_beat(project_dir, episode_num, beat_num)
        if not sketch_path:
            logger.warning("Beat %d: no sketch found, skipping color verify", beat_num)
            beat_results.append(
                ColorVerifyBeatResult(
                    beat_number=beat_num,
                    status="pass",
                    expected=sorted(expected_ids),
                    detected=[],
                    missing=[],
                    extra=[],
                )
            )
            passed_count += 1
            continue

        detected_expected = detect_sketch_colors(
            str(sketch_path), expected_color_map, threshold=missing_threshold
        )
        non_expected_color_map = {
            identity_id: color
            for identity_id, color in sketch_colors.items()
            if identity_id not in expected_ids
        }
        detected_extra = (
            detect_sketch_colors(str(sketch_path), non_expected_color_map, threshold=extra_threshold)
            if non_expected_color_map
            else set()
        )

        missing_ids = expected_ids - detected_expected
        all_detected_ids = detected_expected | detected_extra

        missing_items: list[ColorMismatch] = []
        for identity_id in sorted(missing_ids):
            if identity_id in sketch_colors:
                hex_code, color_name = _parse_color_entry(sketch_colors[identity_id])
                missing_items.append(
                    ColorMismatch(
                        identity_id=identity_id,
                        color_hex=hex_code,
                        color_name=color_name,
                        issue_type="missing",
                    )
                )

        extra_items: list[ColorMismatch] = []
        for identity_id in sorted(detected_extra):
            hex_code, color_name = _parse_color_entry(sketch_colors[identity_id])
            extra_items.append(
                ColorMismatch(
                    identity_id=identity_id,
                    color_hex=hex_code,
                    color_name=color_name,
                    issue_type="extra",
                )
            )

        if missing_items:
            status = "fail"
            failed_count += 1
            failed_beat_numbers.append(beat_num)
        elif extra_items:
            status = "warn"
            warned_count += 1
        else:
            status = "pass"
            passed_count += 1

        beat_results.append(
            ColorVerifyBeatResult(
                beat_number=beat_num,
                status=status,
                expected=sorted(expected_ids),
                detected=sorted(all_detected_ids),
                missing=missing_items,
                extra=extra_items,
                sketch_path=sketch_path.relative_to(project_dir).as_posix(),
            )
        )

    return ColorVerifyResult(
        total_beats=len(beats),
        passed_beats=passed_count,
        failed_beats=failed_count,
        warned_beats=warned_count,
        failed_beat_numbers=failed_beat_numbers,
        beat_results=beat_results,
        overall_passed=(failed_count == 0),
    )
