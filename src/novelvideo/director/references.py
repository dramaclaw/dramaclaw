"""One ordered manifest prevents upload completion order from rebinding mentions.

This compiler owns text and mixed-media mention numbering only. It is not an H3
provider adapter and must not invent mode-specific provider payload fields.
"""

from __future__ import annotations

import json
from hashlib import sha256
from typing import Literal

from .schemas.common import ContractModel, DirectorContractError
from .schemas.foundation import ReferenceInput


class ReferenceSlot(ContractModel):
    ref_id: str
    kind: Literal["text", "image", "video", "audio"]
    version: int
    content_hash: str
    display_index: int
    namespace: Literal["text", "mixed"]
    mention_index: int


class ReferenceManifest(ContractModel):
    entries: list[ReferenceSlot]
    manifest_hash: str


def compile_reference_manifest(request: ReferenceInput) -> ReferenceManifest:
    resolved = {ref.ref_id: ref for ref in request.resolved}
    expected = set(request.ordered_ref_ids)
    if set(resolved) - expected:
        raise DirectorContractError(
            "UNREQUESTED_REFERENCE", affected_ids=sorted(set(resolved) - expected)
        )
    missing = expected - set(resolved)
    if missing:
        raise DirectorContractError("MISSING_REFERENCE", affected_ids=sorted(missing))
    counters = {"text": 0, "mixed": 0}
    slots: list[ReferenceSlot] = []
    for index, ref_id in enumerate(request.ordered_ref_ids, start=1):
        ref = resolved[ref_id]
        if not ref.ready:
            raise DirectorContractError("REFERENCE_NOT_READY", affected_ids=[ref_id])
        namespace = "text" if ref.kind == "text" else "mixed"
        counters[namespace] += 1
        slots.append(
            ReferenceSlot(
                ref_id=ref.ref_id,
                kind=ref.kind,
                version=ref.version,
                content_hash=ref.content_hash,
                display_index=index,
                namespace=namespace,
                mention_index=counters[namespace],
            )
        )
    payload = json.dumps(
        [slot.model_dump(by_alias=True) for slot in slots],
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    )
    return ReferenceManifest(
        entries=slots, manifest_hash=sha256(payload.encode()).hexdigest()
    )
