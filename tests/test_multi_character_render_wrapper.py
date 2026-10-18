"""Confirms the 2026-10-18 refactor of `_qwen_edit_multi_character_render`
into a thin wrapper over the new generic `_two_pass_multi_character_render`
(shared with the new `_qwen21_multi_character_render`) didn't change its
call contract: same callable arguments forwarded, same `call_image_api`/
`build_prompt` pair selected for each provider. Does not re-exercise the
masking/compositing pipeline itself (untouched by the refactor, not new
code) — just the delegation boundary that did change."""

from __future__ import annotations

import pytest

from novelvideo.generators import nanobanana_grid as grid


@pytest.mark.asyncio
async def test_edit_2511_wrapper_delegates_with_the_right_callables(monkeypatch):
    captured: dict = {}

    async def fake_two_pass(*, call_image_api, build_prompt, **kwargs):
        captured["call_image_api"] = call_image_api
        captured["build_prompt"] = build_prompt
        captured["kwargs"] = kwargs
        return b"fake-bytes", "", "", {"scene_prompt": "x", "inpaint_prompts": {}}

    monkeypatch.setattr(grid, "_two_pass_multi_character_render", fake_two_pass)

    result = await grid._qwen_edit_multi_character_render(
        api_key="k",
        model="qwen-image-edit-2511",
        canvas_bytes=b"canvas",
        canvas_mime="image/png",
        beats=[{"detected_identities": ["A"]}],
        grid_capacity=1,
        character_map={},
        scene_prompt_override="override scene",
        inpaint_prompts_override={"A": "override inpaint"},
    )

    assert result == (b"fake-bytes", "", "", {"scene_prompt": "x", "inpaint_prompts": {}})
    assert captured["call_image_api"] is grid._call_runpod_qwen_edit_image_api
    assert captured["build_prompt"] is grid.build_qwen_edit_render_prompt
    assert captured["kwargs"]["api_key"] == "k"
    assert captured["kwargs"]["model"] == "qwen-image-edit-2511"
    assert captured["kwargs"]["canvas_bytes"] == b"canvas"
    assert captured["kwargs"]["scene_prompt_override"] == "override scene"
    assert captured["kwargs"]["inpaint_prompts_override"] == {"A": "override inpaint"}


@pytest.mark.asyncio
async def test_qwen21_wrapper_delegates_with_the_right_callables(monkeypatch):
    captured: dict = {}

    async def fake_two_pass(*, call_image_api, build_prompt, **kwargs):
        captured["call_image_api"] = call_image_api
        captured["build_prompt"] = build_prompt
        return b"fake-bytes", "", "", {"scene_prompt": "", "inpaint_prompts": {}}

    monkeypatch.setattr(grid, "_two_pass_multi_character_render", fake_two_pass)

    await grid._qwen21_multi_character_render(
        api_key="k",
        model="qwen-image-2.1",
        canvas_bytes=b"canvas",
        canvas_mime="image/png",
        beats=[{"detected_identities": ["A"]}],
        grid_capacity=1,
        character_map={},
    )

    # Not the bare API caller — a wrapper that boosts cfg/negative_prompt
    # for the masked (inpaint) call only, added 2026-10-18 to fix toddler
    # characters rendering as adults. See its own tests in
    # test_qwen21_inpaint_conditioning.py for the boost behavior itself.
    assert captured["call_image_api"] is grid._qwen21_render_call_image_api_for_multi_character
    assert captured["build_prompt"] is grid.build_qwen21_render_prompt
