# SPDX-License-Identifier: Elastic-2.0
# Copyright (c) 2026 ClaymoreLab
"""Artlist Enterprise Music API provider.

Search Artlist's royalty-free catalog and fetch a downloadable track for use as
background music (BGM) in episode composition.

Auth is OAuth2 client-credentials: set ``ARTLIST_CLIENT_ID`` /
``ARTLIST_CLIENT_SECRET`` (the Enterprise API key pair). Access tokens live for
one hour and are cached until shortly before expiry.

API contract (Artlist Business API):
  - token: POST {token_url}  (Basic base64(id:secret), grant_type=client_credentials)
  - search: GET {base}/search/v1/song?page&query&categoryIds&durationMin/Max&bpmMin/Max
      -> {"songs": [{"id", "duration", "genreCategories": [{"name"}], "url"}]}
  - download: GET {base}/download/v1/downloadable/song/{id}/{mp3|wave}
      -> {"url": "<downloadable file>"}
"""

from __future__ import annotations

import base64
import os
import time
from dataclasses import dataclass
from typing import Any, Iterable, Optional

import aiohttp

DEFAULT_API_BASE = "https://business.artlist.io"
DEFAULT_TOKEN_URL = (
    "https://artlist-business-api-prod-cognito.artlist.io/oauth2/token"
)
# Artlist caps song duration filters at 420s (7 min).
MAX_SONG_DURATION = 420


class ArtlistError(RuntimeError):
    """Raised when an Artlist API call fails."""


@dataclass
class ArtlistTrack:
    """A song returned by Artlist search."""

    id: str
    duration: float  # seconds
    url: str  # AAC preview URL from search results
    name: str = ""
    genres: tuple[str, ...] = ()


class ArtlistMusicProvider:
    """Thin async client for the Artlist Business music API."""

    def __init__(
        self,
        client_id: Optional[str] = None,
        client_secret: Optional[str] = None,
        api_base: Optional[str] = None,
        token_url: Optional[str] = None,
    ):
        self.client_id = client_id or os.environ.get("ARTLIST_CLIENT_ID")
        self.client_secret = client_secret or os.environ.get("ARTLIST_CLIENT_SECRET")
        self.api_base = (
            api_base or os.environ.get("ARTLIST_API_BASE") or DEFAULT_API_BASE
        ).rstrip("/")
        self.token_url = (
            token_url or os.environ.get("ARTLIST_TOKEN_URL") or DEFAULT_TOKEN_URL
        )
        self._token: Optional[str] = None
        self._token_exp: float = 0.0

        if not (self.client_id and self.client_secret):
            raise ValueError(
                "ARTLIST_CLIENT_ID and ARTLIST_CLIENT_SECRET must be set for Artlist"
            )

    async def _access_token(self) -> str:
        # Reuse the cached token until 60s before it expires.
        if self._token and time.time() < self._token_exp - 60:
            return self._token

        basic = base64.b64encode(
            f"{self.client_id}:{self.client_secret}".encode()
        ).decode()
        headers = {
            "Authorization": f"Basic {basic}",
            "Content-Type": "application/x-www-form-urlencoded",
        }
        async with aiohttp.ClientSession() as session:
            async with session.post(
                self.token_url,
                headers=headers,
                data="grant_type=client_credentials",
            ) as resp:
                if resp.status != 200:
                    text = await resp.text()
                    raise ArtlistError(
                        f"Token request failed: HTTP {resp.status} - {text[:200]}"
                    )
                data = await resp.json()

        token = data.get("access_token")
        if not token:
            raise ArtlistError(f"No access_token in token response: {str(data)[:200]}")
        self._token = token
        self._token_exp = time.time() + float(data.get("expires_in") or 3600)
        return token

    async def _auth_headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {await self._access_token()}",
            "Accept": "application/json",
        }

    async def search_songs(
        self,
        *,
        query: Optional[str] = None,
        category_ids: Optional[Iterable[str]] = None,
        duration_min: Optional[int] = None,
        duration_max: Optional[int] = None,
        bpm_min: Optional[int] = None,
        bpm_max: Optional[int] = None,
        vocal_type: Optional[str] = None,
        page: int = 1,
    ) -> list[ArtlistTrack]:
        """Search the catalog. Filters map 1:1 to the Artlist query params."""
        params: dict[str, Any] = {"page": max(1, int(page))}
        if query:
            params["query"] = query
        if category_ids:
            params["categoryIds"] = list(category_ids)
        if duration_min is not None:
            params["durationMin"] = int(duration_min)
        if duration_max is not None:
            params["durationMax"] = int(duration_max)
        if bpm_min is not None:
            params["bpmMin"] = int(bpm_min)
        if bpm_max is not None:
            params["bpmMax"] = int(bpm_max)
        if vocal_type:
            params["vocalType"] = vocal_type

        async with aiohttp.ClientSession() as session:
            async with session.get(
                f"{self.api_base}/search/v1/song",
                params=params,
                headers=await self._auth_headers(),
            ) as resp:
                if resp.status != 200:
                    text = await resp.text()
                    raise ArtlistError(
                        f"Song search failed: HTTP {resp.status} - {text[:200]}"
                    )
                data = await resp.json()

        tracks: list[ArtlistTrack] = []
        for song in data.get("songs") or []:
            genres = tuple(
                (g or {}).get("name", "")
                for g in (song.get("genreCategories") or [])
                if (g or {}).get("name")
            )
            tracks.append(
                ArtlistTrack(
                    id=str(song.get("id")),
                    duration=float(song.get("duration") or 0),
                    url=song.get("url") or "",
                    name=song.get("name") or "",
                    genres=genres,
                )
            )
        return tracks

    async def get_download_url(self, song_id: str, fmt: str = "mp3") -> str:
        """Resolve a downloadable file URL for a song (fmt: 'mp3' or 'wave')."""
        fmt = fmt if fmt in {"mp3", "wave"} else "mp3"
        async with aiohttp.ClientSession() as session:
            async with session.get(
                f"{self.api_base}/download/v1/downloadable/song/{song_id}/{fmt}",
                headers=await self._auth_headers(),
            ) as resp:
                if resp.status != 200:
                    text = await resp.text()
                    raise ArtlistError(
                        f"Download URL request failed: HTTP {resp.status} - {text[:200]}"
                    )
                data = await resp.json()
        url = data.get("url")
        if not url:
            raise ArtlistError(f"No url in downloadable response: {str(data)[:200]}")
        return url

    async def download_track(self, url: str, output_path: str) -> str:
        """Download an audio file to ``output_path``."""
        os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)
        async with aiohttp.ClientSession() as session:
            async with session.get(url) as resp:
                if resp.status != 200:
                    raise ArtlistError(f"Track download failed: HTTP {resp.status}")
                with open(output_path, "wb") as f:
                    f.write(await resp.read())
        return output_path

    async def fetch_bgm(
        self,
        output_path: str,
        *,
        query: Optional[str] = None,
        duration_target: Optional[float] = None,
        fmt: str = "mp3",
        tolerance: float = 30.0,
    ) -> tuple[ArtlistTrack, str]:
        """Search for a track, pick the best duration match, and download it.

        Returns ``(track, local_path)``. Prefers a track near
        ``duration_target`` seconds; the composer can still loop/trim to the
        exact episode length.
        """
        dmin = dmax = None
        if duration_target:
            dmin = max(0, int(duration_target - tolerance))
            dmax = min(MAX_SONG_DURATION, int(duration_target + tolerance))

        tracks = await self.search_songs(
            query=query, duration_min=dmin, duration_max=dmax
        )
        if not tracks and (dmin is not None or dmax is not None):
            # Relax the duration window if nothing matched.
            tracks = await self.search_songs(query=query)
        if not tracks:
            raise ArtlistError("No Artlist tracks matched the query")

        if duration_target:
            track = min(tracks, key=lambda t: abs(t.duration - duration_target))
        else:
            track = tracks[0]

        download_url = await self.get_download_url(track.id, fmt=fmt)
        await self.download_track(download_url, output_path)
        return track, output_path
