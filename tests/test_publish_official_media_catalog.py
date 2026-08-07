from __future__ import annotations

import hashlib
import importlib.util
import json
import subprocess
import sys
from pathlib import Path

import pytest


def _publisher_module():
    path = Path(__file__).parents[1] / "scripts" / "publish_official_media_catalog.py"
    spec = importlib.util.spec_from_file_location("publish_official_media_catalog", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def test_build_publication_uses_content_addressed_catalog_path():
    publisher = _publisher_module()
    payload = json.loads(
        (Path(__file__).parents[1] / "src/novelvideo/official_media_models.json")
        .read_text(encoding="utf-8")
    )

    publication = publisher.build_publication(
        payload,
        revision="a" * 40,
        published_at="2026-08-07T12:00:00Z",
        prefix="official-media-catalog",
    )

    digest = hashlib.sha256(publication.catalog_bytes).hexdigest()
    assert publication.catalog_key == f"official-media-catalog/catalogs/{digest}.json"
    assert publication.manifest_key == "official-media-catalog/manifest.json"
    assert publication.manifest == {
        "schemaVersion": 1,
        "catalogVersion": payload["catalogVersion"],
        "revision": "a" * 40,
        "publishedAt": "2026-08-07T12:00:00Z",
        "sha256": digest,
        "path": f"catalogs/{digest}.json",
    }
    assert json.loads(publication.catalog_bytes) == payload
    assert json.loads(publication.manifest_bytes) == publication.manifest


@pytest.mark.parametrize("prefix", ["", "/", "../catalog", "catalog/../escape"])
def test_build_publication_rejects_unsafe_prefix(prefix):
    publisher = _publisher_module()
    payload = json.loads(
        (Path(__file__).parents[1] / "src/novelvideo/official_media_models.json")
        .read_text(encoding="utf-8")
    )

    with pytest.raises(ValueError, match="prefix"):
        publisher.build_publication(
            payload,
            revision="b" * 40,
            published_at="2026-08-07T12:00:00Z",
            prefix=prefix,
        )


def test_publisher_dry_run_in_isolated_stdlib_interpreter():
    root = Path(__file__).parents[1]
    script = root / "scripts" / "publish_official_media_catalog.py"
    source = root / "src"
    command = (
        "import runpy,sys;"
        f"sys.path.insert(0,{str(source)!r});"
        f"sys.argv=[{str(script)!r},'--dry-run','--revision',{'c' * 40!r},"
        "'--published-at','2026-08-07T12:00:00Z'];"
        f"runpy.run_path({str(script)!r},run_name='__main__')"
    )

    completed = subprocess.run(
        [sys.executable, "-I", "-S", "-c", command],
        cwd=root,
        check=True,
        capture_output=True,
        text=True,
    )

    result = json.loads(completed.stdout)
    assert result["dryRun"] is True
    assert result["manifestKey"] == "official-media-catalog/manifest.json"
