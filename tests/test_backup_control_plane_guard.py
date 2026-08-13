"""The backup snapshot must not run without cross-node canvas mutual exclusion.

``snapshot_hot_state`` copies live canvas state while holding
``canvas_write_lock``. That lock is a per-node file lock, so it only excludes
writers that share the same filesystem. An install that carries an external
ports adapter is a multi-node install: there the writer lock belongs to the
control plane, and a backup process that cannot reach the control plane would
copy canvases with no mutual exclusion at all — a torn snapshot that only
surfaces at restore time. Such a process must fail loudly instead.

"An external adapter is mixed into this install" is spelled here the way the
repo already spells it: a non-empty ``novelvideo.ports_bootstrap`` entry point
group (``scripts/check_ce_port_closure.py`` rule 3,
``novelvideo/ports/registry.py:68``). A single-node install has an empty group
and keeps the file lock, so the guard never fires there.
"""

from __future__ import annotations

import importlib
import os
import subprocess
import sys
from contextlib import contextmanager
from pathlib import Path

import pytest

from novelvideo.backup import files_sync as files_sync_module
from novelvideo.backup.files_sync import snapshot_hot_state
from novelvideo.freezone.canvas_lock import canvas_write_lock

ADAPTER_ENTRY_POINT_GROUP = "novelvideo.ports_bootstrap"


def _install_external_ports_adapter(site_dir: Path) -> Path:
    """Publish an external ports adapter to ``importlib.metadata``.

    Only the distribution metadata is written: the guard must decide from
    packaging facts alone and must never import or execute adapter code.
    """

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
def multi_node_install(tmp_path, monkeypatch):
    site_dir = _install_external_ports_adapter(tmp_path / "site-packages")
    monkeypatch.syspath_prepend(str(site_dir))
    importlib.invalidate_caches()
    yield site_dir
    importlib.invalidate_caches()


@pytest.fixture
def canvas_state(tmp_path):
    state_dir = tmp_path / "state"
    project_dir = state_dir / "user" / "project"
    canvas = project_dir / "freezone" / "canvases" / "canvas.json"
    idempotency = project_dir / "freezone" / "canvas_idempotency" / "canvas.json"
    canvas.parent.mkdir(parents=True)
    idempotency.parent.mkdir(parents=True)
    canvas.write_text('{"revision": 3}', encoding="utf-8")
    idempotency.write_text('{"entries": []}', encoding="utf-8")
    return state_dir, project_dir, canvas


def _lock_files(project_dir: Path) -> list[Path]:
    locks_dir = project_dir / "freezone" / "canvases" / "_locks"
    return sorted(locks_dir.glob("*.lock")) if locks_dir.is_dir() else []


@pytest.mark.parametrize("dsn", (None, "", "   "))
def test_snapshot_refuses_multi_node_install_without_control_plane(
    monkeypatch,
    tmp_path,
    multi_node_install,
    canvas_state,
    dsn,
):
    state_dir, project_dir, _ = canvas_state
    if dsn is None:
        monkeypatch.delenv("ST_CONTROL_PLANE_DSN", raising=False)
    else:
        monkeypatch.setenv("ST_CONTROL_PLANE_DSN", dsn)
    snapshot_dir = tmp_path / "snapshot"

    with pytest.raises(files_sync_module.ControlPlaneUnavailableError) as caught:
        snapshot_hot_state(state_dir, snapshot_dir)

    message = str(caught.value)
    assert "ST_CONTROL_PLANE_DSN" in message
    assert ADAPTER_ENTRY_POINT_GROUP in message
    # The refusal happens before any staging and before the writer lock is ever
    # taken, so no half-protected snapshot can exist.
    assert not snapshot_dir.exists()
    assert _lock_files(project_dir) == []


def test_snapshot_is_unchanged_on_a_single_node_install(
    monkeypatch,
    tmp_path,
    canvas_state,
):
    """No external adapter: the file lock is sound, the guard must not fire."""

    state_dir, project_dir, canvas = canvas_state
    monkeypatch.delenv("ST_CONTROL_PLANE_DSN", raising=False)
    snapshot_dir = tmp_path / "snapshot"

    roots, files, copied_bytes = snapshot_hot_state(state_dir, snapshot_dir)

    staged = snapshot_dir / canvas.relative_to(state_dir)
    # Three roots: canvases, canvas_idempotency, and the freezone dir itself
    # (the ``("", "stale_marks.json")`` spec in ``_HOT_STATE_SPECS``).
    assert (roots, files) == (3, 2)
    assert copied_bytes > 0
    assert staged.read_text(encoding="utf-8") == '{"revision": 3}'
    # The real per-node lock really was taken.
    assert [path.name for path in _lock_files(project_dir)] == ["canvas.lock"]


def test_reachable_control_plane_keeps_the_writer_lock_call_shape(
    monkeypatch,
    tmp_path,
    multi_node_install,
    canvas_state,
):
    state_dir, project_dir, canvas = canvas_state
    monkeypatch.setenv("ST_CONTROL_PLANE_DSN", "postgresql://control-plane/db")
    lock_calls = []

    @contextmanager
    def recording_lock(locked_project_dir, canvas_id, **kwargs):
        lock_calls.append((locked_project_dir, canvas_id, kwargs))
        with canvas_write_lock(locked_project_dir, canvas_id, **kwargs):
            yield

    monkeypatch.setattr(files_sync_module, "canvas_write_lock", recording_lock)
    snapshot_dir = tmp_path / "snapshot"

    roots, files, copied_bytes = snapshot_hot_state(state_dir, snapshot_dir)

    assert lock_calls == [(project_dir, "canvas", {"timeout_seconds": 10.0})]
    assert (roots, files) == (3, 2)
    assert copied_bytes > 0
    staged = snapshot_dir / canvas.relative_to(state_dir)
    assert staged.read_text(encoding="utf-8") == '{"revision": 3}'


def test_files_sync_process_exits_nonzero_without_control_plane(
    tmp_path,
    canvas_state,
):
    """End-to-end: the CLI process itself must exit non-zero and say what is missing.

    ``ST_EDITION=ce`` is what the deployed backup container reports today, so
    ``require_legacy_local_service_operation`` lets the run start; the external
    adapter in the image is what makes the file lock insufficient.
    """

    state_dir, _, _ = canvas_state
    site_dir = _install_external_ports_adapter(tmp_path / "cli-site-packages")
    src_root = Path(files_sync_module.__file__).resolve().parents[2]
    env = {
        key: value
        for key, value in os.environ.items()
        if key not in {"ST_CONTROL_PLANE_DSN", "PYTHONPATH"}
    }
    env.update(
        PYTHONPATH=os.pathsep.join((str(site_dir), str(src_root))),
        ST_EDITION="ce",
        NOVELVIDEO_STATE_DIR=str(state_dir),
        BACKUP_STAGE_DIR=str(tmp_path / "stage"),
        BACKUP_SYNC_OUTPUT="0",
        BACKUP_OSS_BUCKET="bucket",
        BACKUP_OSS_PREFIX="backup/env/node",
        BACKUP_OSS_ENDPOINT="oss-cn-example.invalid",
        BACKUP_OSS_AK="ak",
        BACKUP_OSS_SK="sk",
    )

    # Without the guard this run reaches ``rclone sync`` against the unreachable
    # endpoint above and blocks on its retries, so the call is bounded: a timeout
    # here means the refusal did not happen.
    result = subprocess.run(
        [sys.executable, "-m", "novelvideo.backup.files_sync"],
        cwd=tmp_path,
        env=env,
        capture_output=True,
        text=True,
        timeout=60,
    )

    output = result.stdout + result.stderr
    assert result.returncode != 0
    assert "ST_CONTROL_PLANE_DSN" in output
    # It must stop at the guard, not somewhere downstream of a finished snapshot.
    assert "backup_snapshot_failed" in output
    assert "backup_snapshot_complete" not in output
