import base64
import json
from types import MappingProxyType, SimpleNamespace

import pytest

ACTIVE_ENV = "ST_TASK_ENVELOPE_ACTIVE_KEY_ID"
KEYRING_ENV = "ST_TASK_ENVELOPE_KEYRING_B64_JSON"


def _encoded(value: bytes) -> str:
    return base64.b64encode(value).decode("ascii")


def _load(monkeypatch, *, active="active-v1", keyring=None):
    from novelvideo.task_backend.signing import load_task_envelope_signing_config

    monkeypatch.setenv(ACTIVE_ENV, active)
    monkeypatch.setenv(
        KEYRING_ENV,
        json.dumps(keyring or {"active-v1": _encoded(b"a" * 32)}),
    )
    return load_task_envelope_signing_config()


def test_load_signing_config_supports_rotation_and_immutable_copy(monkeypatch):
    config = _load(
        monkeypatch,
        keyring={"retired-v1": _encoded(b"r" * 32), "active-v1": _encoded(b"a" * 32)},
    )

    assert config.active_key_id == "active-v1"
    assert config.keyring == {"retired-v1": b"r" * 32, "active-v1": b"a" * 32}
    assert isinstance(config.keyring, MappingProxyType)
    assert "active-v1" not in repr(config)
    assert repr(b"a" * 32) not in repr(config)
    with pytest.raises(TypeError):
        config.keyring["other"] = b"x" * 32


@pytest.mark.parametrize(
    ("active", "raw_keyring"),
    [
        (None, None),
        ("", None),
        ("active-v1", None),
        ("active-v1", ""),
        ("bad kid", '{"bad kid":"' + _encoded(b"a" * 32) + '"}'),
        ("missing-v1", '{"active-v1":"' + _encoded(b"a" * 32) + '"}'),
        ("active-v1", "[]"),
        ("active-v1", '"scalar"'),
        ("active-v1", "{}"),
        ("active-v1", '{"active-v1":{"nested":"value"}}'),
        ("active-v1", '{"active-v1":"%%%"}'),
        ("active-v1", '{"active-v1":"' + _encoded(b"short") + '"}'),
        ("active-v1", '{"active-v1":"' + _encoded(b"a" * 32).rstrip("=") + '"}'),
        (
            "active-v1",
            '{"active-v1":"'
            + _encoded(b"a" * 32)
            + '","active-v1":"'
            + _encoded(b"b" * 32)
            + '"}',
        ),
    ],
)
def test_load_signing_config_rejects_invalid_values_without_leaking(
    monkeypatch, active, raw_keyring
):
    from novelvideo.task_backend.signing import TaskEnvelopeSigningConfigError

    if active is None:
        monkeypatch.delenv(ACTIVE_ENV, raising=False)
    else:
        monkeypatch.setenv(ACTIVE_ENV, active)
    if raw_keyring is None:
        monkeypatch.delenv(KEYRING_ENV, raising=False)
    else:
        monkeypatch.setenv(KEYRING_ENV, raw_keyring)

    with pytest.raises(TaskEnvelopeSigningConfigError) as captured:
        from novelvideo.task_backend.signing import load_task_envelope_signing_config

        load_task_envelope_signing_config()

    error = captured.value
    assert error.code == "TASK_ENVELOPE_CONFIG_INVALID"
    assert str(error) == "task envelope signing configuration is invalid"
    assert error.__cause__ is None
    assert error.__context__ is None
    rendered = f"{error!r}\n{error}"
    for canary in ("active-v1", "missing-v1", "%%%", "short", "nested"):
        assert canary not in rendered


def test_load_signing_config_normalizes_ordinary_environment_errors(monkeypatch):
    import novelvideo.task_backend.signing as signing

    class BrokenEnvironment:
        def get(self, key, default=None):
            raise RuntimeError("environment-canary")

    monkeypatch.setattr(signing, "os", SimpleNamespace(environ=BrokenEnvironment()))

    with pytest.raises(signing.TaskEnvelopeSigningConfigError) as captured:
        signing.load_task_envelope_signing_config()

    assert captured.value.__cause__ is None
    assert captured.value.__context__ is None
    assert "environment-canary" not in repr(captured.value)


def test_load_signing_config_propagates_base_exception(monkeypatch):
    import novelvideo.task_backend.signing as signing

    class InterruptingEnvironment:
        def get(self, key, default=None):
            raise KeyboardInterrupt

    monkeypatch.setattr(
        signing, "os", SimpleNamespace(environ=InterruptingEnvironment())
    )

    with pytest.raises(KeyboardInterrupt):
        signing.load_task_envelope_signing_config()


def test_loaded_config_never_reads_environment_again(monkeypatch):
    config = _load(monkeypatch)

    monkeypatch.delenv(ACTIVE_ENV)
    monkeypatch.delenv(KEYRING_ENV)

    assert config.active_key_id == "active-v1"
    assert config.keyring["active-v1"] == b"a" * 32
