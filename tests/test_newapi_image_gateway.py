import base64
import importlib
import logging

import pytest

from novelvideo.shared.billing_errors import InsufficientCreditsError

pytestmark = pytest.mark.m04


def _isolate_settings_db(monkeypatch, tmp_path):
    import novelvideo.config as config

    state_dir = str(tmp_path / "state")
    monkeypatch.delenv("MODEL_GATEWAY_MODE", raising=False)
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", state_dir)
    monkeypatch.setattr(config, "STATE_DIR", state_dir)


def test_dc_image_2_selection_maps_to_newapi_gpt_image2(monkeypatch, tmp_path):
    _isolate_settings_db(monkeypatch, tmp_path)
    monkeypatch.setenv("NEWAPI_API_KEY", "newapi-token")
    monkeypatch.setenv("NEWAPI_BASE_URL", "http://newapi.test/v1")
    monkeypatch.setenv("NEWAPI_IMAGE_MODEL", "gpt-image-2")
    monkeypatch.setenv("DEFAULT_CHARACTER_IMAGE_SELECTION", "newapi_gpt_image2")

    import novelvideo.config as config

    config = importlib.reload(config)

    assert config.character_image_selection_options()["newapi_gpt_image2"] == "DC-Image-2"
    assert config.get_character_image_selection() == "newapi_gpt_image2"

    image_config = config.get_grid_generation_config(selection_override="newapi_gpt_image2")
    assert image_config["provider"] == "newapi"
    assert image_config["api_key"] == "newapi-token"
    assert image_config["base_url"] == "http://newapi.test/v1"
    assert image_config["model"] == "gpt-image-2"


def test_dc_banana_2_selection_maps_to_newapi_nanobanana2(monkeypatch, tmp_path):
    _isolate_settings_db(monkeypatch, tmp_path)
    monkeypatch.setenv("NEWAPI_API_KEY", "newapi-token")
    monkeypatch.setenv("NEWAPI_BASE_URL", "http://newapi.test/v1")
    monkeypatch.setenv("NEWAPI_NANOBANANA2_MODEL", "nano-banana-2")
    monkeypatch.setenv("DEFAULT_CHARACTER_IMAGE_SELECTION", "newapi_nanobanana2")

    import novelvideo.config as config

    config = importlib.reload(config)

    assert config.character_image_selection_options()["newapi_nanobanana2"] == "DC-Banana-2"
    assert config.get_character_image_selection() == "newapi_nanobanana2"

    image_config = config.get_grid_generation_config(selection_override="newapi_nanobanana2")
    assert image_config["provider"] == "newapi"
    assert image_config["api_key"] == "newapi-token"
    assert image_config["base_url"] == "http://newapi.test/v1"
    assert image_config["model"] == "nano-banana-2"


def test_fixed_asset_image_providers_default_to_newapi_when_env_is_empty(monkeypatch):
    for key in (
        "PROP_REF_IMAGE_PROVIDER",
        "SCENE_MASTER_IMAGE_PROVIDER",
        "SCENE_REVERSE_MASTER_IMAGE_PROVIDER",
        "SCENE_360_IMAGE_PROVIDER",
    ):
        monkeypatch.setenv(key, "")
    monkeypatch.setenv("NEWAPI_IMAGE_MODEL", "gpt-image-2")

    import novelvideo.config as config

    config = importlib.reload(config)

    assert config.PROP_REF_IMAGE_PROVIDER == "newapi"
    assert config.SCENE_MASTER_IMAGE_PROVIDER == "newapi"
    assert config.SCENE_REVERSE_MASTER_IMAGE_PROVIDER == "newapi"
    assert config.SCENE_360_IMAGE_PROVIDER == "newapi"

    from novelvideo.generators import nanobanana_prop, scene_reference_images

    nanobanana_prop = importlib.reload(nanobanana_prop)
    scene_reference_images = importlib.reload(scene_reference_images)

    assert nanobanana_prop.resolve_prop_reference_image_model() == "gpt-image-2"
    assert scene_reference_images._scene_image_provider("master", None) == "newapi"
    assert scene_reference_images._scene_image_provider("reverse_master", None) == "newapi"


def test_newapi_sketch_config_defaults_to_dc_image2_low_quality(monkeypatch):
    import httpx
    import novelvideo.config as config
    from novelvideo.generators import nanobanana_grid

    posted = {}

    class FakeResponse:
        headers = {"x-newapi-request-id": "req-sketch"}

        def raise_for_status(self):
            return None

        def json(self):
            return {
                "id": "resp-sketch",
                "data": [{"b64_json": base64.b64encode(b"sketch").decode()}],
            }

    class FakeAsyncClient:
        def __init__(self, *args, **kwargs):
            posted["timeout"] = kwargs.get("timeout")

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return None

        async def post(self, url, *, headers, json):
            posted["json"] = json
            return FakeResponse()

    monkeypatch.setenv("NEWAPI_API_KEY", "newapi-token")
    monkeypatch.setenv("NEWAPI_BASE_URL", "http://newapi.test/v1")
    monkeypatch.setenv("NEWAPI_IMAGE_MODEL", "gpt-image-2")
    monkeypatch.setenv("DEFAULT_SKETCH_IMAGE_SELECTION", "newapi_gpt_image2")
    monkeypatch.setattr(httpx, "AsyncClient", FakeAsyncClient)

    config = importlib.reload(config)
    sketch_config = config.get_sketch_generation_config()

    assert sketch_config["provider"] == "newapi"
    assert sketch_config["model"] == "gpt-image-2"
    assert sketch_config["image_size"] == "1K"
    assert sketch_config["openai_image_quality"] == "low"

    trace = {}
    image_bytes, _text, error = run_async(
        nanobanana_grid._call_newapi_image_api(
            api_key=sketch_config["api_key"],
            model=sketch_config["model"],
            prompt="sketch prompt",
            image_config={
                "aspect_ratio": "2:3",
                "image_size": sketch_config["image_size"],
                "quality": sketch_config["openai_image_quality"],
            },
            base_url=sketch_config["base_url"],
            trace=trace,
        )
    )

    assert image_bytes == b"sketch"
    assert error == ""
    assert posted["timeout"] == nanobanana_grid.NEWAPI_IMAGE_HTTP_TIMEOUT_SECONDS == 1800.0
    assert posted["json"]["model"] == "gpt-image-2"
    assert posted["json"]["quality"] == "low"
    assert posted["json"]["extra_fields"] == {
        "aspect_ratio": "2:3",
        "image_size": "1K",
        "resolution": "1k",
        "quality": "low",
    }
    assert trace == {"request_id": "req-sketch", "response_id": "resp-sketch"}


def test_newapi_sketch_config_can_use_dc_banana2_without_quality(monkeypatch):
    import httpx
    import novelvideo.config as config
    from novelvideo.generators import nanobanana_grid

    posted = {}

    class FakeResponse:
        def raise_for_status(self):
            return None

        def json(self):
            return {"data": [{"b64_json": base64.b64encode(b"sketch").decode()}]}

    class FakeAsyncClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return None

        async def post(self, url, *, headers, json):
            posted["json"] = json
            return FakeResponse()

    monkeypatch.setenv("NEWAPI_API_KEY", "newapi-token")
    monkeypatch.setenv("NEWAPI_BASE_URL", "http://newapi.test/v1")
    monkeypatch.setenv("NEWAPI_NANOBANANA2_MODEL", "nano-banana-2")
    monkeypatch.setenv("DEFAULT_SKETCH_IMAGE_SELECTION", "newapi_nanobanana2")
    monkeypatch.setattr(httpx, "AsyncClient", FakeAsyncClient)

    config = importlib.reload(config)
    sketch_config = config.get_sketch_generation_config()

    assert sketch_config["provider"] == "newapi"
    assert sketch_config["model"] == "nano-banana-2"
    assert sketch_config["image_size"] == "1K"

    image_bytes, _text, error = run_async(
        nanobanana_grid._call_newapi_image_api(
            api_key=sketch_config["api_key"],
            model=sketch_config["model"],
            prompt="sketch prompt",
            image_config={
                "aspect_ratio": "2:3",
                "image_size": sketch_config["image_size"],
                "quality": sketch_config["openai_image_quality"],
            },
            base_url=sketch_config["base_url"],
        )
    )

    assert image_bytes == b"sketch"
    assert error == ""
    assert posted["json"]["model"] == "nano-banana-2"
    assert "quality" not in posted["json"]
    assert posted["json"]["extra_fields"] == {
        "aspect_ratio": "2:3",
        "image_size": "1K",
        "resolution": "1k",
    }


def test_newapi_image_call_sends_gpt_image2_params(monkeypatch):
    import httpx
    from novelvideo.generators import nanobanana_grid

    posted = {}

    class FakeResponse:
        def raise_for_status(self):
            return None

        def json(self):
            return {"data": [{"b64_json": base64.b64encode(b"image-bytes").decode()}]}

    class FakeAsyncClient:
        def __init__(self, *args, **kwargs):
            self.kwargs = kwargs

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return None

        async def post(self, url, *, headers, json):
            posted["url"] = url
            posted["headers"] = headers
            posted["json"] = json
            return FakeResponse()

    monkeypatch.setattr(httpx, "AsyncClient", FakeAsyncClient)

    image_bytes, _text, error = run_async(
        nanobanana_grid._call_newapi_image_api(
            api_key="newapi-token",
            model="gpt-image-2",
            prompt="portrait prompt",
            image_config={
                "aspect_ratio": "3:4",
                "image_size": "0.5K",
                "quality": "medium",
            },
            base_url="http://newapi.test/v1",
        )
    )

    assert image_bytes == b"image-bytes"
    assert error == ""
    assert posted["url"] == "http://newapi.test/v1/images/generations"
    assert posted["headers"]["Authorization"] == "Bearer newapi-token"
    assert posted["json"]["model"] == "gpt-image-2"
    assert posted["json"]["prompt"] == "portrait prompt"
    assert posted["json"]["quality"] == "medium"
    assert posted["json"]["extra_fields"] == {
        "aspect_ratio": "3:4",
        "image_size": "1K",
        "resolution": "1k",
        "quality": "medium",
    }


def test_newapi_image_call_reports_transport_exception_type(monkeypatch):
    import httpx
    from novelvideo.generators import nanobanana_grid

    class FakeAsyncClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return None

        async def post(self, url, *, headers, json):
            raise httpx.ReadTimeout("")

    monkeypatch.setattr(httpx, "AsyncClient", FakeAsyncClient)

    image_bytes, _text, error = run_async(
        nanobanana_grid._call_newapi_image_api(
            api_key="newapi-token",
            model="gpt-image-2",
            prompt="portrait prompt",
            image_config={"aspect_ratio": "16:9", "image_size": "1K"},
            base_url="http://newapi.test/v1",
        )
    )

    assert image_bytes is None
    assert "请求异常: ReadTimeout" in error
    assert "endpoint=http://newapi.test/v1" in error
    assert "model=gpt-image-2" in error


def test_newapi_image_call_reraises_insufficient_credit(monkeypatch):
    from novelvideo.generators import nanobanana_grid

    class FakeUsageMeter:
        async def reserve_current_model_call_credit(self, **_kwargs):
            raise InsufficientCreditsError(user_id="usr_1", cost=5, balance=0)

    monkeypatch.setattr(nanobanana_grid, "get_usage_meter", lambda: FakeUsageMeter())

    with pytest.raises(InsufficientCreditsError):
        run_async(
            nanobanana_grid._call_newapi_image_api(
                api_key="newapi-token",
                model="gpt-image-2",
                prompt="portrait prompt",
                base_url="http://newapi.test/v1",
            )
        )


def test_newapi_sketch_grid_reraises_insufficient_credit(monkeypatch, tmp_path):
    from novelvideo.generators import nanobanana_grid

    async def fake_call_newapi_image_api(**_kwargs):
        raise InsufficientCreditsError(user_id="usr_1", cost=5, balance=0)

    monkeypatch.setattr(
        nanobanana_grid,
        "_call_newapi_image_api",
        fake_call_newapi_image_api,
    )

    generator = nanobanana_grid.NanoBananaGridGenerator(
        api_key="newapi-token",
        config={
            "provider": "newapi",
            "api_key": "newapi-token",
            "base_url": "http://newapi.test/v1",
            "model": "gpt-image-2",
            "rows": 1,
            "cols": 1,
            "batch_size": 1,
            "total_panels": 1,
            "mode": "1x1",
            "image_size": "1K",
            "openai_sketch_image_quality": "low",
        },
    )

    with pytest.raises(InsufficientCreditsError):
        run_async(
            generator.generate_grid(
                beats=[
                    {
                        "beat_number": 3,
                        "visual_description": "女主站在竹林中回头。",
                        "narration": "她终于察觉身后有人。",
                    }
                ],
                character_map={},
                style="chinese_period_drama",
                output_path=str(tmp_path / "sketch.png"),
                rows=1,
                cols=1,
                sketch=True,
                mode_key="1x1_2-3_sketch",
                location_beat_numbers=[3],
            )
        )


def test_newapi_image_call_omits_quality_for_nanobanana2(monkeypatch):
    import httpx
    from novelvideo.generators import nanobanana_grid

    posted = {}

    class FakeResponse:
        def raise_for_status(self):
            return None

        def json(self):
            return {"data": [{"b64_json": base64.b64encode(b"image-bytes").decode()}]}

    class FakeAsyncClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return None

        async def post(self, url, *, headers, json):
            posted["json"] = json
            return FakeResponse()

    monkeypatch.setattr(httpx, "AsyncClient", FakeAsyncClient)

    image_bytes, _text, error = run_async(
        nanobanana_grid._call_newapi_image_api(
            api_key="newapi-token",
            model="nano-banana-2",
            prompt="portrait prompt",
            image_config={
                "aspect_ratio": "3:4",
                "image_size": "1K",
                "quality": "medium",
            },
            base_url="http://newapi.test/v1",
        )
    )

    assert image_bytes == b"image-bytes"
    assert error == ""
    assert posted["json"]["model"] == "nano-banana-2"
    assert "quality" not in posted["json"]
    assert posted["json"]["extra_fields"] == {
        "aspect_ratio": "3:4",
        "image_size": "1K",
        "resolution": "1k",
    }


def test_newapi_image_call_relays_reference_images(monkeypatch):
    import httpx
    from novelvideo.generators import nanobanana_grid

    posted = {}
    relayed = []

    class FakeResponse:
        def raise_for_status(self):
            return None

        def json(self):
            return {"data": [{"b64_json": base64.b64encode(b"image-bytes").decode()}]}

    class FakeAsyncClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return None

        async def post(self, url, *, headers, json):
            posted["json"] = json
            return FakeResponse()

    def fake_upload_image_bytes(data, *, ext="png", ttl=None, image_transform=None):
        relayed.append((data, ext, ttl, image_transform))
        return f"https://relay.test/{len(relayed)}.png"

    monkeypatch.setattr(httpx, "AsyncClient", FakeAsyncClient)
    monkeypatch.setattr(nanobanana_grid, "upload_image_bytes", fake_upload_image_bytes)

    image_bytes, _text, error = run_async(
        nanobanana_grid._call_newapi_image_api(
            api_key="newapi-token",
            model="gpt-image-2",
            prompt="identity prompt",
            reference_images=[b"ref-a", b"ref-b"],
            image_config={"aspect_ratio": "3:4", "image_size": "1K", "quality": "medium"},
            base_url="http://newapi.test/v1",
        )
    )

    assert image_bytes == b"image-bytes"
    assert error == ""
    assert relayed == [
        (b"ref-a", "png", None, nanobanana_grid.IMAGE_TRANSFORM_AI_REFERENCE_JPEG),
        (b"ref-b", "png", None, nanobanana_grid.IMAGE_TRANSFORM_AI_REFERENCE_JPEG),
    ]
    assert posted["json"]["images"] == [
        "https://relay.test/1.png",
        "https://relay.test/2.png",
    ]


def test_newapi_image_call_preserves_reference_image_extensions(monkeypatch):
    import httpx
    from novelvideo.generators import nanobanana_grid

    relayed = []

    class FakeResponse:
        def raise_for_status(self):
            return None

        def json(self):
            return {"data": [{"b64_json": base64.b64encode(b"image-bytes").decode()}]}

    class FakeAsyncClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return None

        async def post(self, url, *, headers, json):
            return FakeResponse()

    def fake_upload_image_bytes(data, *, ext="png", ttl=None, image_transform=None):
        relayed.append((data, ext, ttl, image_transform))
        return f"https://relay.test/{len(relayed)}.{ext}"

    monkeypatch.setattr(httpx, "AsyncClient", FakeAsyncClient)
    monkeypatch.setattr(nanobanana_grid, "upload_image_bytes", fake_upload_image_bytes)

    image_bytes, _text, error = run_async(
        nanobanana_grid._call_newapi_image_api(
            api_key="newapi-token",
            model="gpt-image-2",
            prompt="identity prompt",
            reference_images=[
                ("face.jpg", b"jpg-bytes", "image/jpeg"),
                (b"webp-bytes", "image/webp"),
            ],
            image_config={"aspect_ratio": "3:4", "image_size": "1K", "quality": "medium"},
            base_url="http://newapi.test/v1",
        )
    )

    assert image_bytes == b"image-bytes"
    assert error == ""
    assert relayed == [
        (b"jpg-bytes", "jpg", None, nanobanana_grid.IMAGE_TRANSFORM_AI_REFERENCE_JPEG),
        (b"webp-bytes", "webp", None, nanobanana_grid.IMAGE_TRANSFORM_AI_REFERENCE_JPEG),
    ]


def test_newapi_image_http_error_logs_redacted_request_context(monkeypatch, caplog):
    import httpx
    from novelvideo.generators import nanobanana_grid

    posted = {}
    refunds = []

    class FakeResponse:
        status_code = 400
        text = '{"error":{"message":"openai_error","type":"bad_response_status_code"}}'
        headers = {
            "x-newapi-request-id": "req-123",
            "cf-ray": "cf-ray-456",
            "date": "Fri, 22 May 2026 03:00:00 GMT",
            "authorization": "Bearer should-not-leak",
        }

        def raise_for_status(self):
            raise httpx.HTTPStatusError(
                "bad response",
                request=httpx.Request("POST", "http://newapi.test/v1/images/generations"),
                response=self,
            )

    class FakeAsyncClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return None

        async def post(self, url, *, headers, json):
            posted["url"] = url
            posted["headers"] = headers
            posted["json"] = json
            return FakeResponse()

    def fake_upload_image_bytes(data, *, ext="png", ttl=None, image_transform=None):
        return f"https://relay.test/signed-{data.decode()}?token=secret"

    class FakeUsageMeter:
        async def reserve_current_model_call_credit(self, **_kwargs):
            return "reservation_1"

        async def refund_model_call_credit_reservation(self, reservation_id, *, metadata=None):
            refunds.append({"reservation_id": reservation_id, "metadata": metadata or {}})

    monkeypatch.setattr(httpx, "AsyncClient", FakeAsyncClient)
    monkeypatch.setattr(nanobanana_grid, "upload_image_bytes", fake_upload_image_bytes)
    monkeypatch.setattr(nanobanana_grid, "get_usage_meter", lambda: FakeUsageMeter())
    caplog.set_level(logging.WARNING, logger="novelvideo.generators.nanobanana_grid")

    image_bytes, _text, error = run_async(
        nanobanana_grid._call_newapi_image_api(
            api_key="newapi-token",
            model="gpt-image-2",
            prompt="sensitive prompt body",
            reference_images=[b"ref-a"],
            image_config={"aspect_ratio": "2:1", "image_size": "2K", "quality": "medium"},
            base_url="http://newapi.test/v1",
        )
    )

    log_text = "\n".join(record.getMessage() for record in caplog.records)

    assert image_bytes is None
    assert "request_id=req-123" in error
    assert "cf-ray-456" in error
    assert "model=gpt-image-2" in error
    assert "extra_fields" in error
    assert "reference_image_count=1" in error
    assert "request_id=req-123" in log_text
    assert "http://newapi.test/v1/images/generations" in log_text
    assert "prompt_sha256=" in log_text
    assert "sensitive prompt body" not in error
    assert "sensitive prompt body" not in log_text
    assert "newapi-token" not in error
    assert "newapi-token" not in log_text
    assert "token=secret" not in error
    assert "token=secret" not in log_text
    assert refunds == [
        {
            "reservation_id": "reservation_1",
            "metadata": {
                "source": "newapi_image_api",
                "error": "HTTP 400",
                "request_id": "req-123",
                "http_status": 400,
                "response_headers": {
                    "x-newapi-request-id": "req-123",
                    "cf-ray": "cf-ray-456",
                    "date": "Fri, 22 May 2026 03:00:00 GMT",
                },
            },
        }
    ]


def test_newapi_image_http_5xx_does_not_retry_in_app(monkeypatch):
    import httpx
    from novelvideo.generators import nanobanana_grid

    attempts = 0

    class FailingResponse:
        status_code = 502
        text = '{"error":{"message":"error","type":"bad_response"}}'
        headers = {"x-oneapi-request-id": "req-fail"}

        def raise_for_status(self):
            raise httpx.HTTPStatusError(
                "bad gateway",
                request=httpx.Request("POST", "http://newapi.test/v1/images/generations"),
                response=self,
            )

    class FakeAsyncClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return None

        async def post(self, url, *, headers, json):
            nonlocal attempts
            attempts += 1
            return FailingResponse()

    monkeypatch.setattr(httpx, "AsyncClient", FakeAsyncClient)

    image_bytes, _text, error = run_async(
        nanobanana_grid._call_newapi_image_api(
            api_key="newapi-token",
            model="gpt-image-2",
            prompt="retry prompt",
            image_config={"aspect_ratio": "2:1", "image_size": "2K", "quality": "medium"},
            base_url="http://newapi.test/v1",
        )
    )

    assert image_bytes is None
    assert "HTTP 502" in error
    assert "request_id=req-fail" in error
    assert attempts == 1


def test_newapi_identity_image_sends_portrait_then_costume_references(
    monkeypatch,
    tmp_path,
):
    from novelvideo.generators import nanobanana_character

    captured = {}

    async def fake_call_newapi_image_api(**kwargs):
        captured.update(kwargs)
        return b"identity-image", "", ""

    monkeypatch.setattr(
        nanobanana_character,
        "_call_newapi_image_api",
        fake_call_newapi_image_api,
    )

    generator = nanobanana_character.NanoBananaCharacterGenerator(
        config={
            "provider": "newapi",
            "api_key": "newapi-token",
            "model": "nano-banana-2",
            "base_url": "http://newapi.test/v1",
        }
    )
    output_path = tmp_path / "identity_body_temp.png"

    image_bytes = run_async(
        generator._generate_with_reference(
            client=None,
            prompt="identity prompt",
            reference_image=None,
            output_path=str(output_path),
            reference_image_bytes=b"portrait-bytes",
            reference_image_name="/project/characters/李雷/reference_portrait.jpg",
            aspect_ratio="16:9",
            image_size="1K",
            additional_image_bytes=[b"costume-bytes"],
            additional_image_names=["/project/characters/李雷/学生_costume.png"],
        )
    )

    assert image_bytes == b"identity-image"
    assert output_path.read_bytes() == b"identity-image"
    assert captured["model"] == "nano-banana-2"
    assert captured["base_url"] == "http://newapi.test/v1"
    assert captured["image_config"] == {
        "aspect_ratio": "16:9",
        "image_size": "1K",
        "quality": "medium",
    }
    assert captured["reference_images"] == [
        ("reference_portrait.jpg", b"portrait-bytes", "image/jpeg"),
        ("学生_costume.png", b"costume-bytes", "image/png"),
    ]


def test_newapi_character_portrait_reraises_insufficient_credit(monkeypatch, tmp_path):
    from novelvideo.generators import nanobanana_character

    async def fake_call_newapi_image_api(**_kwargs):
        raise InsufficientCreditsError(user_id="usr_1", cost=5, balance=0)

    monkeypatch.setattr(
        nanobanana_character,
        "_call_newapi_image_api",
        fake_call_newapi_image_api,
    )

    generator = nanobanana_character.NanoBananaCharacterGenerator(
        config={
            "provider": "newapi",
            "api_key": "newapi-token",
            "model": "gpt-image-2",
            "base_url": "http://newapi.test/v1",
        }
    )

    with pytest.raises(InsufficientCreditsError):
        run_async(
            generator.generate_character_portrait(
                character_name="李雷",
                character_prompt="young man",
                output_dir=str(tmp_path),
            )
        )


def test_newapi_character_portrait_raise_on_error_preserves_provider_detail(monkeypatch, tmp_path):
    import novelvideo.config as config
    from novelvideo.generators import image_generator, nanobanana_character

    async def fake_call_newapi_image_api(**_kwargs):
        return None, "", "HTTP 504: request_id=req-123; body=provider timeout"

    monkeypatch.setenv("NEWAPI_API_KEY", "newapi-token")
    monkeypatch.setenv("NEWAPI_BASE_URL", "http://newapi.test/v1")
    monkeypatch.setenv("NEWAPI_IMAGE_MODEL", "gpt-image-2")
    monkeypatch.setenv("DEFAULT_CHARACTER_IMAGE_SELECTION", "newapi_gpt_image2")
    importlib.reload(config)
    monkeypatch.setattr(
        nanobanana_character,
        "_call_newapi_image_api",
        fake_call_newapi_image_api,
    )

    with pytest.raises(RuntimeError, match="HTTP 504: request_id=req-123"):
        run_async(
            image_generator.generate_character_reference_unified(
                character_name="李雷",
                appearance_prompt="young man",
                output_dir=str(tmp_path),
                count=1,
                model="newapi_gpt_image2",
                raise_on_error=True,
            )
        )


def test_newapi_scene_master_uses_text_only_nanobanana2(monkeypatch, tmp_path):
    _isolate_settings_db(monkeypatch, tmp_path)
    from novelvideo.generators import scene_reference_images
    from novelvideo.models import NovelScene

    captured = {}

    async def fake_call_newapi_image_api(**kwargs):
        captured.update(kwargs)
        return b"scene-master", "", ""

    monkeypatch.setenv("NEWAPI_API_KEY", "newapi-token")
    monkeypatch.setenv("NEWAPI_BASE_URL", "http://newapi.test/v1")
    monkeypatch.setenv("SCENE_MASTER_IMAGE_PROVIDER", "newapi")
    monkeypatch.setenv("SCENE_MASTER_IMAGE_MODEL", "nano-banana-2")
    monkeypatch.setattr(
        scene_reference_images,
        "_call_newapi_image_api",
        fake_call_newapi_image_api,
    )
    monkeypatch.setattr(scene_reference_images, "NEWAPI_API_KEY", "newapi-token")
    monkeypatch.setattr(scene_reference_images, "NEWAPI_BASE_URL", "http://newapi.test/v1")
    monkeypatch.setattr(scene_reference_images, "SCENE_MASTER_IMAGE_PROVIDER", "newapi")
    monkeypatch.setattr(scene_reference_images, "SCENE_MASTER_IMAGE_MODEL", "nano-banana-2")

    scene = NovelScene(
        name="古董店",
        scene_type="interior",
        environment_prompt="从店门可以直接看到收银台，周围堆放着一些古董",
    )

    output_path = run_async(
        scene_reference_images.generate_scene_reference_image(
            project_dir=tmp_path,
            scene=scene,
            kind="master",
            style_name="live_action",
            style_prompt="grounded realism",
            avoid_instructions="no people",
        )
    )

    assert output_path == tmp_path / "assets" / "scenes" / "古董店" / "master.png"
    assert output_path.read_bytes() == b"scene-master"
    assert captured["api_key"] == "newapi-token"
    assert captured["base_url"] == "http://newapi.test/v1"
    assert captured["model"] == "nano-banana-2"
    assert captured["reference_images"] is None
    assert captured["image_config"] == {
        "aspect_ratio": "16:9",
        "image_size": "1K",
        "output_format": "png",
    }
    assert "SCENE NAME: 古董店" in captured["prompt"]
    assert "从店门可以直接看到收银台" in captured["prompt"]


def test_newapi_scene_time_plate_master_injects_time_and_base_reference(monkeypatch, tmp_path):
    from novelvideo.generators import scene_reference_images
    from novelvideo.models import NovelScene

    captured = {}

    async def fake_call_newapi_image_api(**kwargs):
        captured.update(kwargs)
        return b"scene-night-master", "", ""

    base_master_path = tmp_path / "assets" / "scenes" / "古董店" / "master.png"
    base_master_path.parent.mkdir(parents=True)
    base_master_path.write_bytes(b"base-master-bytes")

    monkeypatch.setattr(
        scene_reference_images,
        "_call_newapi_image_api",
        fake_call_newapi_image_api,
    )
    monkeypatch.setattr(scene_reference_images, "NEWAPI_API_KEY", "newapi-token")
    monkeypatch.setattr(scene_reference_images, "NEWAPI_BASE_URL", "http://newapi.test/v1")
    monkeypatch.setattr(scene_reference_images, "SCENE_MASTER_IMAGE_PROVIDER", "newapi")
    monkeypatch.setattr(scene_reference_images, "SCENE_MASTER_IMAGE_MODEL", "nano-banana-2")

    scene = NovelScene(
        name="古董店_夜晚",
        base_scene_id="古董店",
        time_of_day="夜晚",
        scene_type="interior",
        environment_prompt="正面：收银台与古董柜\n光源：中性基础光",
    )

    output_path = run_async(
        scene_reference_images.generate_scene_reference_image(
            project_dir=tmp_path,
            scene=scene,
            kind="master",
        )
    )

    assert output_path == tmp_path / "assets" / "scenes" / "古董店_夜晚" / "master.png"
    assert output_path.read_bytes() == b"scene-night-master"
    assert captured["reference_images"] == [
        ("base_scene_master_master.png", b"base-master-bytes", "image/png")
    ]
    assert "TARGET TIME-OF-DAY PLATE: 夜晚" in captured["prompt"]
    assert "overall lighting must read as 夜晚" in captured["prompt"]
    assert "Keep the same architecture" in captured["prompt"]


def test_newapi_scene_variant_plate_master_keeps_described_lighting(monkeypatch, tmp_path):
    from novelvideo.generators import scene_reference_images
    from novelvideo.models import NovelScene

    captured = {}

    async def fake_call_newapi_image_api(**kwargs):
        captured.update(kwargs)
        return b"scene-variant-master", "", ""

    base_master_path = tmp_path / "assets" / "scenes" / "城市街道" / "master.png"
    base_master_path.parent.mkdir(parents=True)
    base_master_path.write_bytes(b"base-master-bytes")

    monkeypatch.setattr(
        scene_reference_images,
        "_call_newapi_image_api",
        fake_call_newapi_image_api,
    )
    monkeypatch.setattr(scene_reference_images, "NEWAPI_API_KEY", "newapi-token")
    monkeypatch.setattr(scene_reference_images, "NEWAPI_BASE_URL", "http://newapi.test/v1")
    monkeypatch.setattr(scene_reference_images, "SCENE_MASTER_IMAGE_PROVIDER", "newapi")
    monkeypatch.setattr(scene_reference_images, "SCENE_MASTER_IMAGE_MODEL", "nano-banana-2")

    scene = NovelScene(
        name="城市街道_雨夜版",
        base_scene_id="城市街道",
        variant_id="雨夜版",
        scene_type="exterior",
        environment_prompt="正面：湿漉沥青马路\n光源：路灯昏暗，积水反光，雨夜氛围",
    )

    output_path = run_async(
        scene_reference_images.generate_scene_reference_image(
            project_dir=tmp_path,
            scene=scene,
            kind="master",
        )
    )

    assert output_path == tmp_path / "assets" / "scenes" / "城市街道_雨夜版" / "master.png"
    assert captured["reference_images"] == [
        ("base_scene_master_master.png", b"base-master-bytes", "image/png")
    ]
    assert "STRUCTURED VARIANT PLATE" in captured["prompt"]
    assert "variant_id=雨夜版" in captured["prompt"]
    assert "do NOT neutralize" in captured["prompt"]
    # The base-scene neutralizer must not fire for variant plates.
    assert "IGNORE mood/time-of-day phrases" not in captured["prompt"]


def test_newapi_reverse_master_uses_master_reference_nanobanana2(monkeypatch, tmp_path):
    _isolate_settings_db(monkeypatch, tmp_path)
    from novelvideo.generators import scene_reference_images
    from novelvideo.models import NovelScene

    captured = {}

    async def fake_call_newapi_image_api(**kwargs):
        captured.update(kwargs)
        return b"scene-reverse", "", ""

    master_path = tmp_path / "assets" / "scenes" / "古董店" / "master.png"
    master_path.parent.mkdir(parents=True)
    master_path.write_bytes(b"master-bytes")

    monkeypatch.setattr(
        scene_reference_images,
        "_call_newapi_image_api",
        fake_call_newapi_image_api,
    )
    monkeypatch.setattr(scene_reference_images, "NEWAPI_API_KEY", "newapi-token")
    monkeypatch.setattr(scene_reference_images, "NEWAPI_BASE_URL", "http://newapi.test/v1")
    monkeypatch.setattr(scene_reference_images, "SCENE_REVERSE_MASTER_IMAGE_PROVIDER", "newapi")
    monkeypatch.setattr(
        scene_reference_images,
        "SCENE_REVERSE_MASTER_IMAGE_MODEL",
        "nano-banana-2",
    )

    scene = NovelScene(
        name="古董店",
        scene_type="interior",
        environment_prompt="从店门可以直接看到收银台，周围堆放着一些古董",
    )

    output_path = run_async(
        scene_reference_images.generate_scene_reference_image(
            project_dir=tmp_path,
            scene=scene,
            kind="reverse_master",
            style_name="live_action",
            style_prompt="grounded realism",
            avoid_instructions="no people",
        )
    )

    assert output_path == tmp_path / "assets" / "scenes" / "古董店" / "reverse_master.png"
    assert output_path.read_bytes() == b"scene-reverse"
    assert captured["api_key"] == "newapi-token"
    assert captured["base_url"] == "http://newapi.test/v1"
    assert captured["model"] == "nano-banana-2"
    assert captured["reference_images"] == [
        ("scene_master_master.png", b"master-bytes", "image/png")
    ]
    assert captured["image_config"] == {
        "aspect_ratio": "16:9",
        "image_size": "1K",
        "output_format": "png",
    }
    assert "REFERENCE 1 = the scene's FRONT-FACING master" in captured["prompt"]


def test_newapi_reverse_master_can_use_gpt_image2_quality_low(monkeypatch, tmp_path):
    _isolate_settings_db(monkeypatch, tmp_path)
    from novelvideo.generators import scene_reference_images
    from novelvideo.models import NovelScene

    captured = {}

    async def fake_call_newapi_image_api(**kwargs):
        captured.update(kwargs)
        return b"scene-reverse", "", ""

    master_path = tmp_path / "assets" / "scenes" / "古董店" / "master.png"
    master_path.parent.mkdir(parents=True)
    master_path.write_bytes(b"master-bytes")

    monkeypatch.setattr(
        scene_reference_images,
        "_call_newapi_image_api",
        fake_call_newapi_image_api,
    )
    monkeypatch.setattr(scene_reference_images, "NEWAPI_API_KEY", "newapi-token")
    monkeypatch.setattr(scene_reference_images, "NEWAPI_BASE_URL", "http://newapi.test/v1")
    monkeypatch.setattr(scene_reference_images, "SCENE_REVERSE_MASTER_IMAGE_PROVIDER", "newapi")
    monkeypatch.setattr(
        scene_reference_images,
        "SCENE_REVERSE_MASTER_IMAGE_MODEL",
        "gpt-image-2",
    )

    scene = NovelScene(
        name="古董店",
        scene_type="interior",
        environment_prompt="从店门可以直接看到收银台，周围堆放着一些古董",
    )

    run_async(
        scene_reference_images.generate_scene_reference_image(
            project_dir=tmp_path,
            scene=scene,
            kind="reverse_master",
        )
    )

    assert captured["model"] == "gpt-image-2"
    assert captured["reference_images"] == [
        ("scene_master_master.png", b"master-bytes", "image/png")
    ]
    assert captured["image_config"] == {
        "aspect_ratio": "16:9",
        "image_size": "1K",
        "output_format": "png",
        "quality": "low",
    }


def test_newapi_prop_reference_gpt_image2_sends_quality_medium(monkeypatch, tmp_path):
    _isolate_settings_db(monkeypatch, tmp_path)
    import httpx
    import novelvideo.config as config
    from novelvideo.generators import nanobanana_prop

    posted = {}

    class FakeResponse:
        def raise_for_status(self):
            return None

        def json(self):
            return {"data": [{"b64_json": base64.b64encode(b"prop-ref").decode()}]}

    class FakeAsyncClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return None

        async def post(self, url, *, headers, json):
            posted["url"] = url
            posted["headers"] = headers
            posted["json"] = json
            return FakeResponse()

    monkeypatch.setattr(httpx, "AsyncClient", FakeAsyncClient)
    monkeypatch.setenv("NEWAPI_API_KEY", "newapi-token")
    monkeypatch.setenv("NEWAPI_BASE_URL", "http://newapi.test/v1")
    monkeypatch.setenv("PROP_REF_IMAGE_PROVIDER", "newapi")
    monkeypatch.setenv("PROP_REF_IMAGE_MODEL", "gpt-image-2")
    importlib.reload(config)
    nanobanana_prop = importlib.reload(nanobanana_prop)
    monkeypatch.setattr(
        nanobanana_prop,
        "get_grid_generation_config",
        lambda: {"openai_image_quality": "medium"},
    )

    output_path = tmp_path / "assets" / "props" / "玉佩" / "reference_3view.png"
    result = run_async(
        nanobanana_prop.generate_prop_reference(
            visual_prompt="青绿色玉佩，边缘有金色纹路",
            output_path=str(output_path),
        )
    )

    assert result == str(output_path)
    assert output_path.read_bytes() == b"prop-ref"
    assert posted["url"] == "http://newapi.test/v1/images/generations"
    assert posted["headers"]["Authorization"] == "Bearer newapi-token"
    assert posted["json"]["model"] == "gpt-image-2"
    assert posted["json"]["quality"] == "medium"
    assert posted["json"]["extra_fields"] == {
        "aspect_ratio": "16:9",
        "image_size": "1K",
        "resolution": "1k",
        "quality": "medium",
    }


def test_newapi_prop_reference_nanobanana2_omits_quality(monkeypatch, tmp_path):
    _isolate_settings_db(monkeypatch, tmp_path)
    import httpx
    import novelvideo.config as config
    from novelvideo.generators import nanobanana_prop

    posted = {}

    class FakeResponse:
        def raise_for_status(self):
            return None

        def json(self):
            return {"data": [{"b64_json": base64.b64encode(b"prop-ref").decode()}]}

    class FakeAsyncClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return None

        async def post(self, url, *, headers, json):
            posted["json"] = json
            return FakeResponse()

    monkeypatch.setattr(httpx, "AsyncClient", FakeAsyncClient)
    monkeypatch.setenv("NEWAPI_API_KEY", "newapi-token")
    monkeypatch.setenv("NEWAPI_BASE_URL", "http://newapi.test/v1")
    monkeypatch.setenv("PROP_REF_IMAGE_PROVIDER", "newapi")
    monkeypatch.setenv("PROP_REF_IMAGE_MODEL", "nano-banana-2")
    importlib.reload(config)
    nanobanana_prop = importlib.reload(nanobanana_prop)
    monkeypatch.setattr(
        nanobanana_prop,
        "get_grid_generation_config",
        lambda: {"openai_image_quality": "medium"},
    )

    output_path = tmp_path / "assets" / "props" / "玉佩" / "reference_3view.png"
    result = run_async(
        nanobanana_prop.generate_prop_reference(
            visual_prompt="青绿色玉佩，边缘有金色纹路",
            output_path=str(output_path),
        )
    )

    assert result == str(output_path)
    assert output_path.read_bytes() == b"prop-ref"
    assert posted["json"]["model"] == "nano-banana-2"
    assert "quality" not in posted["json"]
    assert posted["json"]["extra_fields"] == {
        "aspect_ratio": "16:9",
        "image_size": "1K",
        "resolution": "1k",
    }


def test_newapi_prop_reference_reraises_insufficient_credit(monkeypatch, tmp_path):
    _isolate_settings_db(monkeypatch, tmp_path)
    import novelvideo.config as config
    from novelvideo.generators import nanobanana_prop

    async def fake_call_newapi_image_api(**_kwargs):
        raise InsufficientCreditsError(user_id="usr_1", cost=5, balance=0)

    monkeypatch.setenv("NEWAPI_API_KEY", "newapi-token")
    monkeypatch.setenv("NEWAPI_BASE_URL", "http://newapi.test/v1")
    monkeypatch.setenv("PROP_REF_IMAGE_PROVIDER", "newapi")
    monkeypatch.setenv("PROP_REF_IMAGE_MODEL", "gpt-image-2")
    importlib.reload(config)
    nanobanana_prop = importlib.reload(nanobanana_prop)
    monkeypatch.setattr(nanobanana_prop, "_call_newapi_image_api", fake_call_newapi_image_api)
    monkeypatch.setattr(
        nanobanana_prop,
        "get_grid_generation_config",
        lambda: {"openai_image_quality": "medium"},
    )

    with pytest.raises(InsufficientCreditsError):
        run_async(
            nanobanana_prop.generate_prop_reference(
                visual_prompt="青绿色玉佩，边缘有金色纹路",
                output_path=str(tmp_path / "reference_3view.png"),
            )
        )


def test_freezone_single_image_generation_routes_newapi(monkeypatch, tmp_path):
    from novelvideo.generators import nanobanana_grid

    captured = {}

    async def fake_call_newapi_image_api(**kwargs):
        captured.update(kwargs)
        return b"freezone-image", "", ""

    monkeypatch.setattr(nanobanana_grid, "_call_newapi_image_api", fake_call_newapi_image_api)

    output_path = tmp_path / "freezone.png"
    image_path = run_async(
        nanobanana_grid.generate_text_to_image(
            prompt="freezone prompt",
            output_path=str(output_path),
            aspect_ratio="1:1",
            image_size="2K",
            quality="medium",
            config={
                "provider": "newapi",
                "api_key": "newapi-token",
                "model": "gpt-image-2",
                "base_url": "http://newapi.test/v1",
                "openai_image_quality": "medium",
                "openai_sketch_image_quality": "low",
                "image_size": "2K",
                "mode": "1x1",
                "rows": 1,
                "cols": 1,
                "total_panels": 1,
            },
        )
    )

    assert image_path == output_path
    assert output_path.read_bytes() == b"freezone-image"
    assert captured["api_key"] == "newapi-token"
    assert captured["model"] == "gpt-image-2"
    assert captured["prompt"] == "freezone prompt"
    assert captured["reference_images"] is None
    assert captured["base_url"] == "http://newapi.test/v1"
    assert captured["image_config"] == {
        "aspect_ratio": "1:1",
        "image_size": "2K",
        "quality": "medium",
    }


def run_async(coro):
    import asyncio

    return asyncio.run(coro)
