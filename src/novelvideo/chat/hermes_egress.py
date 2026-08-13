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

HOME_SCOPE_EGRESS_PROJECT_ID = "__home__"
"""home 态出网身份用的 project 哨兵值（本模块只定义，暂无产品代码消费）。

home 态的 chat 会话同时受两个互斥约束挤压：
`agent_sessions.current_project_id` 在 home 态必须是 NULL（EE 侧 agent_sessions
迁移上的 home-project-null CHECK），而 `TrustedEgressContext.project_id` 有非空
不变量（`egress_context.py` 的 `__post_init__` 必填字段循环）。同一个值满足不了
两边，所以出网身份与会话身份被拆成两个形参：会话侧继续传 `None`，出网侧传本哨兵。

写进账本是合法的：EE 侧的 egress_operations 迁移把 `project_id` 定义成 TEXT NOT NULL，
只校验 `btrim(...) <> ''`，**没有指向 projects 的外键**，所以哨兵不需要对应一条真实
project 记录。真实 project id 是 ULID（26 位 Crockford base32），取值域与本哨兵不相交。
"""


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
    requester_user_id: str,
    project_id: str,
) -> AdmissionContext:
    if type(context) is not TrustedEgressContext:
        raise EgressBoundaryError("TASK_ENVELOPE_INVALID")
    if (
        context.requester_user_id != requester_user_id
        or context.project_id != project_id
    ):
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
    requester_user_id: str,
    project_id: str,
    prompt: str,
    credential_resolver: Any,
    operation_port: Any,
) -> HermesLaunchAuthorization:
    """Claim the operation, then resolve the exact frozen Gateway reference.

    ``username`` is the login name and is kept for the caller's workspace/env
    plumbing; identity admission is decided by ``requester_user_id`` alone —
    the two are different values in this repo.
    """

    admission = _strict_admission(
        context, requester_user_id=requester_user_id, project_id=project_id
    )
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
    requester_user_id: str,
    api_url: str,
    agent_token_env: dict[str, str],
    project_id: str | None,
    egress_project_id: str,
    project_env: dict[str, str] | None,
    authorization: HermesLaunchAuthorization,
) -> dict[str, str]:
    """Build a minimal child env without consulting workspace/process credentials.

    ``project_id`` and ``egress_project_id`` are deliberately separate: the
    former is the session/project identity handed to the child process as
    ``DRAMACLAW_PROJECT_ID`` (absent in home scope), the latter is the identity
    compared against the trusted egress context. In home scope they differ.
    """

    context = authorization.context
    _strict_admission(
        context, requester_user_id=requester_user_id, project_id=egress_project_id
    )
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
    "HOME_SCOPE_EGRESS_PROJECT_ID",
    "EgressBoundaryError",
    "HermesLaunchAuthorization",
    "authorize_credentialed_hermes",
    "build_hermes_child_env",
]
