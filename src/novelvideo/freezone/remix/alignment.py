"""Adapter boundary and normalization for speech transcription and alignment."""

from __future__ import annotations

import hashlib
import threading
import re
from copy import deepcopy
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any, Protocol


_SPEECH_ENGINE_SLOT = threading.BoundedSemaphore(value=1)


class SpeechTranscriber(Protocol):
    def transcribe(self, media_path: Path, language: str) -> dict[str, Any]: ...


class SpeechAligner(SpeechTranscriber, Protocol):
    """A local or service-backed engine whose raw result is normalized here."""

    def align(self, media_path: Path, script: str, language: str) -> dict[str, Any]: ...


def configured_newapi_transcriber(*, allow_segments: bool = False) -> SpeechAligner:
    """Use the effective NewAPI gateway for canvas speech recognition."""
    from novelvideo.config import get_newapi_runtime_credentials
    from novelvideo.egress_context import ambient_organization_egress_context
    from novelvideo.freezone.remix.newapi_transcription import NewApiSpeechTranscriber

    if ambient_organization_egress_context() is not None:
        return NewApiSpeechTranscriber(organization=True, allow_segments=allow_segments)
    api_key, base_url = get_newapi_runtime_credentials()
    return NewApiSpeechTranscriber(api_key=api_key, base_url=base_url, allow_segments=allow_segments)


def transcribe_media(
    media_path: Path, language: str, *, aligner: SpeechTranscriber | None = None, allow_segments: bool = False
) -> dict[str, Any]:
    """Transcribe media through NewAPI into a normalized word timeline.

    An injected adapter remains available for tests and dedicated callers.
    Unicode code-point spans are derived in stream order.
    """
    _validate_media_and_language(media_path, language)
    if aligner is None:
        raw = (configured_newapi_transcriber(allow_segments=True) if allow_segments else configured_newapi_transcriber()).transcribe(media_path, language)
    else:
        with _SPEECH_ENGINE_SLOT:
            raw = aligner.transcribe(media_path, language)
    if raw.get("status") == "completed" and not raw.get("words"):
        segments = _normalize_segments(raw.get("segments"), transcript=raw.get("transcript"))
        transcript = raw.get("transcript", "")
        if not isinstance(transcript, str):
            raise ValueError("recognized transcript must be text")
        return {"media_hash": _sha256(media_path), "language": raw.get("language", language),
                "status": "completed" if transcript or segments else "no_speech",
                "transcript": transcript, "words": [], "segments": segments}
    normalized = _normalize_result(
        raw,
        media_path=media_path,
        language=language,
        script_revision=None,
        script_text=None,
    )
    if allow_segments and normalized.get("status") == "completed":
        # Sentence boundaries are extra evidence, never a substitute for the
        # timed words that downstream alignment depends on.
        segments = _normalize_segments(raw.get("segments"), transcript=normalized.get("transcript"))
        if segments:
            normalized["segments"] = segments
    return normalized


def _normalize_segments(raw_segments: object, *, transcript: object) -> list[dict[str, Any]]:
    if raw_segments is None:
        return []
    if not isinstance(raw_segments, list):
        raise ValueError("recognized segments must be a list")
    segments: list[dict[str, Any]] = []
    for segment in raw_segments:
        if not isinstance(segment, dict) or not isinstance(segment.get("text"), str):
            raise ValueError("recognized segment text is required")
        # Whisper models emit a trailing blank or artifact-only segment; it must
        # not become a reviewable sentence without spoken text.
        if not segment["text"].strip():
            continue
        start, end = _word_times(segment)
        segments.append({"text": segment["text"], "start_us": start, "end_us": end})
    if segments and isinstance(transcript, str) and transcript.strip():
        joined = "".join(part["text"] for part in segments)
        if "".join(joined.split()) != "".join(transcript.split()):
            # Segment text that disagrees with the transcript cannot be trusted
            # for sentence display, so leave the words as the only evidence.
            return []
    return segments


def align_script(
    media_path: Path,
    script: dict[str, Any],
    *,
    aligner: SpeechAligner | None = None,
) -> dict[str, Any]:
    """Align a versioned script against timed recognition words.

    ``script`` requires ``revision`` and either ``dialogue`` or ``text``; its
    optional ``language`` is inferred from the script when absent. Set
    ``already_spoken`` for projected take text whose speaker labels were
    removed upstream, so spoken colons are never parsed as another label. Engine
    character spans are checked against the exact script slice. Engines without
    spans are matched only in forward sequence after whitespace, which prevents
    a repeated word from being rebound to the first occurrence. Mismatches are
    returned as a ``script_mismatch`` status rather than fabricated timings.
    """
    revision = script.get("revision")
    if not isinstance(revision, int) or revision < 1:
        raise ValueError("script revision must be a positive integer")
    text = script.get("dialogue", script.get("text"))
    if not isinstance(text, str):
        raise ValueError("script dialogue or text is required")
    language = _script_language(script.get("language"), text)
    _validate_media_and_language(media_path, language)
    spoken, original_positions = (text, None) if script.get("already_spoken") is True else _spoken_script_positions(text)
    with _SPEECH_ENGINE_SLOT:
        raw = _require_aligner(aligner).align(media_path, spoken, language)
    result = _normalize_result(
        raw,
        media_path=media_path,
        language=language,
        script_revision=revision,
        script_text=spoken,
    )
    if result["status"] == "completed" and original_positions is not None:
        for word in result["words"]:
            start, end = word["start_char"], word["end_char"]
            word["start_char"] = original_positions[start]
            word["end_char"] = original_positions[end - 1] + 1
        result["transcript"] = text
    if original_positions is not None:
        _map_match_report_to_original_script(result, original_positions)
    return result


_HAN_SCRIPT = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]")
_LATIN_SCRIPT = re.compile(r"[A-Za-z]")


def _script_language(value: object, text: str) -> str:
    if isinstance(value, str) and value:
        return value
    if _HAN_SCRIPT.search(text):
        return "zh"
    if _LATIN_SCRIPT.search(text):
        return "en"
    return "auto"


def _map_match_report_to_original_script(
    result: dict[str, Any], original_positions: list[int]
) -> None:
    report = result.get("match_report")
    if not isinstance(report, dict):
        mismatch = result.get("mismatch")
        report = mismatch.get("report") if isinstance(mismatch, dict) else None
    if isinstance(report, dict):
        for key in ("substitutions", "insertions", "omissions"):
            differences = report.get(key)
            if not isinstance(differences, list):
                continue
            for difference in differences:
                span = difference.get("script_range") if isinstance(difference, dict) else None
                if not isinstance(span, dict):
                    continue
                _map_script_span(span, original_positions)
    mismatch = result.get("mismatch")
    untimed = mismatch.get("untimed_script_ranges") if isinstance(mismatch, dict) else None
    if isinstance(untimed, list):
        for span in untimed:
            if isinstance(span, dict):
                _map_script_span(span, original_positions)


def _map_script_span(span: dict[str, Any], original_positions: list[int]) -> None:
    start, end = span.get("start_char"), span.get("end_char")
    if not isinstance(start, int) or not isinstance(end, int):
        return
    if start < end and end <= len(original_positions):
        span["start_char"] = original_positions[start]
        span["end_char"] = original_positions[end - 1] + 1
    elif start == end:
        span["start_char"] = span["end_char"] = (
            original_positions[start]
            if start < len(original_positions)
            else original_positions[-1] + 1
        )


_SPEAKER_PREFIX = re.compile(r"^\s*[^：:\n]{1,24}[：:]\s*")


def _spoken_script_positions(text: str) -> tuple[str, list[int] | None]:
    """Remove role prefixes for alignment while retaining original code-point offsets."""
    lines = text.splitlines(keepends=True)
    nonblank = [line for line in lines if line.strip()]
    if len(nonblank) < 2 or not all(_SPEAKER_PREFIX.match(line) for line in nonblank):
        return text, None
    spoken_chars: list[str] = []
    positions: list[int] = []
    source_offset = 0
    for line in lines:
        content = line.rstrip("\r\n")
        prefix = _SPEAKER_PREFIX.match(content)
        start = prefix.end() if prefix else 0
        for index in range(start, len(content)):
            spoken_chars.append(content[index])
            positions.append(source_offset + index)
        if line.endswith("\n"):
            spoken_chars.append("\n")
            positions.append(source_offset + len(line) - 1)
        source_offset += len(line)
    return "".join(spoken_chars), positions


def _require_aligner(aligner: SpeechAligner | None) -> SpeechAligner:
    if aligner is None:
        return configured_newapi_transcriber()
    return aligner


def _validate_media_and_language(media_path: Path, language: object) -> None:
    if not media_path.is_file():
        raise FileNotFoundError(media_path)
    if not isinstance(language, str) or not language:
        raise ValueError("language is required")


def _normalize_result(
    raw: dict[str, Any],
    *,
    media_path: Path,
    language: str,
    script_revision: int | None,
    script_text: str | None,
) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise ValueError("speech aligner returned an invalid result")
    status = raw.get("status")
    detected_language = raw.get("language") if language == "auto" else language
    if not isinstance(detected_language, str) or not detected_language:
        detected_language = language
    common = {
        "schema": "word_timeline.v1",
        "media_hash": _sha256(media_path),
        "language": detected_language,
    }
    if script_revision is not None:
        common["script_revision"] = script_revision
    if status == "no_speech":
        return {**common, "status": "no_speech", "transcript": "", "words": [], "confidence_available": False}
    if status == "script_mismatch":
        mismatch = {
            **common,
            "status": "script_mismatch",
            "transcript": "",
            "words": [],
            "confidence_available": False,
            "mismatch": raw.get("mismatch", {"reason": "speech aligner reported a script mismatch"}),
        }
        recognized_transcript = raw.get("recognized_transcript")
        if isinstance(recognized_transcript, str) and isinstance(raw.get("recognized_words"), list):
            mismatch["recognized_transcript"] = recognized_transcript
            mismatch["recognized_words"] = _normalize_words(raw["recognized_words"], recognized_transcript)
        return mismatch
    if status != "completed":
        raise ValueError("speech aligner status must be completed, no_speech, or script_mismatch")

    try:
        words = _normalize_words(raw.get("words"), script_text)
    except _ScriptMismatch as error:
        return {
            **common,
            "status": "script_mismatch",
            "transcript": "",
            "words": [],
            "confidence_available": False,
            "mismatch": {"reason": str(error)},
        }
    transcript = script_text if script_text is not None else raw.get("transcript")
    if not isinstance(transcript, str):
        transcript = "".join(word["text"] for word in words)
    normalized = {
        **common,
        "status": "completed",
        "transcript": transcript,
        "words": words,
        "confidence_available": any(word["confidence"] is not None for word in words),
    }
    if isinstance(raw.get("match_report"), dict):
        normalized["match_report"] = deepcopy(raw["match_report"])
    return normalized


def _normalize_words(raw_words: object, script_text: str | None) -> list[dict[str, Any]]:
    if not isinstance(raw_words, list):
        raise ValueError("speech aligner words must be a list")
    words: list[dict[str, Any]] = []
    cursor = 0
    for raw_word in raw_words:
        if not isinstance(raw_word, dict):
            raise ValueError("speech aligner word must be an object")
        text = raw_word.get("text")
        if not isinstance(text, str) or not text:
            raise ValueError("speech aligner word text is required")
        start_char, end_char, cursor = _word_span(raw_word, text, script_text, cursor)
        start_us, end_us = _word_times(raw_word)
        confidence = raw_word.get("confidence")
        if confidence is not None and not isinstance(confidence, (int, float)):
            raise ValueError("speech aligner word confidence must be numeric or absent")
        words.append(
            {
                "text": text,
                "start_char": start_char,
                "end_char": end_char,
                "start_us": start_us,
                "end_us": end_us,
                "confidence": confidence,
                "confidence_status": "available" if confidence is not None else "unavailable",
            }
        )
    return words


def _word_span(
    raw_word: dict[str, Any], text: str, script_text: str | None, cursor: int
) -> tuple[int, int, int]:
    start = raw_word.get("start_char")
    end = raw_word.get("end_char")
    if start is not None or end is not None:
        if not isinstance(start, int) or not isinstance(end, int) or start < 0 or end <= start:
            raise ValueError("speech aligner word character span is invalid")
        if script_text is not None and (end > len(script_text) or script_text[start:end] != text):
            raise _ScriptMismatch(f"aligned token does not match script at character {start}")
        return start, end, max(cursor, end)
    if script_text is None:
        return cursor, cursor + len(text), cursor + len(text)
    while cursor < len(script_text) and script_text[cursor].isspace():
        cursor += 1
    if not script_text.startswith(text, cursor):
        raise _ScriptMismatch(f"aligned token does not match script at character {cursor}")
    return cursor, cursor + len(text), cursor + len(text)


def _word_times(raw_word: dict[str, Any]) -> tuple[int, int]:
    if "start_us" in raw_word or "end_us" in raw_word:
        start, end = raw_word.get("start_us"), raw_word.get("end_us")
        if not isinstance(start, int) or not isinstance(end, int):
            raise ValueError("speech aligner microsecond times must be integers")
    else:
        start, end = _seconds_to_us(raw_word.get("start")), _seconds_to_us(raw_word.get("end"))
    if start < 0 or end <= start:
        raise ValueError("speech aligner word times are invalid")
    return start, end


def _seconds_to_us(value: object) -> int:
    try:
        seconds = Decimal(str(value))
    except (InvalidOperation, ValueError) as error:
        raise ValueError("speech aligner word seconds are invalid") from error
    if not seconds.is_finite():
        raise ValueError("speech aligner word seconds are invalid")
    return int(seconds * 1_000_000)


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1_048_576), b""):
            digest.update(chunk)
    return f"sha256:{digest.hexdigest()}"


class _ScriptMismatch(ValueError):
    """Internal mismatch signal converted to a result status at the public boundary."""
