"""AI chat service with project-scoped history and user-level agent sessions."""

from __future__ import annotations

import asyncio
import copy
import hashlib
import importlib.util
import json
import logging
import os
import re
import shutil
import sqlite3
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import quote, unquote, urlparse
from urllib.request import Request, urlopen

from novelvideo.chat.backend_sdk import (
    ClaudeSdkClient,
    CodexClient,
    _codex_item_completed_trace,
    _codex_item_started_trace,
    _codex_unwrap_item,
    interrupt_live_claude_client,
    interrupt_live_codex_turn,
)
from novelvideo.ports import get_auth_session_port
from novelvideo.sqlite_pragmas import configure_sqlite_connection
from novelvideo.utils.error_redaction import redact_secrets
from novelvideo.utils.static_urls import project_static_url

logger = logging.getLogger("novelvideo.chat.service")

_MEDIA_EXTENSIONS = {
    ".png": "image",
    ".jpg": "image",
    ".jpeg": "image",
    ".webp": "image",
    ".gif": "image",
    ".mp4": "video",
    ".mov": "video",
    ".webm": "video",
    ".wav": "audio",
    ".mp3": "audio",
    ".m4a": "audio",
}
_URL_RE = re.compile(r"(https?://[^\s)>\"]+|/static/[^\s)>\"]+)")
_REL_PATH_RE = re.compile(
    r"(?P<path>(?:assets|videos|audio|images|frames|sketches|grids|uploads|scripts)/[^\s)>\"]+\.(?:png|jpg|jpeg|webp|gif|mp4|mov|webm|wav|mp3|m4a))"
)
_MARKDOWN_IMAGE_RE = re.compile(r"!\[[^\]]*\]\(([^)]+)\)")
_USER_TURN_LABEL_RE = re.compile(r"(?im)^\s*(?:user|human|用户|我)\s*[:：]\s*")
_ASSISTANT_TURN_LABEL_RE = re.compile(r"(?i)^\s*(?:assistant|ai|助手|助理|模型)\s*[:：]\s*")
_UI_SPEC_BLOCK_RE = re.compile(r"<ui-spec\b[^>]*>(.*?)</ui-spec>", re.IGNORECASE | re.DOTALL)
_UI_SPEC_FENCE_RE = re.compile(
    r"```(?:json-render|ui-spec|json)?\s*(<ui-spec\b[\s\S]*?</ui-spec>)\s*```",
    re.IGNORECASE,
)
_LOCAL_FILESYSTEM_PATH_RE = re.compile(
    r"(?<![\w./-])(?:~|/Users/[^\s`'\"<>)]+)(?:/[^\s`'\"<>)]+)+"
)
_CHAT_RUN_LOCK_KEY = "active_chat_run"
_CHAT_RUN_LOCK_TTL_SECONDS = 10 * 60
_CHAT_RUN_LOCK_MAX_SECONDS = 60 * 60
_CHAT_RUN_LOCK_HEARTBEAT_SECONDS = 30.0
_CHAT_RUN_LOCK_BIRTH_GRACE_SECONDS = 5.0
_REINGEST_CONFIRMATION_BLOCK_RE = re.compile(
    r"\[DRAMACLAW_REINGEST_CONFIRMATION\](.*?)\[/DRAMACLAW_REINGEST_CONFIRMATION\]",
    re.DOTALL,
)
_REINGEST_CANCELLED_BLOCK_RE = re.compile(
    r"\[DRAMACLAW_REINGEST_CANCELLED\](.*?)\[/DRAMACLAW_REINGEST_CANCELLED\]",
    re.DOTALL,
)
_CHAT_ATTACHMENTS_BLOCK_RE = re.compile(
    r"\[CHAT_ATTACHMENTS\].*?\[/CHAT_ATTACHMENTS\]",
    re.DOTALL,
)
_DRAMACLAW_INGEST_AUTOMATION_RE = re.compile(
    r"\[DRAMACLAW_(?:INGEST_AUTOMATION|REINGEST_CONFIRMATION|UPLOADED_FILES)\]",
)
_SCRIPT_CREATION_REQUEST_RE = re.compile(
    r"(?:帮我|给我|请|想要|我要|创建|生成|写|做|制作|创作|起草|来一个|出一个)"
    r"[\s\S]{0,40}(?:剧本|短剧|短片剧本|短视频剧本|网剧)",
    re.IGNORECASE,
)
_STYLE_SHORT_DRAMA_REQUEST_RE = re.compile(
    r"(?:[\w\u4e00-\u9fff]+风格|主题|题材|赛博朋克|末世|复仇|女总裁|玄幻|都市|悬疑)"
    r"[\s\S]{0,30}(?:短剧|短片剧本|短视频剧本|网剧)",
    re.IGNORECASE,
)
_CONTINUE_PIPELINE_RE = re.compile(r"(?:继续|恢复|接着|下一步|当前|已有|已上传|刚才上传)")
_DRAMACLAW_SCRIPT_UPLOAD_MODEL_REPLY_INSTRUCTIONS = """[DRAMACLAW_SCRIPT_UPLOAD_GUIDANCE]
用户正在请求创建、生成或编写剧本/短剧，但当前消息没有上传剧本文档。

你必须只用自然中文回复用户，不要调用任何工具，不要创建项目，不要生成剧本，不要构造基础脚本，不要启动摄入或流水线。

回复目标：
- 语气自然，不要像系统错误提示。
- 明确表达：虾导不提供生成剧本功能。
- 引导用户去“虾料”上传已有剧本文档。
- 说明上传后你可以继续帮他推进分集、画面、配音、成片等后续制作。
- 只回复 1-2 句，不要列步骤，不要输出 markdown 标题。
[/DRAMACLAW_SCRIPT_UPLOAD_GUIDANCE]
"""
_HIDDEN_TOOL_MARKERS = (
    "skill_view",
    "skills_list",
    "skill view",
    "skills list",
    "loading skill",
    "→ skill view",
    "→ skills list",
)
_JSON_RENDER_CHAT_INSTRUCTIONS = """[RENDERING_CONTRACT]
这是硬性输出合同，优先级高于普通叙述习惯。违反时必须自我修正后再回复。

触发条件：
- 只有在回复需要展示图片、肖像、身份图、草图、首帧、视频、音频等可视/可播放媒体时，才需要调用对应的 DramaClaw 展示工具。
- 角色列表、剧集规划、项目进度、任务状态、脚本/beat 摘要、表格、长篇正文、普通结构化说明默认使用 markdown；如果没有图片/视频/音频媒体，不要使用媒体展示工具。

禁止事项：
- 不要向用户解释内部渲染格式、渲染机制、工具调用过程或工具名；只给业务结果和必要的下一步提示。
- 不要为纯文本、进度、脚本、表格、角色/剧集清单调用媒体展示工具；这些内容使用 markdown。
- 用户要求查看图片、肖像、身份图、草图、首帧、视频、音频时，不要用文字列表、文件名列表、Beat 名称列表或 URL 列表替代媒体展示；必须调用对应展示工具。若没有工具返回的可展示媒体，只说明当前暂无可展示媒体。
- 一旦本轮调用了媒体展示工具，最终自然语言回复只能是简短说明，绝对禁止输出 markdown 图片语法（例如 ![标题](url)）、纯文本媒体 URL、任何 http/https 链接、/static 路径、HTML <img>/<video>/<audio> 标签或聊天附件 media_json。
- 不要猜测、拼接或改写静态资源路径，尤其禁止自行编造 /static/projects/{project_id}/...、/static/admin/{slug}/...、localhost URL 或下载地址。

资源 URL 规则：
- 展示工具会读取 API 返回的可访问 URL 字段（portrait_url、image_url、sketch_url、frame_url、video_url、audio_url、url）并准备可展示媒体。
- 如果工具/API 只返回本地文件路径或你不确定 URL 是否可访问，必须先调用相应 DramaClaw 展示工具；不能自己按经验拼 /static 路径。
- 如果没有正式结果 URL、URL 为空、或资源尚未生成，只说明当前状态，不要伪造媒体展示。
- 如果工具/API 返回多个候选字段，优先使用明确的 *_url 字段；不要使用 *_path 作为 src，除非 API 明确说明该 path 已是浏览器可访问 URL。

展示工具选择：
- 角色肖像/身份图：调用 dramaclaw_get_character_media。
- 当前草图：调用 dramaclaw_get_sketches，只展示正式 sketch_url。草图候选池：调用 dramaclaw_get_sketch_candidates，只展示 grids/epNNN/sketch/beat_XX_t* 候选。首帧：调用 dramaclaw_get_first_frames，只展示首帧。
- 场景图：调用 dramaclaw_get_scene_images。
- 视频预览、beat 视频、最终成片：调用 dramaclaw_get_episode_media(media_type="video") 或对应最终视频读取工具。
- 配音/TTS/音乐：调用 dramaclaw_get_episode_media(media_type="audio") 或对应音频读取工具。
- 指定人物肖像：调用 dramaclaw_get_character_media(media_kind="portrait", name="角色名或名称片段")；name 只匹配角色名/别名，不要混入身份图。
- 指定身份图：调用 dramaclaw_get_character_media(media_kind="identity", name="角色名或身份名片段")；不要混入角色肖像。name 匹配角色名/别名/身份名/身份 ID；只有用户明确按描述内容查找时才用 query="..."。
- 指定当前草图：调用 dramaclaw_get_sketches(episode=N, beat=M)；该工具只展示正式 sketch_url/current sketch，不展示 grids/epNNN/sketch/beat_XX_t* 草图池候选。不要用草图池或首帧替代当前草图。指定草图候选/图池/备选草图：调用 dramaclaw_get_sketch_candidates(episode=N, beat=M)。指定首帧：调用 dramaclaw_get_first_frames(episode=N, beat=M)。多个正式草图用 beat_indices=[...]；分页用 offset + limit。
- 指定场景图：调用 dramaclaw_get_scene_images(name="场景名或名称片段")；名称按包含关系模糊匹配；多个关键词用 names=[...]；按第几个场景用 index=N 或 scene_indices=[...]；按类型筛选用 scene_type="..."；分页用 offset + limit。
- 指定视频：调用 dramaclaw_get_episode_media(episode=N, media_type="video", beat=M)；按内容片段查视频用 query="..."，匹配 beat 标题、画面描述、解说/对白、说话人、角色、场景；多个 beat 用 beat_indices=[...]；分页用 offset + limit。
- 指定音频/配音/TTS：调用 dramaclaw_get_episode_media(episode=N, media_type="audio", beat=M)；按内容片段查音频用 query="..."，匹配 beat 标题、解说/对白、说话人、角色、场景；多个 beat 用 beat_indices=[...]；分页用 offset + limit。

发送前自检：
1. 本回复是否展示图片/视频/音频媒体？如果是，是否调用了对应展示工具？
2. 是否避免暴露内部渲染格式、渲染机制、工具调用过程或工具名？
3. 如果不展示图片/视频/音频，是否使用 markdown？
4. 如果任一答案是否，先修正再回复。
[/RENDERING_CONTRACT]"""


def _media_path_from_static_url(url: str) -> str | None:
    parsed = urlparse(url)
    path = parsed.path if parsed.scheme in {"http", "https"} else url.split("?", 1)[0]
    if not path.startswith("/static/"):
        return None
    rel = path[len("/static/") :]
    parts = rel.split("/", 2)
    if len(parts) == 3:
        return unquote(parts[2])
    return unquote(rel)


def _canonical_project_static_media_url(
    project_id: str,
    project_dir: Path,
    url_or_path: str,
) -> tuple[str, str] | None:
    media_path = _media_path_from_static_url(url_or_path)
    if media_path is None:
        media_path = url_or_path.strip().split("?", 1)[0].lstrip("./")
    if not media_path:
        return None
    local_path = project_dir / media_path
    return project_static_url(project_id, media_path, local_path=local_path), media_path


def _media_project_dir(
    username: str,
    project: str,
    project_dir: str | Path | None = None,
) -> Path:
    return Path(project_dir) if project_dir is not None else _project_dir(username, project)


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[3]


def _output_root() -> Path:
    configured = os.environ.get("NOVELVIDEO_OUTPUT_DIR", "").strip()
    if configured:
        return Path(configured).expanduser()
    return _repo_root() / "output"


def _state_root() -> Path:
    configured = os.environ.get("NOVELVIDEO_STATE_DIR", "").strip()
    if configured:
        return Path(configured).expanduser()
    return _repo_root() / "state"


def _json_render_error_log_path() -> Path:
    configured = os.environ.get("JR_ERROR_LOG", "").strip()
    if configured:
        return Path(configured).expanduser()
    return _repo_root() / "jr_error.log"


def _user_preferences_path(username: str) -> Path:
    return _state_root() / username / "preferences.md"


def load_user_preferences(username: str) -> str:
    """Load/create the user-level long-term preference file.

    This is the Lovart-style long-term memory layer: project chat history stays
    project-scoped, while stable taste/workflow preferences live per user.
    """

    path = _user_preferences_path(username)
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.exists():
        path.write_text(
            "# User Preferences\n\n"
            "Record stable cross-project preferences here, such as visual taste, "
            "brand/style defaults, pacing habits, and recurring workflow choices.\n",
            encoding="utf-8",
        )
    return path.read_text(encoding="utf-8").strip()


def _prompt_with_user_context(username: str, project: str, prompt: str) -> str:
    preferences = load_user_preferences(username)
    scope = f"project:{project}" if project else "home"
    return (
        "[DRAMACLAW_USER_CONTEXT]\n"
        f"username: {username}\n"
        f"scope: {scope}\n"
        "Project-scoped facts must stay in the project scope. "
        "Only stable user preferences should be reused across projects.\n\n"
        "[USER_PREFERENCES]\n"
        f"{preferences}\n\n"
        f"{_JSON_RENDER_CHAT_INSTRUCTIONS}\n\n"
        "[USER_MESSAGE]\n"
        f"{prompt}"
    )


def _chat_backend() -> str:
    preferred = (
        os.environ.get("DRAMACLAW_CHAT_BACKEND")
        or os.environ.get("SUPERTALE_CHAT_BACKEND")
        or "hermes"
    ).strip().lower() or "hermes"
    if preferred == "hermes":
        # Explicit "hermes" must succeed — do NOT silently fall back to
        # claude/codex. A missing hermes binary is a config error to surface.
        if is_hermes_backend_available():
            return "hermes"
        raise RuntimeError(
            "DRAMACLAW_CHAT_BACKEND=hermes requested but hermes is unavailable. "
            "Run `uv tool install 'hermes-agent[acp]'`, "
            "then run `hermes doctor` to diagnose."
        )
    if preferred == "codex":
        if is_codex_backend_available():
            return "codex"
        raise RuntimeError(
            "DRAMACLAW_CHAT_BACKEND=codex requested but Codex is unavailable. "
            "Install `openai-codex`/Codex Python SDK support in the backend environment "
            "and ensure CODEX_BIN points to a valid codex binary."
        )
    if preferred == "claude":
        if is_claude_backend_available():
            return "claude"
        raise RuntimeError(
            "DRAMACLAW_CHAT_BACKEND=claude requested but Claude is unavailable. "
            "Install claude-agent-sdk and ensure CLAUDE_CLI_PATH points to a valid claude binary."
        )
    if is_codex_backend_available():
        return "codex"
    if is_claude_backend_available():
        return "claude"
    return preferred


def _claude_cli_path() -> Path:
    configured = os.environ.get("CLAUDE_CLI_PATH", "").strip()
    if configured:
        return Path(configured).expanduser()
    resolved = shutil.which("claude")
    if resolved:
        return Path(resolved)
    return Path.home() / ".local" / "bin" / "claude"


def _codex_bin_path() -> Path | None:
    configured = os.environ.get("CODEX_BIN", "").strip()
    if configured:
        return Path(configured).expanduser()
    return None


def _codex_model() -> str:
    return os.environ.get("CODEX_MODEL", "gpt-5.4").strip() or "gpt-5.4"


def _claude_model() -> str | None:
    model = os.environ.get("CLAUDE_MODEL", "").strip()
    return model or None


def _claude_sdk_available() -> bool:
    return importlib.util.find_spec("claude_agent_sdk") is not None


def is_claude_backend_available() -> bool:
    return _claude_cli_path().exists() and _claude_sdk_available()


def is_codex_backend_available() -> bool:
    codex_bin = _codex_bin_path()
    return (codex_bin is None or codex_bin.exists()) and importlib.util.find_spec("openai_codex") is not None


def is_hermes_backend_available() -> bool:
    """Lazy import so chat_service can be loaded without hermes deps."""
    try:
        from novelvideo.chat.hermes_pool import is_hermes_backend_available as _check
    except ImportError:
        return False
    return _check()


def is_chat_backend_available() -> bool:
    # NOTE: _chat_backend() raises when DRAMACLAW_CHAT_BACKEND=hermes is
    # requested but unavailable; catch so this probe stays non-throwing.
    try:
        backend = _chat_backend()
    except RuntimeError:
        return False
    if backend == "claude":
        return is_claude_backend_available()
    if backend == "codex":
        return is_codex_backend_available()
    if backend == "hermes":
        return is_hermes_backend_available()
    return False


def get_chat_backend_name() -> str:
    return _chat_backend()


def _repo_skill_roots() -> list[Path]:
    root = _repo_root()
    return [
        root / ".claude" / "skills",
        root / ".codex" / "skills",
    ]


def _skill_sources() -> list[tuple[str, Path]]:
    sources: dict[str, Path] = {}
    for repo_skills_root in _repo_skill_roots():
        if not repo_skills_root.exists():
            continue
        for child in sorted(repo_skills_root.iterdir()):
            if child.is_dir() and (child / "SKILL.md").exists():
                # Keep the first matching skill name so .claude/skills remains the default
                # source when both locations expose the same skill.
                sources.setdefault(child.name, child)

    configured = (
        os.environ.get("CLAUDE_DRAMACLAW_SKILL_PATH")
        or os.environ.get("CLAUDE_SUPERTALE_SKILL_PATH")
        or ""
    ).strip()
    if configured:
        sources["dramaclaw"] = Path(configured).expanduser()

    return [(name, path) for name, path in sorted(sources.items()) if path.exists()]


def _sync_project_skills(skills_dir: Path) -> None:
    for skill_name, src in _skill_sources():
        dst = skills_dir / skill_name
        if not dst.exists():
            shutil.copytree(src, dst)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _parse_iso_datetime(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value)
    except ValueError:
        return None


def _project_dir(username: str, project: str) -> Path:
    base_dir = _output_root() / username / project
    for path in (
        base_dir,
        base_dir / "graph",
        base_dir / "assets",
        base_dir / "assets" / "characters",
        base_dir / "scripts",
        base_dir / "images",
        base_dir / "audio",
        base_dir / "videos",
        base_dir / "uploads",
    ):
        path.mkdir(parents=True, exist_ok=True)
    return base_dir


def _project_state_dir(username: str, project: str) -> Path:
    base_dir = _state_root() / username / project
    base_dir.mkdir(parents=True, exist_ok=True)
    return base_dir


def _user_state_dir(username: str) -> Path:
    base_dir = _state_root() / username
    base_dir.mkdir(parents=True, exist_ok=True)
    return base_dir


def _user_agent_workspace(username: str) -> Path:
    workspace = _user_state_dir(username) / ".chat_agents"
    workspace.mkdir(parents=True, exist_ok=True)
    return workspace


def _user_chat_agent_locks_dir(username: str) -> Path:
    base_dir = _user_state_dir(username) / "chat_agent_locks"
    base_dir.mkdir(parents=True, exist_ok=True)
    return base_dir


def _legacy_chat_db_path(
    username: str,
    project: str,
    project_dir: str | Path | None = None,
) -> Path:
    base_dir = Path(project_dir) if project_dir is not None else _project_dir(username, project)
    return base_dir / ".chat" / "chat.db"


def _migrate_legacy_chat_db(
    username: str,
    project: str,
    new_db_path: Path,
    project_dir: str | Path | None = None,
    *,
    create_parent: bool = True,
) -> None:
    legacy_db_path = _legacy_chat_db_path(username, project, project_dir)
    if new_db_path.exists() or not legacy_db_path.exists():
        return
    if not create_parent and not new_db_path.parent.exists():
        return

    if create_parent:
        new_db_path.parent.mkdir(parents=True, exist_ok=True)
    for suffix in ("", "-wal", "-shm"):
        src = Path(f"{legacy_db_path}{suffix}")
        if not src.exists():
            continue
        dst = Path(f"{new_db_path}{suffix}")
        if dst.exists():
            continue
        shutil.move(str(src), str(dst))

    legacy_dir = legacy_db_path.parent
    try:
        if legacy_dir.exists() and not any(legacy_dir.iterdir()):
            legacy_dir.rmdir()
    except OSError:
        pass


def _chat_db_path(
    username: str,
    project: str,
    project_dir: str | Path | None = None,
    project_state_dir: str | Path | None = None,
) -> Path:
    if project_state_dir is not None:
        db_path = Path(project_state_dir) / "chat.db"
        _migrate_legacy_chat_db(
            username,
            project,
            db_path,
            project_dir,
            create_parent=True,
        )
        return db_path
    db_path = _project_state_dir(username, project) / "chat.db"
    _migrate_legacy_chat_db(username, project, db_path, project_dir, create_parent=True)
    return db_path


def _chat_input_history_path(username: str, project: str) -> Path:
    return _project_state_dir(username, project) / "chat_input_history.json"


def _connect(db_path: Path) -> sqlite3.Connection:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    configure_sqlite_connection(conn)
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS chat_settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS chat_messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          media_json TEXT NOT NULL DEFAULT '[]',
          created_at TEXT NOT NULL
        )
        """
    )
    conn.commit()
    return conn


def load_chat_input_history(username: str, project: str) -> list[str]:
    if not username or not project:
        return []
    path = _chat_input_history_path(username, project)
    if not path.exists():
        return []
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    if not isinstance(payload, list):
        return []
    history: list[str] = []
    for item in payload:
        text = str(item or "").strip()
        if text:
            history.append(text)
    return history


def save_chat_input_history(
    username: str, project: str, history: list[str], *, limit: int = 200
) -> None:
    if not username or not project:
        return
    cleaned: list[str] = []
    for item in history:
        text = str(item or "").strip()
        if text:
            cleaned.append(text)
    if limit > 0:
        cleaned = cleaned[-limit:]
    path = _chat_input_history_path(username, project)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_suffix(".tmp")
    tmp_path.write_text(
        json.dumps(cleaned, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    tmp_path.replace(path)


def _get_setting(conn: sqlite3.Connection, key: str) -> str | None:
    row = conn.execute("SELECT value FROM chat_settings WHERE key = ?", (key,)).fetchone()
    return str(row["value"]) if row else None


def _set_setting(conn: sqlite3.Connection, key: str, value: str) -> None:
    conn.execute(
        """
        INSERT INTO chat_settings(key, value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updated_at = excluded.updated_at
        """,
        (key, value, _now_iso()),
    )
    conn.commit()


def _pid_is_alive(pid: int | None) -> bool:
    if pid is None or pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def _parse_chat_run_lock(
    value: str | None,
) -> tuple[str | None, int | None, datetime | None, datetime | None]:
    if not value:
        return None, None, None, None
    try:
        payload = json.loads(value)
    except json.JSONDecodeError:
        return value, None, None, None
    if not isinstance(payload, dict):
        return None, None, None, None
    lock_id = payload.get("lock_id")
    owner_pid = payload.get("owner_pid")
    started_at = payload.get("started_at")
    updated_at = payload.get("updated_at") or started_at
    return (
        str(lock_id).strip() or None if lock_id is not None else None,
        int(owner_pid) if isinstance(owner_pid, int) else None,
        _parse_iso_datetime(str(started_at)) if started_at is not None else None,
        _parse_iso_datetime(str(updated_at)) if updated_at is not None else None,
    )


def _chat_run_lock_is_stale(
    started_at: datetime | None,
    updated_at: datetime | None = None,
) -> bool:
    now = datetime.now(timezone.utc)
    if started_at is not None:
        if started_at.tzinfo is None:
            started_at = started_at.replace(tzinfo=timezone.utc)
        if (now - started_at).total_seconds() > _CHAT_RUN_LOCK_MAX_SECONDS:
            return True
    heartbeat_at = updated_at or started_at
    if heartbeat_at is None:
        return False
    if heartbeat_at.tzinfo is None:
        heartbeat_at = heartbeat_at.replace(tzinfo=timezone.utc)
    return (now - heartbeat_at).total_seconds() > _CHAT_RUN_LOCK_TTL_SECONDS


def _chat_run_lock_key(project: str) -> str:
    return _CHAT_RUN_LOCK_KEY


def _chat_run_lock_path(username: str, project: str) -> Path:
    lock_key = _chat_run_lock_key(project)
    digest = hashlib.sha256(lock_key.encode("utf-8")).hexdigest()
    return _user_chat_agent_locks_dir(username) / f"{digest}.lock"


def _read_chat_run_lock_file(
    path: Path,
) -> tuple[str | None, int | None, datetime | None, datetime | None]:
    try:
        value = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return None, None, None, None
    except OSError:
        return None, None, None, None
    return _parse_chat_run_lock(value)


def _remove_chat_run_lock_file(path: Path) -> None:
    try:
        path.unlink()
    except FileNotFoundError:
        pass


def _atomic_write_chat_run_lock_file(path: Path, payload: str) -> None:
    tmp_path = path.with_name(f".{path.name}.{os.getpid()}.{uuid.uuid4().hex}.tmp")
    try:
        tmp_path.write_text(payload, encoding="utf-8")
        tmp_path.replace(path)
    finally:
        tmp_path.unlink(missing_ok=True)


def _chat_run_lock_payload(lock_id: str, *, started_at: str | None = None) -> str:
    now = _now_iso()
    return json.dumps(
        {
            "lock_id": lock_id,
            "owner_pid": os.getpid(),
            "started_at": started_at or now,
            "updated_at": now,
        },
        ensure_ascii=False,
    )


def _chat_run_lock_file_is_new(path: Path) -> bool:
    try:
        mtime = path.stat().st_mtime
    except FileNotFoundError:
        return False
    except OSError:
        return True
    return (datetime.now(timezone.utc).timestamp() - mtime) < _CHAT_RUN_LOCK_BIRTH_GRACE_SECONDS


def _acquire_chat_run_lock(username: str, project: str) -> str:
    lock_path = _chat_run_lock_path(username, project)
    lock_id = uuid.uuid4().hex
    lock_payload = _chat_run_lock_payload(lock_id)
    payload_bytes = lock_payload.encode("utf-8")
    for _attempt in range(3):
        try:
            fd = os.open(str(lock_path), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        except FileExistsError:
            existing_lock_id, owner_pid, started_at, updated_at = _read_chat_run_lock_file(
                lock_path
            )
            if not existing_lock_id and _chat_run_lock_file_is_new(lock_path):
                raise RuntimeError("当前用户已有 AI 对话正在处理中，请稍后再试。")
            if (
                existing_lock_id
                and _pid_is_alive(owner_pid)
                and not _chat_run_lock_is_stale(started_at, updated_at)
            ):
                raise RuntimeError("当前用户已有 AI 对话正在处理中，请稍后再试。")
            _remove_chat_run_lock_file(lock_path)
            continue
        try:
            with os.fdopen(fd, "wb") as file:
                file.write(payload_bytes)
            return lock_id
        except Exception:
            try:
                os.close(fd)
            except OSError:
                pass
            _remove_chat_run_lock_file(lock_path)
            raise
    raise RuntimeError("当前用户已有 AI 对话正在处理中，请稍后再试。")


def _release_chat_run_lock(username: str, project: str, lock_id: str) -> None:
    lock_path = _chat_run_lock_path(username, project)
    current_lock_id, _owner_pid, _started_at, _updated_at = _read_chat_run_lock_file(lock_path)
    if current_lock_id == lock_id:
        _remove_chat_run_lock_file(lock_path)


def _heartbeat_chat_run_lock(username: str, project: str, lock_id: str) -> bool:
    lock_path = _chat_run_lock_path(username, project)
    current_lock_id, _owner_pid, started_at, _updated_at = _read_chat_run_lock_file(lock_path)
    if current_lock_id != lock_id:
        return False
    payload = _chat_run_lock_payload(
        lock_id,
        started_at=started_at.isoformat() if started_at else None,
    )
    try:
        _atomic_write_chat_run_lock_file(lock_path, payload)
    except OSError:
        return False
    return True


def chat_run_lock_is_active(username: str, project: str = "") -> bool:
    lock_path = _chat_run_lock_path(username, project)
    existing_lock_id, owner_pid, started_at, updated_at = _read_chat_run_lock_file(lock_path)
    if (
        existing_lock_id
        and _pid_is_alive(owner_pid)
        and not _chat_run_lock_is_stale(started_at, updated_at)
    ):
        return True
    _remove_chat_run_lock_file(lock_path)
    return False


def force_release_chat_run_lock(username: str, project: str) -> None:
    _remove_chat_run_lock_file(_chat_run_lock_path(username, project))


async def _chat_run_lock_heartbeat_loop(username: str, project: str, lock_id: str) -> None:
    while True:
        await asyncio.sleep(_CHAT_RUN_LOCK_HEARTBEAT_SECONDS)
        if not _heartbeat_chat_run_lock(username, project, lock_id):
            return


def _append_message(
    conn: sqlite3.Connection, role: str, content: str, media: list[dict[str, Any]] | None = None
) -> dict[str, Any]:
    media = media or []
    created_at_iso = _now_iso()
    cursor = conn.execute(
        """
        INSERT INTO chat_messages(role, content, media_json, created_at)
        VALUES (?, ?, ?, ?)
        """,
        (role, content, json.dumps(media, ensure_ascii=False), created_at_iso),
    )
    conn.commit()
    return {
        "id": int(cursor.lastrowid),
        "role": role,
        "content": content,
        "media": media,
        "created_at": created_at_iso,
    }


def _split_trace_contents(content: str) -> list[str]:
    raw_lines = str(content or "").rstrip().splitlines()
    blocks: list[list[str]] = []
    current: list[str] = []
    for line in raw_lines:
        if not line.strip():
            if current:
                blocks.append(current)
                current = []
            continue
        current.append(line)
    if current:
        blocks.append(current)
    return ["\n".join(block) for block in blocks if block]


def _is_hidden_chat_tool_event(name: object, text: object) -> bool:
    """Internal Hermes bookkeeping tools should not become user-visible cards."""
    haystack = f"{name or ''}\n{text or ''}".lower()
    return any(marker in haystack for marker in _HIDDEN_TOOL_MARKERS)


def _completion_text_or_existing(event_text: object, existing: str) -> str:
    """ACP may finish with metadata like ``stop=end_turn`` after text deltas."""
    final_text = str(event_text or "").strip()
    if not final_text or final_text.startswith("stop="):
        return existing
    if existing.strip() and _is_completion_notice(final_text):
        if final_text in existing:
            return existing
        return f"{existing.rstrip()}\n\n{final_text}"
    return final_text


def _is_completion_notice(text: str) -> bool:
    return text in {
        "当前任务已开始处理。请稍后让我查看当前任务进度，或在任务完成后再继续下一步。",
        "刚才这一步没有成功启动任务。请先根据返回的错误补齐前置条件；如果是配音缺少声线，可以到「虾塘」上传或录制缺失声线后再继续。",
    }


def _merge_stream_text(existing: str, incoming: object) -> str:
    """Support providers that emit either cumulative text or delta chunks."""
    chunk = str(incoming or "")
    if not chunk:
        return existing
    if chunk.startswith(existing):
        return chunk
    if existing.endswith(chunk):
        return existing
    return existing + chunk


async def _emit_chat_event_best_effort(on_event, event: dict[str, Any]) -> bool:
    """Emit to the connected client without making persistence depend on it."""
    try:
        await on_event(event)
        return True
    except Exception:
        return False


def _assistant_prefix_candidates(previous_assistant: object) -> list[str]:
    if isinstance(previous_assistant, (list, tuple)):
        items = [str(item or "").strip() for item in previous_assistant if str(item or "").strip()]
        candidates = []
        for index in range(len(items)):
            suffix = items[index:]
            candidates.append("".join(suffix))
            candidates.append("\n".join(suffix))
            candidates.append("\n\n".join(suffix))
        candidates.extend(items)
        return sorted(set(candidates), key=len, reverse=True)
    prefix = str(previous_assistant or "").strip()
    return [prefix] if prefix else []


def _strip_replayed_assistant_prefix(
    content: str,
    previous_assistant: object,
    *,
    suppress_partial_replay: bool = False,
) -> str:
    """Hermes ACP can replay prior assistant text at the start of a new turn."""
    text = str(content or "")
    original_text = text
    candidates = _assistant_prefix_candidates(previous_assistant)
    while text and candidates:
        original = text
        for prefix in candidates:
            if text.startswith(prefix):
                text = text[len(prefix) :].lstrip()
                break
            compact_prefix = "".join(prefix.split())
            if not compact_prefix:
                continue
            matched = 0
            end_index = 0
            for index, char in enumerate(text):
                if char.isspace():
                    continue
                if matched >= len(compact_prefix) or char != compact_prefix[matched]:
                    break
                matched += 1
                end_index = index + 1
                if matched == len(compact_prefix):
                    text = text[end_index:].lstrip()
                    break
            if text != original:
                break
        if text == original:
            break
    if suppress_partial_replay and not text.strip() and str(content or "").strip():
        return ""
    if not suppress_partial_replay and not text.strip() and original_text.strip():
        return original_text
    return text


def _compact_chat_text(content: object) -> str:
    return "".join(str(content or "").split())


def _strip_leading_assistant_label(content: str) -> str:
    return _ASSISTANT_TURN_LABEL_RE.sub("", str(content or ""), count=1).lstrip()


def _looks_like_labeled_transcript_replay(content: str) -> bool:
    text = str(content or "").lstrip()
    if not text:
        return False
    if _USER_TURN_LABEL_RE.match(text):
        return True
    return bool(_USER_TURN_LABEL_RE.search(text) and _ASSISTANT_TURN_LABEL_RE.search(text))


def _strip_replayed_turn_transcript(
    content: str,
    current_prompt: object,
    *,
    suppress_partial_replay: bool = False,
) -> str:
    """Remove a replayed labeled transcript while keeping normal short replies intact."""
    text = str(content or "")
    prompt = str(current_prompt or "").strip()
    if not text or not prompt:
        return text

    compact_prompt = _compact_chat_text(prompt)
    best_end = -1
    for match in _USER_TURN_LABEL_RE.finditer(text):
        start = match.end()
        line_end = text.find("\n", start)
        if line_end < 0:
            line_end = len(text)
        line = text[start:line_end]

        prompt_index = line.rfind(prompt)
        if prompt_index >= 0:
            best_end = max(best_end, start + prompt_index + len(prompt))
            continue

        if len(compact_prompt) >= 4 and compact_prompt in _compact_chat_text(line):
            best_end = max(best_end, line_end)

    if best_end < 0:
        if suppress_partial_replay and _looks_like_labeled_transcript_replay(text):
            return ""
        return text
    remainder = _strip_leading_assistant_label(text[best_end:])
    if suppress_partial_replay and not remainder.strip():
        return ""
    return remainder


def _strip_replayed_chat_response(
    content: str,
    previous_assistant: object,
    current_prompt: object,
    *,
    suppress_partial_replay: bool = False,
) -> str:
    text = _strip_replayed_turn_transcript(
        content,
        current_prompt,
        suppress_partial_replay=suppress_partial_replay,
    )
    return _strip_replayed_assistant_prefix(
        text,
        previous_assistant,
        suppress_partial_replay=suppress_partial_replay,
    )


def _json_loads_with_trailing_repair(raw: str) -> Any:
    text = str(raw or "").strip()
    if not text:
        raise ValueError("empty ui-spec")
    first_object = text.find("{")
    first_array = text.find("[")
    starts = [index for index in (first_object, first_array) if index >= 0]
    if not starts:
        raise ValueError("ui-spec does not contain JSON")
    start = min(starts)
    text = text[start:].strip()

    candidates = [text]
    stack: list[str] = []
    in_string = False
    escaped = False
    for char in text:
        if escaped:
            escaped = False
            continue
        if char == "\\":
            escaped = True
            continue
        if char == '"':
            in_string = not in_string
            continue
        if in_string:
            continue
        if char == "{":
            stack.append("}")
        elif char == "[":
            stack.append("]")
        elif char in {"}", "]"} and stack and stack[-1] == char:
            stack.pop()
    if 0 < len(stack) <= 4:
        candidates.append(text + "".join(reversed(stack)))

    last_object = text.rfind("}")
    last_array = text.rfind("]")
    end = max(last_object, last_array)
    if end >= 0:
        candidates.append(text[: end + 1])

    errors: list[str] = []
    for candidate in dict.fromkeys(candidates):
        try:
            return json.loads(candidate)
        except json.JSONDecodeError as exc:
            errors.append(str(exc))
    raise ValueError("; ".join(errors) or "invalid ui-spec JSON")


def _canonicalize_ui_spec(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError("ui-spec root must be an object")
    spec = dict(value)
    spec_type = spec.get("type")
    root = spec.get("root")
    elements = spec.get("elements")
    if not isinstance(spec_type, str) or not spec_type.strip():
        raise ValueError("ui-spec.type is required")
    if not isinstance(root, str) or not root.strip():
        raise ValueError("ui-spec.root is required")
    if not isinstance(elements, dict) or not elements:
        raise ValueError("ui-spec.elements is required")
    if root not in elements:
        raise ValueError("ui-spec.root must point to an element")

    canonical_elements: dict[str, Any] = {}
    for key, element in elements.items():
        if not isinstance(key, str) or not key:
            raise ValueError("ui-spec element keys must be strings")
        if not isinstance(element, dict):
            raise ValueError(f"ui-spec element {key} must be an object")
        element_type = element.get("type")
        if not isinstance(element_type, str) or not element_type.strip():
            raise ValueError(f"ui-spec element {key}.type is required")
        props = element.get("props")
        children = element.get("children")
        if props is None:
            props = {}
        if children is None:
            children = []
        if not isinstance(props, dict):
            raise ValueError(f"ui-spec element {key}.props must be an object")
        if not isinstance(children, list) or not all(isinstance(child, str) for child in children):
            raise ValueError(f"ui-spec element {key}.children must be a string array")
        normalized_props = dict(props)
        legacy_text = normalized_props.get("children")
        if isinstance(legacy_text, str):
            if element_type in {"Text", "Heading"} and "content" not in normalized_props:
                normalized_props["content"] = legacy_text
                normalized_props.pop("children", None)
            elif element_type == "Badge" and "label" not in normalized_props:
                normalized_props["label"] = legacy_text
                normalized_props.pop("children", None)

        if element_type == "Stack" and "direction" not in normalized_props:
            if normalized_props.get("row") is True:
                normalized_props["direction"] = "row"
            elif normalized_props.get("row") is False:
                normalized_props["direction"] = "column"

        canonical_elements[key] = {
            **element,
            "type": element_type,
            "props": normalized_props,
            "children": children,
        }

    reachable: set[str] = set()
    pending = [root]
    while pending:
        key = pending.pop()
        if key in reachable:
            continue
        element = canonical_elements.get(key)
        if element is None:
            raise ValueError(f"ui-spec references missing child {key}")
        reachable.add(key)
        pending.extend(element["children"])

    spec["type"] = spec_type
    spec["root"] = root
    spec["elements"] = canonical_elements
    return spec


def _log_json_render_error(error: ValueError, body: str) -> None:
    original_body = str(body or "")
    raw_body = original_body
    max_chars = 12000
    if len(raw_body) > max_chars:
        raw_body = f"{raw_body[:max_chars]}\n...[truncated {len(original_body) - max_chars} chars]"
    entry = (
        f"\n--- {_now_iso()} ---\n"
        f"error: {error}\n"
        "body:\n"
        f"{raw_body}\n"
    )
    try:
        path = _json_render_error_log_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as fh:
            fh.write(entry)
    except OSError:
        return


def _normalize_single_ui_spec_block(body: str) -> str:
    nested_start = body.lower().rfind("<ui-spec")
    if nested_start >= 0:
        close_index = body.lower().find("</ui-spec>", nested_start)
        if close_index >= 0:
            nested_block = body[nested_start : close_index + len("</ui-spec>")]
            return _normalize_json_render_reply(nested_block)

    try:
        value = _json_loads_with_trailing_repair(body)
        if isinstance(value, list):
            specs = [_canonicalize_ui_spec(item) for item in value]
            return _wrap_ui_spec_bundle(specs)
        spec = _canonicalize_ui_spec(value)
    except ValueError as exc:
        _log_json_render_error(exc, body)
        return "（json-render 格式校验失败：模型返回的 ui-spec 不是合法 canonical JSON，已阻止展示。请重新生成。）"

    spec_type = spec.get("type") if isinstance(spec.get("type"), str) else "ui_spec"
    json_text = json.dumps(spec, ensure_ascii=False, indent=2)
    return f'<ui-spec type="{spec_type}">\n{json_text}\n</ui-spec>'


def _normalize_json_render_reply(content: str) -> str:
    text = str(content or "")
    text = _wrap_embedded_ui_spec_json(text)
    if "<ui-spec" not in text.lower():
        return text
    text = _UI_SPEC_FENCE_RE.sub(lambda match: match.group(1).strip(), text)
    return _UI_SPEC_BLOCK_RE.sub(
        lambda match: _normalize_single_ui_spec_block(match.group(1)),
        text,
    )


def _wrap_embedded_ui_spec_json(content: str) -> str:
    text = str(content or "")
    if "<ui-spec" in text.lower():
        return text
    if '"elements"' not in text or '"root"' not in text:
        return text

    decoder = json.JSONDecoder()
    index = 0
    parts: list[str] = []
    changed = False
    while index < len(text):
        start = text.find("{", index)
        if start < 0:
            parts.append(text[index:])
            break
        parts.append(text[index:start])
        try:
            value, end = decoder.raw_decode(text[start:])
        except json.JSONDecodeError:
            parts.append(text[start : start + 1])
            index = start + 1
            continue
        if isinstance(value, dict):
            try:
                spec = _canonicalize_ui_spec(value)
            except ValueError:
                spec = None
            if spec is not None:
                parts.append(_ui_spec_block(spec))
                index = start + end
                changed = True
                continue
        parts.append(text[start : start + end])
        index = start + end

    if not changed:
        return text
    return re.sub(r"\n{3,}", "\n\n", "".join(parts)).strip()


def _redact_local_filesystem_paths(content: str) -> str:
    """Hide local developer paths before text is shown or persisted in chat."""
    text = str(content or "")
    if not text:
        return ""
    return _LOCAL_FILESYSTEM_PATH_RE.sub("[本地路径]", text)


def _strip_media_rendering_leaks(content: str) -> str:
    """Remove internal rendering/tool chatter that models sometimes echo."""
    lines: list[str] = []
    for line in str(content or "").splitlines():
        stripped = line.strip()
        lower = stripped.lower()
        if not stripped:
            lines.append(line)
            continue
        if "<ui-spec" in lower or "ui-spec" in lower or "ui_spec" in lower:
            continue
        if "json-render" in lower or "automatically rendered" in lower or "backend" in lower:
            continue
        if "dramaclaw_" in lower:
            continue
        if "按规范渲染" in stripped or "UI画廊" in stripped:
            continue
        lines.append(line)
    text = _redact_local_filesystem_paths("\n".join(lines).strip())
    return re.sub(r"\n{3,}", "\n\n", text)


def _strip_embedded_ui_spec_json_text(content: str) -> str:
    """Remove model-written media JSON from prose before appending tool specs."""
    text = str(content or "")
    pattern = re.compile(
        r'\{\s*"type"\s*:\s*"(?:character_showcase|sketch_gallery|keyframe_video|audio_list|media_bundle)"'
    )
    index = 0
    parts: list[str] = []
    decoder = json.JSONDecoder()
    changed = False

    while True:
        match = pattern.search(text, index)
        if not match:
            parts.append(text[index:])
            break
        start = match.start()
        parts.append(text[index:start])
        try:
            value, end = decoder.raw_decode(text[start:])
        except json.JSONDecodeError:
            next_paragraph = text.find("\n\n", start)
            index = len(text) if next_paragraph < 0 else next_paragraph
            changed = True
            continue
        if isinstance(value, dict):
            try:
                _canonicalize_ui_spec(value)
                index = start + end
                changed = True
                continue
            except ValueError:
                pass
        parts.append(text[start : start + end])
        index = start + end

    if not changed:
        return text.strip()
    return re.sub(r"\n{3,}", "\n\n", "".join(parts)).strip()


def _extract_tool_ui_specs(value: Any) -> list[dict[str, Any]]:
    specs: list[dict[str, Any]] = []

    def append_spec(node: Any) -> None:
        try:
            specs.append(_canonicalize_ui_spec(node))
        except ValueError as exc:
            _log_json_render_error(exc, json.dumps(node, ensure_ascii=False, default=str))

    def visit(node: Any) -> None:
        if isinstance(node, dict):
            ui_spec = node.get("ui_spec")
            if isinstance(ui_spec, dict):
                append_spec(ui_spec)
            elif {"type", "root", "elements"}.issubset(node):
                append_spec(node)
            for child in node.values():
                visit(child)
        elif isinstance(node, list):
            for child in node:
                visit(child)
        elif isinstance(node, str):
            text = node.strip()
            if not text or len(text) > 1_000_000:
                return
            if "<ui-spec" in text.casefold():
                _, embedded_specs = _split_ui_specs_from_text(text)
                specs.extend(embedded_specs)
                return
            if "ui_spec" not in text and not {"type", "root", "elements"}.issubset(set(re.findall(r'"([^"]+)"\s*:', text))):
                return
            try:
                decoded = json.loads(text)
            except json.JSONDecodeError:
                return
            visit(decoded)

    visit(value)
    deduped: list[dict[str, Any]] = []
    seen: set[str] = set()
    for spec in specs:
        key = json.dumps(spec, ensure_ascii=False, sort_keys=True)
        if key in seen:
            continue
        seen.add(key)
        deduped.append(spec)
    return deduped


def _extract_tool_chat_error(value: Any) -> str | None:
    def normalize_error_text(text: object) -> str:
        raw = redact_secrets(str(text or "")).strip()
        raw = re.sub(r"\s+", " ", raw)
        raw = re.sub(r"provider_response_id[\"']?\s*[:=]\s*[\"']?[^\"'\s,;}]+", "provider_response_id=[redacted]", raw, flags=re.IGNORECASE)
        raw = re.sub(r"response_id[\"']?\s*[:=]\s*[\"']?[^\"'\s,;}]+", "response_id=[redacted]", raw, flags=re.IGNORECASE)
        if len(raw) > 1200:
            raw = raw[:1200].rstrip() + "..."
        return raw

    def business_chat_error_from_text(text: object) -> str | None:
        raw = normalize_error_text(text)
        if not raw:
            return None
        if "Render 模式需要草图" in raw or "未生成可用图片" in raw:
            return (
                "Render 任务没有生成可用图片：当前缺少必要草图前置。"
                "请先在「虾塘」生成或确认对应 Beat 的草图后，再重新生成 Render。"
                f"\n\n错误原因：{raw[:1200]}"
            )
        return None

    def generic_chat_error_from_text(text: object) -> str | None:
        raw = normalize_error_text(text)
        if not raw:
            return None
        lowered = raw.casefold()
        if "provider_response_id" in lowered and "content_filter" in lowered:
            return None
        return f"任务执行失败：{raw}"

    def parse_jsonish(text: str) -> Any | None:
        raw = str(text or "").strip()
        if not raw:
            return None
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            pass
        try:
            return _json_loads_with_trailing_repair(raw)
        except ValueError:
            return None

    def visit(node: Any) -> str | None:
        if isinstance(node, str):
            decoded = parse_jsonish(node)
            if decoded is not None:
                return visit(decoded)
            return None
        if isinstance(node, list):
            for child in node:
                found = visit(child)
                if found:
                    return found
            return None
        if not isinstance(node, dict):
            return None

        chat_error = node.get("chat_error")
        if isinstance(chat_error, str) and chat_error.strip():
            return chat_error.strip()

        for key in ("error", "detail", "message"):
            mapped = business_chat_error_from_text(node.get(key))
            if mapped:
                return mapped

        status = str(node.get("status") or "").strip().lower()
        failed_status = status in {"failed", "error", "cancelled", "canceled"}
        ok_false = node.get("ok") is False
        if failed_status or ok_false:
            for key in ("error", "detail", "message"):
                generic = generic_chat_error_from_text(node.get(key))
                if generic:
                    return generic
            if failed_status:
                return f"任务执行失败：当前状态为 {status}。"
            return "任务执行失败：接口返回 ok=false，但没有提供具体错误原因。"

        for key in ("result", "message", "content", "data", "output"):
            found = visit(node.get(key))
            if found:
                return found
        for child in node.values():
            found = visit(child)
            if found:
                return found
        return None

    return visit(value)


def _ui_spec_json(spec: dict[str, Any]) -> tuple[str, str]:
    canonical = _canonicalize_ui_spec(spec)
    spec_type = canonical.get("type") if isinstance(canonical.get("type"), str) else "ui_spec"
    return spec_type, json.dumps(canonical, ensure_ascii=False, indent=2)


def _wrap_ui_spec_json(spec_type: str, json_text: str) -> str:
    return (
        f'<ui-spec type="{spec_type}">\n'
        f"{json_text}\n"
        "</ui-spec>"
    )


def _wrap_ui_spec_bundle(specs: list[dict[str, Any]]) -> str:
    canonical_specs = [_canonicalize_ui_spec(spec) for spec in specs]
    if len(canonical_specs) == 1:
        spec_type = canonical_specs[0].get("type")
        return _wrap_ui_spec_json(
            spec_type if isinstance(spec_type, str) and spec_type else "ui_spec",
            json.dumps(canonical_specs[0], ensure_ascii=False, indent=2),
        )
    return _wrap_ui_spec_json(
        "media_bundle",
        json.dumps(canonical_specs, ensure_ascii=False, indent=2),
    )


def _ui_spec_block(spec: dict[str, Any]) -> str:
    spec_type, json_text = _ui_spec_json(spec)
    return _wrap_ui_spec_json(spec_type, json_text)


_MERGEABLE_MEDIA_SPEC_TYPES = {
    "character_showcase",
    "sketch_gallery",
    "keyframe_video",
    "audio_list",
}


def _can_merge_ui_specs(left: dict[str, Any], right: dict[str, Any]) -> bool:
    spec_type = left.get("type")
    if spec_type != right.get("type") or spec_type not in _MERGEABLE_MEDIA_SPEC_TYPES:
        return False
    left_elements = left.get("elements")
    right_elements = right.get("elements")
    left_root_id = left.get("root")
    right_root_id = right.get("root")
    if not (
        isinstance(left_elements, dict)
        and isinstance(right_elements, dict)
        and isinstance(left_root_id, str)
        and isinstance(right_root_id, str)
    ):
        return False
    left_root = left_elements.get(left_root_id)
    right_root = right_elements.get(right_root_id)
    if not isinstance(left_root, dict) or not isinstance(right_root, dict):
        return False
    return left_root.get("type") == right_root.get("type") == "Stack"


def _merge_ui_specs(left: dict[str, Any], right: dict[str, Any]) -> dict[str, Any]:
    left = _canonicalize_ui_spec(left)
    right = _canonicalize_ui_spec(right)
    left_elements = dict(left["elements"])
    right_elements = right["elements"]
    left_root_id = left["root"]
    right_root_id = right["root"]
    left_root = dict(left_elements[left_root_id])
    right_root = right_elements[right_root_id]
    left_children = list(left_root.get("children") or [])
    right_children = list(right_root.get("children") or [])

    def unique_key(key: str) -> str:
        if key not in left_elements:
            return key
        index = 2
        while f"{key}_{index}" in left_elements:
            index += 1
        return f"{key}_{index}"

    key_map: dict[str, str] = {}
    for key, element in right_elements.items():
        if key == right_root_id:
            continue
        next_key = unique_key(key)
        key_map[key] = next_key
        left_elements[next_key] = element

    left_root["children"] = [
        *left_children,
        *[key_map.get(child, child) for child in right_children if isinstance(child, str)],
    ]
    left_elements[left_root_id] = left_root
    return {**left, "elements": left_elements}


def _merge_tool_ui_specs_by_type(specs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    merged: list[dict[str, Any]] = []
    merge_indexes: dict[str, int] = {}
    for spec in specs:
        spec_type = spec.get("type")
        merge_index = merge_indexes.get(spec_type) if isinstance(spec_type, str) else None
        if merge_index is not None and _can_merge_ui_specs(merged[merge_index], spec):
            try:
                merged[merge_index] = _merge_ui_specs(merged[merge_index], spec)
                continue
            except ValueError as exc:
                _log_json_render_error(exc, json.dumps(spec, ensure_ascii=False))
        merged.append(spec)
        if isinstance(spec_type, str) and spec_type in _MERGEABLE_MEDIA_SPEC_TYPES:
            merge_indexes.setdefault(spec_type, len(merged) - 1)
    return merged


def _append_tool_ui_specs(content: str, specs: list[dict[str, Any]]) -> str:
    raw_text = str(content or "").strip()
    if specs and _UI_SPEC_BLOCK_RE.search(raw_text):
        return raw_text
    text = _strip_media_rendering_leaks(raw_text)
    if not specs:
        return text
    text = _strip_embedded_ui_spec_json_text(text)
    specs = _merge_tool_ui_specs_by_type(specs)
    blocks: list[str] = []
    for spec in specs:
        try:
            blocks.append(_ui_spec_block(spec))
        except ValueError as exc:
            _log_json_render_error(exc, json.dumps(spec, ensure_ascii=False))
    if not blocks:
        return text
    prefix = text or "已为你展示相关媒体。"
    return f"{prefix}\n\n" + "\n\n".join(blocks)


def _split_ui_specs_from_text(content: str) -> tuple[str, list[dict[str, Any]]]:
    text = str(content or "")
    if "<ui-spec" not in text.lower():
        return text, []

    text = _UI_SPEC_FENCE_RE.sub(lambda match: match.group(1).strip(), text)
    specs: list[dict[str, Any]] = []

    def replace_block(match: re.Match[str]) -> str:
        body = match.group(1)
        try:
            value = _json_loads_with_trailing_repair(body)
            if isinstance(value, list):
                specs.extend(_canonicalize_ui_spec(item) for item in value)
            else:
                specs.append(_canonicalize_ui_spec(value))
        except ValueError as exc:
            _log_json_render_error(exc, body)
            return "（json-render 格式校验失败：模型返回的 ui-spec 不是合法 canonical JSON，已阻止展示。请重新生成。）"
        return ""

    display_text = _UI_SPEC_BLOCK_RE.sub(replace_block, text)
    display_text = re.sub(r"\n{3,}", "\n\n", display_text).strip()
    return display_text, specs


def _dedupe_tool_ui_specs(specs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    deduped: list[dict[str, Any]] = []
    seen: set[str] = set()
    for spec in specs:
        key = json.dumps(spec, ensure_ascii=False, sort_keys=True)
        if key in seen:
            continue
        seen.add(key)
        deduped.append(spec)
    return deduped


def _prompt_wants_sketch_only(prompt: str) -> bool:
    text = str(prompt or "")
    if "草图" not in text and "sketch" not in text.casefold():
        return False
    frame_terms = ("首帧", "第一帧", "关键帧", "first frame", "first-frame", "keyframe", "frame")
    return not any(term in text.casefold() for term in frame_terms)


def _is_frame_image_element(element: Any) -> bool:
    if not isinstance(element, dict):
        return False
    props = element.get("props")
    if not isinstance(props, dict):
        return False
    fields = [
        props.get("src"),
        props.get("poster"),
        props.get("title"),
        props.get("alt"),
        props.get("description"),
        props.get("overlayTitle"),
        props.get("overlayDescription"),
    ]
    text = "\n".join(str(value or "") for value in fields).casefold()
    return "首帧" in text or "/frames/" in text or "first frame" in text or "first-frame" in text


def _filter_tool_ui_specs_for_prompt(prompt: str, specs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if not specs or not _prompt_wants_sketch_only(prompt):
        return specs

    filtered_specs: list[dict[str, Any]] = []
    for spec in specs:
        if not isinstance(spec, dict) or spec.get("type") != "sketch_gallery":
            filtered_specs.append(spec)
            continue
        elements = spec.get("elements")
        root_key = spec.get("root")
        if not isinstance(elements, dict) or not isinstance(root_key, str):
            filtered_specs.append(spec)
            continue
        root = elements.get(root_key)
        if not isinstance(root, dict):
            filtered_specs.append(spec)
            continue
        children = root.get("children")
        if not isinstance(children, list):
            filtered_specs.append(spec)
            continue

        kept_children: list[str] = []
        kept_elements: dict[str, Any] = {}
        for key, element in elements.items():
            if key == root_key:
                continue
            if key in children and _is_frame_image_element(element):
                continue
            kept_elements[key] = element
            if key in children:
                kept_children.append(key)

        if not kept_children:
            continue
        new_root = copy.deepcopy(root)
        new_root["children"] = kept_children
        filtered_specs.append(
            {
                **spec,
                "elements": {
                    root_key: new_root,
                    **{key: kept_elements[key] for key in kept_elements},
                },
            }
        )
    return filtered_specs


_DISPLAY_TOOL_NAMES = {
    "dramaclaw_get_sketches",
    "dramaclaw_get_sketch_candidates",
    "dramaclaw_get_first_frames",
    "dramaclaw_get_scene_images",
    "dramaclaw_get_character_media",
    "dramaclaw_get_episode_media",
}


def _limit_display_items(items: list[dict[str, Any]], args: dict[str, Any], default: int) -> list[dict[str, Any]]:
    try:
        limit = int(args.get("limit")) if args.get("limit") is not None else default
    except (TypeError, ValueError):
        limit = default
    try:
        offset = int(args.get("offset") or 0)
    except (TypeError, ValueError):
        offset = 0
    offset = max(0, offset)
    limit = max(1, min(limit, default))
    return items[offset : offset + limit]


def _requested_display_beats(args: dict[str, Any]) -> set[int] | None:
    raw = args.get("beat_indices") or args.get("beats")
    values: list[Any] = []
    if isinstance(raw, list):
        values.extend(raw)
    elif raw is not None:
        values.append(raw)
    for key in ("beat", "beat_num", "beat_number", "index"):
        if args.get(key) is not None:
            values.append(args[key])
    beats: set[int] = set()
    for value in values:
        try:
            beat = int(value)
        except (TypeError, ValueError):
            continue
        if beat > 0:
            beats.add(beat)
    return beats or None


def _requested_display_names(args: dict[str, Any]) -> set[str] | None:
    raw = args.get("names")
    values: list[Any] = []
    if isinstance(raw, list):
        values.extend(raw)
    elif raw is not None:
        values.append(raw)
    for key in ("name", "character"):
        if args.get(key) is not None:
            values.append(args[key])
    names = {str(value).strip() for value in values if str(value or "").strip()}
    return names or None


def _requested_display_queries(args: dict[str, Any]) -> set[str] | None:
    raw = args.get("queries") or args.get("keywords")
    values: list[Any] = []
    if isinstance(raw, list):
        values.extend(raw)
    elif raw is not None:
        values.append(raw)
    for key in ("query", "search", "keyword", "text", "identity_name"):
        if args.get(key) is not None:
            values.append(args[key])
    queries = {str(value).strip() for value in values if str(value or "").strip()}
    return queries or None


def _requested_display_scene_names(args: dict[str, Any]) -> set[str] | None:
    raw = args.get("names") or args.get("scene_names")
    values: list[Any] = []
    if isinstance(raw, list):
        values.extend(raw)
    elif raw is not None:
        values.append(raw)
    for key in ("name", "scene_name"):
        if args.get(key) is not None:
            values.append(args[key])
    names = {str(value).strip() for value in values if str(value or "").strip()}
    return names or None


def _requested_display_scene_indices(args: dict[str, Any]) -> set[int] | None:
    raw = args.get("scene_indices") or args.get("indices")
    values: list[Any] = []
    if isinstance(raw, list):
        values.extend(raw)
    elif raw is not None:
        values.append(raw)
    if args.get("index") is not None:
        values.append(args["index"])
    indices: set[int] = set()
    for value in values:
        try:
            index = int(value)
        except (TypeError, ValueError):
            continue
        if index > 0:
            indices.add(index)
    return indices or None


def _matches_any_display_scene_name(scene_name: str, requested_names: set[str] | None) -> bool:
    if requested_names is None:
        return True
    haystack = str(scene_name or "").casefold()
    return any(needle.casefold() in haystack for needle in requested_names if needle)


def _flatten_display_text_fields(fields: list[Any]) -> list[str]:
    values: list[str] = []
    for field in fields:
        if isinstance(field, dict):
            values.extend(_flatten_display_text_fields(list(field.values())))
        elif isinstance(field, list):
            values.extend(_flatten_display_text_fields(field))
        elif field is not None:
            text = str(field).strip()
            if text:
                values.append(text)
    return values


def _matches_any_display_text(fields: list[Any], queries: set[str] | None) -> bool:
    if queries is None:
        return True
    haystack = "\n".join(_flatten_display_text_fields(fields)).casefold()
    return any(query.casefold() in haystack for query in queries if query)


def _media_ui_spec(spec_type: str, component_type: str, items: list[dict[str, Any]]) -> dict[str, Any]:
    elements: dict[str, Any] = {
        "root": {
            "type": "Stack",
            "props": {
                "direction": "row",
                "wrap": "wrap",
                "spacing": 16,
                "alignItems": "flex-start",
                "width": "100%",
            },
            "children": [],
        }
    }
    for index, item in enumerate(items, start=1):
        src = str(item.get("src") or item.get("url") or "").strip()
        if not src:
            continue
        key = f"media_{index}"
        title = str(item.get("title") or item.get("label") or f"媒体 {index}").strip()
        description = str(item.get("description") or "").strip()
        props: dict[str, Any] = {"src": src, "alt": title, "title": title}
        if description:
            props["description"] = description
        if component_type == "Image":
            props.update(
                {
                    "fit": item.get("fit") or "cover",
                    "aspectRatio": item.get("aspectRatio") or "3/4",
                    "overlayTitle": title,
                }
            )
            if description:
                props["overlayDescription"] = description
        elif component_type == "Video":
            poster = str(item.get("poster") or item.get("thumbnail") or "").strip()
            if poster:
                props["poster"] = poster
            props["controls"] = True
        elif component_type == "Audio":
            props["controls"] = True

        elements[key] = {"type": component_type, "props": props, "children": []}
        elements["root"]["children"].append(key)
    return {"type": spec_type, "root": "root", "elements": elements}


def _project_static_url_from_path(project_id: str, rel_path: str, local_path: Path | None = None) -> str:
    return project_static_url(project_id, rel_path, local_path=local_path)


def _api_response_items(resp: Any, *keys: str) -> list[Any]:
    if not isinstance(resp, dict):
        return []
    for key in keys:
        value = resp.get(key)
        if isinstance(value, list):
            return value
    data = resp.get("data")
    if isinstance(data, list):
        return data
    if isinstance(data, dict):
        for key in keys:
            value = data.get(key)
            if isinstance(value, list):
                return value
    return []


def _decode_tool_args(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if isinstance(value, str) and value.strip():
        try:
            decoded = json.loads(value)
        except json.JSONDecodeError:
            return {}
        return decoded if isinstance(decoded, dict) else {}
    return {}


def _extract_display_tool_call(raw: Any) -> tuple[str, dict[str, Any]] | None:
    if not isinstance(raw, dict):
        return None
    title = str(raw.get("title") or raw.get("kind") or raw.get("name") or raw.get("tool_name") or "").strip()
    tool_name = title.partition(":")[0].split()[0].strip()
    if tool_name not in _DISPLAY_TOOL_NAMES:
        for key in ("name", "tool", "toolName", "tool_name"):
            candidate = str(raw.get(key) or "").strip()
            if candidate in _DISPLAY_TOOL_NAMES:
                tool_name = candidate
                break
    if tool_name not in _DISPLAY_TOOL_NAMES:
        function = raw.get("function")
        if isinstance(function, dict):
            candidate = str(function.get("name") or "").strip()
            if candidate in _DISPLAY_TOOL_NAMES:
                tool_name = candidate
    if tool_name not in _DISPLAY_TOOL_NAMES:
        return None
    for key in ("arguments", "args", "input", "params"):
        args = _decode_tool_args(raw.get(key))
        if args:
            return tool_name, args
    content = raw.get("content")
    if isinstance(content, list):
        for item in content:
            if not isinstance(item, dict):
                continue
            nested = item.get("content")
            if isinstance(nested, dict):
                args = _decode_tool_args(nested.get("text"))
                if args:
                    return tool_name, args
    return tool_name, {}


def _display_tool_call_key(tool_name: str, args: dict[str, Any]) -> str:
    try:
        encoded_args = json.dumps(args, ensure_ascii=False, sort_keys=True, default=str)
    except TypeError:
        encoded_args = repr(args)
    return f"{tool_name}:{encoded_args}"


def _infer_display_tool_call_from_text(
    prompt: str,
    assistant_text: str,
    previous_assistant: list[str],
) -> tuple[str, dict[str, Any]] | None:
    """Recover from display promises where the model forgot to call a display tool."""
    prompt_text = str(prompt or "")
    prompt_lower = prompt_text.casefold()
    recent_context = "\n".join(previous_assistant[-2:] if previous_assistant else [])
    context_text = "\n".join([prompt_text, str(assistant_text or ""), recent_context])
    context_lower = context_text.casefold()
    progress_terms = ("进度", "状态", "任务", "做到哪", "做到哪儿", "当前情况")
    if any(term in prompt_text for term in progress_terms):
        return None
    display_terms = ("展示", "显示", "查看", "看", "全部显示", "show", "display", "view")
    if not any(term in prompt_lower for term in display_terms):
        return None
    prompt_mentions_sketch = "草图" in prompt_text or "sketch" in prompt_lower
    context_mentions_sketch = "草图" in context_text or "sketch" in context_lower
    short_followup = len(prompt_text.strip()) <= 20 and any(
        term in prompt_text for term in ("全部", "继续", "下一页", "更多")
    )
    if not prompt_mentions_sketch and not (short_followup and context_mentions_sketch):
        return None

    episode = 1
    episode_match = re.search(
        r"(?:第\s*(\d+)\s*集|ep(?:isode)?\s*\.?\s*(\d+))",
        context_text,
        re.IGNORECASE,
    )
    if episode_match:
        raw_episode = episode_match.group(1) or episode_match.group(2)
        try:
            episode = max(1, int(raw_episode))
        except (TypeError, ValueError):
            episode = 1
    wants_sketch_candidates = any(term in context_text for term in ("草图候选", "候选草图", "图池", "备选草图"))
    if wants_sketch_candidates:
        beat_match = re.search(
            r"(?:beat|Beat|BEAT)\s*\.?\s*(\d+)|第\s*(\d+)\s*(?:个|张)?\s*beat|Beat\s*(\d+)",
            context_text,
            re.IGNORECASE,
        )
        raw_beat = None
        if beat_match:
            raw_beat = next((group for group in beat_match.groups() if group), None)
        if raw_beat:
            try:
                beat = max(1, int(raw_beat))
            except (TypeError, ValueError):
                beat = 0
            if beat > 0:
                return "dramaclaw_get_sketch_candidates", {"episode": episode, "beat": beat}
        return None
    return "dramaclaw_get_sketches", {"episode": episode}


def _backend_api_get(path: str, token: str) -> dict[str, Any]:
    base_url = (
        os.environ.get("DRAMACLAW_API_URL")
        or os.environ.get("NOVELVIDEO_API_URL")
        or f"http://127.0.0.1:{os.environ.get('NOVELVIDEO_API_PORT', '19080')}"
        or os.environ.get("SUPERTALE_API_URL")
    ).strip()
    url = f"{base_url.rstrip('/')}{path}"
    req = Request(
        url,
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            "User-Agent": "dramaclaw-chat-fallback/0.1.0",
        },
        method="GET",
    )
    with urlopen(req, timeout=30) as resp:
        text = resp.read().decode("utf-8", errors="replace")
    try:
        value = json.loads(text)
    except json.JSONDecodeError:
        return {"ok": False, "error": text[:500]}
    return value if isinstance(value, dict) else {"ok": True, "data": value}


async def _fallback_display_tool_ui_specs(
    username: str,
    project: str,
    tool_name: str,
    args: dict[str, Any],
    *,
    token: str,
    project_dir: str | Path | None = None,
) -> list[dict[str, Any]]:
    if not project or tool_name not in _DISPLAY_TOOL_NAMES:
        return []

    def build() -> list[dict[str, Any]]:
        api_project = str(args.get("project_id") or args.get("project") or project).strip()
        project_q = quote(api_project, safe="")
        if tool_name in {"dramaclaw_get_sketches", "dramaclaw_get_first_frames"}:
            episode = int(args.get("episode") or 1)
            media_kind = "frame" if tool_name == "dramaclaw_get_first_frames" else "sketch"
            resp = _backend_api_get(
                f"/api/v1/projects/{project_q}/episodes/{episode}/beats",
                token,
            )
            media_items: list[dict[str, Any]] = []
            requested_beats = _requested_display_beats(args)
            for beat in _api_response_items(resp, "beats", "items"):
                if not isinstance(beat, dict):
                    continue
                beat_number = beat.get("beat_number")
                try:
                    beat_int = int(beat_number)
                except (TypeError, ValueError):
                    beat_int = None
                if requested_beats is not None and beat_int not in requested_beats:
                    continue
                sketch_url = str(beat.get("sketch_url") or "").strip()
                frame_url = str(beat.get("frame_url") or "").strip()
                if sketch_url and media_kind == "sketch":
                    media_items.append(
                        {
                            "src": sketch_url,
                            "title": f"Beat {beat_number} 草图",
                            "description": "草图",
                            "aspectRatio": "3/4",
                        }
                    )
                if frame_url and media_kind == "frame":
                    media_items.append(
                        {
                            "src": frame_url,
                            "title": f"Beat {beat_number} 首帧",
                            "description": "首帧",
                            "aspectRatio": "3/4",
                        }
                    )
            limited = _limit_display_items(media_items, args, 12)
            return [_media_ui_spec("sketch_gallery", "Image", limited)] if limited else []

        if tool_name == "dramaclaw_get_sketch_candidates":
            episode = int(args.get("episode") or 1)
            try:
                beat = int(args.get("beat") or args.get("beat_num") or args.get("beat_number") or 0)
            except (TypeError, ValueError):
                beat = 0
            if beat <= 0:
                return []
            resp = _backend_api_get(
                f"/api/v1/projects/{project_q}/episodes/{episode}/beats/{beat}/sketch-candidates",
                token,
            )
            data = resp.get("data") if isinstance(resp, dict) else None
            candidates = data.get("candidates") if isinstance(data, dict) else []
            media_items = []
            for candidate in candidates if isinstance(candidates, list) else []:
                if not isinstance(candidate, dict):
                    continue
                src = str(candidate.get("url") or "").strip()
                if not src:
                    continue
                media_items.append(
                    {
                        "src": src,
                        "title": f"Beat {beat} 草图候选",
                        "description": "过期候选" if candidate.get("stale") else "草图候选",
                        "aspectRatio": "3/4",
                    }
                )
            limited = _limit_display_items(media_items, args, 12)
            return [_media_ui_spec("sketch_gallery", "Image", limited)] if limited else []

        if tool_name == "dramaclaw_get_scene_images":
            resp = _backend_api_get(f"/api/v1/projects/{project_q}/scenes", token)
            media_items = []
            include_reverse = bool(args.get("include_reverse", True))
            include_pano = bool(args.get("include_pano", False))
            include_custom = bool(args.get("include_custom", False))
            requested_names = _requested_display_scene_names(args)
            requested_indices = _requested_display_scene_indices(args)
            requested_type = str(args.get("scene_type") or "").strip()
            for scene_index, scene in enumerate(_api_response_items(resp, "scenes", "items"), start=1):
                if not isinstance(scene, dict):
                    continue
                scene_name = str(scene.get("name") or "").strip()
                scene_type = str(scene.get("scene_type") or "").strip()
                if requested_indices is not None and scene_index not in requested_indices:
                    continue
                if not _matches_any_display_scene_name(scene_name, requested_names):
                    continue
                if requested_type and scene_type != requested_type:
                    continue
                for kind, field, enabled in (
                    ("master", "master_url", True),
                    ("reverse_master", "reverse_master_url", include_reverse),
                    ("pano", "pano_url", include_pano),
                    ("custom_scene", "custom_scene_url", include_custom),
                ):
                    src = str(scene.get(field) or "").strip()
                    if enabled and src:
                        media_items.append(
                            {
                                "src": src,
                                "title": f"{scene_name or '场景'} · {kind}",
                                "description": scene.get("description") or scene.get("environment_prompt") or "",
                                "aspectRatio": "16/9" if kind == "pano" else "3/4",
                            }
                        )
            limited = _limit_display_items(media_items, args, 12)
            return [_media_ui_spec("sketch_gallery", "Image", limited)] if limited else []

        if tool_name == "dramaclaw_get_character_media":
            resp = _backend_api_get(f"/api/v1/projects/{project_q}/characters", token)
            media_kind = str(args.get("media_kind") or args.get("kind") or "all").strip().lower()
            if media_kind not in {"all", "portrait", "identity"}:
                media_kind = "all"
            include_identities = bool(args.get("include_identities", True)) and media_kind != "portrait"
            media_items = []
            requested_names = _requested_display_names(args)
            requested_queries = _requested_display_queries(args)
            for character in _api_response_items(resp, "characters", "items"):
                if not isinstance(character, dict):
                    continue
                name = str(character.get("name") or "").strip()
                role = str(character.get("role") or character.get("description") or "").strip()
                character_name_match = _matches_any_display_text(
                    [name, character.get("aliases")],
                    requested_names,
                )
                character_query_match = _matches_any_display_text(
                    [
                        name,
                        role,
                        character.get("description"),
                        character.get("appearance"),
                        character.get("profile"),
                        character.get("aliases"),
                    ],
                    requested_queries,
                )
                character_match = character_name_match and character_query_match
                portrait_url = str(character.get("portrait_url") or "").strip()
                if portrait_url and character_match:
                    if media_kind in {"all", "portrait"}:
                        media_items.append(
                            {
                                "src": portrait_url,
                                "title": name or "角色肖像",
                                "description": role,
                                "aspectRatio": "3/4",
                            }
                        )
                identities = character.get("identities") or character.get("identity_images") or []
                if include_identities:
                    try:
                        identities_resp = _backend_api_get(
                            f"/api/v1/projects/{project_q}/characters/{quote(name, safe='')}/identities",
                            token,
                        )
                        for key in ("data", "identities", "items"):
                            value = identities_resp.get(key) if isinstance(identities_resp, dict) else None
                            if isinstance(value, list):
                                identities = value
                                break
                        data = identities_resp.get("data") if isinstance(identities_resp, dict) else None
                        if isinstance(data, dict):
                            value = data.get("identities")
                            if isinstance(value, list):
                                identities = value
                    except Exception:
                        pass
                if include_identities and isinstance(identities, list):
                    for identity in identities:
                        if not isinstance(identity, dict):
                            continue
                        src = str(
                            identity.get("image_url")
                            or identity.get("portrait_image_url")
                            or identity.get("costume_image_url")
                            or ""
                        ).strip()
                        if src:
                            title = str(
                                identity.get("identity_name")
                                or identity.get("name")
                                or identity.get("identity_id")
                                or name
                                or "身份图"
                            )
                            identity_name_match = _matches_any_display_text(
                                [
                                    name,
                                    character.get("aliases"),
                                    title,
                                    identity.get("identity_name"),
                                    identity.get("name"),
                                    identity.get("identity_id"),
                                ],
                                requested_names,
                            )
                            identity_query_match = _matches_any_display_text(
                                [
                                    title,
                                    identity.get("identity_name"),
                                    identity.get("name"),
                                    identity.get("identity_id"),
                                    identity.get("description"),
                                    identity.get("appearance_details"),
                                    identity.get("prompt"),
                                    identity.get("role"),
                                    name,
                                    role,
                                ],
                                requested_queries,
                            )
                            identity_match = identity_name_match and identity_query_match
                            if not identity_match:
                                continue
                            media_items.append(
                                {
                                    "src": src,
                                    "title": f"{name} · {title}" if name else title,
                                    "description": role,
                                    "aspectRatio": "3/4",
                                }
                            )
            limited = _limit_display_items(media_items, args, 12)
            return [_media_ui_spec("character_showcase", "Image", limited)] if limited else []

        if tool_name == "dramaclaw_get_episode_media":
            episode = int(args.get("episode") or 1)
            media_type = str(args.get("media_type") or "video").strip().lower()
            resp = _backend_api_get(
                f"/api/v1/projects/{project_q}/episodes/{episode}/beats",
                token,
            )
            video_items: list[dict[str, Any]] = []
            audio_items: list[dict[str, Any]] = []
            requested_beats = _requested_display_beats(args)
            requested_queries = _requested_display_queries(args)
            for beat in _api_response_items(resp, "beats", "items"):
                if not isinstance(beat, dict):
                    continue
                beat_number = beat.get("beat_number")
                try:
                    beat_int = int(beat_number)
                except (TypeError, ValueError):
                    beat_int = None
                if requested_beats is not None and beat_int not in requested_beats:
                    continue
                if not _matches_any_display_text(
                    [
                        beat.get("title"),
                        beat.get("summary"),
                        beat.get("description"),
                        beat.get("visual_description"),
                        beat.get("image_prompt"),
                        beat.get("video_prompt"),
                        beat.get("narration"),
                        beat.get("voiceover"),
                        beat.get("dialogue"),
                        beat.get("audio_text"),
                        beat.get("speaker"),
                        beat.get("character_names"),
                        beat.get("characters"),
                        beat.get("scene_name"),
                        beat.get("location"),
                    ],
                    requested_queries,
                ):
                    continue
                video_url = str(beat.get("video_url") or "").strip()
                audio_url = str(beat.get("audio_url") or "").strip()
                frame_url = str(beat.get("frame_url") or beat.get("sketch_url") or "").strip()
                if video_url:
                    video_items.append(
                        {"src": video_url, "poster": frame_url, "title": f"Beat {beat_number} 视频"}
                    )
                if audio_url:
                    audio_items.append({"src": audio_url, "title": f"Beat {beat_number} 音频"})
            if media_type == "audio":
                limited = _limit_display_items(audio_items, args, 20)
                return [_media_ui_spec("audio_list", "Audio", limited)] if limited else []
            limited = _limit_display_items(video_items, args, 6)
            return [_media_ui_spec("keyframe_video", "Video", limited)] if limited else []

        return []

    try:
        return await asyncio.to_thread(build)
    except Exception as exc:
        logger.info(
            "display fallback failed project=%s tool=%s args=%s error=%s",
            project,
            tool_name,
            json.dumps(args, ensure_ascii=False, sort_keys=True, default=str)[:1000],
            exc,
        )
        return []


def _assistant_history_contents(
    username: str,
    project: str,
    *,
    project_dir: str | Path | None = None,
    project_state_dir: str | Path | None = None,
) -> list[str]:
    return [
        str(message.get("content") or "")
        for message in list_messages(
            username,
            project,
            project_dir=project_dir,
            project_state_dir=project_state_dir,
        )
        if message.get("role") == "assistant"
    ]


def _trace_history_contents(
    username: str,
    project: str,
    *,
    project_dir: str | Path | None = None,
    project_state_dir: str | Path | None = None,
) -> list[str]:
    conn = _connect(_chat_db_path(username, project, project_dir, project_state_dir))
    try:
        rows = conn.execute(
            """
            SELECT content
              FROM chat_messages
             WHERE role = 'trace'
             ORDER BY id ASC
            """
        ).fetchall()
    finally:
        conn.close()
    return [str(row["content"] or "") for row in rows]


def _replace_trace_messages(conn: sqlite3.Connection, messages: list[dict[str, Any]]) -> None:
    conn.execute("DELETE FROM chat_messages WHERE role = 'trace'")
    for message in messages:
        conn.execute(
            """
            INSERT INTO chat_messages(role, content, media_json, created_at)
            VALUES (?, ?, ?, ?)
            """,
            (
                str(message.get("role") or "assistant"),
                str(message.get("content") or ""),
                json.dumps(message.get("media") or [], ensure_ascii=False),
                str(message.get("created_at") or _now_iso()),
            ),
        )
    conn.commit()


def _extract_codex_user_message_text(item: Any) -> str:
    thread_item = _codex_unwrap_item(item)
    parts: list[str] = []
    for content in getattr(thread_item, "content", []) or []:
        item_type = str(getattr(content, "type", "") or "")
        if item_type == "text":
            text = str(getattr(content, "text", "") or "").strip()
            if text:
                parts.append(text)
        elif item_type == "skill":
            name = str(getattr(content, "name", "") or "").strip()
            if name:
                parts.append(f"[skill] {name}")
        elif item_type == "mention":
            name = str(getattr(content, "name", "") or "").strip()
            path = str(getattr(content, "path", "") or "").strip()
            parts.append(f"[mention] {name or path}".strip())
        elif item_type == "image":
            url = str(getattr(content, "url", "") or "").strip()
            if url:
                parts.append(f"[image] {url}")
        elif item_type == "localImage":
            path = str(getattr(content, "path", "") or "").strip()
            if path:
                parts.append(f"[image] {path}")
    return "\n".join(part for part in parts if part).strip()


def _extract_codex_history_trace(item: Any) -> str:
    from openai_codex.generated.v2_all import CommandExecutionThreadItem

    thread_item = _codex_unwrap_item(item)
    started = _codex_item_started_trace(thread_item) or ""
    completed = _codex_item_completed_trace(thread_item) or ""
    body = ""
    if isinstance(thread_item, CommandExecutionThreadItem):
        aggregated = str(thread_item.aggregated_output or "")
        if aggregated:
            body = aggregated
            if not body.endswith("\n"):
                body += "\n"
    return (started + body + completed).strip()


def _load_codex_thread_history(username: str, project: str) -> list[dict[str, Any]]:
    from openai_codex import Codex, CodexConfig
    from openai_codex.generated.v2_all import AgentMessageThreadItem, UserMessageThreadItem

    thread_id = _get_codex_thread_id(username, project)
    if not thread_id:
        return []

    ensure_user_codex_workspace(username, project)
    workspace = _user_agent_workspace(username)
    codex_bin = _codex_bin_path()
    config = CodexConfig(
        codex_bin=str(codex_bin) if codex_bin is not None else None,
        cwd=str(workspace),
        env=_build_codex_env(username, project),
        config_overrides=_codex_mcp_config_overrides(_dramaclaw_mcp_servers()),
    )

    with Codex(config=config) as codex:
        read_response = codex._client.thread_read(thread_id, include_turns=True)
        thread = read_response.thread
        turns = list(getattr(thread, "turns", []) or [])
        if not turns or not any(getattr(turn, "items", None) for turn in turns):
            resumed = codex._client.thread_resume(
                thread_id,
                {
                    "cwd": str(workspace),
                    "model": _codex_model(),
                },
            )
            turns = list(getattr(resumed.thread, "turns", []) or [])

    history: list[dict[str, Any]] = []
    for turn_index, turn in enumerate(turns):
        for item_index, item in enumerate(getattr(turn, "items", []) or []):
            thread_item = _codex_unwrap_item(item)
            created_at = _now_iso()
            if isinstance(thread_item, UserMessageThreadItem):
                content = _extract_codex_user_message_text(thread_item)
                if content:
                    history.append(
                        {
                            "id": turn_index * 1000 + item_index,
                            "role": "user",
                            "content": content,
                            "media": _filter_markdown_duplicate_images(
                                content,
                                _extract_media(content, username, project),
                            ),
                            "created_at": created_at,
                        }
                    )
                continue
            if isinstance(thread_item, AgentMessageThreadItem):
                content = str(thread_item.text or "").strip()
                if content:
                    media = _extract_media(content, username, project)
                    history.append(
                        {
                            "id": turn_index * 1000 + item_index,
                            "role": "assistant",
                            "content": content,
                            "media": _filter_markdown_duplicate_images(content, media),
                            "created_at": created_at,
                        }
                    )
                continue

            trace = _extract_codex_history_trace(thread_item)
            if trace:
                for block_index, block in enumerate(_split_trace_contents(trace)):
                    history.append(
                        {
                            "id": turn_index * 10000 + item_index * 10 + block_index,
                            "role": "trace",
                            "content": block,
                            "media": [],
                            "created_at": created_at,
                        }
                    )

    return history


def _sync_codex_history_cache(
    username: str,
    project: str,
    project_dir: str | Path | None = None,
    project_state_dir: str | Path | None = None,
) -> None:
    history = [
        message
        for message in _load_codex_thread_history(username, project)
        if message.get("role") == "trace"
    ]
    if not history:
        return
    conn = _connect(_chat_db_path(username, project, project_dir, project_state_dir))
    try:
        _replace_trace_messages(conn, history)
    finally:
        conn.close()


def list_messages(
    username: str,
    project: str,
    *,
    project_dir: str | Path | None = None,
    project_state_dir: str | Path | None = None,
    limit: int = 50,
) -> list[dict[str, Any]]:
    conn = _connect(_chat_db_path(username, project, project_dir, project_state_dir))
    try:
        rows = conn.execute(
            """
            SELECT id, role, content, media_json, created_at
              FROM (
                    SELECT id, role, content, media_json, created_at
                      FROM chat_messages
                     WHERE role <> 'trace'
                     ORDER BY id DESC
                     LIMIT ?
                   )
             ORDER BY id ASC
            """,
            (max(1, int(limit)),),
        ).fetchall()
        messages: list[dict[str, Any]] = []
        previous_assistants: list[str] = []
        for row in rows:
            content = str(row["content"])
            role = str(row["role"])
            if role == "assistant":
                raw_content = content
                content = _strip_replayed_assistant_prefix(content, previous_assistants)
                previous_assistants.append(raw_content)
            stored_media = _normalize_media_items(
                json.loads(row["media_json"] or "[]"),
                username,
                project,
                project_dir=project_dir,
            )
            extracted_media = _extract_media(content, username, project, project_dir=project_dir)
            merged_media = _merge_media_items(stored_media, extracted_media)
            messages.append(
                {
                    "id": int(row["id"]),
                    "role": role,
                    "content": content,
                    "media": _filter_markdown_duplicate_images(content, merged_media),
                    "created_at": str(row["created_at"]),
                }
            )
        return messages
    finally:
        conn.close()


def add_user_message(
    username: str,
    project: str,
    content: str,
    *,
    project_dir: str | Path | None = None,
    project_state_dir: str | Path | None = None,
) -> dict[str, Any]:
    conn = _connect(_chat_db_path(username, project, project_dir, project_state_dir))
    try:
        return _append_message(conn, "user", content)
    finally:
        conn.close()


def add_assistant_message(
    username: str,
    project: str,
    content: str,
    media: list[dict[str, Any]] | None = None,
    *,
    project_dir: str | Path | None = None,
    project_state_dir: str | Path | None = None,
) -> dict[str, Any]:
    content = _redact_local_filesystem_paths(content)
    conn = _connect(_chat_db_path(username, project, project_dir, project_state_dir))
    try:
        return _append_message(conn, "assistant", content, media)
    finally:
        conn.close()


def add_trace_message(
    username: str,
    project: str,
    content: str,
    *,
    project_dir: str | Path | None = None,
    project_state_dir: str | Path | None = None,
) -> dict[str, Any]:
    conn = _connect(_chat_db_path(username, project, project_dir, project_state_dir))
    try:
        return _append_message(conn, "trace", content)
    finally:
        conn.close()


def add_trace_messages(
    username: str,
    project: str,
    contents: list[str],
    *,
    project_dir: str | Path | None = None,
    project_state_dir: str | Path | None = None,
) -> list[dict[str, Any]]:
    conn = _connect(_chat_db_path(username, project, project_dir, project_state_dir))
    try:
        messages: list[dict[str, Any]] = []
        for content in contents:
            normalized = str(content or "").strip()
            if not normalized:
                continue
            messages.append(_append_message(conn, "trace", normalized))
        return messages
    finally:
        conn.close()


def _agent_session_state_path(username: str) -> Path:
    return _user_state_dir(username) / "agent_sessions.json"


def _load_agent_session_state(username: str) -> dict[str, str]:
    path = _agent_session_state_path(username)
    if not path.exists():
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    if not isinstance(payload, dict):
        return {}
    return {
        str(key): str(value).strip() for key, value in payload.items() if str(value or "").strip()
    }


def _save_agent_session_state(username: str, payload: dict[str, str]) -> None:
    path = _agent_session_state_path(username)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_suffix(".tmp")
    tmp_path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    tmp_path.replace(path)


def _get_active_agent_session_id(username: str, backend: str) -> str | None:
    payload = _load_agent_session_state(username)
    active_backend = str(payload.get("backend", "") or "").strip()
    if active_backend != backend:
        return None
    return str(payload.get("thread_id", "") or "").strip() or None


def _set_active_agent_session_id(username: str, backend: str, thread_id: str) -> None:
    normalized = str(thread_id or "").strip()
    if not normalized:
        return
    _save_agent_session_state(
        username,
        {
            "backend": backend,
            "thread_id": normalized,
            "updated_at": _now_iso(),
        },
    )


def _get_claude_session_id(username: str, project: str) -> str | None:
    return _get_active_agent_session_id(username, "claude")


def _set_claude_session_id(username: str, project: str, session_id: str) -> None:
    _set_active_agent_session_id(username, "claude", session_id)


def _get_codex_thread_id(username: str, project: str) -> str | None:
    return _get_active_agent_session_id(username, "codex")


def _set_codex_thread_id(username: str, project: str, thread_id: str) -> None:
    _set_active_agent_session_id(username, "codex", thread_id)


def _load_api_url() -> str:
    explicit = os.environ.get("DRAMACLAW_API_URL", "").strip()
    if explicit:
        return explicit.rstrip("/")

    dedicated = os.environ.get("NOVELVIDEO_API_URL", "").strip()
    if dedicated:
        return dedicated.rstrip("/")

    api_port = os.environ.get("NOVELVIDEO_API_PORT", "").strip()
    if api_port:
        host = os.environ.get("NOVELVIDEO_API_HOST", "127.0.0.1").strip() or "127.0.0.1"
        if host in {"0.0.0.0", "::"}:
            host = "127.0.0.1"
        return f"http://{host}:{api_port}"

    legacy = os.environ.get("SUPERTALE_API_URL", "").strip()
    if legacy:
        return legacy.rstrip("/")

    ui_port = os.environ.get("NOVELVIDEO_UI_PORT", "7870").strip() or "7870"
    return f"http://127.0.0.1:{ui_port}"


PAGE_AGENT_SCOPES = [
    "projects:read",
    "projects:write",
    "tasks:submit",
    "tasks:poll",
    "media:read",
    "assets:read",
]
PAGE_AGENT_SESSION_TTL_SECONDS = 24 * 3600


async def _create_page_agent_session_token(
    username: str,
    project: str,
    *,
    agent_kind: str,
) -> str:
    token = await get_auth_session_port().create_agent_session(
        username=username,
        scopes=PAGE_AGENT_SCOPES,
        ttl_seconds=PAGE_AGENT_SESSION_TTL_SECONDS,
        agent_kind=agent_kind,
        worker_id=f"page-agent:{agent_kind}:{username}",
        current_scope_kind="project" if project else "home",
        current_project_id=project or None,
        metadata={"source": "chat_service"},
    )
    return token.value


def _project_skill_settings_payload(
    username: str,
    project: str,
    agent_token: str = "",
) -> dict[str, Any]:
    env = {
        "DRAMACLAW_USERNAME": username,
        "DRAMACLAW_AGENT_SCOPE": "user",
        "DRAMACLAW_API_URL": _load_api_url(),
        "DRAMACLAW_AGENT_TOKEN": agent_token,
        "SUPERTALE_USERNAME": username,
        "SUPERTALE_AGENT_SCOPE": "user",
        "SUPERTALE_API_URL": _load_api_url(),
        "SUPERTALE_AGENT_TOKEN": agent_token,
    }
    if project:
        env["DRAMACLAW_PROJECT_ID"] = project
        env["SUPERTALE_PROJECT_ID"] = project
    return {"env": env}


def _write_user_skill_settings(username: str, project: str, agent_token: str = "") -> None:
    workspace = _user_agent_workspace(username)
    claude_dir = workspace / ".claude"
    claude_dir.mkdir(parents=True, exist_ok=True)
    payload = _project_skill_settings_payload(username, project, agent_token)
    (claude_dir / "settings.local.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def ensure_user_claude_workspace(username: str, project: str, agent_token: str = "") -> None:
    workspace = _user_agent_workspace(username)
    claude_dir = workspace / ".claude"
    skills_dir = claude_dir / "skills"
    claude_dir.mkdir(parents=True, exist_ok=True)
    skills_dir.mkdir(parents=True, exist_ok=True)
    _write_user_skill_settings(username, project, agent_token)
    _sync_project_skills(skills_dir)


def ensure_user_codex_workspace(username: str, project: str, agent_token: str = "") -> None:
    workspace = _user_agent_workspace(username)
    codex_dir = workspace / ".codex"
    skills_dir = codex_dir / "skills"
    codex_dir.mkdir(parents=True, exist_ok=True)
    skills_dir.mkdir(parents=True, exist_ok=True)
    _sync_project_skills(skills_dir)


def _build_claude_env(username: str, project: str, agent_token: str = "") -> dict[str, str]:
    env = os.environ.copy()
    env["DRAMACLAW_USERNAME"] = username
    env["DRAMACLAW_AGENT_SCOPE"] = "user"
    env["SUPERTALE_USERNAME"] = username
    env["SUPERTALE_AGENT_SCOPE"] = "user"
    if project:
        env["DRAMACLAW_PROJECT_ID"] = project
        env["SUPERTALE_PROJECT_ID"] = project
    env["DRAMACLAW_API_URL"] = _load_api_url()
    env["SUPERTALE_API_URL"] = _load_api_url()
    env["DRAMACLAW_AGENT_TOKEN"] = agent_token
    env["SUPERTALE_AGENT_TOKEN"] = agent_token
    return env


def _build_codex_env(username: str, project: str, agent_token: str = "") -> dict[str, str]:
    env = os.environ.copy()
    env["DRAMACLAW_USERNAME"] = username
    env["DRAMACLAW_AGENT_SCOPE"] = "user"
    env["SUPERTALE_USERNAME"] = username
    env["SUPERTALE_AGENT_SCOPE"] = "user"
    if project:
        env["DRAMACLAW_PROJECT_ID"] = project
        env["SUPERTALE_PROJECT_ID"] = project
    env["DRAMACLAW_API_URL"] = _load_api_url()
    env["SUPERTALE_API_URL"] = _load_api_url()
    env["DRAMACLAW_AGENT_TOKEN"] = agent_token
    env["SUPERTALE_AGENT_TOKEN"] = agent_token
    return env


def _extract_media(
    content: str,
    username: str,
    project: str,
    *,
    project_dir: str | Path | None = None,
) -> list[dict[str, str]]:
    media_project_dir = _media_project_dir(username, project, project_dir)
    items: list[dict[str, str]] = []
    seen: set[str] = set()
    markdown_images = _collect_markdown_image_refs(content)

    def add_item(raw_url: str, path: str | None = None) -> None:
        candidate = raw_url.strip(".,;)]}")
        parsed = urlparse(candidate)
        if parsed.scheme in {"http", "https"} and parsed.path.startswith("/static/"):
            candidate = parsed.path
        if candidate.startswith("/static/"):
            canonical = _canonical_project_static_media_url(project, media_project_dir, candidate)
            if canonical is None:
                return
            candidate, path = canonical
        ext = Path(urlparse(candidate).path).suffix.lower()
        kind = _MEDIA_EXTENSIONS.get(ext)
        if not kind:
            return
        if kind == "image" and (
            candidate in markdown_images
            or (path and path in markdown_images)
            or (path and path.lstrip("./") in markdown_images)
        ):
            return
        effective_path = path or ""
        if not effective_path:
            effective_path = _media_path_from_static_url(candidate) or ""
        key = f"{kind}:{effective_path or candidate}"
        if key in seen:
            return
        seen.add(key)
        items.append(
            {
                "kind": kind,
                "url": candidate,
                "path": effective_path,
                "label": Path(effective_path or candidate).name,
            }
        )

    for match in _URL_RE.finditer(content):
        url = match.group(1)
        if url.startswith("/static/"):
            add_item(url)
        else:
            add_item(url)

    for match in _REL_PATH_RE.finditer(content):
        rel_path = match.group("path")
        full_path = media_project_dir / rel_path
        if full_path.exists():
            static_url = project_static_url(project, rel_path, local_path=full_path)
            add_item(static_url, rel_path)

    return items


def _collect_markdown_image_refs(content: str) -> set[str]:
    refs: set[str] = set()

    for match in _MARKDOWN_IMAGE_RE.finditer(content):
        raw = (match.group(1) or "").strip().strip("<>").strip(".,;)]}")
        if not raw:
            continue
        refs.add(raw)
        parsed = urlparse(raw)
        path = parsed.path if parsed.scheme in {"http", "https"} else raw.split("?", 1)[0]
        if path:
            refs.add(path)
        static_path = _media_path_from_static_url(raw)
        if static_path:
            refs.add(static_path)
            refs.add(static_path.lstrip("./"))
        elif parsed.scheme in {"http", "https"} and parsed.path.startswith("/static/"):
            refs.add(parsed.path)
        elif raw.startswith("/static/"):
            refs.add(raw.split("?", 1)[0])
        else:
            refs.add(path.lstrip("./") if path else raw.lstrip("./"))

    return refs


def _normalize_media_items(
    media: list[dict[str, Any]],
    username: str,
    project: str,
    *,
    project_dir: str | Path | None = None,
) -> list[dict[str, str]]:
    normalized: list[dict[str, str]] = []
    seen: set[str] = set()
    media_project_dir = _media_project_dir(username, project, project_dir)

    for item in media:
        if not isinstance(item, dict):
            continue

        candidate = str(item.get("url", "") or "").strip()
        path = str(item.get("path", "") or "").strip()
        if not candidate and not path:
            continue

        if not candidate and path:
            canonical = _canonical_project_static_media_url(project, media_project_dir, path)
            if canonical is None:
                continue
            candidate, path = canonical

        parsed = urlparse(candidate)
        if parsed.scheme in {"http", "https"} and parsed.path.startswith("/static/"):
            candidate = parsed.path
        if candidate.startswith("/static/"):
            canonical = _canonical_project_static_media_url(project, media_project_dir, candidate)
            if canonical is None:
                continue
            candidate, path = canonical

        ext = Path(urlparse(candidate).path).suffix.lower()
        kind = _MEDIA_EXTENSIONS.get(ext)
        if not kind:
            continue

        if not path:
            path = _media_path_from_static_url(candidate) or ""

        key = f"{kind}:{path or candidate}"
        if key in seen:
            continue
        seen.add(key)

        normalized.append(
            {
                "kind": kind,
                "url": candidate,
                "path": path,
                "label": str(item.get("label", "") or Path(path or candidate).name),
            }
        )

    return normalized


def _merge_media_items(*groups: list[dict[str, str]]) -> list[dict[str, str]]:
    merged: list[dict[str, str]] = []
    seen: set[str] = set()

    for group in groups:
        for item in group:
            kind = str(item.get("kind", "") or "").strip()
            url = str(item.get("url", "") or "").strip()
            path = str(item.get("path", "") or "").strip()
            if not kind or not url:
                continue
            key = f"{kind}:{path or url}"
            if key in seen:
                continue
            seen.add(key)
            merged.append(
                {
                    "kind": kind,
                    "url": url,
                    "path": path,
                    "label": str(item.get("label", "") or Path(path or url).name),
                }
            )

    return merged


def _filter_markdown_duplicate_images(
    content: str, media: list[dict[str, str]]
) -> list[dict[str, str]]:
    markdown_images = _collect_markdown_image_refs(content)
    if not markdown_images:
        return media

    filtered: list[dict[str, str]] = []
    for item in media:
        kind = str(item.get("kind", "") or "").strip()
        if kind != "image":
            filtered.append(item)
            continue

        url = str(item.get("url", "") or "").strip()
        path = str(item.get("path", "") or "").strip()
        if (
            url in markdown_images
            or (path and path in markdown_images)
            or (path and path.lstrip("./") in markdown_images)
        ):
            continue
        filtered.append(item)

    return filtered


def _build_claude_thread(username: str, project: str, agent_token: str):
    ensure_user_claude_workspace(username, project, agent_token)
    workspace = _user_agent_workspace(username)
    client = ClaudeSdkClient(
        cli_path=_claude_cli_path(),
        cwd=workspace,
        env=_build_claude_env(username, project, agent_token),
        model=_claude_model(),
    )
    session_id = _get_claude_session_id(username, project)
    return client.thread_resume(session_id) if session_id else client.thread_start()


def _dramaclaw_mcp_servers() -> dict[str, dict[str, Any]]:
    return {
        "dramaclaw": {
            "type": "stdio",
            "command": sys.executable,
            "args": ["-m", "novelvideo.chat.dramaclaw_mcp"],
        }
    }


def _codex_mcp_config_overrides(mcp_servers: dict[str, dict[str, Any]]) -> tuple[str, ...]:
    overrides: list[str] = []
    for name, server in sorted(mcp_servers.items()):
        if str(server.get("type") or "stdio") != "stdio":
            raise ValueError(f"unsupported Codex MCP server type for {name}: {server.get('type')}")
        command = str(server.get("command") or "").strip()
        if not command:
            raise ValueError(f"Codex MCP server {name} is missing command")
        args = server.get("args") or []
        if not isinstance(args, list):
            raise ValueError(f"Codex MCP server {name} args must be a list")
        prefix = f"mcp_servers.{name}"
        overrides.append(f"{prefix}.command={json.dumps(command, ensure_ascii=False)}")
        overrides.append(
            f"{prefix}.args={json.dumps([str(arg) for arg in args], ensure_ascii=False, separators=(',', ':'))}"
        )
        overrides.append(f"{prefix}.enabled=true")
    return tuple(overrides)


def _build_codex_thread(username: str, project: str, agent_token: str):
    ensure_user_codex_workspace(username, project, agent_token)
    workspace = _user_agent_workspace(username)
    client = CodexClient(
        codex_bin=_codex_bin_path(),
        cwd=workspace,
        env=_build_codex_env(username, project, agent_token),
        model=_codex_model(),
        config_overrides=_codex_mcp_config_overrides(_dramaclaw_mcp_servers()),
    )
    thread_id = _get_codex_thread_id(username, project)
    return client.thread_resume(thread_id) if thread_id else client.thread_start()


async def interrupt_chat_turn(username: str, project: str, thread_id: str, turn_id: str) -> bool:
    thread_id = str(thread_id or "").strip()
    turn_id = str(turn_id or "").strip()
    backend = _chat_backend()
    if backend == "claude":
        if not thread_id:
            return False
        try:
            return await interrupt_live_claude_client(thread_id)
        except Exception as exc:
            if "closed stdout" in str(exc):
                return True
            raise
    if backend == "codex":
        if not thread_id or not turn_id:
            return False
        try:
            return await asyncio.to_thread(interrupt_live_codex_turn, thread_id, turn_id)
        except Exception as exc:
            if "app-server closed stdout" in str(exc):
                return True
            raise
    return False


async def stream_assistant_reply(
    username: str,
    project: str,
    prompt: str,
    on_event,
    *,
    project_dir: str | Path | None = None,
    project_state_dir: str | Path | None = None,
) -> dict[str, Any]:
    run_lock_id = _acquire_chat_run_lock(username, project)
    heartbeat_task = asyncio.create_task(
        _chat_run_lock_heartbeat_loop(username, project, run_lock_id)
    )
    try:
        deterministic = _frontend_context_reply(prompt)
        if deterministic is not None:
            return await _stream_deterministic_assistant_reply(
                username,
                project,
                deterministic,
                on_event,
                project_dir=project_dir,
                project_state_dir=project_state_dir,
            )
        model_prompt = _script_creation_model_reply_prompt(prompt) or prompt
        backend = _chat_backend()
        if backend == "codex":
            return await _stream_assistant_reply_codex(
                username,
                project,
                model_prompt,
                on_event,
                project_dir=project_dir,
                project_state_dir=project_state_dir,
            )
        if backend == "hermes":
            return await _stream_assistant_reply_hermes(
                username,
                project,
                model_prompt,
                on_event,
                project_dir=project_dir,
                project_state_dir=project_state_dir,
            )
        if backend != "claude":
            raise RuntimeError(f"Unsupported chat backend: {backend}")
        return await _stream_assistant_reply_claude(
            username,
            project,
            model_prompt,
            on_event,
            project_dir=project_dir,
            project_state_dir=project_state_dir,
        )
    finally:
        heartbeat_task.cancel()
        try:
            await heartbeat_task
        except asyncio.CancelledError:
            pass
        _release_chat_run_lock(username, project, run_lock_id)


def _frontend_context_reply(prompt: str) -> str | None:
    confirmation = _REINGEST_CONFIRMATION_BLOCK_RE.search(prompt)
    if confirmation:
        body = confirmation.group(1)
        if re.search(r"(?m)^\s*stage:\s*confirm_clear\s*$", body):
            return (
                "覆盖会清空/重建当前项目已有角色、分集、脚本、草图、音频、视频等"
                "流水线结果。是否继续？\n\n请回复 `确定` 或 `继续` 后才会开始覆盖。"
            )
        return (
            "当前项目已有摄入内容，继续会覆盖现有项目。是否要覆盖当前项目？\n\n"
            "请回复 `覆盖` 进入下一步确认。"
        )

    return None


def _script_creation_model_reply_prompt(prompt: str) -> str | None:
    if not prompt:
        return None
    if _DRAMACLAW_INGEST_AUTOMATION_RE.search(prompt):
        return None
    if _CHAT_ATTACHMENTS_BLOCK_RE.search(prompt):
        return None

    text = _CHAT_ATTACHMENTS_BLOCK_RE.sub("", prompt).strip()
    if _CONTINUE_PIPELINE_RE.search(text):
        return None
    if _SCRIPT_CREATION_REQUEST_RE.search(text) or _STYLE_SHORT_DRAMA_REQUEST_RE.search(text):
        return (
            f"{_DRAMACLAW_SCRIPT_UPLOAD_MODEL_REPLY_INSTRUCTIONS}"
            f"\n\n用户原话：{text}"
        )
    return None


async def _stream_deterministic_assistant_reply(
    username: str,
    project: str,
    content: str,
    on_event,
    *,
    project_dir: str | Path | None = None,
    project_state_dir: str | Path | None = None,
) -> dict[str, Any]:
    content = _redact_local_filesystem_paths(content)
    message = add_assistant_message(
        username,
        project,
        content,
        [],
        project_dir=project_dir,
        project_state_dir=project_state_dir,
    )
    await _emit_chat_event_best_effort(on_event, {"type": "assistant_delta", "text": content})
    await _emit_chat_event_best_effort(on_event, {"type": "done", "message": message})
    return message


async def prewarm_chat_backend(username: str, *, project: str | None = None) -> None:
    """Best-effort pre-warm of the per-user agent worker.

    Called when the user opens a chat / switches project so the first real
    message doesn't pay the full cold-start (spawn → initialize → session/new
    with startup probes). No-op unless the hermes backend is active; never
    raises — pre-warming is purely an optimization.
    """
    try:
        if _chat_backend() != "hermes":
            return
        from novelvideo.chat.hermes_pool import pool as _hermes_pool

        await _hermes_pool.prewarm(
            username,
            scope_kind="project" if project else "home",
            project_id=project or None,
        )
    except Exception:
        return


async def _stream_assistant_reply_hermes(
    username: str,
    project: str,
    prompt: str,
    on_event,
    *,
    project_dir: str | Path | None = None,
    project_state_dir: str | Path | None = None,
) -> dict[str, Any]:
    """Stream via Hermes ACP subprocess (per-user, sandboxed).

    Differs from claude/codex paths:
    - Hermes is per-USER not per-(user, project). Project context is injected
      as a prompt prefix via `current_project=project`.
    - No per-project chat.db session id; HermesPool owns the thread lifecycle.
    """
    from novelvideo.chat.hermes_pool import pool as _hermes_pool

    agent_prompt = _prompt_with_user_context(username, project, prompt)
    thread = await _hermes_pool.get_for_user(
        username,
        scope_kind="project" if project else "home",
        project_id=project or None,
    )
    previous_assistant = (
        _assistant_history_contents(
            username,
            project,
            project_dir=project_dir,
            project_state_dir=project_state_dir,
        ) if project else []
    )
    previous_trace = (
        _trace_history_contents(
            username,
            project,
            project_dir=project_dir,
            project_state_dir=project_state_dir,
        ) if project else []
    )
    assistant_text = ""
    tool_text = ""
    tool_ui_specs: list[dict[str, Any]] = []
    fallback_tool_ui_specs: list[dict[str, Any]] = []
    fallback_token: str | None = None
    current_tool_name: str | None = None
    current_tool_hidden = False
    persisted_message: dict[str, Any] | None = None
    seen_display_calls: set[str] = set()
    seen_tool_chat_errors: set[str] = set()

    def persist_partial_reply() -> dict[str, Any] | None:
        nonlocal persisted_message, assistant_text, tool_text
        if persisted_message is not None:
            return persisted_message
        final_text = _strip_replayed_chat_response(
            assistant_text, previous_assistant, prompt
        ).strip()
        all_tool_ui_specs = _dedupe_tool_ui_specs([*tool_ui_specs, *fallback_tool_ui_specs])
        all_tool_ui_specs = _filter_tool_ui_specs_for_prompt(prompt, all_tool_ui_specs)
        final_text = _append_tool_ui_specs(final_text, all_tool_ui_specs)
        if not final_text:
            return None
        final_text = _normalize_json_render_reply(final_text)
        final_tool_text = _strip_replayed_assistant_prefix(tool_text, previous_trace)
        if final_tool_text.strip():
            add_trace_messages(
                username,
                project,
                _split_trace_contents(final_tool_text),
                project_dir=project_dir,
                project_state_dir=project_state_dir,
            )
        media = _extract_media(final_text, username, project, project_dir=project_dir)
        persisted_message = add_assistant_message(
            username,
            project,
            final_text,
            media,
            project_dir=project_dir,
            project_state_dir=project_state_dir,
        )
        return persisted_message

    try:
        async for event in thread.stream(agent_prompt, current_project=project or None):
            if event.type == "thread_started":
                await _emit_chat_event_best_effort(
                    on_event,
                    {
                        "type": "thread_started",
                        "thread_id": str(event.thread_id or "").strip() or None,
                        "turn_id": str(event.turn_id or "").strip() or None,
                    },
                )
                continue
            if event.type == "assistant_delta":
                assistant_text = _merge_stream_text(assistant_text, event.text)
                streamed_text = _strip_replayed_chat_response(
                    assistant_text,
                    previous_assistant,
                    prompt,
                    suppress_partial_replay=True,
                )
                streamed_text = _redact_local_filesystem_paths(streamed_text)
                await _emit_chat_event_best_effort(
                    on_event,
                    {
                        "type": "assistant_delta",
                        "text": streamed_text,
                    },
                )
                continue
            if event.type == "tool_update":
                if event.raw is not None:
                    tool_chat_error = _extract_tool_chat_error(event.raw)
                    if tool_chat_error and tool_chat_error not in seen_tool_chat_errors:
                        seen_tool_chat_errors.add(tool_chat_error)
                        assistant_text = _merge_stream_text(
                            assistant_text,
                            ("\n\n" if assistant_text.strip() else "") + tool_chat_error,
                        )
                        await _emit_chat_event_best_effort(
                            on_event,
                            {
                                "type": "assistant_delta",
                                "text": _redact_local_filesystem_paths(tool_chat_error),
                            },
                        )
                    tool_ui_specs.extend(_extract_tool_ui_specs(event.raw))
                    display_call = _extract_display_tool_call(event.raw)
                    if display_call is not None:
                        tool_name, tool_args = display_call
                        display_call_key = _display_tool_call_key(tool_name, tool_args)
                        if display_call_key in seen_display_calls:
                            logger.info(
                                "filtered duplicate hermes display fallback "
                                "turn_id=%s project=%s tool=%s args=%s raw_kind=%s",
                                event.turn_id,
                                project,
                                tool_name,
                                json.dumps(
                                    tool_args,
                                    ensure_ascii=False,
                                    sort_keys=True,
                                    default=str,
                                )[:1000],
                                event.raw.get("sessionUpdate") if isinstance(event.raw, dict) else None,
                            )
                        else:
                            seen_display_calls.add(display_call_key)
                            if fallback_token is None:
                                fallback_token = await _create_page_agent_session_token(
                                    username,
                                    project,
                                    agent_kind="hermes-display-fallback",
                                )
                            fallback_tool_ui_specs.extend(
                                await _fallback_display_tool_ui_specs(
                                    username,
                                    project,
                                    tool_name,
                                    tool_args,
                                    token=fallback_token,
                                    project_dir=project_dir,
                                )
                            )
                if event.name:
                    current_tool_name = event.name
                    current_tool_hidden = _is_hidden_chat_tool_event(event.name, event.text)
                if current_tool_hidden or _is_hidden_chat_tool_event(current_tool_name, event.text):
                    continue
                tool_text += str(event.text or "") + "\n"
                display_tool_text = _strip_replayed_assistant_prefix(tool_text, previous_trace)
                if display_tool_text.strip():
                    await _emit_chat_event_best_effort(
                        on_event,
                        {
                            "type": "tool_update",
                            "text": display_tool_text,
                            "name": current_tool_name,
                        },
                    )
                continue
            if event.type == "complete":
                if seen_tool_chat_errors and assistant_text.strip():
                    continue
                assistant_text = _completion_text_or_existing(event.text, assistant_text)

        if not assistant_text.strip():
            assistant_text = "(hermes returned no content)"
        if not tool_ui_specs and not fallback_tool_ui_specs:
            inferred_display_call = _infer_display_tool_call_from_text(
                prompt,
                assistant_text,
                previous_assistant,
            )
            if inferred_display_call is not None:
                tool_name, tool_args = inferred_display_call
                if fallback_token is None:
                    fallback_token = await _create_page_agent_session_token(
                        username,
                        project,
                        agent_kind="hermes-display-fallback",
                    )
                fallback_tool_ui_specs.extend(
                    await _fallback_display_tool_ui_specs(
                        username,
                        project,
                        tool_name,
                        tool_args,
                        token=fallback_token,
                        project_dir=project_dir,
                    )
                )
        result_message = persist_partial_reply()
        if result_message is None:
            result_message = add_assistant_message(
                username,
                project,
                "(hermes returned no content)",
                [],
                project_dir=project_dir,
                project_state_dir=project_state_dir,
            )
            persisted_message = result_message
        await _emit_chat_event_best_effort(
            on_event,
            {"type": "assistant_message", "message": result_message},
        )
        await _emit_chat_event_best_effort(on_event, {"type": "done", "message": result_message})
        return result_message
    except Exception:
        raise
    finally:
        persist_partial_reply()


async def _stream_assistant_reply_claude(
    username: str,
    project: str,
    prompt: str,
    on_event,
    *,
    project_dir: str | Path | None = None,
    project_state_dir: str | Path | None = None,
) -> dict[str, Any]:
    try:
        agent_token = await _create_page_agent_session_token(
            username,
            project,
            agent_kind="claude",
        )
        thread = _build_claude_thread(username, project, agent_token)
        agent_prompt = _prompt_with_user_context(username, project, prompt)
        assistant_text = ""
        tool_text = ""
        async for event in thread.stream(agent_prompt):
            if event.type == "thread_started":
                thread_id = str(event.thread_id or "").strip() or None
                if thread_id:
                    _set_claude_session_id(username, project, thread_id)
                await on_event(
                    {
                        "type": "thread_started",
                        "thread_id": thread_id,
                        "turn_id": str(event.turn_id or "").strip() or None,
                    }
                )
                continue
            if event.type == "assistant_delta":
                assistant_text = _merge_stream_text(assistant_text, event.text)
                streamed_text = _redact_local_filesystem_paths(assistant_text)
                await on_event(
                    {
                        "type": "assistant_delta",
                        "text": streamed_text,
                    }
                )
                continue
            if event.type == "tool_update":
                tool_text = str(event.text or "")
                await on_event({"type": "tool_update", "text": tool_text})
                continue
            if event.type == "complete":
                thread_id = str(event.thread_id or "").strip() or None
                if thread_id:
                    _set_claude_session_id(username, project, thread_id)
                assistant_text = _completion_text_or_existing(event.text, assistant_text)

        assistant_text = assistant_text.strip() or "已执行，但没有返回正文。"
        assistant_text = _normalize_json_render_reply(assistant_text)
        if tool_text.strip():
            add_trace_messages(
                username,
                project,
                _split_trace_contents(tool_text),
                project_dir=project_dir,
                project_state_dir=project_state_dir,
            )
        media = _extract_media(assistant_text, username, project, project_dir=project_dir)
        result_message = add_assistant_message(
            username,
            project,
            assistant_text,
            media,
            project_dir=project_dir,
            project_state_dir=project_state_dir,
        )
        await on_event({"type": "done", "message": result_message})
        return result_message
    except Exception:
        raise


async def _stream_assistant_reply_codex(
    username: str,
    project: str,
    prompt: str,
    on_event,
    *,
    project_dir: str | Path | None = None,
    project_state_dir: str | Path | None = None,
) -> dict[str, Any]:
    assistant_text = ""
    tool_text = ""
    agent_token = await _create_page_agent_session_token(
        username,
        project,
        agent_kind="codex",
    )
    thread = _build_codex_thread(username, project, agent_token)
    agent_prompt = _prompt_with_user_context(username, project, prompt)
    async for event in thread.stream(agent_prompt):
        if event.type == "thread_started":
            thread_id = str(event.thread_id or "").strip() or None
            if thread_id:
                _set_codex_thread_id(username, project, thread_id)
            await on_event(
                {
                    "type": "thread_started",
                    "thread_id": thread_id,
                    "turn_id": str(event.turn_id or "").strip() or None,
                }
            )
            continue
        if event.type == "assistant_delta":
            assistant_text = _merge_stream_text(assistant_text, event.text)
            streamed_text = _redact_local_filesystem_paths(assistant_text)
            await on_event(
                {
                    "type": "assistant_delta",
                    "text": streamed_text,
                }
            )
            continue
        if event.type == "tool_update":
            tool_text += str(event.text or "")
            await on_event({"type": "tool_update", "text": tool_text})
            continue
        if event.type == "complete":
            thread_id = str(event.thread_id or "").strip() or None
            if thread_id:
                _set_codex_thread_id(username, project, thread_id)
            assistant_text = _completion_text_or_existing(event.text, assistant_text)

    assistant_text = assistant_text.strip() or "已执行，但没有返回正文。"
    assistant_text = _normalize_json_render_reply(assistant_text)
    if tool_text.strip():
        add_trace_messages(
            username,
            project,
            _split_trace_contents(tool_text),
            project_dir=project_dir,
            project_state_dir=project_state_dir,
        )
    media = _extract_media(assistant_text, username, project, project_dir=project_dir)
    result_message = add_assistant_message(
        username,
        project,
        assistant_text,
        media,
        project_dir=project_dir,
        project_state_dir=project_state_dir,
    )
    await on_event({"type": "done", "message": result_message})
    return result_message


async def generate_assistant_reply(username: str, project: str, prompt: str) -> dict[str, Any]:
    async def _ignore(_event: dict[str, Any]) -> None:
        return None

    return await stream_assistant_reply(username, project, prompt, _ignore)
