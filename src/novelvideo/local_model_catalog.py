"""One local catalog keeps user choices and provider routing in agreement.

The private SQLite file is shared by the API and gateway processes. Refreshes
update discoveries without overwriting switches or defaults changed in the UI.
"""

from __future__ import annotations

import json
import os
import re
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx

ARK_BASE = "https://ark.cn-beijing.volces.com/api/plan/v3"
SF_BASE = "https://api.siliconflow.cn/v1"
PROVIDERS = {
    "siliconflow": {"label": "SiliconFlow", "baseUrl": SF_BASE},
    "ark": {"label": "Volcengine · Agent Plan", "baseUrl": ARK_BASE},
    "local": {"label": "Local · ComfyUI / H3", "baseUrl": ""},
}
ARK_SOURCE = "https://docs.volcengine.com/docs/ark/agent-plan-personal-zcode?lang=zh"
ARK_CATALOG_DATE = "2026-09-27"
ARK_TEXT = {
    "doubao-seed-evolving": True, "deepseek-v4.1-flash": True,
    "ark-code-latest": True, "doubao-seed-2.1-pro": True,
    "doubao-seed-2.1-lite": True, "doubao-seed-2.0-mini": True,
    "deepseek-v4-flash": False, "deepseek-v4-pro": False,
    "glm-5.3": False, "glm-5.3-flash": True, "glm-latest": False,
    "minimax-m3": True, "kimi-k2.7-code": True, "kimi-k3": True,
    "kimi-k2.8-preview": True,
}
LEGACY_TEXT = [
    "deepseek-ai/DeepSeek-V4-Flash", "deepseek-ai/DeepSeek-V3.2",
    "zai-org/GLM-4.5V", "Qwen/Qwen3-VL-32B-Instruct",
]
LOCAL_MODELS = {
    "Qwen-Image-local": ("Qwen Image", "image"),
    "Krea-2-Turbo-local": ("Krea 2 Turbo", "image"),
    "Krea-2-Identity-Edit-local": ("Krea 2 Identity Edit", "image"),
    "MiniMax-H3": ("MiniMax H3", "video"),
}


def active_root() -> Path | None:
    value = os.environ.get("DRAMACLAW_LOCAL_CONFIG_DIR", "").strip()
    return Path(value).expanduser() if value else None


def model_id(provider: str, upstream: str) -> str:
    return upstream if provider == "local" else f"{provider}::{upstream}"


def secret_path(root: Path, provider: str) -> Path:
    if provider not in {"siliconflow", "ark"}:
        raise ValueError("unsupported cloud provider")
    return root / "secrets" / ("siliconflow.key" if provider == "siliconflow" else "ark-agent-plan.key")


def read_key(root: Path, provider: str) -> str:
    try:
        key = secret_path(root, provider).read_text(encoding="utf-8-sig").strip()
    except OSError:
        raise ValueError("provider API key is not configured") from None
    if provider == "siliconflow":
        match = re.search(r"sk-[A-Za-z0-9_-]+", key)
        key = match.group() if match else key
    if not key or any(c in key for c in "\r\n"):
        raise ValueError("provider API key is invalid")
    return key


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _record(provider: str, upstream: str, kind: str, *, vision: bool = False,
            enabled: bool = False, source: str = "official_catalog", **extra: Any) -> dict:
    return {
        "id": model_id(provider, upstream), "provider": provider,
        "providerLabel": PROVIDERS[provider]["label"], "upstreamModel": upstream,
        "label": upstream.rsplit("/", 1)[-1], "kind": kind,
        "inputModalities": ["text", "image"] if vision else ["text"],
        "videoInput": "sampled_frames" if vision and kind == "text" else "none",
        "source": source, "enabled": enabled, "available": True,
        "supported": kind in {"text", "image", "video"}, **extra,
    }


def _sf_record(upstream: str) -> dict:
    lower = upstream.lower()
    kind = "text"
    if any(x in lower for x in ("embedding", "bge-", "reranker", "cosyvoice", "sensevoice", "fish-speech", "moss-", "whisper", "gpt-sovits")):
        kind = "other"
    elif lower.startswith("wan-ai/"):
        kind = "video"
    elif any(x in lower for x in ("qwen-image", "z-image", "ernie-image", "kolors", "flux")):
        kind = "image"
    vision = bool(re.search(r"(?:-vl-|glm-[\d.]+v(?:$|-)|qwen3\.5-|qwen3-omni-|internvl|ocr)", lower))
    legacy = bool(re.fullmatch(r"(?:Pro/)?deepseek-ai/DeepSeek-(?:R1|V3|V4)[A-Za-z0-9._-]*|zai-org/GLM-4\.5V|Qwen/Qwen3-VL-(?:8B|30B-A3B|32B)-(?:Instruct|Thinking)", upstream))
    return _record("siliconflow", upstream, kind, vision=vision,
                   label=("Pro · " if upstream.startswith("Pro/") else "LoRA · " if upstream.startswith("LoRA/") else "") + upstream.rsplit("/", 1)[-1],
                   enabled=legacy, source="provider_api", supportsImageEdit="image-edit" in lower,
                   referenceImageMax=1 if kind == "video" and "i2v" in lower else 3 if "image-edit-2509" in lower else 1 if "image-edit" in lower else 0)


class LocalModelCatalog:
    def __init__(self, root: Path):
        self.root = root
        root.mkdir(parents=True, exist_ok=True)
        self.path = root / "model-catalog.sqlite3"
        with self.connect() as db:
            db.execute("CREATE TABLE IF NOT EXISTS models (id TEXT PRIMARY KEY, data TEXT NOT NULL, enabled INTEGER NOT NULL)")
            db.execute("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
            seeds = [_sf_record(m) for m in LEGACY_TEXT]
            for m, vision in ARK_TEXT.items():
                seeds.append(_record("ark", m, "text", vision=vision,
                    enabled=m in {"doubao-seed-evolving", "deepseek-v4.1-flash"},
                    label={"doubao-seed-evolving": "Seed-Evolving", "deepseek-v4.1-flash": "DeepSeek-V4.1-Flash"}.get(m, m),
                    sourceUrl=ARK_SOURCE, catalogDate=ARK_CATALOG_DATE))
            for m in ("doubao-seedream-5.0-pro", "doubao-seedream-5.0-lite"):
                seeds.append(_record("ark", m, "image", vision=True, supportsImageEdit=True,
                    referenceImageMax=14, sourceUrl=ARK_SOURCE, catalogDate=ARK_CATALOG_DATE))
            seeds.append(_record("ark", "doubao-seedance-2.5", "video", vision=True,
                sourceUrl=ARK_SOURCE, catalogDate=ARK_CATALOG_DATE, minPlan="large"))
            for m, (label, kind) in LOCAL_MODELS.items():
                seeds.append(_record("local", m, kind, enabled=True, label=label, source="local"))
            for item in seeds:
                db.execute("INSERT OR IGNORE INTO models VALUES (?,?,?)", (item["id"], json.dumps(item), item["enabled"]))
            db.execute("INSERT OR IGNORE INTO settings VALUES ('plan', 'medium')")
            db.execute("INSERT OR IGNORE INTO settings VALUES ('default:text', ?)", (model_id("siliconflow", LEGACY_TEXT[0]),))
            db.execute("INSERT OR IGNORE INTO settings VALUES ('default:video','MiniMax-H3')")
            db.execute("INSERT OR IGNORE INTO settings VALUES ('default:image','Qwen-Image-local')")

    def connect(self):
        return sqlite3.connect(self.path, timeout=15)

    def setting(self, key: str, default: str = "") -> str:
        with self.connect() as db:
            row = db.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
        return row[0] if row else default

    def set_setting(self, key: str, value: str) -> None:
        with self.connect() as db:
            db.execute("INSERT OR REPLACE INTO settings VALUES (?,?)", (key, value))

    def models(self, *, enabled_only: bool = False) -> list[dict]:
        with self.connect() as db:
            rows = db.execute("SELECT data,enabled FROM models ORDER BY rowid").fetchall()
        result = []
        for data, enabled in rows:
            item = json.loads(data)
            item["enabled"] = bool(enabled)
            item["blockedReason"] = ""
            if item.get("minPlan") == "large" and self.setting("plan") not in {"large", "max"}:
                item["blockedReason"] = "plan_upgrade_required"
            if not item.get("supported"):
                item["blockedReason"] = "unsupported_modality"
            if not item.get("available", True):
                item["blockedReason"] = "model_removed"
            if not enabled_only or (enabled and not item["blockedReason"]):
                result.append(item)
        return result

    def resolve(self, requested: str, *, kind: str | None = None, require_enabled: bool = True) -> dict:
        requested = requested.removeprefix("newapi_")
        item = next((m for m in self.models() if m["id"] == requested or
                     (m["provider"] == "siliconflow" and m["upstreamModel"] == requested)), None)
        if item is None:
            raise ValueError("model is not in the local catalog; refresh models in Settings")
        if kind and item["kind"] != kind:
            raise ValueError("model does not support this output type")
        if require_enabled and (not item["enabled"] or item["blockedReason"]):
            raise ValueError("model is disabled or unavailable for the current plan")
        return item

    def update(self, changes: list[dict], defaults: dict[str, str] | None = None) -> None:
        current = {m["id"]: m for m in self.models()}
        states = {k: v["enabled"] for k, v in current.items()}
        for change in changes:
            item = current.get(change["id"])
            if item is None or (change["enabled"] and item["blockedReason"]):
                raise ValueError("cannot enable an unknown or unavailable model")
            states[item["id"]] = bool(change["enabled"])
        wanted = {k: self.setting(f"default:{k}") for k in ("text", "image", "video")}
        wanted.update(defaults or {})
        for kind, mid in wanted.items():
            item = current.get(mid)
            if kind not in {"text", "image", "video"} or not item or item["kind"] != kind or not states[mid] or item["blockedReason"]:
                raise ValueError("choose an enabled model as the default before disabling it")
        with self.connect() as db:
            db.executemany("UPDATE models SET enabled=? WHERE id=?", [(states[c["id"]], c["id"]) for c in changes])
            db.executemany("INSERT OR REPLACE INTO settings VALUES (?,?)", [(f"default:{k}", v) for k, v in wanted.items()])

    def snapshot(self) -> dict:
        providers = []
        for pid, info in PROVIDERS.items():
            providers.append({"id": pid, **info, "configured": pid == "local" or secret_path(self.root, pid).is_file(),
                "source": "official_catalog" if pid == "ark" else "local" if pid == "local" else "provider_api",
                "syncedAt": self.setting(f"sync:{pid}"), "error": self.setting(f"error:{pid}"),
                "plan": self.setting("plan") if pid == "ark" else "",
                "catalogDate": ARK_CATALOG_DATE if pid == "ark" else ""})
        return {"providers": providers, "models": self.models(),
                "defaults": {k: self.setting(f"default:{k}") for k in ("text", "image", "video")}}

    async def refresh(self, provider: str) -> dict:
        if provider == "ark":
            # The documented catalog API requires AK/SK, not the inference key.
            return self.snapshot()
        if provider != "siliconflow":
            raise ValueError("unsupported catalog provider")
        try:
            async with httpx.AsyncClient(timeout=25) as client:
                response = await client.get(SF_BASE + "/models", headers={"Authorization": f"Bearer {read_key(self.root, provider)}"})
                response.raise_for_status()
                data = response.json()["data"]
                if not isinstance(data, list) or not data:
                    raise ValueError("empty catalog")
                records = [_sf_record(m["id"]) for m in data if isinstance(m, dict) and isinstance(m.get("id"), str)]
                if not records:
                    raise ValueError("invalid catalog")
                categories = {}
                for kind, query in (("text", {"sub_type": "chat"}), ("image", {"type": "image"}), ("video", {"type": "video"})):
                    grouped = await client.get(SF_BASE + "/models", params=query, headers={"Authorization": f"Bearer {read_key(self.root, provider)}"})
                    grouped.raise_for_status()
                    group = grouped.json()["data"]
                    if not isinstance(group, list):
                        raise ValueError("invalid model category")
                    categories[kind] = {m["id"] for m in group if isinstance(m, dict) and isinstance(m.get("id"), str)}
                for item in records:
                    matches = [kind for kind, ids in categories.items() if item["upstreamModel"] in ids]
                    if len(matches) > 1:
                        raise ValueError("ambiguous model category")
                    item["kind"] = matches[0] if matches else "other"
                    item["supported"] = bool(matches)
        except (httpx.HTTPError, ValueError, KeyError):
            self.set_setting("error:siliconflow", "catalog_refresh_failed")
            raise ValueError("catalog refresh failed; saved models and selections were retained") from None
        with self.connect() as db:
            live = {m["id"] for m in records}
            for mid, data in db.execute("SELECT id,data FROM models WHERE id LIKE 'siliconflow::%'").fetchall():
                if mid not in live:
                    item = json.loads(data)
                    item["available"] = False
                    db.execute("UPDATE models SET data=? WHERE id=?", (json.dumps(item), mid))
            for item in records:
                item["syncedAt"] = now()
                db.execute("INSERT INTO models VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data", (item["id"], json.dumps(item), item["enabled"]))
            db.execute("INSERT OR REPLACE INTO settings VALUES ('sync:siliconflow', ?)", (now(),))
            db.execute("INSERT OR REPLACE INTO settings VALUES ('error:siliconflow', '')")
        return self.snapshot()

    def media_entries(self, kind: str) -> list[dict]:
        entries = []
        for item in self.models(enabled_only=True):
            if item["kind"] != kind or item["provider"] == "local":
                continue
            mid = item["id"]
            image_max = item.get("referenceImageMax", 0)
            modes = (["text_to_image", "image_to_image"] if item.get("supportsImageEdit") else ["text_to_image"]) if kind == "image" else (["first_frame"] if image_max else ["text_to_video"])
            if kind == "image" and item["provider"] == "siliconflow" and "image-edit" in item["upstreamModel"].lower():
                modes = ["image_to_image"]
            entries.append({"catalogId": mid, "id": mid, "apiModel": mid if kind == "image" else f"newapi_{mid}",
                "gatewayModel": mid, "providerId": "newapi", "provider": "newapi",
                "sourceProvider": item["provider"], "providerLabel": item["providerLabel"], "label": item["label"],
                "supportedModes": modes, "referenceImageMax": image_max, "referenceVideoMax": 0, "referenceAudioMax": 0,
                "resolutionOptions": ["2K", "4K"] if item["provider"] == "ark" and kind == "image" else ["1K"] if kind == "image" else ["720p"],
                "ratioOptions": ["1:1", "16:9", "9:16"] if kind == "video" else ["1:1", "16:9", "9:16", "4:3", "3:4"],
                "supportsGenerateAudio": False,
                **({"minDuration": 5, "maxDuration": 5} if kind == "video" else {}),
                "request": {"endpoint": "images/generations" if kind == "image" else "video/generations", "parameters": []}})
        return entries

    def merge_media(self, kind: str, entries: list[dict]) -> list[dict]:
        local = {m["id"]: m for m in self.models() if m["provider"] == "local"}
        result = []
        for entry in entries:
            mid = str(entry.get("id") or "")
            if "::" in mid:
                continue
            canonical = {"newapi_qwen_image_local": "Qwen-Image-local", "newapi_krea2_local": "Krea-2-Turbo-local", "newapi_krea2_edit_local": "Krea-2-Identity-Edit-local"}.get(mid, mid)
            if canonical not in local or not local[canonical]["enabled"]:
                continue
            result.append({**entry, "catalogId": canonical, "sourceProvider": "local", "providerLabel": PROVIDERS["local"]["label"]})
        result += self.media_entries(kind)
        default = self.setting(f"default:{kind}")
        result = [{**entry, "isDefault": entry.get("catalogId") == default} for entry in result]
        return sorted(result, key=lambda entry: not entry["isDefault"])
