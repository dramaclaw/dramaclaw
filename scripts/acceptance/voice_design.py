"""Explicitly budgeted live voice-design acceptance; default mode is read-only.

Credentials come from VOICE_DESIGN_TEST_TOKEN / VOICE_DESIGN_TEST_COOKIE.
Keep the ledger outside the checkout and reuse it for every paid attempt,
including failures. No operation retries an upstream call automatically.
"""

from __future__ import annotations

import argparse
import base64
from contextlib import contextmanager
from datetime import datetime, timezone
import fcntl
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
from urllib.parse import quote, urlsplit
from uuid import UUID, uuid4

import httpx

HISTORICAL_REQUEST_IDS = (
    "51252446-d70d-4dfa-95e5-3d7d1c6b301b",
    "bd899795-ea8f-4f5d-9985-341771aa2cd5",
)
PAID_SEQUENCE = ("voice-design", "voice-design", "voice-design", "indextts2")
AUTHORIZATION = "S5-2026-10-30-total-4"


def digest(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def write_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    with temporary.open("w", encoding="utf-8") as stream:
        os.chmod(temporary, 0o600)
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    temporary.replace(path)


class PaidLedger:
    """Reserve a slot durably before sending; never resend an uncertain attempt."""

    def __init__(self, path: Path, *, announce: bool = True):
        self.path = path
        self.announce = announce

    @contextmanager
    def locked(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.path.with_suffix(".lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            if not self.path.exists():
                raise RuntimeError("reuse the existing S5 ledger; creating a fresh paid budget is forbidden")
            value = json.loads(self.path.read_text())
            calls = value.get("calls", [])
            if (value.get("schema") != 2 or value.get("limit") != 4
                    or value.get("authorization") != AUTHORIZATION
                    or len(calls) < 2 or len(calls) > 4
                    or tuple(call["request_id"] for call in calls[:2]) != HISTORICAL_REQUEST_IDS
                    or any(call["purpose"] != PAID_SEQUENCE[index] or call["ordinal"] != index + 1
                           for index, call in enumerate(calls))):
                raise RuntimeError("ledger schema/authorized limit mismatch")
            yield value
            write_json(self.path, value)

    def reserve(self, request_id: str, purpose: str) -> int:
        UUID(request_id)
        with self.locked() as value:
            if any(call["request_id"] == request_id for call in value["calls"]):
                raise RuntimeError("attempt already counted; inspect/reuse its result")
            if len(value["calls"]) >= 4:
                raise RuntimeError("paid budget exhausted (4/4)")
            if purpose != PAID_SEQUENCE[len(value["calls"])]:
                raise RuntimeError("remaining budget permits one voice-design, then one indextts2 only")
            if purpose == "indextts2" and value["calls"][-1]["status"] != "ready":
                raise RuntimeError("generation did not succeed; stop without another paid request")
            ordinal = len(value["calls"]) + 1
            value["calls"].append(
                {
                    "ordinal": ordinal,
                    "request_id": request_id,
                    "purpose": purpose,
                    "status": "started",
                    "started_at": datetime.now(timezone.utc).isoformat(),
                }
            )
        if self.announce:
            print(f"PAID {ordinal}/4 {purpose} request_id={request_id}", flush=True)
        return ordinal

    def finish(self, request_id: str, status: str, **evidence) -> None:
        with self.locked() as value:
            call = next(c for c in value["calls"] if c["request_id"] == request_id)
            call.update(status=status, **evidence)


def require_local(url: str) -> str:
    parsed = urlsplit(url)
    if parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "localhost", "::1"}:
        raise ValueError("acceptance writes require an isolated loopback HTTP deployment")
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("base URL must not contain credentials, query, or fragment")
    return url.rstrip("/")


def client(base_url: str) -> httpx.Client:
    headers = {}
    if token := os.environ.get("VOICE_DESIGN_TEST_TOKEN"):
        headers["Authorization"] = f"Bearer {token}"
    cookies = {}
    if cookie := os.environ.get("VOICE_DESIGN_TEST_COOKIE"):
        cookies["st_session"] = cookie
    return httpx.Client(base_url=require_local(base_url), headers=headers, cookies=cookies, timeout=120)


def checked(response: httpx.Response) -> dict:
    if not response.is_success:
        # Upstream errors can contain credentials or signed media URLs.
        raise RuntimeError(f"API HTTP {response.status_code}; inspect private deployment logs")
    value = response.json()
    if value.get("ok") is not True:
        raise RuntimeError("API returned ok=false")
    return value["data"]


def self_check() -> None:
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / "ledger.json"
        value = {"schema": 2, "limit": 4, "authorization": AUTHORIZATION, "calls": [
            {"ordinal": index + 1, "purpose": "voice-design", "request_id": request_id, "status": "failed"}
            for index, request_id in enumerate(HISTORICAL_REQUEST_IDS)
        ]}
        write_json(path, value)
        ledger = PaidLedger(path, announce=False)
        third = str(uuid4())
        assert ledger.reserve(third, "voice-design") == 3
        try:
            ledger.reserve(third, "voice-design")
        except RuntimeError:
            pass
        else:
            raise AssertionError("uncertain attempt was resubmitted")
        for purpose in ("voice-design", "indextts2"):
            try:
                ledger.reserve(str(uuid4()), purpose)
            except RuntimeError:
                pass
            else:
                raise AssertionError("extra generation or synthesis before ready was allowed")
        ledger.finish(third, "ready")
        assert ledger.reserve(str(uuid4()), "indextts2") == 4
        try:
            ledger.reserve(str(uuid4()), "indextts2")
        except RuntimeError:
            pass
        else:
            raise AssertionError("fifth paid attempt allowed")
        missing = PaidLedger(Path(directory) / "fresh-ledger.json", announce=False)
        try:
            missing.reserve(str(uuid4()), "voice-design")
        except RuntimeError:
            pass
        else:
            raise AssertionError("a fresh ledger reset the spent budget")
    for url in ("https://example.com", "http://user:pass@localhost", "http://localhost?token=x"):
        try:
            require_local(url)
        except ValueError:
            pass
        else:
            raise AssertionError("non-isolated destination allowed")
    print("SELF-CHECK-OK (no network or provider calls)")


def serve_test_gateway(args: argparse.Namespace) -> None:
    """Explicit deterministic provider boundary; this server has no forwarding code."""
    if not args.fixture_audio or not args.fixture_audio.is_file():
        raise ValueError("--fixture-audio is required for the deterministic gateway")
    encoded = base64.b64encode(args.fixture_audio.read_bytes()).decode()
    audio_format = "wav" if args.fixture_audio.suffix == ".wav" else "mp3"
    with tempfile.TemporaryDirectory() as directory:
        short_path = Path(directory) / f"short.{audio_format}"
        subprocess.run(["ffmpeg", "-v", "error", "-i", str(args.fixture_audio), "-t", "3", "-ar", "16000", "-ac", "1", str(short_path)], check=True)
        short_audio = short_path.read_bytes()
    short_encoded = base64.b64encode(short_audio).decode()
    state = {"mode": "success", "calls": 0}

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *parts):
            return

        def reply(self, status, data):
            content = json.dumps(data).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(content)))
            self.end_headers()
            self.wfile.write(content)

        def do_GET(self):
            if self.path == "/healthz":
                self.reply(200, {"kind": "voice-design-deterministic", **state})
            else:
                self.reply(404, {})

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))))
            if self.path == "/control":
                mode = body.get("mode")
                if mode not in {"success", "provider_error", "bad_audio", "slow", "short"}:
                    self.reply(400, {})
                    return
                state["mode"] = mode
                self.reply(200, state)
                return
            if self.path != "/v1/audio/voice-designs":
                self.reply(404, {})
                return
            state["calls"] += 1
            mode = state["mode"]
            write_json(args.gateway_record, {"kind": "deterministic", "calls": state["calls"], "last_mode": mode})
            if mode == "slow":
                time.sleep(3)
            if mode == "provider_error":
                self.reply(503, {"error": {"message": "deterministic upstream failure"}})
                return
            preview = {} if mode == "bad_audio" else {"format": audio_format, "sample_rate": 16000, "data": short_encoded if mode == "short" else encoded}
            self.reply(200, {"object": "audio.voice", "id": "deterministic-handle", "voice": "deterministic-handle",
                             "model": body.get("model"), "target_model": body.get("target_model"),
                             "preview_audio": preview, "request_id": f"deterministic-{state['calls']}"})

    print(f"DETERMINISTIC-GATEWAY http://127.0.0.1:{args.gateway_port} (no upstream forwarding)", flush=True)
    ThreadingHTTPServer(("127.0.0.1", args.gateway_port), Handler).serve_forever()


def run(args: argparse.Namespace) -> None:
    if args.serve_test_gateway:
        serve_test_gateway(args)
        return
    if args.self_check:
        self_check()
        return
    if args.replay_evidence:
        if not args.formal_file or not args.tts_output:
            raise ValueError("evidence replay requires --formal-file and --tts-output")
        evidence = json.loads(args.replay_evidence.read_text())
        if evidence["candidate"]["status"] != "ready":
            raise AssertionError("recorded candidate was not ready")
        if digest(args.formal_file.read_bytes()) != evidence["candidate"]["sha256"]:
            raise AssertionError("formal file differs from recorded candidate")
        if digest(args.tts_output.read_bytes()) != evidence["indextts"]["output_sha256"]:
            raise AssertionError("IndexTTS2 output differs from recorded result")
        if evidence["indextts"]["reference_sha256"] != evidence["candidate"]["sha256"]:
            raise AssertionError("IndexTTS2 used another reference")
        print("REPLAY-OK (persisted formal and IndexTTS2 files; no network or paid calls)")
        return
    if not args.project or not args.character:
        raise ValueError("--project and --character are required")
    project = quote(args.project, safe="")
    character = quote(args.character, safe="")
    prefix = f"/api/v1/projects/{project}"
    evidence = {"code_sha": subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()}
    with client(args.base_url) as api:
        evidence["quote"] = checked(api.get(f"{prefix}/voice-design/quote", params={"surface": "supertale"}))
        before = checked(api.get(f"{prefix}/characters/{character}/voice-samples"))
        evidence["slots_before"] = before
        if args.generate:
            if not args.allow_paid or not args.ledger or not args.request_id:
                raise ValueError("generation requires --allow-paid --ledger --request-id")
            ledger = PaidLedger(args.ledger)
            ledger.reserve(args.request_id, "voice-design")
            checked(api.post(f"{prefix}/voice-design/candidates", json={
                "request_id": args.request_id, "surface": "supertale",
                "description": args.description, "preview_text": args.preview_text, "language": "zh",
            }))
        candidate_id = args.candidate_id or (args.request_id if args.generate else None)
        if not candidate_id:
            write_json(args.evidence, evidence)
            print("PREFLIGHT-OK (quote and existing slots; no paid call)")
            return
        UUID(candidate_id)
        deadline = time.monotonic() + args.timeout
        while True:
            candidate = checked(api.get(f"{prefix}/voice-design/candidates/{candidate_id}"))
            if candidate["status"] != "generating":
                break
            if time.monotonic() >= deadline:
                raise TimeoutError("candidate unresolved; do not automatically regenerate")
            time.sleep(1)
        evidence["candidate"] = candidate
        write_json(args.evidence, evidence)
        if args.generate:
            ledger.finish(args.request_id, candidate["status"], candidate_id=candidate_id,
                          failure_code=candidate.get("failure", {}).get("code"))
        if candidate["status"] != "ready":
            raise RuntimeError(f"candidate {candidate['status']}; no automatic retry")
        samples = [api.get(candidate["preview_url"]) for _ in range(2)]
        for sample in samples:
            sample.raise_for_status()
            if digest(sample.content) != candidate["sha256"]:
                raise AssertionError("preview SHA differs from candidate")
        evidence["preview_reads"] = 2
        if args.generate:
            ledger.finish(args.request_id, "ready", candidate_sha256=candidate["sha256"])
        if args.save:
            slot = next(slot for slot in before["slots"] if slot["slot"] == args.slot)
            if slot["path"] or slot["sha256"]:
                raise RuntimeError("refusing to replace occupied test slot")
            saved = checked(api.post(f"{prefix}/characters/{character}/voice-samples/{args.slot}/save-generated", json={
                "save_request_id": args.save_request_id or str(uuid4()), "candidate_id": candidate_id,
                "expected_slot": {key: slot[key] for key in ("path", "sha256", "updated_at")},
                "replace_existing": False,
            }))
            evidence["saved"] = saved
        after = checked(api.get(f"{prefix}/characters/{character}/voice-samples"))
        evidence["slots_after"] = after
        for old in before["slots"]:
            if old["slot"] != args.slot:
                current = next(s for s in after["slots"] if s["slot"] == old["slot"])
                if any(current[key] != old[key] for key in ("path", "sha256", "updated_at")):
                    raise AssertionError("non-target voice slot changed")
        if args.save:
            target = next(s for s in after["slots"] if s["slot"] == args.slot)
            if target["sha256"] != candidate["sha256"]:
                raise AssertionError("saved voice SHA differs from candidate")
        if args.formal_file:
            if digest(args.formal_file.read_bytes()) != candidate["sha256"]:
                raise AssertionError("formal file SHA differs from candidate")
            evidence["formal_sha256"] = candidate["sha256"]
        if args.indextts:
            if args.generate or not args.allow_paid or not args.ledger or not args.request_id or not args.formal_file or not args.tts_output:
                raise ValueError("IndexTTS2 requires a separate --allow-paid --ledger --request-id --formal-file --tts-output operation")
            if args.tts_output.exists():
                raise RuntimeError("IndexTTS2 output already exists; reuse the previous evidence without resubmission")
            beats = checked(api.get(f"{prefix}/episodes/{args.episode}/beats"))
            beat_rows = beats if isinstance(beats, list) else beats.get("beats", [])
            beat = next(row for row in beat_rows if row["beat_number"] == args.beat)
            if beat.get("speaker") != args.character or beat.get("audio_type") != "dialogue":
                raise RuntimeError("test beat does not resolve the saved character voice")
            ledger = PaidLedger(args.ledger)
            ledger.reserve(args.request_id, "indextts2")
            response = api.post(f"{prefix}/episodes/{args.episode}/beats/{args.beat}/audio")
            if not response.is_success or response.json().get("ok") is not True:
                ledger.finish(args.request_id, "failed", stage="submission", http_status=response.status_code)
                raise RuntimeError("IndexTTS2 submission failed; no automatic retry")
            task_id = response.json()["task_id"]
            evidence["indextts"] = {"request_id": args.request_id, "task_id": task_id, "reference_sha256": candidate["sha256"]}
            write_json(args.evidence, evidence)
            deadline = time.monotonic() + args.timeout
            while True:
                task = checked(api.get(f"{prefix}/tasks/audio_generation_indextts2/{args.episode}"))
                if task and task["task_id"] == task_id and task["status"] in {"completed", "failed", "cancelled"}:
                    break
                if time.monotonic() >= deadline:
                    raise TimeoutError("IndexTTS2 result unknown; no automatic retry")
                time.sleep(1)
            if task["status"] != "completed" or task.get("result", {}).get("generated") != 1:
                ledger.finish(args.request_id, "failed", task_id=task_id)
                raise RuntimeError("IndexTTS2 task failed; inspect private logs without resubmission")
            output = args.tts_output.read_bytes()
            duration = float(subprocess.check_output(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", str(args.tts_output)], text=True))
            if not output or duration <= 0:
                raise AssertionError("IndexTTS2 output is not readable audio")
            evidence["indextts"].update(output_sha256=digest(output), duration_seconds=duration)
            ledger.finish(args.request_id, "completed", task_id=task_id, output_sha256=digest(output))
        write_json(args.evidence, evidence)
        print(f"ACCEPTANCE-OK candidate={candidate_id} sha256={candidate['sha256']}")


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("--self-check", action="store_true", help="verify budget/destination guards without network")
    result.add_argument("--replay-evidence", type=Path, help="verify persisted real formal/IndexTTS2 files without network, even after candidate TTL")
    result.add_argument("--serve-test-gateway", action="store_true", help="serve deterministic fixtures; never forwards externally")
    result.add_argument("--fixture-audio", type=Path)
    result.add_argument("--gateway-port", type=int, default=18914)
    result.add_argument("--gateway-record", type=Path, default=Path("/tmp/voice-design-deterministic-gateway.json"))
    result.add_argument("--base-url", default=os.environ.get("VOICE_DESIGN_TEST_BASE_URL", "http://127.0.0.1:18910"))
    result.add_argument("--project", default=os.environ.get("VOICE_DESIGN_TEST_PROJECT"))
    result.add_argument("--character", default=os.environ.get("VOICE_DESIGN_TEST_CHARACTER"))
    result.add_argument("--slot", choices=("default", "child", "youth", "middle", "elder"), default="default")
    result.add_argument("--candidate-id", help="reuse an existing result; never calls the provider")
    result.add_argument("--generate", action="store_true")
    result.add_argument("--allow-paid", action="store_true")
    result.add_argument("--ledger", type=Path)
    result.add_argument("--request-id", help="UUID announced to coordinator before this paid attempt")
    result.add_argument("--description", default="六十岁左右的男人，嗓子有点沙，说话慢")
    result.add_argument("--preview-text", default="今天的天气很好，我们沿着河边慢慢走回家。")
    result.add_argument("--timeout", type=int, default=180)
    result.add_argument("--save", action="store_true", help="publish only to an empty test slot")
    result.add_argument("--save-request-id")
    result.add_argument("--formal-file", type=Path, help="verify the actual saved file equals the preview")
    result.add_argument("--indextts", action="store_true", help="spend the final authorized request via the existing beat audio API")
    result.add_argument("--tts-output", type=Path)
    result.add_argument("--episode", type=int, default=891)
    result.add_argument("--beat", type=int, default=1)
    result.add_argument("--evidence", type=Path, default=Path("/tmp/voice-design-acceptance.json"))
    return result


if __name__ == "__main__":
    try:
        run(parser().parse_args())
    except (ValueError, RuntimeError, AssertionError, TimeoutError, httpx.HTTPError) as error:
        raise SystemExit(f"ACCEPTANCE-FAILED: {type(error).__name__}: {error}") from None
