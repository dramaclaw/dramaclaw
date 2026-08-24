from __future__ import annotations

import re
from pathlib import Path

import yaml


REPOSITORY_ROOT = Path(__file__).parents[1]
COMPOSE_FILES = (
    "docker-compose.yml",
    "docker-compose.release.yml",
    "docker-compose.selfhosted.yml",
    "docker-compose.selfhosted.release.yml",
)


def test_all_compose_variants_persist_generated_media_in_ce_data_volume() -> None:
    for relative_path in COMPOSE_FILES:
        compose = yaml.safe_load((REPOSITORY_ROOT / relative_path).read_text())
        api = compose["services"]["api"]

        assert api["environment"] | {
            "NOVELVIDEO_DATA_ROOT": "/data",
            "NOVELVIDEO_OUTPUT_DIR": "/data/output",
            "NOVELVIDEO_STATE_DIR": "/data/state",
            "NOVELVIDEO_RUNTIME_DIR": "/data/runtime",
        } == api["environment"]
        assert "ce-data:/data" in api["volumes"]


def test_all_compose_variants_default_to_codex_chat_runtime() -> None:
    for relative_path in COMPOSE_FILES:
        raw = (REPOSITORY_ROOT / relative_path).read_text()

        assert 'DRAMACLAW_CHAT_BACKEND: "${DRAMACLAW_CHAT_BACKEND:-codex}"' in raw


def test_env_example_configures_data_root_instead_of_individual_directories() -> None:
    env_example = (REPOSITORY_ROOT / ".env.example").read_text()

    assert re.search(r"^NOVELVIDEO_OUTPUT_DIR=", env_example, re.MULTILINE) is None
    assert "# NOVELVIDEO_DATA_ROOT=" in env_example


def test_container_builds_only_the_pinned_redacted_codex_runtime() -> None:
    dockerfile = (REPOSITORY_ROOT / "Dockerfile").read_text()

    assert 'ARG CODEX_REF="758ef40f50c1a458425c7cfbf1eb12cbc07af0b0"' in dockerfile
    assert "0.149.0-redact-turn-metadata.patch" in dockerfile
    assert "cargo test -p codex-protocol" in dockerfile
    assert "cargo build --release -p codex-cli --bin codex" in dockerfile
    assert "CODEX_BIN=/usr/local/bin/codex-dramaclaw" in dockerfile
    assert "--no-install-package openai-codex-cli-bin" in dockerfile
    assert "apt-get install -y --no-install-recommends git" in dockerfile
