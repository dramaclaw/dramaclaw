"""Attach the signed BrainClaw Control Context to the real OpenAI transport.

The envelope binds to method, path and body digest, so it can only be built
once the request is fully serialised. This module therefore signs inside an
``httpx`` request event hook — the last point where the exact bytes on the wire
are still visible — rather than from a pre-serialisation object, which would
sign something the Gateway never receives.

Two keys with different lifetimes are used, and they are never the same file:

* the *signing* key proves the envelope came from DramaClaw and rotates freely;
  it is shared with BrainClaw through the identical keyring JSON the Go
  verifier loads, so the two ends cannot drift on encoding.
* the *grouping* key mints the opaque trajectory/project IDs and must outlive
  signing-key rotation, because rotating it splits one trajectory into two
  statistical families. ``grouping_key_epoch`` travels with the payload so
  BrainClaw can detect that split instead of silently averaging across it.

Raw project, session and user identifiers never leave this process.
"""

from __future__ import annotations

import base64
import json
import os
import re
import stat
import threading
from contextvars import ContextVar, Token
from dataclasses import dataclass
from pathlib import Path

from novelvideo.brainclaw_control_context import (
    HEADER,
    ControlContext,
    ReplayScopeLimit,
    TurnKind,
    group_id,
    sign_control_context,
)

KEYRING_SCHEMA = "brainclaw.control-context-keyring/v1"

_scope: ContextVar["AnyControlContextScope | None"] = ContextVar(
    "brainclaw_control_context_scope", default=None
)
_runtime: "ControlContextRuntime | None" = None
_runtime_lock = threading.Lock()
_runtime_loaded = False


#: Shape of an already-derived group id, as produced by ``group_id``. Validated
#: rather than trusted: without this check a caller could pass a raw project
#: name down the opaque path and it would be signed verbatim as a "group id",
#: silently defeating the pseudonymisation the whole protocol rests on.
_OPAQUE_GROUP_ID = re.compile(r"^hmac-sha256:[0-9a-f]{16}$")


@dataclass(frozen=True)
class ControlContextScope:
    """The DramaClaw-side identity of the work a request belongs to.

    ``trajectory_id`` and ``project_id`` are raw internal identifiers. They are
    hashed here, in DramaClaw, and are never sent as-is. Only a process that
    holds the grouping key may use this form.
    """

    trajectory_id: str
    project_id: str
    turn_kind: TurnKind = "foreground_user"
    replay_scope_limit: ReplayScopeLimit = "model_output_only"


@dataclass(frozen=True)
class OpaqueControlContextScope:
    """The same identity, already pseudonymised by whoever owns the grouping key.

    This is the form a signer outside DramaClaw receives. It exists so the
    grouping key never has to leave DramaClaw: a downstream signer can prove an
    envelope came from us without being able to derive, or reverse, any group
    id. ``grouping_key_epoch`` travels with the ids because the deriving side,
    not the signing side, knows which epoch produced them.
    """

    trajectory_group_id: str
    project_group_id: str
    grouping_key_epoch: int
    turn_kind: TurnKind = "foreground_user"
    replay_scope_limit: ReplayScopeLimit = "model_output_only"

    def __post_init__(self) -> None:
        for name in ("trajectory_group_id", "project_group_id"):
            value = getattr(self, name)
            if not _OPAQUE_GROUP_ID.match(value or ""):
                raise ValueError(f"{name} is not an opaque group id")
        if self.grouping_key_epoch < 0:
            raise ValueError("grouping_key_epoch must be non-negative")


AnyControlContextScope = ControlContextScope | OpaqueControlContextScope


def begin_control_context(scope: AnyControlContextScope) -> Token:
    return _scope.set(scope)


def reset_control_context(token: Token) -> None:
    _scope.reset(token)


class ControlContextRuntime:
    def __init__(
        self,
        *,
        keyring_path: Path,
        signing_key_id: str,
        grouping_key_path: Path | None = None,
        grouping_key_epoch: int = 0,
    ) -> None:
        """Build a signer.

        ``grouping_key_path`` is optional on purpose. A signer that only ever
        receives ``OpaqueControlContextScope`` — anything running outside
        DramaClaw — must be able to start without the grouping key, because
        holding it would let that process derive or correlate group ids. When
        it is absent, raw scopes are refused rather than silently mishandled.
        """
        self.signing_key_id = signing_key_id
        self.signing_key = _load_keyring_secret(keyring_path, signing_key_id)
        self.grouping_key: bytes | None = None
        self.grouping_key_epoch = grouping_key_epoch
        if grouping_key_path is not None:
            self.grouping_key = _binary_key_bytes(_read_owner_only(grouping_key_path))
            if len(self.grouping_key) < 32:
                raise ValueError("BrainClaw control context grouping key is too short")
            if self.grouping_key == self.signing_key:
                # Sharing one secret would tie the trajectory identity's lifetime to
                # signing-key rotation, which is the exact split the epoch exists
                # to make visible.
                raise ValueError("grouping key must not equal the signing key")
            if grouping_key_epoch < 0:
                raise ValueError("grouping key epoch must be non-negative")
        self._ordinal_lock = threading.Lock()
        self._ordinals: dict[str, int] = {}

    @property
    def derives_group_ids(self) -> bool:
        """True only where the grouping key lives, i.e. inside DramaClaw."""
        return self.grouping_key is not None

    def next_ordinal(self, trajectory_group_id: str) -> int:
        # Per-trajectory and monotonic *as issued*. Concurrency and retries mean
        # BrainClaw may observe them out of order, so it treats the ordinal as
        # a label, not as an ordering guarantee.
        with self._ordinal_lock:
            ordinal = self._ordinals.get(trajectory_group_id, 0)
            self._ordinals[trajectory_group_id] = ordinal + 1
            return ordinal

    def header_for(
        self, scope: AnyControlContextScope, method: str, path: str, body: bytes
    ) -> str:
        if isinstance(scope, OpaqueControlContextScope):
            trajectory = scope.trajectory_group_id
            project = scope.project_group_id
            epoch = scope.grouping_key_epoch
        else:
            if self.grouping_key is None:
                raise ValueError(
                    "a raw scope needs the grouping key; this signer only accepts "
                    "OpaqueControlContextScope"
                )
            trajectory = group_id(self.grouping_key, "trajectory", scope.trajectory_id)
            project = group_id(self.grouping_key, "project", scope.project_id)
            epoch = self.grouping_key_epoch
        context = ControlContext(
            trajectory_group_id=trajectory,
            project_group_id=project,
            grouping_key_epoch=epoch,
            checkpoint_ordinal=self.next_ordinal(trajectory),
            turn_kind=scope.turn_kind,
            replay_scope_limit=scope.replay_scope_limit,
        )
        return sign_control_context(
            context,
            signing_key=self.signing_key,
            signing_key_id=self.signing_key_id,
            method=method,
            endpoint_path=path,
            body=body,
        )


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

def _load_keyring_secret(path: Path, key_id: str) -> bytes:
    document = json.loads(_read_owner_only(path).decode())
    if document.get("schema_version") != KEYRING_SCHEMA:
        raise ValueError(f"control context keyring schema is not {KEYRING_SCHEMA}")
    encoded = document.get("keys", {}).get(key_id)
    if not isinstance(encoded, str):
        raise ValueError(f"control context keyring has no key {key_id!r}")
    try:
        secret = base64.b64decode(encoded, validate=True)
    except (ValueError, TypeError):
        secret = base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4))
    if len(secret) < 32:
        raise ValueError(f"control context signing key {key_id!r} is too short")
    return secret


def control_context_runtime() -> ControlContextRuntime | None:
    """Build the runtime once, or return None when signing is not configured.

    An unconfigured deployment sends no header at all. That is a first-class
    state: BrainClaw records the request as diagnostic evidence rather than
    formal, and nothing downstream mistakes it for a verified family.
    """
    global _runtime, _runtime_loaded
    with _runtime_lock:
        if _runtime_loaded:
            return _runtime
        _runtime_loaded = True
        keyring = os.environ.get("BRAINCLAW_CONTROL_CONTEXT_KEYRING_FILE", "").strip()
        key_id = os.environ.get("BRAINCLAW_CONTROL_CONTEXT_SIGNING_KEY_ID", "").strip()
        grouping = os.environ.get("BRAINCLAW_CONTROL_CONTEXT_GROUPING_KEY_FILE", "").strip()
        if not (keyring and key_id):
            return None
        # The grouping key is optional: a signer that only receives opaque ids
        # must not hold it. Absent key means raw scopes are refused, not that
        # ids get derived some other way.
        _runtime = ControlContextRuntime(
            keyring_path=Path(keyring),
            signing_key_id=key_id,
            grouping_key_path=Path(grouping) if grouping else None,
            grouping_key_epoch=int(
                os.environ.get("BRAINCLAW_CONTROL_CONTEXT_GROUPING_KEY_EPOCH", "1") or "1"
            ),
        )
        return _runtime


def reset_control_context_runtime() -> None:
    """Test seam: forget the cached runtime so env changes take effect."""
    global _runtime, _runtime_loaded
    with _runtime_lock:
        _runtime = None
        _runtime_loaded = False


async def sign_brainclaw_control_context(request) -> None:
    """httpx request event hook. Never raises into the business call path."""
    # A caller-supplied value of this internal header is always replaced, never
    # appended to: httpx headers are multi-valued, and BrainClaw refuses any
    # request presenting more than one envelope.
    request.headers.pop(HEADER, None)
    scope = _scope.get()
    if scope is None:
        return
    runtime = control_context_runtime()
    if runtime is None:
        return
    try:
        body = request.content
    except Exception:
        # Streaming upload: the bytes the signature must cover do not exist yet.
        # Sending an unbound envelope would be worse than sending none.
        return
    try:
        request.headers[HEADER] = runtime.header_for(
            scope, request.method, request.url.path, body
        )
    except Exception:
        # Signing is observability, not the product. A misconfigured key must
        # degrade this request to diagnostic evidence, not fail the trajectory.
        return
