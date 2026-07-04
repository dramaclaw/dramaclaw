from __future__ import annotations

import csv
import importlib.util
import time
import sys
import tomllib
from pathlib import Path


SCRIPT_PATH = Path(__file__).resolve().parents[1] / "scripts/compliance/generate_p0b_artifacts.py"
SPEC = importlib.util.spec_from_file_location("generate_p0b_artifacts", SCRIPT_PATH)
assert SPEC is not None
generator = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
sys.modules[SPEC.name] = generator
SPEC.loader.exec_module(generator)


def test_locked_package_licenses_include_project_dependencies_missing_from_environment() -> None:
    packages = {package.name.lower(): package for package in generator.locked_package_licenses()}

    assert packages["psycopg"].version
    assert packages["psycopg-binary"].version
    assert packages["pymysql"].version
    assert packages["contourpy"].license_expression == "BSD-3-Clause"
    assert packages["plyfile"].license_expression == "GPL-3.0-or-later"
    assert "fish-audio-sdk" not in packages
    assert "mutagen" not in packages


def test_sharp_dependency_metadata_does_not_request_bundled_ffmpeg_extra() -> None:
    data = tomllib.loads(Path("pyproject.toml").read_text(encoding="utf-8"))
    metadata_entries = data["tool"]["uv"]["dependency-metadata"]
    sharp_metadata = next(entry for entry in metadata_entries if entry["name"] == "sharp")

    requires_dist = sharp_metadata["requires-dist"]

    assert "imageio" in requires_dist
    assert all(not dependency.startswith("imageio[ffmpeg]") for dependency in requires_dist)


def test_locked_package_licenses_exclude_imageio_ffmpeg_bundled_binary() -> None:
    packages = {package.name.lower(): package for package in generator.locked_package_licenses()}

    assert "imageio" in packages
    assert "imageio-ffmpeg" not in packages


def test_license_field_beats_generic_classifier_for_specific_expression() -> None:
    expression, evidence = generator.normalize_license(
        "BSD-2-Clause",
        ["License :: OSI Approved :: BSD License"],
    )

    assert expression == "BSD-2-Clause"
    assert evidence == "python package metadata License field"


def test_lgplv3_classifier_is_not_upgraded_to_or_later() -> None:
    expression, _ = generator.normalize_license(
        "",
        ["License :: OSI Approved :: GNU Lesser General Public License v3 (LGPLv3)"],
    )

    assert expression == "LGPL-3.0-only"


def test_packaging_license_override_uses_either_license_not_classifier_and() -> None:
    package = generator.package_license_from_metadata("packaging", "24.2", __import__("email").message.Message())

    assert package.license_expression == "Apache-2.0 OR BSD-2-Clause"
    assert package.source == "manual"


def test_numpy_and_scipy_license_overrides_include_bundled_copyleft_components() -> None:
    numpy = generator.package_license_from_metadata("numpy", "1.26.4", __import__("email").message.Message())
    scipy = generator.package_license_from_metadata("scipy", "1.17.1", __import__("email").message.Message())

    assert numpy.license_expression == (
        "BSD-3-Clause AND (GPL-3.0-or-later WITH GCC-exception-3.1) "
        "AND LGPL-2.1-or-later"
    )
    assert scipy.license_expression == (
        "BSD-3-Clause AND (GPL-3.0-or-later WITH GCC-exception-3.1) "
        "AND LGPL-2.1-or-later"
    )
    assert generator.is_copyleft_expression(numpy.license_expression)
    assert generator.is_copyleft_expression(scipy.license_expression)


def test_mixed_gpl_with_exception_and_lgpl_classification_is_not_only_weak() -> None:
    expression = (
        "BSD-3-Clause AND (GPL-3.0-or-later WITH GCC-exception-3.1) "
        "AND LGPL-2.1-or-later"
    )

    assert generator.copyleft_classification(expression) == (
        "mixed strong copyleft with GCC runtime exception and weak copyleft "
        "library obligations"
    )


def test_lgpl_only_classification_stays_weak_copyleft() -> None:
    assert generator.copyleft_classification("LGPL-3.0-only") == (
        "weak copyleft library obligations if distributed/linked"
    )


def test_write_csv_uses_lf_line_endings(tmp_path: Path) -> None:
    csv_path = tmp_path / "report.csv"

    generator.write_csv(csv_path, ["name"], [{"name": "example"}])

    assert b"\r\n" not in csv_path.read_bytes()
    rows = list(csv.DictReader(csv_path.read_text(encoding="utf-8").splitlines()))
    assert rows == [{"name": "example"}]


def test_write_sbom_skips_locked_root_package_to_keep_spdx_ids_unique(
    tmp_path: Path, monkeypatch
) -> None:
    monkeypatch.setattr(generator, "ROOT", tmp_path)
    (tmp_path / "pyproject.toml").write_text(
        "[project]\nname = \"supertale-ce\"\nversion = \"0.1.0\"\n",
        encoding="utf-8",
    )

    generator.write_sbom(
        [
            generator.PackageLicense("supertale-ce", "0.1.0", "Elastic-2.0", "metadata", "self"),
            generator.PackageLicense("pydantic", "2.13.4", "MIT", "metadata", "classifier"),
        ]
    )

    data = __import__("json").loads((tmp_path / "sbom.spdx.json").read_text(encoding="utf-8"))
    spdx_ids = [package["SPDXID"] for package in data["packages"]]

    assert spdx_ids.count("SPDXRef-Package-supertale-ce") == 1
    assert len(spdx_ids) == len(set(spdx_ids))
    assert all(
        relationship["relatedSpdxElement"] != "SPDXRef-Package-supertale-ce"
        for relationship in data["relationships"]
    )


def test_license_inventory_covers_current_git_index() -> None:
    inventory_paths = {
        row["path"] for row in csv.DictReader(Path("license-inventory.csv").open(encoding="utf-8"))
    }

    missing = sorted(set(generator.run_git_ls_files()) - inventory_paths)

    assert missing == []


def test_third_party_dirs_with_license_file_not_marked_project_license() -> None:
    """带自身 License.txt 的第三方目录,其文件不得被聚合标成 PROJECT_LICENSE。
    防止后续一刀切重跑把上游许可(如 viewer-kit/quaternius 的 CC0-1.0)
    覆盖回 Elastic-2.0。"""
    rows = list(csv.DictReader(Path("license-inventory.csv").open(encoding="utf-8")))
    tracked = set(generator.run_git_ls_files())
    third_party_dirs = {
        str(Path(p).parent) for p in tracked if Path(p).name == "License.txt"
    }
    assert third_party_dirs, "预期至少有一个带 License.txt 的第三方目录"
    offenders = [
        row["path"]
        for row in rows
        if any(row["path"].startswith(d + "/") for d in third_party_dirs)
        and row["license_expression"] == generator.PROJECT_LICENSE
    ]
    assert offenders == [], (
        "第三方(带 License.txt)路径被错标为 PROJECT_LICENSE:\n" + "\n".join(offenders)
    )


def test_codex_sandbox_binaries_are_not_marked_project_license() -> None:
    rows = {
        row["path"]: row
        for row in csv.DictReader(Path("license-inventory.csv").open(encoding="utf-8"))
        if row["path"].startswith("deploy/sandbox/linux-")
    }

    assert (
        rows["deploy/sandbox/linux-amd64/codex-linux-sandbox"]["license_expression"]
        == "Apache-2.0"
    )
    assert (
        rows["deploy/sandbox/linux-arm64/codex-linux-sandbox"]["license_expression"]
        == "Apache-2.0"
    )
    assert (
        generator._inventory_row("deploy/sandbox/linux-amd64/codex-linux-sandbox")[
            "license_expression"
        ]
        == "Apache-2.0"
    )


def test_write_sbom_is_idempotent_for_same_inputs(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(generator, "ROOT", tmp_path)
    (tmp_path / "pyproject.toml").write_text(
        "[project]\nname = \"supertale-ce\"\nversion = \"0.1.0\"\n",
        encoding="utf-8",
    )
    packages = [
        generator.PackageLicense("pydantic", "2.13.4", "MIT", "metadata", "classifier"),
    ]

    generator.write_sbom(packages)
    first = (tmp_path / "sbom.spdx.json").read_text(encoding="utf-8")
    time.sleep(1.1)
    generator.write_sbom(packages)
    second = (tmp_path / "sbom.spdx.json").read_text(encoding="utf-8")

    assert second == first
