"""Encode streamed assistant text as `{offset, text}` patches.

The chat backends report the reply as a growing snapshot, and some display
transforms (path masking, replay stripping) rewrite text that was already
shown. Sending the whole snapshot on every delta makes a long reply cost
O(N^2) bytes. The encoder sends only the changed tail instead: the client
keeps ``offset`` characters of what it has and appends ``text``.

``offset`` is measured in UTF-16 code units because the browser slices
JavaScript strings, whose indices count UTF-16 units, not code points.
"""

from __future__ import annotations

import os


def _utf16_length(text: str) -> int:
    return len(text.encode("utf-16-le")) // 2


class AssistantDeltaEncoder:
    """Tracks what the client holds and emits the patch for the next snapshot."""

    def __init__(self) -> None:
        self._sent = ""

    def encode(self, snapshot: str) -> dict[str, object] | None:
        """Return the patch that turns the client text into ``snapshot``.

        Returns ``None`` when the client already holds ``snapshot``.
        """
        text = str(snapshot or "")
        if text == self._sent:
            return None
        shared = len(os.path.commonprefix([self._sent, text]))
        self._sent = text
        return {"offset": _utf16_length(text[:shared]), "text": text[shared:]}
