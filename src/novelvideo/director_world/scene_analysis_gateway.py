"""Gateway transport shared by the optional panorama reference analyses."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

OVERLAP_MODEL_ENV = "SCENE_OVERLAP_ANALYSIS_MODEL"
OVERLAP_MODEL = "DC-scene-overlap-analyzer-LLM"
SPATIAL_MODEL_ENV = "SCENE_SPATIAL_CONTRACT_MODEL"
SPATIAL_MODEL = "DC-scene-spatial-contract-LLM"


def resolve_scene_analysis_model(
    model_env: str, default_model: str, model: str = ""
) -> str:
    from novelvideo.config import get_effective_newapi_text_model_name

    return get_effective_newapi_text_model_name(
        model_env, default_model, model_name_override=model or None
    )


def scene_analysis_gateway_configured() -> bool:
    """Use the same effective LLM credentials as the unified gateway client."""
    from novelvideo.config import get_newapi_runtime_credentials
    from novelvideo.model_gateway_settings import get_effective_llm_config

    config = get_effective_llm_config()
    api_key, base_url = get_newapi_runtime_credentials(
        api_key_override=config.api_key,
        base_url_override=config.base_url,
        env_api_key="MODEL_API_KEY",
        env_base_url="MODEL_BASE_URL",
    )
    return bool(api_key and base_url)


async def analyze_scene_references(
    *,
    image_path: Path,
    prompt: str,
    model_env: str,
    default_model: str,
    model: str | None = None,
    max_tokens: int,
    timeout_seconds: float = 120.0,
) -> str:
    """Send a reference sheet through the edition's configured LLM gateway.

    Organization analysis remains disabled at the panorama runner: these child
    processes do not yet have their own admitted organization operation.
    """
    from pydantic_ai import Agent, BinaryContent, PromptedOutput, StructuredDict

    from novelvideo.brainclaw_contract import BrainClawProfile
    from novelvideo.config import (
        get_newapi_structured_output_model_settings,
        get_newapi_text_pydantic_model,
    )
    from novelvideo.task_backend.subprocesses import require_direct_model_egress_allowed

    require_direct_model_egress_allowed(None)
    transport = get_newapi_text_pydantic_model(
        model_env,
        default_model,
        model_name_override=model or None,
        timeout_seconds_override=timeout_seconds,
        brainclaw_profile=BrainClawProfile.FREEZONE_VISION_ANALYSIS,
        capability="vision.analyze",
    )
    agent = Agent(
        transport,
        output_type=PromptedOutput(
            StructuredDict({"type": "object", "additionalProperties": True}),
            template=False,
        ),
        name="Scene Reference Analyzer",
        model_settings={
            "temperature": 0.0,
            "max_tokens": max_tokens,
            **get_newapi_structured_output_model_settings(),
        },
    )
    result = await asyncio.wait_for(
        agent.run(
            [
                prompt,
                BinaryContent(data=image_path.read_bytes(), media_type="image/jpeg"),
            ]
        ),
        timeout=timeout_seconds,
    )
    if not result.output:
        raise RuntimeError("Scene reference analysis returned empty output")
    return json.dumps(result.output, ensure_ascii=False)
