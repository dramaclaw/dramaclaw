from __future__ import annotations

from dataclasses import replace
from io import BytesIO
from types import SimpleNamespace

import httpx
import pytest
import requests
from PIL import Image

from novelvideo.model_gateway_settings import EffectiveMediaRelayConfig
from novelvideo.ports.local.usage import NoOpUsageMeter
from novelvideo.storage import media_preflight as preflight


@pytest.fixture
def storage_config():
    return EffectiveMediaRelayConfig(
        source="database",
        provider="aliyun_oss",
        ttl_seconds=1800,
        endpoint="oss-cn-test.aliyuncs.com",
        bucket="test-relay",
        access_key_id="test-access-key",
        access_key_secret="test-secret",
        cloud_name="test-cloud",
        cloudinary_api_key="cloud-key",
        cloudinary_api_secret="cloud-secret",
    )


def _encoded_image(*, mode="L", size=(1, 1), color=255):
    output = BytesIO()
    Image.new(mode, size, color).save(output, format="PNG")
    return output.getvalue()


def test_probe_is_a_valid_png_with_correct_checksums():
    with Image.open(BytesIO(preflight._PROBE_PNG)) as image:
        image.verify()
    with Image.open(BytesIO(preflight._PROBE_PNG)) as image:
        assert image.size == (1, 1)
        assert image.convert("RGBA").getpixel((0, 0)) == (255, 255, 255, 255)


@pytest.fixture(autouse=True)
def isolate_preflight(monkeypatch):
    monkeypatch.setattr(preflight, "_verified_config", None)
    monkeypatch.setattr(preflight, "uses_local_ce_runtime", lambda: True)


@pytest.fixture
def storage_io(monkeypatch):
    calls = SimpleNamespace(
        puts=[],
        gets=[],
        deletes=[],
        error=None,
        delete_error=None,
        content=preflight._PROBE_PNG,
        status=200,
    )

    class Bucket:
        def delete_object(self, key):
            calls.deletes.append(key)
            if calls.delete_error:
                raise calls.delete_error

    class Relay:
        def __init__(self, **kwargs):
            self._bucket = Bucket()

        def upload_bytes(self, data, **kwargs):
            calls.puts.append((data, kwargs))
            if calls.error:
                raise calls.error
            return "https://storage.test/probe?signature=private-signature"

    def get(request):
        calls.gets.append(request)
        return httpx.Response(calls.status, content=calls.content)

    transport = httpx.MockTransport(get)
    original_client = httpx.Client
    monkeypatch.setattr(preflight, "AliyunOSSRelay", Relay)
    monkeypatch.setattr(preflight, "CloudinaryRelay", Relay)
    monkeypatch.setattr(
        preflight.httpx,
        "Client",
        lambda **kwargs: original_client(transport=transport, **kwargs),
    )
    return calls


def test_probe_checks_real_bytes_and_cleans_only_its_own_object(
    storage_config, storage_io
):
    preflight.verify_media_storage(storage_config)
    assert storage_io.puts[0][0] == preflight._PROBE_PNG
    key = storage_io.puts[0][1]["object_key"]
    assert key.startswith("relay/") and "/preflight-" in key and key.endswith(".png")
    assert len(storage_io.gets) == 1
    assert storage_io.deletes == [key]


def test_storage_config_repr_never_exposes_credentials(storage_config):
    assert storage_config.access_key_id not in repr(storage_config)
    assert storage_config.access_key_secret not in repr(storage_config)
    cloud = replace(
        storage_config,
        cloudinary_api_key="cloudinary-key",
        cloudinary_api_secret="cloudinary-secret",
    )
    assert cloud.cloudinary_api_key not in repr(cloud)
    assert cloud.cloudinary_api_secret not in repr(cloud)


def test_delete_permission_is_not_required(storage_config, storage_io):
    storage_io.delete_error = PermissionError("delete denied")
    preflight.verify_media_storage(storage_config)
    assert len(storage_io.gets) == 1


@pytest.mark.parametrize(
    "field,value",
    [
        ("access_key_id", "rotated-key"),
        ("access_key_secret", "rotated-secret"),
        ("endpoint", "other.endpoint"),
        ("bucket", "other-bucket"),
        ("cloudinary_folder", "other-folder"),
        ("provider", "cloudinary"),
    ],
)
def test_cache_follows_effective_config(storage_config, storage_io, field, value):
    preflight.verify_media_storage(storage_config)
    preflight.verify_media_storage(storage_config)
    assert len(storage_io.puts) == 1
    preflight.verify_media_storage(replace(storage_config, **{field: value}))
    assert len(storage_io.puts) == 2


def test_cache_expires_and_explicit_checks_are_fresh(
    monkeypatch, storage_config, storage_io
):
    now = [10.0]
    monkeypatch.setattr(preflight.time, "monotonic", lambda: now[0])
    preflight.verify_media_storage(storage_config)
    preflight.verify_media_storage(storage_config, force=True)
    assert len(storage_io.puts) == 2
    now[0] = 71.0
    preflight.verify_media_storage(storage_config)
    assert len(storage_io.puts) == 3


@pytest.mark.parametrize(
    "code,status,expected",
    [
        ("InvalidAccessKeyId", 403, "MEDIA_STORAGE_AUTH_INVALID"),
        ("SignatureDoesNotMatch", 403, "MEDIA_STORAGE_AUTH_INVALID"),
        ("AccessDenied", 403, "MEDIA_STORAGE_ACCESS_DENIED"),
        ("NoSuchBucket", 404, "MEDIA_STORAGE_TARGET_INVALID"),
    ],
)
def test_oss_errors_are_safe_and_never_cached(
    storage_config, storage_io, code, status, expected
):
    class ProviderError(Exception):
        pass

    error = ProviderError("test-secret and https://storage.test?signature=secret")
    error.code, error.status = code, status
    storage_io.error = error
    for _ in range(2):
        with pytest.raises(preflight.MediaStorageUnavailable) as exc:
            preflight.verify_media_storage(storage_config)
        assert exc.value.code == expected
        assert "test-secret" not in str(exc.value)
        assert "signature" not in str(exc.value)
    assert len(storage_io.puts) == 2


@pytest.mark.parametrize("provider", ["aliyun_oss", "cloudinary"])
def test_read_failure_is_not_a_successful_probe(storage_config, storage_io, provider):
    storage_config = replace(storage_config, provider=provider)
    storage_io.content = b"wrong object or transformed response"
    with pytest.raises(
        preflight.MediaStorageUnavailable, match="MEDIA_STORAGE_READ_MISMATCH"
    ):
        preflight.verify_media_storage(storage_config)
    assert preflight._verified_config is None


@pytest.mark.parametrize("provider", ["aliyun_oss", "cloudinary"])
def test_reencoded_probe_is_only_accepted_for_cloudinary(
    storage_config, storage_io, provider
):
    storage_config = replace(storage_config, provider=provider)
    storage_io.content = _encoded_image()
    assert storage_io.content != preflight._PROBE_PNG
    if provider == "cloudinary":
        preflight.verify_media_storage(storage_config)
        assert preflight._verified_config is not None
    else:
        with pytest.raises(
            preflight.MediaStorageUnavailable, match="MEDIA_STORAGE_READ_MISMATCH"
        ):
            preflight.verify_media_storage(storage_config)
        assert preflight._verified_config is None


@pytest.mark.parametrize(
    "content",
    [
        b"",
        b"<html>access denied</html>",
        _encoded_image(size=(2, 1)),
        _encoded_image(color=0),
        _encoded_image(mode="RGBA", color=(255, 255, 255, 0)),
    ],
    ids=["empty", "html", "wrong-size", "wrong-pixels", "wrong-alpha"],
)
def test_cloudinary_does_not_accept_unreadable_or_different_images(
    storage_config, storage_io, content
):
    storage_io.content = content
    with pytest.raises(
        preflight.MediaStorageUnavailable, match="MEDIA_STORAGE_READ_MISMATCH"
    ):
        preflight.verify_media_storage(replace(storage_config, provider="cloudinary"))
    assert preflight._verified_config is None


def test_cloudinary_rejects_a_png_with_an_invalid_checksum(storage_config, storage_io):
    content = bytearray(preflight._PROBE_PNG)
    content[content.index(b"IDAT") + 4] ^= 1
    storage_io.content = bytes(content)
    with pytest.raises(
        preflight.MediaStorageUnavailable, match="MEDIA_STORAGE_READ_MISMATCH"
    ):
        preflight.verify_media_storage(replace(storage_config, provider="cloudinary"))
    assert preflight._verified_config is None


@pytest.mark.parametrize("provider", ["aliyun_oss", "cloudinary"])
@pytest.mark.parametrize(
    "status,expected",
    [
        (401, "MEDIA_STORAGE_AUTH_INVALID"),
        (403, "MEDIA_STORAGE_ACCESS_DENIED"),
        (404, "MEDIA_STORAGE_TARGET_INVALID"),
        (302, "MEDIA_STORAGE_UNAVAILABLE"),
    ],
)
def test_upload_success_does_not_hide_unreadable_delivery(
    storage_config, storage_io, provider, status, expected
):
    storage_io.status = status
    with pytest.raises(preflight.MediaStorageUnavailable) as exc:
        preflight.verify_media_storage(replace(storage_config, provider=provider))
    assert exc.value.code == expected
    assert len(storage_io.puts) == 1
    assert preflight._verified_config is None


def test_timeout_is_actionable_without_exposing_request(storage_config, storage_io):
    storage_io.error = httpx.ReadTimeout("https://storage.test?signature=secret")
    with pytest.raises(
        preflight.MediaStorageUnavailable, match="MEDIA_STORAGE_TIMEOUT"
    ) as exc:
        preflight.verify_media_storage(storage_config)
    assert "signature" not in str(exc.value)


@pytest.mark.parametrize("status", [200, 401, 403])
def test_cloudinary_upload_and_read_are_both_verified(
    monkeypatch, storage_config, status
):
    settings = replace(
        storage_config,
        provider="cloudinary",
        cloud_name="test-cloud",
        cloudinary_api_key="cloud-key",
        cloudinary_api_secret="cloud-secret",
        cloudinary_folder="references",
    )
    requests = []

    def transport(request):
        requests.append(request)
        if request.method == "POST":
            return httpx.Response(
                status, json={"secure_url": "https://cdn.test/probe.png"}
            )
        return httpx.Response(200, content=preflight._PROBE_PNG)

    original_client = httpx.Client
    monkeypatch.setattr(
        httpx,
        "Client",
        lambda **kwargs: original_client(
            transport=httpx.MockTransport(transport), **kwargs
        ),
    )
    if status == 200:
        preflight.verify_media_storage(settings)
        assert [request.method for request in requests] == ["POST", "GET"]
        assert requests[0].url.path == "/v1_1/test-cloud/image/upload"
        assert b"references" in requests[0].content
    else:
        expected = (
            "MEDIA_STORAGE_AUTH_INVALID"
            if status == 401
            else "MEDIA_STORAGE_ACCESS_DENIED"
        )
        with pytest.raises(preflight.MediaStorageUnavailable) as exc:
            preflight.verify_media_storage(settings)
        assert exc.value.code == expected
        assert "cloud-secret" not in str(exc.value)
        assert [request.method for request in requests] == ["POST"]


@pytest.mark.asyncio
@pytest.mark.parametrize("provider", ["aliyun_oss", "cloudinary"])
async def test_bad_storage_prevents_video_gateway_submission(
    monkeypatch, storage_config, storage_io, tmp_path, provider
):
    from novelvideo.generators import video_generator

    monkeypatch.setattr(
        preflight,
        "effective_media_storage_config",
        lambda: replace(storage_config, provider=provider),
    )
    monkeypatch.setattr(video_generator, "get_usage_meter", NoOpUsageMeter)
    storage_io.error = PermissionError("storage cannot be written")
    generator = video_generator.NewApiVideoGenerator(
        api_key="test-gateway-key",
        endpoint="https://gateway.test/v1",
        model="video-test",
    )

    async def post(*args, **kwargs):
        pytest.fail("paid video request submitted despite storage failure")

    monkeypatch.setattr(generator, "_post_json", post)
    result = await generator.generate(
        prompt="a landscape",
        image_path="",
        output_path=str(tmp_path / "video.mp4"),
    )
    assert result.status is video_generator.VideoGenStatus.FAILED
    assert "MEDIA_STORAGE_UNAVAILABLE" in result.error


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["image", "video", "audio"])
@pytest.mark.parametrize("provider", ["aliyun_oss", "cloudinary"])
async def test_ce_media_boundary_blocks_bad_storage(
    monkeypatch, storage_config, storage_io, kind, provider
):
    monkeypatch.setattr(
        preflight,
        "effective_media_storage_config",
        lambda: replace(storage_config, provider=provider),
    )
    storage_io.error = PermissionError("storage cannot be written")
    with pytest.raises(preflight.MediaStorageUnavailable):
        await NoOpUsageMeter().reserve_current_model_call_credit(
            model="model", billing_kind=kind
        )


@pytest.mark.asyncio
async def test_local_only_ce_and_non_media_calls_do_not_probe(
    monkeypatch, storage_config, storage_io
):
    monkeypatch.setattr(
        preflight,
        "effective_media_storage_config",
        lambda: replace(storage_config, access_key_id="", access_key_secret=""),
    )
    await NoOpUsageMeter().reserve_current_model_call_credit(
        model="model", billing_kind="image"
    )
    monkeypatch.setattr(
        preflight, "effective_media_storage_config", lambda: storage_config
    )
    await NoOpUsageMeter().reserve_current_model_call_credit(
        model="llm", billing_kind="model"
    )
    assert storage_io.puts == []


@pytest.mark.asyncio
async def test_ee_does_not_read_ce_storage(monkeypatch, storage_io):
    monkeypatch.setattr(preflight, "uses_local_ce_runtime", lambda: False)
    monkeypatch.setattr(
        preflight,
        "effective_media_storage_config",
        lambda: pytest.fail("CE config read in EE"),
    )
    await preflight.require_ce_media_storage()
    assert storage_io.puts == []


@pytest.mark.asyncio
@pytest.mark.parametrize("provider", ["aliyun_oss", "cloudinary"])
async def test_bad_storage_prevents_image_gateway_submission(
    monkeypatch, storage_config, storage_io, provider
):
    from novelvideo.generators import nanobanana_grid

    monkeypatch.setattr(
        preflight,
        "effective_media_storage_config",
        lambda: replace(storage_config, provider=provider),
    )
    monkeypatch.setattr(nanobanana_grid, "get_usage_meter", NoOpUsageMeter)
    storage_io.error = PermissionError("storage cannot be written")
    posts = []

    async def post(self, *args, **kwargs):
        posts.append(args)
        pytest.fail("paid model was called despite storage failure")

    monkeypatch.setattr(httpx.AsyncClient, "post", post)
    data, text, error = await nanobanana_grid._call_newapi_image_api(
        api_key="test-gateway-key",
        model="LingShan-G2",
        prompt="a landscape",
        base_url="https://gateway.test/v1",
        image_config={},
    )
    assert not data
    assert "MEDIA_STORAGE_UNAVAILABLE" in error
    assert posts == []


@pytest.mark.asyncio
@pytest.mark.parametrize("provider", ["aliyun_oss", "cloudinary"])
async def test_bad_storage_prevents_preset_speech_submission(
    monkeypatch, tmp_path, storage_config, storage_io, provider
):
    from novelvideo.freezone.audio_node import _write_newapi_audio_speech

    monkeypatch.setattr(
        preflight,
        "effective_media_storage_config",
        lambda: replace(storage_config, provider=provider),
    )
    storage_io.error = PermissionError("storage cannot be written")

    async def post(self, *args, **kwargs):
        pytest.fail("paid speech request submitted despite storage failure")

    monkeypatch.setattr(httpx.AsyncClient, "post", post)
    with pytest.raises(preflight.MediaStorageUnavailable):
        await _write_newapi_audio_speech(
            output_path=tmp_path / "speech.mp3",
            model="tts-test",
            input_text="hello",
            api_key="test-gateway-key",
            base_url="https://gateway.test/v1",
        )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "request_error,expected",
    [
        (requests.exceptions.ConnectTimeout, "MEDIA_STORAGE_TIMEOUT"),
        (requests.exceptions.ReadTimeout, "MEDIA_STORAGE_TIMEOUT"),
        (requests.exceptions.ConnectionError, "MEDIA_STORAGE_UNAVAILABLE"),
    ],
)
async def test_oss_sdk_errors_block_speech_with_safe_classification(
    monkeypatch, tmp_path, storage_config, request_error, expected
):
    from novelvideo.freezone.audio_node import _write_newapi_audio_speech

    monkeypatch.setattr(
        preflight, "effective_media_storage_config", lambda: storage_config
    )

    def fail_request(self, method, url, **kwargs):
        # Let the real oss2 SDK wrap the requests exception in RequestError.
        raise request_error("test-secret and https://storage.test?signature=secret")

    async def paid_post(self, *args, **kwargs):
        pytest.fail("paid speech request submitted despite storage failure")

    monkeypatch.setattr(requests.Session, "request", fail_request)
    monkeypatch.setattr(httpx.AsyncClient, "post", paid_post)
    with pytest.raises(preflight.MediaStorageUnavailable) as exc:
        await _write_newapi_audio_speech(
            output_path=tmp_path / "speech.mp3",
            model="tts-test",
            input_text="hello",
            api_key="test-gateway-key",
            base_url="https://gateway.test/v1",
        )
    assert exc.value.code == expected
    assert "test-secret" not in str(exc.value)
    assert "signature" not in str(exc.value)
    assert preflight._verified_config is None
