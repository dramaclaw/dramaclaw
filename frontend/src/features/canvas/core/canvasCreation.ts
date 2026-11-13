// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { FreezoneCanvasPayload, FreezoneCanvasSummary } from "@/api/canvas";
import type { CanvasEnvironment } from "./environment";
import { MAX_USER_CREATED_CANVASES_PER_PROJECT } from "@/lib/limits";

export type CanvasTranslate = CanvasEnvironment["translate"];

export type CanvasSummaryForDisplay = FreezoneCanvasSummary & {
  displayName?: string;
  displayKind?: CanvasKind;
};

export function isConflictCopyCanvas(item: FreezoneCanvasSummary): boolean {
  return item.metadata?.canvas_origin === "conflict_copy" || item.id.startsWith("copy_") || item.id.includes("_copy_");
}

export function isUserCreatedCanvas(item: FreezoneCanvasSummary): boolean {
  return item.metadata?.canvas_origin === "user_created";
}

export type CanvasKind =
  | "default"
  | "episode"
  | "beat"
  | "personal"
  | "asset"
  | "workflow"
  | "blank"
  | "other";

export function canvasKindFromSummary(item: CanvasSummaryForDisplay): CanvasKind {
  const displayKind = item.displayKind;
  if (displayKind) return displayKind;
  if (isUserCreatedCanvas(item)) return "blank";
  const metadata = item.metadata ?? {};
  if (metadata.free_workflow && typeof metadata.free_workflow === "object") {
    return "workflow";
  }
  const preset = metadata.preset as { scope?: unknown } | undefined;
  const scope =
    typeof item.canvas_scope === "string"
      ? item.canvas_scope
      : typeof preset?.scope === "string"
        ? preset.scope
        : item.id === "default"
          ? "default"
          : "";
  if (scope === "default") return "default";
  if (scope === "episode") return "episode";
  if (scope === "beat") return "beat";
  if (scope === "asset") return "asset";
  if (scope === "blank") return "blank";
  return "other";
}

function metadataString(item: FreezoneCanvasSummary, key: string): string | null {
  const value = item.metadata?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function rawDisplayNameFromSummary(item: FreezoneCanvasSummary): string | null {
  return metadataString(item, "display_name");
}

function creatorUsernameFromSummary(item: FreezoneCanvasSummary): string | null {
  return metadataString(item, "creator_username");
}

export function displayNameForCanvasSummary(item: CanvasSummaryForDisplay, t: CanvasTranslate): string {
  const rawDisplayName = rawDisplayNameFromSummary(item);
  if (rawDisplayName) {
    const creator = creatorUsernameFromSummary(item);
    return creator ? t("freezone.canvases.userCreatedName", { user: creator, name: rawDisplayName }) : rawDisplayName;
  }
  return item.displayName ?? describeCanvasSummary(item, t);
}

function normalizeCanvasName(value: string): string {
  // The same name must fold the same way in the browser and in Node.
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function compareCanvasName(item: FreezoneCanvasSummary, name: string, t: CanvasTranslate): boolean {
  const normalized = normalizeCanvasName(name);
  if (!normalized) return false;
  const rawDisplayName = rawDisplayNameFromSummary(item);
  if (rawDisplayName && normalizeCanvasName(rawDisplayName) === normalized) return true;
  return normalizeCanvasName(describeCanvasSummary(item, t)) === normalized;
}

export function findDuplicateCanvasName(
  items: FreezoneCanvasSummary[],
  name: string,
  t: CanvasTranslate,
): FreezoneCanvasSummary | null {
  return items.find((item) => compareCanvasName(item, name, t)) ?? null;
}

/**
 * Count only this creator's user-created blank canvases in the project.
 * System preset and personal canvases do not use the quota.
 * Legacy canvases without a creator belong to the anonymous bucket (null),
 * so missing metadata cannot bypass the anonymous creator's quota.
 */
export function countCanvasesCreatedBy(
  items: FreezoneCanvasSummary[],
  username?: string | null,
): number {
  const owner = username?.trim() || null;
  return items.filter(
    (item) => isUserCreatedCanvas(item) && creatorUsernameFromSummary(item) === owner,
  ).length;
}

/** Unknown means prerequisites are missing, so it must never be treated as available. */
export type CanvasQuotaStatus = "unknown" | "available" | "reached";

/**
 * Missing lists or unrestored identities mean unknown, never permission to create:
 * the backend does not enforce this quota, and anonymous saves lose attribution.
 * The anonymous bucket must not block a signed-in creator for legacy canvases.
 */
export function canvasCreationQuotaStatus(
  items: FreezoneCanvasSummary[] | null | undefined,
  username?: string | null,
): CanvasQuotaStatus {
  return canvasCreationQuota(items, username).status;
}

export function userCreatedCanvasId(name: string, username?: string | null): string {
  const base = `${username?.trim() || "user"}:${name.trim()}`;
  // The same name must fold the same way in the browser and in Node.
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 32) || "canvas";
  return `canvas_${slug}_${stableCanvasIdHash(base)}`.slice(0, 64).replace(/_+$/g, "");
}

export function stableCanvasIdHash(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function describeCanvasSummary(item: FreezoneCanvasSummary, t: CanvasTranslate): string {
  const metadata = item.metadata ?? {};
  if (isConflictCopyCanvas(item)) return t("freezone.canvases.conflictCopy");
  if (metadata.free_workflow && typeof metadata.free_workflow === "object") {
    const source = (metadata.free_workflow as { source_preset?: unknown }).source_preset as
      | { scope?: unknown; episode?: unknown; beat?: unknown; asset_kind?: unknown; asset_id?: unknown }
      | null
      | undefined;
    if (source?.scope === "beat") {
      return t("freezone.canvases.description.freeWorkflowBeat", {
        episode: source.episode ?? "?",
        beat: source.beat ?? "?",
      });
    }
    if (source?.scope === "asset") {
      return t("freezone.canvases.description.freeWorkflowAsset", {
        asset: source.asset_id ?? source.asset_kind ?? t("freezone.canvases.description.assetFallback"),
      });
    }
    return t("freezone.canvases.description.freeWorkflow");
  }
  const preset = metadata.preset as
    | {
        scope?: unknown;
        episode?: unknown;
        beat?: unknown;
        primary_slot?: unknown;
        asset_kind?: unknown;
        character?: unknown;
        identity_id?: unknown;
        asset_id?: unknown;
      }
    | undefined;
  const scope =
    typeof item.canvas_scope === "string"
      ? item.canvas_scope
      : typeof preset?.scope === "string"
        ? preset.scope
        : item.id === "default"
          ? "default"
          : "";

  if (scope === "default") return t("freezone.canvases.description.default");
  if (scope === "episode") {
    const episode =
      typeof item.episode === "number"
        ? item.episode
        : typeof preset?.episode === "number"
          ? preset.episode
          : null;
    return episode !== null
      ? t("freezone.canvases.description.episode", { episode })
      : t("freezone.canvases.description.episodeUnknown");
  }
  if (scope === "beat") {
    const episode =
      typeof item.episode === "number"
        ? item.episode
        : typeof preset?.episode === "number"
          ? preset.episode
          : null;
    const beat =
      typeof item.beat === "number"
        ? item.beat
        : typeof preset?.beat === "number"
          ? preset.beat
          : null;
    const slot = typeof preset?.primary_slot === "string" ? ` · ${preset.primary_slot}` : "";
    return t("freezone.canvases.description.beat", {
      episode: episode ?? "?",
      beat: beat ?? "?",
      slot,
    });
  }
  if (scope === "asset") {
    const kind =
      typeof preset?.asset_kind === "string"
        ? preset.asset_kind
        : t("freezone.canvases.description.assetFallback");
    const character = typeof preset?.character === "string" ? preset.character : "";
    const identityId = typeof preset?.identity_id === "string" ? preset.identity_id : "";
    const assetId = typeof preset?.asset_id === "string" ? preset.asset_id : "";
    const name = character || identityId || assetId;
    return name
      ? t("freezone.canvases.description.asset", { name, kind })
      : t("freezone.canvases.description.assetUnknown", { kind });
  }
  if (scope === "blank") return t("freezone.canvases.description.blank");
  return item.id;
}

export function canvasCreationQuota(
  items: FreezoneCanvasSummary[] | null | undefined,
  username?: string | null,
): { status: CanvasQuotaStatus; used: number; limit: number } {
  const used = items && username?.trim() ? countCanvasesCreatedBy(items, username) : 0;
  const limit = MAX_USER_CREATED_CANVASES_PER_PROJECT;
  const status = !items || !username?.trim() ? "unknown" : used >= limit ? "reached" : "available";
  return { status, used, limit };
}

export interface PlanCanvasCreationInput {
  projectId: string;
  name: string;
  creatorUsername?: string | null;
  canvases: FreezoneCanvasSummary[] | null | undefined;
  requestId: string;
  saveSource: "manual_save" | "agent_create";
  origin?: { chatCanvasId: string; turnId: string };
}

export type CanvasCreationRejection =
  | { code: "quota_unknown" }
  | { code: "quota_reached"; limit: number }
  | { code: "name_required" }
  | { code: "duplicate_name"; name: string; existingCanvasId: string }
  | { code: "id_taken"; name: string; canvasId: string };

export type CanvasCreationPlan =
  | { status: "rejected"; canvasId: string | null; rejection: CanvasCreationRejection }
  | { status: "ready"; canvasId: string; payload: FreezoneCanvasPayload };

export function planCanvasCreation(
  input: PlanCanvasCreationInput,
  env: Pick<CanvasEnvironment, "translate">,
): CanvasCreationPlan {
  const name = input.name.trim();
  const canvasId = name ? userCreatedCanvasId(name, input.creatorUsername) : null;
  const quota = canvasCreationQuota(input.canvases, input.creatorUsername);
  if (quota.status === "unknown") {
    return { status: "rejected", canvasId, rejection: { code: "quota_unknown" } };
  }
  if (quota.status === "reached") {
    return { status: "rejected", canvasId, rejection: { code: "quota_reached", limit: quota.limit } };
  }
  if (canvasId === null) {
    return { status: "rejected", canvasId, rejection: { code: "name_required" } };
  }
  const canvases = input.canvases ?? [];
  const duplicate = findDuplicateCanvasName(canvases, name, env.translate);
  if (duplicate) {
    return {
      status: "rejected", canvasId,
      rejection: { code: "duplicate_name", name, existingCanvasId: duplicate.id },
    };
  }
  if (canvases.some((item) => item.id === canvasId)) {
    return { status: "rejected", canvasId, rejection: { code: "id_taken", name, canvasId } };
  }
  return {
    status: "ready",
    canvasId,
    payload: {
      schema_version: 2,
      canvas_id: canvasId,
      project_id: input.projectId,
      base_revision: null,
      client_save_id: input.requestId,
      save_source: input.saveSource,
      nodes: [],
      edges: [],
      viewport: null,
      metadata: {
        canvas_origin: "user_created",
        display_name: name,
        creator_username: input.creatorUsername ?? null,
        create_request_id: input.requestId,
        ...(input.origin ? {
          agent_origin: { chat_canvas_id: input.origin.chatCanvasId, turn_id: input.origin.turnId },
        } : {}),
      },
    },
  };
}

export function describeCanvases(
  canvases: CanvasSummaryForDisplay[],
  viewer: { username?: string | null; chatCanvasId?: string | null },
  env: Pick<CanvasEnvironment, "translate">,
) {
  const username = viewer.username?.trim() || null;
  return canvases.map((item) => {
    const creatorUsername = creatorUsernameFromSummary(item);
    const origin = item.metadata?.agent_origin;
    return {
      canvasId: item.id,
      displayName: displayNameForCanvasSummary(item, env.translate),
      kind: canvasKindFromSummary(item),
      creatorUsername,
      createdByViewer: isUserCreatedCanvas(item) && username !== null && creatorUsername === username,
      createdFromThisChat: Boolean(
        viewer.chatCanvasId && origin && typeof origin === "object" &&
        "chat_canvas_id" in origin && origin.chat_canvas_id === viewer.chatCanvasId,
      ),
      modifiedAt: item.modified_at,
    };
  });
}

export function canvasCreationPutPayload(payload: FreezoneCanvasPayload): FreezoneCanvasPayload {
  const metadata = { ...payload.metadata };
  delete metadata.create_request_id;
  delete metadata.agent_origin;
  return { ...payload, metadata };
}
