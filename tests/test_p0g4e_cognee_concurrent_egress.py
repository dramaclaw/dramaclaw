"""Concurrent Cognee submits must each claim their own egress operation.

Cognee fans out with asyncio.create_task — one task per embedding batch
(cognee/tasks/storage/index_data_points.py:66-70), one per data item
(pipelines/operations/run_tasks.py:119-120), plus the context-window split in
LiteLLMEmbeddingEngine. Each task gets a copy-on-write snapshot of the
contextvars, so a request identity derived from a counter *stored as an int in
a ContextVar* cannot advance: every sibling reads the same base and mints the
same id. Same id, same operation_key, and the ledger refuses the second claim.

That is the defect these tests pin, and it is why a novel import fails at the
knowledge-graph stage whenever egress goes through the operation ledger.

The tasks below are written as explicit create_task on purpose. Collapsing
them into a sequential loop makes every test here pass against the defect.
"""

from __future__ import annotations

import asyncio
from contextlib import nullcontext
from types import SimpleNamespace

import pytest
from support.egress_ledger import LedgerDouble

from novelvideo.egress_context import TrustedEgressContext
from novelvideo.ports.authz import BillingPrincipal
from novelvideo.ports.egress_operations import EgressOperationError
from novelvideo.ports.model_credentials import CredentialReference, RequestCredential


def _organization_context(*, envelope_id: str = "envelope-1") -> TrustedEgressContext:
    return TrustedEgressContext(
        envelope_id=envelope_id,
        project_id="project-1",
        task_type="graph_build",
        requester_user_id="user-1",
        root_task_id="root-task-1",
        admission_id="admission-1",
        admitted_at="2026-08-03T04:05:00Z",
        membership_id="membership-1",
        authz_version=7,
        billing_principal=BillingPrincipal(kind="organization", id="org-1"),
        credential=CredentialReference(
            source="organization",
            credential_id="credential-1",
            key_version=3,
            org_id="org-1",
        ),
    )


class _CredentialPort:
    async def resolve(self, admission):
        return RequestCredential(
            reference=admission.credential,
            api_key="sk-request-scoped",
            base_url="https://gateway.example/v1",
        )


@pytest.fixture
def wired(monkeypatch):
    """Real routing code, doubled ledger and transport.

    Patches runtime.get_egress_operation_port, not ports.get_egress_operation_port:
    model_gateway_runtime.py:17 binds the name at module import, so patching the
    ports module would not be seen. (media_relay re-imports inside the function,
    which is why its own tests patch the other one.)
    """
    from novelvideo import model_gateway_runtime as runtime
    from novelvideo.cognee import config as cognee_config

    ledger = LedgerDouble()
    monkeypatch.setattr(runtime, "get_egress_operation_port", lambda: ledger)
    monkeypatch.setattr(runtime, "get_model_credentials", lambda: _CredentialPort())
    monkeypatch.setattr(
        cognee_config,
        "embedding_gateway_credentials",
        lambda *_args, **_kwargs: pytest.fail(
            "organization embedding must not read settings/env"
        ),
    )
    return ledger


async def _embed_concurrently(payloads: list[str]) -> list[object]:
    """One create_task per payload, exactly as index_data_points.py:66 does."""
    from novelvideo import model_gateway_runtime as runtime
    from novelvideo.cognee import config as cognee_config
    from novelvideo.embedding_models import (
        COGNEE_EMBEDDING_MODEL_V2,
        embedding_model_scope,
    )

    calls: list[dict] = []

    async def transport(*_args, **kwargs):
        calls.append(kwargs)
        return f"vectors-for-{kwargs['input']}"

    with runtime.model_gateway_request_scope(_organization_context()):
        with embedding_model_scope(COGNEE_EMBEDDING_MODEL_V2):
            tasks = [
                asyncio.create_task(
                    cognee_config._route_project_embedding_transport(
                        transport,
                        (),
                        {"input": [payload], "model": "stale-model"},
                    )
                )
                for payload in payloads
            ]
            await asyncio.gather(*tasks)

    return calls


async def test_concurrent_embedding_batches_claim_distinct_operations(wired):
    """The reported bug. Fails today with the production error code."""
    ledger = wired

    calls = await _embed_concurrently(["alpha", "beta", "gamma", "delta"])

    assert len(calls) == 4
    assert len({spec.operation_key for spec in ledger.claims}) == 4


async def test_identical_payloads_in_one_envelope_each_claim_their_own_operation(
    wired,
):
    """Guards the tempting wrong fix of keying on the payload digest alone.

    Two identical chunk batches are two distinct side effects: each must come
    back with vectors. Nothing caches a completed operation's result
    (result_ref is just the operation_id, model_gateway_runtime.py:368), so
    replaying the second one returns an exception, not the first one's vectors.
    """
    ledger = wired

    calls = await _embed_concurrently(["same-chunk", "same-chunk"])

    assert len(calls) == 2
    assert len({spec.operation_key for spec in ledger.claims}) == 2


async def test_operation_keys_do_not_depend_on_fan_out_order(wired, monkeypatch):
    """Retry-stability: the key set must follow the payloads, not the schedule.

    This is the test a monotonic counter or a uuid4 nonce cannot pass, and it
    is what docs/b2b-org-tenant/p0-gray-freeze.md:108 asks for — the identity
    must survive worker redelivery, where nothing reproduces completion order.
    """
    from novelvideo import model_gateway_runtime as runtime

    payloads = ["alpha", "beta", "gamma"]
    forward = wired
    await _embed_concurrently(payloads)

    reversed_ledger = LedgerDouble()
    monkeypatch.setattr(
        runtime, "get_egress_operation_port", lambda: reversed_ledger
    )
    await _embed_concurrently(list(reversed(payloads)))

    assert {spec.operation_key for spec in forward.claims} == {
        spec.operation_key for spec in reversed_ledger.claims
    }


async def test_replaying_one_envelope_claims_zero_new_operations(wired):
    """The guard that uniqueness was not bought by destroying dedup.

    A redelivered envelope re-issues the same payloads against a ledger that
    already holds their rows. Every claim must lose. Passing today as well as
    after the fix is the point: this one must never go red.
    """
    from novelvideo.model_gateway_runtime import ModelGatewayEgressError

    ledger = wired
    await _embed_concurrently(["alpha", "beta"])
    rows_after_first_delivery = dict(ledger.rows)

    with pytest.raises((ModelGatewayEgressError, EgressOperationError)) as excinfo:
        await _embed_concurrently(["alpha", "beta"])

    assert getattr(excinfo.value, "code", None) == "EGRESS_OPERATION_REPLAYED"
    assert ledger.rows == rows_after_first_delivery


async def test_org_cognee_stage_does_not_retry_in_process(wired):
    """A second attempt in the same scope would re-mint and re-pay.

    Outside organization mode the one retry is a free transient-failure
    absorber, so it stays. Under organization egress the codebase already
    disables retries everywhere else it can reach them
    (model_gateway_runtime.py:53-57, cognee/config.py:807).
    """
    from novelvideo import model_gateway_runtime as runtime
    from novelvideo.cognee.store import CogneeStore

    attempts = 0

    async def operation():
        nonlocal attempts
        attempts += 1
        raise RuntimeError("transient")

    store = SimpleNamespace(
        embedding_model_scope=nullcontext,
        _ensure_pipeline_run_succeeded=lambda *_args, **_kwargs: None,
    )

    with runtime.model_gateway_request_scope(_organization_context()):
        with pytest.raises(RuntimeError):
            await CogneeStore._run_cognee_pipeline_with_retry(
                store,
                stage_name="知识图谱构建",
                operation=operation,
                log=lambda _message: None,
            )

    assert attempts == 1


class _MeterDouble:
    """Enough usage meter to get through _run_project_embedding_with_billing."""

    async def reserve_current_model_call_credit(self, **_kwargs) -> str:
        return ""

    async def refund_model_call_credit_reservation(self, *_args, **_kwargs) -> None:
        return None

    async def bump_model_call(self, **_kwargs) -> None:
        return None


async def test_org_embedding_does_not_retry_inside_the_engine(monkeypatch):
    """cognee's own @retry re-mints an operation key on every attempt.

    LiteLLMEmbeddingEngine.embed_text carries
    @retry(stop=stop_after_delay(128), retry=retry_if_not_exception_type(NotFoundError))
    (LiteLLMEmbeddingEngine.py:104-111). Both egress error classes are plain
    RuntimeError, so they are retryable by that predicate, and each attempt
    re-enters gateway_aembedding — a fresh occurrence, a fresh operation, a
    second paid submit. Under organization egress the engine gets one attempt.

    This drives the real installer against a stub engine module rather than
    testing the unwrap helper alone: the defect this suite exists for shipped
    because the wiring, not the function, was wrong.
    """
    from types import SimpleNamespace as _NS

    from tenacity import retry, stop_after_attempt, wait_fixed

    from novelvideo import model_gateway_runtime as runtime
    from novelvideo.cognee import config as cognee_config
    from novelvideo.embedding_models import (
        COGNEE_EMBEDDING_MODEL_V2,
        embedding_model_scope,
    )

    attempts = 0

    @retry(stop=stop_after_attempt(3), wait=wait_fixed(0), reraise=True)
    async def engine_embed_text(self, text):
        nonlocal attempts
        attempts += 1
        raise RuntimeError("egress operation conflicts with an existing claim")

    class _Engine:
        provider = "custom"
        mock = False
        embed_text = engine_embed_text

        def get_vector_size(self):
            return 0

    # litellm is read off the module (config.py:1005), so a stub module keeps
    # the real litellm untouched. The header-capture installer is the one
    # remaining global mutation and is not what this test is about.
    stub_module = _NS(
        LiteLLMEmbeddingEngine=_Engine,
        litellm=_NS(aembedding=None),
        handle_embedding_response=lambda *_args: None,
    )
    monkeypatch.setattr(
        cognee_config.importlib, "import_module", lambda _name: stub_module
    )
    monkeypatch.setattr(cognee_config, "_embedding_gateway_patch_installed", False)
    monkeypatch.setattr(
        cognee_config, "_install_litellm_embedding_header_capture", lambda: None
    )
    monkeypatch.setattr(cognee_config, "get_usage_meter", lambda: _MeterDouble())

    cognee_config._patch_cognee_embedding_gateway()

    with runtime.model_gateway_request_scope(_organization_context()):
        with embedding_model_scope(COGNEE_EMBEDDING_MODEL_V2):
            with pytest.raises(RuntimeError):
                await _Engine.embed_text(_Engine(), ["chunk"])

    assert attempts == 1
