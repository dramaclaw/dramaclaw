// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { apiCall } from "./client";

// SuperTale-side canvas storage (`/api/v1/projects/<project_id>/freezone/canvases/*`).
// The wire format is intentionally generic: `{nodes, edges, viewport}`. The
// backend treats the canvas graph as opaque JSON, so node/capability evolutions stay
// client-side until a specific semantic needs indexing.

export interface FreezoneCanvasSummary {
  id: string;
  modified_at: string;
  size: number;
  schema_version?: 2 | number | null;
  canvas_scope?: FreezoneCanvasScope | string | null;
  episode?: number | null;
  beat?: number | null;
  asset_target?: Record<string, unknown> | null;
  revision?: number | null;
  metadata?: Record<string, unknown> | null;
}

export type FreezoneCanvasScope = "default" | "episode" | "beat" | "asset";

export type CanvasSaveSource =
  | "autosave"
  | "manual_save"
  | "manual_clear"
  | "restore"
  | "from_preset"
  | "projection_remove"
  | "import";

export type CanvasBackupStatus = "disabled" | "synced" | "pending" | "failed";

export interface FreezoneCanvasPayload {
  schema_version?: 2;
  canvas_id?: string;
  project_id?: string;
  canvas_scope?: FreezoneCanvasScope;
  owner_principal_type?: "user" | "team";
  owner_principal_id?: string;
  access_model?: "project_role";
  min_project_role?: "viewer" | "editor" | "admin";
  episode?: number | null;
  beat?: number | null;
  asset_target?: Record<string, unknown> | null;
  revision?: number | null;
  base_revision?: number | null;
  /** Idempotency token. Same value on retries of the same save attempt. */
  client_save_id?: string;
  save_source?: CanvasSaveSource;
  /** Only true when the user explicitly cleared the canvas. */
  allow_empty_overwrite?: boolean;
  created_by?: string;
  updated_by?: string;
  created_at?: string;
  updated_at?: string;
  nodes: unknown[];
  edges: unknown[];
  viewport?: unknown;
  /**
   * Free-form sidecar for freezone-specific canvas state that doesn't fit the
   * xyflow node/edge model (shot metadata, future per-canvas settings). The
   * backend treats this as opaque JSON.
   */
  metadata?: Record<string, unknown> | null;
}

export interface FreezoneCanvasSaveResult {
  saved: boolean;
  revision: number;
  updated_at?: string;
  client_save_id?: string;
  backup_status?: CanvasBackupStatus;
}

export type WorkflowRunStatus = "running" | "completed" | "failed" | "cancelled" | "interrupted";
export type WorkflowRunActionStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "blocked"
  | "skipped";
export type WorkflowRunActionPhase =
  | "waiting_dependencies"
  | "waiting_slot"
  | "waiting_capacity"
  | "preparing"
  | "compiling_recipe"
  | "submitting"
  | "generating"
  | "syncing_result"
  | "retrying";

export interface FreezoneWorkflowRunAction {
  node_id: string;
  action: string;
  status: WorkflowRunActionStatus;
  phase?: WorkflowRunActionPhase | null;
  updated_at?: string | null;
  error?: string | null;
  task_key?: string | null;
  task_type?: string | null;
  job_id?: string | null;
  error_category?: string | null;
  error_request_id?: string | null;
  error_fingerprint?: string | null;
  user_error?: string | null;
  retryable?: boolean | null;
  artifact_status?: "valid" | "missing" | "unverified" | "not_required" | null;
  recipe_id?: string | null;
  recipe_version?: string | null;
  generation_attempt_id?: string | null;
  product_operation_id?: string | null;
  retry_count?: number;
}

export interface FreezoneWorkflowRun {
  schema_version: "freezone_workflow_run.v1";
  run_id: string;
  project_id: string;
  canvas_id: string;
  status: WorkflowRunStatus;
  resumable: boolean;
  created_at: string;
  started_at: string;
  updated_at: string;
  completed_at?: string | null;
  runner_id?: string | null;
  lease_expires_at?: string | null;
  actions: FreezoneWorkflowRunAction[];
  metadata?: Record<string, unknown>;
}

export async function createFreezoneWorkflowRun(
  projectId: string,
  canvasId: string,
  actions: Array<{
    node_id: string;
    action: string;
    recipe_id?: string;
    recipe_version?: string;
    generation_attempt_id?: string;
  }>,
  idempotencyKey?: string,
  runnerId?: string,
): Promise<FreezoneWorkflowRun> {
  return await apiCall<FreezoneWorkflowRun>(
    `projects/${encodeURIComponent(projectId)}/freezone/canvases/${encodeURIComponent(canvasId)}/workflow-runs`,
    {
      method: "POST",
      json: {
        actions,
        ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
        ...(runnerId ? { runner_id: runnerId } : {}),
      },
    },
  );
}

export async function updateFreezoneWorkflowRun(
  projectId: string,
  canvasId: string,
  runId: string,
  payload: {
    status?: WorkflowRunStatus;
    action_updates?: Array<{
      node_id: string;
      action: string;
      status: WorkflowRunActionStatus;
      phase?: WorkflowRunActionPhase | null;
      error?: string | null;
      task_key?: string | null;
      task_type?: string | null;
      job_id?: string | null;
      retry_count?: number;
    }>;
    runner_id?: string;
  },
): Promise<FreezoneWorkflowRun> {
  return await apiCall<FreezoneWorkflowRun>(
    `projects/${encodeURIComponent(projectId)}/freezone/canvases/${encodeURIComponent(canvasId)}/workflow-runs/${encodeURIComponent(runId)}`,
    { method: "PATCH", json: payload },
  );
}

const workflowRunsInFlight = new Map<
  string,
  Promise<{ runs: FreezoneWorkflowRun[] }>
>();

export function listFreezoneWorkflowRuns(
  projectId: string,
  canvasId: string,
): Promise<{ runs: FreezoneWorkflowRun[] }> {
  const key = `${projectId}\u0000${canvasId}`;
  const existing = workflowRunsInFlight.get(key);
  if (existing) return existing;

  const request = apiCall<{ runs: FreezoneWorkflowRun[] }>(
    `projects/${encodeURIComponent(projectId)}/freezone/canvases/${encodeURIComponent(
      canvasId,
    )}/workflow-runs`,
  ).finally(() => {
    if (workflowRunsInFlight.get(key) === request) {
      workflowRunsInFlight.delete(key);
    }
  });
  workflowRunsInFlight.set(key, request);
  return request;
}

/**
 * Mint an idempotency token for a single canvas save attempt. Callers should
 * reuse the same id across retries of the same logical save (network blip,
 * 503 canvas_lock_busy) and only generate a new one when fresh local content
 * is being sent — see useCanvasSync for the policy.
 */
export function generateClientSaveId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `save-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export interface FreezonePresetCanvasRequest {
  scope: "episode" | "beat" | "asset" | "blank";
  episode?: number | null;
  beat?: number | null;
  primary_slot?: string;
  asset_kind?: string | null;
  character?: string | null;
  identity_id?: string | null;
  asset_id?: string | null;
  canvas_id?: string | null;
  overwrite_existing?: boolean;
  base_revision?: number | null;
}

export interface FreezonePresetCanvasResponse {
  canvas_id: string;
  reused: boolean;
  url: string;
}

export interface FreezoneProjectionPresetRequest
  extends Omit<FreezonePresetCanvasRequest, "canvas_id" | "overwrite_existing"> {
  projection_key: string;
  base_revision: number;
  force_refresh?: boolean;
}

export interface FreezoneProjectionBuildResponse {
  projection_key: string;
  facts_signature: string;
  nodes: unknown[];
  edges: unknown[];
  metadata?: Record<string, unknown> | null;
}

export interface FreezoneProjectionStatusItem {
  projection_key: string;
  stale: boolean;
  scope?: "episode" | "beat" | "asset" | "blank";
  episode?: number | null;
  beat?: number | null;
  asset_kind?: string | null;
  asset_id?: string | null;
  stored_facts_signature?: string;
  current_facts_signature?: string;
  error?: string;
}

export interface FreezoneProjectionStatusResponse {
  canvas_id: string;
  revision?: number | null;
  projections: FreezoneProjectionStatusItem[];
}

export async function listFreezoneCanvases(
  projectId: string,
  options?: { signal?: AbortSignal },
): Promise<FreezoneCanvasSummary[]> {
  return await apiCall<FreezoneCanvasSummary[]>(
    `projects/${encodeURIComponent(projectId)}/freezone/canvases`,
    options?.signal ? { signal: options.signal } : undefined,
  );
}

export async function getFreezoneCanvas(
  projectId: string,
  canvasId: string,
  options?: { signal?: AbortSignal },
): Promise<FreezoneCanvasPayload> {
  return await apiCall<FreezoneCanvasPayload>(
    `projects/${encodeURIComponent(projectId)}/freezone/canvases/${encodeURIComponent(canvasId)}`,
    options?.signal ? { signal: options.signal } : undefined,
  );
}

export async function putFreezoneCanvas(
  projectId: string,
  canvasId: string,
  payload: FreezoneCanvasPayload,
): Promise<FreezoneCanvasSaveResult> {
  return await apiCall<FreezoneCanvasSaveResult>(
    `projects/${encodeURIComponent(projectId)}/freezone/canvases/${encodeURIComponent(canvasId)}`,
    { method: "PUT", json: payload },
  );
}

export interface CreateBlankFreezoneCanvasRequest {
  canvasId: string;
  name: string;
  creatorUsername?: string | null;
}

export async function createBlankFreezoneCanvas(
  projectId: string,
  payload: CreateBlankFreezoneCanvasRequest,
): Promise<FreezoneCanvasSaveResult> {
  return await putFreezoneCanvas(projectId, payload.canvasId, {
    schema_version: 2,
    canvas_id: payload.canvasId,
    project_id: projectId,
    base_revision: null,
    client_save_id: generateClientSaveId(),
    save_source: "manual_save",
    nodes: [],
    edges: [],
    viewport: null,
    metadata: {
      canvas_origin: "user_created",
      display_name: payload.name,
      creator_username: payload.creatorUsername ?? null,
    },
  });
}

export async function deleteFreezoneCanvas(
  projectId: string,
  canvasId: string,
): Promise<{ deleted: boolean }> {
  return await apiCall<{ deleted: boolean }>(
    `projects/${encodeURIComponent(projectId)}/freezone/canvases/${encodeURIComponent(canvasId)}`,
    { method: "DELETE" },
  );
}

export async function createCanvasFromPreset(
  projectId: string,
  payload: FreezonePresetCanvasRequest,
): Promise<FreezonePresetCanvasResponse> {
  return await apiCall<FreezonePresetCanvasResponse>(
    `projects/${encodeURIComponent(projectId)}/freezone/canvases:from-preset`,
    { method: "POST", json: payload },
  );
}

export async function buildProjectionFromPreset(
  projectId: string,
  payload: FreezoneProjectionPresetRequest,
): Promise<FreezoneProjectionBuildResponse> {
  return await apiCall<FreezoneProjectionBuildResponse>(
    `projects/${encodeURIComponent(projectId)}/freezone/projections:build-from-preset`,
    { method: "POST", json: payload },
  );
}

export async function getProjectionStatuses(
  projectId: string,
  canvasId: string,
  projectionKeys?: string[],
): Promise<FreezoneProjectionStatusResponse> {
  return await apiCall<FreezoneProjectionStatusResponse>(
    `projects/${encodeURIComponent(projectId)}/freezone/canvases/${encodeURIComponent(canvasId)}/projections:status`,
    { method: "POST", json: { projection_keys: projectionKeys ?? null } },
  );
}

/**
 * One entry in the `canvas_history/<canvas_id>/` directory. Backend writes
 * `<timestamp>_rev<n>.json` snapshots before every accepted overwrite (see
 * SuperTale2 spec §3.2). The primary key is whatever string the backend
 * uses to address a single snapshot — restore calls pass it as `history_id`.
 *
 * The exact key name has shifted across backend revisions (seen as `id`,
 * `history_id`, `filename`, `name`), so we accept any of them and let the
 * helper `extractHistoryId` pick the first one that's a string. The `string`
 * index signature keeps `console.log(entry)` honest when the backend adds
 * fields we have not modeled yet.
 *
 * NOTE: the listing / restore endpoints are part of the planned canvas
 * reliability work and may return 404 on environments where the backend
 * change has not landed yet. Callers should treat that as "feature pending"
 * rather than a hard error.
 */
export interface FreezoneCanvasHistoryEntry {
  id?: string;
  history_id?: string;
  filename?: string;
  name?: string;
  revision?: number | null;
  size?: number | null;
  modified_at?: string | null;
  save_source?: string | null;
  updated_by?: string | null;
  [key: string]: unknown;
}

/**
 * Pull the snapshot identifier out of a list-response entry. The current
 * backend returns it as `history_id`; we check the other aliases too so a
 * future field-name shift does not break the panel silently.
 */
export function extractHistoryId(
  entry: FreezoneCanvasHistoryEntry,
): string | null {
  for (const key of ["history_id", "id", "filename", "name"] as const) {
    const value = entry[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return null;
}

export async function listFreezoneCanvasHistory(
  projectId: string,
  canvasId: string,
): Promise<FreezoneCanvasHistoryEntry[]> {
  return await apiCall<FreezoneCanvasHistoryEntry[]>(
    `projects/${encodeURIComponent(projectId)}/freezone/canvases/${encodeURIComponent(canvasId)}/history`,
  );
}

export interface FreezoneCanvasRestoreRequest {
  history_id: string;
  /**
   * Optional optimistic-lock guard. Pass the current revision when restoring
   * from a stale tab; omit (or pass `null`) to force-replace.
   */
  base_revision?: number | null;
}

export async function restoreFreezoneCanvasVersion(
  projectId: string,
  canvasId: string,
  payload: FreezoneCanvasRestoreRequest,
): Promise<FreezoneCanvasSaveResult> {
  return await apiCall<FreezoneCanvasSaveResult>(
    `projects/${encodeURIComponent(projectId)}/freezone/canvases/${encodeURIComponent(canvasId)}/restore`,
    { method: "POST", json: payload },
  );
}
