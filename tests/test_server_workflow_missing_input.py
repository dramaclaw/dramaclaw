# SPDX-License-Identifier: Elastic-2.0
# Copyright (c) 2026 ClaymoreLab
"""Request guard failures in the action runner preserve input details."""

import pytest

from novelvideo.freezone.server_workflow_actions import WorkflowActionRunner
from test_canvas_confirmation_price import KEYFRAME_ERROR
from test_server_workflow_actions import FakeHost


@pytest.mark.parametrize(
    "node_type,code,message",
    [
        ("imageGenNode", "missing_references", "At least one reference is required."),
        ("videoNode", "missing_media", KEYFRAME_ERROR),
        ("videoNode", "missing_source_video", "An upstream source video is required."),
        ("videoNode", "missing_upscale_source", "缺少高清视频源"),
    ],
    ids=["image-references", "video-keyframe", "video-source", "upscale-source"],
)
async def test_runner_preserves_missing_input_reason(node_type, code, message):
    host = FakeHost()
    host.canvas["nodes"][0]["type"] = node_type
    upscale = code == "missing_upscale_source"
    if node_type == "videoNode":
        host.data["genMode"] = "videoExtend" if code == "missing_source_video" else "firstFrame"
        host.data["isUpscaleNode"] = upscale
    video_source = code == "missing_source_video"
    source_type = "videoNode" if video_source else "uploadNode"
    state = "empty" if video_source else "uploading"
    if not upscale:
        source_data = (
            {"label": "源素材", "videoUrl": ""} if video_source
            else {"label": "源素材", "imageUrl": "", "isUploading": True}
        )
        host.canvas["nodes"].append({"id": "n1", "type": source_type, "data": source_data})
        host.canvas["edges"].append({"source": "n1", "target": "n"})
    request_op = "image_generation_request" if node_type == "imageGenNode" else (
        "video_generation_request"
    )
    guard = {"ok": False, "code": code, "message": message}

    async def core(op, payload):
        if op == request_op:
            return {"compile_input": {"ok": True, "fallbackPrompt": "A ship"},
                    "request": guard, "trim_requirement": None}
        if op == "recipe_compile_request":
            return {"kind": "plain", "prompt": "A ship"}
        assert op == "image_generation_patch"
        if payload["phase"] == "start":
            return {"isGenerating": True}
        if payload["phase"] == "outcome":
            return {"action": "write", "patch": {},
                    "error": {"message": payload["outcome"]["message"]}}
        if payload["phase"] == "settle":
            return {"kind": "no_result", "patch": {"isGenerating": False}}
        assert payload["phase"] == "action_result"
        return {"status": "error", "error": payload["settled"][0]["message"]}

    async def accepted(_task):
        pytest.fail("A guard refusal must never submit generation")

    async def phase(_value):
        pass

    runner = WorkflowActionRunner(
        host=host, project_id="project", canvas_id="default", run_id="run-1",
        core_call=core, sleep=host.sleep, monotonic=lambda: host.clock,
    )
    result = await runner.run_action(
        node_id="n", action="generate_image" if node_type == "imageGenNode" else "generate_video",
        existing_task=None, on_accepted=accepted, on_phase=phase, should_stop=lambda: False,
    )
    assert host.requests == []
    expected = f"generation_input_missing[{code}]: {message}"
    if not upscale:
        expected += f' Empty inputs: "源素材" ({source_type} n1, {state})'
    assert result == {"status": "failed", "error": expected}
