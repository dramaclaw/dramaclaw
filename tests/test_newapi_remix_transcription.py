"""The canvas transcript action uses NewAPI's timed audio transcription."""

from __future__ import annotations

import hashlib
from pathlib import Path

import httpx
import pytest

from novelvideo.freezone.remix.alignment import align_script, transcribe_media


def test_newapi_transcription_readiness_endpoint(monkeypatch: pytest.MonkeyPatch) -> None:
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from novelvideo.api.auth import get_api_user
    from novelvideo.api.routes import remix

    app = FastAPI()
    app.include_router(remix.router, prefix="/api/v1")
    app.dependency_overrides[get_api_user] = lambda: {"username": "local-test"}
    async def local_context(*_args, **_kwargs):
        return None
    monkeypatch.setattr(remix, "_request_transcription_context", local_context)
    monkeypatch.setattr("novelvideo.config.get_newapi_runtime_credentials", lambda: ("secret", "https://gateway.example/v1"))
    client = TestClient(app)

    response = client.get("/api/v1/projects/local/freezone/remix/transcription-readiness")
    assert response.status_code == 200
    assert response.json() == {"ok": True, "data": {"ready": True, "engine": "newapi", "model": "audio-transcribe"}}


def test_newapi_readiness_reports_missing_gateway_without_exposing_credentials(monkeypatch: pytest.MonkeyPatch) -> None:
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from novelvideo.api.auth import get_api_user
    from novelvideo.api.routes import remix

    app = FastAPI()
    app.include_router(remix.router, prefix="/api/v1")
    app.dependency_overrides[get_api_user] = lambda: {"username": "local-test"}
    async def local_context(*_args, **_kwargs):
        return None
    monkeypatch.setattr(remix, "_request_transcription_context", local_context)
    monkeypatch.setattr("novelvideo.config.get_newapi_runtime_credentials", lambda: ("", ""))
    response = TestClient(app).get("/api/v1/projects/local/freezone/remix/transcription-readiness")

    assert response.status_code == 200
    assert response.json() == {"ok": True, "data": {"ready": False, "engine": "newapi", "model": "audio-transcribe"}}


def test_p0_runner_uses_newapi_word_boundaries_without_interpolating(tmp_path: Path) -> None:
    from novelvideo.freezone.remix.p0 import NewApiAlignmentRunner

    media = tmp_path / "speech.wav"
    media.write_bytes(b"audio")

    class FakeTranscriber:
        def align(self, path: Path, script: str, language: str):
            assert (path, script, language) == (media, "go go", "en")
            return {"status": "completed", "words": [
                {"start_char": 0, "end_char": 2, "start": 0.1, "end": 0.3},
                {"start_char": 3, "end_char": 5, "start": 0.6, "end": 0.8},
            ]}

    runner = NewApiAlignmentRunner(transcriber=FakeTranscriber())
    assert runner.align(media, language="en", script="go go") == [
        {"start_char": 0, "end_char": 2, "start_us": 100_000, "end_us": 300_000},
        {"start_char": 3, "end_char": 5, "start_us": 600_000, "end_us": 800_000},
    ]


def test_newapi_transcription_publishes_real_word_times(tmp_path: Path) -> None:
    from novelvideo.freezone.remix.newapi_transcription import NewApiSpeechTranscriber
    media = tmp_path / "speech.wav"
    media.write_bytes(b"audio")

    def respond(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1/audio/transcriptions"
        assert request.headers["authorization"] == "Bearer test-key"
        body = request.read()
        assert b'name="model"' in body and b"audio-transcribe" in body
        assert b'name="timestamp_granularities[]"' in body and b"word" in body
        assert b'name="timestamp_granularities[]"' in body and b"segment" in body
        assert b'name="language"' not in body  # auto-detect
        assert b"audio" in body
        return httpx.Response(200, json={
            "language": "chinese",
            "text": "你好 世界",
            "words": [
                {"word": "你好", "start": 0.1, "end": 0.5},
                {"word": " 世界", "start": 0.6, "end": 1.0},
            ],
        })

    transcriber = NewApiSpeechTranscriber(
        api_key="test-key",
        base_url="https://gateway.example/v1",
        transport=httpx.MockTransport(respond),
    )
    result = transcribe_media(media, "auto", aligner=transcriber)

    assert result["language"] == "zh"
    assert result["transcript"] == "你好 世界"
    assert result["media_hash"] == f"sha256:{hashlib.sha256(b'audio').hexdigest()}"
    assert [(word["text"], word["start_us"], word["end_us"]) for word in result["words"]] == [
        ("你好", 100_000, 500_000),
        (" 世界", 600_000, 1_000_000),
    ]


def test_newapi_transcription_preserves_provider_sentence_spacing_and_word_spans(tmp_path: Path) -> None:
    from novelvideo.freezone.remix.newapi_transcription import NewApiSpeechTranscriber

    media = tmp_path / "speech.wav"
    media.write_bytes(b"audio")
    transcriber = NewApiSpeechTranscriber(
        api_key="test-key", base_url="https://gateway.example/v1",
        transport=httpx.MockTransport(lambda _request: httpx.Response(200, json={
            "language": "english",
            "text": "Okay, Sarah, so what?",
            "words": [
                {"word": "Okay", "start": 0.0, "end": 0.3},
                {"word": "Sarah", "start": 0.4, "end": 0.7},
                {"word": "so", "start": 0.8, "end": 0.9},
                {"word": "what", "start": 1.0, "end": 1.2},
            ],
        })),
    )

    result = transcribe_media(media, "auto", aligner=transcriber)

    assert result["transcript"] == "Okay, Sarah, so what?"
    assert [(word["text"], word["start_char"], word["end_char"]) for word in result["words"]] == [
        ("Okay", 0, 4), ("Sarah", 6, 11), ("so", 13, 15), ("what", 16, 20),
    ]


def test_newapi_transcription_keeps_provider_spelling_when_two_tokens_form_one_word(tmp_path: Path) -> None:
    from novelvideo.freezone.remix.newapi_transcription import NewApiSpeechTranscriber

    media = tmp_path / "speech.wav"
    media.write_bytes(b"audio")
    transcriber = NewApiSpeechTranscriber(
        api_key="test-key", base_url="https://gateway.example/v1",
        transport=httpx.MockTransport(lambda _request: httpx.Response(200, json={
            "language": "english", "text": "cannot",
            "words": [
                {"word": "can", "start": 0.0, "end": 0.3},
                {"word": "not", "start": 0.3, "end": 0.6},
            ],
        })),
    )

    result = transcribe_media(media, "auto", aligner=transcriber)

    assert result["transcript"] == "cannot"
    assert [(word["start_char"], word["end_char"]) for word in result["words"]] == [(0, 3), (3, 6)]


def test_newapi_transcription_rejects_text_without_word_timestamps(tmp_path: Path) -> None:
    from novelvideo.freezone.remix.newapi_transcription import NewApiSpeechTranscriber
    media = tmp_path / "speech.wav"
    media.write_bytes(b"audio")
    transcriber = NewApiSpeechTranscriber(
        api_key="test-key",
        base_url="https://gateway.example/v1",
        transport=httpx.MockTransport(
            lambda _request: httpx.Response(200, json={"text": "hello", "segments": [{"start": 0, "end": 1, "text": "hello"}]})
        ),
    )

    with pytest.raises(RuntimeError, match="word timestamps"):
        transcribe_media(media, "en", aligner=transcriber)


def test_script_mismatch_keeps_raw_timed_recognition_for_srt_correction(tmp_path: Path) -> None:
    from novelvideo.freezone.remix.newapi_transcription import NewApiSpeechTranscriber

    media = tmp_path / "speech.wav"
    media.write_bytes(b"audio")
    transcriber = NewApiSpeechTranscriber(
        api_key="test-key", base_url="https://gateway.example/v1",
        transport=httpx.MockTransport(lambda _request: httpx.Response(200, json={
            "language": "zh", "text": "桌上那是空杯。行，下一题。",
            "words": [
                {"word": "桌上那是空杯。", "start": 1.25, "end": 3.0},
                {"word": "行，下一题。", "start": 3.6, "end": 4.7},
            ],
        })),
    )

    result = align_script(media, {"revision": 1, "text": "桌上那排空杯。\n行，下一题。", "already_spoken": True}, aligner=transcriber)

    assert result["status"] == "script_mismatch"
    assert result["words"] == []
    assert result["recognized_transcript"] == "桌上那是空杯。行，下一题。"
    assert [(word["text"], word["start_us"], word["end_us"]) for word in result["recognized_words"]] == [
        ("桌上那是空杯。", 1_250_000, 3_000_000),
        ("行，下一题。", 3_600_000, 4_700_000),
    ]


def test_newapi_transcription_groups_zero_duration_tokens_with_adjacent_word(tmp_path: Path) -> None:
    from novelvideo.freezone.remix.newapi_transcription import NewApiSpeechTranscriber

    media = tmp_path / "speech.wav"
    media.write_bytes(b"audio")
    transcriber = NewApiSpeechTranscriber(
        api_key="test-key", base_url="https://gateway.example/v1",
        transport=httpx.MockTransport(lambda _request: httpx.Response(200, json={
            "text": "一杯咖啡", "words": [
                {"word": "一", "start": 0.0, "end": 0.3},
                {"word": "杯", "start": 0.3, "end": 0.3},
                {"word": "咖", "start": 0.4, "end": 0.6},
                {"word": "啡", "start": 0.6, "end": 0.8},
            ],
        })),
    )

    result = transcribe_media(media, "zh", aligner=transcriber)

    assert result["transcript"] == "一杯咖啡"
    assert [(word["text"], word["start_us"], word["end_us"]) for word in result["words"]] == [
        ("一", 0, 300_000), ("杯咖", 400_000, 600_000), ("啡", 600_000, 800_000),
    ]


def test_newapi_transcription_keeps_zero_duration_token_inside_one_span(tmp_path: Path) -> None:
    from novelvideo.freezone.remix.newapi_transcription import NewApiSpeechTranscriber

    media = tmp_path / "speech.wav"
    media.write_bytes(b"audio")
    transcriber = NewApiSpeechTranscriber(
        api_key="test-key", base_url="https://gateway.example/v1",
        transport=httpx.MockTransport(lambda _request: httpx.Response(200, json={
            "language": "chinese",
            "text": "如果只能选一样,你每天最离不开的东西是什么?",
            "words": [
                {"word": "如果", "start": 0.0, "end": 0.48},
                {"word": "只能", "start": 0.48, "end": 0.8},
                {"word": "选", "start": 0.8, "end": 0.94},
                {"word": "一样", "start": 0.94, "end": 1.26},
                {"word": "你", "start": 1.54, "end": 1.54},
                {"word": "每天", "start": 1.54, "end": 1.92},
                {"word": "最离不开的东西是什么", "start": 1.92, "end": 3.32},
            ],
        })),
    )

    result = transcribe_media(media, "auto", aligner=transcriber)

    assert result["transcript"] == "如果只能选一样,你每天最离不开的东西是什么?"
    assert [word["text"] for word in result["words"]] == [
        "如果", "只能", "选", "一样", "你每天", "最离不开的东西是什么",
    ]


def test_default_canvas_transcription_selects_newapi(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from novelvideo.freezone.remix import alignment

    media = tmp_path / "speech.wav"
    media.write_bytes(b"audio")
    called: list[tuple[Path, str]] = []

    class HostedTranscriber:
        def transcribe(self, path: Path, language: str):
            called.append((path, language))
            return {"status": "no_speech", "words": []}

    monkeypatch.setattr(alignment, "configured_newapi_transcriber", lambda: HostedTranscriber(), raising=False)

    assert transcribe_media(media, "auto")["status"] == "no_speech"
    assert called == [(media, "auto")]


def test_newapi_aligns_matching_script_with_repeated_words_and_punctuation(tmp_path: Path) -> None:
    from novelvideo.freezone.remix.newapi_transcription import NewApiSpeechTranscriber

    media = tmp_path / "speech.wav"
    media.write_bytes(b"audio")
    transcriber = NewApiSpeechTranscriber(
        api_key="test-key", base_url="https://gateway.example/v1",
        transport=httpx.MockTransport(lambda _request: httpx.Response(200, json={
            "language": "english", "text": "go go",
            "words": [
                {"word": "go", "start": 0.1, "end": 0.3},
                {"word": "go", "start": 0.6, "end": 0.8},
            ],
        })),
    )

    result = align_script(media, {"revision": 2, "language": "en", "dialogue": "Go, go!"}, aligner=transcriber)

    assert result["status"] == "completed"
    assert result["transcript"] == "Go, go!"
    assert [(word["text"], word["start_char"], word["end_char"], word["start_us"], word["end_us"]) for word in result["words"]] == [
        ("Go", 0, 2, 100_000, 300_000),
        ("go", 4, 6, 600_000, 800_000),
    ]
    assert result["match_report"]["character_coverage"] == 1.0
    assert result["match_report"]["provenance"] == "newapi_asr_comparison"
    from novelvideo.freezone.remix.contracts import WordTimeline
    assert WordTimeline.model_validate(result).status == "completed"
    from novelvideo.freezone.remix.take_timing import compile_take_timing
    script = {
        "revision": 2, "dialogue": "Go, go!", "selections": [], "events": [],
        "segments": [{"segment_id": "take-1", "start_char": 0, "end_char": 7,
                      "speaker": "speaker", "source": "speaking_video"}],
    }
    timing = compile_take_timing(script, [{
        "segment_id": "take-1", "media_hash": result["media_hash"],
        "duration_us": 1_000_000, "alignment": result,
    }], fps=30)
    assert [cue["text"] for cue in timing["takes"][0]["word_cues"]] == ["Go", "go"]


def test_newapi_alignment_accepts_traditional_recognition_for_simplified_script(tmp_path: Path) -> None:
    from novelvideo.freezone.remix.newapi_transcription import NewApiSpeechTranscriber

    media = tmp_path / "speech.wav"
    media.write_bytes(b"audio")
    transcriber = NewApiSpeechTranscriber(
        api_key="test-key", base_url="https://gateway.example/v1",
        transport=httpx.MockTransport(lambda _request: httpx.Response(200, json={
            "language": "chinese", "text": "還是來一杯。",
            "words": [
                {"word": "還是", "start": 0.1, "end": 0.4},
                {"word": "來", "start": 0.4, "end": 0.6},
                {"word": "一杯。", "start": 0.6, "end": 1.0},
            ],
        })),
    )

    result = align_script(media, {"revision": 1, "dialogue": "还是来一杯。"}, aligner=transcriber)

    assert result["status"] == "completed"
    assert [(word["text"], word["start_char"], word["end_char"]) for word in result["words"]] == [
        ("还是", 0, 2), ("来", 2, 3), ("一杯", 3, 5),
    ]
    assert result["match_report"]["character_coverage"] == 1.0


def test_newapi_alignment_accepts_timed_erhua_variant_without_inventing_a_word_time(tmp_path: Path) -> None:
    from novelvideo.freezone.remix.newapi_transcription import NewApiSpeechTranscriber

    media = tmp_path / "speech.wav"
    media.write_bytes(b"audio")
    transcriber = NewApiSpeechTranscriber(
        api_key="test-key", base_url="https://gateway.example/v1",
        transport=httpx.MockTransport(lambda _request: httpx.Response(200, json={
            "language": "chinese", "text": "问你个事最近你最离不开的东西是什么想好了再答",
            "words": [
                {"word": "问你个事", "start": 0.1, "end": 0.8},
                {"word": "最近你最离不开的东西是什么", "start": 0.9, "end": 2.1},
                {"word": "想好了再答", "start": 2.2, "end": 3.0},
            ],
        })),
    )

    result = align_script(media, {"revision": 1, "dialogue": "问你个事儿，最近你最离不开的东西是什么？想好了再答。"}, aligner=transcriber)

    assert result["status"] == "completed"
    assert [(word["text"], word["start_us"], word["end_us"]) for word in result["words"]] == [
        ("问你个事儿", 100_000, 800_000),
        ("最近你最离不开的东西是什么", 900_000, 2_100_000),
        ("想好了再答", 2_200_000, 3_000_000),
    ]
    assert result["match_report"]["omissions"][0]["script_range"]["text"] == "儿"


def test_newapi_alignment_keeps_character_token_boundaries_after_erhua(tmp_path: Path) -> None:
    from novelvideo.freezone.remix.newapi_transcription import NewApiSpeechTranscriber

    media = tmp_path / "speech.wav"
    media.write_bytes(b"audio")
    transcript = "问你个事最近"
    transcriber = NewApiSpeechTranscriber(
        api_key="test-key", base_url="https://gateway.example/v1",
        transport=httpx.MockTransport(lambda _request: httpx.Response(200, json={
            "language": "chinese", "text": transcript,
            "words": [
                {"word": character, "start": index * 0.1, "end": (index + 1) * 0.1}
                for index, character in enumerate(transcript)
            ],
        })),
    )

    result = align_script(media, {"revision": 1, "dialogue": "问你个事儿，最近"}, aligner=transcriber)

    assert result["status"] == "completed"
    assert [(word["text"], word["start_char"], word["end_char"]) for word in result["words"]] == [
        ("问", 0, 1), ("你", 1, 2), ("个", 2, 3), ("事儿", 3, 5), ("最", 6, 7), ("近", 7, 8),
    ]


def test_newapi_alignment_still_rejects_missing_meaningful_chinese_word(tmp_path: Path) -> None:
    from novelvideo.freezone.remix.newapi_transcription import NewApiSpeechTranscriber

    media = tmp_path / "speech.wav"
    media.write_bytes(b"audio")
    transcriber = NewApiSpeechTranscriber(
        api_key="test-key", base_url="https://gateway.example/v1",
        transport=httpx.MockTransport(lambda _request: httpx.Response(200, json={
            "language": "chinese", "text": "我想去",
            "words": [{"word": "我", "start": 0.1, "end": 0.2},
                      {"word": "想", "start": 0.2, "end": 0.4},
                      {"word": "去", "start": 0.4, "end": 0.6}],
        })),
    )

    result = align_script(media, {"revision": 1, "dialogue": "我不想去"}, aligner=transcriber)

    assert result["status"] == "script_mismatch"
    assert result["words"] == []


def test_newapi_alignment_reports_different_spoken_words(tmp_path: Path) -> None:
    from novelvideo.freezone.remix.newapi_transcription import NewApiSpeechTranscriber

    media = tmp_path / "speech.wav"
    media.write_bytes(b"audio")
    transcriber = NewApiSpeechTranscriber(
        api_key="test-key", base_url="https://gateway.example/v1",
        transport=httpx.MockTransport(lambda _request: httpx.Response(200, json={
            "language": "english", "text": "go than go",
            "words": [
                {"word": "go", "start": 0.1, "end": 0.3},
                {"word": "than", "start": 0.3, "end": 0.5},
                {"word": "go", "start": 0.6, "end": 0.8},
            ],
        })),
    )

    result = align_script(media, {"revision": 1, "language": "en", "dialogue": "go then go"}, aligner=transcriber)

    assert result["status"] == "script_mismatch"
    assert result["words"] == []
    assert result["mismatch"]["report"]["substitutions"]


def test_newapi_alignment_rejects_script_words_without_model_timestamps(tmp_path: Path) -> None:
    from novelvideo.freezone.remix.newapi_transcription import NewApiSpeechTranscriber

    media = tmp_path / "speech.wav"
    media.write_bytes(b"audio")
    transcriber = NewApiSpeechTranscriber(
        api_key="test-key", base_url="https://gateway.example/v1",
        transport=httpx.MockTransport(lambda _request: httpx.Response(200, json={
            "language": "english", "text": "go then go",
            "words": [
                {"word": "go", "start": 0.1, "end": 0.3},
                {"word": "go", "start": 0.6, "end": 0.8},
            ],
        })),
    )

    with pytest.raises(RuntimeError, match="untimed text"):
        align_script(media, {"revision": 1, "language": "en", "dialogue": "go then go"}, aligner=transcriber)


def test_newapi_alignment_maps_spoken_words_past_speaker_labels(tmp_path: Path) -> None:
    from novelvideo.freezone.remix.newapi_transcription import NewApiSpeechTranscriber

    media = tmp_path / "speech.wav"
    media.write_bytes(b"audio")
    transcriber = NewApiSpeechTranscriber(
        api_key="test-key", base_url="https://gateway.example/v1",
        transport=httpx.MockTransport(lambda _request: httpx.Response(200, json={
            "language": "chinese", "text": "你好再见",
            "words": [
                {"word": "你", "start": 0.1, "end": 0.2},
                {"word": "好", "start": 0.2, "end": 0.3},
                {"word": "再", "start": 0.5, "end": 0.6},
                {"word": "见", "start": 0.6, "end": 0.7},
            ],
        })),
    )

    result = align_script(media, {"revision": 1, "language": "zh", "dialogue": "男：你好\n女：再见"}, aligner=transcriber)

    assert result["status"] == "completed"
    assert result["transcript"] == "男：你好\n女：再见"
    assert [(word["start_char"], word["end_char"]) for word in result["words"]] == [
        (2, 3), (3, 4), (7, 8), (8, 9),
    ]


def test_default_canvas_script_alignment_selects_newapi(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from novelvideo.freezone.remix import alignment

    media = tmp_path / "speech.wav"
    media.write_bytes(b"audio")
    called: list[tuple[Path, str, str]] = []

    class HostedAligner:
        def align(self, path: Path, script: str, language: str):
            called.append((path, script, language))
            return {"status": "no_speech", "words": []}

    monkeypatch.setattr(alignment, "configured_newapi_transcriber", lambda: HostedAligner())

    assert align_script(media, {"revision": 1, "language": "en", "dialogue": "hello"})["status"] == "no_speech"
    assert called == [(media, "hello", "en")]
