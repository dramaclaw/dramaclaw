import asyncio
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace

import pytest
from tenacity import retry, stop_after_delay, wait_fixed


def test_cognee_pipeline_concurrency_defaults(monkeypatch):
    from novelvideo.cognee.concurrency import get_cognee_concurrency_config

    monkeypatch.delenv("COGNEE_LLM_CONCURRENCY", raising=False)
    monkeypatch.delenv("COGNEE_EMBEDDING_BATCH_CONCURRENCY", raising=False)

    config = get_cognee_concurrency_config()

    assert config.llm == 2
    assert config.embedding_batch == 4


def test_cognee_pipeline_concurrency_accepts_positive_overrides(monkeypatch):
    from novelvideo.cognee.concurrency import get_cognee_concurrency_config

    monkeypatch.setenv("COGNEE_LLM_CONCURRENCY", "3")
    monkeypatch.setenv("COGNEE_EMBEDDING_BATCH_CONCURRENCY", "6")

    config = get_cognee_concurrency_config()

    assert config.llm == 3
    assert config.embedding_batch == 6


@pytest.mark.parametrize("value", ["0", "-1", "abc", "1.5"])
@pytest.mark.parametrize(
    "key",
    ["COGNEE_LLM_CONCURRENCY", "COGNEE_EMBEDDING_BATCH_CONCURRENCY"],
)
def test_cognee_pipeline_concurrency_rejects_invalid_values(
    monkeypatch, key, value
):
    from novelvideo.cognee.concurrency import get_cognee_concurrency_config

    monkeypatch.setenv(key, value)

    with pytest.raises(ValueError, match=key):
        get_cognee_concurrency_config()


@pytest.mark.asyncio
async def test_llm_queue_wait_does_not_consume_retry_budget():
    from novelvideo.cognee.concurrency import (
        CogneeConcurrencyConfig,
        cognee_pipeline_concurrency,
        install_llm_adapter_concurrency,
    )

    attempts = 0

    class Adapter:
        @retry(stop=stop_after_delay(0.03), wait=wait_fixed(0), reraise=True)
        async def acreate_structured_output(self, name: str) -> str:
            nonlocal attempts
            if name == "blocker":
                await asyncio.sleep(0.05)
                return "ok"
            attempts += 1
            if attempts == 1:
                raise RuntimeError("transient")
            return "recovered"

    install_llm_adapter_concurrency(Adapter)

    async with cognee_pipeline_concurrency(
        CogneeConcurrencyConfig(llm=1, embedding_batch=1)
    ):
        adapter = Adapter()
        blocker = asyncio.create_task(
            adapter.acreate_structured_output("blocker")
        )
        await asyncio.sleep(0)
        queued = asyncio.create_task(adapter.acreate_structured_output("queued"))

        assert await blocker == "ok"
        assert await queued == "recovered"

    assert attempts == 2


@pytest.mark.asyncio
async def test_graph_and_summary_share_one_llm_limit():
    from novelvideo.cognee.concurrency import (
        CogneeConcurrencyConfig,
        cognee_pipeline_concurrency,
        llm_pipeline_limiter,
    )

    active = 0
    peak = 0

    async def request(_source: str) -> None:
        nonlocal active, peak
        async with llm_pipeline_limiter:
            active += 1
            peak = max(peak, active)
            await asyncio.sleep(0.01)
            active -= 1

    async with cognee_pipeline_concurrency(
        CogneeConcurrencyConfig(llm=2, embedding_batch=4)
    ):
        await asyncio.gather(
            *(request("graph") for _ in range(6)),
            *(request("summary") for _ in range(6)),
        )

    assert peak == 2


@pytest.mark.asyncio
async def test_embedding_batches_share_pipeline_limit():
    from novelvideo.cognee.concurrency import (
        CogneeConcurrencyConfig,
        cognee_pipeline_concurrency,
        embedding_pipeline_limiter,
    )

    active = 0
    peak = 0

    async def request() -> None:
        nonlocal active, peak
        async with embedding_pipeline_limiter:
            active += 1
            peak = max(peak, active)
            await asyncio.sleep(0.01)
            active -= 1

    async with cognee_pipeline_concurrency(
        CogneeConcurrencyConfig(llm=2, embedding_batch=4)
    ):
        await asyncio.gather(*(request() for _ in range(12)))

    assert peak == 4


@pytest.mark.asyncio
async def test_embedding_scheduler_enters_vector_engine_after_admission():
    from novelvideo.cognee.concurrency import (
        CogneeConcurrencyConfig,
        build_limited_index_data_points,
        cognee_pipeline_concurrency,
    )

    active = 0
    peak = 0

    class CustomEmbeddingEngine:
        provider = "custom"

    class VectorEngine:
        embedding_engine = CustomEmbeddingEngine()

        async def index_data_points(self, *_args) -> None:
            nonlocal active, peak
            active += 1
            peak = max(peak, active)
            await asyncio.sleep(0.01)
            active -= 1

    async def scheduler(_points, vector_engine=None):
        await asyncio.gather(
            *(
                vector_engine.index_data_points("Type", "name", [index])
                for index in range(12)
            )
        )

    limited_scheduler = build_limited_index_data_points(
        scheduler,
        CustomEmbeddingEngine,
    )

    async with cognee_pipeline_concurrency(
        CogneeConcurrencyConfig(llm=2, embedding_batch=4)
    ):
        await limited_scheduler([], vector_engine=VectorEngine())

    assert peak == 4


@pytest.mark.asyncio
async def test_embedding_scheduler_preserves_vector_engine_type_identity():
    from novelvideo.cognee.concurrency import (
        CogneeConcurrencyConfig,
        build_limited_index_data_points,
        cognee_pipeline_concurrency,
    )

    class CustomEmbeddingEngine:
        provider = "custom"

    class VectorEngine:
        embedding_engine = CustomEmbeddingEngine()

    original_engine = VectorEngine()

    async def scheduler(_points, vector_engine=None):
        assert isinstance(vector_engine, VectorEngine)
        assert vector_engine.embedding_engine is original_engine.embedding_engine

    limited_scheduler = build_limited_index_data_points(
        scheduler,
        CustomEmbeddingEngine,
    )

    async with cognee_pipeline_concurrency(
        CogneeConcurrencyConfig(llm=1, embedding_batch=1)
    ):
        await limited_scheduler([], vector_engine=original_engine)


@pytest.mark.asyncio
async def test_embedding_queue_wait_does_not_consume_retry_budget():
    from novelvideo.cognee.concurrency import (
        CogneeConcurrencyConfig,
        build_limited_index_data_points,
        cognee_pipeline_concurrency,
    )

    attempts = 0

    class CustomEmbeddingEngine:
        provider = "custom"

    class VectorEngine:
        embedding_engine = CustomEmbeddingEngine()

        @retry(stop=stop_after_delay(0.03), wait=wait_fixed(0), reraise=True)
        async def index_data_points(self, name: str) -> str:
            nonlocal attempts
            if name == "blocker":
                await asyncio.sleep(0.05)
                return "ok"
            attempts += 1
            if attempts == 1:
                raise RuntimeError("transient")
            return "recovered"

    async def scheduler(_points, vector_engine=None):
        blocker = asyncio.create_task(vector_engine.index_data_points("blocker"))
        await asyncio.sleep(0)
        queued = asyncio.create_task(vector_engine.index_data_points("queued"))
        return await asyncio.gather(blocker, queued)

    limited_scheduler = build_limited_index_data_points(
        scheduler,
        CustomEmbeddingEngine,
    )

    async with cognee_pipeline_concurrency(
        CogneeConcurrencyConfig(llm=1, embedding_batch=1)
    ):
        assert await limited_scheduler([], vector_engine=VectorEngine()) == [
            "ok",
            "recovered",
        ]

    assert attempts == 2


@pytest.mark.asyncio
async def test_embedding_scheduler_logs_once_when_other_provider_is_not_limited(
    monkeypatch,
):
    from novelvideo.cognee import concurrency
    from novelvideo.cognee.concurrency import (
        CogneeConcurrencyConfig,
        build_limited_index_data_points,
        cognee_pipeline_concurrency,
    )

    class CustomEmbeddingEngine:
        pass

    class OtherEmbeddingEngine:
        provider = "openai"

    original_engine = SimpleNamespace(embedding_engine=OtherEmbeddingEngine())
    received_engine = None
    info_calls = []
    monkeypatch.setattr(
        concurrency.logger,
        "info",
        lambda message, *args: info_calls.append(message % args),
    )

    async def scheduler(_points, vector_engine=None):
        nonlocal received_engine
        received_engine = vector_engine

    limited_scheduler = build_limited_index_data_points(
        scheduler,
        CustomEmbeddingEngine,
    )

    async with cognee_pipeline_concurrency(
        CogneeConcurrencyConfig(llm=1, embedding_batch=1)
    ):
        await limited_scheduler([], vector_engine=original_engine)
        await limited_scheduler([], vector_engine=original_engine)

    assert received_engine is original_engine
    bypass_logs = [
        message for message in info_calls if "embedding concurrency bypassed" in message
    ]
    assert len(bypass_logs) == 1
    assert "OtherEmbeddingEngine" in bypass_logs[0]


@pytest.mark.asyncio
async def test_limiters_are_noops_outside_pipeline_context(monkeypatch):
    from novelvideo.cognee import concurrency
    from novelvideo.cognee.concurrency import (
        embedding_pipeline_limiter,
        llm_pipeline_limiter,
    )

    debug_calls = []
    monkeypatch.setattr(
        concurrency.logger,
        "debug",
        lambda message, *args: debug_calls.append(message % args),
    )

    async with llm_pipeline_limiter:
        pass
    async with embedding_pipeline_limiter:
        pass

    assert any("llm" in message for message in debug_calls)
    assert any("embedding_batch" in message for message in debug_calls)


def _fake_rate_limiting_module(*, llm_rate=False, embedding_rate=False):
    return SimpleNamespace(
        llm_config=SimpleNamespace(
            llm_rate_limit_enabled=llm_rate,
            embedding_rate_limit_enabled=embedding_rate,
        ),
        llm_rate_limiter=object(),
        embedding_rate_limiter=object(),
    )


def _fake_installer_bindings():
    class Adapter:
        async def acreate_structured_output(self):
            return None

    class EmbeddingEngine:
        provider = "custom"

    async def index_data_points(_points, vector_engine=None):
        return vector_engine

    targets = [SimpleNamespace(index_data_points=index_data_points) for _ in range(3)]
    return Adapter, EmbeddingEngine, index_data_points, targets


def test_installer_wraps_current_provider_without_enabling_native_limiters():
    from novelvideo.cognee.concurrency import install_cognee_pipeline_concurrency

    module = _fake_rate_limiting_module()
    original_llm_limiter = module.llm_rate_limiter
    original_embedding_limiter = module.embedding_rate_limiter
    adapter, embedding_engine, index_data_points, targets = (
        _fake_installer_bindings()
    )

    install_cognee_pipeline_concurrency(
        module,
        cognee_version="1.0.5",
        generic_adapter_class=adapter,
        embedding_engine_class=embedding_engine,
        index_data_points_function=index_data_points,
        index_data_points_targets=targets,
    )

    assert module.llm_rate_limiter is original_llm_limiter
    assert module.embedding_rate_limiter is original_embedding_limiter
    assert module.llm_config.llm_rate_limit_enabled is False
    assert module.llm_config.embedding_rate_limit_enabled is False
    assert adapter.acreate_structured_output._novelvideo_concurrency_wrapped is True
    assert all(
        target.index_data_points._novelvideo_concurrency_wrapped is True
        for target in targets
    )
    assert len({id(target.index_data_points) for target in targets}) == 1


def test_installer_is_idempotent():
    from novelvideo.cognee.concurrency import install_cognee_pipeline_concurrency

    module = _fake_rate_limiting_module()
    adapter, embedding_engine, index_data_points, targets = (
        _fake_installer_bindings()
    )

    kwargs = {
        "cognee_version": "1.0.5",
        "generic_adapter_class": adapter,
        "embedding_engine_class": embedding_engine,
        "index_data_points_function": index_data_points,
        "index_data_points_targets": targets,
    }
    install_cognee_pipeline_concurrency(module, **kwargs)
    first_llm = adapter.acreate_structured_output
    first_embedding = targets[0].index_data_points
    install_cognee_pipeline_concurrency(module, **kwargs)

    assert adapter.acreate_structured_output is first_llm
    assert targets[0].index_data_points is first_embedding


@pytest.mark.parametrize("kind", ["llm", "embedding"])
def test_installer_rejects_native_rate_limiter_conflict(kind):
    from novelvideo.cognee.concurrency import install_cognee_pipeline_concurrency

    module = _fake_rate_limiting_module(
        llm_rate=kind == "llm", embedding_rate=kind == "embedding"
    )

    with pytest.raises(ValueError, match="native rate limit"):
        install_cognee_pipeline_concurrency(module, cognee_version="1.0.5")


def test_installer_rejects_unsupported_cognee_version():
    from novelvideo.cognee.concurrency import install_cognee_pipeline_concurrency

    with pytest.raises(RuntimeError, match="1.0.5"):
        install_cognee_pipeline_concurrency(
            _fake_rate_limiting_module(), cognee_version="1.1.0"
        )


def test_import_time_install_failure_is_deferred(monkeypatch):
    from novelvideo.cognee import config

    warnings = []

    def fail_install() -> None:
        raise ValueError("COGNEE_LLM_CONCURRENCY must be a positive integer")

    monkeypatch.setattr(config, "_install_cognee_pipeline_concurrency", fail_install)
    monkeypatch.setattr(
        config.logger,
        "warning",
        lambda message, *args: warnings.append(message % args),
    )

    config._install_cognee_pipeline_concurrency_on_import()

    assert "deferred" in warnings[-1]
    assert "COGNEE_LLM_CONCURRENCY" in warnings[-1]


def test_init_cognee_does_not_swallow_concurrency_install_failure(monkeypatch):
    from novelvideo.cognee import config

    fake_config = SimpleNamespace(
        set_llm_provider=lambda _value: None,
        set_llm_model=lambda _value: None,
        set_llm_api_key=lambda _value: None,
        set_embedding_provider=lambda _value: None,
        set_embedding_model=lambda _value: None,
        set_embedding_dimensions=lambda _value: None,
        set_embedding_api_key=lambda _value: None,
    )
    monkeypatch.setattr(config, "COGNEE_AVAILABLE", True)
    monkeypatch.setattr(config, "cognee", SimpleNamespace(config=fake_config))
    monkeypatch.setattr(config, "cognee_gateway_restart_required", lambda: False)
    monkeypatch.setattr(config, "_resolve_llm_provider", lambda: "newapi")
    monkeypatch.setattr(config, "_resolve_llm_api_key", lambda *_args: "fake-key")
    monkeypatch.setattr(config, "_apply_llm_env", lambda *_args: None)
    monkeypatch.setattr(
        config,
        "_apply_embedding_env",
        lambda _provider, _key: ("openai", "embedding", "1024", "fake-key"),
    )
    monkeypatch.setattr(config, "_apply_cognee_runtime_defaults", lambda: None)
    monkeypatch.setattr(config, "_patch_cognee_embedding_timeout", lambda: None)
    monkeypatch.setattr(config, "_install_insufficient_credits_log_filter", lambda: None)
    monkeypatch.setattr(config, "_patch_cognee_embedding_gateway", lambda: None)
    monkeypatch.setattr(
        config,
        "_install_cognee_pipeline_concurrency",
        lambda: (_ for _ in ()).throw(RuntimeError("unsupported Cognee")),
    )

    with pytest.raises(RuntimeError, match="unsupported Cognee"):
        config.init_cognee()


def test_strict_installer_does_not_log_separately_parsed_limits(monkeypatch):
    from novelvideo.cognee import config

    info_calls = []
    monkeypatch.setattr(config, "install_cognee_pipeline_concurrency", lambda: None)
    monkeypatch.setattr(
        config.logger,
        "info",
        lambda message, *args: info_calls.append(message % args),
    )

    config._install_cognee_pipeline_concurrency()

    assert info_calls == []


def test_dramaclaw_installs_retry_safe_bindings_into_cognee():
    from cognee.infrastructure.llm.structured_output_framework.litellm_instructor.llm.generic_llm_api.adapter import (
        GenericAPIAdapter,
    )
    from cognee.shared import rate_limiting
    from cognee.tasks.storage import add_data_points as add_data_points_function
    import importlib

    add_data_points_module = importlib.import_module(
        "cognee.tasks.storage.add_data_points"
    )

    assert rate_limiting.llm_config.llm_rate_limit_enabled is False
    assert rate_limiting.llm_config.embedding_rate_limit_enabled is False
    assert (
        GenericAPIAdapter.acreate_structured_output._novelvideo_concurrency_wrapped
        is True
    )
    assert (
        add_data_points_module.index_data_points._novelvideo_concurrency_wrapped
        is True
    )
    assert callable(add_data_points_function)


def test_installer_replaces_every_loaded_cognee_index_alias():
    import importlib
    import sys

    import novelvideo.cognee.config  # noqa: F401

    index_module = importlib.import_module("cognee.tasks.storage.index_data_points")
    limited = index_module.index_data_points
    original = limited.__wrapped__
    stale_modules = sorted(
        name
        for name, module in list(sys.modules.items())
        if name.startswith("cognee.")
        and module is not None
        and getattr(module, "index_data_points", None) is original
    )

    assert stale_modules == []


@pytest.mark.asyncio
async def test_store_wraps_each_cognee_operation_in_pipeline_limits():
    from novelvideo.cognee.concurrency import llm_pipeline_limiter
    from novelvideo.cognee.store import CogneeStore

    store = CogneeStore.__new__(CogneeStore)
    store._set_cognee_context = lambda: None
    store._ensure_pipeline_run_succeeded = lambda _result, _stage: None
    active = 0
    peak = 0

    async def request() -> None:
        nonlocal active, peak
        async with llm_pipeline_limiter:
            active += 1
            peak = max(peak, active)
            await asyncio.sleep(0.01)
            active -= 1

    async def operation():
        await asyncio.gather(*(request() for _ in range(8)))
        return []

    await store._run_cognee_pipeline_with_retry(
        stage_name="test", operation=operation, log=lambda _message: None
    )

    assert peak == 2


def test_pipeline_limits_are_safe_across_thread_event_loops():
    from novelvideo.cognee.concurrency import (
        CogneeConcurrencyConfig,
        cognee_pipeline_concurrency,
        llm_pipeline_limiter,
    )

    async def run_pipeline() -> int:
        active = 0
        peak = 0

        async def request() -> None:
            nonlocal active, peak
            async with llm_pipeline_limiter:
                active += 1
                peak = max(peak, active)
                await asyncio.sleep(0.005)
                active -= 1

        async with cognee_pipeline_concurrency(
            CogneeConcurrencyConfig(llm=1, embedding_batch=1)
        ):
            await asyncio.gather(*(request() for _ in range(4)))
        return peak

    with ThreadPoolExecutor(max_workers=5) as executor:
        peaks = list(executor.map(lambda _index: asyncio.run(run_pipeline()), range(5)))

    assert peaks == [1, 1, 1, 1, 1]


@pytest.mark.asyncio
async def test_cancelled_request_releases_pipeline_permit():
    from novelvideo.cognee.concurrency import (
        CogneeConcurrencyConfig,
        cognee_pipeline_concurrency,
        llm_pipeline_limiter,
    )

    entered = asyncio.Event()

    async def cancelled_request() -> None:
        async with llm_pipeline_limiter:
            entered.set()
            await asyncio.Event().wait()

    async with cognee_pipeline_concurrency(
        CogneeConcurrencyConfig(llm=1, embedding_batch=1)
    ):
        task = asyncio.create_task(cancelled_request())
        await entered.wait()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

        async with asyncio.timeout(0.2):
            async with llm_pipeline_limiter:
                pass


@pytest.mark.asyncio
async def test_pipeline_logs_observed_concurrency_peaks(monkeypatch):
    from novelvideo.cognee import concurrency
    from novelvideo.cognee.concurrency import (
        CogneeConcurrencyConfig,
        cognee_pipeline_concurrency,
        embedding_pipeline_limiter,
        llm_pipeline_limiter,
    )

    async def request(limiter) -> None:
        async with limiter:
            await asyncio.sleep(0.01)

    log_calls = []
    monkeypatch.setattr(
        concurrency.logger,
        "info",
        lambda message, *args: log_calls.append(message % args),
    )

    async with cognee_pipeline_concurrency(
        CogneeConcurrencyConfig(llm=2, embedding_batch=4)
    ):
        await asyncio.gather(*(request(llm_pipeline_limiter) for _ in range(6)))
        await asyncio.gather(*(request(embedding_pipeline_limiter) for _ in range(8)))

    assert "llm_peak=2" in log_calls[-1]
    assert "embedding_batch_peak=4" in log_calls[-1]
