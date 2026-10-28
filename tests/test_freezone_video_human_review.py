from pathlib import Path
from types import SimpleNamespace

import pytest

from novelvideo.freezone.video_node import effective_video_human_review


@pytest.mark.parametrize("mode", ["textToVideo", "text_to_video"])
def test_text_mode_overrides_custom_request_template_review(mode):
    from novelvideo.media_model_request_schema import enforce_newapi_video_mode_contract

    payload = {
        "human_review": True,
        "metadata": {"human_review": True, "ratio": "16:9"},
    }
    result = enforce_newapi_video_mode_contract(payload, mode=mode)
    assert result["metadata"]["human_review"] is False
    assert "human_review" not in result
    assert result["metadata"]["ratio"] == "16:9"
    assert payload["metadata"]["human_review"] is True


def test_reference_mode_keeps_custom_request_review():
    from novelvideo.media_model_request_schema import enforce_newapi_video_mode_contract

    result = enforce_newapi_video_mode_contract(
        {"metadata": {"human_review": True}}, mode="imageToVideo"
    )
    assert result["metadata"]["human_review"] is True


@pytest.mark.parametrize(
    "mode,refs,last_frame,expected",
    [
        ("textToVideo", [], None, False),
        ("text_to_video", [{"path": "old.png"}], "old-last.png", False),
        ("allReference", [], None, False),
        (None, [], None, False),
        ("allReference", [{"type": "audio", "path": "voice.mp3"}], None, False),
        ("imageToVideo", [{"type": "image", "path": "  "}], None, False),
        ("imageToVideo", [{"type": "image", "path": "frame.png"}], None, True),
        ("videoEdit", [{"type": "video", "path": "clip.mp4"}], None, True),
        ("first_last_frame", [], "last.png", True),
        (None, [{"path": "legacy.png"}], None, True),
    ],
)
def test_review_requires_visual_materials_and_non_text_mode(
    mode, refs, last_frame, expected
):
    assert (
        effective_video_human_review(
            True, gen_mode=mode, reference_items=refs, last_frame_path=last_frame
        )
        is expected
    )
    assert (
        effective_video_human_review(
            False, gen_mode=mode, reference_items=refs, last_frame_path=last_frame
        )
        is False
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("trusted", [False, True])
@pytest.mark.parametrize(
    "mode,expected", [("text_to_video", False), ("image_reference", True)]
)
async def test_execution_leaf_normalizes_review(
    monkeypatch, tmp_path, trusted, mode, expected
):
    from novelvideo.freezone.jobs import run_freezone_video_gen
    from novelvideo.freezone.video_node import run_trusted_freezone_video_gen
    from novelvideo.generators.video_generator import VideoGenStatus

    calls = []

    class Generator:
        async def generate(self, **kwargs):
            calls.append(kwargs)
            Path(kwargs["output_path"]).write_bytes(b"fake-video")
            return SimpleNamespace(status=VideoGenStatus.DONE, error=None)

    monkeypatch.setattr(
        "novelvideo.generators.video_generator.create_video_generator",
        lambda **_kwargs: Generator(),
    )
    kwargs = dict(
        project_dir=tmp_path,
        job_id="review-test",
        prompt="sunset",
        backend="newapi_seedance-2.0-fast",
        gen_mode=mode,
        reference_items=[{"type": "image", "path": "old-reference.png"}],
        human_review=True,
    )
    if trusted:
        await run_trusted_freezone_video_gen(
            **kwargs,
            egress_context=object(),
            task_type="freezone_video_gen",
            episode=0,
            beat_num=0,
            scope="review-test",
        )
    else:
        await run_freezone_video_gen(**kwargs)
    assert calls[0]["human_review"] is expected
