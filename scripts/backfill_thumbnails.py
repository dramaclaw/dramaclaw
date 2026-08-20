#!/usr/bin/env python3
"""Pre-build downscaled image variants for projects that predate them.

A request never builds a variant it is missing: it queues the work and serves
the original instead (see ``novelvideo.utils.thumbnails.fresh_thumbnail``), so
a project warms itself up as people use it and nothing here is required for
correctness. What this buys is the *first* visit — without it the opening paint
of an untouched project is all originals, which is exactly the slow paint
variants exist to remove. Worth running ahead of time for a project you know is
about to be opened; unnecessary for one already in use.

Safe to re-run: a variant whose mtime already matches its source is left
alone, so a second pass over an unchanged project does nothing but stat
files. Interrupting is safe too — variants are written atomically.

    scripts/backfill_thumbnails.py output/alice/my-project
    scripts/backfill_thumbnails.py --root output --jobs 8
    scripts/backfill_thumbnails.py --root output --dry-run
"""

from __future__ import annotations

import argparse
import signal
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

from novelvideo.utils.thumbnails import (  # noqa: E402
    DEFAULT_RENDER_CONCURRENCY,
    THUMB_ROOT,
    VARIANTS,
    ensure_thumbnail,
    is_thumbnailable,
    set_render_concurrency,
    thumbnail_path,
)


@dataclass
class Totals:
    scanned: int = 0
    built: int = 0
    current: int = 0
    skipped: int = 0
    source_bytes: int = 0
    variant_bytes: int = 0


def iter_project_dirs(args: argparse.Namespace) -> list[Path]:
    """Resolve CLI inputs to project directories.

    ``--root`` follows the ``output/<user>/<project>`` layout rather than
    recursing: a project directory is exactly two levels down, and guessing
    deeper would treat ``freezone/`` and ``assets/`` as projects.
    """

    dirs: list[Path] = []
    for raw in args.project:
        path = Path(raw).expanduser()
        if not path.is_dir():
            raise SystemExit(f"not a directory: {path}")
        dirs.append(path.resolve())
    for raw in args.root:
        root = Path(raw).expanduser()
        if not root.is_dir():
            raise SystemExit(f"not a directory: {root}")
        for user_dir in sorted(root.iterdir()):
            if not user_dir.is_dir() or user_dir.name.startswith("."):
                continue
            for project_dir in sorted(user_dir.iterdir()):
                if project_dir.is_dir() and not project_dir.name.startswith("."):
                    dirs.append(project_dir.resolve())
    # De-duplicate while keeping the order the user asked for.
    return list(dict.fromkeys(dirs))


def iter_sources(project_dir: Path) -> list[Path]:
    sources: list[Path] = []
    for path in project_dir.rglob("*"):
        # Pruning by name rather than by resolved path keeps this cheap on
        # projects with tens of thousands of files.
        if THUMB_ROOT in path.parts:
            continue
        if path.is_file() and is_thumbnailable(path):
            sources.append(path)
    return sources


def backfill_project(
    project_dir: Path, variants: list[str], jobs: int, dry_run: bool
) -> Totals:
    totals = Totals()
    sources = iter_sources(project_dir)
    work: list[tuple[Path, str]] = []

    for source in sources:
        totals.scanned += 1
        for variant in variants:
            dest = thumbnail_path(project_dir, source, variant)
            if dest is None:
                totals.skipped += 1
                continue
            try:
                if dest.stat().st_mtime_ns == source.stat().st_mtime_ns:
                    totals.current += 1
                    continue
            except OSError:
                pass
            work.append((source, variant))

    if dry_run:
        totals.built = len(work)
        return totals

    def build(job: tuple[Path, str]) -> tuple[Path, Path | None]:
        source, variant = job
        return source, ensure_thumbnail(project_dir, source, variant)

    # Counted once per source, not once per built variant: a source shrunk into
    # two variants is still one source, and charging it twice would double both
    # the reported volume and the compression ratio.
    counted: set[Path] = set()
    pool = ThreadPoolExecutor(max_workers=jobs)
    try:
        for future in as_completed([pool.submit(build, job) for job in work]):
            source, dest = future.result()
            if dest is None:
                totals.skipped += 1
                continue
            totals.built += 1
            try:
                if source not in counted:
                    counted.add(source)
                    totals.source_bytes += source.stat().st_size
                totals.variant_bytes += dest.stat().st_size
            except OSError:
                pass
    finally:
        # Not `with`: its __exit__ is shutdown(wait=True), so Ctrl-C on a large
        # project would sit through the entire remaining queue before the
        # KeyboardInterrupt surfaced — the process looks hung exactly when the
        # operator is trying to stop it.
        pool.shutdown(wait=False, cancel_futures=True)
    return totals


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("project", nargs="*", help="project directory to backfill")
    parser.add_argument(
        "--root",
        action="append",
        default=[],
        metavar="DIR",
        help="output root; every <user>/<project> below it is backfilled",
    )
    parser.add_argument(
        "--variant",
        action="append",
        default=[],
        choices=sorted(VARIANTS),
        help=f"variant to build (default: all of {', '.join(sorted(VARIANTS))})",
    )
    parser.add_argument(
        "--jobs",
        type=int,
        default=DEFAULT_RENDER_CONCURRENCY,
        help=f"concurrent decodes (default: {DEFAULT_RENDER_CONCURRENCY})",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="report what would be built without writing anything",
    )
    parser.add_argument("-q", "--quiet", action="store_true", help="totals only")
    args = parser.parse_args(argv)

    if not args.project and not args.root:
        parser.error("give at least one project directory or --root")

    project_dirs = iter_project_dirs(args)
    variants = args.variant or sorted(VARIANTS)
    jobs = max(1, args.jobs)
    # Without this the module's serving-sized budget would silently cap
    # --jobs at four, and the run would look mysteriously slow.
    set_render_concurrency(jobs)

    # Ctrl-C between projects should print what was already done rather than
    # dumping a traceback; a half-written variant is impossible either way.
    interrupted = False

    def on_sigint(signum, frame):  # noqa: ANN001, ARG001
        nonlocal interrupted
        interrupted = True
        raise KeyboardInterrupt

    signal.signal(signal.SIGINT, on_sigint)

    grand = Totals()
    started = time.monotonic()
    try:
        for project_dir in project_dirs:
            totals = backfill_project(project_dir, variants, jobs, args.dry_run)
            if not args.quiet:
                print(
                    f"{project_dir}: scanned {totals.scanned}, "
                    f"built {totals.built}, current {totals.current}, "
                    f"skipped {totals.skipped}"
                )
            for field in vars(totals):
                setattr(grand, field, getattr(grand, field) + getattr(totals, field))
    except KeyboardInterrupt:
        print("interrupted", file=sys.stderr)

    elapsed = time.monotonic() - started
    # "up to": a dry run only stats files, so it counts every missing variant
    # without knowing which sources are already small enough to be declined.
    verb = "would build up to" if args.dry_run else "built"
    print(
        f"{len(project_dirs)} project(s), {grand.scanned} image(s) scanned, "
        f"{verb} {grand.built}, {grand.current} already current, "
        f"{grand.skipped} skipped, {elapsed:.1f}s"
    )
    if grand.variant_bytes:
        ratio = grand.source_bytes / grand.variant_bytes
        print(
            f"{grand.source_bytes / 1e6:.1f}MB of sources -> "
            f"{grand.variant_bytes / 1e6:.1f}MB of variants ({ratio:.0f}x smaller)"
        )
    return 1 if interrupted else 0


if __name__ == "__main__":
    raise SystemExit(main())
