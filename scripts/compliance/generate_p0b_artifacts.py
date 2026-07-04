# SPDX-License-Identifier: Elastic-2.0
# SPDX-FileCopyrightText: 2026 SuperTale contributors
"""Generate P0-B license and dependency compliance evidence files."""

from __future__ import annotations

import csv
import hashlib
import json
import re
import subprocess
import tomllib
from dataclasses import dataclass
from email.message import Message
from importlib import metadata
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
COPYRIGHT = "2026 SuperTale contributors"
PROJECT_LICENSE = "Elastic-2.0"
SBOM_CREATED = "2026-06-25T00:00:00Z"

# Per-path license overrides for bundled third-party files that ship their own
# License.txt and must NOT be aggregated under PROJECT_LICENSE. Keyed by path
# prefix (relative to repo root). Keep in sync with frontend/REUSE.toml.
THIRD_PARTY_PATH_OVERRIDES: tuple[tuple[str, str, str, str], ...] = (
    (
        "LICENSES/Apache-2.0.txt",
        "Apache-2.0",
        "Apache Software Foundation",
        "Apache License 2.0 text",
    ),
    (
        "deploy/sandbox/linux-amd64/codex-linux-sandbox",
        "Apache-2.0",
        "2026 OpenAI",
        "built from openai/codex codex-rs/linux-sandbox commit da4c8ca57d40b074bdc1b5b1218851100150c56b",
    ),
    (
        "deploy/sandbox/linux-arm64/codex-linux-sandbox",
        "Apache-2.0",
        "2026 OpenAI",
        "built from openai/codex codex-rs/linux-sandbox commit da4c8ca57d40b074bdc1b5b1218851100150c56b",
    ),
    (
        "frontend/public/viewer-kit/quaternius/",
        "CC0-1.0",
        "Quaternius",
        "upstream License.txt (CC0-1.0 public domain)",
    ),
)


MANUAL_LICENSES = {
    "da2": (
        "Apache-2.0",
        "manual review: https://github.com/EnVision-Research/DA-2/blob/main/LICENSE",
    ),
    "numpy": (
        "BSD-3-Clause AND (GPL-3.0-or-later WITH GCC-exception-3.1) AND LGPL-2.1-or-later",
        "wheel LICENSE.txt bundled notices: NumPy BSD-3-Clause, GCC runtime, libquadmath",
    ),
    "packaging": (
        "Apache-2.0 OR BSD-2-Clause",
        "packaging-24.2.dist-info/LICENSE says use under either LICENSE.APACHE or LICENSE.BSD",
    ),
    "scipy": (
        "BSD-3-Clause AND (GPL-3.0-or-later WITH GCC-exception-3.1) AND LGPL-2.1-or-later",
        "wheel LICENSE.txt bundled notices: SciPy BSD-3-Clause, GCC runtime, libquadmath",
    ),
    "sharp": (
        "LicenseRef-Apple-Sample-Code AND LicenseRef-Apple-ML-Research-Model",
        "package license files: sharp-0.1.dist-info/licenses/LICENSE and LICENSE_MODEL",
    ),
}


LOCKED_LICENSE_OVERRIDES = {
    "async-timeout": ("Apache-2.0", "package metadata published for locked dependency"),
    "colorama": ("BSD-3-Clause", "package metadata published for locked dependency"),
    "contourpy": ("BSD-3-Clause", "package metadata recorded for locked optional dependency"),
    "cuda-bindings": ("Apache-2.0", "package metadata published for locked dependency"),
    "cuda-pathfinder": ("Apache-2.0", "package metadata published for locked dependency"),
    "cuda-toolkit": ("LicenseRef-NVIDIA-CUDA-Toolkit", "NVIDIA CUDA Toolkit package license"),
    "cycler": ("BSD-3-Clause", "package metadata recorded for locked optional dependency"),
    "einops": ("MIT", "package metadata recorded for locked optional dependency"),
    "fonttools": ("MIT", "package metadata recorded for locked optional dependency"),
    "imageio": ("BSD-2-Clause", "package metadata recorded for locked optional dependency"),
    "jaxtyping": ("MIT", "package metadata recorded for locked optional dependency"),
    "kiwisolver": ("BSD-3-Clause", "package metadata recorded for locked optional dependency"),
    "matplotlib": ("PSF-2.0", "package metadata recorded for locked optional dependency"),
    "mpmath": ("BSD-3-Clause", "package metadata recorded for locked optional dependency"),
    "nvidia-cublas": ("LicenseRef-NVIDIA-CUDA-Toolkit", "NVIDIA CUDA Toolkit package license"),
    "nvidia-cuda-cupti": ("LicenseRef-NVIDIA-CUDA-Toolkit", "NVIDIA CUDA Toolkit package license"),
    "nvidia-cuda-nvrtc": ("LicenseRef-NVIDIA-CUDA-Toolkit", "NVIDIA CUDA Toolkit package license"),
    "nvidia-cuda-runtime": ("LicenseRef-NVIDIA-CUDA-Toolkit", "NVIDIA CUDA Toolkit package license"),
    "nvidia-cudnn-cu13": ("LicenseRef-NVIDIA-cuDNN", "NVIDIA cuDNN package license"),
    "nvidia-cufft": ("LicenseRef-NVIDIA-CUDA-Toolkit", "NVIDIA CUDA Toolkit package license"),
    "nvidia-cufile": ("LicenseRef-NVIDIA-CUDA-Toolkit", "NVIDIA CUDA Toolkit package license"),
    "nvidia-curand": ("LicenseRef-NVIDIA-CUDA-Toolkit", "NVIDIA CUDA Toolkit package license"),
    "nvidia-cusolver": ("LicenseRef-NVIDIA-CUDA-Toolkit", "NVIDIA CUDA Toolkit package license"),
    "nvidia-cusparse": ("LicenseRef-NVIDIA-CUDA-Toolkit", "NVIDIA CUDA Toolkit package license"),
    "nvidia-cusparselt-cu13": ("LicenseRef-NVIDIA-CUDA-Toolkit", "NVIDIA CUDA Toolkit package license"),
    "nvidia-nccl-cu13": ("LicenseRef-NVIDIA-NCCL", "NVIDIA NCCL package license"),
    "nvidia-nvjitlink": ("LicenseRef-NVIDIA-CUDA-Toolkit", "NVIDIA CUDA Toolkit package license"),
    "nvidia-nvshmem-cu13": ("LicenseRef-NVIDIA-NVSHMEM", "NVIDIA NVSHMEM package license"),
    "nvidia-nvtx": ("LicenseRef-NVIDIA-CUDA-Toolkit", "NVIDIA CUDA Toolkit package license"),
    "overrides": ("Apache-2.0", "package metadata published for locked dependency"),
    "pillow-heif": ("BSD-3-Clause", "package metadata recorded for locked optional dependency"),
    "plyfile": ("GPL-3.0-or-later", "package metadata recorded for locked optional dependency"),
    "psycopg": ("LGPL-3.0-only", "package metadata published for locked dependency"),
    "psycopg-binary": ("LGPL-3.0-only", "package metadata published for locked dependency"),
    "pymysql": ("MIT", "package metadata published for locked dependency"),
    "python-magic-bin": ("MIT", "package metadata published for locked dependency"),
    "pywin32": ("PSF-2.0", "package metadata published for locked dependency"),
    "safetensors": ("Apache-2.0", "package metadata recorded for locked optional dependency"),
    "setuptools": ("MIT", "package metadata recorded for locked optional dependency"),
    "sympy": ("BSD-3-Clause", "package metadata recorded for locked optional dependency"),
    "timm": ("Apache-2.0", "package metadata recorded for locked optional dependency"),
    "torch": ("BSD-3-Clause", "package metadata recorded for locked optional dependency"),
    "torchvision": ("BSD-3-Clause", "package metadata recorded for locked optional dependency"),
    "triton": ("MIT", "package metadata published for locked dependency"),
    "transformers": ("Apache-2.0", "package metadata recorded for locked optional dependency"),
    "wadler-lindig": ("Apache-2.0", "package metadata recorded for locked optional dependency"),
}


LICENSE_NORMALIZATIONS = [
    ("Apache-2.0", "Apache-2.0"),
    ("Apache 2.0", "Apache-2.0"),
    ("Apache License 2.0", "Apache-2.0"),
    ("Apache Software License", "Apache-2.0"),
    ("Apache", "Apache-2.0"),
    ("MIT", "MIT"),
    ("BSD-2-Clause", "BSD-2-Clause"),
    ("BSD-3-Clause", "BSD-3-Clause"),
    ("BSD 3-Clause", "BSD-3-Clause"),
    ("BSD 3-Clause License", "BSD-3-Clause"),
    ("New BSD", "BSD-3-Clause"),
    ("BSD", "BSD-3-Clause"),
    ("MPL-2.0", "MPL-2.0"),
    ("ISC", "ISC"),
    ("PSF-2.0", "PSF-2.0"),
    ("Unlicense", "Unlicense"),
    ("Python Software Foundation License", "PSF-2.0"),
]


CLASSIFIER_LICENSES = {
    "License :: OSI Approved :: Apache Software License": "Apache-2.0",
    "License :: OSI Approved :: BSD License": "BSD-3-Clause",
    "License :: OSI Approved :: GNU General Public License v2 or later (GPLv2+)": "GPL-2.0-or-later",
    "License :: OSI Approved :: GNU General Public License v3 or later (GPLv3+)": "GPL-3.0-or-later",
    "License :: OSI Approved :: GNU Lesser General Public License v3 (LGPLv3)": "LGPL-3.0-only",
    "License :: OSI Approved :: ISC License (ISCL)": "ISC",
    "License :: OSI Approved :: MIT License": "MIT",
    "License :: OSI Approved :: Mozilla Public License 2.0 (MPL 2.0)": "MPL-2.0",
    "License :: OSI Approved :: Python Software Foundation License": "PSF-2.0",
    "License :: Public Domain": "LicenseRef-Public-Domain",
}


@dataclass(frozen=True)
class PackageLicense:
    name: str
    version: str
    license_expression: str
    source: str
    evidence: str


def run_git_ls_files() -> list[str]:
    output = subprocess.check_output(["git", "ls-files"], cwd=ROOT, text=True)
    return [line for line in output.splitlines() if line]


def write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def write_csv(path: Path, fieldnames: list[str], rows: list[dict[str, str]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames, lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)


def canonical_package_name(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


def normalize_license(raw_license: str, classifiers: list[str]) -> tuple[str, str]:
    raw = " ".join((raw_license or "").split())
    if raw:
        if raw in {
            "Elastic-2.0",
            "GPL-2.0-or-later",
            "GPL-3.0-or-later",
            "LGPL-3.0-or-later",
            "LGPL-3.0-only",
            "MIT-CMU",
        }:
            return raw, "python package metadata License-Expression/License field"
        if raw.lower().startswith("mit license"):
            return "MIT", "python package metadata License field"
        if raw.lower() == "mit style":
            return "MIT", "python package metadata License field"
        if raw.lower().startswith("apache license") and "version 2.0" in raw.lower():
            return "Apache-2.0", "python package metadata License field"
        if len(raw) < 120 and (" AND " in raw or " OR " in raw):
            return raw, "python package metadata License-Expression/License field"
        for needle, expression in LICENSE_NORMALIZATIONS:
            if raw.lower() == needle.lower():
                return expression, "python package metadata License field"

    classifier_expressions = [
        CLASSIFIER_LICENSES[classifier] for classifier in classifiers if classifier in CLASSIFIER_LICENSES
    ]
    if classifier_expressions:
        joiner = " OR " if raw == "Dual License" else " AND "
        return joiner.join(dict.fromkeys(classifier_expressions)), "python package classifier"

    raise ValueError(
        "Unable to resolve package license from metadata; add a classifier mapping "
        "or manual override"
    )


def is_copyleft_expression(expression: str) -> bool:
    return bool(re.search(r"(^|[^A-Z])(A?GPL|LGPL|MPL|EPL|CDDL)(-|[^A-Z]|$)", expression.upper()))


def copyleft_classification(expression: str) -> str:
    upper = expression.upper()
    has_strong_gpl = bool(re.search(r"(^|[^A-Z])(A?GPL)(-|[^A-Z]|$)", upper))
    has_lgpl = "LGPL" in upper
    if "AGPL" in upper:
        return "network copyleft review required"
    if has_strong_gpl and has_lgpl:
        if "GCC-EXCEPTION" in upper:
            return (
                "mixed strong copyleft with GCC runtime exception and weak copyleft "
                "library obligations"
            )
        return "mixed strong and weak copyleft review required"
    if has_strong_gpl:
        return "strong copyleft review required if distributed/linked"
    if has_lgpl:
        return "weak copyleft library obligations if distributed/linked"
    return "file-level weak copyleft notice/source obligations"


def package_license(distribution: metadata.Distribution) -> PackageLicense:
    message: Message = distribution.metadata
    name = message.get("Name", "").strip()
    version = message.get("Version", "").strip()
    return package_license_from_metadata(name, version, message)


def package_license_from_metadata(name: str, version: str, message: Message) -> PackageLicense:
    manual = MANUAL_LICENSES.get(canonical_package_name(name))
    if manual:
        expression, evidence = manual
        return PackageLicense(name, version, expression, "manual", evidence)

    raw_license = message.get("License-Expression") or message.get("License") or ""
    classifiers = [c for c in message.get_all("Classifier") or [] if c.startswith("License ::")]
    try:
        expression, evidence = normalize_license(raw_license, classifiers)
    except ValueError as exc:
        raise ValueError(f"{exc} for {name} {version}") from exc
    return PackageLicense(name, version, expression, "metadata", evidence)


def installed_package_licenses() -> list[PackageLicense]:
    packages = [
        package_license(distribution)
        for distribution in metadata.distributions()
        if distribution.metadata.get("Name")
    ]
    return sorted(packages, key=lambda item: item.name.lower())


def locked_package_licenses() -> list[PackageLicense]:
    lock_data = tomllib.loads((ROOT / "uv.lock").read_text(encoding="utf-8"))
    installed = {
        canonical_package_name(distribution.metadata["Name"]): distribution
        for distribution in metadata.distributions()
        if distribution.metadata.get("Name")
    }
    packages: list[PackageLicense] = []
    for item in lock_data["package"]:
        name = str(item["name"])
        version = str(item.get("version") or "")
        canonical_name = canonical_package_name(name)
        manual = MANUAL_LICENSES.get(canonical_name)
        if manual:
            expression, evidence = manual
            packages.append(PackageLicense(name, version, expression, "manual", evidence))
        elif distribution := installed.get(canonical_name):
            packages.append(package_license_from_metadata(name, version, distribution.metadata))
        elif override := LOCKED_LICENSE_OVERRIDES.get(canonical_name):
            expression, evidence = override
            packages.append(PackageLicense(name, version, expression, "manual", evidence))
        else:
            raise ValueError(
                f"Unable to resolve locked package license for {name} {version}; "
                "install the package or add LOCKED_LICENSE_OVERRIDES entry"
            )
    return sorted(packages, key=lambda item: item.name.lower())


def write_reuse_toml() -> None:
    write_text(
        ROOT / "REUSE.toml",
        """version = 1

[[annotations]]
path = [
    "LICENSES/Apache-2.0.txt",
]
precedence = "override"
SPDX-FileCopyrightText = "Apache Software Foundation"
SPDX-License-Identifier = "Apache-2.0"

[[annotations]]
path = [
    "deploy/sandbox/linux-amd64/codex-linux-sandbox",
    "deploy/sandbox/linux-arm64/codex-linux-sandbox",
]
precedence = "override"
SPDX-FileCopyrightText = "2026 OpenAI"
SPDX-License-Identifier = "Apache-2.0"

[[annotations]]
path = [
    "**",
]
precedence = "aggregate"
SPDX-FileCopyrightText = "2026 SuperTale contributors"
SPDX-License-Identifier = "Elastic-2.0"
""",
    )


# NOTE: 不再从根 LICENSE 复制生成 LICENSES/Elastic-2.0.txt。license 正文按 REUSE
# 惯例只以 LICENSES/Elastic-2.0.txt 为唯一权威副本（静态、随仓库提交），避免根目录
# 再有一份重复的 LICENSE 让 GitHub 多出一个 License 标签。


def _inventory_row(path: str) -> dict[str, str]:
    for prefix, license_expression, copyright_text, evidence in THIRD_PARTY_PATH_OVERRIDES:
        if path.startswith(prefix):
            return {
                "path": path,
                "license_expression": license_expression,
                "copyright": copyright_text,
                "evidence": evidence,
            }
    return {
        "path": path,
        "license_expression": PROJECT_LICENSE,
        "copyright": COPYRIGHT,
        "evidence": "REUSE.toml aggregate annotation",
    }


def write_license_inventory(files: list[str]) -> None:
    rows = [
        _inventory_row(path)
        for path in sorted(set(files + [
            "REUSE.toml",
            "LICENSES/Apache-2.0.txt",
            "LICENSES/Elastic-2.0.txt",
            "license-inventory.csv",
            "NOTICE",
            "sbom.spdx.json",
            "docs/compliance/python-dependency-licenses.csv",
            "docs/compliance/npm-dependency-licenses.csv",
            "docs/compliance/system-deps.csv",
            "docs/compliance/copyleft-deps.csv",
            "docs/adr/0002-ffmpeg-system-dependency.md",
            "scripts/compliance/generate_p0b_artifacts.py",
        ]))
    ]
    write_csv(
        ROOT / "license-inventory.csv",
        ["path", "license_expression", "copyright", "evidence"],
        rows,
    )


def write_dependency_reports(packages: list[PackageLicense]) -> None:
    package_rows = [
        {
            "package": package.name,
            "version": package.version,
            "license_expression": package.license_expression,
            "source": package.source,
            "evidence": package.evidence,
        }
        for package in packages
    ]
    write_csv(
        ROOT / "docs/compliance/python-dependency-licenses.csv",
        ["package", "version", "license_expression", "source", "evidence"],
        package_rows,
    )

    write_csv(
        ROOT / "docs/compliance/npm-dependency-licenses.csv",
        ["package", "version", "license_expression", "source", "scope", "evidence"],
        [
            {
                "package": "@playcanvas/splat-transform",
                "version": "^2.0.3",
                "license_expression": "MIT",
                "source": "pyproject.toml [tool.supertale.external-tools.splat-transform]",
                "scope": "optional INSTALL_WORLD=1 Docker/runtime external tool",
                "evidence": "upstream package metadata and existing Dockerfile comment",
            }
        ],
    )

    write_csv(
        ROOT / "docs/compliance/system-deps.csv",
        ["name", "kind", "license_expression", "distribution_scope", "evidence", "notes"],
        [
            {
                "name": "ffmpeg",
                "kind": "system executable",
                "license_expression": "LGPL-2.1-or-later OR GPL-2.0-or-later",
                "distribution_scope": "not distributed in CE source snapshot; installed by user or OS package manager",
                "evidence": "Dockerfile apt-get install -y --no-install-recommends ffmpeg",
                "notes": "Actual license depends on build flags. Bundled binary distribution requires fresh audit.",
            },
            {
                "name": "ffprobe",
                "kind": "system executable",
                "license_expression": "LGPL-2.1-or-later OR GPL-2.0-or-later",
                "distribution_scope": "not distributed in CE source snapshot; installed by user or OS package manager",
                "evidence": "runtime subprocess calls in src/novelvideo",
                "notes": "Provided by the ffmpeg project/package.",
            },
            {
                "name": "Debian slim base packages",
                "kind": "container OS packages",
                "license_expression": "LicenseRef-Debian-Packages",
                "distribution_scope": "container runtime image only",
                "evidence": "Dockerfile FROM python:3.12-slim and apt package installation",
                "notes": "Refer to Debian package copyright files in the built image.",
            },
        ],
    )

    copyleft_rows: list[dict[str, str]] = []
    for package in packages:
        expression = package.license_expression
        if is_copyleft_expression(expression):
            copyleft_rows.append(
                {
                    "name": package.name,
                    "version": package.version,
                    "license_expression": expression,
                    "classification": copyleft_classification(expression),
                    "distribution_scope": "Python dependency in local CE environment",
                    "notes": package.evidence,
                }
            )
    copyleft_rows.extend(
        [
            {
                "name": "ffmpeg/ffprobe",
                "version": "system provided",
                "license_expression": "LGPL-2.1-or-later OR GPL-2.0-or-later",
                "classification": "external executable; license depends on system build flags",
                "distribution_scope": "not distributed in CE source snapshot",
                "notes": "See docs/adr/0002-ffmpeg-system-dependency.md.",
            },
            {
                "name": "sharp model weights",
                "version": "downloaded at runtime when optional world feature is used",
                "license_expression": "LicenseRef-Apple-ML-Research-Model",
                "classification": "restricted research model license, not copyleft",
                "distribution_scope": "not distributed in CE source snapshot or Docker image",
                "notes": "Do not bundle model weights in CE releases.",
            },
        ]
    )
    write_csv(
        ROOT / "docs/compliance/copyleft-deps.csv",
        [
            "name",
            "version",
            "license_expression",
            "classification",
            "distribution_scope",
            "notes",
        ],
        sorted(copyleft_rows, key=lambda row: row["name"].lower()),
    )


def write_notice(packages: list[PackageLicense]) -> None:
    attribution_names = [
        "certifi",
        "cognee",
        "da2",
        "edge-tts",
        "fastapi",
        "openai",
        "Pillow",
        "pydantic",
        "sharp",
        "typer",
        "uvicorn",
    ]
    package_index = {package.name.lower(): package for package in packages}
    lines = [
        "SuperTale CE NOTICE",
        "",
        "NOTICE-branding",
        "SuperTale, DramaClaw, DramaClawAPI, and related product names, logos,",
        "service names, and visual brand assets are brand identifiers of their",
        "respective owners. The Elastic License 2.0 grant for this repository does",
        "not grant trademark rights or permission to remove product attribution,",
        "branding notices, or other reserved-rights notices from distributed copies.",
        "",
        "Partner and sponsor logos shown in the project README (including Claymore AI",
        "Lab, 新飞翔科技 / Neo Flying Technology, 灵山 / L.Shan AI, and 钦新控股 / K-NOVA",
        "Holding Group) are trademarks of their respective owners, displayed with",
        "permission for attribution purposes only. No trademark rights in those marks",
        "are granted by the Elastic License 2.0.",
        "",
        "Project License",
        "This repository is licensed under the Elastic License 2.0. See LICENSE.",
        "",
        "Third-Party Notices",
        "This product depends on third-party software. The machine-readable",
        "dependency evidence is in docs/compliance/python-dependency-licenses.csv,",
        "docs/compliance/npm-dependency-licenses.csv, and docs/compliance/system-deps.csv.",
        "",
        "Selected runtime dependencies requiring attribution:",
    ]
    for name in attribution_names:
        package = package_index.get(name.lower())
        if package:
            lines.append(f"- {package.name} {package.version}: {package.license_expression}")
    lines.extend(
        [
            "- @playcanvas/splat-transform ^2.0.3: MIT; optional world asset conversion tool",
            "- ffmpeg/ffprobe: external system executables; license depends on the user's system build",
            "",
            "Restricted Optional Components",
            "The optional world feature can use apple/ml-sharp and its model assets. The source",
            "package includes Apple software and model license files in upstream distributions.",
            "CE source releases and Docker images must not bundle Apple model weights.",
            "",
            "Generated Evidence",
            "Regenerate these files with:",
            "  uv run python scripts/compliance/generate_p0b_artifacts.py",
            "",
        ]
    )
    write_text(ROOT / "NOTICE", "\n".join(lines))


def write_ffmpeg_adr() -> None:
    write_text(
        ROOT / "docs/adr/0002-ffmpeg-system-dependency.md",
        """# ADR-0002: Treat ffmpeg as a System Dependency

Date: 2026-06-25

## Status

Accepted.

## Context

SuperTale CE calls `ffmpeg` and `ffprobe` for media probing, extraction,
composition, transcoding, and final MP4 validation. ffmpeg builds can be licensed
under LGPL or GPL depending on enabled codecs and build flags. Shipping a binary
inside the CE source snapshot or release package would therefore require a
separate binary provenance, build-flag, notice, and source-offer review.

## Decision

The CE source repository does not distribute ffmpeg or ffprobe binaries. The
runtime expects `ffmpeg` and `ffprobe` to be supplied by the user's operating
system, package manager, or deployment image. The Dockerfile installs ffmpeg from
the base distribution package repositories as an image runtime dependency; the
source repository still does not vendor ffmpeg binaries.

## Consequences

- P0-B treats ffmpeg/ffprobe as system dependencies, recorded in
  `docs/compliance/system-deps.csv`.
- Users are responsible for choosing a compatible ffmpeg build for their
  environment and legal obligations.
- Any future change that bundles ffmpeg binaries, caches ffmpeg archives, or
  publishes ffmpeg inside installers must reopen this ADR and audit the exact
  build flags, especially `--enable-gpl` and nonfree codec options.
- Release gates should reject committed ffmpeg binaries and should not infer that
  a system ffmpeg is LGPL-only without inspecting the actual binary build.
""",
    )


def write_sbom(packages: list[PackageLicense]) -> None:
    root_package_name = "supertale-ce"
    root_spdx_id = "SPDXRef-Package-supertale-ce"
    version = project_version()
    package_entries = [
        {
            "SPDXID": root_spdx_id,
            "name": root_package_name,
            "downloadLocation": "NOASSERTION",
            "filesAnalyzed": False,
            "licenseConcluded": PROJECT_LICENSE,
            "licenseDeclared": PROJECT_LICENSE,
            "copyrightText": f"Copyright {COPYRIGHT}",
            "versionInfo": version,
        }
    ]
    relationships = []
    seen_spdx_ids = {root_spdx_id}
    for package in packages:
        if canonical_package_name(package.name) == canonical_package_name(root_package_name):
            continue
        spdx_id = "SPDXRef-Package-" + package.name.lower().replace("_", "-").replace(".", "-")
        if spdx_id in seen_spdx_ids:
            raise ValueError(f"Duplicate SPDX package id generated for {package.name}: {spdx_id}")
        seen_spdx_ids.add(spdx_id)
        package_entries.append(
            {
                "SPDXID": spdx_id,
                "name": package.name,
                "downloadLocation": "NOASSERTION",
                "filesAnalyzed": False,
                "licenseConcluded": package.license_expression,
                "licenseDeclared": package.license_expression,
                "copyrightText": "NOASSERTION",
                "versionInfo": package.version,
            }
        )
        relationships.append(
            {
                "spdxElementId": root_spdx_id,
                "relationshipType": "DEPENDS_ON",
                "relatedSpdxElement": spdx_id,
            }
        )
    namespace_seed = json.dumps(
        {
            "name": root_package_name,
            "version": version,
            "packages": [
                [entry["name"], entry.get("versionInfo", ""), entry["licenseDeclared"]]
                for entry in package_entries
            ],
        },
        sort_keys=True,
        separators=(",", ":"),
    )
    document_namespace = (
        "https://supertale.local/spdx/supertale-ce/"
        + hashlib.sha256(namespace_seed.encode("utf-8")).hexdigest()[:16]
    )
    sbom = {
        "spdxVersion": "SPDX-2.3",
        "dataLicense": "CC0-1.0",
        "SPDXID": "SPDXRef-DOCUMENT",
        "name": "supertale-ce-p0b-sbom",
        "documentNamespace": document_namespace,
        "creationInfo": {
            "created": SBOM_CREATED,
            "creators": ["Tool: scripts/compliance/generate_p0b_artifacts.py"],
        },
        "packages": package_entries,
        "relationships": relationships,
    }
    write_text(ROOT / "sbom.spdx.json", json.dumps(sbom, indent=2, sort_keys=True) + "\n")


def project_version() -> str:
    data = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))
    return str(data["project"]["version"])


def update_readme_notice_reference() -> None:
    readme_path = ROOT / "README.md"
    readme = readme_path.read_text(encoding="utf-8").rstrip()
    marker = "See `NOTICE` for required branding and third-party attribution notices."
    if marker not in readme:
        readme += "\n\n## Notices\n\n" + marker + "\n"
    write_text(readme_path, readme + "\n")


def main() -> None:
    files = run_git_ls_files()
    packages = locked_package_licenses()
    write_reuse_toml()
    write_license_inventory(files)
    write_dependency_reports(packages)
    write_notice(packages)
    write_ffmpeg_adr()
    write_sbom(packages)
    update_readme_notice_reference()


if __name__ == "__main__":
    main()
