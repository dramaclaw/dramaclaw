from __future__ import annotations

import base64

import pytest

from novelvideo.generators import image_generator
from novelvideo.shared.billing_errors import BillingError, InsufficientCreditsError

pytestmark = pytest.mark.m04


class _ForeignBillingError(BillingError):
    def __init__(self, **_kwargs) -> None:
        super().__init__("foreign billing error")


class FakeResponse:
    status_code = 200
    text = ""
    headers = {"x-oneapi-request-id": "req_image_1"}

    def __init__(self, payload):
        self._payload = payload

    def json(self):
        return self._payload


class FakeAsyncClient:
    def __init__(self, payload, *_args, **_kwargs):
        self.payload = payload

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return None

    async def post(self, *_args, **_kwargs):
        return FakeResponse(self.payload)


def _generator() -> image_generator.VolcengineImageGenerator:
    generator = image_generator.VolcengineImageGenerator.__new__(
        image_generator.VolcengineImageGenerator
    )
    generator.api_key = "key"
    generator.endpoint = "http://example.test/v1"
    generator.seedream_model = "seedream-test"
    generator.seededit_model = "seededit-test"
    generator.default_width = 1024
    generator.default_height = 1024
    generator.default_style = "chinese_period_drama"
    return generator


@pytest.mark.asyncio
async def test_seedream_request_confirms_reserved_credit(monkeypatch, tmp_path):
    reserved: list[dict] = []
    confirmed: list[dict] = []
    refunded: list[dict] = []
    image_payload = base64.b64encode(b"image").decode()

    async def fake_reserve(model, *, source):
        reserved.append({"model": model, "source": source})
        return "reservation_1"

    async def fake_confirm(**kwargs):
        confirmed.append(kwargs)

    async def fake_refund(reservation_id, *, source, error):
        refunded.append({"reservation_id": reservation_id, "source": source, "error": error})

    monkeypatch.setattr(image_generator, "_reserve_image_model_call", fake_reserve)
    monkeypatch.setattr(image_generator, "_confirm_image_model_call", fake_confirm)
    monkeypatch.setattr(image_generator, "_refund_image_model_call", fake_refund)
    monkeypatch.setattr(
        image_generator.httpx,
        "AsyncClient",
        lambda *args, **kwargs: FakeAsyncClient(
            {"id": "resp_image_1", "data": [{"b64_json": image_payload}]},
            *args,
            **kwargs,
        ),
    )

    result = await _generator().generate_with_request(
        image_generator.ImageGenerationRequest(prompt="test"),
        str(tmp_path / "out.png"),
    )

    assert result.success is True
    assert reserved == [{"model": "seedream-test", "source": "seedream_image_request_api"}]
    assert confirmed == [
        {
            "model": "seedream-test",
            "reservation_id": "reservation_1",
            "provider_request_id": "req_image_1",
            "response_id": "resp_image_1",
        }
    ]
    assert refunded == []


@pytest.mark.asyncio
async def test_seedream_request_refunds_reserved_credit_on_missing_image(monkeypatch, tmp_path):
    refunded: list[dict] = []

    async def fake_reserve(model, *, source):
        return "reservation_1"

    async def fake_confirm(**_kwargs):
        raise AssertionError("confirm should not be called")

    async def fake_refund(reservation_id, *, source, error):
        refunded.append({"reservation_id": reservation_id, "source": source, "error": error})

    monkeypatch.setattr(image_generator, "_reserve_image_model_call", fake_reserve)
    monkeypatch.setattr(image_generator, "_confirm_image_model_call", fake_confirm)
    monkeypatch.setattr(image_generator, "_refund_image_model_call", fake_refund)
    monkeypatch.setattr(
        image_generator.httpx,
        "AsyncClient",
        lambda *args, **kwargs: FakeAsyncClient(
            {"id": "resp_image_1", "data": [{"b64_json": ""}]},
            *args,
            **kwargs,
        ),
    )

    result = await _generator().generate_with_request(
        image_generator.ImageGenerationRequest(prompt="test"),
        str(tmp_path / "out.png"),
    )

    assert result.success is False
    assert refunded == [
        {
            "reservation_id": "reservation_1",
            "source": "seedream_image_request_api",
            "error": "missing_image_data",
        }
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "InsufficientCreditsError",
    [
        InsufficientCreditsError,
        _ForeignBillingError,
    ],
    ids=["personal", "foreign"],
)
async def test_seedream_request_reraises_insufficient_credit(
    monkeypatch, tmp_path, InsufficientCreditsError
):
    async def fake_reserve(model, *, source):
        raise InsufficientCreditsError(user_id="usr_1", cost=5, balance=0)

    async def fake_refund(*_args, **_kwargs):
        return None

    monkeypatch.setattr(image_generator, "_reserve_image_model_call", fake_reserve)
    monkeypatch.setattr(image_generator, "_refund_image_model_call", fake_refund)

    with pytest.raises(InsufficientCreditsError):
        await _generator().generate_with_request(
            image_generator.ImageGenerationRequest(prompt="test"),
            str(tmp_path / "out.png"),
        )
