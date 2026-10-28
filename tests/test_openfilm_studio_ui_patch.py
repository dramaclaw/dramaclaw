# SPDX-License-Identifier: Elastic-2.0
# Copyright (c) 2026 ClaymoreLab
"""The vendored OpenFilm editor ships as a minified chunk, so a re-vendor silently
loses Dramaclaw's patches. Assert the patched build is what actually ships."""

from __future__ import annotations

import re
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
DIST = REPO_ROOT / "vendor" / "openfilm" / "studio" / "ui" / "dist"
PATCH_SCRIPT = REPO_ROOT / "scripts" / "openfilm_studio" / "patch_studio_ui.mjs"
SOURCE_PATCHES = REPO_ROOT / "scripts" / "openfilm_studio" / "source-patches"
REVENDOR = REPO_ROOT / "scripts" / "openfilm_studio" / "revendor.mjs"


def _chunk_names() -> tuple[str, str]:
    """The stock and patched chunk names, read from the script's own constants."""
    script = PATCH_SCRIPT.read_text(encoding="utf-8")
    match = re.search(
        r"^const SOURCE_CHUNK = ['\"](.+?)['\"];\n"
        r"const PATCHED_CHUNK = ['\"](.+?)['\"];$",
        script,
        re.MULTILINE,
    )
    assert match, "patch script lost its chunk-name constants"
    return match.group(1), match.group(2)


@pytest.fixture(scope="module")
def chunk() -> str:
    _, patched = _chunk_names()
    path = DIST / "assets" / patched
    assert path.is_file(), (
        f"{path.name} is missing — run `node scripts/openfilm_studio/patch_studio_ui.mjs` "
        "after vendoring OpenFilm"
    )
    return path.read_text(encoding="utf-8")


def test_version_history_stays_out_of_the_embed(chunk: str) -> None:
    """Version history is the editor's local git — commit messages, branches and copies of
    the film's media. The person cutting a video in the host manages no project folder, so
    both the toolbar entry and its dialog stay hidden; the history API itself is untouched."""
    assert 'function EG({open:e,onClick:t,className:s}){const r=Be();return a.jsx(on,' not in chunk
    assert 'function EG({open:e,onClick:t,className:s}){const r=Be();return new URLSearchParams(location.search).get("hostBack")?null:a.jsx(on,' in chunk
    assert 'function AG({projectId:e,history:t,open:s,anchor:r,onClose:i}){const l=Be(),' not in chunk
    assert 'function AG({projectId:e,history:t,open:s,anchor:r,onClose:i}){if(new URLSearchParams(location.search).get("hostBack"))return null;const l=Be(),' in chunk


def test_dev_release_notes_stay_out_of_the_embed(chunk: str) -> None:
    """Settings → Developer closed with a Releases group that previews the vendored editor's
    own notes: it prints the upstream version and reopens the dialog the embed suppresses.
    The editor ships with the host image, so there is no user-facing update to preview."""
    assert 'rb()?a.jsx(jo,{title:e("settings.developer.releaseGroup")' not in chunk
    assert 'rb()&&!new URLSearchParams(location.search).get("hostBack")?a.jsx(jo,{title:e("settings.developer.releaseGroup")' in chunk


def test_source_edits_are_stored_as_patches() -> None:
    """The UI source is not vendored, so these files are the only copy of our edits to it.
    Losing them means the next upgrade silently drops hostBack, the 44px titlebar, the
    open Layers pane, the export attribution, the branded server copy and the route gates."""
    patches = sorted(SOURCE_PATCHES.glob("*.patch"))
    assert [path.name for path in patches] == [
        "0001-project-view-embed.patch",
        "0002-app-keep-host-back.patch",
        "0003-host-chrome-fallback.patch",
        "0004-export-branding.patch",
        "0005-update-gate.patch",
        "0006-project-name-from-film-title.patch",
        "0007-server-copy-branding.patch",
        "0008-host-route-gates.patch",
    ]
    text = "\n".join(path.read_text(encoding="utf-8") for path in patches)
    for path in (
        "packages/openfilm/studio/ui/src/components/ProjectView.tsx",
        "packages/openfilm/studio/ui/src/App.tsx",
        "packages/openfilm/src/host.mjs",
        "packages/openfilm/studio/server/slides.mjs",
        "packages/openfilm/studio/server/fcpxml.mjs",
        "packages/openfilm/studio/server/server.mjs",
        "packages/openfilm/studio/server/projects.mjs",
        "packages/openfilm/studio/server/transcripts.mjs",
        "packages/openfilm/studio/server/get.mjs",
        "packages/openfilm/studio/server/history-store.mjs",
    ):
        assert f"a/{path}" in text and f"b/{path}" in text
    assert "dramaclaw:studio-back" in text
    assert "hostBackLabel" in text
    assert "OPENFILM_CHROME_CHANNEL" in text
    assert "flex h-8 min-w-0 items-center" in text
    assert "flex h-11 min-w-0 items-center" in text
    assert "useKeptFlag('openfilm.project.layers', false)" in text
    assert "useKeptFlag('openfilm.project.layers', true)" in text
    assert "<dc:creator>Dramaclaw</dc:creator>" in text
    assert "`Dramaclaw A${i + 1}`" in text
    assert "OPENFILM_NO_UPDATE_CHECK" in text


def test_project_name_uses_the_film_title() -> None:
    """The film folder is named after the compose node id so a reopen finds the same film;
    the editor header therefore printed that UUID. The host already writes the node's name
    as the film's <title>, which is also the name an export should carry."""
    server = (
        REPO_ROOT / "vendor" / "openfilm" / "studio" / "server" / "projects.mjs"
    ).read_text(encoding="utf-8")
    assert "name: basename(r.path)" not in server
    assert "name: filmTitle(r.path) ?? basename(r.path)" in server
    patch = (
        SOURCE_PATCHES / "0006-project-name-from-film-title.patch"
    ).read_text(encoding="utf-8")
    assert "a/packages/openfilm/studio/server/projects.mjs" in patch
    assert "filmTitle" in patch


def test_film_title_decodes_pythons_apostrophe() -> None:
    """Python writes the <title> with html.escape(), which spells an apostrophe `&#x27;`, while
    the decoder only knew `&#39;` — so a node named 「It's fine」 kept the raw entity in the
    editor header."""
    pattern = re.compile(r"replace\(/&#39;\|&#x27;/g")
    server = (
        REPO_ROOT / "vendor" / "openfilm" / "studio" / "server" / "projects.mjs"
    ).read_text(encoding="utf-8")
    patch = (
        SOURCE_PATCHES / "0006-project-name-from-film-title.patch"
    ).read_text(encoding="utf-8")
    assert pattern.search(server), "vendored filmTitle no longer decodes &#x27;"
    assert pattern.search(patch), "stored patch would restore the old decoder on revendor"


def test_project_fonts_do_not_carry_the_vendored_product(chunk: str) -> None:
    """`eA` prefixes both the @font-face family and the stack that points at it, so the name is
    written into every film that picks a project font — and a re-vendor puts the editor's own name
    back there."""
    assert '"OpenFilm Project "' not in chunk
    assert '"Dramaclaw Project "' in chunk


def test_embed_title_cannot_rename_the_film_folder(chunk: str) -> None:
    """The heading is Studio's rename box, and renaming a project moves its folder — which is
    the id the host looks the film up by. Enter therefore looked like a save that had not taken
    (the name came back) while the next open quietly built a fresh cut and orphaned the edits.
    In the embed the name belongs to the canvas node, so the heading only shows it."""
    assert 'children:oc?a.jsx("input",{autoFocus:!0,value:Cm' not in chunk
    assert (
        'children:new URLSearchParams(location.search).get("hostBack")'
        '?a.jsx("span",{className:"min-w-0 truncate px-2 text-[13px] font-medium '
        'text-[var(--text-muted)]",children:WY(Ko||r("project.untitled"))})'
        ':oc?a.jsx("input",{autoFocus:!0,value:Cm'
    ) in chunk


def test_revendor_applies_the_stored_patches_and_guards_the_bundle() -> None:
    """revendor.mjs is the supported upgrade path: apply every stored patch, patch a staged
    build before vendor/ is touched, then re-run the minified-patch guard."""
    script = REVENDOR.read_text(encoding="utf-8")
    assert "source-patches" in script
    assert "[copy, '--check']" in script
    assert "tests/test_openfilm_studio_ui_patch.py" in script
    assert "process.env.OPENFILM_STUDIO_DIST" in PATCH_SCRIPT.read_text(encoding="utf-8")


def test_vendored_host_carries_the_chrome_fallback() -> None:
    host = (REPO_ROOT / "vendor" / "openfilm" / "src" / "host.mjs").read_text(encoding="utf-8")
    assert "OPENFILM_CHROME_CHANNEL" in host
    assert "Executable doesn't exist" in host


def test_vendor_ships_runtime_without_upstream_tests() -> None:
    """revendor copies upstream's src/ and studio/server/ wholesale; their unit tests and
    tsconfig sit next to the runtime upstream but are not part of what ships."""
    roots = [
        REPO_ROOT / "vendor" / "openfilm" / "src",
        REPO_ROOT / "vendor" / "openfilm" / "studio" / "server",
    ]
    stray = [
        path.relative_to(REPO_ROOT).as_posix()
        for root in roots
        for path in root.rglob("*")
        if path.is_file() and (path.name.endswith(".test.mjs") or path.name == "tsconfig.json")
    ]
    assert stray == []


def test_index_html_loads_the_patched_chunk() -> None:
    source, patched = _chunk_names()
    html = (DIST / "index.html").read_text(encoding="utf-8")
    assert f"/assets/{patched}" in html
    assert f"/assets/{source}" not in html, "the unpatched chunk is still referenced"


def test_desktop_download_promo_is_disabled(chunk: str) -> None:
    """The chip sells OpenFilm's own desktop app; Dramaclaw is the host."""
    assert 'r("desktop.title")' in chunk, "the promo markup moved — re-derive the anchor"
    assert '!Et&&a.jsx(on,{label:r("desktop.title")' not in chunk


def test_brand_mark_replaced_by_settings_gear(chunk: str) -> None:
    assert '"aria-label":"OpenFilm"' not in chunk
    assert 'viewBox:"0 0 24 24",fill:"none",stroke:"currentColor"' in chunk


def test_asset_download_saves_instead_of_navigating(chunk: str) -> None:
    """Media lives on the film origin, so a plain <a download> navigates the editor
    into the browser's video viewer instead of saving."""
    assert "URL.createObjectURL(await r.blob())" in chunk
    anchor = re.search(r'\{href:t,download:e\.name[^}]{0,80}', chunk)
    assert anchor and "onClick" in anchor.group(0), "download anchor lost its click handler"


def test_only_one_patched_chunk_ships() -> None:
    """The chunk is served `immutable`, so every patch round has to ship under a new
    name — and the superseded ones have to go, or index.html and the stale file drift."""
    _, patched = _chunk_names()
    shipped = [
        path.name
        for path in (DIST / "assets").glob("index-*.dramaclaw*.js")
    ]
    assert shipped == [patched], f"stale patched chunks are still vendored: {shipped}"


def test_the_patch_script_names_the_vendored_build() -> None:
    """SOURCE_CHUNK spent rounds naming a bundle the dist never shipped (index-0psln3pX.js against a
    vendored index-D1xgKltC.js), so the script patched a file that was not in vendor/ and a fresh
    clone loaded the stock editor: its own title, its own favicon, its own wordmark. Both names have
    to come from the one build, and that build has to be what the dist actually holds."""
    source, patched = _chunk_names()
    stem = source[: -len(".js")]
    assert patched.startswith(f"{stem}.dramaclaw") and patched.endswith(".js"), (
        f"{patched} is not {source} patched — the two constants name different builds"
    )
    ships = sorted(path.name for path in (DIST / "assets").glob("index-*.js"))
    assert ships == [patched], f"the dist ships {ships}, this script writes {patched}"


def test_host_language_wins_over_browser_guessing(chunk: str) -> None:
    """A cross-site iframe gets a reduced `navigator.languages` (Chrome hands back the
    alternative locale), so auto-detection resolves to English inside the embed. The
    host states the language instead; a manual pick in the editor still outranks it."""
    assert 'function Pk(){' in chunk, "language resolver moved — re-derive the anchor"
    assert 'const q=new URLSearchParams(location.search).get("lang")' in chunk


def test_host_language_survives_the_editors_own_navigation(chunk: str) -> None:
    """Studio rewrites its own address on every in-editor navigation (keepKey). Keeping only
    hostBack and its label dropped the host's ?lang=, so the next reload fell back to browser
    guessing and the embed came back English."""
    assert 'for(const i of["hostBack","hostBackLabel","lang"])' in chunk, (
        "keepKey no longer preserves the host language"
    )
    patch = (
        SOURCE_PATCHES / "0002-app-keep-host-back.patch"
    ).read_text(encoding="utf-8")
    assert "for (const name of ['hostBack', 'hostBackLabel', 'lang'])" in patch, (
        "the stored App.tsx patch would drop lang on revendor"
    )


def test_failed_project_sends_the_user_back_to_the_canvas(chunk: str) -> None:
    """The error screen used to render a Projects button that walked the user into
    Studio's own project list, with no toolbar and therefore no way back."""
    dead_end = 'onClick:s,className:"rounded-lg border border-[var(--border)] px-3 py-1.5 hover:bg-[var(--bg-hover)]",children:r("nav.projects")'
    assert dead_end not in chunk, "the project-list dead end is reachable again"
    assert 'if(x){const _q=new URLSearchParams(location.search),_b=_q.get("hostBack")' in chunk


def test_project_gone_sends_the_user_back_to_the_canvas(chunk: str) -> None:
    """onLeave is how the project panel reports a vanished film: standalone it navigates
    to "/" and the router then auto-opens the first project it finds. Inside the embed
    that is a different user's cut, so the host has to take the user back instead."""
    assert 'i=()=>{Wu?Wu.report({gone:!0}):s("/",!0)}' not in chunk
    assert 'i=()=>{if(Wu){Wu.report({gone:!0});return}' in chunk


def test_embed_loading_splash_drops_openfilm_mark_and_copy(chunk: str) -> None:
    """The boot splash is OpenFilm's own loading screen — its wordmark plus 「正在打开
    项目」 wording — and it paints after the host's loading surface is gone, so a refresh
    flashes another product. In the embed only the neutral bar is left for the film fetch."""
    assert 'function ME({labelKey:e}){const t=Be();' in chunk, "loading splash moved — re-derive the anchor"
    assert 'function ME({labelKey:e}){const t=Be();const _h=' in chunk
    assert '!_h&&a.jsx("span",{className:"text-[var(--text)]",children:a.jsx(z0,{size:34})})' in chunk
    assert '!_h&&e?a.jsx("p"' in chunk


def _catalogue_ranges() -> list[tuple[str, str, str]]:
    """The i18n catalogues, as the patch script locates them: (lang, start anchor, end anchor)."""
    script = PATCH_SCRIPT.read_text(encoding="utf-8")
    found = re.findall(
        r"\{ lang: '([\w-]+)', start: '(.+?)', end: '(.+?)' \}",
        script,
    )
    assert found, "patch script lost its CATALOGUES table"
    return found


@pytest.mark.parametrize(
    ("lang", "start", "end"),
    _catalogue_ranges(),
    ids=[case[0] for case in _catalogue_ranges()],
)
def test_catalogue_copy_never_names_the_vendored_product(
    chunk: str, lang: str, start: str, end: str
) -> None:
    """Every string the editor shows its user comes from one of these five catalogues. The
    sweep renames the vendored product to Dramaclaw (虾画 in Chinese) inside them; the exact
    strings the sweep cannot judge — package names, class names, URLs, release notes — stay
    outside."""
    from_index = chunk.index(start)
    to_index = chunk.index(end, from_index)
    segment = chunk[from_index:to_index]
    for token in ("OpenFilm", "Studio"):
        stray = re.search(rf"(?<![A-Za-z0-9_]){token}(?![A-Za-z0-9_])", segment)
        assert not stray, f"{lang} catalogue still shows {token}: {segment[max(0, stray.start()-60):stray.start()+60]!r}"


def test_copy_overrides_replace_foreign_instructions(chunk: str) -> None:
    """Two strings told the user to run a terminal command or click the OpenFilm logo — the
    embed has neither, so the sweep alone would leave a sentence pointing at nothing."""
    assert "Run this in a terminal" not in chunk
    assert "the OpenFilm logo at the top left" not in chunk
    assert "（左上角的 OpenFilm 标志）" not in chunk
    assert "在终端运行下面这条命令" not in chunk
    assert "Dramaclaw has stopped" in chunk
    assert "虾画已停止运行" in chunk
    assert "请在设置 → 服务商中连接一个翻译服务" in chunk


def test_embed_hides_settings_footer_links(chunk: str) -> None:
    """The settings sidebar footer links to the upstream repo, its examples repo and its
    website — all three walk an embedded user out to OpenFilm."""
    assert 'children:P$.map(E=>a.jsx("a",{href:E.href' not in chunk
    assert 'children:!new URLSearchParams(location.search).get("hostBack")&&P$.map(E=>a.jsx("a",{href:E.href' in chunk


def test_embed_hides_about_and_update_row(chunk: str) -> None:
    """About shows the vendored editor's own version and a 检查更新 button that would update
    it; neither is a Dramaclaw concept."""
    assert 'Et?.update?.onState?a.jsx(K$,{}):a.jsx(U$,{})' not in chunk
    assert 'Et?.update?.onState?a.jsx(K$,{}):new URLSearchParams(location.search).get("hostBack")?null:a.jsx(U$,{})' in chunk


def test_embed_never_opens_the_whats_new_dialog(chunk: str) -> None:
    """The dialog prints upstream release notes under the vendored version number and its
    footer links to OpenFilm's GitHub releases."""
    assert '!s||typeof document>"u")return null;if(new URLSearchParams(location.search).get("hostBack"))return null;' in chunk


def test_embed_does_not_offer_the_studio_start_command(chunk: str) -> None:
    """When the editor loses its server it offers `openfilm open` to copy into a terminal;
    a Dramaclaw user has no terminal and no such command."""
    assert 'i&&!Et?a.jsx("button",{type:"button",onClick:()=>{navigator.clipboard?.writeText(l)' not in chunk
    assert 'i&&!Et&&!new URLSearchParams(location.search).get("hostBack")?a.jsx("button"' in chunk


def test_shortcut_scheme_label_follows_the_ui_language(chunk: str) -> None:
    """Settings → Keyboard shortcuts names the keymap after the vendored product."""
    assert 'openfilm:"OpenFilm"' not in chunk
    assert 'openfilm:v0()==="zh-CN"?"虾画":"Dramaclaw"' in chunk


def test_index_html_drops_openfilm_title_and_favicon() -> None:
    """The tab title and the favicon come from the vendored build; a direct link to the
    editor (or a browser that keeps the frame in its history) shows them."""
    html = (DIST / "index.html").read_text(encoding="utf-8")
    assert "OpenFilm" not in html, "the document title or favicon still carries the brand"


def test_embed_hides_the_locked_start_command(chunk: str) -> None:
    """The full-screen "this browser isn't signed in" dialog pairs its explanation with a
    `openfilm open` clipboard button that hands out a keyed localhost address. The host opens
    that address itself, so the embed keeps the explanation and drops the command."""
    assert 'Et?null:a.jsxs("div",{className:"mt-4 flex items-center gap-2 text-[12.5px] text-[var(--text-muted)]",children:[a.jsx("span",{children:e("connection.lockedHow")})' not in chunk
    assert 'Et||new URLSearchParams(location.search).get("hostBack")?null:a.jsxs("div",{className:"mt-4 flex items-center gap-2' in chunk


def _code_brand() -> list[tuple[str, str, int]]:
    """The product names the script renames outside the catalogues."""
    script = PATCH_SCRIPT.read_text(encoding="utf-8")
    found = [
        (find, replace, int(count))
        for _q1, find, _q2, replace, count in re.findall(
            r"""\{ find: (['"])(.+?)\1, replace: (['"])(.+?)\3, count: (\d+) \}""",
            script,
        )
    ]
    assert len(found) >= 8, "patch script lost its CODE_BRAND table"
    return found


@pytest.mark.parametrize(("find", "replace", "count"), _code_brand())
def test_code_strings_name_the_host(chunk: str, find: str, replace: str, count: int) -> None:
    """Fallbacks the fetch helpers throw into a toast, and the labels of the diagnostic report,
    are written in code rather than copy — the catalogue sweep cannot reach them."""
    assert chunk.count(find) == 0, f"{find!r} is still in the shipped bundle"
    assert chunk.count(replace) == count, f"{replace!r} should appear {count} times"


def test_locked_copy_never_asks_for_a_terminal(
    chunk: str,
) -> None:
    """The key-recovery copy told every language to run `openfilm open`; the embed's user has no
    terminal, and the host already passed the key once."""
    for lang, start, end in _catalogue_ranges():
        segment = chunk[chunk.index(start):chunk.index(end, chunk.index(start))]
        assert "openfilm open" not in segment, f"{lang} still tells users to run a command"
    assert "请回到虾画画布" in chunk
    assert "Go back to the Dramaclaw canvas" in chunk


def test_zh_copy_is_not_space_padded(chunk: str) -> None:
    """Upstream padded its Latin wordmark with spaces, which is right around a foreign word and a
    typo around 虾画."""
    start, end = "pz={nav:{", "cx=["
    segment = chunk[chunk.index(start):chunk.index(end, chunk.index(start))]
    stray = re.search(r"[\u3000-\u9fff] 虾画|虾画 [\u3000-\u9fff]", segment)
    if stray:
        pytest.fail(
            f"space-padded brand: {segment[max(0, stray.start() - 40):stray.start() + 40]!r}"
        )
