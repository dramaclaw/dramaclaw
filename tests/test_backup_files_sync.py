"""files_sync rclone filter and command construction tests."""

from novelvideo.backup.files_sync import RCLONE_FILTER, build_rclone_env, build_sync_cmd


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
