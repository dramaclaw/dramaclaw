"""Regression coverage for the backup/control-plane boundary.

``files_sync`` is a local-files backup command.  EE canvas JSON lives in OSS
and is protected by OSS durability/versioning, so carrying an EE ports adapter
must not turn ``ST_CONTROL_PLANE_DSN`` into a backup-process prerequisite.
"""

from __future__ import annotations

import importlib
from pathlib import Path

import pytest

from novelvideo.backup.files_sync import snapshot_hot_state

ADAPTER_ENTRY_POINT_GROUP = "novelvideo.ports_bootstrap"


def _install_external_ports_adapter(site_dir: Path) -> Path:
    dist_info = site_dir / "external_ports_adapter-0.0.0.dist-info"
    dist_info.mkdir(parents=True)
    (dist_info / "METADATA").write_text(
        "Metadata-Version: 2.1\nName: external-ports-adapter\nVersion: 0.0.0\n",
        encoding="utf-8",
    )
    (dist_info / "entry_points.txt").write_text(
        f"[{ADAPTER_ENTRY_POINT_GROUP}]\n"
        "adapter = external_ports_adapter.ports_bootstrap:register\n",
        encoding="utf-8",
    )
    return site_dir


@pytest.fixture
def external_adapter_install(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    site_dir = _install_external_ports_adapter(tmp_path / "site-packages")
    monkeypatch.syspath_prepend(str(site_dir))
    importlib.invalidate_caches()
    yield
    importlib.invalidate_caches()


def test_snapshot_does_not_require_control_plane_dsn(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    external_adapter_install,
) -> None:
    monkeypatch.delenv("ST_CONTROL_PLANE_DSN", raising=False)
    state_dir = tmp_path / "state"
    canvas = state_dir / "user" / "project" / "freezone" / "canvases" / "canvas.json"
    canvas.parent.mkdir(parents=True)
    canvas.write_text('{"revision": 3}', encoding="utf-8")
    snapshot_dir = tmp_path / "snapshot"

    roots, files, copied_bytes = snapshot_hot_state(state_dir, snapshot_dir)

    staged = snapshot_dir / canvas.relative_to(state_dir)
    assert (roots, files) == (2, 1)
    assert copied_bytes > 0
    assert staged.read_text(encoding="utf-8") == '{"revision": 3}'
