#!/usr/bin/env python3
"""Delete Langfuse traces older than N days (the LLM call log's retention).

Media blobs expire separately via the MinIO lifecycle rule that
docker-compose.langfuse.yml installs. Run from cron or by hand:

    LANGFUSE_HOST=... LANGFUSE_PUBLIC_KEY=... LANGFUSE_SECRET_KEY=... \
        python scripts/llm_call_log_cleanup.py --days 14 [--dry-run]
"""

from __future__ import annotations

import argparse
import os
import sys
from datetime import datetime, timedelta, timezone

BATCH = 100


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--days", type=int, default=int(os.environ.get("LLM_LOG_RETENTION_DAYS", "14"))
    )
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)
    if args.days < 1:
        parser.error("--days must be >= 1")

    try:
        from langfuse import Langfuse
    except ImportError:
        print("pip install langfuse first", file=sys.stderr)
        return 2
    host = os.environ.get("LANGFUSE_HOST", "")
    public_key = os.environ.get("LANGFUSE_PUBLIC_KEY", "")
    secret_key = os.environ.get("LANGFUSE_SECRET_KEY", "")
    if not (host and public_key and secret_key):
        print("LANGFUSE_HOST/PUBLIC_KEY/SECRET_KEY must be set", file=sys.stderr)
        return 2

    client = Langfuse(
        public_key=public_key, secret_key=secret_key, host=host, tracing_enabled=False
    )
    cutoff = datetime.now(timezone.utc) - timedelta(days=args.days)
    deleted = 0
    while True:
        # Deleting shifts pagination, so always re-read the first page.
        page = client.api.trace.list(
            to_timestamp=cutoff, limit=BATCH, page=1, fields="core"
        )
        ids = [trace.id for trace in page.data]
        if not ids:
            break
        if args.dry_run:
            total = getattr(getattr(page, "meta", None), "total_items", len(ids))
            print(f"[dry-run] {total} traces older than {args.days}d would be deleted")
            return 0
        client.api.trace.delete_multiple(trace_ids=ids)
        deleted += len(ids)
    print(f"deleted {deleted} traces older than {args.days}d")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
