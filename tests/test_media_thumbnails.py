"""Downscaled `/static` image variants (novelvideo.utils.thumbnails)."""

from __future__ import annotations

import os
import threading
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image

from novelvideo.utils import thumbnails

_MTIME_AFTER = 2_000_000_000_000_000_000


def _write_png(path: Path, size=(1200, 800), mode="RGB", color=(200, 30, 30)) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.new(mode, size, color).save(path)
    return path


def _drain_prewarm() -> None:
    """Block until the background workers have finished everything queued."""

    thumbnails._prewarm_channel().join()


def _warm(project_dir: Path, source: Path, variant: str) -> None:
    """Build a variant through the same background queue production uses.

    The request path never builds one itself, so every test below that is about
    *serving* a variant has to warm it first.
    """

    assert thumbnails.prewarm(project_dir, source, [variant]) == 1
    _drain_prewarm()


# Every known variant must round-trip; the frontend picks one by name and an
# unknown name silently serves the original, so a typo here is invisible online.
@pytest.mark.parametrize("variant", sorted(thumbnails.VARIANTS))
def test_every_variant_builds_within_its_own_budget(tmp_path, variant):
    source = _write_png(tmp_path / "images" / f"{variant}.png", (5504, 3072))

    dest = thumbnails.ensure_thumbnail(tmp_path, source, variant)

    assert dest is not None
    with Image.open(dest) as im:
        assert im.format == "WEBP"
        long_edge = thumbnails.VARIANTS[variant]
        assert max(im.size) == long_edge
        # Aspect preserved to the nearest pixel. The canvas never derives a
        # ratio from a variant (it measures off the recorded source size, see
        # nodeBodyImageMeasurement), but a variant that letterboxed or cropped
        # would still be visibly wrong in the node.
        assert abs(min(im.size) - round(long_edge * 3072 / 5504)) <= 1


# `card` feeds a canvas node body, so it must stay a real reduction on the
# sizes that made the canvas laggy — not just "smaller than the source".
def test_card_variant_is_an_order_of_magnitude_cheaper_to_decode(tmp_path):
    source = _write_png(tmp_path / "images" / "big.png", (5504, 3072))

    dest = thumbnails.ensure_thumbnail(tmp_path, source, "card")

    assert dest is not None
    with Image.open(dest) as im:
        source_pixels = 5504 * 3072
        assert im.size[0] * im.size[1] * 10 < source_pixels


def test_variants_do_not_share_a_cache_slot(tmp_path):
    source = _write_png(tmp_path / "images" / "big.png", (5504, 3072))

    thumb = thumbnails.ensure_thumbnail(tmp_path, source, "thumb")
    card = thumbnails.ensure_thumbnail(tmp_path, source, "card")

    assert thumb != card
    with Image.open(thumb) as a, Image.open(card) as b:
        assert max(a.size) == thumbnails.VARIANTS["thumb"]
        assert max(b.size) == thumbnails.VARIANTS["card"]


def test_builds_webp_within_the_variant_budget(tmp_path):
    source = _write_png(tmp_path / "freezone" / "_outputs" / "big.png", (1600, 900))

    dest = thumbnails.ensure_thumbnail(tmp_path, source, "thumb")

    assert dest is not None
    assert (
        dest
        == tmp_path / "_thumbs" / "thumb" / "freezone" / "_outputs" / "big.png.webp"
    )
    with Image.open(dest) as im:
        assert im.format == "WEBP"
        assert max(im.size) <= thumbnails.VARIANTS["thumb"]
        assert im.size == (320, 180)  # aspect ratio preserved
    assert dest.stat().st_size < source.stat().st_size


def test_variant_is_stamped_with_the_source_mtime(tmp_path):
    source = _write_png(tmp_path / "a.png")

    dest = thumbnails.ensure_thumbnail(tmp_path, source, "thumb")

    assert dest is not None
    assert dest.stat().st_mtime_ns == source.stat().st_mtime_ns


def test_variant_stays_current_when_fuse_replaces_the_requested_mtime(tmp_path):
    source = _write_png(tmp_path / "a.png")
    dest = thumbnails.ensure_thumbnail(tmp_path, source, "thumb")
    assert dest is not None

    # ossfs/geesefs may report success for os.utime but keep the later object
    # upload time after rename/copy instead of the timestamp requested above.
    later = source.stat().st_mtime_ns + 10**9
    os.utime(dest, ns=(later, later))

    assert thumbnails.fresh_thumbnail(tmp_path, source, "thumb") == dest


def test_second_call_reuses_the_cached_variant(tmp_path, monkeypatch):
    source = _write_png(tmp_path / "a.png")
    assert thumbnails.ensure_thumbnail(tmp_path, source, "thumb") is not None

    def _boom(*_args, **_kwargs):
        raise AssertionError("cached variant should not be re-rendered")

    monkeypatch.setattr(thumbnails, "_render", _boom)
    assert thumbnails.ensure_thumbnail(tmp_path, source, "thumb") is not None


def test_regenerated_source_invalidates_the_variant(tmp_path):
    source = _write_png(tmp_path / "a.png", (1600, 900), color=(10, 10, 200))
    first = thumbnails.ensure_thumbnail(tmp_path, source, "thumb")
    assert first is not None
    first_bytes = first.read_bytes()

    # Same path, different content and a newer mtime — what a regenerate does.
    _write_png(tmp_path / "a.png", (1600, 900), color=(240, 240, 10))
    os.utime(source, ns=(source.stat().st_mtime_ns + 10**9,) * 2)

    second = thumbnails.ensure_thumbnail(tmp_path, source, "thumb")
    assert second is not None
    assert second.read_bytes() != first_bytes
    assert second.stat().st_mtime_ns == source.stat().st_mtime_ns


def test_variant_follows_the_orientation_the_browser_shows(tmp_path):
    """EXIF orientation must be baked in, or the variant renders sideways.

    A browser applies the orientation tag when it paints the original, so a
    phone photo the user sees upright is stored rotated. Resizing the stored
    pixels without transposing produces a variant that disagrees with the
    original it stands in for -- the node shows the photo on its side and the
    fullscreen viewer snaps it upright. media_relay and the freezone crop route
    both transpose before resizing; this path must too.
    """

    source = tmp_path / "images" / "portrait.jpg"
    source.parent.mkdir(parents=True, exist_ok=True)
    image = Image.new("RGB", (2000, 1000), (10, 120, 200))
    exif = image.getexif()
    exif[274] = 6  # rotate 90 CW for display -> the browser sees 1000x2000
    image.save(source, "JPEG", exif=exif)

    dest = thumbnails.ensure_thumbnail(tmp_path, source, "card")

    assert dest is not None
    with Image.open(dest) as im:
        # Portrait, like the browser shows the original -- not the stored 1280x640.
        assert im.size == (640, 1280)


def test_source_already_within_budget_is_served_as_is(tmp_path, monkeypatch):
    """No variant when downscaling would not actually downscale anything.

    The history strip and the LOD shell ask for `thumb` unconditionally, so
    plenty of already-small sources reach this path. Re-encoding one to WEBP
    costs a decode and a write into the OSS-backed project dir and can come out
    larger than the original it replaces.
    """

    decodes = _watch_decodes(monkeypatch)
    source = _write_png(tmp_path / "images" / "small.png", (320, 200))

    assert thumbnails.ensure_thumbnail(tmp_path, source, "thumb") is None
    # ...and the source was never decoded to decide that, which is the whole
    # point: this path is hit constantly and the answer is in the header.
    assert decodes == []
    assert not (tmp_path / thumbnails.THUMB_ROOT).exists()


def test_a_source_one_pixel_over_the_budget_still_builds(tmp_path):
    source = _write_png(tmp_path / "images" / "just-over.png", (321, 200))

    dest = thumbnails.ensure_thumbnail(tmp_path, source, "thumb")

    assert dest is not None
    with Image.open(dest) as im:
        assert max(im.size) == 320


def test_transparency_survives_the_downscale(tmp_path):
    source = _write_png(tmp_path / "a.png", (600, 600), mode="RGBA", color=(0, 0, 0, 0))

    dest = thumbnails.ensure_thumbnail(tmp_path, source, "thumb")

    assert dest is not None
    with Image.open(dest) as im:
        assert im.mode in {"RGBA", "LA", "P"}
        assert im.convert("RGBA").getpixel((0, 0))[3] == 0


@pytest.mark.parametrize("variant", [None, "", "full", "THUMB-XL", "../etc"])
def test_unknown_variant_falls_back_to_the_original(tmp_path, variant):
    source = _write_png(tmp_path / "a.png")
    assert thumbnails.ensure_thumbnail(tmp_path, source, variant) is None


def test_variant_names_are_case_insensitive(tmp_path):
    source = _write_png(tmp_path / "a.png")
    assert thumbnails.ensure_thumbnail(tmp_path, source, " Thumb ") is not None


def test_non_image_sources_fall_back(tmp_path):
    for name in ("clip.mp4", "world.sog", "notes.txt", "loop.gif"):
        path = tmp_path / name
        path.write_bytes(b"not an image")
        assert thumbnails.ensure_thumbnail(tmp_path, path, "thumb") is None


def test_oversized_sources_fall_back(tmp_path, monkeypatch):
    source = _write_png(tmp_path / "a.png")
    monkeypatch.setattr(thumbnails, "_MAX_SOURCE_BYTES", 1)
    assert thumbnails.ensure_thumbnail(tmp_path, source, "thumb") is None


def _watch_decodes(monkeypatch) -> list:
    """Record every call to the first thing in ``_render`` that touches pixels.

    Up to ``exif_transpose`` the render is reading a header; from there on it is
    holding the whole bitmap. So "was this called" is the same question as "did
    we pay for this source", which is what the two tests below are really about.
    """

    from PIL import ImageOps

    seen: list = []
    real = ImageOps.exif_transpose
    monkeypatch.setattr(
        ImageOps, "exif_transpose", lambda im, **kw: seen.append(im) or real(im, **kw)
    )
    return seen


def test_a_small_file_that_decodes_huge_is_declined_before_decoding(
    tmp_path, monkeypatch
):
    """The file-size ceiling does not imply the pixel ceiling.

    Flat colour compresses to almost nothing, so this source clears
    ``_MAX_SOURCE_BYTES`` by three orders of magnitude while still holding 64
    megapixels. Pillow does not cover the gap: its decompression-bomb *error*
    only fires above ~179MP, and this sits quietly under even the warning
    threshold. Decoding it would cost a quarter gigabyte, times however many
    render slots are busy.
    """

    decodes = _watch_decodes(monkeypatch)
    source = _write_png(tmp_path / "images" / "flat.png", (8000, 8000), color=(7, 7, 7))
    assert source.stat().st_size < thumbnails._MAX_SOURCE_BYTES
    assert 8000 * 8000 > thumbnails._MAX_SOURCE_PIXELS

    assert thumbnails.ensure_thumbnail(tmp_path, source, "card") is None
    assert decodes == []
    assert not (tmp_path / thumbnails.THUMB_ROOT).exists()


def test_the_pixel_ceiling_leaves_real_photography_alone(tmp_path):
    """8K is 33MP. A ceiling that turns it away would be protecting nothing."""

    source = _write_png(tmp_path / "images" / "8k.png", (7680, 4320))

    dest = thumbnails.ensure_thumbnail(tmp_path, source, "card")

    assert dest is not None
    with Image.open(dest) as im:
        assert max(im.size) == 1280


def test_a_variant_is_never_itself_thumbnailed(tmp_path):
    nested = _write_png(tmp_path / thumbnails.THUMB_ROOT / "thumb" / "a.png.webp")
    assert thumbnails.thumbnail_path(tmp_path, nested, "thumb") is None
    assert thumbnails.ensure_thumbnail(tmp_path, nested, "thumb") is None


def test_sources_outside_the_project_fall_back(tmp_path):
    project = tmp_path / "project"
    project.mkdir()
    outside = _write_png(tmp_path / "elsewhere" / "a.png")
    assert thumbnails.ensure_thumbnail(project, outside, "thumb") is None


def test_undecodable_source_falls_back_instead_of_raising(tmp_path):
    source = tmp_path / "a.png"
    source.write_bytes(b"\x89PNG\r\n\x1a\n truncated garbage")
    assert thumbnails.ensure_thumbnail(tmp_path, source, "thumb") is None


def test_failed_render_leaves_no_temp_file_behind(tmp_path, monkeypatch):
    source = _write_png(tmp_path / "a.png")
    monkeypatch.setattr(
        thumbnails.os,
        "replace",
        lambda *_a, **_k: (_ for _ in ()).throw(OSError("nope")),
    )

    assert thumbnails.ensure_thumbnail(tmp_path, source, "thumb") is None
    leftovers = list((tmp_path / thumbnails.THUMB_ROOT).rglob("*.tmp"))
    assert leftovers == []


# --- lookup-only entry point ------------------------------------------------


def test_fresh_thumbnail_never_builds_what_is_missing(tmp_path):
    source = _write_png(tmp_path / "a.png", (2000, 1200))

    assert thumbnails.fresh_thumbnail(tmp_path, source, "thumb") is None
    assert not (tmp_path / thumbnails.THUMB_ROOT).exists()


def test_fresh_thumbnail_returns_a_variant_that_is_already_current(tmp_path):
    source = _write_png(tmp_path / "a.png", (2000, 1200))
    built = thumbnails.ensure_thumbnail(tmp_path, source, "thumb")

    assert thumbnails.fresh_thumbnail(tmp_path, source, "thumb") == built


def test_fresh_thumbnail_declines_a_variant_left_behind_by_an_older_source(tmp_path):
    """Same freshness rule as the builder, or the read path serves stale bytes."""

    source = _write_png(tmp_path / "a.png", (2000, 1200))
    thumbnails.ensure_thumbnail(tmp_path, source, "thumb")
    _write_png(source, (2000, 1200), color=(10, 200, 40))
    os.utime(source, ns=(_MTIME_AFTER, _MTIME_AFTER))

    assert thumbnails.fresh_thumbnail(tmp_path, source, "thumb") is None


def test_fresh_thumbnail_declines_anything_out_of_scope(tmp_path):
    source = _write_png(tmp_path / "a.png", (2000, 1200))
    thumbnails.ensure_thumbnail(tmp_path, source, "thumb")
    video = tmp_path / "clip.mp4"
    video.write_bytes(b"not an image")

    for variant in (None, "", "enormous"):
        assert thumbnails.fresh_thumbnail(tmp_path, source, variant) is None
    assert thumbnails.fresh_thumbnail(tmp_path, video, "thumb") is None
    assert thumbnails.fresh_thumbnail(tmp_path, tmp_path / "gone.png", "thumb") is None


# --- route wiring -----------------------------------------------------------


def _client(monkeypatch, project_dir: Path) -> TestClient:
    from novelvideo.api.deps import ProjectResolution
    from novelvideo.api.routes import files

    async def fake_resolve_project_scope(project, user, *, required_role="viewer"):
        return ProjectResolution(
            ctx=None,
            username="admin",
            project_name=project,
            project_dir=project_dir,
            output_dir=str(project_dir),
            state_dir=str(project_dir / "state"),
            runtime_dir=str(project_dir / "runtime"),
        )

    monkeypatch.setattr(files, "resolve_project_scope", fake_resolve_project_scope)

    app = FastAPI()
    app.include_router(files.router)
    app.dependency_overrides[files.get_api_user] = lambda: {"username": "admin"}
    return TestClient(app)


def test_media_route_serves_the_variant_when_asked(monkeypatch, tmp_path):
    source = _write_png(tmp_path / "freezone" / "_outputs" / "big.png", (2000, 1200))
    _warm(tmp_path, source, "thumb")
    client = _client(monkeypatch, tmp_path)

    full = client.get("/projects/demo/media/freezone/_outputs/big.png")
    thumb = client.get(
        "/projects/demo/media/freezone/_outputs/big.png", params={"st_thumb": "thumb"}
    )

    assert full.status_code == 200
    assert thumb.status_code == 200
    assert thumb.headers["content-type"] == "image/webp"
    assert len(thumb.content) < len(full.content)
    assert len(full.content) == source.stat().st_size


def test_media_route_serves_a_variant_when_fuse_discards_its_stamp(
    monkeypatch, tmp_path
):
    """Exercise the production ossfs/geesefs timestamp behavior end to end."""

    real_replace = os.replace

    def replace_and_use_upload_time(src, dest):
        real_replace(src, dest)
        if thumbnails.THUMB_ROOT in Path(dest).parts:
            os.utime(dest, ns=(_MTIME_AFTER, _MTIME_AFTER))

    monkeypatch.setattr(thumbnails.os, "replace", replace_and_use_upload_time)

    source = _write_png(tmp_path / "freezone" / "_outputs" / "big.png", (2000, 1200))
    _warm(tmp_path, source, "thumb")
    client = _client(monkeypatch, tmp_path)

    response = client.get(
        "/projects/demo/media/freezone/_outputs/big.png",
        params={"st_thumb": "thumb"},
    )

    assert response.status_code == 200
    assert response.headers["content-type"] == "image/webp"
    assert len(response.content) < source.stat().st_size


def test_media_route_ignores_an_unknown_variant(monkeypatch, tmp_path):
    _write_png(tmp_path / "a.png")
    client = _client(monkeypatch, tmp_path)

    bogus = client.get("/projects/demo/media/a.png", params={"st_thumb": "enormous"})
    plain = client.get("/projects/demo/media/a.png")

    assert bogus.status_code == 200
    assert bogus.content == plain.content


def test_media_route_falls_back_for_non_images(monkeypatch, tmp_path):
    (tmp_path / "clip.mp4").write_bytes(b"\x00\x01video-bytes")
    client = _client(monkeypatch, tmp_path)

    response = client.get("/projects/demo/media/clip.mp4", params={"st_thumb": "thumb"})

    assert response.status_code == 200
    assert response.content == b"\x00\x01video-bytes"


def test_bare_variant_url_is_revalidated_rather_than_held_stale(monkeypatch, tmp_path):
    """A URL with no version token must not be cached behind a max-age window.

    Variants are served from our bytes, so we own their freshness. The LOD shell
    requests thumbnails with no cache-bust token at all: regenerate an image in
    place and a plain max-age would keep painting the old one for the whole
    window with nothing able to invalidate it.
    """

    source = _write_png(tmp_path / "freezone" / "_outputs" / "big.png", (2000, 1200))
    _warm(tmp_path, source, "thumb")
    client = _client(monkeypatch, tmp_path)

    response = client.get(
        "/projects/demo/media/freezone/_outputs/big.png", params={"st_thumb": "thumb"}
    )

    assert response.status_code == 200
    # Assert the variant explicitly: a cold miss is also a 200, and a cache
    # assertion that passes while the original is being served tests nothing.
    assert response.headers["content-type"] == "image/webp"
    assert response.headers["cache-control"] == "private, no-cache"

    # Cheap revalidation is the whole point of no-cache. FileResponse sets an
    # ETag but never answers a conditional request — that lives in StaticFiles,
    # which does not serve this route — so without an explicit 304 every paint
    # would re-download the variant in full, worse than the stale window
    # no-cache was chosen to avoid.
    etag = response.headers["etag"]
    revalidated = client.get(
        "/projects/demo/media/freezone/_outputs/big.png",
        params={"st_thumb": "thumb"},
        headers={"If-None-Match": etag},
    )

    assert revalidated.status_code == 304
    assert revalidated.content == b""
    assert revalidated.headers["cache-control"] == "private, no-cache"


@pytest.mark.parametrize("token", ["st_v", "v"])
def test_versioned_variant_url_is_cached_hard(monkeypatch, tmp_path, token):
    """A versioned URL changes when the bytes change, so it is safe to pin."""

    source = _write_png(tmp_path / "freezone" / "_outputs" / "big.png", (2000, 1200))
    _warm(tmp_path, source, "thumb")
    client = _client(monkeypatch, tmp_path)

    response = client.get(
        "/projects/demo/media/freezone/_outputs/big.png",
        params={"st_thumb": "thumb", token: "1787194176036036558"},
    )

    assert response.status_code == 200
    assert response.headers["content-type"] == "image/webp"
    assert "immutable" in response.headers["cache-control"]


def test_a_regenerated_source_is_revalidated_to_the_new_variant(monkeypatch, tmp_path):
    source = _write_png(tmp_path / "freezone" / "_outputs" / "big.png", (2000, 1200))
    _warm(tmp_path, source, "thumb")
    client = _client(monkeypatch, tmp_path)
    url = "/projects/demo/media/freezone/_outputs/big.png"

    first = client.get(url, params={"st_thumb": "thumb"})
    # Same URL, different bytes — the in-place regeneration the shell cannot bust.
    _write_png(source, (2000, 1200), color=(10, 200, 40))
    os.utime(source, ns=(_MTIME_AFTER, _MTIME_AFTER))
    _warm(tmp_path, source, "thumb")
    second = client.get(url, params={"st_thumb": "thumb"})

    assert first.status_code == second.status_code == 200
    # Both are variants; without this the test would still pass with the route
    # serving the original twice, which is what a cold cache does.
    assert first.headers["content-type"] == "image/webp"
    assert second.headers["content-type"] == "image/webp"
    assert second.content != first.content
    # The validator moved with the source, so the browser's cached copy is not
    # revalidated into a 304 — it gets the new bytes.
    assert second.headers["etag"] != first.headers["etag"]
    stale = client.get(
        url,
        params={"st_thumb": "thumb"},
        headers={"If-None-Match": first.headers["etag"]},
    )
    assert stale.status_code == 200
    assert stale.content == second.content


def test_a_cold_variant_request_serves_the_original_without_queuing_work(
    monkeypatch, tmp_path
):
    """Reading old history must never schedule CPU-bound thumbnail work.

    Serving a request *without* a variant is a 302 to presigned OSS: the
    original never travels through this process. Building on demand trades that
    away for reading and decoding it locally, so the first visit to a cold
    project would pull every full-resolution source over the ossfs mount just to
    hand back a smaller copy. The response stays byte-for-byte what it would
    have been before variants existed and no future render is scheduled.
    """

    source = _write_png(tmp_path / "freezone" / "_outputs" / "big.png", (2000, 1200))
    client = _client(monkeypatch, tmp_path)
    url = "/projects/demo/media/freezone/_outputs/big.png"

    prewarm_calls: list[Path] = []
    monkeypatch.setattr(
        thumbnails,
        "prewarm",
        lambda _project_dir, requested, *_args: prewarm_calls.append(requested),
    )

    cold = client.get(url, params={"st_thumb": "thumb"})

    assert cold.status_code == 200
    assert cold.content == source.read_bytes()
    assert prewarm_calls == []
    assert not (tmp_path / thumbnails.THUMB_ROOT).exists()


def test_an_identical_prewarm_job_is_not_queued_twice(tmp_path, monkeypatch):
    """One paint of a cold canvas offers the same job once per visible node.

    And again on the next paint, since nothing is current yet. Without dedup a
    single canvas load packs the 512-slot queue with copies of a handful of jobs
    and drops the genuinely distinct ones.
    """

    source = _write_png(tmp_path / "a.png", (2000, 1200))
    started = threading.Event()
    release = threading.Event()
    original_render = thumbnails._render

    def block(*args, **kwargs):
        started.set()
        release.wait(5)
        return original_render(*args, **kwargs)

    monkeypatch.setattr(thumbnails, "_render", block)
    try:
        assert thumbnails.prewarm(tmp_path, source, ["thumb"]) == 1
        assert started.wait(5)
        assert thumbnails.prewarm(tmp_path, source, ["thumb"]) == 0
    finally:
        release.set()
    _drain_prewarm()

    assert thumbnails.thumbnail_path(tmp_path, source, "thumb").is_file()
    # The key is released once the job is done, or a source that was prewarmed
    # early in a process could never be prewarmed again after being rewritten.
    assert thumbnails.prewarm(tmp_path, source, ["thumb"]) == 1
    _drain_prewarm()


def test_variant_param_does_not_weaken_path_traversal_defence(monkeypatch, tmp_path):
    project = tmp_path / "project"
    project.mkdir()
    _write_png(tmp_path / "secret.png")
    client = _client(monkeypatch, project)

    # Percent-encoded so the client does not normalize the `..` away before the
    # request is sent -- a literal "../" never reaches the server and would make
    # this assertion pass without the guard ever running.
    response = client.get(
        "/projects/demo/media/%2E%2E/secret.png", params={"st_thumb": "thumb"}
    )

    assert response.status_code == 403
    # The guard has to run *before* the thumbnailer, or a variant of the escaped
    # file gets written into the project dir even though the response is a 403.
    assert not (project / thumbnails.THUMB_ROOT).exists()


# --- write-time prewarm ---------------------------------------------------


def test_prewarm_builds_the_variant_in_the_background(tmp_path):
    source = _write_png(tmp_path / "freezone" / "_outputs" / "gen.png", (1600, 900))

    assert thumbnails.prewarm(tmp_path, source) == len(thumbnails.VARIANTS)
    _drain_prewarm()

    for variant in thumbnails.VARIANTS:
        dest = thumbnails.thumbnail_path(tmp_path, source, variant)
        assert dest is not None and dest.is_file()


def test_prewarm_accepts_an_explicit_variant_list(tmp_path):
    source = _write_png(tmp_path / "a.png")

    assert thumbnails.prewarm(tmp_path, source, ["thumb"]) == 1
    _drain_prewarm()

    assert thumbnails.thumbnail_path(tmp_path, source, "thumb").is_file()


def test_prewarm_ignores_unknown_variants_and_non_images(tmp_path):
    source = _write_png(tmp_path / "a.png")
    video = tmp_path / "clip.mp4"
    video.write_bytes(b"not an image")

    assert thumbnails.prewarm(tmp_path, source, ["full", "", "../etc"]) == 0
    assert thumbnails.prewarm(tmp_path, video) == 0


def test_prewarm_drops_work_instead_of_blocking_when_saturated(tmp_path, monkeypatch):
    import queue as queue_mod

    class _Full:
        def put_nowait(self, _job):
            raise queue_mod.Full

    monkeypatch.setattr(thumbnails, "_prewarm_channel", lambda: _Full())
    source = _write_png(tmp_path / "a.png")

    assert thumbnails.prewarm(tmp_path, source) == 0


def test_prewarm_never_raises_into_its_caller(tmp_path, monkeypatch):
    def _boom():
        raise RuntimeError("no threads today")

    monkeypatch.setattr(thumbnails, "_prewarm_channel", _boom)
    assert thumbnails.prewarm(tmp_path, _write_png(tmp_path / "a.png")) == 0


# --- history records trigger the prewarm ----------------------------------


def _record(result):
    return {
        "id": "freezone_gen:abc",
        "status": "completed",
        "media_type": "image",
        "result": result,
    }


def _prewarm_spy(monkeypatch):
    calls: list[tuple[Path, tuple[str, ...]]] = []

    def record(_project_dir, source, variants=None):
        calls.append((source, tuple(variants or ())))
        return 1

    monkeypatch.setattr(thumbnails, "prewarm", record)
    return calls


def test_history_record_prewarms_its_output_image(tmp_path, monkeypatch):
    from novelvideo.freezone import history

    source = _write_png(tmp_path / "freezone" / "_outputs" / "gen" / "job.png")
    calls = _prewarm_spy(monkeypatch)

    queued = history.prewarm_history_thumbnail(
        tmp_path,
        _record(
            {
                "output_url": "/static/projects/p/freezone/_outputs/gen/job.png?v=17",
                "image_url": "/static/projects/p/freezone/_outputs/gen/job.png?v=17",
            }
        ),
    )

    assert queued == 1
    assert calls == [(source, ("thumb",))]


def test_history_record_only_prewarms_the_displayed_output(tmp_path, monkeypatch):
    from novelvideo.freezone import history

    for index in range(3):
        _write_png(tmp_path / "freezone" / "_outputs" / f"{index}.png")
    calls = _prewarm_spy(monkeypatch)

    history.prewarm_history_thumbnail(
        tmp_path,
        _record(
            {
                "output_url": "/static/projects/p/freezone/_outputs/0.png",
                "image_url": "/static/projects/p/freezone/_outputs/1.png",
                "images": [{"url": "/static/projects/p/freezone/_outputs/2.png"}],
            }
        ),
    )

    assert calls == [(tmp_path / "freezone" / "_outputs" / "0.png", ("thumb",))]


def test_history_record_ignores_non_image_payload_strings(tmp_path, monkeypatch):
    from novelvideo.freezone import history

    calls = _prewarm_spy(monkeypatch)

    history.prewarm_history_thumbnail(
        tmp_path,
        _record(
            {
                "model": "LingShan G2",
                "revised_prompt": "a photo of a cat. really.",
                "video_url": "/static/projects/p/freezone/_outputs/a.mp4",
                "seed": 1234,
            }
        ),
    )

    assert calls == []


def test_unfinished_history_record_never_queues_a_thumbnail(tmp_path, monkeypatch):
    from novelvideo.freezone import history

    calls = _prewarm_spy(monkeypatch)

    queued = history.prewarm_history_thumbnail(
        tmp_path,
        {
            **_record({"output_url": "/static/projects/p/freezone/_outputs/a.png"}),
            "status": "failed",
        },
    )

    assert queued == 0
    assert calls == []


def test_history_record_ignores_urls_escaping_the_project(tmp_path, monkeypatch):
    from novelvideo.freezone import history

    calls = _prewarm_spy(monkeypatch)

    history.prewarm_history_thumbnail(
        tmp_path,
        _record(
            {
                "output_url": "https://evil.example.com/x.png",
                "image_url": "/static/projects/p/../../../../etc/passwd.png",
            }
        ),
    )

    assert calls == []


def test_history_record_skips_an_invalid_candidate_url(tmp_path, monkeypatch):
    from novelvideo.freezone import history

    source = _write_png(tmp_path / "freezone" / "_outputs" / "valid.png")
    calls = _prewarm_spy(monkeypatch)

    queued = history.prewarm_history_thumbnail(
        tmp_path,
        _record(
            {
                "output_url": "https://provider.example/result.png",
                "image_url": "/static/projects/p/freezone/_outputs/valid.png",
            }
        ),
    )

    assert queued == 1
    assert calls == [(source, ("thumb",))]


def test_non_image_history_never_prewarms_a_thumbnail(tmp_path, monkeypatch):
    from novelvideo.freezone import history

    calls = _prewarm_spy(monkeypatch)

    queued = history.prewarm_history_thumbnail(
        tmp_path,
        {
            **_record(
                {
                    "output_url": "/static/projects/p/freezone/_outputs/movie.mp4",
                    "preview_image_url": "/static/projects/p/freezone/_outputs/poster.png",
                }
            ),
            "media_type": "video",
        },
    )

    assert queued == 0
    assert calls == []


@pytest.mark.parametrize("result", [None, "", [], "not-a-dict", 7])
def test_history_record_without_a_result_dict_queues_nothing(tmp_path, result):
    from novelvideo.freezone import history

    assert history.prewarm_history_thumbnail(tmp_path, _record(result)) == 0


def test_appending_a_history_record_prewarms_its_media(tmp_path, monkeypatch):
    from novelvideo.freezone import history

    source = _write_png(tmp_path / "freezone" / "_outputs" / "gen" / "job.png")
    calls = _prewarm_spy(monkeypatch)

    history.append_generation_history(
        project_dir=tmp_path,
        canvas_id="repro",
        node_id="node-1",
        record=_record(
            {"output_url": "/static/projects/p/freezone/_outputs/gen/job.png"}
        ),
    )

    assert calls == [(source, ("thumb",))]


def test_a_broken_prewarm_never_breaks_the_history_write(tmp_path, monkeypatch):
    from novelvideo.freezone import history

    _write_png(tmp_path / "freezone" / "_outputs" / "gen" / "job.png")

    def _boom(*_args, **_kwargs):
        raise RuntimeError("thumbnailer exploded")

    monkeypatch.setattr(thumbnails, "prewarm", _boom)

    written = history.append_generation_history(
        project_dir=tmp_path,
        canvas_id="repro",
        node_id="node-1",
        record=_record(
            {"output_url": "/static/projects/p/freezone/_outputs/gen/job.png"}
        ),
    )

    assert written is not None
    stored = history.read_generation_history(
        project_dir=tmp_path, canvas_id="repro", node_id="node-1"
    )
    assert len(stored) == 1


# --- offline backfill (scripts/backfill_thumbnails.py) ---------------------


@pytest.fixture
def backfill(monkeypatch):
    """Import the script and undo its global decode-budget resize afterwards."""

    import importlib.util
    import sys

    path = Path(__file__).resolve().parent.parent / "scripts" / "backfill_thumbnails.py"
    spec = importlib.util.spec_from_file_location("backfill_thumbnails", path)
    module = importlib.util.module_from_spec(spec)
    # @dataclass resolves its own module out of sys.modules; without this the
    # import fails before the script ever runs.
    monkeypatch.setitem(sys.modules, spec.name, module)
    spec.loader.exec_module(module)

    original = thumbnails._render_slots
    yield module
    # main() resizes the shared decode budget for the batch; put it back so a
    # later test does not inherit a backfill-sized semaphore.
    thumbnails._render_slots = original


def _variants_under(project_dir: Path) -> list[Path]:
    return sorted((project_dir / thumbnails.THUMB_ROOT).rglob("*.webp"))


# The script's counters count variants, not sources, so every expectation below
# scales with VARIANTS — adding a third variant must not need a test edit.
def _per_source() -> int:
    return len(thumbnails.VARIANTS)


def _write_backfillable_png(path: Path) -> Path:
    """A source every variant actually downscales.

    `_render` declines to build a variant that would not shrink anything, so a
    source smaller than the largest budget yields fewer files than there are
    variants and the counts below stop lining up with VARIANTS.
    """

    edge = max(thumbnails.VARIANTS.values()) + 1
    return _write_png(path, (edge, edge))


def test_backfill_builds_every_missing_variant(backfill, tmp_path, capsys):
    project = tmp_path / "alice" / "proj"
    for name in ("a.png", "sub/b.png", "sub/deep/c.png"):
        _write_backfillable_png(project / name)

    assert backfill.main([str(project)]) == 0

    assert len(_variants_under(project)) == 3 * _per_source()
    assert f"built {3 * _per_source()}" in capsys.readouterr().out


def test_backfill_is_idempotent(backfill, tmp_path, capsys):
    project = tmp_path / "alice" / "proj"
    _write_backfillable_png(project / "a.png")
    backfill.main([str(project)])
    capsys.readouterr()

    assert backfill.main([str(project)]) == 0

    out = capsys.readouterr().out
    assert "built 0" in out
    assert f"{_per_source()} already current" in out


def test_backfill_dry_run_writes_nothing(backfill, tmp_path, capsys):
    project = tmp_path / "alice" / "proj"
    _write_backfillable_png(project / "a.png")

    assert backfill.main([str(project), "--dry-run"]) == 0

    assert not (project / thumbnails.THUMB_ROOT).exists()
    # An upper bound: the dry run deliberately does not open the images, so it
    # cannot know which sources are already inside a variant's budget.
    assert f"would build up to {_per_source()}" in capsys.readouterr().out


def test_backfill_never_recurses_into_its_own_output(backfill, tmp_path, capsys):
    project = tmp_path / "alice" / "proj"
    _write_backfillable_png(project / "a.png")
    backfill.main([str(project)])
    capsys.readouterr()

    # A second pass must still see exactly one source, not the variant it wrote.
    backfill.main([str(project)])
    assert "1 image(s) scanned" in capsys.readouterr().out


def test_backfill_root_walks_user_and_project_levels(backfill, tmp_path, capsys):
    root = tmp_path / "output"
    for user, name in (("alice", "one"), ("alice", "two"), ("bob", "three")):
        _write_backfillable_png(root / user / name / "a.png")

    assert backfill.main(["--root", str(root)]) == 0

    out = capsys.readouterr().out
    assert "3 project(s)" in out
    assert f"built {3 * _per_source()}" in out


def test_backfill_counts_each_source_once_towards_the_savings_line(backfill, tmp_path):
    """The savings line is the script's whole justification; it must be true.

    Every source produces one variant per name, so accumulating source bytes
    per built variant reports len(VARIANTS)x the real volume — and the same
    multiple on the compression ratio the operator reads off the last line.
    """

    project = tmp_path / "alice" / "proj"
    sources = [
        _write_backfillable_png(project / "a.png"),
        _write_backfillable_png(project / "sub" / "b.png"),
    ]

    totals = backfill.backfill_project(project, sorted(thumbnails.VARIANTS), 2, False)

    assert totals.built == len(sources) * _per_source()
    assert totals.source_bytes == sum(s.stat().st_size for s in sources)
    assert 0 < totals.variant_bytes < totals.source_bytes


def test_backfill_ignores_non_images(backfill, tmp_path, capsys):
    project = tmp_path / "alice" / "proj"
    project.mkdir(parents=True)
    (project / "clip.mp4").write_bytes(b"\x00\x01")
    (project / "notes.txt").write_text("hi")
    (project / "world.sog").write_bytes(b"\x00")

    assert backfill.main([str(project)]) == 0

    assert "0 image(s) scanned" in capsys.readouterr().out
    assert not (project / thumbnails.THUMB_ROOT).exists()


def test_backfill_requires_a_target(backfill):
    with pytest.raises(SystemExit):
        backfill.main([])


def test_backfill_rejects_a_missing_directory(backfill, tmp_path):
    with pytest.raises(SystemExit):
        backfill.main([str(tmp_path / "nope")])
