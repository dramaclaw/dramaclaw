from novelvideo.cognee.script_parser import parse_scenes
from novelvideo.utils.screenplay_quality import check_screenplay_import_quality
from novelvideo.utils.screenplay_scene_parser import parse_scene_blocks
from novelvideo.workflows.literal_script_writing import LiteralScriptWritingWorkflow


def test_parse_one_line_scene_block_header():
    text = """
场次（1）地点：兰州拉面馆，夜，内；出场人物：杜晨，面馆男青年，面馆女青年
杜晨：老板，结账。
"""

    blocks = parse_scene_blocks(text)

    assert len(blocks) == 1
    assert blocks[0].location == "兰州拉面馆"
    assert blocks[0].time_of_day == "夜"
    assert blocks[0].interior_exterior == "内"
    assert blocks[0].characters == ["杜晨", "面馆男青年", "面馆女青年"]
    assert blocks[0].lines == ["杜晨：老板，结账。"]


def test_parse_three_line_scene_block_header():
    text = """
场次（1）
地点：兰州拉面馆，夜，内
出场人物：杜晨，面馆男青年，面馆女青年
杜晨：老板，结账。
"""

    blocks = parse_scene_blocks(text)

    assert len(blocks) == 1
    assert blocks[0].location == "兰州拉面馆"
    assert blocks[0].time_of_day == "夜"
    assert blocks[0].interior_exterior == "内"
    assert blocks[0].characters == ["杜晨", "面馆男青年", "面馆女青年"]
    assert blocks[0].lines == ["杜晨：老板，结账。"]


def test_parse_repairable_split_scene_header_without_polluting_body():
    text = """
场次：1
地点：兰州拉面馆
时间：夜
内外景：内
人物：杜晨，面馆男青年
杜晨：老板，结账。
"""

    blocks = parse_scene_blocks(text)

    assert len(blocks) == 1
    assert blocks[0].scene_no == "1"
    assert blocks[0].location == "兰州拉面馆"
    assert blocks[0].time_of_day == "夜"
    assert blocks[0].interior_exterior == "内"
    assert blocks[0].characters == ["杜晨", "面馆男青年"]
    assert blocks[0].lines == ["杜晨：老板，结账。"]


def test_parse_numbered_legacy_header_with_people_line():
    text = """
1-1、上海老城·封门旧址 深夜 外
人物：鲁鸢、鬼纹木魈、神秘人

鲁鸢【VO】：旧梁、老桩、百年门楼。
△封门旧址，死寂，门楼塌了一半。
"""

    blocks = parse_scene_blocks(text)

    assert len(blocks) == 1
    assert blocks[0].episode == 1
    assert blocks[0].scene_no == "1"
    assert blocks[0].location == "上海老城·封门旧址"
    assert blocks[0].time_of_day == "深夜"
    assert blocks[0].interior_exterior == "外"
    assert blocks[0].characters == ["鲁鸢", "鬼纹木魈", "神秘人"]
    assert blocks[0].lines == [
        "鲁鸢【VO】：旧梁、老桩、百年门楼。",
        "△封门旧址，死寂，门楼塌了一半。",
    ]


def test_parse_numbered_marker_then_location_line():
    text = """
1-1
上海老城·封门旧址 深夜 外
人物：鲁鸢、鬼纹木魈、神秘人
鲁鸢【VO】：旧梁、老桩、百年门楼。
"""

    blocks = parse_scene_blocks(text)

    assert len(blocks) == 1
    assert blocks[0].header_line == "1-1"
    assert blocks[0].location == "上海老城·封门旧址"
    assert blocks[0].time_of_day == "深夜"
    assert blocks[0].interior_exterior == "外"
    assert blocks[0].characters == ["鲁鸢", "鬼纹木魈", "神秘人"]
    assert blocks[0].lines == ["鲁鸢【VO】：旧梁、老桩、百年门楼。"]


def test_cognee_scene_parser_uses_shared_scene_blocks():
    text = """
1-1、上海老城·封门旧址 深夜 外
人物：鲁鸢、鬼纹木魈、神秘人
鲁鸢【VO】：旧梁、老桩、百年门楼。
"""

    scenes = parse_scenes(text)

    assert len(scenes) == 1
    assert scenes[0].name == "上海老城·封门旧址"
    assert scenes[0].time_of_day == "深夜"
    assert scenes[0].interior is False
    assert scenes[0].characters == ["鲁鸢", "鬼纹木魈", "神秘人"]
    assert scenes[0].context_lines == ["鲁鸢【VO】：旧梁、老桩、百年门楼。"]


def test_literal_scene_blocks_accept_multiline_headers():
    lines = [
        "场次（1）",
        "地点：兰州拉面馆，夜，内",
        "出场人物：杜晨，面馆男青年",
        "杜晨：老板，结账。",
    ]

    blocks = LiteralScriptWritingWorkflow._build_scene_blocks(lines)

    assert len(blocks) == 1
    assert blocks[0].location == "兰州拉面馆"
    assert blocks[0].time_of_day == "夜晚"
    assert blocks[0].characters == ["杜晨", "面馆男青年"]
    assert blocks[0].lines == ["杜晨：老板，结账。"]


def test_literal_scene_blocks_normalize_classical_time_to_closed_choice():
    lines = [
        "3-1、凤鸣皇城·苏鸾寝殿 亥时 内",
        "人物：苏糖、沈晚、锦绣",
        "△烛火跳动。",
    ]

    blocks = LiteralScriptWritingWorkflow._build_scene_blocks(lines)

    assert len(blocks) == 1
    assert blocks[0].location == "凤鸣皇城·苏鸾寝殿"
    assert blocks[0].time_of_day == "夜晚"


def test_literal_parse_scene_header_normalizes_time_to_closed_choice():
    header = LiteralScriptWritingWorkflow._parse_scene_header("凤鸣皇城·苏鸾寝殿 亥时 内")

    assert header == {
        "location": "凤鸣皇城·苏鸾寝殿",
        "time_of_day": "夜晚",
    }


def test_screenplay_quality_accepts_legacy_numbered_headers():
    text = """
1-1、上海老城·封门旧址 深夜 外
人物：鲁鸢、鬼纹木魈、神秘人
鲁鸢【VO】：旧梁、老桩、百年门楼。
神秘人：你不该来这里。
鲁鸢：我已经来了。
神秘人：那就留下。
鲁鸢：试试看。
"""

    report = check_screenplay_import_quality(text)

    assert report.metrics["total_scene_headers"] == 1
    assert not any(issue.code == "missing_scene_headers" for issue in report.blocking_issues)


def test_parse_classical_hour_scene_header():
    text = """
3-1、凤鸣皇城·苏鸾寝殿 亥时 内
人物：苏糖、沈晚、锦绣
△烛火跳动。
"""

    blocks = parse_scene_blocks(text)

    assert len(blocks) == 1
    assert blocks[0].location == "凤鸣皇城·苏鸾寝殿"
    assert blocks[0].time_of_day == "亥时"
    assert blocks[0].interior_exterior == "内"


def test_parse_classical_hour_with_quarter_scene_header():
    text = """
2-1、演武场外墙 亥时三刻 外
人物：苏糖、沈晚
△夜风卷着落叶。
"""

    scenes = parse_scenes(text)

    assert len(scenes) == 1
    assert scenes[0].name == "演武场外墙"
    assert scenes[0].time_of_day == "亥时三刻"
    assert scenes[0].interior is False
