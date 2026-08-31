from __future__ import annotations

import io
from types import SimpleNamespace

import pytest
from fastapi import UploadFile

from novelvideo.utils.screenplay_quality import build_import_format_check


def _codes(result: dict) -> set[str]:
    return {issue["code"] for issue in result["issues"]}


def _issue(result: dict, code: str) -> dict:
    return next(issue for issue in result["issues"] if issue["code"] == code)


def _dialogue_lines(count: int) -> str:
    return "\n".join(f"角色{i % 3}：这是一句用于预检统计的对白。" for i in range(count))


def test_complete_split_field_scene_header_is_supported_without_warning():
    result = build_import_format_check(
        "场次：1\n地点：人类城池\n时间：日\n内外景：内\n",
        has_chapters=True,
    )

    assert result["level"] == "ok"
    assert result["scene_header_status"] == "standard"
    assert result["issues"] == []


def test_normative_scene_headers_pass_without_issues():
    text = f"""
1-1、上海老城·封门旧址 深夜 外
人物：鲁鸢、神秘人
{_dialogue_lines(8)}
1-2、上海老城·雨棚 日 内
人物：鲁鸢、老板
{_dialogue_lines(8)}
"""

    result = build_import_format_check(text, has_chapters=True)

    assert result["level"] == "ok"
    assert result["issues"] == []
    assert result["scene_header_status"] == "standard"


def test_not_screenplay_like_is_metric_only():
    text = """
1-1、上海老城·封门旧址 深夜 外
人物：鲁鸢、神秘人
鲁鸢：你来了。
"""

    result = build_import_format_check(text, has_chapters=True)

    assert result["level"] == "ok"
    assert result["issues"] == []


def test_missing_interior_exterior_warns():
    result = build_import_format_check(
        "1-1、上海老城·封门旧址 深夜\n鲁鸢：你来了。\n神秘人：是。\n",
        has_chapters=True,
    )

    assert result["level"] == "warning"
    assert "missing_interior_exterior" in _codes(result)


def test_inline_scene_header_with_trailing_character_metadata_keeps_interior_exterior():
    result = build_import_format_check(
        "场次（1）地点：兰州拉面馆，夜，内；人物：老板\n老板：欢迎。\n",
        has_chapters=True,
    )

    assert "missing_interior_exterior" not in _codes(result)


def test_missing_scene_headers_is_warning_when_chapters_exist():
    text = _dialogue_lines(8)

    result = build_import_format_check(text, has_chapters=True)

    assert result["level"] == "warning"
    assert "missing_scene_headers" in _codes(result)
    assert result["level"] != "blocking"
    assert result["scene_header_status"] == "missing"


def test_headerless_short_drama_is_blocking_when_scene_headers_are_required():
    text = "第一集\n孙悟空走进寝房，看见师父正在休息。"

    result = build_import_format_check(
        text,
        has_chapters=True,
        require_scene_headers=True,
    )

    assert result["level"] == "blocking"
    assert result["scene_header_status"] == "missing"
    assert "missing_scene_headers" in _codes(result)


def test_explicit_english_scene_markers_are_repairable_not_missing():
    text = """Episode 1
SCENE 1 — THE EMPTY PLATFORM
Location: Seoul Subway Station
Time: 11:47 PM
JI-WON: Hello?
SCENE 2 — THE LAST TRAIN
The train stops.
"""

    result = build_import_format_check(
        text,
        has_chapters=True,
        require_scene_headers=True,
    )

    assert result["level"] != "blocking"
    assert result["scene_header_status"] == "repairable"
    assert "missing_scene_headers" not in _codes(result)


@pytest.mark.parametrize(
    "action_line",
    [
        "孙悟空快步走到门外",
        "孙悟空推门走进屋内",
        "孙悟空快步走到门外（闪回）",
        "孙悟空推门走进屋内（雨）",
    ],
)
def test_prose_ending_in_interior_or_exterior_is_not_a_repairable_scene_header(
    action_line,
):
    text = f"""
第一集
{action_line}
他发现师父已经离开。
"""

    result = build_import_format_check(
        text,
        has_chapters=True,
        require_scene_headers=True,
    )

    assert result["level"] == "blocking"
    assert result["scene_header_status"] == "missing"
    assert "missing_scene_headers" in _codes(result)


def test_unnumbered_header_with_explicit_time_and_commas_is_supported():
    text = """
第一集
菩提寝房，夜，内
孙悟空：师父。
"""

    result = build_import_format_check(
        text,
        has_chapters=True,
        require_scene_headers=True,
    )

    assert result["level"] == "ok"
    assert result["scene_header_status"] == "standard"


@pytest.mark.parametrize(
    "header",
    [
        "菩提寝房 夜 内（闪回）",
        "菩提寝房，夜，内（梦境）",
        "菩提寝房 夜 内（闪回）（雨）",
    ],
)
def test_unnumbered_header_with_trailing_parenthetical_is_supported(header):
    text = f"""
第一集
{header}
孙悟空：师父。
"""

    result = build_import_format_check(
        text,
        has_chapters=True,
        require_scene_headers=True,
    )

    assert result["level"] == "ok"
    assert result["scene_header_status"] == "standard"


def test_bare_numbered_labeled_scene_header_is_supported():
    text = """
第一集
1场 地点：菩提寝房
时间：夜
内外景：内
孙悟空：师父。
"""

    result = build_import_format_check(
        text,
        has_chapters=True,
        require_scene_headers=True,
    )

    assert result["level"] == "ok"
    assert result["scene_header_status"] == "standard"
    assert result["issues"] == []


def test_numbered_bracketed_scene_header_is_standard():
    text = """
第一集
1 场景：【夜 皇宫豹房露台 外】
人物：正德帝、随行太监
△ 乾清宫方向烈焰冲天。
正德帝：好一棚大烟火也。
"""

    result = build_import_format_check(
        text,
        has_chapters=True,
        require_scene_headers=True,
    )

    assert result["level"] == "ok"
    assert result["scene_header_status"] == "standard"
    assert result["issues"] == []


@pytest.mark.parametrize(
    "header",
    [
        "1.1 李家客厅 内 日",
        "1-1 李家客厅 日 内",
        "内景 李家客厅 - 夜",
        "INT. LI FAMILY LIVING ROOM - NIGHT",
        "+场 李家客厅 内 日",
    ],
)
def test_supported_scene_header_dialects_are_standard(header):
    text = f"""
第一集
{header}
人物：李梅、王芳
李梅：我回来了。
"""

    result = build_import_format_check(
        text,
        has_chapters=True,
        require_scene_headers=True,
    )

    assert result["scene_header_status"] == "standard"
    assert result["level"] == "ok"
    assert result["issues"] == []


def test_recognizable_scene_header_with_missing_time_warns_but_does_not_block():
    result = build_import_format_check(
        "第一集\n1.1 李家客厅 内\n人物：李梅\n李梅：我回来了。",
        has_chapters=True,
        require_scene_headers=True,
    )

    assert result["scene_header_status"] == "repairable"
    assert result["level"] == "warning"
    assert "nonstandard_scene_headers" in _codes(result)
    assert "scene_headers_missing_time" in _codes(result)
    issue = _issue(result, "scene_headers_missing_time")
    assert issue["line"] == 2
    assert issue["message"] == "场景头“1.1 李家客厅 内”缺少时间。"
    assert "1.1 李家客厅 内 [日/夜]" in issue["fix"]


def test_incomplete_scene_headers_identify_each_source_line_and_missing_field():
    result = build_import_format_check(
        """第一集
1.1 郑家客厅 内 日
人物：郑玉琴、刘管家
郑玉琴：你来了。
11.2 学校实验室
人物：小雨
小雨：实验成功了。
+场 舞蹈室照镜子 日
人物：小雨
小雨：再练一次。
""",
        has_chapters=True,
        require_scene_headers=True,
    )

    incomplete = _issue(result, "incomplete_scene_header")
    missing_interior = _issue(result, "missing_interior_exterior")
    assert (incomplete["line"], incomplete["message"]) == (
        5,
        "场景头“11.2 学校实验室”缺少时间、内/外。",
    )
    assert (missing_interior["line"], missing_interior["message"]) == (
        8,
        "场景头“+场 舞蹈室照镜子 日”缺少内/外。",
    )
    assert "11.2 学校实验室 [日/夜] [内/外]" in incomplete["fix"]
    assert "+场 舞蹈室照镜子 日 [内/外]" in missing_interior["fix"]


def test_parenthetical_dialogue_directions_do_not_warn():
    dialogue = "\n".join(
        f"角色{i % 2}（轻笑，语气平静）：这是第{i + 1}句对白。"
        for i in range(8)
    )
    text = f"""
第一集
1 场景：【夜 皇宫豹房露台 外】
人物：角色0、角色1
{dialogue}
"""

    result = build_import_format_check(
        text,
        has_chapters=True,
        require_scene_headers=True,
    )

    assert result["level"] == "ok"
    assert "heavy_parenthetical_dialogue" not in _codes(result)


def test_complete_multiline_scene_headers_are_supported():
    text = """
场次（1）
地点：兰州拉面馆，夜，内
人物：杜晨
杜晨：老板，结账。
"""

    result = build_import_format_check(text, has_chapters=True)

    assert result["scene_header_status"] == "standard"
    assert result["level"] == "ok"
    assert result["issues"] == []


def test_no_chapters_is_blocking():
    result = build_import_format_check("没有可识别章节", has_chapters=False)

    assert result["level"] == "blocking"
    assert "未检测到有效章节" in result["summary"]


def test_duplicate_chapter_numbers_warn():
    result = build_import_format_check(
        "第一集\n正文\n第一集 已经结束。\n第二集\n正文",
        has_chapters=True,
        chapters=[
            {"number": 1, "title": "第一集", "start_line": 0},
            {"number": 1, "title": "第一集 已经结束。", "start_line": 2},
            {"number": 2, "title": "第二集", "start_line": 3},
        ],
    )

    assert result["level"] == "warning"
    assert "duplicate_chapter_number" in _codes(result)
    assert "non_increasing_chapter_number" in _codes(result)
    assert _issue(result, "duplicate_chapter_number")["line"] == 3


def test_missing_interior_exterior_suppresses_legacy_missing_time():
    result = build_import_format_check("地点：人类城池，日\n", has_chapters=True)

    assert "missing_interior_exterior" in _codes(result)
    assert "scene_headers_missing_time" not in _codes(result)


def test_sparse_scene_headers_only_for_long_scripts():
    long_text = f"""
1-1、上海老城·封门旧址 深夜 外
人物：鲁鸢、神秘人
{_dialogue_lines(24)}
"""
    short_text = f"""
1-1、上海老城·封门旧址 深夜 外
人物：鲁鸢、神秘人
{_dialogue_lines(12)}
"""

    long_result = build_import_format_check(long_text, has_chapters=True)
    short_result = build_import_format_check(short_text, has_chapters=True)

    assert "sparse_scene_headers" in _codes(long_result)
    assert "sparse_scene_headers" not in _codes(short_result)


def test_incomplete_split_field_scene_header_warns_without_blocking():
    result = build_import_format_check(
        "梗概\n这是故事。\n场次：1\n地点：人类城池\n",
        has_chapters=True,
        require_scene_headers=True,
    )

    assert result["level"] == "warning"
    assert result["scene_header_status"] == "repairable"
    assert "nonstandard_scene_headers" in _codes(result)


def test_time_detection_requires_delimiters():
    split_result = build_import_format_check(
        "地点：夜市\n时间：日\n角色：甲\n甲：到了。\n",
        has_chapters=True,
    )
    false_time_result = build_import_format_check(
        "1-1、日月湾 内\n甲：到了。\n",
        has_chapters=True,
    )

    assert split_result["scene_header_status"] == "repairable"
    assert "nonstandard_scene_headers" in _codes(split_result)
    assert "missing_interior_exterior" not in _codes(false_time_result)


def _legacy_resolution(project_dir):
    return SimpleNamespace(
        ctx=None,
        username="admin",
        project_name="demo",
        project_dir=project_dir,
        output_dir=str(project_dir / "output"),
        state_dir=str(project_dir / "state"),
        runtime_dir=str(project_dir / "runtime"),
    )


def _project_scope_resolver(project_dir):
    async def resolve(*args, **kwargs):
        return _legacy_resolution(project_dir)

    return resolve


@pytest.mark.asyncio
async def test_upload_success_includes_format_check_in_data(tmp_path, monkeypatch):
    from novelvideo.api.routes import ingest

    monkeypatch.setattr(ingest, "resolve_project_scope", _project_scope_resolver(tmp_path))
    text = "第一章 开始\n场次：1\n地点：人类城池\n时间：日\n角色：甲\n甲：到了。"
    raw = text.encode("utf-8")
    upload = UploadFile(file=io.BytesIO(raw), filename="script.txt")

    response = await ingest.upload_novel(project="demo", file=upload, user={"username": "admin"})

    assert response["ok"] is True
    assert response["data"]["format_check"]["level"] == "warning"
    assert _codes(response["data"]["format_check"]) == {
        "nonstandard_scene_headers",
        "missing_interior_exterior",
    }
    assert "format_check" not in response


@pytest.mark.asyncio
async def test_upload_empty_preview_includes_blocking_format_check_at_top_level(tmp_path, monkeypatch):
    from novelvideo.api.routes import ingest

    monkeypatch.setattr(ingest, "resolve_project_scope", _project_scope_resolver(tmp_path))
    upload = UploadFile(file=io.BytesIO(b""), filename="empty.txt")

    response = await ingest.upload_novel(project="demo", file=upload, user={"username": "admin"})

    assert response["ok"] is False
    assert response["format_check"]["level"] == "blocking"
    assert "format_check" not in response.get("data", {})
