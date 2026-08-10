# SPDX-License-Identifier: Elastic-2.0
# Copyright (c) 2026 ClaymoreLab
"""风格清单加载器:外部覆盖、坏清单兜底、原地替换后的缓存失效。"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from novelvideo.freezone import style_templates as manifest


@pytest.fixture(autouse=True)
def _clean_manifest_cache(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv(manifest.MANIFEST_ENV, raising=False)
    manifest.reset_style_template_cache()
    yield
    manifest.reset_style_template_cache()


def _write_manifest(path: Path, templates: list[dict], version: str = "test-1") -> Path:
    path.write_text(
        json.dumps({"version": version, "templates": templates}, ensure_ascii=False),
        encoding="utf-8",
    )
    return path


def _builtin_ids() -> list[str]:
    """直接从内置清单文件读 id 列表。

    「回落到内置清单」的断言原本写死 24,每加一批风格就要改三处数字,而它想表达的
    其实是「拿到的就是内置那份」。改成比对 id 列表:既不随风格数漂移,又比数量更严。
    """
    shipped = json.loads(manifest.BUILTIN_MANIFEST_PATH.read_text(encoding="utf-8"))
    return [item["id"] for item in shipped["templates"]]


def _template(template_id: str = "demo") -> dict:
    return {
        "id": template_id,
        "label": "示例风格",
        "category": "都市",
        "cover": f"{template_id}/cover.webp",
        "samples": [f"{template_id}/female.webp"],
        "style_prompt": "示例提示词",
    }


def test_builtin_manifest_ships_with_the_package() -> None:
    assert manifest.BUILTIN_MANIFEST_PATH.is_file()
    # 加载器读出来的必须和文件里那份一字不差 —— 校验环节把不合规的条目丢掉时,
    # 这里就会少几条。数量另设下限,防止清单被截断成空壳还悄悄通过。
    assert [item["id"] for item in manifest.load_style_templates()] == _builtin_ids()
    assert len(_builtin_ids()) >= 24
    assert manifest.get_style_manifest_version()


def test_env_override_replaces_the_builtin_manifest(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = _write_manifest(tmp_path / "styles.json", [_template()])
    monkeypatch.setenv(manifest.MANIFEST_ENV, str(path))
    manifest.reset_style_template_cache()

    assert [item["id"] for item in manifest.load_style_templates()] == ["demo"]
    assert manifest.get_style_manifest_version() == "test-1"


def test_missing_override_falls_back_to_the_builtin_manifest(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv(manifest.MANIFEST_ENV, str(tmp_path / "nope.json"))
    manifest.reset_style_template_cache()

    assert [item["id"] for item in manifest.load_style_templates()] == _builtin_ids()


@pytest.mark.parametrize(
    "payload",
    [
        "{ not json",
        json.dumps({"templates": []}),
        json.dumps({"templates": [{"id": "a", "label": "甲"}]}),
        json.dumps({"templates": [{**_template("a"), "samples": [""]}]}),
        json.dumps({"templates": [_template("a"), _template("a")]}),
    ],
)
def test_broken_override_falls_back_instead_of_raising(
    payload: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "styles.json"
    path.write_text(payload, encoding="utf-8")
    monkeypatch.setenv(manifest.MANIFEST_ENV, str(path))
    manifest.reset_style_template_cache()

    assert [item["id"] for item in manifest.load_style_templates()] == _builtin_ids()


def test_bare_array_manifest_is_accepted(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "styles.json"
    path.write_text(json.dumps([_template()], ensure_ascii=False), encoding="utf-8")
    monkeypatch.setenv(manifest.MANIFEST_ENV, str(path))
    manifest.reset_style_template_cache()

    assert [item["id"] for item in manifest.load_style_templates()] == ["demo"]
    assert manifest.get_style_manifest_version() == ""


def test_replacing_the_file_in_place_takes_effect(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """运维覆盖清单文件后不必重启进程 —— 缓存按 mtime/size 失效。"""
    path = _write_manifest(tmp_path / "styles.json", [_template("before")])
    monkeypatch.setenv(manifest.MANIFEST_ENV, str(path))
    manifest.reset_style_template_cache()
    assert [item["id"] for item in manifest.load_style_templates()] == ["before"]

    _write_manifest(path, [_template("after"), _template("extra")], version="test-2")

    assert [item["id"] for item in manifest.load_style_templates()] == [
        "after",
        "extra",
    ]
    assert manifest.get_style_manifest_version() == "test-2"


def test_samples_default_to_empty_when_absent(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    entry = _template()
    entry.pop("samples")
    path = _write_manifest(tmp_path / "styles.json", [entry])
    monkeypatch.setenv(manifest.MANIFEST_ENV, str(path))
    manifest.reset_style_template_cache()

    assert manifest.load_style_templates()[0]["samples"] == []


def test_loaded_templates_are_not_shared_by_reference(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """调用方拿到的列表可以随便改,别污染下一次请求。"""
    path = _write_manifest(tmp_path / "styles.json", [_template()])
    monkeypatch.setenv(manifest.MANIFEST_ENV, str(path))
    manifest.reset_style_template_cache()

    first = manifest.load_style_templates()
    first.clear()

    assert len(manifest.load_style_templates()) == 1
