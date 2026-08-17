"""选中 Beats 再生的任务行要能说清自己覆盖了哪些 beat。

``sketch_regen`` / ``selected_regen`` 的任务行 ``beat_num`` 是 None，``scope`` 是
``mode_key__sha1(beats)``，前端从这两样都反推不出 beat 号。结果是每个 beat 的草图 /
渲染图面板都认领同一条任务，一个 beat 在跑、其他 beat 也跟着显示「生成中」。
入队时把 beat 名单落进 task metadata，前端就能按 beat 归属显示进度。
"""

import pytest

from novelvideo.ports.tasks import display_metadata_for_task


def test_selected_beats_land_in_metadata_from_config():
    metadata = display_metadata_for_task(
        "sketch_regen",
        {"episode": 1, "config": {"selected_beat_numbers": [9, 10]}},
    )

    assert metadata["beat_numbers"] == [9, 10]


def test_selected_beats_also_read_from_top_level_payload():
    metadata = display_metadata_for_task(
        "selected_regen",
        {"episode": 1, "selected_beat_numbers": [3]},
    )

    assert metadata["beat_numbers"] == [3]


def test_beat_numbers_are_deduped_in_order():
    metadata = display_metadata_for_task(
        "sketch_regen",
        {"config": {"selected_beat_numbers": [9, 9, 7, "7", 8]}},
    )

    assert metadata["beat_numbers"] == [9, 7, 8]


@pytest.mark.parametrize(
    "payload",
    [
        {},
        {"config": {}},
        {"config": {"selected_beat_numbers": []}},
        {"config": {"selected_beat_numbers": ["", None]}},
    ],
)
def test_no_beat_numbers_key_when_payload_has_none(payload):
    """没名单就别写这个键——前端把「缺失」读成「覆盖全部」，写个空列表会把真在跑的
    beat 藏掉。"""
    assert "beat_numbers" not in display_metadata_for_task("sketch_regen", payload)


def test_existing_display_metadata_is_untouched():
    metadata = display_metadata_for_task(
        "stage_asset",
        {"scene_name": "家中客厅", "step": "pano", "display_name": "舞台资产"},
    )

    assert metadata["scene_name"] == "家中客厅"
    assert metadata["step"] == "pano"
    assert metadata["display_name"] == "舞台资产"
    assert "beat_numbers" not in metadata
