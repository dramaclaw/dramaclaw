import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]


def _run_json(code: str, *, env_updates: dict[str, str]) -> dict:
    env = os.environ.copy()
    env.update(env_updates)
    env["NOVELVIDEO_STATE_DIR"] = tempfile.mkdtemp(prefix="ce-openapi-state-")
    proc = subprocess.run(
        [sys.executable, "-c", code],
        check=False,
        capture_output=True,
        text=True,
        cwd=REPO_ROOT,
        env=env,
        timeout=60,
    )
    assert proc.returncode == 0, proc.stderr
    return json.loads(proc.stdout)


def _schema(*, dsn: str = "") -> dict:
    return _run_json(
        """
import json
from novelvideo.api.app import create_app
app = create_app()
app.router.on_startup.clear()
app.router.on_shutdown.clear()
print(json.dumps(app.openapi()), end="")
""",
        env_updates={
            "ST_CONTROL_PLANE_DSN": dsn,
            "REDIS_URL": "",
            "ST_EDITION": "ce",
        },
    )


def test_ce_openapi_and_http_exclude_ee_routes() -> None:
    paths = _schema().get("paths", {})

    assert "/api/v1/projects/{project}/grants" not in paths
    assert "/api/v1/projects/{project}/grants/{grant_id}" not in paths
    assert "/api/v1/users/search" not in paths

    result = _run_json(
        """
import json
from fastapi.testclient import TestClient
from novelvideo.api.app import create_app
app = create_app()
app.router.on_startup.clear()
app.router.on_shutdown.clear()
with TestClient(app) as client:
    response = client.get("/api/v1/users/search?q=alice")
print(json.dumps({"status_code": response.status_code}), end="")
""",
        env_updates={
            "ST_CONTROL_PLANE_DSN": "",
            "REDIS_URL": "",
            "ST_EDITION": "ce",
        },
    )
    assert result["status_code"] == 404


def test_config_endpoint_reports_ce_runtime_without_auth() -> None:
    result = _run_json(
        """
import json
from fastapi.testclient import TestClient
from novelvideo.api.app import create_app
app = create_app()
app.router.on_startup.clear()
app.router.on_shutdown.clear()
with TestClient(app) as client:
    response = client.get("/api/v1/config")
print(json.dumps({"status_code": response.status_code, "body": response.json()}), end="")
""",
        env_updates={
            "ST_CONTROL_PLANE_DSN": "",
            "REDIS_URL": "",
            "ST_EDITION": "ce",
        },
    )

    assert result["status_code"] == 200
    assert result["body"]["ok"] is True
    assert result["body"]["data"]["edition"] == "ce"
    assert result["body"]["data"]["auth_required"] is False
    assert result["body"]["data"]["instance_id"]


def test_default_ce_starts_and_serves_config_without_edition_settings(tmp_path) -> None:
    result = _run_json(
        """
import json
import os
from unittest.mock import AsyncMock, patch
from fastapi.testclient import TestClient
import novelvideo.env
import dotenv

# A fresh install must not inherit the developer's .env or shell edition.
novelvideo.env.load_project_dotenv = lambda **kwargs: None
dotenv.load_dotenv = lambda *args, **kwargs: False
for key in ("ST_EDITION", "ST_CONTROL_PLANE_DSN"):
    os.environ.pop(key, None)

from novelvideo.api.app import create_app
from novelvideo.ports.registry import get_port
with patch("novelvideo.official_media_catalog_remote.run_official_media_catalog_updater", new=AsyncMock()):
    app = create_app()
    # Exercise the real lifespan, including bootstrap and the local lifecycle.
    with TestClient(app) as client:
        response = client.get("/api/v1/config")
        paths = app.openapi()["paths"]
        result = {
            "status_code": response.status_code,
            "data": response.json()["data"],
            "lifecycle": type(get_port("lifecycle")).__name__,
            "has_ee_users_route": "/api/v1/users/search" in paths,
        }
print(json.dumps(result), end="")
""",
        env_updates={
            "NOVELVIDEO_DATA_ROOT": str(tmp_path),
            "NOVELVIDEO_OUTPUT_DIR": str(tmp_path / "output"),
            "NOVELVIDEO_RUNTIME_DIR": str(tmp_path / "runtime"),
            "ST_EDITION": "",
            "ST_CONTROL_PLANE_DSN": "",
            "ST_TASK_ENVELOPE_ACTIVE_KEY_ID": "",
            "ST_TASK_ENVELOPE_KEYRING_B64_JSON": "",
        },
    )
    assert result["status_code"] == 200
    assert result["data"]["edition"] == "ce"
    assert result["data"]["auth_required"] is False
    assert result["lifecycle"] == "NoOpLifecycle"
    assert result["has_ee_users_route"] is False
