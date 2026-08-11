from __future__ import annotations

import inspect
from dataclasses import asdict

import pytest

from novelvideo.egress_context import TrustedEgressContext
from novelvideo.ports.authz import BillingPrincipal
from novelvideo.ports.egress_operations import (
    HandleKind,
    OperationClaimResult,
    OperationSnapshot,
    OperationState,
)
from novelvideo.ports.model_credentials import CredentialReference
from support.egress_ledger import assert_transition_allowed


class FakeOperations:
    """带状态机的替身。

    原先它连 `mark_accepted` 都没有，`mark_completed` 也不看前置态，于是服务路径
    「从 dispatching 直跳 completed」——真库上必抛 P0001——在这里一路绿灯。替身不建
    状态机，DB 侧的约束就是摆设，见 OI-49。
    """

    def __init__(
        self, *, won: bool = True, state: OperationState = OperationState.DISPATCHING
    ):
        self.won = won
        self.state = state
        self.claims = []
        self.accepted = []
        self.completed = []
        self.unknown = []
        self._state = state
        self._version = 1

    async def claim(self, *, spec):
        self.claims.append(spec)
        return OperationClaimResult(
            won=self.won,
            operation=OperationSnapshot(
                operation_id="op-1",
                operation_key=spec.operation_key,
                state=self.state,
                version=1,
            ),
            transition_token="transition-1" if self.won else None,
        )

    def _transition(self, kwargs, target: OperationState) -> OperationSnapshot:
        assert_transition_allowed(
            current=self._state,
            target=target,
            expected_version=kwargs["expected_version"],
            row_version=self._version,
        )
        self._state = target
        self._version = kwargs["expected_version"] + 1
        return OperationSnapshot(
            operation_id=kwargs["operation_id"],
            operation_key="operation-key",
            state=target,
            version=self._version,
        )

    async def mark_accepted(self, **kwargs):
        snapshot = self._transition(kwargs, OperationState.ACCEPTED)
        self.accepted.append(kwargs)
        return snapshot

    async def mark_completed(self, **kwargs):
        snapshot = self._transition(kwargs, OperationState.COMPLETED)
        self.completed.append(kwargs)
        return snapshot

    async def mark_unknown(self, **kwargs):
        snapshot = self._transition(kwargs, OperationState.UNKNOWN)
        self.unknown.append(kwargs)
        return snapshot


def _org_context(*, org_id: str = "org-a", project_id: str = "project-a"):
    return TrustedEgressContext(
        envelope_id="envelope-1",
        project_id=project_id,
        task_type="image.generate",
        requester_user_id="user-1",
        root_task_id="root-1",
        admission_id="admission-1",
        admitted_at="2026-08-03T04:05:00Z",
        membership_id="membership-1",
        authz_version=1,
        billing_principal=BillingPrincipal(kind="organization", id=org_id),
        credential=CredentialReference(
            source="organization",
            credential_id="org-gateway-key",
            key_version=7,
            org_id=org_id,
        ),
    )


def _platform_context():
    return TrustedEgressContext(
        envelope_id="envelope-platform",
        project_id="project-platform",
        task_type="image.generate",
        requester_user_id="user-platform",
        root_task_id="root-platform",
        admission_id="admission-platform",
        admitted_at="2026-08-03T04:05:00Z",
        membership_id=None,
        authz_version=1,
        billing_principal=BillingPrincipal(kind="platform", id="platform"),
        credential=CredentialReference(
            source="platform",
            credential_id="platform-key",
            key_version=1,
        ),
    )


def test_c1_eg21_context_facade_has_no_identity_or_authority_override():
    from novelvideo.storage.media_relay import relay_tenant_image_bytes_from_context

    assert tuple(
        inspect.signature(relay_tenant_image_bytes_from_context).parameters
    ) == (
        "data",
        "object_id",
        "context",
        "ext",
        "ttl",
    )


@pytest.mark.asyncio
async def test_c1_eg21_context_facade_uses_registry_and_context_identity(monkeypatch):
    from novelvideo import ports
    from novelvideo.storage import media_relay

    operations = FakeOperations()
    relay_calls = []

    class FakeRelay:
        def upload_bytes(self, data, *, ext, ttl, object_key):
            relay_calls.append((data, ext, ttl, object_key))
            return "https://relay.example/signed-secret-url"

    monkeypatch.setattr(ports, "get_egress_operation_port", lambda: operations)
    monkeypatch.setattr(media_relay, "get_media_relay", lambda: FakeRelay())
    context = _org_context(org_id="org-from-context", project_id="project-from-context")

    result = await media_relay.relay_tenant_image_bytes_from_context(
        b"image",
        object_id="object-canary-never-persist",
        context=context,
        ttl=60,
    )

    assert result == "https://relay.example/signed-secret-url"
    assert len(relay_calls) == 1
    spec = operations.claims[0]
    assert spec.organization_id == "org-from-context"
    assert spec.project_id == "project-from-context"
    assert spec.credential_id == "svc-media-relay"
    assert spec.credential_version == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("context", [object(), _platform_context()])
async def test_c1_eg21_context_facade_denies_untrusted_context_before_authority_or_config(
    monkeypatch, context
):
    from novelvideo import ports
    from novelvideo.storage import media_relay

    monkeypatch.setattr(
        ports,
        "get_egress_operation_port",
        lambda: (_ for _ in ()).throw(AssertionError("authority must stay at zero")),
    )
    monkeypatch.setattr(
        media_relay,
        "get_media_relay",
        lambda: (_ for _ in ()).throw(AssertionError("config must stay at zero")),
    )

    with pytest.raises(media_relay.ServiceEgressDenied) as exc_info:
        await media_relay.relay_tenant_image_bytes_from_context(
            b"image", object_id="object-a", context=context
        )

    assert exc_info.value.code == "ORG_SERVICE_EGRESS_DENIED"


@pytest.mark.asyncio
async def test_c1_eg21_context_facade_denies_missing_authority_before_config(
    monkeypatch,
):
    from novelvideo import ports
    from novelvideo.ports.registry import PortNotRegistered
    from novelvideo.storage import media_relay

    monkeypatch.setattr(
        ports,
        "get_egress_operation_port",
        lambda: (_ for _ in ()).throw(PortNotRegistered("egress_operations")),
    )
    monkeypatch.setattr(
        media_relay,
        "get_media_relay",
        lambda: (_ for _ in ()).throw(AssertionError("config must stay at zero")),
    )

    with pytest.raises(media_relay.ServiceEgressDenied) as exc_info:
        await media_relay.relay_tenant_image_bytes_from_context(
            b"image", object_id="object-a", context=_org_context()
        )

    assert exc_info.value.code == "ORG_SERVICE_EGRESS_DENIED"


@pytest.mark.asyncio
async def test_c1_eg21_context_facade_denies_incomplete_authority_before_config(
    monkeypatch,
):
    from novelvideo import ports
    from novelvideo.storage import media_relay

    class ClaimOnlyOperations:
        async def claim(self, *, spec):
            raise AssertionError("claim must stay at zero")

    monkeypatch.setattr(
        ports, "get_egress_operation_port", lambda: ClaimOnlyOperations()
    )
    monkeypatch.setattr(
        media_relay,
        "get_media_relay",
        lambda: (_ for _ in ()).throw(AssertionError("config must stay at zero")),
    )

    with pytest.raises(media_relay.ServiceEgressDenied):
        await media_relay.relay_tenant_image_bytes_from_context(
            b"image", object_id="object-a", context=_org_context()
        )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "state",
    [
        OperationState.DISPATCHING,
        OperationState.ACCEPTED,
        OperationState.COMPLETED,
        OperationState.UNKNOWN,
    ],
)
async def test_c1_eg21_context_facade_never_relays_non_winning_claims(
    monkeypatch, state
):
    from novelvideo import ports
    from novelvideo.storage import media_relay

    operations = FakeOperations(won=False, state=state)
    monkeypatch.setattr(ports, "get_egress_operation_port", lambda: operations)
    monkeypatch.setattr(
        media_relay,
        "get_media_relay",
        lambda: (_ for _ in ()).throw(AssertionError("relay must stay at zero")),
    )

    with pytest.raises(media_relay.ServiceOperationNotReplayable):
        await media_relay.relay_tenant_image_bytes_from_context(
            b"image", object_id="object-a", context=_org_context()
        )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "state", [OperationState.ACCEPTED, OperationState.COMPLETED, OperationState.UNKNOWN]
)
async def test_c1_eg21_context_facade_never_relays_existing_terminal_claims(
    monkeypatch, state
):
    from novelvideo import ports
    from novelvideo.storage import media_relay

    operations = FakeOperations(won=True, state=state)
    monkeypatch.setattr(ports, "get_egress_operation_port", lambda: operations)
    monkeypatch.setattr(
        media_relay,
        "get_media_relay",
        lambda: (_ for _ in ()).throw(AssertionError("relay must stay at zero")),
    )

    with pytest.raises(media_relay.ServiceOperationNotReplayable):
        await media_relay.relay_tenant_image_bytes_from_context(
            b"image", object_id="object-a", context=_org_context()
        )


@pytest.mark.asyncio
async def test_c1_eg21_context_facade_does_not_relay_conflicting_claim(monkeypatch):
    from novelvideo import ports
    from novelvideo.ports.egress_operations import EgressOperationError
    from novelvideo.storage import media_relay

    class ConflictingOperations:
        async def claim(self, *, spec):
            raise EgressOperationError("EGRESS_OPERATION_CONFLICT")

        async def mark_completed(self, **kwargs):
            raise AssertionError("conflict must not transition to completed")

        async def mark_unknown(self, **kwargs):
            raise AssertionError("conflict must not transition to unknown")

    monkeypatch.setattr(
        ports, "get_egress_operation_port", lambda: ConflictingOperations()
    )
    monkeypatch.setattr(
        media_relay,
        "get_media_relay",
        lambda: (_ for _ in ()).throw(AssertionError("relay must stay at zero")),
    )

    with pytest.raises(EgressOperationError) as exc_info:
        await media_relay.relay_tenant_image_bytes_from_context(
            b"image", object_id="object-a", context=_org_context()
        )

    assert exc_info.value.code == "EGRESS_OPERATION_CONFLICT"


@pytest.mark.asyncio
@pytest.mark.parametrize("relay_fails", [False, True])
async def test_c1_eg21_context_facade_transitions_in_claim_relay_terminal_order(
    monkeypatch, relay_fails
):
    from novelvideo import ports
    from novelvideo.storage import media_relay

    events = []

    class OrderedOperations(FakeOperations):
        async def claim(self, *, spec):
            events.append("claim")
            return await super().claim(spec=spec)

        async def mark_accepted(self, **kwargs):
            events.append("accepted")
            return await super().mark_accepted(**kwargs)

        async def mark_completed(self, **kwargs):
            events.append("completed")
            return await super().mark_completed(**kwargs)

        async def mark_unknown(self, **kwargs):
            events.append("unknown")
            return await super().mark_unknown(**kwargs)

    class OrderedRelay:
        def upload_bytes(self, *_args, **_kwargs):
            events.append("relay")
            if relay_fails:
                raise RuntimeError("service-secret object-canary signed-url")
            return "https://relay.example/signed-secret-url"

    monkeypatch.setattr(ports, "get_egress_operation_port", lambda: OrderedOperations())
    monkeypatch.setattr(media_relay, "get_media_relay", lambda: OrderedRelay())

    call = media_relay.relay_tenant_image_bytes_from_context(
        b"image", object_id="object-a", context=_org_context()
    )
    if relay_fails:
        with pytest.raises(media_relay.ServiceInvocationFailed):
            await call
        assert events == ["claim", "relay", "unknown"]
    else:
        assert await call == "https://relay.example/signed-secret-url"
        # `completed` 只能来自 `accepted`（`0039:302-307`），中继因此多一步 accept。
        assert events == ["claim", "relay", "accepted", "completed"]


@pytest.mark.asyncio
async def test_c1_eg21_context_facade_marks_unknown_when_relay_config_fails(
    monkeypatch,
):
    from novelvideo import ports
    from novelvideo.storage import media_relay

    events = []

    class OrderedOperations(FakeOperations):
        async def claim(self, *, spec):
            events.append("claim")
            return await super().claim(spec=spec)

        async def mark_unknown(self, **kwargs):
            events.append("unknown")
            return await super().mark_unknown(**kwargs)

    def fail_config():
        events.append("config")
        raise RuntimeError("service-secret object-canary")

    monkeypatch.setattr(ports, "get_egress_operation_port", lambda: OrderedOperations())
    monkeypatch.setattr(media_relay, "get_media_relay", fail_config)

    with pytest.raises(media_relay.ServiceInvocationFailed):
        await media_relay.relay_tenant_image_bytes_from_context(
            b"image", object_id="object-a", context=_org_context()
        )

    assert events == ["claim", "config", "unknown"]


@pytest.mark.asyncio
async def test_c1_eg21_pos_binds_service_org_project_object_without_secret_sinks():
    from novelvideo.storage.media_relay import (
        StorageRelayIdentity,
        relay_tenant_image_bytes,
    )

    storage_calls = []

    class FakeRelay:
        def upload_bytes(self, data, *, ext, ttl, object_key):
            storage_calls.append((data, ext, ttl, object_key))
            return "https://relay.example/signed-secret-url"

    operations = FakeOperations()
    result = await relay_tenant_image_bytes(
        b"image",
        ext="png",
        ttl=60,
        object_id="object-canary-never-persist",
        context=_org_context(),
        identity=StorageRelayIdentity(
            credential_id="svc-media-relay",
            credential_version=3,
            organization_id="org-a",
            project_id="project-a",
        ),
        operations=operations,
        relay=FakeRelay(),
    )

    assert result == "https://relay.example/signed-secret-url"
    assert len(storage_calls) == 1
    assert storage_calls[0][3].startswith("tenants/org-a/projects/project-a/objects/")
    assert "object-canary" not in storage_calls[0][3]
    assert len(operations.claims) == 1
    persisted = repr(asdict(operations.claims[0])) + repr(operations.completed)
    for forbidden in (
        "object-canary-never-persist",
        "signed-secret-url",
        "org-gateway-key",
    ):
        assert forbidden not in persisted


@pytest.mark.asyncio
async def test_c1_eg21_cross_org_denies_before_claim_or_storage():
    from novelvideo.storage.media_relay import (
        ServiceEgressDenied,
        StorageRelayIdentity,
        relay_tenant_image_bytes,
    )

    class FailRelay:
        def upload_bytes(self, *_args, **_kwargs):
            raise AssertionError("storage must stay at zero")

    operations = FakeOperations()
    with pytest.raises(ServiceEgressDenied) as exc_info:
        await relay_tenant_image_bytes(
            b"image",
            object_id="object-a",
            context=_org_context(org_id="org-a"),
            identity=StorageRelayIdentity(
                credential_id="svc-media-relay",
                credential_version=1,
                organization_id="org-b",
                project_id="project-a",
            ),
            operations=operations,
            relay=FailRelay(),
        )

    assert exc_info.value.code == "ORG_SERVICE_EGRESS_DENIED"
    assert operations.claims == []


@pytest.mark.parametrize(
    "url",
    [
        "http://media.example/object.png",
        "https://other.example/object.png",
        "https://media.example:bad/object.png",
        "file:///etc/passwd",
    ],
)
def test_c1_eg21_rejects_non_https_or_non_allowlisted_source_hosts(url):
    from novelvideo.storage.media_relay import (
        ServiceEgressDenied,
        StorageRelayIdentity,
        validate_tenant_source_url,
    )

    with pytest.raises(ServiceEgressDenied):
        validate_tenant_source_url(
            url,
            context=_org_context(),
            identity=StorageRelayIdentity(
                credential_id="svc-media-relay",
                credential_version=1,
                organization_id="org-a",
                project_id="project-a",
                allowed_source_hosts=("media.example",),
            ),
        )


def test_c1_eg21_accepts_exact_allowlisted_https_source_host():
    from novelvideo.storage.media_relay import (
        StorageRelayIdentity,
        validate_tenant_source_url,
    )

    url = "https://media.example/object.png"
    assert (
        validate_tenant_source_url(
            url,
            context=_org_context(),
            identity=StorageRelayIdentity(
                credential_id="svc-media-relay",
                credential_version=1,
                organization_id="org-a",
                project_id="project-a",
                allowed_source_hosts=("media.example",),
            ),
        )
        == url
    )


@pytest.mark.asyncio
async def test_c1_eg21_release_feed_drops_untrusted_release_url(tmp_path, monkeypatch):
    from novelvideo.ports.local.release_feed import LocalReleaseFeed

    monkeypatch.setenv("RELEASE_NOTIFICATIONS_ENABLED", "true")
    notes = tmp_path / "release-notes.md"
    notes.write_text(
        "# v1.0.0\n## User-facing Highlights (en)\n- **Current**: local\n",
        encoding="utf-8",
    )

    async def fetcher():
        return {
            "tag_name": "v2.0.0",
            "html_url": "https://attacker.example/secret-object-canary",
            "body": "# v2.0.0\n## User-facing Highlights (en)\n- **New**: item\n",
        }

    feed = await LocalReleaseFeed(
        notes_path=notes,
        version_reader=lambda: "1.0.0",
        github_fetcher=fetcher,
    ).current(locale="en")

    assert feed.update_available is True
    assert feed.release_url is None


@pytest.mark.asyncio
async def test_c1_eg22_pos_allows_only_newapi_admin_service_identity():
    from novelvideo.newapi_provisioner import (
        NewApiAdminServiceIdentity,
        run_newapi_admin_operation,
    )

    network_calls = []
    operations = FakeOperations()

    result = await run_newapi_admin_operation(
        identity=NewApiAdminServiceIdentity(
            credential_id="svc-newapi-admin",
            credential_version=2,
            admin_base_url="http://new-api:3000",
        ),
        admin_base_url="http://new-api:3000",
        capability="gateway.provisioning.setup",
        business_task_id="setup-default",
        request={"action": "setup", "channel": "default"},
        operations=operations,
        invoke=lambda: network_calls.append("called") or {"ok": True},
    )

    assert result == {"ok": True}
    assert network_calls == ["called"]
    assert len(operations.claims) == 1
    # 这条路径没有上游作业号、也没有结果引用（HandleKind.NONE），两列就该是 NULL。
    # 原先它断言的是占位串 `"service-operation-completed"` ——把「能骗过非空检查的
    # 字符串」钉成了期望值，DB 约束、写入点、用例三方互相背书，见 OI-49。
    assert operations.claims[0].handle_kind is HandleKind.NONE
    assert operations.accepted[0]["provider_job_id"] is None
    assert operations.completed[0]["result_ref"] is None


@pytest.mark.asyncio
async def test_c1_eg22_org_deny_rejects_org_gateway_key_before_claim_or_network():
    from novelvideo.newapi_provisioner import (
        NewApiAdminServiceIdentity,
        ServiceControlEgressDenied,
        run_newapi_admin_operation,
    )

    operations = FakeOperations()
    network_calls = []
    with pytest.raises(ServiceControlEgressDenied) as exc_info:
        await run_newapi_admin_operation(
            identity=NewApiAdminServiceIdentity(
                credential_id="svc-newapi-admin",
                credential_version=2,
                admin_base_url="http://new-api:3000",
            ),
            admin_base_url="http://new-api:3000",
            capability="gateway.provisioning.setup",
            business_task_id="setup-default",
            request={"action": "setup"},
            operations=operations,
            invoke=lambda: network_calls.append("called"),
            context=_org_context(),
        )

    assert exc_info.value.code == "ORG_SERVICE_EGRESS_DENIED"
    assert operations.claims == []
    assert network_calls == []


@pytest.mark.asyncio
@pytest.mark.parametrize("context", [_org_context(), _platform_context()])
async def test_c1_eg22_facade_only_denies_every_trusted_request_context(context):
    from novelvideo.newapi_provisioner import (
        NewApiAdminServiceIdentity,
        ServiceControlEgressDenied,
        run_newapi_admin_operation,
    )

    operations = FakeOperations()
    network_calls = []
    with pytest.raises(ServiceControlEgressDenied):
        await run_newapi_admin_operation(
            identity=NewApiAdminServiceIdentity(
                credential_id="svc-newapi-admin",
                credential_version=1,
                admin_base_url="http://new-api:3000",
            ),
            admin_base_url="http://new-api:3000",
            capability="gateway.provisioning.setup",
            business_task_id="setup-default",
            request={"action": "setup"},
            operations=operations,
            invoke=lambda: network_calls.append("called"),
            context=context,
        )

    assert operations.claims == []
    assert network_calls == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("identity", "capability"),
    [
        (object(), "gateway.provisioning.setup"),
        (None, "model.generate"),
    ],
)
async def test_c1_eg22_facade_only_denies_wrong_identity_or_capability(
    identity, capability
):
    from novelvideo.newapi_provisioner import (
        ServiceControlEgressDenied,
        run_newapi_admin_operation,
    )

    operations = FakeOperations()
    network_calls = []
    with pytest.raises(ServiceControlEgressDenied):
        await run_newapi_admin_operation(
            identity=identity,
            admin_base_url="http://new-api:3000",
            capability=capability,
            business_task_id="setup-default",
            request={"action": "setup"},
            operations=operations,
            invoke=lambda: network_calls.append("called"),
        )

    assert operations.claims == []
    assert network_calls == []


@pytest.mark.asyncio
async def test_c1_eg22_facade_only_denies_missing_authority_before_network():
    from novelvideo.newapi_provisioner import (
        NewApiAdminServiceIdentity,
        ServiceControlEgressDenied,
        run_newapi_admin_operation,
    )

    network_calls = []
    with pytest.raises(ServiceControlEgressDenied):
        await run_newapi_admin_operation(
            identity=NewApiAdminServiceIdentity(
                credential_id="svc-newapi-admin",
                credential_version=1,
                admin_base_url="http://new-api:3000",
            ),
            admin_base_url="http://new-api:3000",
            capability="gateway.provisioning.setup",
            business_task_id="setup-default",
            request={"action": "setup"},
            operations=None,
            invoke=lambda: network_calls.append("called"),
        )

    assert network_calls == []


def test_c1_eg22_org_deny_applies_at_model_gateway_route_boundary(monkeypatch):
    from novelvideo.api.routes import model_gateway
    from novelvideo.newapi_provisioner import ServiceControlEgressDenied

    monkeypatch.setattr(
        model_gateway, "require_legacy_local_service_operation", lambda: None
    )
    monkeypatch.setattr(model_gateway, "is_ce_effective", lambda: False)
    monkeypatch.setattr(
        model_gateway,
        "require_provisioner_enabled",
        lambda: (_ for _ in ()).throw(AssertionError("provisioner must stay at zero")),
    )

    with pytest.raises(ServiceControlEgressDenied) as exc_info:
        model_gateway.require_ce_gateway_management()

    assert exc_info.value.code == "ORG_SERVICE_EGRESS_DENIED"


def test_c1_eg22_provisioner_denies_org_context_before_network(monkeypatch):
    from novelvideo import newapi_provisioner
    from novelvideo.newapi_provisioner import (
        NewApiProvisionerConfig,
        ServiceControlEgressDenied,
    )

    monkeypatch.setattr(
        newapi_provisioner,
        "get_newapi_setup_status",
        lambda *_args: (_ for _ in ()).throw(
            AssertionError("network must stay at zero")
        ),
    )
    cfg = NewApiProvisionerConfig(
        admin_base_url="http://new-api:3000",
        sql_dsn="local",
        sqlite_path="/not-used",
        admin_username="root",
        init_timeout_ms=1,
        relay_token_name="relay",
    )

    with pytest.raises(ServiceControlEgressDenied):
        newapi_provisioner.ensure_newapi_setup(cfg, context=_org_context())


@pytest.mark.asyncio
async def test_c1_eg23_pos_uses_cli_backup_identity_and_minimal_environment(
    monkeypatch,
):
    from novelvideo.backup.files_sync import (
        BackupExecutionContext,
        BackupServiceIdentity,
        build_rclone_env,
        run_backup_operation,
    )

    monkeypatch.setenv("BACKUP_OSS_AK", "backup-ak")
    monkeypatch.setenv("BACKUP_OSS_SK", "backup-sk")
    monkeypatch.setenv("BACKUP_OSS_ENDPOINT", "oss-cn-chengdu.aliyuncs.com")
    monkeypatch.setenv("MODEL_API_KEY", "model-secret-must-not-inherit")
    process_calls = []
    operations = FakeOperations()
    context = BackupExecutionContext(
        source="cli",
        identity=BackupServiceIdentity(
            credential_id="svc-backup",
            credential_version=4,
        ),
        root_operation_id="backup-run-1",
    )

    result = await run_backup_operation(
        context=context,
        capability="backup.storage.sync",
        business_task_id="files-sync",
        request={"job": "files-sync", "scope": "state"},
        operations=operations,
        invoke=lambda: process_calls.append(build_rclone_env()) or 0,
    )

    assert result == 0
    assert len(process_calls) == 1
    assert "MODEL_API_KEY" not in process_calls[0]
    assert len(operations.claims) == 1


@pytest.mark.asyncio
async def test_c1_eg23_org_deny_stays_before_claim_process_and_network():
    from novelvideo.backup.files_sync import (
        BackupExecutionContext,
        BackupServiceIdentity,
        BackupServiceEgressDenied,
        run_backup_operation,
    )

    operations = FakeOperations()
    process_calls = []
    with pytest.raises(BackupServiceEgressDenied) as exc_info:
        await run_backup_operation(
            context=BackupExecutionContext(
                source="request",
                identity=BackupServiceIdentity(
                    credential_id="svc-backup",
                    credential_version=1,
                ),
                root_operation_id="request-run-1",
                request_context=_org_context(),
            ),
            capability="backup.storage.restore",
            business_task_id="restore-cell",
            request={"job": "restore", "scope": "cell"},
            operations=operations,
            invoke=lambda: process_calls.append("called"),
        )

    assert exc_info.value.code == "ORG_SERVICE_EGRESS_DENIED"
    assert operations.claims == []
    assert process_calls == []


@pytest.mark.asyncio
@pytest.mark.parametrize("request_context", [_org_context(), _platform_context()])
async def test_c1_eg23_facade_only_denies_every_trusted_request_context(
    request_context,
):
    from novelvideo.backup.files_sync import (
        BackupExecutionContext,
        BackupServiceEgressDenied,
        BackupServiceIdentity,
        run_backup_operation,
    )

    operations = FakeOperations()
    process_calls = []
    context = BackupExecutionContext(
        source="request",
        identity=BackupServiceIdentity("svc-backup", 1),
        root_operation_id="request-run",
        request_context=request_context,
    )
    with pytest.raises(BackupServiceEgressDenied):
        await run_backup_operation(
            context=context,
            capability="backup.storage.sync",
            business_task_id="files-sync",
            request={"job": "files-sync"},
            operations=operations,
            invoke=lambda: process_calls.append("called"),
        )

    assert operations.claims == []
    assert process_calls == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("case", "capability"),
    [("wrong-identity", "backup.storage.sync"), ("wrong-capability", "model.generate")],
)
async def test_c1_eg23_facade_only_denies_wrong_identity_or_capability(
    case, capability
):
    from novelvideo.backup.files_sync import (
        BackupExecutionContext,
        BackupServiceEgressDenied,
        BackupServiceIdentity,
        run_backup_operation,
    )

    if case == "wrong-identity":
        context = BackupExecutionContext(
            source="request",
            identity=object(),
            root_operation_id="request-run",
        )
    else:
        context = BackupExecutionContext(
            source="cli",
            identity=BackupServiceIdentity("svc-backup", 1),
            root_operation_id="backup-run",
        )
    operations = FakeOperations()
    process_calls = []
    with pytest.raises(BackupServiceEgressDenied):
        await run_backup_operation(
            context=context,
            capability=capability,
            business_task_id="files-sync",
            request={"job": "files-sync"},
            operations=operations,
            invoke=lambda: process_calls.append("called"),
        )

    assert operations.claims == []
    assert process_calls == []


@pytest.mark.asyncio
async def test_c1_eg23_facade_only_denies_missing_authority_before_process():
    from novelvideo.backup.files_sync import (
        BackupExecutionContext,
        BackupServiceEgressDenied,
        BackupServiceIdentity,
        run_backup_operation,
    )

    process_calls = []
    with pytest.raises(BackupServiceEgressDenied):
        await run_backup_operation(
            context=BackupExecutionContext(
                source="cli",
                identity=BackupServiceIdentity("svc-backup", 1),
                root_operation_id="backup-run",
            ),
            capability="backup.storage.sync",
            business_task_id="files-sync",
            request={"job": "files-sync"},
            operations=None,
            invoke=lambda: process_calls.append("called"),
        )

    assert process_calls == []


def test_c1_eg23_files_sync_entry_denies_request_context_before_env_or_process(
    monkeypatch,
):
    from novelvideo.backup import files_sync
    from novelvideo.backup.files_sync import (
        BackupExecutionContext,
        BackupServiceEgressDenied,
        BackupServiceIdentity,
    )

    monkeypatch.setattr(
        files_sync, "require_legacy_local_service_operation", lambda: None
    )
    monkeypatch.setattr(
        files_sync.subprocess,
        "run",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("process must stay at zero")
        ),
    )
    context = BackupExecutionContext(
        source="request",
        identity=BackupServiceIdentity("svc-backup", 1),
        root_operation_id="request-run",
        request_context=_org_context(),
    )

    with pytest.raises(BackupServiceEgressDenied):
        files_sync.main(execution_context=context)


def test_c1_eg23_db_daily_entry_denies_request_context_before_storage(monkeypatch):
    from novelvideo.backup import db_daily
    from novelvideo.backup.files_sync import (
        BackupExecutionContext,
        BackupServiceEgressDenied,
        BackupServiceIdentity,
    )

    context = BackupExecutionContext(
        source="request",
        identity=BackupServiceIdentity("svc-backup", 1),
        root_operation_id="request-run",
        request_context=_org_context(),
    )

    monkeypatch.setattr(
        db_daily, "require_legacy_local_service_operation", lambda: None
    )
    with pytest.raises(BackupServiceEgressDenied):
        db_daily.main(execution_context=context)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "state",
    [OperationState.ACCEPTED, OperationState.COMPLETED, OperationState.UNKNOWN],
)
async def test_service_operations_never_replay_non_winning_claims(state):
    from novelvideo.newapi_provisioner import (
        NewApiAdminServiceIdentity,
        ServiceOperationNotReplayable,
        run_newapi_admin_operation,
    )

    operations = FakeOperations(won=False, state=state)
    calls = []
    with pytest.raises(ServiceOperationNotReplayable):
        await run_newapi_admin_operation(
            identity=NewApiAdminServiceIdentity(
                credential_id="svc-newapi-admin",
                credential_version=1,
                admin_base_url="http://new-api:3000",
            ),
            admin_base_url="http://new-api:3000",
            capability="gateway.provisioning.setup",
            business_task_id="setup-default",
            request={"action": "setup"},
            operations=operations,
            invoke=lambda: calls.append("called"),
        )

    assert calls == []


@pytest.mark.asyncio
async def test_service_operation_failure_is_stable_and_secret_free():
    from novelvideo.newapi_provisioner import (
        NewApiAdminServiceIdentity,
        ServiceInvocationFailed,
        run_newapi_admin_operation,
    )

    operations = FakeOperations()

    def fail():
        raise RuntimeError("postgres://admin:secret@example/db object-canary")

    with pytest.raises(ServiceInvocationFailed) as exc_info:
        await run_newapi_admin_operation(
            identity=NewApiAdminServiceIdentity(
                credential_id="svc-newapi-admin",
                credential_version=1,
                admin_base_url="http://new-api:3000",
            ),
            admin_base_url="http://new-api:3000",
            capability="gateway.provisioning.setup",
            business_task_id="setup-default",
            request={"action": "setup"},
            operations=operations,
            invoke=fail,
        )

    assert str(exc_info.value) == "service operation failed"
    assert len(operations.unknown) == 1
