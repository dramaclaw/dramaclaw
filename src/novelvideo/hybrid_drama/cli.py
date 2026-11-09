"""Practical command line for the hybrid CE/direct-Seedance runner."""

from __future__ import annotations

import argparse
from contextlib import contextmanager
import json
import os
from pathlib import Path
import sys

import httpx
import portalocker

from novelvideo.hybrid_drama.ce import CEClient, build_beat_prompt
from novelvideo.hybrid_drama.runner import (
    assemble_episode,
    finalize_delivery,
    poll_tasks,
    review_candidate,
    submit_task,
)


def _load(path: str | Path) -> dict:
    return json.loads(Path(path).read_text())


def _write_new(path: str | Path, value: dict) -> None:
    output = Path(path)
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("x") as handle:
        json.dump(value, handle, ensure_ascii=False, indent=2, sort_keys=True)
        handle.write("\n")


def _api_key() -> str:
    key = os.environ.get("BYTEPLUS_MODEL_ARK_API_KEY") or os.environ.get("ARK_API_KEY")
    if not key:
        raise ValueError("BYTEPLUS_MODEL_ARK_API_KEY or ARK_API_KEY is required")
    return key.strip(" \t\r\n\"'")


@contextmanager
def _state_lock(run_dir: str | Path):
    run_dir = Path(run_dir)
    run_dir.mkdir(parents=True, exist_ok=True)
    with (run_dir / ".state.lock").open("a+") as lock:
        portalocker.lock(lock, portalocker.LOCK_EX)
        try:
            yield
        finally:
            portalocker.unlock(lock)


def _build(args) -> None:
    if args.ce_base_url:
        if not args.project or args.episode is None:
            raise ValueError("--project and --episode are required with --ce-base-url")
        token = os.environ.get("DRAMACLAW_AGENT_TOKEN") or os.environ.get(
            "SUPERTALE_AGENT_TOKEN"
        )
        prepared = CEClient(args.ce_base_url, token=token).fetch_beat_prompt(
            args.project, args.episode, args.beat_number
        )
    else:
        ce = _load(args.ce)
        beat = next(
            (
                item
                for item in ce.get("beats", [])
                if int(item.get("beat_number") or 0) == args.beat_number
            ),
            ce.get("beat"),
        )
        if not beat or int(beat.get("beat_number") or 0) != args.beat_number:
            raise ValueError(f"beat_number {args.beat_number} not found in CE input")
        prepared = build_beat_prompt(
            ce["project"],
            ce["episode"],
            beat,
            ce.get("identities") or ce.get("cast") or {},
        )
    _write_new(args.out, prepared)
    print(args.out)


def _references(path: str | None) -> dict[str, Path]:
    if not path:
        return {}
    source = Path(path)
    return {key: source.parent / value for key, value in _load(source).items()}


def _submit(args) -> None:
    with _state_lock(args.run_dir):
        task = submit_task(
            args.run_dir,
            _load(args.prepared),
            _references(args.references),
            max_cost_usd=args.max_cost_usd,
            max_attempts=args.max_attempts,
            manual_retry=args.manual_retry,
            api_key=_api_key(),
        )
    print(json.dumps({key: task[key] for key in ("beat_key", "task_id", "status", "request_sha256", "estimated_cost_usd")}))


def _poll(args) -> None:
    with _state_lock(args.run_dir):
        tasks = poll_tasks(args.run_dir, api_key=_api_key())
    print(
        json.dumps(
            [
                {
                    "task_id": task["task_id"],
                    "status": task["status"],
                    "usage": task.get("usage"),
                    "candidate_sha256": task.get("candidate", {}).get("sha256"),
                }
                for task in tasks
            ]
        )
    )


def _review(args) -> None:
    with _state_lock(args.run_dir):
        review = review_candidate(
            args.run_dir,
            args.candidate,
            decision=args.decision,
            evidence=_load(args.evidence),
        )
    print(json.dumps({"candidate_sha256": review["candidate_sha256"], "decision": review["decision"]}))


def _assemble(args) -> None:
    with _state_lock(args.run_dir):
        assembly = assemble_episode(args.run_dir, args.output)
    print(json.dumps({"media_sha256": assembly["media_sha256"], "qc": assembly["qc"]}))


def _finalize(args) -> None:
    with _state_lock(args.run_dir):
        delivery = finalize_delivery(args.run_dir, args.output, _load(args.review))
    print(json.dumps({"status": delivery["status"], "media_sha256": delivery["media_sha256"]}))


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="hybrid_drama")
    commands = parser.add_subparsers(dest="command", required=True)

    build = commands.add_parser("build-prompt")
    source = build.add_mutually_exclusive_group(required=True)
    source.add_argument("--ce")
    source.add_argument("--ce-base-url")
    build.add_argument("--project")
    build.add_argument("--episode", type=int)
    build.add_argument("--beat-number", type=int, required=True)
    build.add_argument("--out", required=True)
    build.set_defaults(action=_build)

    submit = commands.add_parser("submit")
    submit.add_argument("--run-dir", required=True)
    submit.add_argument("--prepared", required=True)
    submit.add_argument("--references")
    submit.add_argument("--max-cost-usd", required=True)
    submit.add_argument("--max-attempts", type=int, default=1)
    submit.add_argument("--manual-retry", action="store_true")
    submit.set_defaults(action=_submit)

    poll = commands.add_parser("poll")
    poll.add_argument("--run-dir", required=True)
    poll.set_defaults(action=_poll)

    review = commands.add_parser("review")
    review.add_argument("--run-dir", required=True)
    review.add_argument("--candidate", required=True)
    review.add_argument("--decision", choices=("adopt", "repair", "more-evidence"), required=True)
    review.add_argument("--evidence", required=True)
    review.set_defaults(action=_review)

    assemble = commands.add_parser("assemble")
    assemble.add_argument("--run-dir", required=True)
    assemble.add_argument("--output", required=True)
    assemble.set_defaults(action=_assemble)

    finalize = commands.add_parser("finalize")
    finalize.add_argument("--run-dir", required=True)
    finalize.add_argument("--output", required=True)
    finalize.add_argument("--review", required=True)
    finalize.set_defaults(action=_finalize)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        args.action(args)
    except (ValueError, OSError, httpx.HTTPError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    return 0
