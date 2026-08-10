"""Fail-closed runtime configuration for TaskEnvelope signing."""

from __future__ import annotations

import base64
import binascii
from dataclasses import dataclass, field
import json
import logging
import os
from pathlib import Path
import re
import secrets
from types import MappingProxyType
from typing import Mapping

logger = logging.getLogger("novelvideo.task_backend.signing")

_ACTIVE_KEY_ID_ENV = "ST_TASK_ENVELOPE_ACTIVE_KEY_ID"
_KEYRING_ENV = "ST_TASK_ENVELOPE_KEYRING_B64_JSON"
_KEY_ID_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}\Z")

_LOCAL_KEYRING_FILENAME = "task_envelope_keyring.json"
_LOCAL_KEY_ID = "ce-local-v1"
_LOCAL_KEY_BYTES = 32


class TaskEnvelopeSigningConfigError(RuntimeError):
    code = "TASK_ENVELOPE_CONFIG_INVALID"

    def __init__(self) -> None:
        super().__init__("task envelope signing configuration is invalid")


@dataclass(frozen=True)
class TaskEnvelopeSigningConfig:
    active_key_id: str = field(repr=False)
    keyring: Mapping[str, bytes] = field(repr=False)


def _object_without_duplicate_keys(
    pairs: list[tuple[str, object]],
) -> dict[str, object]:
    value: dict[str, object] = {}
    for key, item in pairs:
        if key in value:
            raise ValueError
        value[key] = item
    return value


def _decode_key(value: object) -> bytes:
    if type(value) is not str or not value:
        raise ValueError
    encoded = value.encode("ascii")
    try:
        decoded = base64.b64decode(encoded, validate=True)
    except (ValueError, binascii.Error):
        raise ValueError from None
    if len(decoded) < 32 or base64.b64encode(decoded) != encoded:
        raise ValueError
    return decoded


def _build_config(active_key_id: object, raw_keyring: object) -> TaskEnvelopeSigningConfig:
    """Validate one active kid plus a ``{kid: canonical-b64}`` object.

    Shared by the environment parser and the CE-local keyring file so both
    entry points enforce the identical frozen contract.
    """
    if (
        type(active_key_id) is not str
        or _KEY_ID_RE.fullmatch(active_key_id) is None
        or type(raw_keyring) is not str
        or not raw_keyring
    ):
        raise ValueError

    parsed = json.loads(raw_keyring, object_pairs_hook=_object_without_duplicate_keys)
    if type(parsed) is not dict or not parsed:
        raise ValueError

    keyring: dict[str, bytes] = {}
    for key_id, encoded_key in parsed.items():
        if type(key_id) is not str or _KEY_ID_RE.fullmatch(key_id) is None:
            raise ValueError
        keyring[key_id] = _decode_key(encoded_key)
    if active_key_id not in keyring:
        raise ValueError

    return TaskEnvelopeSigningConfig(
        active_key_id=active_key_id,
        keyring=MappingProxyType(dict(keyring)),
    )


def _parse_config() -> TaskEnvelopeSigningConfig:
    return _build_config(
        os.environ.get(_ACTIVE_KEY_ID_ENV),
        os.environ.get(_KEYRING_ENV),
    )


def load_task_envelope_signing_config() -> TaskEnvelopeSigningConfig:
    failed = False
    try:
        config = _parse_config()
    except Exception:
        failed = True
        config = None
    if failed or config is None:
        raise TaskEnvelopeSigningConfigError from None
    return config


def _local_keyring_path() -> Path:
    configured = os.environ.get("NOVELVIDEO_STATE_DIR", "").strip()
    if configured:
        base = Path(configured)
    else:
        from novelvideo.config import STATE_DIR

        base = Path(STATE_DIR)
    return base / _LOCAL_KEYRING_FILENAME


def _config_from_document(document: object) -> TaskEnvelopeSigningConfig:
    if type(document) is not dict:
        raise ValueError
    return _build_config(
        document.get("active_key_id"),
        json.dumps(document.get("keyring")),
    )


def _read_local_keyring(path: Path) -> TaskEnvelopeSigningConfig | None:
    try:
        raw = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return None
    except OSError:
        return None
    # A keyring that exists but does not parse is tampering or corruption, not
    # a first boot; regenerating here would silently invalidate live envelopes.
    return _config_from_document(json.loads(raw))


def _persist_local_keyring(path: Path, document: dict) -> TaskEnvelopeSigningConfig:
    """Create the keyring exactly once, even under a concurrent first boot.

    The payload is written to a private temporary file and only then linked
    into place, so a racing reader can never observe a half-written keyring
    (the failure mode behind rails/rails#53661).
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    serialized = json.dumps(document, sort_keys=True).encode("utf-8")
    temp_path = path.with_name(f"{path.name}.{os.getpid()}.{secrets.token_hex(8)}.tmp")
    fd = os.open(str(temp_path), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    try:
        os.write(fd, serialized)
    finally:
        os.close(fd)
    try:
        try:
            os.link(str(temp_path), str(path))
        except FileExistsError:
            pass
        except OSError:
            # Filesystems without hard links: fall back to an atomic replace.
            # A concurrent writer may win, so the on-disk copy still decides.
            os.replace(str(temp_path), str(path))
    finally:
        try:
            os.unlink(str(temp_path))
        except OSError:
            pass
    existing = _read_local_keyring(path)
    if existing is None:
        raise OSError("task envelope keyring vanished after persist")
    return existing


def load_or_create_local_signing_config() -> TaskEnvelopeSigningConfig:
    """CE-only: honour explicit config, otherwise generate a per-install keyring.

    CE is published as a public image whose compose file marks ``.env``
    optional, so a fail-closed signing config would crash every out-of-the-box
    install. CE therefore behaves like Rails' ``secret_key_base`` outside
    production: generate once, persist, reuse. EE never reaches this function —
    the gate is the edition, never "the config happens to be missing", so a
    misconfigured EE deploy still refuses to start instead of silently minting
    per-process keys that its workers cannot verify.
    """
    from novelvideo.shared.runtime_env import is_ce_effective

    # Explicit configuration wins in every edition and stays fail-closed; the
    # edition gate below guards key *generation* only, which is the whole of
    # the CE exception.
    if os.environ.get(_ACTIVE_KEY_ID_ENV) or os.environ.get(_KEYRING_ENV):
        return load_task_envelope_signing_config()

    if not is_ce_effective():
        raise TaskEnvelopeSigningConfigError from None

    path = _local_keyring_path()
    failed = False
    try:
        config = _read_local_keyring(path)
    except Exception:
        failed = True
        config = None
    if failed:
        raise TaskEnvelopeSigningConfigError from None
    if config is not None:
        return config

    document = {
        "active_key_id": _LOCAL_KEY_ID,
        "keyring": {
            _LOCAL_KEY_ID: base64.b64encode(
                secrets.token_bytes(_LOCAL_KEY_BYTES)
            ).decode("ascii")
        },
    }
    try:
        return _persist_local_keyring(path, document)
    except OSError as exc:
        # A read-only state volume must not brick the install. CE runs producer
        # and consumer in one inline process, so an ephemeral key still signs
        # and verifies; it only resets on restart.
        logger.warning(
            "could not persist the task envelope keyring to %s (%s); using an "
            "ephemeral key for this process. Set %s and %s explicitly to keep "
            "signatures stable across restarts or hosts.",
            path,
            exc,
            _ACTIVE_KEY_ID_ENV,
            _KEYRING_ENV,
        )
    return _config_from_document(document)
