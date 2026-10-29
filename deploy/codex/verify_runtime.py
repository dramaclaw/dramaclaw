"""Verify the pinned credential-safe Codex artifact before shipping a CE image."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

TARGETS = {
    "amd64": "x86_64-unknown-linux-musl",
    "arm64": "aarch64-unknown-linux-musl",
}
REQUIRED_TESTS = {
    "debug_redacts_responses_api_client_metadata_values",
    "turn_metadata_extracts_dramaclaw_gateway_key_without_serializing_it",
    "turn_scoped_responses_auth_replaces_the_provider_placeholder",
}


def verify_runtime(
    binary: Path, metadata: Path, ref_file: Path, *, ref: str, version: str, arch: str
) -> None:
    manifest = json.loads(metadata.read_text(encoding="utf-8"))
    expected = {
        "repo": "https://github.com/claymorelab/codex",
        "commit": ref,
        "upstream_version": version,
        "target": TARGETS[arch],
    }
    for key, value in expected.items():
        if manifest.get(key) != value:
            raise ValueError(f"Codex runtime {key} mismatch")
    if ref_file.read_text(encoding="utf-8").strip() != ref:
        raise ValueError("Codex runtime ref file mismatch")
    if not REQUIRED_TESTS.issubset(manifest.get("tests", [])):
        raise ValueError("Codex runtime is missing credential-safety test evidence")
    if binary.stat().st_size != manifest.get("bytes"):
        raise ValueError("Codex runtime binary size mismatch")
    with binary.open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    if digest != manifest.get("sha256"):
        raise ValueError("Codex runtime binary SHA256 mismatch")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ref", required=True)
    parser.add_argument("--version", required=True)
    parser.add_argument("--arch", choices=sorted(TARGETS), required=True)
    parser.add_argument(
        "--binary", type=Path, default=Path("/usr/local/bin/codex-dramaclaw")
    )
    parser.add_argument(
        "--metadata", type=Path, default=Path("/opt/codex-runtime.json")
    )
    parser.add_argument("--ref-file", type=Path, default=Path("/opt/codex-runtime.sha"))
    args = parser.parse_args()
    verify_runtime(
        args.binary,
        args.metadata,
        args.ref_file,
        ref=args.ref,
        version=args.version,
        arch=args.arch,
    )


if __name__ == "__main__":
    main()
