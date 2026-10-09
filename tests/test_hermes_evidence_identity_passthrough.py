"""The evidence identity must survive every hop of the real chat path.

Every layer here was a place the identity was silently dropped: the pool facade
declares an explicit signature and swallowed unknown keywords, and the service
call site simply never passed them. Unit tests on the issuer all passed anyway,
which is why this asserts the plumbing rather than the minting.
"""

from __future__ import annotations

import inspect

import pytest

from novelvideo.chat import hermes_pool, hermes_sdk, service


def test_the_pool_facade_forwards_the_identity() -> None:
    """A __getattr__ proxy would forward anything, but stream is explicit."""
    signature = inspect.signature(hermes_pool._ManagedHermesThread.stream)
    for name in ("trajectory_id", "project_id"):
        assert name in signature.parameters, (
            f"{name} is dropped by the pool facade before it reaches the worker"
        )


def test_the_worker_accepts_the_identity() -> None:
    signature = inspect.signature(hermes_sdk.HermesSdkThread.stream)
    for name in ("trajectory_id", "project_id"):
        assert name in signature.parameters


@pytest.mark.asyncio
async def test_the_facade_actually_passes_them_through() -> None:
    seen: dict[str, object] = {}

    class FakeThread:
        async def stream(self, prompt, *, current_project=None, trajectory_id=None,
                         project_id=None, gateway_api_key=None):
            seen.update(prompt=prompt, current_project=current_project,
                        trajectory_id=trajectory_id, project_id=project_id,
                        gateway_api_key=gateway_api_key)
            if False:  # pragma: no cover - makes this an async generator
                yield None

    class FakeOwner:
        async def _begin_turn(self, slot): return None
        async def _finish_turn(self, slot): return None

    class FakeSlot:
        thread = FakeThread()

    facade = hermes_pool._ManagedHermesThread(FakeOwner(), FakeSlot())
    async for _ in facade.stream("hi", current_project="p", trajectory_id="tr",
                                 project_id="pr", gateway_api_key="sk-org-A"):
        pass
    assert seen == {"prompt": "hi", "current_project": "p", "trajectory_id": "tr",
                    "project_id": "pr", "gateway_api_key": "sk-org-A"}


def test_home_scope_states_the_absence_of_a_project_explicitly() -> None:
    """BrainClaw refuses to invent a grouping, so 'no project' must be said."""
    from novelvideo.chat.hermes_egress import HOME_SCOPE_EGRESS_PROJECT_ID

    identity = service._evidence_identity(None, None, "main")
    assert identity["project_id"] == HOME_SCOPE_EGRESS_PROJECT_ID
    assert identity["trajectory_id"].startswith("conversation:")


def test_a_canvas_is_its_own_trajectory_within_a_project() -> None:
    class Scope:
        canvas_id = "canvas-7"

    canvas = service._evidence_identity("proj-a", Scope(), "freezone:main")
    plain = service._evidence_identity("proj-a", None, "main")

    assert canvas["trajectory_id"] == "canvas:proj-a:canvas-7:freezone:main"
    assert canvas["trajectory_id"] != plain["trajectory_id"], "a canvas is not the plain conversation"
    # The project is what groups distinct episodes for fold-splitting.
    assert canvas["project_id"] == plain["project_id"] == "proj-a"


def test_the_same_conversation_is_one_stable_episode() -> None:
    """Over-grouping costs power; under-grouping manufactures independence."""
    first = service._evidence_identity("proj-a", None, "main")
    second = service._evidence_identity("proj-a", None, "main")
    assert first == second

    other_profile = service._evidence_identity("proj-a", None, "freezone:x")
    assert other_profile["trajectory_id"] != first["trajectory_id"]
    assert other_profile["project_id"] == first["project_id"]


def test_different_projects_never_share_a_group() -> None:
    a = service._evidence_identity("proj-a", None, "main")
    b = service._evidence_identity("proj-b", None, "main")
    assert a["project_id"] != b["project_id"]
    assert a["trajectory_id"] != b["trajectory_id"]


def test_the_same_canvas_id_never_spans_projects() -> None:
    class Scope:
        canvas_id = "canvas-7"

    a = service._evidence_identity("proj-a", Scope(), "freezone:main")
    b = service._evidence_identity("proj-b", Scope(), "freezone:main")
    assert a["project_id"] != b["project_id"]
    assert a["trajectory_id"] != b["trajectory_id"]


def test_agent_profiles_on_the_same_canvas_never_share_a_trajectory() -> None:
    class Scope:
        canvas_id = "canvas-7"

    main = service._evidence_identity("proj-a", Scope(), "freezone:main")
    future_session = service._evidence_identity(
        "proj-a", Scope(), "freezone:agent-future"
    )
    assert main["project_id"] == future_session["project_id"]
    assert main["trajectory_id"] != future_session["trajectory_id"]


def test_the_turn_key_reaches_the_worker_through_every_hop() -> None:
    """Each layer declares its parameters explicitly, so each must name it."""
    for target in (hermes_pool._ManagedHermesThread.stream, hermes_sdk.HermesSdkThread.stream):
        assert "gateway_api_key" in inspect.signature(target).parameters, (
            f"{target.__qualname__} drops the turn credential"
        )


def _build_child_environment(hermes_egress, secret: str) -> dict[str, str]:
    """Build a worker environment the way the pool does, with a real key set.

    The key is deliberately a live-looking value: the assertion is that it does
    not survive into the child, which is only meaningful if it was present.
    """
    import pathlib as _pathlib

    from novelvideo.egress_context import TrustedEgressContext
    from novelvideo.ports.authz import BillingPrincipal
    from novelvideo.ports.model_credentials import CredentialReference, RequestCredential

    reference = CredentialReference(
        source="organization", credential_id="c-1", key_version=1, org_id="org-1")
    context = TrustedEgressContext(
        envelope_id="e-1", project_id="p-1", task_type="chat",
        requester_user_id="u-1", root_task_id="r-1", admission_id="a-1",
        admitted_at="2026-08-19T00:00:00Z", membership_id="m-1", authz_version=1,
        billing_principal=BillingPrincipal(kind="organization", id="org-1"),
        credential=reference)
    authorization = hermes_egress.HermesTurnAuthorization.for_test(
        context=context,
        credential=RequestCredential(reference=reference, api_key=secret,
                                     base_url="https://gateway.example"))
    return hermes_egress.build_hermes_child_env(
        home=_pathlib.Path("/tmp/canary-home"), username="u-1",
        requester_user_id="u-1", api_url="https://api.example",
        agent_token_env={}, project_id="p-1", egress_project_id="p-1",
        project_env=None, authorization=authorization)


def test_the_child_environment_holds_a_placeholder_not_a_key() -> None:
    """A pooled worker serves many tenants, so its environment cannot hold one.

    The placeholder exists only so the OpenAI SDK can build a client; the latch
    beside it is what stops the placeholder ever authenticating a request.

    Checked by building the environment and reading it, rather than by grepping
    the function's source. The source form was pinned to a literal that later
    moved into a shared constant — so the test failed on a refactor while
    saying nothing about what the child actually receives, which is the only
    thing that matters here.
    """
    from novelvideo.chat import hermes_egress

    secret = "sk-should-never-appear"
    environment = _build_child_environment(hermes_egress, secret)

    assert environment["NEWAPI_API_KEY"] == (
        hermes_egress.PER_TURN_CREDENTIAL_PLACEHOLDER)
    assert environment[hermes_egress.GATEWAY_CREDENTIAL_MODE_ENV] == (
        hermes_egress.PER_TURN_CREDENTIAL_MODE)
    assert secret not in "\n".join(f"{k}={v}" for k, v in environment.items()), (
        "the real key must not reach the child environment")


def test_a_credential_no_longer_costs_a_worker_rollout() -> None:
    """The key is a property of the turn now, not of the worker."""
    source = inspect.getsource(hermes_pool.HermesPool.get_for_user)
    assert "slot.state = \"draining\"\n                if slot.active_turns or not await" not in source, (
        "an authorised turn still drains the worker"
    )
    creation = inspect.getsource(hermes_pool.HermesPool)
    assert "one_shot=authorization is not None" not in creation, (
        "an authorised worker is still one-shot"
    )
    # And the fingerprint that decides rotation no longer includes the key.
    fingerprint = inspect.getsource(hermes_pool.gateway_origin_fingerprint)
    assert "api_key" not in fingerprint.split('"""')[-1], (
        "the rotation fingerprint still depends on the credential"
    )


# --- per-turn gateway credential ------------------------------------------

def test_the_facade_supplies_the_turn_key_so_no_call_site_can_forget() -> None:
    """The shape that removes a whole class of mistake.

    Three call sites reach thread.stream(); two of them pass no credential at
    all. Requiring each to pass one would mean any future call site could omit
    it and silently authenticate as the platform. The facade carries it instead,
    and a caller has to go out of its way to override.
    """
    seen: dict[str, object] = {}

    class FakeThread:
        async def stream(self, prompt, *, current_project=None, trajectory_id=None,
                         project_id=None, gateway_api_key=None):
            seen["gateway_api_key"] = gateway_api_key
            if False:  # pragma: no cover - makes this an async generator
                yield None

    class FakeOwner:
        async def _begin_turn(self, slot): return None
        async def _finish_turn(self, slot): return None

    class FakeSlot:
        thread = FakeThread()

    import asyncio

    facade = hermes_pool._ManagedHermesThread(FakeOwner(), FakeSlot(), "sk-org-A")

    async def drive():
        # A call site that passes nothing still authenticates as this turn.
        async for _ in facade.stream("hi"):
            pass

    asyncio.run(drive())
    assert seen["gateway_api_key"] == "sk-org-A"


def test_platform_and_organisation_keys_both_travel_per_turn(monkeypatch) -> None:
    """A platform turn used to rely on the worker environment. It no longer does."""
    monkeypatch.setattr(hermes_pool, "effective_gateway_credentials",
                        lambda: ("sk-platform-P", "https://gateway.example/v1"))
    assert hermes_pool._resolve_turn_gateway_api_key(None) == "sk-platform-P"

    class Credential:
        api_key = "sk-org-A"
        base_url = "https://gateway.example/v1"

    class Authorization:
        credential = Credential()

    assert hermes_pool._resolve_turn_gateway_api_key(Authorization()) == "sk-org-A"


def test_a_credential_for_another_gateway_is_refused(monkeypatch) -> None:
    """Workers are shared by origin, so a mismatched key must not be sent."""
    monkeypatch.setattr(hermes_pool, "effective_gateway_credentials",
                        lambda: ("sk-platform-P", "https://gateway.example/v1"))

    class Credential:
        api_key = "sk-org-A"
        base_url = "https://other-gateway.example/v1"

    class Authorization:
        credential = Credential()

    with pytest.raises(hermes_pool.GatewayOriginMismatch):
        hermes_pool._resolve_turn_gateway_api_key(Authorization())


def test_no_worker_environment_ever_holds_a_real_key() -> None:
    """Both spawn paths, not just the organisation one.

    A platform-started worker that kept a real key was the dangerous half: an
    organisation turn reusing it would fall back to the platform account the
    moment its _meta went missing.
    """
    source = inspect.getsource(hermes_pool.HermesPool._build_env)
    assert 'env["NEWAPI_API_KEY"] = PER_TURN_CREDENTIAL_PLACEHOLDER' in source
    assert 'env["OPENAI_API_KEY"] = PER_TURN_CREDENTIAL_PLACEHOLDER' in source
    assert 'env["DRAMACLAW_GATEWAY_CREDENTIAL_MODE"] = "per_turn_required"' in source
    assert 'env["NEWAPI_API_KEY"] = api_key' not in source


def test_a_slot_never_retains_a_credential() -> None:
    """A slot outlives the turn; a credential must not."""
    import dataclasses

    fields = {f.name for f in dataclasses.fields(hermes_pool._WorkerSlot)}
    assert "authorization" not in fields, "the slot still retains a real API key"
    assert "slot.authorization" not in inspect.getsource(hermes_pool.HermesPool)
