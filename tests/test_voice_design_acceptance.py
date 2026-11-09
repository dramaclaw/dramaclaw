"""Exercise the public deterministic gateway without provider credentials."""

from contextlib import contextmanager
import json
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import time

import httpx
import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts/acceptance/voice_design.py"


@contextmanager
def gateway(tmp_path):
    if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
        pytest.skip("deterministic gateway requires ffmpeg and ffprobe")
    audio = tmp_path / "source.wav"
    subprocess.run([
        "ffmpeg", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=4",
        "-ar", "16000", "-ac", "1", str(audio),
    ], check=True)
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    record = tmp_path / "record.json"
    process = subprocess.Popen([
        sys.executable, str(SCRIPT), "--serve-test-gateway", "--fixture-audio", str(audio),
        "--gateway-port", str(port), "--gateway-record", str(record),
    ], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    try:
        with httpx.Client(base_url=f"http://127.0.0.1:{port}", timeout=10) as client:
            for _ in range(100):
                try:
                    if client.get("/healthz").status_code == 200:
                        break
                except httpx.ConnectError:
                    pass
                if process.poll() is not None:
                    raise AssertionError("gateway exited during startup")
                time.sleep(.05)
            else:
                raise AssertionError("gateway never became ready")
            yield client, record
    finally:
        process.terminate()
        process.wait(timeout=10)


def test_deterministic_gateway_three_model_contract(tmp_path):
    with gateway(tmp_path) as (client, record):
        for model, target in (
            ("voice-enrollment", "cosyvoice-v3.5-flash"),
            ("qwen-voice-design", "qwen3-tts-vd-2026-01-26"),
        ):
            result = client.post("/v1/audio/voice-designs", json={
                "model": model, "target_model": target, "voice_prompt": "a calm voice",
                "preview_text": "a deterministic preview",
            }).json()
            assert (result["model"], result["target_model"]) == (model, target)
            assert result["preview_audio"]["format"] == "wav"
        assert client.post("/v1/audio/voice-designs", json={
            "model": "qwen-voice-design", "target_model": "cosyvoice-v3.5-flash",
        }).status_code == 400
        body = {
            "model": "seed-audio-1.0", "instructions": "a calm voice",
            "input": "a deterministic preview", "response_format": "mp3",
            "metadata": {"sample_rate": 16000},
        }
        for extra in ({"voice": "forbidden"}, {"target_model": "forbidden"}, {"model": "ordinary"}):
            assert client.post("/v1/audio/speech", json=body | extra).status_code == 400
        for mode, minimum in (("success", 3), ("short", 2), ("long", 5)):
            assert client.post("/control", json={"mode": mode}).status_code == 200
            response = client.post("/v1/audio/speech", json=body, headers={"Authorization": "never-record-this"})
            assert response.status_code == 200
            assert response.headers["content-type"] == "audio/mpeg"
            output = tmp_path / f"{mode}.mp3"
            output.write_bytes(response.content)
            probe = json.loads(subprocess.check_output([
                "ffprobe", "-v", "error", "-show_format", "-show_streams", "-of", "json", str(output),
            ]))
            assert probe["format"]["format_name"] == "mp3"
            assert minimum < float(probe["format"]["duration"]) < minimum + 2
            assert probe["streams"][0]["sample_rate"] == "16000"
            assert probe["streams"][0]["channels"] == 1
        assert client.post("/control", json={"mode": "json_local"}).status_code == 200
        assert client.post("/v1/audio/speech", json=body).json() == {
            "audio": {"url": "https://127.0.0.1/private.mp3", "format": "mp3"},
        }
        assert client.post("/v1/not-allowed", json={}).status_code == 404
        evidence = json.loads(record.read_text())
        assert evidence["calls"] == 6
        assert len(evidence["requests"]) == 6
        assert evidence["requests"][-1] == {"endpoint": "/v1/audio/speech", **body}
        assert "never-record-this" not in record.read_text()
        assert record.stat().st_mode & 0o777 == 0o600


def test_preflight_uses_explicit_catalog_quote_without_generation(tmp_path):
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    import threading
    from urllib.parse import parse_qs, urlsplit

    models = [{"catalog_id": name, "config_digest": digit * 64} for name, digit in (("cosy", "a"), ("qwen", "b"))]
    requests = []

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):
            parsed = urlsplit(self.path)
            requests.append((parsed.path, parse_qs(parsed.query)))
            if parsed.path.endswith("/models"):
                data = {"models": models}
            elif parsed.path.endswith("/quote"):
                assert parse_qs(parsed.query) == {"surface": ["supertale"], "catalog_id": ["qwen"]}
                data = {"model": models[1], "cost": 2}
            else:
                assert parsed.path.endswith("/voice-samples")
                data = {"slots": []}
            content = json.dumps({"ok": True, "data": data}).encode()
            self.send_response(200)
            self.send_header("Content-Length", str(len(content)))
            self.end_headers()
            self.wfile.write(content)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        evidence = tmp_path / "preflight.json"
        result = subprocess.run([
            sys.executable, str(SCRIPT), "--base-url", f"http://127.0.0.1:{server.server_port}",
            "--project", "isolated", "--character", "test", "--catalog-id", "qwen",
            "--evidence", str(evidence),
        ], capture_output=True, text=True)
        assert result.returncode == 0, result.stderr
        assert "PREFLIGHT-OK" in result.stdout
        assert json.loads(evidence.read_text())["quote"]["model"] == models[1]
        assert len(requests) == 3
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


@pytest.mark.parametrize("missing", ("test_gateway_url", "prepare_fixtures", "deployment_env"))
def test_project_library_browser_case_requires_isolation_before_any_request(monkeypatch, missing):
    import importlib.util
    from types import SimpleNamespace

    monkeypatch.syspath_prepend(str(SCRIPT.parent))
    spec = importlib.util.spec_from_file_location("voice_design_ui_acceptance", SCRIPT.with_name("voice_design_ui.py"))
    assert spec and spec.loader
    ui = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(ui)
    args = {
        "test_gateway_url": "http://127.0.0.1:18914",
        "prepare_fixtures": True,
        "deployment_env": Path("isolated-env.json"),
    }
    args[missing] = None
    acceptance = ui.Acceptance.__new__(ui.Acceptance)
    acceptance.args = SimpleNamespace(**args)
    # No page exists: touching a request or character fixture would fail first.
    with pytest.raises(RuntimeError, match="isolated deterministic deployment and fresh fixtures"):
        acceptance.run_case("U14")
