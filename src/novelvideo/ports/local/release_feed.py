"""Local CE release feed adapter."""

from __future__ import annotations

import importlib.metadata
import os
import time
from dataclasses import replace
from pathlib import Path
from typing import Any, Awaitable, Callable

import httpx
from packaging.version import InvalidVersion, Version

from novelvideo.ports.release_feed import ReleaseFeed, ReleaseItem
from novelvideo.release_notes import parse, validate_version_marker

PACKAGE_NAME = "supertale-ce"
TAG_PREFIX = "v"
GITHUB_LATEST_RELEASE_URL = "https://api.github.com/repos/dramaclaw/dramaclaw/releases/latest"
GITHUB_CACHE_TTL_SECONDS = 6 * 60 * 60
GITHUB_FAILURE_CACHE_TTL_SECONDS = 60

GitHubFetcher = Callable[[], Awaitable[dict[str, Any]]]
VersionReader = Callable[[], str]


class NoOpReleaseFeed:
    async def current(self, *, locale: str) -> ReleaseFeed:
        _ = locale
        return ReleaseFeed(source="none")


class LocalReleaseFeed:
    def __init__(
        self,
        *,
        notes_path: Path | None = None,
        version_reader: VersionReader | None = None,
        github_fetcher: GitHubFetcher | None = None,
        clock: Callable[[], float] | None = None,
    ) -> None:
        self._notes_path = notes_path
        self._version_reader = version_reader or (lambda: importlib.metadata.version(PACKAGE_NAME))
        self._github_fetcher = github_fetcher or self._fetch_latest_release
        self._clock = clock or time.time
        self._local_cache_key: tuple[Path, int, int] | None = None
        self._local_cache_body: str | None = None
        self._github_cache_until = 0.0
        self._github_cache_payload: dict[str, Any] | None = None
        self._github_failure_cache_until = 0.0

    async def current(self, *, locale: str) -> ReleaseFeed:
        if not _enabled():
            return ReleaseFeed(source="none")

        current_version = self._read_current_version()
        current_tag = f"{TAG_PREFIX}{current_version}" if current_version else None
        current_items: list[ReleaseItem] = []
        if current_tag is not None and current_version is not None:
            body = self._read_notes_body()
            if body:
                try:
                    validate_version_marker(body, current_version)
                    parsed = parse(body, current_tag, locale=locale)
                    current_items = [_to_port_item(item) for item in parsed.items]
                except ValueError:
                    current_items = []

        feed = ReleaseFeed(
            source="local_file",
            current_version=current_version,
            current_tag=current_tag,
            current_items=current_items,
        )

        if current_version is None:
            return feed

        latest = await self._latest_release()
        if latest is None:
            return feed

        latest_tag = str(latest.get("tag_name") or "").strip() or None
        latest_version = _version_from_tag(latest_tag)
        if latest_tag is None or latest_version is None:
            return replace(feed, source="local_file+github")

        update_available = _is_newer(latest_version, current_version)
        parsed_latest = parse(str(latest.get("body") or ""), latest_tag, locale=locale)
        release_url = str(latest.get("html_url") or "") or None
        latest_published_at = str(latest.get("published_at") or "") or None
        return replace(
            feed,
            source="local_file+github",
            update_available=update_available,
            latest_version=latest_version if update_available else None,
            latest_tag=latest_tag if update_available else None,
            release_url=release_url if update_available else None,
            update_items=[_to_port_item(item) for item in parsed_latest.items]
            if update_available
            else [],
            attention=parsed_latest.attention if update_available else "low",
            latest_published_at=latest_published_at if update_available else None,
        )

    def _read_current_version(self) -> str | None:
        try:
            return self._version_reader()
        except importlib.metadata.PackageNotFoundError:
            return None

    def _notes_file(self) -> Path:
        if self._notes_path is not None:
            return self._notes_path
        return Path(__file__).resolve().parents[2] / "release-notes.md"

    def _read_notes_body(self) -> str:
        path = self._notes_file()
        try:
            stat = path.stat()
        except OSError:
            self._local_cache_key = None
            self._local_cache_body = None
            return ""
        key = (path, int(stat.st_mtime_ns), int(stat.st_size))
        if key == self._local_cache_key and self._local_cache_body is not None:
            return self._local_cache_body
        try:
            body = path.read_text(encoding="utf-8")
        except OSError:
            body = ""
        self._local_cache_key = key
        self._local_cache_body = body
        return body

    async def _latest_release(self) -> dict[str, Any] | None:
        now = self._clock()
        if self._github_cache_payload is not None and now < self._github_cache_until:
            return self._github_cache_payload
        if now < self._github_failure_cache_until:
            return None
        try:
            payload = await self._github_fetcher()
        except Exception:
            self._github_failure_cache_until = now + GITHUB_FAILURE_CACHE_TTL_SECONDS
            return None
        self._github_cache_payload = payload
        self._github_cache_until = now + GITHUB_CACHE_TTL_SECONDS
        self._github_failure_cache_until = 0.0
        return payload

    async def _fetch_latest_release(self) -> dict[str, Any]:
        headers = {"Accept": "application/vnd.github+json"}
        token = os.environ.get("RELEASE_NOTIFICATIONS_GITHUB_TOKEN", "").strip()
        if token:
            headers["Authorization"] = f"Bearer {token}"
        async with httpx.AsyncClient(timeout=5.0) as client:
            response = await client.get(GITHUB_LATEST_RELEASE_URL, headers=headers)
            response.raise_for_status()
            return response.json()


def _enabled() -> bool:
    value = os.environ.get("RELEASE_NOTIFICATIONS_ENABLED", "true").strip().lower()
    return value not in {"0", "false", "no", "off"}


def _version_from_tag(tag: str | None) -> str | None:
    if not tag:
        return None
    value = tag[1:] if tag.lower().startswith(TAG_PREFIX) else tag
    return value.strip() or None


def _is_newer(candidate: str, current: str) -> bool:
    try:
        return Version(candidate) > Version(current)
    except InvalidVersion:
        return candidate > current


def _to_port_item(item) -> ReleaseItem:
    return ReleaseItem(
        id=item.id,
        kind=item.kind,
        icon=item.icon,
        title=item.title,
        body=item.body,
    )
