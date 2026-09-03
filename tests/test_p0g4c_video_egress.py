"""P0G-4C video egress construction proofs."""

from __future__ import annotations

from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace

import pytest

from novelvideo.egress_context import TrustedEgressContext
from novelvideo.ports.authz import BillingPrincipal
from novelvideo.ports.egress_operations import (
    OperationClaimResult,
    OperationSnapshot,
    OperationState,
)
from novelvideo.ports.model_credentials import CredentialReference, RequestCredential


def _context(kind: str = "organization") -> TrustedEgressContext:
    principal_id = {
        "organization": "org-1",
        "platform": "user-1",
        "local": "local-worker",
    }[kind]
    credential = CredentialReference(
        source=kind,
        credential_id={
            "organization": "credential-1",
            "platform": "platform-newapi",
            "local": "local-video",
        }[kind],
        key_version=7 if kind == "organization" else 1,
        org_id="org-1" if kind == "organization" else None,
    )
    return TrustedEgressContext(
        envelope_id="envelope-1",
        project_id="project-1",
        task_type="single_video",
        requester_user_id="user-1",
        root_task_id="root-1",
        admission_id="admission-1",
        admitted_at="2026-08-03T04:05:00Z",
        membership_id="membership-1" if kind == "organization" else None,
        authz_version=11,
        billing_principal=BillingPrincipal(kind=kind, id=principal_id),
        credential=credential,
    )


class _OperationPort:
    def __init__(
        self,
        state: OperationState = OperationState.DISPATCHING,
        order: list[str] | None = None,
    ) -> None:
        self.state = state
        self.order = order
        self.events: list[tuple[str, object]] = []

    async def claim(self, *, spec):
        if self.order is not None:
            self.order.append("claim")
        self.events.append(("claim", spec))
        return OperationClaimResult(
            won=self.state is OperationState.DISPATCHING,
            operation=OperationSnapshot(
                operation_id="operation-1",
                operation_key=spec.operation_key,
                state=self.state,
                version=1,
            ),
            transition_token=(
                "transition-1" if self.state is OperationState.DISPATCHING else None
            ),
        )

    async def mark_rejected_before_submit(self, **kwargs):
        self.events.append(("rejected_before_submit", kwargs))
        return self._snapshot(OperationState.REJECTED_BEFORE_SUBMIT, 2)

    async def mark_accepted(self, **kwargs):
        self.events.append(("accepted", kwargs))
        return self._snapshot(OperationState.ACCEPTED, 2)

    async def mark_completed(self, **kwargs):
        self.events.append(("completed", kwargs))
        return self._snapshot(OperationState.COMPLETED, 3)

    async def mark_unknown(self, **kwargs):
        self.events.append(("unknown", kwargs))
        return self._snapshot(OperationState.UNKNOWN, kwargs["expected_version"] + 1)

    @staticmethod
    def _snapshot(state: OperationState, version: int) -> OperationSnapshot:
        return OperationSnapshot(
            operation_id="operation-1",
            operation_key="operation-key",
            state=state,
            version=version,
        )


class _CredentialPort:
    def __init__(self, context: TrustedEgressContext, events: list[str]) -> None:
        self.context = context
        self.events = events

    async def resolve(self, admission):
        self.events.append("resolve")
        assert admission.billing_principal == self.context.billing_principal
        assert admission.credential == self.context.credential
        assert admission.admitted_at == self.context.admitted_at
        assert admission.membership_id == self.context.membership_id
        assert admission.authz_version == self.context.authz_version
        return RequestCredential(
            reference=self.context.credential,
            api_key="organization-secret",
            base_url="https://gateway.example/v1",
        )


class _UsageMeter:
    reviews: list[tuple[str, dict]] = []

    async def mark_current_paid_execution_attempt(self, **_kwargs) -> None:
        return None

    async def mark_model_call_credit_settlement_for_review(
        self, reservation_id, *, metadata=None
    ):
        self.reviews.append((reservation_id, metadata or {}))
        return {"status": "awaiting"}


def _install_newapi_ports(monkeypatch, context, operation_port, events):
    import novelvideo.ports as ports
    import novelvideo.generators.video_generator as video_generator

    monkeypatch.setattr(ports, "get_egress_operation_port", lambda: operation_port)
    monkeypatch.setattr(
        ports,
        "get_model_credentials",
        lambda: _CredentialPort(context, events),
    )
    monkeypatch.setattr(video_generator, "get_usage_meter", lambda: _UsageMeter())

    async def reserve(*_args, **_kwargs):
        return "reservation-1"

    async def no_op(*_args, **_kwargs):
        return None

    monkeypatch.setattr(video_generator, "_reserve_video_model_call", reserve)
    monkeypatch.setattr(video_generator, "_refund_video_model_call", no_op)
    monkeypatch.setattr(video_generator, "_confirm_video_model_call", no_op)


def test_direct_video_backends_preserve_platform_and_deny_organization() -> None:
    from novelvideo.generators.video_generator import (
        GrokVideoGenerator,
        HuimengVideoGenerator,
        Seedance2VideoGenerator,
        SeedanceVideoGenerator,
        VideoEgressError,
        create_video_generator,
    )

    platform_cases = (
        ("seedance_fast", {"api_key": "platform-key"}, SeedanceVideoGenerator),
        ("seedance_2", {"api_key": "platform-key"}, Seedance2VideoGenerator),
        ("grok_720", {"api_key": "platform-key"}, GrokVideoGenerator),
        (
            "huimeng_seedance-1.0-pro-fast",
            {"client": object()},
            HuimengVideoGenerator,
        ),
    )
    for backend, kwargs, expected_type in platform_cases:
        assert isinstance(create_video_generator(backend, **kwargs), expected_type)

        with pytest.raises(VideoEgressError) as exc_info:
            create_video_generator(backend, egress_context=_context(), **kwargs)
        assert exc_info.value.code == "ORG_EGRESS_DENIED"

        with pytest.raises(VideoEgressError) as local_exc_info:
            create_video_generator(backend, egress_context=_context("local"), **kwargs)
        assert local_exc_info.value.code == "ORG_EGRESS_DENIED"


@pytest.mark.asyncio
async def test_direct_instance_denies_organization_before_transport(
    tmp_path: Path,
) -> None:
    from novelvideo.generators.video_generator import (
        SeedanceVideoGenerator,
        VideoEgressError,
    )

    generator = SeedanceVideoGenerator(model="seedance", api_key="platform-key")

    with pytest.raises(VideoEgressError) as exc_info:
        await generator.generate(
            image_path=str(tmp_path / "missing.png"),
            prompt="prompt",
            output_path=str(tmp_path / "out.mp4"),
            egress_context=_context(),
        )
    assert exc_info.value.code == "ORG_EGRESS_DENIED"


def test_direct_backends_deny_organization_bound_only_by_request_scope() -> None:
    """忘了穿 `egress_context=` 时，闸门要回落到请求作用域，而不是放行。

    上面两条既有用例都显式传参，所以它们证明不了「调用点漏传」这个形状。
    而漏传恰恰是最可能发生的：这两族闸门（`_deny_direct_organization_video`
    与 `_direct_video_context_denied`）的上下文都只从 kwargs 取，漏一个参数
    就等于组织流量拿平台凭据直连上游、记到平台账上。
    """
    from novelvideo.generators.video_generator import (
        VideoEgressError,
        create_video_generator,
    )
    from novelvideo.model_gateway_runtime import model_gateway_request_scope

    cases = (
        ("seedance_fast", {"api_key": "platform-key"}),
        ("seedance_pro", {"api_key": "platform-key"}),
        ("seedance_2", {"api_key": "platform-key"}),
        ("grok_720", {"api_key": "platform-key"}),
        ("huimeng_seedance-1.0-pro-fast", {"client": object()}),
    )
    for backend, kwargs in cases:
        for kind in ("organization", "local"):
            with model_gateway_request_scope(_context(kind)):
                with pytest.raises(VideoEgressError) as exc_info:
                    create_video_generator(backend, **kwargs)
                assert exc_info.value.code == "ORG_EGRESS_DENIED", backend

        # 反向对照：平台作用域不受影响，回落不得变成一律拒绝。
        with model_gateway_request_scope(_context("platform")):
            assert create_video_generator(backend, **kwargs) is not None
        assert create_video_generator(backend, **kwargs) is not None


@pytest.mark.asyncio
async def test_direct_instance_denies_organization_bound_only_by_request_scope(
    tmp_path: Path,
) -> None:
    """实例侧同理：`generate()` 漏传 `egress_context=` 也必须被作用域拦下。"""
    from novelvideo.generators.video_generator import (
        SeedanceVideoGenerator,
        VideoEgressError,
    )
    from novelvideo.model_gateway_runtime import model_gateway_request_scope

    generator = SeedanceVideoGenerator(model="seedance", api_key="platform-key")

    with model_gateway_request_scope(_context()):
        with pytest.raises(VideoEgressError) as exc_info:
            await generator.generate(
                image_path=str(tmp_path / "missing.png"),
                prompt="prompt",
                output_path=str(tmp_path / "out.mp4"),
            )
    assert exc_info.value.code == "ORG_EGRESS_DENIED"


@pytest.mark.asyncio
async def test_newapi_submit_poll_fetch_use_exact_credential_and_transitions(
    monkeypatch, tmp_path: Path
) -> None:
    from novelvideo.generators.video_generator import (
        NewApiVideoGenerator,
        VideoGenStatus,
    )

    context = _context()
    events: list[str] = []
    operation_port = _OperationPort(order=events)
    _install_newapi_ports(monkeypatch, context, operation_port, events)

    generator = NewApiVideoGenerator(
        model="seedance-1.0-pro-fast",
        egress_context=context,
    )

    async def post(url, payload, *, headers):
        events.append("submit")
        assert url == "https://gateway.example/v1/video/generations"
        assert headers["Authorization"] == "Bearer organization-secret"
        return {"id": "provider-job-1"}

    async def get(url, *, headers):
        events.append("poll")
        assert url.endswith("/video/generations/provider-job-1")
        assert headers["Authorization"] == "Bearer organization-secret"
        return {"status": "completed", "video_url": "https://result.example/video"}

    async def download(url, output_path):
        events.append("fetch")
        assert url == "https://result.example/video"
        Path(output_path).write_bytes(b"video-result")
        return b"video-result"

    monkeypatch.setattr(generator, "_post_json", post)
    monkeypatch.setattr(generator, "_get_json", get)
    monkeypatch.setattr(generator, "_download_video", download)
    monkeypatch.setattr(
        generator, "_revalidate_organization", lambda _context: _async_none()
    )

    result = await generator.generate(
        image_path=None,
        prompt="prompt",
        output_path=str(tmp_path / "video.mp4"),
        episode=1,
        beat_num=2,
        scope="beat",
        task_type="single_video",
        admitted_at="caller-payload-canary",
        poll_interval=0,
        max_polls=1,
    )

    assert result.status is VideoGenStatus.DONE
    assert events == ["claim", "resolve", "submit", "poll", "fetch"]
    assert [name for name, _ in operation_port.events] == [
        "claim",
        "accepted",
        "completed",
    ]
    operation_spec = operation_port.events[0][1]
    assert operation_spec.organization_id == "org-1"
    assert operation_spec.project_id == "project-1"
    assert operation_spec.root_task_id == "root-1"
    assert operation_spec.business_task_id == (
        "single_video:episode:1:beat:2:scope:beat:generate"
    )
    assert operation_spec.capability == "video.generate.gateway"
    assert operation_spec.credential_id == "credential-1"
    assert operation_spec.credential_version == 7
    assert len(operation_spec.request_digest) == 64
    accepted = operation_port.events[1][1]
    completed = operation_port.events[2][1]
    assert accepted["provider_job_id"] == "provider-job-1"
    assert accepted["requester_user_id"] == context.requester_user_id
    assert accepted["membership_id"] == context.membership_id
    assert accepted["authz_version"] == context.authz_version
    assert completed["result_ref"].startswith("video:sha256:")
    assert "result.example" not in completed["result_ref"]
    assert str(tmp_path) not in completed["result_ref"]


async def _async_none():
    return None


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "state",
    [OperationState.ACCEPTED, OperationState.COMPLETED, OperationState.UNKNOWN],
)
async def test_newapi_existing_operation_never_resubmits(
    monkeypatch, tmp_path: Path, state: OperationState
) -> None:
    from novelvideo.generators.video_generator import (
        NewApiVideoGenerator,
        VideoEgressError,
    )

    context = _context()
    operation_port = _OperationPort(state)
    events: list[str] = []
    _install_newapi_ports(monkeypatch, context, operation_port, events)
    generator = NewApiVideoGenerator(
        model="seedance-1.0-pro-fast", egress_context=context
    )

    async def forbidden(*_args, **_kwargs):
        raise AssertionError("transport must remain zero")

    monkeypatch.setattr(generator, "_post_json", forbidden)

    with pytest.raises(VideoEgressError) as exc_info:
        await generator.generate(
            image_path=None,
            prompt="prompt",
            output_path=str(tmp_path / "video.mp4"),
            episode=1,
            beat_num=2,
            scope="beat",
            task_type="single_video",
        )
    assert exc_info.value.code == "EGRESS_OPERATION_REPLAYED"
    assert events == []
    assert [name for name, _ in operation_port.events] == ["claim"]


@pytest.mark.asyncio
async def test_newapi_existing_operation_rejects_before_media_relay(
    monkeypatch, tmp_path: Path
) -> None:
    from novelvideo.generators.video_generator import (
        NewApiVideoGenerator,
        VideoEgressError,
    )

    context = _context()
    operation_port = _OperationPort(OperationState.ACCEPTED)
    events: list[str] = []
    _install_newapi_ports(monkeypatch, context, operation_port, events)
    generator = NewApiVideoGenerator(
        model="seedance-1.0-pro-fast", egress_context=context
    )
    image_path = tmp_path / "frame.png"
    image_path.write_bytes(b"frame")

    async def forbidden(*_args, **_kwargs):
        raise AssertionError("media relay and provider transport must remain zero")

    monkeypatch.setattr(generator, "_relay_frame_input", forbidden)
    monkeypatch.setattr(generator, "_post_json", forbidden)

    with pytest.raises(VideoEgressError) as exc_info:
        await generator.generate(
            image_path=str(image_path),
            prompt="prompt",
            output_path=str(tmp_path / "video.mp4"),
            episode=1,
            beat_num=2,
            scope="beat",
            task_type="single_video",
        )

    assert exc_info.value.code == "EGRESS_OPERATION_REPLAYED"
    assert events == []
    assert [name for name, _ in operation_port.events] == ["claim"]


@pytest.mark.asyncio
async def test_newapi_media_relay_failure_is_rejected_without_detail_leak(
    monkeypatch, tmp_path: Path
) -> None:
    from novelvideo.generators.video_generator import NewApiVideoGenerator

    context = _context()
    operation_port = _OperationPort()
    events: list[str] = []
    _install_newapi_ports(monkeypatch, context, operation_port, events)
    generator = NewApiVideoGenerator(
        model="seedance-1.0-pro-fast", egress_context=context
    )
    image_path = tmp_path / "frame.png"
    image_path.write_bytes(b"frame")

    async def broken_relay(*_args, **_kwargs):
        raise RuntimeError("relay endpoint secret-canary")

    async def forbidden_submit(*_args, **_kwargs):
        raise AssertionError("provider submit must remain zero")

    monkeypatch.setattr(generator, "_relay_frame_input", broken_relay)
    monkeypatch.setattr(generator, "_post_json", forbidden_submit)

    result = await generator.generate(
        image_path=str(image_path),
        prompt="prompt",
        output_path=str(tmp_path / "video.mp4"),
        episode=1,
        beat_num=2,
        scope="beat",
        task_type="single_video",
    )

    assert result.error == "EGRESS_OPERATION_REJECTED_BEFORE_SUBMIT"
    assert "secret-canary" not in repr(result)
    assert events == ["resolve"]
    assert [name for name, _ in operation_port.events] == [
        "claim",
        "rejected_before_submit",
    ]


@pytest.mark.asyncio
async def test_newapi_request_digest_covers_payload_flags_and_media_content(
    monkeypatch, tmp_path: Path
) -> None:
    import novelvideo.ports as ports
    from novelvideo.generators.video_generator import (
        NewApiVideoGenerator,
        VideoEgressError,
    )

    context = _context()
    generator = NewApiVideoGenerator(
        model="seedance-1.0-pro-fast", egress_context=context
    )
    image_path = tmp_path / "frame.png"

    async def digest_for(
        content: bytes, *, human_review: bool = False, audio_setting: str = ""
    ) -> str:
        image_path.write_bytes(content)
        operation_port = _OperationPort(OperationState.ACCEPTED)
        monkeypatch.setattr(ports, "get_egress_operation_port", lambda: operation_port)
        with pytest.raises(VideoEgressError) as exc_info:
            await generator.generate(
                image_path=str(image_path),
                prompt="prompt",
                output_path=str(tmp_path / "video.mp4"),
                human_review=human_review,
                audio_setting=audio_setting,
                episode=1,
                beat_num=2,
                scope="beat",
                task_type="single_video",
            )
        assert exc_info.value.code == "EGRESS_OPERATION_REPLAYED"
        return operation_port.events[0][1].request_digest

    base = await digest_for(b"frame-a")
    human_review = await digest_for(b"frame-a", human_review=True)
    audio_setting = await digest_for(b"frame-a", audio_setting="keep_audio")
    changed_media = await digest_for(b"frame-b")

    assert len({base, human_review, audio_setting, changed_media}) == 4


@pytest.mark.asyncio
async def test_newapi_exact_version_mismatch_rejects_before_submit(
    monkeypatch, tmp_path: Path
) -> None:
    import novelvideo.ports as ports
    from novelvideo.generators.video_generator import (
        NewApiVideoGenerator,
        VideoEgressError,
    )

    context = _context()
    operation_port = _OperationPort()
    events: list[str] = []
    _install_newapi_ports(monkeypatch, context, operation_port, events)
    generator = NewApiVideoGenerator(
        model="seedance-1.0-pro-fast", egress_context=context
    )

    class ShiftedCredentialPort:
        async def resolve(self, _admission):
            return RequestCredential(
                reference=replace(context.credential, key_version=8),
                api_key="shifted-secret",
                base_url="https://gateway.example/v1",
            )

    async def forbidden(*_args, **_kwargs):
        raise AssertionError("submit must remain zero")

    monkeypatch.setattr(ports, "get_model_credentials", lambda: ShiftedCredentialPort())
    monkeypatch.setattr(generator, "_post_json", forbidden)

    with pytest.raises(VideoEgressError) as exc_info:
        await generator.generate(
            image_path=None,
            prompt="prompt",
            output_path=str(tmp_path / "video.mp4"),
            episode=1,
            beat_num=2,
            scope="beat",
            task_type="single_video",
        )

    assert exc_info.value.code == "ORG_CREDENTIAL_VERSION_MISMATCH"
    assert [name for name, _ in operation_port.events] == [
        "claim",
        "rejected_before_submit",
    ]


@pytest.mark.asyncio
async def test_newapi_ambiguous_submit_interruption_becomes_unknown(
    monkeypatch, tmp_path: Path
) -> None:
    from novelvideo.generators.video_generator import (
        NewApiVideoGenerator,
        VideoGenStatus,
    )

    context = _context()
    operation_port = _OperationPort()
    events: list[str] = []
    _install_newapi_ports(monkeypatch, context, operation_port, events)
    generator = NewApiVideoGenerator(
        model="seedance-1.0-pro-fast", egress_context=context
    )
    refund_errors: list[str] = []

    async def interrupted(*_args, **_kwargs):
        raise TimeoutError("provider timeout canary")

    async def capture_refund(*_args, **kwargs):
        refund_errors.append(str(kwargs.get("error") or ""))

    monkeypatch.setattr(generator, "_post_json", interrupted)
    monkeypatch.setattr(
        "novelvideo.generators.video_generator._refund_video_model_call",
        capture_refund,
    )
    result = await generator.generate(
        image_path=None,
        prompt="prompt",
        output_path=str(tmp_path / "video.mp4"),
        episode=1,
        beat_num=2,
        scope="beat",
        task_type="single_video",
    )

    assert result.status is VideoGenStatus.FAILED
    assert "canary" not in (result.error or "")
    assert refund_errors == ["EGRESS_OPERATION_UNKNOWN"]
    assert [name for name, _ in operation_port.events] == ["claim", "unknown"]


@pytest.mark.asyncio
async def test_newapi_unknown_transition_failure_is_not_reported_terminal(
    monkeypatch, tmp_path: Path
) -> None:
    from novelvideo.generators.video_generator import (
        NewApiVideoGenerator,
        VideoEgressError,
    )

    class BrokenOperationPort(_OperationPort):
        async def mark_unknown(self, **_kwargs):
            raise RuntimeError("database transition canary")

    context = _context()
    operation_port = BrokenOperationPort()
    events: list[str] = []
    _install_newapi_ports(monkeypatch, context, operation_port, events)
    generator = NewApiVideoGenerator(
        model="seedance-1.0-pro-fast", egress_context=context
    )

    async def interrupted(*_args, **_kwargs):
        raise TimeoutError("provider timeout canary")

    monkeypatch.setattr(generator, "_post_json", interrupted)

    with pytest.raises(VideoEgressError) as exc_info:
        await generator.generate(
            image_path=None,
            prompt="prompt",
            output_path=str(tmp_path / "video.mp4"),
            episode=1,
            beat_num=2,
            scope="beat",
            task_type="single_video",
        )

    assert exc_info.value.code == "EGRESS_OPERATION_TRANSITION_FAILED"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("submit_response", "poll_response", "expected_events"),
    [
        ({"unsafe": "secret-canary"}, None, ["claim", "unknown"]),
        (
            {"id": "provider-job-1"},
            {"status": "completed", "unsafe": "secret-canary"},
            ["claim", "accepted", "unknown"],
        ),
        (
            {"id": "provider-job-1"},
            {"status": "failed", "error": "secret-canary"},
            ["claim", "accepted", "unknown"],
        ),
    ],
)
async def test_newapi_accepted_failures_become_unknown_without_provider_leak(
    monkeypatch,
    tmp_path: Path,
    submit_response: dict,
    poll_response: dict | None,
    expected_events: list[str],
) -> None:
    from novelvideo.generators.video_generator import NewApiVideoGenerator

    context = _context()
    operation_port = _OperationPort()
    events: list[str] = []
    _install_newapi_ports(monkeypatch, context, operation_port, events)
    generator = NewApiVideoGenerator(
        model="seedance-1.0-pro-fast", egress_context=context
    )

    async def post(*_args, **_kwargs):
        return submit_response

    async def poll(*_args, **_kwargs):
        assert poll_response is not None
        return poll_response

    monkeypatch.setattr(generator, "_post_json", post)
    monkeypatch.setattr(generator, "_get_json", poll)
    monkeypatch.setattr(
        generator, "_revalidate_organization", lambda _context: _async_none()
    )

    result = await generator.generate(
        image_path=None,
        prompt="prompt",
        output_path=str(tmp_path / "video.mp4"),
        episode=1,
        beat_num=2,
        scope="beat",
        task_type="single_video",
        max_polls=1,
    )

    assert result.error == "EGRESS_OPERATION_UNKNOWN"
    assert "secret-canary" not in repr(result)
    assert [name for name, _ in operation_port.events] == expected_events


@pytest.mark.asyncio
async def test_newapi_authority_drift_after_acceptance_stops_poll_and_enters_review(
    monkeypatch, tmp_path: Path
) -> None:
    from novelvideo.generators.video_generator import (
        NewApiVideoGenerator,
    )
    from novelvideo.ports.authz import AuthzError
    from novelvideo.task_backend.envelope import RunningTaskAuthorityIndeterminate

    context = _context()
    operation_port = _OperationPort()
    events: list[str] = []
    _UsageMeter.reviews.clear()
    _install_newapi_ports(monkeypatch, context, operation_port, events)
    generator = NewApiVideoGenerator(
        model="seedance-1.0-pro-fast", egress_context=context
    )

    async def post(*_args, **_kwargs):
        return {"id": "provider-job-1"}

    async def disabled(_context):
        try:
            raise RuntimeError("postgres://user:secret-canary@internal")
        except RuntimeError:
            raise AuthzError("ORG_MEMBERSHIP_INACTIVE") from None

    async def forbidden(*_args, **_kwargs):
        raise AssertionError("poll/fetch must remain zero")

    monkeypatch.setattr(generator, "_post_json", post)
    monkeypatch.setattr(generator, "_revalidate_organization", disabled)
    monkeypatch.setattr(generator, "_get_json", forbidden)
    monkeypatch.setattr(generator, "_download_video", forbidden)

    with pytest.raises(RunningTaskAuthorityIndeterminate) as captured:
        await generator.generate(
            image_path=None,
            prompt="prompt",
            output_path=str(tmp_path / "video.mp4"),
            episode=1,
            beat_num=2,
            scope="beat",
            task_type="single_video",
            max_polls=1,
        )

    assert captured.value.failure_kind == "drift"
    assert captured.value.__context__ is None
    assert "secret-canary" not in repr(captured.value)
    assert _UsageMeter.reviews == [
        (
            "reservation-1",
            {
                "source": "video_post_accept_authz_indeterminate",
                "failure_kind": "drift",
                "provider_request_id": "",
                "provider_task_id": "provider-job-1",
            },
        )
    ]
    assert [name for name, _ in operation_port.events] == [
        "claim",
        "accepted",
        "unknown",
    ]


@pytest.mark.asyncio
async def test_newapi_gray_disable_after_acceptance_uses_existing_failure_refund_path(
    monkeypatch, tmp_path: Path
) -> None:
    from novelvideo.generators.video_generator import (
        NewApiVideoGenerator,
        VideoGenStatus,
    )
    from novelvideo.ports.authz import AuthzError

    context = _context()
    operation_port = _OperationPort()
    events: list[str] = []
    _install_newapi_ports(monkeypatch, context, operation_port, events)
    generator = NewApiVideoGenerator(
        model="seedance-1.0-pro-fast", egress_context=context
    )
    refunds: list[str] = []

    async def post(*_args, **_kwargs):
        return {"id": "provider-job-1"}

    async def disabled(_context):
        raise AuthzError("P0_GRAY_DISABLED")

    async def capture_refund(*_args, **kwargs):
        refunds.append(str(kwargs.get("error") or ""))

    monkeypatch.setattr(generator, "_post_json", post)
    monkeypatch.setattr(generator, "_revalidate_organization", disabled)
    monkeypatch.setattr(
        "novelvideo.generators.video_generator._refund_video_model_call",
        capture_refund,
    )

    result = await generator.generate(
        image_path=None,
        prompt="prompt",
        output_path=str(tmp_path / "video.mp4"),
        episode=1,
        beat_num=2,
        scope="beat",
        task_type="single_video",
        max_polls=1,
    )

    assert result.status is VideoGenStatus.FAILED
    assert result.error == "P0_GRAY_DISABLED"
    assert refunds == ["P0_GRAY_DISABLED"]
    assert [name for name, _ in operation_port.events] == [
        "claim",
        "accepted",
        "unknown",
    ]


@pytest.mark.asyncio
async def test_newapi_generic_post_accept_authz_failure_is_redacted(
    monkeypatch, tmp_path: Path
) -> None:
    from novelvideo.generators.video_generator import NewApiVideoGenerator

    context = _context()
    operation_port = _OperationPort()
    events: list[str] = []
    _install_newapi_ports(monkeypatch, context, operation_port, events)
    generator = NewApiVideoGenerator(
        model="seedance-1.0-pro-fast", egress_context=context
    )

    async def post(*_args, **_kwargs):
        return {"id": "provider-job-1"}

    async def broken_authz(_context):
        raise RuntimeError("postgres://user:secret-canary@internal")

    monkeypatch.setattr(generator, "_post_json", post)
    monkeypatch.setattr(generator, "_revalidate_organization", broken_authz)

    result = await generator.generate(
        image_path=None,
        prompt="prompt",
        output_path=str(tmp_path / "video.mp4"),
        episode=1,
        beat_num=2,
        scope="beat",
        task_type="single_video",
        max_polls=1,
    )

    assert result.error == "ORG_AUTHZ_STALE"
    assert "secret-canary" not in repr(result)
    assert [name for name, _ in operation_port.events] == [
        "claim",
        "accepted",
        "unknown",
    ]


@pytest.mark.asyncio
async def test_newapi_generate_supplied_context_is_revalidated_after_acceptance(
    monkeypatch, tmp_path: Path
) -> None:
    import novelvideo.ports as ports
    from novelvideo.generators.video_generator import NewApiVideoGenerator
    from novelvideo.ports.authz import AuthzError

    context = _context()
    operation_port = _OperationPort()
    events: list[str] = []
    _install_newapi_ports(monkeypatch, context, operation_port, events)
    generator = NewApiVideoGenerator(
        model="seedance-1.0-pro-fast",
        api_key="platform-key",
        endpoint="https://platform.example/v1",
    )

    class DisabledAuthz:
        async def admit_model_task(self, **_kwargs):
            raise AuthzError("P0_GRAY_DISABLED")

    async def post(*_args, **_kwargs):
        return {"id": "provider-job-1"}

    async def forbidden(*_args, **_kwargs):
        raise AssertionError("poll/fetch must remain zero")

    monkeypatch.setattr(ports, "get_authz_port", lambda: DisabledAuthz())
    monkeypatch.setattr(generator, "_post_json", post)
    monkeypatch.setattr(generator, "_get_json", forbidden)
    monkeypatch.setattr(generator, "_download_video", forbidden)

    result = await generator.generate(
        image_path=None,
        prompt="prompt",
        output_path=str(tmp_path / "video.mp4"),
        egress_context=context,
        episode=1,
        beat_num=2,
        scope="beat",
        task_type="single_video",
        max_polls=1,
    )
    assert result.error == "P0_GRAY_DISABLED"
    assert [name for name, _ in operation_port.events] == [
        "claim",
        "accepted",
        "unknown",
    ]


@pytest.mark.asyncio
async def test_newapi_post_accept_authz_recovers_without_resubmitting_provider(
    monkeypatch, tmp_path: Path
) -> None:
    import novelvideo.ports as ports
    import novelvideo.generators.video_generator as video_generator
    from novelvideo.generators.video_generator import NewApiVideoGenerator
    from novelvideo.ports.authz import AuthzServiceUnavailable

    context = _context()
    operation_port = _OperationPort()
    events: list[str] = []
    _install_newapi_ports(monkeypatch, context, operation_port, events)
    generator = NewApiVideoGenerator(
        model="seedance-1.0-pro-fast", egress_context=context
    )
    calls = {"authz": 0, "submit": 0, "poll": 0}

    class Authz:
        async def admit_model_task(self, **_kwargs):
            calls["authz"] += 1
            if calls["authz"] < 3:
                raise AuthzServiceUnavailable()
            return generator._admission_from_egress_context(context)

    async def submit(*_args, **_kwargs):
        calls["submit"] += 1
        return {"id": "provider-job-1"}

    async def poll(*_args, **_kwargs):
        calls["poll"] += 1
        return {"status": "failed", "error": "provider_failed"}

    async def no_sleep(_delay):
        return None

    monkeypatch.setattr(ports, "get_authz_port", lambda: Authz())
    monkeypatch.setattr(generator, "_post_json", submit)
    monkeypatch.setattr(generator, "_get_json", poll)
    monkeypatch.setattr(video_generator, "_POST_ACCEPT_AUTHZ_RETRY_SLEEP", no_sleep)
    monkeypatch.setattr(video_generator, "_POST_ACCEPT_AUTHZ_RETRY_RANDOM", lambda: 0.5)

    await generator.generate(
        image_path=None,
        prompt="prompt",
        output_path=str(tmp_path / "video.mp4"),
        episode=1,
        beat_num=2,
        scope="beat",
        task_type="single_video",
        max_polls=1,
    )

    assert calls == {"authz": 3, "submit": 1, "poll": 1}


@pytest.mark.asyncio
async def test_newapi_post_accept_key_rotation_keeps_frozen_credential(
    monkeypatch,
) -> None:
    import novelvideo.ports as ports
    from novelvideo.generators.video_generator import NewApiVideoGenerator

    context = _context()
    generator = NewApiVideoGenerator(
        model="seedance-1.0-pro-fast", egress_context=context
    )
    rotated = generator._admission_from_egress_context(context)
    rotated = replace(
        rotated,
        credential=replace(
            context.credential,
            credential_id="credential-2",
            key_version=8,
        ),
    )

    class Authz:
        async def admit_model_task(self, **_kwargs):
            return rotated

    monkeypatch.setattr(ports, "get_authz_port", lambda: Authz())

    await generator._revalidate_organization(context)


@pytest.mark.asyncio
async def test_newapi_post_accept_unbind_revalidates_authority_without_active_key(
    monkeypatch,
) -> None:
    import novelvideo.ports as ports
    from novelvideo.generators.video_generator import NewApiVideoGenerator
    from novelvideo.ports.authz import AuthzError, AuthzSnapshot

    context = _context()
    generator = NewApiVideoGenerator(
        model="seedance-1.0-pro-fast", egress_context=context
    )
    calls = {"admit": 0, "snapshot": 0}

    class Authz:
        async def admit_model_task(self, **_kwargs):
            calls["admit"] += 1
            raise AuthzError("ORG_CREDENTIAL_DISABLED")

        async def snapshot(self, *, user_id):
            calls["snapshot"] += 1
            assert user_id == context.requester_user_id
            return AuthzSnapshot(
                requester_user_id=context.requester_user_id,
                org_id=context.billing_principal.id,
                membership_id=context.membership_id,
                role="member",
                membership_status="active",
                org_status="active",
                authz_version=context.authz_version,
            )

    monkeypatch.setattr(ports, "get_authz_port", lambda: Authz())

    await generator._revalidate_organization(context)

    assert calls == {"admit": 1, "snapshot": 1}


@pytest.mark.asyncio
async def test_newapi_post_accept_unbind_still_rejects_inactive_membership(
    monkeypatch,
) -> None:
    import novelvideo.ports as ports
    from novelvideo.generators.video_generator import NewApiVideoGenerator
    from novelvideo.ports.authz import AuthzError, AuthzSnapshot

    context = _context()
    generator = NewApiVideoGenerator(
        model="seedance-1.0-pro-fast", egress_context=context
    )

    class Authz:
        async def admit_model_task(self, **_kwargs):
            raise AuthzError("ORG_CREDENTIAL_DISABLED")

        async def snapshot(self, *, user_id):
            return AuthzSnapshot(
                requester_user_id=user_id,
                org_id=context.billing_principal.id,
                membership_id=context.membership_id,
                role="member",
                membership_status="suspended",
                org_status="active",
                authz_version=context.authz_version,
            )

    monkeypatch.setattr(ports, "get_authz_port", lambda: Authz())

    with pytest.raises(AuthzError) as captured:
        await generator._revalidate_organization(context)

    assert captured.value.code == "ORG_MEMBERSHIP_INACTIVE"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("requester_user_id", "user-2"),
        ("billing_principal", BillingPrincipal(kind="organization", id="org-2")),
        ("membership_id", "membership-2"),
        ("authz_version", 12),
    ],
)
async def test_newapi_post_accept_noncredential_authority_drift_still_fails(
    monkeypatch,
    field: str,
    value: object,
) -> None:
    import novelvideo.ports as ports
    from novelvideo.generators.video_generator import NewApiVideoGenerator
    from novelvideo.ports.authz import AuthzError

    context = _context()
    generator = NewApiVideoGenerator(
        model="seedance-1.0-pro-fast", egress_context=context
    )
    current = generator._admission_from_egress_context(context)
    if field == "billing_principal":
        current = replace(
            current,
            billing_principal=value,
            credential=replace(current.credential, org_id=value.id),
        )
    else:
        current = replace(current, **{field: value})

    class Authz:
        async def admit_model_task(self, **_kwargs):
            return current

    monkeypatch.setattr(ports, "get_authz_port", lambda: Authz())

    with pytest.raises(AuthzError) as captured:
        await generator._revalidate_organization(context)
    assert captured.value.code == "ORG_AUTHZ_STALE"


@pytest.mark.asyncio
@pytest.mark.parametrize("unbind", [False, True])
async def test_newapi_key_rotation_after_acceptance_keeps_old_key_for_poll(
    monkeypatch,
    tmp_path: Path,
    unbind: bool,
) -> None:
    import novelvideo.ports as ports
    from novelvideo.generators.video_generator import (
        NewApiVideoGenerator,
        VideoGenStatus,
    )
    from novelvideo.ports.authz import AuthzError, AuthzSnapshot

    context = _context()
    operation_port = _OperationPort()
    events: list[str] = []
    _install_newapi_ports(monkeypatch, context, operation_port, events)
    generator = NewApiVideoGenerator(
        model="seedance-1.0-pro-fast", egress_context=context
    )
    rotated = replace(
        generator._admission_from_egress_context(context),
        credential=replace(
            context.credential,
            credential_id="credential-2",
            key_version=8,
        ),
    )
    calls = {"submit": 0, "poll": 0, "fetch": 0}

    class Authz:
        async def admit_model_task(self, **_kwargs):
            if unbind:
                raise AuthzError("ORG_CREDENTIAL_DISABLED")
            return rotated

        async def snapshot(self, *, user_id):
            assert unbind
            return AuthzSnapshot(
                requester_user_id=user_id,
                org_id=context.billing_principal.id,
                membership_id=context.membership_id,
                role="member",
                membership_status="active",
                org_status="active",
                authz_version=context.authz_version,
            )

    async def submit(_url, _payload, *, headers):
        calls["submit"] += 1
        assert headers["Authorization"] == "Bearer organization-secret"
        return {"id": "provider-job-1"}

    async def poll(_url, *, headers):
        calls["poll"] += 1
        assert headers["Authorization"] == "Bearer organization-secret"
        assert "new-key-canary" not in headers.values()
        return {"status": "completed", "video_url": "https://result.example/video"}

    async def fetch(_url, output_path):
        calls["fetch"] += 1
        Path(output_path).write_bytes(b"video-result")
        return b"video-result"

    monkeypatch.setattr(ports, "get_authz_port", lambda: Authz())
    monkeypatch.setattr(generator, "_post_json", submit)
    monkeypatch.setattr(generator, "_get_json", poll)
    monkeypatch.setattr(generator, "_download_video", fetch)

    result = await generator.generate(
        image_path=None,
        prompt="prompt",
        output_path=str(tmp_path / "video.mp4"),
        episode=1,
        beat_num=2,
        scope="beat",
        task_type="single_video",
        poll_interval=0,
        max_polls=1,
    )

    assert result.status is VideoGenStatus.DONE
    assert calls == {"submit": 1, "poll": 1, "fetch": 1}
    assert [name for name, _ in operation_port.events] == [
        "claim",
        "accepted",
        "completed",
    ]


@pytest.mark.asyncio
async def test_newapi_disable_between_poll_and_fetch_stops_fetch(
    monkeypatch, tmp_path: Path
) -> None:
    from novelvideo.generators.video_generator import NewApiVideoGenerator
    from novelvideo.ports.authz import AuthzError

    context = _context()
    operation_port = _OperationPort()
    events: list[str] = []
    _install_newapi_ports(monkeypatch, context, operation_port, events)
    generator = NewApiVideoGenerator(
        model="seedance-1.0-pro-fast", egress_context=context
    )
    revalidations = 0

    async def post(*_args, **_kwargs):
        return {"id": "provider-job-1"}

    async def poll(*_args, **_kwargs):
        return {"status": "completed", "video_url": "https://result.example/video"}

    async def revalidate(_context):
        nonlocal revalidations
        revalidations += 1
        if revalidations == 2:
            raise AuthzError("P0_GRAY_DISABLED")

    async def forbidden_fetch(*_args, **_kwargs):
        raise AssertionError("fetch must remain zero after disable")

    monkeypatch.setattr(generator, "_post_json", post)
    monkeypatch.setattr(generator, "_get_json", poll)
    monkeypatch.setattr(generator, "_revalidate_organization", revalidate)
    monkeypatch.setattr(generator, "_download_video", forbidden_fetch)

    result = await generator.generate(
        image_path=None,
        prompt="prompt",
        output_path=str(tmp_path / "video.mp4"),
        episode=1,
        beat_num=2,
        scope="beat",
        task_type="single_video",
        max_polls=1,
    )
    assert result.error == "P0_GRAY_DISABLED"
    assert revalidations == 2
    assert [name for name, _ in operation_port.events] == [
        "claim",
        "accepted",
        "unknown",
    ]


@pytest.mark.asyncio
async def test_newapi_disable_between_video_and_last_frame_fetch_stops_second_fetch(
    monkeypatch, tmp_path: Path
) -> None:
    from novelvideo.generators.video_generator import NewApiVideoGenerator
    from novelvideo.ports.authz import AuthzError

    context = _context()
    operation_port = _OperationPort()
    events: list[str] = []
    _install_newapi_ports(monkeypatch, context, operation_port, events)
    generator = NewApiVideoGenerator(
        model="seedance-1.0-pro-fast", egress_context=context
    )
    revalidations = 0
    fetched: list[str] = []

    async def post(*_args, **_kwargs):
        return {"id": "provider-job-1"}

    async def poll(*_args, **_kwargs):
        return {
            "status": "completed",
            "video_url": "https://result.example/video.mp4",
            "last_frame_url": "https://result.example/last.png",
        }

    async def revalidate(_context):
        nonlocal revalidations
        revalidations += 1
        if revalidations == 3:
            raise AuthzError("P0_GRAY_DISABLED")

    async def download(url, _output_path):
        fetched.append(url)
        return b"video"

    monkeypatch.setattr(generator, "_post_json", post)
    monkeypatch.setattr(generator, "_get_json", poll)
    monkeypatch.setattr(generator, "_revalidate_organization", revalidate)
    monkeypatch.setattr(generator, "_download_video", download)

    result = await generator.generate(
        image_path=None,
        prompt="prompt",
        output_path=str(tmp_path / "video.mp4"),
        gen_mode="text_to_video",
        seedance2_config={"return_last_frame": True},
        episode=1,
        beat_num=2,
        scope="beat",
        task_type="single_video",
        max_polls=1,
    )
    assert result.error == "P0_GRAY_DISABLED"
    assert revalidations == 3
    assert fetched == ["https://result.example/video.mp4"]
    assert [name for name, _ in operation_port.events] == [
        "claim",
        "accepted",
        "unknown",
    ]


def test_comfy_service_requires_allowlisted_endpoint_and_no_org_key() -> None:
    from novelvideo.generators.video_generator import (
        ComfyUIVideoGenerator,
        VideoEgressError,
        create_video_generator,
    )

    context = _context()
    generator = create_video_generator("comfyui", egress_context=context)
    assert isinstance(generator, ComfyUIVideoGenerator)
    assert generator.server_address == ComfyUIVideoGenerator.DEFAULT_ADDRESS
    assert generator.use_ssl is True

    for kwargs in (
        {"server_address": "arbitrary.example:8188", "use_ssl": True},
        {"api_key": "organization-secret"},
    ):
        with pytest.raises(VideoEgressError) as exc_info:
            create_video_generator("comfyui", egress_context=context, **kwargs)
        assert exc_info.value.code == "ORG_SERVICE_EGRESS_DENIED"


def test_comfy_loopback_requires_trusted_local_context_and_ignores_secret_env(
    monkeypatch,
) -> None:
    from novelvideo.generators.video_generator import (
        ComfyUIVideoGenerator,
        VideoEgressError,
        create_video_generator,
    )

    monkeypatch.setenv("OPENAI_API_KEY", "secret-env-canary")
    monkeypatch.setenv("ARK_API_KEY", "secret-env-canary")
    generator = create_video_generator(
        "comfyui",
        egress_context=_context("local"),
        server_address="127.0.0.1:8188",
        use_ssl=False,
    )
    assert isinstance(generator, ComfyUIVideoGenerator)
    assert generator.http_url == "http://127.0.0.1:8188"
    assert not hasattr(generator, "api_key")

    with pytest.raises(VideoEgressError) as exc_info:
        create_video_generator(
            "comfyui",
            egress_context=_context(),
            server_address="127.0.0.1:8188",
            use_ssl=False,
        )
    assert exc_info.value.code == "ORG_SERVICE_EGRESS_DENIED"

    with pytest.raises(VideoEgressError) as remote_exc_info:
        create_video_generator(
            "comfyui",
            egress_context=_context("local"),
            server_address=ComfyUIVideoGenerator.DEFAULT_ADDRESS,
            use_ssl=True,
        )
    assert remote_exc_info.value.code == "ORG_SERVICE_EGRESS_DENIED"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("kind", "factory_kwargs"),
    [
        ("organization", {}),
        ("local", {"server_address": "127.0.0.1:8188", "use_ssl": False}),
    ],
)
async def test_comfy_allowed_service_and_local_paths_submit_poll_fetch(
    monkeypatch, tmp_path: Path, kind: str, factory_kwargs: dict
) -> None:
    import novelvideo.generators.video_generator as video_generator
    from novelvideo.generators.video_generator import (
        VideoGenStatus,
        create_video_generator,
    )

    monkeypatch.setenv("OPENAI_API_KEY", "secret-env-canary")
    monkeypatch.setenv("ARK_API_KEY", "secret-env-canary")
    context = _context(kind)
    generator = create_video_generator(
        "comfyui", egress_context=context, **factory_kwargs
    )
    image_path = tmp_path / f"{kind}.png"
    image_path.write_bytes(b"frame")
    events: list[str] = []

    class WebSocket:
        async def recv(self):
            return '{"type":"executing","data":{"prompt_id":"prompt-1","node":null}}'

        async def close(self):
            return None

    async def connect(*_args, **_kwargs):
        events.append("connect")
        return WebSocket()

    async def upload(*_args, **_kwargs):
        events.append("upload")
        return {"name": "frame.png"}

    async def submit(*_args, **_kwargs):
        events.append("submit")
        return {"prompt_id": "prompt-1"}

    async def poll(*_args, **_kwargs):
        events.append("poll")
        return {"prompt-1": {"outputs": {"61": {"gifs": [{"filename": "video.mp4"}]}}}}

    async def fetch(*_args, **_kwargs):
        events.append("fetch")
        return b"video"

    async def no_sleep(*_args, **_kwargs):
        return None

    monkeypatch.setattr(video_generator.websockets, "connect", connect)
    monkeypatch.setattr(video_generator.asyncio, "sleep", no_sleep)
    monkeypatch.setattr(generator, "_upload_image", upload)
    monkeypatch.setattr(generator, "_queue_prompt", submit)
    monkeypatch.setattr(generator, "_get_history", poll)
    monkeypatch.setattr(generator, "_download_video", fetch)

    result = await generator.generate(
        image_path=str(image_path),
        prompt="prompt",
        output_path=str(tmp_path / f"{kind}.mp4"),
        egress_context=context,
    )

    assert result.status is VideoGenStatus.DONE
    assert events == ["upload", "connect", "submit", "poll", "fetch"]


@pytest.mark.asyncio
async def test_comfy_direct_instance_rechecks_service_policy_before_network(
    tmp_path: Path,
) -> None:
    from novelvideo.generators.video_generator import (
        ComfyUIVideoGenerator,
        VideoEgressError,
    )

    generator = ComfyUIVideoGenerator(
        server_address="arbitrary.example:8188",
        use_ssl=True,
    )
    with pytest.raises(VideoEgressError) as exc_info:
        await generator.generate(
            image_path=str(tmp_path / "missing.png"),
            prompt="prompt",
            output_path=str(tmp_path / "video.mp4"),
            egress_context=_context(),
        )
    assert exc_info.value.code == "ORG_SERVICE_EGRESS_DENIED"


@pytest.mark.asyncio
async def test_single_video_runner_propagates_trusted_context(
    monkeypatch, tmp_path: Path
) -> None:
    from novelvideo.generators.video_generator import VideoGenStatus
    from novelvideo.project_context import ProjectContext
    from novelvideo.task_backend.runners import video as video_runner

    context = _context()
    calls: dict[str, dict] = {}

    class TaskManager:
        def update_progress_for_project(self, *_args, **_kwargs) -> None:
            return None

    class Generator:
        async def generate(self, **kwargs):
            calls["generate"] = kwargs
            output = Path(kwargs["output_path"])
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_bytes(b"video")
            return SimpleNamespace(
                status=VideoGenStatus.DONE,
                error=None,
                task_id="provider-job-1",
                provider_task_id="provider-job-1",
                last_frame_path=None,
                last_frame_url=None,
            )

    def create(**kwargs):
        calls["create"] = kwargs
        return Generator()

    monkeypatch.setattr(video_runner, "get_task_manager", lambda: TaskManager())
    monkeypatch.setattr(
        "novelvideo.generators.video_generator.create_video_generator", create
    )
    monkeypatch.setattr(
        "novelvideo.generators.video_pool_indexer.add_video_to_pool",
        lambda **_kwargs: SimpleNamespace(id="pool-1"),
    )
    project_context = ProjectContext(
        project_id="project-1",
        project_name="demo",
        owner_type="user",
        owner_id="user-1",
        owner_username="user",
        requester_user_id="user-1",
        requester_username="user",
        requester_principals=(("user", "user-1"),),
        effective_role="editor",
        home_node_id="local",
        output_dir=tmp_path / "output",
        state_dir=tmp_path / "state",
        runtime_dir=tmp_path / "runtime",
        is_home_node=True,
    )
    await video_runner._run_single_video_async(
        {
            "task_type": "single_video",
            "episode": 1,
            "beat_num": 2,
            "scope": "beat",
            "__trusted_egress_context": context,
            "payload": {
                "config": {
                    "frame_path": None,
                    "prompt": "prompt",
                    "video_backend": "newapi_seedance-1.0-pro-fast",
                }
            },
        },
        project_context,
    )

    assert calls["create"]["egress_context"] is context
    assert calls["generate"]["egress_context"] is context
    assert calls["generate"]["scope"] == "beat"


@pytest.mark.asyncio
async def test_freezone_video_leaf_propagates_trusted_context(
    monkeypatch, tmp_path: Path
) -> None:
    from novelvideo.freezone.video_node import run_trusted_freezone_video_gen
    from novelvideo.generators.video_generator import VideoGenStatus

    context = _context()
    calls: dict[str, dict] = {}

    class Generator:
        async def generate(self, **kwargs):
            calls["generate"] = kwargs
            output = Path(kwargs["output_path"])
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_bytes(b"video")
            return SimpleNamespace(status=VideoGenStatus.DONE, error=None)

    def create(**kwargs):
        calls["create"] = kwargs
        return Generator()

    monkeypatch.setattr(
        "novelvideo.generators.video_generator.create_video_generator", create
    )
    output = await run_trusted_freezone_video_gen(
        project_dir=tmp_path,
        job_id="job-1",
        prompt="prompt",
        backend="newapi_seedance-1.0-pro-fast",
        egress_context=context,
        task_type="freezone_video_gen",
        episode=0,
        beat_num=0,
        scope="job-1",
    )

    assert output.exists()
    assert calls["create"]["egress_context"] is context
    assert calls["generate"]["egress_context"] is context
    assert calls["generate"]["task_type"] == "freezone_video_gen"
    assert calls["generate"]["scope"] == "job-1"


@pytest.mark.asyncio
async def test_freezone_platform_context_preserves_legacy_leaf(
    monkeypatch, tmp_path: Path
) -> None:
    from novelvideo.project_context import ProjectContext
    from novelvideo.task_backend.runners import video as video_runner

    calls: list[dict] = []

    class TaskManager:
        def update_progress_for_project(self, *_args, **_kwargs) -> None:
            return None

    async def legacy_leaf(**kwargs):
        calls.append(kwargs)
        output = kwargs["project_dir"] / "freezone" / "legacy.mp4"
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_bytes(b"video")
        return output

    async def forbidden(*_args, **_kwargs):
        raise AssertionError("platform flow must preserve the existing leaf")

    monkeypatch.setattr(video_runner, "get_task_manager", lambda: TaskManager())
    monkeypatch.setattr("novelvideo.freezone.jobs.run_freezone_video_gen", legacy_leaf)
    monkeypatch.setattr(
        "novelvideo.freezone.video_node.run_trusted_freezone_video_gen", forbidden
    )
    project_context = ProjectContext(
        project_id="project-1",
        project_name="demo",
        owner_type="user",
        owner_id="user-1",
        owner_username="user",
        requester_user_id="user-1",
        requester_username="user",
        requester_principals=(("user", "user-1"),),
        effective_role="editor",
        home_node_id="local",
        output_dir=tmp_path / "output",
        state_dir=tmp_path / "state",
        runtime_dir=tmp_path / "runtime",
        is_home_node=True,
    )
    await video_runner._run_freezone_video_gen_async(
        {
            "task_type": "freezone_video_gen",
            "scope": "job-1",
            "__trusted_egress_context": _context("platform"),
            "payload": {
                "job_id": "job-1",
                "project_dir": str(project_context.output_dir),
                "backend": "seedance_fast",
            },
        },
        project_context,
    )

    assert len(calls) == 1
    assert "egress_context" not in calls[0]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("poll_response", "expected_error"),
    [
        (
            {
                "status": "failed",
                "error": {
                    "code": "VIDEO_MEDIA_DIMENSIONS_INVALID",
                    "message": "素材尺寸不符合要求 secret-canary",
                },
            },
            "VIDEO_MEDIA_DIMENSIONS_INVALID",
        ),
        (
            {
                "status": "failed",
                "error_message": (
                    "素材审核失败（共 1 个素材）：\n\n[1] 素材：https://relay.example/"
                    "a.jpg?OSSAccessKeyId=secret-canary\n    原因：[InvalidParameter."
                    "HeightTooSmall] Height must be between 300px and 6000px."
                ),
            },
            "VIDEO_MEDIA_DIMENSIONS_INVALID",
        ),
        (
            {
                "status": "failed",
                "error": {"code": "weird secret-canary", "message": "x"},
            },
            "x",
        ),
        (
            {
                "status": "failed",
                "error": "video generation failed",
                "content": "提示词长度超过模型限制，请缩短后重试",
            },
            "提示词长度超过模型限制，请缩短后重试",
        ),
        (
            {
                "status": "failed",
                "content": {
                    "message": (
                        "参考素材读取失败：https://relay.example/a.jpg?"
                        "OSSAccessKeyId=secret-canary 请更换素材后重试"
                    )
                },
            },
            "参考素材读取失败：[redacted-url] 请更换素材后重试",
        ),
    ],
)
async def test_newapi_organization_failures_keep_safe_provider_error_details(
    monkeypatch,
    tmp_path: Path,
    poll_response: dict,
    expected_error: str,
) -> None:
    """厂商明确打回时，组织账号拿到安全错误码或脱敏后的具体消息。

    2026-08-26 3060 上 creator02-zhu 的参考图 338x191 被火山 HeightTooSmall 拒了 8 次，
    用户只看到 `EGRESS_OPERATION_UNKNOWN`。已知 `VIDEO_*` 枚举码继续优先放行；其他明确
    失败恢复安全消息，但带签名的 relay URL 依旧不能进 result。
    """
    from novelvideo.generators.video_generator import (
        NewApiVideoGenerator,
        VideoGenStatus,
    )

    context = _context()
    operation_port = _OperationPort()
    events: list[str] = []
    _install_newapi_ports(monkeypatch, context, operation_port, events)
    generator = NewApiVideoGenerator(
        model="seedance-2.0", egress_context=context
    )
    refund_errors: list[str] = []

    async def post(*_args, **_kwargs):
        return {"id": "provider-job-1"}

    async def poll(*_args, **_kwargs):
        return poll_response

    async def capture_refund(*_args, **kwargs):
        refund_errors.append(str(kwargs.get("error") or ""))

    monkeypatch.setattr(generator, "_post_json", post)
    monkeypatch.setattr(generator, "_get_json", poll)
    monkeypatch.setattr(
        generator, "_revalidate_organization", lambda _context: _async_none()
    )
    monkeypatch.setattr(
        "novelvideo.generators.video_generator._refund_video_model_call",
        capture_refund,
    )

    result = await generator.generate(
        image_path=None,
        prompt="prompt",
        output_path=str(tmp_path / "video.mp4"),
        episode=1,
        beat_num=2,
        scope="beat",
        task_type="single_video",
        max_polls=1,
    )

    assert result.status is VideoGenStatus.FAILED
    assert result.error == expected_error
    assert "secret-canary" not in repr(result)
    assert refund_errors == [expected_error]
    assert [name for name, _ in operation_port.events] == [
        "claim",
        "accepted",
        "unknown",
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("status_code", "response_body", "expected_error", "expected_transition"),
    [
        (
            400,
            '{"error": {"code": "VIDEO_MEDIA_DIMENSIONS_INVALID", '
            '"message": "secret-canary"}}',
            "VIDEO_MEDIA_DIMENSIONS_INVALID",
            "rejected_before_submit",
        ),
        (
            400,
            '{"error": {"content": "请求参数不受当前模型支持：'
            'https://relay.example/a.png?token=secret-canary 请调整后重试"}}',
            "请求参数不受当前模型支持：[redacted-url] 请调整后重试",
            "rejected_before_submit",
        ),
        (
            403,
            '{"error": {"content": "token quota is not enough"}}',
            "token quota is not enough",
            "rejected_before_submit",
        ),
        (
            500,
            '{"error": {"content": "upstream result is uncertain"}}',
            "upstream result is uncertain",
            "unknown",
        ),
    ],
)
async def test_newapi_organization_submit_response_keeps_safe_error_and_terminal_state(
    monkeypatch,
    tmp_path: Path,
    status_code: int,
    response_body: str,
    expected_error: str,
    expected_transition: str,
) -> None:
    """提交响应恢复安全详情，并按是否明确拒绝收敛出口状态。"""
    from novelvideo.generators.video_generator import (
        NewApiVideoError,
        NewApiVideoGenerator,
        VideoGenStatus,
    )

    context = _context()
    operation_port = _OperationPort()
    events: list[str] = []
    _install_newapi_ports(monkeypatch, context, operation_port, events)
    generator = NewApiVideoGenerator(model="seedance-2.0", egress_context=context)

    async def rejected(*_args, **_kwargs):
        raise NewApiVideoError(
            f"DramaClawAPI submit failed: HTTP {status_code} - {response_body}",
            request_id="req-1",
            status_code=status_code,
        )

    monkeypatch.setattr(generator, "_post_json", rejected)
    monkeypatch.setattr(
        generator, "_revalidate_organization", lambda _context: _async_none()
    )

    result = await generator.generate(
        image_path=None,
        prompt="prompt",
        output_path=str(tmp_path / "video.mp4"),
        episode=1,
        beat_num=2,
        scope="beat",
        task_type="single_video",
    )

    assert result.status is VideoGenStatus.FAILED
    assert result.error == expected_error
    assert "secret-canary" not in repr(result)
    assert [name for name, _ in operation_port.events] == ["claim", expected_transition]
