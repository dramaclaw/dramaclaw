"""`assistant.delta` frames carry `{offset, text}` patches, not the whole reply.

The browser rebuilds the reply as ``prev[:offset] + text`` where ``offset`` is
counted in UTF-16 code units (JavaScript string indices). These tests replay
that client rule in Python and check it against the server-side encoder.
"""

from __future__ import annotations

import json

from novelvideo.chat.presentation_text import (
    _redact_local_filesystem_paths,
    _strip_replayed_chat_response,
)
from novelvideo.chat.stream_delta import AssistantDeltaEncoder


def _client_apply(previous: str, patch: dict) -> str:
    """The browser rule: keep `offset` UTF-16 units, then append `text`."""
    units = previous.encode("utf-16-le")[: patch["offset"] * 2]
    return units.decode("utf-16-le") + patch["text"]


def _replay(snapshots: list[str]) -> tuple[list[dict], list[str]]:
    encoder = AssistantDeltaEncoder()
    patches: list[dict] = []
    assembled: list[str] = []
    client_text = ""
    for snapshot in snapshots:
        patch = encoder.encode(snapshot)
        if patch is None:
            continue
        patches.append(patch)
        client_text = _client_apply(client_text, patch)
        assembled.append(client_text)
    return patches, assembled


def test_append_only_stream_sends_each_chunk_once():
    chunk_count = 200
    chunk_size = 50
    snapshots = [
        "".join(chr(ord("a") + (i % 26)) * chunk_size for i in range(step + 1))
        for step in range(chunk_count)
    ]

    patches, assembled = _replay(snapshots)

    assert len(patches) == 200
    assert sum(len(patch["text"]) for patch in patches) == 10_000
    assert [patch["offset"] for patch in patches[:3]] == [0, 50, 100]
    assert patches[-1]["offset"] == 9_950
    # Whole-snapshot frames would have cost 50 * 200 * 201 / 2 = 1,005,000 chars.
    wire_bytes = sum(len(json.dumps(patch).encode("utf-8")) for patch in patches)
    assert wire_bytes == 15_577
    assert assembled[-1] == snapshots[-1]


def test_unchanged_snapshot_sends_nothing():
    encoder = AssistantDeltaEncoder()

    assert encoder.encode("hello") == {"offset": 0, "text": "hello"}
    assert encoder.encode("hello") is None
    assert encoder.encode("hello!") == {"offset": 5, "text": "!"}


def test_path_masking_that_shrinks_the_text_reassembles_exactly():
    raw = "文件在 /Users/alice/proj/out.png 已生成，请查看。"
    snapshots = [
        _redact_local_filesystem_paths(raw[:end]) for end in range(1, len(raw) + 1)
    ]

    patches, assembled = _replay(snapshots)

    assert assembled[-1] == "文件在 [本地路径] 已生成，请查看。"
    assert assembled[-1] == snapshots[-1]
    # The mask appears once "/Users/alice/" gains a second segment; that patch
    # rewrites from the start of the path instead of appending.
    rewrite = next(patch for patch in patches if patch["text"].startswith("[本地路径]"))
    assert rewrite == {"offset": 4, "text": "[本地路径]"}
    expected = [
        snapshot
        for index, snapshot in enumerate(snapshots)
        if index == 0 or snapshot != snapshots[index - 1]
    ]
    assert assembled == expected


def test_replay_stripping_rewinds_to_offset_zero_and_reassembles_exactly():
    previous_answer = "这是上一轮的完整回答，内容足够长以便识别出来。"
    prompt = "继续"
    raw = previous_answer + "新的回答在这里。"
    snapshots = [
        _strip_replayed_chat_response(
            raw[:end], [previous_answer], prompt, suppress_partial_replay=True
        )
        for end in range(1, len(raw) + 1)
    ]

    patches, assembled = _replay(snapshots)

    # A short replayed prefix is shown first, then withdrawn once it is
    # recognised as a replay, then the real answer streams from offset 0.
    assert patches[0] == {"offset": 0, "text": "这"}
    assert {"offset": 0, "text": ""} in patches
    assert assembled[-1] == "新的回答在这里。"
    assert assembled[-1] == snapshots[-1]
    rewinds = [patch for patch in patches[1:] if patch["offset"] == 0]
    assert rewinds[0] == {"offset": 0, "text": ""}


def test_redelivered_patch_is_idempotent_on_the_client():
    encoder = AssistantDeltaEncoder()
    first = encoder.encode("abc")
    second = encoder.encode("abX")

    client_text = _client_apply("", first)
    client_text = _client_apply(client_text, second)
    client_text = _client_apply(client_text, second)

    assert second == {"offset": 2, "text": "X"}
    assert client_text == "abX"


def test_offsets_count_utf16_units_for_astral_characters():
    encoder = AssistantDeltaEncoder()

    assert encoder.encode("a😀") == {"offset": 0, "text": "a😀"}
    assert encoder.encode("a😀b") == {"offset": 3, "text": "b"}
    assert encoder.encode("a😀c") == {"offset": 3, "text": "c"}
    assert encoder.encode("a😁") == {"offset": 1, "text": "😁"}
