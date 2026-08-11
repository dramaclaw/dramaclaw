"""`egress_operations` 的句柄类别：让「非法状态」不可表达，而不是靠占位串糊过去。

`0039_p0_gray_egress_operations.py:138-146` 的 `egress_operations_output_check`
读上去像「出网必留上游句柄」，实际只校验 `btrim(...) <> ''`。于是四处写入点塞占位
串就能满足它：`tts_generator.py:141` 的 `"sync-audio"`、三条服务路径的
`"service-operation-completed"`、`model_gateway_runtime.py` 拿 `operation_id` 自引用
当句柄。约束、写入点、和一条把占位串钉成期望值的绿色用例三方互相背书——保证是假的。

修法是给行加类别列 `handle_kind`，三选一，各自的终态形状由 DB 判别式约束：

| handle_kind    | accepted                | completed                            |
|----------------|-------------------------|--------------------------------------|
| `provider_job` | provider_job_id 非空    | provider_job_id 非空 + result_ref 非空 |
| `local_result` | provider_job_id IS NULL | provider_job_id NULL + result_ref 非空 |
| `none`         | provider_job_id IS NULL | 两列均 IS NULL                        |

类别在 **claim 时**声明：形状是调用方自己的事，claim 时就已知，且约束必须从建行
起成立。字段**必填、无默认值**——给默认值就把「我声明它没有句柄」和「我忘了写」
压回同一个值，那正是 OI-48 的教训。

顺带修一个本文件之前无人撞见的真缺陷：三条服务路径在 `dispatching` 态直接调
`mark_completed`，而 `0039:294-338` 的 `transition_egress_operation` 要求
`completed` 必须来自 `accepted`——真库上必抛 P0001。它一直是绿的，只因替身
`FakeOperations` 根本没有 `mark_accepted`、也不建状态机。所以替身也要一起补：
不给替身状态机，新约束照样被架空，等于把 OI-49 重演一遍。
"""

from __future__ import annotations

import ast
import inspect
from pathlib import Path

import pytest

from novelvideo.ports.egress_operations import (
    EgressOperationError,
    HandleKind,
    OperationClaimResult,
    OperationSnapshot,
    OperationSpec,
    OperationState,
)

SRC_ROOT = Path(__file__).resolve().parents[1] / "src" / "novelvideo"

# `0039` 之前被写进库的两个占位串。清零后不得回潮。
PLACEHOLDER_HANDLES = ("sync-audio", "service-operation-completed")


def _spec(**overrides) -> OperationSpec:
    values = {
        "organization_id": "org_1",
        "project_id": "project_1",
        "root_task_id": "root_1",
        "business_task_id": "episode:1:beat:2:image",
        "capability": "image.generate",
        "credential_id": "credential_1",
        "credential_version": 3,
        "request_digest": "a" * 64,
        "handle_kind": HandleKind.PROVIDER_JOB,
    }
    values.update(overrides)
    return OperationSpec(**values)


class StateMachineOperations:
    """带真状态机的替身：`completed` 只能来自 `accepted`，与真 definer 同律。

    `0039:294-338` 的 SECURITY DEFINER 函数就是这么判的。替身不照着建，服务路径
    的非法跃迁在测试里永远看不见——这正是这个缺陷活到今天的原因。
    """

    def __init__(self) -> None:
        self.state = OperationState.DISPATCHING
        self.version = 1
        self.claims: list[OperationSpec] = []
        self.transitions: list[tuple[str, dict]] = []

    async def claim(self, *, spec: OperationSpec) -> OperationClaimResult:
        self.claims.append(spec)
        return OperationClaimResult(
            won=True,
            operation=OperationSnapshot(
                operation_id="op-1",
                operation_key=spec.operation_key,
                state=self.state,
                version=self.version,
            ),
            transition_token="transition-1",
        )

    def _apply(
        self,
        verb: str,
        kwargs: dict,
        *,
        allowed_from: set[OperationState],
        target: OperationState,
    ) -> OperationSnapshot:
        if self.state not in allowed_from:
            raise EgressOperationError("EGRESS_OPERATION_INVALID_TRANSITION")
        if kwargs["expected_version"] != self.version:
            raise EgressOperationError("EGRESS_OPERATION_INVALID_TRANSITION")
        self.transitions.append((verb, dict(kwargs)))
        self.state = target
        self.version += 1
        return OperationSnapshot(
            operation_id=kwargs["operation_id"],
            operation_key="operation-key",
            state=target,
            version=self.version,
        )

    async def mark_accepted(self, **kwargs) -> OperationSnapshot:
        return self._apply(
            "accepted",
            kwargs,
            allowed_from={OperationState.DISPATCHING},
            target=OperationState.ACCEPTED,
        )

    async def mark_completed(self, **kwargs) -> OperationSnapshot:
        return self._apply(
            "completed",
            kwargs,
            allowed_from={OperationState.ACCEPTED},
            target=OperationState.COMPLETED,
        )

    async def mark_rejected_before_submit(self, **kwargs) -> OperationSnapshot:
        return self._apply(
            "rejected_before_submit",
            kwargs,
            allowed_from={OperationState.DISPATCHING},
            target=OperationState.REJECTED_BEFORE_SUBMIT,
        )

    async def mark_unknown(self, **kwargs) -> OperationSnapshot:
        return self._apply(
            "unknown",
            kwargs,
            allowed_from={OperationState.DISPATCHING, OperationState.ACCEPTED},
            target=OperationState.UNKNOWN,
        )


def test_operation_spec_requires_an_explicitly_declared_handle_kind() -> None:
    """漏写 handle_kind 是 TypeError。没有默认值——默认值就是新的占位串。"""

    values = {
        "organization_id": "org_1",
        "project_id": "project_1",
        "root_task_id": "root_1",
        "business_task_id": "task_1",
        "capability": "image.generate",
        "credential_id": "credential_1",
        "credential_version": 3,
        "request_digest": "a" * 64,
    }
    with pytest.raises(TypeError, match="handle_kind"):
        OperationSpec(**values)

    for bad in ("provider_job", None, 1, True):
        with pytest.raises(TypeError, match="handle_kind"):
            _spec(handle_kind=bad)

    assert {kind.value for kind in HandleKind} == {
        "provider_job",
        "local_result",
        "none",
    }


def test_operation_key_ignores_handle_kind() -> None:
    """类别**不得**进身份字典，否则存量 claim 的 replay 会整体失配。

    钉住 `tests/ports/test_egress_operations.py:57` 已有的那个摘要常量：它没动，
    才说明既有行的 replay 语义没被这次改动搬走。
    """

    assert _spec(handle_kind=HandleKind.PROVIDER_JOB).operation_key == _spec(
        handle_kind=HandleKind.NONE
    ).operation_key
    assert _spec().operation_key == (
        "6364e3f1e602b759bbecf2a8fccc6c119bed41c263c30b25b8b98cc6fb40b1b2"
    )


def test_every_claim_site_declares_a_handle_kind() -> None:
    """9 个生产构造点逐个显式声明；新增一个不声明的即红。

    只认字面量 `HandleKind.X`：间接取值等于把类别推迟到运行期，那就没法在这里看出
    它到底声明了什么。
    """

    declared: dict[str, str] = {}
    for path in sorted(SRC_ROOT.rglob("*.py")):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            func = node.func
            if not (isinstance(func, ast.Name) and func.id == "OperationSpec"):
                continue
            kinds = [kw for kw in node.keywords if kw.arg == "handle_kind"]
            site = f"{path.relative_to(SRC_ROOT)}:{node.lineno}"
            assert kinds, f"{site} 构造 OperationSpec 却没声明 handle_kind"
            value = kinds[0].value
            assert (
                isinstance(value, ast.Attribute)
                and isinstance(value.value, ast.Name)
                and value.value.id == "HandleKind"
            ), f"{site} 的 handle_kind 不是 HandleKind 字面量"
            declared[site] = value.attr

    assert len(declared) == 9, declared


@pytest.mark.asyncio
async def test_service_paths_reach_completed_through_accepted() -> None:
    """三条服务路径必须走完 dispatching→accepted→completed，且两列都不留假值。

    现在它们从 `dispatching` 直接 `mark_completed`，真库上是 P0001。
    """

    from novelvideo.backup.files_sync import (
        run_backup_operation,
        trusted_backup_cli_context,
    )
    from novelvideo.newapi_provisioner import (
        NewApiAdminServiceIdentity,
        run_newapi_admin_operation,
    )

    newapi_ops = StateMachineOperations()
    await run_newapi_admin_operation(
        identity=NewApiAdminServiceIdentity(
            credential_id="svc-newapi-admin",
            credential_version=2,
            admin_base_url="http://new-api:3000",
        ),
        admin_base_url="http://new-api:3000",
        capability="gateway.provisioning.setup",
        business_task_id="setup-default",
        request={"action": "setup", "channel": "default"},
        operations=newapi_ops,
        invoke=lambda: {"ok": True},
    )

    backup_ops = StateMachineOperations()
    await run_backup_operation(
        context=trusted_backup_cli_context("root-op-1"),
        capability="backup.storage.files",
        business_task_id="files-sync-1",
        request={"action": "sync"},
        operations=backup_ops,
        invoke=lambda: {"ok": True},
    )

    for label, ops in (("newapi", newapi_ops), ("backup", backup_ops)):
        verbs = [verb for verb, _kwargs in ops.transitions]
        assert verbs == ["accepted", "completed"], f"{label}: {verbs}"
        assert ops.claims[0].handle_kind is HandleKind.NONE, label
        accepted_kwargs = ops.transitions[0][1]
        completed_kwargs = ops.transitions[1][1]
        assert accepted_kwargs["provider_job_id"] is None, label
        assert completed_kwargs["result_ref"] is None, label
        # expected_version 必须跟着 accepted 的返回走：插入一步之后版本已经 +1，
        # 继续拿 claim 时的版本会被乐观锁挡掉。
        assert completed_kwargs["expected_version"] == accepted_kwargs[
            "expected_version"
        ] + 1, label


@pytest.mark.asyncio
async def test_media_relay_reaches_completed_through_accepted() -> None:
    from novelvideo.egress_context import TrustedEgressContext
    from novelvideo.ports.authz import BillingPrincipal
    from novelvideo.ports.model_credentials import CredentialReference
    from novelvideo.storage.media_relay import (
        StorageRelayIdentity,
        relay_tenant_image_bytes,
    )

    class _Relay:
        def upload_bytes(self, _data, *, ext, ttl, object_key):
            return f"https://cdn.example/{object_key}?ttl={ttl}&ext={ext}"

    context = TrustedEgressContext(
        envelope_id="envelope-1",
        project_id="project-a",
        task_type="image.generate",
        requester_user_id="user-1",
        root_task_id="root-1",
        admission_id="admission-1",
        admitted_at="2026-08-11T04:05:00Z",
        membership_id="membership-1",
        authz_version=1,
        billing_principal=BillingPrincipal(kind="organization", id="org-a"),
        credential=CredentialReference(
            source="organization",
            credential_id="credential-1",
            key_version=2,
            org_id="org-a",
        ),
    )
    operations = StateMachineOperations()

    url = await relay_tenant_image_bytes(
        b"image-bytes",
        object_id="object-1",
        context=context,
        identity=StorageRelayIdentity(
            credential_id="svc-relay",
            credential_version=1,
            organization_id="org-a",
            project_id="project-a",
        ),
        operations=operations,
        relay=_Relay(),
    )

    assert url.startswith("https://cdn.example/")
    assert [verb for verb, _kwargs in operations.transitions] == [
        "accepted",
        "completed",
    ]
    assert operations.claims[0].handle_kind is HandleKind.NONE
    assert operations.transitions[0][1]["provider_job_id"] is None
    assert operations.transitions[1][1]["result_ref"] is None


@pytest.mark.asyncio
async def test_state_machine_double_refuses_completed_straight_from_dispatching() -> (
    None
):
    """替身自身先得会拒，否则上面那几条什么也没证明。"""

    operations = StateMachineOperations()
    with pytest.raises(EgressOperationError) as excinfo:
        await operations.mark_completed(
            operation_id="op-1",
            transition_token="transition-1",
            expected_version=1,
            result_ref=None,
        )

    assert excinfo.value.code == "EGRESS_OPERATION_INVALID_TRANSITION"


def test_no_placeholder_operation_handles_remain() -> None:
    """占位串在 src 下清零——包括本文件自己的常量之外的任何出现。"""

    offenders = [
        f"{path.relative_to(SRC_ROOT)}:{number}"
        for path in sorted(SRC_ROOT.rglob("*.py"))
        for number, line in enumerate(
            path.read_text(encoding="utf-8").splitlines(), start=1
        )
        if any(placeholder in line for placeholder in PLACEHOLDER_HANDLES)
    ]

    assert offenders == []


def test_no_operation_id_is_reused_as_its_own_upstream_handle() -> None:
    """`model_gateway_runtime.py` 曾拿 `operation_id` 自引用当句柄——那不是句柄。

    自引用能过「非空」检查却零信息量，是 OI-49 登记时漏掉的第五处。
    """

    from novelvideo import model_gateway_runtime

    source = Path(inspect.getsourcefile(model_gateway_runtime)).read_text(
        encoding="utf-8"
    )
    tree = ast.parse(source)

    offenders: list[str] = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        for keyword in node.keywords:
            if keyword.arg not in {"provider_job_id", "result_ref"}:
                continue
            value = keyword.value
            if (
                isinstance(value, ast.Attribute)
                and value.attr == "operation_id"
            ):
                offenders.append(f"{keyword.arg}@{node.lineno}")

    assert offenders == []
