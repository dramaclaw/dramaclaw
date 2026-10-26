# OpenFilm Studio (vendored)

OpenFilm v0.2.4, upstream commit `53156ac`, MIT licensed. Only the Studio runtime is
vendored: `src/`, `studio/server/`, the built `studio/ui/dist/`, `product.json`,
`SPEC.md`, `LICENSE`, and `THIRD_PARTY_NOTICES.md`.

Upstream: https://github.com/openfilm/openfilm

## Install

```bash
(cd vendor/openfilm && npm install --omit=dev)
```

`playwright-core` is required at startup. Studio previews work without a browser
build; thumbnails and exports use Playwright's Chromium, falling back to an installed
Google Chrome when Playwright's browser is missing.

## Not everything here is MIT

`studio/ui/dist/assets/inter-*.woff2` are Inter, licensed under the SIL Open Font License 1.1
(see `THIRD_PARTY_NOTICES.md`); this repository keeps the license text at `LICENSES/OFL-1.1.txt`,
and `REUSE.toml` declares those files OFL-1.1 rather than MIT.

## Local patches

These are the only edits to upstream; keep them when refreshing the vendored copy.
The source-level edits are stored as patch files in
`scripts/openfilm_studio/source-patches/` — they apply to the UI source, which is not
vendored, and are compiled into `studio/ui/dist/`.

- `studio/ui/src/components/ProjectView.tsx`: the Layers pane defaults to open, the
  titlebar is 44px tall, and the Projects button becomes an ArrowLeft “back to host”
  action when the page address carries `hostBack` / `hostBackLabel` (the embedded
  Studio is left through the host, not Studio's own project list).
- `studio/ui/src/App.tsx`: `keepKey` preserves `hostBack`, `hostBackLabel` and `lang` so the host's
  back action and its language survive Studio's own navigation.
- The titlebar heading (minified patch `title-is-read-only`): outside the embed it is
  Studio's rename box, and renaming moves the project folder — the id the host finds a
  film by. Embedded it is a plain label; the name comes from the canvas node.
- The project-font prefix (minified patch in `CODE_BRAND`): a chosen project font is
  registered as `“Dramaclaw Project …”`, because the family name is written into every
  film that picks one.
- `src/host.mjs`: when Playwright's browser is not installed, fall back to the system
  Google Chrome (`OPENFILM_CHROME_CHANNEL` overrides the channel) instead of losing
  thumbnails and exports.
- `studio/server/slides.mjs`, `studio/server/fcpxml.mjs`, `studio/server/transcripts.mjs`,
  `studio/server/exports.mjs`, `studio/server/nle.mjs`: exports name Dramaclaw in their
  metadata, roles, lanes and subtitle notes — those files leave the product and are
  opened on someone else's machine.
- `studio/server/projects.mjs`: a project's display name comes from its film's
  `<title>` (the host writes the compose node's name there); the folder is still the
  stable node id, so a reopened cut keeps its film and the header is not a UUID.
- `studio/server/server.mjs` — three routes a hosted editor must never offer, each
  closed by the env `run.mjs` forces:
  `OPENFILM_NO_UPDATE_CHECK` (`POST /api/update`, plus the npm version lookup),
  `OPENFILM_NO_RENAME` (`PATCH /api/projects/:id`, which would orphan the film in the
  folder it renames), and `OPENFILM_NO_EXAMPLES` (the boot lookup and the examples list).
- Server copy and identifiers (patch `0007`): toasts, the diagnostics report name, the
  fetch `user-agent`s and the history commit author say Dramaclaw. The embed replaces
  the wordmark with a settings gear, so copy that pointed at “the OpenFilm logo at the
  top left” now points at the gear.

To upgrade, use `node scripts/openfilm_studio/revendor.mjs --ref <tag>` and follow
`scripts/openfilm_studio/README.md`. Do not edit files here by hand.
