from __future__ import annotations

import copy
import hashlib
import importlib.util
from pathlib import Path

import pytest

SPEC = importlib.util.spec_from_file_location(
    "image_promotion",
    Path(__file__).resolve().parents[1] / "scripts/promote_release_images.py",
)
promotion = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(promotion)
SOURCE = "a" * 40


def receipt():
    return {
        "schema_version": 2,
        "release_tag": "v2.1.3",
        "source_sha": SOURCE,
        "image_tag": "2.1.3",
        "issuer": {
            "repository_id": "1127546821",
            "workflow": ".github/workflows/dramaclaw-release-packages.yml",
            "run_id": 123,
            "sha": "f" * 40,
        },
        "chat": {
            "ok": True,
            "backend": "codex",
            "entrypoint": "/api/v1/chat/ws",
            "phases": ["fresh-install", "retained-data-upgrade"],
            "responsesRequests": 2,
            "packagedSkillResourcesVerified": True,
            "skillLocatorSent": True,
            "credentialsPersistedInRuntime": False,
        },
        "protocol": {
            "ok": True,
            "backend": "codex",
            "turns": 2,
            "rotating_auth": True,
            "credentials_persisted": False,
            "packaged_hermes_absent": True,
        },
        "images": {
            name: {
                "digest": "sha256:" + char * 64,
                "platforms": ["linux/amd64", "linux/arm64"],
                "runtime": {
                    "service": "api" if name == "dramaclaw" else "web",
                    "platform": "linux/amd64",
                    "index_digest": "sha256:" + char * 64,
                    "image_ref": f"registry.example/dramaclaw/{name}@sha256:{char * 64}",
                    "manifest_digest": "sha256:"
                    + hashlib.sha256((name + "amd64").encode()).hexdigest(),
                    "config_digest": "sha256:" + "e" * 64,
                    "image_id": "sha256:" + "e" * 64,
                    "container_id": "f" * 64,
                    "verified_before_and_after": True,
                },
            }
            for name, char in [("dramaclaw", "b"), ("dramaclaw-frontend", "c")]
        },
    }


@pytest.mark.parametrize(
    "path,value",
    [
        (("schema_version",), 1),
        (("images", "dramaclaw", "runtime"), {}),
        (("images", "dramaclaw-frontend", "runtime", "image_id"), "sha256:" + "d" * 64),
        (("images", "dramaclaw", "runtime", "verified_before_and_after"), False),
        (("source_sha",), "d" * 40),
        (("release_tag",), "v2.1.1"),
        (("issuer", "repository_id"), "1"),
        (("issuer", "workflow"), "another.yml"),
        (("chat", "ok"), False),
        (("chat", "phases"), ["fresh-install"]),
        (("chat", "entrypoint"), "direct-app-server"),
        (("chat", "responsesRequests"), 0),
        (("chat", "skillLocatorSent"), False),
        (("chat", "credentialsPersistedInRuntime"), True),
        (("protocol", "turns"), 1),
        (("protocol", "rotating_auth"), False),
        (("protocol", "packaged_hermes_absent"), False),
        (("images", "dramaclaw", "digest"), "latest"),
        (("images", "dramaclaw", "platforms"), ["linux/amd64"]),
    ],
)
def test_unaccepted_or_wrong_source_receipts_fail_before_registry_access(
    monkeypatch, path, value
):
    data = receipt()
    node = data
    for part in path[:-1]:
        node = node[part]
    node[path[-1]] = value
    monkeypatch.setattr(
        promotion,
        "inspect",
        lambda *args: pytest.fail("unaccepted receipt read the registry"),
    )
    with pytest.raises(promotion.PromotionError):
        promotion.promote(data, "v2.1.3", SOURCE, latest=True)


def registry(monkeypatch, data, *, bad_arch=False, moved=False):
    aliases, children, writes = {}, {}, []
    for name, image in data["images"].items():
        repo = "docker.io/claymorelab/" + name
        aliases[repo + ":" + data["image_tag"]] = image["digest"]
        for arch in ("amd64", "arm64"):
            digest = "sha256:" + hashlib.sha256((name + arch).encode()).hexdigest()
            children[repo + "@" + digest] = arch

    def inspect(ref, field="Manifest"):
        repo = (
            ref.split("@")[0].rsplit(":", 1)[0] if "@" not in ref else ref.split("@")[0]
        )
        if field == "Raw":
            return {"config": {"digest": "sha256:" + "e" * 64}}
        if field == "Image":
            arch = children[ref]
            return {
                "architecture": arch,
                "os": "linux",
                "config": {
                    "Labels": {
                        "org.opencontainers.image.revision": (
                            "d" * 40 if bad_arch and arch == "arm64" else SOURCE
                        ),
                        "org.opencontainers.image.version": "2.1.3",
                    }
                },
            }
        name = repo.rsplit("/", 1)[1]
        digest = aliases.get(ref, data["images"][name]["digest"])
        if moved and ":" + data["image_tag"] in ref:
            digest = "sha256:" + "e" * 64
        return {
            "digest": digest,
            "manifests": [
                {
                    "platform": {"os": "linux", "architecture": arch},
                    "digest": "sha256:"
                    + hashlib.sha256((name + arch).encode()).hexdigest(),
                }
                for arch in ("amd64", "arm64")
            ],
        }

    def run(args, **kwargs):
        writes.append(args)
        aliases[args[-2]] = args[-1].split("@")[1]

    monkeypatch.setattr(promotion, "inspect", inspect)
    monkeypatch.setattr(promotion.subprocess, "run", run)
    return writes


@pytest.mark.parametrize("failure", ["bad_arch", "moved"])
def test_drift_or_wrong_platform_source_does_not_change_any_tag(monkeypatch, failure):
    data = receipt()
    writes = registry(monkeypatch, data, **{failure: True})
    with pytest.raises(promotion.PromotionError):
        promotion.promote(data, "v2.1.3", SOURCE, latest=True)
    assert writes == []


def test_latest_promotion_reuses_both_exact_indexes_without_a_build(monkeypatch):
    data = receipt()
    writes = registry(monkeypatch, data)
    result = promotion.promote(data, "v2.1.3", SOURCE, latest=True)
    assert result["ok"] and not result["rebuilt"]
    assert len(writes) == 2
    assert all("create" in call and call[-2].endswith(":latest") for call in writes)
    assert {call[-1].split("@")[1] for call in writes} == {
        v["digest"] for v in data["images"].values()
    }


def test_benchmark_uses_isolated_aliases_and_cannot_update_latest(monkeypatch):
    data = receipt()
    data["image_tag"] = f"ci-{SOURCE}-123"
    writes = registry(monkeypatch, data)
    with pytest.raises(promotion.PromotionError):
        promotion.promote(data, "v2.1.3", SOURCE, benchmark=True, latest=True)
    assert writes == []
    promotion.promote(data, "v2.1.3", SOURCE, benchmark=True)
    assert all(call[-2].endswith("-promoted") and ":ci-" in call[-2] for call in writes)
    with pytest.raises(promotion.PromotionError):
        promotion.validate_receipt(data, "v2.1.3", SOURCE)


def test_dry_run_validates_every_image_without_mutation(monkeypatch):
    data = receipt()
    writes = registry(monkeypatch, data)
    result = promotion.promote(
        copy.deepcopy(data), "v2.1.3", SOURCE, latest=True, dry_run=True
    )
    assert result["dry_run"] and result["ok"] and writes == []


def test_release_asset_must_authenticate_the_packaging_publisher_and_exact_bytes():
    payload = b'{"schema_version": 2}'
    meta = {
        "tag_name": "v2.1.3",
        "draft": False,
        "assets": [
            {
                "name": "release-image-acceptance.json",
                "size": len(payload),
                "digest": "sha256:" + hashlib.sha256(payload).hexdigest(),
                "uploader": {"id": 1857277},
            }
        ],
    }
    promotion.validate_release_asset(meta, "v2.1.3", payload)
    with pytest.raises(promotion.PromotionError):
        promotion.validate_release_asset(meta, "v2.1.3", payload + b" ")
    wrong = copy.deepcopy(meta)
    wrong["assets"][0]["uploader"]["id"] = 1
    with pytest.raises(promotion.PromotionError):
        promotion.validate_release_asset(wrong, "v2.1.3", payload)
    with pytest.raises(promotion.PromotionError):
        promotion.validate_release_asset(meta, "v2.1.4", payload)


@pytest.mark.parametrize("name", ["dramaclaw", "dramaclaw-frontend"])
@pytest.mark.parametrize("field", ["manifest_digest", "config_digest"])
def test_runtime_identity_must_match_the_accepted_registry_manifest(
    monkeypatch, name, field
):
    data = receipt()
    # Internally consistent proof is still rejected if it attests another
    # platform manifest or config than the accepted index actually contains.
    data["images"][name]["runtime"][field] = "sha256:" + "a" * 64
    if field == "config_digest":
        data["images"][name]["runtime"]["image_id"] = "sha256:" + "a" * 64
    writes = registry(monkeypatch, data)
    with pytest.raises(promotion.PromotionError):
        promotion.promote(data, "v2.1.3", SOURCE, latest=True)
    assert writes == []


@pytest.mark.parametrize("id_kind", ["index_digest", "manifest_digest"])
def test_containerd_identity_is_verified_via_its_selected_platform(
    monkeypatch, id_kind
):
    data = receipt()
    for image in data["images"].values():
        runtime = image["runtime"]
        runtime["image_id"] = runtime[id_kind]
        runtime["manifest_descriptor_digest"] = runtime["manifest_digest"]
    writes = registry(monkeypatch, data)
    assert promotion.promote(data, "v2.1.3", SOURCE, latest=True)["ok"]
    assert len(writes) == 2


@pytest.mark.parametrize("descriptor", [None, "sha256:" + "1" * 64])
def test_containerd_id_without_matching_platform_evidence_cannot_promote(
    monkeypatch, descriptor
):
    data = receipt()
    runtime = data["images"]["dramaclaw"]["runtime"]
    runtime["image_id"] = runtime["index_digest"]
    runtime["manifest_descriptor_digest"] = descriptor
    writes = registry(monkeypatch, data)
    with pytest.raises(promotion.PromotionError):
        promotion.promote(data, "v2.1.3", SOURCE, latest=True)
    assert writes == []
