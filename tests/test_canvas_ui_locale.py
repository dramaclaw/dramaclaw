"""Project canvas UI language persistence."""

import importlib
import json
import os
from pathlib import Path

import pytest


@pytest.fixture
def locales():
    return importlib.import_module("novelvideo.freezone.canvas_ui_locale")


@pytest.mark.parametrize(
    "value,expected",
    [
        ("en", "en"),
        ("pt-BR", "pt-BR"),
        ("zh_CN", "zh_CN"),
        ("  en  ", "en"),
        ("en-12345678-12345678-12345678-12345", "en-12345678-12345678-12345678-12345"),
        ("", None),
        ("e", None),
        ("en us", None),
        ("../x", None),
        ("en-12345678-12345678-12345678-123456", None),
        ("engl", None),
        ("en-123456789", None),
        ("en-", None),
        ("中文", None),
        (None, None),
        (123, None),
        (True, None),
        ([], None),
        ({"locale": "en"}, None),
    ],
)
def test_valid_ui_locale_literal_cases(locales, value, expected):
    assert locales.valid_ui_locale(value) == expected


def test_missing_locale_file_returns_none(locales, tmp_path):
    assert locales.recorded_ui_locale(tmp_path) is None


def test_record_then_read_locale(locales, tmp_path):
    locales.record_ui_locale(tmp_path, " en ")
    path = tmp_path / "freezone" / "ui_locale.json"
    assert json.loads(path.read_text()) == {"locale": "en"}
    assert locales.recorded_ui_locale(tmp_path) == "en"
    assert list(path.parent.iterdir()) == [path]


def test_last_writer_wins(locales, tmp_path):
    locales.record_ui_locale(tmp_path, "en")
    locales.record_ui_locale(tmp_path, "pt-BR")
    assert locales.recorded_ui_locale(tmp_path) == "pt-BR"


def test_invalid_locale_does_not_overwrite(locales, tmp_path, caplog):
    locales.record_ui_locale(tmp_path, "en")
    locales.record_ui_locale(tmp_path, "../x")
    assert locales.recorded_ui_locale(tmp_path) == "en"
    assert not caplog.records


@pytest.mark.parametrize(
    "contents",
    ["{broken", "[]", "null", '{"locale": "../x"}', '{"locale": 1}', "{}"],
)
def test_corrupt_or_invalid_locale_file_returns_none(locales, tmp_path, contents):
    path = tmp_path / "freezone" / "ui_locale.json"
    path.parent.mkdir()
    path.write_text(contents)
    assert locales.recorded_ui_locale(tmp_path) is None


def test_unreadable_locale_file_returns_none(locales, tmp_path, monkeypatch):
    def unreadable(*args, **kwargs):
        raise PermissionError("private-path")

    monkeypatch.setattr(Path, "read_text", unreadable)
    assert locales.recorded_ui_locale(tmp_path) is None


def test_unchanged_locale_preserves_mtime(locales, tmp_path):
    locales.record_ui_locale(tmp_path, "en")
    path = tmp_path / "freezone" / "ui_locale.json"
    os.utime(path, ns=(1_000_000_000, 1_000_000_000))
    before = path.stat().st_mtime_ns
    locales.record_ui_locale(tmp_path, "en")
    assert path.stat().st_mtime_ns == before


def test_failed_atomic_replace_preserves_locale_and_logs_only_class(
    locales, tmp_path, monkeypatch, caplog,
):
    locales.record_ui_locale(tmp_path, "en")

    def failed_replace(source, destination):
        assert Path(source).parent == Path(destination).parent
        assert json.loads(Path(source).read_text()) == {"locale": "vi"}
        raise OSError("private-path")

    monkeypatch.setattr(locales.os, "replace", failed_replace)
    locales.record_ui_locale(tmp_path, "vi")
    assert locales.recorded_ui_locale(tmp_path) == "en"
    assert [record.getMessage() for record in caplog.records] == [
        "Canvas UI locale not recorded (OSError)"
    ]
    assert list((tmp_path / "freezone").iterdir()) == [
        tmp_path / "freezone" / "ui_locale.json"
    ]
