"""Fail-closed runtime configuration for TaskEnvelope signing."""

from __future__ import annotations

import base64
import binascii
from dataclasses import dataclass, field
import json
import os
import re
from types import MappingProxyType
from typing import Mapping

_ACTIVE_KEY_ID_ENV = "ST_TASK_ENVELOPE_ACTIVE_KEY_ID"
_KEYRING_ENV = "ST_TASK_ENVELOPE_KEYRING_B64_JSON"
_KEY_ID_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}\Z")


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


def _parse_config() -> TaskEnvelopeSigningConfig:
    active_key_id = os.environ.get(_ACTIVE_KEY_ID_ENV)
    raw_keyring = os.environ.get(_KEYRING_ENV)
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
