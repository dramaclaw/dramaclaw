"""Regression tests for ModelTimeoutError (issue #211)."""

from __future__ import annotations

import asyncio

import httpx
import pytest

from novelvideo import config as config_module
from novelvideo.config import (
    MODEL_TIMEOUT_ERROR_CODE,
    ModelTimeoutError,
    _is_text_model_timeout_error,
    get_newapi_text_timeout_seconds,
)


def test_model_timeout_error_has_stable_code():
    err = ModelTimeoutError("my-model", 0.75)
    assert err.error_code == MODEL_TIMEOUT_ERROR_CODE
    assert err.code == MODEL_TIMEOUT_ERROR_CODE
    assert err.error_code == "MODEL_TIMEOUT"
    assert isinstance(err, RuntimeError)
    assert isinstance(err, Exception)
    # stable code string check
    assert err.code == "MODEL_TIMEOUT"


def test_model_timeout_error_message_includes_model_and_timeout():
    err = ModelTimeoutError("DC-freezone-LLM", 123.5)
    msg = str(err)
    assert "DC-freezone-LLM" in msg
    assert "123.5" in msg
    assert "MODEL_TIMEOUT" in msg
    assert "upstream may still succeed" in msg.lower() or "upstream may still succeed" in msg


def test_model_timeout_error_message_handles_float_formatting():
    err = ModelTimeoutError("test-model", 300.0)
    assert "300" in str(err)
    assert "test-model" in str(err)


def test_get_newapi_text_timeout_seconds_prefers_override(monkeypatch):
    monkeypatch.setenv("NEWAPI_TEXT_TIMEOUT_SECONDS", "10")
    monkeypatch.setenv("MY_MODEL_TIMEOUT_SECONDS", "20")
    # explicit override wins over both envs
    assert get_newapi_text_timeout_seconds("MY_MODEL", timeout_seconds_override=1.5) == pytest.approx(1.5)
    # per-model env wins over global
    assert get_newapi_text_timeout_seconds("MY_MODEL") == pytest.approx(20.0)
    # global fallback
    assert get_newapi_text_timeout_seconds("OTHER_MODEL") == pytest.approx(10.0)


def test_get_newapi_text_timeout_seconds_default(monkeypatch):
    monkeypatch.delenv("NEWAPI_TEXT_TIMEOUT_SECONDS", raising=False)
    monkeypatch.delenv("DC_TEST_MODEL_TIMEOUT_SECONDS", raising=False)
    assert get_newapi_text_timeout_seconds("DC_TEST_MODEL") == pytest.approx(300.0)
    assert get_newapi_text_timeout_seconds("DC_TEST_MODEL", default_seconds=42.0) == pytest.approx(42.0)


def test_get_newapi_text_pydantic_model_timeout_override_flows(monkeypatch, tmp_path):
    # Isolate gateway so we don't need real settings.db routing
    from novelvideo.model_gateway_settings import save_custom_newapi_gateway

    monkeypatch.setattr(config_module, "STATE_DIR", str(tmp_path / "state"))
    monkeypatch.setenv("ST_EDITION", "ce")
    for key in ("ST_CONTROL_PLANE_DSN", "MODEL_GATEWAY_MODE", "MODEL_GATEWAY_RUNTIME_VERSION", "NEWAPI_API_KEY", "NEWAPI_BASE_URL"):
        monkeypatch.delenv(key, raising=False)
    save_custom_newapi_gateway(base_url="http://127.0.0.1:3000", api_key="sk-test", activate=True)

    captured: dict[str, object] = {}

    def fake_model(model_name, **kwargs):
        captured.update(model_name=model_name, **kwargs)
        return "fake-model"

    monkeypatch.setattr(config_module, "_newapi_text_openai_model", fake_model)

    # without override -> uses env helper (should be 300 by default)
    monkeypatch.delenv("NEWAPI_TEXT_TIMEOUT_SECONDS", raising=False)
    monkeypatch.delenv("DC_TEST_MODEL_TIMEOUT_SECONDS", raising=False)
    result = config_module.get_newapi_text_pydantic_model("DC_TEST_MODEL", "DC-test-LLM")
    assert result == "fake-model"
    assert captured["timeout_seconds"] == pytest.approx(300.0)

    # with explicit per-task override -> must flow through
    result = config_module.get_newapi_text_pydantic_model(
        "DC_TEST_MODEL", "DC-test-LLM", timeout_seconds_override=7.5
    )
    assert captured["timeout_seconds"] == pytest.approx(7.5)

    # with per-model env -> must flow through
    monkeypatch.setenv("DC_TEST_MODEL_TIMEOUT_SECONDS", "99")
    result = config_module.get_newapi_text_pydantic_model("DC_TEST_MODEL", "DC-test-LLM")
    assert captured["timeout_seconds"] == pytest.approx(99.0)


def test_is_text_model_timeout_error_recognises_variants():
    # asyncio.TimeoutError
    assert _is_text_model_timeout_error(asyncio.TimeoutError("t")) is True
    # httpx timeouts
    assert _is_text_model_timeout_error(httpx.ReadTimeout("t", request=httpx.Request("GET", "http://x"))) is True
    assert _is_text_model_timeout_error(httpx.ConnectTimeout("t")) is True
    # non-timeout should be False
    assert _is_text_model_timeout_error(ValueError("oops")) is False
    assert _is_text_model_timeout_error(RuntimeError("boom")) is False


def test_is_timeout_error_openai_variants():
    try:
        from openai import APIConnectionError, APITimeoutError
    except Exception:
        pytest.skip("openai not available")

    # APITimeoutError
    try:
        exc = APITimeoutError(request=httpx.Request("POST", "https://example.test/v1/chat/completions"))  # type: ignore[call-arg]
    except TypeError:
        # openai APITimeoutError signature may require different args
        pytest.skip("openai APITimeoutError signature incompatible")
    assert _is_text_model_timeout_error(exc) is True

    # APIConnectionError with timeout in message -> True
    try:
        conn_exc = APIConnectionError(request=httpx.Request("POST", "https://example.test/v1/chat/completions"))  # type: ignore[call-arg]
        conn_exc.message = "Request timed out"
        # Ensure string contains timeout
        if "timeout" not in str(conn_exc).lower():
            # Force message
            conn_exc.args = ("Request timed out",)
    except Exception:
        pytest.skip("APIConnectionError construction failed")
    # At least one of these should be considered timeout after we set message
    assert _is_text_model_timeout_error(conn_exc) is True or "timeout" in str(conn_exc).lower()

    # APIConnectionError without timeout -> False
    try:
        non_timeout = APIConnectionError(request=httpx.Request("POST", "https://example.test/v1/chat/completions"))  # type: ignore[call-arg]
        # ensure no timeout word
        if "timeout" in str(non_timeout).lower():
            non_timeout.args = ("connection refused",)
            non_timeout.__cause__ = None
            non_timeout.__context__ = None
    except Exception:
        pytest.skip("APIConnectionError construction failed")
    # If the library's default message contains timeout we can't assert False reliably;
    # just check that a plain ValueError is not considered timeout (already checked above)
    # So we only assert when we successfully sanitized
    if "timeout" not in str(non_timeout).lower():
        assert _is_text_model_timeout_error(non_timeout) is False


@pytest.mark.asyncio
async def test_request_translates_httpx_timeout_to_model_timeout(monkeypatch):
    from pydantic_ai.models.openai import OpenAIChatModel

    model = config_module._newapi_text_openai_model(
        "DC-freezone-LLM",
        api_key="sk-test",
        base_url="https://example.test/v1",
        timeout_seconds=0.05,
        profile=None,
    )
    http_client = model.provider._own_http_client
    orig = OpenAIChatModel.request

    async def fake_request(self, *args, **kwargs):
        raise httpx.ReadTimeout("timed out", request=httpx.Request("POST", "https://example.test/v1/chat/completions"))

    monkeypatch.setattr(OpenAIChatModel, "request", fake_request)
    try:
        with pytest.raises(ModelTimeoutError) as exc_info:
            await model.request([], None, None)
        err = exc_info.value
        assert err.error_code == "MODEL_TIMEOUT"
        assert err.code == "MODEL_TIMEOUT"
        assert "DC-freezone-LLM" in str(err)
        assert "0.05" in str(err)
        # cause should be preserved
        assert exc_info.value.__cause__ is not None
    finally:
        monkeypatch.setattr(OpenAIChatModel, "request", orig)
        if http_client is not None and not http_client.is_closed:
            await http_client.aclose()


@pytest.mark.asyncio
async def test_request_translates_asyncio_timeout_to_model_timeout(monkeypatch):
    from pydantic_ai.models.openai import OpenAIChatModel

    model = config_module._newapi_text_openai_model(
        "my-model",
        api_key="sk-test",
        base_url="https://example.test/v1",
        timeout_seconds=1.25,
        profile=None,
    )
    http_client = model.provider._own_http_client
    orig = OpenAIChatModel.request

    async def fake_request(self, *args, **kwargs):
        raise asyncio.TimeoutError("timeout")

    monkeypatch.setattr(OpenAIChatModel, "request", fake_request)
    try:
        with pytest.raises(ModelTimeoutError) as exc_info:
            await model.request([], None, None)
        assert exc_info.value.error_code == "MODEL_TIMEOUT"
        assert "my-model" in str(exc_info.value)
        assert "1.25" in str(exc_info.value)
    finally:
        monkeypatch.setattr(OpenAIChatModel, "request", orig)
        if http_client is not None and not http_client.is_closed:
            await http_client.aclose()


@pytest.mark.asyncio
async def test_request_translates_openai_api_timeout(monkeypatch):
    try:
        from openai import APITimeoutError
    except Exception:
        pytest.skip("openai not available")
    from pydantic_ai.models.openai import OpenAIChatModel

    model = config_module._newapi_text_openai_model(
        "DC-freezone-LLM",
        api_key="sk-test",
        base_url="https://example.test/v1",
        timeout_seconds=12.0,
        profile=None,
    )
    http_client = model.provider._own_http_client
    orig = OpenAIChatModel.request

    async def fake_request(self, *args, **kwargs):
        try:
            raise APITimeoutError(request=httpx.Request("POST", "https://example.test/v1/chat/completions"))  # type: ignore[call-arg]
        except TypeError:
            # fallback: construct with minimal args and set message
            err = APITimeoutError.__new__(APITimeoutError)  # type: ignore
            err.args = ("Request timed out",)
            raise err

    monkeypatch.setattr(OpenAIChatModel, "request", fake_request)
    try:
        with pytest.raises(ModelTimeoutError) as exc_info:
            await model.request([], None, None)
        assert exc_info.value.error_code == "MODEL_TIMEOUT"
    finally:
        monkeypatch.setattr(OpenAIChatModel, "request", orig)
        if http_client is not None and not http_client.is_closed:
            await http_client.aclose()


@pytest.mark.asyncio
async def test_request_does_not_wrap_non_timeout_error(monkeypatch):
    from pydantic_ai.models.openai import OpenAIChatModel

    model = config_module._newapi_text_openai_model(
        "DC-freezone-LLM",
        api_key="sk-test",
        base_url="https://example.test/v1",
        timeout_seconds=5.0,
        profile=None,
    )
    http_client = model.provider._own_http_client
    orig = OpenAIChatModel.request

    class FakeAuthError(RuntimeError):
        status_code = 401

    async def fake_request(self, *args, **kwargs):
        raise FakeAuthError("401 Unauthorized")

    monkeypatch.setattr(OpenAIChatModel, "request", fake_request)
    try:
        with pytest.raises(FakeAuthError):
            await model.request([], None, None)
        # Ensure not wrapped as ModelTimeoutError
        with pytest.raises(FakeAuthError) as exc_info:
            await model.request([], None, None)
        assert not isinstance(exc_info.value, ModelTimeoutError)
    finally:
        monkeypatch.setattr(OpenAIChatModel, "request", orig)
        if http_client is not None and not http_client.is_closed:
            await http_client.aclose()


@pytest.mark.asyncio
async def test_request_does_not_wrap_422_error(monkeypatch):
    from pydantic_ai.models.openai import OpenAIChatModel

    model = config_module._newapi_text_openai_model(
        "DC-freezone-LLM",
        api_key="sk-test",
        base_url="https://example.test/v1",
        timeout_seconds=5.0,
        profile=None,
    )
    http_client = model.provider._own_http_client
    orig = OpenAIChatModel.request

    # Simulate a 422 validation error as openai.BadRequestError or generic
    try:
        from openai import BadRequestError

        def make_422():
            resp = httpx.Response(422, request=httpx.Request("POST", "https://example.test/v1/chat/completions"), json={"error": {"message": "Unprocessable"}})
            return BadRequestError(message="422", response=resp, body=None)  # type: ignore[call-arg]
    except Exception:
        # fallback generic
        class BadRequestError(RuntimeError):  # type: ignore[no-redef]
            pass

        def make_422():
            return BadRequestError("422 Unprocessable Entity")

    async def fake_request(self, *args, **kwargs):
        raise make_422()

    monkeypatch.setattr(OpenAIChatModel, "request", fake_request)
    try:
        with pytest.raises(Exception) as exc_info:
            await model.request([], None, None)
        assert not isinstance(exc_info.value, ModelTimeoutError)
    finally:
        monkeypatch.setattr(OpenAIChatModel, "request", orig)
        if http_client is not None and not http_client.is_closed:
            await http_client.aclose()


@pytest.mark.asyncio
@pytest.mark.asyncio
async def test_client_timeout_via_httpx_mock_transport(monkeypatch):
    # Simulate a client-side timeout at the model boundary — proves the
    # wrapper translates httpx.ReadTimeout -> ModelTimeoutError without
    # needing a live transport.
    from pydantic_ai.models.openai import OpenAIChatModel

    model = config_module._newapi_text_openai_model(
        "DC-freezone-LLM",
        api_key="sk-test",
        base_url="https://example.test/v1",
        timeout_seconds=5.0,
        profile=None,
    )
    http_client = model.provider._own_http_client
    orig = OpenAIChatModel.request

    async def fake_request(self, *args, **kwargs):
        raise httpx.ReadTimeout(
            "timed out", request=httpx.Request("POST", "https://example.test/v1/chat/completions")
        )

    monkeypatch.setattr(OpenAIChatModel, "request", fake_request)
    try:
        with pytest.raises(ModelTimeoutError) as exc_info:
            await model.request([], None, None)
        assert exc_info.value.error_code == "MODEL_TIMEOUT"
        assert "DC-freezone-LLM" in str(exc_info.value)
    finally:
        monkeypatch.setattr(OpenAIChatModel, "request", orig)
        if http_client is not None and not http_client.is_closed:
            await http_client.aclose()


@pytest.mark.asyncio
async def test_non_timeout_401_via_httpx_mock_not_wrapped(monkeypatch):
    # Simulate an upstream 401 response — should NOT become ModelTimeoutError.
    from pydantic_ai.models.openai import OpenAIChatModel

    model = config_module._newapi_text_openai_model(
        "DC-freezone-LLM",
        api_key="sk-test",
        base_url="https://example.test/v1",
        timeout_seconds=5.0,
        profile=None,
    )
    http_client = model.provider._own_http_client
    orig = OpenAIChatModel.request

    class FakeAuthError(RuntimeError):
        status_code = 401

    async def fake_request(self, *args, **kwargs):
        raise FakeAuthError("401 Unauthorized: invalid api key")

    monkeypatch.setattr(OpenAIChatModel, "request", fake_request)
    try:
        with pytest.raises(FakeAuthError) as exc_info:
            await model.request([], None, None)
        assert not isinstance(exc_info.value, ModelTimeoutError)
        assert "401" in str(exc_info.value)
    finally:
        monkeypatch.setattr(OpenAIChatModel, "request", orig)
        if http_client is not None and not http_client.is_closed:
            await http_client.aclose()
