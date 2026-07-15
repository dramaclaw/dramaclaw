"""NovelVideo 配置模块。

独立的配置系统，不依赖 SuperScript。
"""

import os
from dataclasses import dataclass
from typing import Any

from dotenv import load_dotenv
from novelvideo.official_defaults import (
    DEFAULT_TEXT_MODEL_BY_ENV,
    OFFICIAL_NEWAPI_BASE_URL,
)

# 加载环境变量（必须在任何其他导入之前）
load_dotenv()

# =============================================================================
# 模型提供商配置
# =============================================================================

PROVIDER_PRESETS = {
    "openai": {
        "base_url": None,
        "default_model": "gpt-4o",
        "timeout": 120,
        "api_key_env": "OPENAI_API_KEY",
    },
    "anthropic": {
        "base_url": None,
        "default_model": "claude-sonnet-4-5",
        "timeout": 120,
        "api_key_env": "ANTHROPIC_API_KEY",
    },
    "gemini": {
        "base_url": None,
        "default_model": "gemini-3.5-flash",
        "timeout": 300,
        "api_key_env": "GOOGLE_API_KEY",
    },
    "openrouter": {
        "base_url": "https://openrouter.ai/api/v1",
        "default_model": "gemini-3.5-flash",
        "timeout": 300,
        "api_key_env": "OPENROUTER_API_KEY",
    },
    "volcengine": {
        "base_url": "https://ark.cn-beijing.volces.com/api/v3",
        "default_model": "doubao-seed-1-6-251015",
        "timeout": 1800,
        "api_key_env": "ARK_API_KEY",
    },
}

PROVIDER_ALIASES = {
    "doubao": "volcengine",
    "ark": "volcengine",
    "claude": "anthropic",
    "gpt": "openai",
    "google": "gemini",
    "or": "openrouter",
}


def _env_float(name: str, default: float) -> float:
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    try:
        return float(raw)
    except ValueError:
        return default


def _env_bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    normalized = raw.strip().lower()
    if normalized in {"1", "true", "yes", "y", "on"}:
        return True
    if normalized in {"0", "false", "no", "n", "off"}:
        return False
    return default


def get_pydantic_model(
    provider_override: str | None = None,
    model_name_override: str | None = None,
):
    """根据环境变量获取 PydanticAI Model 实例。

    用于 novelvideo 模块的所有 Agent 调用。

    Args:
        provider_override: 覆盖环境变量中的 provider
        model_name_override: 覆盖环境变量中的 model name
    """
    provider = (provider_override or os.environ.get("MODEL_PROVIDER", "volcengine")).lower()
    provider = PROVIDER_ALIASES.get(provider, provider)

    if provider not in PROVIDER_PRESETS:
        available = list(PROVIDER_PRESETS.keys()) + list(PROVIDER_ALIASES.keys())
        raise ValueError(f"Unknown provider: {provider}. " f"Available: {', '.join(available)}")

    preset = PROVIDER_PRESETS[provider]
    model_name = model_name_override or os.environ.get("MODEL_NAME", preset["default_model"])
    api_key = os.environ.get("MODEL_API_KEY") or os.environ.get(preset["api_key_env"])

    if not api_key:
        raise ValueError(
            f"API key not set. "
            f"Set MODEL_API_KEY or {preset['api_key_env']} environment variable."
        )

    base_url = os.environ.get("MODEL_BASE_URL", preset["base_url"])

    if provider == "openrouter" and model_name.startswith("openrouter/"):
        model_name = model_name[len("openrouter/") :]

    if provider == "anthropic":
        from pydantic_ai.models.anthropic import AnthropicModel
        from pydantic_ai.providers.anthropic import AnthropicProvider

        return AnthropicModel(model_name, provider=AnthropicProvider(api_key=api_key))
    elif provider == "gemini":
        from pydantic_ai.models.google import GoogleModel
        from pydantic_ai.providers.google import GoogleProvider

        return GoogleModel(model_name, provider=GoogleProvider(api_key=api_key))
    elif provider == "openrouter":
        from pydantic_ai.models.openrouter import OpenRouterModel
        from pydantic_ai.providers.openrouter import OpenRouterProvider

        provider_kwargs = {"api_key": api_key}
        app_url = os.environ.get("OPENROUTER_APP_URL", "").strip()
        app_title = os.environ.get("OPENROUTER_APP_TITLE", "").strip()
        if app_url:
            provider_kwargs["app_url"] = app_url
        if app_title:
            provider_kwargs["app_title"] = app_title
        return OpenRouterModel(model_name, provider=OpenRouterProvider(**provider_kwargs))
    else:
        # OpenAI 兼容 (openai, volcengine, openrouter 等)
        from pydantic_ai.models.openai import OpenAIChatModel
        from pydantic_ai.providers.openai import OpenAIProvider

        provider_kwargs = {"api_key": api_key}
        if base_url:
            provider_kwargs["base_url"] = base_url
        return OpenAIChatModel(model_name, provider=OpenAIProvider(**provider_kwargs))


def _clean_env_value(name: str | None) -> str | None:
    if not name:
        return None
    value = os.environ.get(name)
    if value is None:
        return None
    value = value.strip()
    return value or None


def get_newapi_text_model_name(model_env: str, default_model: str) -> str:
    """Return the logical newAPI text model for a path-specific task."""
    return _clean_env_value(model_env) or DEFAULT_TEXT_MODEL_BY_ENV.get(
        model_env, default_model
    )


def _get_newapi_text_model_profile(model_name: str):
    """Attach Gemini-compatible model profile while routing through newAPI."""
    normalized = (model_name or "").strip()
    if not normalized.startswith("gemini-") or "image" in normalized:
        return None

    from pydantic_ai.providers.openrouter import OpenRouterProvider

    return OpenRouterProvider.model_profile(f"google/{normalized}")


def _newapi_text_http_client_factory(
    *,
    timeout_seconds: float,
) -> Any:
    trust_env = _env_bool("NEWAPI_TEXT_TRUST_ENV", True)

    def factory():
        import httpx

        kwargs: dict[str, Any] = {"timeout": timeout_seconds}
        if not trust_env:
            kwargs["trust_env"] = False
        return httpx.AsyncClient(**kwargs)

    return factory


def _newapi_text_openai_provider(
    *,
    api_key: str,
    base_url: str,
    timeout_seconds: float,
):
    from openai import AsyncOpenAI
    from pydantic_ai.providers.openai import OpenAIProvider

    class _LifecycleManagedOpenAIProvider(OpenAIProvider):
        def __init__(self) -> None:
            http_client_factory = _newapi_text_http_client_factory(
                timeout_seconds=timeout_seconds,
            )
            http_client = http_client_factory()
            super().__init__(
                openai_client=AsyncOpenAI(
                    api_key=api_key,
                    base_url=base_url,
                    timeout=timeout_seconds,
                    max_retries=1,
                    http_client=http_client,
                ),
            )
            self._own_http_client = http_client
            self._http_client_factory = http_client_factory

    return _LifecycleManagedOpenAIProvider()


def _newapi_text_openai_model(
    model_name: str,
    *,
    api_key: str,
    base_url: str,
    timeout_seconds: float,
    profile: Any,
):
    from contextlib import asynccontextmanager

    from pydantic_ai.models.openai import OpenAIChatModel

    class _AutoClosingOpenAIChatModel(OpenAIChatModel):
        async def request(self, *args: Any, **kwargs: Any) -> Any:
            async with self:
                return await super().request(*args, **kwargs)

        @asynccontextmanager
        async def request_stream(self, *args: Any, **kwargs: Any):
            async with self:
                async with super().request_stream(*args, **kwargs) as response:
                    yield response

    return _AutoClosingOpenAIChatModel(
        model_name,
        provider=_newapi_text_openai_provider(
            api_key=api_key,
            base_url=base_url,
            timeout_seconds=timeout_seconds,
        ),
        profile=profile,
    )


def get_newapi_text_pydantic_model(model_env: str, default_model: str):
    """Create a PydanticAI OpenAI-compatible model that routes through newAPI."""
    model_name = get_newapi_text_model_name(model_env, default_model)
    api_key, base_url = get_newapi_runtime_credentials(
        env_api_key="MODEL_API_KEY",
        env_base_url="MODEL_BASE_URL",
    )
    if not api_key:
        raise ValueError("API key not set. Configure DramaClawAPI credentials.")
    timeout_seconds = _env_float(
        f"{model_env}_TIMEOUT_SECONDS",
        _env_float("NEWAPI_TEXT_TIMEOUT_SECONDS", 120.0),
    )
    return _newapi_text_openai_model(
        model_name,
        api_key=api_key,
        base_url=base_url,
        timeout_seconds=timeout_seconds,
        profile=_get_newapi_text_model_profile(model_name),
    )


def get_newapi_text_pydantic_model_settings(
    thinking_env: str,
    default_thinking_level: str,
) -> dict | None:
    """Build PydanticAI model settings for a newAPI text task."""
    thinking_level = get_text_thinking_level(thinking_env, default_thinking_level)
    reasoning_effort = _normalize_openai_compat_reasoning_effort(thinking_level)
    if not reasoning_effort:
        return None
    return {"openai_reasoning_effort": reasoning_effort}


def get_superpower_pydantic_model(
    *,
    feature_provider_env: str | None = None,
    feature_model_env: str | None = None,
):
    """Return the multimodal model used by SuperPower prompt builders.

    By default this inherits the normal MODEL_PROVIDER/MODEL_NAME settings.
    Individual prompt builders can override that with feature-specific env vars
    (for example GLOBAL_VIDEO_PROVIDER/GLOBAL_VIDEO_MODEL). Global
    SUPERPOWER_* env vars remain available for deployments that want one shared
    SuperPower provider without hard-coding Google/Gemini in code.
    """

    provider_override = (
        _clean_env_value(feature_provider_env)
        or _clean_env_value("SUPERPOWER_PROVIDER")
        or _clean_env_value("SUPERPOWER_MODEL_PROVIDER")
    )
    model_name_override = (
        _clean_env_value(feature_model_env)
        or _clean_env_value("SUPERPOWER_MODEL")
        or _clean_env_value("SUPERPOWER_MODEL_NAME")
    )
    return get_pydantic_model(
        provider_override=provider_override,
        model_name_override=model_name_override,
    )


def get_pydantic_model_settings(
    provider_override: str | None = None,
    model_name_override: str | None = None,
    *,
    max_tokens: int | None = None,
    thinking_level_override: str | None = None,
) -> dict | None:
    """获取 PydanticAI 的通用 model_settings。"""
    provider = (provider_override or os.environ.get("MODEL_PROVIDER", "volcengine")).lower()
    provider = PROVIDER_ALIASES.get(provider, provider)

    preset = PROVIDER_PRESETS.get(provider, {})
    _model_name = model_name_override or os.environ.get(
        "MODEL_NAME", preset.get("default_model", "")
    )
    thinking_level = (
        thinking_level_override
        or os.environ.get("MODEL_THINKING_LEVEL")
        or preset.get("thinking_level")
        or "low"
    )

    settings: dict[str, object] = {}
    if max_tokens is not None:
        settings["max_tokens"] = max_tokens

    if thinking_level:
        normalized = str(thinking_level).strip().lower()
        if provider == "gemini":
            settings["google_thinking_config"] = {"thinking_level": normalized}
        elif provider == "openai" and normalized in {"low", "medium", "high"}:
            settings["openai_reasoning_effort"] = normalized
        elif provider == "openrouter" and normalized in {"low", "medium", "high"}:
            settings["openrouter_reasoning"] = {"effort": normalized}

    return settings or None


def get_text_thinking_level(env_name: str, default: str) -> str:
    """Read a path-specific thinking level.

    Missing env vars use the caller default. Explicit empty env vars mean
    "do not send a thinking/reasoning setting" for that path.
    """
    return os.environ.get(env_name, default).strip()


_OPENAI_COMPAT_REASONING_EFFORTS = {"none", "minimal", "low", "medium", "high", "xhigh"}


def _normalize_openai_compat_reasoning_effort(value: str | None) -> str:
    normalized = str(value or "").strip().lower()
    return normalized if normalized in _OPENAI_COMPAT_REASONING_EFFORTS else ""


def _is_openai_compatible_runtime() -> bool:
    provider = (
        (
            os.environ.get("LLM_PROVIDER")
            or os.environ.get("COGNEE_LLM_PROVIDER")
            or os.environ.get("MODEL_PROVIDER")
            or ""
        )
        .strip()
        .lower()
    )
    return provider in {"newapi", "custom"}


def get_newapi_reasoning_kwargs(
    *,
    thinking_env: str | None = None,
    default_thinking_level: str | None = None,
) -> dict:
    """Build reasoning kwargs for OpenAI-compatible newAPI/Cognee calls.

    Explicit empty env values disable sending reasoning parameters.
    Direct providers keep their original request shape.
    """
    if not _is_openai_compatible_runtime():
        return {}
    if thinking_env and thinking_env in os.environ:
        thinking_level = os.environ.get(thinking_env, "").strip()
    elif default_thinking_level is not None:
        thinking_level = default_thinking_level
    else:
        thinking_level = os.environ.get("MODEL_THINKING_LEVEL", "").strip()
    reasoning_effort = _normalize_openai_compat_reasoning_effort(thinking_level)
    if not reasoning_effort:
        return {}
    return {
        "reasoning_effort": reasoning_effort,
        "allowed_openai_params": ["reasoning_effort"],
    }


def get_model_info() -> dict:
    """获取当前模型配置信息。"""
    provider = os.environ.get("MODEL_PROVIDER", "volcengine").lower()
    provider = PROVIDER_ALIASES.get(provider, provider)
    preset = PROVIDER_PRESETS.get(provider, {})

    return {
        "provider": provider,
        "model": os.environ.get("MODEL_NAME", preset.get("default_model", "unknown")),
        "base_url": os.environ.get("MODEL_BASE_URL", preset.get("base_url")),
        "timeout": int(os.environ.get("MODEL_TIMEOUT", preset.get("timeout", 120))),
    }


# Redis 配置
REDIS_URL = os.environ.get("REDIS_URL", "redis://localhost:6379")


# =============================================================================
# 基础配置
# =============================================================================

# 数据根目录，三类子目录 (output/state/runtime) 默认基于此目录派生
DATA_ROOT = os.path.abspath(os.environ.get("NOVELVIDEO_DATA_ROOT", "."))

# 使用绝对路径，确保 task worker 也能找到正确的目录
OUTPUT_DIR = os.path.abspath(
    os.environ.get("NOVELVIDEO_OUTPUT_DIR", os.path.join(DATA_ROOT, "output"))
)

# 状态文件目录 (data.db, cognee_system/, project_config.json)
STATE_DIR = os.path.abspath(
    os.environ.get("NOVELVIDEO_STATE_DIR", os.path.join(DATA_ROOT, "state"))
)

# 运行时临时目录 (日志、staging、temp panels)
RUNTIME_DIR = os.path.abspath(
    os.environ.get("NOVELVIDEO_RUNTIME_DIR", os.path.join(DATA_ROOT, "runtime"))
)

# =============================================================================
# OSS presign 配置
# =============================================================================

OSS_ENDPOINT = os.environ.get("OSS_ENDPOINT")
OSS_PUBLIC_ENDPOINT = os.environ.get("OSS_PUBLIC_ENDPOINT")
OSS_BUCKET = os.environ.get("OSS_BUCKET")
OSS_ACCESS_KEY_ID = os.environ.get("OSS_ACCESS_KEY_ID")
OSS_ACCESS_KEY_SECRET = os.environ.get("OSS_ACCESS_KEY_SECRET")
OSS_OBJECT_PREFIX = os.environ.get("OSS_OBJECT_PREFIX", "output")
DOWNLOAD_VIA_OSS = os.environ.get("DOWNLOAD_VIA_OSS", "1") not in {
    "0",
    "false",
    "False",
    "",
}
STATIC_VIA_OSS = os.environ.get("STATIC_VIA_OSS", "1") not in {
    "0",
    "false",
    "False",
    "",
}
OSS_STATIC_REQUIRE_READY = os.environ.get("OSS_STATIC_REQUIRE_READY", "1") not in {
    "0",
    "false",
    "False",
    "",
}
OSS_STATIC_READY_PROBE_ATTEMPTS = int(os.environ.get("OSS_STATIC_READY_PROBE_ATTEMPTS", "3"))
OSS_STATIC_READY_PROBE_DELAY_SECONDS = float(
    os.environ.get("OSS_STATIC_READY_PROBE_DELAY_SECONDS", "0.15")
)
OSS_PRESIGN_EXPIRES = int(os.environ.get("OSS_PRESIGN_EXPIRES", "900"))
OSS_STATIC_PRESIGN_EXPIRES = int(os.environ.get("OSS_STATIC_PRESIGN_EXPIRES", "3600"))


# =============================================================================
# IndexTTS2 配置
# =============================================================================

INDEXTTS2_PROVIDER = os.environ.get("INDEXTTS2_PROVIDER", "newapi").strip().lower() or "newapi"
if INDEXTTS2_PROVIDER not in {"newapi", "fal"}:
    INDEXTTS2_PROVIDER = "newapi"
FAL_API_KEY = os.environ.get("FAL_API_KEY", "") or os.environ.get("FAL_KEY", "")
INDEXTTS2_FAL_ENDPOINT = os.environ.get(
    "INDEXTTS2_FAL_ENDPOINT",
    "https://fal.run/fal-ai/index-tts-2/text-to-speech",
)
INDEXTTS2_TIMEOUT_SECONDS = float(os.environ.get("INDEXTTS2_TIMEOUT_SECONDS", "1800"))

NEWAPI_BASE_URL = os.environ.get("NEWAPI_BASE_URL", "")
NEWAPI_API_KEY = os.environ.get("NEWAPI_API_KEY", "")


def get_effective_newapi_gateway_config():
    """Return the selected NewAPI runtime gateway credentials."""
    from novelvideo.model_gateway_settings import get_effective_newapi_config

    return get_effective_newapi_config(
        official_base_url=OFFICIAL_NEWAPI_BASE_URL,
        official_api_key=NEWAPI_API_KEY,
    )


def get_newapi_runtime_credentials(
    *,
    api_key_override: str | None = None,
    base_url_override: str | None = None,
    env_api_key: str = "NEWAPI_API_KEY",
    env_base_url: str = "NEWAPI_BASE_URL",
) -> tuple[str, str]:
    """Resolve NewAPI credentials with UI settings before env vars.

    Precedence:
    explicit call overrides > settings.db > requested env vars > NEWAPI env vars
    > legacy OpenAI-compatible env vars > defaults.
    """

    gateway = get_effective_newapi_gateway_config()
    api_key = (
        str(api_key_override or "").strip()
        or str(gateway.api_key or "").strip()
        or os.environ.get(env_api_key, "").strip()
        or NEWAPI_API_KEY
        or os.environ.get("MODEL_API_KEY", "").strip()
        or os.environ.get("OPENAI_API_KEY", "").strip()
    )
    base_url = (
        str(base_url_override or "").strip().rstrip("/")
        or str(gateway.base_url or "").strip()
        or os.environ.get(env_base_url, "").strip().rstrip("/")
        or str(NEWAPI_BASE_URL or "").strip().rstrip("/")
        or os.environ.get("MODEL_BASE_URL", "").strip().rstrip("/")
        or OFFICIAL_NEWAPI_BASE_URL
    )
    return api_key, base_url


INDEXTTS2_NEWAPI_MODEL = os.environ.get("INDEXTTS2_NEWAPI_MODEL", "index-tts-2")
INDEXTTS2_RECORD_PROVIDER = "newapi" if INDEXTTS2_PROVIDER == "newapi" else "fal.ai"
INDEXTTS2_RECORD_MODEL = INDEXTTS2_NEWAPI_MODEL if INDEXTTS2_PROVIDER == "newapi" else "IndexTTS2"
NEWAPI_IMAGE_MODEL = os.environ.get("NEWAPI_IMAGE_MODEL", "LingShan-G2")
NEWAPI_NANOBANANA2_MODEL = os.environ.get("NEWAPI_NANOBANANA2_MODEL", "LingShan-NB-2")
SCENE_MASTER_IMAGE_PROVIDER = (
    os.environ.get("SCENE_MASTER_IMAGE_PROVIDER", "").strip().lower() or "newapi"
)
SCENE_MASTER_IMAGE_MODEL = os.environ.get("SCENE_MASTER_IMAGE_MODEL", "")
SCENE_REVERSE_MASTER_IMAGE_PROVIDER = (
    os.environ.get("SCENE_REVERSE_MASTER_IMAGE_PROVIDER", "").strip().lower() or "newapi"
)
SCENE_REVERSE_MASTER_IMAGE_MODEL = os.environ.get("SCENE_REVERSE_MASTER_IMAGE_MODEL", "")
SCENE_360_IMAGE_PROVIDER = (
    os.environ.get("SCENE_360_IMAGE_PROVIDER", "").strip().lower() or "newapi"
)
SCENE_360_IMAGE_MODEL = os.environ.get("SCENE_360_IMAGE_MODEL", "")
PROP_REF_IMAGE_PROVIDER = (
    os.environ.get("PROP_REF_IMAGE_PROVIDER", "").strip().lower() or "newapi"
)
PROP_REF_IMAGE_MODEL = os.environ.get("PROP_REF_IMAGE_MODEL", "")


# =============================================================================
# 火山引擎图像生成配置
# =============================================================================

VOLCENGINE_VISUAL_API_KEY = os.environ.get("VOLCENGINE_VISUAL_API_KEY") or os.environ.get(
    "ARK_API_KEY"
)
VOLCENGINE_VISUAL_ENDPOINT = os.environ.get(
    "VOLCENGINE_VISUAL_ENDPOINT", "https://ark.cn-beijing.volces.com/api/v3"
)

SEEDREAM_MODEL = os.environ.get("SEEDREAM_MODEL", "doubao-seedream-4-5-251128")
SEEDEDIT_MODEL = os.environ.get("SEEDEDIT_MODEL", "doubao-seededit-3-0-i2i-250628")

IMAGE_DEFAULT_WIDTH = int(os.environ.get("IMAGE_DEFAULT_WIDTH", "1440"))
IMAGE_DEFAULT_HEIGHT = int(os.environ.get("IMAGE_DEFAULT_HEIGHT", "2560"))
IMAGE_DEFAULT_STYLE = os.environ.get("IMAGE_DEFAULT_STYLE", "chinese_period_drama")

# 角色参考图生成模型选择
# "nanobanana" - 使用 Nano Banana Pro (Gemini)，与网格生成同一模型，一致性更好
# "seedream" - 使用 Seedream 4.5 (火山引擎)，质量高但与网格生成跨模型
CHARACTER_IMAGE_MODEL = os.environ.get("CHARACTER_IMAGE_MODEL", "nanobanana")

# 风格预设统一由 src/novelvideo/styles/presets/*.json 提供。


def get_style_preset(
    style: str = None,
    *,
    username: str | None = None,
    project: str | None = None,
    project_dir: str | None = None,
) -> dict:
    """获取视觉风格预设配置。

    Args:
        style: 风格名称，默认使用 IMAGE_DEFAULT_STYLE

    Returns:
        风格预设字典
    """
    style = style or IMAGE_DEFAULT_STYLE

    from novelvideo.services.style_service import StyleService

    config = StyleService.get_style(
        style,
        username=username,
        project=project,
        project_dir=project_dir,
    )
    if not config:
        raise KeyError(f"Style '{style}' not found")
    return config.to_legacy_dict()


# =============================================================================
# LLM 临时媒体中转（给 newAPI/视觉模型拉取本地参考图）
# =============================================================================

MEDIA_RELAY_PROVIDER = os.environ.get("MEDIA_RELAY_PROVIDER", "aliyun_oss").strip().lower()
MEDIA_RELAY_TTL_SECONDS = int(os.environ.get("MEDIA_RELAY_TTL_SECONDS", "1800"))

OSS_RELAY_ENDPOINT = os.environ.get("OSS_RELAY_ENDPOINT", "oss-cn-chengdu.aliyuncs.com")
OSS_RELAY_BUCKET = os.environ.get("OSS_RELAY_BUCKET", "claymore-llm-relay")
OSS_RELAY_AK = os.environ.get("OSS_RELAY_AK", "")
OSS_RELAY_SK = os.environ.get("OSS_RELAY_SK", "")

CLOUDINARY_RELAY_CLOUD_NAME = os.environ.get("CLOUDINARY_RELAY_CLOUD_NAME", "")
CLOUDINARY_RELAY_API_KEY = os.environ.get("CLOUDINARY_RELAY_API_KEY", "")
CLOUDINARY_RELAY_API_SECRET = os.environ.get("CLOUDINARY_RELAY_API_SECRET", "")
CLOUDINARY_RELAY_FOLDER = os.environ.get("CLOUDINARY_RELAY_FOLDER", "")


def get_style_labels() -> dict[str, str]:
    """获取风格 ID -> 显示标签的映射。

    Returns:
        {style_id: label} 字典
    """
    from novelvideo.services.style_service import StyleService

    return StyleService.get_style_labels()


def list_available_styles() -> list[dict]:
    """列出所有可用风格（预设 + 自定义）。

    Returns:
        风格列表，每项包含 {id, name, label, type}
    """
    from novelvideo.services.style_service import StyleService

    return StyleService.list_all_styles()


def get_image_config() -> dict:
    """获取图像生成配置。"""
    from novelvideo.services.style_service import StyleService

    all_styles = StyleService.list_all_styles()
    style_presets = {s["id"]: StyleService.get_legacy_style_preset(s["id"]) for s in all_styles}

    return {
        "api_key": VOLCENGINE_VISUAL_API_KEY,
        "endpoint": VOLCENGINE_VISUAL_ENDPOINT,
        "seedream_model": SEEDREAM_MODEL,
        "seededit_model": SEEDEDIT_MODEL,
        "default_width": IMAGE_DEFAULT_WIDTH,
        "default_height": IMAGE_DEFAULT_HEIGHT,
        "default_style": IMAGE_DEFAULT_STYLE,
        "style_presets": style_presets,
        "character_image_model": CHARACTER_IMAGE_MODEL,
        "character_image_selection": get_character_image_selection(),
    }


def get_character_image_model() -> str:
    """获取角色参考图生成模型类型。

    Returns:
        "nanobanana" 或 "seedream"
    """
    return CHARACTER_IMAGE_MODEL


# =============================================================================
# TTS 配置
# =============================================================================

TTS_PROVIDER = os.environ.get("TTS_PROVIDER", "cosyvoice")  # 默认 CosyVoice
EDGE_TTS_VOICE = os.environ.get("EDGE_TTS_VOICE", "zh-CN-XiaoxiaoNeural")
VOLCENGINE_TTS_ENDPOINT = os.environ.get(
    "VOLCENGINE_TTS_ENDPOINT", "https://openspeech.bytedance.com/api/v1/tts"
)

# CosyVoice 配置（阿里云 DashScope）
COSYVOICE_MODEL = os.environ.get("COSYVOICE_MODEL", "cosyvoice-v3-flash")
COSYVOICE_VOICE = os.environ.get("COSYVOICE_VOICE", "longxiaoxia_v3")
DASHSCOPE_API_KEY = os.environ.get("DASHSCOPE_API_KEY")

# CosyVoice 语速倍率（范围 [0.5, 2.0]，1.0 为标准速度）
COSYVOICE_SPEECH_RATE = float(os.environ.get("COSYVOICE_SPEECH_RATE", "1.2"))

# TTS 语速估算（实测 1.0x 均值 4.45 字/秒 × 1.3x 加速 ≈ 5.8 字/秒）
TTS_CHARS_PER_SECOND = float(os.environ.get("TTS_CHARS_PER_SECOND", "5.8"))

# Dialogue beat TTS 配置（角色台词使用不同语速）
COSYVOICE_DIALOGUE_SPEECH_RATE = float(os.environ.get("COSYVOICE_DIALOGUE_SPEECH_RATE", "1.0"))
TTS_DIALOGUE_CHARS_PER_SECOND = float(os.environ.get("TTS_DIALOGUE_CHARS_PER_SECOND", "4.45"))


def get_tts_config() -> dict:
    """获取 TTS 配置。"""
    return {
        "provider": TTS_PROVIDER,
        # Edge TTS
        "default_voice": EDGE_TTS_VOICE,
        "rate": os.environ.get("TTS_RATE", "+0%"),
        "pitch": os.environ.get("TTS_PITCH", "+0Hz"),
        "volcengine_endpoint": VOLCENGINE_TTS_ENDPOINT,
        "volcengine_api_key": VOLCENGINE_VISUAL_API_KEY,
        # CosyVoice
        "cosyvoice_model": COSYVOICE_MODEL,
        "cosyvoice_voice": COSYVOICE_VOICE,
        "cosyvoice_speech_rate": COSYVOICE_SPEECH_RATE,
        "dashscope_api_key": DASHSCOPE_API_KEY,
    }


# =============================================================================
# Fish Audio S2 配置（情感语音合成）
# =============================================================================

FISH_AUDIO_API_KEY = os.environ.get("FISH_AUDIO_API_KEY")
FISH_AUDIO_SPEED = float(os.environ.get("FISH_AUDIO_SPEED", "1.0"))

# Fish Audio 声音预设 (8 种: age_group × gender)
FISH_VOICE_PRESETS = {
    "child_male": os.environ.get("FISH_VOICE_CHILD_MALE", ""),
    "child_female": os.environ.get("FISH_VOICE_CHILD_FEMALE", ""),
    "youth_male": os.environ.get("FISH_VOICE_YOUTH_MALE", ""),
    "youth_female": os.environ.get("FISH_VOICE_YOUTH_FEMALE", ""),
    "middle_male": os.environ.get("FISH_VOICE_MIDDLE_MALE", ""),
    "middle_female": os.environ.get("FISH_VOICE_MIDDLE_FEMALE", ""),
    "elder_male": os.environ.get("FISH_VOICE_ELDER_MALE", ""),
    "elder_female": os.environ.get("FISH_VOICE_ELDER_FEMALE", ""),
}


def get_fish_voice_id(age_group: str, gender: str) -> str:
    """根据年龄段+性别获取预设 voice ID。"""
    gender_key = "female" if "女" in gender else "male"
    return FISH_VOICE_PRESETS.get(f"{age_group}_{gender_key}", "")


# =============================================================================
# 视频合成配置
# =============================================================================

FFMPEG_PATH = os.environ.get("FFMPEG_PATH", "ffmpeg")
VIDEO_FPS = int(os.environ.get("VIDEO_FPS", "30"))
VIDEO_WIDTH = int(os.environ.get("VIDEO_WIDTH", "1080"))
VIDEO_HEIGHT = int(os.environ.get("VIDEO_HEIGHT", "1920"))
VIDEO_CODEC = os.environ.get("VIDEO_CODEC", "libx264")
VIDEO_AUDIO_CODEC = os.environ.get("VIDEO_AUDIO_CODEC", "aac")
VIDEO_BITRATE = os.environ.get("VIDEO_BITRATE", "4M")

KEN_BURNS_ZOOM_RANGE = (1.0, 1.15)
KEN_BURNS_PAN_SPEED = 0.02

# =============================================================================
# AI 视频生成配置（图生视频）
# =============================================================================


def _csv_env(name: str, default: str) -> list[str]:
    values = [item.strip() for item in os.environ.get(name, default).split(",")]
    return [item for item in values if item]


# newAPI 视频网关。VIDEO_BACKEND 使用 newapi_<model> 时会通过 NEWAPI_BASE_URL 调用。
NEWAPI_VIDEO_MODELS = _csv_env(
    "NEWAPI_VIDEO_MODELS",
    "seedance-1.0-pro-fast,seedance-1.5-pro,seedance-2.0,seedance-2.0-fast,seedance-2.0-value,seedance-2.0-fast-value,happyhorse-1.0",
)
DEFAULT_VIDEO_MODEL = os.environ.get(
    "DEFAULT_VIDEO_MODEL",
    os.environ.get("NEWAPI_VIDEO_MODEL", NEWAPI_VIDEO_MODELS[0]),
).strip()
NEWAPI_VIDEO_MODEL = os.environ.get("NEWAPI_VIDEO_MODEL", DEFAULT_VIDEO_MODEL).strip()
NEWAPI_VIDEO_RESOLUTION = os.environ.get("NEWAPI_VIDEO_RESOLUTION", "720p")
NEWAPI_VIDEO_AUDIO_MODELS = _csv_env(
    "NEWAPI_VIDEO_AUDIO_MODELS",
    "seedance-1.5-pro,seedance-2.0,seedance-2.0-fast,seedance-2.0-value,seedance-2.0-fast-value",
)
NEWAPI_VIDEO_DURATION_BOUNDS = os.environ.get(
    "NEWAPI_VIDEO_DURATION_BOUNDS",
    "seedance-1.0-pro-fast:2-12,seedance-1.5-pro:4-12,seedance-2.0:4-15,seedance-2.0-fast:4-15,seedance-2.0-value:4-15,seedance-2.0-fast-value:4-15,happyhorse-1.0:3-15",
).strip()

# 视频生成后端: newapi_seedance-1.0-pro-fast (默认), newapi_seedance-2.0-fast,
# comfyui, seedance_fast, seedance_pro, seedance_pro_silent, wan26, grok_720
VIDEO_BACKEND = os.environ.get("VIDEO_BACKEND", f"newapi_{DEFAULT_VIDEO_MODEL}")

# Seedance 模型（火山方舟）
SEEDANCE_FAST_MODEL = os.environ.get("SEEDANCE_FAST_MODEL", "doubao-seedance-1-0-pro-fast-251015")
SEEDANCE_PRO_MODEL = os.environ.get("SEEDANCE_PRO_MODEL", "doubao-seedance-1-5-pro-251215")

# HuiMeng 视频聚合 API
HUIMENGI_BASE_URL = os.environ.get("HUIMENGI_BASE_URL", "https://api.huimengi.com")
HUIMENGI_VIDEO_RESOLUTION = os.environ.get("HUIMENGI_VIDEO_RESOLUTION", "720p")
HUIMENGI_VIDEO_GENERATE_AUDIO = os.environ.get(
    "HUIMENGI_VIDEO_GENERATE_AUDIO", "false"
).lower() in ("true", "1", "yes")

# ComfyUI 本地视频生成服务
COMFYUI_VIDEO_URL = os.environ.get("COMFYUI_VIDEO_URL", "http://localhost:9527")

# ComfyUI 工作流类型: gguf (低显存，~8GB) 或 fp8 (高质量，~16GB)
# - gguf: 使用 GGUF 量化模型，适合显存较小的 GPU
# - fp8: 使用 fp8 精度模型，质量更好，支持 FLF (首尾帧) 模式
COMFYUI_WORKFLOW = os.environ.get("COMFYUI_WORKFLOW", "gguf")

# ComfyUI 是否使用 SSL（HTTPS/WSS），云服务器通常需要开启
COMFYUI_USE_SSL = os.environ.get("COMFYUI_USE_SSL", "false").lower() in ("true", "1", "yes")

# 默认视频分辨率（竖屏）
VIDEO_RESOLUTION = os.environ.get("VIDEO_RESOLUTION", "720x1280")

# 分辨率预设
VIDEO_RESOLUTION_PRESETS = {
    "720x1280": {"width": 720, "height": 1280, "label": "720p 竖屏"},
    "1080x1920": {"width": 1080, "height": 1920, "label": "1080p 竖屏"},
}


def get_video_generation_config() -> dict:
    """获取 AI 视频生成（图生视频）配置。"""
    resolution = VIDEO_RESOLUTION_PRESETS.get(
        VIDEO_RESOLUTION, VIDEO_RESOLUTION_PRESETS["720x1280"]
    )
    return {
        "backend": VIDEO_BACKEND,
        "huimengi_base_url": HUIMENGI_BASE_URL,
        "huimengi_video_resolution": HUIMENGI_VIDEO_RESOLUTION,
        "newapi_base_url": NEWAPI_BASE_URL,
        "newapi_video_models": list(NEWAPI_VIDEO_MODELS),
        "newapi_video_model": NEWAPI_VIDEO_MODEL,
        "newapi_video_resolution": NEWAPI_VIDEO_RESOLUTION,
        "comfyui_url": COMFYUI_VIDEO_URL,
        "comfyui_workflow": COMFYUI_WORKFLOW,
        "comfyui_use_ssl": COMFYUI_USE_SSL,
        "resolution": VIDEO_RESOLUTION,
        "width": resolution["width"],
        "height": resolution["height"],
        "resolution_presets": VIDEO_RESOLUTION_PRESETS,
    }


def get_video_config() -> dict:
    """获取视频配置。"""
    return {
        "ffmpeg_path": FFMPEG_PATH,
        "fps": VIDEO_FPS,
        "width": VIDEO_WIDTH,
        "height": VIDEO_HEIGHT,
        "codec": VIDEO_CODEC,
        "audio_codec": VIDEO_AUDIO_CODEC,
        "bitrate": VIDEO_BITRATE,
        "ken_burns_zoom_range": KEN_BURNS_ZOOM_RANGE,
        "ken_burns_pan_speed": KEN_BURNS_PAN_SPEED,
    }


# =============================================================================
# 图像生成配置（Google / OpenRouter / OpenAI / HuiMeng）
# =============================================================================

GOOGLE_AI_API_KEY = os.environ.get("GOOGLE_AI_API_KEY")
OPENROUTER_API_KEY = os.environ.get("OPENROUTER_API_KEY")
OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY")
HUIMENGI_API_KEY = os.environ.get("HUIMENGI_API_KEY")
OPENROUTER_GPT_IMAGE2_MODEL = os.environ.get(
    "OPENROUTER_GPT_IMAGE2_MODEL", "openai/gpt-5.4-image-2"
)
OPENROUTER_NANOBANANA2_MODEL = os.environ.get(
    "OPENROUTER_NANOBANANA2_MODEL", "google/gemini-3.1-flash-image-preview"
)

# 图像生成 Provider: "google" / "openrouter" / "openai" / "huimeng"
# OpenRouter 价格: $0.002/图 (2K) vs Google 官方 $0.134/图 (2K)
_NANOBANANA_PROVIDER_EXPLICIT = "NANOBANANA_PROVIDER" in os.environ
NANOBANANA_PROVIDER = os.environ.get("NANOBANANA_PROVIDER", "openrouter")


NANOBANANA_MODEL = os.environ.get("NANOBANANA_MODEL", "gemini-3.1-flash-image-preview")
OPENAI_IMAGE_MODEL = os.environ.get("OPENAI_IMAGE_MODEL", "gpt-image-2")
HUIMENG_IMAGE_MODEL = os.environ.get("HUIMENG_IMAGE_MODEL", "image-2")
HUIMENG_IMAGE_OFFICIAL_MODEL = os.environ.get("HUIMENG_IMAGE_OFFICIAL_MODEL", "image-2-official")
HUIMENG_NANOBANANA2_MODEL = os.environ.get("HUIMENG_NANOBANANA2_MODEL", "nb-2")
SCENE_360_PROVIDER = os.environ.get("SCENE_360_PROVIDER") or NANOBANANA_PROVIDER
SCENE_360_HUIMENG_MODEL = os.environ.get("SCENE_360_HUIMENG_MODEL", HUIMENG_IMAGE_MODEL)
SCENE_ASSET_PROVIDER = os.environ.get("SCENE_ASSET_PROVIDER") or NANOBANANA_PROVIDER
SCENE_ASSET_MODEL = os.environ.get("SCENE_ASSET_MODEL", "")
OPENAI_IMAGE_QUALITY = os.environ.get("OPENAI_IMAGE_QUALITY", "medium")
OPENAI_SKETCH_IMAGE_QUALITY = os.environ.get("OPENAI_SKETCH_IMAGE_QUALITY", "low")
_DEFAULT_SKETCH_SELECTION_EXPLICIT = "DEFAULT_SKETCH_IMAGE_SELECTION" in os.environ
_DEFAULT_RENDER_SELECTION_EXPLICIT = "DEFAULT_RENDER_IMAGE_SELECTION" in os.environ
DEFAULT_SKETCH_IMAGE_SELECTION = os.environ.get(
    "DEFAULT_SKETCH_IMAGE_SELECTION", "newapi_gpt_image2"
)
DEFAULT_RENDER_IMAGE_SELECTION = os.environ.get(
    "DEFAULT_RENDER_IMAGE_SELECTION", "newapi_gpt_image2"
)
CHARACTER_IMAGE_SELECTION = os.environ.get("CHARACTER_IMAGE_SELECTION") or os.environ.get(
    "DEFAULT_CHARACTER_IMAGE_SELECTION"
)

IMAGE_GENERATION_SELECTIONS: dict[str, dict[str, str]] = {
    "huimeng_gpt_image2": {
        "label": "HuiMeng GPT Image 2",
        "provider": "huimeng",
        "model": HUIMENG_IMAGE_MODEL,
    },
    "huimeng_image2_official": {
        "label": "HuiMeng Image 2 Official",
        "provider": "huimeng",
        "model": HUIMENG_IMAGE_OFFICIAL_MODEL,
    },
    "huimeng_nanobanana2": {
        "label": "HuiMeng NanoBanana 2",
        "provider": "huimeng",
        "model": HUIMENG_NANOBANANA2_MODEL,
    },
    "openai_gpt_image2": {
        "label": "OpenAI GPT Image 2",
        "provider": "openai",
        "model": OPENAI_IMAGE_MODEL,
    },
    "openrouter_gpt_image2": {
        "label": "OpenRouter GPT Image 2",
        "provider": "openrouter",
        "model": OPENROUTER_GPT_IMAGE2_MODEL,
    },
    "openrouter_nanobanana2": {
        "label": "OpenRouter NanoBanana 2",
        "provider": "openrouter",
        "model": OPENROUTER_NANOBANANA2_MODEL,
    },
    "newapi_gpt_image2": {
        "label": "LingShan-G2",
        "provider": "newapi",
        "model": NEWAPI_IMAGE_MODEL,
    },
    "newapi_nanobanana2": {
        "label": "LingShan-NB-2",
        "provider": "newapi",
        "model": NEWAPI_NANOBANANA2_MODEL,
    },
}

VISIBLE_IMAGE_GENERATION_SELECTION_KEYS = (
    "newapi_gpt_image2",
    "newapi_nanobanana2",
)

LEGACY_IMAGE_GENERATION_SELECTION_ALIASES = {
    "huimeng_gpt_image2": "newapi_gpt_image2",
    "huimeng_image2_official": "newapi_gpt_image2",
    "openai_gpt_image2": "newapi_gpt_image2",
    "openrouter_gpt_image2": "newapi_gpt_image2",
    "huimeng_nanobanana2": "newapi_nanobanana2",
    "openrouter_nanobanana2": "newapi_nanobanana2",
    "nanobanana": "newapi_nanobanana2",
    "seedream": "newapi_gpt_image2",
}

# 网格生成模式配置
# 竖屏 Panel 模式（每格竖屏，适合 I2V）：
# "1x1" - 单张生成（1K 分辨率，panel 高度 1376）
# "1x3" - 横向三格（panel 高度 877，竖屏 0.78）
# "1x4" - 横向四格（panel 高度 1097，竖屏 0.58）官方推荐 3-4 panel comic
# "3x2" - 6 panels（panel 高度 1365 ✓，竖屏 0.84）
# "4x3" - 12 panels（panel 高度 1024 ✓，竖屏 0.75）最优
# "5x4" - 20 panels（panel 高度 819，竖屏 0.70）
# 正方形 Panel 模式：
# "2x2" - 紧凑四格
# "3x3" - 分批生成（更稳定）
# "4x4" - 分批生成（中等，panel 高度 1024 ✓）
# "5x5" - 批量生成，最大 25 面板
GRID_MODE = os.environ.get("GRID_MODE", "1x1")

# 网格尺寸配置表
# 格式: mode -> (rows, cols, batch_size)
MODE_CONFIG = {
    # 竖屏 Panel 模式（每格竖屏，适合 I2V）
    "1x1": (1, 1, 1),
    "1x2": (1, 2, 2),  # panel 0.89 竖屏
    "1x3": (1, 3, 3),  # panel 0.78 竖屏 ✓
    "1x4": (1, 4, 4),  # panel 0.58 竖屏 ✓ 官方推荐
    "3x2": (3, 2, 6),  # panel 0.84 竖屏, 高度 1365 ✓
    "4x3": (4, 3, 12),  # panel 0.75 竖屏 ✓ 最优
    "5x4": (5, 4, 20),  # panel 0.70 竖屏 ✓
    # 正方形 Panel 模式
    "2x2": (2, 2, 4),
    "3x3": (3, 3, 9),
    "4x4": (4, 4, 16),
    "5x5": (5, 5, 25),
}

# 网格尺寸配置（根据 GRID_MODE 自动设置）
if GRID_MODE in MODE_CONFIG:
    GRID_ROWS, GRID_COLS, GRID_BATCH_SIZE = MODE_CONFIG[GRID_MODE]
else:
    # 默认使用 1x1
    GRID_ROWS, GRID_COLS, GRID_BATCH_SIZE = 1, 1, 1
GRID_TOTAL_PANELS = 25  # 动态优化时的最大面板数


def image_generation_selection_options() -> dict[str, str]:
    """Return UI labels for configured image-generation selections."""
    return {
        key: IMAGE_GENERATION_SELECTIONS[key]["label"]
        for key in VISIBLE_IMAGE_GENERATION_SELECTION_KEYS
        if key in IMAGE_GENERATION_SELECTIONS
    }


def character_image_selection_options() -> dict[str, str]:
    """Return UI labels for character/identity image generation."""
    return image_generation_selection_options()


def _visible_image_generation_selection(value: str | None) -> str:
    candidate = str(value or "").strip()
    if (
        candidate in VISIBLE_IMAGE_GENERATION_SELECTION_KEYS
        and candidate in IMAGE_GENERATION_SELECTIONS
    ):
        return candidate
    alias = LEGACY_IMAGE_GENERATION_SELECTION_ALIASES.get(candidate)
    if alias in VISIBLE_IMAGE_GENERATION_SELECTION_KEYS and alias in IMAGE_GENERATION_SELECTIONS:
        return alias
    return ""


def _default_image_generation_selection(fallback: str | None = None) -> str:
    for candidate in (
        fallback,
        DEFAULT_SKETCH_IMAGE_SELECTION,
        DEFAULT_RENDER_IMAGE_SELECTION,
        "newapi_gpt_image2",
        *VISIBLE_IMAGE_GENERATION_SELECTION_KEYS,
    ):
        selection = _visible_image_generation_selection(candidate)
        if selection:
            return selection
    raise ValueError("No visible image generation selection configured.")


def normalize_image_generation_selection(
    value: str | None,
    *,
    fallback: str | None = None,
) -> str:
    selection = _visible_image_generation_selection(value)
    if selection:
        return selection
    return _default_image_generation_selection(fallback)


def image_generation_selection_label(value: str | None, *, fallback: str | None = None) -> str:
    selection = normalize_image_generation_selection(value, fallback=fallback)
    return IMAGE_GENERATION_SELECTIONS[selection]["label"]


def get_character_image_selection() -> str:
    """Return the configured character/identity image source selection."""
    candidate = _visible_image_generation_selection(CHARACTER_IMAGE_SELECTION)
    if candidate:
        return candidate

    legacy_model = str(CHARACTER_IMAGE_MODEL or "").strip()
    legacy_selection = _visible_image_generation_selection(legacy_model)
    if legacy_selection:
        return legacy_selection

    return normalize_image_generation_selection(
        DEFAULT_RENDER_IMAGE_SELECTION,
        fallback=DEFAULT_SKETCH_IMAGE_SELECTION,
    )


def normalize_character_image_selection(value: str | None) -> str:
    candidate = _visible_image_generation_selection(value)
    if candidate:
        return candidate
    return get_character_image_selection()


def infer_image_generation_selection(
    provider: str | None,
    model: str | None,
    *,
    fallback: str | None = None,
) -> str:
    provider_norm = str(provider or "").strip().lower()
    model_norm = str(model or "").strip()
    for key, entry in IMAGE_GENERATION_SELECTIONS.items():
        if entry["provider"] == provider_norm and entry["model"] == model_norm:
            return key
    if provider_norm == "openrouter" and model_norm in {
        NANOBANANA_MODEL,
        f"google/{NANOBANANA_MODEL}",
    }:
        return "openrouter_nanobanana2"
    if provider_norm == "huimeng" and model_norm == "image-2":
        return "huimeng_gpt_image2"
    if provider_norm == "huimeng" and model_norm == "image-2-official":
        return "huimeng_image2_official"
    return normalize_image_generation_selection(fallback, fallback=DEFAULT_SKETCH_IMAGE_SELECTION)


def _image_provider_config(
    provider: str,
    *,
    model_override: str | None = None,
    selection_override: str | None = None,
) -> dict:
    if selection_override:
        selection = normalize_image_generation_selection(selection_override)
        entry = IMAGE_GENERATION_SELECTIONS[selection]
        provider = entry["provider"]
        model = model_override or entry["model"]
    else:
        provider = (provider or "openrouter").lower()
        model = model_override or ""

    if provider == "openrouter":
        resolved_model = model or (
            f"google/{NANOBANANA_MODEL}"
            if not NANOBANANA_MODEL.startswith("google/")
            else NANOBANANA_MODEL
        )
        return {"provider": provider, "api_key": OPENROUTER_API_KEY, "model": resolved_model}
    if provider in {"huimeng", "huimengi"}:
        return {
            "provider": "huimeng",
            "api_key": HUIMENGI_API_KEY,
            "model": model or HUIMENG_IMAGE_MODEL,
        }
    if provider == "openai":
        return {
            "provider": provider,
            "api_key": OPENAI_API_KEY,
            "model": model or OPENAI_IMAGE_MODEL,
        }
    if provider == "newapi":
        gateway = get_effective_newapi_gateway_config()
        return {
            "provider": provider,
            "api_key": gateway.api_key,
            "model": model or NEWAPI_IMAGE_MODEL,
            "base_url": gateway.base_url,
        }

    return {"provider": "google", "api_key": GOOGLE_AI_API_KEY, "model": model or NANOBANANA_MODEL}


def get_grid_generation_config(
    selection_override: str | None = None,
    provider_override: str | None = None,
    model_override: str | None = None,
    image_size_override: str | None = None,
) -> dict:
    """获取网格生成配置。

    支持四种 Provider:
    - google: 直连 Google AI Studio (GOOGLE_AI_API_KEY)
    - openrouter: 通过 OpenRouter 代理 (OPENROUTER_API_KEY)，成本降低 60 倍
    - openai: 通过 OpenAI Image API (OPENAI_API_KEY)，默认 gpt-image-2
    - huimeng: 通过 HuiMeng Tasks API (HUIMENGI_API_KEY)

    环境变量:
    - NANOBANANA_PROVIDER: "google" / "openrouter" / "openai" / "huimeng"
    - GOOGLE_AI_API_KEY: Google AI Studio API Key
    - OPENROUTER_API_KEY: OpenRouter API Key
    - OPENAI_API_KEY: OpenAI API Key
    - HUIMENGI_API_KEY: HuiMeng API Key
    - OPENAI_IMAGE_MODEL: OpenAI Image API 模型，默认 gpt-image-2
    - HUIMENG_IMAGE_MODEL: HuiMeng 图片模型，默认 image-2
    - DEFAULT_SKETCH_IMAGE_SELECTION / DEFAULT_RENDER_IMAGE_SELECTION: UI 默认图片源
    """
    if (
        selection_override is None
        and provider_override is None
        and _DEFAULT_RENDER_SELECTION_EXPLICIT
    ):
        selection_override = DEFAULT_RENDER_IMAGE_SELECTION

    provider_config = _image_provider_config(
        provider_override or NANOBANANA_PROVIDER,
        model_override=model_override,
        selection_override=selection_override,
    )

    return {
        "provider": provider_config["provider"],
        "api_key": provider_config["api_key"],
        "model": provider_config["model"],
        "base_url": provider_config.get("base_url", ""),
        "openai_image_quality": OPENAI_IMAGE_QUALITY,
        "openai_sketch_image_quality": OPENAI_SKETCH_IMAGE_QUALITY,
        "huimeng_image_quality": os.environ.get("HUIMENG_IMAGE_QUALITY", "medium"),
        "image_size": image_size_override or "1K",
        "mode": GRID_MODE,
        "rows": GRID_ROWS,
        "cols": GRID_COLS,
        "batch_size": GRID_BATCH_SIZE,
        "total_panels": GRID_TOTAL_PANELS,
    }


def get_sketch_generation_config(
    selection_override: str | None = None,
    model_override: str | None = None,
) -> dict:
    """获取草图工作台网格生成配置。

    优先级:
    1. 显式 DEFAULT_SKETCH_IMAGE_SELECTION（新选择表）
    2. 显式 NANOBANANA_PROVIDER / NANOBANANA_MODEL（旧环境变量兼容）
    3. 通用 get_grid_generation_config()
    """
    selection = selection_override
    if selection is None:
        selection = (
            DEFAULT_SKETCH_IMAGE_SELECTION
            if (_DEFAULT_SKETCH_SELECTION_EXPLICIT or not _NANOBANANA_PROVIDER_EXPLICIT)
            else None
        )
    provider_override = None if selection else NANOBANANA_PROVIDER
    config = get_grid_generation_config(
        selection_override=selection,
        provider_override=provider_override,
        model_override=model_override,
    )
    config["openai_image_quality"] = OPENAI_SKETCH_IMAGE_QUALITY
    config["huimeng_image_quality"] = "low"
    config["image_size"] = "1K"
    return config


def get_render_generation_config(
    selection_override: str | None = None,
    model_override: str | None = None,
) -> dict:
    """获取首帧渲染图像配置。"""
    selection = selection_override
    if selection is None:
        selection = (
            DEFAULT_RENDER_IMAGE_SELECTION
            if (_DEFAULT_RENDER_SELECTION_EXPLICIT or not _NANOBANANA_PROVIDER_EXPLICIT)
            else None
        )
    provider_override = None if selection else NANOBANANA_PROVIDER
    return get_grid_generation_config(
        selection_override=selection,
        provider_override=provider_override,
        model_override=model_override,
    )


# =============================================================================
# 草图（Sketch）路径管理
# =============================================================================


def get_sketch_dir(project_name: str, episode: int) -> str:
    """获取整集草图存放目录。

    Args:
        project_name: 项目名称（如 admin/test1）
        episode: 集数

    Returns:
        草图目录路径，如 output/admin/test1/grids/ep001/sketch
    """
    base_dir = os.path.abspath(os.path.join(OUTPUT_DIR, project_name))
    return os.path.join(base_dir, "grids", f"ep{episode:03d}", "sketch")


def get_sketch_path(project_name: str, episode: int, sketch_index: int = 1) -> str:
    """获取整集草图路径（已弃用，保留向后兼容）。

    新模式下草图文件名为 sketch_b{start}-{end}_{rows}x{cols}.jpg，
    建议使用 list_sketch_files() 遍历草图目录。

    Args:
        project_name: 项目名称（如 admin/test1）
        episode: 集数
        sketch_index: 草图索引（1-based），默认为 1

    Returns:
        草图目录路径（新模式下返回目录而非具体文件）
    """
    return get_sketch_dir(project_name, episode)


def list_sketch_files(project_name: str, episode: int) -> list[str]:
    """列出指定集的所有草图文件。

    支持新命名约定: sketch_b{start}-{end}_{rows}x{cols}.jpg

    Args:
        project_name: 项目名称
        episode: 集数

    Returns:
        草图文件路径列表（按文件名排序）
    """
    sketch_dir = get_sketch_dir(project_name, episode)
    if not os.path.exists(sketch_dir):
        return []

    import glob

    pattern = os.path.join(sketch_dir, "sketch_b*_*x*.jpg")
    files = glob.glob(pattern)
    return sorted(files)


# =============================================================================
# 项目管理
# =============================================================================


def get_project_dir(project_name: str) -> str:
    """获取项目输出目录。"""
    return os.path.join(OUTPUT_DIR, project_name)


def ensure_project_dirs(project_name: str) -> dict[str, str]:
    """确保项目目录结构存在，返回资源目录路径。

    `project_name` 可为 `username/project` 或历史单目录格式 `project`。
    当包含用户名时，会同时确保 output/state/runtime 三类目录存在。
    """
    base_dir = os.path.abspath(get_project_dir(project_name))

    parts = project_name.split("/", 1)
    if len(parts) == 2:
        from novelvideo.utils.project_paths import ProjectPaths

        paths = ProjectPaths(parts[0], parts[1])
        paths.ensure_dirs()
        paths.bootstrap_from_legacy_output()

    dirs = {
        "base": base_dir,
        "graph": os.path.join(base_dir, "graph"),
        "assets": os.path.join(base_dir, "assets"),
        "characters": os.path.join(base_dir, "assets", "characters"),
        "scripts": os.path.join(base_dir, "scripts"),
        "images": os.path.join(base_dir, "images"),
        "frames": os.path.join(base_dir, "frames"),  # 首帧图片
        "audio": os.path.join(base_dir, "audio"),
        "videos": os.path.join(base_dir, "videos"),
    }

    for path in dirs.values():
        os.makedirs(path, exist_ok=True)

    return dirs


def ensure_project_dirs_at_paths(
    *,
    output_dir: str | os.PathLike[str],
    state_dir: str | os.PathLike[str],
    runtime_dir: str | os.PathLike[str],
) -> dict[str, str]:
    """Ensure project directories from registry paths without legacy bootstrap."""
    base_dir = os.path.abspath(os.fspath(output_dir))
    dirs = {
        "base": base_dir,
        "graph": os.path.join(base_dir, "graph"),
        "assets": os.path.join(base_dir, "assets"),
        "characters": os.path.join(base_dir, "assets", "characters"),
        "scripts": os.path.join(base_dir, "scripts"),
        "images": os.path.join(base_dir, "images"),
        "frames": os.path.join(base_dir, "frames"),
        "audio": os.path.join(base_dir, "audio"),
        "videos": os.path.join(base_dir, "videos"),
        "state": os.path.abspath(os.fspath(state_dir)),
        "runtime": os.path.abspath(os.fspath(runtime_dir)),
        "logs": os.path.join(os.path.abspath(os.fspath(runtime_dir)), "logs"),
        "staging": os.path.join(os.path.abspath(os.fspath(runtime_dir)), "staging"),
        "temp_sketch_panels": os.path.join(
            os.path.abspath(os.fspath(runtime_dir)),
            "temp_sketch_panels",
        ),
    }

    for path in dirs.values():
        os.makedirs(path, exist_ok=True)

    return dirs
