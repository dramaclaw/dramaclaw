from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_api_image_drops_root_at_runtime() -> None:
    dockerfile = (ROOT / "Dockerfile").read_text(encoding="utf-8")
    assert "useradd --system --uid 10001" in dockerfile
    assert "USER dramaclaw:dramaclaw" in dockerfile
    assert "HERMES_CLI_PATH=/usr/local/bin/hermes" in dockerfile


def test_all_api_compose_variants_are_hardened() -> None:
    for name in (
        "docker-compose.yml",
        "docker-compose.release.yml",
        "docker-compose.selfhosted.yml",
        "docker-compose.selfhosted.release.yml",
    ):
        text = (ROOT / name).read_text(encoding="utf-8")
        api = text.split("\n  web:", 1)[0]
        assert 'user: "10001:10001"' in api, name
        assert "read_only: true" in api, name
        assert "- ALL" in api, name
        assert "no-new-privileges:true" in api, name
