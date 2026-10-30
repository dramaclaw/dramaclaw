"""Promote accepted image indexes without rebuilding the tested bytes."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import time

PACKAGING_REPOSITORY_ID = "1127546821"
# Existing packaging publisher account; token ownership changes require review.
PACKAGING_PUBLISHER_ID = 1857277
REPOSITORIES = ("dramaclaw", "dramaclaw-frontend")
SHA = re.compile(r"[0-9a-f]{40}")
DIGEST = re.compile(r"sha256:[0-9a-f]{64}")
TAG = re.compile(r"v[0-9]+\.[0-9]+\.[0-9]+(?:[.-][0-9A-Za-z.-]+)?")
PHASES = ["fresh-install", "retained-data-upgrade"]


class PromotionError(ValueError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise PromotionError(message)


def validate_release_asset(release: dict, tag: str, payload: bytes) -> None:
    """Authenticate the receipt through GitHub asset metadata, not JSON claims."""
    require(
        release.get("tag_name") == tag and release.get("draft") is False,
        "Promotion requires the published release",
    )
    assets = [
        a
        for a in release.get("assets", [])
        if a.get("name") == "release-image-acceptance.json"
    ]
    require(len(assets) == 1, "Missing or ambiguous image acceptance asset")
    asset = assets[0]
    require(
        asset.get("uploader", {}).get("id") == PACKAGING_PUBLISHER_ID,
        "Acceptance asset was not uploaded by the trusted packaging publisher",
    )
    require(
        asset.get("size") == len(payload)
        and asset.get("digest") == "sha256:" + hashlib.sha256(payload).hexdigest(),
        "Downloaded acceptance asset differs from GitHub metadata",
    )


def validate_receipt(
    data: dict, tag: str, source: str, *, benchmark: bool = False
) -> str:
    require(
        bool(TAG.fullmatch(tag)) and bool(SHA.fullmatch(source)),
        "Invalid source identity",
    )
    require(data.get("schema_version") == 1, "Unsupported acceptance receipt")
    require(
        data.get("release_tag") == tag and data.get("source_sha") == source,
        "Acceptance source/tag mismatch",
    )
    issuer = data.get("issuer", {})
    require(
        str(issuer.get("repository_id")) == PACKAGING_REPOSITORY_ID,
        "Unexpected acceptance issuer",
    )
    require(
        issuer.get("workflow") == ".github/workflows/dramaclaw-release-packages.yml",
        "Unexpected acceptance workflow",
    )
    require(
        isinstance(issuer.get("run_id"), int) and issuer["run_id"] > 0,
        "Missing acceptance run",
    )
    require(
        bool(SHA.fullmatch(str(issuer.get("sha", "")))), "Missing packaging source SHA"
    )
    image_tag = data.get("image_tag", "")
    if benchmark:
        require(
            bool(re.fullmatch(r"ci-" + source + r"-[1-9][0-9]*", image_tag)),
            "Invalid benchmark image tag",
        )
    else:
        require(image_tag == tag[1:], "A candidate tag cannot be promoted to a release")
    chat = data.get("chat", {})
    require(
        chat.get("ok") is True and chat.get("backend") == "codex",
        "Chat acceptance did not pass",
    )
    require(
        chat.get("entrypoint") == "/api/v1/chat/ws" and chat.get("phases") == PHASES,
        "Missing actual chat/upgrade acceptance",
    )
    require(chat.get("responsesRequests") == 2, "Missing Responses round trips")
    for key in ("packagedSkillResourcesVerified", "skillLocatorSent"):
        require(chat.get(key) is True, "Missing packaged Skill acceptance")
    require(
        chat.get("credentialsPersistedInRuntime") is False,
        "Runtime credential persistence",
    )
    protocol = data.get("protocol", {})
    require(
        protocol.get("ok") is True
        and protocol.get("backend") == "codex"
        and protocol.get("turns") == 2,
        "Protocol acceptance did not pass",
    )
    require(
        protocol.get("rotating_auth") is True
        and protocol.get("credentials_persisted") is False,
        "Missing credential protection acceptance",
    )
    require(protocol.get("packaged_hermes_absent") is True, "Retired runtime present")
    images = data.get("images", {})
    require(set(images) == set(REPOSITORIES), "Incomplete image set")
    for image in images.values():
        require(
            bool(DIGEST.fullmatch(str(image.get("digest", "")))),
            "Invalid image index digest",
        )
        require(
            set(image.get("platforms", [])) == {"linux/amd64", "linux/arm64"},
            "Missing image architecture",
        )
    return image_tag


def inspect(ref: str, field: str = "Manifest") -> dict:
    return json.loads(
        subprocess.check_output(
            [
                "docker",
                "buildx",
                "--builder",
                "default",
                "imagetools",
                "inspect",
                "--format",
                "{{json ." + field + "}}",
                ref,
            ]
        )
    )


def promote(
    data: dict,
    tag: str,
    source: str,
    *,
    benchmark: bool = False,
    latest: bool = False,
    dry_run: bool = False,
) -> dict:
    image_tag = validate_receipt(data, tag, source, benchmark=benchmark)
    require(not (benchmark and latest), "Benchmark promotion cannot update latest")
    planned = []
    # Validate every platform/config before changing any tag.
    for name in REPOSITORIES:
        repository = "docker.io/claymorelab/" + name
        digest = data["images"][name]["digest"]
        require(
            inspect(repository + ":" + image_tag)["digest"] == digest,
            "Accepted image tag changed",
        )
        index = inspect(repository + "@" + digest)
        require(index["digest"] == digest, "Unexpected index identity")
        platforms = {
            m.get("platform", {}).get("architecture"): m
            for m in index.get("manifests", [])
            if m.get("platform", {}).get("os") == "linux"
        }
        require(
            {"amd64", "arm64"} <= set(platforms), "Accepted index lost an architecture"
        )
        for arch in ("amd64", "arm64"):
            config = inspect(repository + "@" + platforms[arch]["digest"], "Image")
            labels = config.get("config", {}).get("Labels", {})
            require(
                config.get("architecture") == arch and config.get("os") == "linux",
                "Wrong image platform",
            )
            require(
                labels.get("org.opencontainers.image.revision") == source,
                "Image source label mismatch",
            )
            require(
                labels.get("org.opencontainers.image.version") == tag[1:],
                "Image version label mismatch",
            )
        targets = (
            [image_tag + "-promoted"] if benchmark else (["latest"] if latest else [])
        )
        planned.append({"repository": repository, "digest": digest, "targets": targets})
    started = time.monotonic()
    if not dry_run:
        for image in planned:
            for target in image["targets"]:
                ref = image["repository"] + ":" + target
                subprocess.run(
                    [
                        "docker",
                        "buildx",
                        "--builder",
                        "default",
                        "imagetools",
                        "create",
                        "--tag",
                        ref,
                        image["repository"] + "@" + image["digest"],
                    ],
                    check=True,
                )
                require(
                    inspect(ref)["digest"] == image["digest"],
                    "Promoted digest mismatch",
                )
    return {
        "ok": True,
        "source_sha": source,
        "release_tag": tag,
        "rebuilt": False,
        "dry_run": dry_run,
        "images": planned,
        "promotion_seconds": round(time.monotonic() - started, 2),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--receipt", type=Path, required=True)
    parser.add_argument("--release-tag", required=True)
    parser.add_argument("--source-sha", required=True)
    parser.add_argument("--release-metadata", type=Path)
    parser.add_argument("--benchmark", action="store_true")
    parser.add_argument("--latest", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    payload = args.receipt.read_bytes()
    if not args.benchmark:
        require(args.release_metadata is not None, "Release asset metadata is required")
        validate_release_asset(
            json.loads(args.release_metadata.read_text()), args.release_tag, payload
        )
    result = promote(
        json.loads(payload),
        args.release_tag,
        args.source_sha,
        benchmark=args.benchmark,
        latest=args.latest,
        dry_run=args.dry_run,
    )
    args.output.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result))


if __name__ == "__main__":
    main()
