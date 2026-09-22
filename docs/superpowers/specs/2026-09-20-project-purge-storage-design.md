# Project purge across CE and EE

## Decision

Use one purge contract on `main` and `staging`, with a storage-specific output cleaner. CE removes local `output`, `state`, and `runtime` trees. EE removes current objects from its configured S3-compatible project-output bucket and removes local `state` and `runtime` trees. The project name remains reserved until every required cleanup succeeds. Version history remains subject to the bucket's existing roughly seven-day retention policy.

The September 17 failure on 3060 was a versioned MinIO bucket mounted through s3fs. `shutil.rmtree` removed visible files but `rmdir` failed with `ENOTEMPTY` on prefixes still exposed by the mount. The current main flow had already written `purged_at`, leaving remaining project data without a normal retry path. Staging renames the three directories before setting `purged_at` and suppresses later `rmtree` errors; this protects local same-name recreation but neither makes the three moves atomic nor gives reliable completion on s3fs.

## Invariants

1. Validate all recorded storage paths against the project's owner, name, organization scope, and configured roots before any destructive operation. Backport staging's ownership checks to main. Reject symlink boundaries and overlapping paths.
2. A project name cannot be reused while cleanup is pending or failed. `purged_at` is written only after all required cleanup is verified. CE's registry row is deleted only then.
3. A failed purge leaves a recoverable deleted project and a retriable operation. Repeating cleanup is safe and never targets data from a newly created project.
4. Purge cannot run alongside another purge or active background task. New task admission is fenced before cleanup, and already active tasks must be stopped. Restore is unavailable during cleanup. General API writes already admitted before the marker still need a separate request-drain mechanism.
5. Success means no current objects under the exact project output prefix and no project-owned local `state` or `runtime` entries. Delete markers and noncurrent versions do not count as current objects; they remain under lifecycle retention.
6. Cleanup failures are surfaced to the API; a successful response is never returned for failed required cleanup.

## Data flow

The shared CE route handles one synchronous purge request at a time. The project registry records a persistent `purge_started_at` and serializes a purge attempt per project with a CE file lock or EE PostgreSQL transaction advisory lock; a failed or interrupted attempt leaves that marker for a later request to resume. A second concurrent request receives an in-progress response and cannot run cleanup. Restore and new project task admission reject a project with that marker, and the project name remains reserved. Before cleanup, the route confirms that existing tasks have stopped; when they have not, it returns a conflict without deleting data. The route verifies ownership, then calls a `ProjectOutputPurger` port. The CE implementation deletes its local output tree with normal filesystem operations. The EE implementation lists and deletes current objects through the S3 API using an exact, trailing-slash project prefix. It processes bounded batches, checks per-object delete errors, and repeats list/delete until a delimiter-free listing has no current keys. It also handles any object whose key equals the project directory marker. It never renames the s3fs path or calls `rmdir` on it.

After output cleanup, the route deletes local `state` and `runtime` paths and performs staging's Codex-thread cleanup where applicable. The home-route cleanup must also succeed or remain explicitly retryable. Only then does the registry finish the purge and release the name. The operation can resume after process termination; already removed files and objects are accepted as success. If a failed operation is retried, it revalidates path ownership and the exact bucket/prefix before deleting anything.

The route rechecks output and local storage just before marking completion. This catches writes that finish during cleanup, but it does not fully close the race with a general API request admitted before `purge_started_at`. Such a request can write after the final check. A project-scoped drain or shared write lock across all mutating API paths is still required before treating this as a complete write fence.

`create_project` must not discard unknown data at a same-name path. It verifies that the destination has no current output objects and no local state/runtime residue before initializing a new project; otherwise it rejects creation for investigation. This replaces staging's `orphaned` rename for an EE S3 mount. CE may remove only files known to belong to its own failed, uncommitted creation; it does not silently remove pre-existing project data.

## EE configuration

The S3 endpoint, bucket, object root prefix, and credentials are explicit EE deployment configuration. EE project creation and purge fail closed if that configuration is missing or the recorded output path cannot be mapped below the configured output root. The model-relay OSS settings are a separate service and must not be reused implicitly. Credentials never enter CE source, audit records, or error responses. The S3 cleaner uses key-only deletes, leaving noncurrent versions to the existing bucket lifecycle rule.

## API and user experience

The purge endpoint returns success only when cleanup and registry finalization have completed. An active competing attempt returns HTTP 409, and a storage failure returns HTTP 500; the deleted project remains in the trash for retry. The UI shows success only on the successful response and lets the user retry a failed request. A completed purge disappears from ordinary project lists, as today.

## Branch and deployment order

Implement the same route contract and CE local cleaner on DramaClaw `main` and `staging`. Implement the matching registry operation and EE S3 cleaner on SuperTale `main` and `staging`, adapting staging-only Codex cleanup and organization storage paths without changing the contract. Deploy the EE code and its explicit S3 configuration together. Existing 3060 rows already marked purged with live data require a separate, audited operations cleanup; ordinary endpoint retry cannot discover them.

## Verification

Cover CE local success and injected file-delete failure; EE paginated listing, partial batch errors, versioned delete markers, empty marker objects, and retry after interruption; storage ownership rejection; concurrent purge/restore/create/task admission; and same-name recreation after verified completion. An integration test against a versioned MinIO bucket must show that current objects disappear while historical versions remain and that the endpoint succeeds even if an s3fs delimiter listing still shows ghost prefixes. Verify both branch pairs with the same contract tests before deployment.
