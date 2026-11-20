"""Per-film host storage is carried through every Studio entry point."""

from pathlib import Path
from types import SimpleNamespace
import tempfile

import pytest

from novelvideo.freezone import studio


@pytest.fixture()
def host(monkeypatch, tmp_path):
    from novelvideo.api.routes import freezone

    ctx = SimpleNamespace(
        output_dir=tmp_path / "output",
        state_dir=tmp_path / "state",
        runtime_dir=tmp_path / "runtime",
        project_id="p",
        requester_user_id="u",
    )
    root = ctx.output_dir / "freezone/studio/c1/n1"
    (root / "assets").mkdir(parents=True)
    (root / "film.html").write_text("<html></html>")
    (root / ".film").mkdir()
    (root / ".film/id").write_text("film-1")
    source = ctx.output_dir / "freezone/_uploads/a.mp4"
    source.parent.mkdir(parents=True)
    source.write_bytes(b"media")
    calls = []

    async def resolve(*args, **kwargs):
        return ctx, "u", "p", ctx.output_dir, str(ctx.output_dir)

    async def ensure():
        return {
            "origin": "http://127.0.0.1:4747",
            "film_origin": "http://127.0.0.1:4748",
            "key": "k",
        }

    async def post(state, path, body):
        assert path == "/api/projects"
        calls.append(body)
        return {"project": {"id": "film-1"}}

    async def request(state, method, path, body=None, **kwargs):
        if method == "POST" and path.endswith("/exports"):
            exported = Path(body["folder"]) / "film.mp4"
            exported.write_bytes(b"render")
            return 200, {"exports": [{"id": "e1"}]}
        if path.endswith("/exports"):
            return 200, {
                "exports": [{"id": "e1", "status": "done", "outputs": [str(exported_path(ctx))]}]
            }
        return 200, {"doc": {"tracks": []}, "rev": "r1"}

    monkeypatch.setenv("SUPERTALE_OPENFILM_STUDIO_ENABLED", "1")
    monkeypatch.setattr(studio, "STATE_DIR", tmp_path / "global-state")
    monkeypatch.setattr(freezone, "_resolve_freezone_project", resolve)
    monkeypatch.setattr(studio, "_ensure_studio", ensure)
    monkeypatch.setattr(studio, "_studio_post", post)
    monkeypatch.setattr(studio, "_studio_request", request)
    return ctx, root, calls


def exported_path(ctx):
    return ctx.output_dir / "freezone/_outputs/freezone_video_compose/studio-exports/film.mp4"


@pytest.mark.parametrize("operation", ["session", "read", "edit", "import", "runner", "proxy"])
async def test_all_entry_points_register_host_dirs(host, monkeypatch, operation):
    from novelvideo.api.routes import freezone, openfilm
    from novelvideo.api.schemas import (
        FreezoneVideoComposeStudioRequest,
        FreezoneStudioFilmEditRequest,
        FreezoneStudioMediaImportRequest,
    )
    from novelvideo.task_backend.runners import freezone as runner

    ctx, root, calls = host
    if operation == "session":
        monkeypatch.setattr(freezone, "build_studio_film", lambda **kwargs: root)
        await freezone.freezone_video_compose_studio(
            "p",
            FreezoneVideoComposeStudioRequest(
                canvas_id="c1", node_id="n1", tracks=[], host_back="http://localhost/"
            ),
            {"id": "u"},
        )
    elif operation == "read":
        await freezone.freezone_studio_film("p", "c1", "n1", {"id": "u"})
    elif operation == "edit":
        await freezone.freezone_studio_film_edit(
            "p",
            "c1",
            "n1",
            FreezoneStudioFilmEditRequest(ops=[{"op": "move", "clip": "clip-1", "at": 2}]),
            {"id": "u"},
        )
    elif operation == "import":
        await freezone.freezone_studio_import_media(
            "p",
            "c1",
            "n1",
            FreezoneStudioMediaImportRequest(source_url="/freezone/_uploads/a.mp4"),
            {"id": "u"},
        )
    elif operation == "proxy":
        await openfilm._film("p", "c1", "n1", {"id": "u"})
    else:
        from novelvideo.api import deps

        monkeypatch.setattr(runner, "_update", lambda *args, **kwargs: None)
        monkeypatch.setattr(runner, "_append_node_history", lambda **kwargs: None)
        monkeypatch.setattr(
            runner, "_project_video_compose_result_to_canvas", lambda **kwargs: False
        )
        monkeypatch.setattr(deps, "make_static_url_for_context", lambda *args: "/output.mp4")

        async def leaf(envelope, fn, name, **kwargs):
            return await fn(**kwargs)

        monkeypatch.setattr(runner, "_call_freezone_leaf", leaf)
        result = await runner._run_freezone_video_compose_async(
            {
                "payload": {
                    "job_id": "j1",
                    "studio_export": True,
                    "canvas_id": "c1",
                    "node_id": "n1",
                }
            },
            ctx,
        )
        assert Path(result["output_path"]).read_bytes() == b"render"
    assert calls == [
        {
            "path": str(ctx.output_dir / "freezone/studio/c1/n1"),
            "create": True,
            "stateDir": str(ctx.state_dir / "openfilm/c1/n1"),
            "runtimeDir": str(ctx.runtime_dir / "openfilm/c1/n1"),
        }
    ]


@pytest.mark.parametrize("kind", ["state", "runtime"])
@pytest.mark.parametrize("location", ["film", "home", "temp"])
def test_host_dirs_reject_unsafe_locations(monkeypatch, tmp_path, kind, location):
    root = tmp_path / "output/freezone/studio/c1/n1"
    home = tmp_path / "home"
    monkeypatch.setattr(studio, "_studio_home", lambda: home)
    # Resolve symlinks too: a nominal host path can point at a forbidden location.
    target = {"film": root / "cache", "home": home / "cache", "temp": Path(tempfile.gettempdir())}[
        location
    ]
    target.mkdir(parents=True, exist_ok=True)
    base = tmp_path / "unsafe"
    (base / "openfilm/c1").mkdir(parents=True)
    (base / "openfilm/c1/n1").symlink_to(target, target_is_directory=True)
    dirs = {"state_dir": tmp_path / "state", "runtime_dir": tmp_path / "runtime"}
    dirs[f"{kind}_dir"] = base
    with pytest.raises(studio.StudioError) as error:
        studio.studio_film_for_node(
            project_dir=tmp_path / "output", **dirs, canvas_id="c1", node_id="n1"
        )
    assert error.value.status_code == 500


def test_film_host_dirs_use_the_same_safe_segments(monkeypatch, tmp_path):
    monkeypatch.setattr(studio, "_studio_home", lambda: tmp_path / "home")
    film = studio.studio_film_for_node(
        project_dir=tmp_path / "output",
        state_dir=tmp_path / "state",
        runtime_dir=tmp_path / "runtime",
        canvas_id="c/1",
        node_id="n/1",
    )
    assert film.root == studio.film_dir_for_node(tmp_path / "output", "c/1", "n/1")
    assert film.state_dir == tmp_path / "state/openfilm" / film.root.parent.name / film.root.name
    assert (
        film.runtime_dir == tmp_path / "runtime/openfilm" / film.root.parent.name / film.root.name
    )


def test_studio_env_owns_its_tmp(monkeypatch, tmp_path):
    monkeypatch.setattr(studio, "STATE_DIR", tmp_path / "state")
    monkeypatch.setattr(studio, "RUNTIME_DIR", tmp_path / "runtime", raising=False)
    monkeypatch.delenv("KUBERNETES_SERVICE_HOST", raising=False)
    for name in ("TMPDIR", "TMP", "TEMP"):
        monkeypatch.setenv(name, "/inherited")
    env = studio._studio_env(4747, "key", tmp_path / "ready")
    expected = str(tmp_path / "runtime/openfilm/tmp")
    assert env["TMPDIR"] == env["TMP"] == env["TEMP"] == expected
    assert Path(expected).stat().st_mode & 0o777 == 0o700
    assert env["OPENFILM_HOST_DIRS"] == "1"
    assert env["OPENFILM_HOME"] == str(tmp_path / "state/openfilm/home")


@pytest.mark.parametrize("location", ["home", "temp"])
def test_studio_env_rejects_unsafe_tmp(monkeypatch, tmp_path, location):
    runtime = tmp_path / "runtime"
    target = tmp_path / "home" if location == "home" else Path(tempfile.gettempdir())
    target.mkdir(parents=True, exist_ok=True)
    (runtime / "openfilm").mkdir(parents=True)
    (runtime / "openfilm/tmp").symlink_to(target, target_is_directory=True)
    monkeypatch.setattr(studio, "RUNTIME_DIR", runtime, raising=False)
    monkeypatch.setattr(studio, "_studio_home", lambda: tmp_path / "home")
    with pytest.raises(studio.StudioError) as error:
        studio._studio_env(4747, "k", tmp_path / "ready")
    assert error.value.status_code == 500
