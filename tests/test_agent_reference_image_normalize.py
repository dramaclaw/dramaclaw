"""Vision-agent image inputs share the reference-image bound."""

from __future__ import annotations

import importlib
import io

import pytest
from PIL import Image

from novelvideo.utils.reference_image import REFERENCE_IMAGE_MAX_EDGE

_WIDE = (REFERENCE_IMAGE_MAX_EDGE + 904, (REFERENCE_IMAGE_MAX_EDGE + 904) // 2)

_AGENTS = [
    ("novelvideo.agents.keyframe_prompt_builder", "KeyframePromptBuilder"),
    ("novelvideo.agents.video_prompt_builder", "VideoPromptBuilder"),
    ("novelvideo.agents.global_video_optimizer", "GlobalVideoPromptOptimizer"),
]


@pytest.mark.parametrize("module_name,class_name", _AGENTS)
def test_agent_compress_image_caps_the_long_edge(tmp_path, module_name, class_name):
    path = tmp_path / "sketch.png"
    Image.new("RGBA", _WIDE, (40, 100, 160, 255)).save(path, format="PNG")
    cls = getattr(importlib.import_module(module_name), class_name)

    data = cls._compress_image(cls.__new__(cls), str(path))

    with Image.open(io.BytesIO(data)) as image:
        assert image.format == "JPEG"
        assert max(image.size) == REFERENCE_IMAGE_MAX_EDGE
