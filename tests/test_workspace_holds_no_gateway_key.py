"""Under the per-turn latch, no real gateway key may exist on disk.

The worker's process environment already carries only a placeholder. That was
never the whole guarantee: Hermes loads `HERMES_HOME/.env` at startup and the
generated `config.yaml` resolves its provider key through `key_env`, so a real
value in that file restores the deployment credential the latch exists to
remove — and an organisation turn then bills the platform with nothing to show
for it. The canary found the key sitting there while every environment
assertion passed.
"""
from __future__ import annotations

import pytest

from novelvideo.chat import hermes_workspace

PLATFORM = "sk-platform-canary"
ORG_A = "sk-org-a-canary"
ORG_B = "sk-org-b-canary"
MANAGED = ("NEWAPI_API_KEY", "OPENAI_API_KEY")


@pytest.fixture
def per_turn(monkeypatch):
    monkeypatch.setenv("DRAMACLAW_GATEWAY_CREDENTIAL_MODE", "per_turn_required")
    monkeypatch.setattr(hermes_workspace, "effective_gateway_credentials",
                        lambda: (PLATFORM, "https://gateway.example"))


def _keys_on_disk(root) -> list[str]:
    found = []
    for path in root.rglob("*"):
        if not path.is_file():
            continue
        try:
            text = path.read_text(errors="ignore")
        except OSError:
            continue
        for secret in (PLATFORM, ORG_A, ORG_B):
            if secret in text:
                found.append(f"{path.name}:{secret[:11]}…")
    return found


def test_no_key_is_written_under_the_per_turn_latch(per_turn, tmp_path):
    env_file = tmp_path / ".env"
    env_file.write_text("# workspace\n")
    hermes_workspace._ensure_gateway_env_file(env_file)
    assert _keys_on_disk(tmp_path) == []
    for name in MANAGED:
        assert name not in env_file.read_text()


def test_an_existing_workspace_is_migrated_idempotently(per_turn, tmp_path):
    """A workspace written before this rule must lose its key, and stay clean."""
    env_file = tmp_path / ".env"
    env_file.write_text(
        f"# workspace\nNEWAPI_API_KEY={PLATFORM}\nOPENAI_API_KEY={PLATFORM}\n"
        "DRAMACLAW_KEEP_ME=preserved\n")

    for _ in range(3):        # idempotent: repeated runs neither restore nor churn
        hermes_workspace._remove_managed_model_env_values(env_file)
        hermes_workspace._ensure_gateway_env_file(env_file)
        assert _keys_on_disk(tmp_path) == []

    remaining = env_file.read_text()
    assert "DRAMACLAW_KEEP_ME=preserved" in remaining, \
        "migration must not discard unrelated workspace settings"


def test_no_credential_mode_can_put_a_key_back_on_disk(monkeypatch, tmp_path):
    """There is no escape hatch, and that is deliberate.

    A `legacy_environment` mode used to exist and was worse than none. It wrote
    the real key back to disk while `build_hermes_child_env` still gave the
    worker a placeholder and the per-turn latch — so a "legacy" deployment got
    the exposure of the old design and the behaviour of the new one at once:
    the worker still failed closed, and now a live credential sat on disk too.

    Half a compatibility mode is more dangerous than none, because it reads as
    a supported path. New DramaClaw is installed paired with the Hermes fork.
    """
    monkeypatch.setattr(hermes_workspace, "effective_gateway_credentials",
                        lambda: (PLATFORM, "https://gateway.example"))
    for mode in ("", "legacy_environment", "per_turn_required", "anything",
                 "per_tun_required", "LEGACY_ENVIRONMENT"):
        monkeypatch.setenv("DRAMACLAW_GATEWAY_CREDENTIAL_MODE", mode)
        env_file = tmp_path / f"env-{mode or 'unset'}"
        env_file.write_text("# workspace\n")
        hermes_workspace._ensure_gateway_env_file(env_file)
        assert PLATFORM not in env_file.read_text(), \
            f"mode {mode!r} put a gateway key back on disk"


def test_an_existing_workspace_is_still_migrated(monkeypatch, tmp_path):
    """A workspace written before this rule loses its key and keeps the rest."""
    monkeypatch.setattr(hermes_workspace, "effective_gateway_credentials",
                        lambda: (PLATFORM, "https://gateway.example"))
    env_file = tmp_path / ".env"
    env_file.write_text(
        f"# workspace\nNEWAPI_API_KEY={PLATFORM}\nOPENAI_API_KEY={PLATFORM}\n"
        "DRAMACLAW_KEEP_ME=preserved\n")
    for _ in range(3):
        hermes_workspace._remove_managed_model_env_values(env_file)
        hermes_workspace._ensure_gateway_env_file(env_file)
        assert _keys_on_disk(tmp_path) == []
    assert "DRAMACLAW_KEEP_ME=preserved" in env_file.read_text()
