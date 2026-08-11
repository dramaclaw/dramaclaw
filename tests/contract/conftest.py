"""contract 层共用的测试装配。"""

from datetime import datetime, timezone
from itertools import count

import pytest

from novelvideo.ports.authz import AdmissionContext, BillingPrincipal
from novelvideo.ports.local.tasks import InlineTaskBackend
from novelvideo.ports.model_credentials import CredentialReference
from novelvideo.task_backend.consumer import TaskEnvelopeConsumer
from novelvideo.task_backend.producer import TaskEnvelopeProducer

_ENVELOPE_NOW = datetime(2026, 8, 3, 4, 5, 6, tzinfo=timezone.utc)
_ENVELOPE_SIGNING_KEY = b"contract-task-envelope-test-key1"


class _StubAuthz:
    async def admit_model_task(self, *, user_id: str, root_task_id: str):
        return AdmissionContext(
            requester_user_id=user_id,
            billing_principal=BillingPrincipal(kind="local", id=user_id),
            credential=CredentialReference("local", "local-newapi", 1),
            admission_id=f"admission-{root_task_id}",
            root_task_id=root_task_id,
            admitted_at="2026-08-03T04:05:00Z",
            authz_version=1,
        )


@pytest.fixture
def signed_inline_backend():
    """造一个签名链路完整的 InlineTaskBackend。

    producer 与 consumer 都是真实实现，共用测试 keyring 与固定时钟，只有 authz
    是 stub——签名与验签真跑，不是绕过校验的替身。

    必须接线：InlineTaskBackend 在 consumer 为 None 时按设计直接判
    InvalidTaskEnvelope（失败关闭），裸构造的后端不会执行任何任务，用例只会卡在
    等待上超时。生产侧唯一构造点 ports/local/__init__.py 同样必然传这两者。
    """

    def _build() -> InlineTaskBackend:
        authz = _StubAuthz()
        envelope_ids = count(1)
        keyring = {"contract-v1": _ENVELOPE_SIGNING_KEY}
        producer = TaskEnvelopeProducer(
            authz=authz,
            active_key_id="contract-v1",
            keyring=keyring,
            clock=lambda: _ENVELOPE_NOW,
            envelope_id_factory=lambda: f"contract-envelope-{next(envelope_ids)}",
        )
        consumer = TaskEnvelopeConsumer(
            keyring=keyring,
            authz=authz,
            clock=lambda: _ENVELOPE_NOW,
        )
        return InlineTaskBackend(producer=producer, consumer=consumer)

    return _build
