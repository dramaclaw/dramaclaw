from __future__ import annotations

import sys
from pathlib import Path
from types import ModuleType, SimpleNamespace

import pytest

from novelvideo.egress_context import TrustedEgressContext
from novelvideo.ports.authz import BillingPrincipal
from novelvideo.ports.egress_operations import (
    EgressOperationError,
    OperationClaimResult,
    OperationSnapshot,
    OperationState,
)
from novelvideo.ports.model_credentials import (
    CredentialReference,
    ModelCredentialError,
    RequestCredential,
)


def _context(kind: str = "organization") -> TrustedEgressContext:
    principal_id = "org-1" if kind == "organization" else "local-user-1"
    return TrustedEgressContext(
        envelope_id="envelope-1",
        project_id="project-1",
        task_type="freezone_audio_speech",
        requester_user_id="user-1",
        root_task_id="root-task-1",
        admission_id="admission-1",
        membership_id="membership-1" if kind == "organization" else None,
        authz_version=7,
        billing_principal=BillingPrincipal(kind=kind, id=principal_id),
        credential=CredentialReference(
            source=kind,
            credential_id=f"{kind}-credential-1",
            key_version=3,
            org_id="org-1" if kind == "organization" else None,
        ),
    )


class _CredentialPort:
    def __init__(self, *, error: str | None = None) -> None:
        self.error = error
        self.admissions = []

    async def resolve(self, admission):
        self.admissions.append(admission)
        if self.error:
            raise ModelCredentialError(self.error, "unsafe resolver detail")
        return RequestCredential(
            reference=admission.credential,
            api_key="org-secret-key",
            base_url="https://gateway.example/v1",
        )


class _OperationPort:
    def __init__(
        self, events: list[str], *, existing_state: OperationState | None = None
    ):
        self.events = events
        self.existing_state = existing_state
        self.specs = []

    async def claim(self, *, spec):
        self.events.append("claim")
        self.specs.append(spec)
        state = self.existing_state or OperationState.DISPATCHING
        return OperationClaimResult(
            won=self.existing_state is None,
            operation=OperationSnapshot("operation-1", spec.operation_key, state, 1),
            transition_token=(
                None if self.existing_state is not None else "transition-1"
            ),
        )

    async def mark_rejected_before_submit(self, **kwargs):
        self.events.append("rejected")
        return OperationSnapshot(
            "operation-1", "operation-key", OperationState.REJECTED_BEFORE_SUBMIT, 2
        )

    async def mark_accepted(self, **kwargs):
        self.events.append("accepted")
        return OperationSnapshot(
            "operation-1", "operation-key", OperationState.ACCEPTED, 2
        )

    async def mark_completed(self, **kwargs):
        self.events.append("completed")
        return OperationSnapshot(
            "operation-1", "operation-key", OperationState.COMPLETED, 3
        )

    async def mark_unknown(self, **kwargs):
        self.events.append("unknown")
        return OperationSnapshot(
            "operation-1", "operation-key", OperationState.UNKNOWN, 2
        )


class _Response:
    def __init__(
        self,
        *,
        content: bytes = b"audio",
        status_code: int = 200,
        content_type: str = "audio/mpeg",
        text: str = "",
    ) -> None:
        self.content = content
        self.status_code = status_code
        self.headers = {"content-type": content_type}
        self.text = text

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            import httpx

            request = httpx.Request("POST", "https://gateway.example/v1/audio/speech")
            raise httpx.HTTPStatusError(
                "unsafe provider response",
                request=request,
                response=httpx.Response(
                    self.status_code,
                    request=request,
                    text=self.text,
                ),
            )

    def json(self):
        return {"audio": {"url": "https://fal/audio"}}


class _AsyncClient:
    def __init__(self, events: list[str], responses: list[_Response], captured: dict):
        self.events = events
        self.responses = responses
        self.captured = captured

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return None

    async def post(self, endpoint, *, headers, json):
        self.events.append("post")
        self.captured.update(endpoint=endpoint, headers=headers, body=json)
        return self.responses.pop(0)

    async def get(self, _url):
        self.events.append("get")
        return self.responses.pop(0)


def _install_ports(monkeypatch, credential_port, operation_port) -> None:
    import novelvideo.ports as ports

    monkeypatch.setattr(ports, "get_model_credentials", lambda: credential_port)
    monkeypatch.setattr(ports, "get_egress_operation_port", lambda: operation_port)


@pytest.mark.asyncio
async def test_audio_runner_propagates_same_trusted_context_to_beat_leaf(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    from novelvideo.egress_context import (
        TRUSTED_EGRESS_CONTEXT_KEY,
        TrustedRunnerEnvelope,
    )
    from novelvideo.task_backend.runners import audio as audio_runner
    import novelvideo.audio.indextts2_beat_audio_task as beat_task
    import novelvideo.sqlite_store as sqlite_store

    context = _context()
    captured: dict = {}

    class Store:
        def __init__(self, *_args, **_kwargs):
            pass

        async def initialize(self):
            return None

        async def close(self):
            return None

    async def fake_run(**kwargs):
        captured.update(kwargs)
        return SimpleNamespace(
            generated=0,
            total_targets=0,
            skipped_existing=0,
            skipped_empty=0,
            skipped_manual=0,
            skipped_silence=0,
            skipped_non_dialogue=0,
            failed=[],
            generated_beats=[],
            to_dict=lambda: {},
        )

    monkeypatch.setattr(sqlite_store, "SQLiteStore", Store)
    monkeypatch.setattr(beat_task, "run_indextts2_beat_audio_generation", fake_run)
    monkeypatch.setattr(
        audio_runner,
        "get_task_manager",
        lambda: SimpleNamespace(
            update_progress_for_project=lambda *_args, **_kwargs: None
        ),
    )
    envelope = TrustedRunnerEnvelope(
        {
            "episode": 1,
            "payload": {"episode": 1},
            TRUSTED_EGRESS_CONTEXT_KEY: context,
        }
    )
    ctx = SimpleNamespace(
        owner_project_label="owner/project",
        output_dir=tmp_path / "output",
        state_dir=tmp_path / "state",
        owner_username="owner",
        project_name="project",
    )

    await audio_runner._run_indextts2_audio(envelope, ctx)

    assert captured["egress_context"] is context


@pytest.mark.asyncio
async def test_eg15a_organization_uses_exact_gateway_credential_after_claim(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    from novelvideo.generators import indextts2_fal

    events: list[str] = []
    captured: dict = {}
    credential_port = _CredentialPort()
    operation_port = _OperationPort(events)
    _install_ports(monkeypatch, credential_port, operation_port)
    monkeypatch.setattr(
        indextts2_fal, "_reserve_tts_model_call", _async_value("reservation-1")
    )
    monkeypatch.setattr(indextts2_fal, "_confirm_tts_model_call", _async_value(None))
    monkeypatch.setattr(indextts2_fal, "_audio_duration_seconds", _async_value(1.25))
    monkeypatch.setattr(
        indextts2_fal.httpx,
        "AsyncClient",
        lambda **_kwargs: _AsyncClient(events, [_Response()], captured),
    )
    monkeypatch.setattr(
        "novelvideo.config.get_effective_newapi_gateway_config",
        lambda: pytest.fail("organization path must not read platform gateway config"),
    )

    client = indextts2_fal.IndexTTS2FalClient(
        provider="newapi",
        api_key="platform-secret-must-not-be-used",
        endpoint="https://platform.example/v1",
        egress_context=_context(),
    )
    result = await client.generate(
        prompt="hello",
        audio_url="data:audio/mpeg;base64,AA==",
        output_path=tmp_path / "speech.mp3",
    )

    assert result.success is True
    assert events == ["claim", "post", "accepted", "completed"]
    assert captured["endpoint"] == "https://gateway.example/v1/audio/speech"
    assert captured["headers"]["Authorization"] == "Bearer org-secret-key"
    assert credential_port.admissions[0].credential == _context().credential
    assert operation_port.specs[0].credential_version == 3


@pytest.mark.asyncio
async def test_eg15a_missing_exact_credential_has_no_fal_or_env_fallback(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    from novelvideo.generators import indextts2_fal

    events: list[str] = []
    credential_port = _CredentialPort(error="ORG_CREDENTIAL_VERSION_MISMATCH")
    operation_port = _OperationPort(events)
    _install_ports(monkeypatch, credential_port, operation_port)
    monkeypatch.setenv("FAL_KEY", "fallback-secret")
    monkeypatch.setattr(
        indextts2_fal.httpx,
        "AsyncClient",
        lambda **_kwargs: pytest.fail("transport must remain zero"),
    )

    client = indextts2_fal.IndexTTS2FalClient(
        provider="newapi",
        egress_context=_context(),
    )
    result = await client.generate(
        prompt="hello",
        audio_url="data:audio/mpeg;base64,AA==",
        output_path=tmp_path / "speech.mp3",
    )

    assert result.success is False
    assert result.error == "ORG_CREDENTIAL_VERSION_MISMATCH"
    assert events == ["claim", "rejected"]
    assert "fallback-secret" not in repr(result)


@pytest.mark.asyncio
async def test_eg15b_platform_stays_available_but_organization_denies_fal_before_transport(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    from novelvideo.generators import indextts2_fal

    events: list[str] = []
    captured: dict = {}
    monkeypatch.setattr(
        indextts2_fal, "_reserve_tts_model_call", _async_value("reservation-1")
    )
    monkeypatch.setattr(indextts2_fal, "_confirm_tts_model_call", _async_value(None))
    monkeypatch.setattr(indextts2_fal, "_audio_duration_seconds", _async_value(1.0))
    monkeypatch.setattr(
        indextts2_fal.httpx,
        "AsyncClient",
        lambda **_kwargs: _AsyncClient(
            events,
            [
                _Response(content_type="application/json"),
                _Response(content=b"fal-audio"),
            ],
            captured,
        ),
    )
    monkeypatch.setattr(
        indextts2_fal, "_extract_audio_url", lambda _payload: "https://fal/audio"
    )

    platform = indextts2_fal.IndexTTS2FalClient(
        provider="fal", api_key="fal-platform-key", endpoint="https://fal.example/run"
    )
    assert (
        await platform.generate(
            prompt="hello",
            audio_url="data:audio/mpeg;base64,AA==",
            output_path=tmp_path / "platform.mp3",
        )
    ).success

    before = list(events)
    organization = indextts2_fal.IndexTTS2FalClient(
        provider="fal",
        api_key="fal-org-key-must-not-be-used",
        endpoint="https://fal.example/run",
        egress_context=_context(),
    )
    denied = await organization.generate(
        prompt="hello",
        audio_url="data:audio/mpeg;base64,AA==",
        output_path=tmp_path / "denied.mp3",
    )
    assert denied.success is False
    assert denied.error == "ORG_EGRESS_DENIED"
    assert events == before


@pytest.mark.asyncio
async def test_eg16a_platform_stays_available_but_organization_denies_dashscope(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    from novelvideo.generators import tts_generator

    calls: list[str] = []
    _install_fake_dashscope(monkeypatch, calls)
    monkeypatch.setattr(
        tts_generator.CosyVoiceTTSGenerator, "_get_audio_duration", _async_value(1.0)
    )

    platform = tts_generator.CosyVoiceTTSGenerator(api_key="platform-dashscope")
    assert (await platform.generate("hello", str(tmp_path / "platform.mp3"))).success
    assert calls == ["synthesizer", "call"]

    monkeypatch.setattr(
        tts_generator,
        "get_tts_config",
        lambda: pytest.fail("organization path must not read DashScope config"),
    )
    organization = tts_generator.CosyVoiceTTSGenerator(
        api_key="org-dashscope-must-not-be-used",
        egress_context=_context(),
    )
    denied = await organization.generate("hello", str(tmp_path / "denied.mp3"))
    assert denied.success is False
    assert denied.error == "ORG_EGRESS_DENIED"
    assert calls == ["synthesizer", "call"]


@pytest.mark.asyncio
async def test_eg16b_edge_accepts_only_trusted_local_context_and_isolates_secrets(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    from novelvideo.generators import tts_generator

    events: list[str] = []
    operation_port = _OperationPort(events)
    _install_ports(monkeypatch, _CredentialPort(), operation_port)
    captured = _install_fake_edge_tts(monkeypatch, events)
    monkeypatch.setattr(
        tts_generator.EdgeTTSGenerator, "_get_audio_duration", _async_value(1.0)
    )
    monkeypatch.setenv("MODEL_API_KEY", "platform-secret")
    monkeypatch.setenv("DASHSCOPE_API_KEY", "provider-secret")
    monkeypatch.setattr(
        tts_generator,
        "get_tts_config",
        lambda: pytest.fail("local Edge path must not read model provider config"),
    )

    generator = tts_generator.EdgeTTSGenerator(egress_context=_context("local"))
    result = await generator.generate("hello", str(tmp_path / "edge.mp3"))

    assert result.success is True
    assert events == ["claim", "edge_stream", "accepted", "completed"]
    assert captured == {
        "text": "hello",
        "voice": "zh-CN-XiaoxiaoNeural",
        "rate": "+0%",
        "pitch": "+0Hz",
    }
    assert "secret" not in repr(captured)


@pytest.mark.asyncio
async def test_eg16b_rejects_org_context_and_provider_switch_before_edge_transport(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    from novelvideo.generators import tts_generator

    events: list[str] = []
    _install_fake_edge_tts(monkeypatch, events)
    denied = await tts_generator.EdgeTTSGenerator(egress_context=_context()).generate(
        "hello", str(tmp_path / "denied.mp3")
    )
    assert denied.success is False
    assert denied.error == "ORG_SERVICE_EGRESS_DENIED"
    assert events == []

    with pytest.raises(tts_generator.AudioEgressError) as exc:
        tts_generator.create_tts_generator(
            provider="cosyvoice",
            egress_context=_context("local"),
        )
    assert exc.value.code == "ORG_SERVICE_EGRESS_DENIED"
    assert events == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "state", [OperationState.ACCEPTED, OperationState.COMPLETED, OperationState.UNKNOWN]
)
async def test_existing_audio_operation_never_resubmits(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, state: OperationState
) -> None:
    from novelvideo.generators import indextts2_fal

    events: list[str] = []
    _install_ports(
        monkeypatch, _CredentialPort(), _OperationPort(events, existing_state=state)
    )
    monkeypatch.setattr(
        indextts2_fal.httpx,
        "AsyncClient",
        lambda **_kwargs: pytest.fail("existing operation must not resubmit"),
    )
    result = await indextts2_fal.IndexTTS2FalClient(
        provider="newapi", egress_context=_context()
    ).generate(
        prompt="hello",
        audio_url="data:audio/mpeg;base64,AA==",
        output_path=tmp_path / "speech.mp3",
    )
    assert result.success is False
    assert result.error == "audio operation already handled"
    assert events == ["claim"]


@pytest.mark.asyncio
async def test_audio_operation_conflict_and_provider_failure_do_not_leak_or_resubmit(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    from novelvideo.freezone import audio_node

    class ConflictPort(_OperationPort):
        async def claim(self, *, spec):
            self.events.append("claim")
            raise EgressOperationError(
                "EGRESS_OPERATION_CONFLICT", "credential-ref-secret"
            )

    events: list[str] = []
    _install_ports(monkeypatch, _CredentialPort(), ConflictPort(events))
    import httpx

    monkeypatch.setattr(
        httpx,
        "AsyncClient",
        lambda **_kwargs: pytest.fail("conflict must not submit"),
    )
    with pytest.raises(EgressOperationError) as exc:
        await audio_node._write_newapi_audio_speech(
            output_path=tmp_path / "conflict.mp3",
            model="IndexTTS2",
            input_text="hello",
            egress_context=_context(),
            business_task_id="beat-1",
        )
    assert exc.value.code == "EGRESS_OPERATION_CONFLICT"
    assert "credential-ref-secret" not in repr(exc.value)
    assert events == ["claim"]

    events.clear()
    captured: dict = {}
    _install_ports(monkeypatch, _CredentialPort(), _OperationPort(events))
    provider_body = "provider-secret credential-ref-secret"
    monkeypatch.setattr(
        httpx,
        "AsyncClient",
        lambda **_kwargs: _AsyncClient(
            events,
            [_Response(status_code=502, text=provider_body)],
            captured,
        ),
    )
    with pytest.raises(RuntimeError) as failure:
        await audio_node._write_newapi_audio_speech(
            output_path=tmp_path / "failure.mp3",
            model="IndexTTS2",
            input_text="hello",
            egress_context=_context(),
            business_task_id="beat-2",
        )
    assert events == ["claim", "post", "unknown"]
    assert provider_body not in repr(failure.value)
    assert "org-secret-key" not in repr(failure.value)


def _async_value(value):
    async def _call(*_args, **_kwargs):
        return value

    return _call


def _install_fake_dashscope(monkeypatch: pytest.MonkeyPatch, calls: list[str]) -> None:
    dashscope = ModuleType("dashscope")
    dashscope.api_key = None
    audio = ModuleType("dashscope.audio")
    tts_v2 = ModuleType("dashscope.audio.tts_v2")

    class ResultCallback:
        pass

    class SpeechSynthesizer:
        def __init__(self, *, callback, **_kwargs):
            calls.append("synthesizer")
            self.callback = callback

        def call(self, _text):
            calls.append("call")
            self.callback.on_open()
            self.callback.on_data(b"audio")
            self.callback.on_close()

    tts_v2.ResultCallback = ResultCallback
    tts_v2.SpeechSynthesizer = SpeechSynthesizer
    monkeypatch.setitem(sys.modules, "dashscope", dashscope)
    monkeypatch.setitem(sys.modules, "dashscope.audio", audio)
    monkeypatch.setitem(sys.modules, "dashscope.audio.tts_v2", tts_v2)


def _install_fake_edge_tts(
    monkeypatch: pytest.MonkeyPatch, events: list[str]
) -> dict[str, str]:
    module = ModuleType("edge_tts")
    captured: dict[str, str] = {}

    class Communicate:
        def __init__(self, text, voice, *, rate, pitch):
            captured.update(text=text, voice=voice, rate=rate, pitch=pitch)

        async def stream(self):
            events.append("edge_stream")
            yield {"type": "audio", "data": b"audio"}

    class SubMaker:
        def feed(self, _chunk):
            return None

        def get_srt(self):
            return ""

    module.Communicate = Communicate
    module.SubMaker = SubMaker
    monkeypatch.setitem(sys.modules, "edge_tts", module)
    return captured
