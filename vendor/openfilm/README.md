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

## Local patches

These are the only edits to upstream; keep them when refreshing the vendored copy.

- `studio/ui/src/components/ProjectView.tsx`: the Layers pane defaults to open, the
  titlebar is 44px tall, and the Projects button becomes an ArrowLeft “back to host”
  action when the page address carries `hostBack` / `hostBackLabel` (the embedded
  Studio is left through the host, not Studio's own project list).
- `studio/ui/src/App.tsx`: `keepKey` preserves `hostBack` and `hostBackLabel` so the
  host's back action survives Studio's own navigation.
- `src/host.mjs`: when Playwright's browser is not installed, fall back to the system
  Google Chrome (`OPENFILM_CHROME_CHANNEL` overrides the channel) instead of losing
  thumbnails and exports.

The UI patches are compiled into `studio/ui/dist/`; rebuild with the upstream source
at the pinned commit if the vendored dist is refreshed.
