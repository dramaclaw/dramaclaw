from __future__ import annotations

from dataclasses import replace
from unittest.mock import Mock, patch
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest
from botocore.exceptions import ClientError, ConnectTimeoutError, ReadTimeoutError
from botocore.stub import Stubber

from novelvideo import config
from novelvideo.model_gateway_settings import (
    EffectiveMediaRelayConfig,
    build_media_relay_status,
    get_effective_media_relay_config,
    save_media_relay_config,
)
from novelvideo.storage import media_preflight, media_relay, s3_relay
from novelvideo.storage.media_errors import (
    MediaStorageUnavailable,
    safe_media_storage_error,
)


@pytest.fixture
def s3_settings(monkeypatch, tmp_path):
    monkeypatch.setenv("ST_EDITION", "ce")
    monkeypatch.delenv("ST_CONTROL_PLANE_DSN", raising=False)
    monkeypatch.setattr(config, "STATE_DIR", str(tmp_path))
    monkeypatch.setattr(media_preflight, "_verified_config", None)
    return EffectiveMediaRelayConfig(
        source="database",
        provider="s3",
        ttl_seconds=1800,
        endpoint="oss.example.test",
        bucket="oss-bucket",
        access_key_id="oss-only-key",
        access_key_secret="oss-only-secret",
        s3_endpoint="https://storage.example.test",
        s3_bucket="media",
        s3_access_key_id="s3-test-key",
        s3_access_key_secret="s3-test-secret",
        s3_region="us-east-1",
        s3_path_style=True,
    )


@pytest.mark.parametrize("path_style", [True, False])
def test_upload_and_sigv4_url(s3_settings, path_style):
    relay = s3_relay.build_s3_relay(replace(s3_settings, s3_path_style=path_style))
    with Stubber(relay._client) as stub:
        stub.add_response(
            "put_object",
            {},
            {
                "Bucket": "media",
                "Key": "relay/test.png",
                "Body": b"image",
                "ContentType": "image/png",
            },
        )
        url = relay.upload_bytes(b"image", object_key="relay/test.png", ttl=7200)
        stub.assert_no_pending_responses()
    parsed = urlsplit(url)
    assert parsed.netloc == (
        "storage.example.test" if path_style else "media.storage.example.test"
    )
    assert parsed.path == ("/media/relay/test.png" if path_style else "/relay/test.png")
    query = parse_qs(parsed.query)
    assert query["X-Amz-Algorithm"] == ["AWS4-HMAC-SHA256"]
    assert query["X-Amz-Expires"] == ["7200"]
    assert query["X-Amz-Credential"] == [
        f"s3-test-key/{query['X-Amz-Date'][0][:8]}/us-east-1/s3/aws4_request"
    ]
    assert "X-Amz-Security-Token" not in query
    assert "s3-test-secret" not in url
    sdk_config = relay._client.meta.config
    assert sdk_config.retries["total_max_attempts"] == 1
    assert sdk_config.request_checksum_calculation == "when_required"


def test_generated_key_and_file_upload(s3_settings, monkeypatch, tmp_path):
    relay = s3_relay.build_s3_relay(s3_settings)
    calls = []
    monkeypatch.setattr(
        relay._client, "put_object", lambda **kwargs: calls.append(kwargs)
    )
    path = tmp_path / "sound.mp3"
    path.write_bytes(b"audio")
    url = relay.upload_file(path)
    assert calls[0]["Key"].startswith("relay/")
    assert calls[0]["Key"].endswith(".mp3")
    assert calls[0]["ContentType"] == "audio/mpeg"
    assert calls[0]["Body"] == b"audio"
    assert "X-Amz-Signature" in url


@pytest.mark.parametrize("ttl", [0, -1, 604801])
def test_invalid_ttl_fails_before_upload(s3_settings, ttl):
    relay = s3_relay.build_s3_relay(s3_settings)
    with Stubber(relay._client):
        with pytest.raises(media_relay.MediaRelayConfigError, match="TTL"):
            relay.upload_bytes(b"image", ttl=ttl)


@pytest.mark.parametrize("ttl", [0, -1, 604801])
async def test_invalid_environment_ttl_fails_preflight_before_io(
    s3_settings, monkeypatch, ttl
):
    monkeypatch.setattr(config, "MEDIA_RELAY_PROVIDER", "s3")
    monkeypatch.setattr(config, "MEDIA_RELAY_TTL_SECONDS", ttl)
    monkeypatch.setenv("S3_RELAY_ENDPOINT", s3_settings.s3_endpoint)
    monkeypatch.setenv("S3_RELAY_BUCKET", s3_settings.s3_bucket)
    monkeypatch.setenv("S3_RELAY_AK", s3_settings.s3_access_key_id)
    monkeypatch.setenv("S3_RELAY_SK", s3_settings.s3_access_key_secret)
    settings = media_preflight.effective_media_storage_config()
    assert settings.source == "environment"
    assert settings.ttl_seconds == ttl
    build_relay = Mock()
    read_client = Mock()
    monkeypatch.setattr(s3_relay, "build_s3_relay", build_relay)
    monkeypatch.setattr(media_preflight.httpx, "Client", read_client)

    with pytest.raises(media_preflight.MediaStorageUnavailable) as error:
        await media_preflight.require_ce_media_storage()

    assert error.value.code == "MEDIA_STORAGE_CONFIG_INVALID"
    build_relay.assert_not_called()
    read_client.assert_not_called()
    assert media_preflight._verified_config is None


@pytest.mark.parametrize(
    "key", ["../outside.png", "/absolute.png", "relay/../other.png"]
)
def test_unsafe_key_fails_before_upload(s3_settings, key):
    relay = s3_relay.build_s3_relay(s3_settings)
    with Stubber(relay._client):
        with pytest.raises(media_relay.ServiceEgressDenied):
            relay.upload_bytes(b"image", object_key=key)


@pytest.mark.parametrize(
    "endpoint",
    [
        "storage.test",
        "ftp://storage.test",
        "https://user:secret@storage.test",
        "https://storage.test?token=secret",
        "https://storage.test/path",
        "https://storage.test:bad",
    ],
)
def test_invalid_endpoint_is_rejected_without_echoing_secrets(s3_settings, endpoint):
    with pytest.raises(media_relay.MediaRelayConfigError) as error:
        s3_relay.build_s3_relay(replace(s3_settings, s3_endpoint=endpoint))
    assert "secret" not in str(error.value)


def test_http_endpoint_and_explicit_credentials(s3_settings, monkeypatch):
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "unrelated-host-key")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "unrelated-host-secret")
    monkeypatch.setenv("AWS_SESSION_TOKEN", "unrelated-host-token")
    relay = s3_relay.build_s3_relay(
        replace(s3_settings, s3_endpoint="http://localhost:9000")
    )
    credentials = relay._client._request_signer._credentials
    assert credentials.access_key == s3_settings.s3_access_key_id
    assert credentials.secret_key == s3_settings.s3_access_key_secret
    assert not credentials.token
    assert relay._client.meta.endpoint_url == "http://localhost:9000"


@pytest.mark.parametrize(
    "code,status,expected",
    [
        ("SignatureDoesNotMatch", 403, "MEDIA_STORAGE_AUTH_INVALID"),
        ("ExpiredToken", 400, "MEDIA_STORAGE_AUTH_INVALID"),
        ("AccessDenied", 403, "MEDIA_STORAGE_ACCESS_DENIED"),
        ("NoSuchBucket", 404, "MEDIA_STORAGE_TARGET_INVALID"),
        ("AuthorizationHeaderMalformed", 400, "MEDIA_STORAGE_TARGET_INVALID"),
    ],
)
def test_sdk_errors_are_safe(s3_settings, code, status, expected):
    relay = s3_relay.build_s3_relay(s3_settings)
    with (
        Stubber(relay._client) as stub,
        patch.dict("sys.modules", {"novelvideo.storage.media_preflight": None}),
    ):
        stub.add_client_error(
            "put_object", code, "secret https://host?signature=private", status
        )
        with pytest.raises(MediaStorageUnavailable) as error:
            relay.upload_bytes(b"image")
    assert error.value.code == expected
    assert "secret" not in str(error.value)
    assert "signature" not in str(error.value)


@pytest.mark.parametrize("error_type", [ConnectTimeoutError, ReadTimeoutError])
def test_sdk_timeout_classification(error_type):
    error = error_type(endpoint_url="https://host?signature=private")
    result = safe_media_storage_error(error)
    assert result.code == "MEDIA_STORAGE_TIMEOUT"
    assert "signature" not in str(result)


@pytest.mark.parametrize("delete_denied", [False, True])
@pytest.mark.parametrize("ttl", [1, 604800])
def test_preflight_reads_signed_url_and_cleans_own_object(
    s3_settings, monkeypatch, delete_denied, ttl
):
    s3_settings = replace(s3_settings, ttl_seconds=ttl)
    relay = s3_relay.build_s3_relay(s3_settings, timeout=5)
    calls = []
    monkeypatch.setattr(
        relay._client, "put_object", lambda **kwargs: calls.append(kwargs)
    )

    def delete(**kwargs):
        calls.append(kwargs)
        if delete_denied:
            raise ClientError({"Error": {"Code": "AccessDenied"}}, "DeleteObject")

    monkeypatch.setattr(relay._client, "delete_object", delete)
    monkeypatch.setattr(s3_relay, "build_s3_relay", lambda settings, **kwargs: relay)
    client_type = httpx.Client
    gets = []

    def get(request):
        gets.append(request)
        assert "X-Amz-Signature" in request.url.params
        assert request.url.params["X-Amz-Expires"] == "60"
        return httpx.Response(200, content=media_preflight._PROBE_PNG)

    monkeypatch.setattr(
        media_preflight.httpx,
        "Client",
        lambda **kwargs: client_type(transport=httpx.MockTransport(get), **kwargs),
    )
    media_preflight.verify_media_storage(s3_settings)
    media_preflight.verify_media_storage(s3_settings)
    assert len(gets) == 1
    assert calls[0]["Key"].startswith("relay/")
    assert "/preflight-" in calls[0]["Key"]
    assert calls[1] == {"Bucket": "media", "Key": calls[0]["Key"]}
    assert relay._client.meta.config.connect_timeout == 5
    assert relay._client.meta.config.read_timeout == 5


def test_saved_s3_config_is_isolated_masked_and_used_by_factory(
    s3_settings, monkeypatch
):
    save_media_relay_config(
        provider="s3",
        ttl_seconds=900,
        endpoint=s3_settings.endpoint,
        bucket=s3_settings.bucket,
        access_key_id=s3_settings.access_key_id,
        access_key_secret=s3_settings.access_key_secret,
        s3_endpoint=s3_settings.s3_endpoint,
        s3_bucket=s3_settings.s3_bucket,
        s3_access_key_id=s3_settings.s3_access_key_id,
        s3_access_key_secret=s3_settings.s3_access_key_secret,
        s3_region="auto",
        s3_path_style=True,
    )
    monkeypatch.setenv("S3_RELAY_AK", "different-environment-key")
    settings = get_effective_media_relay_config()
    assert settings.s3_access_key_id == "s3-test-key"
    assert settings.access_key_id == "oss-only-key"
    assert settings.s3_region == "auto"
    assert settings.s3_access_key_secret not in repr(settings)
    status = build_media_relay_status()
    assert status["configured"] is True
    assert status["s3PathStyle"] is True
    assert "s3-test-secret" not in str(status)
    relay = media_relay.get_media_relay()
    assert isinstance(relay, s3_relay.S3Relay)
    assert relay._client.meta.region_name == "auto"
    # Saving a different provider without S3 fields must preserve the S3 slot.
    save_media_relay_config(provider="cloudinary", ttl_seconds=1800, cloud_name="demo")
    assert get_effective_media_relay_config().s3_access_key_id == "s3-test-key"


def test_s3_environment_config_does_not_reuse_oss_credentials(s3_settings, monkeypatch):
    monkeypatch.setenv("MEDIA_RELAY_PROVIDER", "s3")
    monkeypatch.setenv("OSS_RELAY_AK", "oss-only-key")
    monkeypatch.setenv("S3_RELAY_ENDPOINT", "http://localhost:9000")
    monkeypatch.setenv("S3_RELAY_BUCKET", "media")
    monkeypatch.setenv("S3_RELAY_AK", "s3-key")
    monkeypatch.setenv("S3_RELAY_SK", "s3-secret")
    monkeypatch.setenv("S3_RELAY_REGION", "us-east-1")
    monkeypatch.setenv("S3_RELAY_PATH_STYLE", "true")
    settings = get_effective_media_relay_config()
    assert settings.source == "environment"
    assert settings.s3_path_style is True
    assert settings.s3_access_key_id == "s3-key"
    monkeypatch.setenv("ST_EDITION", "ee")
    assert get_effective_media_relay_config().source == "environment"


async def test_s3_preflight_gate_and_ee_exclusion(s3_settings, monkeypatch):
    calls = []
    monkeypatch.setattr(
        media_preflight, "effective_media_storage_config", lambda: s3_settings
    )
    monkeypatch.setattr(
        media_preflight, "verify_media_storage", lambda settings: calls.append(settings)
    )
    monkeypatch.setattr(media_preflight, "uses_local_ce_runtime", lambda: True)
    await media_preflight.require_ce_media_storage()
    assert calls == [s3_settings]
    monkeypatch.setattr(media_preflight, "uses_local_ce_runtime", lambda: False)
    await media_preflight.require_ce_media_storage()
    assert calls == [s3_settings]
