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

Use Python 3.11-compatible code and keep imports/package paths rooted in `src/novelvideo`. Follow the existing style: 4-space indentation, type hints for public interfaces and dataclass/Pydantic models, snake_case for functions and modules, PascalCase for classes, and uppercase names for constants. Keep route handlers thin and move reusable behavior into services, ports, or task runners matching nearby modules. Do not commit task outputs, temporary previews, or local runtime state. Approved static images, audio, and video required by the product may be committed under the existing asset conventions.

For the first frontend visual change in a session, read the relevant sections of `DESIGN.md`; reuse that context unless the file changes or the task enters a different design area. It is the source of truth for design tokens and documented scene exceptions. When tokens or documented component specifications change, update the corresponding section and run the design linter once (0 errors; do not increase existing warnings). Pure component fixes do not require unrelated design documentation updates. Derived design-tool context must follow this source, not introduce a competing specification.

## Testing Guidelines

Tests use `pytest` with `pytest-asyncio` set to auto mode. Name test files `test_*.py` and colocate fixtures in `tests/conftest.py` unless they are narrowly scoped. Mark enterprise-only or full end-to-end tests with `@pytest.mark.ee` or `@pytest.mark.e2e` so default runs stay community-edition friendly. Add focused regression tests for API contracts, task lifecycle changes, storage migrations, and provider error handling.

## Commit & Pull Request Guidelines

Recent history uses short conventional prefixes such as `fix:`, `feat(scope):`, `refactor(scope):`, and `chore(scope):`; keep subjects imperative and specific. PRs should describe the user-visible change, list verification commands, link related issues, and include screenshots or sample API output for UI/API contract changes. Note any migration, configuration, model-provider, or compliance impact explicitly.

## Security & Configuration Tips

Do not commit provider keys, signed URLs, credentials, or generated secrets. Configure model access through environment variables such as `MODEL_PROVIDER` and `MODEL_API_KEY`. Run the gitleaks pre-commit hook before sharing changes that touch configuration, provisioning, backup, or gateway code.


## Task Scope, Skills, and Verification

- Treat the commands above as a reference, not a checklist for every task. Read only instructions and references relevant to the requested work; reuse unchanged context and successful checks within a session.
- Use design tools for design exploration, alternatives, or an explicitly requested canvas workflow. Exact CSS sizing/spacing, copy corrections, existing asset swaps, and local UI fixes normally go directly to source code. Session reviews and repository progress use local session/Git evidence, not business pipeline APIs or product documentation by keyword alone.
- For small visual or copy changes, use diff checks and a targeted rendered check when layout is uncertain; do not add tests that only repeat a constant. For behavior changes, run relevant regression tests. Run type/build checks for changes that affect types, imports, integration, or release readiness; use broader suites for shared contracts or cross-module changes. Repeat only after relevant edits, failures, or unresolved concerns.
- Continue low-risk, reversible work already authorized by the user. Do not ask permission to read status, inspect files, make requested edits, or run appropriate checks. Ask only for necessary missing choices or actions beyond the existing scope/authorization.
- Preserve sandbox permissions and explicit approval for destructive/irreversible actions, sensitive data disclosure, credentials, external publishing, permission changes, or additional paid work beyond the authorized provider/scope/budget. Existing authorization is not permission to expand these boundaries.
- Reuse an authorized isolated browser and scoped verification script when practical. Keep audio muted during automated media checks and close browsers started solely for verification. Do not weaken execution permissions to avoid approval prompts.
