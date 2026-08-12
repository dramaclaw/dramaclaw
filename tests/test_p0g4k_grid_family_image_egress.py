"""OI-52：grid 家族 6 个 newapi 图像调用点必须经过出网闸门。

`nanobanana_grid.py` 里 `_call_newapi_image_api` 的调用点中有 6 个既不传 `trace=`
也不传 `egress_context=`，也不经过任何闸门——组织流量在这些路径上无 claim、无组织
凭证解析、无重放保护，平台 Key 替组织垫真实算力。

唯一正确的调用点在 `_generate_image` 内，它的形状（`_prepare_organization_image_egress`
→ 换凭证 → 调叶子 → `_complete_organization_image_egress`）已由
`tests/test_p0g4b_image_egress.py` 钉住。本文件把同一形状钉到 grid 家族的 6 个入口上。

这 6 个入口里只有 `generate_grid` / `reformat_sketch` 当前有活调用者，另 4 个零调用者
——它们照样要有断言，否则复活时会静默重新漏。
"""

from __future__ import annotations

import base64

import pytest

from novelvideo.egress_context import TrustedEgressContext
from novelvideo.model_gateway_runtime import model_gateway_request_scope
from novelvideo.ports.authz import BillingPrincipal
from novelvideo.ports.egress_operations import (
    OperationClaimResult,
    OperationSnapshot,
    OperationState,
)
from novelvideo.ports.model_credentials import CredentialReference, RequestCredential


def _egress_context(*, kind: str, envelope_id: str | None = None) -> TrustedEgressContext:
    organization = kind == "organization"
    return TrustedEgressContext(
        envelope_id=envelope_id or f"env-grid-{kind}",
        project_id="project-grid",
        task_type="grid_generation",
        requester_user_id="user-grid",
        root_task_id="root-grid",
        admission_id="admission-grid",
        admitted_at="2026-08-12T04:05:00Z",
        membership_id="membership-grid" if organization else None,
        authz_version=3,
        billing_principal=BillingPrincipal(
            kind=kind,
            id="org-grid" if organization else "user-grid",
        ),
        credential=CredentialReference(
            source="organization" if organization else "platform",
            credential_id="credential-grid" if organization else "platform-newapi",
            key_version=7 if organization else 1,
            org_id="org-grid" if organization else None,
        ),
    )


class _CredentialPort:
    def __init__(self, credential: RequestCredential, events: list[str]) -> None:
        self.credential = credential
        self.admissions: list[object] = []
        self.events = events

    async def resolve(self, admission):
        self.events.append("resolve")
        self.admissions.append(admission)
        return self.credential


class _OperationPort:
    def __init__(self, events: list[str]) -> None:
        self.claims: list[object] = []
        self.states: dict[str, OperationSnapshot] = {}
        self.tokens: dict[str, str] = {}
        self.completed_refs: list[str] = []
        self.unknowns: list[str] = []
        self.events = events

    async def claim(self, *, spec):
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
        return OperationClaimResult(won=True, operation=snapshot, transition_token=token)

    def _current(self, operation_id: str) -> OperationSnapshot:
        return next(
            value for value in self.states.values() if value.operation_id == operation_id
        )

    async def mark_accepted(
        self, *, operation_id, transition_token, expected_version, provider_job_id
    ):
        assert transition_token == self.tokens[operation_id]
        assert expected_version == 1
        assert provider_job_id
        current = self._current(operation_id)
        accepted = OperationSnapshot(
            operation_id=operation_id,
            operation_key=current.operation_key,
            state=OperationState.ACCEPTED,
            version=2,
        )
        self.states[current.operation_key] = accepted
        return accepted

    async def mark_completed(
        self, *, operation_id, transition_token, expected_version, result_ref
    ):
        assert transition_token == self.tokens[operation_id]
        assert expected_version == 2
        assert result_ref
        self.completed_refs.append(result_ref)
        current = self._current(operation_id)
        completed = OperationSnapshot(
            operation_id=operation_id,
            operation_key=current.operation_key,
            state=OperationState.COMPLETED,
            version=3,
        )
        self.states[current.operation_key] = completed
        return completed

    async def mark_unknown(self, *, operation_id, transition_token, expected_version):
        self.unknowns.append(operation_id)
        return None

    async def mark_rejected_before_submit(
        self, *, operation_id, transition_token, expected_version
    ):
        return None


def _grid_config() -> dict:
    return {
        "provider": "newapi",
        "api_key": "poison-config-key",
        "base_url": "https://poison.invalid/v1",
        "model": "frozen-grid-model",
        "mode": "1x1",
        "rows": 1,
        "cols": 1,
        "batch_size": 1,
        "total_panels": 1,
        "image_size": "1K",
    }


def _png_bytes() -> bytes:
    from io import BytesIO

    from PIL import Image

    buffer = BytesIO()
    Image.new("RGB", (16, 16), (10, 20, 30)).save(buffer, format="PNG")
    return buffer.getvalue()


class _Harness:
    """把 test_p0g4b_image_egress.py 已验证的假件装到 grid 家族入口上。"""

    def __init__(self, monkeypatch, context: TrustedEgressContext) -> None:
        import httpx
        import novelvideo.ports as ports
        from novelvideo.generators import nanobanana_grid

        self.module = nanobanana_grid
        self.context = context
        self.events: list[str] = []
        self.posts: list[dict[str, object]] = []
        self.credential_port = _CredentialPort(
            RequestCredential(
                reference=context.credential,
                api_key="request-scoped-grid-key",
                base_url="https://gateway.invalid/v1",
            ),
            self.events,
        )
        self.operation_port = _OperationPort(self.events)
        monkeypatch.setattr(ports, "get_model_credentials", lambda: self.credential_port)
        monkeypatch.setattr(
            ports, "get_egress_operation_port", lambda: self.operation_port
        )

        posts = self.posts
        image_payload = base64.b64encode(_png_bytes()).decode()

        class FakeResponse:
            headers = {"x-newapi-request-id": "request-grid"}

            def raise_for_status(self):
                return None

            def json(self):
                return {
                    "id": "response-grid",
                    "data": [{"b64_json": image_payload}],
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

        async def fake_relay(_references, **_kwargs):
            return ["https://relay.invalid/reference.png"]

        monkeypatch.setattr(
            nanobanana_grid, "_relay_reference_images_for_newapi", fake_relay
        )

        for name in (
            "_call_openrouter_image_api",
            "_call_openai_image_api",
            "_call_huimeng_image_api",
        ):

            async def fail_direct(*_args, _name=name, **_kwargs):
                raise AssertionError("organization image must not use a direct provider")

            monkeypatch.setattr(nanobanana_grid, name, fail_direct)

    def generator(self):
        return self.module.NanoBananaGridGenerator(
            api_key="poison-config-key", config=_grid_config()
        )


# --- 块 ①：provider 收窄提前到构造点 -------------------------------------------------


def test_organization_grid_generator_denies_direct_provider_at_construction() -> None:
    """组织 + 非 newapi provider 必须在构造点就被拒。

    `_prepare_organization_image_egress:141-142` 已有这条判决，但 grid 家族的 6 个
    调用点根本不经过它，于是 EG-09b 的 `org-denied` 契约对它们从未生效。
    """

    from novelvideo.generators.nanobanana_grid import NanoBananaGridGenerator

    config = _grid_config()
    config["provider"] = "google"

    with model_gateway_request_scope(_egress_context(kind="organization")):
        with pytest.raises(Exception) as denied:
            NanoBananaGridGenerator(api_key="platform-google-key", config=config)

    assert getattr(denied.value, "code", None) == "ORG_EGRESS_DENIED"


def test_platform_grid_generator_keeps_direct_providers() -> None:
    """平台/个人身份下 direct provider 行为零变化——deny 只对组织生效。"""

    from novelvideo.generators.nanobanana_grid import NanoBananaGridGenerator

    config = _grid_config()
    config["provider"] = "google"

    with model_gateway_request_scope(_egress_context(kind="platform")):
        scoped = NanoBananaGridGenerator(api_key="platform-google-key", config=config)
    bare = NanoBananaGridGenerator(api_key="platform-google-key", config=config)

    assert scoped.provider == "google"
    assert bare.provider == "google"


# --- 块 ②③④：6 个入口都要 claim / 换凭证 / complete ---------------------------------


async def _drive_generate_grid(generator, tmp_path):
    return await generator.generate_grid(
        beats=[
            {
                "beat_number": 1,
                "visual_description": "空镜",
                "detected_identities": ["__NO_CHARACTER__"],
            }
        ],
        character_map={},
        style="chinese_period_drama",
        output_path=str(tmp_path / "grid.png"),
        rows=1,
        cols=1,
        sketch=True,
        sketch_dir=str(tmp_path / "sketches"),
    )


async def _drive_reformat_sketch(generator, tmp_path):
    source = tmp_path / "source.png"
    source.write_bytes(_png_bytes())
    return await generator.reformat_sketch(
        source_path=str(source),
        output_path=str(tmp_path / "reformatted.png"),
        target_aspect="9:16",
    )


async def _drive_generate_action_grid(generator, tmp_path):
    return await generator.generate_action_grid(
        action_description="一段连续动作",
        character_map={},
        style="chinese_period_drama",
        output_path=str(tmp_path / "action.png"),
    )


async def _drive_render_single_panel(generator, tmp_path):
    sketch = tmp_path / "panel-sketch.png"
    sketch.write_bytes(_png_bytes())
    return await generator._render_single_panel_gemini(
        sketch_path=str(sketch),
        prompt="渲染这一格",
        output_path=str(tmp_path / "panel.png"),
    )


async def _drive_upscale(generator, tmp_path):
    source = tmp_path / "small.png"
    source.write_bytes(_png_bytes())
    return await generator.upscale_with_nanobanana(
        input_path=str(source),
        output_path=str(tmp_path / "upscaled.png"),
        original_prompt="原始提示词",
    )


async def _drive_single_preview(generator, tmp_path):
    return await generator.generate_single_preview(
        prompt="风格实验",
        style_config={
            "style_instructions": "水墨",
            "avoid_instructions": "避免文字",
        },
        output_path=str(tmp_path / "preview.png"),
    )


_GRID_ENTRIES = [
    ("generate_grid", _drive_generate_grid, "image.generate.grid"),
    ("reformat_sketch", _drive_reformat_sketch, "image.edit.sketch_reformat"),
    ("generate_action_grid", _drive_generate_action_grid, "image.generate.action_grid"),
    (
        "_render_single_panel_gemini",
        _drive_render_single_panel,
        "image.generate.render_panel",
    ),
    ("upscale_with_nanobanana", _drive_upscale, "image.edit.upscale"),
    ("generate_single_preview", _drive_single_preview, "image.generate.preview"),
]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "entry,driver,capability",
    _GRID_ENTRIES,
    ids=[name for name, _driver, _capability in _GRID_ENTRIES],
)
async def test_grid_family_organization_call_claims_resolves_and_completes(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
    entry: str,
    driver,
    capability: str,
) -> None:
    context = _egress_context(kind="organization")
    harness = _Harness(monkeypatch, context)

    with model_gateway_request_scope(context):
        generator = harness.generator()
        await driver(generator, tmp_path)

    assert len(harness.posts) == 1, f"{entry} must reach the gateway exactly once"
    assert harness.posts[0]["url"].startswith("https://gateway.invalid/v1/images/")
    assert (
        harness.posts[0]["headers"]["Authorization"]
        == "Bearer request-scoped-grid-key"
    )
    assert len(harness.operation_port.claims) == 1
    claim = harness.operation_port.claims[0]
    assert claim.capability == capability
    assert claim.credential_version == 7
    assert claim.organization_id == "org-grid"
    assert harness.events[:2] == ["claim", "resolve"]
    assert len(harness.operation_port.completed_refs) == 1
    assert harness.operation_port.completed_refs[0].startswith("image:sha256:")


# --- 块 ②：平台分支必须逐字节透传 ---------------------------------------------------


@pytest.mark.asyncio
async def test_platform_grid_call_passes_through_the_leaf_unchanged(
    monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    """无组织身份时，叶子收到的实参必须与改动前一致——不传 trace、不传 egress_context。

    `tests/test_newapi_image_gateway.py` 有 13 处直调叶子且没注册 egress 端口，
    这条断言保证包装函数不会把它们拖下水。
    """

    from novelvideo.generators import nanobanana_grid

    captured: list[dict[str, object]] = []

    async def fake_leaf(**kwargs):
        captured.append(kwargs)
        return _png_bytes(), "", ""

    monkeypatch.setattr(nanobanana_grid, "_call_newapi_image_api", fake_leaf)

    generator = nanobanana_grid.NanoBananaGridGenerator(
        api_key="platform-newapi-key", config=_grid_config()
    )
    await _drive_generate_grid(generator, tmp_path)

    assert len(captured) == 1
    assert "trace" not in captured[0]
    assert "egress_context" not in captured[0]
    assert captured[0]["api_key"] == "platform-newapi-key"
    assert captured[0]["base_url"] == "https://poison.invalid/v1"


# --- 块 ③：同 envelope 内两次同 capability 不得撞键 -----------------------------------


@pytest.mark.asyncio
async def test_two_calls_in_one_envelope_do_not_collide(
    monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    """`business_task_id` 硬编码成 `envelope_id` 时，同 envelope 的第二次调用会撞键。

    `_render_single_panel_gemini` 用 `asyncio.gather` 扇出 N 路，正踩这个。
    """

    context = _egress_context(kind="organization")
    harness = _Harness(monkeypatch, context)

    with model_gateway_request_scope(context):
        generator = harness.generator()
        await _drive_generate_grid(generator, tmp_path / "first")
        await _drive_generate_grid(generator, tmp_path / "second")

    assert len(harness.operation_port.claims) == 2
    business_task_ids = {claim.business_task_id for claim in harness.operation_port.claims}
    assert len(business_task_ids) == 2
    assert len(harness.operation_port.completed_refs) == 2


# --- 块 ⑤：`_generate_image` 的 ambient 漏洞 -----------------------------------------


@pytest.mark.asyncio
async def test_generate_image_forwards_ambient_organization_context_to_the_leaf(
    monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    """只有 ambient 组织身份时，转发给叶子的 `egress_context=` 不能是 None。

    否则参考图中继静默走平台分支，而不是 `relay_tenant_image_bytes_from_context`。
    claim 本身没漏（`_prepare_organization_image_egress` 内部自己回落），漏的是中继身份。
    """

    from novelvideo.generators import nanobanana_grid

    context = _egress_context(kind="organization")
    harness = _Harness(monkeypatch, context)

    seen: list[object] = []
    original_leaf = nanobanana_grid._call_newapi_image_api

    async def spy_leaf(**kwargs):
        seen.append(kwargs.get("egress_context"))
        return await original_leaf(**kwargs)

    monkeypatch.setattr(nanobanana_grid, "_call_newapi_image_api", spy_leaf)

    reference = tmp_path / "reference.png"
    reference.write_bytes(_png_bytes())

    with model_gateway_request_scope(context):
        await nanobanana_grid.generate_reference_edit_image(
            prompt="edit under ambient identity",
            reference_images=[str(reference)],
            output_path=str(tmp_path / "edited.png"),
            config=_grid_config(),
        )

    assert seen == [context]
    assert len(harness.posts) == 1
