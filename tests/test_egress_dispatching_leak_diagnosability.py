"""OI-58 C 层：`mark_unknown` 失败时,那行泄漏必须留下痕迹。

三条服务出网路径（relay / newapi 管理面 / 备份同步）的收尾形状逐字相同：

    except Exception:
        try:
            await operations.mark_unknown(...)
        except Exception:
            pass          # <- 这里
        raise XxxFailed() from None

那个空 `except` 是本次故障**一直没人发现**的直接原因。`mark_unknown` 在真库上抛
P0001（服务主体拿不到跃迁授权，见 OI-58 A 层），异常被这三行吞掉，行永久停在
`dispatching`，而日志里只剩一句笼统的 `XxxFailed`——「台账写不进去」与「上游调用失败」
两件完全不同的事，从外面看一模一样。

**吞掉本身是对的，不改。** 出网已经失败了，台账写不进去不该把它变成另一种失败；
收敛由库内收割器兜底（EE `0066_egress_operation_reaper`）。要改的是它**静默**：
收割器要过一整个租约周期（默认 60 分钟）才会碰到那行，在那之前唯一的线索就是这条日志。

护栏（沿用 OI-45，`test_org_relay_failure_diagnosability.py`）：日志只出
`operation_id` / `capability` / 异常类型名。凭条是这行的写入授权，印出来等于把锁贴在
墙上；被吞的那个异常本体可能带签名 URL 或密钥，所以只取类型名，不取 `str(exc)`。

断言落在 `caplog.text` 而不是 record 属性：默认 formatter 不打 `extra=`（全 CE 树
只有一处用它），断言属性会在「日志实际上什么都没打出来」时照样绿。
"""

from __future__ import annotations

import logging

import pytest

from novelvideo.backup.files_sync import (
    BackupInvocationFailed,
    run_backup_operation,
    trusted_backup_cli_context,
)
from novelvideo.egress_context import TrustedEgressContext
from novelvideo.newapi_provisioner import (
    NewApiAdminServiceIdentity,
    ServiceInvocationFailed as NewApiInvocationFailed,
    run_newapi_admin_operation,
)
from novelvideo.ports.authz import BillingPrincipal
from novelvideo.ports.egress_operations import (
    OperationClaimResult,
    OperationSnapshot,
    OperationState,
)
from novelvideo.ports.model_credentials import CredentialReference
from novelvideo.storage.media_relay import (
    ServiceInvocationFailed,
    StorageRelayIdentity,
    relay_tenant_image_bytes,
)

CANARY = "transition-token-and-signed-url-canary"
LEDGER_LOGGER = "novelvideo.ports.egress_operations"


class _Operations:
    """领得到、写不了终态——就是服务主体在真库上的形状（OI-58 A 层之前）。"""

    def __init__(self, *, unknown_error: BaseException | None = None) -> None:
        self._unknown_error = unknown_error
        self.unknown_calls: list[dict] = []

    async def claim(self, *, spec):
        return OperationClaimResult(
            won=True,
            operation=OperationSnapshot(
                operation_id="operation-oi58",
                operation_key=spec.operation_key,
                state=OperationState.DISPATCHING,
                version=1,
            ),
            transition_token=CANARY,
        )

    async def mark_unknown(self, **kwargs):
        self.unknown_calls.append(kwargs)
        if self._unknown_error is not None:
            raise self._unknown_error
        return OperationSnapshot(
            operation_id=kwargs["operation_id"],
            operation_key="0" * 64,
            state=OperationState.UNKNOWN,
            version=2,
        )

    async def mark_accepted(self, **kwargs):  # pragma: no cover - 本文件只走失败路径
        raise AssertionError("the invocation failed; nothing may be accepted")

    async def mark_completed(self, **kwargs):  # pragma: no cover - 同上
        raise AssertionError("the invocation failed; nothing may be completed")

    async def mark_rejected_before_submit(self, **kwargs):  # pragma: no cover - 同上
        raise AssertionError("unused")


class _ExplodingRelay:
    def upload_bytes(self, *_args, **_kwargs):
        raise RuntimeError(f"PUT https://bucket.invalid/x?sig={CANARY} -> 403")


def _org_context() -> TrustedEgressContext:
    return TrustedEgressContext(
        envelope_id="envelope-oi58",
        project_id="project-oi58",
        task_type="image.edit",
        requester_user_id="user-oi58",
        root_task_id="root-oi58",
        admission_id="admission-oi58",
        admitted_at="2026-08-12T04:05:00Z",
        membership_id="membership-oi58",
        authz_version=4,
        billing_principal=BillingPrincipal(kind="organization", id="org-oi58"),
        credential=CredentialReference(
            source="organization",
            credential_id="credential-oi58",
            key_version=9,
            org_id="org-oi58",
        ),
    )


async def _drive_relay(operations) -> None:
    context = _org_context()
    await relay_tenant_image_bytes(
        b"image-bytes",
        object_id="object-oi58",
        context=context,
        identity=StorageRelayIdentity(
            credential_id="svc-media-relay",
            credential_version=1,
            organization_id=context.billing_principal.id,
            project_id=context.project_id,
        ),
        operations=operations,
        relay=_ExplodingRelay(),
    )


async def _drive_newapi_admin(operations) -> None:
    def _boom():
        raise RuntimeError(f"admin call failed with token {CANARY}")

    await run_newapi_admin_operation(
        identity=NewApiAdminServiceIdentity(
            credential_id="svc-newapi-admin",
            credential_version=1,
            admin_base_url="https://newapi.invalid",
        ),
        admin_base_url="https://newapi.invalid",
        capability="gateway.provisioning.channel.create",
        business_task_id="task-oi58",
        request={"channel": "oi58"},
        operations=operations,
        invoke=_boom,
    )


async def _drive_backup(operations) -> None:
    def _boom():
        raise RuntimeError(f"ossutil failed with {CANARY}")

    await run_backup_operation(
        context=trusted_backup_cli_context("files-sync-oi58"),
        capability="backup.storage.files.sync",
        business_task_id="task-oi58",
        request={"bucket": "oi58"},
        operations=operations,
        invoke=_boom,
    )


# `capability` 逐条写死而不是从 driver 回读：这三个串是日志里唯一能区分「哪条服务路径
# 漏了」的东西，从被测代码回读就等于用它自己证明自己。
CALL_SITES = [
    pytest.param(_drive_relay, ServiceInvocationFailed, "storage.media.relay", id="relay"),
    pytest.param(
        _drive_newapi_admin,
        NewApiInvocationFailed,
        "gateway.provisioning.channel.create",
        id="newapi-admin",
    ),
    pytest.param(
        _drive_backup, BackupInvocationFailed, "backup.storage.files.sync", id="backup"
    ),
]


@pytest.mark.asyncio
@pytest.mark.parametrize(("drive", "expected_error", "capability"), CALL_SITES)
async def test_a_swallowed_mark_unknown_names_the_operation_it_left_behind(
    caplog, drive, expected_error, capability
):
    """行停在 `dispatching` 了，日志得说清是哪一行、哪条能力、被什么挡住的。"""

    operations = _Operations(unknown_error=RuntimeError("egress operation transition is invalid"))

    with caplog.at_level(logging.WARNING, logger=LEDGER_LOGGER):
        with pytest.raises(expected_error):
            await drive(operations)

    assert operations.unknown_calls, "mark_unknown 必须仍被尝试——收割器不是它的替代品"
    assert "operation-oi58" in caplog.text
    assert capability in caplog.text
    assert "RuntimeError" in caplog.text


@pytest.mark.asyncio
@pytest.mark.parametrize(("drive", "expected_error", "capability"), CALL_SITES)
async def test_neither_the_transition_token_nor_the_upstream_message_reaches_the_log(
    caplog, drive, expected_error, capability
):
    """凭条与被吞异常的正文都不出库（OI-45 护栏）。

    这里的 canary 同时是 `transition_token` **和** 上游异常正文里的签名 URL —— 一条
    断言同时钉住两个泄漏面。
    """

    operations = _Operations(unknown_error=RuntimeError(f"denied for {CANARY}"))

    with caplog.at_level(logging.WARNING, logger=LEDGER_LOGGER):
        with pytest.raises(expected_error):
            await drive(operations)

    assert caplog.text, "前一条用例保证有日志；这条只管它不带密钥"
    assert CANARY not in caplog.text


@pytest.mark.asyncio
@pytest.mark.parametrize(("drive", "expected_error", "capability"), CALL_SITES)
async def test_a_mark_unknown_that_succeeded_says_nothing(
    caplog, drive, expected_error, capability
):
    """收敛成功是正常路径。给它也打一条警告，就是把这条日志变成噪音。"""

    operations = _Operations()

    with caplog.at_level(logging.WARNING, logger=LEDGER_LOGGER):
        with pytest.raises(expected_error):
            await drive(operations)

    assert operations.unknown_calls
    assert caplog.text == ""


@pytest.mark.asyncio
@pytest.mark.parametrize(("drive", "expected_error", "capability"), CALL_SITES)
async def test_the_swallowing_itself_is_unchanged(caplog, drive, expected_error, capability):
    """本次只加日志：台账写不进去，**仍然**不许改变调用方看到的失败。

    把这里改成向上抛，等于让一次出网失败根据「台账能不能写」分裂成两种错误，
    而调用方对此无能为力。
    """

    operations = _Operations(unknown_error=RuntimeError("boom"))

    with pytest.raises(expected_error) as exc_info:
        await drive(operations)

    # `from None`：被吞的异常不许挂在 __cause__ 上溜出去（它可能带密钥）。
    assert exc_info.value.__cause__ is None
