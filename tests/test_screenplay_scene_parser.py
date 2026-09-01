import pytest

from novelvideo.cognee.script_parser import parse_scenes
from novelvideo.time_of_day import normalize_time_of_day
from novelvideo.utils.screenplay_quality import assess_screenplay_scene_headers
from novelvideo.utils.screenplay_quality import check_screenplay_import_quality
from novelvideo.utils.screenplay_scene_parser import parse_scene_blocks
from novelvideo.utils.screenplay_scene_parser import is_scene_start_line
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


def test_parse_bare_scene_numbers_when_followed_by_location_headers():
    text = """
第一集 初遇
1
咖啡馆 日 内
人物：张三
张三：我到了。
（2）
办公室 夜 内
人物：李四
李四：进来吧。
"""

    blocks = parse_scene_blocks(text)

    assert [(block.scene_no, block.location) for block in blocks] == [
        ("1", "咖啡馆"),
        ("2", "办公室"),
    ]
    assert blocks[0].lines == ["张三：我到了。"]
    assert blocks[1].lines == ["李四：进来吧。"]


def test_do_not_treat_standalone_number_as_scene_without_location_header():
    text = """
第一集 初遇
1-1 咖啡馆 日 内
人物：张三
张三：年份是多少？
2026
张三：原来如此。
"""

    blocks = parse_scene_blocks(text)

    assert len(blocks) == 1
    assert blocks[0].lines == [
        "张三：年份是多少？",
        "2026",
        "张三：原来如此。",
    ]


def test_parse_numbered_bracketed_scene_headers_with_characters():
    text = """
第一集
1 场景：【夜 皇宫豹房露台 外】
人物：正德帝、随行太监
△ 乾清宫方向烈焰冲天。
正德帝：好一棚大烟火也。
2 场景：【夜 乾清宫偏殿・尚宝监值守房 内】
人物：黑衣刺客（李砚）、尚宝监王奉御
△ 浓烟顺着窗缝往殿内灌。
李砚 OS：朱家的天下，早已烂在根里。
3 场景：【夜 紫禁城宫墙与屋顶 外】
人物：李砚、锦衣卫众、陆峥
△ 李砚在飞檐间疾奔。
陆峥：立刻封锁九门。
"""

    blocks = parse_scene_blocks(text)

    assert is_scene_start_line("1 场景：【夜 皇宫豹房露台 外】") is True
    assert len(blocks) == 3
    assert [
        (
            block.episode,
            block.scene_no,
            block.location,
            block.time_of_day,
            block.interior_exterior,
            block.characters,
        )
        for block in blocks
    ] == [
        (1, "1", "皇宫豹房露台", "夜", "外", ["正德帝", "随行太监"]),
        (1, "2", "乾清宫偏殿・尚宝监值守房", "夜", "内", ["李砚", "尚宝监王奉御"]),
        (1, "3", "紫禁城宫墙与屋顶", "夜", "外", ["李砚", "锦衣卫众", "陆峥"]),
    ]
    assert blocks[0].lines == ["△ 乾清宫方向烈焰冲天。", "正德帝：好一棚大烟火也。"]
    assert blocks[1].lines == [
        "△ 浓烟顺着窗缝往殿内灌。",
        "李砚 OS：朱家的天下，早已烂在根里。",
    ]
    assert blocks[2].lines == ["△ 李砚在飞檐间疾奔。", "陆峥：立刻封锁九门。"]


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


def test_parse_dot_numbered_scene_with_interior_before_time():
    text = """
第11集
11.1 李家客厅 内 日
人物：李梅、王芳
▲ 李梅把书包放到桌上。
李梅：我回来了。
11.2 学校实验室 外 夜
人物：李梅、老师
▲ 夜风吹过实验楼。
"""

    blocks = parse_scene_blocks(text)

    assert [
        (
            block.episode,
            block.scene_no,
            block.location,
            block.time_of_day,
            block.interior_exterior,
        )
        for block in blocks
    ] == [
        (11, "1", "李家客厅", "日", "内"),
        (11, "2", "学校实验室", "夜", "外"),
    ]
    assert blocks[0].lines == ["▲ 李梅把书包放到桌上。", "李梅：我回来了。"]


def test_scene_boundary_preserves_adjacent_sublocations_for_later_scene_planning():
    blocks = parse_scene_blocks(
        "第一集\n1.2 名门高级人才学院教室/楼梯间 内 日\n人物：李梅\n李梅：快走。"
    )

    assert len(blocks) == 1
    assert blocks[0].location == "名门高级人才学院教室/楼梯间"
    assert blocks[0].time_of_day == "日"
    assert blocks[0].interior_exterior == "内"


def test_parse_insert_scene_and_standalone_insert_annotation():
    text = """
第11集
+场 李家厨房 内 夜
人物：奶奶
▲ 奶奶关上灶火。
+场
11.2 学校实验室 内 日
人物：李梅
李梅：实验完成了。
"""

    blocks = parse_scene_blocks(text)

    assert len(blocks) == 2
    assert blocks[0].location == "李家厨房"
    assert blocks[0].time_of_day == "夜"
    assert blocks[1].scene_no == "2"
    assert blocks[1].location == "学校实验室"


def test_incomplete_insert_scene_keeps_boundary_for_warning_and_normalization():
    blocks = parse_scene_blocks(
        "第一集\n+场 舞蹈室照镜子 日\n人物：李梅\n▲ 李梅看向镜中的自己。"
    )

    assert len(blocks) == 1
    assert blocks[0].location == "舞蹈室照镜子"
    assert blocks[0].time_of_day == "日"
    assert blocks[0].interior_exterior == ""
    assert is_scene_start_line("+场 舞蹈室照镜子 日") is True


def test_insert_scene_with_handwritten_punctuation_never_drops_the_heading():
    text = """
+场 医院走廊。
+场（3）学校礼堂！
+场 操场？
"""

    blocks = parse_scene_blocks(text)

    assert [block.header_line for block in blocks] == [
        "+场 医院走廊。",
        "+场（3）学校礼堂！",
        "+场 操场？",
    ]
    assert [block.location for block in blocks] == [
        "医院走廊",
        "学校礼堂",
        "操场",
    ]
    assert blocks[1].scene_no == "3"


def test_version_number_is_not_treated_as_partial_chinese_scene_header():
    blocks = parse_scene_blocks("第一集\n1.2 release notes\n这是普通说明。")

    assert len(blocks) == 1
    assert blocks[0].header_line == ""
    assert blocks[0].lines == ["1.2 release notes", "这是普通说明。"]


def test_parse_chinese_and_english_fountain_scene_headers():
    text = """
内景 客厅 - 夜
张三：回来了。
EXT. SCHOOL YARD - DAY #2A#
LUCY: WAIT FOR ME.
"""

    blocks = parse_scene_blocks(text)

    assert [
        (block.location, block.time_of_day, block.interior_exterior)
        for block in blocks
    ] == [
        ("客厅", "夜", "内"),
        ("SCHOOL YARD", "日", "外"),
    ]


def test_parse_explicit_english_scene_markers_and_metadata():
    text = """Episode 1
SCENE 1 — THE EMPTY PLATFORM
Location: Seoul Subway Station
Time: 11:47 PM
Characters: Ji-won, Old Woman
JI-WON: Hello?
SCENE 2 — THE LAST TRAIN
The train stops.
"""

    blocks = [block for block in parse_scene_blocks(text) if block.header_line]

    assert len(blocks) == 2
    assert blocks[0].episode == 1
    assert blocks[0].scene_no == "1"
    assert blocks[0].location == "Seoul Subway Station"
    assert blocks[0].time_of_day == "11:47 PM"
    assert blocks[0].characters == ["Ji-won", "Old Woman"]
    assert blocks[0].lines == ["JI-WON: Hello?"]
    assert blocks[1].scene_no == "2"
    assert blocks[1].lines == ["The train stops."]


@pytest.mark.parametrize(
    "prose_line",
    [
        "Scene 2 was rewritten yesterday.",
        "Chapter 2 explains why the train stopped.",
    ],
)
def test_numbered_english_prose_is_preserved_as_body_content(prose_line):
    blocks = parse_scene_blocks(prose_line)

    assert len(blocks) == 1
    assert blocks[0].header_line == ""
    assert blocks[0].lines == [prose_line]


def test_parse_numbered_english_scene_and_constrained_sense_compatibility():
    text = """Episode 1
1-1 Scene: Living room at home, daytime
Characters: Me, Father, Mother
ME: Stop.
1-2 Sense: Brother's bedroom, nighttime
Characters: Sister, Brother
SISTER: Listen.
"""

    blocks = [block for block in parse_scene_blocks(text) if block.header_line]

    assert [block.scene_no for block in blocks] == ["1", "2"]
    assert [block.location for block in blocks] == [
        "Living room at home",
        "Brother's bedroom",
    ]
    assert [block.time_of_day for block in blocks] == ["daytime", "nighttime"]
    assert blocks[0].characters == ["Me", "Father", "Mother"]
    assert blocks[1].characters == ["Sister", "Brother"]


def test_parse_bare_sense_only_with_structured_location_and_time():
    text = """Episode 1
Sense: Living room at home, daytime
Time: First Grade
Characters: Me, Father, Mother
ME: Stop.
1-2 Sense: Brother's bedroom, nighttime
Characters: Sister, Brother
SISTER: Listen.
"""

    blocks = [block for block in parse_scene_blocks(text) if block.header_line]

    assert len(blocks) == 2
    assert blocks[0].location == "Living room at home"
    assert blocks[0].time_of_day == "daytime"
    assert blocks[0].characters == ["Me", "Father", "Mother"]
    assert blocks[0].lines == ["Time: First Grade", "ME: Stop."]
    assert blocks[1].scene_no == "2"


def test_bare_sense_and_production_labels_remain_body_content():
    text = """SCENE 1 — PLATFORM
Sense: something is wrong.
Sense 2 people entered.
NARRATOR:
The station is empty.
SFX:
Metal scraping.
VISUAL PROMPT:
Dark tunnel.
"""

    blocks = [block for block in parse_scene_blocks(text) if block.header_line]

    assert len(blocks) == 1
    assert blocks[0].lines == [
        "Sense: something is wrong.",
        "Sense 2 people entered.",
        "NARRATOR:",
        "The station is empty.",
        "SFX:",
        "Metal scraping.",
        "VISUAL PROMPT:",
        "Dark tunnel.",
    ]


def test_parse_chinese_fountain_heading_without_space_after_dot():
    blocks = parse_scene_blocks(
        "内景.咖啡馆 - 日\n张三：你好。\n内景茶室 - 夜\n李四：请坐。"
    )

    assert [
        (block.location, block.time_of_day, block.interior_exterior)
        for block in blocks
    ] == [
        ("咖啡馆", "日", "内"),
        ("茶室", "夜", "内"),
    ]


def test_chinese_fountain_short_prefix_does_not_match_prose():
    blocks = parse_scene_blocks("内心独白 - 日\n张三想起了往事。")

    assert len(blocks) == 1
    assert blocks[0].header_line == ""
    assert blocks[0].lines == ["内心独白 - 日", "张三想起了往事。"]


def test_mixed_international_heading_is_repairable_by_design():
    blocks = parse_scene_blocks("INT./EXT. CAR - NIGHT\nThe car crosses a tunnel.")

    assert len(blocks) == 1
    assert blocks[0].location == "CAR"
    assert blocks[0].time_of_day == "夜"
    assert blocks[0].interior_exterior == ""


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


# 下面这段与 frontend/src/components/ingest/NovelFormatDialog.tsx 里
# DRAMA_FORMAT_EXAMPLE_EN 逐字相同。那是英文界面「照着抄」的模板，
# 抄出来必须是解析器认的标准格式——否则文档就在教人写导入失败的剧本。
DOCUMENTED_ENGLISH_FORMAT_EXAMPLE = """EPISODE 1

INT. SEOUL SUBWAY STATION - NIGHT
Characters: Ji-won, Old Woman

△ Rainwater drips from the ceiling. The platform is completely empty.

JI-WON: Is anyone here?

OLD WOMAN: You should not have come this late.


INT. SUBWAY CAR - NIGHT
Characters: Ji-won, Old Woman, Boy

△ The train doors close. The lights flicker above the empty seats.

JI-WON: Where is this train going?

OLD WOMAN: To the last station.


EXT. SEOUL STREET - DAWN
Characters: Ji-won

△ Ji-won steps onto the deserted street as the first morning light appears.

JI-WON: I made it back.
"""


def test_documented_english_format_example_parses_as_standard():
    blocks = parse_scene_blocks(DOCUMENTED_ENGLISH_FORMAT_EXAMPLE)

    assert [
        (b.episode, b.location, b.time_of_day, b.interior_exterior, b.characters)
        for b in blocks
    ] == [
        (1, "SEOUL SUBWAY STATION", "夜", "内", ["Ji-won", "Old Woman"]),
        (1, "SUBWAY CAR", "夜", "内", ["Ji-won", "Old Woman", "Boy"]),
        (1, "SEOUL STREET", "清晨", "外", ["Ji-won"]),
    ]
    # 时间是原文写出来的，不是兜底推断的；推断出来的时间不会继承给场景变体。
    assert not any(b.time_inferred for b in blocks)

    assessment = assess_screenplay_scene_headers(DOCUMENTED_ENGLISH_FORMAT_EXAMPLE)
    assert assessment.status == "standard"
    assert assessment.standard_headers == 3

    report = check_screenplay_import_quality(DOCUMENTED_ENGLISH_FORMAT_EXAMPLE)
    assert report.blocking_issues == []
    assert report.warnings == []


def test_documented_english_time_line_keeps_clock_out_of_the_location():
    """文档承诺：钟点写成独立的 `Time:` 行，地点不受污染，时间归一化成「夜晚」。"""
    text = (
        "EPISODE 1\n"
        "INT. SEOUL SUBWAY STATION - NIGHT\n"
        "Time: 11:47 PM\n"
        "Characters: Ji-won, Old Woman\n"
        "△ Rainwater drips from the ceiling.\n"
        "JI-WON: Is anyone here?\n"
    )

    (block,) = parse_scene_blocks(text)

    assert block.location == "SEOUL SUBWAY STATION"
    assert block.time_of_day == "11:47 PM"
    assert normalize_time_of_day(block.time_of_day) == "夜晚"
    assert assess_screenplay_scene_headers(text).status == "standard"


def test_documented_english_repairable_format_is_warned_not_blocked():
    """文档把 `SCENE 1 - TITLE` 标成「可修复」：能定边界，但缺时间，只警告不阻断。"""
    text = (
        "EPISODE 1\n"
        "\n"
        "SCENE 1 - SEOUL SUBWAY STATION\n"
        "Characters: Ji-won, Old Woman\n"
        "△ Rainwater drips from the ceiling.\n"
        "JI-WON: Is anyone here?\n"
    )

    assessment = assess_screenplay_scene_headers(text)
    assert assessment.status == "repairable"
    assert assessment.detected_headers == 1
    assert assessment.standard_headers == 0

    report = check_screenplay_import_quality(text)
    assert report.blocking_issues == []
    assert "scene_headers_missing_time" in {w.code for w in report.warnings}


@pytest.mark.parametrize("bad_time", ["MIDNIGHT", "LATE NIGHT", "11:47 PM"])
def test_undocumented_english_time_tokens_lose_the_scene_boundary(bad_time):
    """文档只列 7 个时间词，是因为写别的会整行识别不出来，不只是丢时间。

    如果解析器以后支持了更多时间词，这条会转红——那时要同步放宽
    `ingest.novelFormat.ruleTimeTokens` 里给用户的清单，而不是删掉这条。
    """
    text = (
        "EPISODE 1\n"
        f"INT. SEOUL SUBWAY STATION - {bad_time}\n"
        "Characters: Ji-won\n"
        "△ Rainwater drips from the ceiling.\n"
        "JI-WON: Is anyone here?\n"
    )

    assert assess_screenplay_scene_headers(text).status == "missing"


def test_clock_time_inside_the_location_name_pollutes_the_location():
    """文档禁止把钟点写进地点名：预检不会报错，但地点会带着钟点一路传下去。"""
    text = (
        "EPISODE 1\n"
        "INT. SEOUL SUBWAY STATION 11:47 PM - NIGHT\n"
        "Characters: Ji-won\n"
        "△ Rainwater drips from the ceiling.\n"
        "JI-WON: Is anyone here?\n"
    )

    (block,) = parse_scene_blocks(text)

    assert block.location == "SEOUL SUBWAY STATION 11:47 PM"
    assert assess_screenplay_scene_headers(text).status == "standard"
