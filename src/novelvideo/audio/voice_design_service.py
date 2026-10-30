"""One-shot voice design through the authenticated model gateway."""

from __future__ import annotations

import asyncio
import base64
import binascii
import hashlib
import ipaddress
import json
import math
import os
import socket
import subprocess
import tempfile
from dataclasses import asdict, dataclass
from pathlib import Path
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
from novelvideo.ports import get_credit_quote, get_model_credentials
from novelvideo.project_context import ProjectContext
from novelvideo.ports.registry import PortNotRegistered, get_port

MAX_AUDIO_BYTES = 10 * 1024 * 1024


class VoiceDesignError(RuntimeError):
    def __init__(self, code: str, *, unknown: bool = False):
        super().__init__(code)
        self.code = code
        self.unknown = unknown


@dataclass(frozen=True)
class ResolvedVoiceDesignConfig:
    model_id: str
    target_model_id: str
    model: str
    target_model: str
    config_digest: str

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


def resolve_voice_design_catalog(entries: list[dict]) -> ResolvedVoiceDesignConfig:
    visible = {
        str(e.get("catalogId") or e.get("catalog_id") or e.get("id")): e
        for e in entries
        if e.get("enabled") is not False
    }
    designs = [
        (key, e)
        for key, e in visible.items()
        if e.get("request", {}).get("endpoint") == "audio/voice-designs"
    ]
    if len(designs) != 1:
        raise VoiceDesignError("voice_design_unavailable")
    model_id, design = designs[0]
    target_id = design.get("targetModel")
    target = visible.get(target_id)
    if not target or target.get("request", {}).get("endpoint") != "audio/speech":
        raise VoiceDesignError("voice_design_unavailable")
    try:
        validate_media_model_catalog_config(
            {"request": design.get("request"), "targetModel": target_id}, "audio"
        )
        validate_media_model_catalog_config({"request": target.get("request")}, "audio")
    except ValueError:
        raise VoiceDesignError("voice_design_unavailable") from None
    model = str(design.get("gateway_model") or design.get("gatewayModel") or "")
    target_model = str(target.get("gateway_model") or target.get("gatewayModel") or "")
    target_names = {target_model, target_id, *(target.get("aliases") or [])}
    if not model or "cosyvoice-v3.5-flash" not in target_names:
        raise VoiceDesignError("voice_design_unavailable")
    digest = hashlib.sha256(
        json.dumps([design, target], sort_keys=True).encode()
    ).hexdigest()
    return ResolvedVoiceDesignConfig(model_id, target_id, model, target_model, digest)


async def resolve_voice_design_config(
    *, user_id: str, project_id: str
) -> ResolvedVoiceDesignConfig:
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
    return resolve_voice_design_catalog(entries)


async def quote_voice_design(*, ctx: ProjectContext, surface: str) -> dict:
    from novelvideo.api.routes.model_credits import _credit_product_surface

    if surface not in {"supertale", "canvas"}:
        raise VoiceDesignError("invalid_input")
    resolved = await resolve_voice_design_config(
        user_id=ctx.requester_user_id,
        project_id=ctx.project_id,
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


def _verify_audio(path: Path) -> float:
    from novelvideo.freezone.reference_validation import _ffprobe

    info = _ffprobe(path)
    streams = info.get("streams", [])
    duration = float(info.get("format", {}).get("duration", 0))
    if (
        len(streams) != 1
        or streams[0].get("codec_name") != "mp3"
        or int(streams[0].get("sample_rate", 0)) != 16000
        or streams[0].get("channels") != 1
        or not math.isfinite(duration)
        or duration <= 0
    ):
        raise VoiceDesignError("provider_bad_audio")
    if duration > 15:
        raise VoiceDesignError("candidate_duration_exceeded")
    subprocess.run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-xerror",
            "-protocol_whitelist",
            "file,pipe",
            "-i",
            str(path),
            "-f",
            "null",
            "-",
        ],
        capture_output=True,
        check=True,
        timeout=20,
    )
    return duration


async def persist_preview(payload: dict, output_path: Path) -> VoiceDesignAudio:
    preview = payload.get("preview_audio")
    if (
        not isinstance(preview, dict)
        or preview.get("format") != "mp3"
        or preview.get("sample_rate") != 16000
    ):
        raise VoiceDesignError("provider_bad_audio")
    temporary = None
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
        if not 0 < len(data) <= MAX_AUDIO_BYTES:
            raise VoiceDesignError("provider_bad_audio")
        output_path.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(
            dir=output_path.parent, suffix=".mp3", delete=False
        ) as stream:
            temporary = Path(stream.name)
            stream.write(data)
        duration = await asyncio.to_thread(_verify_audio, temporary)
        os.replace(temporary, output_path)
        return VoiceDesignAudio(output_path, duration, hashlib.sha256(data).hexdigest())
    except (
        ValueError,
        binascii.Error,
        OSError,
        subprocess.SubprocessError,
        aiohttp.ClientError,
    ):
        raise VoiceDesignError("provider_bad_audio") from None
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


async def generate_voice_design(
    *,
    request: dict,
    output_path: Path,
    egress_context: TrustedEgressContext,
    model_config: ResolvedVoiceDesignConfig,
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
    except Exception:
        if lease is not None:
            await reject_audio_operation(lease)
        raise VoiceDesignError("voice_design_forbidden") from None
    try:
        async with asyncio.timeout(90):
            async with aiohttp.ClientSession(
                timeout=aiohttp.ClientTimeout(total=90)
            ) as session:
                async with session.post(
                    credential.base_url.rstrip("/") + "/audio/voice-designs",
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
                    payload = json.loads(raw)
                    if not isinstance(payload, dict):
                        raise VoiceDesignError("provider_bad_audio")
            audio = await persist_preview(payload, output_path)
        if lease is not None:
            await complete_audio_operation(
                lease, result_ref=f"voice-design:{audio.sha256}"
            )
        return audio
    except asyncio.CancelledError:
        if lease is not None:
            await mark_audio_operation_unknown(lease)
        raise
    except Exception as exc:
        if lease is not None:
            await mark_audio_operation_unknown(lease)
        if isinstance(exc, (TimeoutError, aiohttp.ClientError)):
            raise VoiceDesignError("generation_unknown", unknown=True) from None
        if isinstance(exc, VoiceDesignError):
            raise
        raise VoiceDesignError("provider_unavailable") from None
