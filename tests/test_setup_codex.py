"""Offline checks for platform selection and fail-closed native runtime setup."""

from pathlib import Path
import subprocess

import pytest

ROOT = Path(__file__).resolve().parents[1]
SETUP = ROOT / "scripts" / "setup-codex.sh"
ARTIFACTS = [
    (
        "Darwin",
        "arm64",
        "aarch64-apple-darwin",
        "2f88642dc43dd758f243a8a7bde74d848c4180c3b6929f8891bad03060301a47",
    ),
    (
        "Darwin",
        "x86_64",
        "x86_64-apple-darwin",
        "83555e47dd6f255f473f507f92160156f727d79e3cf805f299ff994b48dd8937",
    ),
    (
        "Linux",
        "x86_64",
        "x86_64-unknown-linux-musl",
        "628f9923b2fe26f15b0aff80d778bdc3b005ea17079f6de5b5f6cd0fa7591e38",
    ),
    (
        "Linux",
        "aarch64",
        "aarch64-unknown-linux-musl",
        "34ab0569195d57b7042e40775793053cf3f337916d8059514d7c96e5d11ea385",
    ),
]


@pytest.fixture
def setup_env(tmp_path):
    binaries = tmp_path / "bin"
    binaries.mkdir()
    fixture_binary = tmp_path / "fixture-codex"
    fixture_binary.write_text(
        '#!/bin/sh\n[ "$1" = --version ] || exit 1\n'
        'echo executed >> "$EXECUTIONS"\n'
        'echo "codex-cli ${FAKE_VERSION:-0.164.0}"\n'
    )
    fixture_binary.chmod(0o755)
    commands = {
        "uname": 'case "$1" in -s) echo "$FAKE_OS";; -m) echo "$FAKE_ARCH";; esac',
        "curl": (
            'printf "%s\\n" "$*" >> "$DOWNLOADS"\n'
            'while [ "$#" -gt 0 ]; do\n'
            '  case "$1" in --output) shift; output="$1";; esac\n'
            "  shift\n"
            "done\n"
            'cp "$FIXTURE_BINARY" "$output"\n'
            'exit "${CURL_EXIT:-0}"\n'
        ),
        # Simulate content-addressed fixture bytes, while keeping the production
        # pinned hashes unchanged. A separate test uses a real SHA256 utility.
        "sha256sum": (
            'if [ "${BAD_SHA:-0}" = 1 ] || ! cmp -s "$1" "$FIXTURE_BINARY"; then\n'
            '  echo "invalid  $1"\n'
            'else echo "$FAKE_SHA  $1"; fi\n'
        ),
    }
    for name, body in commands.items():
        command = binaries / name
        command.write_text(f"#!/bin/sh\nset -eu\n{body}\n")
        command.chmod(0o755)
    return {
        "PATH": f"{binaries}:/usr/bin:/bin",
        "HOME": str(tmp_path),
        "NOVELVIDEO_RUNTIME_DIR": str(tmp_path / "runtime with spaces"),
        "FAKE_OS": "Darwin",
        "FAKE_ARCH": "arm64",
        "FAKE_SHA": ARTIFACTS[0][3],
        "FIXTURE_BINARY": str(fixture_binary),
        "EXECUTIONS": str(tmp_path / "executions"),
        "DOWNLOADS": str(tmp_path / "downloads"),
    }


def run_setup(env):
    return subprocess.run(
        ["/bin/bash", str(SETUP)], env=env, capture_output=True, text=True, timeout=5
    )


def assert_not_installed(env):
    assert not any(p.is_file() for p in Path(env["NOVELVIDEO_RUNTIME_DIR"]).rglob("codex"))
    assert not list(Path(env["NOVELVIDEO_RUNTIME_DIR"]).rglob(".download.*"))


@pytest.mark.parametrize(("system", "arch", "target", "sha"), ARTIFACTS)
def test_downloads_and_reuses_verified_platform_artifact(
    setup_env, system, arch, target, sha
):
    setup_env.update(FAKE_OS=system, FAKE_ARCH=arch, FAKE_SHA=sha)
    result = run_setup(setup_env)
    assert result.returncode == 0, result.stderr
    binary = Path(result.stdout.strip())
    assert binary.is_file()
    assert binary.stat().st_mode & 0o777 == 0o700
    assert str(binary).endswith(f"/0.164.0/{target}/{sha}/codex")
    download_log = Path(setup_env["DOWNLOADS"])
    assert (
        f"https://dramaclaw-dl.cdnfg.com/build/codex/0.164.0/{target}/{sha}/codex"
        in download_log.read_text()
    )
    assert "--proto =https --proto-redir =https" in download_log.read_text()
    assert not list(binary.parent.glob(".download.*"))

    # A second startup is offline, but must still verify and execute --version.
    setup_env["CURL_EXIT"] = "22"
    again = run_setup(setup_env)
    assert again.returncode == 0, again.stderr
    assert again.stdout == result.stdout
    assert len(download_log.read_text().splitlines()) == 1
    assert len(Path(setup_env["EXECUTIONS"]).read_text().splitlines()) == 2


@pytest.mark.parametrize(
    ("system", "arch"), [("Linux", "riscv64"), ("MINGW64_NT", "x86_64")]
)
def test_unsupported_platform_never_downloads(setup_env, system, arch):
    setup_env.update(FAKE_OS=system, FAKE_ARCH=arch)
    result = run_setup(setup_env)
    assert result.returncode == 2
    assert "No published runtime" in result.stderr
    assert not Path(setup_env["DOWNLOADS"]).exists()
    assert not Path(setup_env["EXECUTIONS"]).exists()


@pytest.mark.parametrize(
    ("setting", "message"),
    [("CURL_EXIT", "Download failed"), ("BAD_SHA", "SHA256 mismatch")],
)
def test_failed_download_or_checksum_is_never_executed(setup_env, setting, message):
    setup_env[setting] = "1"
    result = run_setup(setup_env)
    assert result.returncode == 2
    assert message in result.stderr
    assert result.stdout == ""
    assert not Path(setup_env["EXECUTIONS"]).exists()
    assert_not_installed(setup_env)


def test_version_mismatch_is_not_installed(setup_env):
    setup_env["FAKE_VERSION"] = "0.162.0"
    result = run_setup(setup_env)
    assert result.returncode == 2
    assert "Expected codex-cli 0.164.0" in result.stderr
    assert_not_installed(setup_env)


def test_corrupt_cache_is_replaced_only_after_verified_download(setup_env):
    original = run_setup(setup_env)
    assert original.returncode == 0, original.stderr
    binary = Path(original.stdout.strip())
    binary.write_text("corrupt")
    setup_env["CURL_EXIT"] = "22"
    assert run_setup(setup_env).returncode == 2
    assert binary.read_text() == "corrupt"
    assert len(Path(setup_env["EXECUTIONS"]).read_text().splitlines()) == 1
    setup_env.pop("CURL_EXIT")
    repaired = run_setup(setup_env)
    assert repaired.returncode == 0, repaired.stderr
    assert repaired.stdout == original.stdout
    assert binary.read_bytes() == Path(setup_env["FIXTURE_BINARY"]).read_bytes()


def test_explicit_runtime_skips_platform_selection_and_download(setup_env):
    custom = Path(setup_env["HOME"]) / "custom runtime" / "codex"
    custom.parent.mkdir()
    custom.write_bytes(Path(setup_env["FIXTURE_BINARY"]).read_bytes())
    custom.chmod(0o755)
    setup_env.update(CODEX_BIN="~/custom runtime/codex", FAKE_ARCH="riscv64")
    result = run_setup(setup_env)
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == str(custom)
    assert "credential-safety patches" in result.stderr
    assert not Path(setup_env["DOWNLOADS"]).exists()
    assert custom.stat().st_mode & 0o777 == 0o755  # custom permissions are untouched


def test_invalid_explicit_runtime_fails_without_fallback(setup_env):
    setup_env["CODEX_BIN"] = "/missing/codex"
    result = run_setup(setup_env)
    assert result.returncode == 2
    assert "CODEX_BIN is not an executable file" in result.stderr
    assert not Path(setup_env["DOWNLOADS"]).exists()


def test_real_checksum_rejects_wrong_download_before_execution(setup_env):
    fake_checksum = Path(setup_env["HOME"]) / "bin" / "sha256sum"
    fake_checksum.unlink()  # use the actual host sha256sum/shasum implementation
    result = run_setup(setup_env)
    assert result.returncode == 2
    assert "SHA256 mismatch" in result.stderr
    assert not Path(setup_env["EXECUTIONS"]).exists()
    assert_not_installed(setup_env)


def test_cache_respects_data_root_when_runtime_root_is_unset(setup_env):
    setup_env.pop("NOVELVIDEO_RUNTIME_DIR")
    setup_env["NOVELVIDEO_DATA_ROOT"] = str(Path(setup_env["HOME"]) / "ce-data")
    result = run_setup(setup_env)
    assert result.returncode == 0, result.stderr
    assert result.stdout.startswith(setup_env["NOVELVIDEO_DATA_ROOT"] + "/runtime/codex/bin/")
