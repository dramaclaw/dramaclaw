// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
// Client for the outline confirm route
// (POST /api/v1/projects/{p}/interactive-story-outline/confirm). The route
// answers with the flat interactive-story contract instead of the usual
// `{ok, data}` envelope, so this call opts out of ky's error throwing and
// classifies the response itself; the card then maps codes to i18n messages.

import { apiClient } from "./client";
import type { PendingOutlineStatus } from "@/features/canvas/story/pendingStoryOutline";

export interface InteractiveStoryOutlineConfirmResult {
  ok: true;
  project_id: string;
  canvas_id: string;
  outline_id: string;
  status: PendingOutlineStatus;
  revision: number;
  idempotent?: boolean;
  refresh_canvas: true;
}

export type ConfirmOutlineOutcome =
  | { kind: "confirmed"; result: InteractiveStoryOutlineConfirmResult }
  /** revision_conflict: a newer canvas exists. Refresh and let the user
   * re-review the latest outline before confirming again — do not silently
   * re-attempt against `currentRevision`, the outline content may have changed. */
  | { kind: "stale"; currentRevision: number | null }
  /** outline disappeared or was superseded by a newer agent save. */
  | { kind: "superseded" }
  | { kind: "error"; code: string; message: string };

export interface ConfirmOutlineRequest {
  canvas_id: string;
  outline_id: string;
  status: "confirmed" | "needs_revision";
  base_revision: number;
  idempotency_key: string;
}

interface ContractErrorBody {
  code?: string;
  message?: string;
  current_revision?: number | null;
}

export async function confirmStoryOutline(
  project: string,
  body: ConfirmOutlineRequest,
): Promise<ConfirmOutlineOutcome> {
  let response;
  try {
    response = await apiClient(
      `projects/${encodeURIComponent(project)}/interactive-story-outline/confirm`,
      { method: "POST", json: body, throwHttpErrors: false, retry: 0 },
    );
  } catch (err) {
    // throwHttpErrors:false keeps server rejections off this path; anything
    // reaching here is transport-level (offline, timeout).
    const message = err instanceof Error ? err.message : String(err);
    return { kind: "error", code: "network_error", message };
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (response.ok) {
    const result = payload as InteractiveStoryOutlineConfirmResult | null;
    if (result?.ok === true && typeof result.revision === "number") {
      return { kind: "confirmed", result };
    }
    return {
      kind: "error",
      code: "malformed_response",
      message: `HTTP ${response.status}`,
    };
  }
  const error = (payload ?? {}) as ContractErrorBody;
  if (response.status === 409 && error.code === "revision_conflict") {
    return {
      kind: "stale",
      currentRevision:
        typeof error.current_revision === "number" ? error.current_revision : null,
    };
  }
  if (response.status === 404 && error.code === "outline_not_found") {
    return { kind: "superseded" };
  }
  return {
    kind: "error",
    code: error.code ?? `http_${response.status}`,
    message: error.message ?? `HTTP ${response.status}`,
  };
}
