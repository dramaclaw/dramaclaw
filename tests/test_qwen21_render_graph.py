"""Unit tests for the Qwen-Image 2.1 render graph
(`_runpod_qwen21_render_image_graph`) and its image-prep helper
(`_qwen21_prepare_render_image`) — no DB, no network, no RunPod calls.

These exist specifically to pin down the one detail that made the original
`_runpod_qwen_image_graph` unreliable for render (see
`.claude/CLAUDE.md` 2026-10-18 entry): the no-mask path must use
`TextEncodeQwenImage21`'s own latent output (correctly sized to the input
image), and the masked path must use a REAL `VAEEncode` of the canvas, not
that same (empty) latent output — see
`_runpod_qwen21_render_image_graph`'s module-level docstring for the full
reasoning.
"""

from __future__ import annotations

import io

from PIL import Image

from novelvideo.generators.nanobanana_grid import (
    _qwen21_prepare_render_image,
    _runpod_qwen_image_graph,
    _runpod_qwen21_render_image_graph,
)


def _make_png(width: int, height: int) -> bytes:
    img = Image.new("RGB", (width, height), (255, 0, 0))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def test_prepare_render_image_rounds_to_multiple_of_32():
    data = _make_png(900, 500)
    out_bytes, (w, h) = _qwen21_prepare_render_image(data, target_area=1024 * 1024)
    assert w % 32 == 0
    assert h % 32 == 0
    with Image.open(io.BytesIO(out_bytes)) as img:
        assert img.size == (w, h)


def test_prepare_render_image_preserves_roughly_the_target_area():
    data = _make_png(2000, 1000)
    _out_bytes, (w, h) = _qwen21_prepare_render_image(data, target_area=1024 * 1024)
    # within ~15% of target area after rounding to multiples of 32
    assert 0.85 * 1024 * 1024 <= w * h <= 1.3 * 1024 * 1024


def test_no_mask_graph_uses_text_encoder_latent_not_empty_latent_image():
    graph = _runpod_qwen21_render_image_graph(
        "Replace <image1> with <image2>.",
        "canvas.png",
        ["ref.png"],
        12345,
        steps=40,
        cfg=1.0,
    )
    assert graph["6"]["inputs"]["latent_image"] == ["4", 2]
    assert all(node["class_type"] != "EmptyLatentImage" for node in graph.values())
    assert all(node["class_type"] != "VAEEncode" for node in graph.values())
    assert graph["4"]["inputs"]["resolution"] == 0
    assert graph["6"]["inputs"]["cfg"] == 1.0
    assert graph["6"]["inputs"]["steps"] == 40
    assert graph["4"]["inputs"]["images.image_1"] == ["10", 0]
    # Default negative_prompt stays "" — the official cfg=1 recipe assumes
    # no negative prompt is in play.
    assert graph["4"]["inputs"]["negative_prompt"] == ""


def test_negative_prompt_param_is_wired_into_text_encoder():
    # Added 2026-10-18 for the masked multi-character inpaint pass's
    # boosted-cfg conditioning (see RUNPOD_QWEN21_RENDER_INPAINT_CFG/
    # _INPAINT_NEGATIVE_PROMPT in config.py) — must not affect anything
    # else in the graph.
    graph = _runpod_qwen21_render_image_graph(
        "Replace <image1> with <image2>.",
        "canvas.png",
        ["ref.png"],
        12345,
        steps=40,
        cfg=3.0,
        negative_prompt="adult, wrong age, mismatched body proportions",
    )
    assert graph["4"]["inputs"]["negative_prompt"] == "adult, wrong age, mismatched body proportions"
    assert graph["6"]["inputs"]["cfg"] == 3.0
    assert graph["6"]["inputs"]["latent_image"] == ["4", 2]


def test_masked_graph_uses_real_vaencode_of_canvas_not_text_encoder_latent():
    graph = _runpod_qwen21_render_image_graph(
        "Replace the person in <image1> with <image2>.",
        "canvas.png",
        ["ref.png"],
        12345,
        mask_name="mask.png",
        steps=40,
        cfg=1.0,
    )
    # The critical assertion: masked latent must NOT be the text encoder's
    # own (empty) latent output.
    latent_input = graph["6"]["inputs"]["latent_image"]
    assert latent_input != ["4", 2]
    assert latent_input == ["52", 0]

    # SetLatentNoiseMask's samples must trace back to a real VAEEncode of
    # the canvas (node "10"), not to the text encoder.
    assert graph["52"]["class_type"] == "SetLatentNoiseMask"
    samples_node_id = graph["52"]["inputs"]["samples"][0]
    assert graph[samples_node_id]["class_type"] == "VAEEncode"
    assert graph[samples_node_id]["inputs"]["pixels"] == ["10", 0]

    assert graph["91"]["class_type"] == "ImageToMask"
    assert graph["90"]["inputs"]["image"] == "mask.png"


def test_reference_names_become_image_2_plus():
    graph = _runpod_qwen21_render_image_graph(
        "prompt", "canvas.png", ["ref_a.png", "ref_b.png"], 1, steps=40, cfg=1.0
    )
    assert graph["4"]["inputs"]["images.image_2"][0] in graph
    assert graph["4"]["inputs"]["images.image_3"][0] in graph
    loaded_images = {
        node["inputs"]["image"]
        for node in graph.values()
        if node["class_type"] == "LoadImage"
    }
    assert loaded_images == {"canvas.png", "ref_a.png", "ref_b.png"}


def test_shared_sketch_character_scene_prop_graph_is_unaffected():
    """Regression guard: `_runpod_qwen_image_graph` (used by
    sketch/character/scene/prop generation) must still use `EmptyLatentImage`
    at the caller-provided width/height — that's correct for those uses
    (fresh image at a target size), unlike render/identity-swap. This test
    pins the exact pre-2026-10-18 shape so a future edit to the shared
    function can't silently change render-path behavior."""
    graph, _refs = _runpod_qwen_image_graph(
        "a prompt", 512, 768, 42, [("ref.png", b"data", "image/png")]
    )
    assert graph["5"]["class_type"] == "EmptyLatentImage"
    assert graph["5"]["inputs"] == {"width": 512, "height": 768, "batch_size": 1}
    assert graph["6"]["inputs"]["latent_image"] == ["5", 0]
