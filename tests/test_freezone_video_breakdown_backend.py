"""逐帧拉片（freezone_video_breakdown）的接口契约。

覆盖三件事：路由把参数原样带进任务 payload、作业层的洗数据逻辑（模型时间戳不
可信）、runner 只把 URL 交出去（磁盘路径不许外泄）。
"""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from novelvideo.api.routes import freezone as freezone_routes
from novelvideo.freezone import jobs as freezone_jobs
from novelvideo.freezone.jobs import (
    _group_breakdown_shots,
    _normalize_breakdown_shots,
    _select_motion_shots,
    build_video_breakdown_prompt,
    plan_breakdown_frame_count,
    plan_breakdown_shot_range,
)
from novelvideo.project_context import ProjectContext


def _async_return(value: object):
    """替掉真跑 ffmpeg 的协程：吃掉所有参数，直接给固定结果。"""

    async def _stub(*_args: object, **_kwargs: object) -> object:
        return value

    return _stub


def _ctx(tmp_path: Path) -> ProjectContext:
    return ProjectContext(
        project_id="proj_breakdown_1",
        project_name="demo",
        owner_type="user",
        owner_id="user_owner",
        owner_username="alice",
        requester_user_id="user_editor",
        requester_username="bob",
        requester_principals=(("user", "user_editor"),),
        effective_role="editor",
        home_node_id="node_a",
        output_dir=tmp_path / "output" / "alice" / "demo",
        state_dir=tmp_path / "state" / "alice" / "demo",
        runtime_dir=tmp_path / "runtime" / "alice" / "demo",
        is_home_node=True,
    )


def test_breakdown_prompt_demands_segment_lighting_and_music() -> None:
    prompt = build_video_breakdown_prompt(frame_count=8, duration_sec=12.5, group_size=4)

    assert "视频总时长约 12.50 秒" in prompt
    assert "每组最多 4 个镜头" in prompt
    # 前端分镜卡片是「镜号 | 景别·光线 | 描述」，这三个字段缺一个卡片就不完整。
    assert '"segment"' in prompt
    assert '"shot_size"' in prompt
    assert '"lighting"' in prompt
    assert '"description"' in prompt
    assert '"music"' in prompt
    assert "严格输出 JSON 对象" in prompt


def test_prompt_shot_range_scales_with_duration_at_medium_granularity() -> None:
    # 片子越长镜头越多，但按「平均每镜 ~2.5 秒」走中等粒度，
    # 不再把 45 秒的片拆成 40 镜（= 11 个分镜组，翻起来比原片还累）。
    sparse = build_video_breakdown_prompt(frame_count=8, duration_sec=12.5)
    dense = build_video_breakdown_prompt(frame_count=40, duration_sec=45.0)

    assert "拆成 4-5 个镜头" in sparse
    assert "拆成 13-18 个镜头" in dense
    assert "粒度取中" in dense


def test_frame_count_tracks_duration_and_stays_inside_the_cap() -> None:
    # 每秒一帧，短片有下限，长片被 max_frames 封顶。
    assert plan_breakdown_frame_count(duration_sec=45.0, max_frames=40) == 40
    assert plan_breakdown_frame_count(duration_sec=24.0, max_frames=40) == 24
    assert plan_breakdown_frame_count(duration_sec=3.0, max_frames=40) == 8
    # 时长探测失败时只能按预算抽满，不猜密度。
    assert plan_breakdown_frame_count(duration_sec=None, max_frames=40) == 40
    # 调用方压低上限时，上限说了算（连下限一起压）。
    assert plan_breakdown_frame_count(duration_sec=60.0, max_frames=5) == 5


def test_shot_range_follows_duration_not_frame_density() -> None:
    # 8 秒片就算抽了 20 帧，也不该拆成 20 个 0.4 秒的碎镜。
    assert plan_breakdown_shot_range(frame_count=20, duration_sec=8.0) == (3, 3)
    # 长片按时长走中等粒度，而不是把帧数当镜头数（60 秒 → 24 镜，不是 40 镜）。
    assert plan_breakdown_shot_range(frame_count=40, duration_sec=60.0) == (17, 24)
    # 帧数是硬上限：没看过的画面拆不出镜头。
    assert plan_breakdown_shot_range(frame_count=10, duration_sec=60.0) == (7, 10)
    # 时长未知时用帧数当时长的近似（抽帧本来就是每秒一张）。
    assert plan_breakdown_shot_range(frame_count=25, duration_sec=None) == (7, 10)
    # 再短的片也至少给 3 镜，否则「分镜组」就没有意义了。
    assert plan_breakdown_shot_range(frame_count=8, duration_sec=2.0) == (3, 3)


@pytest.mark.asyncio
async def test_breakdown_frames_span_the_whole_video_not_just_the_head(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[list[str]] = []

    async def fake_scene_cmd(cmd: list[str]) -> bool:
        calls.append(cmd)
        pattern = Path(cmd[-1])
        pattern.parent.mkdir(parents=True, exist_ok=True)
        # 快剪素材：全片 100 个切点，文件名是 PTS，一直排到片尾。
        for index in range(100):
            (pattern.parent / f"scene_{index * 30:05d}.jpg").write_bytes(b"x")
        return True

    async def fail_if_called(cmd: list[str]) -> None:
        raise AssertionError(f"切点够密时不该再等距抽一遍: {cmd}")

    monkeypatch.setattr(freezone_jobs, "_try_run_cmd", fake_scene_cmd)
    monkeypatch.setattr(freezone_jobs, "_run_cmd", fail_if_called)

    frames = await freezone_jobs._extract_breakdown_frames(
        video_path=tmp_path / "clip.mp4",
        out_dir=tmp_path / "frames",
        target_frames=10,
        scene_threshold=0.3,
        duration_sec=100.0,
    )

    # 场景检测这趟不能拿目标帧数当 -frames:v：那样扫到第 10 个切点就停，
    # 后面 90 个切点连看都没看到，拉片结果只覆盖视频开头。
    scene_cmd = calls[0]
    assert scene_cmd[scene_cmd.index("-frames:v") + 1] == str(
        freezone_jobs._BREAKDOWN_SCENE_SCAN_LIMIT
    )
    # limited-range 的 yuv420p 会让 mjpeg 编码器直接开不起来，抽帧一张都出不来。
    assert "format=yuvj420p" in scene_cmd[scene_cmd.index("-vf") + 1]
    assert len(frames) == 10
    assert frames[0].name == "scene_00000.jpg"
    assert frames[-1].name == "scene_02970.jpg"
    # 没被选中的帧不留在磁盘上，免得一次拉片攒下几百张废图。
    assert len(list((tmp_path / "frames").glob("scene_*.jpg"))) == 10


@pytest.mark.asyncio
async def test_breakdown_frames_fall_back_to_even_sampling_for_one_take_clips(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[list[str]] = []

    async def fake_scene_cmd(cmd: list[str]) -> bool:
        calls.append(cmd)
        pattern = Path(cmd[-1])
        pattern.parent.mkdir(parents=True, exist_ok=True)
        # 一镜到底：场景检测只认出两个切点，不够拆细。
        for index in range(2):
            (pattern.parent / f"scene_{index * 30:05d}.jpg").write_bytes(b"x")
        return True

    async def fake_even_cmd(cmd: list[str]) -> None:
        calls.append(cmd)
        pattern = Path(cmd[-1])
        pattern.parent.mkdir(parents=True, exist_ok=True)
        for index in range(1, 13):
            (pattern.parent / f"even_{index:05d}.jpg").write_bytes(b"x")

    monkeypatch.setattr(freezone_jobs, "_try_run_cmd", fake_scene_cmd)
    monkeypatch.setattr(freezone_jobs, "_run_cmd", fake_even_cmd)

    frames = await freezone_jobs._extract_breakdown_frames(
        video_path=tmp_path / "clip.mp4",
        out_dir=tmp_path / "frames",
        target_frames=12,
        scene_threshold=0.3,
        duration_sec=12.0,
    )

    assert len(calls) == 2
    even_cmd = calls[1]
    # 12 秒要 12 帧 → 每秒一帧。
    assert "fps=1.000000" in even_cmd[even_cmd.index("-vf") + 1]
    assert len(frames) == 12
    assert all(path.name.startswith("even_") for path in frames)
    # 走了等距那条路，场景帧就是垃圾，不能混进模型输入里。
    assert list((tmp_path / "frames").glob("scene_*.jpg")) == []


def test_normalize_shots_fills_missing_times_and_keeps_them_monotonic() -> None:
    shots = _normalize_breakdown_shots(
        [
            {"shot": 1, "description": "开门"},
            {"shot": 2, "start_time": 1.0, "end_time": 0.5, "description": "回头"},
            {"shot": 3, "start_time": 99.0, "end_time": 120.0, "description": "远景"},
        ],
        duration_sec=9.0,
        frame_count=6,
        group_size=4,
    )

    assert [shot["code"] if "code" in shot else shot["shot"] for shot in shots] == [1, 2, 3]
    assert shots[0]["start_time"] == 0.0
    for previous, current in zip(shots, shots[1:]):
        assert current["start_time"] >= previous["start_time"]
        assert current["end_time"] >= current["start_time"]
    # 越界的时间必须夹回片长内，否则 ffmpeg 会切出 0 秒的空片段。
    assert all(shot["end_time"] <= 9.0 for shot in shots)


def test_normalize_shots_backfills_required_display_fields() -> None:
    (shot,) = _normalize_breakdown_shots(
        [{"visual_description": "少年抬头"}],
        duration_sec=4.0,
        frame_count=3,
        group_size=4,
    )

    assert shot["description"] == "少年抬头"
    assert shot["shot_size"]
    assert shot["lighting"]
    assert shot["camera_movement"]
    assert 1 <= shot["keyframe"] <= 3


def test_group_shots_uses_model_segments_when_present() -> None:
    shots = _normalize_breakdown_shots(
        [{"segment": 1}, {"segment": 1}, {"segment": 2}],
        duration_sec=6.0,
        frame_count=3,
        group_size=4,
    )

    groups = _group_breakdown_shots(
        shots,
        segments=[{"segment": 1, "label": "开场"}, {"segment": 2, "label": "冲突"}],
        group_size=4,
    )

    assert [group["label"] for group in groups] == ["开场", "冲突"]
    assert [len(group["shots"]) for group in groups] == [2, 1]
    assert [group["group_index"] for group in groups] == [1, 2]


def test_group_shots_falls_back_to_even_split_when_model_gives_one_segment() -> None:
    shots = _normalize_breakdown_shots(
        [{"segment": 1} for _ in range(9)],
        duration_sec=18.0,
        frame_count=9,
        group_size=4,
    )

    groups = _group_breakdown_shots(shots, segments=[], group_size=4)

    assert [len(group["shots"]) for group in groups] == [4, 4, 1]
    assert [group["label"] for group in groups] == ["分镜组01", "分镜组02", "分镜组03"]


def test_group_shots_caps_long_model_segments_at_group_size() -> None:
    shots = _normalize_breakdown_shots(
        [{"segment": 1} for _ in range(10)] + [{"segment": 2} for _ in range(3)],
        duration_sec=26.0,
        frame_count=13,
        group_size=4,
    )

    groups = _group_breakdown_shots(
        shots,
        segments=[{"segment": 1, "label": "骑车入田"}, {"segment": 2, "label": "停下聆听"}],
        group_size=4,
    )

    # 模型给的第一段有 10 镜，不封顶就会在画布上堆成一大片。
    assert [len(group["shots"]) for group in groups] == [4, 4, 2, 3]
    assert [group["label"] for group in groups] == [
        "骑车入田（1/3）",
        "骑车入田（2/3）",
        "骑车入田（3/3）",
        "停下聆听",
    ]
    assert [group["group_index"] for group in groups] == [1, 2, 3, 4]
    # 拆出来的组各自是独立分镜组，镜头上的 segment 要跟着走，别再指向原段落。
    assert [shot["segment"] for group in groups for shot in group["shots"]] == [
        1,
        1,
        1,
        1,
        2,
        2,
        2,
        2,
        3,
        3,
        4,
        4,
        4,
    ]


def test_malformed_key_value_pair_is_repaired_instead_of_failing_the_whole_read() -> None:
    # 真实事故：模型把 "shot":25 写成 "shot25，连续错了好几镜，
    # 一个 token 的笔误让整份 20KB 的读片表报废。
    raw = (
        '{"title":"田野","segments":[{"segment":1,"label":"开场"}],"shots":['
        '{"shot":1,"segment":1,"description":"少年骑车"},'
        '{"shot2,"segment":1,"description":"稻田全景"},'
        '{"shot3,"segment":1,"description":"仰望天空"}],'
        '"music":{"description":"轻柔","bpm":76}}'
    )

    parsed = freezone_jobs.loads_model_json(raw)

    assert [shot["shot"] for shot in parsed["shots"]] == [1, 2, 3]
    assert [shot["description"] for shot in parsed["shots"]] == ["少年骑车", "稻田全景", "仰望天空"]
    assert parsed["title"] == "田野"
    assert parsed["music"]["bpm"] == 76


def test_unrepairable_shot_is_dropped_so_the_rest_of_the_read_survives() -> None:
    raw = (
        '{"shots":['
        '{"shot":1,"description":"能用"},'
        '{"shot":2,"description":"坏的" "又坏"},'
        '{"shot":3,"description":"也能用"}]}'
    )

    parsed = freezone_jobs.loads_model_json(raw)

    assert [shot["shot"] for shot in parsed["shots"]] == [1, 3]


def test_hopeless_output_still_raises_so_the_job_can_retry() -> None:
    with pytest.raises(json.JSONDecodeError):
        freezone_jobs.loads_model_json("这不是 JSON，是模型在聊天")


def test_code_fenced_json_is_still_accepted() -> None:
    parsed = freezone_jobs.loads_model_json('```json\n{"shots":[{"shot":1}]}\n```')

    assert parsed["shots"] == [{"shot": 1}]


@pytest.mark.asyncio
async def test_breakdown_retries_once_when_the_model_output_is_beyond_repair(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """拉片一趟要几分钟，模型抽风时宁可自己重试一次，也别让用户重传视频。"""

    video = tmp_path / "clip.mp4"
    video.write_bytes(b"fake")
    frame = tmp_path / "frame_00001.jpg"
    frame.write_bytes(b"\xff\xd8\xff\xd9")

    monkeypatch.setattr(freezone_jobs.shutil, "which", lambda _name: "/usr/bin/ffmpeg")
    monkeypatch.setattr(
        freezone_jobs, "_probe_video_duration", _async_return(8.0), raising=True
    )
    monkeypatch.setattr(
        freezone_jobs, "_extract_breakdown_frames", _async_return([frame]), raising=True
    )
    monkeypatch.setattr(
        freezone_jobs, "_extract_frame_at", _async_return(None), raising=True
    )

    calls: list[int] = []

    async def flaky_vision(**_kwargs: object) -> tuple[str, str]:
        calls.append(1)
        if len(calls) == 1:
            return "vision-model", "抱歉，我无法解析这段视频。"
        return "vision-model", '{"title":"田野","shots":[{"shot":1,"segment":1}]}'

    monkeypatch.setattr(
        "novelvideo.freezone.vision_gateway.call_freezone_vision_model", flaky_vision
    )

    payload = await freezone_jobs.run_freezone_video_breakdown(
        project_dir=tmp_path / "project",
        job_id="job_retry",
        video_path=video,
        dimensions=["storyboard"],
    )

    assert len(calls) == 2
    assert payload["title"] == "田野"
    # 第一趟的原始输出要落盘，出问题时还能翻。
    raw_dump = (
        tmp_path / "project" / "freezone" / "_outputs" / "freezone_video_breakdown" / "job_retry"
    )
    assert (raw_dump / "raw_response.txt").read_text(encoding="utf-8").startswith("抱歉")


def test_motion_selection_prefers_moving_shots_and_returns_time_order() -> None:
    shots = _normalize_breakdown_shots(
        [
            {"start_time": 0.0, "end_time": 5.0, "camera_movement": "固定"},
            {"start_time": 5.0, "end_time": 7.0, "camera_movement": "推镜"},
            {"start_time": 7.0, "end_time": 12.0, "camera_movement": "跟镜"},
        ],
        duration_sec=12.0,
        frame_count=3,
        group_size=4,
    )

    picked = _select_motion_shots(shots, max_clips=2)

    assert [shot["camera_movement"] for shot in picked] == ["推镜", "跟镜"]
    assert picked[0]["start_time"] < picked[1]["start_time"]


def test_motion_selection_falls_back_to_all_shots_when_nothing_moves() -> None:
    shots = _normalize_breakdown_shots(
        [
            {"start_time": 0.0, "end_time": 1.0, "camera_movement": "固定"},
            {"start_time": 1.0, "end_time": 5.0, "camera_movement": "静止"},
        ],
        duration_sec=5.0,
        frame_count=2,
        group_size=4,
    )

    picked = _select_motion_shots(shots, max_clips=1)

    assert len(picked) == 1
    assert picked[0]["duration"] == 4.0


@pytest.mark.asyncio
async def test_breakdown_task_bills_under_the_shared_video_analyze_feature(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, object] = {}

    async def fake_enqueue_project_task(*_args, **kwargs):
        captured.update(kwargs)
        return SimpleNamespace(
            task_state=SimpleNamespace(task_id="task_1"),
            backend="celery",
            queue="node.ffmpeg",
        )

    monkeypatch.setattr(
        freezone_routes,
        "get_task_backend",
        lambda: SimpleNamespace(enqueue_project_task=fake_enqueue_project_task),
    )

    await freezone_routes._enqueue_or_start_freezone_video_analysis(
        ctx=SimpleNamespace(project_id="project_59"),
        username="admin",
        project="59",
        project_dir=tmp_path,
        output_dir=str(tmp_path),
        task_type="freezone_video_breakdown",
        job_id="job_1",
        payload={"video_path": "clip.mp4"},
    )

    assert captured["payload"]["billing"] == {
        "feature_key": "freezone.video_analyze",
        "operation": "video_breakdown",
    }
    # 拉片全程是 ffmpeg 切片，不能占 default 队列。
    assert captured["queue_kind"] == "ffmpeg"


@pytest.mark.asyncio
async def test_breakdown_route_forwards_every_tuning_option(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    video_path = tmp_path / "clip.mp4"
    video_path.write_bytes(b"mp4")
    captured: dict[str, object] = {}

    async def _fake_resolve(project: str, user: dict, *, required_role: str = "editor"):
        del user, required_role
        return None, "admin", project, tmp_path, str(tmp_path)

    monkeypatch.setattr(freezone_routes, "_resolve_freezone_project", _fake_resolve)
    monkeypatch.setattr(freezone_routes, "_new_job_id", lambda: "breakdown_job")
    monkeypatch.setattr(
        freezone_routes,
        "resolve_static_url_to_path",
        lambda _url, _project_dir: video_path,
    )

    async def fake_enqueue(**kwargs):
        captured.update(kwargs)
        captured.update(kwargs["payload"])
        return {"ok": True, "data": {"task_key": f"{kwargs['task_type']}:{kwargs['job_id']}"}}

    monkeypatch.setattr(
        freezone_routes,
        "_enqueue_or_start_freezone_video_analysis",
        fake_enqueue,
    )

    result = await freezone_routes.freezone_video_breakdown(
        project="59",
        body=freezone_routes.FreezoneVideoBreakdownRequest(
            video_url="/static/admin/59/freezone/_uploads/clip.mp4",
            dimensions=["storyboard", "motion"],
            max_frames=12,
            scene_threshold=0.25,
            duration_sec=15.0,
            storyboard_group_size=3,
            max_motion_clips=2,
            motion_clip_max_sec=4.0,
            music_clip_sec=10.0,
        ),
        user={"username": "admin"},
    )

    assert result["data"]["task_key"] == "freezone_video_breakdown:breakdown_job"
    assert captured["video_path"] == video_path.as_posix()
    assert captured["video_url"] == "/static/admin/59/freezone/_uploads/clip.mp4"
    assert captured["dimensions"] == ["storyboard", "motion"]
    assert captured["max_frames"] == 12
    assert captured["scene_threshold"] == 0.25
    assert captured["duration_sec"] == 15.0
    assert captured["storyboard_group_size"] == 3
    assert captured["max_motion_clips"] == 2
    assert captured["motion_clip_max_sec"] == 4.0
    assert captured["music_clip_sec"] == 10.0


def test_breakdown_request_defaults_to_all_three_dimensions() -> None:
    body = freezone_routes.FreezoneVideoBreakdownRequest(video_url="/static/a/1/clip.mp4")

    assert body.dimensions == ["storyboard", "motion", "music"]
    assert body.storyboard_group_size == 4
    assert body.max_motion_clips == 3


@pytest.mark.asyncio
async def test_breakdown_runner_publishes_urls_and_drops_local_paths(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from novelvideo.task_backend.runners import freezone as freezone_runner

    ctx = _ctx(tmp_path)
    project_dir = Path(ctx.output_dir)
    out_dir = project_dir / "freezone" / "_outputs" / "freezone_video_breakdown" / "job"
    out_dir.mkdir(parents=True, exist_ok=True)
    for name in ("shot_01.jpg", "motion_01.mp4", "motion_01.jpg", "music_01.m4a"):
        (out_dir / name).write_bytes(b"bytes")

    class FakeTaskManager:
        def update_progress_for_project(self, *_args, **_kwargs):
            pass

    async def fake_run_freezone_video_breakdown(**_kwargs):
        return {
            "job_id": "job",
            "model": "DC-freezone-vision-LLM",
            "duration_sec": 12.0,
            "title": "雨夜追逐",
            "summary": "少年在雨夜奔跑",
            "dimensions": ["storyboard", "motion", "music"],
            "frame_paths": [],
            "storyboard": {
                "label": "分镜组",
                "groups": [
                    {
                        "group_index": 1,
                        "segment": 1,
                        "label": "分镜组01",
                        "shots": [
                            {
                                "code": "S01",
                                "image_path": str(out_dir / "shot_01.jpg"),
                            }
                        ],
                    }
                ],
            },
            "motion": {
                "label": "动态｜运镜动作参考",
                "clips": [
                    {
                        "code": "M01",
                        "video_path": str(out_dir / "motion_01.mp4"),
                        "preview_image_path": str(out_dir / "motion_01.jpg"),
                    }
                ],
            },
            "music": {
                "label": "音乐｜BGM参考片段",
                "clip": {"code": "A01", "audio_path": str(out_dir / "music_01.m4a")},
            },
            "raw": {"shots": []},
            "output_path": str(out_dir / "breakdown.json"),
        }

    monkeypatch.setattr(freezone_runner, "get_task_manager", lambda: FakeTaskManager())
    monkeypatch.setattr(
        "novelvideo.freezone.jobs.run_freezone_video_breakdown",
        fake_run_freezone_video_breakdown,
    )

    result = await freezone_runner._run_freezone_video_breakdown_async(
        {
            "task_type": "freezone_video_breakdown",
            "payload": {
                "job_id": "job",
                "project_dir": str(project_dir),
                "video_path": str(project_dir / "clip.mp4"),
                "video_url": "/static/projects/proj_breakdown_1/clip.mp4",
            },
        },
        ctx,
    )

    shot = result["storyboard"]["groups"][0]["shots"][0]
    clip = result["motion"]["clips"][0]
    music_clip = result["music"]["clip"]

    assert "image_path" not in shot
    assert "video_path" not in clip
    assert "preview_image_path" not in clip
    assert "audio_path" not in music_clip
    assert shot["image_url"].startswith("/static/projects/proj_breakdown_1/")
    assert clip["video_url"].startswith("/static/projects/proj_breakdown_1/")
    assert clip["preview_image_url"].startswith("/static/projects/proj_breakdown_1/")
    assert music_clip["audio_url"].startswith("/static/projects/proj_breakdown_1/")
    # 原始模型响应只用于排障，不进接口返回。
    assert "raw" not in result
    assert "output_path" not in result
    assert result["source_video_url"] == "/static/projects/proj_breakdown_1/clip.mp4"


@pytest.mark.asyncio
async def test_breakdown_runner_keeps_music_null_when_source_has_no_audio(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from novelvideo.task_backend.runners import freezone as freezone_runner

    ctx = _ctx(tmp_path)
    project_dir = Path(ctx.output_dir)
    project_dir.mkdir(parents=True, exist_ok=True)

    class FakeTaskManager:
        def update_progress_for_project(self, *_args, **_kwargs):
            pass

    async def fake_run_freezone_video_breakdown(**_kwargs):
        return {
            "job_id": "job",
            "dimensions": ["music"],
            "frame_paths": [],
            "storyboard": None,
            "motion": None,
            "music": {"label": "音乐｜BGM参考片段", "clip": None},
            "output_path": "",
        }

    monkeypatch.setattr(freezone_runner, "get_task_manager", lambda: FakeTaskManager())
    monkeypatch.setattr(
        "novelvideo.freezone.jobs.run_freezone_video_breakdown",
        fake_run_freezone_video_breakdown,
    )

    result = await freezone_runner._run_freezone_video_breakdown_async(
        {
            "task_type": "freezone_video_breakdown",
            "payload": {"job_id": "job", "project_dir": str(project_dir), "video_path": "clip.mp4"},
        },
        ctx,
    )

    # 无音轨时 clip 为 None：前端据此不建音频节点，而不是建一个点不开的空节点。
    assert result["music"]["clip"] is None
    assert result["storyboard"] is None
