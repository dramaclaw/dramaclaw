from __future__ import annotations

import subprocess
import sys
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).parents[1]
SCRIPT = REPOSITORY_ROOT / "scripts" / "bump_compose_default.py"

FIXTURE = """\
services:
  api:
    image: ${DRAMACLAW_IMAGE_PREFIX:-claymorelab}/dramaclaw:${DRAMACLAW_VERSION:-2.0.2}
  newapi:
    image: ${DRAMACLAW_IMAGE_PREFIX:-claymorelab}/dramaclaw-gateway:${DRAMACLAW_GATEWAY_VERSION:-v1.0.0-rc.24-dramaclaw.1}
  web:
    image: ${DRAMACLAW_IMAGE_PREFIX:-claymorelab}/dramaclaw-frontend:${DRAMACLAW_VERSION:-2.0.2}
"""


def _run(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(SCRIPT), *args],
        capture_output=True,
        text=True,
    )


def _write_fixture(tmp_path: Path) -> Path:
    compose_file = tmp_path / "docker-compose.release.yml"
    compose_file.write_text(FIXTURE)
    return compose_file


def test_bumps_every_occurrence_of_the_target_var_only(tmp_path: Path) -> None:
    compose_file = _write_fixture(tmp_path)
    original_line_count = FIXTURE.count("\n")

    result = _run(str(compose_file), "DRAMACLAW_VERSION", "2.1.0")

    assert result.returncode == 0, result.stderr
    assert "2.0.2 -> 2.1.0" in result.stdout

    new_text = compose_file.read_text()
    assert new_text.count("${DRAMACLAW_VERSION:-2.1.0}") == 2
    assert "${DRAMACLAW_VERSION:-2.0.2}" not in new_text
    # The gateway var and everything else must be untouched.
    assert "${DRAMACLAW_GATEWAY_VERSION:-v1.0.0-rc.24-dramaclaw.1}" in new_text
    assert new_text.count("\n") == original_line_count


def test_bumps_gateway_var_independently_of_version_var(tmp_path: Path) -> None:
    compose_file = _write_fixture(tmp_path)

    result = _run(
        str(compose_file), "DRAMACLAW_GATEWAY_VERSION", "v1.0.0-rc.25-dramaclaw.2"
    )

    assert result.returncode == 0, result.stderr
    new_text = compose_file.read_text()
    assert (
        "${DRAMACLAW_GATEWAY_VERSION:-v1.0.0-rc.25-dramaclaw.2}" in new_text
    )
    # Both DRAMACLAW_VERSION occurrences remain at their original default.
    assert new_text.count("${DRAMACLAW_VERSION:-2.0.2}") == 2


def test_unchanged_when_new_default_matches_current_value(tmp_path: Path) -> None:
    compose_file = _write_fixture(tmp_path)
    before = compose_file.read_text()

    result = _run(str(compose_file), "DRAMACLAW_VERSION", "2.0.2")

    assert result.returncode == 0, result.stderr
    assert "unchanged" in result.stdout
    assert compose_file.read_text() == before


def test_missing_var_default_form_exits_2(tmp_path: Path) -> None:
    compose_file = _write_fixture(tmp_path)
    before = compose_file.read_text()

    result = _run(str(compose_file), "DRAMACLAW_NO_SUCH_VAR", "1.0.0")

    assert result.returncode == 2, result.stdout
    assert compose_file.read_text() == before


def test_docker_compose_yml_has_no_dramaclaw_version_default(tmp_path: Path) -> None:
    """docker-compose.yml (source-build mode) must never be touched by the bump.

    It has no ``${DRAMACLAW_VERSION:-...}`` default form (versions come from
    the build context there), so running the script against it must fail
    with exit 2 rather than silently editing the wrong file.
    """
    source_compose = REPOSITORY_ROOT / "docker-compose.yml"
    before = source_compose.read_text()

    result = _run(str(source_compose), "DRAMACLAW_VERSION", "2.1.0")

    assert result.returncode == 2, result.stdout
    assert source_compose.read_text() == before


def test_check_only_exits_0_when_a_change_is_needed_and_does_not_write(
    tmp_path: Path,
) -> None:
    compose_file = _write_fixture(tmp_path)
    before = compose_file.read_text()

    result = _run(str(compose_file), "DRAMACLAW_VERSION", "2.1.0", "--check-only")

    assert result.returncode == 0, result.stderr
    assert compose_file.read_text() == before


def test_check_only_exits_3_when_already_up_to_date_and_does_not_write(
    tmp_path: Path,
) -> None:
    compose_file = _write_fixture(tmp_path)
    before = compose_file.read_text()

    result = _run(str(compose_file), "DRAMACLAW_VERSION", "2.0.2", "--check-only")

    assert result.returncode == 3, result.stdout
    assert "unchanged" in result.stdout
    assert compose_file.read_text() == before


def test_check_only_still_exits_2_when_var_is_missing(tmp_path: Path) -> None:
    compose_file = _write_fixture(tmp_path)

    result = _run(
        str(compose_file), "DRAMACLAW_NO_SUCH_VAR", "1.0.0", "--check-only"
    )

    assert result.returncode == 2, result.stdout
