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
import sqlite3
from pathlib import Path
from typing import Any, Dict, List, Optional

import aiosqlite
from rich.console import Console

from novelvideo.sqlite_pragmas import configure_sqlite_connection_async
from novelvideo.models import (
    CharacterIdentity,
    NovelCharacter,
    NovelEpisode,
    NovelProp,
    NovelScene,
    NovelVisualBeat,
    normalize_detected_identities,
    normalize_detected_props,
    sync_beat_asset_refs,
)
from novelvideo.utils.path_resolver import compute_identity_path

console = Console()
logger = logging.getLogger(__name__)


class StoreClosedError(RuntimeError):
    """Raised when a SQLiteStore is used after its lifecycle has ended."""

    def __init__(self, project_dir: str):
        super().__init__(f"SQLiteStore is closed: {project_dir}")
        self.project_dir = project_dir


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
"""


async def _table_columns(db: aiosqlite.Connection, table: str) -> set[str]:
    async with db.execute(f"PRAGMA table_info({table})") as cursor:
        rows = await cursor.fetchall()
    return {str(row["name"]) for row in rows}


async def _add_column_if_missing(
    db: aiosqlite.Connection,
    table: str,
    name: str,
    definition: str,
) -> None:
    """Add a column while tolerating concurrent runtime schema bootstrap.

    SQLite has no portable ``ADD COLUMN IF NOT EXISTS``. Multiple API/worker
    processes can initialize the same project DB at once, so a column may be
    added after our ``PRAGMA table_info`` read but before ``ALTER TABLE``.
    """
    if name in await _table_columns(db, table):
        return

    try:
        await db.execute(f"ALTER TABLE {table} ADD COLUMN {name} {definition}")
    except sqlite3.OperationalError as exc:
        if "duplicate column name" not in str(exc).lower():
            raise
        if name not in await _table_columns(db, table):
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
        if len(parts) == 2:
            from novelvideo.utils.project_paths import ProjectPaths

            paths = ProjectPaths(parts[0], parts[1])
            paths.bootstrap_from_legacy_output()
            default_state_dir = paths.state_dir
        else:
            default_state_dir = Path(self.project_dir)

        if state_dir:
            resolved_state_dir = Path(state_dir)
        else:
            resolved_state_dir = default_state_dir

        resolved_state_dir.mkdir(parents=True, exist_ok=True)
        self.state_dir = str(resolved_state_dir)
        self.db_path = str(resolved_state_dir / "data.db")

    async def _ensure_db(self) -> aiosqlite.Connection:
        if self._closed or (self._closing and self._current_task_lease_depth() <= 0):
            raise StoreClosedError(self.project_dir)
        if self._db is None:
            if self._closing:
                raise StoreClosedError(self.project_dir)
            self._db = await aiosqlite.connect(self.db_path)
            self._db.row_factory = aiosqlite.Row
            await configure_sqlite_connection_async(self._db)
            await self._db.executescript(SQLITE_SCHEMA_SQL)
            await self._ensure_episode_planning_columns(self._db)
            await self._ensure_beat_current_columns(self._db)
            await self._ensure_scene_columns(self._db)
            await self._ensure_indextts2_columns(self._db)
            await self._db.commit()
            # Phase 2 DB split: failure-mode *definitions* live in the
            # user-shared verification.db (not this project DB). They are
            # seeded lazily by `failure_registry.load_negative_clause_for_project`
            # / `open_defs_db_for_project` the first time any caller needs
            # them. This project DB holds only per-project hits +
            # convergence facts — the schema above already creates
            # `sketch_failure_mode_hits`, which stays project-local.
        return self._db

    async def _ensure_scene_columns(self, db: aiosqlite.Connection) -> None:
        await _add_column_if_missing(
            db,
            "scenes",
            "spatial_layout_image",
            "TEXT DEFAULT ''",
        )
        for name in ("base_scene_id", "variant_id", "time_of_day", "variant_prompt"):
            await _add_column_if_missing(db, "scenes", name, "TEXT DEFAULT ''")

    async def _ensure_indextts2_columns(self, db: aiosqlite.Connection) -> None:
        """Add IndexTTS2 / Seedance 2.0 voice columns introduced in Stage A."""
        await _add_column_if_missing(
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
            await _add_column_if_missing(db, "characters", name, definition)

    async def _ensure_episode_planning_columns(self, db: aiosqlite.Connection) -> None:
        """Add episode columns introduced after early project databases were created."""
        columns = {
            "beat_source_text": "TEXT DEFAULT ''",
            "adapted_content": "TEXT DEFAULT ''",
            "scene_menu_json": "TEXT DEFAULT '[]'",
            "prop_menu_json": "TEXT DEFAULT '[]'",
            "identity_default_map_json": "TEXT DEFAULT '{}'",
        }
        for name, definition in columns.items():
            await _add_column_if_missing(db, "episodes", name, definition)

    async def _ensure_beat_current_columns(self, db: aiosqlite.Connection) -> None:
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
            await _add_column_if_missing(db, "beats", name, definition)

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
        novel_path = Path(self.project_dir) / "novel.txt"
        if novel_path.exists():
            return novel_path.read_text(encoding="utf-8")
        return None

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
        old_dir = Path(self.project_dir) / "assets" / "characters" / old_name
        new_dir = Path(self.project_dir) / "assets" / "characters" / new_name
        if old_dir.exists() and not new_dir.exists():
            old_dir.replace(new_dir)
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

    async def rename_scene(self, old_name: str, new_name: str) -> bool:
        """重命名场景记录。资源目录迁移由调用方处理。"""
        old_name = str(old_name or "").strip()
        new_name = str(new_name or "").strip()
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

    async def rename_prop(self, old_name: str, new_name: str) -> bool:
        """重命名道具记录。资源目录迁移由调用方处理。"""
        old_name = str(old_name or "").strip()
        new_name = str(new_name or "").strip()
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
                await self.update_episode(ep.number, identity_ids=ids)

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

    async def add_episodes(self, episodes: List[NovelEpisode]) -> None:
        db = await self._ensure_db()
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
        await db.commit()

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
