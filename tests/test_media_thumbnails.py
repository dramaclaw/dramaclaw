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
    assert dest == tmp_path / "_thumbs" / "thumb" / "freezone" / "_outputs" / "big.png.webp"
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


def test_source_already_within_budget_is_served_as_is(tmp_path):
    """No variant when downscaling would not actually downscale anything.

    The history strip and the LOD shell ask for `thumb` unconditionally, so
    plenty of already-small sources reach this path. Re-encoding one to WEBP
    costs a decode and a write into the OSS-backed project dir and can come out
    larger than the original it replaces.
    """

    source = _write_png(tmp_path / "images" / "small.png", (320, 200))

    assert thumbnails.ensure_thumbnail(tmp_path, source, "thumb") is None
    # ...and nothing was written on the way to deciding that.
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
        thumbnails.os, "replace", lambda *_a, **_k: (_ for _ in ()).throw(OSError("nope"))
    )

    assert thumbnails.ensure_thumbnail(tmp_path, source, "thumb") is None
    leftovers = list((tmp_path / thumbnails.THUMB_ROOT).rglob("*.tmp"))
    assert leftovers == []


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

    _write_png(tmp_path / "freezone" / "_outputs" / "big.png", (2000, 1200))
    client = _client(monkeypatch, tmp_path)

    response = client.get(
        "/projects/demo/media/freezone/_outputs/big.png", params={"st_thumb": "thumb"}
    )

    assert response.status_code == 200
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

    _write_png(tmp_path / "freezone" / "_outputs" / "big.png", (2000, 1200))
    client = _client(monkeypatch, tmp_path)

    response = client.get(
        "/projects/demo/media/freezone/_outputs/big.png",
        params={"st_thumb": "thumb", token: "1787194176036036558"},
    )

    assert response.status_code == 200
    assert "immutable" in response.headers["cache-control"]


def test_a_regenerated_source_is_revalidated_to_the_new_variant(monkeypatch, tmp_path):
    source = _write_png(tmp_path / "freezone" / "_outputs" / "big.png", (2000, 1200))
    client = _client(monkeypatch, tmp_path)
    url = "/projects/demo/media/freezone/_outputs/big.png"

    first = client.get(url, params={"st_thumb": "thumb"})
    # Same URL, different bytes — the in-place regeneration the shell cannot bust.
    _write_png(source, (2000, 1200), color=(10, 200, 40))
    os.utime(source, ns=(_MTIME_AFTER, _MTIME_AFTER))
    second = client.get(url, params={"st_thumb": "thumb"})

    assert first.status_code == second.status_code == 200
    assert second.content != first.content
    # The validator moved with the source, so the browser's cached copy is not
    # revalidated into a 304 — it gets the new bytes.
    assert second.headers["etag"] != first.headers["etag"]
    stale = client.get(
        url, params={"st_thumb": "thumb"}, headers={"If-None-Match": first.headers["etag"]}
    )
    assert stale.status_code == 200
    assert stale.content == second.content


def test_renders_do_not_run_on_the_shared_request_threadpool(monkeypatch, tmp_path):
    """Renders belong on the thumbnailer's own executor.

    Starlette's threadpool is ~40 threads for the whole app and ensure_thumbnail
    blocks on the decode semaphore: rendering there means a burst of cold
    thumbnails parks threads every other blocking call in the process needs.
    """

    _write_png(tmp_path / "freezone" / "_outputs" / "big.png", (2000, 1200))
    client = _client(monkeypatch, tmp_path)
    seen: list[str] = []

    original = thumbnails._render

    def record(*args, **kwargs):
        seen.append(threading.current_thread().name)
        return original(*args, **kwargs)

    monkeypatch.setattr(thumbnails, "_render", record)

    response = client.get(
        "/projects/demo/media/freezone/_outputs/big.png", params={"st_thumb": "thumb"}
    )

    assert response.status_code == 200
    assert seen and all(name.startswith("thumb-render") for name in seen), seen


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


def _drain_prewarm() -> None:
    """Block until the background workers have finished everything queued."""

    thumbnails._prewarm_channel().join()


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
    return {"id": "freezone_gen:abc", "media_type": "image", "result": result}


def _prewarm_spy(monkeypatch):
    calls: list[Path] = []
    monkeypatch.setattr(
        thumbnails, "prewarm", lambda project_dir, source, *a, **k: (calls.append(source), 1)[1]
    )
    return calls


def test_history_record_prewarms_its_output_image(tmp_path, monkeypatch):
    from novelvideo.freezone import history

    source = _write_png(tmp_path / "freezone" / "_outputs" / "gen" / "job.png")
    calls = _prewarm_spy(monkeypatch)

    queued = history.prewarm_record_variants(
        tmp_path,
        _record(
            {
                "output_url": "/static/projects/p/freezone/_outputs/gen/job.png?v=17",
                "image_url": "/static/projects/p/freezone/_outputs/gen/job.png?v=17",
            }
        ),
    )

    assert queued == 1  # same URL twice is one job
    assert calls == [source]


def test_history_record_prewarms_images_nested_in_lists(tmp_path, monkeypatch):
    from novelvideo.freezone import history

    for index in range(3):
        _write_png(tmp_path / "freezone" / "_outputs" / f"{index}.png")
    calls = _prewarm_spy(monkeypatch)

    history.prewarm_record_variants(
        tmp_path,
        _record(
            {
                "images": [
                    {"url": f"/static/projects/p/freezone/_outputs/{i}.png"}
                    for i in range(3)
                ]
            }
        ),
    )

    assert sorted(path.name for path in calls) == ["0.png", "1.png", "2.png"]


def test_history_record_ignores_non_image_payload_strings(tmp_path, monkeypatch):
    from novelvideo.freezone import history

    calls = _prewarm_spy(monkeypatch)

    history.prewarm_record_variants(
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


def test_history_record_ignores_urls_escaping_the_project(tmp_path, monkeypatch):
    from novelvideo.freezone import history

    calls = _prewarm_spy(monkeypatch)

    history.prewarm_record_variants(
        tmp_path,
        _record(
            {
                "a": "https://evil.example.com/x.png",
                "b": "/static/projects/p/../../../../etc/passwd.png",
                "c": "//evil.example.com/y.png",
            }
        ),
    )

    assert calls == []


def test_history_record_caps_how_many_images_it_queues(tmp_path, monkeypatch):
    from novelvideo.freezone import history

    calls = _prewarm_spy(monkeypatch)

    history.prewarm_record_variants(
        tmp_path,
        _record({f"u{i}": f"/static/projects/p/img_{i}.png" for i in range(40)}),
    )

    assert len(calls) <= history._PREWARM_MAX_URLS


@pytest.mark.parametrize("result", [None, "", [], "not-a-dict", 7])
def test_history_record_without_a_result_dict_queues_nothing(tmp_path, result):
    from novelvideo.freezone import history

    assert history.prewarm_record_variants(tmp_path, _record(result)) == 0


def test_appending_a_history_record_prewarms_its_media(tmp_path, monkeypatch):
    from novelvideo.freezone import history

    source = _write_png(tmp_path / "freezone" / "_outputs" / "gen" / "job.png")
    calls = _prewarm_spy(monkeypatch)

    history.append_generation_history(
        project_dir=tmp_path,
        canvas_id="repro",
        node_id="node-1",
        record=_record({"output_url": "/static/projects/p/freezone/_outputs/gen/job.png"}),
    )

    assert calls == [source]


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
        record=_record({"output_url": "/static/projects/p/freezone/_outputs/gen/job.png"}),
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
