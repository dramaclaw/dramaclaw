# HTML Artifacts Implementation Plan

> **For agentic workers:** Use subagent-driven-development for bounded implementation and review. User approved execution on a new staging branch.

**Goal:** Project-scoped, versioned HTML artifacts created/edited by the existing Freezone director, represented as canvas nodes and chat result cards, opened in a large editor retaining the director dock.

**Architecture:** One durable artifact identity referenced by canvas and chat. REST manages immutable HTML revisions with optimistic concurrency and project authorization. A sandboxed preview and source editor share these revisions. Existing frontend canvas tool bridge and Hermes tools expose CRUD/version operations.

**Tech Stack:** FastAPI/Python 3.11, React/TypeScript, existing canvas/ky/Vitest/pytest; no new runtime dependency.

## Global constraints
- Base local staging d9cd536c (origin/staging 5b7cf6c1 plus staging promo/collage skill commit), no main merge or dirty checkout contents.
- Preserve project ACL and home-node constraints, no credentials exposed to generated HTML.
- Single-page HTML with inline CSS/JS and project media; no backend apps/npm hosting/public publish.
- Same artifact ID for normal revisions; explicit alternatives create new artifacts/nodes.
- Immutable revisions, stale base_version rejected with 409, failures leave last saved version intact.
- Preview scripts run sandboxed without same-origin privileges; restrictive CSP, no app cookies/API access. Untrusted messages cannot execute canvas tools.
- Read DESIGN.md before visual work; existing tokens, i18n conventions, no unrelated refactor.

## Task 1: Durable artifact service and REST
Files: src/novelvideo/freezone/html_artifacts.py, src/novelvideo/api/routes/html_artifacts.py, src/novelvideo/api/__init__.py, tests/test_html_artifacts.py, tests/test_api_html_artifacts.py.
- [x] Write/run failing tests for persistence, project isolation, conflicting writes, recovery, invalid IDs, resource validation and portable export.
- [x] Implement project-local storage with cross-process lock and atomic update; immutable versions.
- [x] Routes prefix /projects/{project}/freezone/html-artifacts: POST create {title,html}; GET list; GET /{id}?version=; PUT /{id} {title,html,base_version}; GET /{id}/versions; POST /{id}/restore {version,base_version}; GET /{id}/export. Artifact response {id,title,version,html,created_at,updated_at}; versions {versions:[{version,title,created_at}]}; list {artifacts:[...metadata]}.
- [x] Enforce existing viewer/editor roles and home-node guard. Export ZIP with project-local referenced images and rewritten paths; refuse unsafe or unsupported references rather than silently broken exports.
- [x] Run focused tests and report exact contract to coordinator.

## Task 2: Canvas HTML node and editor
Files: frontend/src/features/html-artifacts/*, canvas domain/registry/factory, FreezoneShell.tsx, i18n resources; frontend tests.
- [x] Test sandbox generation, selected-element message validation, API conflict handling, editor unsaved state.
- [x] Register htmlArtifactNode carrying artifactId/version/title; preview thumbnail is sandboxed static content, opened preview runs scripts only in isolated frame.
- [x] Editor occupies main content retaining existing dock, desktop/mobile toggle, preview/source, save, versions/restore/export and return canvas.
- [x] Element selection sends artifact/version/element reference into existing director draft; preserve stale/draft warnings.

## Task 3: Director tools and result cards
Files: .hermes/plugins/freezone/__init__.py, frontend canvas tool catalogs/commands/references, superchat result rendering; plugin and frontend tests.
- [x] Expose create/read/update/history/restore via existing authenticated frontend tool bridge. Create also places canvas node; updates refresh existing references.
- [x] Results render an openable artifact card referring to saved artifact, including historical version identity.
- [x] Supply active artifact context and selected element context to existing chat, with source read before update and base version required.

## Task 4: Integration and review
- [x] Run backend service/API/plugin regression tests, frontend focused tests, TypeScript/build, i18n checks.
- [x] Review whole diff for ACL, preview escape, export traversal, version races, canvas persistence and user flow.
- [x] Start separate test services without stopping existing 5173/5174 or 8780; verify UI where feasible.
- [x] Record completed work and limits; leave branch ready for user testing, no push/merge requested.

Verified 2026-09-08: backend 161, frontend 251 passing, TypeScript/build/i18n checks passed. Preview refined to nonce-only static default and explicit credentialless interactive mode bound to artifact revision; see docs/features/html-artifacts.md. Real local tool bridge completed after UI confirmation without a model request.
