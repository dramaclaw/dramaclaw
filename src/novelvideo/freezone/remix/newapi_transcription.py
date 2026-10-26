"""Timed speech transcription through the selected NewAPI gateway."""

from __future__ import annotations

import mimetypes
import math
import re
import subprocess
import tempfile
import unicodedata
import asyncio
import contextvars
import hashlib
from contextlib import ExitStack
from concurrent.futures import ThreadPoolExecutor
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any

import httpx

from novelvideo.model_gateway_runtime import ModelGatewayPreDispatchError


MODEL = "audio-transcribe"
MAX_ORGANIZATION_AUDIO_BYTES = 25 * 1024 * 1024
_DIRECT_AUDIO_SUFFIXES = {".aac", ".flac", ".m4a", ".mp3", ".mpga", ".ogg", ".opus", ".wav"}
_LANGUAGE_CODES = {"chinese": "zh", "mandarin": "zh", "english": "en"}
_OPTIONAL_ERHUA_WORDS = frozenset({"事儿", "这儿", "那儿", "哪儿", "点儿", "会儿", "玩儿", "味儿"})


class TranscriptionPreDispatchError(ModelGatewayPreDispatchError):
    """Local transcription preparation failed before any request was sent."""


def _script_character_map(
    script: str, script_chars: list[str], script_offsets: list[tuple[int, int]], asr_chars: list[str]
) -> tuple[list[int], dict[int, int]] | None:
    """Map timed ASR characters to script characters without timing an absent word.

    A recognized colloquial 儿化 suffix shares its preceding token's existing
    time. Every other insertion, deletion or substitution remains a mismatch.
    """
    mapped = [-1] * len(asr_chars)
    suffix_after: dict[int, int] = {}
    for tag, script_start, script_end, asr_start, asr_end in SequenceMatcher(
        None, "".join(script_chars), "".join(asr_chars), autojunk=False
    ).get_opcodes():
        if tag == "equal":
            for offset in range(asr_end - asr_start):
                mapped[asr_start + offset] = script_start + offset
            continue
        if (tag != "delete" or script_end != script_start + 1 or script_start == 0
            or asr_start == 0 or script_chars[script_start] != "儿"
            or mapped[asr_start - 1] != script_start - 1):
            return None
        preceding = script_offsets[script_start - 1][0]
        suffix_end = script_offsets[script_start][1]
        if script[preceding:suffix_end] not in _OPTIONAL_ERHUA_WORDS:
            return None
        suffix_after[asr_start - 1] = script_start
    return (mapped, suffix_after) if all(index >= 0 for index in mapped) else None


class NewApiSpeechTranscriber:
    """Request actual word timestamps; never infer them from sentence duration."""

    def __init__(
        self, *, api_key: str = "", base_url: str = "", transport: httpx.BaseTransport | None = None,
        allow_segments: bool = False, organization: bool = False,
    ) -> None:
        if organization:
            if api_key or base_url:
                raise TranscriptionPreDispatchError("Organization transcription cannot carry platform credentials")
            self.api_key = ""
            self.endpoint = ""
            self.organization = True
            self.transport = transport
            self.allow_segments = allow_segments
            return
        if not api_key.strip() or not base_url.strip():
            raise TranscriptionPreDispatchError("NewAPI transcription requires a configured gateway and API key")
        try:
            gateway = httpx.URL(base_url.strip())
        except httpx.InvalidURL as exc:
            raise TranscriptionPreDispatchError("NewAPI transcription requires a configured HTTP gateway") from exc
        if gateway.scheme not in {'http', 'https'} or not gateway.host:
            raise TranscriptionPreDispatchError("NewAPI transcription requires a configured HTTP gateway")
        self.api_key = api_key.strip()
        self.endpoint = base_url.strip().rstrip("/") + "/audio/transcriptions"
        self.organization = False
        self.transport = transport
        self.allow_segments = allow_segments

    def transcribe(self, media_path: Path, language: str) -> dict[str, Any]:
        if media_path.suffix.lower() in _DIRECT_AUDIO_SUFFIXES:
            return self._request(media_path, language)
        try:
            temporary_directory = tempfile.TemporaryDirectory(prefix="remix-transcribe-")
        except OSError as exc:
            raise TranscriptionPreDispatchError("Could not extract audio from the media for transcription") from exc
        with temporary_directory as temporary:
            audio_path = Path(temporary) / "audio.mp3"
            try:
                completed = subprocess.run(
                    [
                        "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error",
                        "-y", "-i", str(media_path), "-map", "0:a:0", "-vn",
                        "-ac", "1", "-ar", "16000", "-b:a", "32k", str(audio_path),
                    ],
                    capture_output=True, text=True, timeout=600, check=False,
                )
                if completed.returncode or not audio_path.is_file() or not audio_path.stat().st_size:
                    raise TranscriptionPreDispatchError("Could not extract audio from the media for transcription")
            except (OSError, subprocess.SubprocessError) as exc:
                raise TranscriptionPreDispatchError("Could not extract audio from the media for transcription") from exc
            # No preparation handler encloses dispatch or temporary cleanup:
            # failures there cannot prove that a request was never submitted.
            return self._request(audio_path, language)

    def align(self, media_path: Path, script: str, language: str) -> dict[str, Any]:
        """Map verified script characters to NewAPI's timed recognition tokens.

        This is word-level ASR alignment, not an acoustic forced alignment.
        Script characters without a timed ASR token remain a reviewable mismatch.
        """
        from novelvideo.freezone.remix.speech_comparison import (
            _contiguous_ranges,
            _normalized_characters,
            compare_spoken_script,
        )

        recognized = self.transcribe(media_path, language)
        if recognized["status"] == "no_speech":
            return recognized
        transcript = recognized["transcript"]
        def mismatch(reason: str, **details: Any) -> dict[str, Any]:
            return {
                "status": "script_mismatch", "words": [],
                "recognized_transcript": transcript,
                "recognized_words": recognized["words"],
                "mismatch": {"reason": reason, "report": serialized_report, **details},
            }
        report = compare_spoken_script(script, transcript)
        serialized_report = report.model_dump(mode="json")
        serialized_report["provenance"] = "newapi_asr_comparison"
        script_chars, script_offsets = _normalized_characters(script)
        asr_chars, asr_offsets = _normalized_characters(transcript)
        character_map = _script_character_map(script, script_chars, script_offsets, asr_chars)
        if not report.normalized_script or character_map is None:
            return mismatch("NewAPI transcription differs from the script")
        script_indices, suffix_after = character_map
        mapped_words: list[dict[str, Any]] = []
        covered: set[int] = set()
        cursor = 0
        for word in recognized["words"]:
            start = word.get("start_char")
            end = word.get("end_char")
            if type(start) is not int or type(end) is not int:
                start = transcript.find(word["text"], cursor)
                end = start + len(word["text"])
            if start < cursor or end > len(transcript) or transcript[start:end] != word["text"]:
                return mismatch("Timed NewAPI word does not match its transcript")
            cursor = end
            indices = [
                index for index, (source_start, source_end) in enumerate(asr_offsets)
                if start <= source_start and source_end <= end
            ]
            if not indices:
                continue
            covered.update(indices)
            script_start = script_offsets[script_indices[indices[0]]][0]
            last_script_index = suffix_after.get(indices[-1], script_indices[indices[-1]])
            script_end = script_offsets[last_script_index][1]
            token = script[script_start:script_end]
            if "\n" in token:
                return mismatch("Timed NewAPI word crosses script lines")
            mapped_words.append({
                "text": token, "start_char": script_start, "end_char": script_end,
                "start": word["start"], "end": word["end"],
            })
        covered_script = {script_indices[index] for index in covered}
        covered_script.update(suffix_after[index] for index in covered if index in suffix_after)
        missing = sorted({script_offsets[index][0] for index in range(len(script_offsets)) if index not in covered_script})
        if missing or not mapped_words:
            return mismatch("NewAPI did not time every required script character",
                            untimed_script_ranges=_contiguous_ranges(missing, script))
        return {
            "status": "completed", "language": recognized["language"],
            "transcript": script, "words": mapped_words,
            "match_report": serialized_report,
        }

    def _request(self, audio_path: Path, language: str) -> dict[str, Any]:
        if self.organization:
            return self._organization_request(audio_path, language)
        return self._request_with_credentials(audio_path, language, self.api_key, self.endpoint)

    def _organization_request(self, audio_path: Path, language: str) -> dict[str, Any]:
        from novelvideo.model_gateway_runtime import (
            ModelGatewayEgressError,
            current_model_gateway_context,
            execute_organization_gateway_request,
            next_model_gateway_business_task_id,
        )
        from novelvideo.ports.egress_operations import canonical_request_digest
        from novelvideo.ports.model_credentials import RequestCredential

        context = current_model_gateway_context()
        if context is None or not context.is_organization:
            raise ModelGatewayEgressError("ORG_EGRESS_DENIED")
        try:
            digest = hashlib.sha256()
            size = 0
            with audio_path.open("rb") as audio:
                for chunk in iter(lambda: audio.read(1_048_576), b""):
                    size += len(chunk)
                    if size > MAX_ORGANIZATION_AUDIO_BYTES:
                        raise TranscriptionPreDispatchError("Audio exceeds organization transcription upload limit")
                    digest.update(chunk)
            media_digest = digest.hexdigest()
        except OSError as exc:
            raise TranscriptionPreDispatchError("Could not read audio for transcription") from exc
        request_digest = canonical_request_digest({
            "model": MODEL, "media_sha256": media_digest, "language": language,
            "response_format": "verbose_json", "timestamp_granularity": ["word", "segment"],
        })
        capability = "audio.transcription.gateway"
        business_task_id = next_model_gateway_business_task_id(
            capability, request_digest=request_digest
        )

        async def submit(credential: RequestCredential) -> dict[str, Any]:
            endpoint = credential.base_url.strip().rstrip("/") + "/audio/transcriptions"
            return self._request_with_credentials(audio_path, language, credential.api_key, endpoint)

        async def execute() -> dict[str, Any]:
            return await execute_organization_gateway_request(
                capability=capability, business_task_id=business_task_id,
                request_digest=request_digest, submit=submit,
            )

        # The Remix aligner is synchronous. Worker threads have no running loop;
        # a direct async caller is bridged through a copied request context.
        try:
            asyncio.get_running_loop()
        except RuntimeError:
            return asyncio.run(execute())
        copied = contextvars.copy_context()
        with ThreadPoolExecutor(max_workers=1) as executor:
            return executor.submit(copied.run, asyncio.run, execute()).result()

    def _request_with_credentials(
        self, audio_path: Path, language: str, api_key: str, endpoint: str
    ) -> dict[str, Any]:
        form = {
            "model": MODEL,
            "response_format": "verbose_json",
            # Word and sentence granularity in one request: words carry the exact
            # timing, segments carry the provider's own sentence boundaries. The
            # gateway rejects diarization for this model, so speaker identity is
            # never requested here.
            "timestamp_granularities[]": ["word", "segment"],
        }
        if language != "auto":
            form["language"] = language
        mime_type = mimetypes.guess_type(audio_path.name)[0] or "application/octet-stream"
        timeout = httpx.Timeout(connect=20.0, read=600.0, write=600.0, pool=20.0)
        stack = ExitStack()
        try:
            audio = stack.enter_context(audio_path.open("rb"))
            client = stack.enter_context(httpx.Client(transport=self.transport, timeout=timeout))
        except Exception as exc:
            stack.close()
            raise TranscriptionPreDispatchError("Could not prepare audio transcription request") from exc
        try:
            response = client.post(
                endpoint,
                headers={"Authorization": f"Bearer {api_key}"},
                data=form,
                files={"file": (audio_path.name, audio, mime_type)},
            )
        except httpx.HTTPError as exc:
            raise RuntimeError("NewAPI audio transcription request failed") from exc
        finally:
            stack.close()
        if not response.is_success:
            raise RuntimeError(
                f"NewAPI audio-transcribe returned HTTP {response.status_code}"
            )
        try:
            payload = response.json()
        except ValueError as exc:
            raise RuntimeError("NewAPI audio-transcribe returned invalid JSON") from exc
        segments = _normalized_segments(payload)
        if not isinstance(payload, dict) or not payload.get("words"):
            if not self.allow_segments:
                return _timed_transcript(payload, language)
            text = payload.get("text", "") if isinstance(payload, dict) else ""
            if not isinstance(text, str):
                raise RuntimeError("NewAPI returned invalid segment recognition")
            return {"status": "completed" if text.strip() or segments else "no_speech", "language": language,
                    "transcript": text, "words": [], "segments": segments}
        # Word timing stays authoritative; segments only add the provider's own
        # sentence boundaries. They never replace or retime the spoken words.
        recognized = _timed_transcript(payload, language)
        if segments:
            recognized["segments"] = segments
        return recognized


def _normalized_segments(payload: object) -> list[dict[str, Any]]:
    if not isinstance(payload, dict):
        return []
    raw_segments = payload.get("segments")
    if raw_segments is None:
        return []
    if not isinstance(raw_segments, list):
        raise RuntimeError("NewAPI returned invalid recognition segments")
    segments: list[dict[str, Any]] = []
    for segment in raw_segments:
        if not isinstance(segment, dict) or not isinstance(segment.get("text"), str):
            raise RuntimeError("NewAPI returned invalid recognition segment")
        start, end = segment.get("start"), segment.get("end")
        if (isinstance(start, bool) or isinstance(end, bool) or not isinstance(start, (int, float))
            or not isinstance(end, (int, float)) or not math.isfinite(start) or not math.isfinite(end)
            or start < 0 or end <= start):
            raise RuntimeError("NewAPI returned invalid recognition segment times")
        segments.append({"text": segment["text"], "start": start, "end": end})
    return segments


def _timed_transcript(payload: object, language: str) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise RuntimeError("NewAPI audio-transcribe returned an invalid result")
    raw_words = payload.get("words")
    recognized_text = payload.get("text")
    if not isinstance(raw_words, list):
        if isinstance(recognized_text, str) and recognized_text.strip():
            raise RuntimeError("NewAPI audio-transcribe did not return word timestamps")
        raise RuntimeError("NewAPI audio-transcribe did not return a word list")
    if not raw_words:
        if isinstance(recognized_text, str) and recognized_text.strip():
            raise RuntimeError("NewAPI audio-transcribe did not return word timestamps")
        return {"status": "no_speech", "words": []}

    words: list[dict[str, Any]] = []
    pending_prefix = ""
    for item in raw_words:
        if not isinstance(item, dict):
            raise RuntimeError("NewAPI audio-transcribe returned an invalid timed word")
        text = item.get("word")
        if not isinstance(text, str) or not text:
            raise RuntimeError("NewAPI audio-transcribe returned an empty timed word")
        if item.get("start") is None or item.get("end") is None:
            raise RuntimeError("NewAPI audio-transcribe did not return word timestamps")
        start, end = item["start"], item["end"]
        if (
            isinstance(start, bool) or isinstance(end, bool)
            or not isinstance(start, (int, float)) or not isinstance(end, (int, float))
            or not math.isfinite(start) or not math.isfinite(end)
            or start < 0 or end < start
        ):
            raise RuntimeError("NewAPI audio-transcribe returned invalid word timestamps")
        if round(end * 1_000_000) == round(start * 1_000_000):
            # The model occasionally gives a spoken token zero duration. Attach
            # its text to the next timed token: a zero-duration token usually
            # sits on a boundary where the provider transcript carries
            # punctuation or spacing, which would break the later span match.
            pending_prefix += text
            continue
        words.append({"text": pending_prefix + text, "start": start, "end": end})
        pending_prefix = ""
    if pending_prefix and words:
        # A trailing zero-duration token still belongs to the spoken text.
        words[-1]["text"] += pending_prefix
    if not words:
        raise RuntimeError("NewAPI audio-transcribe did not return usable word timestamps")

    detected = payload.get("language")
    selected_language = detected if language == "auto" and isinstance(detected, str) else language
    selected_language = _LANGUAGE_CODES.get(selected_language.lower(), selected_language)
    transcript = "".join(word["text"] for word in words)
    matched_sentence = False
    if isinstance(recognized_text, str) and recognized_text.strip():
        def has_untimed_text(fragment: str) -> bool:
            return any(
                not character.isspace() and not unicodedata.category(character).startswith("P")
                for character in fragment
            )

        mapped: list[dict[str, Any]] = []
        cursor = 0
        for word in words:
            match = re.search(re.escape(word["text"]), recognized_text[cursor:], re.IGNORECASE)
            if match is None:
                break
            start, end = cursor + match.start(), cursor + match.end()
            if has_untimed_text(recognized_text[cursor:start]):
                raise RuntimeError("NewAPI transcript contains untimed text")
            mapped.append({**word, "text": recognized_text[start:end], "start_char": start, "end_char": end})
            cursor = end
        if len(mapped) != len(words):
            raise RuntimeError("NewAPI transcript disagrees with timed words")
        if has_untimed_text(recognized_text[cursor:]):
            raise RuntimeError("NewAPI transcript contains untimed text")
        words = mapped
        transcript = recognized_text
        matched_sentence = True
    if not matched_sentence and selected_language == "en":
        # A provider sentence may not match its timed tokens exactly. Keep
        # English boundaries readable even when the canonical match fails.
        transcript = " ".join(word["text"] for word in words)
        cursor = 0
        for word in words:
            word["start_char"] = cursor
            cursor += len(word["text"])
            word["end_char"] = cursor
            cursor += 1
    return {
        "status": "completed",
        "language": selected_language,
        "transcript": transcript,
        "words": words,
    }
