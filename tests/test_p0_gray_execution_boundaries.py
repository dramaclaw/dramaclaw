from __future__ import annotations

from pathlib import Path

import pytest

from novelvideo.egress_context import TrustedEgressContext
from novelvideo.ports.authz import BillingPrincipal
from novelvideo.ports.egress_operations import (
    OperationClaimResult,
    OperationSnapshot,
    OperationState,
)
from novelvideo.ports.model_credentials import CredentialReference, RequestCredential


def _context(*, kind: str = "organization") -> TrustedEgressContext:
    organization = kind == "organization"
    return TrustedEgressContext(
        envelope_id="envelope-1",
        project_id="project-1",
        task_type="chat",
        requester_user_id="user-1",
        root_task_id="root-1",
        admission_id="admission-1",
        membership_id="membership-1" if organization else None,
        authz_version=7,
        billing_principal=BillingPrincipal(
            kind=kind,
            id="org-1" if organization else "user-1",
        ),
        credential=CredentialReference(
            source=kind,
            credential_id="credential-1",
            key_version=3,
            org_id="org-1" if organization else None,
        ),
    )


class _Resolver:
    def __init__(self) -> None:
        self.admissions = []

    async def resolve(self, admission):
        self.admissions.append(admission)
        return RequestCredential(
            reference=admission.credential,
            api_key="gw-request-secret",
            base_url="https://gateway.example/v1",
        )


class _Operations:
    def __init__(
        self, *, won: bool = True, state: OperationState = OperationState.DISPATCHING
    ):
        self.specs = []
        self.won = won
        self.state = state
        self.rejections = []

    async def claim(self, *, spec):
        self.specs.append(spec)
        return OperationClaimResult(
            won=self.won,
            operation=OperationSnapshot(
                operation_id="operation-1",
                operation_key=spec.operation_key,
                state=self.state,
                version=1,
            ),
            transition_token="transition-1" if self.won else None,
        )

    async def mark_rejected_before_submit(self, **kwargs):
        self.rejections.append(kwargs)
        return OperationSnapshot(
            operation_id=kwargs["operation_id"],
            operation_key="operation-key",
            state=OperationState.REJECTED_BEFORE_SUBMIT,
            version=kwargs["expected_version"] + 1,
        )


@pytest.mark.asyncio
async def test_c1_eg07_pos_claims_then_resolves_exact_gateway_credential(monkeypatch):
    from novelvideo.chat.hermes_egress import authorize_credentialed_hermes

    events: list[str] = []
    resolver = _Resolver()
    operations = _Operations()
    original_claim = operations.claim
    original_resolve = resolver.resolve

    async def claim(*, spec):
        events.append("claim")
        return await original_claim(spec=spec)

    async def resolve(admission):
        events.append("resolve")
        return await original_resolve(admission)

    monkeypatch.setattr(operations, "claim", claim)
    monkeypatch.setattr(resolver, "resolve", resolve)
    authorization = await authorize_credentialed_hermes(
        context=_context(),
        username="user-1",
        project_id="project-1",
        prompt="hello",
        credential_resolver=resolver,
        operation_port=operations,
    )

    assert events == ["claim", "resolve"]
    assert resolver.admissions[0].credential == _context().credential
    assert operations.specs[0].business_task_id == "envelope-1"
    assert authorization.credential.api_key == "gw-request-secret"


@pytest.mark.asyncio
async def test_c1_eg07_nofb_rejects_forged_lineage_before_claim_or_resolve(monkeypatch):
    from novelvideo.chat.hermes_egress import (
        EgressBoundaryError,
        authorize_credentialed_hermes,
    )

    monkeypatch.setenv("NEWAPI_API_KEY", "workspace-fallback-secret")
    resolver = _Resolver()
    operations = _Operations()

    with pytest.raises(EgressBoundaryError) as exc_info:
        await authorize_credentialed_hermes(
            context=_context(),
            username="different-user",
            project_id="project-1",
            prompt="hello",
            credential_resolver=resolver,
            operation_port=operations,
        )

    assert exc_info.value.code == "TASK_ENVELOPE_INVALID"
    assert resolver.admissions == []
    assert operations.specs == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "state",
    [OperationState.ACCEPTED, OperationState.COMPLETED, OperationState.UNKNOWN],
)
async def test_c1_eg07_nofb_existing_operation_never_resolves_or_restarts(state):
    from novelvideo.chat.hermes_egress import (
        EgressBoundaryError,
        authorize_credentialed_hermes,
    )

    resolver = _Resolver()
    operations = _Operations(won=False, state=state)

    with pytest.raises(EgressBoundaryError) as exc_info:
        await authorize_credentialed_hermes(
            context=_context(),
            username="user-1",
            project_id="project-1",
            prompt="hello",
            credential_resolver=resolver,
            operation_port=operations,
        )

    assert exc_info.value.code == "EGRESS_OPERATION_NOT_RESTARTED"
    assert resolver.admissions == []


@pytest.mark.asyncio
async def test_c1_eg07_resolver_failure_marks_safe_rejected_before_submit():
    from novelvideo.chat.hermes_egress import (
        EgressBoundaryError,
        authorize_credentialed_hermes,
    )

    class _FailingResolver:
        async def resolve(self, admission):
            raise RuntimeError("unsafe workspace secret and command")

    operations = _Operations()
    with pytest.raises(EgressBoundaryError) as exc_info:
        await authorize_credentialed_hermes(
            context=_context(),
            username="user-1",
            project_id="project-1",
            prompt="hello",
            credential_resolver=_FailingResolver(),
            operation_port=operations,
        )

    assert exc_info.value.code == "ORG_CREDENTIAL_DECRYPT_FAILED"
    assert "unsafe" not in str(exc_info.value)
    assert operations.rejections == [
        {
            "operation_id": "operation-1",
            "transition_token": "transition-1",
            "expected_version": 1,
        }
    ]


def test_c1_eg07_child_env_is_minimal_and_ignores_process_provider_secrets(
    monkeypatch, tmp_path
):
    from novelvideo.chat.hermes_egress import (
        HermesLaunchAuthorization,
        build_hermes_child_env,
    )

    monkeypatch.setenv("OPENAI_API_KEY", "process-openai-secret")
    monkeypatch.setenv("OPENROUTER_API_KEY", "process-openrouter-secret")
    monkeypatch.setenv("MODEL_API_KEY", "process-model-secret")
    authorization = HermesLaunchAuthorization.for_test(
        context=_context(),
        credential=RequestCredential(
            reference=_context().credential,
            api_key="gw-request-secret",
            base_url="https://gateway.example/v1",
        ),
    )

    env = build_hermes_child_env(
        home=tmp_path,
        username="user-1",
        api_url="http://127.0.0.1:8780",
        agent_token_env={"DRAMACLAW_AGENT_TOKEN": "agent-token"},
        project_id="project-1",
        project_env={"DRAMACLAW_PROJECT_OUTPUT_DIR": str(tmp_path / "output")},
        authorization=authorization,
    )

    assert env["NEWAPI_API_KEY"] == "gw-request-secret"
    assert env["NEWAPI_BASE_URL"] == "https://gateway.example/v1"
    assert "OPENAI_API_KEY" not in env
    assert "OPENROUTER_API_KEY" not in env
    assert "MODEL_API_KEY" not in env
    assert set(env) <= {
        "PATH",
        "LANG",
        "LC_ALL",
        "HOME",
        "HERMES_HOME",
        "TMPDIR",
        "DRAMACLAW_USER",
        "DRAMACLAW_AGENT_TOKEN",
        "DRAMACLAW_API_URL",
        "DRAMACLAW_PROJECT_ID",
        "DRAMACLAW_PROJECT_OUTPUT_DIR",
        "NEWAPI_API_KEY",
        "NEWAPI_BASE_URL",
    }


def test_c1_eg17_platform_and_director_org_deny_before_network_or_process():
    from novelvideo.task_backend.subprocesses import require_direct_model_egress_allowed

    require_direct_model_egress_allowed(_context(kind="platform"))
    with pytest.raises(Exception) as exc_info:
        require_direct_model_egress_allowed(_context())
    assert getattr(exc_info.value, "code", None) == "ORG_EGRESS_DENIED"


def test_c1_eg20a_pos_and_env_exact_allowlist(tmp_path, monkeypatch):
    from novelvideo.task_backend import subprocesses

    captured = {}

    class _FakeProcess:
        pid = 41
        returncode = 0

        def poll(self):
            return self.returncode

        def communicate(self, timeout=None):
            return ("ok", "")

    def fake_popen(args, **kwargs):
        captured["args"] = args
        captured.update(kwargs)
        return _FakeProcess()

    monkeypatch.setattr(subprocesses.subprocess, "Popen", fake_popen)
    monkeypatch.setenv("OPENAI_API_KEY", "organization-key-must-not-leak")
    command = ("ffmpeg", "-version")
    policy = subprocesses.RestrictedSubprocessPolicy(
        command=command,
        cwd=tmp_path,
        env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"},
    )
    completed = subprocesses.run_project_subprocess(
        command,
        cwd=tmp_path,
        egress_context=_context(),
        restricted_policy=policy,
        capture_output=True,
        text=True,
    )

    assert completed.returncode == 0
    assert captured["args"] == list(command)
    assert captured["cwd"] == tmp_path
    assert captured["env"] == {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"}


def test_c1_eg20a_env_rejects_unlisted_command_cwd_and_secret_without_launch(
    tmp_path, monkeypatch
):
    from novelvideo.task_backend import subprocesses

    launches = []
    monkeypatch.setattr(
        subprocesses.subprocess, "Popen", lambda *a, **k: launches.append((a, k))
    )
    policy = subprocesses.RestrictedSubprocessPolicy(
        command=("ffmpeg", "-version"),
        cwd=tmp_path,
        env={"PATH": "/usr/bin:/bin"},
    )

    for command, cwd, env in (
        (("node", "script.js"), tmp_path, {}),
        (("ffmpeg", "-version"), Path("/"), {}),
        (("ffmpeg", "-version"), tmp_path, {"OPENAI_API_KEY": "secret"}),
    ):
        with pytest.raises(Exception) as exc_info:
            subprocesses.run_project_subprocess(
                command,
                cwd=cwd,
                env=env,
                egress_context=_context(),
                restricted_policy=policy,
            )
        assert getattr(exc_info.value, "code", None) == "ORG_SERVICE_EGRESS_DENIED"

    assert launches == []


def test_c1_eg20a_rejects_network_argument_and_hides_launcher_exception(
    tmp_path, monkeypatch
):
    from novelvideo.task_backend import subprocesses

    command = ("ffmpeg", "-i", "https://secret.example/input.mp4")
    policy = subprocesses.RestrictedSubprocessPolicy(
        command=command,
        cwd=tmp_path,
        env={"PATH": "/usr/bin:/bin"},
    )
    launches = []
    monkeypatch.setattr(
        subprocesses.subprocess,
        "Popen",
        lambda *args, **kwargs: launches.append((args, kwargs)),
    )
    with pytest.raises(Exception) as exc_info:
        subprocesses.run_project_subprocess(
            command,
            cwd=tmp_path,
            egress_context=_context(),
            restricted_policy=policy,
        )
    assert getattr(exc_info.value, "code", None) == "ORG_SERVICE_EGRESS_DENIED"
    assert launches == []

    safe_command = ("ffmpeg", "-version")
    safe_policy = subprocesses.RestrictedSubprocessPolicy(
        command=safe_command,
        cwd=tmp_path,
        env={"PATH": "/usr/bin:/bin"},
    )
    monkeypatch.setattr(
        subprocesses.subprocess,
        "Popen",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            OSError("unsafe command=/secret/workspace token=secret")
        ),
    )
    with pytest.raises(Exception) as exc_info:
        subprocesses.run_project_subprocess(
            safe_command,
            cwd=tmp_path,
            egress_context=_context(),
            restricted_policy=safe_policy,
        )
    assert getattr(exc_info.value, "code", None) == "ORG_SERVICE_EGRESS_DENIED"
    assert "unsafe" not in str(exc_info.value)


def test_c1_eg20b_platform_and_org_deny_model_child_env(monkeypatch):
    from novelvideo.task_backend.subprocesses import build_model_child_env

    source = {
        "PATH": "/usr/bin:/bin",
        "OPENAI_API_KEY": "platform-secret",
        "OPENROUTER_API_KEY": "platform-router-secret",
    }
    assert (
        build_model_child_env(source, egress_context=_context(kind="platform"))
        == source
    )

    with pytest.raises(Exception) as exc_info:
        build_model_child_env(source, egress_context=_context())
    assert getattr(exc_info.value, "code", None) == "ORG_EGRESS_DENIED"


def test_c1_eg07_pool_build_env_consumes_authorization_not_workspace_gateway(
    monkeypatch, tmp_path
):
    from novelvideo.chat import hermes_pool
    from novelvideo.chat.hermes_egress import HermesLaunchAuthorization
    from novelvideo.ports.auth_contract import AgentSessionToken

    monkeypatch.setattr(
        hermes_pool,
        "effective_gateway_credentials",
        lambda: pytest.fail("workspace gateway fallback must not be read"),
    )
    authorization = HermesLaunchAuthorization.for_test(
        context=_context(),
        credential=RequestCredential(
            reference=_context().credential,
            api_key="gw-request-secret",
            base_url="https://gateway.example/v1",
        ),
    )
    token = AgentSessionToken(
        value="agent-token",
        session_id="session-1",
        user="user-1",
        exp=9999999999,
        scopes=("projects:read",),
        worker_id="worker-1",
    )
    env = hermes_pool.HermesPool()._build_env(
        tmp_path,
        "user-1",
        token,
        project_id="project-1",
        project_env={"DRAMACLAW_PROJECT_OUTPUT_DIR": str(tmp_path / "output")},
        authorization=authorization,
    )

    assert env["NEWAPI_API_KEY"] == "gw-request-secret"
    assert "OPENAI_API_KEY" not in env


def test_c1_eg20b_chat_env_builder_denies_org_before_child_env(monkeypatch):
    from novelvideo.chat import service

    monkeypatch.setenv("OPENAI_API_KEY", "provider-secret")
    with pytest.raises(Exception) as exc_info:
        service._build_codex_env("user-1", "project-1", egress_context=_context())
    assert getattr(exc_info.value, "code", None) == "ORG_EGRESS_DENIED"


def test_c1_eg17_block_world_org_denied_before_provider_env(monkeypatch):
    import argparse

    from novelvideo.director_world import block_world_builder

    monkeypatch.setenv("OPENAI_API_KEY", "provider-secret")
    args = argparse.Namespace(model="", base_url="", api_key="")
    with pytest.raises(Exception) as exc_info:
        block_world_builder.resolve_model_config(args, egress_context=_context())
    assert getattr(exc_info.value, "code", None) == "ORG_EGRESS_DENIED"


@pytest.mark.asyncio
async def test_c1_eg17_overlap_analyzer_org_denied_before_network(monkeypatch):
    import argparse

    from novelvideo.director_world import scene_overlap_analyzer

    network = []
    monkeypatch.setattr(
        scene_overlap_analyzer,
        "ask_openrouter",
        lambda **kwargs: network.append(kwargs),
    )
    with pytest.raises(Exception) as exc_info:
        await scene_overlap_analyzer.run(
            argparse.Namespace(), egress_context=_context()
        )
    assert getattr(exc_info.value, "code", None) == "ORG_EGRESS_DENIED"
    assert network == []


def test_c1_eg17_stage_voxel_org_denied_before_file_or_process(tmp_path):
    from novelvideo import stage_asset_tasks

    with pytest.raises(Exception) as exc_info:
        stage_asset_tasks.run_voxel_world_from_360(
            tmp_path,
            "scene-1",
            egress_context=_context(),
        )
    assert getattr(exc_info.value, "code", None) == "ORG_EGRESS_DENIED"


def test_c1_eg17_staging_prop_org_denied_before_model(monkeypatch):
    from novelvideo.director_world import staging_prop_ai

    model_calls = []
    monkeypatch.setattr(
        staging_prop_ai,
        "run_staging_prop_agent",
        lambda *args, **kwargs: model_calls.append((args, kwargs)),
    )
    with pytest.raises(Exception) as exc_info:
        staging_prop_ai.generate_ai_staging_prop({}, egress_context=_context())
    assert getattr(exc_info.value, "code", None) == "ORG_EGRESS_DENIED"
    assert model_calls == []


@pytest.mark.asyncio
async def test_c1_eg20a_freezone_runner_uses_restricted_subprocess(
    tmp_path, monkeypatch
):
    from novelvideo.freezone import jobs

    launches = []

    def fake_run(args, **kwargs):
        launches.append((args, kwargs))
        return type("Completed", (), {"returncode": 0, "stderr": ""})()

    monkeypatch.setattr(jobs, "run_project_subprocess", fake_run, raising=False)
    await jobs._run_cmd(
        ["ffmpeg", "-version"],
        cwd=tmp_path,
        egress_context=_context(),
    )

    assert len(launches) == 1
    assert launches[0][1]["egress_context"] == _context()
    assert launches[0][1]["restricted_policy"].command == ("ffmpeg", "-version")
    assert all("KEY" not in name for name in launches[0][1]["restricted_policy"].env)
