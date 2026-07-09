"""历史资产还原「模型 + 模式」记忆 — 记录写入层。

生成请求显式带上注册表 model id 与生成模式，runner 原样写进 JSONL 记录顶层，
供还原链路回填节点。缺字段时记录不含这两键（向后兼容，回退默认）。
"""

from __future__ import annotations

from pathlib import Path

from novelvideo.freezone.history import read_generation_history
from novelvideo.project_context import ProjectContext
from novelvideo.task_backend.runners.freezone import (
    _append_node_history,
    _history_model_mode_extra,
)
from novelvideo.task_backend.runners.video import _append_freezone_video_node_history


def _ctx(tmp_path: Path) -> ProjectContext:
    return ProjectContext(
        project_id="proj_freezone",
        project_name="demo",
        owner_type="user",
        owner_id="owner_1",
        owner_username="admin",
        requester_user_id="owner_1",
        requester_username="admin",
        requester_principals=(("user", "owner_1"),),
        effective_role="editor",
        home_node_id="node_a",
        output_dir=tmp_path / "output" / "admin" / "demo",
        state_dir=tmp_path / "state" / "admin" / "demo",
        runtime_dir=tmp_path / "runtime" / "admin" / "demo",
        is_home_node=True,
    )


def test_video_history_persists_model_and_gen_mode(tmp_path: Path) -> None:
    ctx = _ctx(tmp_path)
    project_dir = tmp_path / "proj"
    payload = {
        "node_id": "video_1",
        "canvas_id": "default",
        "prompt": "深夜古街",
        "model_id": "happyhouse_1_0",
        "gen_mode": "firstLastFrame",
    }
    rec = _append_freezone_video_node_history(
        ctx=ctx,
        project_dir=project_dir,
        payload=payload,
        job_id="job_v1",
        result={"output_url": "/static/x.mp4"},
    )
    assert rec is not None
    assert rec["model"] == "happyhouse_1_0"
    assert rec["gen_mode"] == "firstLastFrame"

    stored = read_generation_history(
        project_dir=project_dir, canvas_id="default", node_id="video_1"
    )
    assert stored[-1]["model"] == "happyhouse_1_0"
    assert stored[-1]["gen_mode"] == "firstLastFrame"


def test_video_history_omits_model_keys_when_absent(tmp_path: Path) -> None:
    ctx = _ctx(tmp_path)
    project_dir = tmp_path / "proj"
    payload = {"node_id": "video_2", "canvas_id": "default", "prompt": "x"}
    rec = _append_freezone_video_node_history(
        ctx=ctx,
        project_dir=project_dir,
        payload=payload,
        job_id="job_v2",
        result={"output_url": "/static/y.mp4"},
    )
    assert rec is not None
    assert "model" not in rec
    assert "gen_mode" not in rec


def test_history_model_mode_extra_maps_and_omits() -> None:
    assert _history_model_mode_extra(
        {"model_id": "seedream_4_0", "gen_mode": "image_to_image"}
    ) == {"model": "seedream_4_0", "gen_mode": "image_to_image"}
    # 缺省 → 省略（向后兼容）
    assert _history_model_mode_extra({"prompt": "x"}) == {}
    # 仅其一
    assert _history_model_mode_extra({"model_id": "m"}) == {"model": "m"}


def test_image_history_persists_model_and_gen_mode(tmp_path: Path) -> None:
    ctx = _ctx(tmp_path)
    project_dir = tmp_path / "proj"
    payload = {
        "node_id": "img_1",
        "canvas_id": "default",
        "prompt": "赛博夜景",
    }
    rec = _append_node_history(
        ctx=ctx,
        project_dir=project_dir,
        payload=payload,
        task_type="freezone_gen",
        job_id="job_i1",
        media_type="image",
        result={"output_url": "/static/a.png"},
        model="seedream_4_0",
        gen_mode="image_to_image",
    )
    assert rec is not None
    assert rec["model"] == "seedream_4_0"
    assert rec["gen_mode"] == "image_to_image"

    stored = read_generation_history(
        project_dir=project_dir, canvas_id="default", node_id="img_1"
    )
    assert stored[-1]["model"] == "seedream_4_0"
    assert stored[-1]["gen_mode"] == "image_to_image"


def test_image_history_omits_model_keys_when_absent(tmp_path: Path) -> None:
    ctx = _ctx(tmp_path)
    project_dir = tmp_path / "proj"
    payload = {"node_id": "img_2", "canvas_id": "default", "prompt": "x"}
    rec = _append_node_history(
        ctx=ctx,
        project_dir=project_dir,
        payload=payload,
        task_type="freezone_gen",
        job_id="job_i2",
        media_type="image",
        result={"output_url": "/static/b.png"},
    )
    assert rec is not None
    assert "model" not in rec
    assert "gen_mode" not in rec
