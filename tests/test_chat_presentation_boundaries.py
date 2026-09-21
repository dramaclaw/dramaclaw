"""Keep chat display transforms separate from runtime and storage."""

import ast
from pathlib import Path

from novelvideo.chat import (
    display_fallback,
    media_presentation,
    presentation_mapping,
    presentation_text,
)


def test_presentation_modules_do_not_import_application_or_runtime() -> None:
    modules = (
        presentation_text,
        presentation_mapping,
        media_presentation,
        display_fallback,
    )
    forbidden = (
        "novelvideo.chat.service",
        "novelvideo.chat.backend_sdk",
        "novelvideo.chat.session_registry",
        "novelvideo.chat.store",
        "novelvideo.api",
    )
    for module in modules:
        tree = ast.parse(Path(module.__file__).read_text(encoding="utf-8"))
        imports = [
            node
            for node in ast.walk(tree)
            if isinstance(node, (ast.Import, ast.ImportFrom))
        ]
        names = [
            name
            for node in imports
            for name in (
                [node.module or ""]
                if isinstance(node, ast.ImportFrom)
                else [alias.name for alias in node.names]
            )
        ]
        assert not any(name.startswith(forbidden) for name in names), module.__name__


def test_ui_mapping_reports_invalid_spec_through_injected_logger() -> None:
    errors: list[tuple[str, str]] = []
    result = presentation_mapping._normalize_json_render_reply(
        '<ui-spec type="broken">{"type":"broken"}</ui-spec>',
        log_error=lambda error, body: errors.append((str(error), body)),
    )
    assert "格式校验失败" in result
    assert len(errors) == 1
    assert errors[0][1] == '{"type":"broken"}'
