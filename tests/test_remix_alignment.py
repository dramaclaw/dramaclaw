"""Speech adapter output is normalized before it becomes a remix artifact."""

from __future__ import annotations

import hashlib
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
import threading
import time
from typing import Any

from novelvideo.freezone.remix.alignment import align_script, transcribe_media


class FakeSpeechAligner:
    def __init__(self, *, transcription: dict[str, Any], alignment: dict[str, Any] | None = None) -> None:
        self.transcription = transcription
        self.alignment = alignment if alignment is not None else transcription

    def transcribe(self, media_path: Path, language: str) -> dict[str, Any]:
        return self.transcription

    def align(self, media_path: Path, script: str, language: str) -> dict[str, Any]:
        return self.alignment


def test_transcribe_normalizes_unicode_character_spans_and_absent_confidence(tmp_path: Path) -> None:
    media = tmp_path / "voice.wav"
    media.write_bytes(b"synthetic narration")

    result = transcribe_media(
        media,
        "zh",
        aligner=FakeSpeechAligner(
            transcription={
                "status": "completed",
                "words": [
                    {"text": "你好", "start": 0.0, "end": 0.4},
                    {"text": "🙂", "start": 0.5, "end": 0.7, "confidence": None},
                ],
            }
        ),
    )

    assert result["status"] == "completed"
    assert result["media_hash"] == f"sha256:{hashlib.sha256(b'synthetic narration').hexdigest()}"
    assert result["transcript"] == "你好🙂"
    assert result["confidence_available"] is False
    assert result["words"] == [
        {
            "text": "你好",
            "start_char": 0,
            "end_char": 2,
            "start_us": 0,
            "end_us": 400_000,
            "confidence": None,
            "confidence_status": "unavailable",
        },
        {
            "text": "🙂",
            "start_char": 2,
            "end_char": 3,
            "start_us": 500_000,
            "end_us": 700_000,
            "confidence": None,
            "confidence_status": "unavailable",
        },
    ]


def test_transcribe_explicitly_returns_no_speech(tmp_path: Path) -> None:
    media = tmp_path / "silent.wav"
    media.write_bytes(b"silence")

    result = transcribe_media(
        media,
        "en",
        aligner=FakeSpeechAligner(transcription={"status": "no_speech", "words": []}),
    )

    assert result["status"] == "no_speech"
    assert result["transcript"] == ""
    assert result["words"] == []
    assert result["confidence_available"] is False


def test_transcribe_keeps_provider_segments_next_to_timed_words(tmp_path: Path) -> None:
    media = tmp_path / "dialogue.wav"
    media.write_bytes(b"dialogue")

    result = transcribe_media(
        media,
        "zh",
        allow_segments=True,
        aligner=FakeSpeechAligner(transcription={
            "status": "completed",
            "transcript": "你吃榴莲把嗓子扎着了对啊 干嘛",
            "words": [
                {"text": "你", "start": 0.0, "end": 0.3},
                {"text": "吃", "start": 0.3, "end": 0.6},
                {"text": "榴莲", "start": 0.6, "end": 1.2},
                {"text": "把", "start": 1.2, "end": 1.5},
                {"text": "嗓子", "start": 1.5, "end": 1.9},
                {"text": "扎着了", "start": 1.9, "end": 2.26},
                {"text": "对啊", "start": 2.26, "end": 2.8},
                {"text": " 干嘛", "start": 2.8, "end": 3.16},
            ],
            "segments": [
                {"text": "你吃榴莲把嗓子扎着了", "start": 0.0, "end": 2.26},
                {"text": "对啊 干嘛", "start": 2.26, "end": 3.16},
            ],
        }),
    )

    assert len(result["words"]) == 8
    assert result["segments"] == [
        {"text": "你吃榴莲把嗓子扎着了", "start_us": 0, "end_us": 2_260_000},
        {"text": "对啊 干嘛", "start_us": 2_260_000, "end_us": 3_160_000},
    ]


def test_transcribe_drops_segments_that_disagree_with_the_transcript(tmp_path: Path) -> None:
    media = tmp_path / "dialogue.wav"
    media.write_bytes(b"dialogue")

    result = transcribe_media(
        media,
        "zh",
        allow_segments=True,
        aligner=FakeSpeechAligner(transcription={
            "status": "completed",
            "transcript": "你吃榴莲把嗓子扎着了",
            "words": [{"text": "你吃榴莲把嗓子扎着了", "start": 0.0, "end": 2.26}],
            "segments": [{"text": "完全不同的句子", "start": 0.0, "end": 2.26}],
        }),
    )

    assert "segments" not in result
    assert len(result["words"]) == 1


def test_speech_engine_calls_have_a_process_wide_single_slot(tmp_path: Path) -> None:
    media = tmp_path / "speech.wav"
    media.write_bytes(b"audio")
    active = 0
    max_active = 0
    first_entered = threading.Event()
    release = threading.Event()
    lock = threading.Lock()

    class BlockingAligner:
        def transcribe(self, media_path, language):
            nonlocal active, max_active
            with lock:
                active += 1
                max_active = max(max_active, active)
                first_entered.set()
            try:
                release.wait(timeout=3)
                return {"status": "no_speech", "words": []}
            finally:
                with lock:
                    active -= 1

    aligner = BlockingAligner()
    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [
            pool.submit(transcribe_media, media, "en", aligner=aligner)
            for _ in range(2)
        ]
        assert first_entered.wait(timeout=1)
        time.sleep(0.05)
        assert max_active == 1
        release.set()
        assert [future.result(timeout=3)["status"] for future in futures] == [
            "no_speech",
            "no_speech",
        ]
    assert max_active == 1


def test_align_script_marks_sequential_text_mismatch_without_guessing_repeated_words(tmp_path: Path) -> None:
    media = tmp_path / "voice.wav"
    media.write_bytes(b"voice")

    result = align_script(
        media,
        {"revision": 4, "language": "en", "dialogue": "go then go"},
        aligner=FakeSpeechAligner(
            transcription={"status": "completed", "words": []},
            alignment={
                "status": "completed",
                "words": [
                    {"text": "go", "start": 0.0, "end": 0.2},
                    {"text": "than", "start": 0.2, "end": 0.5},
                    {"text": "go", "start": 0.5, "end": 0.7},
                ],
            },
        ),
    )

    assert result["status"] == "script_mismatch"
    assert result["script_revision"] == 4
    assert result["words"] == []
    assert result["mismatch"] == {"reason": "aligned token does not match script at character 3"}


def test_align_script_infers_chinese_when_script_omits_language(
    tmp_path: Path,
) -> None:
    media = tmp_path / "voice.wav"
    media.write_bytes(b"audio")

    class RecordingAligner:
        language: str | None = None

        def align(self, media_path: Path, script: str, language: str) -> dict:
            self.language = language
            return {
                "status": "completed",
                "language": "zh",
                "words": [
                    {
                        "text": "你",
                        "start_char": 0,
                        "end_char": 1,
                        "start": 0.0,
                        "end": 0.2,
                    },
                    {
                        "text": "好",
                        "start_char": 1,
                        "end_char": 2,
                        "start": 0.2,
                        "end": 0.4,
                    },
                ],
            }

    aligner = RecordingAligner()
    result = align_script(
        media,
        {"revision": 1, "dialogue": "你好"},
        aligner=aligner,
    )

    assert aligner.language == "zh"
    assert result["language"] == "zh"


def test_align_script_uses_engine_character_spans_for_repeated_words(tmp_path: Path) -> None:
    media = tmp_path / "voice.wav"
    media.write_bytes(b"voice")

    result = align_script(
        media,
        {"revision": 4, "language": "en", "dialogue": "go then go"},
        aligner=FakeSpeechAligner(
            transcription={"status": "completed", "words": []},
            alignment={
                "status": "completed",
                "words": [
                    {"text": "go", "start_char": 0, "end_char": 2, "start_us": 0, "end_us": 200_000, "confidence": 0.9},
                    {"text": "then", "start_char": 3, "end_char": 7, "start_us": 200_000, "end_us": 500_000, "confidence": 0.85},
                    {"text": "go", "start_char": 8, "end_char": 10, "start_us": 500_000, "end_us": 700_000, "confidence": 0.8},
                ],
            },
        ),
    )

    assert result["status"] == "completed"
    assert [(word["start_char"], word["end_char"]) for word in result["words"]] == [(0, 2), (3, 7), (8, 10)]
    assert result["confidence_available"] is True


def test_align_script_keeps_colons_in_preprojected_speech(tmp_path: Path) -> None:
    media = tmp_path / "dialogue.wav"
    media.write_bytes(b"voice")
    spoken = "你好：欢迎\n再见：明天"

    class CheckingAligner(FakeSpeechAligner):
        def align(self, media_path: Path, script: str, language: str) -> dict[str, Any]:
            assert script == spoken
            return self.alignment

    result = align_script(media, {"revision": 1, "dialogue": spoken, "already_spoken": True},
                          aligner=CheckingAligner(transcription={"status": "completed", "words": []},
                                                  alignment={"status": "completed", "words": [
                                                      {"text": "你好：欢迎", "start_char": 0, "end_char": 5,
                                                       "start_us": 0, "end_us": 500_000},
                                                      {"text": "再见：明天", "start_char": 6, "end_char": 11,
                                                       "start_us": 600_000, "end_us": 1_000_000},
                                                  ]}))
    assert result["status"] == "completed"
    assert result["transcript"] == spoken


def test_align_script_skips_speaker_labels_and_maps_words_to_original_script(tmp_path: Path) -> None:
    media = tmp_path / "dialogue.wav"
    media.write_bytes(b"voice")

    class CheckingAligner(FakeSpeechAligner):
        def align(self, media_path: Path, script: str, language: str) -> dict[str, Any]:
            assert script == "你好？\n再见。"
            return self.alignment

    result = align_script(
        media,
        {"revision": 2, "language": "zh", "dialogue": "男：你好？\n女：再见。"},
        aligner=CheckingAligner(
            transcription={"status": "completed", "words": []},
            alignment={"status": "completed", "words": [
                {"text": "你好？", "start_char": 0, "end_char": 3, "start_us": 0, "end_us": 500_000},
                {"text": "再见。", "start_char": 4, "end_char": 7, "start_us": 600_000, "end_us": 1_000_000},
            ]},
        ),
    )
    assert result["status"] == "completed"
    assert result["transcript"] == "男：你好？\n女：再见。"
    assert [(word["start_char"], word["end_char"]) for word in result["words"]] == [(2, 5), (8, 11)]


def test_align_script_keeps_single_line_colon_as_spoken_text(tmp_path: Path) -> None:
    media = tmp_path / "narration.wav"
    media.write_bytes(b"voice")

    class CheckingAligner(FakeSpeechAligner):
        def align(self, media_path: Path, script: str, language: str) -> dict[str, Any]:
            assert script == "注意：保持安静。"
            return self.alignment

    result = align_script(
        media,
        {"revision": 1, "language": "zh", "dialogue": "注意：保持安静。"},
        aligner=CheckingAligner(
            transcription={"status": "completed", "words": []},
            alignment={"status": "completed", "words": [
                {"text": "注意", "start_char": 0, "end_char": 2, "start_us": 0, "end_us": 200_000},
            ]},
        ),
    )
    assert result["words"][0]["start_char"] == 0


def test_align_script_preserves_match_report_and_maps_script_ranges_after_role_prefixes(
    tmp_path: Path,
) -> None:
    media = tmp_path / "dialogue.wav"
    media.write_bytes(b"voice")
    report = {
        "normalized_script": "你好再见",
        "normalized_asr": "你号再见",
        "matched_characters": 3,
        "script_characters": 4,
        "character_coverage": 0.75,
        "required_script_covered": True,
        "substitutions": [{
            "script_range": {"text": "好", "start_char": 1, "end_char": 2, "normalized_start": 1, "normalized_end": 2},
            "asr_range": {"text": "号", "start_char": 1, "end_char": 2, "normalized_start": 1, "normalized_end": 2},
            "confidence": "low",
            "provenance": "asr_comparison",
        }],
        "insertions": [{
            "script_range": {"text": "", "start_char": 3, "end_char": 3, "normalized_start": 2, "normalized_end": 2},
            "asr_range": {"text": "啊", "start_char": 2, "end_char": 3, "normalized_start": 2, "normalized_end": 3},
            "confidence": "low",
            "provenance": "asr_comparison",
        }],
        "omissions": [],
    }

    result = align_script(
        media,
        {"revision": 2, "language": "zh", "dialogue": "男：你好\n女：再见"},
        aligner=FakeSpeechAligner(
            transcription={"status": "completed", "words": []},
            alignment={
                "status": "completed",
                "match_report": report,
                "words": [
                    {"text": "你", "start_char": 0, "end_char": 1, "start_us": 0, "end_us": 100_000},
                    {"text": "好", "start_char": 1, "end_char": 2, "start_us": 100_000, "end_us": 200_000},
                    {"text": "再", "start_char": 3, "end_char": 4, "start_us": 300_000, "end_us": 400_000},
                    {"text": "见", "start_char": 4, "end_char": 5, "start_us": 400_000, "end_us": 500_000},
                ],
            },
        ),
    )

    assert result["status"] == "completed"
    assert result["match_report"]["substitutions"][0]["script_range"] == {
        "text": "好",
        "start_char": 3,
        "end_char": 4,
        "normalized_start": 1,
        "normalized_end": 2,
    }
    assert result["match_report"]["insertions"][0]["script_range"] == {
        "text": "",
        "start_char": 7,
        "end_char": 7,
        "normalized_start": 2,
        "normalized_end": 2,
    }


def test_align_script_maps_untimed_ranges_after_role_prefixes(tmp_path: Path) -> None:
    media = tmp_path / "dialogue.wav"
    media.write_bytes(b"voice")

    result = align_script(
        media,
        {"revision": 2, "language": "zh", "dialogue": "男：你好\n女：再见"},
        aligner=FakeSpeechAligner(
            transcription={"status": "completed", "words": []},
            alignment={
                "status": "script_mismatch",
                "words": [],
                "mismatch": {
                    "reason": "forced alignment left required script characters untimed",
                    "untimed_script_ranges": [
                        {"text": "好", "start_char": 1, "end_char": 2}
                    ],
                },
            },
        ),
    )

    assert result["mismatch"]["untimed_script_ranges"] == [
        {"text": "好", "start_char": 3, "end_char": 4}
    ]
