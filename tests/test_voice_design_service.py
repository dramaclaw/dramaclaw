import pytest

from novelvideo.audio.voice_design_service import (
    VoiceDesignError,
    ensure_voice_design_enabled,
    resolve_voice_design_catalog,
)


def test_feature_disabled_and_budget_required(monkeypatch):
    monkeypatch.delenv("VOICE_DESIGN_ENABLED", raising=False)
    with pytest.raises(VoiceDesignError):
        ensure_voice_design_enabled()
    monkeypatch.setenv("VOICE_DESIGN_ENABLED", "1")
    monkeypatch.delenv("VOICE_DESIGN_DAILY_LIMIT", raising=False)
    with pytest.raises(VoiceDesignError):
        ensure_voice_design_enabled()


def test_catalog_target_visibility_and_billing_once():
    design = {
        "id": "design",
        "gateway_model": "voice-enrollment",
        "request": {"endpoint": "audio/voice-designs"},
        "targetModel": "target",
    }
    target = {
        "id": "target",
        "gateway_model": "cosyvoice-v3.5-flash",
        "request": {"endpoint": "audio/speech"},
    }
    with pytest.raises(VoiceDesignError):
        resolve_voice_design_catalog([design])
    resolved = resolve_voice_design_catalog([design, target])
    assert resolved.billing_params()["item_count"] == 1
    assert resolved.billing_params()["pricing_kind"] == "audio"
    assert resolved.target_model == "cosyvoice-v3.5-flash"


@pytest.mark.parametrize(
    "preview",
    [
        None,
        {},
        {"data": "%%%", "format": "mp3", "sample_rate": 16000},
        {"data": "YQ==", "format": "wav", "sample_rate": 16000},
        {"data": "YQ==", "format": "mp3", "sample_rate": 16000},
    ],
)
async def test_invalid_preview_is_not_published(tmp_path, preview):
    from novelvideo.audio.voice_design_service import persist_preview

    path = tmp_path / "candidate.mp3"
    with pytest.raises(VoiceDesignError):
        await persist_preview({"preview_audio": preview}, path)
    assert not path.exists()


@pytest.fixture
def enabled(monkeypatch):
    monkeypatch.setenv("VOICE_DESIGN_ENABLED", "1")
    monkeypatch.setenv("VOICE_DESIGN_DAILY_LIMIT", "20")
    monkeypatch.setenv("VOICE_DESIGN_CHANNEL_DAILY_LIMIT", "100")


@pytest.fixture
def context():
    from novelvideo.egress_context import TrustedEgressContext
    from novelvideo.ports.authz import BillingPrincipal
    from novelvideo.ports.model_credentials import CredentialReference

    return TrustedEgressContext(
        envelope_id="envelope",
        project_id="project",
        task_type="voice_design",
        requester_user_id="user",
        root_task_id="task",
        admission_id="admission",
        admitted_at="now",
        membership_id="membership",
        authz_version=1,
        billing_principal=BillingPrincipal(kind="organization", id="org"),
        credential=CredentialReference(
            source="organization", credential_id="key", key_version=1, org_id="org"
        ),
    )


@pytest.fixture
def model_config():
    from novelvideo.audio.voice_design_service import ResolvedVoiceDesignConfig

    return ResolvedVoiceDesignConfig(
        "design", "target", "voice-enrollment", "cosyvoice-v3.5-flash", "digest"
    )


@pytest.fixture
def audio_bytes(tmp_path):
    import subprocess

    path = tmp_path / "source.mp3"
    subprocess.run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:duration=1",
            "-ar",
            "16000",
            "-ac",
            "1",
            str(path),
        ],
        check=True,
    )
    return path.read_bytes()


async def test_preview_is_real_decodable_mp3(tmp_path, audio_bytes):
    import base64
    from novelvideo.audio.voice_design_service import persist_preview

    result = await persist_preview(
        {
            "preview_audio": {
                "data": base64.b64encode(audio_bytes).decode(),
                "format": "mp3",
                "sample_rate": 16000,
            }
        },
        tmp_path / "candidate.mp3",
    )
    assert 0 < result.duration_seconds < 2
    assert result.path.read_bytes() == audio_bytes


@pytest.mark.parametrize("duration", [16])
async def test_long_preview_is_not_published(tmp_path, duration):
    import base64
    import subprocess
    from novelvideo.audio.voice_design_service import persist_preview

    path = tmp_path / "source.mp3"
    subprocess.run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            f"sine=duration={duration}",
            "-ar",
            "16000",
            "-ac",
            "1",
            str(path),
        ],
        check=True,
    )
    output = tmp_path / "candidate.mp3"
    with pytest.raises(VoiceDesignError) as error:
        await persist_preview(
            {
                "preview_audio": {
                    "data": base64.b64encode(path.read_bytes()).decode(),
                    "format": "mp3",
                    "sample_rate": 16000,
                }
            },
            output,
        )
    assert error.value.code == "candidate_duration_exceeded"
    assert not output.exists()


async def test_oversize_preview_is_not_published(tmp_path):
    import base64
    from novelvideo.audio.voice_design_service import persist_preview, MAX_AUDIO_BYTES

    with pytest.raises(VoiceDesignError):
        await persist_preview(
            {
                "preview_audio": {
                    "data": base64.b64encode(b"x" * (MAX_AUDIO_BYTES + 1)).decode(),
                    "format": "mp3",
                    "sample_rate": 16000,
                }
            },
            tmp_path / "candidate.mp3",
        )
    assert not (tmp_path / "candidate.mp3").exists()


@pytest.mark.parametrize(
    "url",
    [
        "http://example.com/a",
        "https://127.0.0.1/a",
        "https://[::1]/a",
        "https://user:password@example.com/a",
    ],
)
async def test_preview_url_rejects_unsafe_targets(url):
    from novelvideo.audio.voice_design_service import _download_preview

    with pytest.raises(VoiceDesignError):
        await _download_preview(url)


@pytest.fixture
def gateway(monkeypatch, context):
    from types import SimpleNamespace
    from unittest.mock import AsyncMock
    from novelvideo.audio import voice_design_service as service
    from novelvideo.ports.local.egress_operations import LocalEgressOperations
    from novelvideo.ports.model_credentials import RequestCredential
    from novelvideo.ports.registry import _PORTS

    monkeypatch.setitem(_PORTS, "egress_operations", LocalEgressOperations())
    credentials = AsyncMock(
        return_value=RequestCredential(
            context.credential, "secret", "https://gateway.example/v1"
        )
    )
    monkeypatch.setitem(
        _PORTS, "model_credentials", SimpleNamespace(resolve=credentials)
    )
    calls = []

    class Response:
        status = 200

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        @property
        def content(self):
            return self

        async def iter_chunked(self, size):
            import json

            if isinstance(self.payload, Exception):
                raise self.payload
            yield json.dumps(self.payload).encode()

    response = Response()
    response.payload = {}

    class Session:
        def __init__(self, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        def post(self, url, **kwargs):
            calls.append((url, kwargs))
            return response

    monkeypatch.setattr(service.aiohttp, "ClientSession", Session)
    return calls, response, credentials


async def test_gateway_voice_enrollment_contract(
    enabled, gateway, context, model_config, tmp_path, audio_bytes
):
    import base64
    from novelvideo.audio.voice_design_service import generate_voice_design

    calls, response, _ = gateway
    response.payload = {
        "preview_audio": {
            "data": base64.b64encode(audio_bytes).decode(),
            "format": "mp3",
            "sample_rate": 16000,
        }
    }
    result = await generate_voice_design(
        request={
            "description": "沙哑的声音",
            "preview_text": "今天的天气很好，我们沿着河边慢慢走回家。",
        },
        output_path=tmp_path / "result.mp3",
        egress_context=context,
        model_config=model_config,
    )
    assert result.path.exists()
    assert len(calls) == 1
    assert calls[0][0] == "https://gateway.example/v1/audio/voice-designs"
    assert calls[0][1]["json"] == {
        "model": "voice-enrollment",
        "target_model": "cosyvoice-v3.5-flash",
        "preferred_name": "dc891",
        "voice_prompt": "沙哑的声音",
        "preview_text": "今天的天气很好，我们沿着河边慢慢走回家。",
        "language": "zh",
        "sample_rate": 16000,
        "response_format": "mp3",
    }
    assert calls[0][1]["allow_redirects"] is False


async def test_unknown_generation_is_not_resubmitted(
    enabled, gateway, context, model_config, tmp_path
):
    from novelvideo.audio.voice_design_service import generate_voice_design

    calls, response, _ = gateway
    response.payload = TimeoutError()
    for _ in range(2):
        with pytest.raises(VoiceDesignError) as error:
            await generate_voice_design(
                request={
                    "description": "声音",
                    "preview_text": "今天的天气很好，我们沿着河边慢慢走回家。",
                },
                output_path=tmp_path / "result.mp3",
                egress_context=context,
                model_config=model_config,
            )
        assert error.value.unknown
    assert len(calls) == 1


async def test_voice_design_respects_trusted_egress(
    enabled, gateway, context, model_config, tmp_path
):
    from novelvideo.audio.voice_design_service import generate_voice_design
    from novelvideo.ports.model_credentials import ModelCredentialError

    calls, _, credentials = gateway
    credentials.side_effect = ModelCredentialError("ORG_CREDENTIAL_MISSING")
    for trusted in (None, context):
        with pytest.raises(VoiceDesignError):
            await generate_voice_design(
                request={
                    "description": "声音",
                    "preview_text": "今天的天气很好，我们沿着河边慢慢走回家。",
                },
                output_path=tmp_path / "result.mp3",
                egress_context=trusted,
                model_config=model_config,
            )
    assert calls == []


async def test_admission_and_budget_precede_provider_call(
    enabled, gateway, context, model_config, tmp_path, monkeypatch
):
    from novelvideo.audio.voice_design_service import generate_voice_design

    calls, _, _ = gateway
    monkeypatch.delenv("VOICE_DESIGN_CHANNEL_DAILY_LIMIT")
    with pytest.raises(VoiceDesignError):
        await generate_voice_design(
            request={
                "description": "声音",
                "preview_text": "今天的天气很好，我们沿着河边慢慢走回家。",
            },
            output_path=tmp_path / "result.mp3",
            egress_context=context,
            model_config=model_config,
        )
    assert calls == []


async def test_public_resolver_rejects_private_dns(monkeypatch):
    import asyncio
    import socket
    from unittest.mock import AsyncMock
    from novelvideo.audio.voice_design_service import _PublicResolver

    monkeypatch.setattr(
        asyncio.get_running_loop(),
        "getaddrinfo",
        AsyncMock(
            return_value=[
                (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("10.0.0.1", 443))
            ]
        ),
    )
    with pytest.raises(VoiceDesignError):
        await _PublicResolver().resolve("preview.example", 443)


@pytest.mark.parametrize(
    ("code", "expected"),
    [
        ("MEDIA_MODEL_SCOPE_DENIED", "voice_design_forbidden"),
        ("MEDIA_MODEL_CONFIG_INVALID", "voice_design_unavailable"),
        ("", "voice_design_unavailable"),
    ],
)
async def test_scoped_catalog_never_falls_back(enabled, monkeypatch, code, expected):
    from types import SimpleNamespace
    from unittest.mock import AsyncMock
    from novelvideo.ports.registry import _PORTS
    from novelvideo.audio.voice_design_service import resolve_voice_design_config

    failure = RuntimeError("internal detail")
    failure.code = code
    scoped = AsyncMock(side_effect=failure)
    monkeypatch.setitem(
        _PORTS, "media_model_catalog", SimpleNamespace(list_models_for_project=scoped)
    )
    with pytest.raises(VoiceDesignError) as error:
        await resolve_voice_design_config(user_id="requester", project_id="project")
    assert error.value.code == expected
    assert str(error.value) == expected
    scoped.assert_awaited_once_with("audio", user_id="requester", project_id="project")


@pytest.mark.parametrize(
    ("surface", "product"), [("supertale", "mainline"), ("canvas", "freezone")]
)
async def test_project_quote_uses_trusted_scope_and_one_item(
    enabled, monkeypatch, model_config, surface, product
):
    from types import SimpleNamespace
    from unittest.mock import AsyncMock
    from novelvideo.audio import voice_design_service as service
    from novelvideo.ports.credit_quote import CreditQuote

    resolve = AsyncMock(return_value=model_config)
    quote = AsyncMock(return_value=CreditQuote(total_cost=1, display="1"))
    monkeypatch.setattr(service, "resolve_voice_design_config", resolve)
    monkeypatch.setattr(
        service,
        "get_credit_quote",
        lambda: SimpleNamespace(generation_credit_quote=quote),
    )
    result = await service.quote_voice_design(
        ctx=SimpleNamespace(requester_user_id="requester", project_id="project"),
        surface=surface,
    )
    resolve.assert_awaited_once_with(user_id="requester", project_id="project")
    assert quote.call_args.kwargs["params"] == model_config.billing_params()
    assert quote.call_args.kwargs["quantity"] == 1
    assert quote.call_args.kwargs["product_surface"] == product
    assert result == {
        "ok": True,
        "data": {"cost": 1, "display": "1", "unit": "call", "quantity": 1},
    }


def test_voice_design_rejects_non_cosyvoice_target():
    design = {
        "id": "design",
        "gateway_model": "voice-enrollment",
        "request": {"endpoint": "audio/voice-designs"},
        "targetModel": "target",
    }
    target = {
        "id": "target",
        "gateway_model": "unsupported-tts",
        "request": {"endpoint": "audio/speech"},
    }
    with pytest.raises(VoiceDesignError):
        resolve_voice_design_catalog([design, target])
    target["aliases"] = ["cosyvoice-v3.5-flash"]
    assert (
        resolve_voice_design_catalog([design, target]).target_model == "unsupported-tts"
    )


@pytest.mark.parametrize(("rate", "channels"), [(22050, 1), (16000, 2)])
async def test_preview_metadata_cannot_hide_wrong_audio(tmp_path, rate, channels):
    import base64
    import subprocess
    from novelvideo.audio.voice_design_service import persist_preview

    source = tmp_path / "source.mp3"
    subprocess.run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "sine=duration=1",
            "-ar",
            str(rate),
            "-ac",
            str(channels),
            str(source),
        ],
        check=True,
    )
    with pytest.raises(VoiceDesignError):
        await persist_preview(
            {
                "preview_audio": {
                    "data": base64.b64encode(source.read_bytes()).decode(),
                    "format": "mp3",
                    "sample_rate": 16000,
                }
            },
            tmp_path / "candidate.mp3",
        )
    assert not (tmp_path / "candidate.mp3").exists()


async def test_platform_credential_does_not_claim_organization_ledger(
    enabled, gateway, context, model_config, audio_bytes, tmp_path, monkeypatch
):
    import base64
    from dataclasses import replace
    from unittest.mock import AsyncMock
    from novelvideo.audio import voice_design_service as service
    from novelvideo.ports.authz import BillingPrincipal
    from novelvideo.ports.model_credentials import (
        CredentialReference,
        RequestCredential,
    )

    calls, response, credentials = gateway
    platform = replace(
        context,
        billing_principal=BillingPrincipal(kind="platform", id="user"),
        credential=CredentialReference(
            source="platform", credential_id="platform-key", key_version=1
        ),
    )
    credentials.return_value = RequestCredential(
        platform.credential, "test-key", "https://gateway.example/v1"
    )
    claim = AsyncMock(side_effect=AssertionError("platform is not an organization"))
    monkeypatch.setattr(service, "claim_audio_operation", claim)
    response.payload = {
        "preview_audio": {
            "data": base64.b64encode(audio_bytes).decode(),
            "format": "mp3",
            "sample_rate": 16000,
        }
    }
    await service.generate_voice_design(
        request={
            "description": "声音",
            "preview_text": "今天的天气很好，我们沿着河边慢慢走回家。",
        },
        output_path=tmp_path / "result.mp3",
        egress_context=platform,
        model_config=model_config,
    )
    claim.assert_not_awaited()
    assert len(calls) == 1


async def test_preview_redirect_cannot_reach_private_host(monkeypatch):
    from novelvideo.audio import voice_design_service as service

    calls = []

    class Response:
        status = 302
        headers = {"Location": "https://127.0.0.1/private"}

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

    class Session:
        def __init__(self, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        def get(self, url, **kwargs):
            calls.append((url, kwargs))
            return Response()

    monkeypatch.setattr(service.aiohttp, "TCPConnector", lambda **kwargs: None)
    monkeypatch.setattr(service.aiohttp, "ClientSession", Session)
    with pytest.raises(VoiceDesignError):
        await service._download_preview("https://preview.example/audio.mp3")
    assert calls == [("https://preview.example/audio.mp3", {"allow_redirects": False})]


@pytest.mark.parametrize(
    ("status", "code"),
    [
        (401, "voice_design_forbidden"),
        (403, "voice_design_forbidden"),
        (402, "insufficient_credits"),
        (429, "rate_limited"),
        (500, "provider_unavailable"),
    ],
)
async def test_gateway_failure_is_redacted(
    enabled, gateway, context, model_config, tmp_path, status, code
):
    from novelvideo.audio.voice_design_service import generate_voice_design

    calls, response, _ = gateway
    response.status = status
    response.payload = {"error": "unsafe provider credentials"}
    with pytest.raises(VoiceDesignError) as error:
        await generate_voice_design(
            request={
                "description": "声音",
                "preview_text": "今天的天气很好，我们沿着河边慢慢走回家。",
            },
            output_path=tmp_path / "result.mp3",
            egress_context=context,
            model_config=model_config,
        )
    assert error.value.code == code
    assert str(error.value) == code
    assert len(calls) == 1
    assert not (tmp_path / "result.mp3").exists()
