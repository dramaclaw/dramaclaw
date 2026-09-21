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
from novelvideo.sqlite_pragmas import configure_sqlite_connection

PAIRING_TTL_SECONDS = 5 * 60
TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60

# 收件箱只是个「有新东西待认领」的提示，不是归档。超过一天还没人认领，说明用户
# 早就忘了自己传过什么，这时候再自动往画布上塞东西只会让人莫名其妙。过期只是不再
# 自动上画布——文件本身还在项目的 `freezone/_uploads/` 里，素材库照样能找到。
INBOX_TTL_SECONDS = 24 * 60 * 60

# 去掉 0/O/1/I/L 这些抄错率高的字符。32 个字符 8 位 = 40 bit，配合 5 分钟有效期
# 和调用频率限制足够；再长用户就不愿意敲了。
_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
_CODE_GROUP = 4

# 只容忍这些：用户会打空格、会把分组符敲成别的。除此之外出现字母表外的字符，
# 说明他敲错了，不要替他「纠正」成另一个合法码——那样他以为自己敲对了，
# 而日志里永远看不出他实际敲了什么。
_CODE_SEPARATORS = frozenset(" \t\r\n-_.")

_SCHEMA = """
CREATE TABLE IF NOT EXISTS blender_pairings (
    pairing_id_hash TEXT PRIMARY KEY,
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


@dataclass(frozen=True)
class BlenderClient:
    """一个已配对的插件。**不带**令牌本身——这个对象会被序列化给前端。"""

    token_id: str
    user_id: str
    label: str
    created_at: int
    expires_at: int
    last_seen: int | None


def _now() -> int:
    return int(time.time())


def default_db_path() -> Path:
    return Path(STATE_DIR) / "blender" / "blender.db"


@contextmanager
def _connect(db_path: str | Path) -> Iterator[sqlite3.Connection]:
    path = Path(db_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path, isolation_level=None)
    conn.row_factory = sqlite3.Row
    try:
        configure_sqlite_connection(conn)
        # 建表放在这儿而不是只放在 create_pairing 里：不能假设 create_pairing
        # 一定先被调到。state 卷被清空后，第一个到达的往往是插件的轮询，
        # 那时该回 expired 让它重新配对，而不是抛 500 把轮询循环打死。
        conn.executescript(_SCHEMA)
        yield conn
    finally:
        conn.close()


def init_db(db_path: str | Path) -> None:
    """建表。`_connect` 已经会建，这个函数留给显式初始化和测试。"""
    with _connect(db_path):
        pass


def _hash(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def normalize_code(raw: str | None) -> str:
    """把用户敲进来的码收敛成库里存的那个形状。

    人会打小写、会多敲空格、会把连字符敲成别的——这些都不该算错码。
    但字母表里没有的字符（`0` `O` `1` `I` `L` 这些一开始就被排除掉的易混字符）
    出现在输入里就是笔误，整个码判非法。
    """
    compact = "".join(
        ch for ch in (raw or "").upper() if ch not in _CODE_SEPARATORS
    )
    if len(compact) != _CODE_GROUP * 2:
        return ""
    if any(ch not in _CODE_ALPHABET for ch in compact):
        return ""
    return f"{compact[:_CODE_GROUP]}-{compact[_CODE_GROUP:]}"


def _generate_code() -> str:
    body = "".join(secrets.choice(_CODE_ALPHABET) for _ in range(_CODE_GROUP * 2))
    return f"{body[:_CODE_GROUP]}-{body[_CODE_GROUP:]}"


def create_pairing(db_path: str | Path) -> NewPairing:
    now = _now()
    expires_at = now + PAIRING_TTL_SECONDS
    last_error: sqlite3.IntegrityError | None = None
    with _connect(db_path) as conn:
        for _ in range(8):
            code = _generate_code()
            pairing_id = secrets.token_urlsafe(24)
            try:
                conn.execute(
                    "INSERT INTO blender_pairings "
                    "(pairing_id_hash, code_hash, status, created_at, expires_at) "
                    "VALUES (?, ?, 'pending', ?, ?)",
                    (_hash(pairing_id), _hash(code), now, expires_at),
                )
            except sqlite3.IntegrityError as exc:
                # UNIQUE 撞的是库里所有行，不分过期与否。重抽，不要把别人的配对顶掉。
                last_error = exc
                continue
            return NewPairing(pairing_id=pairing_id, code=code, expires_at=expires_at)
    raise RuntimeError("生成配对码失败，请重试") from last_error


def approve_pairing(db_path: str | Path, raw_code: str, *, user_id: str) -> bool:
    """浏览器侧确认。已批过、过期、不存在都回 False，不区分——码是可猜的。"""
    code = normalize_code(raw_code)
    if not code:
        return False
    if not user_id:
        # 路由层拿到空 user_id（未登录降级、字段名写错）时，宁可让批准失败，
        # 也不要发出一个绑定到空用户的 30 天令牌。
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


def consume_pairing(db_path: str | Path, pairing_id: str) -> PairingResult:
    """插件轮询。已批则**当场**生成令牌并把配对置为 consumed。

    令牌到这一刻才存在，之前任何一行里都没有它——授权还没发生就先造钥匙，
    等于给自己留一个会过期但一直躺在库里的秘密。
    """
    pairing_id_hash = _hash(pairing_id)
    with _connect(db_path) as conn:
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute(
            "SELECT status, expires_at, approved_user FROM blender_pairings "
            "WHERE pairing_id_hash = ?",
            (pairing_id_hash,),
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
            "UPDATE blender_pairings SET status = 'consumed' "
            "WHERE pairing_id_hash = ?",
            (pairing_id_hash,),
        )
        conn.execute("COMMIT")
        return PairingResult(status="approved", token=token, user_id=user_id)


def purge_expired(db_path: str | Path) -> None:
    """清掉过期的配对和过期的收件箱行。

    配对不按 status 区分：过期的 approved 行同样兑不出令牌了（`consume_pairing` 的
    过期检查排在状态检查之前），留着只是永久占着 code_hash 的 UNIQUE 名额。
    consumed 行也不必留——令牌本身记在 blender_tokens 里。

    收件箱同理：`blender_inbox` 没有任何别的删除路径，不在这里清就是只增不减。

    这个函数现在挂在系统里调用最频繁的路径上——`take_inbox` 每次被轮询都先跑
    它一遍。收件箱那条 `DELETE ... WHERE created_at <= ?` 是全表扫描：
    `blender_inbox_project` 索引以 `user_id` 开头，这条查询用不上它。实测
    1 万行时能把一次空轮询从 0.59ms 拉到 0.95ms——现在这点开销可以接受，因为
    有 TTL 兜底表不会无限长；但谁要是想把 `INBOX_TTL_SECONDS` 调大很多，
    得先想清楚这笔账，因为它的成本是跟着全局表大小涨的，不是跟着某个用户或
    项目的行数涨的。
    """
    now = _now()
    with _connect(db_path) as conn:
        conn.execute("DELETE FROM blender_pairings WHERE expires_at <= ?", (now,))
        conn.execute(
            "DELETE FROM blender_inbox WHERE created_at <= ?",
            (now - INBOX_TTL_SECONDS,),
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


def verify_token(db_path: str | Path, token: str) -> BlenderClient | None:
    """校验插件令牌。任何一种不通过都返回 None，调用方不需要区分原因。"""
    if not token:
        return None
    with _connect(db_path) as conn:
        row = conn.execute(
            "SELECT token_id, user_id, label, created_at, expires_at, last_seen "
            "FROM blender_tokens "
            "WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?",
            (_hash(token), _now()),
        ).fetchone()
        if row is None:
            return None
        now = _now()
        conn.execute(
            "UPDATE blender_tokens SET last_seen = ? WHERE token_id = ?",
            (now, row["token_id"]),
        )
        return BlenderClient(
            token_id=row["token_id"],
            user_id=row["user_id"],
            label=row["label"],
            created_at=row["created_at"],
            expires_at=row["expires_at"],
            last_seen=now,
        )


def list_tokens(db_path: str | Path, *, user_id: str) -> list[BlenderClient]:
    with _connect(db_path) as conn:
        rows = conn.execute(
            "SELECT token_id, user_id, label, created_at, expires_at, last_seen "
            "FROM blender_tokens "
            "WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ? "
            "ORDER BY created_at DESC",
            (user_id, _now()),
        ).fetchall()
    return [
        BlenderClient(
            token_id=row["token_id"],
            user_id=row["user_id"],
            label=row["label"],
            created_at=row["created_at"],
            expires_at=row["expires_at"],
            last_seen=row["last_seen"],
        )
        for row in rows
    ]


def revoke_token(db_path: str | Path, token_id: str, *, user_id: str) -> bool:
    """吊销。`user_id` 是 WHERE 的一部分，不是先查后判——少一次 TOCTOU。"""
    with _connect(db_path) as conn:
        cur = conn.execute(
            "UPDATE blender_tokens SET revoked_at = ? "
            "WHERE token_id = ? AND user_id = ? AND revoked_at IS NULL",
            (_now(), token_id, user_id),
        )
        return cur.rowcount == 1


def record_delivery(
    db_path: str | Path,
    *,
    user_id: str,
    project_id: str,
    url: str,
    kind: str,
    filename: str,
    camera: str,
    frame: int | None,
    frame_start: int | None,
    frame_end: int | None,
    fps: float | None,
    width: int | None,
    height: int | None,
) -> str:
    """记一条待认领的投递。

    文件此刻已经落在项目的 `freezone/_uploads/` 里了——这一行只是告诉前端
    「有新东西，位置在这」。就算这行写失败，素材也不会丢，用户仍能在素材库里找到。
    """
    delivery_id = secrets.token_urlsafe(12)
    with _connect(db_path) as conn:
        conn.execute(
            "INSERT INTO blender_inbox (delivery_id, project_id, user_id, url, kind, "
            "filename, camera, frame, frame_start, frame_end, fps, width, height, "
            "created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                delivery_id,
                project_id,
                user_id,
                url,
                kind,
                filename,
                camera,
                frame,
                frame_start,
                frame_end,
                fps,
                width,
                height,
                _now(),
            ),
        )
    return delivery_id


def list_inbox(db_path: str | Path, *, user_id: str, project_id: str) -> list[dict]:
    """非破坏性地看一眼收件箱。**生产代码不该调它**——生产读走 `take_inbox`。

    `src/` 下没有任何调用方，只有测试在用：`take_inbox` 取完就删，测试要断言
    「这一行还在」就没法用它自己去查。留着这个函数就是为了这一件事。

    `ORDER BY` 必须跟 `take_inbox` 保持逐字一致（都是 `created_at, rowid`）：
    这里存在的意义是给测试当一面「不破坏现场」的镜子，如果它排序方式跟生产读
    不一样，镜子里照出来的顺序问题会被当成正常，反而把真正的排序 bug 藏起来。
    """
    with _connect(db_path) as conn:
        rows = conn.execute(
            "SELECT * FROM blender_inbox WHERE user_id = ? AND project_id = ? "
            "ORDER BY created_at, rowid",
            (user_id, project_id),
        ).fetchall()
    return [dict(row) for row in rows]


def take_inbox(db_path: str | Path, *, user_id: str, project_id: str) -> list[dict]:
    """取走该用户在该项目下所有待认领的投递，**取完即删**。

    为什么是「取走」而不是「读 + 标记已读」：认领的终点是画布上多出来的节点，而节点
    一进 store 就会被自动保存落盘。行留着，下一轮 5 秒后的轮询就会重复建一遍节点。

    为什么不用 `DELETE ... RETURNING`：那要 sqlite 3.35+，而运行时的 sqlite 版本跟着
    系统走。`BEGIN IMMEDIATE` 一上来就拿写锁，SELECT 和 DELETE 在同一把锁里，原子性
    一样，还没有版本门槛。

    调用方拿到行之后如果建节点失败，这几行已经没了——这是有意的取舍。文件还在
    `_uploads/` 里，素材库能看见，丢的只是这一次「自动落到画布上」的便利；反过来
    （先建节点再删）会在网络抖动时重复建节点，那个更难收拾。

    这里的 TTL 语义完全依赖开头这次 `purge_expired` 调用——下面的 SELECT 本身没有
    `created_at` 条件。如果以后有人为了「这个路径每个打开的标签页每 5 秒打一次」
    这个理由把 purge_expired 改成有条件触发或限流，`take_inbox` 会在不知不觉中
    开始把过期行也一起吐出去。不在 SELECT 里加 TTL 谓词是有意的：DELETE 的 WHERE
    必须跟 SELECT 的逐字一致，加了就得两处一起改，这条注释就是让这个取舍成为
    「知道自己在做什么」而不是遗忘。
    """
    purge_expired(db_path)
    with _connect(db_path) as conn:
        conn.execute("BEGIN IMMEDIATE")
        rows = conn.execute(
            "SELECT * FROM blender_inbox WHERE user_id = ? AND project_id = ? "
            # created_at 只精确到整秒，同一秒到的多条投递靠它排不出先后；
            # 加 rowid（sqlite 的插入顺序）当次级键，保证是真实的到达顺序。
            "ORDER BY created_at, rowid",
            (user_id, project_id),
        ).fetchall()
        if rows:
            conn.execute(
                "DELETE FROM blender_inbox WHERE user_id = ? AND project_id = ?",
                (user_id, project_id),
            )
        conn.execute("COMMIT")
    return [dict(row) for row in rows]


def hit_rate_limit(db_path: str | Path, bucket: str, *, limit: int, window: int) -> bool:
    """记一次调用，返回「还允许吗」。

    固定窗口，不是滑动窗口：窗口边界上最坏能放过 2×limit 次。对「别让人在线爆破
    40 bit 的配对码」这个目的，固定窗口足够，换来的是一行 SQL 而不是一张事件表。
    """
    now = _now()
    window_start = now - (now % window)
    with _connect(db_path) as conn:
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute(
            "SELECT window_start, hits FROM blender_rate_limits WHERE bucket = ?",
            (bucket,),
        ).fetchone()

        if row is None or row["window_start"] != window_start:
            conn.execute(
                "INSERT INTO blender_rate_limits (bucket, window_start, hits) "
                "VALUES (?, ?, 1) "
                "ON CONFLICT(bucket) DO UPDATE SET window_start = ?, hits = 1",
                (bucket, window_start, window_start),
            )
            conn.execute("COMMIT")
            return True

        hits = row["hits"] + 1
        conn.execute(
            "UPDATE blender_rate_limits SET hits = ? WHERE bucket = ?", (hits, bucket)
        )
        conn.execute("COMMIT")
        return hits <= limit
