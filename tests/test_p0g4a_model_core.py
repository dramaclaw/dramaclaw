from __future__ import annotations

import pytest
import ast
from pathlib import Path
from types import SimpleNamespace

from novelvideo.egress_context import TrustedEgressContext
from novelvideo.egress_context import TRUSTED_EGRESS_CONTEXT_KEY, TrustedRunnerEnvelope
from novelvideo.ports.authz import BillingPrincipal
from novelvideo.ports.egress_operations import (
    OperationClaimResult,
    OperationSnapshot,
    OperationState,
)
from novelvideo.ports.model_credentials import (
    CredentialReference,
    ModelCredentialError,
    RequestCredential,
)
from pydantic_ai.messages import ModelRequest, UserPromptPart
from pydantic_ai.models import ModelRequestParameters


def _organization_context(
    *,
    envelope_id: str = "envelope-1",
    org_id: str = "org-1",
    credential_id: str = "credential-1",
) -> TrustedEgressContext:
    return TrustedEgressContext(
        envelope_id=envelope_id,
        project_id="project-1",
        task_type="script_writer",
        requester_user_id="user-1",
        root_task_id="root-task-1",
        admission_id="admission-1",
        admitted_at="2026-08-03T04:05:00Z",
        membership_id="membership-1",
        authz_version=7,
        billing_principal=BillingPrincipal(kind="organization", id=org_id),
        credential=CredentialReference(
            source="organization",
            credential_id=credential_id,
            key_version=3,
            org_id=org_id,
        ),
    )


def _platform_context() -> TrustedEgressContext:
    return TrustedEgressContext(
        envelope_id="envelope-platform",
        project_id="project-1",
        task_type="sketch_generation",
        requester_user_id="user-1",
        root_task_id="root-platform",
        admission_id="admission-platform",
        admitted_at="2026-08-03T04:05:00Z",
        membership_id=None,
        authz_version=1,
        billing_principal=BillingPrincipal(kind="platform", id="user-1"),
        credential=CredentialReference(
            source="platform",
            credential_id="platform-newapi",
            key_version=1,
        ),
    )


class _OperationPort:
    def __init__(self, *, won: bool = True) -> None:
        self.won = won
        self.calls: list[tuple[str, object]] = []

    async def claim(self, *, spec):
        self.calls.append(("claim", spec))
        return OperationClaimResult(
            won=self.won,
            operation=OperationSnapshot(
                operation_id="operation-1",
                operation_key=spec.operation_key,
                state=(
                    OperationState.DISPATCHING if self.won else OperationState.ACCEPTED
                ),
                version=1,
            ),
            transition_token="transition-1" if self.won else None,
        )

    async def mark_rejected_before_submit(self, **kwargs):
        self.calls.append(("rejected", kwargs))
        return OperationSnapshot(
            operation_id="operation-1",
            operation_key="key",
            state=OperationState.REJECTED_BEFORE_SUBMIT,
            version=2,
        )

    async def mark_accepted(self, **kwargs):
        self.calls.append(("accepted", kwargs))
        return OperationSnapshot(
            operation_id="operation-1",
            operation_key="key",
            state=OperationState.ACCEPTED,
            version=2,
        )

    async def mark_completed(self, **kwargs):
        self.calls.append(("completed", kwargs))
        return OperationSnapshot(
            operation_id="operation-1",
            operation_key="key",
            state=OperationState.COMPLETED,
            version=3,
        )

    async def mark_unknown(self, **kwargs):
        self.calls.append(("unknown", kwargs))
        return OperationSnapshot(
            operation_id="operation-1",
            operation_key="key",
            state=OperationState.UNKNOWN,
            version=2,
        )


class _CredentialPort:
    def __init__(
        self, outcome: RequestCredential | Exception, events: list[str]
    ) -> None:
        self.outcome = outcome
        self.events = events
        self.admissions: list[object] = []

    async def resolve(self, admission):
        self.events.append("resolve")
        self.admissions.append(admission)
        if isinstance(self.outcome, Exception):
            raise self.outcome
        return self.outcome


@pytest.mark.asyncio
async def test_c1_eg01_pos_claims_and_resolves_exact_credential_before_submit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from novelvideo import model_gateway_runtime as runtime

    events: list[str] = []
    operation_port = _OperationPort()
    credential = RequestCredential(
        reference=_organization_context().credential,
        api_key="sk-request-scoped-canary",
        base_url="https://gateway.example/v1",
    )
    credential_port = _CredentialPort(credential, events)

    async def submit(resolved: RequestCredential):
        events.append("submit")
        assert resolved is credential
        return {"id": "response-1"}

    monkeypatch.setattr(runtime, "get_egress_operation_port", lambda: operation_port)
    monkeypatch.setattr(runtime, "get_model_credentials", lambda: credential_port)

    with runtime.model_gateway_request_scope(_organization_context()):
        result = await runtime.execute_organization_gateway_request(
            capability="text.generate",
            business_task_id="envelope-1:text.generate:1",
            request_digest="a" * 64,
            submit=submit,
        )

    assert result == {"id": "response-1"}
    assert events == ["resolve", "submit"]
    assert [name for name, _payload in operation_port.calls] == [
        "claim",
        "accepted",
        "completed",
    ]
    claim_spec = operation_port.calls[0][1]
    assert claim_spec.organization_id == "org-1"
    assert claim_spec.credential_id == "credential-1"
    assert claim_spec.credential_version == 3
    assert claim_spec.business_task_id == "envelope-1:text.generate:1"
    assert claim_spec.request_digest == "a" * 64
    assert (
        credential_port.admissions[0].credential == _organization_context().credential
    )
    assert credential_port.admissions[0].admitted_at == "2026-08-03T04:05:00Z"


@pytest.mark.asyncio
async def test_c1_eg01_nofb_credential_failure_has_zero_submit_and_no_env_fallback(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from novelvideo import model_gateway_runtime as runtime

    events: list[str] = []
    operation_port = _OperationPort()
    credential_port = _CredentialPort(
        ModelCredentialError("ORG_CREDENTIAL_VERSION_MISMATCH"),
        events,
    )
    submit_calls = 0

    async def submit(_resolved):
        nonlocal submit_calls
        submit_calls += 1
        raise AssertionError("network submit must remain zero")

    monkeypatch.setenv("MODEL_API_KEY", "sk-platform-fallback-canary")
    monkeypatch.setenv("OPENAI_API_KEY", "sk-provider-fallback-canary")
    monkeypatch.setattr(runtime, "get_egress_operation_port", lambda: operation_port)
    monkeypatch.setattr(runtime, "get_model_credentials", lambda: credential_port)

    with runtime.model_gateway_request_scope(_organization_context()):
        with pytest.raises(ModelCredentialError) as excinfo:
            await runtime.execute_organization_gateway_request(
                capability="text.generate",
                business_task_id="envelope-1:text.generate:1",
                request_digest="b" * 64,
                submit=submit,
            )

    assert excinfo.value.code == "ORG_CREDENTIAL_VERSION_MISMATCH"
    assert submit_calls == 0
    assert [name for name, _payload in operation_port.calls] == ["claim", "rejected"]


@pytest.mark.asyncio
async def test_existing_operation_never_resubmits(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from novelvideo import model_gateway_runtime as runtime

    operation_port = _OperationPort(won=False)
    credential_calls = 0
    submit_calls = 0

    class CredentialPort:
        async def resolve(self, _admission):
            nonlocal credential_calls
            credential_calls += 1
            raise AssertionError("existing operation must not resolve credentials")

    async def submit(_resolved):
        nonlocal submit_calls
        submit_calls += 1

    monkeypatch.setattr(runtime, "get_egress_operation_port", lambda: operation_port)
    monkeypatch.setattr(runtime, "get_model_credentials", lambda: CredentialPort())

    with runtime.model_gateway_request_scope(_organization_context()):
        with pytest.raises(runtime.ModelGatewayEgressError) as excinfo:
            await runtime.execute_organization_gateway_request(
                capability="text.generate",
                business_task_id="envelope-1:text.generate:1",
                request_digest="c" * 64,
                submit=submit,
            )

    assert excinfo.value.code == "EGRESS_OPERATION_REPLAYED"
    assert credential_calls == 0
    assert submit_calls == 0


def test_request_scopes_isolate_identity_without_storing_credentials() -> None:
    from novelvideo import model_gateway_runtime as runtime

    first = _organization_context(envelope_id="envelope-a")
    second = _organization_context(envelope_id="envelope-b")
    with runtime.model_gateway_request_scope(first):
        assert runtime.current_model_gateway_context() is first
        with runtime.model_gateway_request_scope(second):
            assert runtime.current_model_gateway_context() is second
        assert runtime.current_model_gateway_context() is first
    assert runtime.current_model_gateway_context() is None
    assert "api_key" not in repr(first).casefold()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "capability",
    [
        "text.generate",
        "text.generate.agent",
        "text.generate.workflow",
        "vision.analyze",
        "freezone.text.generate",
    ],
)
async def test_gateway_routed_pydantic_model_uses_one_request_scoped_transport(
    monkeypatch: pytest.MonkeyPatch,
    capability: str,
) -> None:
    from novelvideo import config
    from novelvideo import model_gateway_runtime as runtime

    operation_port = _OperationPort()
    credential = RequestCredential(
        reference=_organization_context().credential,
        api_key="sk-request-scoped-canary",
        base_url="https://gateway.example/v1",
    )
    credential_port = _CredentialPort(credential, [])
    factory_calls: list[dict[str, object]] = []
    transport_calls: list[tuple[object, object, object]] = []
    response = object()

    class Delegate:
        async def request(self, messages, model_settings, model_request_parameters):
            transport_calls.append((messages, model_settings, model_request_parameters))
            return response

    def delegate_factory(model_name: str, **kwargs):
        factory_calls.append({"model_name": model_name, **kwargs})
        return Delegate()

    monkeypatch.setenv("ST_EDITION", "ee")
    monkeypatch.setenv("ST_CONTROL_PLANE_DSN", "postgresql://control-plane")
    monkeypatch.setattr(runtime, "get_egress_operation_port", lambda: operation_port)
    monkeypatch.setattr(runtime, "get_model_credentials", lambda: credential_port)
    monkeypatch.setattr(config, "_newapi_text_openai_model", delegate_factory)
    messages = [ModelRequest(parts=[UserPromptPart(content="hello")])]
    parameters = ModelRequestParameters()

    model = config.get_newapi_text_pydantic_model(
        "P0G4A_MODEL",
        "DC-p0g4a",
        capability=capability,
    )
    with runtime.model_gateway_request_scope(_organization_context()):
        result = await model.request(messages, None, parameters)

    assert result is response
    assert len(factory_calls) == 1
    assert factory_calls[0]["api_key"] == "sk-request-scoped-canary"
    assert factory_calls[0]["base_url"] == "https://gateway.example/v1"
    assert transport_calls == [(messages, None, parameters)]
    claim_spec = operation_port.calls[0][1]
    assert claim_spec.capability == capability
    assert claim_spec.business_task_id == f"envelope-1:{capability}:000001"
    assert len(claim_spec.request_digest) == 64


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "capability",
    [
        "text.generate",
        "text.generate.agent",
        "text.generate.workflow",
        "vision.analyze",
        "freezone.text.generate",
    ],
)
async def test_gateway_routed_model_failure_never_builds_platform_or_provider_transport(
    monkeypatch: pytest.MonkeyPatch,
    capability: str,
) -> None:
    from novelvideo import config
    from novelvideo import model_gateway_runtime as runtime

    operation_port = _OperationPort()
    credential_port = _CredentialPort(
        ModelCredentialError("ORG_CREDENTIAL_MISSING"),
        [],
    )
    factory_calls = 0

    def forbidden_factory(*_args, **_kwargs):
        nonlocal factory_calls
        factory_calls += 1
        raise AssertionError("transport factory must not run")

    monkeypatch.setenv("ST_EDITION", "ee")
    monkeypatch.setenv("ST_CONTROL_PLANE_DSN", "postgresql://control-plane")
    monkeypatch.setenv("MODEL_API_KEY", "sk-platform-fallback-canary")
    monkeypatch.setenv("OPENAI_API_KEY", "sk-provider-fallback-canary")
    monkeypatch.setattr(runtime, "get_egress_operation_port", lambda: operation_port)
    monkeypatch.setattr(runtime, "get_model_credentials", lambda: credential_port)
    monkeypatch.setattr(config, "_newapi_text_openai_model", forbidden_factory)
    monkeypatch.setattr(
        config,
        "get_newapi_runtime_credentials",
        lambda **_kwargs: pytest.fail(
            "organization path must not read runtime credentials"
        ),
    )

    model = config.get_newapi_text_pydantic_model(
        "P0G4A_MODEL",
        "DC-p0g4a",
        capability=capability,
    )
    with runtime.model_gateway_request_scope(_organization_context()):
        with pytest.raises(ModelCredentialError) as excinfo:
            await model.request(
                [ModelRequest(parts=[UserPromptPart(content="hello")])],
                None,
                ModelRequestParameters(),
            )

    assert excinfo.value.code == "ORG_CREDENTIAL_MISSING"
    assert factory_calls == 0
    assert [name for name, _payload in operation_port.calls] == ["claim", "rejected"]


@pytest.mark.asyncio
async def test_submitted_transport_exception_is_marked_unknown_without_retry(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from novelvideo import model_gateway_runtime as runtime

    operation_port = _OperationPort()
    credential = RequestCredential(
        reference=_organization_context().credential,
        api_key="sk-unknown-canary",
        base_url="https://gateway.example/v1",
    )
    transport_calls = 0

    async def submit(_credential):
        nonlocal transport_calls
        transport_calls += 1
        raise TimeoutError("provider outcome unavailable")

    monkeypatch.setattr(runtime, "get_egress_operation_port", lambda: operation_port)
    monkeypatch.setattr(
        runtime,
        "get_model_credentials",
        lambda: _CredentialPort(credential, []),
    )

    with runtime.model_gateway_request_scope(_organization_context()):
        with pytest.raises(TimeoutError):
            await runtime.execute_organization_gateway_request(
                capability="text.generate",
                business_task_id="envelope-1:text.generate:1",
                request_digest="d" * 64,
                submit=submit,
            )

    assert transport_calls == 1
    assert [name for name, _payload in operation_port.calls] == ["claim", "unknown"]


def test_request_scoped_objects_and_operation_spec_do_not_expose_plaintext_key() -> (
    None
):
    from novelvideo import model_gateway_runtime as runtime
    from novelvideo.ports.egress_operations import OperationSpec

    canary = "sk-plaintext-must-not-escape"
    context = _organization_context()
    credential = RequestCredential(
        reference=context.credential,
        api_key=canary,
        base_url="https://gateway.example/v1",
    )
    operation = OperationSpec(
        organization_id="org-1",
        project_id="project-1",
        root_task_id="root-1",
        business_task_id="business-1",
        capability="text.generate",
        credential_id="credential-1",
        credential_version=3,
        request_digest="e" * 64,
    )

    with runtime.model_gateway_request_scope(context):
        assert canary not in repr(runtime.current_model_gateway_context())
    assert canary not in repr(credential)
    assert canary not in repr(operation)


@pytest.mark.asyncio
async def test_c1_eg02_pos_stream_uses_one_transport_and_completes_after_consumption(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from contextlib import asynccontextmanager

    from novelvideo import config
    from novelvideo import model_gateway_runtime as runtime

    operation_port = _OperationPort()
    credential = RequestCredential(
        reference=_organization_context().credential,
        api_key="sk-stream-request",
        base_url="https://gateway.example/v1",
    )
    credential_port = _CredentialPort(credential, [])
    transport_calls = 0
    streamed_response = object()

    class Delegate:
        @asynccontextmanager
        async def request_stream(self, *_args, **_kwargs):
            nonlocal transport_calls
            transport_calls += 1
            yield streamed_response

    monkeypatch.setenv("ST_EDITION", "ee")
    monkeypatch.setenv("ST_CONTROL_PLANE_DSN", "postgresql://control-plane")
    monkeypatch.setattr(runtime, "get_egress_operation_port", lambda: operation_port)
    monkeypatch.setattr(runtime, "get_model_credentials", lambda: credential_port)
    monkeypatch.setattr(
        config, "_newapi_text_openai_model", lambda *_args, **_kwargs: Delegate()
    )

    model = config.get_newapi_text_pydantic_model(
        "P0G4A_MODEL",
        "DC-p0g4a",
        capability="text.generate.agent",
    )
    with runtime.model_gateway_request_scope(_organization_context()):
        async with model.request_stream(
            [ModelRequest(parts=[UserPromptPart(content="hello")])],
            None,
            ModelRequestParameters(),
        ) as response:
            assert response is streamed_response
            assert [name for name, _payload in operation_port.calls] == [
                "claim",
                "accepted",
            ]

    assert transport_calls == 1
    assert [name for name, _payload in operation_port.calls] == [
        "claim",
        "accepted",
        "completed",
    ]


@pytest.mark.asyncio
async def test_c1_eg02_nofb_stream_resolve_failure_has_zero_transport(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from novelvideo import config
    from novelvideo import model_gateway_runtime as runtime

    operation_port = _OperationPort()
    credential_port = _CredentialPort(
        ModelCredentialError("ORG_CREDENTIAL_MISSING"), []
    )
    factory_calls = 0

    def forbidden_factory(*_args, **_kwargs):
        nonlocal factory_calls
        factory_calls += 1
        raise AssertionError("stream transport must remain zero")

    monkeypatch.setenv("ST_EDITION", "ee")
    monkeypatch.setenv("ST_CONTROL_PLANE_DSN", "postgresql://control-plane")
    monkeypatch.setattr(runtime, "get_egress_operation_port", lambda: operation_port)
    monkeypatch.setattr(runtime, "get_model_credentials", lambda: credential_port)
    monkeypatch.setattr(config, "_newapi_text_openai_model", forbidden_factory)

    model = config.get_newapi_text_pydantic_model(
        "P0G4A_MODEL",
        "DC-p0g4a",
        capability="text.generate.agent",
    )
    with runtime.model_gateway_request_scope(_organization_context()):
        with pytest.raises(ModelCredentialError):
            async with model.request_stream(
                [ModelRequest(parts=[UserPromptPart(content="hello")])],
                None,
                ModelRequestParameters(),
            ):
                pass

    assert factory_calls == 0
    assert [name for name, _payload in operation_port.calls] == ["claim", "rejected"]


@pytest.mark.asyncio
async def test_c1_eg18a_pos_freezone_text_binds_only_trusted_identity(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from novelvideo import model_gateway_runtime as runtime
    from novelvideo.freezone import text_node

    seen: list[TrustedEgressContext | None] = []

    class Agent:
        async def run(self, _task):
            seen.append(runtime.current_model_gateway_context())
            return SimpleNamespace(
                output=text_node.FreezoneTranslationResult(
                    translated_text="hello",
                    source_language="zh",
                    target_language="en",
                )
            )

    monkeypatch.setattr(text_node, "get_freezone_translation_agent", lambda: Agent())
    context = _organization_context()

    result = await text_node.translate_freezone_text(
        text="你好",
        node_type="text",
        egress_context=context,
    )

    assert result == ("hello", "zh", "en")
    assert seen == [context]
    assert runtime.current_model_gateway_context() is None


@pytest.mark.asyncio
async def test_c1_eg04b_deny_precedes_provider_env_and_registry_reads(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
) -> None:
    from novelvideo import model_gateway_runtime as runtime
    from novelvideo.verification import sketch_visual_gate

    summary_path = tmp_path / "summary.json"
    summary_path.write_text('{"grid_results": []}', encoding="utf-8")
    monkeypatch.setattr(
        sketch_visual_gate.failure_registry,
        "list_active",
        lambda *_args, **_kwargs: pytest.fail(
            "registry read must follow organization deny"
        ),
    )
    monkeypatch.setattr(
        sketch_visual_gate,
        "_resolve_gate_backend",
        lambda: pytest.fail("provider env must not be read"),
    )

    with pytest.raises(runtime.ModelGatewayEgressError) as excinfo:
        await sketch_visual_gate.gate_candidate_cells(
            project_dir=tmp_path,
            summary_path=summary_path,
            defs_db=object(),
            egress_context=_organization_context(),
        )

    assert excinfo.value.code == "ORG_EGRESS_DENIED"


def test_c1_eg04b_deny_uses_bound_context_when_leaf_has_no_explicit_argument(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from novelvideo import model_gateway_runtime as runtime
    from novelvideo.verification import sketch_visual_gate

    monkeypatch.setattr(
        sketch_visual_gate,
        "_resolve_gate_backend",
        lambda: pytest.fail("organization direct gate must not read provider env"),
    )
    with runtime.model_gateway_request_scope(_organization_context()):
        with pytest.raises(runtime.ModelGatewayEgressError) as excinfo:
            sketch_visual_gate.resolve_gate_backend_for_context(None)

    assert excinfo.value.code == "ORG_EGRESS_DENIED"


def test_c1_eg04b_platform_keeps_direct_backend_resolution(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from novelvideo.verification import sketch_visual_gate

    monkeypatch.setenv("SKETCH_GATE_PROVIDER", "openrouter")
    monkeypatch.setenv("SKETCH_GATE_API_KEY", "sk-platform-gate")
    monkeypatch.setenv("SKETCH_GATE_MODEL", "platform-vlm")

    assert sketch_visual_gate.resolve_gate_backend_for_context(_platform_context()) == (
        "openrouter",
        "sk-platform-gate",
        "platform-vlm",
    )


def test_c1_eg02_and_eg03_calling_leaves_declare_capability() -> None:
    expected = {
        "src/novelvideo/agents/content_rewriter.py": "text.generate",
        "src/novelvideo/agents/asset_compiler.py": "text.generate.agent",
        "src/novelvideo/workflows/literal_script_writing.py": "text.generate.workflow",
    }
    for relative_path, capability in expected.items():
        tree = ast.parse(Path(relative_path).read_text(encoding="utf-8"))
        calls = [
            node
            for node in ast.walk(tree)
            if isinstance(node, ast.Call)
            and isinstance(node.func, ast.Name)
            and node.func.id == "get_newapi_text_pydantic_model"
        ]
        assert calls, relative_path
        for call in calls:
            keyword = next(
                (item for item in call.keywords if item.arg == "capability"),
                None,
            )
            assert keyword is not None, relative_path
            assert isinstance(keyword.value, ast.Constant)
            assert keyword.value.value == capability


def test_c1_eg03_seedance_composer_leaf_declares_workflow_capability() -> None:
    source = Path("src/novelvideo/seedance2_i2v/prompt.py").read_text(encoding="utf-8")
    tree = ast.parse(source)
    composer = next(
        node
        for node in tree.body
        if isinstance(node, ast.FunctionDef)
        and node.name == "create_seedance2_prompt_composer_agent"
    )
    calls = [
        node
        for node in ast.walk(composer)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Name)
        and node.func.id == "get_newapi_text_pydantic_model"
    ]

    assert len(calls) == 1
    capability = next(
        (keyword.value for keyword in calls[0].keywords if keyword.arg == "capability"),
        None,
    )
    assert isinstance(capability, ast.Constant)
    assert capability.value == "text.generate.workflow"


def test_runner_scope_consumes_only_trusted_envelope_identity() -> None:
    from novelvideo import model_gateway_runtime as runtime

    context = _organization_context()
    envelope = TrustedRunnerEnvelope({TRUSTED_EGRESS_CONTEXT_KEY: context})

    with runtime.model_gateway_scope_for_runner(envelope):
        assert runtime.current_model_gateway_context() is context
    assert runtime.current_model_gateway_context() is None

    with pytest.raises(TypeError):
        with runtime.model_gateway_scope_for_runner(
            {TRUSTED_EGRESS_CONTEXT_KEY: context}
        ):
            pass


def test_c1_eg03_script_runner_binds_gateway_scope_before_workflow() -> None:
    source = Path("src/novelvideo/task_backend/runners/script.py").read_text(
        encoding="utf-8"
    )
    tree = ast.parse(source)
    functions = {
        node.name: node
        for node in tree.body
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
    }
    wrapper = functions.get("_run_script_writer")
    assert wrapper is not None
    calls = [
        node
        for node in ast.walk(wrapper)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Name)
        and node.func.id == "model_gateway_scope_for_runner"
    ]
    assert len(calls) == 1


@pytest.mark.parametrize(
    ("relative_path", "function_name"),
    [
        ("src/novelvideo/task_backend/runners/identity.py", "run_identity_planner"),
        (
            "src/novelvideo/task_backend/runners/episode_assets.py",
            "run_episode_asset_planner",
        ),
        ("src/novelvideo/task_backend/runners/ingest.py", "run_ingest_fast"),
        ("src/novelvideo/task_backend/runners/graph_build.py", "_run_async"),
    ],
)
def test_agent_and_cognee_runners_bind_trusted_gateway_scope(
    relative_path: str,
    function_name: str,
) -> None:
    tree = ast.parse(Path(relative_path).read_text(encoding="utf-8"))
    function = next(
        node
        for node in tree.body
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
        and node.name == function_name
    )
    calls = [
        node
        for node in ast.walk(function)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Name)
        and node.func.id == "model_gateway_scope_for_runner"
    ]
    assert len(calls) == 1, relative_path


@pytest.mark.asyncio
async def test_c1_eg05_pos_embedding_claims_before_single_transport(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from novelvideo import model_gateway_runtime as runtime
    from novelvideo.cognee import config as cognee_config
    from novelvideo.embedding_models import (
        COGNEE_EMBEDDING_MODEL_V2,
        embedding_model_scope,
    )

    operation_port = _OperationPort()
    credential = RequestCredential(
        reference=_organization_context().credential,
        api_key="sk-embedding-request",
        base_url="https://gateway.example/v1",
    )
    credential_port = _CredentialPort(credential, [])
    transport_calls: list[dict[str, object]] = []

    async def transport(*_args, **kwargs):
        transport_calls.append(kwargs)
        return "embedding-response"

    monkeypatch.setattr(runtime, "get_egress_operation_port", lambda: operation_port)
    monkeypatch.setattr(runtime, "get_model_credentials", lambda: credential_port)
    monkeypatch.setattr(
        cognee_config,
        "embedding_gateway_credentials",
        lambda *_args, **_kwargs: pytest.fail(
            "organization embedding must not read settings/env"
        ),
    )

    with runtime.model_gateway_request_scope(_organization_context()):
        with embedding_model_scope(COGNEE_EMBEDDING_MODEL_V2):
            result = await cognee_config._route_project_embedding_transport(
                transport,
                (),
                {"input": ["hello"], "model": "stale-model"},
            )

    assert result == "embedding-response"
    assert len(transport_calls) == 1
    assert transport_calls[0]["api_key"] == "sk-embedding-request"
    assert transport_calls[0]["api_base"] == "https://gateway.example/v1"
    assert operation_port.calls[0][1].capability == "embedding.generate"


@pytest.mark.asyncio
async def test_c1_eg05_nofb_embedding_resolve_error_has_zero_transport(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from novelvideo import model_gateway_runtime as runtime
    from novelvideo.cognee import config as cognee_config
    from novelvideo.embedding_models import (
        COGNEE_EMBEDDING_MODEL_V2,
        embedding_model_scope,
    )

    operation_port = _OperationPort()
    credential_port = _CredentialPort(
        ModelCredentialError("ORG_CREDENTIAL_MISSING"), []
    )
    transport_calls = 0

    async def transport(*_args, **_kwargs):
        nonlocal transport_calls
        transport_calls += 1

    monkeypatch.setenv("OPENAI_API_KEY", "sk-stale-platform")
    monkeypatch.setenv("EMBEDDING_API_KEY", "sk-stale-embedding")
    monkeypatch.setattr(runtime, "get_egress_operation_port", lambda: operation_port)
    monkeypatch.setattr(runtime, "get_model_credentials", lambda: credential_port)
    monkeypatch.setattr(
        cognee_config,
        "embedding_gateway_credentials",
        lambda *_args, **_kwargs: pytest.fail(
            "organization embedding must not read settings/env"
        ),
    )

    with runtime.model_gateway_request_scope(_organization_context()):
        with embedding_model_scope(COGNEE_EMBEDDING_MODEL_V2):
            with pytest.raises(ModelCredentialError) as excinfo:
                await cognee_config._route_project_embedding_transport(
                    transport,
                    (),
                    {"input": ["hello"]},
                )

    assert excinfo.value.code == "ORG_CREDENTIAL_MISSING"
    assert transport_calls == 0
    assert [name for name, _payload in operation_port.calls] == ["claim", "rejected"]


@pytest.mark.asyncio
async def test_c1_eg06_pos_cognee_llm_uses_request_key_without_env_mutation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from novelvideo import model_gateway_runtime as runtime
    from novelvideo.cognee import config as cognee_config

    class OperationPort(_OperationPort):
        async def claim(self, *, spec):
            result = await super().claim(spec=spec)
            operation_id = f"operation-{spec.organization_id}"
            return OperationClaimResult(
                won=True,
                operation=OperationSnapshot(
                    operation_id=operation_id,
                    operation_key=result.operation.operation_key,
                    state=OperationState.DISPATCHING,
                    version=1,
                ),
                transition_token=f"transition-{spec.organization_id}",
            )

    class CredentialPort:
        async def resolve(self, admission):
            return RequestCredential(
                reference=admission.credential,
                api_key=f"sk-{admission.billing_principal.id}",
                base_url=f"https://{admission.billing_principal.id}.example/v1",
            )

    calls: list[tuple[str, str, int]] = []

    async def transport(*_args, **kwargs):
        calls.append((kwargs["api_key"], kwargs["api_base"], kwargs["max_retries"]))
        await asyncio.sleep(0)
        return {"id": kwargs["api_key"]}

    import asyncio
    import os

    operation_port = OperationPort()
    monkeypatch.setattr(runtime, "get_egress_operation_port", lambda: operation_port)
    monkeypatch.setattr(runtime, "get_model_credentials", lambda: CredentialPort())
    environment_before = dict(os.environ)

    async def run(context: TrustedEgressContext):
        with runtime.model_gateway_request_scope(context):
            return await cognee_config._route_cognee_llm_transport(
                transport,
                (),
                {
                    "model": "openai/DC-cognee-LLM",
                    "messages": [{"role": "user", "content": context.project_id}],
                    "api_key": "sk-stale-platform",
                    "api_base": "https://stale.example/v1",
                    "max_retries": 5,
                },
            )

    first, second = await asyncio.gather(
        run(_organization_context(envelope_id="envelope-a", org_id="org-a")),
        run(_organization_context(envelope_id="envelope-b", org_id="org-b")),
    )

    assert first == {"id": "sk-org-a"}
    assert second == {"id": "sk-org-b"}
    assert sorted(calls) == [
        ("sk-org-a", "https://org-a.example/v1", 0),
        ("sk-org-b", "https://org-b.example/v1", 0),
    ]
    assert dict(os.environ) == environment_before


def test_c1_eg06_env_isolation_init_skips_all_credential_env_bridges(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import os

    from novelvideo import model_gateway_runtime as runtime
    from novelvideo.cognee import config as cognee_config

    monkeypatch.setattr(cognee_config, "COGNEE_AVAILABLE", True)
    monkeypatch.setattr(cognee_config, "cognee_gateway_restart_required", lambda: False)
    monkeypatch.setattr(
        cognee_config,
        "_apply_llm_env",
        lambda *_args, **_kwargs: pytest.fail(
            "organization task must not mutate LLM env"
        ),
    )
    monkeypatch.setattr(
        cognee_config,
        "_apply_embedding_env",
        lambda *_args, **_kwargs: pytest.fail(
            "organization task must not mutate embedding env"
        ),
    )
    environment_before = dict(os.environ)

    with runtime.model_gateway_request_scope(_organization_context()):
        cognee_config.init_cognee()

    assert dict(os.environ) == environment_before


def test_organization_disables_pydantic_output_retries() -> None:
    from novelvideo import model_gateway_runtime as runtime

    assert runtime.model_gateway_output_retries(3) == 3
    with runtime.model_gateway_request_scope(_platform_context()):
        assert runtime.model_gateway_output_retries(3) == 3
    with runtime.model_gateway_request_scope(_organization_context()):
        assert runtime.model_gateway_output_retries(3) == 0


def test_freezone_org_agent_is_never_saved_in_module_singleton(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from novelvideo import model_gateway_runtime as runtime
    from novelvideo.freezone import text_node

    created: list[object] = []

    def create():
        agent = object()
        created.append(agent)
        return agent

    monkeypatch.setattr(text_node, "_translation_agent", None)
    monkeypatch.setattr(text_node, "create_freezone_translation_agent", create)

    with runtime.model_gateway_request_scope(_organization_context()):
        first = text_node.get_freezone_translation_agent()
        second = text_node.get_freezone_translation_agent()

    assert first is not second
    assert text_node._translation_agent is None
    assert created == [first, second]


def test_all_agent_and_cognee_newapi_leaves_declare_capability() -> None:
    roots = {
        Path("src/novelvideo/agents"): "text.generate.agent",
        Path("src/novelvideo/cognee"): "cognee.llm",
    }
    exceptions = {
        Path("src/novelvideo/agents/content_rewriter.py"): "text.generate",
    }
    for root, default_capability in roots.items():
        for path in root.glob("*.py"):
            tree = ast.parse(path.read_text(encoding="utf-8"))
            capability = exceptions.get(path, default_capability)
            calls = [
                node
                for node in ast.walk(tree)
                if isinstance(node, ast.Call)
                and isinstance(node.func, ast.Name)
                and node.func.id == "get_newapi_text_pydantic_model"
            ]
            for call in calls:
                keyword = next(
                    (item for item in call.keywords if item.arg == "capability"),
                    None,
                )
                assert keyword is not None, str(path)
                assert isinstance(keyword.value, ast.Constant), str(path)
                assert keyword.value.value == capability, str(path)


def test_legacy_agent_factory_forwards_explicit_agent_capability(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from novelvideo import config

    captured: dict[str, object] = {}

    def fake_factory(*_args, **kwargs):
        captured.update(kwargs)
        return object()

    monkeypatch.setattr(config, "get_newapi_text_pydantic_model", fake_factory)

    config.get_pydantic_model(model_name_override="DC-agent")

    assert captured["capability"] == "text.generate.agent"
