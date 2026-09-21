"""项目下拉框的纯逻辑：解析 `/blender/projects`、刷新后该选中哪个。"""

from __future__ import annotations

from dramaclaw_blender.core.projects import parse_projects, reconcile_selection


def test_parse_keeps_id_and_name_pairs_in_order():
    payload = {
        "projects": [
            {"id": "01JA", "name": "demo"},
            {"id": "01JB", "name": "另一个"},
        ]
    }

    assert parse_projects(payload) == [("01JA", "demo"), ("01JB", "另一个")]


def test_parse_skips_entries_without_an_id():
    """没有 id 的条目选了也投不进去——投递地址拼的就是 id。

    旧后端返回的是一串目录名（`["demo"]`），也归这一类：跳过它，下拉框是空的、
    面板提示刷新，总好过选中一个名字、投递时吃 `Project not found`。
    """
    payload = {
        "projects": [
            "demo",
            {"name": "no-id"},
            {"id": "", "name": "blank-id"},
            {"id": 42, "name": "not-a-string"},
            {"id": "01JA", "name": "demo"},
        ]
    }

    assert parse_projects(payload) == [("01JA", "demo")]


def test_parse_falls_back_to_id_when_name_is_missing():
    assert parse_projects({"projects": [{"id": "01JA"}]}) == [("01JA", "01JA")]


def test_parse_tolerates_garbage_payloads():
    assert parse_projects({}) == []
    assert parse_projects({"projects": None}) == []
    assert parse_projects([]) == []


def test_reconcile_keeps_the_current_pick_and_refreshes_its_name():
    projects = [("01JA", "demo"), ("01JB", "renamed")]

    # 项目改名了：id 不变，面板上的名字跟着变。
    assert reconcile_selection("01JB", projects) == ("01JB", "renamed")


def test_reconcile_replaces_a_stale_pick_with_the_first_project():
    """之前选的没了（删了、被撤权、换了账号），或者是老版本存下的项目名。"""
    projects = [("01JA", "demo"), ("01JB", "other")]

    assert reconcile_selection("demo", projects) == ("01JA", "demo")
    assert reconcile_selection("", projects) == ("01JA", "demo")


def test_reconcile_clears_the_pick_when_there_is_nothing_to_choose():
    assert reconcile_selection("01JA", []) == ("", "")
