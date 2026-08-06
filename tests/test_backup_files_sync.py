"""files_sync filter, staging snapshot, and command tests."""

from pathlib import Path
from subprocess import CompletedProcess

import pytest

from novelvideo.backup import files_sync as files_sync_module

from novelvideo.backup.files_sync import (
    HOT_SNAPSHOT_FILTER,
    LIVE_SYNC_FILTER,
    RCLONE_FILTER,
    build_rclone_env,
    build_sync_cmd,
    snapshot_hot_state,
)


def test_filter_excludes_all_sqlite_and_litestream_state():
    lines = [line.strip() for line in RCLONE_FILTER.strip().splitlines()]
    for required in (
        "- *.db",
        "- *.db-*",
        "- cognee_db",
        "- cognee_db-*",
        "- *-litestream/**",
        "- *.snapshot",
        "- *.snapshot.tmp",
        "- **/.*.tmp",
        "- .hermes/.env",
        "- .hermes/*_cache/**",
        "- .hermes/logs/**",
        "- .hermes/tmp/**",
        "- .hermes/.cache/**",
        "- .hermes/.local/**",
        "+ **",
    ):
        assert required in lines
    assert lines[-1] == "+ **"


def test_live_and_hot_filters_partition_high_churn_state():
    live_lines = [line.strip() for line in LIVE_SYNC_FILTER.strip().splitlines()]
    hot_lines = [line.strip() for line in HOT_SNAPSHOT_FILTER.strip().splitlines()]
    for path in (
        "**/freezone/canvases/**",
        "**/freezone/canvas_idempotency/**",
        "**/freezone/_canvas_events/**",
    ):
        assert f"- {path}" in live_lines
        assert f"+ {path}" in hot_lines
        assert f"- {path}" not in RCLONE_FILTER
    assert live_lines[-1] == "+ **"
    assert hot_lines[-1] == "- **"


def test_build_sync_cmd_shape(tmp_path):
    filter_file = tmp_path / "filter.txt"
    cmd = build_sync_cmd(
        src="/data/state",
        dst="oss:dramaclaw-staging/backup/3060/node-3060/files/state",
        history_dst="oss:dramaclaw-staging/backup/3060/node-3060/files-history/20260611T040000Z",
        filter_file=filter_file,
    )

    assert cmd[:3] == ["rclone", "sync", "/data/state"]
    assert "--filter-from" in cmd and str(filter_file) in cmd
    assert "--backup-dir" in cmd and "--fast-list" in cmd
    # Hot live files (freezone canvas/idempotency json) must not fail the job.
    assert "--local-no-check-updated" in cmd


def test_snapshot_reads_open_inode_when_atomic_replace_lands(monkeypatch, tmp_path):
    state_dir = tmp_path / "state"
    canvas_dir = state_dir / "user" / "project" / "freezone" / "canvases"
    canvas_dir.mkdir(parents=True)
    source = canvas_dir / "canvas.json"
    replacement = canvas_dir / ".canvas.json.writer.tmp"
    source.write_text("old-version", encoding="utf-8")
    replacement.write_text("new-version", encoding="utf-8")

    original_copy_exact = files_sync_module._copy_exact
    replaced = False

    def replace_then_copy(source_file, destination_file, size, source_path):
        nonlocal replaced
        if not replaced:
            replacement.replace(source)
            replaced = True
        original_copy_exact(source_file, destination_file, size, source_path)

    monkeypatch.setattr(files_sync_module, "_copy_exact", replace_then_copy)

    snapshot_dir = tmp_path / "snapshot"
    roots, files, copied_bytes = snapshot_hot_state(state_dir, snapshot_dir)

    staged = snapshot_dir / source.relative_to(state_dir)
    assert roots == 1
    assert files == 1
    assert copied_bytes == len("old-version")
    assert staged.read_text(encoding="utf-8") == "old-version"
    assert source.read_text(encoding="utf-8") == "new-version"


def test_snapshot_copies_only_initial_prefix_of_append_only_log(monkeypatch, tmp_path):
    state_dir = tmp_path / "state"
    event_dir = state_dir / "user" / "project" / "freezone" / "_canvas_events"
    event_dir.mkdir(parents=True)
    source = event_dir / "canvas.jsonl"
    source.write_bytes(b"first\n")

    original_copy_exact = files_sync_module._copy_exact

    def append_then_copy(source_file, destination_file, size, source_path):
        with source.open("ab") as writer:
            writer.write(b"second\n")
        original_copy_exact(source_file, destination_file, size, source_path)

    monkeypatch.setattr(files_sync_module, "_copy_exact", append_then_copy)

    snapshot_dir = tmp_path / "snapshot"
    roots, files, copied_bytes = snapshot_hot_state(state_dir, snapshot_dir)

    staged = snapshot_dir / source.relative_to(state_dir)
    assert (roots, files, copied_bytes) == (1, 1, len(b"first\n"))
    assert staged.read_bytes() == b"first\n"
    assert source.read_bytes() == b"first\nsecond\n"


def test_main_syncs_staged_hot_state_and_live_remainder_once(monkeypatch, tmp_path):
    state_dir = tmp_path / "state"
    canvas = state_dir / "user" / "project" / "freezone" / "canvases" / "c.json"
    canvas.parent.mkdir(parents=True)
    canvas.write_text("stable", encoding="utf-8")
    stage_dir = tmp_path / "stage"

    monkeypatch.setenv("BACKUP_OSS_BUCKET", "bucket")
    monkeypatch.setenv("BACKUP_OSS_PREFIX", "backup/env/node")
    monkeypatch.setenv("BACKUP_OSS_ENDPOINT", "oss-cn-example.invalid")
    monkeypatch.setenv("BACKUP_OSS_AK", "ak")
    monkeypatch.setenv("BACKUP_OSS_SK", "sk")
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(state_dir))
    monkeypatch.setenv("BACKUP_STAGE_DIR", str(stage_dir))
    monkeypatch.setenv("BACKUP_SYNC_OUTPUT", "0")

    sync_calls = []
    filter_contents = []

    def fake_run(cmd, env):
        sync_calls.append(cmd)
        filter_path = Path(cmd[cmd.index("--filter-from") + 1])
        filter_contents.append(filter_path.read_text(encoding="utf-8"))
        return 0

    marker_calls = []

    def fake_subprocess_run(cmd, *, input, env):
        marker_calls.append((cmd, input, env))
        return CompletedProcess(cmd, 0)

    monkeypatch.setattr(files_sync_module, "_run", fake_run)
    monkeypatch.setattr(files_sync_module.subprocess, "run", fake_subprocess_run)

    assert files_sync_module.main() == 0

    assert len(sync_calls) == 2
    assert sync_calls[0][2].startswith(str(stage_dir))
    assert sync_calls[1][2] == str(state_dir)
    assert filter_contents == [HOT_SNAPSHOT_FILTER, LIVE_SYNC_FILTER]
    assert len(marker_calls) == 1


def test_main_does_not_touch_remote_when_hot_snapshot_fails(monkeypatch, tmp_path):
    state_dir = tmp_path / "state"
    state_dir.mkdir()

    monkeypatch.setenv("BACKUP_OSS_BUCKET", "bucket")
    monkeypatch.setenv("BACKUP_OSS_PREFIX", "backup/env/node")
    monkeypatch.setenv("BACKUP_OSS_ENDPOINT", "oss-cn-example.invalid")
    monkeypatch.setenv("BACKUP_OSS_AK", "ak")
    monkeypatch.setenv("BACKUP_OSS_SK", "sk")
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(state_dir))
    monkeypatch.setenv("BACKUP_STAGE_DIR", str(tmp_path / "stage"))
    monkeypatch.setenv("BACKUP_SYNC_OUTPUT", "0")

    def fail_snapshot(state_path, snapshot_path):
        raise OSError("staging capacity exhausted")

    def unexpected_remote_call(*args, **kwargs):
        pytest.fail("snapshot failure must not invoke rclone")

    monkeypatch.setattr(files_sync_module, "snapshot_hot_state", fail_snapshot)
    monkeypatch.setattr(files_sync_module, "_run", unexpected_remote_call)
    monkeypatch.setattr(
        files_sync_module.subprocess,
        "run",
        unexpected_remote_call,
    )

    with pytest.raises(OSError, match="staging capacity exhausted"):
        files_sync_module.main()


def test_build_rclone_env(monkeypatch):
    monkeypatch.setenv("BACKUP_OSS_AK", "ak1")
    monkeypatch.setenv("BACKUP_OSS_SK", "sk1")
    monkeypatch.setenv("BACKUP_OSS_ENDPOINT", "oss-cn-chengdu.aliyuncs.com")

    env = build_rclone_env()

    assert env["RCLONE_CONFIG_OSS_TYPE"] == "s3"
    assert env["RCLONE_CONFIG_OSS_PROVIDER"] == "Alibaba"
    assert env["RCLONE_CONFIG_OSS_ACCESS_KEY_ID"] == "ak1"
    assert env["RCLONE_CONFIG_OSS_ENDPOINT"] == "https://oss-cn-chengdu.aliyuncs.com"
    assert env["RCLONE_S3_NO_CHECK_BUCKET"] == "true"


def test_snapshot_copyto_natural_name(tmp_path):
    from novelvideo.backup.files_sync import build_snapshot_copyto_cmd

    cmd = build_snapshot_copyto_cmd(
        src=tmp_path / "cognee_db.snapshot",
        dst="oss:b/backup/3060/node-3060/state/u/p/cognee_system/databases/cognee_db",
        history_dst=(
            "oss:b/backup/3060/node-3060/files-history/ts/state/u/p/"
            "cognee_system/databases/cognee_db.prev"
        ),
    )

    assert cmd[:2] == ["rclone", "copyto"]
    assert cmd[3].endswith("/cognee_db")
    assert "--backup-dir" in cmd
