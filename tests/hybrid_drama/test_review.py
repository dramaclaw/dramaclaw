import hashlib
import json

import pytest

from novelvideo.hybrid_drama.runner import review_candidate, review_for_candidate


def test_candidate_review_is_invalidated_when_media_hash_changes(tmp_path):
    candidate = tmp_path / "candidates" / "one.mp4"
    candidate.parent.mkdir()
    candidate.write_bytes(b"first-candidate")
    digest = hashlib.sha256(b"first-candidate").hexdigest()
    (tmp_path / "state.json").write_text(
        json.dumps(
            {
                "version": 1,
                "tasks": [
                    {
                        "beat_key": "p:e:1",
                        "candidate": {"path": "candidates/one.mp4", "sha256": digest},
                    }
                ],
                "reviews": [],
            }
        )
    )
    evidence = {
        "contact_sheet": "frames at 0, 1, 2, 3 seconds inspected",
        "motion_strip": "two-second 3fps strip inspected",
        "audio": "listened to full candidate",
    }

    review = review_candidate(tmp_path, candidate, decision="adopt", evidence=evidence)

    assert review["candidate_sha256"] == digest
    assert review_for_candidate(tmp_path, candidate)["decision"] == "adopt"
    candidate.write_bytes(b"changed-candidate")
    assert review_for_candidate(tmp_path, candidate) is None
    with pytest.raises(ValueError, match="registered candidate"):
        review_candidate(tmp_path, candidate, decision="adopt", evidence=evidence)
