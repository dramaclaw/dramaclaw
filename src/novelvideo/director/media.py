"""Freeze a media intent before handing it to the shared image task service.

An interrupted submission has an unknown outcome, not permission to buy again.
The document remains the source; generated images never rewrite that document.
"""

from __future__ import annotations

import hashlib
import json
import re
import time
from contextlib import nullcontext
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from novelvideo.media_model_request_schema import (
    media_request_schema_for_mode,
    validate_media_model_params,
)

from .store import DirectorConflict, DirectorNotFound, DirectorStore
from .characters import LABELS as CHARACTER_LABELS


def fingerprint(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True).encode()).hexdigest()


class MediaPrepare(BaseModel):
    model_config = ConfigDict(extra="forbid")
    intent_id: UUID
    work_revision: int = Field(ge=1)
    document_version: int = Field(ge=1)
    kind: Literal["characters", "scenes", "props"]
    asset_id: str = Field(min_length=1, max_length=100)
    prompt: str = Field(min_length=1, max_length=16000)
    model_id: str = Field(min_length=1, max_length=200)
    aspect_ratio: str = Field(max_length=40)
    image_size: str = Field(max_length=40)
    quality: str = Field(max_length=40)
    model_params: dict[str, Any] = Field(default_factory=dict)


def document_assets(content: str) -> list[dict]:
    """Use document order and text, never ask a second model to invent a roster."""
    headings = list(re.finditer(r"^(#{1,2}) ([^\n]+)$", content, re.MULTILINE))
    non_assets = {*CHARACTER_LABELS["relations"], *CHARACTER_LABELS["worldRules"]}
    assets = []
    for index, item in enumerate(headings):
        if item.group(1) != "##" or item.group(2).strip() in non_assets:
            continue
        assets.append({"id": str(len(assets)), "name": item.group(2).strip(),
                       "text": content[item.start():headings[index + 1].start() if index + 1 < len(headings) else len(content)].strip()})
    return assets


class MediaRepository:
    def __init__(self, store: DirectorStore):
        self.store = store
        with store._write() as db:
            db.execute("""CREATE TABLE IF NOT EXISTS director_media_intents (
                id TEXT PRIMARY KEY, work_id TEXT NOT NULL, actor_id TEXT NOT NULL,
                request_hash TEXT NOT NULL, request_json TEXT NOT NULL,
                status TEXT NOT NULL, result_json TEXT NOT NULL DEFAULT '{}',
                created_at REAL NOT NULL, updated_at REAL NOT NULL,
                FOREIGN KEY(work_id) REFERENCES works(id))""")

    @staticmethod
    def view(row) -> dict:
        return {"id": row["id"], "workId": row["work_id"], "status": row["status"],
                "request": json.loads(row["request_json"]), "result": json.loads(row["result_json"]),
                "createdAt": row["created_at"]}

    def list(self, work_id: str) -> list[dict]:
        with self.store._connect() as db:
            self.store._work(db, work_id)
            return [self.view(row) for row in db.execute(
                "SELECT * FROM director_media_intents WHERE work_id=? ORDER BY created_at,id", (work_id,))]

    def source(self, work_id: str, kind: str) -> dict:
        if kind not in {"characters", "scenes", "props"}:
            raise ValueError("MEDIA_KIND_INVALID")
        work = self.store.get_work(work_id)
        document = self.store.get_document(work_id, kind)
        return {"workRevision": work["revision"], "documentVersion": document["version"],
                "kind": kind, "assets": document_assets(document["content"]),
                "style": work["preset"]["visual_style"]}

    def prepare(self, actor: str, work_id: str, body: MediaPrepare, catalog: list[dict], *, _db=None) -> dict:
        request_hash = fingerprint(body.model_dump(mode="json"))
        with (self.store._write() if _db is None else nullcontext(_db)) as db:
            previous = db.execute("SELECT * FROM director_media_intents WHERE id=?", (str(body.intent_id),)).fetchone()
            if previous:
                if previous["work_id"] != work_id or previous["actor_id"] != actor or previous["request_hash"] != request_hash:
                    raise DirectorConflict("MEDIA_INTENT_REUSED")
                return self.view(previous)
            work = self.store._work(db, work_id)
            if work["revision"] != body.work_revision or self.store._version(db, work_id, body.kind) != body.document_version:
                raise DirectorConflict("MEDIA_SOURCE_CHANGED")
            document = db.execute("SELECT content FROM document_versions WHERE work_id=? AND doc_key=? AND version=?",
                                  (work_id, body.kind, body.document_version)).fetchone()
            assets = document_assets(document["content"])
            asset = next((item for item in assets if item["id"] == body.asset_id), None)
            model = next((item for item in catalog if item["id"] == body.model_id), None)
            if not asset or not model or not body.prompt.strip():
                raise ValueError("MEDIA_SELECTION_INVALID")
            for field, value, default in [("ratioOptions", body.aspect_ratio, "1:1"),
                                          ("resolutionOptions", body.image_size, "2K"),
                                          ("qualityOptions", body.quality, "medium")]:
                if value not in (model.get(field) or [default]):
                    raise ValueError("MEDIA_PARAMETER_NOT_OFFERED")
            schema = media_request_schema_for_mode(model.get("request") or {}, "text_to_image")
            params = validate_media_model_params(schema, body.model_params)
            actual = {"prompt": body.prompt, "model": model.get("apiModel") or model.get("api_model") or model["id"],
                      "provider": model.get("providerId") or model.get("provider"),
                      "model_id": model["id"], "aspect_ratio": body.aspect_ratio, "image_size": body.image_size,
                      "quality": body.quality, "model_params": params, "gen_mode": "text_to_image",
                      "reference_urls": [], "canvas_id": f"director-{work_id}", "node_id": str(body.intent_id)}
            request = {"source": {"kind": body.kind, "documentVersion": body.document_version,
                                  "workRevision": body.work_revision, "asset": asset, "hash": fingerprint(document["content"])},
                       "modelLabel": model["label"], "catalogHash": fingerprint(model), "actual": actual,
                       "price": {"status": "unknown", "amount": None}, "approvalRequired": True}
            now = time.time()
            db.execute("INSERT INTO director_media_intents(id,work_id,actor_id,request_hash,request_json,status,created_at,updated_at) VALUES(?,?,?,?,?,'prepared',?,?)",
                       (str(body.intent_id), work_id, actor, request_hash, json.dumps(request, ensure_ascii=False), now, now))
            return self.view(db.execute("SELECT * FROM director_media_intents WHERE id=?", (str(body.intent_id),)).fetchone())

    def claim(self, actor: str, work_id: str, intent_id: str, catalog: list[dict]) -> tuple[dict, bool]:
        with self.store._write() as db:
            row = db.execute("SELECT * FROM director_media_intents WHERE id=? AND work_id=? AND actor_id=?", (intent_id, work_id, actor)).fetchone()
            if not row:
                raise DirectorNotFound("MEDIA_INTENT_NOT_FOUND")
            view = self.view(row)
            if row["status"] != "prepared":
                return view, False
            request = view["request"]
            if request.get("batchId"):
                batch = db.execute("SELECT * FROM director_media_batches WHERE id=? AND work_id=?",
                                   (request["batchId"], work_id)).fetchone()
                if not batch or batch["status"] != "approved" or intent_id not in json.loads(batch["selection_json"]):
                    raise DirectorConflict("MEDIA_BATCH_NOT_APPROVED")
            source = request["source"]
            model = next((item for item in catalog if item["id"] == request["actual"]["model_id"]), None)
            if model is None or fingerprint(model) != request["catalogHash"]:
                raise DirectorConflict("MEDIA_MODEL_CHANGED")
            if self.store._work(db, work_id)["revision"] != source["workRevision"] or self.store._version(db, work_id, source["kind"]) != source["documentVersion"]:
                raise DirectorConflict("MEDIA_SOURCE_CHANGED")
            db.execute("UPDATE director_media_intents SET status='submitting',updated_at=? WHERE id=?", (time.time(), intent_id))
            view["status"] = "submitting"
            return view, True

    def finish(self, work_id: str, intent_id: str, result: dict | None) -> dict:
        with self.store._write() as db:
            db.execute("UPDATE director_media_intents SET status=?,result_json=?,updated_at=? WHERE id=? AND work_id=? AND status='submitting'",
                       ("accepted" if result else "unknown", json.dumps(result or {}), time.time(), intent_id, work_id))
            row = db.execute("SELECT * FROM director_media_intents WHERE id=? AND work_id=?", (intent_id, work_id)).fetchone()
            if not row:
                raise DirectorNotFound("MEDIA_INTENT_NOT_FOUND")
            return self.view(row)
