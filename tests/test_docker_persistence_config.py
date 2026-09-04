from __future__ import annotations

import os
import re
from pathlib import Path

import yaml


REPOSITORY_ROOT = Path(__file__).parents[1]
COMPOSE_FILE = "docker-compose.yml"
IMAGE_PREFIX = "${DRAMACLAW_IMAGE_PREFIX:-claymorelab}/"
BUILD_SCRIPT = "scripts/build_images.sh"
OFFICIAL_GATEWAY_URL = "https://relayclaw.cdnfg.com/v1"


def _compose() -> dict:
    return yaml.safe_load((REPOSITORY_ROOT / COMPOSE_FILE).read_text())


def test_repository_ships_exactly_one_compose_file() -> None:
    variants = sorted(
        {p.name for p in REPOSITORY_ROOT.glob("docker-compose*.y*ml")}
        | {p.name for p in REPOSITORY_ROOT.glob("compose.y*ml")}
    )
    assert variants == [COMPOSE_FILE]


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
    services = _compose()["services"]
    assert services["api"]["image"] == IMAGE_PREFIX + "dramaclaw:${DRAMACLAW_VERSION:-latest}"
    assert services["web"]["image"] == (
        IMAGE_PREFIX + "dramaclaw-frontend:${DRAMACLAW_VERSION:-latest}"
    )


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
    assert api["depends_on"] == {"newapi": {"condition": "service_healthy"}}


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
    assert compose["services"]["newapi"]["ports"] == ["${ST_NEWAPI_PORT:-3000}:3000"]
    assert compose["services"]["web"]["ports"] == ["${ST_WEB_PORT:-8080}:80"]
    assert set(compose["volumes"]) == {"ce-data", "newapi-data"}


def test_build_script_exists_and_is_executable() -> None:
    script = REPOSITORY_ROOT / BUILD_SCRIPT
    assert script.is_file()
    assert os.access(script, os.X_OK)
    assert script.read_text().startswith("#!/usr/bin/env bash\n")


def test_env_example_configures_data_root_instead_of_individual_directories() -> None:
    env_example = (REPOSITORY_ROOT / ".env.example").read_text()

    assert re.search(r"^NOVELVIDEO_OUTPUT_DIR=", env_example, re.MULTILINE) is None
    assert "# NOVELVIDEO_DATA_ROOT=" in env_example


def test_env_example_documents_image_variables() -> None:
    env_example = (REPOSITORY_ROOT / ".env.example").read_text()

    for key in ("DRAMACLAW_IMAGE_PREFIX", "DRAMACLAW_VERSION", "DRAMACLAW_GATEWAY_VERSION"):
        assert re.search(rf"^# {key}=", env_example, re.MULTILINE), key
