"""Nobody re-sends a model request from inside this process.

Four facts, verified against the relayclaw gateway source and against 24h of
its production logs, say the transport-level retry must be zero on *every*
path — platform and organization alike:

1. The gateway settles billing without checking whether the client is still
   connected (``controller/relay.go:583``: ``if taskErr == nil { SettleBilling(...) }``
   with no ctx test). A read timeout on our side therefore says nothing about
   whether the upstream call was billed. The client-gone signal
   (``StreamEndReasonClientGone``) reaches only log generation
   (``service/log_info_generate.go:133``), never the billing path.
2. So a blind re-send after a timeout is not a *probable* double-charge, it is
   a *definite* one: two full relays, two settles.
3. The relay path honours no client-supplied idempotency key — request ids are
   server-generated (``middleware/request-id.go:10``), and the only
   ``X-Idempotency-Key`` in that repo is outbound to a payment provider. Both
   open alignment branches (rc.22, rc.24) leave this unchanged, so there is no
   near-term escape hatch.
4. The retry we actually want already exists one hop up: the gateway retries
   across channels *inside a single BillingSession* (one request id, one
   pre-consume, one settle), so it cannot double-bill. Production runs it —
   24h of ``claymore-llm-gateway-prod``: 3726 pre-consumes, 34 retries, chains
   up to 6 attempts.

The SDK's own default is 2, so ``max_retries=0`` has to be passed explicitly;
deleting that argument silently restores retries. That is what these tests
pin. An earlier round of review proposed a ``组织 0 / 直营 1`` split; it was
retracted (dramaclaw/dramaclaw#274, 2026-08-11) because fact 1 makes the
platform path no safer than the organization path — same gateway, same settle.
"""

from __future__ import annotations

import asyncio

import httpx
import pytest

from novelvideo.egress_context import (
    BillingPrincipal,
    CredentialReference,
    TrustedEgressContext,
)
from novelvideo.ports.model_credentials import RequestCredential

EXPECTED_MAX_RETRIES = 0


def _org_context() -> TrustedEgressContext:
    return TrustedEgressContext(
        envelope_id="envelope-retry-off",
        project_id="project-retry-off",
        task_type="text.generate",
        requester_user_id="user-retry-off",
        root_task_id="root-retry-off",
        admission_id="admission-retry-off",
        admitted_at="2026-08-11T04:05:00Z",
        membership_id="membership-retry-off",
        authz_version=1,
        billing_principal=BillingPrincipal(kind="organization", id="org-retry-off"),
        credential=CredentialReference(
            source="organization",
            credential_id="org-gateway-key",
            key_version=3,
            org_id="org-retry-off",
        ),
    )


def _org_credential() -> RequestCredential:
    return RequestCredential(
        reference=_org_context().credential,
        api_key="org-key",
        base_url="https://org.test/v1",
    )


def _close(model) -> None:
    provider = getattr(model, "provider", model)
    client = getattr(provider, "_own_http_client", None)
    if client is not None:
        asyncio.run(client.aclose())


def _assert_no_retries(model) -> None:
    assert model.provider.client.max_retries == EXPECTED_MAX_RETRIES


# --------------------------------------------------------------------------
# Every construction site of the text transport.
#
# There is exactly one place that builds the AsyncOpenAI client
# (config._newapi_text_openai_provider), reached only through
# config._newapi_text_openai_model. These tests enter from the five callers of
# that funnel, not from the funnel itself, so that a new branch which forgets
# to route through it still fails here.
# --------------------------------------------------------------------------


def test_ce_platform_model_disables_transport_retry(monkeypatch):
    """config.py's CE branch — the only path a community install takes."""

    import novelvideo.config as config

    monkeypatch.setenv("ST_EDITION", "ce")
    monkeypatch.delenv("ST_CONTROL_PLANE_DSN", raising=False)
    # CE resolves credentials from settings.db rather than the environment, so
    # the resolver is stubbed. Under test is the max_retries decision on the
    # branch below it, not credential resolution.
    monkeypatch.setattr(
        config,
        "get_newapi_runtime_credentials",
        lambda **_kwargs: ("platform-key", "https://platform.test/v1"),
    )

    model = config.get_newapi_text_pydantic_model("RETRY_OFF_MODEL", "gpt-test")
    try:
        _assert_no_retries(model)
    finally:
        _close(model)


def test_freezone_vision_organization_transport_disables_retry(monkeypatch):
    """presets.py builds its transport from an explicit egress_context.

    This is the site no ambient read can classify: the ContextVar is unbound
    here, and the model is built right after an image egress operation was
    claimed. A retry here spends the organization's money twice against one
    claim.
    """

    from novelvideo.freezone import presets
    from novelvideo.generators import nanobanana_grid
    from novelvideo.model_gateway_runtime import current_model_gateway_context

    class _Egress:
        credential = _org_credential()

    async def fake_prepare(**_kwargs):
        assert current_model_gateway_context() is None, (
            "this test is only meaningful while the ContextVar is unbound here"
        )
        return _Egress()

    monkeypatch.setattr(
        nanobanana_grid, "_prepare_organization_image_egress", fake_prepare
    )

    state = asyncio.run(
        presets.prepare_freezone_vision_egress(
            egress_context=_org_context(),
            model_name="gpt-test",
            prompt="describe",
            images=[b"\x89PNG"],
            timeout_seconds=12.0,
        )
    )
    assert state is not None
    model = state.transport_context.model
    try:
        _assert_no_retries(model)
    finally:
        _close(model)


def test_staging_prop_agent_transport_disables_retry():
    """director_world builds its own agent, bypassing config's entry point."""

    from novelvideo.director_world.staging_prop_ai import create_staging_prop_agent

    agent = create_staging_prop_agent(
        model="gpt-test",
        api_key="platform-key",
        base_url="https://platform.test/v1",
    )
    model = agent.model
    try:
        _assert_no_retries(model)
    finally:
        _close(model)


# --------------------------------------------------------------------------
# The EE gateway facade resolves credentials per submit, so it builds the
# transport *inside* request()/request_stream(). Both branches are entered for
# real, with the real delegate factory, and the model each one built is caught
# on its way past.
# --------------------------------------------------------------------------


def _counting_transport(built: list, monkeypatch):
    """Route the real transport at a counter instead of the network."""

    import novelvideo.config as config

    calls: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return httpx.Response(500, json={"error": {"message": "boom"}})

    real_factory = config._newapi_text_http_client_factory

    def patched_factory(*, timeout_seconds: float):
        real_factory(timeout_seconds=timeout_seconds)  # keep its env parsing honest

        def factory():
            return httpx.AsyncClient(
                timeout=timeout_seconds, transport=httpx.MockTransport(handler)
            )

        return factory

    monkeypatch.setattr(config, "_newapi_text_http_client_factory", patched_factory)

    real_model_factory = config._newapi_text_openai_model

    def spy(model_name, **kwargs):
        model = real_model_factory(model_name, **kwargs)
        built.append(model)
        return model

    return spy, calls


def _gateway_model(delegate_factory):
    from novelvideo.model_gateway_runtime import create_request_scoped_gateway_model

    return create_request_scoped_gateway_model(
        model_name="gpt-test",
        capability="text.generate",
        timeout_seconds=12.0,
        profile=None,
        delegate_factory=delegate_factory,
        platform_credential_factory=lambda: (
            "platform-key",
            "https://platform.test/v1",
        ),
    )


def _one_message():
    from pydantic_ai.messages import ModelRequest, UserPromptPart
    from pydantic_ai.models import ModelRequestParameters

    return [ModelRequest(parts=[UserPromptPart(content="hi")])], ModelRequestParameters()


@pytest.mark.parametrize("branch", ["request", "request_stream"])
def test_gateway_platform_branch_disables_retry(monkeypatch, branch):
    """直营. request_stream is a second site and drifts independently."""

    from pydantic_ai.exceptions import ModelHTTPError

    built: list = []
    spy, calls = _counting_transport(built, monkeypatch)
    model = _gateway_model(spy)
    messages, params = _one_message()

    async def drive():
        if branch == "request":
            await model.request(messages, None, params)
        else:
            async with model.request_stream(messages, None, params):
                pass

    with pytest.raises(ModelHTTPError):
        asyncio.run(drive())

    assert built, "the gateway never built a transport"
    for delegate in built:
        _assert_no_retries(delegate)
    # The behaviour behind the attribute: one 500 produced exactly one call.
    assert len(calls) == 1 + EXPECTED_MAX_RETRIES


def test_gateway_organization_branch_disables_retry(monkeypatch):
    """The org submit closure must never re-send: one claim, one egress."""

    import novelvideo.model_gateway_runtime as runtime
    from pydantic_ai.exceptions import ModelHTTPError

    built: list = []
    spy, calls = _counting_transport(built, monkeypatch)
    model = _gateway_model(spy)
    messages, params = _one_message()

    async def fake_execute(*, capability, business_task_id, request_digest, submit):
        return await submit(_org_credential())

    monkeypatch.setattr(runtime, "execute_organization_gateway_request", fake_execute)

    async def drive():
        with runtime.model_gateway_request_scope(_org_context()):
            await model.request(messages, None, params)

    with pytest.raises(ModelHTTPError):
        asyncio.run(drive())

    assert built, "the gateway never built a transport"
    for delegate in built:
        _assert_no_retries(delegate)
    assert len(calls) == 1 + EXPECTED_MAX_RETRIES


def test_the_zero_has_to_be_written_down():
    """Deleting ``max_retries=0`` would not fail loudly — the SDK default is 2.

    This is why the tests above assert on a value rather than on the absence
    of one: the safe state here is the explicit state.
    """

    import openai

    assert openai.DEFAULT_MAX_RETRIES == 2
    assert EXPECTED_MAX_RETRIES != openai.DEFAULT_MAX_RETRIES
