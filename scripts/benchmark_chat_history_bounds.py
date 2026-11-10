"""Local synthetic OOM regression benchmark; temporary databases are removed on exit.

Run: python -m scripts.benchmark_chat_history_bounds --rows 46930
Each measurement runs in a fresh subprocess so peak RSS excludes fixture construction.
"""

import argparse
import asyncio
import json
import resource
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from novelvideo.chat.store import ChatScope, ChatStore
from scripts.compact_chat_ui_events import compact


def event(text, early=False):
    parts = [{"id": "thought", "type": "agent_thought", "text": text}]
    if early:
        parts.insert(0, {"id": "early", "type": "tool_status", "text": "keep me"})
    return {"type": "assistant.message_parts", "parts": parts}


def objects(root):
    return ChatStore(), ChatScope(kind="project", id="bench", state_dir=str(root))


def measure(root, mode):
    store, scope = objects(root)
    started = time.perf_counter()
    if mode == "sync":
        for _ in range(100):
            messages = store.list_messages("bench", scope)
            assert messages[0]["parts_incomplete"]
            assert len(messages[0]["parts"][-1]["text"]) == 538638
    elif mode == "async":

        async def reader():
            for _ in range(20):
                messages = await store.list_messages_async("bench", scope)
                assert messages[0]["parts_incomplete"]

        async def readers():
            await asyncio.gather(*(reader() for _ in range(8)))

        asyncio.run(readers())
    elif mode == "compact":
        compact(store.db_for("bench", scope), apply=True)
        messages = store.list_messages("bench", scope)
        assert not messages[0].get("parts_incomplete")
        assert messages[0]["parts"] == event("文" * 538638, early=True)["parts"]
        assert messages[0]["content"] == "original body"
        with store.connect("bench", scope) as conn:
            assert (
                conn.execute("SELECT count(*) FROM chat_ui_events").fetchone()[0] == 2
            )
            assert json.loads(
                conn.execute(
                    "SELECT payload_json FROM chat_ui_events WHERE event_type='notice'"
                ).fetchone()[0]
            ) == {"type": "notice"}
    elif mode == "writes":
        for i in range(2000):
            store.append_ui_event("bench", scope, "turn", event("x" * (i * 256)))
        with store.connect("bench", scope) as conn:
            assert (
                conn.execute(
                    "SELECT count(*) FROM chat_ui_events WHERE event_type='assistant.message_parts'"
                ).fetchone()[0]
                == 1
            )
    peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    if sys.platform != "darwin":
        peak *= 1024
    report = {
        "mode": mode,
        "seconds": round(time.perf_counter() - started, 3),
        "peak_rss_mib": round(peak / 1048576, 2),
        "db_bytes": store.db_for("bench", scope).stat().st_size,
    }
    print(json.dumps(report), flush=True)
    assert peak < 512 * 1048576, report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rows", type=int, default=46930)
    parser.add_argument("--worker", choices=["sync", "async", "compact", "writes"])
    parser.add_argument("--root", type=Path)
    args = parser.parse_args()
    if args.worker:
        measure(args.root, args.worker)
        return
    with tempfile.TemporaryDirectory(prefix="chat-oom-benchmark-") as directory:
        root = Path(directory)
        store, scope = objects(root)
        store.append_message("bench", scope, "user", "original body", turn_id="turn")
        with store.connect("bench", scope) as conn:
            # ~2.1 GiB of cumulative snapshots, with incident-size final rows.
            for i in range(args.rows):
                text = "x" * (1024 + i * 2) if i < args.rows - 10 else "文" * 538638
                conn.execute(
                    "INSERT INTO chat_ui_events(turn_id,event_type,payload_json,created_at) VALUES (?,?,?,?)",
                    (
                        "turn",
                        "assistant.message_parts",
                        json.dumps(event(text, i == 0), ensure_ascii=False),
                        "now",
                    ),
                )
                if i % 1000 == 0:
                    conn.commit()
            conn.execute(
                "INSERT INTO chat_ui_events(turn_id,event_type,payload_json,created_at) VALUES (?,?,?,?)",
                ("turn", "notice", '{"type":"notice"}', "now"),
            )
        conn.close()
        print(
            json.dumps(
                {
                    "rows": args.rows,
                    "fixture_bytes": store.db_for("bench", scope).stat().st_size,
                }
            ),
            flush=True,
        )
        for mode in ["sync", "async", "compact", "writes"]:
            subprocess.run(
                [
                    sys.executable,
                    "-m",
                    "scripts.benchmark_chat_history_bounds",
                    "--worker",
                    mode,
                    "--root",
                    str(root),
                ],
                check=True,
            )


if __name__ == "__main__":
    main()
