"""`scripts/check_frontend_i18n.py` 的豁免区间标记校验。

review #447：扫描器遇到 `i18n-exempt-start` 后不校验是否闭合，漏写 `-end` 会让
该文件其后所有中文静默跳过，检查仍以 0 命中通过——棘轮静默失效。
"""
from __future__ import annotations

import importlib.util
import os
from pathlib import Path

import pytest

pytestmark = pytest.mark.m07

REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPT = REPO_ROOT / "scripts" / "check_frontend_i18n.py"


def _load_scanner():
    spec = importlib.util.spec_from_file_location("check_frontend_i18n", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def _run_scan_in(tmp_path: Path, source: str):
    """在临时目录里造一个 frontend/src 树再扫——扫描器读的是相对路径。"""
    src = tmp_path / "frontend" / "src"
    src.mkdir(parents=True)
    (src / "sample.ts").write_text(source, encoding="utf-8")
    module = _load_scanner()
    cwd = os.getcwd()
    os.chdir(tmp_path)
    try:
        return module.scan()
    finally:
        os.chdir(cwd)


def test_unclosed_exempt_block_is_reported(tmp_path):
    hits, errors = _run_scan_in(
        tmp_path,
        'const a = "x";\n'
        "// i18n-exempt-start\n"
        'const table = { 日: "day" };\n'
        'const leaked = "这行是真的硬编码文案";\n',
    )
    # 未闭合时后面的中文确实被跳过了（这正是危险所在）……
    assert hits == {}
    # ……所以必须由标记校验来兜住。
    assert len(errors) == 1
    assert "i18n-exempt-start" in errors[0]
    assert "sample.ts:2" in errors[0]


def test_stray_exempt_end_is_reported(tmp_path):
    _, errors = _run_scan_in(tmp_path, 'const a = "x";\n// i18n-exempt-end\n')
    assert len(errors) == 1
    assert "没有对应的 i18n-exempt-start" in errors[0]


def test_nested_exempt_start_is_reported(tmp_path):
    _, errors = _run_scan_in(
        tmp_path,
        "// i18n-exempt-start\n// i18n-exempt-start\n// i18n-exempt-end\n",
    )
    assert any("嵌套" in e for e in errors)


def test_balanced_exempt_block_is_clean(tmp_path):
    hits, errors = _run_scan_in(
        tmp_path,
        "// i18n-exempt-start\n"
        'const table = { 日: "day" };\n'
        "// i18n-exempt-end\n"
        'const leaked = "这行要被抓到";\n',
    )
    assert errors == []
    assert [lineno for lineno, _ in hits["frontend/src/sample.ts"]] == [4]


def test_marker_error_fails_the_check_even_with_write(tmp_path, capsys):
    """标记破损时连 `--write` 都不能通过：否则会把「少报后的计数」固化进 allowlist。"""
    src = tmp_path / "frontend" / "src"
    src.mkdir(parents=True)
    (src / "sample.ts").write_text("// i18n-exempt-start\n", encoding="utf-8")
    module = _load_scanner()
    cwd = os.getcwd()
    os.chdir(tmp_path)
    try:
        assert module.main([]) == 1
        assert module.main(["--write"]) == 1
        assert not (tmp_path / "scripts" / "frontend_i18n_allowlist.json").exists()
    finally:
        os.chdir(cwd)
