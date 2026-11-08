"""Durable direct-Seedance runner with spend and review gates."""

from __future__ import annotations

from decimal import Decimal
import fcntl
import hashlib
import json
import os
from datetime import datetime, timezone
from pathlib import Path
import subprocess
from typing import Any

import httpx

BASE_URL = "https://ark.ap-southeast.bytepluses.com"
# Canary-verified 4s 720p Seedance usage; see devops/dramaclaw-ops direct-seedance runbook.
DEFAULT_ESTIMATED_TOKENS = 87_300


def _json_bytes(value: Any) -> bytes:
    return (json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode()


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _write_immutable(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("xb") as handle:
        handle.write(data)


def _save_state(run_dir: Path, state: dict) -> None:
    temporary = run_dir / "state.json.tmp"
    temporary.write_bytes(_json_bytes(state))
    os.replace(temporary, run_dir / "state.json")


def load_state(run_dir: str | Path) -> dict:
    return json.loads((Path(run_dir) / "state.json").read_text())


def estimate_cost(total_tokens: int, *, has_video_input: bool) -> Decimal:
    rate = Decimal("6.40") if has_video_input else Decimal("10.70")
    return Decimal(int(total_tokens)) * rate / Decimal(1_000_000)


def build_seedance_request(prepared: dict, reference_urls: dict[str, str]) -> dict:
    content = [{"type": "text", "text": prepared["prompt"]}]
    for identity_id in prepared["reference_ids"]:
        content.append(
            {
                "type": "image_url",
                "image_url": {"url": reference_urls[identity_id]},
                "role": "reference_image",
            }
        )
    return {
        "model": "dreamina-seedance-2-5-260628",
        "content": content,
        "generate_audio": True,
        "ratio": "9:16",
        "resolution": "720p",
        "duration": 4,
        "watermark": False,
    }


def _submit_task(
    run_dir: str | Path,
    prepared: dict,
    reference_paths: dict[str, str | Path],
    *,
    max_cost_usd: Decimal | str,
    max_attempts: int = 1,
    manual_retry: bool = False,
    api_key: str,
    relay=None,
    http_client=None,
) -> dict:
    run_dir = Path(run_dir)
    run_dir.mkdir(parents=True, exist_ok=True)
    state_path = run_dir / "state.json"
    state = (
        load_state(run_dir)
        if state_path.exists()
        else {"version": 1, "max_cost_usd": str(max_cost_usd), "tasks": [], "reviews": []}
    )
    max_cost = Decimal(str(max_cost_usd))
    if max_cost <= 0:
        raise ValueError("max_cost_usd must be positive")
    estimated_cost = estimate_cost(DEFAULT_ESTIMATED_TOKENS, has_video_input=False)
    committed = sum(
        (Decimal(task["estimated_cost_usd"]) for task in state["tasks"]), Decimal(0)
    )
    if (
        Decimal(str(state["max_cost_usd"])) != max_cost
        or committed + estimated_cost > max_cost
    ):
        raise ValueError("pre-submit estimate exceeds or changes max_cost_usd run budget")
    existing = [task for task in state["tasks"] if task["beat_key"] == prepared["beat_key"]]
    if existing:
        if not manual_retry or any(task["status"] != "failed" for task in existing):
            raise ValueError("duplicate submission blocked by a persisted or unknown outcome")
        if len(existing) >= max_attempts:
            raise ValueError("max_attempts cap reached")
    if max_attempts < 1:
        raise ValueError("max_attempts must be positive")
    references = []
    reference_urls = {}
    if relay is None:
        from novelvideo.storage.media_relay import get_media_relay

        relay = get_media_relay()
    for identity_id in prepared["reference_ids"]:
        source = Path(reference_paths[identity_id])
        data = source.read_bytes()
        digest = _sha256(data)
        ext = source.suffix.lower().lstrip(".") or "png"
        relative = f"references/{digest}.{ext}"
        stored = run_dir / relative
        if not stored.exists():
            _write_immutable(stored, data)
        url = relay.upload_bytes(
            data, ext=ext, resource_type="image", object_key=None
        )
        reference_urls[identity_id] = str(url)
        references.append(
            {"identity_id": identity_id, "sha256": digest, "path": relative, "url": str(url)}
        )

    request = build_seedance_request(prepared, reference_urls)
    request_record = {
        "project": prepared["project"],
        "episode": prepared["episode"],
        "beat": prepared["beat"],
        "request": request,
        "references": references,
        "estimated_tokens": DEFAULT_ESTIMATED_TOKENS,
        "estimated_cost_usd": format(estimated_cost, ".6f"),
    }
    request_bytes = _json_bytes(request_record)
    request_sha256 = _sha256(request_bytes)
    request_path = f"requests/{len(state['tasks']) + 1}-{request_sha256}.json"
    _write_immutable(run_dir / request_path, request_bytes)
    task = {
        "beat_key": prepared["beat_key"],
        "beat_number": prepared["beat_number"],
        "has_dialogue": prepared["has_dialogue"],
        "status": "submitting",
        "task_id": None,
        "request_path": request_path,
        "request_sha256": request_sha256,
        "receipt_path": None,
        "receipt_sha256": None,
        "references": references,
        "estimated_tokens": DEFAULT_ESTIMATED_TOKENS,
        "estimated_cost_usd": format(estimated_cost, ".6f"),
    }
    state["tasks"].append(task)
    _save_state(run_dir, state)

    client = http_client or httpx.Client(timeout=120.0)
    try:
        response = client.post(
            f"{BASE_URL}/api/v3/contents/generations/tasks",
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            json=request,
        )
    except httpx.TransportError:
        task["status"] = "unknown"
        _save_state(run_dir, state)
        raise
    if response.is_error:
        try:
            failure_receipt = response.json()
        except ValueError:
            failure_receipt = {"status_code": response.status_code, "body": response.text}
        receipt_bytes = _json_bytes(failure_receipt)
        receipt_path = f"receipts/submit-{len(state['tasks'])}-{request_sha256}.json"
        _write_immutable(run_dir / receipt_path, receipt_bytes)
        task["status"] = "failed"
        task["receipt_path"] = receipt_path
        task["receipt_sha256"] = _sha256(receipt_bytes)
        _save_state(run_dir, state)
        response.raise_for_status()
    try:
        receipt = response.json()
    except ValueError:
        receipt = {"body": response.text}
    receipt_bytes = _json_bytes(receipt)
    receipt_path = f"receipts/submit-{len(state['tasks'])}-{request_sha256}.json"
    _write_immutable(run_dir / receipt_path, receipt_bytes)
    task["receipt_path"] = receipt_path
    task["receipt_sha256"] = _sha256(receipt_bytes)
    if not receipt.get("id"):
        task["status"] = "unknown"
        _save_state(run_dir, state)
        raise ValueError("submission response has no task ID; outcome is unknown")
    task["task_id"] = str(receipt["id"])
    task["status"] = "submitted"
    _save_state(run_dir, state)
    return dict(task)


def submit_task(
    run_dir: str | Path,
    prepared: dict,
    reference_paths: dict[str, str | Path],
    *,
    max_cost_usd: Decimal | str,
    max_attempts: int = 1,
    manual_retry: bool = False,
    api_key: str,
    relay=None,
    http_client=None,
) -> dict:
    run_dir = Path(run_dir)
    run_dir.mkdir(parents=True, exist_ok=True)
    with (run_dir / ".submit.lock").open("a+") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            return _submit_task(
                run_dir,
                prepared,
                reference_paths,
                max_cost_usd=max_cost_usd,
                max_attempts=max_attempts,
                manual_retry=manual_retry,
                api_key=api_key,
                relay=relay,
                http_client=http_client,
            )
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)


def poll_tasks(
    run_dir: str | Path,
    *,
    api_key: str,
    http_client=None,
    media_inspector=None,
) -> list[dict]:
    run_dir = Path(run_dir)
    state = load_state(run_dir)
    client = http_client or httpx.Client(timeout=120.0)
    if media_inspector is None:
        from novelvideo.hybrid_drama.media import inspect_media

        media_inspector = inspect_media
    results = []
    for task in state["tasks"]:
        if task["status"] not in {"submitted", "queued", "running"}:
            continue
        response = client.get(
            f"{BASE_URL}/api/v3/contents/generations/tasks/{task['task_id']}",
            headers={"Authorization": f"Bearer {api_key}"},
        )
        response.raise_for_status()
        receipt = response.json()
        receipt_bytes = _json_bytes(receipt)
        sequence = len(task.setdefault("poll_receipts", [])) + 1
        receipt_path = (
            f"receipts/poll-{task['task_id']}-{sequence}-{_sha256(receipt_bytes)}.json"
        )
        _write_immutable(run_dir / receipt_path, receipt_bytes)
        task["poll_receipts"].append(
            {"path": receipt_path, "sha256": _sha256(receipt_bytes)}
        )
        provider_status = str(receipt.get("status") or "").lower()
        task["status"] = provider_status or task["status"]
        if "usage" in receipt:
            task["usage"] = receipt["usage"]
        _save_state(run_dir, state)

        if provider_status == "succeeded":
            total_tokens = int(receipt.get("usage", {}).get("total_tokens", 0))
            if total_tokens <= 0:
                task["status"] = "unknown"
                _save_state(run_dir, state)
                raise ValueError("succeeded task is missing usage.total_tokens")
            task["usage"] = {"total_tokens": total_tokens}
            task["actual_cost_usd"] = format(
                estimate_cost(total_tokens, has_video_input=False), ".6f"
            )
            video_url = str(receipt.get("content", {}).get("video_url") or "")
            if not video_url:
                task["status"] = "unknown"
                _save_state(run_dir, state)
                raise ValueError("succeeded task is missing content.video_url")
            download = client.get(video_url)
            download.raise_for_status()
            media = download.content
            digest = _sha256(media)
            candidate_path = f"candidates/{task['task_id']}-{digest}.mp4"
            candidate = run_dir / candidate_path
            if not candidate.exists():
                _write_immutable(candidate, media)
            probe = media_inspector(candidate)
            from novelvideo.hybrid_drama.media import validate_media_probe

            validate_media_probe(probe)
            task["candidate"] = {
                "path": candidate_path,
                "sha256": digest,
                "request_sha256": task["request_sha256"],
                "reference_sha256": [ref["sha256"] for ref in task["references"]],
                "probe": probe,
            }
            _save_state(run_dir, state)
        results.append(dict(task))
    return results


def review_candidate(
    run_dir: str | Path,
    candidate_path: str | Path,
    *,
    decision: str,
    evidence: dict,
) -> dict:
    if decision not in {"adopt", "repair", "more-evidence"}:
        raise ValueError("decision must be adopt, repair, or more-evidence")
    if not all(str(evidence.get(key) or "").strip() for key in ("contact_sheet", "motion_strip", "audio")):
        raise ValueError("contact_sheet, motion_strip, and audio review evidence are required")
    run_dir = Path(run_dir)
    candidate_path = Path(candidate_path)
    if not candidate_path.is_absolute():
        candidate_path = run_dir / candidate_path
    digest = _sha256(candidate_path.read_bytes())
    state = load_state(run_dir)
    matching = [
        task
        for task in state["tasks"]
        if task.get("candidate", {}).get("sha256") == digest
        and (run_dir / task["candidate"]["path"]).resolve() == candidate_path.resolve()
    ]
    if not matching:
        raise ValueError("candidate bytes must match a registered candidate")
    review = {
        "candidate_sha256": digest,
        "beat_key": matching[0]["beat_key"],
        "request_sha256": matching[0].get("request_sha256"),
        "decision": decision,
        "evidence": evidence,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    review_bytes = _json_bytes(review)
    review_path = f"reviews/candidate-{digest}-{_sha256(review_bytes)}.json"
    _write_immutable(run_dir / review_path, review_bytes)
    state["reviews"].append({"path": review_path, "candidate_sha256": digest})
    _save_state(run_dir, state)
    return review


def review_for_candidate(run_dir: str | Path, candidate_path: str | Path) -> dict | None:
    run_dir = Path(run_dir)
    candidate_path = Path(candidate_path)
    if not candidate_path.is_absolute():
        candidate_path = run_dir / candidate_path
    digest = _sha256(candidate_path.read_bytes())
    state = load_state(run_dir)
    for entry in reversed(state.get("reviews", [])):
        if entry["candidate_sha256"] == digest:
            review = json.loads((run_dir / entry["path"]).read_text())
            if review["candidate_sha256"] == digest:
                return review
    return None


def assemble_episode(run_dir: str | Path, output_path: str | Path) -> dict:
    from novelvideo.hybrid_drama.media import inspect_media, validate_media_probe

    run_dir = Path(run_dir)
    output_path = Path(output_path)
    if not output_path.is_absolute():
        output_path = run_dir / output_path
    state = load_state(run_dir)
    beat_keys = list(dict.fromkeys(task["beat_key"] for task in state["tasks"]))
    selected = []
    for beat_key in beat_keys:
        adopted = []
        for task in state["tasks"]:
            if task["beat_key"] != beat_key or not task.get("candidate"):
                continue
            candidate = run_dir / task["candidate"]["path"]
            if _sha256(candidate.read_bytes()) != task["candidate"]["sha256"]:
                continue
            review = review_for_candidate(run_dir, candidate)
            if review and review["decision"] == "adopt":
                adopted.append((task, candidate, review))
        if len(adopted) != 1:
            raise ValueError(f"exactly one adopted candidate is required for {beat_key}")
        selected.append(adopted[0])
    selected.sort(key=lambda item: item[0]["beat_number"])

    concat_lines = []
    selected_hashes = []
    for task, candidate, review in selected:
        probe = inspect_media(candidate)
        validate_media_probe(probe)
        concat_lines.append(f"file '{candidate.resolve()}'")
        selected_hashes.append(task["candidate"]["sha256"])
    concat_path = run_dir / f"concat-{_sha256(''.join(selected_hashes).encode())}.txt"
    _write_immutable(concat_path, ("\n".join(concat_lines) + "\n").encode())
    output_path.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-n",
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            str(concat_path),
            "-c",
            "copy",
            str(output_path),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    qc = inspect_media(output_path, full_decode=True)
    validate_media_probe(qc)
    media_sha256 = _sha256(output_path.read_bytes())
    assembly = {
        "media_sha256": media_sha256,
        "output_path": str(output_path),
        "candidate_sha256": selected_hashes,
        "request_sha256": [item[0]["request_sha256"] for item in selected],
        "review_sha256": [_sha256(_json_bytes(item[2])) for item in selected],
        "qc": qc,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    relative = f"assemblies/{media_sha256}.json"
    _write_immutable(run_dir / relative, _json_bytes(assembly))
    state.setdefault("assemblies", []).append({"path": relative, "media_sha256": media_sha256})
    _save_state(run_dir, state)
    return assembly


def finalize_delivery(run_dir: str | Path, output_path: str | Path, review: dict) -> dict:
    from novelvideo.hybrid_drama.media import inspect_media, validate_media_probe

    run_dir = Path(run_dir)
    output_path = Path(output_path)
    if not output_path.is_absolute():
        output_path = run_dir / output_path
    media_sha256 = _sha256(output_path.read_bytes())
    state = load_state(run_dir)
    assembly_entries = [
        entry
        for entry in state.get("assemblies", [])
        if entry["media_sha256"] == media_sha256
    ]
    if not assembly_entries:
        raise ValueError("final bytes do not match an assembled output")
    if review.get("passed") is not True or review.get("audible_defects") != []:
        raise ValueError("final review must pass with no unresolved audible defects")
    visual = review.get("visual") or {}
    if not all(
        str(visual.get(key) or "").strip()
        for key in ("event_order", "identity_continuity", "motion", "joins", "overlays")
    ):
        raise ValueError("complete final visual review is required")
    has_dialogue = any(task.get("has_dialogue") for task in state["tasks"])
    if review.get("dialogue_present") is not has_dialogue:
        raise ValueError("dialogue_present must match the CE beats")
    if has_dialogue:
        voices = review.get("voices") or {}
        for key in ("exact_words", "speaker", "timing", "voice_consistency", "lip_sync"):
            check = voices.get(key) or {}
            if check.get("passed") is not True or not str(check.get("evidence") or "").strip():
                raise ValueError(f"voice review {key} must pass with evidence")

    qc = inspect_media(output_path, full_decode=True)
    validate_media_probe(qc)
    final_review = {
        "media_sha256": media_sha256,
        "review": review,
        "qc": qc,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    review_bytes = _json_bytes(final_review)
    review_path = f"reviews/final-{media_sha256}-{_sha256(review_bytes)}.json"
    _write_immutable(run_dir / review_path, review_bytes)
    delivery = {
        "status": "complete",
        "media_sha256": media_sha256,
        "assembly_path": assembly_entries[-1]["path"],
        "review_path": review_path,
        "qc": qc,
    }
    _write_immutable(run_dir / "delivery.json", _json_bytes(delivery))
    return delivery
