"""轻量 SQLite 存储。

只提供项目级 SQLite 读写能力，不导入 Cognee / 图谱搜索依赖。
适用于只需要读取角色/剧集/beats 或写回 beat 字段的 API/UI/Actor。
"""

from __future__ import annotations

import asyncio
import contextlib
import functools
import inspect
import json
import logging
import os
import sqlite3
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, List, Optional

import aiosqlite
from rich.console import Console

from novelvideo.freezone.workflow_drafts import WORKFLOW_DRAFT_SCHEMA_SQL
from novelvideo.freezone.workflow_runs import WORKFLOW_RUN_SCHEMA_SQL
from novelvideo.i18n_message import MessageLike, lmsg
from novelvideo.models import (
    BeatAssetRefRow,
    build_prop_menu,
    build_scene_menu,
    CharacterIdentity,
    NovelCharacter,
    NovelEpisode,
    NovelProp,
    NovelScene,
    NovelVisualBeat,
    PropMenuItem,
    SceneMenuItem,
    normalize_detected_identities,
    normalize_detected_props,
    sync_beat_asset_refs,
)
from novelvideo.novel_source import (
    load_imported_novel_content,
    require_imported_novel,
)
from novelvideo.official_defaults import DEFAULT_COGNEE_LLM_MODEL
from novelvideo.sqlite_pragmas import configure_sqlite_connection_async
from novelvideo.sqlite_schema import ensure_sqlite_schema
from novelvideo.utils.asset_names import (
    is_path_safe_asset_name,
    path_safe_asset_name,
    unique_path_safe_asset_name,
)
from novelvideo.utils.identity_refs import (
    remap_default_map,
    remap_id_list,
    remap_identity_id,
    remap_identity_markers,
    remap_keyed_by_identity,
    remap_object_field,
)
from novelvideo.utils.path_resolver import compute_identity_path

console = Console()
logger = logging.getLogger(__name__)

# 存量名字自愈的「每种资产只跑一次、并且串行」必须记在**进程**上，不能记在 store 实例上：
# store 是按请求新建的（``api/deps.py`` 的 ``make_sqlite_store`` / ``make_sqlite_store_for_context``），
# 实例级的锁谁也拦不住谁——两个并发的列表请求各拿各的锁双双进到迁移里，一个搬走目录、
# 另一个的 ``shutil.move`` 抛异常被吞掉，那一行就停在「盘上已改名、库里还是旧名」的错位
# 状态。记在进程上顺带也免掉「每个请求都做一次全表扫描」。
#
# key 用 ``(db_path, kind)``：一个进程可能同时服务很多项目，别让 A 项目的自愈把 B 项目的
# 记成已完成。锁连着创建它的 event loop 一起存——跨 loop 复用 ``asyncio.Lock`` 会炸，测试
# 里每个用例一个 loop。
_PATH_REPAIR_LOCKS: Dict[tuple[str, str], tuple[Any, asyncio.Lock]] = {}
_PATH_REPAIR_DONE: set[tuple[str, str]] = set()


def reset_path_repair_state() -> None:
    """清空进程级的自愈记账。测试用。"""

    _PATH_REPAIR_LOCKS.clear()
    _PATH_REPAIR_DONE.clear()


def _path_repair_lock(key: tuple[str, str]) -> asyncio.Lock:
    loop = asyncio.get_running_loop()
    cached = _PATH_REPAIR_LOCKS.get(key)
    if cached is not None and cached[0] is loop:
        return cached[1]
    lock = asyncio.Lock()
    _PATH_REPAIR_LOCKS[key] = (loop, lock)
    return lock



_PATH_UNSAFE_REPAIR_TABLES = {
    "scene": "scenes",
    "character": "characters",
    "prop": "props",
}


class StoreClosedError(RuntimeError):
    """Raised when a SQLiteStore is used after its lifecycle has ended."""

    def __init__(self, project_dir: str):
        super().__init__(f"SQLiteStore is closed: {project_dir}")
        self.project_dir = project_dir


async def load_episode_planning_content(store: Any, episode: Any) -> str:
    """Return the current production text shared by episode-level planners.

    The persisted beat source is the most explicit user-approved input. When it
    is absent, ``load_working_content`` resolves the adapted draft before the
    imported raw episode. Detached/test stores may not expose that adapter, so
    the model fields and ``load_episode_content`` remain compatible fallbacks.
    """

    beat_source_text = str(getattr(episode, "beat_source_text", "") or "")
    if beat_source_text.strip():
        return beat_source_text

    content_store = getattr(store, "sqlite_store", None) or store
    working_loader = getattr(content_store, "load_working_content", None)
    if callable(working_loader):
        working_content = str(await working_loader(episode.number) or "")
        if working_content.strip():
            return working_content

    adapted_content = str(getattr(episode, "adapted_content", "") or "")
    if adapted_content.strip():
        return adapted_content

    raw_loader = getattr(store, "load_episode_content", None)
    if not callable(raw_loader):
        raw_loader = getattr(content_store, "load_episode_content", None)
    if callable(raw_loader):
        raw_content = str(await raw_loader(episode.number) or "")
        if raw_content.strip():
            return raw_content

    raw_content = str(getattr(episode, "raw_content", "") or "")
    if raw_content.strip():
        return raw_content

    return str(getattr(episode, "content_summary", "") or "")


SQLITE_SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS characters (
    name              TEXT PRIMARY KEY,
    aliases_json      TEXT DEFAULT '[]',
    role              TEXT DEFAULT '',
    is_main           INTEGER DEFAULT 0,
    gender            TEXT DEFAULT '',
    age_group         TEXT DEFAULT 'youth',
    body_type         TEXT DEFAULT '',
    fish_voice_id     TEXT DEFAULT '',
    description       TEXT DEFAULT '',
    face_prompt       TEXT DEFAULT '',
    appearance_details TEXT DEFAULT '',
    identities_json   TEXT DEFAULT '[]',
    created_at        TEXT DEFAULT (datetime('now')),
    updated_at        TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS episodes (
    number            INTEGER PRIMARY KEY,
    title             TEXT DEFAULT '',
    chapter_start     INTEGER DEFAULT 0,
    chapter_end       INTEGER DEFAULT 0,
    beat_source_text  TEXT DEFAULT '',
    content_summary   TEXT DEFAULT '',
    main_conflict     TEXT DEFAULT '',
    cliffhanger       TEXT DEFAULT '',
    key_events        TEXT DEFAULT '[]',
    character_names   TEXT DEFAULT '[]',
    identity_ids      TEXT DEFAULT '[]',
    event_ids         TEXT DEFAULT '[]',
    scene_menu_json   TEXT DEFAULT '[]',
    prop_menu_json    TEXT DEFAULT '[]',
    identity_default_map_json TEXT DEFAULT '{}',
    sketch_colors_json TEXT DEFAULT '{}',
    raw_content       TEXT DEFAULT '',
    adapted_content   TEXT DEFAULT '',
    created_at        TEXT DEFAULT (datetime('now')),
    updated_at        TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS scenes (
    name               TEXT PRIMARY KEY,
    aliases_json       TEXT DEFAULT '[]',
    scene_type         TEXT DEFAULT 'interior',
    base_scene_id      TEXT DEFAULT '',
    variant_id         TEXT DEFAULT '',
    time_of_day        TEXT DEFAULT '',
    environment_prompt TEXT DEFAULT '',
    variant_prompt     TEXT DEFAULT '',
    description        TEXT DEFAULT '',
    spatial_layout_image TEXT DEFAULT '',
    notes              TEXT DEFAULT '',
    created_at         TEXT DEFAULT (datetime('now')),
    updated_at         TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS props (
    name               TEXT PRIMARY KEY,
    aliases_json       TEXT DEFAULT '[]',
    prop_type          TEXT DEFAULT 'object',
    visual_prompt      TEXT DEFAULT '',
    description        TEXT DEFAULT '',
    owner              TEXT DEFAULT '',
    notes              TEXT DEFAULT '',
    created_at         TEXT DEFAULT (datetime('now')),
    updated_at         TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS beats (
    episode_number         INTEGER NOT NULL,
    beat_number            INTEGER NOT NULL,
    narration              TEXT DEFAULT '',
    visual_description     TEXT DEFAULT '',
    detected_identities_json TEXT DEFAULT '[]',
    detected_props_json    TEXT DEFAULT '[]',
    scene_ref_json         TEXT DEFAULT '',
    audio_type             TEXT DEFAULT 'narration',
    speaker                TEXT DEFAULT '',
    speaker_kind           TEXT DEFAULT 'character',
    time_of_day            TEXT DEFAULT '',
    video_mode             TEXT DEFAULT 'first_frame',
    video_prompt           TEXT DEFAULT '',
    keyframe_prompt        TEXT DEFAULT '',
    shot_order             INTEGER,
    duration_seconds       REAL,
    is_manual_shot         INTEGER DEFAULT 0,
    created_at             TEXT DEFAULT (datetime('now')),
    updated_at             TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (episode_number, beat_number)
);

CREATE INDEX IF NOT EXISTS idx_beats_episode ON beats(episode_number);

CREATE TABLE IF NOT EXISTS sketch_failure_modes (
    code                   TEXT PRIMARY KEY,
    layer                  TEXT NOT NULL,
    detection              TEXT NOT NULL,
    prevention_rule        TEXT DEFAULT '',
    correction_template    TEXT DEFAULT '',
    negative_prompt_clause TEXT DEFAULT '',
    gate_enabled           INTEGER DEFAULT 0,
    fixture_path           TEXT DEFAULT '',
    first_seen_episode     INTEGER DEFAULT -1,
    hit_count              INTEGER DEFAULT 0,
    created_at             TEXT DEFAULT (datetime('now')),
    updated_at             TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_failure_modes_layer ON sketch_failure_modes(layer);
CREATE INDEX IF NOT EXISTS idx_failure_modes_gate_enabled ON sketch_failure_modes(gate_enabled);

CREATE TABLE IF NOT EXISTS convergence_rounds (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    episode_number      INTEGER NOT NULL,
    phase               TEXT NOT NULL,
    round_num           INTEGER NOT NULL,
    residual_count      INTEGER DEFAULT 0,
    fixed_count         INTEGER DEFAULT 0,
    new_failures_json   TEXT DEFAULT '[]',
    started_at          TEXT DEFAULT (datetime('now')),
    ended_at            TEXT
);
CREATE INDEX IF NOT EXISTS idx_convergence_episode_phase ON convergence_rounds(episode_number, phase);

-- Director OS phase 2: project-local hit tracking for failure modes.
-- The canonical *definitions* live in the user-shared verification.db; this
-- table only stores per-project usage stats so each project's hit_count /
-- first_seen_episode stays isolated (the definitions are shared knowledge,
-- the hits are project facts).
-- The legacy `sketch_failure_modes` table above is kept untouched during the
-- phase-1-to-phase-2 transition and will be deprecated once verification.db
-- is the single source of truth for defs.
CREATE TABLE IF NOT EXISTS sketch_failure_mode_hits (
    code                TEXT PRIMARY KEY,
    first_seen_episode  INTEGER DEFAULT -1,
    hit_count           INTEGER DEFAULT 0,
    last_seen_at        TEXT DEFAULT (datetime('now'))
);

-- IndexTTS2 / Seedance 2.0 voice provenance (Stage A: NiceGUI cutover).
-- Mirrors the standalone schema in seedance2_i2v/voice_audio_records.py so the
-- table exists immediately on store init rather than lazily on first audio call.
CREATE TABLE IF NOT EXISTS seedance2_voice_audio_records (
    episode_number INTEGER NOT NULL,
    beat_number INTEGER NOT NULL,
    speaker TEXT NOT NULL,
    audio_path TEXT NOT NULL,
    voice_sha256 TEXT NOT NULL,
    text_sha256 TEXT NOT NULL DEFAULT '',
    mode TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    generated_at TEXT NOT NULL,
    status TEXT NOT NULL,
    error TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (episode_number, beat_number, speaker)
);
CREATE INDEX IF NOT EXISTS idx_seedance2_voice_audio_speaker
    ON seedance2_voice_audio_records(episode_number, speaker);

-- structured_v1 analysis bookkeeping.
--
-- A run is keyed by what it analysed (source_sha256) and how (schema_version),
-- so re-importing identical text reuses completed chunks and only failed or
-- stale ones are recomputed. Chunks store source offsets rather than a copy of
-- the text: duplicating a whole novel per run would dwarf the rest of the
-- project database.
CREATE TABLE IF NOT EXISTS story_analysis_runs (
    run_id            TEXT PRIMARY KEY,
    pipeline_version  TEXT NOT NULL,
    schema_version    INTEGER NOT NULL DEFAULT 1,
    spine_template    TEXT NOT NULL DEFAULT '',
    source_sha256     TEXT NOT NULL,
    source_length     INTEGER NOT NULL DEFAULT 0,
    status            TEXT NOT NULL DEFAULT 'pending',
    error             TEXT NOT NULL DEFAULT '',
    created_at        TEXT DEFAULT (datetime('now')),
    completed_at      TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_story_analysis_runs_source
    ON story_analysis_runs(source_sha256, schema_version);

CREATE TABLE IF NOT EXISTS story_analysis_chunks (
    run_id            TEXT NOT NULL,
    chunk_id          TEXT NOT NULL,
    chunk_index       INTEGER NOT NULL DEFAULT 0,
    section_type      TEXT NOT NULL DEFAULT '',
    section_label     TEXT NOT NULL DEFAULT '',
    source_start      INTEGER NOT NULL DEFAULT 0,
    source_end        INTEGER NOT NULL DEFAULT 0,
    source_hash       TEXT NOT NULL DEFAULT '',
    status            TEXT NOT NULL DEFAULT 'pending',
    attempts          INTEGER NOT NULL DEFAULT 0,
    error             TEXT NOT NULL DEFAULT '',
    result_json       TEXT NOT NULL DEFAULT '{}',
    PRIMARY KEY (run_id, chunk_id)
);
CREATE INDEX IF NOT EXISTS idx_story_analysis_chunks_status
    ON story_analysis_chunks(run_id, status);

-- Structured entities keep spans of real source text so they can be traced back
-- to what produced them. Only characters record evidence today; entity_type
-- exists so scenes and props can join later without a schema change.
CREATE TABLE IF NOT EXISTS entity_evidence (
    run_id            TEXT NOT NULL,
    entity_type       TEXT NOT NULL,
    entity_id         TEXT NOT NULL,
    chunk_id          TEXT NOT NULL,
    source_start      INTEGER NOT NULL,
    source_end        INTEGER NOT NULL,
    evidence_kind     TEXT NOT NULL DEFAULT '',
    evidence_text     TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (run_id, entity_type, entity_id, chunk_id, source_start, source_end)
);
CREATE INDEX IF NOT EXISTS idx_entity_evidence_entity
    ON entity_evidence(entity_type, entity_id);

-- The final result of a run, after merging and adjudication. Chunk results are
-- not sufficient on their own: adjudication is a further model call whose
-- outcome can differ between runs, so without this an unchanged source could
-- produce a different cast every rebuild.
CREATE TABLE IF NOT EXISTS story_analysis_artifacts (
    run_id            TEXT NOT NULL,
    artifact_type     TEXT NOT NULL,
    result_json       TEXT NOT NULL DEFAULT '{}',
    created_at        TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (run_id, artifact_type)
);

-- Per-item results, keyed by a hash of the exact model input rather than by
-- run. A scene build is dozens of independent model calls; when one fails or
-- the worker is killed, everything already produced is still valid, and the
-- next run must not pay for it again. Deliberately not scoped to a run: the
-- point is for a *new* run to reuse what an abandoned one finished.
CREATE TABLE IF NOT EXISTS story_analysis_item_cache (
    cache_key         TEXT PRIMARY KEY,
    artifact_type     TEXT NOT NULL,
    result_json       TEXT NOT NULL DEFAULT '{}',
    created_at        TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_item_cache_type
    ON story_analysis_item_cache(artifact_type);
"""

_PROJECT_STORE_SCHEMA_COMPONENT = "project_store"
# MIGRATION CONTRACT: increment this whenever SQLITE_SCHEMA_SQL or any
# _ensure_*_columns migration above changes. Existing databases skip the
# initializer after this version has been recorded.
_PROJECT_STORE_SCHEMA_VERSION = 4


def _table_columns(db: sqlite3.Connection, table: str) -> set[str]:
    rows = db.execute(f"PRAGMA table_info({table})").fetchall()
    return {str(row["name"]) for row in rows}


def _add_column_if_missing(
    db: sqlite3.Connection,
    table: str,
    name: str,
    definition: str,
) -> None:
    """Add a column while tolerating concurrent runtime schema bootstrap.

    SQLite has no portable ``ADD COLUMN IF NOT EXISTS``. Multiple API/worker
    processes can initialize the same project DB at once, so a column may be
    added after our ``PRAGMA table_info`` read but before ``ALTER TABLE``.
    """
    if name in _table_columns(db, table):
        return

    try:
        db.execute(f"ALTER TABLE {table} ADD COLUMN {name} {definition}")
    except sqlite3.OperationalError as exc:
        if "duplicate column name" not in str(exc).lower():
            raise
        if name not in _table_columns(db, table):
            raise
        logger.debug("SQLite column already added concurrently: %s.%s", table, name)


def _leased(method):
    @functools.wraps(method)
    async def wrapper(self, *args, **kwargs):
        async with self._lease():
            return await method(self, *args, **kwargs)

    return wrapper


def _auto_lease_public_async_methods(cls):
    """Wrap public async store methods once at class creation time."""
    for name, attr in list(vars(cls).items()):
        if name.startswith("_") or name == "close":
            continue
        if inspect.iscoroutinefunction(attr):
            setattr(cls, name, _leased(attr))
    return cls


@_auto_lease_public_async_methods
class SQLiteStore:
    """只负责 SQLite 数据读写的轻量存储。

    Store instances are one-shot lifecycle objects: after close(), create a new
    SQLiteStore instead of calling initialize() again.
    """

    def __init__(
        self,
        project_name: str,
        output_dir: str | None = None,
        state_dir: str | None = None,
    ):
        self.project_name = project_name
        self._db: Optional[aiosqlite.Connection] = None
        self._characters: Dict[str, NovelCharacter] = {}
        self._episodes: Dict[int, NovelEpisode] = {}
        self._props: Dict[str, NovelProp] = {}
        self._alias_index: Dict[str, str] = {}
        self._closing = False
        self._closed = False
        self._inflight = 0
        self._drained = asyncio.Event()
        self._drained.set()
        self._lease_depth_by_task: dict[Any, int] = {}

        if output_dir:
            self.project_dir = output_dir
            Path(output_dir).mkdir(parents=True, exist_ok=True)
        else:
            from novelvideo.config import ensure_project_dirs

            self.project_dir = ensure_project_dirs(project_name)["base"]

        parts = project_name.split("/", 1)
        if state_dir:
            resolved_state_dir = Path(state_dir)
            if len(parts) == 2:
                from novelvideo.utils.project_paths import ProjectPaths

                paths = ProjectPaths(parts[0], parts[1])
                if resolved_state_dir.resolve() == paths.state_dir.resolve():
                    paths.bootstrap_from_legacy_output()
        elif len(parts) == 2:
            from novelvideo.utils.project_paths import ProjectPaths

            paths = ProjectPaths(parts[0], parts[1])
            paths.bootstrap_from_legacy_output()
            resolved_state_dir = paths.state_dir
        else:
            resolved_state_dir = Path(self.project_dir)

        resolved_state_dir.mkdir(parents=True, exist_ok=True)
        self.state_dir = str(resolved_state_dir)
        self.db_path = str(resolved_state_dir / "data.db")

    async def _ensure_db(self) -> aiosqlite.Connection:
        if self._closed or (self._closing and self._current_task_lease_depth() <= 0):
            raise StoreClosedError(self.project_dir)
        if self._db is None:
            if self._closing:
                raise StoreClosedError(self.project_dir)
            await self._ensure_project_schema()
            self._db = await aiosqlite.connect(self.db_path, timeout=10)
            self._db.row_factory = aiosqlite.Row
            await configure_sqlite_connection_async(
                self._db,
                set_journal_mode=False,
            )
        return self._db

    async def _ensure_project_schema(self) -> None:
        """Initialize/upgrade project tables once, serialized across processes."""

        await asyncio.to_thread(self._ensure_project_schema_sync)

    def _ensure_project_schema_sync(self) -> None:
        """Run blocking schema migration outside the asyncio event loop."""

        path = Path(self.db_path)

        def initialize(db: sqlite3.Connection) -> None:
            db.row_factory = sqlite3.Row
            db.executescript(SQLITE_SCHEMA_SQL)
            db.executescript(WORKFLOW_DRAFT_SCHEMA_SQL)
            db.executescript(WORKFLOW_RUN_SCHEMA_SQL)
            self._ensure_episode_planning_columns(db)
            self._ensure_beat_current_columns(db)
            self._ensure_scene_columns(db)
            self._ensure_indextts2_columns(db)

        ensure_sqlite_schema(
            path,
            component=_PROJECT_STORE_SCHEMA_COMPONENT,
            version=_PROJECT_STORE_SCHEMA_VERSION,
            initialize=initialize,
        )

        # Phase 2 DB split: failure-mode *definitions* live in the user-shared
        # verification.db. This project DB holds only per-project hits and
        # convergence facts.

    def _ensure_scene_columns(self, db: sqlite3.Connection) -> None:
        _add_column_if_missing(
            db,
            "scenes",
            "spatial_layout_image",
            "TEXT DEFAULT ''",
        )
        for name in ("base_scene_id", "variant_id", "time_of_day", "variant_prompt"):
            _add_column_if_missing(db, "scenes", name, "TEXT DEFAULT ''")

    def _ensure_indextts2_columns(self, db: sqlite3.Connection) -> None:
        """Add IndexTTS2 / Seedance 2.0 voice columns introduced in Stage A."""
        _add_column_if_missing(
            db,
            "beats",
            "seedance2_config_json",
            "TEXT NOT NULL DEFAULT '{}'",
        )

        char_columns = {
            "reference_audio_path": "TEXT DEFAULT ''",
            "reference_audio_sha256": "TEXT DEFAULT ''",
            "reference_audio_updated_at": "TEXT DEFAULT ''",
            "voice_samples_by_age_group_json": "TEXT DEFAULT '{}'",
        }
        for name, definition in char_columns.items():
            _add_column_if_missing(db, "characters", name, definition)

    def _ensure_episode_planning_columns(self, db: sqlite3.Connection) -> None:
        """Add episode columns introduced after early project databases were created."""
        columns = {
            "beat_source_text": "TEXT DEFAULT ''",
            "adapted_content": "TEXT DEFAULT ''",
            "scene_menu_json": "TEXT DEFAULT '[]'",
            "prop_menu_json": "TEXT DEFAULT '[]'",
            "identity_default_map_json": "TEXT DEFAULT '{}'",
        }
        for name, definition in columns.items():
            _add_column_if_missing(db, "episodes", name, definition)

    def _ensure_beat_current_columns(self, db: sqlite3.Connection) -> None:
        """Add beat columns required by the current script/render pipeline."""
        columns = {
            "detected_identities_json": "TEXT DEFAULT '[]'",
            "detected_props_json": "TEXT DEFAULT '[]'",
            "scene_ref_json": "TEXT DEFAULT ''",
            "audio_type": "TEXT DEFAULT 'narration'",
            "speaker": "TEXT DEFAULT ''",
            "speaker_kind": "TEXT DEFAULT 'character'",
            "time_of_day": "TEXT DEFAULT ''",
            "video_mode": "TEXT DEFAULT 'first_frame'",
            "video_prompt": "TEXT DEFAULT ''",
            "keyframe_prompt": "TEXT DEFAULT ''",
            "shot_order": "INTEGER",
            "duration_seconds": "REAL",
            "is_manual_shot": "INTEGER DEFAULT 0",
        }
        for name, definition in columns.items():
            _add_column_if_missing(db, "beats", name, definition)

    async def initialize(self) -> None:
        await self._ensure_db()
        console.print(f"[dim]SQLite 存储已初始化 (db: {self.db_path})[/dim]")

    def is_closed(self) -> bool:
        return self._closing or self._closed

    def _current_task_lease_depth(self) -> int:
        try:
            task = asyncio.current_task()
        except RuntimeError:
            return 0
        if task is None:
            return 0
        return self._lease_depth_by_task.get(task, 0)

    @contextlib.asynccontextmanager
    async def _lease(self):
        """Track in-flight async store operations so close() can drain safely."""
        try:
            task = asyncio.current_task()
        except RuntimeError:
            task = None

        if task is not None:
            depth = self._lease_depth_by_task.get(task, 0)
            if depth > 0:
                self._lease_depth_by_task[task] = depth + 1
                try:
                    yield self
                finally:
                    next_depth = self._lease_depth_by_task.get(task, 1) - 1
                    if next_depth <= 0:
                        self._lease_depth_by_task.pop(task, None)
                    else:
                        self._lease_depth_by_task[task] = next_depth
                return

        if self._closing or self._closed:
            raise StoreClosedError(self.project_dir)

        self._inflight += 1
        self._drained.clear()
        if task is not None:
            self._lease_depth_by_task[task] = 1
        try:
            yield self
        finally:
            if task is not None:
                self._lease_depth_by_task.pop(task, None)
            self._inflight = max(0, self._inflight - 1)
            if self._inflight == 0:
                self._drained.set()

    async def close(self) -> None:
        if self._closed or self._closing:
            return
        self._closing = True
        if self._inflight > 0 and self._current_task_lease_depth() <= 0:
            try:
                await asyncio.wait_for(self._drained.wait(), timeout=10.0)
            except asyncio.TimeoutError:
                logger.warning(
                    "SQLiteStore close drain timeout; force closing project_dir=%s inflight=%s",
                    self.project_dir,
                    self._inflight,
                )
        db = self._db
        self._db = None
        if db is not None:
            try:
                await db.close()
            except Exception:
                logger.exception(
                    "failed to close SQLiteStore db for project_dir=%s",
                    self.project_dir,
                )
        self._closed = True

    def save_novel_content(self, content: str) -> None:
        novel_path = Path(self.project_dir) / "novel.txt"
        novel_path.write_text(content, encoding="utf-8")

    def load_novel_content(self) -> Optional[str]:
        return load_imported_novel_content(self.project_dir)

    async def save_episode_content(self, ep_num: int, content: str) -> None:
        db = await self._ensure_db()
        await db.execute(
            "INSERT INTO episodes (number, raw_content) VALUES (?, ?) "
            "ON CONFLICT(number) DO UPDATE SET raw_content = excluded.raw_content, "
            "updated_at = datetime('now')",
            (ep_num, content),
        )
        await db.commit()

    async def load_episode_content(self, ep_num: int) -> Optional[str]:
        db = await self._ensure_db()
        async with db.execute(
            "SELECT raw_content FROM episodes WHERE number = ?",
            (ep_num,),
        ) as cursor:
            row = await cursor.fetchone()
            if row and row[0]:
                return row[0]
        return None

    async def save_adapted_content(self, ep_num: int, content: str) -> None:
        db = await self._ensure_db()
        cursor = await db.execute(
            "UPDATE episodes SET adapted_content = ?, updated_at = datetime('now') "
            "WHERE number = ?",
            (content, ep_num),
        )
        if cursor.rowcount == 0:
            raise ValueError(f"剧集 {ep_num} 不存在，无法保存改写稿")
        await db.commit()
        episode = self._episodes.get(ep_num)
        if episode is not None:
            episode.adapted_content = content

    async def load_adapted_content(self, ep_num: int) -> str:
        db = await self._ensure_db()
        async with db.execute(
            "SELECT adapted_content FROM episodes WHERE number = ?",
            (ep_num,),
        ) as cursor:
            row = await cursor.fetchone()
            if row and row[0]:
                return row[0]
        return ""

    async def load_working_content(self, ep_num: int) -> str:
        db = await self._ensure_db()
        async with db.execute(
            """
            SELECT
                CASE
                    WHEN adapted_content IS NOT NULL AND trim(adapted_content) != ''
                    THEN adapted_content
                    ELSE raw_content
                END AS working_content
            FROM episodes
            WHERE number = ?
            """,
            (ep_num,),
        ) as cursor:
            row = await cursor.fetchone()
            if row and row["working_content"]:
                return row["working_content"]
        return ""

    async def get_episode_content_count(self) -> int:
        db = await self._ensure_db()
        async with db.execute(
            "SELECT COUNT(*) FROM episodes WHERE raw_content != '' AND raw_content IS NOT NULL"
        ) as cursor:
            row = await cursor.fetchone()
            return row[0] if row else 0

    async def clear_episode_contents(self) -> int:
        db = await self._ensure_db()
        cursor = await db.execute(
            "UPDATE episodes SET raw_content = '', updated_at = datetime('now') "
            "WHERE raw_content != '' AND raw_content IS NOT NULL"
        )
        await db.commit()
        return cursor.rowcount

    async def _update_character_field(self, name: str, field: str, value: Any) -> bool:
        try:
            db = await self._ensure_db()
            await db.execute(
                f"UPDATE characters SET {field} = ?, updated_at = datetime('now') WHERE name = ?",
                (value, name),
            )
            await db.commit()
            return True
        except Exception as e:
            console.print(f"[red]更新角色字段失败: {e}[/red]")
            return False

    async def add_character(self, character: NovelCharacter) -> None:
        db = await self._ensure_db()
        await db.execute(
            """INSERT INTO characters (name, aliases_json, role, is_main, gender, age_group,
               body_type, fish_voice_id, description, face_prompt, appearance_details, identities_json,
               reference_audio_path, reference_audio_sha256, reference_audio_updated_at,
               voice_samples_by_age_group_json)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(name) DO UPDATE SET
               aliases_json=excluded.aliases_json, role=excluded.role,
               is_main=excluded.is_main, gender=excluded.gender,
               age_group=excluded.age_group, body_type=excluded.body_type,
               fish_voice_id=excluded.fish_voice_id, description=excluded.description,
               face_prompt=excluded.face_prompt, appearance_details=excluded.appearance_details,
               identities_json=excluded.identities_json,
               reference_audio_path=excluded.reference_audio_path,
               reference_audio_sha256=excluded.reference_audio_sha256,
               reference_audio_updated_at=excluded.reference_audio_updated_at,
               voice_samples_by_age_group_json=excluded.voice_samples_by_age_group_json,
               updated_at=datetime('now')""",
            (
                character.name,
                json.dumps(character.aliases, ensure_ascii=False),
                character.role,
                1 if character.is_main else 0,
                character.gender,
                character.age_group,
                character.body_type,
                character.fish_voice_id,
                character.description,
                character.face_prompt,
                character.appearance_details,
                character.identities_json,
                character.reference_audio_path,
                character.reference_audio_sha256,
                character.reference_audio_updated_at,
                character.voice_samples_by_age_group_json,
            ),
        )
        await db.commit()
        self._characters[character.name] = character
        updated_alias_index = {k: v for k, v in self._alias_index.items() if v != character.name}
        self._alias_index.clear()
        self._alias_index.update(updated_alias_index)
        for alias in character.aliases:
            self._alias_index[alias] = character.name

    async def add_characters_atomic(
        self, characters: list, *, skip_existing: bool = True
    ) -> list[str]:
        """Publish many characters in one transaction.

        add_character() commits per row, so a failure partway through a build
        leaves half a cast behind. Structured builds publish their whole result
        at once instead: either every character lands or none does.

        Existing characters are skipped by default. A character on disk may
        already carry user edits, a portrait, identities and voice bindings, and
        a rebuild must not overwrite any of that.
        """
        if not characters:
            return []

        db = await self._ensure_db()
        existing = set(self._characters) if skip_existing else set()
        pending = [
            character
            for character in characters
            if not (skip_existing and character.name in existing)
        ]
        if not pending:
            return []

        try:
            await db.execute("BEGIN")
            for character in pending:
                await db.execute(
                    """INSERT INTO characters
                       (name, aliases_json, role, is_main, gender, age_group,
                        body_type, fish_voice_id, description, face_prompt,
                        appearance_details, identities_json)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                       ON CONFLICT(name) DO NOTHING""",
                    (
                        character.name,
                        json.dumps(character.aliases, ensure_ascii=False),
                        character.role,
                        1 if character.is_main else 0,
                        character.gender,
                        character.age_group,
                        character.body_type,
                        character.fish_voice_id,
                        character.description,
                        character.face_prompt,
                        character.appearance_details,
                        character.identities_json,
                    ),
                )
            await db.commit()
        except Exception:
            await db.rollback()
            raise

        for character in pending:
            self._characters[character.name] = character
            for alias in character.aliases:
                self._alias_index[alias] = character.name
        return [character.name for character in pending]

    async def update_character(self, name: str, **updates) -> None:
        char = self.get_character(name)
        if not char:
            raise ValueError(f"角色 {name} 不存在")
        for key, value in updates.items():
            if hasattr(char, key):
                setattr(char, key, value)
        if "aliases" in updates:
            remove_keys = [k for k, v in self._alias_index.items() if v == name]
            for key in remove_keys:
                self._alias_index.pop(key, None)
            for alias in char.aliases:
                self._alias_index[alias] = name
        await self.add_character(char)
        console.print(f"[green]已更新角色: {name}[/green]")

    async def set_character_main(self, name: str, is_main: bool) -> bool:
        """Update only the narrator-main flag without requiring the graph cache.

        Lightweight asset-list requests intentionally skip ``load_graph_state``.
        Repairs discovered by that list must therefore use a column-level write,
        not ``update_character()``, whose object merge contract is cache-backed.
        """

        updated = await self._update_character_field(name, "is_main", 1 if is_main else 0)
        cached = self._characters.get(name)
        if updated and cached is not None:
            cached.is_main = is_main
        return updated

    async def touch_character_asset(self, name: str) -> bool:
        """Advance the row revision after publishing a convention-path asset."""

        db = await self._ensure_db()
        cursor = await db.execute(
            "UPDATE characters SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') "
            "WHERE name = ?",
            (name,),
        )
        await db.commit()
        return (cursor.rowcount or 0) > 0

    async def delete_all_characters(self) -> int:
        try:
            db = await self._ensure_db()
            cursor = await db.execute("DELETE FROM characters")
            await db.commit()
            self._characters.clear()
            self._alias_index.clear()
            deleted = cursor.rowcount
            console.print(f"[dim]已删除 {deleted} 个旧角色[/dim]")
            return deleted
        except Exception as e:
            console.print(f"[yellow]删除旧角色失败: {e}[/yellow]")
            return 0

    async def rename_character(self, old_name: str, new_name: str) -> None:
        # 必须用角色口径：下面是 `char.name = new_name` 直接赋值，绕过了模型校验器，
        # 窄口径放过的 `王:小明` 会原样写进主键，而每次读出来都被改写成 `王_小明`——
        # 又是一行删不掉的记录。
        new_name = path_safe_asset_name(new_name, kind="character")
        char = self.get_character(old_name)
        if not char:
            raise ValueError(f"角色 {old_name} 不存在")
        if old_name == new_name:
            return
        if self.get_character(new_name):
            raise ValueError(f"角色 {new_name} 已存在")
        db = await self._ensure_db()
        await db.execute("DELETE FROM characters WHERE name = ?", (old_name,))
        identities = char.identities
        for identity in identities:
            identity.character_name = new_name
            identity.identity_id = f"{new_name}_{identity.identity_name}"
        char.identities = identities
        char.name = new_name
        await self.add_character(char)
        self._characters.pop(old_name, None)
        self._characters[new_name] = char
        new_alias_index = {}
        for key, value in self._alias_index.items():
            new_alias_index[key] = new_name if value == old_name else value
        self._alias_index.clear()
        self._alias_index.update(new_alias_index)
        await self._cascade_character_rename(old_name, new_name)
        old_dir = Path(self.project_dir) / "assets" / "characters" / old_name
        new_dir = Path(self.project_dir) / "assets" / "characters" / new_name
        if old_dir.exists() and not new_dir.exists():
            old_dir.replace(new_dir)
        # 级联走的是裸 SQL，内存里的 episodes / beats 还是旧引用，重载一次对齐。
        await self.load_graph_state()
        console.print(f"[green]已重命名角色: {old_name} → {new_name}[/green]")

    async def delete_character(self, name: str) -> None:
        char = self.get_character(name)
        if not char:
            console.print(f"[yellow]角色 {name} 不存在[/yellow]")
            return
        db = await self._ensure_db()
        await db.execute("DELETE FROM characters WHERE name = ?", (name,))
        await db.commit()
        self._characters.pop(name, None)
        remove_keys = [k for k, v in self._alias_index.items() if v == name]
        for key in remove_keys:
            self._alias_index.pop(key, None)
        console.print(f"[green]已删除角色: {name}[/green]")

    async def _cascade_character_rename(self, old_name: str, new_name: str) -> None:
        """角色改名后，把散在库里各处的角色名 / identity_id 引用一起改掉。

        ``identity_id`` 是 ``<角色名>_<身份名>`` 拼出来的，改名等于让所有落库的
        identity_id 一起失效：身份图按 identity_id 找不到文件，sketch 颜色分配的键对不
        上，分镜 marker 检出的身份不在身份表里，道具找不到所属身份。

        **要改这个方法，先去 ``novelvideo.utils.identity_refs`` 的模块 docstring 核对那
        份列清单**——那是把 ``SQLITE_SCHEMA_SQL`` 每一列过了一遍数出来的。凭直觉补会漏。

        走裸 SQL 而不是模型层：存量名字自愈本身就必须绕开模型（模型读的时候会把斜杠抹
        平，看不见坏名字），级联跟着走同一条路，两个调用点才能共用这一份实现。

        ``rename_character`` 和 ``_repair_path_unsafe_asset_names`` 都调它——前者是用户
        手动改名的低频操作，后者是打开资产页就跑的自愈，只补一边等于没补。
        """

        if not old_name or old_name == new_name:
            return

        db = await self._ensure_db()
        async with db.execute(
            "SELECT number, character_names, identity_ids, "
            "identity_default_map_json, sketch_colors_json, prop_menu_json "
            "FROM episodes"
        ) as cursor:
            episodes = await cursor.fetchall()
        for row in episodes:
            updates: Dict[str, str] = {}
            names = remap_id_list(row["character_names"], old_name, new_name)
            if names is not None:
                updates["character_names"] = names
            ids = remap_id_list(row["identity_ids"], old_name, new_name)
            if ids is not None:
                updates["identity_ids"] = ids
            default_map = remap_default_map(
                row["identity_default_map_json"], old_name, new_name
            )
            if default_map is not None:
                updates["identity_default_map_json"] = default_map
            colors = remap_keyed_by_identity(
                row["sketch_colors_json"], old_name, new_name
            )
            if colors is not None:
                updates["sketch_colors_json"] = colors
            # PropMenuItem.owner_identity_id 是身份 ID，道具「属于谁」全靠它。
            prop_menu = remap_object_field(
                row["prop_menu_json"], "owner_identity_id", old_name, new_name
            )
            if prop_menu is not None:
                updates["prop_menu_json"] = prop_menu
            if not updates:
                # 没引用过这个角色的集不写库，免得平白刷 updated_at。
                continue
            assignments = ", ".join(f"{column} = ?" for column in updates)
            await db.execute(
                f"UPDATE episodes SET {assignments}, updated_at = datetime('now') "
                "WHERE number = ?",
                (*updates.values(), row["number"]),
            )

        async with db.execute(
            "SELECT episode_number, beat_number, detected_identities_json, "
            "visual_description, speaker, speaker_kind FROM beats"
        ) as cursor:
            beats = await cursor.fetchall()
        for row in beats:
            updates = {}
            detected = remap_id_list(
                row["detected_identities_json"], old_name, new_name
            )
            if detected is not None:
                updates["detected_identities_json"] = detected
            description = remap_identity_markers(
                row["visual_description"], old_name, new_name
            )
            if description is not None:
                updates["visual_description"] = description
            # speaker 存的是 **identity_id**，不是角色名：``BeatUpdate.speaker`` 标的是
            # 「说话人身份ID」，``resolve_dialogue_reference_audio`` 和
            # ``indextts2_beat_audio_task`` 都是 ``speaker.startswith(角色名)`` 之后再
            # ``identity.identity_id == speaker`` 精确配。所以这里必须走
            # ``remap_identity_id``（裸角色名的历史值它也照顾得到），拿 ``== old_name``
            # 比会把 ``林/小满_casual`` 整个漏掉，配音解析就找不到身份了。
            #
            # ``speaker_kind`` 只有 character / non_character 两种，广播、画外音那类
            # non_character 的 speaker 不是角色，不能动。
            speaker = str(row["speaker"] or "")
            if str(row["speaker_kind"] or "character") == "character":
                remapped_speaker = remap_identity_id(speaker, old_name, new_name)
                if remapped_speaker != speaker:
                    updates["speaker"] = remapped_speaker
            if not updates:
                continue
            assignments = ", ".join(f"{column} = ?" for column in updates)
            await db.execute(
                f"UPDATE beats SET {assignments}, updated_at = datetime('now') "
                "WHERE episode_number = ? AND beat_number = ?",
                (*updates.values(), row["episode_number"], row["beat_number"]),
            )

        # props.owner 两种格式混着存：字段声明写的是「所属角色名」，而
        # ``prop_promotion_service`` 把菜单项提升成全局道具时，是把
        # ``owner_identity_id`` 原样抄进来的（``owner=str(item.owner_identity_id ...)``）。
        # ``remap_identity_id`` 对两种都成立：等于旧角色名就换成新的，``旧角色名_`` 开头
        # 就换前缀，其余不动。
        async with db.execute("SELECT name, owner FROM props") as cursor:
            props = await cursor.fetchall()
        for row in props:
            owner = str(row["owner"] or "")
            remapped_owner = remap_identity_id(owner, old_name, new_name)
            if remapped_owner == owner:
                continue
            await db.execute(
                "UPDATE props SET owner = ?, updated_at = datetime('now') WHERE name = ?",
                (remapped_owner, row["name"]),
            )

        await self._cascade_voice_record_speaker(db, old_name, new_name)

        await db.commit()

    async def _cascade_voice_record_speaker(
        self, db: Any, old_name: str, new_name: str
    ) -> None:
        """``seedance2_voice_audio_records.speaker`` 跟着改。

        这里的 speaker 是从 beat 的 speaker 传下来的（``voice_audio_task`` 一路带着走），
        所以和 ``beats.speaker`` 同一个契约：**identity_id**。旁白那条走
        ``NARRATOR_SPEAKER`` 哨兵，不带角色名前缀，``remap_identity_id`` 天然不碰。

        这张表是音频复用的凭证（``classify_seedance2_voice_audio`` 按
        ``(episode, beat, speaker)`` 精确查）。不改的话改名后每一条都查不中，被当成
        missing 重新生成一遍——不会产出错内容，就是白烧一遍配音。

        speaker 是主键的一部分，逐条处理冲突：目标主键已经有行了，说明那条是在新名字下
        写的、比手上这条旧的更可信，删掉旧的即可。整批 ``UPDATE OR REPLACE`` 也能不炸，
        但那是闷头覆盖新行，方向反了。

        建表 SQL 里有这张表，但老库可能在它加进来之前就记下了 schema 版本、跳过了初始化，
        所以先确认表在不在。
        """

        table = "seedance2_voice_audio_records"
        async with db.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
            (table,),
        ) as cursor:
            if await cursor.fetchone() is None:
                return

        async with db.execute(
            f"SELECT episode_number, beat_number, speaker FROM {table}"
        ) as cursor:
            rows = await cursor.fetchall()
        for row in rows:
            speaker = str(row["speaker"] or "")
            remapped = remap_identity_id(speaker, old_name, new_name)
            if remapped == speaker:
                continue
            key = (row["episode_number"], row["beat_number"])
            async with db.execute(
                f"SELECT 1 FROM {table} WHERE episode_number = ? AND beat_number = ? "
                "AND speaker = ?",
                (*key, remapped),
            ) as probe:
                occupied = await probe.fetchone() is not None
            if occupied:
                await db.execute(
                    f"DELETE FROM {table} WHERE episode_number = ? AND beat_number = ? "
                    "AND speaker = ?",
                    (*key, speaker),
                )
                continue
            await db.execute(
                f"UPDATE {table} SET speaker = ? WHERE episode_number = ? "
                "AND beat_number = ? AND speaker = ?",
                (remapped, *key, speaker),
            )

    async def repair_path_unsafe_asset_names(
        self,
        kind: str,
        move_assets: Optional[Callable[[str, str], None]] = None,
    ) -> Dict[str, str]:
        """把库里名字带斜杠的存量资产改名归位，原名转成别名，返回 ``{旧名: 新名}``。

        写入口的消毒（``NovelScene.sanitize_name`` 等）只管新数据，这道闸加上之前落库的
        ``家中客厅/哥哥卧室`` 还躺在表里：它的 ``{name}`` 接口全是 404，删不掉也生不出图。

        **必须走裸 SQL，不能走模型**：模型的 ``sanitize_name`` 会在读出来那一刻就把斜杠
        抹平，模型层根本看不见坏名字，可主键里那个斜杠还在——``DELETE ... WHERE name = ?``
        于是一行都删不掉，表现就是用户报的「点了删除，刷新还在」。

        ``move_assets(old, new)`` 由调用方提供，负责搬 ``assets/<kind>s/<name>`` 那棵目录树；
        它抛异常就跳过这一条不改名——宁可留着坏名字，也不能让记录指向别人的图。

        名字都干净时只做一次 SELECT，不写库也不碰磁盘。

        每种 kind 每个项目**每个进程**只跑一次，且串行——列表接口是并发入口，而 store 是
        按请求新建的，记在实例上等于没记，见模块顶上 ``_PATH_REPAIR_DONE`` 的说明。
        """

        key = (self.db_path, kind)
        if key in _PATH_REPAIR_DONE:
            return {}
        async with _path_repair_lock(key):
            if key in _PATH_REPAIR_DONE:
                return {}
            renamed = await self._repair_path_unsafe_asset_names(kind, move_assets)
            _PATH_REPAIR_DONE.add(key)
            return renamed

    async def _repair_path_unsafe_asset_names(
        self,
        kind: str,
        move_assets: Optional[Callable[[str, str], None]] = None,
    ) -> Dict[str, str]:
        table = _PATH_UNSAFE_REPAIR_TABLES[kind]
        # 角色的身份记录把角色名嵌进了 character_name 和 identity_id，改名后不跟着改，
        # 身份图的落盘路径就指向一个不存在的目录（rename_character 一直在做这件事）。
        columns = "name, aliases_json, identities_json" if kind == "character" else "name, aliases_json"
        db = await self._ensure_db()
        async with db.execute(f"SELECT {columns} FROM {table}") as cursor:
            rows = await cursor.fetchall()

        taken = {str(row["name"] or "") for row in rows}
        if all(is_path_safe_asset_name(name, kind=kind) for name in taken):
            return {}

        renamed: Dict[str, str] = {}
        for row in rows:
            old_name = str(row["name"] or "")
            if is_path_safe_asset_name(old_name, kind=kind):
                continue
            taken.discard(old_name)
            new_name = unique_path_safe_asset_name(old_name, taken, kind=kind)
            if not new_name or new_name == old_name:
                taken.add(old_name)
                continue
            if move_assets is not None:
                try:
                    move_assets(old_name, new_name)
                except (OSError, ValueError):
                    logger.warning(
                        "资产目录迁移失败，跳过改名: %s → %s", old_name, new_name, exc_info=True
                    )
                    taken.add(old_name)
                    continue
            aliases = json.loads(row["aliases_json"] or "[]")
            if old_name not in aliases:
                aliases.append(old_name)
            if kind == "character":
                identities = json.loads(row["identities_json"] or "[]")
                for identity in identities:
                    if not isinstance(identity, dict):
                        continue
                    identity["character_name"] = new_name
                    identity_name = str(identity.get("identity_name") or "")
                    if identity_name:
                        identity["identity_id"] = f"{new_name}_{identity_name}"
                await db.execute(
                    f"UPDATE {table} SET name = ?, aliases_json = ?, identities_json = ?, "
                    f"updated_at = datetime('now') WHERE name = ?",
                    (
                        new_name,
                        json.dumps(aliases, ensure_ascii=False),
                        json.dumps(identities, ensure_ascii=False),
                        old_name,
                    ),
                )
                # identity_id 把角色名嵌在里面，散在 episodes / beats 里的引用要一起改。
                # 和上面的改名同一个事务（下面统一 commit），不能只改一半。
                await self._cascade_character_rename(old_name, new_name)
            else:
                await db.execute(
                    f"UPDATE {table} SET name = ?, aliases_json = ?, "
                    f"updated_at = datetime('now') WHERE name = ?",
                    (new_name, json.dumps(aliases, ensure_ascii=False), old_name),
                )
            if kind == "scene":
                # 派生场景按名字挂在母场景上，母场景改名后这些指针要跟着走，否则分组会
                # 散架。必须和上面的改名同一个事务：一旦这一行提交了，名字就已经安全，
                # 下次启动的自愈不会再看这一行，落下的 base_scene_id 就永远不会被补。
                await db.execute(
                    "UPDATE scenes SET base_scene_id = ?, updated_at = datetime('now') "
                    "WHERE base_scene_id = ?",
                    (new_name, old_name),
                )
            # 逐行提交：目录已经搬到新名下了，这一行的改名必须立刻落库。攒到最后一次性
            # 提交的话，中途任何一行抛异常都会让「盘上新名、库里旧名」这批错位留在磁盘
            # 上——正是上面那句「宁可留着坏名字」要避免的状态，只是方向反过来。
            await db.commit()
            taken.add(new_name)
            renamed[old_name] = new_name

        if not renamed:
            return {}

        # 两种 kind 都走 load_graph_state：`_props.clear()` 只清不填，而 list_props()
        # 直接读 SQLite、不回填缓存，本次请求剩下的 get_cached_prop() 会对每个道具都
        # 返回 None。
        await self.load_graph_state()
        return renamed

    @staticmethod
    def _normalize_alias_lookup(value: str) -> str:
        """统一别名查找键，降低空格/大小写差异导致的失配。"""
        return " ".join((value or "").replace("\u3000", " ").strip().lower().split())

    async def add_scene(self, scene: NovelScene) -> None:
        """添加或更新场景。"""
        db = await self._ensure_db()
        await db.execute(
            """INSERT INTO scenes (name, aliases_json, scene_type,
               base_scene_id, variant_id, time_of_day,
               environment_prompt, variant_prompt, description, spatial_layout_image, notes)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(name) DO UPDATE SET
               aliases_json=excluded.aliases_json,
               scene_type=excluded.scene_type,
               base_scene_id=excluded.base_scene_id,
               variant_id=excluded.variant_id,
               time_of_day=excluded.time_of_day,
               environment_prompt=excluded.environment_prompt,
               variant_prompt=excluded.variant_prompt,
               description=excluded.description,
               spatial_layout_image=excluded.spatial_layout_image,
               notes=excluded.notes,
               updated_at=datetime('now')""",
            (
                scene.name,
                json.dumps(scene.aliases, ensure_ascii=False),
                scene.scene_type,
                scene.base_scene_id,
                scene.variant_id,
                scene.time_of_day,
                scene.environment_prompt,
                scene.variant_prompt,
                scene.description,
                scene.spatial_layout_image,
                scene.notes,
            ),
        )
        await db.commit()

    async def get_scene(self, name: str) -> Optional[NovelScene]:
        """获取场景（支持别名查找）。"""
        db = await self._ensure_db()
        async with db.execute("SELECT * FROM scenes WHERE name = ?", (name,)) as cursor:
            row = await cursor.fetchone()
        if row:
            return self._row_to_scene(row)

        lookup = self._normalize_alias_lookup(name)
        async with db.execute("SELECT * FROM scenes") as cursor:
            rows = await cursor.fetchall()
        for row in rows:
            aliases = json.loads(row["aliases_json"] or "[]")
            if any(self._normalize_alias_lookup(alias) == lookup for alias in aliases):
                return self._row_to_scene(row)
        return None

    async def list_scenes(self) -> List[NovelScene]:
        """列出所有场景。"""
        db = await self._ensure_db()
        async with db.execute("SELECT * FROM scenes ORDER BY name") as cursor:
            rows = await cursor.fetchall()
        return [self._row_to_scene(row) for row in rows]

    async def update_scene(self, name: str, **updates) -> bool:
        """更新场景字段。"""
        allowed = {
            "aliases",
            "scene_type",
            "base_scene_id",
            "variant_id",
            "time_of_day",
            "environment_prompt",
            "variant_prompt",
            "description",
            "spatial_layout_image",
            "notes",
        }
        set_parts = []
        values = []
        for key, value in updates.items():
            if key not in allowed:
                continue
            if key == "aliases":
                set_parts.append("aliases_json = ?")
                values.append(json.dumps(value, ensure_ascii=False))
            else:
                set_parts.append(f"{key} = ?")
                values.append(value)
        if not set_parts:
            return False
        set_parts.append("updated_at = datetime('now')")
        values.append(name)
        db = await self._ensure_db()
        cursor = await db.execute(
            f"UPDATE scenes SET {', '.join(set_parts)} WHERE name = ?",
            values,
        )
        await db.commit()
        return (cursor.rowcount or 0) > 0

    async def touch_scene_asset(self, name: str) -> bool:
        """Advance the row revision after publishing a convention-path asset."""

        db = await self._ensure_db()
        cursor = await db.execute(
            "UPDATE scenes SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') "
            "WHERE name = ?",
            (name,),
        )
        await db.commit()
        return (cursor.rowcount or 0) > 0

    async def rename_scene(self, old_name: str, new_name: str) -> bool:
        """重命名场景记录。资源目录迁移由调用方处理。"""
        old_name = str(old_name or "").strip()
        new_name = path_safe_asset_name(new_name)
        if not old_name or not new_name or old_name == new_name:
            return False
        if await self.get_scene(new_name) is not None:
            return False
        db = await self._ensure_db()
        cursor = await db.execute(
            "UPDATE scenes SET name = ?, updated_at = datetime('now') WHERE name = ?",
            (new_name, old_name),
        )
        await db.commit()
        return (cursor.rowcount or 0) > 0

    async def delete_scene(self, name: str) -> bool:
        """删除场景。"""
        db = await self._ensure_db()
        cursor = await db.execute("DELETE FROM scenes WHERE name = ?", (name,))
        await db.commit()
        return (cursor.rowcount or 0) > 0

    @staticmethod
    def _row_to_scene(row) -> NovelScene:
        return NovelScene(
            name=row["name"],
            aliases=json.loads(row["aliases_json"] or "[]"),
            scene_type=row["scene_type"] or "interior",
            base_scene_id=(row["base_scene_id"] if "base_scene_id" in row.keys() else "") or "",
            variant_id=(row["variant_id"] if "variant_id" in row.keys() else "") or "",
            time_of_day=(row["time_of_day"] if "time_of_day" in row.keys() else "") or "",
            environment_prompt=row["environment_prompt"] or "",
            variant_prompt=(row["variant_prompt"] if "variant_prompt" in row.keys() else "") or "",
            description=row["description"] or "",
            spatial_layout_image=(
                row["spatial_layout_image"] if "spatial_layout_image" in row.keys() else ""
            )
            or "",
            notes=row["notes"] or "",
            updated_at=row["updated_at"] if "updated_at" in row.keys() else "",
        )

    async def add_prop(self, prop: NovelProp) -> None:
        """添加或更新道具。"""
        db = await self._ensure_db()
        await db.execute(
            """INSERT INTO props (name, aliases_json, prop_type, visual_prompt,
               description, owner, notes)
               VALUES (?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(name) DO UPDATE SET
               aliases_json=excluded.aliases_json,
               prop_type=excluded.prop_type,
               visual_prompt=excluded.visual_prompt,
               description=excluded.description,
               owner=excluded.owner,
               notes=excluded.notes,
               updated_at=datetime('now')""",
            (
                prop.name,
                json.dumps(prop.aliases, ensure_ascii=False),
                prop.prop_type,
                prop.visual_prompt,
                prop.description,
                prop.owner,
                prop.notes,
            ),
        )
        await db.commit()
        self._props[prop.name] = prop

    async def get_prop(self, name: str) -> Optional[NovelProp]:
        """获取道具（支持别名查找）。"""
        db = await self._ensure_db()
        async with db.execute("SELECT * FROM props WHERE name = ?", (name,)) as cursor:
            row = await cursor.fetchone()
        if row:
            return self._row_to_prop(row)

        lookup = self._normalize_alias_lookup(name)
        async with db.execute("SELECT * FROM props") as cursor:
            rows = await cursor.fetchall()
        for row in rows:
            aliases = json.loads(row["aliases_json"] or "[]")
            if any(self._normalize_alias_lookup(alias) == lookup for alias in aliases):
                return self._row_to_prop(row)
        return None

    async def list_props(self) -> List[NovelProp]:
        """列出所有道具。"""
        db = await self._ensure_db()
        async with db.execute("SELECT * FROM props ORDER BY name") as cursor:
            rows = await cursor.fetchall()
        return [self._row_to_prop(row) for row in rows]

    async def update_prop(self, name: str, **updates) -> bool:
        """更新道具字段。"""
        allowed = {
            "aliases",
            "prop_type",
            "visual_prompt",
            "description",
            "owner",
            "notes",
        }
        set_parts = []
        values = []
        for key, value in updates.items():
            if key not in allowed:
                continue
            if key == "aliases":
                set_parts.append("aliases_json = ?")
                values.append(json.dumps(value, ensure_ascii=False))
            else:
                set_parts.append(f"{key} = ?")
                values.append(value)
        if not set_parts:
            return False
        set_parts.append("updated_at = datetime('now')")
        values.append(name)
        db = await self._ensure_db()
        cursor = await db.execute(
            f"UPDATE props SET {', '.join(set_parts)} WHERE name = ?",
            values,
        )
        await db.commit()
        if (cursor.rowcount or 0) > 0 and name in self._props:
            prop = self._props[name]
            for key, value in updates.items():
                if key == "aliases":
                    prop.aliases = value
                elif hasattr(prop, key):
                    setattr(prop, key, value)
        return (cursor.rowcount or 0) > 0

    async def touch_prop_asset(self, name: str) -> bool:
        """Advance the row revision after publishing a convention-path asset."""

        db = await self._ensure_db()
        cursor = await db.execute(
            "UPDATE props SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') "
            "WHERE name = ?",
            (name,),
        )
        await db.commit()
        return (cursor.rowcount or 0) > 0

    async def rename_prop(self, old_name: str, new_name: str) -> bool:
        """重命名道具记录。资源目录迁移由调用方处理。"""
        old_name = str(old_name or "").strip()
        new_name = path_safe_asset_name(new_name)
        if not old_name or not new_name or old_name == new_name:
            return False
        if await self.get_prop(new_name) is not None:
            return False
        db = await self._ensure_db()
        cursor = await db.execute(
            "UPDATE props SET name = ?, updated_at = datetime('now') WHERE name = ?",
            (new_name, old_name),
        )
        await db.commit()
        if (cursor.rowcount or 0) > 0:
            prop = self._props.pop(old_name, None)
            if prop is not None:
                prop.name = new_name
                self._props[new_name] = prop
        return (cursor.rowcount or 0) > 0

    async def delete_prop(self, name: str) -> bool:
        """删除道具。"""
        db = await self._ensure_db()
        cursor = await db.execute("DELETE FROM props WHERE name = ?", (name,))
        await db.commit()
        self._props.pop(name, None)
        return (cursor.rowcount or 0) > 0

    @staticmethod
    def _row_to_prop(row) -> NovelProp:
        return NovelProp(
            name=row["name"],
            aliases=json.loads(row["aliases_json"] or "[]"),
            prop_type=row["prop_type"] or "object",
            visual_prompt=row["visual_prompt"] or "",
            description=row["description"] or "",
            owner=row["owner"] or "",
            notes=row["notes"] or "",
            updated_at=row["updated_at"] if "updated_at" in row.keys() else "",
        )

    async def add_character_identity(
        self, character_name: str, identity: CharacterIdentity
    ) -> None:
        char = self.get_character(character_name)
        if not char:
            raise ValueError(f"角色 {character_name} 不存在")
        identity.character_name = char.name
        if not identity.identity_id:
            identity.identity_id = f"{char.name}_{identity.identity_name}"
        for existing in char.identities:
            if existing.identity_id == identity.identity_id:
                raise ValueError(f"身份 {identity.identity_id} 已存在")
        identities = char.identities
        identities.append(identity)
        char.identities = identities
        await self._update_character_field(char.name, "identities_json", char.identities_json)
        console.print(f"[green]已为 {char.name} 添加身份: {identity.identity_name}[/green]")

    async def _cascade_identity_change(self, old_id: str, new_id: str | None = None) -> None:
        for ep in self._episodes.values():
            ids = ep.identity_ids
            if old_id in ids:
                if new_id:
                    ids = [new_id if x == old_id else x for x in ids]
                else:
                    ids = [x for x in ids if x != old_id]
                # Column-level: renaming or deleting an identity can happen
                # while planning is running, and a whole-row write here would
                # discard whatever menu landed in between.
                await self.patch_episode(ep.number, identity_ids=ids)

    async def update_character_identity(
        self,
        character_name: str,
        identity_id: str,
        **updates,
    ) -> None:
        char = self.get_character(character_name)
        if not char:
            raise ValueError(f"角色 {character_name} 不存在")
        identities = char.identities
        target_identity = None
        for identity in identities:
            if identity.identity_id == identity_id:
                target_identity = identity
                break
        if not target_identity:
            raise ValueError(f"身份 {identity_id} 不存在")
        for key, value in updates.items():
            if hasattr(target_identity, key):
                setattr(target_identity, key, value)
        if "identity_name" in updates:
            import re

            new_iname = updates["identity_name"]
            old_iname = identity_id.split("_", 1)[-1] if "_" in identity_id else identity_id
            target_identity.identity_id = f"{char.name}_{new_iname}"
            old_safe = re.sub(r'[/\\:*?"<>|]', "_", old_iname)
            new_safe = re.sub(r'[/\\:*?"<>|]', "_", new_iname)
            old_img = (
                Path(self.project_dir)
                / "assets"
                / "characters"
                / char.name
                / "identities"
                / f"{old_safe}.png"
            )
            new_img = (
                Path(self.project_dir)
                / "assets"
                / "characters"
                / char.name
                / "identities"
                / f"{new_safe}.png"
            )
            if old_img.exists() and not new_img.exists():
                old_img.replace(new_img)
        char.identities = identities
        if "identity_name" in updates:
            old_id = identity_id
            new_id = target_identity.identity_id
            if old_id != new_id:
                await self._cascade_identity_change(old_id, new_id)
        await self._update_character_field(char.name, "identities_json", char.identities_json)
        console.print(f"[green]已更新 {char.name} 的身份: {target_identity.identity_id}[/green]")

    async def delete_character_identity(self, character_name: str, identity_id: str) -> None:
        char = self.get_character(character_name)
        if not char:
            raise ValueError(f"角色 {character_name} 不存在")
        identities = char.identities
        target_identity = None
        for i, identity in enumerate(identities):
            if identity.identity_id == identity_id:
                target_identity = identities.pop(i)
                break
        if not target_identity:
            raise ValueError(f"身份 {identity_id} 不存在")
        char.identities = identities
        await self._cascade_identity_change(identity_id, None)
        await self._update_character_field(char.name, "identities_json", char.identities_json)
        console.print(f"[green]已删除 {char.name} 的身份: {identity_id}[/green]")

    async def delete_identity_image(self, character_name: str, identity_id: str) -> bool:
        char = self.get_character(character_name)
        if not char:
            raise ValueError(f"角色 {character_name} 不存在")
        target_identity = next((i for i in char.identities if i.identity_id == identity_id), None)
        if not target_identity:
            raise ValueError(f"身份 {identity_id} 不存在")
        image_path = compute_identity_path(
            Path(self.project_dir), character_name, target_identity.identity_name
        )
        if not image_path:
            console.print(f"[yellow]身份 {identity_id} 没有图片[/yellow]")
            return False
        image_file = Path(image_path)
        if image_file.exists():
            image_file.unlink()
            console.print(f"[green]已删除图片文件: {image_path}[/green]")
            return True
        console.print(f"[yellow]图片文件不存在: {image_path}[/yellow]")
        return False

    async def _upsert_episodes(
        self,
        db: aiosqlite.Connection,
        episodes: List[NovelEpisode],
    ) -> None:
        """Write episode rows on the caller's current transaction."""

        for ep in episodes:
            await db.execute(
                """INSERT INTO episodes (number, title, chapter_start, chapter_end,
                   raw_content, beat_source_text, content_summary, main_conflict, cliffhanger, key_events,
                   character_names, identity_ids, event_ids, scene_menu_json, prop_menu_json,
                   identity_default_map_json, sketch_colors_json)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT(number) DO UPDATE SET
                   title=excluded.title, chapter_start=excluded.chapter_start,
                   chapter_end=excluded.chapter_end, raw_content=excluded.raw_content,
                   beat_source_text=excluded.beat_source_text,
                   content_summary=excluded.content_summary,
                   main_conflict=excluded.main_conflict, cliffhanger=excluded.cliffhanger,
                   key_events=excluded.key_events, character_names=excluded.character_names,
                   identity_ids=excluded.identity_ids, event_ids=excluded.event_ids,
                   scene_menu_json=excluded.scene_menu_json, prop_menu_json=excluded.prop_menu_json,
                   identity_default_map_json=excluded.identity_default_map_json,
                   sketch_colors_json=excluded.sketch_colors_json,
                   updated_at=datetime('now')""",
                (
                    ep.number,
                    ep.title,
                    ep.chapter_start,
                    ep.chapter_end,
                    ep.raw_content,
                    ep.beat_source_text,
                    ep.content_summary,
                    ep.main_conflict,
                    ep.cliffhanger,
                    json.dumps(ep.key_events, ensure_ascii=False),
                    json.dumps(ep.character_names, ensure_ascii=False),
                    json.dumps(ep.identity_ids, ensure_ascii=False),
                    json.dumps(ep.event_ids, ensure_ascii=False),
                    ep.scene_menu_json,
                    ep.prop_menu_json,
                    ep.identity_default_map_json,
                    ep.sketch_colors_json,
                ),
            )

    async def add_episodes(self, episodes: List[NovelEpisode]) -> None:
        db = await self._ensure_db()
        try:
            await self._upsert_episodes(db, episodes)
            await db.commit()
        except BaseException:
            await asyncio.shield(db.rollback())
            raise
        self._episodes.update({episode.number: episode for episode in episodes})

    async def build_episodes_from_chapters(
        self,
        novel_text: str = None,
        generate_metadata: bool = False,
        on_progress: Optional[Callable[[float, str], None]] = None,
        on_log: Optional[Callable[[str], None]] = None,
    ) -> List[NovelEpisode]:
        """从小说章节结构创建剧集（章节映射模式）。

        Deterministic: chapter markers in the source text become episodes, one
        per chapter. It reads the imported novel and writes SQLite and touches
        no graph, which is why it lives here rather than on the Cognee facade —
        structured projects open a SQLiteStore directly and could not reach it
        there. CogneeStore delegates, so legacy behaviour is unchanged.
        """
        from novelvideo.cognee.chapter_detector import ChapterDetector

        def report(progress: float, task: MessageLike):
            if on_progress:
                on_progress(progress, task)

        def log(message: MessageLike):
            if on_log:
                on_log(message)
            console.print(f"[dim]{message}[/dim]")

        # 获取小说原文
        if novel_text is None:
            log(lmsg("tasks.log.source.loading", "从文件加载原文..."))
            novel_text = require_imported_novel(self.project_dir)
            log(
                lmsg(
                    "tasks.log.source.loaded",
                    f"原文加载完成: {len(novel_text)} 字符",
                    charCount=len(novel_text),
                )
            )

        # Everything below computes; nothing is written until the publish at
        # the end. This used to clear every episode's raw_content and commit
        # before it had even detected a chapter, then commit again per delete,
        # per upsert and per episode body — so a cancelled task or a killed
        # worker could leave a project with every episode blank, or half its
        # episodes mapped, or metadata that did not match the text under it.

        # P1: 检测章节
        report(0.1, "检测章节结构...")
        log("检测章节结构...")
        detector = ChapterDetector()
        chapters = detector.detect(novel_text)

        if not chapters:
            raise ValueError("未检测到章节标记，请使用 AI 规划模式")

        log(f"检测到 {len(chapters)} 个章节")

        episodes = []
        chapter_contents = {}  # 收集章节内容，最后统一写入
        total = len(chapters)

        for i, chapter in enumerate(chapters):
            progress = 0.1 + (i / total) * 0.7
            report(progress, f"处理第 {chapter.number} 章...")

            # 收集章节内容（稍后写入，避免与 _delete_old_episodes 冲突）
            chapter_contents[chapter.number] = chapter.content

            if generate_metadata:
                log(f"为第 {chapter.number} 章生成元数据...")
                metadata = await self._generate_episode_metadata(chapter.number, chapter.content)
            else:
                summary = chapter.content[:200].strip()
                if len(chapter.content) > 200:
                    summary += "..."
                metadata = {
                    "title": f"第{chapter.number}集",
                    "summary": summary,
                    "conflict": "",
                    "cliffhanger": "",
                    "key_events": [],
                    "characters": [],
                }

            episode = NovelEpisode(
                number=chapter.number,
                title=metadata.get("title", f"第{chapter.number}集"),
                chapter_start=chapter.number,
                chapter_end=chapter.number,
                content_summary=metadata.get("summary", ""),
                main_conflict=metadata.get("conflict", ""),
                cliffhanger=metadata.get("cliffhanger", ""),
                key_events=metadata.get("key_events", []),
                character_names=metadata.get("characters", []),
            )
            episodes.append(episode)

        # P2: 合并剧集（保留已有的已规划资产字段）
        report(0.82, "合并剧集数据...")
        log("合并剧集数据（保留身份、场景、道具和颜色）...")
        new_numbers = {ep.number for ep in episodes}
        for ep in episodes:
            old = self._episodes.get(ep.number)
            if old:
                ep.identity_ids = old.identity_ids
                ep.scene_menu = old.scene_menu
                ep.prop_menu = old.prop_menu
                ep.sketch_colors_json = old.sketch_colors_json
            # The body travels on the row, so the text and the metadata
            # describing it land in the same write and cannot disagree.
            ep.raw_content = chapter_contents.get(ep.number, "")

        removed = set(self._episodes.keys()) - new_numbers

        # P3: 单事务发布
        report(0.88, "保存到数据库...")
        log("保存剧集到数据库...")
        db = await self._ensure_db()
        try:
            if removed:
                placeholders = ",".join("?" for _ in removed)
                await db.execute(
                    f"DELETE FROM episodes WHERE number IN ({placeholders})",
                    sorted(removed),
                )
            await self._upsert_episodes(db, episodes)
            await db.commit()
        except BaseException:
            await asyncio.shield(db.rollback())
            raise
        if removed:
            log(f"已删除 {len(removed)} 个旧剧集")

        # P4: 更新内存缓存，只在写入确实落盘之后
        self._episodes.clear()
        for ep in episodes:
            self._episodes[ep.number] = ep

        report(1.0, "章节映射完成")
        log(f"章节映射完成: {len(episodes)} 集")

        return episodes

    async def _generate_episode_metadata(self, episode_num: int, content: str) -> dict:
        """使用 LLM 生成剧集元数据。"""
        try:
            import litellm

            from novelvideo.config import (
                get_newapi_structured_output_litellm_kwargs,
            )

            truncated = content[:8000] if len(content) > 8000 else content

            prompt = f"""请分析以下章节内容，提取关键信息。

章节内容：
{truncated}

请用 JSON 格式返回以下信息：
{{
    "title": "一个吸引人的标题（10字以内）",
    "summary": "内容摘要（50-100字）",
    "conflict": "主要冲突或矛盾",
    "cliffhanger": "结尾悬念（如果有）",
    "key_events": ["关键事件1", "关键事件2"],
    "characters": ["出场角色1", "出场角色2"]
}}

只返回 JSON，不要有其他内容。"""

            response = await litellm.acompletion(
                model=os.environ.get("LLM_MODEL", "").strip()
                or DEFAULT_COGNEE_LLM_MODEL,
                messages=[{"role": "user", "content": prompt}],
                temperature=0.3,
                response_format={"type": "json_object"},
                **get_newapi_structured_output_litellm_kwargs(),
            )

            import json

            result = json.loads(response.choices[0].message.content)
            return result

        except Exception as e:
            console.print(f"[yellow]元数据生成失败: {e}，使用默认值[/yellow]")
            return {
                "title": f"第{episode_num}集",
                "summary": content[:200] + "..." if len(content) > 200 else content,
                "conflict": "",
                "cliffhanger": "",
                "key_events": [],
                "characters": [],
            }

    async def replace_episodes(self, episodes: List[NovelEpisode]) -> None:
        """Atomically replace every episode row and refresh the cache."""

        db = await self._ensure_db()
        try:
            await db.execute("DELETE FROM episodes")
            await self._upsert_episodes(db, episodes)
            await db.commit()
        except BaseException:
            await asyncio.shield(db.rollback())
            raise

        # Do not mutate the shared in-memory cache until the transaction commits.
        self._episodes.clear()
        self._episodes.update({episode.number: episode for episode in episodes})

    async def add_episode(self, episode: NovelEpisode) -> None:
        await self.add_episodes([episode])
        self._episodes[episode.number] = episode

    async def update_episode(self, episode_number: int, **updates) -> None:
        episode = self.get_episode(episode_number)
        if not episode:
            raise ValueError(f"剧集 {episode_number} 不存在")
        old_number = episode.number
        for key, value in updates.items():
            if key == "scene_menu":
                episode.scene_menu = value or []
            elif key == "prop_menu":
                episode.prop_menu = value or []
            elif hasattr(episode, key):
                setattr(episode, key, value)
        new_number = updates.get("number", old_number)
        if new_number != old_number:
            self._episodes.pop(old_number, None)
            self._episodes[new_number] = episode
        await self.add_episodes([episode])
        console.print(f"[green]已更新剧集: 第{episode.number}集[/green]")

    # Episode fields the column-level patch understands, and how each is
    # serialised. ``number`` is deliberately absent: renaming an episode moves
    # the primary key and the cache entry, which is a whole-row concern.
    _PATCHABLE_EPISODE_FIELDS: dict[str, tuple[str, str]] = {
        "scene_menu": ("scene_menu_json", "scene_menu"),
        "prop_menu": ("prop_menu_json", "prop_menu"),
        "identity_ids": ("identity_ids", "json_list"),
        "character_names": ("character_names", "json_list"),
        "key_events": ("key_events", "json_list"),
        "event_ids": ("event_ids", "json_list"),
        "identity_default_map": ("identity_default_map_json", "json_dict"),
        "sketch_colors": ("sketch_colors_json", "json_dict"),
        "title": ("title", "text"),
        "content_summary": ("content_summary", "text"),
        "main_conflict": ("main_conflict", "text"),
        "cliffhanger": ("cliffhanger", "text"),
        "beat_source_text": ("beat_source_text", "text"),
        "raw_content": ("raw_content", "text"),
        "adapted_content": ("adapted_content", "text"),
        "chapter_start": ("chapter_start", "int"),
        "chapter_end": ("chapter_end", "int"),
    }

    async def patch_episode(self, episode_number: int, **fields: Any) -> None:
        """Update only the columns the caller named, atomically.

        Anything that writes the whole episode row re-serialises columns it was
        never asked to change, from whatever the caller happened to load
        earlier. Scene, prop and identity planning run concurrently for one
        episode, and a user can edit that episode while they run, so a
        whole-row write loses whichever result landed in between — even when
        the two writers touch entirely different fields. Re-reading first does
        not close the window, because both can re-read before either commits.

        Naming a field with no value at all is how a column is left alone, so an
        empty list is a real update that empties it.

        This does not replace add_episodes()/replace_episodes(), which still own
        whole-row writes, nor renaming an episode, which moves the primary key.
        The in-memory cache refresh below only makes this process read its own
        write; correctness comes from the SQL, since the cache is not shared
        across workers.
        """
        assignments: list[str] = []
        params: list[Any] = []

        for field, value in fields.items():
            spec = self._PATCHABLE_EPISODE_FIELDS.get(field)
            if spec is None:
                raise ValueError(
                    f"patch_episode cannot write {field!r}; add it to "
                    "_PATCHABLE_EPISODE_FIELDS or use update_episode"
                )
            column, kind = spec
            if kind == "scene_menu":
                items = await self._normalize_scene_menu_items(value or [])
                encoded = json.dumps(
                    [item.model_dump() for item in items], ensure_ascii=False
                )
            elif kind == "prop_menu":
                items = self._normalize_prop_menu_items(value or [])
                encoded = json.dumps(
                    [item.model_dump() for item in items], ensure_ascii=False
                )
            elif kind == "json_list":
                encoded = json.dumps(list(value or []), ensure_ascii=False)
            elif kind == "json_dict":
                encoded = json.dumps(dict(value or {}), ensure_ascii=False)
            elif kind == "int":
                encoded = int(value or 0)
            else:
                encoded = str(value or "")
            assignments.append(f"{column} = ?")
            params.append(encoded)

        if not assignments:
            return

        db = await self._ensure_db()
        assignments.append("updated_at = datetime('now')")
        params.append(int(episode_number))
        cursor = await db.execute(
            f"UPDATE episodes SET {', '.join(assignments)} WHERE number = ?",
            params,
        )
        if not cursor.rowcount:
            raise ValueError(f"剧集 {episode_number} 不存在")
        await db.commit()

        refreshed = await self.get_episode_from_graph(episode_number)
        if refreshed is not None:
            self._episodes[episode_number] = refreshed

    # ── episode menu normalization ──────────────────────────────────────
    #
    # Canonical implementations, shared by the legacy whole-row update and the
    # column-level patch. Both routes must produce byte-identical menus: the
    # only difference between them is which columns get written.

    async def _normalize_scene_menu_items(
        self, scene_menu: Iterable[Any] | None
    ) -> list[SceneMenuItem]:
        """将 episode scene_menu 规范化为资产库标准 scene_id。"""
        normalized_items = build_scene_menu(scene_menu=list(scene_menu or []))
        canonical_items: list[SceneMenuItem] = []
        all_scenes = await self.list_scenes()
        for item in normalized_items:
            scene_id = str(item.scene_id or "").strip()
            if not scene_id:
                continue
            canonical_id = scene_id
            lookup = self._normalize_alias_lookup(scene_id)
            for candidate in all_scenes:
                if self._normalize_alias_lookup(candidate.name) == lookup:
                    canonical_id = candidate.name
                    break
                aliases = getattr(candidate, "aliases", []) or []
                if any(self._normalize_alias_lookup(alias) == lookup for alias in aliases):
                    canonical_id = candidate.name
                    break
            canonical_items.append(
                SceneMenuItem(
                    scene_id=canonical_id,
                    base_scene_id=str(getattr(item, "base_scene_id", "") or "").strip(),
                    variant_id=str(getattr(item, "variant_id", "") or "").strip(),
                    time_of_day=str(getattr(item, "time_of_day", "") or "").strip(),
                )
            )
        return build_scene_menu(scene_menu=canonical_items)

    def _normalize_prop_menu_items(self, prop_menu: Iterable[Any] | None) -> list[PropMenuItem]:
        """将 episode prop_menu 规范化为资产库标准 prop_id。"""
        normalized_items = build_prop_menu(prop_menu=list(prop_menu or []))
        canonical_items: list[PropMenuItem] = []
        for item in normalized_items:
            prop_id = str(item.prop_id or "").strip()
            if not prop_id:
                continue
            cached = self.get_cached_prop(prop_id)
            canonical_id = cached.name if cached else prop_id
            canonical_items.append(
                PropMenuItem(
                    prop_id=canonical_id,
                    prop_type=(getattr(cached, "prop_type", "") if cached else item.prop_type)
                    or "object",
                    visual_prompt=(
                        getattr(cached, "visual_prompt", "")
                        or getattr(cached, "description", "")
                        or item.visual_prompt
                    ),
                    description=(
                        getattr(cached, "visual_prompt", "")
                        or getattr(cached, "description", "")
                        or item.description
                    ),
                    owner_identity_id=item.owner_identity_id or getattr(cached, "owner", ""),
                )
            )
        return build_prop_menu(prop_menu=canonical_items)

    async def delete_all_episodes(self) -> int:
        try:
            db = await self._ensure_db()
            cursor = await db.execute("DELETE FROM episodes")
            await db.commit()
            self._episodes.clear()
            deleted = cursor.rowcount
            console.print(f"[dim]已删除 {deleted} 个旧剧集[/dim]")
            return deleted
        except Exception as e:
            console.print(f"[yellow]删除旧剧集失败: {e}[/yellow]")
            return 0

    async def delete_episodes_by_numbers(self, episode_numbers: set[int] | list[int]) -> int:
        """按集数删除剧集。"""
        numbers = sorted({int(num) for num in episode_numbers if int(num) > 0})
        if not numbers:
            return 0
        db = await self._ensure_db()
        placeholders = ",".join("?" for _ in numbers)
        cursor = await db.execute(
            f"DELETE FROM episodes WHERE number IN ({placeholders})",
            numbers,
        )
        await db.commit()
        for number in numbers:
            self._episodes.pop(number, None)
        return cursor.rowcount or 0

    async def load_graph_state(self) -> None:
        characters = await self.list_characters()
        episodes = await self.list_episodes()
        props = await self.list_props()

        self._characters.clear()
        self._characters.update({char.name: char for char in characters})
        self._episodes.clear()
        self._episodes.update({episode.number: episode for episode in episodes})
        self._props.clear()
        self._props.update({prop.name: prop for prop in props})
        self._alias_index.clear()
        for char in characters:
            for alias in char.aliases:
                self._alias_index[alias] = char.name

    def resolve_name(self, name: str) -> str:
        return self._alias_index.get(name, name)

    def get_character(self, name: str) -> Optional[NovelCharacter]:
        return self._characters.get(self.resolve_name(name))

    def get_episode(self, number: int) -> Optional[NovelEpisode]:
        return self._episodes.get(number)

    def get_cached_prop(self, name: str) -> Optional[NovelProp]:
        raw_name = str(name or "").strip()
        if not raw_name:
            return None
        prop = self._props.get(raw_name)
        if prop:
            return prop
        lookup = self._normalize_alias_lookup(raw_name)
        for candidate in self._props.values():
            if self._normalize_alias_lookup(candidate.name) == lookup:
                return candidate
            aliases = getattr(candidate, "aliases", []) or []
            if any(self._normalize_alias_lookup(alias) == lookup for alias in aliases):
                return candidate
        return None

    def get_all_characters(self) -> List[NovelCharacter]:
        return list(self._characters.values())

    def get_all_episodes(self) -> List[NovelEpisode]:
        return sorted(self._episodes.values(), key=lambda episode: episode.number)

    async def list_characters(self) -> List[NovelCharacter]:
        db = await self._ensure_db()
        async with db.execute("SELECT * FROM characters") as cursor:
            rows = await cursor.fetchall()

        return [
            NovelCharacter(
                name=row["name"],
                aliases=json.loads(row["aliases_json"] or "[]"),
                role=row["role"] or "",
                is_main=bool(row["is_main"]),
                gender=row["gender"] or "",
                age_group=row["age_group"] if "age_group" in row.keys() else "youth",
                body_type=row["body_type"] or "",
                fish_voice_id=row["fish_voice_id"] if "fish_voice_id" in row.keys() else "",
                description=row["description"] or "",
                face_prompt=row["face_prompt"] or "",
                appearance_details=row["appearance_details"] or "",
                identities_json=row["identities_json"] or "[]",
                reference_audio_path=(
                    row["reference_audio_path"] if "reference_audio_path" in row.keys() else ""
                )
                or "",
                reference_audio_sha256=(
                    row["reference_audio_sha256"] if "reference_audio_sha256" in row.keys() else ""
                )
                or "",
                reference_audio_updated_at=(
                    row["reference_audio_updated_at"]
                    if "reference_audio_updated_at" in row.keys()
                    else ""
                )
                or "",
                voice_samples_by_age_group_json=(
                    row["voice_samples_by_age_group_json"]
                    if "voice_samples_by_age_group_json" in row.keys()
                    else "{}"
                )
                or "{}",
                updated_at=row["updated_at"] if "updated_at" in row.keys() else "",
            )
            for row in rows
        ]

    async def list_episodes(self) -> List[NovelEpisode]:
        db = await self._ensure_db()
        async with db.execute("SELECT * FROM episodes ORDER BY number") as cursor:
            rows = await cursor.fetchall()

        return [
            NovelEpisode(
                number=row["number"],
                title=row["title"] or "",
                chapter_start=row["chapter_start"] or 0,
                chapter_end=row["chapter_end"] or 0,
                raw_content=row["raw_content"] or "",
                adapted_content=row["adapted_content"] or "",
                beat_source_text=row["beat_source_text"] or "",
                content_summary=row["content_summary"] or "",
                main_conflict=row["main_conflict"] or "",
                cliffhanger=row["cliffhanger"] or "",
                key_events=json.loads(row["key_events"] or "[]"),
                character_names=json.loads(row["character_names"] or "[]"),
                identity_ids=json.loads(row["identity_ids"] or "[]"),
                event_ids=json.loads(row["event_ids"] or "[]"),
                scene_menu_json=row["scene_menu_json"] if "scene_menu_json" in row.keys() else "[]",
                prop_menu_json=row["prop_menu_json"] if "prop_menu_json" in row.keys() else "[]",
                identity_default_map_json=(
                    row["identity_default_map_json"]
                    if "identity_default_map_json" in row.keys()
                    else "{}"
                ),
                sketch_colors_json=row["sketch_colors_json"] or "{}",
                updated_at=row["updated_at"] if "updated_at" in row.keys() else "",
            )
            for row in rows
        ]

    async def get_character_from_graph(self, name: str) -> Optional[NovelCharacter]:
        characters = await self.list_characters()
        for character in characters:
            if character.name == name or name in character.aliases:
                return character
        return None

    async def get_episode_from_graph(self, number: int) -> Optional[NovelEpisode]:
        db = await self._ensure_db()
        async with db.execute("SELECT * FROM episodes WHERE number = ?", (number,)) as cursor:
            row = await cursor.fetchone()
            if not row:
                return None
            return NovelEpisode(
                number=row["number"],
                title=row["title"] or "",
                chapter_start=row["chapter_start"] or 0,
                chapter_end=row["chapter_end"] or 0,
                raw_content=row["raw_content"] or "",
                adapted_content=row["adapted_content"] or "",
                beat_source_text=row["beat_source_text"] or "",
                content_summary=row["content_summary"] or "",
                main_conflict=row["main_conflict"] or "",
                cliffhanger=row["cliffhanger"] or "",
                key_events=json.loads(row["key_events"] or "[]"),
                character_names=json.loads(row["character_names"] or "[]"),
                identity_ids=json.loads(row["identity_ids"] or "[]"),
                event_ids=json.loads(row["event_ids"] or "[]"),
                scene_menu_json=row["scene_menu_json"] if "scene_menu_json" in row.keys() else "[]",
                prop_menu_json=row["prop_menu_json"] if "prop_menu_json" in row.keys() else "[]",
                identity_default_map_json=(
                    row["identity_default_map_json"]
                    if "identity_default_map_json" in row.keys()
                    else "{}"
                ),
                sketch_colors_json=row["sketch_colors_json"] or "{}",
                updated_at=row["updated_at"] if "updated_at" in row.keys() else "",
            )

    def get_sketch_colors(self, episode_number: int) -> dict:
        episode = self.get_episode(episode_number)
        if not episode:
            return {}
        try:
            return json.loads(episode.sketch_colors_json or "{}")
        except (json.JSONDecodeError, TypeError):
            return {}

    async def set_sketch_colors(self, episode_number: int, colors: dict) -> None:
        db = await self._ensure_db()
        colors_json = json.dumps(colors, ensure_ascii=False)
        await db.execute(
            "UPDATE episodes SET sketch_colors_json = ?, updated_at = datetime('now') "
            "WHERE number = ?",
            (colors_json, episode_number),
        )
        await db.commit()
        episode = self._episodes.get(episode_number)
        if episode:
            episode.sketch_colors_json = colors_json

    @staticmethod
    def _row_to_visual_beat(row) -> NovelVisualBeat:
        return NovelVisualBeat(
            beat_number=row["beat_number"],
            episode_number=row["episode_number"],
            narration=row["narration"] or "",
            visual_description=row["visual_description"] or "",
            detected_identities_json=row["detected_identities_json"] or "[]",
            detected_props_json=(
                row["detected_props_json"] if "detected_props_json" in row.keys() else "[]"
            )
            or "[]",
            scene_ref_json=row["scene_ref_json"] if "scene_ref_json" in row.keys() else "",
            audio_type=row["audio_type"] or "narration",
            speaker=row["speaker"] or "",
            speaker_kind=row["speaker_kind"] if "speaker_kind" in row.keys() else "character",
            video_mode=row["video_mode"] if "video_mode" in row.keys() else "first_frame",
            video_prompt=row["video_prompt"] if "video_prompt" in row.keys() else "",
            keyframe_prompt=row["keyframe_prompt"] if "keyframe_prompt" in row.keys() else "",
            seedance2_config_json=(
                row["seedance2_config_json"] if "seedance2_config_json" in row.keys() else "{}"
            ),
            time_of_day=row["time_of_day"] if "time_of_day" in row.keys() else "",
            shot_order=row["shot_order"] if "shot_order" in row.keys() else None,
            duration_seconds=row["duration_seconds"] if "duration_seconds" in row.keys() else None,
            is_manual_shot=(
                bool(row["is_manual_shot"])
                if "is_manual_shot" in row.keys() and row["is_manual_shot"] is not None
                else False
            ),
        )

    async def list_visual_beats(self) -> List[NovelVisualBeat]:
        db = await self._ensure_db()
        async with db.execute("SELECT * FROM beats ORDER BY episode_number, beat_number") as cursor:
            rows = await cursor.fetchall()
        return [self._row_to_visual_beat(row) for row in rows]

    async def list_beat_asset_refs(self) -> List[BeatAssetRefRow]:
        """每个 beat 的资产引用字段，只取用得上的六列。

        资产反向索引要扫全项目的 beats。走 ``list_visual_beats()`` 的话，每行都是
        ``SELECT *`` 出约 20 列、再构造一个完整 ``NovelVisualBeat``——那个 pydantic
        validator 还会把 ``scene_ref_json`` 反序列化再序列化回去、给 narration 和
        visual_description 填默认值。这些结果扫描一个都不读。
        """
        db = await self._ensure_db()
        async with db.execute(
            "SELECT episode_number, beat_number, visual_description, "
            "detected_identities_json, detected_props_json, scene_ref_json "
            "FROM beats ORDER BY episode_number, beat_number"
        ) as cursor:
            rows = await cursor.fetchall()
        return [
            BeatAssetRefRow(
                episode_number=int(row["episode_number"] or 0),
                beat_number=int(row["beat_number"] or 0),
                visual_description=row["visual_description"] or "",
                detected_identities_json=row["detected_identities_json"] or "[]",
                detected_props_json=row["detected_props_json"] or "[]",
                scene_ref_json=row["scene_ref_json"] or "",
            )
            for row in rows
        ]

    async def count_beats_by_episode(self) -> Dict[int, int]:
        """每集的 beat 数，一次分组查询。

        分集列表要在每张卡片上显示镜头数。前端此前是逐集调
        ``GET /episodes/{n}/beats`` 再取 ``len()``——有几集就发几个请求，每个都要
        解析项目上下文、开库、构造完整 beat 载荷（含 sketch/frame/video URL 与
        每条音频一次 ffprobe），只为了拿一个整数。
        """
        db = await self._ensure_db()
        async with db.execute(
            "SELECT episode_number, COUNT(*) AS n FROM beats GROUP BY episode_number"
        ) as cursor:
            rows = await cursor.fetchall()
        return {int(row["episode_number"]): int(row["n"]) for row in rows}

    async def get_beats_for_episode(self, number: int) -> List[NovelVisualBeat]:
        db = await self._ensure_db()
        async with db.execute(
            "SELECT * FROM beats WHERE episode_number = ? ORDER BY beat_number",
            (number,),
        ) as cursor:
            rows = await cursor.fetchall()
        return [self._row_to_visual_beat(row) for row in rows]

    async def get_beats_as_dicts(self, episode_number: int) -> List[Dict[str, Any]]:
        beats = await self.get_beats_for_episode(episode_number)
        result = []

        def _order_key(b):
            order = getattr(b, "shot_order", None)
            primary = int(order) if order is not None else int(b.beat_number) * 10
            return (primary, int(b.beat_number))

        for b in sorted(beats, key=_order_key):
            result.append(
                {
                    "beat_number": b.beat_number,
                    "narration_segment": b.narration,
                    "visual_description": b.visual_description,
                    "scene_ref": (
                        b.scene_ref.model_dump() if getattr(b, "scene_ref", None) else None
                    ),
                    "estimated_duration": len(b.narration or "") / 4.0,
                    "audio_type": b.audio_type,
                    "speaker": b.speaker,
                    "speaker_kind": getattr(b, "speaker_kind", "character"),
                    "video_mode": getattr(b, "video_mode", "first_frame"),
                    "video_prompt": getattr(b, "video_prompt", ""),
                    "keyframe_prompt": getattr(b, "keyframe_prompt", ""),
                    "seedance2_config_json": getattr(b, "seedance2_config_json", "{}"),
                    "detected_identities": normalize_detected_identities(
                        json.loads(b.detected_identities_json or "[]")
                    ),
                    "detected_props": normalize_detected_props(
                        json.loads(getattr(b, "detected_props_json", "[]") or "[]")
                    ),
                    "time_of_day": getattr(b, "time_of_day", ""),
                    "shot_order": getattr(b, "shot_order", None),
                    "duration_seconds": getattr(b, "duration_seconds", None),
                    "is_manual_shot": bool(getattr(b, "is_manual_shot", False)),
                }
            )
        return result

    async def get_script_as_dict(self, episode_number: int) -> Optional[Dict]:
        episode = self.get_episode(episode_number)
        if not episode:
            episode = await self.get_episode_from_graph(episode_number)
        if not episode:
            return None

        beats = await self.get_beats_as_dicts(episode_number)
        if not beats:
            return None

        return {
            "episode_number": episode_number,
            "title": episode.title,
            "beats": beats,
            "scene_menu": [item.model_dump() for item in (episode.scene_menu or [])],
            "prop_menu": [item.model_dump() for item in (episode.prop_menu or [])],
            "sketch_colors": self.get_sketch_colors(episode_number),
        }

    async def update_beat_asset(
        self,
        episode_number: int,
        beat_number: int | None = None,
        narration_segment: str | None = None,
        visual_description: str | None = None,
        audio_type: str | None = None,
        speaker: str | None = None,
        detected_identities: list | None = None,
        detected_props: list | None = None,
        scene_ref: dict | None = None,
        video_mode: str | None = None,
        video_prompt: str | None = None,
        keyframe_prompt: str | None = None,
        seedance2_config_json: str | None = None,
        time_of_day: str | None = None,
        shot_order: int | None = None,
        duration_seconds: float | None = None,
        is_manual_shot: bool | None = None,
    ) -> bool:
        bn = beat_number
        if bn is None:
            return False

        properties: dict[str, Any] = {}
        if narration_segment is not None:
            properties["narration"] = narration_segment
        if visual_description is not None:
            properties["visual_description"] = visual_description
        if audio_type is not None:
            properties["audio_type"] = audio_type
        if speaker is not None:
            properties["speaker"] = speaker
        if detected_identities is not None:
            properties["detected_identities_json"] = json.dumps(
                normalize_detected_identities(detected_identities),
                ensure_ascii=False,
            )
        if detected_props is not None:
            properties["detected_props_json"] = json.dumps(
                normalize_detected_props(detected_props),
                ensure_ascii=False,
            )
        if video_mode is not None:
            properties["video_mode"] = video_mode
        if video_prompt is not None:
            properties["video_prompt"] = video_prompt
        if keyframe_prompt is not None:
            properties["keyframe_prompt"] = keyframe_prompt
        if seedance2_config_json is not None:
            properties["seedance2_config_json"] = str(seedance2_config_json or "{}")
        if time_of_day is not None:
            properties["time_of_day"] = time_of_day
        if shot_order is not None:
            properties["shot_order"] = int(shot_order)
        if duration_seconds is not None:
            properties["duration_seconds"] = float(duration_seconds)
        if is_manual_shot is not None:
            properties["is_manual_shot"] = 1 if is_manual_shot else 0

        if scene_ref is not None:
            beat_payload = {"scene_ref": scene_ref}
            sync_beat_asset_refs(beat_payload)
            properties["scene_ref_json"] = (
                json.dumps(beat_payload.get("scene_ref"), ensure_ascii=False)
                if beat_payload.get("scene_ref")
                else ""
            )

        if not properties:
            return False

        try:
            db = await self._ensure_db()
            set_parts = [f"{key} = ?" for key in properties]
            set_parts.append("updated_at = datetime('now')")
            values = list(properties.values()) + [episode_number, bn]
            await db.execute(
                f"UPDATE beats SET {', '.join(set_parts)} "
                f"WHERE episode_number = ? AND beat_number = ?",
                values,
            )
            await db.commit()
            return True
        except Exception as e:
            console.print(f"[red]更新 Beat 资源字段失败: {e}[/red]")
            return False

    async def add_visual_beats(self, beats: List[NovelVisualBeat]) -> None:
        """添加视觉节拍到 SQLite。"""
        db = await self._ensure_db()
        for b in beats:
            await db.execute(
                """INSERT INTO beats (episode_number, beat_number, narration, visual_description,
                   detected_identities_json, detected_props_json, scene_ref_json,
                   audio_type, speaker, speaker_kind, time_of_day,
                   video_mode, video_prompt, keyframe_prompt,
                   shot_order, duration_seconds, is_manual_shot)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT(episode_number, beat_number) DO UPDATE SET
                   narration=excluded.narration, visual_description=excluded.visual_description,
                   detected_identities_json=excluded.detected_identities_json,
                   detected_props_json=excluded.detected_props_json,
                   scene_ref_json=excluded.scene_ref_json,
                   audio_type=excluded.audio_type, speaker=excluded.speaker,
                   speaker_kind=excluded.speaker_kind,
                   time_of_day=excluded.time_of_day,
                   video_mode=excluded.video_mode,
                   video_prompt=excluded.video_prompt,
                   keyframe_prompt=excluded.keyframe_prompt,
                   shot_order=excluded.shot_order,
                   duration_seconds=excluded.duration_seconds,
                   is_manual_shot=excluded.is_manual_shot,
                   updated_at=datetime('now')""",
                (
                    b.episode_number,
                    b.beat_number,
                    b.narration,
                    b.visual_description,
                    b.detected_identities_json,
                    getattr(b, "detected_props_json", "[]") or "[]",
                    getattr(b, "scene_ref_json", "") or "",
                    b.audio_type,
                    b.speaker,
                    getattr(b, "speaker_kind", "character"),
                    getattr(b, "time_of_day", ""),
                    getattr(b, "video_mode", "first_frame"),
                    getattr(b, "video_prompt", ""),
                    getattr(b, "keyframe_prompt", ""),
                    getattr(b, "shot_order", None),
                    getattr(b, "duration_seconds", None),
                    1 if getattr(b, "is_manual_shot", False) else 0,
                ),
            )
        await db.commit()

    async def delete_manual_beat(self, episode_number: int, beat_number: int) -> bool:
        """删除单个手工分镜 beat（仅当 is_manual_shot=1）。"""
        try:
            db = await self._ensure_db()
            cursor = await db.execute(
                "DELETE FROM beats WHERE episode_number = ? AND beat_number = ? AND is_manual_shot = 1",
                (episode_number, beat_number),
            )
            await db.commit()
            return cursor.rowcount > 0
        except Exception as e:
            console.print(f"[red]删除手工分镜失败: {e}[/red]")
            return False

    async def get_beat_prompts(
        self,
        episode_number: int,
        beat_number: int | None = None,
    ) -> Dict[str, Optional[str]]:
        """Return persisted video prompt fields for one beat."""
        try:
            db = await self._ensure_db()
            async with db.execute(
                "SELECT video_prompt, video_mode, keyframe_prompt "
                "FROM beats WHERE episode_number = ? AND beat_number = ?",
                (episode_number, beat_number),
            ) as cursor:
                row = await cursor.fetchone()
                if row:
                    return {
                        "video_prompt": row["video_prompt"],
                        "video_mode": row["video_mode"] or "first_frame",
                        "keyframe_prompt": row["keyframe_prompt"],
                    }
            return {
                "video_prompt": None,
                "video_mode": "first_frame",
                "keyframe_prompt": None,
            }
        except StoreClosedError:
            raise
        except Exception as e:
            console.print(f"[red]获取 Beat 提示词失败: {e}[/red]")
            return {
                "video_prompt": None,
                "video_mode": "first_frame",
                "keyframe_prompt": None,
            }

    async def delete_project_data(self) -> None:
        """删除当前项目的所有 SQLite 项目事实。"""
        try:
            db = await self._ensure_db()
            await db.execute("DELETE FROM beats")
            await db.execute("DELETE FROM episodes")
            await db.execute("DELETE FROM characters")
            await db.execute("DELETE FROM scenes")
            await db.execute("DELETE FROM props")
            await db.commit()
            self._characters.clear()
            self._episodes.clear()
            self._props.clear()
            self._alias_index.clear()
        except Exception:
            self._characters.clear()
            self._episodes.clear()
            self._props.clear()
            self._alias_index.clear()
            raise

    async def set_beat_detected_identities(
        self,
        episode_number: int,
        detections: dict[int, list[str]],
    ) -> int:
        """批量写入 per-beat 检测身份。"""
        if not detections:
            return 0
        db = await self._ensure_db()
        count = 0
        for beat_number, ids in detections.items():
            cursor = await db.execute(
                "UPDATE beats SET detected_identities_json = ?, updated_at = datetime('now') "
                "WHERE episode_number = ? AND beat_number = ?",
                (
                    json.dumps(normalize_detected_identities(ids), ensure_ascii=False),
                    episode_number,
                    beat_number,
                ),
            )
            count += cursor.rowcount or 0
        await db.commit()
        return count

    async def set_beat_detected_props(
        self,
        episode_number: int,
        detections: dict[int, list[str]],
    ) -> int:
        """批量写入 per-beat 检测道具。"""
        if not detections:
            return 0
        db = await self._ensure_db()
        count = 0
        for beat_number, ids in detections.items():
            cursor = await db.execute(
                "UPDATE beats SET detected_props_json = ?, updated_at = datetime('now') "
                "WHERE episode_number = ? AND beat_number = ?",
                (
                    json.dumps(normalize_detected_props(ids), ensure_ascii=False),
                    episode_number,
                    beat_number,
                ),
            )
            count += cursor.rowcount or 0
        await db.commit()
        return count

    async def delete_beats_for_episode(self, episode_number: int) -> int:
        """删除指定剧集的所有 beat。"""
        db = await self._ensure_db()
        cursor = await db.execute(
            "DELETE FROM beats WHERE episode_number = ?",
            (episode_number,),
        )
        await db.commit()
        return cursor.rowcount or 0

    async def delete_beats_except(self, episode_number: int, keep_numbers: set[int]) -> int:
        """删除指定剧集中不在 keep_numbers 里的 beat。"""
        keep_numbers = {int(num) for num in keep_numbers if int(num) > 0}
        if not keep_numbers:
            return await self.delete_beats_for_episode(episode_number)
        db = await self._ensure_db()
        placeholders = ",".join("?" for _ in keep_numbers)
        cursor = await db.execute(
            f"DELETE FROM beats WHERE episode_number = ? AND beat_number NOT IN ({placeholders})",
            [episode_number, *sorted(keep_numbers)],
        )
        await db.commit()
        return cursor.rowcount or 0

    async def patch_beats_missing_fields(
        self,
        episode_number: int,
        beats_data: list[dict],
    ) -> int:
        """只补写从旧 JSON 同步来的静态字段。"""
        updated_count = 0
        db = await self._ensure_db()
        for beat in beats_data:
            beat_number = int(beat.get("beat_number", 0) or 0)
            scene_ref = beat.get("scene_ref")
            if beat_number <= 0 or scene_ref is None:
                continue
            cursor = await db.execute(
                "UPDATE beats SET scene_ref_json = ?, updated_at = datetime('now') "
                "WHERE episode_number = ? AND beat_number = ?",
                (
                    json.dumps(scene_ref, ensure_ascii=False) if scene_ref else "",
                    episode_number,
                    beat_number,
                ),
            )
            updated_count += cursor.rowcount or 0
        await db.commit()
        return updated_count

    async def delete_all_scenes(self) -> int:
        """删除所有场景。"""
        db = await self._ensure_db()
        cursor = await db.execute("DELETE FROM scenes")
        await db.commit()
        return cursor.rowcount or 0

    # ============================================================
    # structured_v1 分析 run / chunk / 证据
    # ============================================================

    async def get_reusable_analysis_run(
        self,
        *,
        source_sha256: str,
        schema_version: int,
        pipeline_version: str,
        spine_template: str = "",
    ) -> dict | None:
        """Find a run that analysed identical text the same way.

        Reuse is keyed on all four. Different source text or a changed
        extraction contract must not inherit another run's chunk results, and
        neither must a different spine template: the same novel chunked as a
        screenplay and as narrated prose produces entirely different chunks.
        """
        db = await self._ensure_db()
        async with db.execute(
            """SELECT * FROM story_analysis_runs
               WHERE source_sha256 = ? AND schema_version = ?
                 AND pipeline_version = ? AND spine_template = ?
               ORDER BY created_at DESC LIMIT 1""",
            (source_sha256, int(schema_version), pipeline_version, spine_template),
        ) as cursor:
            row = await cursor.fetchone()
        return dict(row) if row else None

    async def start_analysis_run(
        self,
        *,
        run_id: str,
        pipeline_version: str,
        schema_version: int,
        spine_template: str,
        source_sha256: str,
        source_length: int,
        chunks: list,
    ) -> None:
        """Record a run and its chunk plan in one transaction.

        A half-written plan would let a resume believe chunks are missing rather
        than pending, so the run row and every chunk land together.
        """
        db = await self._ensure_db()
        try:
            await db.execute("BEGIN")
            await db.execute(
                """INSERT OR REPLACE INTO story_analysis_runs
                   (run_id, pipeline_version, schema_version, spine_template,
                    source_sha256, source_length, status, error, completed_at)
                   VALUES (?, ?, ?, ?, ?, ?, 'pending', '', '')""",
                (
                    run_id,
                    pipeline_version,
                    int(schema_version),
                    spine_template,
                    source_sha256,
                    int(source_length),
                ),
            )
            await db.execute(
                "DELETE FROM story_analysis_chunks WHERE run_id = ?", (run_id,)
            )
            await db.executemany(
                """INSERT INTO story_analysis_chunks
                   (run_id, chunk_id, chunk_index, section_type, section_label,
                    source_start, source_end, source_hash, status)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')""",
                [
                    (
                        run_id,
                        chunk.chunk_id,
                        int(chunk.chunk_index),
                        chunk.section_type,
                        chunk.section_label,
                        int(chunk.source_start),
                        int(chunk.source_end),
                        chunk.source_hash,
                    )
                    for chunk in chunks
                ],
            )
            await db.commit()
        except Exception:
            await db.rollback()
            raise

    async def list_analysis_chunks(
        self, run_id: str, *, status: str | None = None
    ) -> list[dict]:
        db = await self._ensure_db()
        sql = "SELECT * FROM story_analysis_chunks WHERE run_id = ?"
        params: list = [run_id]
        if status:
            sql += " AND status = ?"
            params.append(status)
        sql += " ORDER BY chunk_index"
        async with db.execute(sql, params) as cursor:
            rows = await cursor.fetchall()
        return [dict(row) for row in rows]

    async def mark_analysis_chunk_done(
        self, run_id: str, chunk_id: str, result_json: str
    ) -> None:
        db = await self._ensure_db()
        await db.execute(
            """UPDATE story_analysis_chunks
               SET status = 'done', error = '', result_json = ?,
                   attempts = attempts + 1
               WHERE run_id = ? AND chunk_id = ?""",
            (result_json, run_id, chunk_id),
        )
        await db.commit()

    async def mark_analysis_chunk_failed(
        self, run_id: str, chunk_id: str, error: str
    ) -> None:
        db = await self._ensure_db()
        await db.execute(
            """UPDATE story_analysis_chunks
               SET status = 'failed', error = ?, attempts = attempts + 1
               WHERE run_id = ? AND chunk_id = ?""",
            (str(error)[:2000], run_id, chunk_id),
        )
        await db.commit()

    async def finish_analysis_run(
        self, run_id: str, *, status: str, error: str = ""
    ) -> None:
        db = await self._ensure_db()
        await db.execute(
            """UPDATE story_analysis_runs
               SET status = ?, error = ?, completed_at = datetime('now')
               WHERE run_id = ?""",
            (status, str(error)[:2000], run_id),
        )
        await db.commit()

    async def get_analysis_artifact(self, run_id: str, artifact_type: str) -> str:
        """Return a stored final result for a run, or an empty string."""
        db = await self._ensure_db()
        async with db.execute(
            """SELECT result_json FROM story_analysis_artifacts
               WHERE run_id = ? AND artifact_type = ?""",
            (run_id, artifact_type),
        ) as cursor:
            row = await cursor.fetchone()
        return str(row["result_json"]) if row else ""

    async def save_analysis_artifact(
        self, run_id: str, artifact_type: str, result_json: str
    ) -> None:
        """Store a run's final result so a rebuild need not recompute it.

        Chunk results alone are not enough to skip all work: merging is cheap
        but adjudication is another model call, and re-running it can decide
        differently, so an unchanged source could yield a different cast on
        every rebuild.
        """
        db = await self._ensure_db()
        await db.execute(
            """INSERT INTO story_analysis_artifacts
               (run_id, artifact_type, result_json, created_at)
               VALUES (?, ?, ?, datetime('now'))
               ON CONFLICT(run_id, artifact_type) DO UPDATE SET
                 result_json = excluded.result_json,
                 created_at = excluded.created_at""",
            (run_id, artifact_type, result_json),
        )
        await db.commit()

    async def get_analysis_item_cache(
        self, artifact_type: str, cache_keys: list[str]
    ) -> dict[str, str]:
        """Return stored per-item results for the keys that have one.

        Bulk, because a scene build asks about every candidate at once and one
        round trip per scene would cost more than it saves.
        """
        keys = [str(key) for key in cache_keys if key]
        if not keys:
            return {}
        db = await self._ensure_db()
        found: dict[str, str] = {}
        # SQLite caps host parameters per statement; chunk rather than risk it.
        for start in range(0, len(keys), 400):
            window = keys[start : start + 400]
            placeholders = ",".join("?" for _ in window)
            async with db.execute(
                f"""SELECT cache_key, result_json FROM story_analysis_item_cache
                    WHERE artifact_type = ? AND cache_key IN ({placeholders})""",
                (artifact_type, *window),
            ) as cursor:
                rows = await cursor.fetchall()
            for row in rows:
                found[str(row["cache_key"])] = str(row["result_json"])
        return found

    async def save_analysis_item_cache(
        self, artifact_type: str, results: dict[str, str]
    ) -> None:
        """Store per-item results keyed by a hash of the input that produced them.

        The key already carries every input and a contract version, so a hit is
        only ever a result for identical input under the current contract; there
        is nothing to invalidate and no run to scope it to.
        """
        rows = [(key, artifact_type, value) for key, value in results.items() if key]
        if not rows:
            return
        db = await self._ensure_db()
        await db.executemany(
            """INSERT INTO story_analysis_item_cache
               (cache_key, artifact_type, result_json, created_at)
               VALUES (?, ?, ?, datetime('now'))
               ON CONFLICT(cache_key) DO UPDATE SET
                 result_json = excluded.result_json,
                 created_at = excluded.created_at""",
            rows,
        )
        await db.commit()

    async def replace_entity_evidence(
        self, run_id: str, entity_type: str, entity_id: str, evidence: list[dict]
    ) -> None:
        """Rewrite one entity's evidence for a run.

        Replacing rather than appending keeps a re-run of the same chunk from
        accumulating duplicate spans for the same entity.
        """
        db = await self._ensure_db()
        try:
            await db.execute("BEGIN")
            await db.execute(
                """DELETE FROM entity_evidence
                   WHERE run_id = ? AND entity_type = ? AND entity_id = ?""",
                (run_id, entity_type, entity_id),
            )
            await db.executemany(
                """INSERT OR REPLACE INTO entity_evidence
                   (run_id, entity_type, entity_id, chunk_id, source_start,
                    source_end, evidence_kind, evidence_text)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                [
                    (
                        run_id,
                        entity_type,
                        entity_id,
                        str(item.get("chunk_id", "")),
                        int(item.get("source_start", 0)),
                        int(item.get("source_end", 0)),
                        str(item.get("evidence_kind", "")),
                        str(item.get("evidence_text", "")),
                    )
                    for item in evidence
                ],
            )
            await db.commit()
        except Exception:
            await db.rollback()
            raise

    async def list_entity_evidence(
        self, entity_type: str, entity_id: str
    ) -> list[dict]:
        db = await self._ensure_db()
        async with db.execute(
            """SELECT * FROM entity_evidence
               WHERE entity_type = ? AND entity_id = ?
               ORDER BY chunk_id, source_start""",
            (entity_type, entity_id),
        ) as cursor:
            rows = await cursor.fetchall()
        return [dict(row) for row in rows]

    async def delete_all_props(self) -> int:
        """删除所有道具。"""
        db = await self._ensure_db()
        cursor = await db.execute("DELETE FROM props")
        await db.commit()
        self._props.clear()
        return cursor.rowcount or 0

    @property
    def character_count(self) -> int:
        return len(self._characters)

    @property
    def episode_count(self) -> int:
        return len(self._episodes)

    @property
    def prop_count(self) -> int:
        return len(self._props)
