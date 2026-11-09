import hashlib
import json
from types import SimpleNamespace
import subprocess

import pytest

from novelvideo.models import CharacterIdentity, NovelCharacter, NovelEpisode


def test_run_directory_reports_duplicate_and_missing_runs_as_value_errors(tmp_path):
    from novelvideo.hybrid_drama.api_service import run_directory

    run_directory(tmp_path, "run-1", create=True)
    with pytest.raises(ValueError, match="run-1.*already exists"):
        run_directory(tmp_path, "run-1", create=True)
    with pytest.raises(ValueError, match="missing.*not found"):
        run_directory(tmp_path, "missing")


class _Store:
    def __init__(self, episode, beat, characters):
        self._episode = episode
        self._beat = beat
        self._characters = characters

    def get_episode(self, number):
        assert number == self._episode.number
        return self._episode

    async def get_beats_as_dicts(self, number):
        assert number == self._episode.number
        return [self._beat]

    async def list_characters(self):
        return self._characters


def _project(tmp_path, beat):
    output = tmp_path / "output"
    state = tmp_path / "state"
    output.mkdir()
    state.mkdir()
    identity = CharacterIdentity(
        identity_id="Mia_mia",
        character_name="Mia",
        identity_name="mia",
        appearance_details="red coat",
    )
    character = NovelCharacter(name="Mia")
    character.identities = [identity]
    episode = NovelEpisode(number=2, title="Second")
    store = _Store(episode, beat, [character])
    resolved = SimpleNamespace(
        ctx=SimpleNamespace(project_id="project-1", project_name="Demo"),
        project_dir=output,
        output_dir=str(output),
        state_dir=str(state),
    )
    return resolved, store


@pytest.mark.asyncio
@pytest.mark.parametrize("value", ["not-a-decimal", "NaN", "sNaN", "Infinity", "-Infinity"])
async def test_prepare_rejects_malformed_and_non_finite_budgets(tmp_path, value):
    from novelvideo.hybrid_drama.api_service import prepare_run

    resolved, store = _project(tmp_path, {})
    with pytest.raises(ValueError, match="max_cost_usd must be a finite decimal"):
        await prepare_run(
            resolved,
            store,
            episode_number=2,
            beat_number=3,
            max_cost_usd=value,
            run_id="run-1",
        )


@pytest.mark.asyncio
async def test_prepare_reads_store_and_panel_assets_without_exposing_paths(tmp_path):
    from novelvideo.hybrid_drama.api_service import prepare_run

    beat = {
        "beat_number": 3,
        "visual_description": "{{Mia_mia_default}} waits.",
        "narration_segment": "Wait.",
        "speaker": "Mia_mia",
        "speaker_kind": "character",
        "detected_identities": ["Mia_mia"],
    }
    resolved, store = _project(tmp_path, beat)
    reference = (
        resolved.project_dir
        / "assets"
        / "characters"
        / "Mia"
        / "identities"
        / "mia.png"
    )
    reference.parent.mkdir(parents=True)
    reference.write_bytes(b"exact-reference-bytes")

    result = await prepare_run(
        resolved,
        store,
        episode_number=2,
        beat_number=3,
        max_cost_usd="10",
        run_id="run-1",
    )

    assert result == {
        "run_id": "run-1",
        "beat_key": "project-1:2:3",
        "prompt": result["prompt"],
        "reference_ids": ["Mia_mia"],
        "has_dialogue": True,
        "max_cost_usd": "10",
        "max_attempts": 1,
        "resolution": "720p",
    }
    assert 'Dialogue (Mia): "Wait."' in result["prompt"]
    assert str(tmp_path) not in json.dumps(result)
    run_dir = resolved.project_dir / "hybrid_drama" / "runs" / "run-1"
    prepared = json.loads((run_dir / "prepared.json").read_text())
    assert prepared["identities"]["Mia_mia"]["appearance_details"] == "red coat"
    references = json.loads((run_dir / "references.json").read_text())
    assert references == {
        "Mia_mia": "assets/characters/Mia/identities/mia.png"
    }
    state = json.loads((run_dir / "state.json").read_text())
    assert state["max_cost_usd"] == "10"
    assert state["max_attempts"] == 1
    assert state["tasks"] == []


@pytest.mark.asyncio
async def test_submit_uses_persisted_budget_and_sanitizes_provider_urls(tmp_path):
    import httpx

    from novelvideo.hybrid_drama.api_service import prepare_run, submit_prepared_run

    beat = {
        "beat_number": 3,
        "visual_description": "{{Mia_mia_default}} waits.",
        "narration_segment": "Wait.",
        "speaker": "Mia_mia",
        "speaker_kind": "character",
        "detected_identities": ["Mia_mia"],
    }
    resolved, store = _project(tmp_path, beat)
    reference = (
        resolved.project_dir
        / "assets"
        / "characters"
        / "Mia"
        / "identities"
        / "mia.png"
    )
    reference.parent.mkdir(parents=True)
    reference.write_bytes(b"exact-reference-bytes")
    await prepare_run(
        resolved,
        store,
        episode_number=2,
        beat_number=3,
        max_cost_usd="10",
        run_id="run-1",
    )

    class Relay:
        def upload_bytes(self, data, **kwargs):
            assert data == b"exact-reference-bytes"
            return "https://signed.example/reference?signature=secret"

    def handler(request):
        payload = json.loads(request.content)
        assert payload["resolution"] == "720p"
        assert payload["content"][1]["image_url"]["url"].startswith(
            "https://signed.example/"
        )
        return httpx.Response(
            200,
            json={"id": "cgt-123", "provider_url": "https://provider.example/receipt"},
        )

    result = await submit_prepared_run(
        resolved,
        "run-1",
        max_attempts=2,
        api_key="test-key",
        relay=Relay(),
        http_client=httpx.Client(transport=httpx.MockTransport(handler)),
    )

    assert result["run_id"] == "run-1"
    assert result["max_cost_usd"] == "10"
    assert result["max_attempts"] == 2
    assert len(result["tasks"]) == 1
    task = result["tasks"][0]
    assert task["task_id"] == "cgt-123"
    assert task["status"] == "submitted"
    assert task["estimated_cost_usd"] == "0.934110"
    assert "references" not in task
    assert "receipt_path" not in task
    serialized = json.dumps(result)
    assert "https://" not in serialized
    assert "signature=secret" not in serialized
    assert "provider_url" not in serialized


def _write_run(resolved, run_id, tasks):
    run_dir = resolved.project_dir / "hybrid_drama" / "runs" / run_id
    run_dir.mkdir(parents=True)
    (run_dir / "state.json").write_text(
        json.dumps(
            {
                "version": 1,
                "run_id": run_id,
                "project_id": resolved.ctx.project_id,
                "max_cost_usd": "10",
                "max_attempts": 1,
                "tasks": tasks,
                "reviews": [],
                "assemblies": [],
            }
        )
    )
    return run_dir


@pytest.mark.asyncio
async def test_poll_downloads_exact_candidate_and_returns_sanitized_status(tmp_path):
    import httpx

    from novelvideo.hybrid_drama.api_service import poll_run

    resolved, _store = _project(tmp_path, {})
    _write_run(
        resolved,
        "run-1",
        [
            {
                "beat_key": "project-1:2:3",
                "beat_number": 3,
                "has_dialogue": True,
                "status": "submitted",
                "task_id": "cgt-123",
                "request_sha256": "request-hash",
                "references": [],
                "estimated_tokens": 87300,
                "estimated_cost_usd": "0.934110",
                "poll_receipts": [],
            }
        ],
    )
    media = b"provider-candidate-exact-bytes"

    def handler(request):
        if request.url.host == "ark.ap-southeast.bytepluses.com":
            return httpx.Response(
                200,
                json={
                    "id": "cgt-123",
                    "status": "succeeded",
                    "content": {
                        "video_url": "https://video.example/candidate?signature=secret"
                    },
                    "provider_url": "https://provider.example/receipt?secret=yes",
                    "usage": {"total_tokens": 87001},
                },
            )
        assert request.url.host == "video.example"
        return httpx.Response(200, content=media)

    result = await poll_run(
        resolved,
        "run-1",
        api_key="test-key",
        http_client=httpx.Client(transport=httpx.MockTransport(handler)),
        media_inspector=lambda path: {
            "streams": [
                {"codec_type": "video", "width": 720, "height": 1280},
                {"codec_type": "audio", "channels": 2, "sample_rate": "48000"},
            ]
        },
    )

    task = result["tasks"][0]
    assert task["status"] == "succeeded"
    assert task["actual_cost_usd"] == "0.930911"
    assert task["candidate"]["sha256"] == hashlib.sha256(media).hexdigest()
    run_dir = resolved.project_dir / "hybrid_drama" / "runs" / "run-1"
    state = json.loads((run_dir / "state.json").read_text())
    candidate = run_dir / state["tasks"][0]["candidate"]["path"]
    assert candidate.read_bytes() == media
    serialized = json.dumps(result)
    assert "https://" not in serialized
    assert "signature=secret" not in serialized
    assert "provider_url" not in serialized
    assert "receipt_path" not in serialized
    assert "poll_receipts" not in serialized


@pytest.mark.asyncio
async def test_review_selects_registered_candidate_by_exact_hash(tmp_path):
    from novelvideo.hybrid_drama.api_service import get_run_status, review_run_candidate

    resolved, _store = _project(tmp_path, {})
    media = b"exact-candidate-bytes"
    digest = hashlib.sha256(media).hexdigest()
    run_dir = _write_run(
        resolved,
        "run-1",
        [
            {
                "beat_key": "project-1:2:3",
                "beat_number": 3,
                "request_sha256": "request-hash",
                "candidate": {
                    "path": "candidates/candidate.mp4",
                    "sha256": digest,
                    "request_sha256": "request-hash",
                    "reference_sha256": ["reference-hash"],
                },
            }
        ],
    )
    candidate = run_dir / "candidates" / "candidate.mp4"
    candidate.parent.mkdir()
    candidate.write_bytes(media)
    evidence = {
        "contact_sheet": "every frame inspected",
        "motion_strip": "full motion inspected",
        "audio": "full audio inspected",
    }

    result = await review_run_candidate(
        resolved,
        "run-1",
        candidate_sha256=digest,
        decision="adopt",
        evidence=evidence,
    )

    assert result["candidate_sha256"] == digest
    assert result["request_sha256"] == "request-hash"
    assert result["decision"] == "adopt"
    assert "evidence" not in result
    assert "path" not in result
    status = get_run_status(resolved, "run-1")
    assert status["reviews"] == [
        {"candidate_sha256": digest, "decision": "adopt"}
    ]
    assert "evidence" not in json.dumps(status)
    state = json.loads((run_dir / "state.json").read_text())
    review_path = state["reviews"][0]["path"]
    persisted = json.loads((run_dir / review_path).read_text())
    assert persisted["evidence"] == evidence
    assert persisted["candidate_sha256"] == digest


def test_concurrent_reviews_do_not_lose_state_updates(tmp_path, monkeypatch):
    import asyncio
    from concurrent.futures import ThreadPoolExecutor
    import threading

    import novelvideo.hybrid_drama.api_service as api_service
    import novelvideo.hybrid_drama.runner as runner

    resolved, _store = _project(tmp_path, {})
    tasks = []
    digests = []
    for beat_number, media in enumerate((b"first-candidate", b"second-candidate"), 1):
        digest = hashlib.sha256(media).hexdigest()
        digests.append(digest)
        tasks.append(
            {
                "beat_key": f"project-1:2:{beat_number}",
                "beat_number": beat_number,
                "request_sha256": f"request-{beat_number}",
                "candidate": {
                    "path": f"candidates/candidate-{beat_number}.mp4",
                    "sha256": digest,
                    "request_sha256": f"request-{beat_number}",
                },
            }
        )
    run_dir = _write_run(resolved, "run-1", tasks)
    for index, media in enumerate((b"first-candidate", b"second-candidate"), 1):
        candidate = run_dir / "candidates" / f"candidate-{index}.mp4"
        candidate.parent.mkdir(exist_ok=True)
        candidate.write_bytes(media)

    original_load_state = runner.load_state
    original_save_state = runner._save_state
    both_states_loaded = threading.Barrier(2)
    save_lock = threading.Lock()

    def synchronized_load_state(path):
        state = original_load_state(path)
        try:
            both_states_loaded.wait(timeout=1)
        except threading.BrokenBarrierError:
            pass
        return state

    def serialized_save_state(path, state):
        with save_lock:
            original_save_state(path, state)

    monkeypatch.setattr(runner, "load_state", synchronized_load_state)
    monkeypatch.setattr(runner, "_save_state", serialized_save_state)
    evidence = {
        "contact_sheet": "every frame inspected",
        "motion_strip": "full motion inspected",
        "audio": "full audio inspected",
    }

    def review(index):
        return asyncio.run(
            api_service.review_run_candidate(
                resolved,
                "run-1",
                candidate_sha256=digests[index],
                decision="adopt",
                evidence=evidence,
            )
        )

    with ThreadPoolExecutor(max_workers=2) as pool:
        list(pool.map(review, range(2)))

    state = json.loads((run_dir / "state.json").read_text())
    assert {entry["candidate_sha256"] for entry in state["reviews"]} == set(digests)


def _clip(path):
    subprocess.run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "color=c=blue:s=720x1280:r=24:d=0.25",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:sample_rate=48000:duration=0.25",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-shortest",
            str(path),
        ],
        check=True,
        capture_output=True,
    )


@pytest.mark.asyncio
async def test_assemble_uses_server_owned_output_and_sanitizes_lineage(tmp_path):
    from novelvideo.hybrid_drama.api_service import assemble_run, review_run_candidate

    resolved, _store = _project(tmp_path, {})
    run_dir = _write_run(
        resolved,
        "run-1",
        [
            {
                "beat_key": "project-1:2:3",
                "beat_number": 3,
                "has_dialogue": False,
                "request_sha256": "request-hash",
                "candidate": {},
            }
        ],
    )
    candidate = run_dir / "candidates" / "candidate.mp4"
    candidate.parent.mkdir()
    _clip(candidate)
    digest = hashlib.sha256(candidate.read_bytes()).hexdigest()
    state = json.loads((run_dir / "state.json").read_text())
    state["tasks"][0]["candidate"] = {
        "path": "candidates/candidate.mp4",
        "sha256": digest,
        "request_sha256": "request-hash",
        "reference_sha256": [],
    }
    (run_dir / "state.json").write_text(json.dumps(state))
    await review_run_candidate(
        resolved,
        "run-1",
        candidate_sha256=digest,
        decision="adopt",
        evidence={
            "contact_sheet": "every frame inspected",
            "motion_strip": "full motion inspected",
            "audio": "full audio inspected",
        },
    )

    result = await assemble_run(resolved, "run-1")

    output = run_dir / "assembled" / "episode.mp4"
    assert output.is_file()
    assert result["media_sha256"] == hashlib.sha256(output.read_bytes()).hexdigest()
    assert result["candidate_sha256"] == [digest]
    assert result["request_sha256"] == ["request-hash"]
    assert len(result["review_sha256"]) == 1
    assert "output_path" not in result
    assert "qc" not in result
    assert str(tmp_path) not in json.dumps(result)


@pytest.mark.asyncio
async def test_finalize_requires_dialogue_review_and_returns_sanitized_delivery(tmp_path):
    from novelvideo.hybrid_drama.api_service import finalize_run

    resolved, _store = _project(tmp_path, {})
    run_dir = _write_run(
        resolved,
        "run-1",
        [
            {
                "beat_key": "project-1:2:3",
                "beat_number": 3,
                "has_dialogue": True,
                "request_sha256": "request-hash",
            }
        ],
    )
    output = run_dir / "assembled" / "episode.mp4"
    output.parent.mkdir()
    _clip(output)
    digest = hashlib.sha256(output.read_bytes()).hexdigest()
    assembly_path = f"assemblies/{digest}.json"
    (run_dir / "assemblies").mkdir()
    (run_dir / assembly_path).write_text(
        json.dumps({"media_sha256": digest, "output_path": str(output)})
    )
    state = json.loads((run_dir / "state.json").read_text())
    state["assemblies"] = [{"path": assembly_path, "media_sha256": digest}]
    (run_dir / "state.json").write_text(json.dumps(state))
    review = {
        "passed": True,
        "audible_defects": [],
        "visual": {
            "event_order": "event order matches adopted beats",
            "identity_continuity": "identity remains continuous",
            "motion": "motion and anatomy inspected",
            "joins": "all joins inspected",
            "overlays": "all overlays inspected",
        },
        "dialogue_present": True,
    }

    with pytest.raises(ValueError, match="voice"):
        await finalize_run(
            resolved,
            "run-1",
            media_sha256=digest,
            review=review,
        )
    assert not (run_dir / "delivery.json").exists()

    review["voices"] = {
        key: {"passed": True, "evidence": f"{key} inspected"}
        for key in (
            "exact_words",
            "speaker",
            "timing",
            "voice_consistency",
            "lip_sync",
        )
    }
    result = await finalize_run(
        resolved,
        "run-1",
        media_sha256=digest,
        review=review,
    )

    assert result == {"status": "complete", "media_sha256": digest}
    assert json.loads((run_dir / "delivery.json").read_text())["qc"]["full_decode"]
    assert str(tmp_path) not in json.dumps(result)
