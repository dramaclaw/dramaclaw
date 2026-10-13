"""Characterize the presentation boundary and its legacy application entrypoints."""

import ast
import copy
import json
from pathlib import Path

import pytest

from novelvideo.chat import presentation, service


def _spec(spec_type="character_showcase", label="first"):
    return {
        "type": spec_type,
        "root": "root",
        "elements": {
            "root": {"type": "Stack", "children": ["label"]},
            "label": {"type": "Text", "props": {"children": label}},
        },
    }


@pytest.mark.parametrize(
    "canonicalize", [presentation.canonicalize_ui_spec, service._canonicalize_ui_spec]
)
def test_canonicalization_preserves_input_and_legacy_props(canonicalize):
    spec = _spec()
    before = copy.deepcopy(spec)
    result = canonicalize(spec)
    assert result["elements"]["label"] == {
        "type": "Text",
        "props": {"content": "first"},
        "children": [],
    }
    assert result["elements"]["root"]["props"] == {}
    assert spec == before


@pytest.mark.parametrize(
    "parse",
    [
        presentation.json_loads_with_trailing_repair,
        service._json_loads_with_trailing_repair,
    ],
)
@pytest.mark.parametrize("suffix", ["", "\nmodel commentary"])
def test_json_repair_and_trailing_commentary(parse, suffix):
    assert parse('prefix {"text": "brace } and escaped \\" quote"}' + suffix) == {
        "text": 'brace } and escaped " quote'
    }
    assert parse('{"elements": {"root": []') == {"elements": {"root": []}}


@pytest.mark.parametrize(
    "canonicalize", [presentation.canonicalize_ui_spec, service._canonicalize_ui_spec]
)
def test_missing_child_is_rejected(canonicalize):
    spec = _spec()
    spec["elements"]["root"]["children"] = ["missing"]
    with pytest.raises(ValueError, match="references missing child missing"):
        canonicalize(spec)


def test_bundle_split_roundtrip_preserves_categories_and_order():
    specs = [_spec("sketch_gallery"), _spec("character_showcase", "second")]
    block = presentation.wrap_ui_spec_bundle(specs)
    errors = []
    text, restored = presentation.split_ui_specs_from_text(
        f"Before\n\n```json-render\n{block}\n```\n\nAfter",
        log_error=lambda *args: errors.append(args),
    )
    assert text == "Before\n\nAfter"
    assert restored == [presentation.canonicalize_ui_spec(spec) for spec in specs]
    assert errors == []
    assert service._wrap_ui_spec_bundle(specs) == block
    assert service._split_ui_specs_from_text(block) == ("", restored)


def test_split_invalid_block_logs_through_application_callback(monkeypatch):
    body = '{"type": "invalid"}'
    content = f'<ui-spec type="invalid">{body}</ui-spec>'
    direct_errors = []
    expected = presentation.split_ui_specs_from_text(
        content, log_error=lambda *args: direct_errors.append(args)
    )
    app_errors = []
    monkeypatch.setattr(
        service, "_log_json_render_error", lambda *args: app_errors.append(args)
    )
    assert service._split_ui_specs_from_text(content) == expected
    assert expected[1] == []
    assert "格式校验失败" in expected[0]
    assert str(direct_errors[0][0]) == str(app_errors[0][0])
    assert direct_errors[0][1] == app_errors[0][1] == body


def test_merge_retains_collision_and_category_behavior():
    first, second = _spec(label="first"), _spec(label="second")
    before = copy.deepcopy([first, second])
    expected = presentation.merge_ui_specs(first, second)
    assert expected["elements"]["root"]["children"] == ["label", "label_2"]
    assert expected["elements"]["label_2"]["props"]["content"] == "second"
    assert [first, second] == before
    specs = [first, second, _spec("sketch_gallery")]
    assert service._merge_tool_ui_specs_by_type(
        specs
    ) == presentation.merge_tool_ui_specs_by_type(
        specs, log_error=lambda *_: pytest.fail("unexpected malformed spec")
    )
    assert service._dedupe_tool_ui_specs([first, first, second]) == [first, second]


def test_merge_invalid_spec_keeps_original_and_logs(monkeypatch):
    first, second = _spec(), _spec(label="second")
    second["elements"]["root"]["children"] = ["missing"]
    errors = []
    monkeypatch.setattr(
        service, "_log_json_render_error", lambda *args: errors.append(args)
    )
    assert service._merge_tool_ui_specs_by_type([first, second]) == [first, second]
    assert len(errors) == 1
    assert json.loads(errors[0][1]) == second


def test_presentation_has_only_stdlib_dependencies():
    tree = ast.parse(Path(presentation.__file__).read_text())
    allowed = {"__future__", "json", "re", "collections", "typing"}
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            assert all(alias.name.split(".")[0] in allowed for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            assert node.level == 0
            assert node.module.split(".")[0] in allowed
