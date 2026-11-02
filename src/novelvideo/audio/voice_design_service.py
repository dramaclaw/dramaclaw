"""One-shot voice design through the authenticated model gateway."""

from __future__ import annotations

import asyncio
import base64
import binascii
import hashlib
import ipaddress
import json
import logging
import os
import socket
import subprocess
import tempfile
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Literal
from urllib.parse import urlsplit

import aiohttp

from novelvideo.egress_context import TrustedEgressContext
from novelvideo.generators.tts_generator import (
    _trusted_admission,
    claim_audio_operation,
    complete_audio_operation,
    mark_audio_operation_unknown,
    reject_audio_operation,
    resolve_audio_gateway_credential,
)
from novelvideo.media_model_request_schema import validate_media_model_catalog_config
from novelvideo.ports import get_credit_quote, get_model_credentials, get_usage_meter
from novelvideo.ports.usage import UsageMeter
from novelvideo.project_context import ProjectContext
from novelvideo.ports.registry import PortNotRegistered, get_port

MAX_AUDIO_BYTES = 10 * 1024 * 1024
logger = logging.getLogger(__name__)


def _execution_mode() -> Literal["gateway", "test_replay"]:
    return (
        "test_replay"
        if os.environ.get("VOICE_DESIGN_TEST_REPLAY") == "1"
        else "gateway"
    )


def _log_preview_shape(payload: dict) -> None:
    preview = payload.get("preview_audio")
    shape = {
        "preview_type": type(preview).__name__,
        "field_types": {
            field: type(payload[field]).__name__
            for field in ("preview_audio", "output", "data", "error", "code", "message")
            if field in payload
        },
    }
    if isinstance(preview, dict):
        audio_format = preview.get("format")
        sample_rate = preview.get("sample_rate")
        shape.update(
            format=audio_format if audio_format in ("mp3", "wav", "pcm", "opus") else "unsupported",
            format_type=type(audio_format).__name__,
            sample_rate=sample_rate if type(sample_rate) is int else None,
            sample_rate_type=type(sample_rate).__name__,
            data_type=type(preview.get("data")).__name__,
            data_length=len(preview["data"]) if isinstance(preview.get("data"), str) else 0,
            url_type=type(preview.get("url")).__name__,
        )
    logger.info("Voice design preview shape: %s", shape, extra={"preview_shape": shape})


async def _finish_model_call(
    meter: UsageMeter, reservation_id: str, *, model: str, error: str = ""
) -> None:
    try:
        if error:
            await meter.refund_model_call_credit_reservation(
                reservation_id, metadata={"source": "voice_design", "error": error}
            )
        else:
            await meter.bump_model_call(
                user_id=None,
                model=model,
                credit_reservation_id=reservation_id,
                metadata={"source": "voice_design"},
            )
    except Exception:
        logger.warning("Voice design model-call observation could not be completed")


class VoiceDesignError(RuntimeError):
    def __init__(self, code: str, *, unknown: bool = False):
        super().__init__(code)
        self.code = code
        self.unknown = unknown


class _VoiceDesignBilling:
    def billing_params(self) -> dict:
        return {
            "feature_key": "audio.voice_design",
            "item_count": 1,
            "pricing_kind": "audio",
            "pricing_model": self.model,
            "catalog_id": self.model_id,
            "pricing_metrics": {"call_count": 1, "item_count": 1},
            "voice_design_config": asdict(self),
        }

    def snapshot(self) -> dict:
        return {
            "catalog_id": self.model_id,
            "label": self.label or self.model,
            "model": self.model,
            "mode": self.mode,
            "target_model": (
                {"catalog_id": self.target_model_id, "model": self.target_model}
                if isinstance(self, ResolvedVoiceDesignConfig)
                else None
            ),
            "config_digest": self.config_digest,
            "execution_mode": self.execution_mode,
        }


@dataclass(frozen=True)
class ResolvedVoiceDesignConfig(_VoiceDesignBilling):
    model_id: str
    target_model_id: str
    model: str
    target_model: str
    config_digest: str
    label: str = ""
    execution_mode: Literal["gateway", "test_replay"] = "gateway"
    mode: Literal["resource"] = field(default="resource", init=False)


@dataclass(frozen=True)
class PromptedSpeechConfig(_VoiceDesignBilling):
    model_id: str
    model: str
    config_digest: str
    label: str = ""
    execution_mode: Literal["gateway", "test_replay"] = "gateway"
    mode: Literal["prompted_speech"] = field(default="prompted_speech", init=False)


VoiceDesignConfig = ResolvedVoiceDesignConfig | PromptedSpeechConfig


@dataclass(frozen=True)
class VoiceDesignAudio:
    path: Path
    duration_seconds: float
    sha256: str


def ensure_voice_design_enabled() -> int:
    try:
        limit = int(os.environ.get("VOICE_DESIGN_DAILY_LIMIT", "0"))
        budget = int(os.environ.get("VOICE_DESIGN_CHANNEL_DAILY_LIMIT", "0"))
    except ValueError:
        raise VoiceDesignError("voice_design_unavailable") from None
    if os.environ.get("VOICE_DESIGN_ENABLED") != "1" or limit <= 0 or budget <= 0:
        raise VoiceDesignError("voice_design_unavailable")
    return limit


def list_voice_design_catalog(entries: list[dict]) -> list[VoiceDesignConfig]:
    visible = {
        str(e.get("catalogId") or e.get("catalog_id") or e.get("id")): e
        for e in entries
        if e.get("enabled") is not False
    }
    execution_mode = _execution_mode()
    resolved = []
    for model_id, design in visible.items():
        endpoint = design.get("request", {}).get("endpoint")
        prompted = (
            endpoint == "audio/speech"
            and design.get("voiceDesignMode") == "prompted_speech"
        )
        if endpoint != "audio/voice-designs" and not prompted:
            continue
        config = {
            key: design[key]
            for key in ("request", "targetModel", "voiceDesignMode")
            if key in design
        }
        try:
            validate_media_model_catalog_config(config, "audio")
            target_id = design.get("targetModel")
            target = visible.get(target_id) if not prompted else None
            if not prompted:
                if (
                    not target
                    or target.get("request", {}).get("endpoint") != "audio/speech"
                ):
                    continue
                validate_media_model_catalog_config(
                    {
                        key: target[key]
                        for key in ("request", "voiceDesignMode", "targetModel")
                        if key in target
                    },
                    "audio",
                )
            model = str(design.get("gateway_model") or design.get("gatewayModel") or "")
            target_model = str(
                (target or {}).get("gateway_model")
                or (target or {}).get("gatewayModel")
                or ""
            )
            if not model or (not prompted and not target_model):
                continue
            digest = hashlib.sha256(
                json.dumps([design, target, execution_mode], sort_keys=True).encode()
            ).hexdigest()
            label = str(design.get("label") or model)
            resolved.append(
                PromptedSpeechConfig(model_id, model, digest, label, execution_mode)
                if prompted
                else ResolvedVoiceDesignConfig(
                    model_id,
                    target_id,
                    model,
                    target_model,
                    digest,
                    label,
                    execution_mode,
                )
            )
        except (ValueError, TypeError):
            continue
    return resolved


def resolve_voice_design_catalog(
    entries: list[dict], *, catalog_id: str
) -> VoiceDesignConfig:
    for config in list_voice_design_catalog(entries):
        if config.model_id == catalog_id:
            return config
    raise VoiceDesignError("voice_design_unavailable")


async def list_voice_design_configs(
    *, user_id: str, project_id: str
) -> list[VoiceDesignConfig]:
    ensure_voice_design_enabled()
    if not user_id or not project_id:
        raise VoiceDesignError("voice_design_forbidden")
    try:
        catalog = get_port("media_model_catalog")
    except PortNotRegistered:
        from novelvideo.model_gateway_settings import (
            get_ce_media_model_catalog,
            get_effective_newapi_config,
            get_official_media_model_catalog,
        )
        from novelvideo.shared.runtime_env import uses_local_ce_runtime

        if not uses_local_ce_runtime():
            raise VoiceDesignError("voice_design_unavailable") from None
        config = get_effective_newapi_config()
        entries = (
            get_ce_media_model_catalog("audio")
            if config.mode == "custom"
            else get_official_media_model_catalog("audio")
        )
    else:
        try:
            entries = await catalog.list_models_for_project(
                "audio", user_id=user_id, project_id=project_id
            )
        except Exception as exc:
            code = (
                "voice_design_forbidden"
                if getattr(exc, "code", "") == "MEDIA_MODEL_SCOPE_DENIED"
                else "voice_design_unavailable"
            )
            raise VoiceDesignError(code) from None
    return list_voice_design_catalog(entries)


async def resolve_voice_design_config(
    *, user_id: str, project_id: str, catalog_id: str
) -> VoiceDesignConfig:
    for config in await list_voice_design_configs(
        user_id=user_id, project_id=project_id
    ):
        if config.model_id == catalog_id:
            return config
    raise VoiceDesignError("voice_design_unavailable")


async def quote_voice_design(
    *, ctx: ProjectContext, surface: str, catalog_id: str
) -> dict:
    from novelvideo.api.routes.model_credits import _credit_product_surface

    if surface not in {"supertale", "canvas"}:
        raise VoiceDesignError("invalid_input")
    resolved = await resolve_voice_design_config(
        user_id=ctx.requester_user_id,
        project_id=ctx.project_id,
        catalog_id=catalog_id,
    )
    quote = await get_credit_quote().generation_credit_quote(
        kind="feature",
        model="audio.voice_design",
        params=resolved.billing_params(),
        quantity=1,
        product_surface=_credit_product_surface(surface),
        user_id=ctx.requester_user_id,
    )
    return {
        "ok": True,
        "data": {
            "cost": quote.total_cost,
            "display": str(quote.total_cost),
            "unit": "call",
            "quantity": 1,
            "model": resolved.snapshot(),
        },
    }


class _PublicResolver(aiohttp.abc.AbstractResolver):
    """Pin validated public DNS results to the connection, including redirects."""

    async def resolve(self, host, port=0, family=socket.AF_INET):
        results = await asyncio.get_running_loop().getaddrinfo(
            host,
            port,
            type=socket.SOCK_STREAM,
            family=family,
        )
        if not results or any(
            not ipaddress.ip_address(item[4][0]).is_global for item in results
        ):
            raise VoiceDesignError("provider_bad_audio")
        return [
            {
                "hostname": host,
                "host": item[4][0],
                "port": port,
                "family": item[0],
                "proto": item[2],
                "flags": 0,
            }
            for item in results
        ]

    async def close(self):
        pass


async def _download_preview(url: str) -> bytes:
    # Do not attach the gateway authorization header to a provider media URL.
    connector = aiohttp.TCPConnector(resolver=_PublicResolver(), use_dns_cache=False)
    async with aiohttp.ClientSession(
        connector=connector, timeout=aiohttp.ClientTimeout(total=30)
    ) as session:
        for _ in range(4):
            parsed = urlsplit(url)
            if (
                parsed.scheme != "https"
                or not parsed.hostname
                or parsed.username
                or parsed.password
                or parsed.port not in (None, 443)
            ):
                raise VoiceDesignError("provider_bad_audio")
            try:
                literal = ipaddress.ip_address(parsed.hostname)
            except ValueError:
                pass
            else:
                if not literal.is_global:
                    raise VoiceDesignError("provider_bad_audio")
            async with session.get(url, allow_redirects=False) as response:
                if response.status in {301, 302, 303, 307, 308}:
                    from urllib.parse import urljoin

                    url = urljoin(url, response.headers.get("Location", ""))
                    continue
                if (
                    response.status != 200
                    or (response.content_length or 0) > MAX_AUDIO_BYTES
                ):
                    raise VoiceDesignError("provider_bad_audio")
                result = bytearray()
                async for chunk in response.content.iter_chunked(65536):
                    result.extend(chunk)
                    if len(result) > MAX_AUDIO_BYTES:
                        raise VoiceDesignError("provider_bad_audio")
                return bytes(result)
    raise VoiceDesignError("provider_bad_audio")


def _verify_audio(
    path: Path, *, audio_format: str = "mp3", allow_stereo: bool = False
) -> float:
    from novelvideo.freezone.reference_validation import _ffprobe

    info = _ffprobe(path)
    streams = info.get("streams", [])
    if len(streams) != 1:
        raise VoiceDesignError("provider_bad_audio")
    if audio_format == "wav":
        valid_encoding = (
            info.get("format", {}).get("format_name") == "wav"
            and streams[0].get("codec_name") == "pcm_s16le"
            and streams[0].get("channels") in (1, 2)
        )
    else:
        valid_encoding = (
            info.get("format", {}).get("format_name") == "mp3"
            and streams[0].get("codec_name") == "mp3"
            and streams[0].get("channels") in ((1, 2) if allow_stereo else (1,))
        )
    if (
        not valid_encoding
        or int(streams[0].get("sample_rate", 0)) != 16000
    ):
        raise VoiceDesignError("provider_bad_audio")
    max_pcm_bytes = 15 * 16000 * 2
    with tempfile.TemporaryFile() as decoded:
        subprocess.run(
            [
                "ffmpeg",
                "-v",
                "error",
                "-xerror",
                "-nostdin",
                "-protocol_whitelist",
                "file,pipe",
                "-i",
                str(path),
                "-map",
                "0:a:0",
                "-c:a",
                "pcm_s16le",
                "-ar",
                "16000",
                "-ac",
                "1",
                "-f",
                "s16le",
                # Decode past the acceptance boundary, then reject any overflow.
                # This limits probe output; it never truncates a published candidate.
                "-fs",
                str(max_pcm_bytes + 2),
                "pipe:1",
            ],
            stdout=decoded,
            stderr=subprocess.PIPE,
            check=True,
            timeout=20,
        )
        decoded_bytes = os.fstat(decoded.fileno()).st_size
    if decoded_bytes > max_pcm_bytes:
        raise VoiceDesignError("candidate_duration_exceeded")
    if not decoded_bytes or decoded_bytes % 2:
        raise VoiceDesignError("provider_bad_audio")
    return decoded_bytes / (16000 * 2)


def _prepare_preview(
    data: bytes, audio_format: str, *, allow_stereo: bool = False
) -> tuple[bytes, float]:
    from novelvideo.freezone.reference_validation import _ffprobe

    with tempfile.TemporaryDirectory(prefix="voice-design-") as directory:
        source = Path(directory) / f"source.{audio_format}"
        source.write_bytes(data)
        duration = _verify_audio(
            source, audio_format=audio_format, allow_stereo=allow_stereo
        )
        if audio_format == "mp3" and (
            not allow_stereo or _ffprobe(source)["streams"][0]["channels"] == 1
        ):
            return data, duration
        normalized = Path(directory) / "normalized.mp3"
        subprocess.run(
            [
                "ffmpeg", "-v", "error", "-xerror", "-nostdin",
                "-protocol_whitelist", "file,pipe", "-i", str(source),
                "-map", "0:a:0", "-map_metadata", "-1",
                "-c:a", "libmp3lame", "-ar", "16000", "-ac", "1",
                str(normalized),
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            check=True,
            timeout=20,
        )
        if not 0 < normalized.stat().st_size <= MAX_AUDIO_BYTES:
            raise VoiceDesignError("provider_bad_audio")
        duration = _verify_audio(normalized)
        return normalized.read_bytes(), duration


async def persist_preview(payload: dict, output_path: Path) -> VoiceDesignAudio:
    preview = payload.get("preview_audio")
    if (
        not isinstance(preview, dict)
        or preview.get("format") not in ("mp3", "wav")
        or preview.get("sample_rate") != 16000
    ):
        raise VoiceDesignError("provider_bad_audio")
    try:
        encoded = preview.get("data")
        if encoded:
            if not isinstance(encoded, str) or len(encoded) > 4 * (
                (MAX_AUDIO_BYTES + 2) // 3
            ):
                raise VoiceDesignError("provider_bad_audio")
            data = base64.b64decode(encoded, validate=True)
        elif isinstance(preview.get("url"), str):
            data = await _download_preview(preview["url"])
        else:
            raise VoiceDesignError("provider_bad_audio")
        return await _persist_audio_bytes(data, preview["format"], output_path)
    except (ValueError, binascii.Error, aiohttp.ClientError):
        raise VoiceDesignError("provider_bad_audio") from None


async def _persist_audio_bytes(
    data: bytes, audio_format: str, output_path: Path, *, allow_stereo: bool = False
) -> VoiceDesignAudio:
    temporary = None
    try:
        if not 0 < len(data) <= MAX_AUDIO_BYTES:
            raise VoiceDesignError("provider_bad_audio")
        data, duration = await asyncio.to_thread(
            _prepare_preview, data, audio_format, allow_stereo=allow_stereo
        )
        output_path.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(
            dir=output_path.parent, suffix=".mp3", delete=False
        ) as stream:
            temporary = Path(stream.name)
            stream.write(data)
        os.replace(temporary, output_path)
        return VoiceDesignAudio(output_path, duration, hashlib.sha256(data).hexdigest())
    except (
        ValueError,
        OSError,
        subprocess.SubprocessError,
    ):
        raise VoiceDesignError("provider_bad_audio") from None
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


async def _persist_speech_preview(
    raw: bytes, *, is_json: bool, output_path: Path
) -> VoiceDesignAudio:
    if not is_json:
        return await _persist_audio_bytes(raw, "mp3", output_path, allow_stereo=True)
    try:
        payload = json.loads(raw)
    except (ValueError, UnicodeError):
        raise VoiceDesignError("provider_bad_audio") from None
    audio = payload.get("audio") if isinstance(payload, dict) else None
    # Archived responses may omit format; the request and byte validation use MP3.
    if not isinstance(audio, dict) or audio.get("format", "mp3") != "mp3":
        raise VoiceDesignError("provider_bad_audio")
    url = audio.get("url") or audio.get("preview_url")
    if not isinstance(url, str):
        raise VoiceDesignError("provider_bad_audio")
    return await _persist_audio_bytes(
        await _download_preview(url), "mp3", output_path, allow_stereo=True
    )


def _is_loopback_gateway(base_url: str) -> bool:
    parsed = urlsplit(base_url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        return False
    try:
        return ipaddress.ip_address(parsed.hostname).is_loopback
    except ValueError:
        # No hostname resolution or redirects may turn a replay into remote egress.
        return False


async def generate_voice_design(
    *,
    request: dict,
    output_path: Path,
    egress_context: TrustedEgressContext,
    model_config: VoiceDesignConfig,
) -> VoiceDesignAudio:
    ensure_voice_design_enabled()
    if (
        type(egress_context) is not TrustedEgressContext
        or egress_context.task_type != "voice_design"
    ):
        raise VoiceDesignError("voice_design_forbidden")
    description = request.get("description", "")
    preview_text = request.get("preview_text", "")
    if (
        not isinstance(description, str)
        or not 1 <= len(description.strip()) <= 500
        or not isinstance(preview_text, str)
        or not 15 <= len(preview_text) <= 60
        or request.get("language", "zh") != "zh"
    ):
        raise VoiceDesignError("invalid_input")
    execution_mode = _execution_mode()
    if model_config.execution_mode != execution_mode:
        raise VoiceDesignError("voice_design_unavailable")
    if isinstance(model_config, ResolvedVoiceDesignConfig):
        endpoint = "audio/voice-designs"
        body = {
            "model": model_config.model,
            "target_model": model_config.target_model,
            "preferred_name": "dc891",
            "voice_prompt": description,
            "preview_text": preview_text,
            "language": "zh",
            "sample_rate": 16000,
            "response_format": "mp3",
        }
    else:
        endpoint = "audio/speech"
        body = {
            "model": model_config.model,
            "instructions": description,
            "input": preview_text,
            "response_format": "mp3",
            "metadata": {"sample_rate": 16000},
        }
    lease = None
    if egress_context.is_organization:
        lease = await claim_audio_operation(
            egress_context,
            capability="audio.voice_design",
            business_task_id=output_path.stem,
            request=body,
        )
        if lease.replay_error:
            raise VoiceDesignError("generation_unknown", unknown=True)
    try:
        credential = (
            await resolve_audio_gateway_credential(egress_context)
            if egress_context.is_organization
            else await get_model_credentials().resolve(
                _trusted_admission(egress_context)
            )
        )
        if credential.reference != egress_context.credential:
            raise VoiceDesignError("voice_design_forbidden")
        if execution_mode == "test_replay" and not _is_loopback_gateway(
            credential.base_url
        ):
            raise VoiceDesignError("voice_design_forbidden")
    except Exception:
        if lease is not None:
            await reject_audio_operation(lease)
        raise VoiceDesignError("voice_design_forbidden") from None
    meter = get_usage_meter()
    reservation_id = ""
    call_reserved = False
    try:
        reservation_id = await meter.reserve_current_model_call_credit(
            model=model_config.model,
            project_id=egress_context.project_id,
            resource_kind="audio",
            billing_kind="audio",
            metadata={"source": "voice_design"},
        )
        call_reserved = True
        # Leave time after the gateway's 280s poll window for a safe download
        # and full media decoding before the candidate lease expires.
        timeout = 360 if isinstance(model_config, PromptedSpeechConfig) else 90
        async with asyncio.timeout(timeout):
            async with aiohttp.ClientSession(
                timeout=aiohttp.ClientTimeout(total=timeout)
            ) as session:
                async with session.post(
                    credential.base_url.rstrip("/") + "/" + endpoint,
                    json=body,
                    headers={"Authorization": f"Bearer {credential.api_key}"},
                    allow_redirects=False,
                ) as response:
                    if response.status != 200:
                        code = {
                            401: "voice_design_forbidden",
                            403: "voice_design_forbidden",
                            402: "insufficient_credits",
                            429: "rate_limited",
                        }.get(response.status, "provider_unavailable")
                        raise VoiceDesignError(code)
                    raw = bytearray()
                    async for chunk in response.content.iter_chunked(65536):
                        raw.extend(chunk)
                        if len(raw) > 4 * ((MAX_AUDIO_BYTES + 2) // 3) + 65536:
                            raise VoiceDesignError("provider_bad_audio")
                    is_json = "json" in response.headers.get("Content-Type", "").lower()
            if isinstance(model_config, PromptedSpeechConfig):
                audio = await _persist_speech_preview(
                    bytes(raw), is_json=is_json, output_path=output_path
                )
            else:
                try:
                    payload = json.loads(raw)
                except (ValueError, UnicodeError):
                    raise VoiceDesignError("provider_bad_audio") from None
                if not isinstance(payload, dict):
                    raise VoiceDesignError("provider_bad_audio")
                _log_preview_shape(payload)
                audio = await persist_preview(payload, output_path)
        if lease is not None:
            await complete_audio_operation(
                lease, result_ref=f"voice-design:{audio.sha256}"
            )
        await _finish_model_call(meter, reservation_id, model=model_config.model)
        return audio
    except asyncio.CancelledError:
        if call_reserved:
            await _finish_model_call(
                meter, reservation_id, model=model_config.model, error="generation_unknown"
            )
        if lease is not None:
            await mark_audio_operation_unknown(lease)
        raise
    except Exception as exc:
        if call_reserved:
            await _finish_model_call(
                meter,
                reservation_id,
                model=model_config.model,
                error=exc.code if isinstance(exc, VoiceDesignError) else "generation_unknown",
            )
        if lease is not None:
            await mark_audio_operation_unknown(lease)
        if isinstance(exc, (TimeoutError, aiohttp.ClientError)):
            raise VoiceDesignError("generation_unknown", unknown=True) from None
        if isinstance(exc, VoiceDesignError):
            raise
        raise VoiceDesignError("provider_unavailable") from None
