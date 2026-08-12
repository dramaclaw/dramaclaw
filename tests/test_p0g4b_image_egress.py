from __future__ import annotations

import base64

import pytest

from novelvideo.egress_context import TrustedEgressContext
from novelvideo.ports.authz import BillingPrincipal
from novelvideo.ports.model_credentials import CredentialReference
from novelvideo.ports.model_credentials import RequestCredential
from novelvideo.ports.egress_operations import (
    OperationClaimResult,
    OperationSnapshot,
    OperationState,
)


def _egress_context(*, kind: str) -> TrustedEgressContext:
    organization = kind == "organization"
    return TrustedEgressContext(
        envelope_id=f"env-{kind}",
        project_id="project-image",
        task_type="image_generate",
        requester_user_id="user-image",
        root_task_id="root-image",
        admission_id="admission-image",
        admitted_at="2026-08-03T04:05:00Z",
        membership_id="membership-image" if organization else None,
        authz_version=3,
        billing_principal=BillingPrincipal(
            kind=kind,
            id="org-image" if organization else "user-image",
        ),
        credential=CredentialReference(
            source="organization" if organization else "platform",
            credential_id="credential-image" if organization else "platform-newapi",
            key_version=7 if organization else 1,
            org_id="org-image" if organization else None,
        ),
    )


@pytest.mark.asyncio
async def test_eg08_volc_platform_preserved_and_organization_denied_before_transport(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from novelvideo.generators import image_generator

    generator = image_generator.VolcengineImageGenerator(
        api_key="platform-volc-key",
        endpoint="https://volc.invalid",
    )
    calls: list[str] = []

    async def fake_transport(_params):
        calls.append("volc")
        return "aW1hZ2U="

    monkeypatch.setattr(generator, "_call_seedream_api", fake_transport)

    platform = await generator.generate(
        prompt="platform image",
        egress_context=_egress_context(kind="platform"),
    )
    assert platform.success is True
    assert calls == ["volc"]

    with pytest.raises(Exception) as exc:
        await generator.generate(
            prompt="organization image",
            egress_context=_egress_context(kind="organization"),
        )

    assert getattr(exc.value, "code", None) == "ORG_EGRESS_DENIED"
    assert calls == ["volc"]


class _CredentialPort:
    def __init__(
        self,
        credential: RequestCredential,
        events: list[str] | None = None,
    ) -> None:
        self.credential = credential
        self.admissions: list[object] = []
        self.events = events

    async def resolve(self, admission):
        if self.events is not None:
            self.events.append("resolve")
        self.admissions.append(admission)
        return self.credential


class _OperationPort:
    def __init__(self, events: list[str] | None = None) -> None:
        self.claims: list[object] = []
        self.states: dict[str, OperationSnapshot] = {}
        self.tokens: dict[str, str] = {}
        self.accepted_provider_ids: list[str] = []
        self.events = events

    async def claim(self, *, spec):
        if self.events is not None:
            self.events.append("claim")
        self.claims.append(spec)
        existing = self.states.get(spec.operation_key)
        if existing is not None:
            return OperationClaimResult(won=False, operation=existing)
        snapshot = OperationSnapshot(
            operation_id=f"operation-{len(self.claims)}",
            operation_key=spec.operation_key,
            state=OperationState.DISPATCHING,
            version=1,
        )
        self.states[spec.operation_key] = snapshot
        token = f"transition-{len(self.claims)}"
        self.tokens[snapshot.operation_id] = token
        return OperationClaimResult(
            won=True,
            operation=snapshot,
            transition_token=token,
        )

    async def mark_accepted(
        self,
        *,
        operation_id,
        transition_token,
        expected_version,
        provider_job_id,
    ):
        assert transition_token == self.tokens[operation_id]
        assert expected_version == 1
        assert provider_job_id
        self.accepted_provider_ids.append(provider_job_id)
        current = next(
            value
            for value in self.states.values()
            if value.operation_id == operation_id
        )
        accepted = OperationSnapshot(
            operation_id=operation_id,
            operation_key=current.operation_key,
            state=OperationState.ACCEPTED,
            version=2,
        )
        self.states[current.operation_key] = accepted
        return accepted

    async def mark_completed(
        self,
        *,
        operation_id,
        transition_token,
        expected_version,
        result_ref,
    ):
        assert transition_token == self.tokens[operation_id]
        assert expected_version == 2
        assert result_ref
        current = next(
            value
            for value in self.states.values()
            if value.operation_id == operation_id
        )
        completed = OperationSnapshot(
            operation_id=operation_id,
            operation_key=current.operation_key,
            state=OperationState.COMPLETED,
            version=3,
        )
        self.states[current.operation_key] = completed
        return completed

    async def mark_unknown(self, **_kwargs):
        raise AssertionError("successful fake transport must not become unknown")


@pytest.mark.asyncio
@pytest.mark.parametrize("editing", [False, True], ids=["generate", "edit"])
async def test_eg09a_org_generate_edit_use_exact_credential_claim_once_and_never_fallback(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
    editing: bool,
) -> None:
    import httpx
    import novelvideo.ports as ports
    from novelvideo.generators import nanobanana_grid

    context = _egress_context(kind="organization")
    events: list[str] = []
    credential_port = _CredentialPort(
        RequestCredential(
            reference=context.credential,
            api_key="request-scoped-image-key",
            base_url="https://gateway.invalid/v1",
        ),
        events,
    )
    operation_port = _OperationPort(events)
    monkeypatch.setattr(ports, "get_model_credentials", lambda: credential_port)
    monkeypatch.setattr(ports, "get_egress_operation_port", lambda: operation_port)

    direct_calls: list[str] = []
    for name in (
        "_call_openrouter_image_api",
        "_call_openai_image_api",
        "_call_huimeng_image_api",
    ):

        async def fail_direct(*_args, _name=name, **_kwargs):
            direct_calls.append(_name)
            raise AssertionError("organization image must not use a direct provider")

        monkeypatch.setattr(nanobanana_grid, name, fail_direct)

    posts: list[dict[str, object]] = []

    class FakeResponse:
        headers = {"x-newapi-request-id": "request-image"}

        def raise_for_status(self):
            return None

        def json(self):
            return {
                "id": "response-image",
                "data": [{"b64_json": base64.b64encode(b"image").decode()}],
            }

    class FakeAsyncClient:
        def __init__(self, *_args, **_kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def post(self, url, *, headers, json):
            posts.append({"url": url, "headers": headers, "json": json})
            return FakeResponse()

    monkeypatch.setattr(httpx, "AsyncClient", FakeAsyncClient)

    async def fake_relay(_references):
        return ["https://relay.invalid/reference.png"]

    monkeypatch.setattr(
        nanobanana_grid,
        "_relay_reference_images_for_newapi",
        fake_relay,
    )
    output = tmp_path / ("edit.png" if editing else "generate.png")
    config = {
        "provider": "newapi",
        "api_key": "poison-config-key",
        "base_url": "https://poison.invalid/v1",
        "admitted_at": "2099-01-01T00:00:00Z",
        "model": "frozen-image-model",
        "mode": "1x1",
        "rows": 1,
        "cols": 1,
        "total_panels": 1,
    }
    kwargs = {
        "prompt": "same canonical request",
        "output_path": str(output),
        "config": config,
        "egress_context": context,
    }
    if editing:
        reference = tmp_path / "reference.png"
        reference.write_bytes(b"reference")
        kwargs["reference_images"] = [str(reference)]
        result = await nanobanana_grid.generate_reference_edit_image(**kwargs)
    else:
        result = await nanobanana_grid.generate_text_to_image(**kwargs)

    assert result == output
    assert output.read_bytes() == b"image"
    assert len(posts) == 1
    assert posts[0]["url"].startswith("https://gateway.invalid/v1/images/")
    assert posts[0]["headers"]["Authorization"] == "Bearer request-scoped-image-key"
    assert direct_calls == []
    assert len(credential_port.admissions) == 1
    assert credential_port.admissions[0].admitted_at == context.admitted_at
    assert credential_port.admissions[0].admitted_at != config["admitted_at"]
    assert len(operation_port.claims) == 1
    assert operation_port.claims[0].credential_version == 7
    assert operation_port.claims[0].capability == (
        "image.edit" if editing else "image.generate"
    )
    assert events[:2] == ["claim", "resolve"]

    with pytest.raises(Exception) as replay:
        if editing:
            await nanobanana_grid.generate_reference_edit_image(**kwargs)
        else:
            await nanobanana_grid.generate_text_to_image(**kwargs)
    assert getattr(replay.value, "code", None) == "EGRESS_OPERATION_REPLAYED"
    assert len(posts) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("provider", ["openrouter", "openai", "huimeng", "google"])
async def test_eg09b_org_direct_providers_are_denied_before_transport(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
    provider: str,
) -> None:
    from novelvideo.generators import nanobanana_grid

    calls: list[str] = []

    async def fail_transport(*_args, **_kwargs):
        calls.append(provider)
        raise AssertionError("direct transport must not run")

    monkeypatch.setattr(nanobanana_grid, "_call_openrouter_image_api", fail_transport)
    monkeypatch.setattr(nanobanana_grid, "_call_openai_image_api", fail_transport)
    monkeypatch.setattr(nanobanana_grid, "_call_huimeng_image_api", fail_transport)
    config = {
        "provider": provider,
        "api_key": "poison-direct-key",
        "model": "direct-image-model",
        "mode": "1x1",
        "rows": 1,
        "cols": 1,
        "total_panels": 1,
    }

    with pytest.raises(Exception) as denied:
        await nanobanana_grid.generate_text_to_image(
            prompt="organization direct image",
            output_path=str(tmp_path / "denied.png"),
            config=config,
            egress_context=_egress_context(kind="organization"),
        )

    assert getattr(denied.value, "code", None) == "ORG_EGRESS_DENIED"
    assert calls == []


@pytest.mark.asyncio
async def test_eg10_scene_asset_uses_frozen_gateway_and_never_reselects_backend(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
) -> None:
    import novelvideo.config as config_module
    import novelvideo.ports as ports
    from novelvideo.generators import scene_reference_images
    from novelvideo.models import NovelScene

    context = _egress_context(kind="organization")
    credential_port = _CredentialPort(
        RequestCredential(
            reference=context.credential,
            api_key="scene-request-key",
            base_url="https://scene-gateway.invalid/v1",
        )
    )
    operation_port = _OperationPort()
    monkeypatch.setattr(ports, "get_model_credentials", lambda: credential_port)
    monkeypatch.setattr(ports, "get_egress_operation_port", lambda: operation_port)
    monkeypatch.setattr(
        config_module,
        "get_effective_newapi_gateway_config",
        lambda: pytest.fail(
            "organization scene asset must not reselect gateway config"
        ),
    )
    calls: list[dict[str, object]] = []

    async def fake_newapi(**kwargs):
        calls.append(kwargs)
        kwargs["trace"].update(
            {"request_id": "request-image", "response_id": "response-scene"}
        )
        return b"scene-image", "", ""

    monkeypatch.setattr(scene_reference_images, "_call_newapi_image_api", fake_newapi)

    result = await scene_reference_images.generate_scene_reference_image(
        project_dir=tmp_path,
        scene=NovelScene(name="Hall", environment_prompt="wide hall"),
        kind="master",
        provider="newapi",
        model="frozen-scene-model",
        egress_context=context,
    )

    assert result.read_bytes() == b"scene-image"
    assert len(calls) == 1
    assert calls[0]["api_key"] == "scene-request-key"
    assert calls[0]["base_url"] == "https://scene-gateway.invalid/v1"
    assert len(operation_port.claims) == 1
    assert operation_port.claims[0].capability == "image.asset.scene"


@pytest.mark.asyncio
async def test_eg10_character_and_prop_assets_forward_org_context_to_gateway_adapter(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
) -> None:
    from novelvideo.generators import nanobanana_character, nanobanana_prop

    context = _egress_context(kind="organization")
    calls: list[dict[str, object]] = []

    async def fake_generate_text_to_image(**kwargs):
        calls.append(kwargs)
        output = __import__("pathlib").Path(kwargs["output_path"])
        output.write_bytes(b"asset")
        return output

    async def fake_generate_reference_edit_image(**kwargs):
        calls.append(kwargs)
        output = __import__("pathlib").Path(kwargs["output_path"])
        output.write_bytes(b"identity")
        return output

    monkeypatch.setattr(
        nanobanana_prop,
        "generate_text_to_image",
        fake_generate_text_to_image,
        raising=False,
    )
    monkeypatch.setattr(
        nanobanana_character,
        "generate_text_to_image",
        fake_generate_text_to_image,
        raising=False,
    )
    monkeypatch.setattr(
        nanobanana_character,
        "generate_reference_edit_image",
        fake_generate_reference_edit_image,
        raising=False,
    )

    prop_output = tmp_path / "prop.png"
    prop = await nanobanana_prop.generate_prop_reference(
        "ancient bronze sword",
        str(prop_output),
        model="newapi_gpt_image2",
        egress_context=context,
    )
    character = nanobanana_character.NanoBananaCharacterGenerator(
        config={
            "provider": "newapi",
            "api_key": "poison-character-key",
            "model": "frozen-character-model",
        },
        egress_context=context,
    )
    portrait = await character._generate_single_image(
        client=None,
        prompt="portrait",
        output_path=str(tmp_path / "portrait.png"),
    )
    identity = await character._generate_with_reference(
        client=None,
        prompt="identity",
        reference_image=None,
        reference_image_bytes=b"portrait",
        output_path=str(tmp_path / "identity.png"),
    )

    assert prop == str(prop_output)
    assert portrait == b"asset"
    assert identity == b"identity"
    assert [call["egress_capability"] for call in calls] == [
        "image.asset.prop",
        "image.asset.character",
        "image.asset.character",
    ]
    assert all(call["egress_context"] is context for call in calls)
    assert all(call["config"]["provider"] == "newapi" for call in calls)


@pytest.mark.asyncio
async def test_eg18b_freezone_image_reuses_org_context_and_has_no_direct_fallback(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
) -> None:
    from novelvideo.freezone import jobs

    context = _egress_context(kind="organization")
    calls: list[dict[str, object]] = []

    async def fake_generate(**kwargs):
        calls.append(kwargs)
        __import__("pathlib").Path(kwargs["output_path"]).write_bytes(b"freezone")

    monkeypatch.setattr(
        "novelvideo.generators.nanobanana_grid.generate_text_to_image",
        fake_generate,
    )
    monkeypatch.setattr(
        jobs,
        "_run_volcengine_text_to_image",
        lambda **_kwargs: pytest.fail("organization Freezone must not use Volcengine"),
    )

    output = await jobs.run_freezone_gen(
        project_dir=tmp_path,
        job_id="freezone-image",
        prompt="generate image",
        provider="newapi",
        model="frozen-freezone-model",
        egress_context=context,
    )

    assert output.read_bytes() == b"freezone"
    assert len(calls) == 1
    assert calls[0]["egress_context"] is context
    assert calls[0]["egress_capability"] == "freezone.image.generate"


@pytest.mark.asyncio
async def test_eg18b_freezone_mask_edit_reuses_org_context_and_pins_newapi(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
) -> None:
    """图像擦除也归 EG-18b：组织身份必须一路带到出网点（OI-56 ①）。

    上面那条钉的是 `run_freezone_gen`；擦除此前根本到不了这里（分类表判 DENIED，
    分发器兜底拒绝）。接上形参而不往下透传，就是 OI-48 那种「有形参没接住」的形状，
    分类自洽性检查看不出来——所以断言落在 `generate_reference_edit_image` 实收的
    kwargs 上。

    `config["provider"]` 一并钉死：组织下若沿用 `get_grid_generation_config`，本地
    目录配置可能给出非 newapi provider，会在 `nanobanana_grid.py:138-139` 撞
    ORG_EGRESS_DENIED。这里把那个函数投毒成 volcengine——默认配置恰好也返回
    newapi，不投毒的话这条断言对「组织分支被删掉」是绿的。
    """

    from novelvideo.freezone import jobs

    context = _egress_context(kind="organization")
    calls: list[dict[str, object]] = []

    async def fake_generate_reference_edit_image(**kwargs):
        calls.append(kwargs)
        __import__("pathlib").Path(kwargs["output_path"]).write_bytes(b"erased")

    monkeypatch.setattr(
        "novelvideo.generators.nanobanana_grid.generate_reference_edit_image",
        fake_generate_reference_edit_image,
    )
    monkeypatch.setattr(
        "novelvideo.config.get_grid_generation_config",
        lambda **_kwargs: {"provider": "volcengine", "api_key": "local-directory-key"},
    )
    base = tmp_path / "base.png"
    mask = tmp_path / "mask.png"
    base.write_bytes(b"base")
    mask.write_bytes(b"mask")

    output = await jobs.run_freezone_mask_edit(
        project_dir=tmp_path,
        job_id="freezone-mask-edit",
        base_path=str(base),
        mask_path=str(mask),
        prompt="erase the sign",
        provider="newapi",
        model="frozen-freezone-model",
        egress_context=context,
    )

    assert output.read_bytes() == b"erased"
    assert len(calls) == 1
    assert calls[0]["egress_context"] is context
    assert calls[0]["egress_capability"] == "freezone.image.generate"
    assert calls[0]["config"]["provider"] == "newapi"


@pytest.mark.asyncio
async def test_eg18b_freezone_vision_builds_explicit_transport_from_same_org_credential(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
) -> None:
    import novelvideo.config as config_module
    import novelvideo.ports as ports
    from pydantic_ai.models.test import TestModel
    from novelvideo.freezone import image_node

    context = _egress_context(kind="organization")
    credential_port = _CredentialPort(
        RequestCredential(
            reference=context.credential,
            api_key="vision-request-key",
            base_url="https://vision-gateway.invalid/v1",
        )
    )
    operation_port = _OperationPort()
    monkeypatch.setattr(ports, "get_model_credentials", lambda: credential_port)
    monkeypatch.setattr(ports, "get_egress_operation_port", lambda: operation_port)
    monkeypatch.setattr(
        config_module,
        "get_newapi_text_pydantic_model",
        lambda *_args, **_kwargs: pytest.fail(
            "organization vision must bypass environment/backend model transport"
        ),
    )
    built: list[dict[str, object]] = []

    def fake_explicit_model(model_name, **kwargs):
        built.append({"model_name": model_name, **kwargs})
        return TestModel(custom_output_text="request-scoped vision result")

    monkeypatch.setattr(
        config_module,
        "_newapi_text_openai_model",
        fake_explicit_model,
    )
    image = tmp_path / "source.png"
    image.write_bytes(b"image")

    output = await image_node.reverse_prompt_from_image(
        image_path=image,
        egress_context=context,
    )

    assert output == "request-scoped vision result"
    assert len(built) == 1
    assert built[0]["api_key"] == "vision-request-key"
    assert built[0]["base_url"] == "https://vision-gateway.invalid/v1"
    assert len(operation_port.claims) == 1
    assert operation_port.claims[0].capability == "freezone.vision.analyze"
