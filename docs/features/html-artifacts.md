# HTML webpage artifacts

Freezone stores one project-scoped webpage identity with immutable source revisions. The existing director uses `freezone_html_artifact` to create, read, update, list, inspect history, or restore a page. Create/update/restore use the existing canvas confirmation bridge. Source reads are data, never executable canvas command envelopes.

A successful creation produces a canvas node and an openable chat result card. Both reference the same artifact. Normal revisions update that identity; explicit alternatives use create. Optional `reference_node_ids` preserve source relationships as derived-from edges. The editor occupies the canvas content region while retaining the existing director dock.

## Editing and delivery

- Desktop/mobile saved-version preview; HTML source and title editing.
- Explicit save with `base_version`; conflicting writes return HTTP 409 and preserve the draft.
- In-app navigation preserves source drafts in memory. Leaving the browser with unsaved changes triggers its unload guard. This is not durable cross-device draft storage.
- Historical revision selection and restore create a new revision rather than modifying history.
- Selected elements appear as removable chat references; selectors/IDs remain transport metadata.
- Export downloads a ZIP with `index.html` and referenced project media. Use inline CSS/JS and project-relative or current-project `/api/v1/projects/{id}/media/...` or `/static/...` paths. No arbitrary remote fetches, external scripts/stylesheets, srcset, CSS imports or backend/npm runtime. Unsupported export dependencies fail explicitly; preview reports omitted dependencies.

## Preview isolation

The default preview runs only a nonce-authorized element-selection bridge in an opaque-origin sandbox. Authored scripts/event handlers are disabled. Project media is resolved with project authorization and embedded as data URLs; the generated frame receives no app credentials.

Interactive script execution is an explicit per-artifact-version choice. It requires browser support for credentialless iframes, remounts the frame when switching modes, and is revoked before rendering a different revision. Interactive code may navigate or transmit its embedded page contents to external sites: CSP does not prevent all script-driven self-navigation. This limitation is disclosed beside the control. Unsupported browsers retain static preview, selection and source editing.

Preview source is bounded at 2 MiB and expanded output at 16 MiB. Resource export is capped at 100 MiB. CSP denies connect/frame/object/form operations and limits passive media to data URLs.

## Persistence and deployment

Routes: `/api/v1/projects/{project}/freezone/html-artifacts`. Reads/export use viewer access; writes use editor access. All retain the existing home-node guard. SQLite uses immutable revisions, `BEGIN IMMEDIATE`, atomic commits and a verified project binding. Storage symlinks are rejected; project media is read through no-follow directory descriptors. Include `freezone/_html_artifacts/artifacts.sqlite3` in project backups. No schema migration or additional dependency is required.

CE must explicitly enable the existing director surface using `ST_CE_ENABLE_ASSISTANT_SURFACES=1` and configure its normal model provider to use natural-language generation. HTML API/editor operation does not require a model key. EE uses existing project roles and product-surface policy. Public hosting/sharing and full-stack applications are outside this version.
