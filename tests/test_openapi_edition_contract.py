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
        check=True,
        capture_output=True,
        text=True,
        cwd=REPO_ROOT,
        env=env,
    )
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
