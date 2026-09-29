"""A parsed, provisional preview is not a JSON repair or an adopted document.

Use the same installed JSON parser that backs our contracts for split Unicode
and escapes. Only reader-facing fields are projected; IDs, audits and method
notes remain private. Final strict validation is independent of this preview.
"""

from __future__ import annotations

import re

from pydantic_core import from_json

READABLE = re.compile(
    r"options\.[0-3]\.(?:logline|goal|obstacle|stakes|tone|difference|productionRisks\.\d+)"
    r"|specQuestions\.\d+\.(?:question|choices\.[0-5])"
    r"|overview\.(?:title|(?:logline|protagonist|resistance|emotionalCurve)\.text|synopsis\.\d+\.text)"
    r"|adaptation\.(?:approach|proposedChanges)\.\d+\.text"
    r"|chapters\.\d+\.(?:title|position\.text|story\.\d+\.text)"
    r"|hooks\.(?:episodeHighlights\.\d+\.highlight\.text|openings\.\d+\.(?:image\.text|question)"
    r"|setups\.\d+\.(?:(?:plant|payoff)\.text|openReason)|inapplicableReason)"
    r"|boundaries\.\d+\.text|hunks\.\d+\.afterBlocks\.\d+\.text"
)


class OutlinePreview:
    def __init__(self, stage: str):
        self.stage = stage
        self.raw = ""
        self.shown: dict[str, str] = {}

    def feed(self, chunk: str) -> list[dict]:
        self.raw += chunk
        if len(self.raw) > 1024 * 1024:
            raise ValueError("STREAM_OUTPUT_LIMIT")
        try:
            parsed = from_json(self.raw, allow_partial="trailing-strings")
        except ValueError:
            return []
        if not isinstance(parsed, dict):
            return []
        values: list[tuple[str, str, str]] = []

        def collect(node, path: tuple[str, ...], section: str):
            if isinstance(node, dict):
                for key, value in node.items():
                    collect(value, (*path, key), section)
            elif isinstance(node, list):
                for index, value in enumerate(node):
                    collect(value, (*path, str(index)), section)
            elif isinstance(node, str) and READABLE.fullmatch(".".join(path)):
                values.append((".".join(path), section, node))

        if self.stage == "M03":
            collect(parsed.get("options"), ("options",), "direction")
            collect(parsed.get("specQuestions"), ("specQuestions",), "questions")
        elif self.stage == "M07":
            for section in ("overview", "adaptation", "chapters", "hooks", "boundaries"):
                collect(parsed.get(section), (section,), section)
        elif self.stage == "M14":
            for index, hunk in enumerate(parsed.get("hunks", [])):
                if isinstance(hunk, dict) and hunk.get("sectionKey") in {"overview", "adaptation", "chapters", "hooks", "boundaries"}:
                    collect(hunk.get("afterBlocks"), ("hunks", str(index), "afterBlocks"), hunk["sectionKey"])
        events = []
        for key, section, text in values:
            if self.shown.get(key) != text:
                # Full field snapshots make replay idempotent even when a
                # malformed duplicate key changes an unfinished preview.
                events.append({"schemaVersion": 1, "blockKey": key, "sectionKey": section,
                               "text": text, "provisional": True})
                self.shown[key] = text
        return events
