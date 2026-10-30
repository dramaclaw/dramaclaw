"""Bundled Ladybug JSON extension for the pinned Ladybug version.

extension.ladybugdb.com no longer hosts the pinned version, so Ladybug's
on-demand ``INSTALL JSON`` fails with HTTP 404. The unmodified upstream
libraries ship in ``assets/ladybug-json`` and are loaded by absolute path.
"""

from __future__ import annotations

import hashlib
import json
import platform
from importlib.metadata import version
from pathlib import Path


_BUNDLE_DIR = Path(__file__).resolve().parent / "assets" / "ladybug-json"
_PLATFORMS = {
    ("Linux", "x86_64"): "linux_amd64",
    ("Linux", "aarch64"): "linux_arm64",
    ("Darwin", "arm64"): "osx_arm64",
    ("Darwin", "x86_64"): "osx_amd64",
    ("Windows", "AMD64"): "win_amd64",
}


def bundled_json_extension() -> Path | None:
    """Return the verified library for this platform, or None if none is bundled."""
    target = _PLATFORMS.get((platform.system(), platform.machine()))
    if target is None:
        return None

    installed = version("ladybug")
    library = _BUNDLE_DIR / installed / f"libjson-{target}.lbug_extension"
    sums_file = _BUNDLE_DIR / installed / "SHA256SUMS"
    if not sums_file.is_file():
        raise RuntimeError(
            f"No bundled Ladybug JSON extension for Ladybug {installed}; "
            "update src/novelvideo/assets/ladybug-json together with Ladybug."
        )
    expected = {
        name: digest
        for digest, name in (
            line.split() for line in sums_file.read_text().splitlines() if line.strip()
        )
    }.get(library.name)
    try:
        actual = hashlib.sha256(library.read_bytes()).hexdigest()
    except FileNotFoundError as exc:
        raise RuntimeError(
            f"Bundled Ladybug JSON extension is missing: {library}"
        ) from exc
    if actual != expected:
        raise RuntimeError(
            f"Bundled Ladybug JSON extension SHA256 mismatch for {library.name}: "
            f"expected {expected}, got {actual}"
        )
    return library


def load_bundled_json_extension(connection, library: Path) -> None:
    # JSON quoting also escapes paths containing quotes or backslashes.
    connection.execute(f"LOAD EXTENSION {json.dumps(str(library))};")


def verify_bundled_json_extension() -> None:
    """CI/image preflight: verify the bytes, then load the library and use it."""
    from ladybug import Connection, Database

    library = bundled_json_extension()
    if library is None:
        raise RuntimeError(
            f"No bundled Ladybug JSON extension for {platform.system()} {platform.machine()}"
        )
    database = Database(
        None, buffer_pool_size=64 * 1024 * 1024, max_db_size=256 * 1024 * 1024
    )
    connection = Connection(database)
    try:
        load_bundled_json_extension(connection, library)
        result = connection.execute("RETURN to_json({ok: 1});")
        actual = result.get_next()
        result.close()
        if actual != ['{"ok":1}']:
            raise RuntimeError(f"Ladybug JSON extension smoke test failed: {actual}")
    finally:
        connection.close()
        database.close()
    print(f"Verified bundled Ladybug JSON extension: {library}")


if __name__ == "__main__":
    verify_bundled_json_extension()
