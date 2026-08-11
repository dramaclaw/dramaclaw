"""Request-local authorization for credentialed Hermes workers."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from novelvideo.egress_context import TrustedEgressContext
from novelvideo.ports.authz import AdmissionContext, BillingPrincipal
from novelvideo.ports.egress_operations import (
    OperationClaimResult,
    OperationSnapshot,
    HandleKind,
    OperationSpec,
    OperationState,
    canonical_request_digest,
)
from novelvideo.ports.model_credentials import CredentialReference, RequestCredential
from novelvideo.task_backend.subprocesses import EgressBoundaryError


@dataclass(frozen=True, slots=True)
class HermesLaunchAuthorization:
    """Secret-bearing authorization kept only for one child launch."""

    context: TrustedEgressContext
    credential: RequestCredential
    claim: OperationClaimResult

    @classmethod
    def for_test(
        cls,
        *,
        context: TrustedEgressContext,
        credential: RequestCredential,
    ) -> "HermesLaunchAuthorization":
        snapshot = OperationSnapshot(
            operation_id="test-operation",
            operation_key="test-operation-key",
            state=OperationState.DISPATCHING,
            version=1,
        )
        return cls(
            context=context,
            credential=credential,
            claim=OperationClaimResult(
                won=True,
                operation=snapshot,
                transition_token="test-transition",
            ),
        )


def _strict_admission(
    context: TrustedEgressContext,
    *,
    username: str,
    project_id: str,
) -> AdmissionContext:
    if type(context) is not TrustedEgressContext:
        raise EgressBoundaryError("TASK_ENVELOPE_INVALID")
    if context.requester_user_id != username or context.project_id != project_id:
        raise EgressBoundaryError("TASK_ENVELOPE_INVALID")
    if type(context.billing_principal) is not BillingPrincipal:
        raise EgressBoundaryError("TASK_ENVELOPE_INVALID")
    if type(context.credential) is not CredentialReference:
        raise EgressBoundaryError("TASK_ENVELOPE_INVALID")
    try:
        return AdmissionContext(
            requester_user_id=context.requester_user_id,
            billing_principal=context.billing_principal,
            credential=context.credential,
            admission_id=context.admission_id,
            root_task_id=context.root_task_id,
            admitted_at="verified-task-delivery",
            membership_id=context.membership_id,
            authz_version=context.authz_version,
        )
    except (TypeError, ValueError):
        raise EgressBoundaryError("TASK_ENVELOPE_INVALID") from None


async def authorize_credentialed_hermes(
    *,
    context: TrustedEgressContext,
    username: str,
    project_id: str,
    prompt: str,
    credential_resolver: Any,
    operation_port: Any,
) -> HermesLaunchAuthorization:
    """Claim the operation, then resolve the exact frozen Gateway reference."""

    admission = _strict_admission(context, username=username, project_id=project_id)
    credential = context.credential
    organization_id = credential.org_id or context.billing_principal.id
    spec = OperationSpec(
        organization_id=organization_id,
        project_id=context.project_id,
        root_task_id=context.root_task_id,
        business_task_id=context.envelope_id,
        capability="agent.hermes.text",
        credential_id=credential.credential_id,
        credential_version=credential.key_version,
        request_digest=canonical_request_digest({"prompt": prompt}),
        handle_kind=HandleKind.NONE,
    )
    claim = await operation_port.claim(spec=spec)
    if type(claim) is not OperationClaimResult or not claim.won:
        raise EgressBoundaryError("EGRESS_OPERATION_NOT_RESTARTED")
    try:
        resolved = await credential_resolver.resolve(admission)
    except Exception:
        try:
            await operation_port.mark_rejected_before_submit(
                operation_id=claim.operation.operation_id,
                transition_token=str(claim.transition_token),
                expected_version=claim.operation.version,
            )
        except Exception:
            pass
        raise EgressBoundaryError("ORG_CREDENTIAL_DECRYPT_FAILED") from None
    if type(resolved) is not RequestCredential or resolved.reference != credential:
        raise EgressBoundaryError("ORG_CREDENTIAL_VERSION_MISMATCH")
    return HermesLaunchAuthorization(context=context, credential=resolved, claim=claim)


def build_hermes_child_env(
    *,
    home: Path,
    username: str,
    api_url: str,
    agent_token_env: dict[str, str],
    project_id: str | None,
    project_env: dict[str, str] | None,
    authorization: HermesLaunchAuthorization,
) -> dict[str, str]:
    """Build a minimal child env without consulting workspace/process credentials."""

    context = authorization.context
    _strict_admission(context, username=username, project_id=project_id or "")
    env = {
        "PATH": "/usr/local/bin:/usr/bin:/bin",
        "LANG": os.environ.get("LANG", "C.UTF-8"),
        "LC_ALL": os.environ.get("LC_ALL", "C.UTF-8"),
        "HOME": str(home),
        "HERMES_HOME": str(home),
        "TMPDIR": str(home / "tmp"),
        "DRAMACLAW_USER": username,
        "DRAMACLAW_API_URL": api_url,
        "NEWAPI_API_KEY": authorization.credential.api_key,
        "NEWAPI_BASE_URL": authorization.credential.base_url,
    }
    env.update(
        {
            key: value
            for key, value in agent_token_env.items()
            if key.startswith(("DRAMACLAW_AGENT_", "SUPERTALE_AGENT_"))
        }
    )
    if project_id:
        env["DRAMACLAW_PROJECT_ID"] = project_id
    env.update(
        {
            key: value
            for key, value in (project_env or {}).items()
            if key.startswith("DRAMACLAW_PROJECT_")
        }
    )
    return env


__all__ = [
    "EgressBoundaryError",
    "HermesLaunchAuthorization",
    "authorize_credentialed_hermes",
    "build_hermes_child_env",
]
