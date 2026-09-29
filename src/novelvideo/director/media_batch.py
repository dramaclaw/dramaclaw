"""A batch is a frozen roster, not a loop that invents new paid intents on retry.

Plans and placeholder nodes commit together. Submission reuses the single-image
claim so a lost response or process restart can never repurchase an unknown item.
"""

from __future__ import annotations

import json
import time
from typing import Any, Literal
from uuid import UUID, uuid5

from pydantic import BaseModel, ConfigDict, Field

from .media import MediaPrepare, MediaRepository, fingerprint
from .store import DirectorConflict, DirectorNotFound


class BatchPrepare(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: UUID
    work_revision: int = Field(ge=1)
    document_version: int = Field(ge=1)
    kind: Literal["characters", "scenes", "props"]
    model_id: str
    aspect_ratio: str
    image_size: str
    quality: str
    model_params: dict[str, Any] = Field(default_factory=dict)
    prompts: dict[str, str] = Field(default_factory=dict)


class BatchApproval(BaseModel):
    model_config = ConfigDict(extra="forbid")
    selected_ids: list[UUID] = Field(min_length=1, max_length=100)
    acknowledge_unknown_cost: Literal[True]


class NodePosition(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    version: int = Field(ge=1)
    x: float = Field(ge=-100000, le=100000)
    y: float = Field(ge=-100000, le=100000)


class MediaBatchRepository:
    def __init__(self, media: MediaRepository):
        self.media, self.store = media, media.store
        with self.store._write() as db:
            db.execute("""
              CREATE TABLE IF NOT EXISTS director_media_batches (
                id TEXT PRIMARY KEY, work_id TEXT NOT NULL, actor_id TEXT NOT NULL,
                request_hash TEXT NOT NULL, status TEXT NOT NULL,
                selection_json TEXT NOT NULL DEFAULT '[]', created_at REAL NOT NULL)""")
            db.execute("""
              CREATE TABLE IF NOT EXISTS director_media_nodes (
                id TEXT PRIMARY KEY, batch_id TEXT NOT NULL, work_id TEXT NOT NULL,
                ordinal INTEGER NOT NULL, x REAL NOT NULL, y REAL NOT NULL,
                version INTEGER NOT NULL DEFAULT 1,
                FOREIGN KEY(id) REFERENCES director_media_intents(id),
                FOREIGN KEY(batch_id) REFERENCES director_media_batches(id));
            """)

    def _get(self, db, work: str, batch_id: str) -> dict:
        batch = db.execute("SELECT * FROM director_media_batches WHERE id=? AND work_id=?", (batch_id, work)).fetchone()
        if not batch:
            raise DirectorNotFound("MEDIA_BATCH_NOT_FOUND")
        nodes = []
        for row in db.execute("SELECT * FROM director_media_nodes WHERE batch_id=? ORDER BY ordinal", (batch_id,)):
            intent = db.execute("SELECT * FROM director_media_intents WHERE id=?", (row["id"],)).fetchone()
            nodes.append({**dict(row), "intent": self.media.view(intent)})
        return {"id": batch_id, "status": batch["status"], "selectedIds": json.loads(batch["selection_json"]), "nodes": nodes}

    def list(self, work: str) -> list[dict]:
        with self.store._connect() as db:
            self.store._work(db, work)
            return [self._get(db, work, r["id"]) for r in db.execute(
                "SELECT id FROM director_media_batches WHERE work_id=? ORDER BY created_at,id", (work,)).fetchall()]

    def prepare(self, actor: str, work: str, body: BatchPrepare, catalog: list[dict]) -> dict:
        digest = fingerprint(body.model_dump(mode="json"))
        with self.store._write() as db:
            old = db.execute("SELECT * FROM director_media_batches WHERE id=?", (str(body.id),)).fetchone()
            if old:
                if (old["work_id"], old["actor_id"], old["request_hash"]) != (work, actor, digest):
                    raise DirectorConflict("MEDIA_BATCH_REUSED")
                return self._get(db, work, str(body.id))
            source = self.media.source(work, body.kind)
            assets = source["assets"]
            if not assets or len(assets) > 100:
                raise ValueError("MEDIA_BATCH_ROSTER_INVALID")
            if set(body.prompts) - {a["id"] for a in assets}:
                raise ValueError("MEDIA_BATCH_UNKNOWN_ASSET")
            if (source["workRevision"], source["documentVersion"]) != (body.work_revision, body.document_version):
                raise DirectorConflict("MEDIA_SOURCE_CHANGED")
            db.execute("INSERT INTO director_media_batches(id,work_id,actor_id,request_hash,status,created_at) VALUES(?,?,?,?,'planned',?)",
                       (str(body.id), work, actor, digest, time.time()))
            # Each plan starts below prior nodes, including manually moved ones.
            bottom = db.execute("SELECT MAX(y) FROM director_media_nodes WHERE work_id=?", (work,)).fetchone()[0]
            top = 80 if bottom is None else bottom + 800
            for index, asset in enumerate(assets):
                intent_id = uuid5(body.id, f"{body.kind}:{asset['id']}")
                # Full source block plus confirmed style; no invented age, lens,
                # exclusive entrance or secondary character from an extra planner.
                prompt = body.prompts.get(asset["id"], f"{asset['text']}\n\n{source['style']}").strip()
                single = MediaPrepare(**body.model_dump(exclude={"id", "prompts"}), intent_id=intent_id,
                                      asset_id=asset["id"], prompt=prompt)
                intent = self.media.prepare(actor, work, single, catalog, _db=db)
                request = {**intent["request"], "batchId": str(body.id)}
                db.execute("UPDATE director_media_intents SET request_json=? WHERE id=?",
                           (json.dumps(request, ensure_ascii=False), str(intent_id)))
                parts = body.aspect_ratio.split(":")
                width, height = map(float, parts) if len(parts) == 2 else (1, 1)
                row_height = 350 * height / width + 108 if width > 0 and height > 0 else 458
                db.execute("INSERT INTO director_media_nodes(id,batch_id,work_id,ordinal,x,y) VALUES(?,?,?,?,?,?)",
                           (str(intent_id), str(body.id), work, index, 720 + (index % 3) * 382, top + (index // 3) * row_height))
            return self._get(db, work, str(body.id))

    def approve(self, actor: str, work: str, batch_id: str, body: BatchApproval, catalog: list[dict]) -> dict:
        selected = [str(value) for value in body.selected_ids]
        with self.store._write() as db:
            batch = self._get(db, work, batch_id)
            owner = db.execute("SELECT actor_id FROM director_media_batches WHERE id=?", (batch_id,)).fetchone()[0]
            if owner != actor:
                raise DirectorConflict("MEDIA_BATCH_OWNER_MISMATCH")
            ordered = [n["id"] for n in batch["nodes"] if n["id"] in selected]
            if len(set(selected)) != len(selected) or len(ordered) != len(selected):
                raise ValueError("MEDIA_BATCH_SELECTION_INVALID")
            if batch["status"] == "approved":
                if ordered != batch["selectedIds"]:
                    raise DirectorConflict("MEDIA_BATCH_APPROVAL_REUSED")
                return batch
            if batch["status"] != "planned":
                raise DirectorConflict("MEDIA_BATCH_CANCELLED")
            current = self.store._work(db, work)
            for node in batch["nodes"]:
                if node["id"] not in selected:
                    continue
                request = node["intent"]["request"]
                source = request["source"]
                model = next((m for m in catalog if m["id"] == request["actual"]["model_id"]), None)
                if current["revision"] != source["workRevision"] or self.store._version(db, work, source["kind"]) != source["documentVersion"]:
                    raise DirectorConflict("MEDIA_SOURCE_CHANGED")
                if model is None or fingerprint(model) != request["catalogHash"]:
                    raise DirectorConflict("MEDIA_MODEL_CHANGED")
            db.execute("UPDATE director_media_batches SET status='approved',selection_json=? WHERE id=?", (json.dumps(ordered), batch_id))
            for node in batch["nodes"]:
                if node["id"] not in selected:
                    db.execute("UPDATE director_media_intents SET status='cancelled' WHERE id=? AND status='prepared'", (node["id"],))
            return self._get(db, work, batch_id)

    def cancel(self, actor: str, work: str, batch_id: str) -> dict:
        with self.store._write() as db:
            self._get(db, work, batch_id)
            owner = db.execute("SELECT actor_id FROM director_media_batches WHERE id=?", (batch_id,)).fetchone()[0]
            if owner != actor:
                raise DirectorConflict("MEDIA_BATCH_OWNER_MISMATCH")
            db.execute("UPDATE director_media_batches SET status='cancelled' WHERE id=?", (batch_id,))
            db.execute("UPDATE director_media_intents SET status='cancelled' WHERE id IN (SELECT id FROM director_media_nodes WHERE batch_id=?) AND status='prepared'", (batch_id,))
            return self._get(db, work, batch_id)

    def move(self, work: str, node_id: str, body: NodePosition) -> dict:
        with self.store._write() as db:
            row = db.execute("SELECT * FROM director_media_nodes WHERE id=? AND work_id=?", (node_id, work)).fetchone()
            if not row:
                raise DirectorNotFound("MEDIA_NODE_NOT_FOUND")
            if row["version"] != body.version:
                # Lost response for this exact move is safe to read back.
                if row["version"] == body.version + 1 and (row["x"], row["y"]) == (body.x, body.y):
                    return dict(row)
                raise DirectorConflict("MEDIA_NODE_POSITION_CHANGED")
            db.execute("UPDATE director_media_nodes SET x=?,y=?,version=version+1 WHERE id=?", (body.x, body.y, node_id))
            return dict(db.execute("SELECT * FROM director_media_nodes WHERE id=?", (node_id,)).fetchone())
