"""Shared NewAPI transport for Freezone vision-understanding tasks."""

from __future__ import annotations

from dataclasses import dataclass

from novelvideo.official_defaults import DEFAULT_FREEZONE_VISION_MODEL


@dataclass(frozen=True)
class VisionInput:
    data: bytes
    media_type: str = "image/png"


def image_media_type(path: str) -> str:
    """Return the image MIME type expected by multimodal model providers."""
    suffix = str(path).lower().rsplit(".", 1)[-1] if "." in str(path) else ""
    if suffix in {"jpg", "jpeg"}:
        return "image/jpeg"
    if suffix == "webp":
        return "image/webp"
    if suffix == "gif":
        return "image/gif"
    return "image/png"


def resolve_freezone_vision_model(model_override: str | None = None) -> str:
    """Return the logical NewAPI model shared by Freezone vision tasks."""
    clean_override = str(model_override or "").strip()
    if clean_override:
        return clean_override

    from novelvideo.config import get_newapi_text_model_name

    return get_newapi_text_model_name(
        "FREEZONE_VISION_MODEL",
        DEFAULT_FREEZONE_VISION_MODEL,
    )


async def call_freezone_vision_model(
    *,
    prompt: str,
    images: list[VisionInput],
    model_override: str | None = None,
    timeout_seconds: float = 120.0,
) -> tuple[str, str]:
    """Run a PydanticAI vision Agent through the effective NewAPI gateway."""
    if not images:
        raise ValueError("at least one image is required")

    from pydantic_ai import Agent, BinaryContent

    from novelvideo.config import get_newapi_text_pydantic_model

    model = resolve_freezone_vision_model(model_override)
    agent = Agent(
        get_newapi_text_pydantic_model(
            "FREEZONE_VISION_MODEL",
            DEFAULT_FREEZONE_VISION_MODEL,
            model_name_override=model,
            timeout_seconds_override=timeout_seconds,
        ),
        output_type=str,
        name="Freezone Vision Analyzer",
    )
    result = await agent.run(
        [
            prompt,
            *[
                BinaryContent(data=image.data, media_type=image.media_type)
                for image in images
            ],
        ]
    )
    text = str(result.output or "").strip()
    if not text:
        raise RuntimeError("视觉模型返回空内容")
    return model, text
