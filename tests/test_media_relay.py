from __future__ import annotations

import io
import re
import sys
import types
from pathlib import Path

import pytest
from PIL import Image

from novelvideo import config
from novelvideo.model_gateway_settings import save_media_relay_config
from novelvideo.storage import media_relay


class FakeAuth:
    def __init__(self, ak: str, sk: str) -> None:
        self.ak = ak
        self.sk = sk


class FakeBucket:
    instances: list["FakeBucket"] = []

    def __init__(self, auth: FakeAuth, endpoint: str, bucket_name: str) -> None:
        self.auth = auth
        self.endpoint = endpoint
        self.bucket_name = bucket_name
        self.puts: list[tuple[str, bytes]] = []
        self.signs: list[tuple[str, str, int, bool]] = []
        FakeBucket.instances.append(self)

    def put_object(self, key: str, data: bytes):
        self.puts.append((key, data))
        return object()

    def sign_url(self, method: str, key: str, ttl: int, slash_safe: bool = True) -> str:
        self.signs.append((method, key, ttl, slash_safe))
        return f"https://relay.test/{key}?signed=1"


@pytest.fixture(autouse=True)
def fake_oss2(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("ST_EDITION", "ce")
    monkeypatch.delenv("ST_CONTROL_PLANE_DSN", raising=False)
    FakeBucket.instances.clear()
    fake_module = types.SimpleNamespace(Auth=FakeAuth, Bucket=FakeBucket)
    monkeypatch.setitem(sys.modules, "oss2", fake_module)


def test_aliyun_oss_relay_uploads_under_relay_prefix_and_signs_get_url() -> None:
    relay = media_relay.AliyunOSSRelay(
        endpoint="oss-cn-chengdu.aliyuncs.com",
        bucket_name="claymore-llm-relay",
        access_key_id="ak",
        access_key_secret="sk",
    )

    url = relay.upload_bytes(b"image-bytes", ext="PNG", ttl=1800)

    bucket = FakeBucket.instances[0]
    assert bucket.endpoint == "https://oss-cn-chengdu.aliyuncs.com"
    assert bucket.bucket_name == "claymore-llm-relay"
    key, data = bucket.puts[0]
    assert data == b"image-bytes"
    assert re.match(r"^relay/\d{8}/[0-9a-f]{32}\.png$", key)
    assert bucket.signs == [("GET", key, 1800, True)]
    assert url == f"https://relay.test/{key}?signed=1"


def test_aliyun_oss_relay_requires_credentials() -> None:
    with pytest.raises(media_relay.MediaRelayConfigError) as exc_info:
        media_relay.AliyunOSSRelay(
            endpoint="oss-cn-chengdu.aliyuncs.com",
            bucket_name="claymore-llm-relay",
            access_key_id="",
            access_key_secret="sk",
        )

    assert "OSS_RELAY_AK" in str(exc_info.value)


def test_get_media_relay_uses_saved_runtime_oss_config(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr(config, "STATE_DIR", str(tmp_path / "state"))
    monkeypatch.setattr(config, "MEDIA_RELAY_PROVIDER", "aliyun_oss")
    monkeypatch.setattr(config, "MEDIA_RELAY_TTL_SECONDS", 1800)
    monkeypatch.setattr(config, "OSS_RELAY_ENDPOINT", "env.endpoint")
    monkeypatch.setattr(config, "OSS_RELAY_BUCKET", "env-bucket")
    monkeypatch.setattr(config, "OSS_RELAY_AK", "env-ak")
    monkeypatch.setattr(config, "OSS_RELAY_SK", "env-sk")
    save_media_relay_config(
        provider="aliyun_oss",
        ttl_seconds=900,
        endpoint="db.endpoint",
        bucket="db-bucket",
        access_key_id="db-ak",
        access_key_secret="db-sk",
    )

    relay = media_relay.get_media_relay()
    url = relay.upload_bytes(b"image-bytes", ext="png", ttl=900)

    bucket = FakeBucket.instances[0]
    assert bucket.endpoint == "https://db.endpoint"
    assert bucket.bucket_name == "db-bucket"
    assert bucket.auth.ak == "db-ak"
    assert bucket.auth.sk == "db-sk"
    assert bucket.signs[0][2] == 900
    assert url.startswith("https://relay.test/relay/")


def test_get_media_relay_uses_saved_runtime_cloudinary_config(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr(config, "STATE_DIR", str(tmp_path / "state"))
    monkeypatch.setattr(config, "MEDIA_RELAY_PROVIDER", "aliyun_oss")
    monkeypatch.setattr(config, "MEDIA_RELAY_TTL_SECONDS", 1800)
    monkeypatch.setattr(config, "OSS_RELAY_ENDPOINT", "env.endpoint")
    monkeypatch.setattr(config, "OSS_RELAY_BUCKET", "env-bucket")
    monkeypatch.setattr(config, "OSS_RELAY_AK", "env-ak")
    monkeypatch.setattr(config, "OSS_RELAY_SK", "env-sk")
    monkeypatch.setattr(config, "CLOUDINARY_RELAY_CLOUD_NAME", "")
    monkeypatch.setattr(config, "CLOUDINARY_RELAY_API_KEY", "")
    monkeypatch.setattr(config, "CLOUDINARY_RELAY_API_SECRET", "")
    monkeypatch.setattr(config, "CLOUDINARY_RELAY_FOLDER", "relay")
    save_media_relay_config(
        provider="cloudinary",
        ttl_seconds=900,
        cloud_name="demo-cloud",
        cloudinary_api_key="api-key",
        cloudinary_api_secret="api-secret",
        cloudinary_folder="dramaclaw-relay",
    )

    relay = media_relay.get_media_relay()

    assert isinstance(relay, media_relay.CloudinaryRelay)
    assert relay._cloud_name == "demo-cloud"
    assert relay._api_key == "api-key"
    assert relay._api_secret == "api-secret"
    assert relay._folder == "dramaclaw-relay"


def test_cloudinary_relay_uploads_bytes_with_basic_auth(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[dict[str, object]] = []

    class FakeResponse:
        def raise_for_status(self) -> None:
            return None

        def json(self) -> dict[str, str]:
            return {"secure_url": "https://res.cloudinary.com/demo/image/upload/abc.png"}

    class FakeClient:
        def __init__(self, *, timeout: float) -> None:
            self.timeout = timeout

        def __enter__(self) -> "FakeClient":
            return self

        def __exit__(self, *args) -> None:
            return None

        def post(self, url, *, data, files, auth):
            calls.append({"url": url, "data": data, "files": files, "auth": auth})
            return FakeResponse()

    import httpx

    monkeypatch.setattr(httpx, "Client", FakeClient)
    relay = media_relay.CloudinaryRelay(
        cloud_name="demo-cloud",
        api_key="api-key",
        api_secret="api-secret",
        folder="dramaclaw-relay",
    )

    url = relay.upload_bytes(b"image-bytes", ext="PNG", ttl=900)

    assert url == "https://res.cloudinary.com/demo/image/upload/abc.png"
    assert calls[0]["url"] == "https://api.cloudinary.com/v1_1/demo-cloud/image/upload"
    assert calls[0]["data"] == {"folder": "dramaclaw-relay"}
    assert calls[0]["auth"] == ("api-key", "api-secret")
    filename, data, content_type = calls[0]["files"]["file"]
    assert filename.endswith(".png")
    assert data == b"image-bytes"
    assert content_type == "image/png"


class CaptureRelay:
    def __init__(self) -> None:
        self.uploaded_bytes: list[tuple[bytes, str, int]] = []
        self.uploaded_files: list[tuple[Path, int]] = []

    def upload_bytes(self, data: bytes, *, ext: str = "png", ttl: int = 1800) -> str:
        self.uploaded_bytes.append((data, ext, ttl))
        return f"https://relay.test/bytes.{ext}?ttl={ttl}"

    def upload_file(self, path: str | Path, *, ttl: int = 1800) -> str:
        file_path = Path(path)
        self.uploaded_files.append((file_path, ttl))
        return f"https://relay.test/{file_path.name}?ttl={ttl}"


def test_ensure_image_url_returns_remote_url_without_upload(monkeypatch: pytest.MonkeyPatch) -> None:
    relay = CaptureRelay()
    monkeypatch.setattr(media_relay, "get_media_relay", lambda: relay)

    url = media_relay.ensure_image_url("https://example.test/a.png", ttl=60)

    assert url == "https://example.test/a.png"
    assert relay.uploaded_bytes == []
    assert relay.uploaded_files == []


def test_ensure_image_url_uploads_data_url(monkeypatch: pytest.MonkeyPatch) -> None:
    relay = CaptureRelay()
    monkeypatch.setattr(media_relay, "get_media_relay", lambda: relay)

    url = media_relay.ensure_image_url("data:image/jpeg;base64,aGVsbG8=", ttl=60)

    assert url == "https://relay.test/bytes.jpg?ttl=60"
    assert relay.uploaded_bytes == [(b"hello", "jpg", 60)]
    assert relay.uploaded_files == []


def test_upload_image_bytes_defaults_to_raw_upload(monkeypatch: pytest.MonkeyPatch) -> None:
    relay = CaptureRelay()
    monkeypatch.setattr(media_relay, "get_media_relay", lambda: relay)

    url = media_relay.upload_image_bytes(b"raw-png-bytes", ext="png", ttl=60)

    assert url == "https://relay.test/bytes.png?ttl=60"
    assert relay.uploaded_bytes == [(b"raw-png-bytes", "png", 60)]


def test_upload_image_bytes_can_normalize_ai_reference_jpeg(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    relay = CaptureRelay()
    monkeypatch.setattr(media_relay, "get_media_relay", lambda: relay)
    source = Image.new("RGBA", (32, 16), (255, 0, 0, 255))
    source_buf = io.BytesIO()
    source.save(source_buf, format="PNG")

    url = media_relay.upload_image_bytes(
        source_buf.getvalue(),
        ext="png",
        ttl=60,
        image_transform=media_relay.IMAGE_TRANSFORM_AI_REFERENCE_JPEG,
    )

    assert url == "https://relay.test/bytes.jpg?ttl=60"
    assert len(relay.uploaded_bytes) == 1
    uploaded_bytes, ext, ttl = relay.uploaded_bytes[0]
    assert ext == "jpg"
    assert ttl == 60
    uploaded_image = Image.open(io.BytesIO(uploaded_bytes))
    assert uploaded_image.format == "JPEG"
    assert uploaded_image.mode == "RGB"
    assert uploaded_image.size == (32, 16)


def test_ensure_image_url_uploads_local_file(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    relay = CaptureRelay()
    monkeypatch.setattr(media_relay, "get_media_relay", lambda: relay)
    image_path = tmp_path / "portrait.png"
    image_path.write_bytes(b"png-bytes")

    url = media_relay.ensure_image_url(image_path, ttl=60)

    assert url == "https://relay.test/portrait.png?ttl=60"
    assert relay.uploaded_bytes == []
    assert relay.uploaded_files == [(image_path, 60)]
