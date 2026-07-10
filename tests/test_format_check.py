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


def test_bad_colon_scene_marker_and_split_location_time_warn_with_fixes():
    result = build_import_format_check(
        "场次：1\n地点：人类城池\n时间：日\n",
        has_chapters=True,
    )

    assert result["level"] == "warning"
    assert _codes(result) >= {"scene_marker_colon_number", "split_location_time"}
    assert all(issue["fix"] for issue in result["issues"])


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


def test_scene_marker_colon_number_reports_real_line_number():
    result = build_import_format_check("梗概\n这是故事。\n场次：1\n地点：人类城池\n", has_chapters=True)

    assert _issue(result, "scene_marker_colon_number")["line"] == 3


def test_time_detection_requires_delimiters():
    split_result = build_import_format_check(
        "地点：夜市\n时间：日\n角色：甲\n甲：到了。\n",
        has_chapters=True,
    )
    false_time_result = build_import_format_check(
        "1-1、日月湾 内\n甲：到了。\n",
        has_chapters=True,
    )

    assert "split_location_time" in _codes(split_result)
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
    assert _codes(response["data"]["format_check"]) >= {
        "scene_marker_colon_number",
        "split_location_time",
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
