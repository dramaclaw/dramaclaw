"""Issue the short-lived capability Hermes carries to the DramaClaw Gateway.

This is a *different* envelope from the BrainClaw Control Context, on a
different hop:

    DramaClaw --capability--> Gateway --control context--> BrainClaw

The distinction that matters: the Control Context is bound to one exact request
(method, path, body digest), because the Gateway mints it once the outbound
bytes are final. The capability cannot be, because one capability covers every
model call an agent turn makes — and a turn's requests are not known when it is
issued. The capability is therefore a **bearer token**: anyone holding it can
replay it until it expires. Everything below follows from that:

* a short, hard-capped TTL, because TTL is the only thing bounding replay;
* an explicit ``audience``, so a capability cannot be presented elsewhere;
* a ``nonce``, so two turns never produce an identical token;
* it is never logged, never persisted, and stripped at the Gateway before the
  request continues to a provider.

Trusted mode uses no shared signing key. Verified mode retains the original
two-signature protocol for deployments that need cryptographic caller
authentication. In both modes the local grouping key never appears here:
DramaClaw derives opaque ids and the envelope carries only those results.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import stat
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

from novelvideo.brainclaw_control_context import group_id

HEADER = "X-DramaClaw-Control-Capability"
ENVELOPE_VERSION = "v1"
TRUSTED_ENVELOPE_VERSION = "t1"
TRUSTED_KEY_ID = "trusted-local"
PAYLOAD_SCHEMA = "dramaclaw.control-capability/v1"
ISSUER = "dramaclaw"
AUDIENCE = "dramaclaw-gateway"

#: Whole header, including the version and key id prefixes.
MAX_HEADER_BYTES = 4096
#: Hard ceiling on the lifetime of a bearer token. An agent turn can be long,
#: but a capability that outlives its turn is pure replay surface.
MAX_TTL_SECONDS = 900
#: Tolerated clock disagreement between issuer and verifier, in both
#: directions. Without it a correctly issued capability is rejected on a host
#: whose clock is a second behind.
MAX_CLOCK_SKEW_SECONDS = 60

TurnKind = Literal["foreground_user", "internal_maintenance"]
ReplayScopeLimit = Literal["none", "model_output_only"]

OPAQUE_GROUP_ID = re.compile(r"^hmac-sha256:[0-9a-f]{16}$")
SAFE_IDENTIFIER = re.compile(r"^[A-Za-z0-9._:-]{1,128}$")
MAX_GROUPING_KEY_EPOCH = 2**32 - 1


def _b64u(raw: bytes) -> str:
    """Unpadded base64url. Padding is stripped so the encoding is canonical:
    two encoders must not be able to produce two valid spellings of one token.
    """
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def new_nonce() -> str:
    return _b64u(secrets.token_bytes(16))


@dataclass(frozen=True)
class ControlCapability:
    key_id: str
    turn_id: str
    trajectory_group_id: str
    project_group_id: str
    grouping_key_epoch: int
    issued_at: int
    expires_at: int
    nonce: str
    turn_kind: TurnKind = "foreground_user"
    replay_scope_limit: ReplayScopeLimit = "model_output_only"

    def payload(self) -> dict[str, Any]:
        for name in ("trajectory_group_id", "project_group_id"):
            if not OPAQUE_GROUP_ID.match(getattr(self, name) or ""):
                raise ValueError(f"{name} is not an opaque group id")
        for name in ("key_id", "turn_id", "nonce"):
            if not SAFE_IDENTIFIER.match(getattr(self, name) or ""):
                raise ValueError(f"{name} is not a safe identifier")
        if not 0 <= self.grouping_key_epoch <= MAX_GROUPING_KEY_EPOCH:
            raise ValueError("grouping_key_epoch must fit in uint32")
        if self.issued_at < 0 or self.expires_at <= self.issued_at:
            raise ValueError("capability must expire after it is issued")
        if self.expires_at - self.issued_at > MAX_TTL_SECONDS:
            raise ValueError(f"capability TTL exceeds {MAX_TTL_SECONDS}s")
        return {
            "schema_version": PAYLOAD_SCHEMA,
            "issuer": ISSUER,
            "audience": AUDIENCE,
            "key_id": self.key_id,
            "turn_id": self.turn_id,
            "trajectory_group_id": self.trajectory_group_id,
            "project_group_id": self.project_group_id,
            "grouping_key_epoch": self.grouping_key_epoch,
            "turn_kind": self.turn_kind,
            "replay_scope_limit": self.replay_scope_limit,
            "issued_at": self.issued_at,
            "expires_at": self.expires_at,
            "nonce": self.nonce,
        }


def sign_control_capability(capability: ControlCapability, *, signing_key: bytes) -> str:
    """Return the header value.

    Note what is *not* covered: method, path and body. A capability spans every
    request of one turn, so binding it to one of them would be wrong. Request
    binding happens one hop later, in the Control Context the Gateway mints.
    """
    payload_b64 = _b64u(
        json.dumps(capability.payload(), sort_keys=True, separators=(",", ":")).encode()
    )
    signature = _sign(signing_key, ENVELOPE_VERSION, capability.key_id, payload_b64)
    header = f"{ENVELOPE_VERSION}.{capability.key_id}.{payload_b64}.{signature}"
    if len(header.encode()) > MAX_HEADER_BYTES:
        raise ValueError("control capability header exceeds the frozen size limit")
    return header


def encode_trusted_capability(capability: ControlCapability) -> str:
    """Encode identity for a Gateway explicitly configured to trust callers.

    This carries no signature and makes no authentication claim. Structural,
    privacy and TTL checks still run at Claymore; the mode is appropriate when
    the deployment controls which callers can reach that gateway.
    """
    payload_b64 = _b64u(
        json.dumps(capability.payload(), sort_keys=True, separators=(",", ":")).encode()
    )
    header = f"{TRUSTED_ENVELOPE_VERSION}.{payload_b64}"
    if len(header.encode()) > MAX_HEADER_BYTES:
        raise ValueError("trusted control capability header exceeds the size limit")
    return header


def _sign(signing_key: bytes, version: str, key_id: str, payload_b64: str) -> str:
    # The signature covers the payload's exact base64 string, never a
    # re-serialised JSON object, so canonicalisation can never diverge between
    # languages. NUL separates the fields so no concatenation of two values can
    # be confused with another split of the same bytes.
    parts = [version.encode(), key_id.encode(), payload_b64.encode()]
    return _b64u(hmac.new(signing_key, b"\x00".join(parts), hashlib.sha256).digest())


# --- Issuer runtime -------------------------------------------------------

_issuer: "ControlCapabilityIssuer | None" = None
_issuer_lock = threading.Lock()
_issuer_loaded = False

#: Default lifetime. Long enough for a normal agent turn, far below the frozen
#: ceiling, because a bearer token's replay window is exactly its TTL.
DEFAULT_TTL_SECONDS = 300


def _read_owner_only(path: Path) -> bytes:
    info = path.stat()
    if not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) & 0o077:
        raise ValueError(f"{path.name} must be an owner-only regular file")
    return path.read_bytes()

def _binary_key_bytes(raw: bytes) -> bytes:
    """Return a raw binary key exactly as stored.

    Nothing is trimmed, deliberately. ``bytes.strip()`` was the original bug: a
    random 32-byte key begins or ends with an ASCII whitespace byte about 5% of
    the time, so stripping either shortened it below the minimum or — worse —
    left a still-long-enough key whose two ends derived different opaque ids
    from the same file.

    Trimming only a trailing newline was the same mistake in a smaller size. A
    raw key ends in 0x0a once every 256 files, and that byte is key material,
    not an editor artefact. This file is binary; if a human-editable form is
    ever wanted it should be an explicit base64 or hex encoding, decoded here,
    rather than a guess about which trailing bytes were meant.

    A file that accidentally carries a trailing newline is simply a different
    32-or-33-byte key, and both sides read the same file, so they still agree.
    Length is enforced by the caller.
    """
    return raw


def _default_grouping_key_path() -> Path:
    from novelvideo.config import STATE_DIR

    return Path(STATE_DIR) / "brainclaw" / "grouping.key"


def _ensure_local_grouping_key(path: Path) -> Path:
    """Create the one local-only identity key once, safe under worker races."""
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    try:
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        return path
    try:
        with os.fdopen(descriptor, "wb") as target:
            target.write(secrets.token_bytes(32))
            target.flush()
            os.fsync(target.fileno())
    except BaseException:
        try:
            path.unlink()
        except OSError:
            pass
        raise
    return path

class ControlCapabilityIssuer:
    """Mints one capability per agent turn.

    This is the only place that sees raw trajectory/project ids. The local
    grouping key derives opaque ids here. A signing key is optional and is used
    only by verified mode; trusted mode sends the same strictly validated
    claims without claiming cryptographic authentication.
    """

    def __init__(
        self,
        *,
        keyring_path: Path | None,
        signing_key_id: str | None,
        grouping_key_path: Path,
        grouping_key_epoch: int,
        ttl_seconds: int = DEFAULT_TTL_SECONDS,
    ) -> None:
        self.signing_key_id = signing_key_id or TRUSTED_KEY_ID
        self.signing_key: bytes | None = None
        if keyring_path is not None:
            if not signing_key_id:
                raise ValueError("a capability keyring requires a signing key id")
            from novelvideo.brainclaw_control_context_transport import _load_keyring_secret

            self.signing_key = _load_keyring_secret(keyring_path, signing_key_id)
        self.grouping_key = _binary_key_bytes(_read_owner_only(grouping_key_path))
        if len(self.grouping_key) < 32:
            raise ValueError("grouping key is too short")
        if self.signing_key is not None and self.grouping_key == self.signing_key:
            # One secret for both would tie a trajectory's identity lifetime to
            # signing-key rotation, which is the split the epoch exists to show.
            raise ValueError("grouping key must not equal the capability signing key")
        if grouping_key_epoch < 0:
            raise ValueError("grouping key epoch must be non-negative")
        if not 0 < ttl_seconds <= MAX_TTL_SECONDS:
            raise ValueError(f"ttl must be within (0, {MAX_TTL_SECONDS}]")
        self.grouping_key_epoch = grouping_key_epoch
        self.ttl_seconds = ttl_seconds

    def group_ids(self, trajectory_id: str, project_id: str) -> tuple[str, str]:
        return (
            group_id(self.grouping_key, "trajectory", trajectory_id),
            group_id(self.grouping_key, "project", project_id),
        )

    def issue(
        self,
        *,
        trajectory_id: str,
        project_id: str,
        turn_id: str,
        turn_kind: TurnKind = "foreground_user",
        replay_scope_limit: ReplayScopeLimit = "model_output_only",
        now: int | None = None,
    ) -> str:
        """Return the header value for one turn."""
        issued_at = int(now if now is not None else time.time())
        trajectory, project = self.group_ids(trajectory_id, project_id)
        capability = ControlCapability(
            key_id=self.signing_key_id,
            turn_id=turn_id,
            trajectory_group_id=trajectory,
            project_group_id=project,
            grouping_key_epoch=self.grouping_key_epoch,
            issued_at=issued_at,
            expires_at=issued_at + self.ttl_seconds,
            nonce=new_nonce(),
            turn_kind=turn_kind,
            replay_scope_limit=replay_scope_limit,
        )
        if self.signing_key is None:
            return encode_trusted_capability(capability)
        return sign_control_capability(capability, signing_key=self.signing_key)


def control_capability_issuer() -> "ControlCapabilityIssuer | None":
    """Build the issuer once.

    With no shared signing-key configuration this defaults to trusted mode and
    creates one persistent local grouping key. Supplying both signing settings
    opts into the original verified protocol; half-configuration is rejected.
    """
    global _issuer, _issuer_loaded
    with _issuer_lock:
        if _issuer_loaded:
            return _issuer
        keyring = os.environ.get("BRAINCLAW_CAPABILITY_KEYRING_FILE", "").strip()
        key_id = os.environ.get("BRAINCLAW_CAPABILITY_SIGNING_KEY_ID", "").strip()
        grouping = os.environ.get("BRAINCLAW_CONTROL_CONTEXT_GROUPING_KEY_FILE", "").strip()
        if bool(keyring) != bool(key_id):
            raise ValueError("capability keyring and signing key id must be configured together")
        grouping_path = Path(grouping) if grouping else _default_grouping_key_path()
        _ensure_local_grouping_key(grouping_path)
        issuer = ControlCapabilityIssuer(
            keyring_path=Path(keyring) if keyring else None,
            signing_key_id=key_id or None,
            grouping_key_path=grouping_path,
            grouping_key_epoch=int(
                os.environ.get("BRAINCLAW_CONTROL_CONTEXT_GROUPING_KEY_EPOCH", "1") or "1"
            ),
            ttl_seconds=int(
                os.environ.get("BRAINCLAW_CAPABILITY_TTL_SECONDS", str(DEFAULT_TTL_SECONDS))
                or DEFAULT_TTL_SECONDS
            ),
        )
        _issuer = issuer
        _issuer_loaded = True
        return _issuer


def reset_control_capability_issuer() -> None:
    """Test seam: forget the cached issuer so env changes take effect."""
    global _issuer, _issuer_loaded
    with _issuer_lock:
        _issuer = None
        _issuer_loaded = False
