"""Exercise the host replacement notice against the real vendored Studio."""

from __future__ import annotations

import json
import os
import shutil
import signal
import socket
import subprocess
import time
from contextlib import suppress
from pathlib import Path
from urllib.parse import urlsplit

import httpx
import pytest

from novelvideo.freezone import studio

NOTICE = "/api/host/film-replaced"
A = ("a", "2.999", 0)
B = ("b", "1.999", 3)
C = ("c", "1.999", 5)


def _document(*clips: tuple[str, str, int], title: str = "t") -> str:
    videos = "\n".join(
        f'<video id="clip-{index}" data-dramaclaw-item-id="{item}" '
        f'src="assets/{item.upper()}.mp4#t=0,{end}" at="{at}" volume="1"></video>'
        for index, (item, end, at) in enumerate(clips)
    )
    return f"""<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=1920, height=1080">
<title>{title}</title>
<style>
html, body {{ margin: 0; background: #000000; }}
</style>
</head>
<body>
<section>
{videos}
</section>
</body>
</html>
"""


def _port() -> int:
    while True:
        with socket.socket() as editor, socket.socket() as preview:
            editor.bind(("127.0.0.1", 0))
            port = editor.getsockname()[1]
            if port == 65535:
                continue
            try:
                preview.bind(("127.0.0.1", port + 1))
            except OSError:
                continue
            return port


@pytest.fixture
def running_studio(tmp_path_factory):
    node = shutil.which("node")
    if not node or not studio._runtime_installed():
        pytest.skip("Node and the vendored Studio runtime are required")

    root = tmp_path_factory.mktemp("openfilm-studio")
    key = "test-launch-key"
    launcher = studio._repo_root() / "scripts/openfilm_studio/run.mjs"
    log_path = root / "studio.log"
    home = root / "home"
    home.mkdir()

    for attempt in range(1, 4):
        ready = root / f"ready-{attempt}.json"
        with pytest.MonkeyPatch.context() as patch:
            patch.setattr(studio, "STATE_DIR", root / "state")
            patch.setattr(studio, "RUNTIME_DIR", root / "runtime")
            patch.delenv("KUBERNETES_SERVICE_HOST", raising=False)
            patch.delenv("SUPERTALE_OPENFILM_STUDIO_PUBLIC_ORIGIN", raising=False)
            env = studio._studio_env(_port(), key, ready)
        env["OPENFILM_HOME"] = str(home)

        with log_path.open("wb") as log:
            proc = subprocess.Popen(
                [node, str(launcher)],
                env=env,
                stdout=log,
                stderr=log,
                start_new_session=True,
            )
        try:
            deadline = time.monotonic() + 15
            while not ready.exists() and proc.poll() is None and time.monotonic() < deadline:
                time.sleep(0.05)
            if not ready.is_file():
                exited = proc.poll() is not None
                startup_log = log_path.read_text()
                if attempt < 3 and exited and "EADDRINUSE" in startup_log:
                    continue
                pytest.fail(startup_log)
            yield json.loads(ready.read_text())["origin"], key
            return
        finally:
            with suppress(ProcessLookupError):
                os.killpg(proc.pid, signal.SIGKILL)
            proc.wait(timeout=5)


def _trim(client: httpx.Client, project: str, clip: str) -> None:
    film = client.get(project).raise_for_status().json()
    client.post(
        f"{project}/edit",
        json={
            "base": film["rev"],
            "ops": [{"op": "set", "clip": clip, "field": "time", "value": [0, 1.467]}],
        },
    ).raise_for_status()


@pytest.fixture
def trimmed_film(running_studio, tmp_path):
    origin, key = running_studio
    film_dir = tmp_path / "film"
    state_dir = tmp_path / "state"
    runtime_dir = tmp_path / "runtime"
    for directory in (film_dir / "assets", state_dir, runtime_dir):
        directory.mkdir(parents=True)
    (film_dir / "film.html").write_text(_document(A, B), encoding="utf-8")

    with httpx.Client(base_url=origin, headers={"x-studio-key": key}, trust_env=False) as client:
        registration = client.post(
            "/api/projects",
            json={
                "path": str(film_dir),
                "create": True,
                "stateDir": str(state_dir),
                "runtimeDir": str(runtime_dir),
            },
        ).raise_for_status().json()
        project = f"/api/projects/{registration['project']['id']}"
        _trim(client, project, "clip-1")
        assert "B.mp4#t=0,1.467" in (film_dir / "film.html").read_text()
        yield client, project, film_dir, state_dir


def _notice(client: httpx.Client, folder: Path) -> None:
    response = client.post(NOTICE, json={"path": str(folder)})
    assert response.status_code == 200, response.text
    assert response.json() == {"ok": True}


def _rewrite_and_settle(client: httpx.Client, project: str, folder: Path, document: str) -> dict:
    pending = folder / "film.html.tmp"
    pending.write_text(document, encoding="utf-8")
    os.replace(pending, folder / "film.html")
    client.get(project).raise_for_status()
    time.sleep(0.6)
    return client.get(project).raise_for_status().json()


def _kept_merges(state_dir: Path, film_dir: Path) -> list[str]:
    marker = b"Kept the person's edits"
    matches = []
    for directory in (state_dir, film_dir / ".film"):
        for path in directory.rglob("*"):
            if path.is_file() and marker in path.read_bytes():
                matches.append(str(path))
        repo = directory / "history"
        if not (repo / "HEAD").is_file():
            continue
        git = ["git", f"--git-dir={repo}"]
        refs = subprocess.check_output(
            [*git, "for-each-ref", "--format=%(refname)", "refs/openfilm/merges"]
        )
        matches.extend(refs.decode().splitlines())
        # Include unreachable commits as well as those still pointed to by a ref.
        objects = subprocess.check_output([*git, "cat-file", "--batch", "--batch-all-objects"])
        if marker in objects:
            matches.append(f"{repo} object database")
    return matches


def test_host_rewrite_after_replace_notice_drops_the_trim(trimmed_film, tmp_path):
    client, project, folder, state = trimmed_film
    alias = tmp_path / "film-alias"
    alias.symlink_to(folder, target_is_directory=True)
    _notice(client, alias)
    document = _document(A, B, C)

    result = _rewrite_and_settle(client, project, folder, document)

    assert (folder / "film.html").read_bytes() == document.encode()
    assert "1.467" not in result["text"]
    assert "1.467" not in json.dumps(result["doc"])
    assert _kept_merges(state, folder) == []


def test_without_the_notice_studio_keeps_the_trim(trimmed_film):
    client, project, folder, state = trimmed_film
    _rewrite_and_settle(client, project, folder, _document(A, B, C))

    assert "B.mp4#t=0,1.467" in (folder / "film.html").read_text()
    assert _kept_merges(state, folder)


def test_replace_notice_keeps_the_trim_off_a_shifted_clip(trimmed_film):
    client, project, folder, _ = trimmed_film
    _notice(client, folder)
    document = _document(("b", "1.999", 0), ("c", "1.999", 2))

    _rewrite_and_settle(client, project, folder, document)

    disk = (folder / "film.html").read_bytes()
    assert disk == document.encode()
    assert b"C.mp4#t=0,1.999" in disk
    assert b"1.467" not in disk


def test_replace_notice_is_host_only(running_studio, trimmed_film, tmp_path):
    origin, key = running_studio
    client, project, folder, _ = trimmed_film
    body = {"path": str(folder)}
    port = urlsplit(origin).port

    with httpx.Client(base_url=origin, trust_env=False) as browser:
        assert browser.post(NOTICE, json=body).status_code == 401
        response = browser.post(
            NOTICE,
            json=body,
            headers={"cookie": f"openfilm_studio_{port}={key}", "origin": origin},
        )
        assert response.status_code == 403, response.text

    _rewrite_and_settle(client, project, folder, _document(A, B, C))
    assert "B.mp4#t=0,1.467" in (folder / "film.html").read_text()

    for invalid in ({}, {"path": "film"}):
        response = client.post(NOTICE, json=invalid)
        assert response.status_code == 400, response.text

    unread = tmp_path / "unread"
    unread.mkdir()
    _notice(client, unread)


def test_edits_after_the_replace_notice_are_protected_again(trimmed_film):
    client, project, folder, state = trimmed_film
    _notice(client, folder)
    document = _document(A, B, C)
    _rewrite_and_settle(client, project, folder, document)
    assert (folder / "film.html").read_bytes() == document.encode()
    assert _kept_merges(state, folder) == []

    _trim(client, project, "clip-2")
    assert "C.mp4#t=0,1.467" in (folder / "film.html").read_text()

    _rewrite_and_settle(client, project, folder, _document(A, B, C, title="Agent edit"))
    merged = (folder / "film.html").read_text()
    assert "<title>Agent edit</title>" in merged
    assert "C.mp4#t=0,1.467" in merged
    assert _kept_merges(state, folder)
