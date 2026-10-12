from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest


class _TextAgent:
    def __init__(self, output: str, seen: dict | None = None):
        self._output = output
        self._seen = seen

    async def run(self, prompt):
        if self._seen is not None:
            self._seen["prompt"] = prompt
        return SimpleNamespace(output=self._output)


@pytest.mark.parametrize(
    ("language", "required", "forbidden"),
    [
        ("en", "English", "Chinese (中文) only"),
        ("zh", "中文", "English only"),
    ],
)
def test_global_video_optimizer_applies_language_to_system_and_task(
    monkeypatch, tmp_path, language, required, forbidden
):
    import novelvideo.agents.global_video_optimizer as module
    import novelvideo.config as config_module

    agent_kwargs = {}

    class FactoryAgent:
        def __init__(self, _model, **kwargs):
            agent_kwargs.update(kwargs)

    monkeypatch.setattr(module, "Agent", FactoryAgent)
    monkeypatch.setattr(
        config_module,
        "get_newapi_text_pydantic_model",
        lambda *_args, **_kwargs: object(),
    )

    # The factory's system instruction must agree with the per-request task.
    module.create_global_video_optimizer_agent(language)
    system_prompt = agent_kwargs["system_prompt"]
    assert required in system_prompt
    assert forbidden not in system_prompt

    sketch_path = tmp_path / "beat_01.png"
    sketch_path.write_bytes(b"fake-image")
    seen = {}
    optimizer = module.GlobalVideoPromptOptimizer()
    monkeypatch.setattr(optimizer, "_get_agent", lambda _language: _TextAgent("ok", seen))
    monkeypatch.setattr(optimizer, "_compress_image", lambda _path: b"compressed")

    asyncio.run(
        optimizer.optimize_single_beat(
            beat={"beat_number": 1, "visual_description": "A woman opens a door."},
            sketch_image_path=str(sketch_path),
            character_color_map={},
            language=language,
        )
    )

    task = seen["prompt"][0]
    assert required in task
    assert forbidden not in task


@pytest.mark.parametrize(
    ("language", "required", "expected_fallback"),
    [
        ("en", "English", "The character moves naturally"),
        ("zh", "中文", "角色自然动作"),
    ],
)
def test_video_prompt_builder_applies_language_to_task_and_fallback(
    monkeypatch, language, required, expected_fallback
):
    from novelvideo.agents.video_prompt_builder import VideoPromptBuilder

    seen = {}
    builder = VideoPromptBuilder()
    monkeypatch.setattr(builder, "_get_agent", lambda _language: _TextAgent("generated", seen))

    result = asyncio.run(
        builder.build(
            frame_prompt="A woman opens a door.",
            language=language,
        )
    )

    assert result == "generated"
    assert required in seen["prompt"]
    assert required in builder._build_task_en(
        duration=5,
        frame_prompt="A woman opens a door.",
        has_image=False,
        color_map_text="",
        narration="",
        audio_type="narration",
        dialogue_line="",
        language=language,
    )
    assert expected_fallback in builder._fallback_build(5, language)


@pytest.mark.parametrize(
    ("language", "required", "expected_fallback"),
    [
        ("en", "English", "The character adjusts their posture naturally"),
        ("zh", "中文", "角色姿态自然调整"),
    ],
)
def test_keyframe_prompt_builder_applies_language_to_task_and_fallback(
    monkeypatch, tmp_path, language, required, expected_fallback
):
    from novelvideo.agents.keyframe_prompt_builder import KeyframePromptBuilder

    first = tmp_path / "first.png"
    last = tmp_path / "last.png"
    first.write_bytes(b"first")
    last.write_bytes(b"last")

    seen = {}
    builder = KeyframePromptBuilder()
    monkeypatch.setattr(builder, "_compress_image", lambda _path: b"image")
    monkeypatch.setattr(builder, "_get_agent", lambda _language: _TextAgent("generated", seen))

    result = asyncio.run(
        builder.build(
            first_frame_path=str(first),
            last_frame_path=str(last),
            narration="A woman opens a door.",
            language=language,
        )
    )

    assert result == "generated"
    assert required in seen["prompt"][0]
    assert expected_fallback in builder._fallback_build(language)


class _FailingAgent:
    async def run(self, _prompt):
        raise RuntimeError("model unavailable")


def _keyframe_builder_with_failing_agent(monkeypatch, tmp_path):
    from novelvideo.agents.keyframe_prompt_builder import KeyframePromptBuilder

    first, last = tmp_path / "first.png", tmp_path / "last.png"
    first.write_bytes(b"first")
    last.write_bytes(b"last")
    builder = KeyframePromptBuilder()
    monkeypatch.setattr(builder, "_compress_image", lambda _path: b"image")
    monkeypatch.setattr(builder, "_get_agent", lambda _language: _FailingAgent())
    return builder, first, last


def test_keyframe_prompt_builder_falls_back_by_default_when_model_fails(monkeypatch, tmp_path):
    builder, first, last = _keyframe_builder_with_failing_agent(monkeypatch, tmp_path)

    result = asyncio.run(
        builder.build(str(first), str(last), narration="A woman opens a door.", language="en")
    )

    assert result == builder._fallback_build("en")


def test_keyframe_prompt_builder_raises_when_fallback_is_not_allowed(monkeypatch, tmp_path):
    builder, first, last = _keyframe_builder_with_failing_agent(monkeypatch, tmp_path)

    with pytest.raises(RuntimeError, match="model unavailable"):
        asyncio.run(
            builder.build(
                str(first),
                str(last),
                narration="A woman opens a door.",
                language="en",
                allow_fallback=False,
            )
        )


def test_keyframe_route_helper_call_matches_builder_signature(monkeypatch, tmp_path):
    """scripts._generate_single_beat_keyframe_prompt used to pass allow_fallback, which build()
    did not accept, so every keyframe prompt request raised TypeError."""
    from novelvideo.agents import keyframe_prompt_builder as module
    from novelvideo.api.routes.scripts import _generate_single_beat_keyframe_prompt
    from novelvideo.utils.path_resolver import PathResolver

    paths = PathResolver(str(tmp_path), 1)
    for beat in (1, 2):
        paths.frame(beat).parent.mkdir(parents=True, exist_ok=True)
        paths.frame(beat).write_bytes(b"frame")

    builder = module.KeyframePromptBuilder()
    monkeypatch.setattr(builder, "_compress_image", lambda _path: b"image")
    monkeypatch.setattr(builder, "_get_agent", lambda _language: _TextAgent("generated", {}))
    monkeypatch.setattr(module, "get_keyframe_prompt_builder", lambda: builder)

    prompt = asyncio.run(
        _generate_single_beat_keyframe_prompt(
            output_dir=tmp_path,
            episode=1,
            beat={"beat_number": 1, "narration_segment": "n1"},
            next_beat={"beat_number": 2, "narration_segment": "n2"},
            language="en",
        )
    )

    assert prompt == "generated"


def test_keyframe_route_helper_surfaces_model_failure_instead_of_canned_prompt(monkeypatch, tmp_path):
    from novelvideo.agents import keyframe_prompt_builder as module
    from novelvideo.api.routes.scripts import _generate_single_beat_keyframe_prompt
    from novelvideo.utils.path_resolver import PathResolver

    paths = PathResolver(str(tmp_path), 1)
    for beat in (1, 2):
        paths.frame(beat).parent.mkdir(parents=True, exist_ok=True)
        paths.frame(beat).write_bytes(b"frame")

    builder = module.KeyframePromptBuilder()
    monkeypatch.setattr(builder, "_compress_image", lambda _path: b"image")
    monkeypatch.setattr(builder, "_get_agent", lambda _language: _FailingAgent())
    monkeypatch.setattr(module, "get_keyframe_prompt_builder", lambda: builder)

    with pytest.raises(RuntimeError, match="model unavailable"):
        asyncio.run(
            _generate_single_beat_keyframe_prompt(
                output_dir=tmp_path,
                episode=1,
                beat={"beat_number": 1, "narration_segment": "n1"},
                next_beat={"beat_number": 2, "narration_segment": "n2"},
                language="en",
            )
        )
