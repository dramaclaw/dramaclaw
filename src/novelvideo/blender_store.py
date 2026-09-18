"""Blender 插件的配对、令牌与收件箱存储。

三张表塞在一个 sqlite 里，放在 `STATE_DIR/blender/blender.db`。理由见
`docs/superpowers/specs/2026-09-18-dramaclaw-blender-uploader-design.md`：这些数据
跟项目目录无关（令牌是账号级的），量极小，且需要「审批」「兑换」这类要原子性的
状态跳转——比往 json 文件里塞更省事，也不必为它引入新依赖。

模块里所有函数都显式收一个 `db_path`，不读全局状态，测试可以直接给 tmp_path。
路由层用 `default_db_path()`。
"""

from __future__ import annotations

import hashlib
import secrets
import sqlite3
import time
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator

from novelvideo.config import STATE_DIR

PAIRING_TTL_SECONDS = 5 * 60
TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60

# 去掉 0/O/1/I/L 这些抄错率高的字符。32 个字符 8 位 = 40 bit，配合 5 分钟有效期
# 和调用频率限制足够；再长用户就不愿意敲了。
_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
_CODE_GROUP = 4

_SCHEMA = """
CREATE TABLE IF NOT EXISTS blender_pairings (
    pairing_id    TEXT PRIMARY KEY,
    code_hash     TEXT NOT NULL UNIQUE,
    status        TEXT NOT NULL,
    created_at    INTEGER NOT NULL,
    expires_at    INTEGER NOT NULL,
    approved_user TEXT
);

CREATE TABLE IF NOT EXISTS blender_tokens (
    token_id   TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    user_id    TEXT NOT NULL,
    label      TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    revoked_at INTEGER,
    last_seen  INTEGER
);

CREATE INDEX IF NOT EXISTS blender_tokens_user ON blender_tokens (user_id);

CREATE TABLE IF NOT EXISTS blender_inbox (
    delivery_id TEXT PRIMARY KEY,
    project_id  TEXT NOT NULL,
    user_id     TEXT NOT NULL,
    url         TEXT NOT NULL,
    kind        TEXT NOT NULL,
    filename    TEXT NOT NULL,
    camera      TEXT NOT NULL,
    frame       INTEGER,
    frame_start INTEGER,
    frame_end   INTEGER,
    fps         REAL,
    width       INTEGER,
    height      INTEGER,
    created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS blender_inbox_project
    ON blender_inbox (user_id, project_id, created_at);

CREATE TABLE IF NOT EXISTS blender_rate_limits (
    bucket       TEXT PRIMARY KEY,
    window_start INTEGER NOT NULL,
    hits         INTEGER NOT NULL
);
"""


@dataclass(frozen=True)
class NewPairing:
    pairing_id: str
    code: str
    expires_at: int


@dataclass(frozen=True)
class PairingResult:
    """`consume_pairing` 的回答。

    `status` 只有四种：pending / approved / consumed / expired。**不存在**
    「不认识这个 id」——未知 id 一律回 expired，否则这个端点就成了枚举 oracle。
    """

    status: str
    token: str | None = None
    user_id: str | None = None


def _now() -> int:
    return int(time.time())


def default_db_path() -> Path:
    return Path(STATE_DIR) / "blender" / "blender.db"


@contextmanager
def _connect(db_path: Path) -> Iterator[sqlite3.Connection]:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path, isolation_level=None)
    conn.row_factory = sqlite3.Row
    try:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA foreign_keys=ON")
        yield conn
    finally:
        conn.close()


def init_db(db_path: Path) -> None:
    with _connect(db_path) as conn:
        conn.executescript(_SCHEMA)


def _hash(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def normalize_code(raw: str) -> str:
    """把用户敲进来的码收敛成库里存的那个形状。

    人会打小写、会多敲空格、会把连字符敲成别的——这些都不该算错码。
    """
    compact = "".join(ch for ch in (raw or "").upper() if ch in _CODE_ALPHABET)
    if len(compact) != _CODE_GROUP * 2:
        return ""
    return f"{compact[:_CODE_GROUP]}-{compact[_CODE_GROUP:]}"


def _generate_code() -> str:
    body = "".join(secrets.choice(_CODE_ALPHABET) for _ in range(_CODE_GROUP * 2))
    return f"{body[:_CODE_GROUP]}-{body[_CODE_GROUP:]}"


def create_pairing(db_path: Path) -> NewPairing:
    now = _now()
    expires_at = now + PAIRING_TTL_SECONDS
    init_db(db_path)
    with _connect(db_path) as conn:
        for _ in range(8):
            code = _generate_code()
            pairing_id = secrets.token_urlsafe(24)
            try:
                conn.execute(
                    "INSERT INTO blender_pairings "
                    "(pairing_id, code_hash, status, created_at, expires_at) "
                    "VALUES (?, ?, 'pending', ?, ?)",
                    (pairing_id, _hash(code), now, expires_at),
                )
            except sqlite3.IntegrityError:
                # 码撞了（未过期的同码）。重抽，不要把别人的配对顶掉。
                continue
            return NewPairing(pairing_id=pairing_id, code=code, expires_at=expires_at)
    raise RuntimeError("生成配对码失败，请重试")


def approve_pairing(db_path: Path, raw_code: str, *, user_id: str) -> bool:
    """浏览器侧确认。已批过、过期、不存在都回 False，不区分——码是可猜的。"""
    code = normalize_code(raw_code)
    if not code:
        return False
    with _connect(db_path) as conn:
        conn.execute("BEGIN IMMEDIATE")
        cur = conn.execute(
            "UPDATE blender_pairings SET status = 'approved', approved_user = ? "
            "WHERE code_hash = ? AND status = 'pending' AND expires_at > ?",
            (user_id, _hash(code), _now()),
        )
        conn.execute("COMMIT")
        return cur.rowcount == 1


def consume_pairing(db_path: Path, pairing_id: str) -> PairingResult:
    """插件轮询。已批则**当场**生成令牌并把配对置为 consumed。

    令牌到这一刻才存在，之前任何一行里都没有它——授权还没发生就先造钥匙，
    等于给自己留一个会过期但一直躺在库里的秘密。
    """
    with _connect(db_path) as conn:
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute(
            "SELECT status, expires_at, approved_user FROM blender_pairings "
            "WHERE pairing_id = ?",
            (pairing_id,),
        ).fetchone()

        if row is None:
            conn.execute("COMMIT")
            return PairingResult(status="expired")
        if row["status"] == "consumed":
            conn.execute("COMMIT")
            return PairingResult(status="consumed")
        if row["expires_at"] <= _now():
            conn.execute("COMMIT")
            return PairingResult(status="expired")
        if row["status"] != "approved":
            conn.execute("COMMIT")
            return PairingResult(status="pending")

        user_id = row["approved_user"]
        token = _insert_token(conn, user_id=user_id, label="Blender")
        conn.execute(
            "UPDATE blender_pairings SET status = 'consumed' WHERE pairing_id = ?",
            (pairing_id,),
        )
        conn.execute("COMMIT")
        return PairingResult(status="approved", token=token, user_id=user_id)


def purge_expired(db_path: Path) -> None:
    """清掉没人来兑的配对。过期的行留着只是垃圾，不是记录。"""
    with _connect(db_path) as conn:
        conn.execute(
            "DELETE FROM blender_pairings WHERE expires_at <= ? AND status != 'approved'",
            (_now(),),
        )


def _insert_token(conn: sqlite3.Connection, *, user_id: str, label: str) -> str:
    token = secrets.token_urlsafe(32)
    now = _now()
    conn.execute(
        "INSERT INTO blender_tokens "
        "(token_id, token_hash, user_id, label, created_at, expires_at) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (
            secrets.token_urlsafe(12),
            _hash(token),
            user_id,
            label,
            now,
            now + TOKEN_TTL_SECONDS,
        ),
    )
    return token
