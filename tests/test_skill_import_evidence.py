import pytest

from novelvideo.freezone.skill_import_evidence import (
    hydrate_segment_quotes,
    segment_source,
)


def assert_lossless(source: str, segments: list[dict]) -> None:
    assert [segment["id"] for segment in segments] == [
        f"S{index:04d}" for index in range(1, len(segments) + 1)
    ]
    for segment in segments:
        assert source[segment["start"] : segment["end"]] == segment["text"]
    covered = {
        offset
        for segment in segments
        for offset in range(segment["start"], segment["end"])
    }
    assert all(character.isspace() or offset in covered for offset, character in enumerate(source))


def test_segments_markdown_blocks_with_exact_offsets_and_heading_paths():
    source = "# First\n\nIntro text.\n\n## Nested\n\n- one\n  - two\n"

    segments = segment_source(source)

    assert segments == [
        {"id": "S0001", "start": 0, "end": 8, "text": "# First\n", "heading_path": ["First"]},
        {"id": "S0002", "start": 9, "end": 21, "text": "Intro text.\n", "heading_path": ["First"]},
        {"id": "S0003", "start": 22, "end": 32, "text": "## Nested\n", "heading_path": ["First", "Nested"]},
        {"id": "S0004", "start": 33, "end": 47, "text": "- one\n  - two\n", "heading_path": ["First", "Nested"]},
    ]
    assert_lossless(source, segments)


@pytest.mark.parametrize(
    "source",
    [
        "# Data\n\n```python\nvalue = `raw` \\\\ path\n```\n",
        "# Table\n\n| 名称 | 值 |\n| --- | --- |\n| café | 東京 |\n",
        "# Markup\n\n<section data-kind=\"demo\">\n<item>one</item>\n</section>\n",
        "# Windows\r\n\r\nText with `ticks` and C:\\\\tmp\\file.\r\n",
        "Repeated text.\n\nRepeated text.\n",
    ],
)
def test_complex_markdown_is_sliced_from_the_original_source(source):
    first = segment_source(source)
    second = segment_source(source)

    assert first == second
    assert_lossless(source, first)


def test_duplicate_blocks_keep_distinct_offsets_and_ids():
    source = "Same words.\n\nSame words.\n"

    segments = segment_source(source)

    assert [segment["start"] for segment in segments] == [0, 13]
    assert [segment["text"] for segment in segments] == ["Same words.\n", "Same words.\n"]
    assert_lossless(source, segments)


def test_unparsed_non_whitespace_ranges_are_preserved():
    source = "Visible paragraph.\n\n[unused]: https://example.com/a\\(b\\)\n"

    segments = segment_source(source)

    assert any("[unused]" in segment["text"] for segment in segments)
    assert_lossless(source, segments)


def test_large_blocks_split_at_source_boundaries_but_not_inside_an_unbroken_line():
    source = "# Long\n\n" + ("sentence with spaces. " * 100) + "\n" + ("x" * 1400)

    segments = segment_source(source)

    paragraph_segments = [segment for segment in segments if "sentence" in segment["text"]]
    assert len(paragraph_segments) >= 2
    assert all(len(segment["text"]) <= 1200 for segment in paragraph_segments)
    assert segments[-1]["text"] == "x" * 1400
    assert_lossless(source, segments)


def test_hydration_returns_exact_text_in_requested_order_and_rejects_unknown_ids():
    source = "One `literal` \\\\ value.\n\nTwo.\n"
    segments = segment_source(source)

    assert hydrate_segment_quotes(["S0002", "S0001"], segments) == [
        segments[1]["text"],
        segments[0]["text"],
    ]
    with pytest.raises(ValueError, match="Unknown source segment ID"):
        hydrate_segment_quotes(["S9999"], segments)
