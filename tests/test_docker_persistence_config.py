from __future__ import annotations

import hashlib
import re
from pathlib import Path

import yaml


REPOSITORY_ROOT = Path(__file__).parents[1]
RELEASE_FILE = "docker-compose.release.yml"
SOURCE_FILE = "docker-compose.yml"
COMPOSE_FILES = (SOURCE_FILE, RELEASE_FILE)
IMAGE_PREFIX = "${DRAMACLAW_IMAGE_PREFIX:-claymorelab}/"
OFFICIAL_GATEWAY_URL = "https://relayclaw.cdnfg.com/v1"


def _compose() -> dict:
    return yaml.safe_load((REPOSITORY_ROOT / RELEASE_FILE).read_text())


def _api(relative_path: str) -> dict:
    api = yaml.safe_load((REPOSITORY_ROOT / relative_path).read_text())["services"]["api"]
    if "extends" in api:
        base = yaml.safe_load((REPOSITORY_ROOT / api["extends"]["file"]).read_text())
        inherited = base["services"][api["extends"]["service"]]
        merged = inherited | api
        merged["environment"] = inherited.get("environment", {}) | api.get("environment", {})
        return merged
    return api


def test_repository_ships_source_release_and_explicit_evidence_compose_files() -> None:
    variants = sorted(
        {p.name for p in REPOSITORY_ROOT.glob("docker-compose*.y*ml")}
        | {p.name for p in REPOSITORY_ROOT.glob("compose.y*ml")}
    )
    assert variants == [
        "docker-compose.brainclaw-evidence.yml",
        "docker-compose.release.yml",
        "docker-compose.yml",
    ]


def test_compose_is_image_only_and_prefixed() -> None:
    services = _compose()["services"]
    assert set(services) == {"api", "newapi", "web"}
    for name, service in services.items():
        assert "build" not in service, f"{name} must not carry a build block"
        assert "pull_policy" not in service, f"{name} must not set pull_policy"
        assert service["image"].startswith(IMAGE_PREFIX), name
        assert service.get("restart") == "unless-stopped", name


def test_gateway_is_the_dramaclaw_fork_pinned_by_variable() -> None:
    image = _compose()["services"]["newapi"]["image"]
    assert re.fullmatch(
        r"\$\{DRAMACLAW_IMAGE_PREFIX:-claymorelab\}/dramaclaw-gateway:"
        r"\$\{DRAMACLAW_GATEWAY_VERSION:-v\d+\.\d+\.\d+(-rc\.\d+)?-dramaclaw\.\d+\}",
        image,
    ), image


def test_ce_images_share_one_version_variable() -> None:
    # The default moves with every release (the packaging workflow opens a PR that bumps it),
    # so assert the shape and that api and web move together — never the literal version.
    services = _compose()["services"]
    versions = set()
    for name, repository in (("api", "dramaclaw"), ("web", "dramaclaw-frontend")):
        image = services[name]["image"]
        match = re.fullmatch(
            re.escape(IMAGE_PREFIX + repository) + r":\$\{DRAMACLAW_VERSION:-(\d+\.\d+\.\d+)\}",
            image,
        )
        assert match, image
        versions.add(match.group(1))
    assert len(versions) == 1, versions


def test_api_persists_generated_media_in_ce_data_volume() -> None:
    api = _compose()["services"]["api"]
    assert api["environment"] | {
        "NOVELVIDEO_DATA_ROOT": "/data",
        "NOVELVIDEO_OUTPUT_DIR": "/data/output",
        "NOVELVIDEO_STATE_DIR": "/data/state",
        "NOVELVIDEO_RUNTIME_DIR": "/data/runtime",
    } == api["environment"]
    assert "ce-data:/data" in api["volumes"]


def test_api_provisioner_env_matches_desktop_contract() -> None:
    api = _compose()["services"]["api"]
    env = api["environment"]
    assert env["NEWAPI_BASE_URL"] == "${NEWAPI_BASE_URL:-" + OFFICIAL_GATEWAY_URL + "}"
    assert env["NEWAPI_ADMIN_BASE_URL"] == "http://newapi:3000"
    assert env["NEWAPI_SQL_DSN"] == "local"
    assert env["NEWAPI_SQLITE_PATH"] == "/newapi-data/one-api.db"
    assert env["NEWAPI_ADMIN_USERNAME"] == "root"
    assert env["NEWAPI_PROVISIONER_ENABLED"] == "${NEWAPI_PROVISIONER_ENABLED:-true}"
    assert "newapi-data:/newapi-data" in api["volumes"]
    assert api["depends_on"] == {"newapi": {"condition": "service_started"}}


def test_gateway_shares_sqlite_volume_and_has_healthcheck() -> None:
    newapi = _compose()["services"]["newapi"]
    assert "newapi-data:/data" in newapi["volumes"]
    assert newapi["environment"]["SQL_DSN"] == ""
    assert "healthcheck" in newapi
    assert "http://localhost:3000/api/status" in " ".join(newapi["healthcheck"]["test"])


def test_compose_pins_env_file_long_syntax_ports_and_volumes() -> None:
    compose = _compose()
    api = compose["services"]["api"]
    assert api["env_file"] == [{"path": ".env", "required": False}]
    assert api["ports"] == ["${ST_API_PORT:-8780}:8780"]
    assert compose["services"]["newapi"]["ports"] == [
        "${ST_NEWAPI_BIND:-127.0.0.1}:${ST_NEWAPI_PORT:-3000}:3000"
    ]
    assert compose["services"]["web"]["ports"] == ["${ST_WEB_PORT:-8080}:80"]
    assert set(compose["volumes"]) == {"ce-data", "newapi-data"}


def test_source_file_extends_release_and_builds_all_three() -> None:
    source = yaml.safe_load((REPOSITORY_ROOT / SOURCE_FILE).read_text())

    assert set(source) == {"services", "volumes"}
    services = source["services"]
    assert set(services) == {"api", "newapi", "web"}
    for name, service in services.items():
        expected_keys = {"extends", "image", "build"} | ({"environment"} if name == "api" else set())
        assert set(service) == expected_keys, f"{name} keys: {set(service)}"
        assert service["extends"] == {"file": RELEASE_FILE, "service": name}

    assert services["api"]["image"] == "dramaclaw-local/api"
    assert services["newapi"]["image"] == "dramaclaw-local/gateway"
    assert services["web"]["image"] == "dramaclaw-local/web"

    assert services["api"]["build"] == {
        "context": ".",
        "dockerfile": "Dockerfile",
        "args": {
            "INSTALL_WORLD": "${INSTALL_WORLD:-0}",
            "HERMES_REPO": "${HERMES_REPO:-https://github.com/dramaclaw/hermes-agent.git}",
            "HERMES_REF": "${HERMES_REF:-brainclaw/evidence-plane}",
        },
    }
    assert services["newapi"]["build"] == {
        "context": "${DRAMACLAW_GATEWAY_SRC:-../dramaclaw-gateway}",
        "dockerfile": "Dockerfile",
    }
    assert services["web"]["build"] == {"context": "./frontend", "dockerfile": "Dockerfile"}

    assert set(source["volumes"]) == {"ce-data", "newapi-data"}


def test_source_file_never_mentions_release_versions() -> None:
    source_text = (REPOSITORY_ROOT / SOURCE_FILE).read_text()

    assert "DRAMACLAW_VERSION" not in source_text
    assert "DRAMACLAW_GATEWAY_VERSION" not in source_text


def test_compose_runtime_matches_the_selected_image() -> None:
    source = _api(SOURCE_FILE)["environment"]
    release = _api(RELEASE_FILE)["environment"]
    assert source["DRAMACLAW_CHAT_BACKEND"] == "${DRAMACLAW_CHAT_BACKEND:-codex}"
    assert source["HERMES_CLI_PATH"] == "/usr/local/bin/hermes"
    assert release["DRAMACLAW_CHAT_BACKEND"] == "${DRAMACLAW_CHAT_BACKEND:-hermes}"
    assert release["HERMES_CLI_PATH"] == "/root/.local/bin/hermes"


def test_all_ce_compose_variants_keep_hermes_explicit_fallback_enabled() -> None:
    for relative_path in COMPOSE_FILES:
        api = _api(relative_path)

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
        api = _api(relative_path)

        assert "user" not in api
        assert "read_only" not in api
        assert "cap_drop" not in api


def test_env_example_documents_image_variables() -> None:
    env_example = (REPOSITORY_ROOT / ".env.example").read_text()

    for key in ("DRAMACLAW_IMAGE_PREFIX", "DRAMACLAW_VERSION", "DRAMACLAW_GATEWAY_VERSION"):
        assert re.search(rf"^# {key}=", env_example, re.MULTILINE), key
