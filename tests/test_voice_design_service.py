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


@pytest.fixture
def runner_case(enabled, monkeypatch, tmp_path, context, model_config):
    from types import SimpleNamespace
    from unittest.mock import AsyncMock
    from uuid import uuid4
    from novelvideo.audio import voice_design_service as service
    from novelvideo.audio import voice_design_storage as storage_module
    from novelvideo.project_context import ProjectContext
    from novelvideo.egress_context import (
        TrustedRunnerEnvelope,
        TRUSTED_EGRESS_CONTEXT_KEY,
    )

    ctx = ProjectContext(
        "project",
        "demo",
        "user",
        "owner",
        "owner",
        "user",
        "user",
        (),
        "editor",
        "local",
        tmp_path / "output",
        tmp_path / "state",
        tmp_path / "runtime",
        True,
    )
    now = [1000.0]
    store = storage_module.VoiceDesignStorage(
        ctx, clock=lambda: now[0], quota_path=tmp_path / "quota.sqlite3"
    )
    candidate_id = str(uuid4())
    store.reserve(
        candidate_id,
        description="声音",
        preview_text="今天的天气很好，我们沿着河边慢慢走回家。",
        language="zh",
        surface="supertale",
    )
    monkeypatch.setattr(storage_module, "VoiceDesignStorage", lambda _ctx: store)
    monkeypatch.setattr(
        service, "resolve_voice_design_config", AsyncMock(return_value=model_config)
    )
    envelope = TrustedRunnerEnvelope(
        {
            "project_id": ctx.project_id,
            "requester_user_id": ctx.requester_user_id,
            "task_type": "voice_design",
            "episode": 0,
            "scope": store.task_scope(candidate_id),
            "payload": {
                "candidate_id": candidate_id,
                "billing": model_config.billing_params(),
            },
            TRUSTED_EGRESS_CONTEXT_KEY: context,
        }
    )
    return SimpleNamespace(
        ctx=ctx, store=store, now=now, candidate_id=candidate_id, envelope=envelope
    )


@pytest.fixture
def core_case(monkeypatch, runner_case, context):
    from types import SimpleNamespace
    from unittest.mock import AsyncMock
    from novelvideo.generators.tts_generator import _trusted_admission
    from novelvideo.ports.usage import FeatureSettlementResolution
    from novelvideo.task_backend import run_core, cancel
    from novelvideo.task_backend.consumer import VerifiedTaskDelivery

    settlements = []
    identities = []

    class Usage:
        async def resolve_feature_credit_reservation(self, identity):
            identities.append(identity)
            return FeatureSettlementResolution(
                outcome="resolved",
                reservation_id="reservation",
                feature_key="audio.voice_design",
                model_call_credit_policy="feature_included",
            )

        async def settle_feature_credit_reservation(
            self, reservation_id, *, action, metadata=None
        ):
            settlements.append((action, reservation_id))

        async def settle_cancelled_feature_credit_reservation(
            self, reservation_id, **kwargs
        ):
            settlements.append(("refund", reservation_id))

    monkeypatch.setattr(run_core, "get_usage_meter", lambda: Usage())
    monkeypatch.setattr(run_core, "is_cancel_requested", AsyncMock(return_value=False))
    monkeypatch.setattr(cancel, "is_cancel_requested", AsyncMock(return_value=False))
    monkeypatch.setattr(run_core, "_emit_project_task_metrics", AsyncMock())
    monkeypatch.setattr(
        run_core, "_set_project_task_metrics_context", lambda *a, **kw: None
    )
    monkeypatch.setattr(run_core, "_clear_project_task_metrics_context", lambda: None)
    completed = []
    failed = []
    manager = SimpleNamespace(
        begin_task_execution_for_project=lambda *a, **kw: True,
        complete_task_for_project=lambda *a, **kw: completed.append(kw),
        fail_task_for_project=lambda *a, **kw: failed.append(kw),
        update_progress_for_project=lambda *a, **kw: None,
    )
    delivery = VerifiedTaskDelivery(
        envelope_id=context.envelope_id,
        admission=_trusted_admission(context),
        task_type="voice_design",
        project_id=context.project_id,
        requester_user_id=context.requester_user_id,
        episode=0,
        beat_num=None,
        scope=runner_case.envelope["scope"],
        queue_kind="default",
        payload=runner_case.envelope["payload"],
    )

    def run():
        return run_core.run_project_task_core_sync(
            delivery, runner_case.ctx, manager, run_task_id=context.root_task_id
        )

    return SimpleNamespace(
        run=run,
        settlements=settlements,
        identities=identities,
        completed=completed,
        failed=failed,
    )


def test_core_generates_and_replays_ready_with_same_reservation(
    runner_case, core_case, gateway, audio_bytes
):
    import base64

    calls, response, _ = gateway
    response.payload = {
        "preview_audio": {
            "data": base64.b64encode(audio_bytes).decode(),
            "format": "mp3",
            "sample_rate": 16000,
        }
    }
    first = core_case.run()
    second = core_case.run()
    assert first["status"] == second["status"] == "ready"
    assert first["sha256"] == second["sha256"]
    assert len(calls) == 1
    assert core_case.settlements == [
        ("confirm", "reservation"),
        ("confirm", "reservation"),
    ]
    assert {identity.root_task_id for identity in core_case.identities} == {"task"}
    assert {identity.feature_key for identity in core_case.identities} == {
        "audio.voice_design"
    }


@pytest.mark.parametrize("status", ["failed", "unknown", "expired", "queued_timeout"])
def test_core_does_not_confirm_terminal_failure(
    runner_case, core_case, gateway, status
):
    store = runner_case.store
    candidate_id = runner_case.candidate_id
    if status == "failed":
        store.fail(candidate_id, "provider_bad_audio")
    elif status == "unknown":
        store.claim(candidate_id)
        runner_case.now[0] += 121
    elif status == "queued_timeout":
        store.mark_queued(candidate_id)
        runner_case.now[0] += 601
    else:
        store.claim(candidate_id)
        path = store.output_path(candidate_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"validated bytes")
        import hashlib

        store.complete(
            candidate_id,
            duration_seconds=1,
            sha256=hashlib.sha256(path.read_bytes()).hexdigest(),
        )
        runner_case.now[0] += 3601
    expected_status = store.get(candidate_id)["status"]
    with pytest.raises(VoiceDesignError):
        core_case.run()
    assert core_case.completed == []
    assert core_case.settlements == [("refund", "reservation")]
    assert store.get(candidate_id)["status"] == expected_status
    assert gateway[0] == []


def test_claimed_core_replay_waits_without_settlement(
    runner_case, core_case, gateway, audio_bytes
):
    from concurrent.futures import ThreadPoolExecutor, TimeoutError
    from threading import Event
    import hashlib

    store = runner_case.store
    candidate_id = runner_case.candidate_id
    store.claim(candidate_id)
    seen = Event()
    original_get = store.get

    def observed_get(value):
        result = original_get(value)
        seen.set()
        return result

    store.get = observed_get
    with ThreadPoolExecutor(1) as executor:
        pending = executor.submit(core_case.run)
        assert seen.wait(2)
        with pytest.raises(TimeoutError):
            pending.result(timeout=0.1)
        assert core_case.settlements == []
        assert gateway[0] == []
        path = store.output_path(candidate_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(audio_bytes)
        store.complete(
            candidate_id,
            duration_seconds=1,
            sha256=hashlib.sha256(audio_bytes).hexdigest(),
        )
        assert pending.result(timeout=2)["status"] == "ready"
    assert core_case.settlements == [("confirm", "reservation")]
    assert gateway[0] == []


def test_claimed_core_replay_expires_without_confirm(runner_case, core_case, gateway):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Event

    store = runner_case.store
    store.claim(runner_case.candidate_id)
    seen = Event()
    original_get = store.get

    def observed_get(value):
        result = original_get(value)
        seen.set()
        return result

    store.get = observed_get
    with ThreadPoolExecutor(1) as executor:
        pending = executor.submit(core_case.run)
        assert seen.wait(2)
        assert core_case.settlements == []
        runner_case.now[0] += 121
        with pytest.raises(VoiceDesignError) as error:
            pending.result(timeout=2)
        assert error.value.unknown
    assert core_case.settlements == [("refund", "reservation")]
    assert gateway[0] == []


@pytest.mark.parametrize("reason", ["cancelled", "timeout"])
def test_core_cancellation_preserves_unknown_without_confirm(
    runner_case, core_case, gateway, monkeypatch, reason
):
    import asyncio
    from novelvideo.audio import voice_design_service as service
    from novelvideo.task_backend import cancel, run_core

    started = []

    async def waiting(**kwargs):
        started.append(True)
        await asyncio.Event().wait()

    monkeypatch.setattr(service, "generate_voice_design", waiting)
    if reason == "cancelled":

        async def cancelled(**kwargs):
            return bool(started)

        monkeypatch.setattr(cancel, "is_cancel_requested", cancelled)
    else:
        monkeypatch.setattr(run_core, "_project_task_timeout_seconds", lambda: 0.05)
    result = core_case.run()
    assert started
    assert result.get("cancelled") or result.get("failed")
    assert runner_case.store.get(runner_case.candidate_id)["status"] == "unknown"
    assert core_case.settlements == [("refund", "reservation")]
    assert core_case.completed == []
    assert gateway[0] == []


@pytest.mark.parametrize(
    "limit", ["VOICE_DESIGN_DAILY_LIMIT", "VOICE_DESIGN_CHANNEL_DAILY_LIMIT"]
)
def test_persistent_quota_precedes_runner_gateway(
    runner_case, core_case, gateway, context, monkeypatch, limit
):
    from uuid import uuid4

    store = runner_case.store
    previous = str(uuid4())
    store.reserve(
        previous,
        description="声音",
        preview_text="今天的天气很好，我们沿着河边慢慢走回家。",
        language="zh",
        surface="supertale",
    )
    store.claim(
        previous, channel_key=context.credential.credential_id, channel_daily_limit=100
    )
    store.fail(previous, "provider_bad_audio")
    monkeypatch.setenv(limit, "1")
    from novelvideo.audio.voice_design_storage import CandidateStorageError

    with pytest.raises(CandidateStorageError) as error:
        core_case.run()
    assert error.value.code == "voice_design_quota_exceeded"
    assert core_case.settlements == [("refund", "reservation")]
    assert core_case.completed == []
    assert gateway[0] == []
