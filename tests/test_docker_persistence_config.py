from __future__ import annotations

import hashlib
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


def test_all_ce_compose_variants_keep_hermes_explicit_fallback_enabled() -> None:
    for relative_path in COMPOSE_FILES:
        api = yaml.safe_load((REPOSITORY_ROOT / relative_path).read_text())["services"][
            "api"
        ]

        assert api["environment"]["SUPERTALE_ALLOW_UNSANDBOXED"] == "1"
        assert api["environment"]["ST_CONTROL_PLANE_DSN"] == ""


def test_env_example_configures_data_root_instead_of_individual_directories() -> None:
    env_example = (REPOSITORY_ROOT / ".env.example").read_text()

    assert re.search(r"^NOVELVIDEO_OUTPUT_DIR=", env_example, re.MULTILINE) is None
    assert "# NOVELVIDEO_DATA_ROOT=" in env_example


CODEX_REF_RE = re.compile(r'^ARG CODEX_REF="([0-9a-f]{40})"$', re.MULTILINE)
CODEX_RUNTIME_IMAGE_RE = re.compile(
    r'^ARG CODEX_RUNTIME_IMAGE="docker\.io/claymorelab/codex-dramaclaw:'
    r"([0-9a-f]{7})-p([0-9a-f]{8})@sha256:[0-9a-f]{64}\"$",
    re.MULTILINE,
)


def test_container_consumes_only_the_pinned_prebuilt_codex_runtime() -> None:
    """The CE image must not compile codex; it copies the prebuilt, digest-pinned
    credential-safe runtime whose tag encodes (upstream ref, patch sha). The two
    ARG lines are the single source of truth for every consumer of this repo."""
    dockerfile = (REPOSITORY_ROOT / "Dockerfile").read_text()

    refs = CODEX_REF_RE.findall(dockerfile)
    assert len(refs) == 1, refs
    pins = CODEX_RUNTIME_IMAGE_RE.findall(dockerfile)
    assert len(pins) == 1, pins
    (codex_ref,) = refs
    ((tag_ref, tag_patch),) = pins

    first_from = dockerfile.index("\nFROM ")
    assert dockerfile.index("ARG CODEX_REF=") < first_from
    assert dockerfile.index("ARG CODEX_RUNTIME_IMAGE=") < first_from

    assert tag_ref == codex_ref[:7]
    patches = sorted((REPOSITORY_ROOT / "deploy" / "codex").glob("*.patch"))
    assert len(patches) == 1, patches
    assert tag_patch == hashlib.sha256(patches[0].read_bytes()).hexdigest()[:8]

    assert "FROM ${CODEX_RUNTIME_IMAGE} AS codex-runtime" in dockerfile
    assert "COPY --from=codex-runtime /codex /usr/local/bin/codex-dramaclaw" in dockerfile
    assert "COPY --from=codex-runtime /codex-runtime.sha /opt/codex-runtime.sha" in dockerfile
    assert "COPY --from=codex-runtime /codex-runtime.json /opt/codex-runtime.json" in dockerfile
    assert 'test "$(cat /opt/codex-runtime.sha)" = "${CODEX_REF}"' in dockerfile
    assert "patch_sha256" in dockerfile
    assert "/opt/codex-runtime.json" in dockerfile
    assert "codex-dramaclaw --version" in dockerfile
    assert "codex-builder" not in dockerfile
    assert "cargo build --release -p codex-cli" not in dockerfile
    assert "cargo test -p codex-" not in dockerfile

    assert "CODEX_BIN=/usr/local/bin/codex-dramaclaw" in dockerfile
    assert "--no-install-package openai-codex-cli-bin" in dockerfile
    assert "apt-get install -y --no-install-recommends git" in dockerfile
    assert "COPY LICENSES ./LICENSES" in dockerfile
    assert "COPY NOTICE ./NOTICE" in dockerfile
    assert "COPY LICENSES NOTICE ./" not in dockerfile
    assert "USER dramaclaw:dramaclaw" not in dockerfile


def test_compose_upgrade_keeps_existing_volume_runtime_permissions() -> None:
    for relative_path in COMPOSE_FILES:
        api = yaml.safe_load((REPOSITORY_ROOT / relative_path).read_text())["services"]["api"]

        assert "user" not in api
        assert "read_only" not in api
        assert "cap_drop" not in api
