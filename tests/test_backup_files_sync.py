"""files_sync filter, staging snapshot, and command tests."""

import os
from contextlib import contextmanager
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


@pytest.fixture(autouse=True)
def _allow_legacy_local_service_operation(monkeypatch):
    """Neutralize the CE-local deployment gate for the staging/filter tests.

    ``main()`` gained ``require_legacy_local_service_operation()`` on this
    branch, so main's staging tests would otherwise die on
    ``ORG_SERVICE_EGRESS_DENIED`` before reaching the behaviour they assert.
    The gate itself is covered by
    ``tests/test_p0g4t_service_operation_exclusion.py``, which parametrizes
    ``files_sync.main`` directly — the same pattern as
    ``tests/test_p0g4f_storage_control.py``.
    """

    monkeypatch.setattr(
        files_sync_module, "require_legacy_local_service_operation", lambda: None
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
        "- *.tmp",
        "- **/freezone/canvases/_locks/**",
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
        "**/freezone/canvases/*.json",
        "**/freezone/canvas_idempotency/*.json",
        "**/freezone/_canvas_events/*.jsonl",
        "**/freezone/_skill_runs/*.json",
        "**/freezone/_skill_run_idempotency/*.json",
        "**/freezone/stale_marks.json",
    ):
        assert f"- {path}" in live_lines
        assert f"+ {path}" in hot_lines
        assert f"- {path}" not in RCLONE_FILTER
    for base_rule in ("- *.tmp", "- **/freezone/canvases/_locks/**"):
        assert base_rule in hot_lines
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
    # Unknown live mutations must fail instead of silently accepting a partial copy.
    assert "--local-no-check-updated" not in cmd


def test_snapshot_reads_open_inode_when_atomic_replace_lands(monkeypatch, tmp_path):
    state_dir = tmp_path / "state"
    canvas_dir = state_dir / "user" / "project" / "freezone" / "canvases"
    canvas_dir.mkdir(parents=True)
    source = canvas_dir / "canvas.json"
    replacement = canvas_dir / ".canvas.json.writer.tmp"
    old_version = '{"revision": 1}'
    new_version = '{"revision": 2}'
    source.write_text(old_version, encoding="utf-8")
    replacement.write_text(new_version, encoding="utf-8")

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
    assert roots == 2
    assert files == 1
    assert copied_bytes == len(old_version)
    assert staged.read_text(encoding="utf-8") == old_version
    assert source.read_text(encoding="utf-8") == new_version


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
    assert (roots, files, copied_bytes) == (2, 1, len(b"first\n"))
    assert staged.read_bytes() == b"first\n"
    assert source.read_bytes() == b"first\nsecond\n"


def test_snapshot_creates_empty_hot_roots(tmp_path):
    state_dir = tmp_path / "state"
    canvas_dir = state_dir / "tenant" / "nested" / "project" / "freezone" / "canvases"
    canvas_dir.mkdir(parents=True)
    snapshot_dir = tmp_path / "snapshot"

    roots, files, copied_bytes = snapshot_hot_state(state_dir, snapshot_dir)

    assert (roots, files, copied_bytes) == (2, 0, 0)
    assert (snapshot_dir / canvas_dir.relative_to(state_dir)).is_dir()


def test_snapshot_copies_canvas_and_idempotency_under_same_writer_lock(
    monkeypatch,
    tmp_path,
):
    state_dir = tmp_path / "state"
    project_dir = state_dir / "user" / "project"
    canvas = project_dir / "freezone" / "canvases" / "canvas.json"
    idempotency = project_dir / "freezone" / "canvas_idempotency" / "canvas.json"
    canvas.parent.mkdir(parents=True)
    idempotency.parent.mkdir(parents=True)
    canvas.write_text('{"revision": 3}', encoding="utf-8")
    idempotency.write_text('{"entries": []}', encoding="utf-8")

    lock_held = False
    copied_while_locked = []
    original_copy = files_sync_module._copy_stable_file

    @contextmanager
    def fake_lock(locked_project_dir, canvas_id, *, timeout_seconds):
        nonlocal lock_held
        assert locked_project_dir == project_dir
        assert canvas_id == "canvas"
        assert timeout_seconds == 10.0
        lock_held = True
        try:
            yield
        finally:
            lock_held = False

    def tracked_copy(source_path, destination_path, **kwargs):
        copied_while_locked.append((source_path, lock_held))
        return original_copy(source_path, destination_path, **kwargs)

    monkeypatch.setattr(files_sync_module, "canvas_write_lock", fake_lock)
    monkeypatch.setattr(files_sync_module, "_copy_stable_file", tracked_copy)

    snapshot_hot_state(state_dir, tmp_path / "snapshot")

    assert {path for path, _ in copied_while_locked} == {canvas, idempotency}
    assert all(held for _, held in copied_while_locked)


def test_snapshot_rejects_file_removed_during_copy(monkeypatch, tmp_path):
    state_dir = tmp_path / "state"
    event_dir = state_dir / "user" / "project" / "freezone" / "_canvas_events"
    event_dir.mkdir(parents=True)
    first = event_dir / "a.jsonl"
    second = event_dir / "b.jsonl"
    first.write_text("first", encoding="utf-8")
    second.write_text("second", encoding="utf-8")

    original_copy = files_sync_module._copy_stable_file
    removed = False

    def remove_during_copy(source_path, destination_path, **kwargs):
        nonlocal removed
        if not removed:
            second.unlink()
            removed = True
        return original_copy(source_path, destination_path, **kwargs)

    monkeypatch.setattr(files_sync_module, "_copy_stable_file", remove_during_copy)

    with pytest.raises(files_sync_module.HotSnapshotError):
        snapshot_hot_state(state_dir, tmp_path / "snapshot")


def test_snapshot_does_not_stage_history_deleted_or_lock_trees(tmp_path):
    state_dir = tmp_path / "state"
    canvases = state_dir / "user" / "project" / "freezone" / "canvases"
    current = canvases / "canvas.json"
    history = canvases / "_history" / "canvas.revision.json"
    deleted = canvases / "_deleted" / "canvas" / "canvas.deleted.json"
    lock = canvases / "_locks" / "canvas.lock"
    for path in (current, history, deleted, lock):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text('{"ok": true}', encoding="utf-8")

    snapshot_dir = tmp_path / "snapshot"
    snapshot_hot_state(state_dir, snapshot_dir)

    assert (snapshot_dir / current.relative_to(state_dir)).is_file()
    for path in (history, deleted, lock):
        assert not (snapshot_dir / path.relative_to(state_dir)).exists()


@pytest.mark.skipif(not hasattr(os, "mkfifo"), reason="FIFO is unavailable")
def test_copy_stable_file_rejects_fifo_without_blocking(tmp_path):
    fifo = tmp_path / "source.fifo"
    os.mkfifo(fifo)

    with pytest.raises(files_sync_module.HotSnapshotError, match="not a regular file"):
        files_sync_module._copy_stable_file(fifo, tmp_path / "snapshot" / "fifo")


@pytest.mark.skipif(not hasattr(os, "symlink"), reason="symlinks are unavailable")
def test_snapshot_rejects_symlinked_hot_root(tmp_path):
    state_dir = tmp_path / "state"
    freezone = state_dir / "user" / "project" / "freezone"
    external_canvases = tmp_path / "external-canvases"
    freezone.mkdir(parents=True)
    external_canvases.mkdir()
    (freezone / "canvases").symlink_to(external_canvases, target_is_directory=True)

    with pytest.raises(files_sync_module.HotSnapshotError, match="is a symlink"):
        snapshot_hot_state(state_dir, tmp_path / "snapshot")


def test_snapshot_stages_in_place_freezone_json_writers(tmp_path):
    state_dir = tmp_path / "state"
    freezone = state_dir / "user" / "project" / "freezone"
    paths = (
        freezone / "_skill_runs" / "run.json",
        freezone / "_skill_run_idempotency" / "request.json",
        freezone / "stale_marks.json",
    )
    for path in paths:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text('{"complete": true}', encoding="utf-8")

    snapshot_dir = tmp_path / "snapshot"
    _, files, _ = snapshot_hot_state(state_dir, snapshot_dir)

    assert files == len(paths)
    assert all((snapshot_dir / path.relative_to(state_dir)).is_file() for path in paths)


def test_snapshot_rejects_incomplete_json(monkeypatch, tmp_path):
    state_dir = tmp_path / "state"
    metadata = state_dir / "user" / "project" / "freezone" / "_skill_runs" / "run.json"
    metadata.parent.mkdir(parents=True)
    metadata.write_text('{"incomplete":', encoding="utf-8")

    with pytest.raises(files_sync_module.HotSnapshotError, match="not complete JSON"):
        snapshot_hot_state(state_dir, tmp_path / "snapshot")


def test_snapshot_rejects_in_place_json_change_during_copy(monkeypatch, tmp_path):
    state_dir = tmp_path / "state"
    metadata = state_dir / "user" / "project" / "freezone" / "_skill_runs" / "run.json"
    metadata.parent.mkdir(parents=True)
    metadata.write_text('{"state": "starting"}', encoding="utf-8")
    original_copy_exact = files_sync_module._copy_exact

    def rewrite_then_copy(source_file, destination_file, size, source_path):
        metadata.write_text(
            '{"state": "completed", "result": "ready"}',
            encoding="utf-8",
        )
        original_copy_exact(source_file, destination_file, size, source_path)

    monkeypatch.setattr(files_sync_module, "_copy_exact", rewrite_then_copy)

    with pytest.raises(files_sync_module.HotSnapshotError, match="source changed"):
        snapshot_hot_state(state_dir, tmp_path / "snapshot")


def test_main_syncs_staged_hot_state_and_live_remainder_once(monkeypatch, tmp_path):
    state_dir = tmp_path / "state"
    canvas = state_dir / "user" / "project" / "freezone" / "canvases" / "c.json"
    canvas.parent.mkdir(parents=True)
    canvas.write_text('{"stable": true}', encoding="utf-8")
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


def test_main_snapshots_output_before_any_remote_call(monkeypatch, tmp_path):
    state_dir = tmp_path / "state"
    output_dir = tmp_path / "output"
    state_dir.mkdir()
    output_dir.mkdir()

    monkeypatch.setenv("BACKUP_OSS_BUCKET", "bucket")
    monkeypatch.setenv("BACKUP_OSS_PREFIX", "backup/env/node")
    monkeypatch.setenv("BACKUP_OSS_ENDPOINT", "oss-cn-example.invalid")
    monkeypatch.setenv("BACKUP_OSS_AK", "ak")
    monkeypatch.setenv("BACKUP_OSS_SK", "sk")
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(state_dir))
    monkeypatch.setenv("NOVELVIDEO_OUTPUT_DIR", str(output_dir))
    monkeypatch.setenv("BACKUP_STAGE_DIR", str(tmp_path / "stage"))
    monkeypatch.setenv("BACKUP_SYNC_OUTPUT", "1")

    snapshot_calls = []

    def snapshot_then_fail(source_path, snapshot_path):
        snapshot_calls.append(source_path)
        snapshot_path.mkdir(parents=True, exist_ok=True)
        if source_path == output_dir:
            raise OSError("output staging capacity exhausted")
        return (0, 0, 0)

    def unexpected_remote_call(*args, **kwargs):
        pytest.fail("all requested snapshots must complete before rclone")

    monkeypatch.setattr(files_sync_module, "snapshot_hot_state", snapshot_then_fail)
    monkeypatch.setattr(files_sync_module, "_run", unexpected_remote_call)
    monkeypatch.setattr(files_sync_module.subprocess, "run", unexpected_remote_call)

    with pytest.raises(OSError, match="output staging capacity exhausted"):
        files_sync_module.main()

    assert snapshot_calls == [state_dir, output_dir]


def test_main_partitions_output_hot_state_too(monkeypatch, tmp_path):
    state_dir = tmp_path / "state"
    output_dir = tmp_path / "output"
    state_dir.mkdir()
    event = (
        output_dir
        / "org"
        / "team"
        / "project"
        / "freezone"
        / "_canvas_events"
        / "c.jsonl"
    )
    event.parent.mkdir(parents=True)
    event.write_text("event", encoding="utf-8")

    monkeypatch.setenv("BACKUP_OSS_BUCKET", "bucket")
    monkeypatch.setenv("BACKUP_OSS_PREFIX", "backup/env/node")
    monkeypatch.setenv("BACKUP_OSS_ENDPOINT", "oss-cn-example.invalid")
    monkeypatch.setenv("BACKUP_OSS_AK", "ak")
    monkeypatch.setenv("BACKUP_OSS_SK", "sk")
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(state_dir))
    monkeypatch.setenv("NOVELVIDEO_OUTPUT_DIR", str(output_dir))
    monkeypatch.setenv("BACKUP_STAGE_DIR", str(tmp_path / "stage"))
    monkeypatch.setenv("BACKUP_SYNC_OUTPUT", "1")

    sync_calls = []
    filter_texts = []
    staged_output_files = []

    def fake_run(cmd, env):
        sync_calls.append(cmd)
        filter_path = Path(cmd[cmd.index("--filter-from") + 1])
        filter_texts.append(filter_path.read_text(encoding="utf-8"))
        if len(sync_calls) == 3:
            staged_output_files.extend(
                path.relative_to(Path(cmd[2]))
                for path in Path(cmd[2]).rglob("*")
                if path.is_file()
            )
        return 0

    def fake_subprocess_run(cmd, *, input, env):
        return CompletedProcess(cmd, 0)

    monkeypatch.setattr(files_sync_module, "_run", fake_run)
    monkeypatch.setattr(files_sync_module.subprocess, "run", fake_subprocess_run)

    assert files_sync_module.main() == 0

    assert [cmd[2] for cmd in sync_calls] == [
        next(src for src in (cmd[2] for cmd in sync_calls) if "hot-state" in src),
        str(state_dir),
        next(src for src in (cmd[2] for cmd in sync_calls) if "hot-output" in src),
        str(output_dir),
    ]
    assert "hot-output" in Path(sync_calls[2][2]).as_posix()
    assert event.relative_to(output_dir) in staged_output_files
    assert filter_texts == [
        HOT_SNAPSHOT_FILTER,
        LIVE_SYNC_FILTER,
        HOT_SNAPSHOT_FILTER,
        LIVE_SYNC_FILTER,
    ]


def test_main_syncs_empty_hot_snapshot_instead_of_skipping(monkeypatch, tmp_path):
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

    sources_seen = []

    def fake_run(cmd, env):
        sources_seen.append(Path(cmd[2]))
        if len(sources_seen) == 1:
            assert sources_seen[0].is_dir()
        return 0

    def fake_subprocess_run(cmd, *, input, env):
        return CompletedProcess(cmd, 0)

    monkeypatch.setattr(files_sync_module, "_run", fake_run)
    monkeypatch.setattr(files_sync_module.subprocess, "run", fake_subprocess_run)

    assert files_sync_module.main() == 0
    assert len(sources_seen) == 2


def test_main_stops_after_first_remote_failure(monkeypatch, tmp_path):
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

    remote_calls = []

    def fail_first_remote(cmd, env):
        remote_calls.append(cmd)
        return 3

    def unexpected_marker(*args, **kwargs):
        pytest.fail("a failed remote stage must not write the success marker")

    monkeypatch.setattr(files_sync_module, "_run", fail_first_remote)
    monkeypatch.setattr(files_sync_module.subprocess, "run", unexpected_marker)

    assert files_sync_module.main() == 3
    assert len(remote_calls) == 1


def test_stage_parent_blank_falls_back_outside_source(monkeypatch, tmp_path):
    source_dir = tmp_path / "source"
    source_dir.mkdir()
    fallback = tmp_path / "system-temp"
    monkeypatch.setenv("BACKUP_STAGE_DIR", "   ")
    monkeypatch.setattr(files_sync_module.tempfile, "gettempdir", lambda: str(fallback))

    assert files_sync_module._stage_parent([source_dir]) == fallback.resolve()


def test_stage_parent_rejects_location_inside_source(monkeypatch, tmp_path):
    source_dir = tmp_path / "source"
    source_dir.mkdir()
    monkeypatch.setenv("BACKUP_STAGE_DIR", str(source_dir / "stage"))

    with pytest.raises(ValueError, match="must not be inside"):
        files_sync_module._stage_parent([source_dir.resolve()])


def test_db_snapshot_stage_logs_count_and_stops_on_failure(
    monkeypatch,
    capsys,
    tmp_path,
):
    state_dir = tmp_path / "state"
    first = state_dir / "a.snapshot"
    second = state_dir / "nested" / "b.snapshot"
    first.parent.mkdir(parents=True)
    second.parent.mkdir(parents=True)
    first.write_text("a", encoding="utf-8")
    second.write_text("b", encoding="utf-8")
    calls = []

    def fail_first(cmd, env):
        calls.append(cmd)
        return 7

    monkeypatch.setattr(files_sync_module, "_run", fail_first)

    assert (
        files_sync_module.sync_db_snapshots(
            state_dir,
            "oss:bucket/state",
            "oss:bucket/history/state",
            {},
        )
        == 7
    )

    assert len(calls) == 1
    output = capsys.readouterr().out
    assert "backup_stage_start stage=db-snapshots-sync files=2" in output
    assert (
        "backup_stage_failed stage=db-snapshots-sync files=2 copied=0 exit=7" in output
    )


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
