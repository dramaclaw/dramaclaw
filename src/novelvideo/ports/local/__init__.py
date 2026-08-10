"""Local CE port registration."""

from __future__ import annotations

from datetime import datetime, timezone
from uuid import uuid4

from novelvideo.ports.authz import (
    AdmissionContext,
    AuthzError,
    AuthzSnapshot,
    BillingPrincipal,
)
from novelvideo.ports.egress import EgressClaim, EgressError, EgressResultReference
from novelvideo.ports.model_credentials import (
    CredentialReference,
    ModelCredentialError,
    RequestCredential,
)
from novelvideo.ports.local.audit import NoOpAuditSink
from novelvideo.ports.local.auth import FileAuthPort, LocalAuthSession
from novelvideo.ports.local.credit_quote import LocalCreditQuote
from novelvideo.ports.local.lifecycle import NoOpLifecycle
from novelvideo.ports.local.project import AllowAllProjectAccess, SQLiteProjectRegistry
from novelvideo.ports.local.release_feed import LocalReleaseFeed
from novelvideo.ports.local.tasks import InlineTaskBackend, InMemoryCancellationStore
from novelvideo.ports.local.usage import NoOpProviderInstrumentation, NoOpUsageMeter
from novelvideo.ports.product_surface_access import LocalProductSurfaceAccess
from novelvideo.ports.registry import get_port, register_port
from novelvideo.task_backend.producer import TaskEnvelopeProducer
from novelvideo.task_backend.consumer import TaskEnvelopeConsumer
from novelvideo.task_backend.signing import load_or_create_local_signing_config


class LocalModelCredentials:
    async def resolve(self, admission) -> RequestCredential:
        if admission.credential.source != "local":
            raise ModelCredentialError(
                "ORG_CREDENTIAL_MISSING",
                "organization credentials require the control plane resolver",
            )
        from novelvideo.config import get_newapi_runtime_credentials

        api_key, base_url = get_newapi_runtime_credentials()
        return RequestCredential(
            reference=admission.credential,
            api_key=api_key,
            base_url=base_url,
        )


class LocalAuthz:
    async def snapshot(self, *, user_id: str) -> AuthzSnapshot:
        raise AuthzError("ORG_CONTEXT_REQUIRED")

    async def check(
        self,
        *,
        snapshot: AuthzSnapshot,
        expected_authz_version: int | None = None,
    ) -> None:
        raise AuthzError("ORG_CONTEXT_REQUIRED")

    async def admit_model_task(
        self, *, user_id: str, root_task_id: str
    ) -> AdmissionContext:
        return AdmissionContext(
            requester_user_id=user_id,
            billing_principal=BillingPrincipal(kind="local", id=user_id),
            credential=CredentialReference(
                source="local",
                credential_id="local-newapi",
                key_version=1,
            ),
            admission_id=f"local-{uuid4().hex}",
            root_task_id=root_task_id,
            admitted_at=datetime.now(timezone.utc).isoformat(),
            authz_version=1,
        )


class LocalEgress:
    async def claim(self, *, admission, spec) -> EgressClaim:
        self._require_local(admission)
        return EgressClaim(
            operation_id=spec.operation_id,
            attempt_id=f"local-{uuid4().hex}",
            status="claimed",
            claim_deadline="local",
        )

    async def consume(
        self,
        *,
        admission,
        result: EgressResultReference,
    ) -> EgressResultReference:
        self._require_local(admission)
        return result

    async def record_success(self, *, claim, result) -> None:
        return None

    @staticmethod
    def _require_local(admission) -> None:
        if (
            admission.billing_principal.kind != "local"
            or admission.credential.source != "local"
        ):
            raise EgressError("ORG_CONTEXT_REQUIRED")


def register_local_ports() -> None:
    authz = LocalAuthz()
    signing_config = load_or_create_local_signing_config()
    producer = TaskEnvelopeProducer(
        authz=authz,
        active_key_id=signing_config.active_key_id,
        keyring=signing_config.keyring,
        clock=lambda: datetime.now(timezone.utc),
        envelope_id_factory=lambda: uuid4().hex,
    )
    consumer = TaskEnvelopeConsumer(
        keyring=signing_config.keyring,
        authz=authz,
        clock=lambda: datetime.now(timezone.utc),
    )
    task_backend = InlineTaskBackend(producer=producer, consumer=consumer)
    ports = (
        ("auth", FileAuthPort()),
        ("auth_session", LocalAuthSession()),
        ("project_registry", SQLiteProjectRegistry()),
        ("project_access", AllowAllProjectAccess()),
        ("usage_meter", NoOpUsageMeter()),
        ("provider_instrumentation", NoOpProviderInstrumentation()),
        ("credit_quote", LocalCreditQuote()),
        ("task_backend", task_backend),
        ("task_envelope_consumer", consumer),
        ("cancellation_store", InMemoryCancellationStore()),
        ("audit_sink", NoOpAuditSink()),
        ("lifecycle", NoOpLifecycle()),
        ("release_feed", LocalReleaseFeed()),
        ("product_surface_access", LocalProductSurfaceAccess()),
        ("model_credentials", LocalModelCredentials()),
        ("authz", authz),
        ("egress", LocalEgress()),
    )
    for name, port in ports:
        register_port(name, port)
    get_port("provider_instrumentation").install()
