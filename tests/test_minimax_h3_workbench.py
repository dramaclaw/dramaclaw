from pathlib import Path

import pytest

from novelvideo.generators.minimax_h3_workbench import (
    MiniMaxH3WorkbenchVideoGenerator,
    _output_location,
    minimax_h3_dimensions,
)
from novelvideo.generators.video_generator import (
    ShotReference,
    VideoGenStatus,
    create_video_generator,
)


class FakeMiniMaxH3Workbench(MiniMaxH3WorkbenchVideoGenerator):
    def __init__(self, **kwargs):
        super().__init__(base_url="http://workbench.test", **kwargs)
        self.uploads: list[tuple[str, str]] = []
        self.requests: list[tuple[str, str, dict | None, dict | None]] = []

    async def _upload_ui_asset(self, path: str, slot: str) -> str:
        self.uploads.append((path, slot))
        return f"{slot}-{Path(path).stem}"

    async def _request_json(
        self,
        method: str,
        path: str,
        *,
        json_body: dict | None = None,
        headers: dict[str, str] | None = None,
    ) -> dict:
        self.requests.append((method, path, json_body, headers))
        if path == "/quickui-studio/api/bootstrap":
            return {"outputs": []}
        if path == "/quickui-studio/api/generate/batch":
            return {
                "ok": True,
                "accepted": 1,
                "items": [{"job_id": "job-1", "status": "queued"}],
            }
        if path == "/quickui-studio/api/status":
            return {
                "queue": {
                    "tasks": [
                        {
                            "job_id": "job-1",
                            "state": "completed",
                            "progress": 100,
                            "outputs": [{"url": "/api/v1/files/result.mp4"}],
                        }
                    ]
                }
            }
        if method == "POST" and path == "/api/v1/jobs":
            return {"job_id": "job-1"}
        if path.endswith("/outputs"):
            return {"outputs": [{"url": "/api/v1/files/result.mp4"}]}
        return {"status": "completed", "progress": 100}

    async def _download_video(self, location: str, output_path: str) -> None:
        assert location == "/api/v1/files/result.mp4"
        Path(output_path).write_bytes(b"video")


def test_output_location_prefers_download_url_over_internal_path():
    output = {
        "name": "result.mp4",
        "path": "video/result.mp4",
        "url": "/view?filename=result.mp4&subfolder=video&type=output",
    }

    assert _output_location(output) == output["url"]


@pytest.mark.parametrize(
    ("ratio", "resolution", "expected"),
    [
        ("16:9", "768p", (1376, 768)),
        ("9:16", "768p", (768, 1376)),
        ("1:1", "2k", (2048, 2048)),
        ("auto", "768p", (1024, 768)),
    ],
)
def test_minimax_h3_dimensions_are_workbench_valid(
    ratio, resolution, expected
):
    input_size = (800, 600) if ratio == "auto" else None
    dimensions = minimax_h3_dimensions(
        ratio,
        resolution,
        input_size=input_size,
    )
    assert dimensions == expected
    assert all(256 <= value <= 2048 and value % 32 == 0 for value in dimensions)


@pytest.mark.asyncio
async def test_all_reference_uploads_every_asset_in_reference_order(tmp_path):
    generator = FakeMiniMaxH3Workbench(
        resolution="2k",
        model_params={
            "quality_mode": "balanced",
            "inference_steps": 6,
            "model_mode": "dual_pass",
            "seed": 42,
        },
    )
    references = [
        ShotReference("image", "/assets/scene.png", "scene"),
        ShotReference("audio", "/assets/voice.wav", "voice"),
        ShotReference("image", "/assets/character.png", "character"),
        ShotReference("video", "/assets/motion.mp4", "motion"),
    ]
    output = tmp_path / "output.mp4"

    result = await generator.generate(
        image_path=references[0].path,
        prompt="A character crosses the bridge",
        output_path=str(output),
        aspect_ratio="16:9",
        duration=15,
        references=references,
        gen_mode="all_reference",
    )

    assert result.status is VideoGenStatus.DONE
    assert output.read_bytes() == b"video"
    assert generator.uploads == [
        ("/assets/scene.png", "image-1"),
        ("/assets/voice.wav", "audio-1"),
        ("/assets/character.png", "image-2"),
        ("/assets/motion.mp4", "video-1"),
    ]
    request = next(
        entry
        for entry in generator.requests
        if entry[1] == "/quickui-studio/api/generate/batch"
    )
    submitted = request[2]["jobs"][0]
    assert submitted["mode"] == "r2v"
    assert submitted["prompt"] == "A character crosses the bridge"
    assert submitted["referenceImages"] == [
        "image-1-scene",
        "image-2-character",
        None,
        None,
        None,
        None,
        None,
        None,
        None,
    ]
    assert submitted["referenceVideos"] == ["video-1-motion", None, None]
    assert submitted["referenceAudios"] == ["audio-1-voice", None, None]
    assert submitted["width"] == 2048
    assert submitted["height"] == 1152
    assert submitted["duration"] == 15.0
    assert submitted["qualityMode"] == 2
    assert submitted["inferenceSteps"] == 6
    assert submitted["modelMode"] == "dual_pass"
    assert submitted["seed"] == 42
    assert submitted["dualPass"] == {
        "scaleBy": 1.2,
        "shiftVideo": 12,
        "shiftAudio": 3,
        "coarseSteps": 6,
        "refineSteps": 3,
    }


@pytest.mark.asyncio
async def test_first_last_frame_maps_to_i2v_without_duplicate_reference_fields(
    tmp_path,
):
    generator = FakeMiniMaxH3Workbench()
    references = [
        ShotReference("image", "/assets/first.png", "first"),
        ShotReference("image", "/assets/last.png", "last"),
    ]

    result = await generator.generate(
        image_path=references[0].path,
        prompt="Slow camera push",
        output_path=str(tmp_path / "output.mp4"),
        references=references,
        gen_mode="first_last_frame",
    )

    assert result.status is VideoGenStatus.DONE
    assert generator.uploads == [
        ("/assets/first.png", "first-frame"),
        ("/assets/last.png", "last-frame"),
    ]
    request = next(
        entry
        for entry in generator.requests
        if entry[1] == "/quickui-studio/api/generate/batch"
    )
    submitted = request[2]["jobs"][0]
    assert submitted["mode"] == "i2v"
    assert submitted["prompt"] == "Slow camera push"
    assert submitted["firstFrame"] == "first-frame-first"
    assert submitted["lastFrame"] == "last-frame-last"
    assert all(value is None for value in submitted["referenceImages"])
    assert submitted["modelMode"] == "fl2va"


@pytest.mark.asyncio
async def test_image_to_video_rejects_media_that_would_be_ignored(tmp_path):
    generator = FakeMiniMaxH3Workbench()
    result = await generator.generate(
        image_path="/assets/first.png",
        prompt="Move",
        output_path=str(tmp_path / "output.mp4"),
        references=[
            ShotReference("image", "/assets/first.png", "image"),
            ShotReference("audio", "/assets/voice.wav", "voice"),
        ],
        gen_mode="image_reference",
    )

    assert result.status is VideoGenStatus.FAILED
    assert "exactly one image" in result.error
    assert generator.requests == []
    assert generator.uploads == []


@pytest.mark.asyncio
async def test_text_to_video_keeps_stable_v1_job_contract(tmp_path):
    generator = FakeMiniMaxH3Workbench()

    result = await generator.generate(
        image_path=None,
        prompt="Rain on an empty street",
        output_path=str(tmp_path / "output.mp4"),
        references=[],
        gen_mode="text_to_video",
    )

    assert result.status is VideoGenStatus.DONE
    request = next(
        entry
        for entry in generator.requests
        if entry[1] == "/api/v1/jobs" and entry[0] == "POST"
    )
    submitted = request[2]
    assert submitted["mode"] == "t2v"
    assert submitted["inputs"] == {"prompt": "Rain on an empty street"}
    assert submitted["parameters"]["model_mode"] == "high_quality"
    assert len(request[3]["Idempotency-Key"]) == 64


def test_factory_uses_local_adapter_only_for_minimax_h3(monkeypatch):
    monkeypatch.setenv("MINIMAX_H3_WORKBENCH_URL", "http://workbench.test")

    generator = create_video_generator(
        backend="newapi_MiniMax-H3",
        resolution="768p",
        model_params={},
    )

    assert isinstance(generator, MiniMaxH3WorkbenchVideoGenerator)
    assert generator.base_url == "http://workbench.test/"
