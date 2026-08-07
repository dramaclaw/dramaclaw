#!/usr/bin/env python3
"""Publish an immutable official media catalog and its manifest to OSS."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from novelvideo.model_gateway_settings import _validate_official_media_catalog

_REVISION_RE = re.compile(r"^[0-9a-f]{7,64}$")


@dataclass(frozen=True)
class CatalogPublication:
    catalog_bytes: bytes
    catalog_key: str
    manifest: dict[str, Any]
    manifest_bytes: bytes
    manifest_key: str


def _canonical_json_bytes(payload: object) -> bytes:
    return json.dumps(
        payload,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


def _normalize_prefix(prefix: str) -> str:
    raw = str(prefix or "").strip()
    value = raw.strip("/")
    if not value or raw.startswith("/") or ".." in value.split("/"):
        raise ValueError("OSS prefix must be a non-empty relative path")
    return value


def build_publication(
    payload: object,
    *,
    revision: str,
    published_at: str,
    prefix: str,
) -> CatalogPublication:
    validated = _validate_official_media_catalog(payload)
    normalized_revision = str(revision or "").strip().lower()
    if not _REVISION_RE.fullmatch(normalized_revision):
        raise ValueError("revision must be a 7-64 character hexadecimal Git SHA")
    try:
        parsed_time = datetime.fromisoformat(
            str(published_at or "").strip().replace("Z", "+00:00")
        )
    except ValueError as exc:
        raise ValueError("published-at must be an ISO-8601 timestamp") from exc
    if parsed_time.tzinfo is None:
        raise ValueError("published-at must include a timezone")

    normalized_prefix = _normalize_prefix(prefix)
    catalog_bytes = _canonical_json_bytes(validated)
    digest = hashlib.sha256(catalog_bytes).hexdigest()
    relative_catalog_path = f"catalogs/{digest}.json"
    manifest = {
        "schemaVersion": 1,
        "catalogVersion": str(validated["catalogVersion"]),
        "revision": normalized_revision,
        "publishedAt": str(published_at).strip(),
        "sha256": digest,
        "path": relative_catalog_path,
    }
    return CatalogPublication(
        catalog_bytes=catalog_bytes,
        catalog_key=f"{normalized_prefix}/{relative_catalog_path}",
        manifest=manifest,
        manifest_bytes=_canonical_json_bytes(manifest),
        manifest_key=f"{normalized_prefix}/manifest.json",
    )


def _git_revision() -> str:
    configured = str(os.environ.get("GITHUB_SHA", "") or "").strip()
    if configured:
        return configured
    result = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        check=True,
        capture_output=True,
        text=True,
    )
    return result.stdout.strip()


def _required_env(name: str) -> str:
    value = str(os.environ.get(name, "") or "").strip()
    if not value:
        raise ValueError(f"{name} is required")
    return value


def _upload(publication: CatalogPublication) -> None:
    import oss2

    auth = oss2.Auth(
        _required_env("OFFICIAL_CATALOG_OSS_ACCESS_KEY_ID"),
        _required_env("OFFICIAL_CATALOG_OSS_ACCESS_KEY_SECRET"),
    )
    bucket = oss2.Bucket(
        auth,
        _required_env("OFFICIAL_CATALOG_OSS_ENDPOINT"),
        _required_env("OFFICIAL_CATALOG_OSS_BUCKET"),
    )
    bucket.put_object(
        publication.catalog_key,
        publication.catalog_bytes,
        headers={
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "public, max-age=31536000, immutable",
        },
    )
    # Publish the mutable pointer last. OSS object PUT is atomic, so readers see
    # either the previous complete release or this complete release.
    bucket.put_object(
        publication.manifest_key,
        publication.manifest_bytes,
        headers={
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "public, max-age=60, must-revalidate",
        },
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--catalog",
        type=Path,
        default=Path("src/novelvideo/official_media_models.json"),
    )
    parser.add_argument(
        "--prefix",
        default=os.environ.get(
            "OFFICIAL_CATALOG_OSS_PREFIX", "official-media-catalog"
        )
        or "official-media-catalog",
    )
    parser.add_argument("--revision", default="")
    parser.add_argument("--published-at", default="")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    payload = json.loads(args.catalog.read_text(encoding="utf-8"))
    publication = build_publication(
        payload,
        revision=args.revision or _git_revision(),
        published_at=args.published_at
        or datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        prefix=args.prefix,
    )
    if not args.dry_run:
        _upload(publication)
    print(
        json.dumps(
            {
                "dryRun": bool(args.dry_run),
                "catalogKey": publication.catalog_key,
                "manifestKey": publication.manifest_key,
                "manifest": publication.manifest,
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
