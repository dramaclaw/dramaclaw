// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
// Read-side projection of the canvas metadata slot written by the agent's
// outline tool (backend contract: `pending_story_outline.v1`, see
// src/novelvideo/interactive_story/models.py). The canvas stays the source of
// truth; this module only parses what `sync.metadata` already carries and
// never writes back through the frontend save path.

export const PENDING_OUTLINE_METADATA_KEY = "pendingStoryOutline";
export const PENDING_OUTLINE_SCHEMA_VERSION = "pending_story_outline.v1";

export type PendingOutlineStatus =
  | "pending"
  | "needs_revision"
  | "confirmed"
  | "linked";

export interface PendingStoryOutline {
  outline_id: string;
  kind: "story" | "ad";
  title: string;
  premise: string;
  plot_summary: string;
  interaction_summary: string;
  endings_summary: string;
  duration_budget_sec: number | null;
  open_questions: string[];
  status: PendingOutlineStatus;
  story_id: string | null;
  updated_at: string;
}

const OUTLINE_KINDS = new Set(["story", "ad"]);
const OUTLINE_STATUSES = new Set([
  "pending",
  "needs_revision",
  "confirmed",
  "linked",
]);

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Fail-soft parse: a malformed or future-version slot renders nothing instead
 * of breaking the canvas, mirroring how other metadata sidecars are treated.
 */
export function parsePendingStoryOutline(
  metadata: Record<string, unknown> | null | undefined,
): PendingStoryOutline | null {
  const raw = metadata?.[PENDING_OUTLINE_METADATA_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (record.schema_version !== PENDING_OUTLINE_SCHEMA_VERSION) return null;
  if (!nonEmptyString(record.outline_id)) return null;
  if (!OUTLINE_KINDS.has(String(record.kind))) return null;
  if (!nonEmptyString(record.title)) return null;
  if (!nonEmptyString(record.premise)) return null;
  if (!nonEmptyString(record.plot_summary)) return null;
  if (!OUTLINE_STATUSES.has(String(record.status))) return null;
  return {
    outline_id: record.outline_id,
    kind: record.kind as "story" | "ad",
    title: record.title,
    premise: record.premise,
    plot_summary: record.plot_summary,
    interaction_summary:
      typeof record.interaction_summary === "string"
        ? record.interaction_summary
        : "",
    endings_summary:
      typeof record.endings_summary === "string" ? record.endings_summary : "",
    duration_budget_sec:
      typeof record.duration_budget_sec === "number" &&
      Number.isFinite(record.duration_budget_sec)
        ? record.duration_budget_sec
        : null,
    open_questions: Array.isArray(record.open_questions)
      ? record.open_questions.filter(
          (item): item is string => typeof item === "string" && item.trim().length > 0,
        )
      : [],
    status: record.status as PendingOutlineStatus,
    story_id: nonEmptyString(record.story_id) ? record.story_id : null,
    updated_at: typeof record.updated_at === "string" ? record.updated_at : "",
  };
}
