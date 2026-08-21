# Repository Guidelines

## Project Structure & Module Organization

This repository contains the SuperTale Community Edition backend and video pipeline. Python source lives under `src/novelvideo/`, with major areas such as `api/` for FastAPI routes, `task_backend/` for job execution, `generators/` for media generation, `verification/` for quality gates, `ports/` for interface boundaries, and `assets/` for bundled media. Tests live in `tests/`, with contract tests in `tests/contract/` and port-focused tests in `tests/ports/`. Operational scripts are in `scripts/`, documentation in `docs/`, examples in `examples/`, and compliance artifacts in `docs/compliance/`, `LICENSES/`, and `sbom.spdx.json`.

## Build, Test, and Development Commands

- `uv sync --group dev`: install runtime and development dependencies from `uv.lock`.
- `uv run novelvideo api --port 8780`: start the local REST API.
- `uv run pytest`: run the default test suite; `pyproject.toml` excludes `ee` and `e2e` markers by default.
- `uv run pytest tests/test_api_assets.py`: run a focused test file while iterating.
- `scripts/acceptance/run.sh`: run acceptance checks when validating broader API behavior.
- `pre-commit run --all-files`: run repository hooks, currently including `gitleaks` secret scanning.

## Coding Style & Naming Conventions

Use Python 3.11-compatible code and keep imports/package paths rooted in `src/novelvideo`. Follow the existing style: 4-space indentation, type hints for public interfaces and dataclass/Pydantic models, snake_case for functions and modules, PascalCase for classes, and uppercase names for constants. Keep route handlers thin and move reusable behavior into services, ports, or task runners matching nearby modules. Avoid committing generated media or local runtime state.

For any frontend visual change, read `DESIGN.md` first — it is the source of truth for colors, typography, spacing, radii, elevation, and motion, and mirrors the CSS variables in `frontend/src/index.css`. When those variables change, update `DESIGN.md` in the same commit and keep `npx @google/design.md lint DESIGN.md` at 0 errors.

## Testing Guidelines

Tests use `pytest` with `pytest-asyncio` set to auto mode. Name test files `test_*.py` and colocate fixtures in `tests/conftest.py` unless they are narrowly scoped. Mark enterprise-only or full end-to-end tests with `@pytest.mark.ee` or `@pytest.mark.e2e` so default runs stay community-edition friendly. Add focused regression tests for API contracts, task lifecycle changes, storage migrations, and provider error handling.

## Commit & Pull Request Guidelines

Recent history uses short conventional prefixes such as `fix:`, `feat(scope):`, `refactor(scope):`, and `chore(scope):`; keep subjects imperative and specific. PRs should describe the user-visible change, list verification commands, link related issues, and include screenshots or sample API output for UI/API contract changes. Note any migration, configuration, model-provider, or compliance impact explicitly.

## Security & Configuration Tips

Do not commit provider keys, signed URLs, credentials, or generated secrets. Configure model access through environment variables such as `MODEL_PROVIDER` and `MODEL_API_KEY`. Run the gitleaks pre-commit hook before sharing changes that touch configuration, provisioning, backup, or gateway code.

## Hermes Sandbox & the CE Unsandboxed Fallback

Hermes workers run inside an OS sandbox (`sandbox_wrap.py`): macOS uses the system
`sandbox-exec`; Linux uses `codex-linux-sandbox`, whose default pipeline execs
**bubblewrap** (`bwrap`) — Landlock is only its `--use-legacy-landlock` fallback, which
we do not use. When the sandbox cannot be used the wrapper **fails closed** on
EE/production and **degrades with a loud warning** on single-tenant CE (see below).

How the Linux sandbox ships (the P1① half of **#346**, now done):

- The vendored binaries live at `deploy/sandbox/linux-{amd64,arm64}/codex-linux-sandbox`
  and reach the image via `COPY deploy ./deploy`. The `Dockerfile` then **installs the one
  matching `TARGETARCH` onto `/usr/local/bin`** (where `_wrap_linux` looks it up) and
  installs the `bubblewrap` package. A build-time `--help` smoke proves the ELF loads.
- `codex-linux-sandbox` still needs a **host kernel with unprivileged user namespaces** at
  runtime for `bwrap`; installing the binary does not create that capability.
- **Network:** the Linux profile allows **outbound** (`"network": "enabled"`), matching the macOS
  Seatbelt profile's `(allow network-outbound)`. codex's `"restricted"` mode `--unshare-net`s the
  sandbox — *no* egress — which strangles Hermes's required calls to the project API
  (`DRAMACLAW_API_URL`) and the model gateway, and the `/bin/true` probe cannot see that break.
  The isolation that matters for multi-tenancy is the **filesystem** boundary (a user cannot read or
  write peers' data), which is fully enforced; tightening egress to an allowlist is P1② below.

Two enforcement layers, both driven by the same `_fallback_or_raise` decision:

- **Runtime, per worker** — `_wrap_linux` runs a one-time cached probe (`_sandbox_can_run`:
  `/bin/true` inside a throwaway sandbox). A *missing binary* **or** a *present-but-unusable*
  sandbox (kernel lacks user namespaces) both route through `_fallback_or_raise`.
- **Boot, per container** — `deploy/docker-entrypoint.sh` runs the startup gate
  `deploy/hermes_sandbox_selfcheck.py` before exec-ing the API. Its exit code decides whether
  the container boots at all.

The decision in both places:

- **EE / production** (`SUPERTALE_ENV=production` or `ST_CONTROL_PLANE_DSN` non-empty) — sandbox
  unusable ⇒ **refuse** (raise at runtime; entrypoint refuses to boot). The `SUPERTALE_ALLOW_UNSANDBOXED`
  flag cannot override this.
- **Single-tenant CE** (DSN empty) with `SUPERTALE_ALLOW_UNSANDBOXED=1` — sandbox unusable ⇒
  **degrade**: loud warning, run Hermes unsandboxed rather than lock a self-hoster out on an old
  kernel. Single-tenant has no cross-user data-isolation risk. The four CE compose files set this
  flag as that **degrade valve** (not a blanket "always unsandboxed" — when the sandbox works, it
  is used). CE without the flag still refuses.

`tests/test_compose_ce_unsandboxed_gate.py` and `tests/test_sandbox_linux_probe.py` pin both the
compose contract and the runtime/boot behavior. Do not remove the compose opt-in unless you accept
that CE will fail closed on kernels without unprivileged user namespaces.

Still open in **#346** (P1②): both platforms currently allow **all** outbound. Tighten egress to a
controlled allowlist (project API + model gateway only) — e.g. codex's `--allow-network-for-proxy`
+ a proxy route spec on Linux, and the matching Seatbelt narrowing on macOS — plus a test that a
minimal Hermes API/model call actually completes from inside a real Linux sandbox.
