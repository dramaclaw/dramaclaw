"""CE cache invalidation helpers for dynamic model gateway settings."""

from __future__ import annotations

import hashlib
import sys
from contextlib import asynccontextmanager, contextmanager
from contextvars import ContextVar
from typing import Any, Awaitable, Callable, Iterator, TypeVar

from novelvideo.model_gateway_settings import get_effective_newapi_config
from novelvideo.egress_context import (
    TRUSTED_EGRESS_CONTEXT_KEY,
    TrustedEgressContext,
    TrustedRunnerEnvelope,
)
from novelvideo.ports import get_egress_operation_port, get_model_credentials
from novelvideo.ports.authz import AdmissionContext
from novelvideo.ports.egress_operations import OperationSpec, canonical_request_digest
from novelvideo.ports.model_credentials import RequestCredential
from novelvideo.shared.runtime_env import is_ce_effective

_T = TypeVar("_T")
_MODEL_GATEWAY_CONTEXT: ContextVar[TrustedEgressContext | None] = ContextVar(
    "novelvideo_model_gateway_context",
    default=None,
)
_MODEL_GATEWAY_SUBMIT_SEQUENCE: ContextVar[int] = ContextVar(
    "novelvideo_model_gateway_submit_sequence",
    default=0,
)

_EGRESS_ERROR_MESSAGES = {
    "EGRESS_OPERATION_REPLAYED": "egress operation cannot be replayed",
    "ORG_EGRESS_DENIED": "organization direct egress is denied",
}


class ModelGatewayEgressError(RuntimeError):
    """Stable, secret-free model egress failure."""

    def __init__(self, code: str) -> None:
        super().__init__(_EGRESS_ERROR_MESSAGES.get(code, "model egress failed"))
        self.code = code


def current_model_gateway_context() -> TrustedEgressContext | None:
    """Return only the trusted identity bound to the current request."""

    return _MODEL_GATEWAY_CONTEXT.get()


def model_gateway_output_retries(platform_retries: int) -> int:
    """Disable PydanticAI retry submits for organization operations."""

    context = current_model_gateway_context()
    return 0 if context is not None and context.is_organization else platform_retries


@contextmanager
def model_gateway_request_scope(
    context: TrustedEgressContext | None,
) -> Iterator[None]:
    """Bind trusted identity without resolving or retaining a plaintext key."""

    if context is not None and type(context) is not TrustedEgressContext:
        raise TypeError("context must be a TrustedEgressContext or None")
    token = _MODEL_GATEWAY_CONTEXT.set(context)
    sequence_token = _MODEL_GATEWAY_SUBMIT_SEQUENCE.set(0)
    try:
        yield
    finally:
        _MODEL_GATEWAY_SUBMIT_SEQUENCE.reset(sequence_token)
        _MODEL_GATEWAY_CONTEXT.reset(token)


@contextmanager
def model_gateway_scope_for_runner(envelope: dict[str, Any]) -> Iterator[None]:
    """Bind identity only when it came from the verified runner envelope."""

    if type(envelope) is TrustedRunnerEnvelope:
        context = envelope.get(TRUSTED_EGRESS_CONTEXT_KEY)
        if type(context) is not TrustedEgressContext:
            raise TypeError("trusted runner envelope requires trusted egress context")
    elif type(envelope) is dict and TRUSTED_EGRESS_CONTEXT_KEY not in envelope:
        context = None
    else:
        raise TypeError("untrusted runner envelope cannot provide egress context")
    with model_gateway_request_scope(context):
        yield


def next_model_gateway_business_task_id(capability: str) -> str:
    context = current_model_gateway_context()
    if context is None:
        raise ModelGatewayEgressError("ORG_EGRESS_DENIED")
    sequence = _MODEL_GATEWAY_SUBMIT_SEQUENCE.get() + 1
    _MODEL_GATEWAY_SUBMIT_SEQUENCE.set(sequence)
    return f"{context.envelope_id}:{capability}:{sequence:06d}"


def _without_volatile_transport_fields(value: Any) -> Any:
    if type(value) is dict:
        return {
            key: _without_volatile_transport_fields(item)
            for key, item in value.items()
            if key not in {"timestamp", "run_id", "conversation_id"}
        }
    if type(value) is list:
        return [_without_volatile_transport_fields(item) for item in value]
    return value


def canonical_model_transport_digest(
    *,
    model_name: str,
    messages: object,
    model_settings: object,
    model_request_parameters: object,
) -> str:
    """Digest the canonical transport request without persisting its contents."""

    from pydantic_core import to_jsonable_python

    payload = to_jsonable_python(
        {
            "model": model_name,
            "messages": messages,
            "model_settings": model_settings,
            "model_request_parameters": model_request_parameters,
        },
        bytes_mode="base64",
    )
    return canonical_request_digest(_without_volatile_transport_fields(payload))


def create_request_scoped_gateway_model(
    *,
    model_name: str,
    capability: str,
    timeout_seconds: float,
    profile: Any,
    delegate_factory: Callable[..., Any],
    platform_credential_factory: Callable[[], tuple[str, str]],
):
    """Create a stateless model facade that resolves credentials per submit."""

    from pydantic_ai.models import Model

    class _RequestScopedGatewayModel(Model):
        def __init__(self) -> None:
            super().__init__(profile=profile)

        @property
        def model_name(self) -> str:
            return model_name

        @property
        def system(self) -> str:
            return "openai"

        @property
        def provider(self) -> None:
            return None

        def _delegate(self, credential: RequestCredential):
            return delegate_factory(
                model_name,
                api_key=credential.api_key,
                base_url=credential.base_url,
                timeout_seconds=timeout_seconds,
                profile=profile,
            )

        async def request(
            self,
            messages,
            model_settings,
            model_request_parameters,
        ):
            context = current_model_gateway_context()
            if context is not None and context.is_organization:
                business_task_id = next_model_gateway_business_task_id(capability)
                request_digest = canonical_model_transport_digest(
                    model_name=model_name,
                    messages=messages,
                    model_settings=model_settings,
                    model_request_parameters=model_request_parameters,
                )

                async def submit(credential: RequestCredential):
                    return await self._delegate(credential).request(
                        messages,
                        model_settings,
                        model_request_parameters,
                    )

                return await execute_organization_gateway_request(
                    capability=capability,
                    business_task_id=business_task_id,
                    request_digest=request_digest,
                    submit=submit,
                )

            api_key, base_url = platform_credential_factory()
            if not api_key or not base_url:
                raise ValueError("API key not set. Configure DramaClawAPI credentials.")
            credential = RequestCredential(
                reference=(
                    context.credential if context is not None else _platform_reference()
                ),
                api_key=api_key,
                base_url=base_url,
            )
            return await self._delegate(credential).request(
                messages,
                model_settings,
                model_request_parameters,
            )

        @asynccontextmanager
        async def request_stream(
            self,
            messages,
            model_settings,
            model_request_parameters,
        ):
            context = current_model_gateway_context()
            if context is not None and context.is_organization:
                business_task_id = next_model_gateway_business_task_id(capability)
                request_digest = canonical_model_transport_digest(
                    model_name=model_name,
                    messages=messages,
                    model_settings=model_settings,
                    model_request_parameters=model_request_parameters,
                )

                def stream_factory(credential: RequestCredential):
                    return self._delegate(credential).request_stream(
                        messages,
                        model_settings,
                        model_request_parameters,
                    )

                async with execute_organization_gateway_stream(
                    capability=capability,
                    business_task_id=business_task_id,
                    request_digest=request_digest,
                    stream_factory=stream_factory,
                ) as response:
                    yield response
                return

            api_key, base_url = platform_credential_factory()
            if not api_key or not base_url:
                raise ValueError("API key not set. Configure DramaClawAPI credentials.")
            credential = RequestCredential(
                reference=(
                    context.credential if context is not None else _platform_reference()
                ),
                api_key=api_key,
                base_url=base_url,
            )
            async with self._delegate(credential).request_stream(
                messages,
                model_settings,
                model_request_parameters,
            ) as response:
                yield response

    return _RequestScopedGatewayModel()


def _platform_reference():
    from novelvideo.ports.model_credentials import CredentialReference

    return CredentialReference(
        source="platform",
        credential_id="platform-newapi",
        key_version=1,
    )


def _organization_admission(context: TrustedEgressContext) -> AdmissionContext:
    return AdmissionContext(
        requester_user_id=context.requester_user_id,
        billing_principal=context.billing_principal,
        credential=context.credential,
        admission_id=context.admission_id,
        root_task_id=context.root_task_id,
        admitted_at=context.admitted_at,
        membership_id=context.membership_id,
        authz_version=context.authz_version,
    )


async def execute_organization_gateway_request(
    *,
    capability: str,
    business_task_id: str,
    request_digest: str,
    submit: Callable[[RequestCredential], Awaitable[_T]],
) -> _T:
    """Claim, resolve and perform exactly one organization transport submit."""

    context = current_model_gateway_context()
    if context is None or not context.is_organization:
        raise ModelGatewayEgressError("ORG_EGRESS_DENIED")
    for value, field_name in (
        (capability, "capability"),
        (business_task_id, "business_task_id"),
        (request_digest, "request_digest"),
    ):
        if type(value) is not str or not value.strip():
            raise ValueError(f"{field_name} is required")

    operation_port = get_egress_operation_port()
    claim = await operation_port.claim(
        spec=OperationSpec(
            organization_id=context.billing_principal.id,
            project_id=context.project_id,
            root_task_id=context.root_task_id,
            business_task_id=business_task_id,
            capability=capability,
            credential_id=context.credential.credential_id,
            credential_version=context.credential.key_version,
            request_digest=request_digest,
        )
    )
    if not claim.won:
        raise ModelGatewayEgressError("EGRESS_OPERATION_REPLAYED")

    operation = claim.operation
    transition_token = claim.transition_token
    assert transition_token is not None
    try:
        credential = await get_model_credentials().resolve(
            _organization_admission(context)
        )
    except BaseException:
        await operation_port.mark_rejected_before_submit(
            operation_id=operation.operation_id,
            transition_token=transition_token,
            expected_version=operation.version,
        )
        raise

    try:
        result = await submit(credential)
    except BaseException:
        await operation_port.mark_unknown(
            operation_id=operation.operation_id,
            transition_token=transition_token,
            expected_version=operation.version,
        )
        raise

    accepted = await operation_port.mark_accepted(
        operation_id=operation.operation_id,
        transition_token=transition_token,
        expected_version=operation.version,
        provider_job_id=operation.operation_id,
    )
    await operation_port.mark_completed(
        operation_id=operation.operation_id,
        transition_token=transition_token,
        expected_version=accepted.version,
        result_ref=operation.operation_id,
    )
    return result


@asynccontextmanager
async def execute_organization_gateway_stream(
    *,
    capability: str,
    business_task_id: str,
    request_digest: str,
    stream_factory: Callable[[RequestCredential], Any],
):
    """Run one claimed organization stream and transition it after consumption."""

    context = current_model_gateway_context()
    if context is None or not context.is_organization:
        raise ModelGatewayEgressError("ORG_EGRESS_DENIED")
    for value, field_name in (
        (capability, "capability"),
        (business_task_id, "business_task_id"),
        (request_digest, "request_digest"),
    ):
        if type(value) is not str or not value.strip():
            raise ValueError(f"{field_name} is required")

    operation_port = get_egress_operation_port()
    claim = await operation_port.claim(
        spec=OperationSpec(
            organization_id=context.billing_principal.id,
            project_id=context.project_id,
            root_task_id=context.root_task_id,
            business_task_id=business_task_id,
            capability=capability,
            credential_id=context.credential.credential_id,
            credential_version=context.credential.key_version,
            request_digest=request_digest,
        )
    )
    if not claim.won:
        raise ModelGatewayEgressError("EGRESS_OPERATION_REPLAYED")

    operation = claim.operation
    transition_token = claim.transition_token
    assert transition_token is not None
    try:
        credential = await get_model_credentials().resolve(
            _organization_admission(context)
        )
    except BaseException:
        await operation_port.mark_rejected_before_submit(
            operation_id=operation.operation_id,
            transition_token=transition_token,
            expected_version=operation.version,
        )
        raise

    accepted = None
    try:
        async with stream_factory(credential) as response:
            accepted = await operation_port.mark_accepted(
                operation_id=operation.operation_id,
                transition_token=transition_token,
                expected_version=operation.version,
                provider_job_id=operation.operation_id,
            )
            try:
                yield response
            except BaseException:
                await operation_port.mark_unknown(
                    operation_id=operation.operation_id,
                    transition_token=transition_token,
                    expected_version=accepted.version,
                )
                raise
    except BaseException:
        if accepted is None:
            await operation_port.mark_unknown(
                operation_id=operation.operation_id,
                transition_token=transition_token,
                expected_version=operation.version,
            )
        raise

    await operation_port.mark_completed(
        operation_id=operation.operation_id,
        transition_token=transition_token,
        expected_version=accepted.version,
        result_ref=operation.operation_id,
    )


def _runtime_version(api_key: str, base_url: str) -> str:
    material = f"{base_url}\n{api_key}".encode("utf-8")
    return hashlib.sha256(material).hexdigest()[:16]


def _clear_agent_singletons() -> list[str]:
    cleared: list[str] = []
    targets = {
        "novelvideo.freezone.text_node": (
            "_translation_agent",
            "_story_script_agent",
            "_video_story_script_agent",
        ),
        "novelvideo.agents.global_video_optimizer": ("_global_video_optimizer",),
    }
    for module_name, attrs in targets.items():
        module = sys.modules.get(module_name)
        if module is None:
            continue
        for attr in attrs:
            if hasattr(module, attr):
                setattr(module, attr, None)
                cleared.append(f"{module_name}.{attr}")
    return cleared


def _cognee_runtime_status() -> str:
    module = sys.modules.get("novelvideo.cognee.config")
    if module is None:
        return "not_loaded"
    restart_required = getattr(module, "cognee_gateway_restart_required", None)
    if callable(restart_required) and restart_required():
        return "restart_required"
    return "ready"


def refresh_model_gateway_runtime() -> dict[str, Any]:
    """Invalidate CE caches after a model gateway settings.db write.

    Dynamic CE settings are never copied into process environment variables.
    Cognee is process-global and must be restarted after its active gateway
    changes; Hermes performs its own worker fingerprint rotation.
    """

    if not is_ce_effective():
        raise RuntimeError("model gateway runtime refresh is only available in CE")

    from novelvideo import config as app_config

    gateway = get_effective_newapi_config(
        official_base_url=app_config.OFFICIAL_NEWAPI_BASE_URL,
        official_api_key=app_config.NEWAPI_API_KEY,
    )
    api_key = str(gateway.api_key or "").strip()
    base_url = str(gateway.base_url or "").strip().rstrip("/")
    version = _runtime_version(api_key, base_url)

    cleared = _clear_agent_singletons()

    return {
        "mode": gateway.mode,
        "source": gateway.source,
        "configured": bool(api_key and base_url),
        "runtimeVersion": version,
        "clearedCaches": cleared,
        "cognee": _cognee_runtime_status(),
    }
