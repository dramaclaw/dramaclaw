from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]


def test_pr_checks_keep_main_and_release_tags_without_duplicate_branch_pushes():
    for name in (
        "ci",
        "frontend",
        "banned-words",
        "secret-scan",
        "ce-import-lint",
        "ee-terms",
        "dependency-review",
    ):
        doc = yaml.safe_load((ROOT / f".github/workflows/{name}.yml").read_text())
        events = doc.get("on", doc.get(True))
        assert events["push"]["branches"] == ["main"]
        assert events["push"]["tags"] == ["v*"]
        assert "pull_request" in events
        assert (
            doc["concurrency"]["cancel-in-progress"]
            == "${{ github.event_name == 'pull_request' }}"
        )


def test_publication_only_promotes_and_does_not_rebuild_the_accepted_images():
    jobs = yaml.safe_load((ROOT / ".github/workflows/release-images.yml").read_text())[
        "jobs"
    ]
    assert (
        jobs["build"]["if"]
        == "github.event_name == 'workflow_dispatch' && !inputs.push_latest"
    )
    promote = jobs["promote"]
    assert promote["if"] == "github.event_name == 'release' || inputs.push_latest"
    assert not any(
        s.get("uses", "").startswith("docker/build-push-action")
        for s in promote["steps"]
    )
    text = str(promote)
    assert (
        "release-image-acceptance.json" in text and '--source-sha "$SOURCE_SHA"' in text
    )
    assert "scripts/promote_release_images.py" in text
    build = next(
        s
        for s in jobs["build"]["steps"]
        if s.get("uses", "").startswith("docker/build-push-action")
    )["with"]
    assert build["platforms"] == "linux/amd64,linux/arm64"
    assert "mode=max" in build["cache-to"] and "type=registry" in build["cache-from"]


def test_dependency_layer_is_independent_and_uv_cache_stays_outside_the_image():
    text = (ROOT / "Dockerfile").read_text()
    assert text.index("--no-install-project") < text.index("COPY src ./src")
    assert text.count("target=/root/.cache/uv,sharing=locked") == 2
    assert "codex-linux-sandbox --help" in text and "command -v bwrap" in text
    assert "find_spec('hermes_cli') is None" in text
    assert "--no-install-package openai-codex-cli-bin" in text
