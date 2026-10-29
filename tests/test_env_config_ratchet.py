from __future__ import annotations

import importlib.util
import os
import sys
from pathlib import Path

from dotenv import dotenv_values

REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPT_PATH = REPO_ROOT / "scripts" / "check_env_config.py"


def _load_module():
    spec = importlib.util.spec_from_file_location("check_env_config", SCRIPT_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def test_local_ce_example_enables_openfilm_studio() -> None:
    values = dotenv_values(REPO_ROOT / ".env.example")

    assert values["SUPERTALE_OPENFILM_STUDIO_ENABLED"] == "1"


def test_three_state_matrix_and_edition_boundary(tmp_path: Path) -> None:
    check_env_config = _load_module()
    ce_root = tmp_path / "dramaclaw-ce"
    supertale_root = tmp_path / "SuperTale2"

    _write(
        ce_root / ".env.example",
        "\n".join(
            [
                "DRAMACLAW_SCRIPT_KEY=1",
                "ST_PROJECT_MAX_ACTIVE_VIDEO_TASKS=4",
                "ST_SMOKE_EE_USERNAME=",
                "FOO_UNUSED_TEST=1",
                "",
            ]
        ),
    )
    _write(
        ce_root / "src" / "novelvideo" / "task_backend" / "limits.py",
        'env_name = f"ST_PROJECT_MAX_ACTIVE_{lane.upper()}_TASKS"\n',
    )
    _write(ce_root / "scripts" / "ce_smoke.sh", ': "${DRAMACLAW_SCRIPT_KEY:=ok}"\n')

    _write(
        supertale_root / ".env.example",
        "\n".join(
            [
                "ST_SMOKE_EE_USERNAME=",
                "CE_PACKAGE_KEY=1",
                "FOO_UNUSED_TEST=1",
                "",
            ]
        ),
    )
    _write(supertale_root / ".env.control-plane.example", "ST_CONTROL_PLANE_DSN=\n")
    _write(
        supertale_root / "scripts" / "dev" / "smoke_ee.sh",
        ': "${ST_SMOKE_EE_USERNAME:?required}"\n',
    )
    _write(
        supertale_root / "src" / "novelvideo_ee" / "config.py",
        'import os\nDSN = os.environ.get("ST_CONTROL_PLANE_DSN")\n',
    )
    _write(
        ce_root / "src" / "novelvideo" / "config.py",
        'import os\nCE_PACKAGE_KEY = os.environ.get("CE_PACKAGE_KEY")\n',
    )

    ce_report = check_env_config.analyze_ce_repo(ce_root)
    assert "DRAMACLAW_SCRIPT_KEY" not in ce_report.dead_keys
    assert "ST_PROJECT_MAX_ACTIVE_VIDEO_TASKS" not in ce_report.dead_keys
    assert "ST_SMOKE_EE_USERNAME" in ce_report.dead_keys
    assert "FOO_UNUSED_TEST" in ce_report.dead_keys

    supertale_report = check_env_config.analyze_supertale_repo(supertale_root, ce_root)
    assert "ST_SMOKE_EE_USERNAME" not in supertale_report.dead_keys
    assert "CE_PACKAGE_KEY" not in supertale_report.dead_keys
    assert "ST_CONTROL_PLANE_DSN" not in supertale_report.dead_keys
    assert "FOO_UNUSED_TEST" in supertale_report.dead_keys


def test_plain_strings_do_not_count_as_env_reads(tmp_path: Path) -> None:
    check_env_config = _load_module()
    root = tmp_path / "repo"

    _write(
        root / ".env.example",
        "\n".join(
            [
                "PY_HELP_TEXT_ONLY=1",
                "PY_DOCSTRING_ONLY=1",
                "PY_OS_GETENV=1",
                "PY_OS_ENVIRON_GET=1",
                "PY_OS_ENVIRON_INDEX=1",
                "PY_OS_ENVIRON_SETDEFAULT=1",
                "SH_HELP_TEXT_ONLY=1",
                "SH_DOLLAR_REF=1",
                "SH_BRACE_REF=1",
                "",
            ]
        ),
    )
    _write(
        root / "src" / "novelvideo" / "config.py",
        "\n".join(
            [
                "import os",
                'HELP_TEXT = "PY_HELP_TEXT_ONLY"',
                '"""PY_DOCSTRING_ONLY"""',
                'A = os.getenv("PY_OS_GETENV")',
                'B = os.environ.get("PY_OS_ENVIRON_GET")',
                'C = os.environ["PY_OS_ENVIRON_INDEX"]',
                'D = os.environ.setdefault("PY_OS_ENVIRON_SETDEFAULT", "fallback")',
                "",
            ]
        ),
    )
    _write(
        root / "scripts" / "smoke.sh",
        "\n".join(
            [
                'echo "SH_HELP_TEXT_ONLY"',
                'echo "$SH_DOLLAR_REF"',
                'echo "${SH_BRACE_REF:-fallback}"',
                "",
            ]
        ),
    )

    report = check_env_config.analyze_ce_repo(root)

    assert "PY_HELP_TEXT_ONLY" in report.dead_keys
    assert "PY_DOCSTRING_ONLY" in report.dead_keys
    assert "SH_HELP_TEXT_ONLY" in report.dead_keys
    assert "PY_OS_GETENV" not in report.dead_keys
    assert "PY_OS_ENVIRON_GET" not in report.dead_keys
    assert "PY_OS_ENVIRON_INDEX" not in report.dead_keys
    assert "PY_OS_ENVIRON_SETDEFAULT" not in report.dead_keys
    assert "SH_DOLLAR_REF" not in report.dead_keys
    assert "SH_BRACE_REF" not in report.dead_keys


def test_literal_loop_alias_only_counts_inside_loop_body(tmp_path: Path) -> None:
    check_env_config = _load_module()
    root = tmp_path / "repo"

    _write(
        root / ".env.example",
        "\n".join(
            [
                "LOOP_ENV_READ=1",
                "DEAD_LOOP_ALIAS=1",
                "",
            ]
        ),
    )
    _write(
        root / "src" / "novelvideo" / "config.py",
        "\n".join(
            [
                "import os",
                'for name in ("LOOP_ENV_READ",):',
                "    os.environ.get(name)",
                "",
                "def show_dead_alias() -> None:",
                '    for name in ("DEAD_LOOP_ALIAS",):',
                "        print(name)",
                "",
                "def read_dynamic(name: str) -> str | None:",
                "    return os.environ.get(name)",
                "",
            ]
        ),
    )

    report = check_env_config.analyze_ce_repo(root)

    assert "LOOP_ENV_READ" not in report.dead_keys
    assert "DEAD_LOOP_ALIAS" in report.dead_keys


def test_attribute_calls_do_not_match_global_reader_helpers(tmp_path: Path) -> None:
    check_env_config = _load_module()
    root = tmp_path / "repo"

    _write(
        root / ".env.example",
        "\n".join(
            [
                "HELPER_ENV_READ=1",
                "NOT_ENV_READ=1",
                "",
            ]
        ),
    )
    _write(
        root / "src" / "novelvideo" / "config.py",
        "\n".join(
            [
                "import os",
                "",
                "def env_value(name: str) -> str | None:",
                "    return os.environ.get(name)",
                "",
                "class NotEnv:",
                "    def env_value(self, value: str) -> str:",
                "        return value",
                "",
                'HELPER = env_value("HELPER_ENV_READ")',
                'NOT_HELPER = NotEnv().env_value("NOT_ENV_READ")',
                "",
            ]
        ),
    )

    report = check_env_config.analyze_ce_repo(root)

    assert "HELPER_ENV_READ" not in report.dead_keys
    assert "NOT_ENV_READ" in report.dead_keys


def test_self_reader_helper_calls_count_as_env_reads(tmp_path: Path) -> None:
    check_env_config = _load_module()
    root = tmp_path / "repo"

    _write(root / ".env.example", "SELF_HELPER_ENV_READ=1\n")
    _write(
        root / "src" / "novelvideo" / "config.py",
        "\n".join(
            [
                "import os",
                "",
                "class Settings:",
                "    def env_value(self, name: str) -> str | None:",
                "        return os.environ.get(name)",
                "",
                "    def build(self) -> str | None:",
                '        return self.env_value("SELF_HELPER_ENV_READ")',
                "",
            ]
        ),
    )

    report = check_env_config.analyze_ce_repo(root)

    assert "SELF_HELPER_ENV_READ" not in report.dead_keys


def test_env_aliases_variables_and_dynamic_names_are_classified(tmp_path: Path) -> None:
    check_env_config = _load_module()
    root = tmp_path / "repo"

    _write(
        root / ".env.example",
        "\n".join(
            [
                "ALIAS_ENV_GET=1",
                "ALIAS_ENV_INDEX=1",
                "ALIAS_ENV_CONTAINS=1",
                "VARIABLE_ENV_GET=1",
                "FSTRING_NOT_ALLOWLISTED=1",
                "",
            ]
        ),
    )
    _write(
        root / "src" / "novelvideo" / "config.py",
        "\n".join(
            [
                "from os import environ",
                'ALIAS_GET = environ.get("ALIAS_ENV_GET")',
                'ALIAS_INDEX = environ["ALIAS_ENV_INDEX"]',
                'HAS_ALIAS = "ALIAS_ENV_CONTAINS" in environ',
                'name = "VARIABLE_ENV_GET"',
                "VARIABLE_GET = environ.get(name)",
                'suffix = "NOT_ALLOWLISTED"',
                'dynamic_name = f"FSTRING_{suffix}"',
                "DYNAMIC_GET = environ.get(dynamic_name)",
                "",
            ]
        ),
    )

    report = check_env_config.analyze_ce_repo(root)

    assert "ALIAS_ENV_GET" not in report.dead_keys
    assert "ALIAS_ENV_INDEX" not in report.dead_keys
    assert "ALIAS_ENV_CONTAINS" not in report.dead_keys
    assert "VARIABLE_ENV_GET" not in report.dead_keys
    assert "FSTRING_NOT_ALLOWLISTED" in report.dead_keys


def test_missing_template_keys_are_reported_for_runtime_reads(tmp_path: Path) -> None:
    check_env_config = _load_module()
    root = tmp_path / "repo"
    _write(root / ".env.example", "LISTED_ENV_READ=1\n")
    _write(
        root / "src" / "novelvideo" / "config.py",
        "\n".join(
            [
                "import os",
                'LISTED = os.environ.get("LISTED_ENV_READ")',
                'MISSING = os.environ.get("MISSING_ENV_READ")',
                "",
            ]
        ),
    )

    report = check_env_config.analyze_ce_repo(root)

    assert "MISSING_ENV_READ" in report.missing_keys
    assert not report.ok


def test_cli_exits_nonzero_for_dead_keys(tmp_path: Path, capsys) -> None:
    check_env_config = _load_module()
    root = tmp_path / "repo"
    _write(root / ".env.example", "FOO_UNUSED_TEST=1\n")
    _write(root / "src" / "novelvideo" / "__init__.py", "")

    status = check_env_config.main(["--mode", "ce", "--root", str(root)])

    captured = capsys.readouterr()
    assert status == 1
    assert "FOO_UNUSED_TEST" in captured.out


def test_supertale_cli_requires_ce_root_when_not_discoverable(
    tmp_path: Path, capsys, monkeypatch
) -> None:
    check_env_config = _load_module()
    supertale_root = tmp_path / "SuperTale2"
    _write(supertale_root / ".env.example", "CE_PACKAGE_KEY=1\n")
    _write(supertale_root / ".env.control-plane.example", "")
    _write(supertale_root / "src" / "novelvideo_ee" / "__init__.py", "")
    monkeypatch.delenv("DRAMACLAW_CE_ROOT", raising=False)

    status = check_env_config.main(["--mode", "supertale", "--root", str(supertale_root)])

    captured = capsys.readouterr()
    assert status == 2
    assert "DRAMACLAW_CE_ROOT" in captured.err
    assert "--ce-root" in captured.err


def test_real_ce_repo_env_ratchet_is_clean() -> None:
    check_env_config = _load_module()

    report = check_env_config.analyze_ce_repo(REPO_ROOT)
    assert report.dead_findings == []
    assert check_env_config.main(["--mode", "ce", "--root", str(REPO_ROOT)]) == 0
