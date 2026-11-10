"""Offline chat snapshot compaction. Stop writers and back up the database first.

Usage: python scripts/compact_chat_ui_events.py /path/to/chat.db [--apply]
Without --apply, only reports the number of snapshot rows.
"""

import argparse
import json
import sqlite3
from pathlib import Path

from novelvideo.chat.store import ChatStore, UI_EVENT_MAX_BYTES


def compact(path: Path, *, apply: bool = False) -> int:
    connection = sqlite3.connect(
        f"file:{path}?mode={'rw' if apply else 'ro'}", uri=True
    )
    try:
        count = connection.execute(
            "SELECT count(*) FROM chat_ui_events WHERE event_type='assistant.message_parts'"
        ).fetchone()[0]
        if not apply:
            return count
        # Keep staging and sorting off the heap even with many distinct turns.
        connection.execute("PRAGMA temp_store=FILE")
        connection.execute("PRAGMA cache_size=-2048")
        connection.execute("PRAGMA temp.cache_size=-2048")
        connection.execute("BEGIN IMMEDIATE")
        turns = connection.execute(
            "SELECT DISTINCT turn_id FROM chat_ui_events WHERE event_type='assistant.message_parts'"
        )
        # Do not modify the source while iterating it. Stage one merged row per turn on disk.
        connection.execute(
            "CREATE TEMP TABLE compacted(id INTEGER PRIMARY KEY, payload TEXT)"
        )
        for (turn,) in turns:
            parts = []
            last = None
            for row_id, raw in connection.execute(
                "SELECT id, CASE WHEN length(CAST(payload_json AS BLOB))<=? "
                "THEN payload_json END FROM chat_ui_events WHERE turn_id=? "
                "AND event_type='assistant.message_parts' ORDER BY id",
                (UI_EVENT_MAX_BYTES, turn),
            ):
                if raw is None:
                    raise ValueError("Oversized snapshot; database left unchanged")
                payload = json.loads(raw)
                parts = ChatStore._merge_message_parts_snapshots(
                    [parts, payload["parts"]]
                )
                last = (row_id, payload)
            if last:
                # Serialize once per turn; only the final merged snapshot is stored.
                row_id, payload = last
                merged = json.dumps({**payload, "parts": parts}, ensure_ascii=False)
                if len(merged.encode()) > UI_EVENT_MAX_BYTES:
                    raise ValueError(
                        "Merged snapshot exceeds budget; database left unchanged"
                    )
                connection.execute("INSERT INTO compacted VALUES (?,?)", (row_id, merged))
        connection.execute(
            "UPDATE chat_ui_events SET payload_json=(SELECT payload FROM compacted WHERE compacted.id=chat_ui_events.id) WHERE id IN (SELECT id FROM compacted)"
        )
        connection.execute(
            "DELETE FROM chat_ui_events WHERE event_type='assistant.message_parts' AND id NOT IN (SELECT id FROM compacted)"
        )
        connection.commit()
        connection.execute("VACUUM")
        return count
    finally:
        connection.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("database", type=Path)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    print(f"Snapshot rows inspected: {compact(args.database, apply=args.apply)}")
