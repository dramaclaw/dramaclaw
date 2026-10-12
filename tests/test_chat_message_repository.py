"""Legacy project message storage keeps its ordering and trace behavior."""

from novelvideo.chat import message_repository


def test_message_repository_keeps_recent_chat_and_trace_separate(tmp_path) -> None:
    conn = message_repository.connect(tmp_path / "chat.db")
    try:
        for index in range(4):
            message_repository.append_message(
                conn, "user", f"user-{index}", now_iso=lambda: "2026-01-01T00:00:00Z"
            )
        message_repository.append_message(
            conn, "trace", "old trace", now_iso=lambda: "2026-01-01T00:00:00Z"
        )
        message_repository.append_message(
            conn,
            "assistant",
            "answer",
            [{"type": "image", "url": "asset"}],
            now_iso=lambda: "2026-01-01T00:00:00Z",
        )

        rows = message_repository.recent_messages(conn, limit=2)
        assert [(row["role"], row["content"]) for row in rows] == [
            ("user", "user-3"),
            ("assistant", "answer"),
        ]
        assert rows[-1]["media_json"] == '[{"type": "image", "url": "asset"}]'

        message_repository.replace_trace_messages(
            conn,
            [{"role": "trace", "content": "new trace", "media": []}],
            now_iso=lambda: "2026-01-02T00:00:00Z",
        )
        assert message_repository.history_contents(conn, "trace", limit=10) == [
            "new trace"
        ]
        assert message_repository.history_contents(conn, "user", limit=2) == [
            "user-2",
            "user-3",
        ]
        assert [
            row["content"] for row in message_repository.recent_messages(conn, limit=2)
        ] == [
            "user-3",
            "answer",
        ]
    finally:
        conn.close()


def test_input_history_keeps_recent_nonempty_prompts_and_ignores_invalid_file(
    tmp_path,
) -> None:
    path = tmp_path / "input-history.json"
    path.write_text("{broken", encoding="utf-8")
    assert message_repository.load_chat_input_history(path) == []

    message_repository.save_chat_input_history(
        path, [" first ", "", "second", "third"], limit=2
    )
    assert message_repository.load_chat_input_history(path) == ["second", "third"]


def test_legacy_database_migration_preserves_messages_and_settings(tmp_path) -> None:
    legacy = tmp_path / "old" / "chat.db"
    conn = message_repository.connect(legacy)
    try:
        message_repository.append_message(
            conn, "user", "hello", now_iso=lambda: "2026-01-01T00:00:00Z"
        )
        message_repository.set_setting(
            conn, "model", "first", now_iso=lambda: "2026-01-01T00:00:00Z"
        )
        message_repository.set_setting(
            conn, "model", "second", now_iso=lambda: "2026-01-02T00:00:00Z"
        )
    finally:
        conn.close()

    current = tmp_path / "new" / "chat.db"
    message_repository.migrate_legacy_chat_db(legacy, current)
    assert not legacy.exists()
    conn = message_repository.connect(current)
    try:
        assert message_repository.get_setting(conn, "model") == "second"
        assert message_repository.history_contents(conn, "user", limit=10) == ["hello"]
    finally:
        conn.close()
