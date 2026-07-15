"""Provision channels and relay tokens in a user-managed NewAPI instance."""

from __future__ import annotations

import json
import os
import secrets
import sqlite3
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlparse

import httpx

from novelvideo.model_gateway_settings import (
    build_newapi_embedding_model_status,
    build_newapi_media_model_mappings_status,
    build_newapi_provider_channels_status,
    build_newapi_database_status,
    get_model_gateway_settings,
    normalize_relay_base_url,
)

PROVIDER_PRESETS: dict[str, dict[str, Any]] = {
    "openai": {"label": "OpenAI", "type": 1, "base_url": "https://api.openai.com"},
    "midjourney": {
        "label": "Midjourney",
        "type": 2,
        "base_url": "https://oa.api2d.net",
    },
    "azure": {"label": "Azure", "type": 3, "base_url": ""},
    "ollama": {"label": "Ollama", "type": 4, "base_url": "http://localhost:11434"},
    "midjourneyplus": {
        "label": "MidjourneyPlus",
        "type": 5,
        "base_url": "https://api.openai-sb.com",
    },
    "openaimax": {
        "label": "OpenAIMax",
        "type": 6,
        "base_url": "https://api.openaimax.com",
    },
    "ohmygpt": {"label": "OhMyGPT", "type": 7, "base_url": "https://api.ohmygpt.com"},
    "custom": {"label": "Custom", "type": 8, "base_url": ""},
    "ails": {"label": "AILS", "type": 9, "base_url": "https://api.caipacity.com"},
    "aiproxy": {"label": "AIProxy", "type": 10, "base_url": "https://api.aiproxy.io"},
    "palm": {"label": "PaLM", "type": 11, "base_url": ""},
    "api2gpt": {"label": "API2GPT", "type": 12, "base_url": "https://api.api2gpt.com"},
    "aigc2d": {"label": "AIGC2D", "type": 13, "base_url": "https://api.aigc2d.com"},
    "anthropic": {
        "label": "Anthropic",
        "type": 14,
        "base_url": "https://api.anthropic.com",
    },
    "baidu": {"label": "Baidu", "type": 15, "base_url": "https://aip.baidubce.com"},
    "zhipu": {"label": "Zhipu", "type": 16, "base_url": "https://open.bigmodel.cn"},
    "ali": {"label": "Ali", "type": 17, "base_url": "https://dashscope.aliyuncs.com"},
    "xunfei": {"label": "Xunfei", "type": 18, "base_url": ""},
    "360": {"label": "360", "type": 19, "base_url": "https://api.360.cn"},
    "openrouter": {
        "label": "OpenRouter",
        "type": 20,
        "base_url": "https://openrouter.ai/api",
    },
    "aiproxylibrary": {
        "label": "AIProxyLibrary",
        "type": 21,
        "base_url": "https://api.aiproxy.io",
    },
    "fastgpt": {
        "label": "FastGPT",
        "type": 22,
        "base_url": "https://fastgpt.run/api/openapi",
    },
    "tencent": {
        "label": "Tencent",
        "type": 23,
        "base_url": "https://hunyuan.tencentcloudapi.com",
    },
    "gemini": {
        "label": "Gemini",
        "type": 24,
        "base_url": "https://generativelanguage.googleapis.com",
    },
    "moonshot": {
        "label": "Moonshot",
        "type": 25,
        "base_url": "https://api.moonshot.cn",
    },
    "zhipuv4": {"label": "ZhipuV4", "type": 26, "base_url": "https://open.bigmodel.cn"},
    "perplexity": {
        "label": "Perplexity",
        "type": 27,
        "base_url": "https://api.perplexity.ai",
    },
    "lingyiwanwu": {
        "label": "LingYiWanWu",
        "type": 31,
        "base_url": "https://api.lingyiwanwu.com",
    },
    "aws": {"label": "AWS", "type": 33, "base_url": ""},
    "cohere": {"label": "Cohere", "type": 34, "base_url": "https://api.cohere.ai"},
    "minimax": {"label": "MiniMax", "type": 35, "base_url": "https://api.minimax.chat"},
    "sunoapi": {"label": "SunoAPI", "type": 36, "base_url": ""},
    "dify": {"label": "Dify", "type": 37, "base_url": "https://api.dify.ai"},
    "jina": {"label": "Jina", "type": 38, "base_url": "https://api.jina.ai"},
    "cloudflare": {
        "label": "Cloudflare",
        "type": 39,
        "base_url": "https://api.cloudflare.com",
    },
    "siliconflow": {
        "label": "SiliconFlow",
        "type": 40,
        "base_url": "https://api.siliconflow.cn",
    },
    "vertexai": {"label": "VertexAI", "type": 41, "base_url": ""},
    "mistral": {"label": "Mistral", "type": 42, "base_url": "https://api.mistral.ai"},
    "deepseek": {
        "label": "DeepSeek",
        "type": 43,
        "base_url": "https://api.deepseek.com",
    },
    "mokaai": {"label": "MokaAI", "type": 44, "base_url": "https://api.moka.ai"},
    "volcengine": {
        "label": "VolcEngine",
        "type": 45,
        "base_url": "https://ark.cn-beijing.volces.com",
    },
    "baiduv2": {
        "label": "BaiduV2",
        "type": 46,
        "base_url": "https://qianfan.baidubce.com",
    },
    "xinference": {"label": "Xinference", "type": 47, "base_url": ""},
    "xai": {"label": "xAI", "type": 48, "base_url": "https://api.x.ai"},
    "coze": {"label": "Coze", "type": 49, "base_url": "https://api.coze.cn"},
    "kling": {"label": "Kling", "type": 50, "base_url": "https://api.klingai.com"},
    "jimeng": {
        "label": "Jimeng",
        "type": 51,
        "base_url": "https://visual.volcengineapi.com",
    },
    "vidu": {"label": "Vidu", "type": 52, "base_url": "https://api.vidu.cn"},
    "submodel": {
        "label": "Submodel",
        "type": 53,
        "base_url": "https://llm.submodel.ai",
    },
    "doubaovideo": {
        "label": "DoubaoVideo",
        "type": 54,
        "base_url": "https://ark.cn-beijing.volces.com",
    },
    "sora": {"label": "Sora", "type": 55, "base_url": "https://api.openai.com"},
    "replicate": {
        "label": "Replicate",
        "type": 56,
        "base_url": "https://api.replicate.com",
    },
    "codex": {"label": "Codex", "type": 57, "base_url": "https://chatgpt.com"},
}


@dataclass(frozen=True)
class NewApiProvisionerConfig:
    admin_base_url: str
    sql_dsn: str
    sqlite_path: str
    admin_username: str
    init_timeout_ms: int
    relay_token_name: str


@dataclass(frozen=True)
class AdminToken:
    admin_user_id: int
    admin_username: str
    access_token: str
    token_created: bool


@dataclass(frozen=True)
class NewApiSetupCredentials:
    username: str = ""
    password: str = ""
    confirm_password: str = ""
    self_use_mode_enabled: bool = True
    demo_site_enabled: bool = False


@dataclass(frozen=True)
class NewApiSetupStatus:
    initialized: bool
    root_initialized: bool
    database_type: str = ""
    setup_performed: bool = False
    already_initialized: bool = False


class NewApiDB:
    def __init__(self, kind: str, conn: Any):
        self.kind = kind
        self.conn = conn

    def _sql(self, sql: str) -> str:
        if self.kind in {"postgres", "mysql"}:
            return sql.replace("?", "%s")
        return sql

    def query(self, sql: str, params: tuple[Any, ...] = ()) -> list[dict[str, Any]]:
        cursor = self.conn.cursor()
        try:
            cursor.execute(self._sql(sql), params)
            columns = [item[0] for item in cursor.description or []]
            return [dict(zip(columns, row)) for row in cursor.fetchall()]
        finally:
            cursor.close()

    def exec(self, sql: str, params: tuple[Any, ...] = ()) -> None:
        cursor = self.conn.cursor()
        try:
            cursor.execute(self._sql(sql), params)
            self.conn.commit()
        finally:
            cursor.close()

    def close(self) -> None:
        self.conn.close()


def env_bool(name: str, default: bool = False) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def provisioner_enabled() -> bool:
    return env_bool("NEWAPI_PROVISIONER_ENABLED", True)


def require_provisioner_enabled() -> None:
    if not provisioner_enabled():
        raise PermissionError("NEWAPI_PROVISIONER_ENABLED is not enabled")


def normalize_admin_base_url(value: str | None) -> str:
    base = str(value or "").strip().rstrip("/")
    if base.endswith("/v1"):
        base = base[:-3].rstrip("/")
    return base


def mask_token(token: str) -> str:
    clean = str(token or "").strip()
    if not clean:
        return ""
    if len(clean) <= 10:
        return "*" * len(clean)
    return f"{clean[:4]}...{clean[-4:]}"


def full_api_key(key: str) -> str:
    clean = key.strip()
    if clean.startswith("sk-"):
        return clean
    return f"sk-{clean}"


def random_token(length: int = 32) -> str:
    alphabet = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"
    return "".join(secrets.choice(alphabet) for _ in range(length))


def normalize_group(group: str | None) -> str:
    parts = [
        item.strip() for item in str(group or "default").split(",") if item.strip()
    ]
    unique = list(dict.fromkeys(parts or ["default"]))
    return f",{','.join(unique)},"


def validate_model_mapping(model_mapping: dict[str, str]) -> list[str]:
    if not isinstance(model_mapping, dict) or not model_mapping:
        raise ValueError("modelMapping must be a non-empty JSON object")
    keys: list[str] = []
    for key, value in model_mapping.items():
        clean_key = str(key or "").strip()
        if not clean_key:
            raise ValueError("modelMapping contains an empty model name")
        if not isinstance(value, str) or not value.strip():
            raise ValueError(f"modelMapping.{clean_key} must be a non-empty string")
        keys.append(clean_key)
    return keys


def _first_non_empty(*values: str | None) -> str:
    for value in values:
        clean = str(value or "").strip()
        if clean:
            return clean
    return ""


def _ce_sqlite_path() -> str:
    """Return the managed CE NewAPI SQLite database path."""
    from novelvideo.config import STATE_DIR

    return str(Path(STATE_DIR) / "newapi" / "one-api.db")


def get_provisioner_config(
    admin_base_url: str | None = None,
    *,
    sql_dsn: str | None = None,
    sqlite_path: str | None = None,
    admin_username: str | None = None,
) -> NewApiProvisionerConfig:
    settings = get_model_gateway_settings()
    request_sql_dsn = str(sql_dsn or "").strip()
    saved_sql_dsn = str(settings.get("custom_newapi_db_sql_dsn", "")).strip()
    env_sql_dsn = str(os.environ.get("NEWAPI_SQL_DSN", "")).strip()
    if request_sql_dsn:
        resolved_sql_dsn = request_sql_dsn
        resolved_sqlite_path = str(sqlite_path or "").strip()
    elif saved_sql_dsn:
        resolved_sql_dsn = saved_sql_dsn
        resolved_sqlite_path = str(
            settings.get("custom_newapi_db_sqlite_path", "")
        ).strip()
    else:
        resolved_sql_dsn = env_sql_dsn or "local"
        resolved_sqlite_path = (
            str(os.environ.get("NEWAPI_SQLITE_PATH", "")).strip()
            or _ce_sqlite_path()
        )
    return NewApiProvisionerConfig(
        admin_base_url=normalize_admin_base_url(
            _first_non_empty(
                admin_base_url,
                settings.get("custom_newapi_admin_base_url"),
                os.environ.get("NEWAPI_ADMIN_BASE_URL", ""),
                "http://127.0.0.1:3000",
            )
        ),
        sql_dsn=resolved_sql_dsn,
        sqlite_path=resolved_sqlite_path,
        admin_username=(
            _first_non_empty(
                admin_username,
                settings.get("custom_newapi_admin_username"),
                os.environ.get("NEWAPI_ADMIN_USERNAME", "root"),
            )
            or "root"
        ),
        init_timeout_ms=int(
            os.environ.get("NEWAPI_PROVISIONER_INIT_TIMEOUT_MS", "120000")
        ),
        relay_token_name=(
            os.environ.get("NEWAPI_RELAY_TOKEN_NAME", "dramaclaw-ce-runtime").strip()
            or "dramaclaw-ce-runtime"
        ),
    )


def open_newapi_db(cfg: NewApiProvisionerConfig) -> NewApiDB:
    dsn = cfg.sql_dsn.strip()
    if not dsn:
        raise RuntimeError(
            "NEWAPI_SQL_DSN is required; set it to a Postgres/MySQL DSN, "
            "an existing SQLite DB path, or 'local' with NEWAPI_SQLITE_PATH"
        )
    if (
        dsn == "local"
        or dsn.endswith((".db", ".sqlite", ".sqlite3"))
        or dsn.startswith("file:")
    ):
        path = cfg.sqlite_path if dsn == "local" else dsn.removeprefix("file:")
        if not path:
            raise RuntimeError(
                "NEWAPI_SQLITE_PATH is required when NEWAPI_SQL_DSN=local"
            )
        if not Path(path).expanduser().is_file():
            raise RuntimeError(f"NewAPI SQLite database does not exist: {path}")
        return NewApiDB("sqlite", sqlite3.connect(path))

    if dsn.startswith(("postgresql://", "postgres://")):
        try:
            import psycopg
        except ImportError as exc:
            raise RuntimeError("missing dependency: install psycopg[binary]") from exc
        return NewApiDB("postgres", psycopg.connect(dsn))

    if dsn.startswith("mysql://"):
        try:
            import pymysql
        except ImportError as exc:
            raise RuntimeError("missing dependency: install pymysql") from exc
        parsed = urlparse(dsn)
        conn = pymysql.connect(
            host=parsed.hostname or "127.0.0.1",
            port=parsed.port or 3306,
            user=unquote(parsed.username or ""),
            password=unquote(parsed.password or ""),
            database=unquote(parsed.path.lstrip("/")),
            charset="utf8mb4",
            autocommit=False,
        )
        return NewApiDB("mysql", conn)

    raise RuntimeError(f"unsupported NEWAPI_SQL_DSN: {dsn}")


def wait_for_db(cfg: NewApiProvisionerConfig) -> NewApiDB:
    deadline = time.monotonic() + cfg.init_timeout_ms / 1000
    last_error: Exception | None = None
    while time.monotonic() < deadline:
        try:
            db = open_newapi_db(cfg)
            db.query("select 1")
            return db
        except Exception as exc:
            last_error = exc
            time.sleep(1.5)
    raise RuntimeError(f"database not ready: {last_error}")


def wait_for_newapi(cfg: NewApiProvisionerConfig) -> None:
    if not cfg.admin_base_url:
        raise RuntimeError("NEWAPI_ADMIN_BASE_URL is required")
    deadline = time.monotonic() + cfg.init_timeout_ms / 1000
    last_error: Exception | None = None
    while time.monotonic() < deadline:
        try:
            with httpx.Client(timeout=5) as client:
                res = client.get(f"{cfg.admin_base_url}/api/setup")
            if res.status_code < 500:
                return
            last_error = RuntimeError(f"HTTP {res.status_code}")
        except Exception as exc:
            last_error = exc
        time.sleep(1.5)
    raise RuntimeError(f"NewAPI not ready: {last_error}")


def get_newapi_setup_status(cfg: NewApiProvisionerConfig) -> NewApiSetupStatus:
    wait_for_newapi(cfg)
    with httpx.Client(timeout=10) as client:
        res = client.get(f"{cfg.admin_base_url}/api/setup")
    try:
        body: Any = res.json()
    except ValueError:
        body = res.text
    if res.status_code >= 400:
        raise RuntimeError(f"NewAPI setup status failed: HTTP {res.status_code} {body}")
    require_newapi_success(body, "get setup status")
    data = response_data(body)
    if not isinstance(data, dict):
        raise RuntimeError(f"get setup status failed: unexpected response {body}")
    return NewApiSetupStatus(
        initialized=bool(data.get("status")),
        root_initialized=bool(data.get("root_init")),
        database_type=str(data.get("database_type") or ""),
    )


def ensure_newapi_setup(
    cfg: NewApiProvisionerConfig,
    credentials: NewApiSetupCredentials | None = None,
) -> NewApiSetupStatus:
    status = get_newapi_setup_status(cfg)
    if status.initialized:
        return NewApiSetupStatus(
            initialized=status.initialized,
            root_initialized=status.root_initialized,
            database_type=status.database_type,
            setup_performed=False,
            already_initialized=True,
        )

    creds = credentials or NewApiSetupCredentials()
    payload: dict[str, Any] = {
        "SelfUseModeEnabled": bool(creds.self_use_mode_enabled),
        "DemoSiteEnabled": bool(creds.demo_site_enabled),
    }
    if not status.root_initialized:
        username = creds.username.strip()
        password = creds.password
        confirm_password = creds.confirm_password
        if not username or not password or not confirm_password:
            raise ValueError(
                "NewAPI is not initialized; setupUsername, setupPassword, "
                "and setupConfirmPassword are required"
            )
        payload.update(
            {
                "username": username,
                "password": password,
                "confirmPassword": confirm_password,
            }
        )

    with httpx.Client(timeout=15) as client:
        res = client.post(f"{cfg.admin_base_url}/api/setup", json=payload)
    try:
        body: Any = res.json()
    except ValueError:
        body = res.text
    if res.status_code >= 400:
        raise RuntimeError(f"NewAPI setup failed: HTTP {res.status_code} {body}")
    require_newapi_success(body, "setup NewAPI")
    final_status = get_newapi_setup_status(cfg)
    return NewApiSetupStatus(
        initialized=final_status.initialized,
        root_initialized=final_status.root_initialized,
        database_type=final_status.database_type,
        setup_performed=True,
        already_initialized=False,
    )


def find_admin_user(
    db: NewApiDB, cfg: NewApiProvisionerConfig
) -> dict[str, Any] | None:
    rows = db.query(
        "select id, username, role, status, access_token from users where username = ? limit 1",
        (cfg.admin_username,),
    )
    if rows:
        return rows[0]
    rows = db.query(
        """
        select id, username, role, status, access_token
        from users
        where role >= ?
        order by role desc, id asc
        limit 1
        """,
        (10,),
    )
    return rows[0] if rows else None


def wait_for_admin_user(db: NewApiDB, cfg: NewApiProvisionerConfig) -> dict[str, Any]:
    deadline = time.monotonic() + cfg.init_timeout_ms / 1000
    while time.monotonic() < deadline:
        user = find_admin_user(db, cfg)
        if user:
            return user
        time.sleep(1.5)
    raise RuntimeError(
        "admin user not found; initialize NewAPI or create root user first"
    )


def admin_headers(admin: AdminToken) -> dict[str, str]:
    return {
        "Authorization": admin.access_token,
        "New-Api-User": str(admin.admin_user_id),
    }


def require_newapi_success(body: Any, action: str) -> None:
    if not isinstance(body, dict):
        raise RuntimeError(f"{action} failed: unexpected response {body!r}")
    if body.get("success") is False:
        raise RuntimeError(f"{action} failed: {body.get('message') or body}")


def response_data(body: Any) -> Any:
    if not isinstance(body, dict):
        return None
    return body.get("data", body.get("response"))


def token_items(body: Any) -> list[dict[str, Any]]:
    data = response_data(body)
    if isinstance(data, dict) and isinstance(data.get("items"), list):
        return [item for item in data["items"] if isinstance(item, dict)]
    if isinstance(body, dict) and isinstance(body.get("items"), list):
        return [item for item in body["items"] if isinstance(item, dict)]
    return []


def channel_items(body: Any) -> list[dict[str, Any]]:
    data = response_data(body)
    if isinstance(data, dict) and isinstance(data.get("items"), list):
        return [item for item in data["items"] if isinstance(item, dict)]
    if isinstance(body, dict) and isinstance(body.get("items"), list):
        return [item for item in body["items"] if isinstance(item, dict)]
    return []


def verify_admin_api(cfg: NewApiProvisionerConfig, admin: AdminToken) -> None:
    with httpx.Client(timeout=10) as client:
        res = client.get(
            f"{cfg.admin_base_url}/api/channel/",
            params={"p": 1, "page_size": 1},
            headers=admin_headers(admin),
        )
    if res.status_code == 401:
        raise RuntimeError(
            "admin access token was written, but NewAPI rejected it with 401"
        )
    if res.status_code >= 400:
        raise RuntimeError(
            f"NewAPI admin check failed: HTTP {res.status_code} {res.text[:300]}"
        )


def ensure_admin_access_token(cfg: NewApiProvisionerConfig) -> AdminToken:
    db = wait_for_db(cfg)
    try:
        wait_for_newapi(cfg)
        user = wait_for_admin_user(db, cfg)
        access_token = str(user.get("access_token") or "").strip()
        token_created = False
        if not access_token:
            access_token = random_token()
            db.exec(
                "update users set access_token = ? where id = ?",
                (access_token, user["id"]),
            )
            token_created = True
        admin = AdminToken(
            admin_user_id=int(user["id"]),
            admin_username=str(user["username"]),
            access_token=access_token,
            token_created=token_created,
        )
        verify_admin_api(cfg, admin)
        return admin
    finally:
        db.close()


def get_token_key(
    cfg: NewApiProvisionerConfig, admin: AdminToken, token_id: int
) -> str:
    with httpx.Client(timeout=15) as client:
        res = client.post(
            f"{cfg.admin_base_url}/api/token/{token_id}/key",
            headers=admin_headers(admin),
        )
    try:
        body: Any = res.json()
    except ValueError:
        body = res.text
    if res.status_code >= 400:
        raise RuntimeError(f"get token key failed: HTTP {res.status_code} {body}")
    require_newapi_success(body, "get token key")
    data = response_data(body)
    key = data.get("key") if isinstance(data, dict) else None
    if not isinstance(key, str) or not key.strip():
        raise RuntimeError(f"get token key failed: missing key in {body}")
    return full_api_key(key)


def find_token_by_name(
    cfg: NewApiProvisionerConfig,
    admin: AdminToken,
    name: str,
) -> dict[str, Any] | None:
    with httpx.Client(timeout=15) as client:
        res = client.get(
            f"{cfg.admin_base_url}/api/token/search",
            params={"keyword": name, "p": 1, "page_size": 100},
            headers=admin_headers(admin),
        )
    try:
        body: Any = res.json()
    except ValueError:
        body = res.text
    if res.status_code >= 400:
        raise RuntimeError(f"search token failed: HTTP {res.status_code} {body}")
    require_newapi_success(body, "search token")
    matches = [item for item in token_items(body) if item.get("name") == name]
    if not matches:
        return None
    return sorted(matches, key=lambda item: int(item.get("id") or 0), reverse=True)[0]


def create_or_reuse_relay_token(
    cfg: NewApiProvisionerConfig,
    admin: AdminToken,
    *,
    name: str,
    group: str = "default",
    unlimited_quota: bool = True,
    remain_quota: int = 0,
    expired_time: int = -1,
    reuse_existing: bool = True,
) -> dict[str, Any]:
    token_name = name.strip()
    if not token_name:
        raise ValueError("token name is required")
    existing = find_token_by_name(cfg, admin, token_name) if reuse_existing else None
    if existing:
        key = get_token_key(cfg, admin, int(existing["id"]))
        return {
            "created": False,
            "tokenId": existing["id"],
            "name": existing["name"],
            "key": key,
            "keyPreview": mask_token(key),
        }

    payload = {
        "name": token_name,
        "expired_time": int(expired_time),
        "remain_quota": int(remain_quota),
        "unlimited_quota": bool(unlimited_quota),
        "model_limits_enabled": False,
        "model_limits": "",
        "group": group.strip() or "default",
        "allow_ips": "",
        "cross_group_retry": False,
    }
    with httpx.Client(timeout=15) as client:
        res = client.post(
            f"{cfg.admin_base_url}/api/token/",
            headers=admin_headers(admin),
            json=payload,
        )
    try:
        body: Any = res.json()
    except ValueError:
        body = res.text
    if res.status_code >= 400:
        raise RuntimeError(f"create token failed: HTTP {res.status_code} {body}")
    require_newapi_success(body, "create token")

    created = find_token_by_name(cfg, admin, token_name)
    if not created:
        raise RuntimeError("token was created, but could not be found by name")
    key = get_token_key(cfg, admin, int(created["id"]))
    return {
        "created": True,
        "tokenId": created["id"],
        "name": created["name"],
        "key": key,
        "keyPreview": mask_token(key),
    }


def build_channel_payload(
    *,
    provider: str,
    upstream_key: str,
    model_mapping: dict[str, str],
    channel_type: int | None = None,
    name: str | None = None,
    group: str = "default",
    priority: int = 0,
    weight: int = 0,
    base_url: str | None = None,
    test_model: str | None = None,
) -> dict[str, Any]:
    provider_key = (provider or "").strip()
    preset = PROVIDER_PRESETS.get(provider_key)
    if not preset and channel_type is None:
        raise ValueError("unknown provider; pass type when using a custom provider")
    model_keys = validate_model_mapping(model_mapping)
    provider_label = preset["label"] if preset else f"type-{channel_type}"
    resolved_base_url = (base_url or (preset or {}).get("base_url") or "").strip()
    if preset:
        channel_name = f"DC-{provider_key}"
    else:
        channel_name = (name or f"DC-type-{channel_type}").strip()
    channel = {
        "name": channel_name,
        "type": int(channel_type or preset["type"]),
        "key": upstream_key.strip(),
        "base_url": resolved_base_url,
        "models": ",".join(model_keys),
        "group": normalize_group(group),
        "model_mapping": json.dumps(
            model_mapping, ensure_ascii=False, separators=(",", ":")
        ),
        "status": 1,
        "auto_ban": 1,
        "priority": int(priority),
        "weight": int(weight),
        "test_model": (test_model or model_keys[0]).strip(),
        "setting": "{}",
        "settings": "{}",
        "other": "",
        "remark": f"created by DramaClaw CE provisioner for {provider_label}",
    }
    if not channel["key"]:
        raise ValueError("upstreamKey is required")
    return {"mode": "single", "channel": channel}


def _parse_model_mapping(value: Any) -> dict[str, str]:
    if isinstance(value, dict):
        return {
            str(key).strip(): str(item).strip()
            for key, item in value.items()
            if str(key).strip() and str(item).strip()
        }
    if isinstance(value, str) and value.strip():
        try:
            decoded = json.loads(value)
        except json.JSONDecodeError:
            return {}
        return _parse_model_mapping(decoded)
    return {}


def _parse_models(value: Any) -> list[str]:
    if isinstance(value, list):
        raw_items = value
    else:
        raw_items = str(value or "").split(",")
    models: list[str] = []
    seen: set[str] = set()
    for item in raw_items:
        model = str(item or "").strip()
        if not model or model in seen:
            continue
        seen.add(model)
        models.append(model)
    return models


def _merge_channel_payload(
    existing: dict[str, Any], payload: dict[str, Any]
) -> dict[str, Any]:
    incoming = dict(payload["channel"])
    existing_mapping = _parse_model_mapping(existing.get("model_mapping"))
    incoming_mapping = _parse_model_mapping(incoming.get("model_mapping"))
    merged_mapping = {**existing_mapping, **incoming_mapping}
    model_keys = validate_model_mapping(merged_mapping)

    allowed_fields = {
        "id",
        "name",
        "type",
        "key",
        "base_url",
        "models",
        "group",
        "model_mapping",
        "status",
        "auto_ban",
        "priority",
        "weight",
        "test_model",
        "setting",
        "settings",
        "other",
        "remark",
    }
    merged = {
        key: value
        for key, value in {**existing, **incoming}.items()
        if key in allowed_fields
    }
    channel_id = existing.get("id")
    if channel_id is not None:
        merged["id"] = channel_id
    merged["model_mapping"] = json.dumps(
        merged_mapping,
        ensure_ascii=False,
        separators=(",", ":"),
    )
    merged["models"] = ",".join(model_keys)
    merged["test_model"] = str(merged.get("test_model") or model_keys[0]).strip()
    if not incoming.get("base_url") and existing.get("base_url"):
        merged["base_url"] = existing["base_url"]
    if not incoming.get("key") and existing.get("key"):
        merged["key"] = existing["key"]
    return {"mode": "single", "channel": merged}


def list_channels(
    cfg: NewApiProvisionerConfig,
    admin: AdminToken,
    *,
    page_size: int = 100,
    max_pages: int = 20,
) -> list[dict[str, Any]]:
    channels: list[dict[str, Any]] = []
    with httpx.Client(timeout=15) as client:
        for page in range(1, max_pages + 1):
            res = client.get(
                f"{cfg.admin_base_url}/api/channel/",
                params={"p": page, "page_size": page_size},
                headers=admin_headers(admin),
            )
            try:
                body: Any = res.json()
            except ValueError:
                body = res.text
            if res.status_code >= 400:
                raise RuntimeError(
                    f"list channels failed: HTTP {res.status_code} {body}"
                )
            require_newapi_success(body, "list channels")
            items = channel_items(body)
            channels.extend(items)
            if len(items) < page_size:
                break
    return channels


def find_channel_by_name(
    cfg: NewApiProvisionerConfig,
    admin: AdminToken,
    *,
    name: str,
    channel_type: int | None = None,
) -> dict[str, Any] | None:
    matches = [
        item
        for item in list_channels(cfg, admin)
        if str(item.get("name") or "") == name
        and (channel_type is None or int(item.get("type") or 0) == int(channel_type))
    ]
    if not matches:
        return None
    return sorted(matches, key=lambda item: int(item.get("id") or 0), reverse=True)[0]


def get_channel_detail(
    cfg: NewApiProvisionerConfig,
    admin: AdminToken,
    channel_id: int | str,
) -> dict[str, Any]:
    with httpx.Client(timeout=15) as client:
        res = client.get(
            f"{cfg.admin_base_url}/api/channel/{channel_id}",
            headers=admin_headers(admin),
        )
    try:
        body: Any = res.json()
    except ValueError:
        body = res.text
    if res.status_code >= 400:
        raise RuntimeError(f"get channel failed: HTTP {res.status_code} {body}")
    require_newapi_success(body, "get channel")
    data = response_data(body)
    if not isinstance(data, dict):
        raise RuntimeError(f"get channel failed: missing data in {body}")
    return data


def update_channel(
    cfg: NewApiProvisionerConfig,
    admin: AdminToken,
    channel_id: int | str,
    payload: dict[str, Any],
) -> dict[str, Any]:
    channel = dict(payload["channel"])
    channel["id"] = channel_id
    attempts = [
        ("PUT", f"{cfg.admin_base_url}/api/channel/", channel),
        ("PUT", f"{cfg.admin_base_url}/api/channel/{channel_id}", channel),
        ("PUT", f"{cfg.admin_base_url}/api/channel/", payload),
        ("PUT", f"{cfg.admin_base_url}/api/channel/{channel_id}", payload),
    ]
    last_status = 0
    last_body: Any = None
    last_payload: dict[str, Any] | None = None
    with httpx.Client(timeout=30) as client:
        for method, url, body_payload in attempts:
            res = client.request(
                method, url, headers=admin_headers(admin), json=body_payload
            )
            try:
                body: Any = res.json()
            except ValueError:
                body = res.text
            last_status = res.status_code
            last_body = body
            last_payload = body_payload
            ok = (
                res.status_code < 400
                and isinstance(body, dict)
                and body.get("success") is not False
            )
            if ok:
                return {
                    "ok": True,
                    "httpStatus": res.status_code,
                    "newApiResponse": body,
                    "sentPayload": body_payload,
                }
            if res.status_code in {404, 405}:
                continue
            if isinstance(body, dict) and "record not found" in str(body).lower():
                continue
            return {
                "ok": False,
                "httpStatus": res.status_code,
                "newApiResponse": body,
                "sentPayload": body_payload,
            }
    return {
        "ok": False,
        "httpStatus": last_status,
        "newApiResponse": last_body,
        "sentPayload": last_payload,
    }


def create_channel(
    cfg: NewApiProvisionerConfig,
    admin: AdminToken,
    payload: dict[str, Any],
) -> dict[str, Any]:
    with httpx.Client(timeout=30) as client:
        res = client.post(
            f"{cfg.admin_base_url}/api/channel/",
            headers=admin_headers(admin),
            json=payload,
        )
    try:
        body: Any = res.json()
    except ValueError:
        body = res.text
    return {
        "ok": res.status_code < 400
        and isinstance(body, dict)
        and body.get("success") is not False,
        "httpStatus": res.status_code,
        "newApiResponse": body,
    }


def update_provider_channel_credentials(
    cfg: NewApiProvisionerConfig,
    admin: AdminToken,
    *,
    provider: str,
    upstream_key: str,
    base_url: str | None = None,
) -> dict[str, Any]:
    provider_key = str(provider or "").strip().lower()
    preset = PROVIDER_PRESETS.get(provider_key)
    if not preset:
        raise ValueError("unknown provider")
    key = str(upstream_key or "").strip()
    if not key:
        raise ValueError("upstreamKey is required")

    channel_name = f"DC-{provider_key}"
    existing = find_channel_by_name(
        cfg,
        admin,
        name=channel_name,
        channel_type=int(preset["type"]),
    )
    if not existing:
        raise LookupError(f"NewAPI channel {channel_name} does not exist")

    detail = get_channel_detail(cfg, admin, existing["id"])
    allowed_fields = {
        "id",
        "name",
        "type",
        "key",
        "base_url",
        "models",
        "group",
        "model_mapping",
        "status",
        "auto_ban",
        "priority",
        "weight",
        "test_model",
        "setting",
        "settings",
        "other",
        "remark",
    }
    channel = {
        field: value for field, value in detail.items() if field in allowed_fields
    }
    channel["id"] = existing["id"]
    channel["name"] = channel_name
    channel["type"] = int(preset["type"])
    channel["key"] = key
    if base_url is not None:
        channel["base_url"] = str(base_url or "").strip().rstrip("/")

    payload = {"mode": "single", "channel": channel}
    result = update_channel(cfg, admin, existing["id"], payload)
    return {
        **result,
        "action": "update",
        "channelId": existing["id"],
        "name": channel_name,
        "provider": provider_key,
    }


def _is_same_channel(candidate: dict[str, Any], target: dict[str, Any]) -> bool:
    candidate_id = str(candidate.get("id") or "").strip()
    target_id = str(target.get("id") or "").strip()
    if candidate_id and target_id:
        return candidate_id == target_id
    return str(candidate.get("name") or "") == str(target.get("name") or "") and int(
        candidate.get("type") or 0
    ) == int(target.get("type") or 0)


def _channel_update_payload_without_models(
    detail: dict[str, Any],
    model_keys_to_remove: set[str],
) -> dict[str, Any] | None:
    existing_mapping = _parse_model_mapping(detail.get("model_mapping"))
    existing_models = _parse_models(detail.get("models"))
    if not (model_keys_to_remove & (set(existing_mapping) | set(existing_models))):
        return None

    next_mapping = {
        key: value
        for key, value in existing_mapping.items()
        if key not in model_keys_to_remove
    }
    next_models = [
        model for model in existing_models if model not in model_keys_to_remove
    ]
    if not next_models and next_mapping:
        next_models = list(next_mapping)

    allowed_fields = {
        "id",
        "name",
        "type",
        "key",
        "base_url",
        "models",
        "group",
        "model_mapping",
        "status",
        "auto_ban",
        "priority",
        "weight",
        "test_model",
        "setting",
        "settings",
        "other",
        "remark",
    }
    channel = {key: value for key, value in detail.items() if key in allowed_fields}
    channel["models"] = ",".join(next_models)
    channel["model_mapping"] = json.dumps(
        next_mapping,
        ensure_ascii=False,
        separators=(",", ":"),
    )
    if str(channel.get("test_model") or "").strip() in model_keys_to_remove:
        channel["test_model"] = next_models[0] if next_models else ""
    return {"mode": "single", "channel": channel}


def remove_model_keys_from_other_dc_channels(
    cfg: NewApiProvisionerConfig,
    admin: AdminToken,
    *,
    target_channel: dict[str, Any],
    model_keys: list[str],
) -> list[dict[str, Any]]:
    keys_to_remove = {
        str(key or "").strip() for key in model_keys if str(key or "").strip()
    }
    if not keys_to_remove:
        return []

    results: list[dict[str, Any]] = []
    for channel in list_channels(cfg, admin):
        name = str(channel.get("name") or "")
        if not name.startswith("DC-") or _is_same_channel(channel, target_channel):
            continue
        channel_id = channel.get("id")
        if channel_id is None:
            continue
        detail = get_channel_detail(cfg, admin, channel_id)
        removed_models = sorted(
            keys_to_remove
            & (
                set(_parse_model_mapping(detail.get("model_mapping")))
                | set(_parse_models(detail.get("models")))
            )
        )
        update_payload = _channel_update_payload_without_models(detail, keys_to_remove)
        if update_payload is None:
            continue
        result = update_channel(cfg, admin, channel_id, update_payload)
        results.append(
            {
                "channelId": channel_id,
                "name": name,
                "ok": result["ok"],
                "httpStatus": result["httpStatus"],
                "removedModels": removed_models,
            }
        )
        if not result["ok"]:
            response = result.get("newApiResponse")
            raise RuntimeError(
                f"remove stale model mapping from channel {name} failed: {response}"
            )
    return results


def upsert_channel(
    cfg: NewApiProvisionerConfig,
    admin: AdminToken,
    payload: dict[str, Any],
) -> dict[str, Any]:
    channel = payload["channel"]
    incoming_model_keys = validate_model_mapping(
        _parse_model_mapping(channel.get("model_mapping"))
    )
    existing = find_channel_by_name(
        cfg,
        admin,
        name=str(channel["name"]),
        channel_type=int(channel["type"]),
    )
    if not existing:
        result = create_channel(cfg, admin, payload)
        if result["ok"]:
            deduped = remove_model_keys_from_other_dc_channels(
                cfg,
                admin,
                target_channel=channel,
                model_keys=incoming_model_keys,
            )
            result["dedupedChannels"] = deduped
        return {**result, "action": "create", "channelId": None}

    detail = get_channel_detail(cfg, admin, existing["id"])
    update_payload = _merge_channel_payload(detail, payload)
    result = update_channel(cfg, admin, existing["id"], update_payload)
    if result["ok"]:
        result["dedupedChannels"] = remove_model_keys_from_other_dc_channels(
            cfg,
            admin,
            target_channel=update_payload["channel"],
            model_keys=incoming_model_keys,
        )
    return {
        **result,
        "action": "update",
        "channelId": existing["id"],
        "sentPayload": update_payload,
    }


def build_provisioner_status() -> dict[str, Any]:
    cfg = get_provisioner_config()
    return {
        "enabled": provisioner_enabled(),
        "adminBaseUrl": cfg.admin_base_url,
        "dbConfigured": bool(cfg.sql_dsn or cfg.sqlite_path),
        "database": build_newapi_database_status(
            sql_dsn=os.environ.get("NEWAPI_SQL_DSN", ""),
            sqlite_path=os.environ.get("NEWAPI_SQLITE_PATH", ""),
            admin_username=os.environ.get("NEWAPI_ADMIN_USERNAME", "root"),
        ),
        "adminUsername": cfg.admin_username,
        "relayTokenName": cfg.relay_token_name,
        "providers": PROVIDER_PRESETS,
        "providerChannels": build_newapi_provider_channels_status(),
        "mediaModels": build_newapi_media_model_mappings_status(),
        "embeddingModel": build_newapi_embedding_model_status(),
        "relayBaseUrl": normalize_relay_base_url(cfg.admin_base_url),
    }
