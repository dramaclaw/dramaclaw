"""LLM attribution context and provider instrumentation.

This module stays in the engine side so provider monkey patches can run in
CE and EE processes without importing EE/control-plane modules.
"""

from __future__ import annotations

import contextvars
import logging
import os
from typing import Any, Optional

logger = logging.getLogger("novelvideo.llm_instrumentation")

_PROJECT_CTX: contextvars.ContextVar[Optional[str]] = contextvars.ContextVar(
    "novelvideo_project_id", default=None
)
_USER_CTX: contextvars.ContextVar[Optional[str]] = contextvars.ContextVar(
    "novelvideo_llm_user_id", default=None
)
_RESOURCE_KIND_CTX: contextvars.ContextVar[str] = contextvars.ContextVar(
    "novelvideo_llm_resource_kind", default=""
)
_BILLING_METADATA_CTX: contextvars.ContextVar[dict[str, Any]] = contextvars.ContextVar(
    "novelvideo_billing_metadata", default={}
)
_CREDIT_RESERVATION_STACK: contextvars.ContextVar[tuple[str, ...]] = contextvars.ContextVar(
    "st_credit_reservation_stack",
    default=(),
)
_MODEL_CALL_INSTRUMENTATION_ACTIVE: contextvars.ContextVar[bool] = contextvars.ContextVar(
    "st_model_call_instrumentation_active",
    default=False,
)
# Compatibility for EE releases that imported the old internal name. New code
# must use the instrumentation-scope name: an empty billing reservation can
# still own the single model-call log for a feature-included invocation.
_AGENT_CREDIT_RESERVATION_ACTIVE = _MODEL_CALL_INSTRUMENTATION_ACTIVE

_ALLOWED_RESOURCE_KINDS = frozenset(
    {"portrait", "sketch", "render", "video", "tts", "script", "ingest"}
)
_PROVIDER_REQUEST_ID_HEADER_NAMES = (
    "x-request-id",
    "x-requestid",
    "request-id",
    "request_id",
    "x-newapi-request-id",
    "newapi-request-id",
    "x-oneapi-request-id",
    "oneapi-request-id",
    "x-goog-request-id",
)

_pydantic_ai_openai_trace_patched = False
_agent_run_patched = False
_litellm_hook_installed = False
_litellm_acompletion_patched = False


def set_project_context(project_id: Optional[str]) -> None:
    _PROJECT_CTX.set(project_id or None)


def get_project_context() -> Optional[str]:
    return _PROJECT_CTX.get()


def get_llm_user_context() -> Optional[str]:
    return _USER_CTX.get()


def get_resource_kind_context() -> str:
    return _RESOURCE_KIND_CTX.get()


def get_billing_metadata_context() -> dict[str, Any]:
    return dict(_BILLING_METADATA_CTX.get() or {})


def clear_llm_usage_context() -> None:
    _USER_CTX.set(None)
    set_project_context(None)
    _RESOURCE_KIND_CTX.set("")
    _BILLING_METADATA_CTX.set({})


def set_llm_usage_context(
    user_id: Optional[str],
    project_id: Optional[str] = None,
    resource_kind: str = "",
    billing_metadata: Optional[dict[str, Any]] = None,
) -> None:
    _USER_CTX.set(user_id)
    set_project_context(project_id)
    kind = resource_kind if resource_kind in _ALLOWED_RESOURCE_KINDS else ""
    _RESOURCE_KIND_CTX.set(kind)
    _BILLING_METADATA_CTX.set(dict(billing_metadata or {}))


def _push_credit_reservation(reservation_id: str) -> None:
    if not reservation_id:
        return
    stack = _CREDIT_RESERVATION_STACK.get()
    _CREDIT_RESERVATION_STACK.set((*stack, reservation_id))


def _pop_credit_reservation() -> str:
    stack = _CREDIT_RESERVATION_STACK.get()
    if not stack:
        return ""
    reservation_id = stack[-1]
    _CREDIT_RESERVATION_STACK.set(stack[:-1])
    return reservation_id


def set_model_call_instrumentation_active(active: bool = True):
    return _MODEL_CALL_INSTRUMENTATION_ACTIVE.set(active)


def reset_model_call_instrumentation_active(token) -> None:
    _MODEL_CALL_INSTRUMENTATION_ACTIVE.reset(token)


def set_model_call_reservation_active(active: bool):
    """Compatibility alias; the flag represents logging ownership, not billing."""
    return set_model_call_instrumentation_active(active)


def reset_model_call_reservation_active(token) -> None:
    """Compatibility alias for older EE integrations."""
    reset_model_call_instrumentation_active(token)


def _extract_model_name(agent: object) -> str:
    try:
        m = getattr(agent, "model", None)
        if m is None:
            return ""
        for attr in ("model_name", "name", "_model_name", "model"):
            val = getattr(m, attr, None)
            if isinstance(val, str) and val:
                return val.strip()
        s = str(m).strip()
        return s if s else ""
    except Exception:
        return ""


def _model_settings_dict(value: object) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    return {}


def _text_billing_params_from_model_settings(
    agent: object,
    run_model_settings: object = None,
) -> dict[str, str] | None:
    params: dict[str, str] = {}
    for settings_value in (getattr(agent, "model_settings", None), run_model_settings):
        settings = _model_settings_dict(settings_value)
        effort = settings.get("openai_reasoning_effort") or settings.get("reasoning_effort")
        clean_effort = str(effort or "").strip().lower()
        if clean_effort:
            params["effort"] = clean_effort
    return params or None


def _text_billing_params_from_openai_kwargs(kwargs: dict | None) -> dict[str, str] | None:
    if not isinstance(kwargs, dict):
        return None
    effort = kwargs.get("reasoning_effort") or kwargs.get("openai_reasoning_effort")
    clean_effort = str(effort or "").strip().lower()
    if not clean_effort:
        return None
    return {"effort": clean_effort}


def _first_nonempty_str(*values: object) -> str:
    for value in values:
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


def _header_value(headers: object, *names: str) -> str:
    getter = getattr(headers, "get", None)
    for name in names:
        value = getter(name) if callable(getter) else None
        found = _first_nonempty_str(value)
        if found:
            return found
    if isinstance(headers, dict):
        lowered = {str(key).lower(): value for key, value in headers.items()}
        for name in names:
            found = _first_nonempty_str(lowered.get(name.lower()))
            if found:
                return found
    return ""


def _attach_openai_response_trace(parsed: object, http_response: object) -> None:
    headers = getattr(http_response, "headers", None)
    if headers is None:
        return
    try:
        header_map = dict(headers)
    except Exception:
        header_map = headers
    try:
        setattr(parsed, "_response_headers", header_map)
    except Exception as exc:
        logger.debug("openai response headers attach failed: %s", exc)
    request_id = _header_value(header_map, *_PROVIDER_REQUEST_ID_HEADER_NAMES)
    if not request_id:
        return
    try:
        current = getattr(parsed, "_request_id", None)
        if not current:
            setattr(parsed, "_request_id", request_id)
    except Exception as exc:
        logger.debug("openai request id attach failed: %s", exc)


def _extract_provider_ids(response_obj: object) -> tuple[str, str, str]:
    request_id = ""
    task_id = ""
    response_id = ""

    def _extract_from_one(obj: object) -> tuple[str, str, str]:
        req = _first_nonempty_str(
            getattr(obj, "request_id", None), getattr(obj, "_request_id", None)
        )
        task = _first_nonempty_str(getattr(obj, "task_id", None), getattr(obj, "taskId", None))
        resp = _first_nonempty_str(
            getattr(obj, "id", None),
            getattr(obj, "response_id", None),
            getattr(obj, "provider_response_id", None),
        )
        if isinstance(obj, dict):
            resp = _first_nonempty_str(
                resp, obj.get("id"), obj.get("response_id"), obj.get("provider_response_id")
            )
            req = _first_nonempty_str(req, obj.get("request_id"), obj.get("requestId"))
            task = _first_nonempty_str(task, obj.get("task_id"), obj.get("taskId"))
        for details in (getattr(obj, "provider_details", None), getattr(obj, "metadata", None)):
            if isinstance(details, dict):
                req = _first_nonempty_str(req, details.get("request_id"), details.get("requestId"))
                task = _first_nonempty_str(task, details.get("task_id"), details.get("taskId"))
                resp = _first_nonempty_str(
                    resp, details.get("response_id"), details.get("provider_response_id")
                )
        response_headers = getattr(obj, "_response_headers", None)
        req = _first_nonempty_str(
            req, _header_value(response_headers, *_PROVIDER_REQUEST_ID_HEADER_NAMES)
        )
        hidden = getattr(obj, "_hidden_params", None)
        if isinstance(hidden, dict):
            headers = hidden.get("headers") or hidden.get("response_headers") or {}
            req = _first_nonempty_str(
                req, _header_value(headers, *_PROVIDER_REQUEST_ID_HEADER_NAMES)
            )
            req = _first_nonempty_str(req, hidden.get("request_id"), hidden.get("requestId"))
        return req, task, resp

    try:
        request_id, task_id, response_id = _extract_from_one(response_obj)
        for attr in ("response",):
            nested = getattr(response_obj, attr, None)
            if nested is None:
                continue
            if callable(nested):
                try:
                    nested = nested()
                except TypeError:
                    continue
            nested_req, nested_task, nested_resp = _extract_from_one(nested)
            request_id = _first_nonempty_str(request_id, nested_req)
            task_id = _first_nonempty_str(task_id, nested_task)
            response_id = _first_nonempty_str(response_id, nested_resp)
        for method in ("new_messages", "all_messages"):
            messages_fn = getattr(response_obj, method, None)
            if not callable(messages_fn):
                continue
            try:
                messages = messages_fn()
            except Exception:
                continue
            for message in reversed(list(messages or [])):
                nested_req, nested_task, nested_resp = _extract_from_one(message)
                request_id = _first_nonempty_str(request_id, nested_req)
                task_id = _first_nonempty_str(task_id, nested_task)
                response_id = _first_nonempty_str(response_id, nested_resp)
                if request_id and response_id:
                    break
    except Exception:
        pass
    return request_id, task_id, response_id


def _strip_model_provider_prefix(model: str) -> str:
    value = (model or "").strip()
    for prefix in ("openai/", "custom/", "google/", "gemini/"):
        if value.startswith(prefix):
            return value[len(prefix) :]
    return value


def _normalize_recorded_model_name(model: str) -> str:
    raw = (model or "").strip()
    if not raw:
        return ""
    plain = _strip_model_provider_prefix(raw)
    for env_key in (
        "COGNEE_LLM_MODEL",
        "COGNEE_EMBEDDING_MODEL",
        "IDENTITY_PLANNER_CAST_MODEL",
        "IDENTITY_PLANNER_ANALYSIS_MODEL",
        "IDENTITY_PLANNER_APPEARANCE_MODEL",
        "EPISODE_SCENE_PLANNER_MODEL",
        "EPISODE_PROP_PLANNER_MODEL",
        "LITERAL_BEAT_META_MODEL",
        "SCENE_BUILD_MODEL",
        "NARRATED_SCENE_ASSET_MODEL",
        "GLOBAL_VIDEO_IDENTITY_DETECTOR_MODEL",
        "GLOBAL_VIDEO_OPTIMIZER_MODEL",
        "SEEDANCE2_PROMPT_COMPOSER_MODEL",
        "NEWAPI_IMAGE_MODEL",
        "NEWAPI_NANOBANANA2_MODEL",
        "PROP_REF_IMAGE_MODEL",
        "SCENE_MASTER_IMAGE_MODEL",
        "SCENE_REVERSE_MASTER_IMAGE_MODEL",
        "SCENE_360_IMAGE_MODEL",
        "SCENE_ASSET_MODEL",
        "NEWAPI_VIDEO_MODEL",
        "DEFAULT_VIDEO_MODEL",
        "INDEXTTS2_NEWAPI_MODEL",
    ):
        configured = os.environ.get(env_key, "").strip()
        if not configured:
            continue
        configured_plain = _strip_model_provider_prefix(configured)
        if plain == configured_plain or plain.startswith(f"{configured_plain}-"):
            return configured_plain
    return plain


def _extract_litellm_usage(kwargs: dict, response_obj: object) -> tuple[int, int, str]:
    in_tok = 0
    out_tok = 0
    model = ""
    try:
        usage = getattr(response_obj, "usage", None) or {}
        if isinstance(usage, dict):
            in_tok = int(usage.get("prompt_tokens") or 0)
            out_tok = int(usage.get("completion_tokens") or 0)
        else:
            in_tok = int(getattr(usage, "prompt_tokens", 0) or 0)
            out_tok = int(getattr(usage, "completion_tokens", 0) or 0)
        model = (kwargs or {}).get("model", "") or getattr(response_obj, "model", "") or ""
    except Exception:
        pass
    return in_tok, out_tok, _normalize_recorded_model_name(model)


def _json_log_value(value: object, *, depth: int = 0) -> object:
    """Convert provider inputs/results to JSON-safe diagnostic values."""
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, bytes):
        return {"type": "bytes", "length": len(value)}
    if depth >= 8:
        return str(value)
    if isinstance(value, dict):
        return {
            str(key): _json_log_value(item, depth=depth + 1)
            for key, item in value.items()
        }
    if isinstance(value, (list, tuple, set)):
        return [_json_log_value(item, depth=depth + 1) for item in value]
    model_dump = getattr(value, "model_dump", None)
    if callable(model_dump):
        try:
            return _json_log_value(model_dump(mode="json"), depth=depth + 1)
        except Exception:
            pass
    output = getattr(value, "output", None)
    if output is not None:
        return {"output": _json_log_value(output, depth=depth + 1)}
    return str(value)


def _failure_log_metadata(exc: BaseException, response: object = None) -> dict[str, object]:
    message = str(exc)
    return {
        "error_message": message,
        "response_payload": {
            "status": "failed",
            "error_type": type(exc).__name__,
            "error_message": message,
            "response": _json_log_value(response),
        },
    }


async def _meter_reserve(**kwargs) -> str:
    from novelvideo.ports import get_usage_meter

    return await get_usage_meter().reserve_current_model_call_credit(**kwargs)


async def _meter_refund(
    reservation_id: str, *, metadata: dict[str, object] | None = None
) -> None:
    from novelvideo.ports import get_usage_meter

    await get_usage_meter().refund_model_call_credit_reservation(
        reservation_id,
        metadata=metadata,
    )


async def _forward_agent_usage(
    agent: object,
    result: object,
    *,
    credit_reservation_id: str = "",
) -> None:
    user_id = _USER_CTX.get()
    if not user_id:
        return
    project_id = _PROJECT_CTX.get()
    resource_kind = _RESOURCE_KIND_CTX.get()
    model = _normalize_recorded_model_name(_extract_model_name(agent))
    request_id, task_id, response_id = _extract_provider_ids(result)
    meta = {
        "response_id": response_id,
        "response_payload": _json_log_value(result),
    }
    from novelvideo.ports import get_usage_meter

    meter = get_usage_meter()
    try:
        usage_fn = getattr(result, "usage", None)
        usage = usage_fn() if callable(usage_fn) else None
        if usage is not None:
            in_tok = (
                getattr(usage, "input_tokens", None)
                or getattr(usage, "request_tokens", None)
                or 0
            )
            out_tok = (
                getattr(usage, "output_tokens", None)
                or getattr(usage, "response_tokens", None)
                or 0
            )
            await meter.record_llm_tokens(
                user_id=user_id,
                input_tokens=int(in_tok or 0),
                output_tokens=int(out_tok or 0),
                model=model,
                project_id=project_id,
                resource_kind=resource_kind,
            )
    except Exception as e:
        logger.debug("forward_agent_usage failed: %s", e)
    await meter.bump_model_call(
        user_id=user_id,
        model=model,
        project_id=project_id,
        resource_kind=resource_kind,
        provider_request_id=request_id,
        provider_task_id=task_id,
        credit_reservation_id=credit_reservation_id,
        metadata=meta,
    )


def _install_pydantic_ai_openai_trace_patch() -> None:
    global _pydantic_ai_openai_trace_patched
    if _pydantic_ai_openai_trace_patched:
        return
    try:
        from pydantic_ai.models.openai import OpenAIChatModel
    except Exception:
        return
    try:
        from openai._response import APIResponse, AsyncAPIResponse

        original_async_parse = AsyncAPIResponse.parse
        original_sync_parse = APIResponse.parse

        async def _patched_async_parse(self, *args, **kwargs):
            parsed = await original_async_parse(self, *args, **kwargs)
            _attach_openai_response_trace(parsed, getattr(self, "http_response", None))
            return parsed

        def _patched_sync_parse(self, *args, **kwargs):
            parsed = original_sync_parse(self, *args, **kwargs)
            _attach_openai_response_trace(parsed, getattr(self, "http_response", None))
            return parsed

        AsyncAPIResponse.parse = _patched_async_parse  # type: ignore[method-assign]
        APIResponse.parse = _patched_sync_parse  # type: ignore[method-assign]
    except Exception as exc:
        logger.debug("OpenAI SDK response parse patch failed: %s", exc)
    original_process_response = OpenAIChatModel._process_response

    def _patched_process_response(self, response):
        request_id = ""
        try:
            request_id = (
                str(getattr(response, "_request_id", "") or "").strip()
                or str(getattr(response, "request_id", "") or "").strip()
                or _header_value(
                    getattr(response, "_response_headers", None), *_PROVIDER_REQUEST_ID_HEADER_NAMES
                )
            )
        except Exception:
            request_id = ""
        result = original_process_response(self, response)
        if request_id:
            try:
                details = dict(getattr(result, "provider_details", None) or {})
                details.setdefault("request_id", request_id)
                result.provider_details = details
            except Exception as exc:
                logger.debug("pydantic-ai request id attach failed: %s", exc)
        return result

    OpenAIChatModel._process_response = _patched_process_response  # type: ignore[method-assign]
    _pydantic_ai_openai_trace_patched = True


def _install_agent_run_patch() -> None:
    global _agent_run_patched
    if _agent_run_patched:
        return
    try:
        from pydantic_ai import Agent
    except Exception:
        return
    original_run = Agent.run

    async def _tracked_run(self, *args, **kwargs):
        reservation_id = await _meter_reserve(
            model=_extract_model_name(self),
            billing_kind="text",
            billing_params=_text_billing_params_from_model_settings(
                self, kwargs.get("model_settings")
            ),
            metadata={
                "source": "pydantic_ai_agent_run",
                "request_payload": {
                    "args": _json_log_value(args),
                    "kwargs": _json_log_value(kwargs),
                },
            },
        )
        token = _MODEL_CALL_INSTRUMENTATION_ACTIVE.set(True)
        try:
            result = await original_run(self, *args, **kwargs)
        except BaseException as exc:
            await _meter_refund(
                reservation_id,
                metadata=_failure_log_metadata(exc),
            )
            raise
        finally:
            _MODEL_CALL_INSTRUMENTATION_ACTIVE.reset(token)
        try:
            await _forward_agent_usage(self, result, credit_reservation_id=reservation_id)
        except Exception:
            pass
        return result

    Agent.run = _tracked_run  # type: ignore[assignment]
    _agent_run_patched = True


async def _forward_litellm_success(
    kwargs: dict,
    response_obj: object,
    *,
    credit_reservation_id: str = "",
) -> None:
    user_id = _USER_CTX.get()
    if not user_id:
        return
    in_tok, out_tok, model = _extract_litellm_usage(kwargs, response_obj)
    project_id = _PROJECT_CTX.get()
    resource_kind = _RESOURCE_KIND_CTX.get()
    request_id, task_id, response_id = _extract_provider_ids(response_obj)
    meta = {
        "response_id": response_id,
        "response_payload": _json_log_value(response_obj),
    }
    from novelvideo.ports import get_usage_meter

    meter = get_usage_meter()
    if in_tok > 0 or out_tok > 0:
        try:
            await meter.record_llm_tokens(
                user_id=user_id,
                input_tokens=in_tok,
                output_tokens=out_tok,
                model=model,
                project_id=project_id,
                resource_kind=resource_kind,
            )
        except Exception as e:
            logger.debug("litellm usage emit failed: %s", e)
    await meter.bump_model_call(
        user_id=user_id,
        model=model,
        project_id=project_id,
        resource_kind=resource_kind,
        provider_request_id=request_id,
        provider_task_id=task_id,
        credit_reservation_id=credit_reservation_id,
        metadata=meta,
    )


def _patch_litellm_acompletion(litellm_module: object) -> None:
    global _litellm_acompletion_patched
    if _litellm_acompletion_patched:
        return
    original_acompletion = getattr(litellm_module, "acompletion", None)
    if not callable(original_acompletion):
        return

    async def _tracked_acompletion(*args, **kwargs):
        if _MODEL_CALL_INSTRUMENTATION_ACTIVE.get() or not _USER_CTX.get():
            return await original_acompletion(*args, **kwargs)
        model = str(kwargs.get("model") or (args[0] if args else "") or "").strip()
        if not model:
            return await original_acompletion(*args, **kwargs)
        reservation_id = await _meter_reserve(
            model=model,
            billing_kind="text",
            billing_params=_text_billing_params_from_openai_kwargs(kwargs),
            metadata={
                "source": "litellm_acompletion",
                "call_type": "acompletion",
                "request_payload": _json_log_value(kwargs),
            },
        )
        token = _MODEL_CALL_INSTRUMENTATION_ACTIVE.set(True)
        try:
            response = await original_acompletion(*args, **kwargs)
        except BaseException as exc:
            await _meter_refund(
                reservation_id,
                metadata=_failure_log_metadata(exc),
            )
            raise
        finally:
            _MODEL_CALL_INSTRUMENTATION_ACTIVE.reset(token)
        call_kwargs = dict(kwargs)
        call_kwargs.setdefault("model", model)
        try:
            await _forward_litellm_success(
                call_kwargs, response, credit_reservation_id=reservation_id
            )
        except Exception as exc:
            logger.debug("litellm acompletion success emit failed: %s", exc)
        return response

    setattr(litellm_module, "acompletion", _tracked_acompletion)
    _litellm_acompletion_patched = True


def _install_litellm_hook() -> None:
    global _litellm_hook_installed
    if _litellm_hook_installed:
        return
    try:
        import litellm  # type: ignore[import-not-found]
        from litellm.integrations.custom_logger import CustomLogger  # type: ignore[import-not-found]
    except Exception:
        return

    class _SupertaleUsageLogger(CustomLogger):
        def _extract(self, kwargs: dict, response_obj: object) -> tuple[int, int, str]:
            return _extract_litellm_usage(kwargs, response_obj)

        async def _forward_success(self, kwargs, response_obj) -> None:
            if _MODEL_CALL_INSTRUMENTATION_ACTIVE.get():
                return
            reservation_id = _pop_credit_reservation()
            await _forward_litellm_success(
                kwargs, response_obj, credit_reservation_id=reservation_id
            )

        async def async_pre_call_hook(self, user_api_key_dict, cache, data, call_type):
            if _MODEL_CALL_INSTRUMENTATION_ACTIVE.get():
                return None
            if not _USER_CTX.get():
                return None
            model = str(data.get("model") or "").strip() if isinstance(data, dict) else ""
            if not model:
                return None
            reservation_id = await _meter_reserve(
                model=model,
                billing_kind="text",
                billing_params=_text_billing_params_from_openai_kwargs(data),
                metadata={
                    "source": "litellm_pre_call",
                    "call_type": str(call_type or ""),
                    "request_payload": _json_log_value(data),
                },
            )
            _push_credit_reservation(reservation_id)
            return None

        async def async_log_failure_event(self, kwargs, response_obj, start_time, end_time):
            if _MODEL_CALL_INSTRUMENTATION_ACTIVE.get():
                return
            reservation_id = _pop_credit_reservation()
            error = kwargs.get("exception") if isinstance(kwargs, dict) else None
            if not isinstance(error, BaseException):
                error = RuntimeError(str(error or "model call failed"))
            await _meter_refund(
                reservation_id,
                metadata=_failure_log_metadata(error, response_obj),
            )

        def log_failure_event(self, kwargs, response_obj, start_time, end_time):
            import asyncio

            if _MODEL_CALL_INSTRUMENTATION_ACTIVE.get():
                return
            reservation_id = _pop_credit_reservation()
            error = kwargs.get("exception") if isinstance(kwargs, dict) else None
            if not isinstance(error, BaseException):
                error = RuntimeError(str(error or "model call failed"))
            coro = _meter_refund(
                reservation_id,
                metadata=_failure_log_metadata(error, response_obj),
            )
            try:
                loop = asyncio.get_running_loop()
            except RuntimeError:
                loop = None
            if loop is not None:
                loop.create_task(coro)
            else:
                asyncio.run(coro)

        async def async_log_success_event(self, kwargs, response_obj, start_time, end_time):
            await self._forward_success(kwargs, response_obj)

        def log_success_event(self, kwargs, response_obj, start_time, end_time):
            import asyncio

            coro = self._forward_success(kwargs, response_obj)
            try:
                loop = asyncio.get_running_loop()
            except RuntimeError:
                loop = None
            if loop is not None:
                loop.create_task(coro)
            else:
                asyncio.run(coro)

    hook = _SupertaleUsageLogger()
    try:
        existing = list(getattr(litellm, "callbacks", None) or [])
        if not any(isinstance(item, _SupertaleUsageLogger) for item in existing):
            existing.append(hook)
            litellm.callbacks = existing
        _patch_litellm_acompletion(litellm)
        _litellm_hook_installed = True
    except Exception as e:
        logger.debug("litellm hook install failed: %s", e)


def install_provider_instrumentation() -> None:
    _install_pydantic_ai_openai_trace_patch()
    _install_agent_run_patch()
    _install_litellm_hook()
