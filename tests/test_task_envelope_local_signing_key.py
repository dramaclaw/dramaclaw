"""CE-only local signing keyring: zero-config boot without weakening EE.

CE ships as a public image whose compose file declares ``.env`` optional
(``docker-compose.release.yml``), so a fail-closed signing config would make
every out-of-the-box CE install crash at bootstrap. CE therefore generates and
persists its own keyring, exactly like Rails' ``secret_key_base`` in
development/test. EE keeps failing closed: the gate is the edition, never
"config happens to be missing".
"""

import base64
import json
import os
import stat
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

ACTIVE_ENV = "ST_TASK_ENVELOPE_ACTIVE_KEY_ID"
KEYRING_ENV = "ST_TASK_ENVELOPE_KEYRING_B64_JSON"
KEYRING_FILE = "task_envelope_keyring.json"


def _encoded(value: bytes) -> str:
    return base64.b64encode(value).decode("ascii")


@pytest.fixture
def ce_env(monkeypatch, tmp_path):
    """A CE-effective process with no signing env and an empty state dir."""
    monkeypatch.delenv(ACTIVE_ENV, raising=False)
    monkeypatch.delenv(KEYRING_ENV, raising=False)
    monkeypatch.setenv("ST_EDITION", "ce")
    monkeypatch.delenv("ST_CONTROL_PLANE_DSN", raising=False)
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(tmp_path))
    return tmp_path


def _load_local(**kwargs):
    from novelvideo.task_backend.signing import load_or_create_local_signing_config

    return load_or_create_local_signing_config(**kwargs)


def test_ce_generates_and_persists_a_usable_keyring(ce_env):
    config = _load_local()

    assert config.active_key_id in config.keyring
    key = config.keyring[config.active_key_id]
    assert isinstance(key, bytes) and len(key) >= 32

    path = ce_env / KEYRING_FILE
    assert path.exists()
    assert stat.S_IMODE(path.stat().st_mode) == 0o600


def test_ce_reuses_the_persisted_keyring_across_restarts(ce_env):
    first = _load_local()
    second = _load_local()

    assert second.active_key_id == first.active_key_id
    assert second.keyring == first.keyring


def test_generated_keyring_survives_a_producer_consumer_roundtrip(ce_env):
    """A generated key must satisfy the same contract as a configured one."""
    from novelvideo.task_backend.envelope import SignedTaskEnvelope

    config = _load_local()
    stored = json.loads((ce_env / KEYRING_FILE).read_text(encoding="utf-8"))

    # The persisted form is exactly what an operator would paste into the two
    # env vars, so a CE install can be promoted to an explicit config.
    assert stored["active_key_id"] == config.active_key_id
    assert set(stored["keyring"]) == set(config.keyring)
    for key_id, encoded in stored["keyring"].items():
        assert base64.b64decode(encoded.encode("ascii"), validate=True) == (
            config.keyring[key_id]
        )
    assert SignedTaskEnvelope is not None


def test_explicit_env_config_wins_over_the_generated_file(ce_env, monkeypatch):
    generated = _load_local()

    monkeypatch.setenv(ACTIVE_ENV, "operator-v1")
    monkeypatch.setenv(
        KEYRING_ENV, json.dumps({"operator-v1": _encoded(b"o" * 32)})
    )
    config = _load_local()

    assert config.active_key_id == "operator-v1"
    assert config.keyring == {"operator-v1": b"o" * 32}
    assert config.active_key_id != generated.active_key_id


@pytest.mark.parametrize(
    ("edition", "dsn"),
    [
        (None, None),
        ("", None),
        ("ee", None),
        ("ce", "postgresql://control-plane/db"),
        (None, "postgresql://control-plane/db"),
    ],
)
def test_non_ce_never_generates_a_key(monkeypatch, tmp_path, edition, dsn):
    from novelvideo.task_backend.signing import TaskEnvelopeSigningConfigError

    monkeypatch.delenv(ACTIVE_ENV, raising=False)
    monkeypatch.delenv(KEYRING_ENV, raising=False)
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(tmp_path))
    if edition is None:
        monkeypatch.delenv("ST_EDITION", raising=False)
    else:
        monkeypatch.setenv("ST_EDITION", edition)
    if dsn is None:
        monkeypatch.delenv("ST_CONTROL_PLANE_DSN", raising=False)
    else:
        monkeypatch.setenv("ST_CONTROL_PLANE_DSN", dsn)

    with pytest.raises(TaskEnvelopeSigningConfigError):
        _load_local()
    assert not (tmp_path / KEYRING_FILE).exists()


def test_non_ce_still_accepts_explicit_config(monkeypatch, tmp_path):
    """The edition gate guards key *generation*, not key *loading*.

    An operator who configured the envelope keyring has already made the
    decision the gate exists to protect; refusing it in EE would only break
    callers that are correctly configured while adding no safety.
    """
    monkeypatch.setenv("ST_EDITION", "ee")
    monkeypatch.setenv("ST_CONTROL_PLANE_DSN", "postgresql://control-plane/db")
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(tmp_path))
    monkeypatch.setenv(ACTIVE_ENV, "operator-v1")
    monkeypatch.setenv(KEYRING_ENV, json.dumps({"operator-v1": _encoded(b"o" * 32)}))

    config = _load_local()

    assert config.active_key_id == "operator-v1"
    # Loading an explicit keyring must never leave a generated file behind.
    assert not (tmp_path / KEYRING_FILE).exists()


def test_concurrent_first_boot_converges_on_one_key(ce_env):
    """Rails' generate_local_secret is not thread-safe (rails/rails#53661);
    parallel first boots must not race into different keys or exceptions."""
    with ThreadPoolExecutor(max_workers=8) as pool:
        configs = list(pool.map(lambda _: _load_local(), range(8)))

    active_ids = {config.active_key_id for config in configs}
    keys = {config.keyring[config.active_key_id] for config in configs}
    assert len(active_ids) == 1
    assert len(keys) == 1


def test_corrupt_persisted_keyring_fails_closed(ce_env):
    from novelvideo.task_backend.signing import TaskEnvelopeSigningConfigError

    path = ce_env / KEYRING_FILE
    path.write_text('{"active_key_id": "x", "keyring": {"x": "%%%"}}', "utf-8")

    with pytest.raises(TaskEnvelopeSigningConfigError):
        _load_local()


def test_generated_config_never_leaks_key_material_in_repr(ce_env):
    config = _load_local()

    rendered = repr(config)
    assert config.active_key_id not in rendered
    assert repr(config.keyring[config.active_key_id]) not in rendered


def test_unwritable_state_dir_still_boots_ce(ce_env, monkeypatch):
    """A read-only volume must not brick a CE install; the key is ephemeral
    but producer and consumer share one process, so inline delivery works."""
    unwritable = ce_env / "ro"
    unwritable.mkdir()
    monkeypatch.setenv("NOVELVIDEO_STATE_DIR", str(unwritable))
    os.chmod(unwritable, 0o500)
    try:
        config = _load_local()
    finally:
        os.chmod(unwritable, 0o700)

    assert config.active_key_id in config.keyring
    assert len(config.keyring[config.active_key_id]) >= 32
    assert not (Path(unwritable) / KEYRING_FILE).exists()
