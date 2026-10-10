"""Sign the BrainClaw Control Context for a DramaClaw request.

BrainClaw cannot derive which trajectory or project a request belongs to, and that
identity cannot be reconstructed afterwards, so DramaClaw states it here. The
grouping IDs are HMACs of DramaClaw-side identifiers: BrainClaw only ever
compares them for equality and never learns the underlying project, session or
user.

The signature covers the request itself — method, path and body digest — not
just the payload. Without that binding a captured envelope could be replayed
onto a different request to relabel arbitrary traffic into someone else's
family. Both this signer and the BrainClaw Go verifier are checked against the
frozen vectors in ``profiles/control-context/vectors.json`` of the BrainClaw
repository, so the two implementations align on encoding rather than on each
other.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
from dataclasses import dataclass
from typing import Literal

HEADER = "X-DramaClaw-Control-Context"
ENVELOPE_VERSION = "v1"
PAYLOAD_SCHEMA = "dramaclaw.brainclaw-context/v1"
MAX_HEADER_BYTES = 4096
MAX_CHECKPOINT_ORDINAL = 2**32 - 1

TurnKind = Literal["foreground_user", "internal_maintenance"]
ReplayScopeLimit = Literal["none", "model_output_only"]


def _b64u(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def group_id(grouping_key: bytes, kind: str, raw_identifier: str) -> str:
    """Derive an opaque, stable group id.

    ``kind`` separates the trajectory and project namespaces so the same string
    cannot collide across them. The grouping key must outlive signing-key
    rotation: rotating it silently splits one trajectory into two families, which
    is why ``grouping_key_epoch`` travels with the payload.
    """
    digest = hmac.new(grouping_key, f"{kind}\x00{raw_identifier}".encode(), hashlib.sha256)
    return "hmac-sha256:" + digest.hexdigest()[:16]


@dataclass(frozen=True)
class ControlContext:
    trajectory_group_id: str
    project_group_id: str
    grouping_key_epoch: int
    checkpoint_ordinal: int
    turn_kind: TurnKind = "foreground_user"
    replay_scope_limit: ReplayScopeLimit = "model_output_only"

    def payload(self) -> dict[str, object]:
        if not 0 <= self.checkpoint_ordinal <= MAX_CHECKPOINT_ORDINAL:
            raise ValueError("checkpoint_ordinal must fit in uint32")
        if self.grouping_key_epoch < 0:
            raise ValueError("grouping_key_epoch must be non-negative")
        # A project-less caller repeats the trajectory id rather than omitting the
        # field: BrainClaw refuses to invent a grouping it cannot see.
        return {
            "schema_version": PAYLOAD_SCHEMA,
            "trajectory_group_id": self.trajectory_group_id,
            "project_group_id": self.project_group_id,
            "grouping_key_epoch": self.grouping_key_epoch,
            "checkpoint_ordinal": self.checkpoint_ordinal,
            "turn_kind": self.turn_kind,
            "replay_scope_limit": self.replay_scope_limit,
        }


def sign_control_context(
    context: ControlContext,
    *,
    signing_key: bytes,
    signing_key_id: str,
    method: str,
    endpoint_path: str,
    body: bytes,
) -> str:
    """Return the header value for this exact request."""
    payload_b64 = _b64u(
        json.dumps(context.payload(), sort_keys=True, separators=(",", ":")).encode()
    )
    signature = _sign(
        signing_key, method, endpoint_path, ENVELOPE_VERSION, signing_key_id, payload_b64, body
    )
    header = f"{ENVELOPE_VERSION}.{signing_key_id}.{payload_b64}.{signature}"
    if len(header.encode()) > MAX_HEADER_BYTES:
        raise ValueError("control context header exceeds the frozen size limit")
    return header


def _sign(
    signing_key: bytes,
    method: str,
    endpoint_path: str,
    version: str,
    signing_key_id: str,
    payload_b64: str,
    body: bytes,
) -> str:
    # Signing covers the payload's exact base64 string, never a re-serialised
    # JSON object, so canonicalisation can never diverge between languages.
    parts = [
        method.encode(),
        endpoint_path.encode(),
        version.encode(),
        signing_key_id.encode(),
        payload_b64.encode(),
        hashlib.sha256(body).hexdigest().encode(),
    ]
    return _b64u(hmac.new(signing_key, b"\x00".join(parts), hashlib.sha256).digest())
