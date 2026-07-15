from pathlib import Path

import pytest

from novelvideo.shared.billing_errors import InsufficientCreditsError

pytestmark = pytest.mark.m07


class _FakeResponse:
    def __init__(self, payload=None, content=b"audio-bytes", headers=None):
        self._payload = payload or {}
        self.content = content
        self.headers = headers or {"content-type": "application/json"}

    def raise_for_status(self):
        return None

    def json(self):
        return self._payload


class _FakeAsyncClient:
    calls = []
    post_response = _FakeResponse({"audio": {"url": "https://example.com/generated.mp3"}})
    get_response = _FakeResponse(content=b"generated-mp3")

    def __init__(self, *args, **kwargs):
        self.kwargs = kwargs

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False

    async def post(self, url, *, headers=None, json=None):
        self.calls.append(("post", url, headers, json))
        return self.post_response

    async def get(self, url):
        self.calls.append(("get", url, None, None))
        return self.get_response


@pytest.mark.asyncio
async def test_reserve_tts_model_call_uses_audio_billing_kind(monkeypatch):
    import novelvideo.generators.indextts2_fal as indextts2_fal

    calls: list[dict] = []

    class FakeUsageMeter:
        async def reserve_current_model_call_credit(self, **kwargs):
            calls.append(kwargs)
            return "reservation_1"

    monkeypatch.setattr(indextts2_fal, "get_usage_meter", lambda: FakeUsageMeter())

    reservation_id = await indextts2_fal._reserve_tts_model_call(
        "LingShan-TTS-2",
        source="indextts2_newapi",
    )

    assert reservation_id == "reservation_1"
    assert calls == [
        {
            "model": "LingShan-TTS-2",
            "billing_kind": "audio",
            "metadata": {"source": "indextts2_newapi"},
        }
    ]


@pytest.mark.asyncio
async def test_indextts2_newapi_posts_audio_speech_schema(monkeypatch, tmp_path):
    import httpx
    import novelvideo.generators.indextts2_fal as indextts2_fal

    from novelvideo.generators.indextts2_fal import IndexTTS2FalClient

    _FakeAsyncClient.calls = []
    reserved: list[dict] = []
    confirmed: list[dict] = []
    refunded: list[dict] = []
    _FakeAsyncClient.post_response = _FakeResponse(
        content=b"generated-wav",
        headers={"content-type": "audio/wav", "x-oneapi-request-id": "req_tts_1"},
    )

    async def fake_reserve(model, *, source):
        reserved.append({"model": model, "source": source})
        return "reservation_1"

    async def fake_confirm(**kwargs):
        confirmed.append(kwargs)

    async def fake_refund(reservation_id, *, source, error, provider_request_id=""):
        refunded.append(
            {
                "reservation_id": reservation_id,
                "source": source,
                "error": error,
                "provider_request_id": provider_request_id,
            }
        )

    monkeypatch.setattr(httpx, "AsyncClient", _FakeAsyncClient)
    monkeypatch.setattr(indextts2_fal, "_reserve_tts_model_call", fake_reserve)
    monkeypatch.setattr(indextts2_fal, "_confirm_tts_model_call", fake_confirm)
    monkeypatch.setattr(indextts2_fal, "_refund_tts_model_call", fake_refund)

    output_path = tmp_path / "beat_03.mp3"
    client = IndexTTS2FalClient(
        provider="newapi",
        api_key="newapi-test-key",
        endpoint="http://newapi.test/v1",
        model="LingShan-TTS-2",
        timeout_seconds=12,
    )
    result = await client.generate(
        prompt="你终于来了。",
        audio_url="data:audio/wav;base64,abc",
        output_path=output_path,
        emotion_prompt="压低声音，克制但急切",
    )

    assert result.success is True
    assert output_path.read_bytes() == b"generated-wav"
    assert reserved == [{"model": "LingShan-TTS-2", "source": "indextts2_newapi"}]
    assert confirmed == [
        {
            "model": "LingShan-TTS-2",
            "reservation_id": "reservation_1",
            "provider_request_id": "req_tts_1",
            "response_id": "",
        }
    ]
    assert refunded == []
    assert _FakeAsyncClient.calls == [
        (
            "post",
            "http://newapi.test/v1/audio/speech",
            {
                "Authorization": "Bearer newapi-test-key",
                "Content-Type": "application/json",
            },
            {
                "model": "LingShan-TTS-2",
                "input": "你终于来了。",
                "metadata": {
                    "audio_url": "data:audio/wav;base64,abc",
                    "should_use_prompt_for_emotion": True,
                    "emotion_prompt": "压低声音，克制但急切",
                },
            },
        )
    ]


@pytest.mark.asyncio
async def test_indextts2_fal_posts_schema_and_downloads_audio(monkeypatch, tmp_path):
    import httpx
    import novelvideo.generators.indextts2_fal as indextts2_fal

    from novelvideo.generators.indextts2_fal import IndexTTS2FalClient

    _FakeAsyncClient.calls = []
    confirmed: list[dict] = []
    refunded: list[dict] = []

    async def fake_reserve(model, *, source):
        return "reservation_1"

    async def fake_confirm(**kwargs):
        confirmed.append(kwargs)

    async def fake_refund(reservation_id, *, source, error, provider_request_id=""):
        refunded.append(
            {
                "reservation_id": reservation_id,
                "source": source,
                "error": error,
                "provider_request_id": provider_request_id,
            }
        )

    monkeypatch.setattr(httpx, "AsyncClient", _FakeAsyncClient)
    monkeypatch.setattr(indextts2_fal, "_reserve_tts_model_call", fake_reserve)
    monkeypatch.setattr(indextts2_fal, "_confirm_tts_model_call", fake_confirm)
    monkeypatch.setattr(indextts2_fal, "_refund_tts_model_call", fake_refund)

    output_path = tmp_path / "beat_03.mp3"
    _FakeAsyncClient.post_response = _FakeResponse(
        {"audio": {"url": "https://example.com/generated.mp3"}}
    )
    _FakeAsyncClient.get_response = _FakeResponse(content=b"generated-mp3")
    client = IndexTTS2FalClient(provider="fal", api_key="fal-test-key", timeout_seconds=12)
    result = await client.generate(
        prompt="你终于来了。",
        audio_url="https://example.com/reference.wav",
        output_path=output_path,
        emotion_prompt="压低声音，克制但急切",
    )

    assert result.success is True
    assert output_path.read_bytes() == b"generated-mp3"
    assert confirmed == [
        {
            "model": "IndexTTS2",
            "reservation_id": "reservation_1",
            "provider_request_id": "",
            "response_id": "",
        }
    ]
    assert refunded == []

    post_call = _FakeAsyncClient.calls[0]
    assert post_call[0] == "post"
    assert post_call[2]["Authorization"] == "Key fal-test-key"
    assert post_call[3] == {
        "audio_url": "https://example.com/reference.wav",
        "prompt": "你终于来了。",
        "should_use_prompt_for_emotion": True,
        "emotion_prompt": "压低声音，克制但急切",
    }
    assert _FakeAsyncClient.calls[1] == (
        "get",
        "https://example.com/generated.mp3",
        None,
        None,
    )


@pytest.mark.asyncio
async def test_indextts2_refunds_reserved_credit_on_generation_failure(monkeypatch, tmp_path):
    import httpx
    import novelvideo.generators.indextts2_fal as indextts2_fal

    from novelvideo.generators.indextts2_fal import IndexTTS2FalClient

    _FakeAsyncClient.calls = []
    refunded: list[dict] = []
    _FakeAsyncClient.post_response = _FakeResponse(
        {"id": "resp_tts_1"},
        headers={"content-type": "application/json", "x-oneapi-request-id": "req_tts_1"},
    )

    async def fake_reserve(model, *, source):
        return "reservation_1"

    async def fake_confirm(**kwargs):
        raise AssertionError("confirm should not be called")

    async def fake_refund(reservation_id, *, source, error, provider_request_id=""):
        refunded.append(
            {
                "reservation_id": reservation_id,
                "source": source,
                "error": error,
                "provider_request_id": provider_request_id,
            }
        )

    monkeypatch.setattr(httpx, "AsyncClient", _FakeAsyncClient)
    monkeypatch.setattr(indextts2_fal, "_reserve_tts_model_call", fake_reserve)
    monkeypatch.setattr(indextts2_fal, "_confirm_tts_model_call", fake_confirm)
    monkeypatch.setattr(indextts2_fal, "_refund_tts_model_call", fake_refund)

    client = IndexTTS2FalClient(
        provider="newapi",
        api_key="newapi-test-key",
        endpoint="http://newapi.test/v1",
        model="LingShan-TTS-2",
        timeout_seconds=12,
    )
    result = await client.generate(
        prompt="测试",
        audio_url="data:audio/wav;base64,abc",
        output_path=tmp_path / "beat_03.mp3",
    )

    assert result.success is False
    assert refunded == [
        {
            "reservation_id": "reservation_1",
            "source": "indextts2_newapi",
            "error": "DramaClawAPI IndexTTS2 response missing audio bytes or URL",
            "provider_request_id": "req_tts_1",
        }
    ]


@pytest.mark.asyncio
async def test_indextts2_reraises_insufficient_credit(monkeypatch, tmp_path):
    import novelvideo.generators.indextts2_fal as indextts2_fal

    from novelvideo.generators.indextts2_fal import IndexTTS2FalClient

    async def fake_reserve(model, *, source):
        raise InsufficientCreditsError(user_id="usr_1", cost=3, balance=0)

    monkeypatch.setattr(indextts2_fal, "_reserve_tts_model_call", fake_reserve)

    client = IndexTTS2FalClient(
        provider="newapi",
        api_key="newapi-test-key",
        endpoint="http://newapi.test/v1",
        model="LingShan-TTS-2",
        timeout_seconds=12,
    )

    with pytest.raises(InsufficientCreditsError):
        await client.generate(
            prompt="测试",
            audio_url="data:audio/wav;base64,abc",
            output_path=tmp_path / "beat_03.mp3",
        )


@pytest.mark.asyncio
async def test_indextts2_fal_returns_failure_without_api_key(tmp_path):
    from novelvideo.generators.indextts2_fal import IndexTTS2FalClient

    result = await IndexTTS2FalClient(provider="fal", api_key="").generate(
        prompt="测试",
        audio_url="https://example.com/reference.wav",
        output_path=Path(tmp_path / "out.mp3"),
    )

    assert result.success is False
    assert "FAL_KEY" in (result.error or "")
