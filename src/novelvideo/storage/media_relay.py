"""Transient media relay for LLM-visible image URLs."""

from __future__ import annotations

import uuid
import base64
import hashlib
import io
import inspect
import logging
import re
import mimetypes
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

logger = logging.getLogger(__name__)

AI_REFERENCE_JPEG_QUALITY = 95
IMAGE_TRANSFORM_AI_REFERENCE_JPEG = "ai_reference_jpeg"


class ServiceEgressDenied(RuntimeError):
    """Stable denial for an invalid storage service boundary."""

    code = "ORG_SERVICE_EGRESS_DENIED"

    def __init__(self, reason: str | None = None) -> None:
        super().__init__("organization service egress is denied")
        # Which boundary refused, as a fixed slug — never interpolated request
        # data. The denial is raised from five places that need five different
        # fixes (a missing port registration is not a malformed object key),
        # and the caller has no other way to tell them apart.
        self.reason = reason


class ServiceOperationNotReplayable(RuntimeError):
    """Raised when a durable service operation was already claimed."""

    code = "ORG_SERVICE_OPERATION_NOT_REPLAYABLE"


class ServiceInvocationFailed(RuntimeError):
    """Secret-free failure after a claimed storage invocation."""

    code = "ORG_SERVICE_INVOCATION_FAILED"

    def __init__(self) -> None:
        super().__init__("service operation failed")


@dataclass(frozen=True, slots=True)
class StorageRelayIdentity:
    """Secret-free identity binding one relay service to one tenant project."""

    credential_id: str
    credential_version: int
    organization_id: str
    project_id: str
    allowed_source_hosts: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        for name in ("credential_id", "organization_id", "project_id"):
            if type(getattr(self, name)) is not str or not getattr(self, name).strip():
                raise ValueError(f"{name} is required")
        if type(self.credential_version) is not int or self.credential_version < 1:
            raise ValueError("credential_version must be positive")
        if type(self.allowed_source_hosts) is not tuple or any(
            type(host) is not str or not host.strip() or "/" in host
            for host in self.allowed_source_hosts
        ):
            raise ValueError("allowed_source_hosts must contain host names")


def validate_tenant_source_url(
    value: str,
    *,
    context,
    identity: StorageRelayIdentity,
) -> str:
    """Validate a remote source without fetching it or exposing its URL."""

    from novelvideo.egress_context import TrustedEgressContext

    parsed = urlparse(str(value or "").strip())
    try:
        port = parsed.port
    except ValueError:
        raise ServiceEgressDenied("source-url") from None
    allowed_hosts = (
        {host.strip().lower() for host in identity.allowed_source_hosts}
        if type(identity) is StorageRelayIdentity
        else set()
    )
    if (
        type(context) is not TrustedEgressContext
        or not context.is_organization
        or type(identity) is not StorageRelayIdentity
        or identity.organization_id != context.billing_principal.id
        or identity.project_id != context.project_id
        or parsed.scheme != "https"
        or parsed.hostname is None
        or parsed.hostname.lower() not in allowed_hosts
        or parsed.username is not None
        or parsed.password is not None
        or port not in {None, 443}
    ):
        raise ServiceEgressDenied("source-url")
    return str(value).strip()


class MediaRelayConfigError(RuntimeError):
    """Raised when the media relay is not configured for URL input."""


class AliyunOSSRelay:
    """Upload transient bytes to Aliyun OSS and return a short-lived signed URL."""

    def __init__(
        self,
        *,
        endpoint: str,
        bucket_name: str,
        access_key_id: str,
        access_key_secret: str,
    ) -> None:
        missing = [
            name
            for name, value in {
                "OSS_RELAY_ENDPOINT": endpoint,
                "OSS_RELAY_BUCKET": bucket_name,
                "OSS_RELAY_AK": access_key_id,
                "OSS_RELAY_SK": access_key_secret,
            }.items()
            if not str(value or "").strip()
        ]
        if missing:
            raise MediaRelayConfigError(
                "OSS media relay config missing: " + ", ".join(missing)
            )

        try:
            import oss2
        except ImportError as exc:
            raise MediaRelayConfigError(
                "oss2 is not installed; install project dependencies before using media relay"
            ) from exc

        self._bucket = oss2.Bucket(
            oss2.Auth(access_key_id, access_key_secret),
            f"https://{endpoint.strip()}",
            bucket_name.strip(),
        )

    def upload_bytes(
        self,
        data: bytes,
        *,
        ext: str = "png",
        ttl: int = 1800,
        resource_type: str = "image",
        object_key: str | None = None,
    ) -> str:
        if not data:
            raise ValueError("cannot relay empty media bytes")
        ext = _normalize_ext(ext)
        key = object_key or (
            f"relay/{datetime.now(timezone.utc):%Y%m%d}/{uuid.uuid4().hex}.{ext}"
        )
        if not _is_safe_object_key(key):
            raise ServiceEgressDenied("object-key")
        self._bucket.put_object(key, data)
        return self._bucket.sign_url("GET", key, int(ttl), slash_safe=True)

    def upload_file(self, path: str | Path, *, ttl: int = 1800) -> str:
        file_path = Path(path)
        return self.upload_bytes(
            file_path.read_bytes(),
            ext=file_path.suffix.lstrip(".") or "png",
            ttl=ttl,
        )


class CloudinaryRelay:
    """Upload transient bytes to Cloudinary and return its secure delivery URL."""

    def __init__(
        self,
        *,
        cloud_name: str,
        api_key: str,
        api_secret: str,
        folder: str = "",
    ) -> None:
        missing = [
            name
            for name, value in {
                "CLOUDINARY_RELAY_CLOUD_NAME": cloud_name,
                "CLOUDINARY_RELAY_API_KEY": api_key,
                "CLOUDINARY_RELAY_API_SECRET": api_secret,
            }.items()
            if not str(value or "").strip()
        ]
        if missing:
            raise MediaRelayConfigError(
                "Cloudinary media relay config missing: " + ", ".join(missing)
            )

        self._cloud_name = cloud_name.strip()
        self._api_key = api_key.strip()
        self._api_secret = api_secret.strip()
        self._folder = str(folder or "").strip().strip("/")

    def upload_bytes(
        self,
        data: bytes,
        *,
        ext: str = "png",
        ttl: int = 1800,
        resource_type: str = "image",
        object_key: str | None = None,
    ) -> str:
        if not data:
            raise ValueError("cannot relay empty media bytes")

        import httpx

        ext = _normalize_ext(ext)
        resource_type = str(resource_type or "image").strip().lower()
        if resource_type not in {"image", "video"}:
            raise ValueError(f"unsupported Cloudinary resource type: {resource_type}")
        filename = f"{uuid.uuid4().hex}.{ext}"
        content_type = mimetypes.types_map.get(f".{ext}", "application/octet-stream")
        payload = {"folder": self._folder} if self._folder else {}
        if object_key is not None:
            if not _is_safe_object_key(object_key):
                raise ServiceEgressDenied("object-key")
            payload["public_id"] = object_key.rsplit(".", 1)[0]
        url = (
            f"https://api.cloudinary.com/v1_1/{self._cloud_name}/"
            f"{resource_type}/upload"
        )
        try:
            with httpx.Client(timeout=60.0) as client:
                response = client.post(
                    url,
                    data=payload,
                    files={"file": (filename, data, content_type)},
                    auth=(self._api_key, self._api_secret),
                )
                response.raise_for_status()
        except httpx.HTTPStatusError as exc:
            detail = _cloudinary_error_detail(exc.response)
            suffix = f": {detail}" if detail else ""
            raise MediaRelayConfigError(
                "Cloudinary media relay upload failed "
                f"(HTTP {exc.response.status_code}){suffix}"
            ) from exc
        except httpx.HTTPError as exc:
            raise MediaRelayConfigError(
                f"Cloudinary media relay upload failed: {exc}"
            ) from exc

        result = response.json()
        secure_url = str(result.get("secure_url") or result.get("url") or "").strip()
        if not secure_url:
            raise MediaRelayConfigError("Cloudinary media relay upload returned no URL")
        return secure_url

    def upload_file(self, path: str | Path, *, ttl: int = 1800) -> str:
        file_path = Path(path)
        return self.upload_bytes(
            file_path.read_bytes(),
            ext=file_path.suffix.lstrip(".") or "png",
            ttl=ttl,
        )


def get_media_relay() -> AliyunOSSRelay | CloudinaryRelay:
    """Build the configured media relay.

    The relay is intentionally not cached so tests can monkeypatch config and
    failed or rotated credentials are not hidden behind process-local state.
    """
    from novelvideo import config
    from novelvideo.model_gateway_settings import get_effective_media_relay_config

    relay_config = get_effective_media_relay_config(
        env_provider=getattr(config, "MEDIA_RELAY_PROVIDER", ""),
        env_ttl_seconds=getattr(config, "MEDIA_RELAY_TTL_SECONDS", 1800),
        env_endpoint=getattr(config, "OSS_RELAY_ENDPOINT", ""),
        env_bucket=getattr(config, "OSS_RELAY_BUCKET", ""),
        env_access_key_id=getattr(config, "OSS_RELAY_AK", ""),
        env_access_key_secret=getattr(config, "OSS_RELAY_SK", ""),
        env_cloud_name=getattr(config, "CLOUDINARY_RELAY_CLOUD_NAME", ""),
        env_cloudinary_api_key=getattr(config, "CLOUDINARY_RELAY_API_KEY", ""),
        env_cloudinary_api_secret=getattr(config, "CLOUDINARY_RELAY_API_SECRET", ""),
        env_cloudinary_folder=getattr(config, "CLOUDINARY_RELAY_FOLDER", ""),
    )
    provider = relay_config.provider
    if provider == "cloudinary":
        return CloudinaryRelay(
            cloud_name=relay_config.cloud_name,
            api_key=relay_config.cloudinary_api_key,
            api_secret=relay_config.cloudinary_api_secret,
            folder=relay_config.cloudinary_folder,
        )
    if provider != "aliyun_oss":
        raise MediaRelayConfigError(
            f"unsupported MEDIA_RELAY_PROVIDER: {provider or '-'}"
        )

    return AliyunOSSRelay(
        endpoint=relay_config.endpoint,
        bucket_name=relay_config.bucket,
        access_key_id=relay_config.access_key_id,
        access_key_secret=relay_config.access_key_secret,
    )


def _default_media_relay_ttl_seconds() -> int:
    from novelvideo import config
    from novelvideo.model_gateway_settings import get_effective_media_relay_config

    return get_effective_media_relay_config(
        env_provider=getattr(config, "MEDIA_RELAY_PROVIDER", ""),
        env_ttl_seconds=getattr(config, "MEDIA_RELAY_TTL_SECONDS", 1800),
        env_endpoint=getattr(config, "OSS_RELAY_ENDPOINT", ""),
        env_bucket=getattr(config, "OSS_RELAY_BUCKET", ""),
        env_access_key_id=getattr(config, "OSS_RELAY_AK", ""),
        env_access_key_secret=getattr(config, "OSS_RELAY_SK", ""),
        env_cloud_name=getattr(config, "CLOUDINARY_RELAY_CLOUD_NAME", ""),
        env_cloudinary_api_key=getattr(config, "CLOUDINARY_RELAY_API_KEY", ""),
        env_cloudinary_api_secret=getattr(config, "CLOUDINARY_RELAY_API_SECRET", ""),
        env_cloudinary_folder=getattr(config, "CLOUDINARY_RELAY_FOLDER", ""),
    ).ttl_seconds


def media_relay_ttl_seconds(*, minimum: int = 0) -> int:
    """Return the configured relay TTL without going below a caller's safety floor."""

    return max(int(minimum), _default_media_relay_ttl_seconds())


def upload_image_bytes(
    data: bytes,
    *,
    ext: str = "png",
    ttl: int | None = None,
    image_transform: str | None = None,
) -> str:
    return upload_media_bytes(
        data,
        ext=ext,
        ttl=ttl,
        resource_type="image",
        image_transform=image_transform,
    )


def upload_media_bytes(
    data: bytes,
    *,
    ext: str = "png",
    ttl: int | None = None,
    resource_type: str = "image",
    image_transform: str | None = None,
) -> str:
    ttl_seconds = int(ttl if ttl is not None else _default_media_relay_ttl_seconds())
    data, ext = _apply_image_transform(data, ext=ext, image_transform=image_transform)
    return get_media_relay().upload_bytes(
        data,
        ext=ext,
        ttl=ttl_seconds,
        resource_type=resource_type,
    )


def upload_image_file(path: str | Path, *, ttl: int | None = None) -> str:
    """Upload a local image file to the relay and return a short-lived URL."""
    ttl_seconds = int(ttl if ttl is not None else _default_media_relay_ttl_seconds())
    return get_media_relay().upload_file(path, ttl=ttl_seconds)


async def relay_tenant_image_bytes(
    data: bytes,
    *,
    object_id: str,
    context,
    identity: StorageRelayIdentity,
    operations,
    relay=None,
    ext: str = "png",
    ttl: int = 1800,
) -> str:
    """Relay bytes through a tenant-bound service identity and durable claim."""

    from novelvideo.egress_context import TrustedEgressContext
    from novelvideo.ports.egress_operations import (
        OperationSpec,
        OperationState,
        canonical_request_digest,
    )

    if (
        type(context) is not TrustedEgressContext
        or not context.is_organization
        or type(identity) is not StorageRelayIdentity
        or identity.organization_id != context.billing_principal.id
        or identity.project_id != context.project_id
        or not data
        or type(object_id) is not str
        or not object_id.strip()
    ):
        raise ServiceEgressDenied("identity")

    normalized_ext = _normalize_ext(ext)
    object_digest = hashlib.sha256(object_id.encode("utf-8")).hexdigest()
    object_key = (
        f"tenants/{identity.organization_id}/projects/{identity.project_id}/"
        f"objects/{object_digest}.{normalized_ext}"
    )
    request_digest = canonical_request_digest(
        {
            "content_digest": hashlib.sha256(data).hexdigest(),
            "object_digest": object_digest,
            "ext": normalized_ext,
            "ttl": int(ttl),
        }
    )
    claim = await operations.claim(
        spec=OperationSpec(
            organization_id=identity.organization_id,
            project_id=identity.project_id,
            root_task_id=context.root_task_id,
            # One relay is one billable egress, and one envelope may relay many
            # objects, so the operation key has to name the object too — the
            # envelope alone would make the second object collide with the
            # first and be rejected as a conflicting claim. object_digest is
            # derived from object_id, so a retry recomputes the same key.
            business_task_id=f"{context.envelope_id}:{object_digest}",
            capability="storage.media.relay",
            credential_id=identity.credential_id,
            credential_version=identity.credential_version,
            request_digest=request_digest,
        )
    )
    if not claim.won or claim.operation.state is not OperationState.DISPATCHING:
        raise ServiceOperationNotReplayable("service operation already claimed")

    try:
        adapter = relay or get_media_relay()
        result = adapter.upload_bytes(
            data,
            ext=normalized_ext,
            ttl=int(ttl),
            object_key=object_key,
        )
        if inspect.isawaitable(result):
            result = await result
    except Exception:
        try:
            await operations.mark_unknown(
                operation_id=claim.operation.operation_id,
                transition_token=claim.transition_token,
                expected_version=claim.operation.version,
            )
        except Exception:
            pass
        raise ServiceInvocationFailed() from None
    await operations.mark_completed(
        operation_id=claim.operation.operation_id,
        transition_token=claim.transition_token,
        expected_version=claim.operation.version,
        result_ref="service-operation-completed",
    )
    return str(result)


async def relay_tenant_image_bytes_from_context(
    data: bytes,
    *,
    object_id: str,
    context: object,
    ext: str = "png",
    ttl: int = 1800,
) -> str:
    """Relay tenant image bytes using only verified context and registered authority."""

    from novelvideo.egress_context import TrustedEgressContext
    from novelvideo.ports import get_egress_operation_port

    if type(context) is not TrustedEgressContext or not context.is_organization:
        raise ServiceEgressDenied("context")

    try:
        operations = get_egress_operation_port()
    except Exception:
        raise ServiceEgressDenied("operation-port") from None
    if not all(
        callable(getattr(operations, method, None))
        for method in ("claim", "mark_completed", "mark_unknown")
    ):
        raise ServiceEgressDenied("operation-port")

    identity = StorageRelayIdentity(
        credential_id="svc-media-relay",
        credential_version=1,
        organization_id=context.billing_principal.id,
        project_id=context.project_id,
    )
    return await relay_tenant_image_bytes(
        data,
        object_id=object_id,
        context=context,
        identity=identity,
        operations=operations,
        ext=ext,
        ttl=ttl,
    )


def ensure_image_url(reference: str | Path, *, ttl: int | None = None) -> str:
    """Return a remote URL for an image reference.

    - http/https URLs are already model-visible and are returned unchanged.
    - data:image/...;base64 references are uploaded to the relay.
    - local files are uploaded to the relay.

    This keeps newAPI/HuiMeng image calls from receiving local paths or data URLs
    when the upstream channel requires fetchable URL inputs.
    """
    value = str(reference or "").strip()
    if not value:
        raise ValueError("image reference is empty")
    if _is_remote_url(value):
        return value
    data_url_match = _DATA_IMAGE_URL_RE.match(value)
    if data_url_match:
        ext = _normalize_ext(data_url_match.group("ext"))
        try:
            data = base64.b64decode(data_url_match.group("data"), validate=True)
        except Exception as exc:
            raise ValueError("invalid base64 image data URL") from exc
        return upload_image_bytes(data, ext=ext, ttl=ttl)

    path = Path(value).expanduser()
    if not path.exists() or not path.is_file():
        raise ValueError(f"image reference is not a URL or local file: {value}")
    return upload_image_file(path, ttl=ttl)


def _apply_image_transform(
    data: bytes,
    *,
    ext: str,
    image_transform: str | None,
) -> tuple[bytes, str]:
    if not image_transform:
        return data, ext
    if image_transform == IMAGE_TRANSFORM_AI_REFERENCE_JPEG:
        return _normalize_ai_reference_image(data, ext=ext)
    raise ValueError(f"unsupported image_transform: {image_transform}")


def _normalize_ai_reference_image(
    data: bytes, *, ext: str = "png"
) -> tuple[bytes, str]:
    original_ext = _normalize_ext(ext)

    try:
        from PIL import Image, ImageOps, UnidentifiedImageError

        with Image.open(io.BytesIO(data)) as img:
            original_format = (img.format or original_ext or "").upper() or "UNKNOWN"
            original_mode = img.mode
            original_size = img.size
            img = ImageOps.exif_transpose(img)
            if img.mode in {"RGBA", "LA"} or (
                img.mode == "P" and "transparency" in img.info
            ):
                background = Image.new("RGB", img.size, (255, 255, 255))
                alpha = img.convert("RGBA").getchannel("A")
                background.paste(img.convert("RGBA"), mask=alpha)
                img = background
            elif img.mode != "RGB":
                img = img.convert("RGB")

            normalized_size = img.size
            buffer = io.BytesIO()
            img.save(
                buffer,
                format="JPEG",
                quality=AI_REFERENCE_JPEG_QUALITY,
                optimize=True,
            )
            normalized = buffer.getvalue()
    except (UnidentifiedImageError, OSError, ValueError) as exc:
        logger.info(
            "DramaClawAPI reference image normalize skipped: ext=%s bytes=%d error=%s",
            original_ext,
            len(data),
            exc,
        )
        return data, original_ext

    logger.info(
        "DramaClawAPI reference image normalized: %s %dx%d %s %.1fKB -> "
        "JPEG %dx%d RGB %.1fKB q=%d",
        original_format,
        original_size[0],
        original_size[1],
        original_mode,
        len(data) / 1024,
        normalized_size[0],
        normalized_size[1],
        len(normalized) / 1024,
        AI_REFERENCE_JPEG_QUALITY,
    )
    return normalized, "jpg"


_DATA_IMAGE_URL_RE = re.compile(
    r"^data:image/(?P<ext>[a-zA-Z0-9.+-]+);base64,(?P<data>.+)$",
    re.DOTALL,
)


def _is_remote_url(value: str) -> bool:
    parsed = urlparse(value)
    return parsed.scheme in {"http", "https"} and bool(parsed.netloc)


def _is_safe_object_key(value: str) -> bool:
    if not value or value.startswith(("/", ".")) or ".." in value.split("/"):
        return False
    return all(
        part and re.fullmatch(r"[A-Za-z0-9._-]+", part) for part in value.split("/")
    )


def _normalize_ext(ext: str) -> str:
    ext = (ext or "png").strip().lower().lstrip(".")
    if ext in {"jpeg", "pjpeg"}:
        return "jpg"
    if ext == "svg+xml":
        return "svg"
    return ext or "png"


def _cloudinary_error_detail(response: object) -> str:
    try:
        payload = response.json()  # type: ignore[attr-defined]
    except Exception:
        payload = None
    if isinstance(payload, dict):
        error = payload.get("error")
        if isinstance(error, dict):
            message = str(error.get("message") or "").strip()
            if message:
                return message[:500]
    try:
        return str(response.text or "").strip()[:500]  # type: ignore[attr-defined]
    except Exception:
        return ""
