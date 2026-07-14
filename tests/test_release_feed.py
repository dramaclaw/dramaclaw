from __future__ import annotations

import asyncio
import importlib.metadata
import subprocess
import tomllib
import zipfile
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient


def test_release_notes_parser_selects_locale_and_stable_ids() -> None:
    from novelvideo.release_notes import parse

    body = (
        "---\n"
        "version: 1.0.2\n"
        "attention: high\n"
        "---\n"
        "# v1.0.2\n"
        "\n"
        "## user-facing highlights (zh)\r\n"
        "*   **标题  一** :  正文   一\r\n"
        "- **:** should be skipped\r\n"
        "```md\r\n"
        "- **围栏内**: 不解析\r\n"
        "```\r\n"
        "### zh nested heading should not stop a level-2 section\r\n"
        "- **标题二**: 正文二\r\n"
        "## User-facing Highlights (en)\n"
        "- **Title One**: Body One\n"
        "## Fixes\n"
        "- **Hidden**: not included\n"
    )

    parsed = parse(body, "v1.0.2", locale="zh")

    assert parsed.version == "1.0.2"
    assert parsed.attention == "high"
    assert [item.title for item in parsed.items] == ["标题 一", "标题二"]
    assert [item.body for item in parsed.items] == ["正文 一", "正文二"]
    assert parsed.items[0].id == "release:v1.0.2:ab74958d"
    assert all(item.kind == "release" and item.icon == "sparkles" for item in parsed.items)

    en = parse(body, "v1.0.2", locale="en")
    assert [item.title for item in en.items] == ["Title One"]
    assert en.items[0].id == "release:v1.0.2:13bb30be"


def test_release_notes_parser_falls_back_and_requires_tag_for_items() -> None:
    from novelvideo.release_notes import parse

    body = "# v1.0.2\n\n## User-facing Highlights (en)\n- **Only English**: fallback\n"

    assert [item.title for item in parse(body, "v1.0.2", locale="zh").items] == [
        "Only English"
    ]
    assert parse(body, None, locale="en").items == []


def test_packaged_release_notes_are_bilingual_and_match_pyproject_version() -> None:
    from novelvideo.release_notes import parse, validate_version_marker

    pyproject = tomllib.loads(Path("pyproject.toml").read_text(encoding="utf-8"))
    expected_version = pyproject["project"]["version"]
    body = Path("src/novelvideo/release-notes.md").read_text(encoding="utf-8")

    assert "## User-facing Highlights (zh)" in body
    assert "## User-facing Highlights (en)" in body
    validate_version_marker(body, expected_version)
    assert parse(body, f"v{expected_version}", locale="zh", allow_locale_fallback=False).items
    assert parse(body, f"v{expected_version}", locale="en", allow_locale_fallback=False).items


def test_packaged_release_notes_are_explicitly_force_included_in_wheel() -> None:
    pyproject = tomllib.loads(Path("pyproject.toml").read_text(encoding="utf-8"))

    wheel_target = pyproject["tool"]["hatch"]["build"]["targets"]["wheel"]

    assert wheel_target["force-include"]["src/novelvideo/release-notes.md"] == (
        "novelvideo/release-notes.md"
    )


def test_built_wheel_contains_parseable_release_notes_artifact(tmp_path: Path) -> None:
    from novelvideo.release_notes import parse, validate_version_marker

    result = subprocess.run(
        ["uv", "build", "--wheel", "--out-dir", str(tmp_path)],
        check=False,
        cwd=Path.cwd(),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )

    assert result.returncode == 0, result.stdout
    wheels = sorted(tmp_path.glob("supertale_ce-*.whl"))
    assert len(wheels) == 1

    pyproject = tomllib.loads(Path("pyproject.toml").read_text(encoding="utf-8"))
    expected_version = pyproject["project"]["version"]
    with zipfile.ZipFile(wheels[0]) as wheel:
        body = wheel.read("novelvideo/release-notes.md").decode("utf-8")

    validate_version_marker(body, expected_version)
    assert parse(body, f"v{expected_version}", locale="zh", allow_locale_fallback=False).items
    assert parse(body, f"v{expected_version}", locale="en", allow_locale_fallback=False).items


def test_project_version_is_single_source_of_truth() -> None:
    pyproject = tomllib.loads(Path("pyproject.toml").read_text(encoding="utf-8"))

    assert pyproject["project"]["version"] == "1.0.9"
    assert importlib.metadata.version("supertale-ce") == pyproject["project"]["version"]
    assert "__version__" not in Path("src/novelvideo/__init__.py").read_text(encoding="utf-8")


@pytest.mark.asyncio
async def test_local_release_feed_reads_notes_and_silently_degrades_github(tmp_path: Path) -> None:
    from novelvideo.ports.local.release_feed import LocalReleaseFeed

    notes = tmp_path / "release-notes.md"
    notes.write_text(
        "---\n"
        "version: 1.0.2\n"
        "attention: low\n"
        "---\n"
        "# v1.0.2\n"
        "\n"
        "## User-facing Highlights (zh)\n"
        "- **当前功能**: 离线也可见\n"
        "## User-facing Highlights (en)\n"
        "- **Current feature**: works offline\n",
        encoding="utf-8",
    )
    calls = 0

    async def failing_fetcher() -> dict[str, Any]:
        nonlocal calls
        calls += 1
        raise TimeoutError("offline")

    feed = await LocalReleaseFeed(
        notes_path=notes,
        version_reader=lambda: "1.0.2",
        github_fetcher=failing_fetcher,
    ).current(locale="zh")

    assert calls == 1
    assert feed.source == "local_file"
    assert feed.current_version == "1.0.2"
    assert feed.current_tag == "v1.0.2"
    assert [item.title for item in feed.current_items] == ["当前功能"]
    assert feed.update_available is False
    assert feed.latest_tag is None


@pytest.mark.asyncio
async def test_local_release_feed_negative_caches_github_failures(tmp_path: Path) -> None:
    from novelvideo.ports.local.release_feed import GITHUB_FAILURE_CACHE_TTL_SECONDS, LocalReleaseFeed

    notes = tmp_path / "release-notes.md"
    notes.write_text(
        "---\nversion: 1.0.2\n---\n# v1.0.2\n"
        "## User-facing Highlights (en)\n- **Current**: local\n",
        encoding="utf-8",
    )
    now = 100.0
    calls = 0

    async def failing_fetcher() -> dict[str, Any]:
        nonlocal calls
        calls += 1
        raise TimeoutError("offline")

    feed = LocalReleaseFeed(
        notes_path=notes,
        version_reader=lambda: "1.0.2",
        github_fetcher=failing_fetcher,
        clock=lambda: now,
    )

    first = await feed.current(locale="en")
    second = await feed.current(locale="en")

    assert calls == 1
    assert first.source == "local_file"
    assert second.source == "local_file"

    now += GITHUB_FAILURE_CACHE_TTL_SECONDS + 1
    await feed.current(locale="en")

    assert calls == 2


@pytest.mark.asyncio
async def test_local_release_feed_reports_newer_github_release(tmp_path: Path) -> None:
    from novelvideo.ports.local.release_feed import LocalReleaseFeed

    notes = tmp_path / "release-notes.md"
    notes.write_text(
        "---\nversion: 1.0.2\n---\n# v1.0.2\n"
        "## User-facing Highlights (en)\n- **Current**: local\n",
        encoding="utf-8",
    )

    async def fetcher() -> dict[str, Any]:
        return {
            "tag_name": "v1.0.5",
            "html_url": "https://github.com/dramaclaw/dramaclaw/releases/tag/v1.0.5",
            "published_at": "2026-07-01T08:00:00Z",
            "body": (
                "---\nattention: medium\n---\n# v1.0.5\n"
                "## User-facing Highlights (en)\n- **Upgrade**: newer release\n"
            ),
        }

    feed = await LocalReleaseFeed(
        notes_path=notes,
        version_reader=lambda: "1.0.2",
        github_fetcher=fetcher,
    ).current(locale="en")

    assert feed.source == "local_file+github"
    assert feed.update_available is True
    assert feed.latest_version == "1.0.5"
    assert feed.latest_tag == "v1.0.5"
    assert feed.release_url == "https://github.com/dramaclaw/dramaclaw/releases/tag/v1.0.5"
    assert feed.latest_published_at == "2026-07-01T08:00:00Z"
    assert feed.attention == "medium"
    assert [item.title for item in feed.update_items] == ["Upgrade"]


@pytest.mark.asyncio
async def test_local_release_feed_disabled_and_missing_version_do_not_call_github(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from importlib.metadata import PackageNotFoundError

    from novelvideo.ports.local.release_feed import LocalReleaseFeed

    notes = tmp_path / "release-notes.md"
    notes.write_text(
        "# v1.0.2\n## User-facing Highlights (en)\n- **Current**: local\n",
        encoding="utf-8",
    )
    calls = 0

    async def fetcher() -> dict[str, Any]:
        nonlocal calls
        calls += 1
        return {}

    monkeypatch.setenv("RELEASE_NOTIFICATIONS_ENABLED", "false")
    disabled = await LocalReleaseFeed(
        notes_path=notes,
        version_reader=lambda: "1.0.2",
        github_fetcher=fetcher,
    ).current(locale="en")
    assert disabled.source == "none"
    assert disabled.current_items == []
    assert calls == 0

    monkeypatch.setenv("RELEASE_NOTIFICATIONS_ENABLED", "true")
    missing_version = await LocalReleaseFeed(
        notes_path=notes,
        version_reader=lambda: (_ for _ in ()).throw(PackageNotFoundError("supertale-ce")),
        github_fetcher=fetcher,
    ).current(locale="en")
    assert missing_version.source == "local_file"
    assert missing_version.current_version is None
    assert missing_version.current_tag is None
    assert missing_version.current_items == []
    assert missing_version.update_available is False
    assert calls == 0


def test_release_feed_port_falls_back_to_noop_when_unregistered() -> None:
    from novelvideo.ports import get_release_feed_port
    from novelvideo.ports.registry import _PORTS

    _PORTS.pop("release_feed", None)

    feed = asyncio.run(get_release_feed_port().current(locale="zh"))
    assert feed.source == "none"
    assert feed.current_items == []
    assert feed.update_available is False


def test_release_notifications_route_returns_ok_envelope(monkeypatch: pytest.MonkeyPatch) -> None:
    from novelvideo.api.app import create_app
    from novelvideo.api.auth import get_api_user
    from novelvideo.ports.registry import register_port
    from novelvideo.ports.release_feed import ReleaseFeed, ReleaseItem

    class FakeReleaseFeedPort:
        async def current(self, *, locale: str) -> ReleaseFeed:
            assert locale == "en"
            return ReleaseFeed(
                source="local_file",
                current_version="1.0.2",
                current_tag="v1.0.2",
                current_items=[
                    ReleaseItem(
                        id="release:v1.0.2:abc12345",
                        kind="release",
                        icon="sparkles",
                        title="Current",
                        body="Body",
                    )
                ],
            )

    monkeypatch.setenv("ST_EDITION", "ce")
    monkeypatch.delenv("ST_CONTROL_PLANE_DSN", raising=False)
    register_port("release_feed", FakeReleaseFeedPort())
    app = create_app()
    app.dependency_overrides[get_api_user] = lambda: {"username": "local"}

    response = TestClient(app).get(
        "/api/v1/release-notifications",
        headers={"Accept-Language": "en-US,en;q=0.9"},
    )

    assert response.status_code == 200
    assert response.json() == {
        "ok": True,
        "data": {
            "source": "local_file",
            "current_version": "1.0.2",
            "current_tag": "v1.0.2",
            "current_items": [
                {
                    "id": "release:v1.0.2:abc12345",
                    "kind": "release",
                    "icon": "sparkles",
                    "title": "Current",
                    "body": "Body",
                }
            ],
            "update_available": False,
            "latest_version": None,
            "latest_tag": None,
            "release_url": None,
            "update_items": [],
            "attention": "low",
            "latest_published_at": None,
        },
    }
