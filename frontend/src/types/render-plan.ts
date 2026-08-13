// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
export interface PlanEntry {
  mode_key: string;
  rows: number;
  cols: number;
  beat_numbers: number[];
  location: string;
  padding_count: number;
  reasons: string[];
  warnings: string[];
}

export interface RenderPlan {
  plan: PlanEntry[];
  plan_hash: string;
  input_fingerprint: string;
  strategy: "location";
  total_beats: number;
  total_grids: number;
}

/**
 * One fanout entry the backend refused to dispatch because a concurrency lane
 * was full. Present on best-effort ("尽力投递") fanout responses: the backend
 * dispatches until a lane rejects, then stops and reports the remainder here.
 *
 * `reason` mirrors the 429 taxonomy the same limits raise when *nothing* could
 * be dispatched — platform-wide lane / per-channel lane / per-user lane.
 */
export interface RejectedDispatch {
  /** Backend-computed selection scope of the refused entry (opaque to the UI). */
  scope: string;
  reason: "channel" | "platform" | "user";
  limit: number;
  active: number;
}

export interface RenderExecuteResult {
  task_type: "render_plan";
  message: string;
  /** Umbrella planning scope (e.g. `location__…`) — does NOT match any task row. */
  scope: string;
  resolved_grids: PlanEntry[];
  /** One `selected_regen` task id per resolved grid. Track these for completion. */
  task_ids: string[];
  /**
   * Absent (or empty) when every grid was dispatched. Otherwise the tail of
   * `resolved_grids` that hit a lane limit — the fanout loop is ordered and
   * breaks on the first rejection, so the refused entries are exactly
   * `resolved_grids.slice(task_ids.length)` (see TCP-P63).
   */
  rejected?: RejectedDispatch[];
}

export interface RenderPlanStaleError {
  error: "input_stale" | "plan_stale";
  data: {
    new_plan: PlanEntry[];
    new_plan_hash: string;
    new_input_fingerprint: string;
  };
}

export interface RenderPlanFeatureDisabledError {
  error: "feature_disabled";
  data: { reason: string };
}
