#!/usr/bin/env python3
"""Bump the ``:-`` shell-parameter default for one variable in a compose file.

Usage:
    bump_compose_default.py <compose-file> <VAR> <new-default> [--check-only]

Finds every ``${VAR:-<old-default>}`` occurrence of ``VAR`` in
``<compose-file>`` and rewrites the default to ``<new-default>``. Only the
text between ``:-`` and the closing ``}`` changes — everything else in the
file, including the number of lines, is left byte-for-byte identical (the
match never crosses a newline, so a plain ``re.sub`` cannot change the line
count).

This repo ships the script but no workflow that calls it: the release
packaging workflow in the (private) SuperTale repo clones ``main``, bumps
``DRAMACLAW_VERSION`` and ``DRAMACLAW_GATEWAY_VERSION`` in
``docker-compose.release.yml`` after each published compose bundle, and opens a
PR here rather than pushing straight to ``main``. Keeping the caller there keeps
the CE-writing token out of this public repo.

Exit codes:
    0   a change was made (stdout: "<old> -> <new>"), or the default was
        already <new-default> (stdout: "unchanged") — the normal,
        non-``--check-only`` case.
    2   ``VAR`` has no ``${VAR:-...}`` default form anywhere in the file
        (nothing is written). Same in both modes — this is a real error,
        e.g. running against ``docker-compose.yml``, which has no
        ``DRAMACLAW_VERSION`` default (its versions come from the build
        context, not a pulled image tag).
    3   only with ``--check-only``: the default already equals
        <new-default>, so no PR is needed. The file is never written in
        ``--check-only`` mode, whether or not a change would be needed.

``--check-only`` flips the "already equal" case from exit 0 to exit 3 so a
caller can tell "up to date" apart from "changed" using only the exit code,
without writing the file just to find out. When a change *would* be needed
it still exits 0 (truthy in a shell ``if``), matching the "please act"
case in the non-check mode.

CI usage (called by the release packaging workflow in the SuperTale repo,
``dramaclaw-release-packages.yml`` -> ``compose-package``, on a clone of ``main``;
this repo carries no workflow that calls it)::

    if python3 scripts/bump_compose_default.py FILE VAR NEW --check-only; then
        # a change is needed -> do it for real, then open a PR
        python3 scripts/bump_compose_default.py FILE VAR NEW
    else
        rc=$?
        [ "$rc" = 3 ] && exit 0   # already up to date, nothing to do
        exit "$rc"                 # rc == 2: VAR not found, real error
    fi
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

EXIT_OK = 0
EXIT_NO_DEFAULT = 2
EXIT_UNCHANGED_CHECK_ONLY = 3


def _pattern(var: str) -> re.Pattern[str]:
    # ``[^}\n]*`` keeps every match inside a single line, so re.sub can
    # never change the file's line count.
    return re.compile(r"\$\{" + re.escape(var) + r":-([^}\n]*)\}")


def bump(text: str, var: str, new_default: str) -> tuple[str, list[str]] | None:
    """Replace every ``${var:-...}`` default in ``text`` with ``new_default``.

    Returns ``(new_text, old_defaults)`` where ``old_defaults`` lists the
    default value captured at each occurrence (in file order), or ``None``
    if ``var`` has no ``${var:-...}`` form anywhere in ``text``.
    """
    pattern = _pattern(var)
    old_defaults = pattern.findall(text)
    if not old_defaults:
        return None
    new_text = pattern.sub(lambda _match: f"${{{var}:-{new_default}}}", text)
    return new_text, old_defaults


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Bump a ${VAR:-default} in a compose file.",
    )
    parser.add_argument("compose_file", type=Path)
    parser.add_argument("var")
    parser.add_argument("new_default")
    parser.add_argument(
        "--check-only",
        action="store_true",
        help="don't write the file; exit 3 instead of 0 when already up to date",
    )
    args = parser.parse_args(argv)

    text = args.compose_file.read_text()

    result = bump(text, args.var, args.new_default)
    if result is None:
        print(
            f"no ${{{args.var}:-...}} default found in {args.compose_file}",
            file=sys.stderr,
        )
        return EXIT_NO_DEFAULT

    new_text, old_defaults = result
    unique_old = sorted(set(old_defaults))

    if unique_old == [args.new_default]:
        print("unchanged")
        return EXIT_UNCHANGED_CHECK_ONLY if args.check_only else EXIT_OK

    print(f"{','.join(unique_old)} -> {args.new_default}")

    if args.check_only:
        return EXIT_OK  # a change is needed; the caller decides what to do

    if new_text.count("\n") != text.count("\n"):
        raise RuntimeError("refusing to write: line count changed")
    args.compose_file.write_text(new_text)
    return EXIT_OK


if __name__ == "__main__":
    raise SystemExit(main())
