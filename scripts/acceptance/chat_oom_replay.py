"""Local-only browser replay fixture. Real UI-event route and history read; synthetic agent.
Run with python -m scripts.acceptance.chat_oom_replay; use Vite proxy to port 18791.
All state is temporary. No external models, authentication or project lookup.
"""

import asyncio
import json
import resource
import tempfile
from pathlib import Path
from types import SimpleNamespace

import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from novelvideo.api.routes import chat
from novelvideo.chat.store import ChatScope

root = tempfile.TemporaryDirectory(prefix="chat-oom-browser-")
state = Path(root.name)
app = FastAPI()
user = {"username": "oom-replay"}
scope = ChatScope(
    kind="project",
    id="oom-replay",
    surface="freezone",
    canvas_id="replay",
    agent_id="main",
    state_dir=str(state),
)
sockets = set()
metrics = {
    "posts": 0,
    "connections": 0,
    "history_reads": 0,
    "sent": 0,
    "running": False,
}


async def project(*args, **kwargs):
    return SimpleNamespace(project_name="oom-replay", state_dir=state, output_dir=state)


chat._project_context_for_scope = project


@app.post("/api/v1/chat/ui-events")
async def persist(payload: chat.ChatUiEventIn):
    metrics["posts"] += 1
    return await chat.append_chat_ui_event(payload, user)


async def history(ws):
    await chat._send_scope_changed(ws, user, user["username"], scope)
    metrics["history_reads"] += 1


@app.websocket("/api/v1/chat/ws")
async def websocket(ws: WebSocket):
    await ws.accept()
    sockets.add(ws)
    metrics["connections"] += 1
    try:
        await history(ws)
        while True:
            frame = await ws.receive_json()
            if frame.get("type") == "scope.set":
                await history(ws)
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        sockets.discard(ws)


async def emit(frame):
    for ws in list(sockets):
        await ws.send_json({**frame, "scope": scope.to_dict(), "turn_id": "incident"})


async def replay():
    metrics["running"] = True
    await chat.chat_store.append_message_async(
        user["username"], scope, "user", "Synthetic incident", turn_id="incident"
    )
    await emit({"type": "agent.turn.started"})
    # Same event count and final character count as the report, accelerated delivery.
    total = 538638
    try:
        for i in range(46930):
            size = total // 46930 + (i < total % 46930)
            await emit({"type": "agent.thought.delta", "text": "x" * size})
            metrics["sent"] = i + 1
            if i % 100 == 0:
                await asyncio.sleep(0.01)
        await emit({"type": "chat.done"})
    finally:
        metrics["running"] = False


@app.post("/api/v1/replay/start")
async def start():
    if not metrics["running"] and not metrics["sent"]:
        asyncio.create_task(replay())
    return metrics


@app.post("/api/v1/replay/disconnect")
async def disconnect():
    for ws in list(sockets):
        await ws.close(code=1012)
    return {"ok": True}


@app.get("/api/v1/replay/metrics")
async def inspect():
    with chat.chat_store.connect(user["username"], scope) as conn:
        count, size = conn.execute(
            "SELECT count(*),coalesce(sum(length(CAST(payload_json AS BLOB))),0) FROM chat_ui_events"
        ).fetchone()
        row = conn.execute(
            "SELECT payload_json FROM chat_ui_events WHERE event_type='assistant.message_parts' ORDER BY id DESC LIMIT 1"
        ).fetchone()
    chars = 0
    if row:
        chars = sum(
            len(part.get("event", {}).get("text", ""))
            for part in json.loads(row[0])["parts"]
            if part.get("type") == "agent_thought"
        )
    return {
        **metrics,
        "rows": count,
        "payload_bytes": size,
        "saved_characters": chars,
        "peak_rss_bytes": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,
    }


def seed_legacy_fixture(database):
    """Inflate only a replay fixture, preserving its final snapshot for comparison."""
    import sqlite3

    if not any(part.startswith("chat-oom-browser-") for part in database.parts):
        raise ValueError("Only temporary replay databases may be seeded")
    with sqlite3.connect(database) as conn:
        raw = conn.execute(
            "SELECT payload_json FROM chat_ui_events WHERE event_type='assistant.message_parts' ORDER BY id DESC LIMIT 1"
        ).fetchone()[0]
        original = json.loads(raw)
        for i in range(46929):
            payload = json.loads(raw)
            for part in payload["parts"]:
                if part.get("type") == "agent_thought":
                    part["event"]["text"] = "x" * (1024 + i * 2)
            conn.execute(
                "INSERT INTO chat_ui_events(turn_id,event_type,payload_json,created_at) VALUES (?,?,?,?)",
                (
                    "incident",
                    "assistant.message_parts",
                    json.dumps(payload),
                    "synthetic",
                ),
            )
            if i % 1000 == 0:
                conn.commit()
        conn.execute(
            "INSERT INTO chat_ui_events(turn_id,event_type,payload_json,created_at) VALUES (?,?,?,?)",
            ("incident", "assistant.message_parts", json.dumps(original), "synthetic"),
        )
    conn.close()
    print(
        json.dumps({"fixture_bytes": database.stat().st_size, "snapshot_rows": 46931})
    )


if __name__ == "__main__":
    import sys

    if len(sys.argv) == 3 and sys.argv[1] == "--seed-fixture":
        seed_legacy_fixture(Path(sys.argv[2]))
        root.cleanup()
        raise SystemExit(0)
    try:
        uvicorn.run(app, host="127.0.0.1", port=18791, log_level="warning")
    finally:
        root.cleanup()
