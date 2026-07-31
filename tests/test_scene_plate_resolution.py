from novelvideo.models import NovelScene, resolve_scene_plate, resolve_scene_plate_from_records
from novelvideo.utils.screenplay_scene_parser import parse_scene_blocks


def test_resolve_scene_plate_prefers_variant_time_plate() -> None:
    record_name, time_baked = resolve_scene_plate(
        "卫生间",
        "漏水",
        "夜",
        {"卫生间", "卫生间_漏水", "卫生间_漏水_夜"},
    )

    assert record_name == "卫生间_漏水_夜"
    assert time_baked is True


def test_missing_scene_time_keeps_legacy_day_plate_resolution() -> None:
    block = parse_scene_blocks("1-1 咖啡馆 内\n张三：你好。")[0]

    assert block.time_of_day == "日"
    assert block.time_inferred is True

    record_name, time_baked = resolve_scene_plate(
        block.location,
        "",
        block.time_of_day,
        {"咖啡馆", "咖啡馆_日"},
    )

    assert record_name == "咖啡馆_日"
    assert time_baked is True


def test_resolve_scene_plate_keeps_variant_before_base_time() -> None:
    record_name, time_baked = resolve_scene_plate(
        "卫生间",
        "漏水",
        "夜",
        {"卫生间", "卫生间_夜", "卫生间_漏水"},
    )

    assert record_name == "卫生间_漏水"
    assert time_baked is False


def test_resolve_scene_plate_uses_base_time_without_variant() -> None:
    record_name, time_baked = resolve_scene_plate(
        "卫生间",
        "",
        "夜晚",
        {"卫生间", "卫生间_夜"},
    )

    assert record_name == "卫生间_夜"
    assert time_baked is True


def test_resolve_scene_plate_marks_time_variant_as_time_baked() -> None:
    record_name, time_baked = resolve_scene_plate(
        "卫生间",
        "夜",
        "夜晚",
        {"卫生间", "卫生间_夜"},
    )

    assert record_name == "卫生间_夜"
    assert time_baked is True


def test_resolve_scene_plate_marks_variant_tail_time_as_time_baked() -> None:
    record_name, time_baked = resolve_scene_plate(
        "卫生间",
        "漏水_夜",
        "夜晚",
        {"卫生间", "卫生间_漏水_夜"},
    )

    assert record_name == "卫生间_漏水_夜"
    assert time_baked is True


def test_resolve_scene_plate_beat_time_picks_matching_time_plate() -> None:
    record_name, time_baked = resolve_scene_plate(
        "卫生间",
        "漏水",
        "白天",
        {"卫生间", "卫生间_漏水", "卫生间_漏水_夜晚", "卫生间_漏水_白天"},
    )

    assert record_name == "卫生间_漏水_白天"
    assert time_baked is True


def test_resolve_scene_plate_skips_wrong_time_plate_when_beat_time_differs() -> None:
    record_name, time_baked = resolve_scene_plate(
        "卫生间",
        "漏水",
        "白天",
        {"卫生间", "卫生间_漏水", "卫生间_漏水_夜晚"},
    )

    assert record_name == "卫生间_漏水"
    assert time_baked is False


def test_resolve_scene_plate_ignores_legacy_time_suffix_when_beat_time_empty() -> None:
    record_name, time_baked = resolve_scene_plate(
        "卫生间",
        "漏水_夜晚",
        "",
        {"卫生间", "卫生间_漏水", "卫生间_漏水_夜晚"},
    )

    assert record_name == "卫生间_漏水"
    assert time_baked is False


def test_resolve_scene_plate_skips_legacy_time_suffix_when_beat_time_differs() -> None:
    record_name, time_baked = resolve_scene_plate(
        "卫生间",
        "漏水_夜晚",
        "白天",
        {"卫生间", "卫生间_漏水", "卫生间_漏水_夜晚"},
    )

    assert record_name == "卫生间_漏水"
    assert time_baked is False


def test_resolve_scene_plate_from_records_uses_structured_time_plate() -> None:
    record_name, time_baked = resolve_scene_plate_from_records(
        "卫生间",
        "漏水",
        "白天",
        [
            NovelScene(name="卫生间"),
            NovelScene(name="卫生间_漏水", base_scene_id="卫生间", variant_id="漏水"),
            NovelScene(
                name="卫生间_漏水_白天",
                base_scene_id="卫生间",
                variant_id="漏水",
                time_of_day="白天",
            ),
        ],
    )

    assert record_name == "卫生间_漏水_白天"
    assert time_baked is True


def test_resolve_scene_plate_from_records_normalizes_time_alias_before_lookup() -> None:
    record_name, time_baked = resolve_scene_plate_from_records(
        "卫生间",
        "漏水",
        "凌晨",
        [
            NovelScene(name="卫生间"),
            NovelScene(name="卫生间_漏水", base_scene_id="卫生间", variant_id="漏水"),
            NovelScene(
                name="卫生间_漏水_夜晚",
                base_scene_id="卫生间",
                variant_id="漏水",
                time_of_day="夜晚",
            ),
        ],
    )

    assert record_name == "卫生间_漏水_夜晚"
    assert time_baked is True


def test_resolve_scene_plate_from_records_skips_wrong_time_plate() -> None:
    record_name, time_baked = resolve_scene_plate_from_records(
        "卫生间",
        "漏水",
        "白天",
        [
            NovelScene(name="卫生间"),
            NovelScene(name="卫生间_漏水", base_scene_id="卫生间", variant_id="漏水"),
            NovelScene(
                name="卫生间_漏水_夜晚",
                base_scene_id="卫生间",
                variant_id="漏水",
                time_of_day="夜晚",
            ),
        ],
    )

    assert record_name == "卫生间_漏水"
    assert time_baked is False


def test_resolve_scene_plate_from_records_empty_beat_time_does_not_select_time_plate() -> None:
    record_name, time_baked = resolve_scene_plate_from_records(
        "卫生间",
        "漏水",
        "",
        [
            NovelScene(name="卫生间"),
            NovelScene(name="卫生间_漏水", base_scene_id="卫生间", variant_id="漏水"),
            NovelScene(
                name="卫生间_漏水_夜晚",
                base_scene_id="卫生间",
                variant_id="漏水",
                time_of_day="夜晚",
            ),
        ],
    )

    assert record_name == "卫生间_漏水"
    assert time_baked is False


def test_resolve_scene_plate_empty_time_matches_existing_scene_resolution() -> None:
    record_name, time_baked = resolve_scene_plate(
        "卫生间",
        "漏水",
        "",
        {"卫生间", "卫生间_漏水"},
    )

    assert record_name == "卫生间_漏水"
    assert time_baked is False


def test_resolve_scene_plate_unknown_names_do_not_assume_time_plate_exists() -> None:
    record_name, time_baked = resolve_scene_plate("卫生间", "漏水", "夜", None)

    assert record_name == "卫生间_漏水"
    assert time_baked is False
