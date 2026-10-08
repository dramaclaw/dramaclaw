"""逐帧拉片:把逐帧分析收敛成运镜素材。纯函数,不调模型。"""

from __future__ import annotations

from novelvideo.freezone import shot_breakdown
from novelvideo.freezone.shot_breakdown import (
    DOMINANT_MAX,
    build_lens_material,
    lens_material_to_prompt,
    summarize_shot_analyses,
)


def _row(**kwargs):
    base = {
        "shot_type": "近景", "angle": "平视", "camera_movement": "静止",
        "mood": "明快", "color_tone": "暖色调",
    }
    base.update(kwargs)
    return base


def test_dominant_ignores_one_off_noise() -> None:
    """一次性出现的镜头不该被当成整片风格——四个镜头里出现一次才算有代表性。"""
    rows = [_row(shot_type="近景") for _ in range(8)] + [_row(shot_type="大远景")]
    summary = summarize_shot_analyses(rows)
    assert summary["shot_type"] == ["近景"]


def test_dominant_keeps_a_real_second_voice() -> None:
    """「近景为主、间以特写」是真实的镜头节奏,硬压成一个值会丢掉它。"""
    rows = [_row(shot_type="近景") for _ in range(6)] + [_row(shot_type="特写") for _ in range(4)]
    assert set(summarize_shot_analyses(rows)["shot_type"]) == {"近景", "特写"}


def test_dominant_is_capped() -> None:
    rows = [_row(shot_type=f"景别{i}") for i in range(10)]
    assert len(summarize_shot_analyses(rows)["shot_type"]) <= DOMINANT_MAX


def test_flat_distribution_still_returns_something() -> None:
    """分布极其平均时一个都过不了门槛,但返回空素材对下游毫无用处,
    必须退回出现最多的那个。"""
    rows = [_row(camera_movement=f"运镜{i}") for i in range(10)]
    assert summarize_shot_analyses(rows)["camera_movement"] != []


def test_empty_input_does_not_crash() -> None:
    summary = summarize_shot_analyses([])
    assert summary["shot_count"] == 0
    assert summary["shot_type"] == []


def test_material_keeps_both_summary_and_per_shot_detail() -> None:
    """只留摘要等于把反编译结果又压回一句话,那还不如不拆。"""
    rows = [_row(subject_action="推门而入"), _row(subject_action="回头")]
    material = build_lens_material(
        analyses=rows, frame_urls=["/a.png", "/b.png"], source_url="/v.mp4", duration_sec=12.5
    )
    assert material["kind"] == "lens_material"
    assert material["summary"]["shot_count"] == 2
    assert len(material["shots"]) == 2
    assert material["shots"][0]["keyframe_url"] == "/a.png"
    assert material["shots"][1]["subject_action"] == "回头"


def test_non_dict_rows_are_dropped_not_crashed_on() -> None:
    """analyses 来自模型输出,混进字符串或 None 是常态。"""
    material = build_lens_material(analyses=[_row(), "坏数据", None], frame_urls=[])
    assert material["summary"]["shot_count"] == 1


def test_prompt_matches_the_existing_label_convention() -> None:
    """素材供的镜头语言要和用户手选的在提示词里长得一样,模型才不会区别对待。"""
    material = build_lens_material(
        analyses=[_row(camera_movement="推镜") for _ in range(3)], frame_urls=[]
    )
    prompt = lens_material_to_prompt(material)
    assert "景别：近景" in prompt
    assert "运镜：推镜" in prompt
    assert "；" in prompt


# ---------------------------------------------------------------
# v2：镜头区间 / 命名 / 分组布局
# ---------------------------------------------------------------


def test_spans_merge_too_short_segments_instead_of_dropping_them():
    """闪白造成的 0.2s 误检要并进前一段——丢掉会让镜头序号和素材对不上。"""
    spans = shot_breakdown.spans_from_cut_times(
        [4.0, 4.2, 9.0], duration_sec=12.0, min_shot_sec=0.8
    )
    assert [(s["start"], s["end"]) for s in spans] == [
        (0.0, 4.0),
        (4.0, 9.0),
        (9.0, 12.0),
    ]
    assert [s["index"] for s in spans] == [0, 1, 2]


def test_spans_ignore_cuts_outside_the_clip():
    spans = shot_breakdown.spans_from_cut_times([-1.0, 0.0, 30.0], duration_sec=5.0)
    assert spans == [{"start": 0.0, "end": 5.0, "duration": 5.0, "index": 0}]


def test_cap_shot_spans_covers_the_whole_video_and_renumbers():
    spans = [
        {"index": index, "start": float(index), "end": float(index + 1), "duration": 1.0}
        for index in range(10)
    ]

    capped = shot_breakdown.cap_shot_spans(spans, max_shots=4)

    assert [span["start"] for span in capped] == [0.0, 3.0, 6.0, 9.0]
    assert [span["index"] for span in capped] == [0, 1, 2, 3]


def test_cap_shot_spans_leaves_short_input_unchanged_but_copies_rows():
    spans = [{"index": 7, "start": 0.0, "end": 1.0, "duration": 1.0}]

    capped = shot_breakdown.cap_shot_spans(spans, max_shots=3)

    assert capped == [{"index": 0, "start": 0.0, "end": 1.0, "duration": 1.0}]
    assert capped[0] is not spans[0]


def test_sample_points_avoid_transition_frames():
    start, end = shot_breakdown.sample_points_for_span({"start": 4.0, "end": 9.0})
    assert start > 4.0 and end < 9.0


def test_sample_points_on_a_very_short_shot_fall_back_to_the_middle():
    """内缩会把两端交叉时宁可两张图接近，也不能取到转场帧。"""
    start, end = shot_breakdown.sample_points_for_span({"start": 2.0, "end": 2.3})
    assert 2.0 <= start <= end <= 2.3


def test_node_names_carry_the_lens_language():
    analysis = {"shot_type": "大特写", "camera_movement": "固定", "subject_action": "琵琶按弦"}
    assert (
        shot_breakdown.format_frame_node_name(2, analysis)
        == "S02｜大特写·固定｜琵琶按弦"
    )
    assert shot_breakdown.format_clip_node_name(
        1, duration_sec=4.2, analysis=analysis
    ).startswith("M01｜4s·大特写固定｜琵琶按弦")


def test_node_names_survive_a_missing_analysis():
    assert shot_breakdown.format_frame_node_name(1, None) == "S01｜镜头·固定"


def test_grid_layout_sizes_the_group_to_its_children():
    four = shot_breakdown.grid_layout(4)
    assert four["width"] == 808 and four["height"] == 838
    two = shot_breakdown.grid_layout(2)
    assert two["width"] == 808 and two["height"] == 452
    assert two["positions"] == [{"x": 36, "y": 66}, {"x": 422, "y": 66}]


def test_groups_are_emitted_per_dimension_and_skipped_when_empty():
    groups = shot_breakdown.build_breakdown_groups(
        frames=[{"kind": "image", "subject_action": "起手"}, {"kind": "image", "subject_action": "收势"}],
        clips=[],
        audio=None,
    )
    assert [g["key"] for g in groups] == [shot_breakdown.DIMENSION_STORYBOARD]
    assert groups[0]["name"] == "分镜组01｜起手→收势"


def test_audio_node_name_separates_stem_from_full_track():
    """伴奏和原声铺到新片上效果天差地别，名字里必须分得开。"""
    assert (
        shot_breakdown.format_audio_node_name(duration_sec=11.07, mood="温馨", bgm_only=True)
        == "BGM｜11s·温馨·伴奏"
    )
    assert (
        shot_breakdown.format_audio_node_name(duration_sec=11.07, bgm_only=False)
        == "BGM｜11s·原声（含人声）"
    )


def test_vocals_track_gets_its_own_name():
    assert (
        shot_breakdown.format_audio_node_name(duration_sec=11.0, track="vocals")
        == "人声｜11s·对白轨"
    )


def test_music_group_carries_both_tracks_when_separation_succeeded():
    """伴奏和人声是同一次分离的两个产物，装进同一个音乐组。"""
    groups = shot_breakdown.build_breakdown_groups(
        audio={"kind": "audio", "name": "BGM｜11s·伴奏"},
        vocals={"kind": "audio", "name": "人声｜11s·对白轨"},
    )
    assert len(groups) == 1
    assert [item["name"] for item in groups[0]["items"]] == [
        "BGM｜11s·伴奏",
        "人声｜11s·对白轨",
    ]
    assert len(groups[0]["layout"]["positions"]) == 2
