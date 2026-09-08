# HTML webpage artifacts

Freezone stores one project-scoped webpage identity with immutable source revisions. The existing director uses `freezone_html_artifact` to create, read, update, list, inspect history, or restore a page. Create/update/restore use the existing canvas confirmation bridge. Source reads are data, never executable canvas command envelopes.

A successful creation produces a canvas node and an openable chat result card. Both reference the same artifact. Normal revisions update that identity; explicit alternatives use create. Optional `reference_node_ids` preserve source relationships as derived-from edges. The editor occupies the canvas content region while retaining the existing director dock.

## Editing and delivery

- Desktop/mobile saved-version preview; HTML source and title editing.
- Explicit save with `base_version`; conflicting writes return HTTP 409 and preserve the draft.
- In-app navigation preserves source drafts in memory. Leaving the browser with unsaved changes triggers its unload guard. This is not durable cross-device draft storage.
- Historical selection previews an existing revision; applying it switches the selected node reference without creating source. Saving an edit creates a new revision and checks the head observed when editing began. The explicit tool restore action still creates a new revision.
- Selected elements appear as removable chat references; selectors/IDs remain transport metadata.
- Export first prepares `freezone/_html_artifacts/<artifact-id>/exports/v<version>.zip` containing `index.html` and referenced project media, then downloads it through the authorized project `/files/` endpoint (including its OSS redirect/fallback behavior). The first successful ZIP for each version is retained and reused; different source versions never overwrite it. ZIPs remain part of project data until project cleanup. Use inline CSS/JS and project-relative or current-project `/api/v1/projects/{id}/media/...` or `/static/...` paths. No arbitrary remote fetches, external scripts/stylesheets, srcset, CSS imports or backend/npm runtime. Unsupported export dependencies fail explicitly; preview reports omitted dependencies.

## Preview isolation

The default preview runs only a nonce-authorized element-selection bridge in an opaque-origin sandbox. Authored scripts/event handlers are disabled. Project media is validated into a same-project resource manifest. The application fetches each resource with its authenticated API client and passes Blob URLs to the isolated frame; the generated frame receives no app credentials. URLs are revoked when the preview is replaced or unmounted.

Interactive script execution is an explicit per-artifact-version choice. It requires browser support for credentialless iframes, remounts the frame when switching modes, and is revoked before rendering a different revision. Interactive code may navigate or transmit its embedded page contents to external sites: CSP does not prevent all script-driven self-navigation. This limitation is disclosed beside the control. Unsupported browsers retain static preview, selection and source editing.

Preview source is bounded at 2 MiB and expanded output at 16 MiB. Resource export is capped at 100 MiB. The 16 MiB preview bound applies to generated markup and inline data, not fetched project media. Project videos still download in full into browser memory; this is not streaming playback. CSP denies connect/frame/object/form operations and limits passive media to data and Blob URLs.

## Persistence and deployment

Routes: `/api/v1/projects/{project}/freezone/html-artifacts`. Reads/export use viewer access; writes use editor access. All retain the existing home-node guard. Immutable source files live in `freezone/_html_artifacts/<artifact-id>/<uuid>.html`; `<version>.json` records metadata, project binding and checksum. Metadata publishes last under the existing canvas mutex port with lease reassertion. Node generation history lives in `freezone/_generation_history/<canvas-id>/<node-id>.jsonl`. Include both directories in project backups. No state index or runtime SQLite compatibility is provided; pre-release local data was converted separately. Storage symlinks are rejected and source reads use no-follow descriptors. EE must provide consistent output mount paths and reliable mutex/publication semantics.

CE must explicitly enable the existing director surface using `ST_CE_ENABLE_ASSISTANT_SURFACES=1` and configure its normal model provider to use natural-language generation. HTML API/editor operation does not require a model key. EE uses existing project roles and product-surface policy. Public hosting/sharing and full-stack applications are outside this version.
