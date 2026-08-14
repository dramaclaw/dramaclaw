"""Backup and restore CLI commands."""

from __future__ import annotations

import os
import subprocess
import tempfile
from pathlib import Path

import typer

from novelvideo.backup.files_sync import RCLONE_FILTER, build_rclone_env

backup_app = typer.Typer(name="backup", help="OSS backup/restore")

CELL_SQLITE_RELS = (
    "data.db",
    "chat.db",
)


@backup_app.callback()
def _backup_group() -> None:
    """Backup command group."""


def derive_region(endpoint: str) -> str:
    """Derive cn-* region from an Aliyun OSS endpoint."""

    host = endpoint.split("/")[-1]
    first = host.split(".")[0]
    if first.startswith("oss-"):
        first = first[len("oss-") :]
    if first.endswith("-internal"):
        first = first[: -len("-internal")]
    return first


def build_restore_config(
    *,
    bucket: str,
    endpoint: str,
    region: str,
    prefix: str,
    user: str,
    project: str,
    rels: tuple[str, ...],
) -> str:
    blocks = []
    for rel in rels:
        blocks.append(
            f"""  - path: /restore/{rel}
    replica:
      type: oss
      bucket: {bucket}
      path: {prefix}/ltx/state/{user}/{project}/{rel}
      endpoint: {endpoint}
      region: {region}
      access-key-id: ${{OSS_ACCESS_KEY_ID}}
      secret-access-key: ${{OSS_SECRET_ACCESS_KEY}}"""
        )
    return "dbs:\n" + "\n".join(blocks) + "\n"


def build_rclone_files_cmd(
    *,
    bucket: str,
    prefix: str,
    user: str,
    project: str,
    dest: Path,
    filter_file: Path,
) -> list[str]:
    return [
        "rclone",
        "copy",
        f"oss:{bucket}/{prefix}/state/{user}/{project}",
        str(dest),
        "--filter-from",
        str(filter_file),
        "--log-level",
        "INFO",
    ]


@backup_app.command("restore-cell")
def restore_cell(
    user: str = typer.Option(...),
    project: str = typer.Option(...),
    timestamp: str = typer.Option(None, help="RFC3339 timestamp; default restores latest"),
    to: Path = typer.Option(None, help="Target dir; default <state>/<user>/<project>.restored"),
    include_output: bool = typer.Option(False, help="Also restore output/"),
    dry_run: bool = typer.Option(False, help="Print commands without running them"),
) -> None:
    bucket = os.environ["BACKUP_OSS_BUCKET"]
    endpoint = os.environ["BACKUP_OSS_ENDPOINT"]
    prefix = (
        os.environ.get("BACKUP_OSS_PREFIX")
        or f"backup/{os.environ['BACKUP_ENV_NAME']}/{os.environ['ST_WORKER_ID']}"
    ).strip("/")
    state_dir = Path(os.environ["NOVELVIDEO_STATE_DIR"])
    target = to or state_dir / user / f"{project}.restored"
    env = build_rclone_env()
    env["OSS_ACCESS_KEY_ID"] = os.environ["BACKUP_OSS_AK"]
    env["OSS_SECRET_ACCESS_KEY"] = os.environ["BACKUP_OSS_SK"]

    region = os.environ.get("BACKUP_OSS_REGION") or derive_region(endpoint)
    cfg_content = build_restore_config(
        bucket=bucket,
        endpoint=endpoint,
        region=region,
        prefix=prefix,
        user=user,
        project=project,
        rels=CELL_SQLITE_RELS,
    )
    with tempfile.NamedTemporaryFile("w", suffix=".yml", delete=False) as cfg_file:
        cfg_file.write(cfg_content)
        cfg_path = Path(cfg_file.name)

    plans: list[list[str]] = []
    for rel in CELL_SQLITE_RELS:
        out = target / rel
        out.parent.mkdir(parents=True, exist_ok=True)
        cmd = ["litestream", "restore", "-config", str(cfg_path)]
        if timestamp:
            cmd += ["-timestamp", timestamp]
        cmd += ["-o", str(out), f"/restore/{rel}"]
        plans.append(cmd)

    with tempfile.NamedTemporaryFile("w", suffix=".filter", delete=False) as filter_file_handle:
        filter_file_handle.write(RCLONE_FILTER)
        filter_file = Path(filter_file_handle.name)
    plans.append(
        build_rclone_files_cmd(
            bucket=bucket,
            prefix=prefix,
            user=user,
            project=project,
            dest=target,
            filter_file=filter_file,
        )
    )
    if include_output:
        out_root = Path(os.environ["NOVELVIDEO_OUTPUT_DIR"]) / user / f"{project}.restored"
        plans.append(
            [
                "rclone",
                "copy",
                f"oss:{bucket}/{prefix}/output/{user}/{project}",
                str(out_root),
                "--log-level",
                "INFO",
            ]
        )

    failures = 0
    for cmd in plans:
        typer.echo("+ " + " ".join(cmd))
        if dry_run:
            continue
        rc = subprocess.run(cmd, env=env).returncode
        if rc != 0:
            typer.echo(f"  warning: exit={rc}; backup path may not exist")
            failures += 1

    typer.echo(f"\nrestored into {target} (failures={failures})")
    typer.echo(f"after verification, stop writers then mv {target} {state_dir / user / project}")


if __name__ == "__main__":
    backup_app()
