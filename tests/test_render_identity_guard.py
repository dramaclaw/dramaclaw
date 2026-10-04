import pytest

from novelvideo.generators.nanobanana_grid import (
    NanoBananaGridGenerator,
    filter_character_map_by_precomputed,
)
from novelvideo.generators.render_identity_guard import render_ai_detection_error
from novelvideo.models import NO_CHARACTER_MARKER


pytestmark = pytest.mark.m09


def test_render_guard_blocks_beats_without_identity_detection_or_manual_mark():
    beats = [
        {"beat_number": 1, "detected_identities": []},
        {"beat_number": 2},
        {"beat_number": 3, "detected_identities": [""]},
    ]

    error = render_ai_detection_error(beats)

    assert error is not None
    assert "AI 检测" in error
    assert "手工标注" in error
    assert "无角色出场" in error
    assert "#1, #2, #3" in error


def test_render_guard_allows_explicit_no_character_marker():
    beats = [
        {"beat_number": 1, "detected_identities": [NO_CHARACTER_MARKER]},
        {"beat_number": 2, "detected_identities": ["沈知薇_嫡女时期"]},
    ]

    assert render_ai_detection_error(beats) is None


def test_render_guard_standalone_message_points_to_canvas_node_not_mainline_beat():
    error = render_ai_detection_error(
        [{"beat_number": 0, "detected_identities": []}],
        standalone_beat_context=True,
    )

    assert error is not None
    assert "镜头上下文" in error
    assert "无角色出场" in error
    assert "AI 检测" not in error
    assert "#0" not in error


def test_render_guard_standalone_allows_no_character_marker():
    assert (
        render_ai_detection_error(
            [{"beat_number": 0, "detected_identities": [NO_CHARACTER_MARKER]}],
            standalone_beat_context=True,
        )
        is None
    )


def test_render_filter_drops_character_map_when_no_identity_detected():
    character_map = {
        "沈知薇": {"reference_mode": "portrait_only", "reference_path": "/tmp/portrait.png"}
    }

    filtered = filter_character_map_by_precomputed(character_map, {0: None, 1: None})

    assert filtered == {}


def test_render_guard_blocks_partial_unmarked_empty_beats():
    beats = [
        {"beat_number": 1, "detected_identities": [NO_CHARACTER_MARKER]},
        {"beat_number": 2, "detected_identities": ["沈知薇_嫡女时期"]},
        {"beat_number": 3, "detected_identities": []},
    ]

    assert "#3" in (render_ai_detection_error(beats) or "")


def _test_grid_generator() -> NanoBananaGridGenerator:
    return NanoBananaGridGenerator(
        api_key="test-key",
        config={
            "provider": "openai",
            "api_key": "test-key",
            "model": "gpt-image-1",
            "rows": 1,
            "cols": 1,
            "batch_size": 1,
            "total_panels": 1,
            "mode": "1x1",
            "image_size": "1K",
        },
    )


@pytest.mark.asyncio
async def test_generate_grid_render_without_detection_is_blocked(tmp_path):
    generator = _test_grid_generator()

    result = await generator.generate_grid(
        beats=[{"beat_number": 1, "visual_description": "{{沈知薇}}"}],
        character_map={"沈知薇": {"reference_mode": "prompt_only"}},
        style="chinese_period_drama",
        output_path=str(tmp_path / "grid.png"),
        rows=1,
        cols=1,
        sketch=False,
        sketch_dir=str(tmp_path / "sketches"),
    )

    assert result.success is False
    assert "AI 检测" in result.error
    assert "无角色出场" in result.error
    assert "Render reference order missing" not in result.error


@pytest.mark.asyncio
async def test_prepare_batch_request_render_without_detection_is_blocked(tmp_path):
    generator = _test_grid_generator()

    with pytest.raises(RuntimeError, match="AI 检测") as exc_info:
        await generator.prepare_batch_request(
            beats=[{"beat_number": 1, "visual_description": "{{沈知薇}}"}],
            character_map={"沈知薇": {"reference_mode": "prompt_only"}},
            style="chinese_period_drama",
            output_path=str(tmp_path / "grid.png"),
            rows=1,
            cols=1,
            sketch=False,
            sketch_dir=str(tmp_path / "sketches"),
        )

    assert "无角色出场" in str(exc_info.value)


@pytest.mark.asyncio
async def test_generate_grid_render_with_no_character_marker_reaches_sketch_prereq(tmp_path):
    generator = _test_grid_generator()

    result = await generator.generate_grid(
        beats=[
            {
                "beat_number": 1,
                "visual_description": "空镜",
                "detected_identities": [NO_CHARACTER_MARKER],
            }
        ],
        character_map={},
        style="chinese_period_drama",
        output_path=str(tmp_path / "grid.png"),
        rows=1,
        cols=1,
        sketch=False,
        sketch_dir=str(tmp_path / "sketches"),
    )

    assert result.success is False
    assert "Render 模式需要草图" in result.error
    assert "AI 检测" not in result.error
