"""Transparent, durable request-transport BrainClaw Outcome reporting.

The model transport records BrainClaw's signed receipt; the Pydantic model
wrapper reports only whether its OpenAI transport completed. Pydantic result
validation and business completion happen above this boundary, so this module
must never label either one as successful. Business
callers remain unaware of routing and never wait for Outcome delivery.
"""

from __future__ import annotations

from contextvars import ContextVar, Token
import hashlib
import hmac
import json
import os
from pathlib import Path
import sqlite3
import stat
import threading
import time
import urllib.error
import urllib.request


RECEIPT_HEADER = "x-brainclaw-outcome-receipt"
_receipts: ContextVar[tuple[str, ...]] = ContextVar("brainclaw_outcome_receipts", default=())
_runtime: "OutcomeRuntime | None" = None
_runtime_lock = threading.Lock()


def begin_request_outcomes() -> Token[tuple[str, ...]]:
    return _receipts.set(())


def reset_request_outcomes(token: Token[tuple[str, ...]]) -> None:
    _receipts.reset(token)


async def capture_brainclaw_receipt(response) -> None:
    receipt = str(response.headers.get(RECEIPT_HEADER) or "").strip()
    if receipt and receipt.startswith("v1."):
        current = _receipts.get()
        if receipt not in current:
            _receipts.set((*current, receipt))


def report_request_outcomes(*, passed: bool) -> None:
    runtime = outcome_runtime()
    if runtime is None:
        return
    for receipt in _receipts.get():
        runtime.enqueue(receipt, passed=passed)


class OutcomeRuntime:
    def __init__(self, *, endpoint: str, key_path: Path, database: Path) -> None:
        info = key_path.stat()
        if not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o600:
            raise ValueError("BrainClaw Outcome key must be a 0600 regular file")
        self.key = key_path.read_bytes().strip()
        if len(self.key) < 32:
            raise ValueError("BrainClaw Outcome key is too short")
        if not endpoint.startswith("http://127.0.0.1:") and not endpoint.startswith("http://localhost:"):
            raise ValueError("BrainClaw Outcome endpoint must be loopback HTTP")
        self.endpoint = endpoint
        database.parent.mkdir(parents=True, exist_ok=True)
        database.parent.chmod(0o700)
        self.connection = sqlite3.connect(database, check_same_thread=False)
        database.chmod(0o600)
        self.connection.execute(
            "CREATE TABLE IF NOT EXISTS outcomes (identity TEXT PRIMARY KEY, body TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_attempt REAL NOT NULL DEFAULT 0)"
        )
        self.connection.commit()
        self.lock = threading.Lock()
        self.wake = threading.Event()
        self.thread = threading.Thread(target=self._run, name="brainclaw-outcomes", daemon=True)
        self.thread.start()

    def enqueue(self, receipt: str, *, passed: bool) -> None:
        payload = {
            "receipt": receipt,
            "outcome_scope": "request",
            "outcome_status": "succeeded" if passed else "failed",
            "outcome_source": "automatic_contract",
            "terminal": True,
            "quality_score": 1.0 if passed else 0.0,
            "reward_method": "dramaclaw-openai-transport-v1",
            "evaluator_version": "dramaclaw-openai-transport-v1",
        }
        body = json.dumps(payload, separators=(",", ":"), sort_keys=True)
        identity = hashlib.sha256(f"{receipt}\0request\0automatic_contract".encode()).hexdigest()
        with self.lock:
            self.connection.execute("INSERT OR IGNORE INTO outcomes(identity,body) VALUES(?,?)", (identity, body))
            self.connection.commit()
        self.wake.set()

    def _run(self) -> None:
        while True:
            self.wake.wait(5.0)
            self.wake.clear()
            with self.lock:
                rows = self.connection.execute(
                    "SELECT identity,body,attempts FROM outcomes WHERE next_attempt<=? ORDER BY rowid LIMIT 100", (time.time(),)
                ).fetchall()
            for identity, body, attempts in rows:
                encoded = body.encode()
                signature = hmac.new(self.key, encoded, hashlib.sha256).hexdigest()
                request = urllib.request.Request(
                    self.endpoint, data=encoded, method="POST",
                    headers={"Content-Type": "application/json", "X-BrainClaw-Outcome-Signature": signature},
                )
                try:
                    with urllib.request.urlopen(request, timeout=5) as response:
                        status_code = response.status
                except urllib.error.HTTPError as exc:
                    status_code = exc.code
                except (urllib.error.URLError, TimeoutError):
                    status_code = 503
                with self.lock:
                    if status_code == 202 or 400 <= status_code < 500:
                        self.connection.execute("DELETE FROM outcomes WHERE identity=?", (identity,))
                    else:
                        delay = min(300.0, 2.0 ** min(attempts + 1, 8))
                        self.connection.execute(
                            "UPDATE outcomes SET attempts=attempts+1,next_attempt=? WHERE identity=?",
                            (time.time() + delay, identity),
                        )
                    self.connection.commit()


def outcome_runtime() -> OutcomeRuntime | None:
    global _runtime
    endpoint = os.environ.get("BRAINCLAW_OUTCOME_URL", "").strip()
    key_file = os.environ.get("BRAINCLAW_OUTCOME_KEY_FILE", "").strip()
    if not endpoint and not key_file:
        return None
    if not endpoint or not key_file:
        raise ValueError("BrainClaw Outcome requires both URL and key file")
    with _runtime_lock:
        if _runtime is None:
            state = Path(os.environ.get("BRAINCLAW_OUTCOME_STATE_DIR", "state/brainclaw"))
            _runtime = OutcomeRuntime(endpoint=endpoint, key_path=Path(key_file), database=state / "outcomes.sqlite3")
    return _runtime
