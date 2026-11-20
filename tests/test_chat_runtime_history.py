"""Codex native history parsing stays independent of chat storage."""

from novelvideo.chat.runtime_history import (
    _split_trace_contents,
)


def test_trace_blocks_skip_blank_lines() -> None:
    assert _split_trace_contents("first\n\nsecond\nthird\n") == [
        "first",
        "second\nthird",
    ]
