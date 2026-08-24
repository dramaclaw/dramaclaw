"""Shared home-node Codex App Server transport.

Codex threads remain project-scoped, but the Rust runtime is expensive enough
that it must not be spawned once per chat turn.  This module owns one local
App Server process per ``CODEX_HOME`` and gives each turn a lightweight
WebSocket connection over its private Unix socket.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import sqlite3
import stat
import subprocess
import threading
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator


_CONNECT_TIMEOUT_SECONDS = 10.0
_MAX_MESSAGE_BYTES = 128 << 20
_NODE_ENV_ALLOWLIST = {
    "ALL_PROXY",
    "CODEX_HOME",
    "DRAMACLAW_CODEX_GATEWAY_BASE_URL",
    "HOME",
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "NO_PROXY",
    "PATH",
    "SSL_CERT_DIR",
    "SSL_CERT_FILE",
    "TMPDIR",
    "TZ",
}
_TURN_METADATA_NAMES = (
    "dramaclaw_gateway_api_key",
    "dramaclaw_control_context_capability",
)
_DEBUG_METADATA_RE = re.compile(
    r"responsesapi_client_metadata: Some\(\{.*?\}\)(?=, additional_context:)",
    re.DOTALL,
)
_JSON_METADATA_RE = re.compile(
    rf'("(?:{"|".join(_TURN_METADATA_NAMES)})"\s*:\s*")[^"]*(")'
)
_ESCAPED_JSON_METADATA_RE = re.compile(
    rf'(\\"(?:{"|".join(_TURN_METADATA_NAMES)})\\"\s*:\s*\\")[^"\\]*(\\")'
)


def _control_dir() -> Path:
    """Return a short, private directory for the home-node control socket."""

    # macOS limits Unix-domain socket paths to roughly 104 bytes. CODEX_HOME is
    # intentionally below the configured state root and can easily exceed that
    # in a local checkout, so the transport endpoint cannot live below it.
    uid = os.getuid() if hasattr(os, "getuid") else os.getpid()
    path = Path("/tmp") / f"dramaclaw-codex-{uid}"
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    mode = path.lstat().st_mode
    if stat.S_ISLNK(mode) or not stat.S_ISDIR(mode):
        raise RuntimeError(f"Unsafe Codex App Server control directory: {path}")
    path.chmod(0o700)
    return path


def _control_paths(codex_home: Path) -> tuple[Path, Path, Path]:
    identity = hashlib.sha256(str(codex_home.resolve()).encode("utf-8")).hexdigest()[:20]
    control_dir = _control_dir()
    return (
        control_dir / f"{identity}.sock",
        control_dir / f"{identity}.lock",
        control_dir / f"{identity}.signature",
    )


def _signature_digest(signature: tuple[object, ...]) -> str:
    payload = json.dumps(signature, ensure_ascii=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _node_process_env(env: dict[str, str]) -> dict[str, str]:
    # This process is shared by all projects on a home node. Use an allowlist:
    # provider-specific secrets are too numerous to safely enumerate, and one
    # ambient credential would silently become authority for every project.
    return {key: value for key, value in env.items() if key in _NODE_ENV_ALLOWLIST}


def _redact_legacy_log_body(body: str) -> str:
    redacted = _DEBUG_METADATA_RE.sub(
        'responsesapi_client_metadata: Some({"<redacted>": "<redacted>"})',
        body,
    )
    redacted = _JSON_METADATA_RE.sub(r'\1<redacted>\2', redacted)
    return _ESCAPED_JSON_METADATA_RE.sub(r'\1<redacted>\2', redacted)


def _sanitize_legacy_turn_metadata(codex_home: Path) -> int:
    """Remove credentials left by an older stock 0.147 runtime.

    The patched runtime prevents new writes. This one-time-per-process scan is
    still needed because CODEX_HOME is persistent and may predate the patch.
    ``secure_delete`` plus ``VACUUM`` removes superseded SQLite page contents;
    truncating WAL removes the second copy.
    """

    database = codex_home / "logs_2.sqlite"
    if not database.is_file():
        return 0
    connection = sqlite3.connect(database, timeout=10)
    changed = 0
    try:
        connection.execute("PRAGMA secure_delete=ON")
        table = connection.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='logs'"
        ).fetchone()
        if table is None:
            return 0
        columns = {
            str(row[1]) for row in connection.execute("PRAGMA table_info(logs)")
        }
        if "feedback_log_body" not in columns:
            return 0
        for row_id, body in connection.execute(
            "SELECT rowid, feedback_log_body FROM logs"
        ).fetchall():
            if not isinstance(body, str):
                continue
            redacted = _redact_legacy_log_body(body)
            if redacted == body:
                continue
            connection.execute(
                "UPDATE logs SET feedback_log_body=? WHERE rowid=?",
                (redacted, row_id),
            )
            changed += 1
        connection.commit()
        if changed:
            connection.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            connection.execute("VACUUM")
            connection.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    finally:
        connection.close()
    return changed


class _SharedCodexRuntime:
    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._process: subprocess.Popen[bytes] | None = None
        self._signature: tuple[object, ...] | None = None
        self._socket_path: Path | None = None
        self._signature_path: Path | None = None

    @staticmethod
    def _socket_accepting(socket_path: Path) -> bool:
        if not socket_path.exists():
            return False
        from websockets.sync.client import unix_connect

        try:
            probe = unix_connect(
                str(socket_path),
                uri="ws://localhost/rpc",
                compression=None,
                open_timeout=0.2,
                close_timeout=0.2,
                max_size=_MAX_MESSAGE_BYTES,
            )
        except (OSError, TimeoutError):
            return False
        except Exception:
            return False
        probe.close()
        return True

    def ensure(
        self,
        *,
        codex_bin: Path,
        codex_home: Path,
        env: dict[str, str],
        config_overrides: tuple[str, ...],
    ) -> Path:
        from portalocker import Lock

        socket_path, lock_path, signature_path = _control_paths(codex_home)
        signature = (
            str(codex_bin),
            str(codex_home),
            config_overrides,
            env.get("DRAMACLAW_CODEX_GATEWAY_BASE_URL", ""),
        )
        signature_digest = _signature_digest(signature)
        with self._lock:
            with Lock(str(lock_path), mode="a", timeout=_CONNECT_TIMEOUT_SECONDS):
                if self._socket_accepting(socket_path):
                    existing_digest = ""
                    try:
                        existing_digest = signature_path.read_text(encoding="ascii").strip()
                    except OSError:
                        pass
                    if (
                        (self._signature is not None and self._signature != signature)
                        or (existing_digest and existing_digest != signature_digest)
                    ):
                        raise RuntimeError(
                            "Codex App Server is already running with different node-level "
                            "gateway configuration; restart the API before using the new configuration"
                        )
                    return socket_path

                if self._process is not None and self._process.poll() is not None:
                    self._process = None
                    self._signature = None

                # A crashed App Server can leave its socket inode behind. The
                # process-wide lock above prevents deleting a peer that is still
                # in the middle of binding the same endpoint.
                try:
                    socket_path.unlink(missing_ok=True)
                    signature_path.unlink(missing_ok=True)
                except OSError as exc:
                    raise RuntimeError(
                        f"Cannot clear stale Codex App Server control state: {exc}"
                    ) from exc

                codex_home.mkdir(parents=True, exist_ok=True)
                _sanitize_legacy_turn_metadata(codex_home)
                command = [str(codex_bin)]
                for override in config_overrides:
                    command.extend(("--config", override))
                command.extend(("app-server", "--listen", f"unix://{socket_path}"))
                # Project identity belongs to a thread's MCP process, never to the
                # shared node runtime. Keeping it here would make the first project
                # to start Codex become ambient authority for every later project.
                process_env = _node_process_env(env)
                process_env["CODEX_HOME"] = str(codex_home)
                log_path = codex_home / "app-server.log"
                with log_path.open("ab") as log_file:
                    self._process = subprocess.Popen(
                        command,
                        cwd=codex_home,
                        env=process_env,
                        stdin=subprocess.DEVNULL,
                        stdout=subprocess.DEVNULL,
                        stderr=log_file,
                    )
                self._signature = signature
                self._socket_path = socket_path
                self._signature_path = signature_path

                deadline = time.monotonic() + _CONNECT_TIMEOUT_SECONDS
                while time.monotonic() < deadline:
                    if self._socket_accepting(socket_path):
                        signature_path.write_text(signature_digest, encoding="ascii")
                        return socket_path
                    if self._process.poll() is not None:
                        self._process = None
                        self._signature = None
                        self._socket_path = None
                        self._signature_path = None
                        detail = ""
                        try:
                            detail = log_path.read_text(
                                encoding="utf-8", errors="replace"
                            )[-2000:].strip()
                        except OSError:
                            pass
                        raise RuntimeError(
                            detail or "Codex App Server exited before its socket was ready"
                        )
                    time.sleep(0.05)

                self.stop()
                raise RuntimeError("Timed out waiting for the shared Codex App Server")

    def stop(self) -> None:
        with self._lock:
            process = self._process
            self._process = None
            self._signature = None
            socket_path = self._socket_path
            signature_path = self._signature_path
            self._socket_path = None
            self._signature_path = None
        if process is None or process.poll() is not None:
            return
        process.terminate()
        try:
            process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=1)
        for path in (socket_path, signature_path):
            if path is not None:
                try:
                    path.unlink(missing_ok=True)
                except OSError:
                    pass


_RUNTIME = _SharedCodexRuntime()


def stop_shared_codex_runtime() -> None:
    """Drop the node runtime when turn-secret cleanup cannot be proven."""

    _RUNTIME.stop()


def _resolve_codex_bin(config) -> Path:
    if not config.codex_bin:
        raise RuntimeError(
            "CODEX_BIN must point to the DramaClaw-patched Codex runtime"
        )
    path = Path(config.codex_bin)
    if not path.exists():
        raise RuntimeError(f"Codex binary not found: {path}")
    return path


class _UnixSocketCodexClient:
    """Build the SDK client lazily so importing chat does not require Codex."""

    @staticmethod
    def create(config, socket_path: Path):
        from openai_codex.client import CodexClient as SdkCodexClient
        from openai_codex.errors import CodexError, TransportClosedError
        from websockets.exceptions import ConnectionClosed
        from websockets.sync.client import unix_connect

        class Client(SdkCodexClient):
            def __init__(self) -> None:
                super().__init__(config=config)
                self._socket_path = socket_path
                self._websocket = None

            def start(self) -> None:
                if self._websocket is not None:
                    return
                self._websocket = unix_connect(
                    str(self._socket_path),
                    uri="ws://localhost/rpc",
                    compression=None,
                    max_size=_MAX_MESSAGE_BYTES,
                    open_timeout=_CONNECT_TIMEOUT_SECONDS,
                )
                self._reader_thread = threading.Thread(
                    target=self._reader_loop,
                    daemon=True,
                )
                self._reader_thread.start()

            def close(self) -> None:
                websocket = self._websocket
                self._websocket = None
                if websocket is not None:
                    websocket.close()
                reader = self._reader_thread
                if (
                    reader is not None
                    and reader.is_alive()
                    and reader is not threading.current_thread()
                ):
                    reader.join(timeout=0.5)

            def _write_message(self, payload) -> None:
                websocket = self._websocket
                if websocket is None:
                    raise TransportClosedError("Codex App Server connection is not running")
                with self._lock:
                    try:
                        websocket.send(json.dumps(payload))
                    except ConnectionClosed as exc:
                        raise TransportClosedError(
                            "Codex App Server connection closed"
                        ) from exc

            def _read_message(self):
                websocket = self._websocket
                if websocket is None:
                    raise TransportClosedError("Codex App Server connection is not running")
                try:
                    raw = websocket.recv()
                except ConnectionClosed as exc:
                    raise TransportClosedError(
                        "Codex App Server connection closed"
                    ) from exc
                if not isinstance(raw, str):
                    raise CodexError("Codex App Server sent a non-text WebSocket frame")
                try:
                    message = json.loads(raw)
                except json.JSONDecodeError as exc:
                    raise CodexError("Codex App Server sent invalid JSON-RPC") from exc
                if not isinstance(message, dict):
                    raise CodexError("Codex App Server sent an invalid JSON-RPC payload")
                return message

        return Client()


@contextmanager
def shared_codex(config) -> Iterator[object]:
    """Open a lightweight client connection to the home-node App Server."""

    from openai_codex import Codex
    from openai_codex._initialize_metadata import validate_initialize_metadata

    env = dict(config.env or {})
    codex_home_raw = str(env.get("CODEX_HOME", "") or "").strip()
    if not codex_home_raw:
        raise RuntimeError("Shared Codex App Server requires CODEX_HOME")
    codex_home = Path(codex_home_raw)
    if not codex_home.is_absolute():
        raise RuntimeError("Shared Codex App Server requires an absolute CODEX_HOME")
    socket_path = _RUNTIME.ensure(
        codex_bin=_resolve_codex_bin(config),
        codex_home=codex_home,
        env=env,
        config_overrides=tuple(config.config_overrides),
    )
    client = _UnixSocketCodexClient.create(config, socket_path)
    codex = object.__new__(Codex)
    codex._client = client
    try:
        client.start()
        codex._init = validate_initialize_metadata(client.initialize())
        yield codex
    finally:
        client.close()
