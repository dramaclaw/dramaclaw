from __future__ import annotations

import asyncio
import json

import pytest

from novelvideo import config
from novelvideo.embedding_models import (
    COGNEE_EMBEDDING_MODEL_LEGACY,
    COGNEE_EMBEDDING_MODEL_V1,
    COGNEE_EMBEDDING_MODEL_V2,
    PROJECT_EMBEDDING_DIMENSION_KEY,
    embedding_model_binding_for_new_project,
    embedding_model_for_legacy_project,
    embedding_model_for_new_project,
    embedding_gateway_credentials,
    embedding_model_scope,
    embedding_model_spec,
    require_current_embedding_model_spec,
)
from novelvideo.model_gateway_settings import (
    MODE_CUSTOM,
    MODE_OFFICIAL,
    save_custom_newapi_gateway,
    save_newapi_embedding_model_config,
    save_official_newapi_key,
    set_model_gateway_mode,
)
from novelvideo.project_config import (
    ensure_cognee_embedding_binding_in_state_dir,
    ensure_cognee_embedding_model_in_state_dir,
)


def _isolate_ce(monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
    monkeypatch.setattr(config, "STATE_DIR", str(tmp_path / "state-root"))
    monkeypatch.setenv("ST_EDITION", "ce")
    monkeypatch.delenv("ST_CONTROL_PLANE_DSN", raising=False)


def test_new_and_legacy_official_projects_bind_v2_and_v1(monkeypatch, tmp_path):
    _isolate_ce(monkeypatch, tmp_path)
    set_model_gateway_mode(MODE_OFFICIAL)

    assert embedding_model_for_new_project() == COGNEE_EMBEDDING_MODEL_V2
    assert embedding_model_for_legacy_project() == COGNEE_EMBEDDING_MODEL_V1


def test_ce_custom_projects_bind_unversioned_model(monkeypatch, tmp_path):
    _isolate_ce(monkeypatch, tmp_path)
    save_custom_newapi_gateway(
        base_url="http://new-api:3000",
        api_key="sk-custom",
        activate=True,
    )

    assert embedding_model_for_new_project() == COGNEE_EMBEDDING_MODEL_LEGACY
    assert embedding_model_for_legacy_project() == COGNEE_EMBEDDING_MODEL_LEGACY


def test_ce_custom_new_project_snapshots_configured_dimensions(monkeypatch, tmp_path):
    _isolate_ce(monkeypatch, tmp_path)
    save_custom_newapi_gateway(
        base_url="http://new-api:3000",
        api_key="sk-custom",
        activate=True,
    )
    save_newapi_embedding_model_config(
        provider="ali",
        upstream_model="Qwen3-Embedding-8B",
        dimension=3072,
        send_dimensions=False,
    )

    binding = embedding_model_binding_for_new_project()

    assert binding.internal_model == COGNEE_EMBEDDING_MODEL_LEGACY
    assert binding.dimensions == 3072
    assert binding.send_dimensions is True


def test_project_model_keeps_its_gateway_after_active_mode_switch(monkeypatch, tmp_path):
    _isolate_ce(monkeypatch, tmp_path)
    save_official_newapi_key(api_key="sk-official", activate=True)
    save_custom_newapi_gateway(
        base_url="http://new-api:3000",
        api_key="sk-custom",
        activate=True,
    )

    official = embedding_gateway_credentials(
        embedding_model_spec(COGNEE_EMBEDDING_MODEL_V1)
    )
    custom = embedding_gateway_credentials(
        embedding_model_spec(COGNEE_EMBEDDING_MODEL_LEGACY)
    )

    assert official == ("sk-official", "https://relayclaw.cdnfg.com/v1")
    assert custom == ("sk-custom", "http://new-api:3000/v1")


def test_legacy_project_binding_is_backfilled_once(monkeypatch, tmp_path):
    _isolate_ce(monkeypatch, tmp_path)
    set_model_gateway_mode(MODE_OFFICIAL)
    state_dir = tmp_path / "project-state"
    state_dir.mkdir()
    config_path = state_dir / "project_config.json"
    config_path.write_text('{"visual_style":"cinematic"}', encoding="utf-8")

    assert (
        ensure_cognee_embedding_model_in_state_dir(state_dir)
        == COGNEE_EMBEDDING_MODEL_V1
    )
    persisted = json.loads(config_path.read_text(encoding="utf-8"))
    assert persisted == {
        "visual_style": "cinematic",
        "cognee_embedding_model": COGNEE_EMBEDDING_MODEL_V1,
        PROJECT_EMBEDDING_DIMENSION_KEY: 1024,
    }

    set_model_gateway_mode(MODE_CUSTOM)
    assert (
        ensure_cognee_embedding_model_in_state_dir(state_dir)
        == COGNEE_EMBEDDING_MODEL_V1
    )


@pytest.mark.parametrize(
    "payload",
    ["not-json", "[]", '{"cognee_embedding_model":"unknown"}'],
)
def test_invalid_project_embedding_config_fails_closed(
    monkeypatch,
    tmp_path,
    payload,
):
    _isolate_ce(monkeypatch, tmp_path)
    set_model_gateway_mode(MODE_OFFICIAL)
    state_dir = tmp_path / "project-state"
    state_dir.mkdir()
    (state_dir / "project_config.json").write_text(payload, encoding="utf-8")

    with pytest.raises(RuntimeError):
        ensure_cognee_embedding_model_in_state_dir(state_dir)


def test_fixed_official_model_specs():
    v1 = embedding_model_spec(COGNEE_EMBEDDING_MODEL_V1)
    v2 = embedding_model_spec(COGNEE_EMBEDDING_MODEL_V2)

    assert (v1.gateway, v1.dimensions, v1.send_dimensions) == (
        MODE_OFFICIAL,
        1024,
        True,
    )
    assert (v2.gateway, v2.dimensions, v2.send_dimensions) == (
        MODE_OFFICIAL,
        1024,
        True,
    )


def test_official_project_dimension_mismatch_fails_closed():
    with pytest.raises(RuntimeError, match="does not match"):
        embedding_model_spec(
            COGNEE_EMBEDDING_MODEL_V2,
            dimensions=3072,
        )


def test_ce_custom_spec_uses_project_dimensions_and_internal_send_policy(
    monkeypatch,
    tmp_path,
):
    _isolate_ce(monkeypatch, tmp_path)
    save_newapi_embedding_model_config(
        provider="ali",
        upstream_model="Qwen3-Embedding-8B",
        dimension=1024,
        send_dimensions=False,
    )

    spec = embedding_model_spec(
        COGNEE_EMBEDDING_MODEL_LEGACY,
        dimensions=3072,
    )

    assert spec.gateway == MODE_CUSTOM
    assert spec.dimensions == 3072
    assert spec.send_dimensions is True


def test_existing_custom_project_keeps_backfilled_1024_dimensions(
    monkeypatch,
    tmp_path,
):
    _isolate_ce(monkeypatch, tmp_path)
    save_custom_newapi_gateway(
        base_url="http://new-api:3000",
        api_key="sk-custom",
        activate=True,
    )
    save_newapi_embedding_model_config(
        provider="ali",
        upstream_model="Qwen3-Embedding-8B",
        dimension=3072,
    )
    state_dir = tmp_path / "project-state"
    state_dir.mkdir()
    config_path = state_dir / "project_config.json"
    config_path.write_text(
        json.dumps({"cognee_embedding_model": COGNEE_EMBEDDING_MODEL_LEGACY}),
        encoding="utf-8",
    )

    binding = ensure_cognee_embedding_binding_in_state_dir(state_dir)

    assert binding.dimensions == 1024
    assert json.loads(config_path.read_text(encoding="utf-8"))[
        PROJECT_EMBEDDING_DIMENSION_KEY
    ] == 1024


@pytest.mark.asyncio
async def test_embedding_model_scope_is_isolated_between_concurrent_tasks():
    ready = asyncio.Event()
    seen: list[tuple[str, str]] = []

    async def read_scoped(model: str) -> None:
        with embedding_model_scope(model):
            before = require_current_embedding_model_spec().internal_model
            ready.set()
            await asyncio.sleep(0)
            after = require_current_embedding_model_spec().internal_model
            seen.append((before, after))

    await asyncio.gather(
        read_scoped(COGNEE_EMBEDDING_MODEL_V1),
        read_scoped(COGNEE_EMBEDDING_MODEL_V2),
    )
    await ready.wait()

    assert sorted(seen) == [
        (COGNEE_EMBEDDING_MODEL_V1, COGNEE_EMBEDDING_MODEL_V1),
        (COGNEE_EMBEDDING_MODEL_V2, COGNEE_EMBEDDING_MODEL_V2),
    ]
    with pytest.raises(RuntimeError, match="no project model context"):
        require_current_embedding_model_spec()


@pytest.mark.asyncio
async def test_custom_project_dimensions_are_isolated_between_concurrent_tasks(
    monkeypatch,
    tmp_path,
):
    _isolate_ce(monkeypatch, tmp_path)

    async def read_scoped(dimensions: int) -> int:
        with embedding_model_scope(
            COGNEE_EMBEDDING_MODEL_LEGACY,
            dimensions=dimensions,
        ):
            await asyncio.sleep(0)
            return require_current_embedding_model_spec().dimensions

    first, second = await asyncio.gather(
        read_scoped(768),
        read_scoped(3072),
    )

    assert (first, second) == (768, 3072)


def test_cognee_vector_size_follows_project_scope(monkeypatch, tmp_path):
    _isolate_ce(monkeypatch, tmp_path)
    from cognee.infrastructure.databases.vector.embeddings.LiteLLMEmbeddingEngine import (
        LiteLLMEmbeddingEngine,
    )

    from novelvideo.cognee import config as cognee_config

    cognee_config._patch_cognee_embedding_gateway()
    engine = LiteLLMEmbeddingEngine.__new__(LiteLLMEmbeddingEngine)
    engine.dimensions = 1024

    with embedding_model_scope(
        COGNEE_EMBEDDING_MODEL_LEGACY,
        dimensions=3072,
    ):
        assert engine.get_vector_size() == 3072

    assert engine.get_vector_size() == 1024


def test_litellm_kwargs_follow_project_model(monkeypatch):
    from novelvideo.cognee import config as cognee_config

    monkeypatch.setattr(
        cognee_config,
        "embedding_gateway_credentials",
        lambda spec: (f"key-{spec.gateway}", f"https://{spec.gateway}.example/v1"),
    )

    with embedding_model_scope(COGNEE_EMBEDDING_MODEL_V1):
        v1 = cognee_config._project_embedding_request_kwargs(
            {
                "model": "wrong",
                "dimensions": 999,
                "allowed_openai_params": ["dimensions"],
            }
        )
    with embedding_model_scope(COGNEE_EMBEDDING_MODEL_V2):
        v2 = cognee_config._project_embedding_request_kwargs({"model": "wrong"})

    assert v1["model"] == "openai/DC-cognee-embedding-v1"
    assert v1["dimensions"] == 1024
    assert v1["allowed_openai_params"] == ["dimensions"]
    assert v1["api_base"] == "https://official.example/v1"
    assert v2["model"] == "openai/DC-cognee-embedding-v2"
    assert v2["dimensions"] == 1024
    assert v2["allowed_openai_params"] == ["dimensions"]
    assert v2["api_key"] == "key-official"

    from litellm.utils import get_optional_params_embeddings

    optional_params = get_optional_params_embeddings(
        model=v2["model"],
        dimensions=v2["dimensions"],
        custom_llm_provider=v2["custom_llm_provider"],
        allowed_openai_params=v2["allowed_openai_params"],
    )
    assert optional_params["dimensions"] == 1024


@pytest.mark.asyncio
async def test_concurrent_embedding_requests_do_not_cross_models(monkeypatch):
    from novelvideo.cognee import config as cognee_config

    monkeypatch.setattr(
        cognee_config,
        "embedding_gateway_credentials",
        lambda spec: ("key", f"https://{spec.internal_model}.example/v1"),
    )

    async def route(model: str) -> dict:
        with embedding_model_scope(model):
            await asyncio.sleep(0)
            return cognee_config._project_embedding_request_kwargs(
                {"model": "global-default", "dimensions": 999}
            )

    v1, v2 = await asyncio.gather(
        route(COGNEE_EMBEDDING_MODEL_V1),
        route(COGNEE_EMBEDDING_MODEL_V2),
    )

    assert v1["model"] == "openai/DC-cognee-embedding-v1"
    assert v1["dimensions"] == 1024
    assert v1["allowed_openai_params"] == ["dimensions"]
    assert v2["model"] == "openai/DC-cognee-embedding-v2"
    assert v2["dimensions"] == 1024
    assert v2["allowed_openai_params"] == ["dimensions"]


@pytest.mark.asyncio
async def test_dimension_mismatch_refunds_reserved_embedding_credit(monkeypatch):
    from novelvideo.cognee import config as cognee_config

    class UsageMeter:
        def __init__(self):
            self.reserve: list[dict] = []
            self.refunds: list[str] = []
            self.bumps: list[dict] = []

        async def reserve_current_model_call_credit(self, **kwargs):
            self.reserve.append(kwargs)
            return "embedding-reservation"

        async def refund_model_call_credit_reservation(
            self,
            reservation_id,
            *,
            metadata=None,
        ):
            self.refunds.append(reservation_id)

        async def bump_model_call(self, **kwargs):
            self.bumps.append(kwargs)

    meter = UsageMeter()
    monkeypatch.setattr(cognee_config, "get_usage_meter", lambda: meter)

    async def wrong_dimensions():
        return [[0.0] * 4096]

    with embedding_model_scope(COGNEE_EMBEDDING_MODEL_V2):
        with pytest.raises(
            RuntimeError,
            match="Embedding dimension mismatch: expected 1024, received 4096",
        ):
            await cognee_config._run_project_embedding_with_billing(
                wrong_dimensions,
                expected_count=1,
            )

    assert meter.reserve[0]["model"] == COGNEE_EMBEDDING_MODEL_V2
    assert meter.refunds == ["embedding-reservation"]
    assert meter.bumps == []


@pytest.mark.asyncio
async def test_successful_embedding_bills_the_project_model(monkeypatch):
    from novelvideo.cognee import config as cognee_config

    class UsageMeter:
        def __init__(self):
            self.bump: dict | None = None

        async def reserve_current_model_call_credit(self, **_kwargs):
            return "embedding-reservation"

        async def refund_model_call_credit_reservation(self, *_args, **_kwargs):
            raise AssertionError("successful embedding must not be refunded")

        async def bump_model_call(self, **kwargs):
            self.bump = kwargs

    meter = UsageMeter()
    monkeypatch.setattr(cognee_config, "get_usage_meter", lambda: meter)

    async def valid_embedding():
        return [[0.0] * 1024]

    with embedding_model_scope(COGNEE_EMBEDDING_MODEL_V1):
        result = await cognee_config._run_project_embedding_with_billing(
            valid_embedding,
            expected_count=1,
        )

    assert len(result[0]) == 1024
    assert meter.bump is not None
    assert meter.bump["model"] == COGNEE_EMBEDDING_MODEL_V1
    assert meter.bump["credit_reservation_id"] == "embedding-reservation"
