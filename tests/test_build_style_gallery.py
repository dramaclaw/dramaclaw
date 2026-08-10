from __future__ import annotations

import importlib.util
import json
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
_SPEC = importlib.util.spec_from_file_location(
    "build_style_gallery", REPO_ROOT / "scripts" / "build_style_gallery.py"
)
assert _SPEC and _SPEC.loader
build_style_gallery = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(build_style_gallery)


def test_clean_style_prompt_strips_dangling_trailing_punctuation() -> None:
    raw = "  日式生活流治愈影像，氛围平缓治愈，影视专业标准，  "

    assert (
        build_style_gallery.clean_style_prompt(raw)
        == "日式生活流治愈影像，氛围平缓治愈，影视专业标准"
    )


def test_clean_style_prompt_keeps_internal_line_breaks() -> None:
    raw = "90年代新写实主义电影，纯胶片质感\n\n构图平实自然，年代感准确\n"

    assert build_style_gallery.clean_style_prompt(raw) == (
        "90年代新写实主义电影，纯胶片质感\n构图平实自然，年代感准确"
    )


def test_clean_style_prompt_keeps_sentence_ending_period() -> None:
    raw = "权力博弈的宿命感，高级电影质感。"

    assert build_style_gallery.clean_style_prompt(raw) == "权力博弈的宿命感，高级电影质感。"


def test_style_meta_covers_all_styles_with_unique_ids() -> None:
    meta = build_style_gallery.STYLE_META

    assert len(meta) == 24
    assert len({item["id"] for item in meta}) == 24
    assert len({item["src"] for item in meta}) == 24
    assert {item["category"] for item in meta} == {
        "古装", "都市", "年代", "生活", "科幻", "类型", "写意",
    }


def test_style_meta_order_groups_categories() -> None:
    categories = [item["category"] for item in build_style_gallery.STYLE_META]

    assert categories == [
        "古装", "古装", "古装",
        "都市", "都市", "都市", "都市",
        "年代", "年代", "年代", "年代", "年代", "年代", "年代",
        "生活", "生活",
        "科幻", "科幻",
        "类型", "类型", "类型", "类型",
        "写意", "写意",
    ]


def test_style_meta_ids_are_ascii_snake_case() -> None:
    import re

    for item in build_style_gallery.STYLE_META:
        assert re.fullmatch(r"[a-z][a-z0-9_]*", item["id"]), item["id"]


def test_render_manifest_matches_the_loader_format() -> None:
    entries = [
        {
            "id": "demo",
            "label": "示例",
            "category": "都市",
            "cover": "demo/cover.webp",
            "samples": ["demo/female.webp"],
            "style_prompt": "示例提示词",
        }
    ]

    text = build_style_gallery.render_manifest(entries, "2026-08-07")
    parsed = json.loads(text)

    assert text.endswith("\n")
    assert "示例" in text, "中文不该被转成 \\uXXXX"
    assert parsed == {"version": "2026-08-07", "templates": entries}


def test_shipped_manifest_matches_style_meta() -> None:
    """脚本的 STYLE_META 与仓库里那份内置清单必须同步,否则重跑脚本会悄悄换掉风格库。"""
    shipped = json.loads(
        (
            REPO_ROOT / "src" / "novelvideo" / "freezone" / "style_templates.json"
        ).read_text(encoding="utf-8")
    )

    assert [item["id"] for item in shipped["templates"]] == [
        item["id"] for item in build_style_gallery.STYLE_META
    ]
    assert [item["label"] for item in shipped["templates"]] == [
        item["src"] for item in build_style_gallery.STYLE_META
    ]
    assert [item["category"] for item in shipped["templates"]] == [
        item["category"] for item in build_style_gallery.STYLE_META
    ]


def _make_style_dir(root: Path, cover_name: str) -> Path:
    style_dir = root / "某风格"
    style_dir.mkdir()
    for name in ("女.png", "少.png", "男.png", "老.png", cover_name):
        (style_dir / name).write_bytes(b"")
    return style_dir


def test_locate_cover_prefers_the_file_named_after_the_style(tmp_path: Path) -> None:
    style_dir = _make_style_dir(tmp_path, "某风格.png")

    assert build_style_gallery.locate_cover(style_dir, "某风格").name == "某风格.png"


def test_locate_cover_falls_back_to_the_only_non_sample_png(tmp_path: Path) -> None:
    """飞书导出里 纪实写实 的封面被误命名为 复古叙事.png,按剩下那张唯一的 PNG 取。"""
    style_dir = _make_style_dir(tmp_path, "复古叙事.png")

    assert build_style_gallery.locate_cover(style_dir, "某风格").name == "复古叙事.png"


def test_locate_cover_refuses_to_guess_between_several_candidates(
    tmp_path: Path,
) -> None:
    import pytest

    style_dir = _make_style_dir(tmp_path, "甲.png")
    (style_dir / "乙.png").write_bytes(b"")

    with pytest.raises(SystemExit):
        build_style_gallery.locate_cover(style_dir, "某风格")
