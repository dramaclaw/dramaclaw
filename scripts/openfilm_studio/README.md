# OpenFilm Studio — vendoring & upgrades

The 「视频合成与剪辑」 workspace embeds OpenFilm Studio. `vendor/openfilm/` carries only the
runtime: `src/`, `studio/server/`, the **built** `studio/ui/dist/`, `studio/client.mjs`,
`product.json`, `SPEC.md`, `LICENSE`, `THIRD_PARTY_NOTICES.md`. The UI *source* stays upstream;
our edits to it live here as patch files.

Pinned at **OpenFilm v0.2.4, commit `53156ac`** (MIT). The editor ships inside the backend image,
so a user never updates it themselves: `index.html` is served `no-store`, assets are
content-hashed and immutable, and the new build is live on the next page load.

## What lives here

| File | Purpose |
| --- | --- |
| `revendor.mjs` | One-command upgrade: clone → patches → build → patch bundle → install → guards |
| `source-patches/*.patch` | Our eight edits to upstream **source** (embed chrome, film title, export and server-copy branding, the self-update/rename/examples gates) |
| `patch_studio_ui.mjs` | Exact-string patches against the minified bundle (branding, embed-only UI, `hostBack`, language, version history…) |
| `run.mjs` | Launcher the Python backend starts per Studio session |
| `smoke.mjs` | Deployment check the image runs at build time: Chromium launches, Studio boots, the patched chunk is served, and a film actually paints with no vendored brand on screen |

`source-patches/` is the source of truth for source-level changes; `patch_studio_ui.mjs` is the
source of truth for everything done to the compiled bundle. Never hand-edit the vendored runtime:
a re-vendor would drop the edit. The exceptions are ours, not upstream's — `vendor/openfilm/README.md`
and the install shim (`package.json` / `package-lock.json`, which pin `playwright-core`); revendor
rewrites their version fields for you.

## Upgrading

```bash
node scripts/openfilm_studio/revendor.mjs --ref v0.2.5
```

Options: `--from <checkout>` reuse a clean upstream checkout (keeps `node_modules` between
attempts; reset it with `git checkout -- .` first, since revendor applies the patches itself),
`--keep` keep the working copy for debugging, `--no-tests` skip the pytest guards, `--repo <url>`
use a fork.

The first four steps run against a staged copy; a failure there leaves `vendor/` untouched. The
install step itself restores the previous tree if a copy dies halfway:

1. clone `--ref` (tag, branch or commit), apply every `source-patches/*.patch`;
2. `pnpm install --frozen-lockfile` (via corepack) and `pnpm --filter openfilm build:ui`;
3. take the new stock chunk name, bump `PATCHED_CHUNK` to the next `dramaclawN`;
4. patch a **staged** copy and run `patch_studio_ui.mjs --check` on it;
5. install `src/`, `studio/server/`, `studio/ui/dist/` and the licence/product files into
   `vendor/openfilm/`; then rewrite `SOURCE_CHUNK`/`PATCHED_CHUNK` in `patch_studio_ui.mjs`, the
   version pin in `vendor/openfilm/README.md`, and the version fields of `package.json` and the
   lockfile's root entry;
6. run `patch_studio_ui.mjs --check` against the installed copy and the pytest guards.

Then run `npm install --omit=dev` in `vendor/openfilm/` only if `package.json` dependencies
changed (the pin is `playwright-core`; Studio falls back to a system Chrome when Playwright's
browser is absent), and rebuild the API image — its build runs `smoke.mjs`, which is what proves
the upgraded tree actually serves.

### When a step fails

- **A source patch no longer applies** — upstream changed those lines. Re-derive the edit against
  the new `packages/openfilm/...` source, regenerate that one file with
  `git diff -- <file> > scripts/openfilm_studio/source-patches/000N-....patch`, re-run.
- **A minified anchor moved** — the error names the patch id and the staged chunk. Search the
  staged chunk for the nearest stable string (the same component/function name, a nearby i18n
  key), rewrite that patch's `find`/`replace`, keep the `count` assertion, and re-run with
  `--from` so the rebuild is quick. Do not guess; a wrong anchor that matches once is worse than
  a failure.
- **The patch script is idempotent on an already-patched chunk.** If you only change anchors,
  re-run `revendor.mjs` against a build — editing the patch script alone will not change the
  installed bundle, because the stock chunk is deleted after the first patch.
- If you ever change the patched output by hand, bump the `dramaclawN` round: `/assets/*` is
  immutable, so reusing a name leaves returning browsers on the old bundle.

## Acceptance checklist after an upgrade

- `uv run pytest tests/test_openfilm_studio_ui_patch.py -q` and
  `uv run pytest tests/test_freezone_studio_film.py tests/test_api_freezone_compose_studio.py -q`
- `cd frontend && npx tsc -b && npx vitest run src/__tests__/features` (compose workspace,
  timeline model, selection attachment)
- Open a compose node at **1550 / 1920 / 2300** wide: five panels fit, chat dock defaults to
  420–500px, titlebar and chat header share one 44px baseline.
- Embed only: no OpenFilm name/logo/link anywhere (top bar, settings, splash, error screens),
  UI follows the host language, ← returns to the canvas, Download saves files, version history
  and the developer release notes are absent, and reloading never shows OpenFilm's own splash.
- Stage the vendor rename first, then `uv run python scripts/compliance/generate_p0b_artifacts.py`:
  the license台账 lists vendored files from `git ls-files`, so a renamed chunk otherwise leaves
  the previous `*.dramaclawN.js` behind in `license-inventory.csv`.

## Deployment note

The API image (`Dockerfile`) ships this runtime: Node 22, `vendor/openfilm/` with `node_modules`
installed from the vendored lockfile, `scripts/openfilm_studio/`, Playwright's headless Chromium
under `/ms-playwright`, and Noto CJK fonts. The build ends with `node
scripts/openfilm_studio/smoke.mjs`, which launches Chromium, boots `run.mjs` and checks that the
served index loads a `*.dramaclawN.js` chunk with the embed back navigation.

`PLAYWRIGHT_BROWSERS_PATH` is set in the image **and** passed through by
`freezone/studio.py` (`_STUDIO_ENV_PASSTHROUGH`); the spawned Studio inherits only that list, so
adding a browser path or Chrome channel there without the passthrough makes it look in
`$HOME/.cache` and miss the installed browser.

## Not ready for remote users yet

The Studio is reachable from the **browser**, not only from the backend: `studio_open_url` hands
the frame `{origin}/open?key=…`, so the iframe loads that origin directly. Today `run.mjs` binds
`127.0.0.1` (`freezone/studio.py` starts it there), one key serves the whole container
(`SUPERTALE_OPENFILM_STUDIO_KEY`, else `secrets.token_hex(24)`), and nothing in the image proxies
it. So a user on another machine cannot open the editor at all, and the frame-level UI suppression
(a `hostBack` query parameter) is not a security boundary — anyone holding the key can load the
stock routes.

Do not solve this by putting the Studio behind the app's reverse proxy as-is. Its API takes
`POST /api/projects {path: "<absolute path>"}` and reads/writes that folder, so one shared
public route hands every tenant the whole machine's filesystem, and one key means one shared
editor. What it needs instead, per deployment:

1. one Studio process per user (or per tenant) with its own `OPENFILM_HOME`, its own key and its
   own port, spawned by `studio.py` as it already does;
2. a proxy route that forwards only that user's Studio, authenticated by the *host's* session
   cookie — not by the studio key in a URL, which lands in browser history and server logs;
3. the vendored server's absolute-path project route closed or jailed to the tenant's home
   (a source patch, so it belongs in `source-patches/` and survives an upgrade).

Until those land, treat 「视频合成与剪辑」 as a local/single-tenant feature and say so when someone
reports "编辑器打不开" on a hosted deployment.

The product therefore keeps the legacy timeline editor by default. Set
`SUPERTALE_OPENFILM_STUDIO_ENABLED=1` on the DramaClaw API process only for a local or otherwise
co-located browser deployment to expose the Studio workspace. The flag is delivered through the
runtime config endpoint, so changing it does not require rebuilding the frontend bundle.
