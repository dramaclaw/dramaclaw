// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it, vi } from "vitest";

import type { FreezoneCanvasSummary } from "@/api/canvas";
import {
  canvasCreationQuota,
  canvasCreationQuotaStatus,
  canvasKindFromSummary,
  countCanvasesCreatedBy,
  describeCanvases,
  displayNameForCanvasSummary,
  findDuplicateCanvasName,
  isConflictCopyCanvas,
  isUserCreatedCanvas,
  planCanvasCreation,
  stableCanvasIdHash,
  userCreatedCanvasId,
} from "@/features/canvas/core/canvasCreation";
import type {
  CanvasKind,
  CanvasSummaryForDisplay,
  CanvasTranslate,
  PlanCanvasCreationInput,
} from "@/features/canvas/core/canvasCreation";
import { createServerTranslate } from "@/features/canvas/server/i18n";
import { personalCanvasIdForUsername } from "@/features/freezone/projections";
import { MAX_USER_CREATED_CANVASES_PER_PROJECT } from "@/lib/limits";

const translate: CanvasTranslate = (key, options) => options ? `${key}:${JSON.stringify(options)}` : key;
const env = { translate };

function summary(id: string, metadata: FreezoneCanvasSummary["metadata"] = {}): FreezoneCanvasSummary {
  return { id, metadata, modified_at: "2026-11-01T00:00:00Z", size: 10 };
}

function userCanvas(id: string, name: string, creator: string | null = "alice"): FreezoneCanvasSummary {
  return summary(id, { canvas_origin: "user_created", display_name: name, creator_username: creator });
}

function input(overrides: Partial<PlanCanvasCreationInput> = {}): PlanCanvasCreationInput {
  return {
    projectId: "project-a",
    name: "Ghost Plan",
    creatorUsername: "alice",
    canvases: [],
    requestId: "request-a",
    saveSource: "manual_save",
    ...overrides,
  };
}

function ownedCanvases(count: number): FreezoneCanvasSummary[] {
  return Array.from({ length: count }, (_, index) => userCanvas(`owned-${index}`, `Owned ${index}`));
}

describe("planCanvasCreation", () => {
  it("rejects an unavailable list before checking an empty name", () => {
    expect(planCanvasCreation(input({ canvases: undefined, name: "" }), env)).toEqual({
      status: "rejected", canvasId: null, rejection: { code: "quota_unknown" },
    });
  });

  it("treats a null list from a JSON host as unavailable", () => {
    const canvases = null as unknown as PlanCanvasCreationInput["canvases"];
    expect(planCanvasCreation(input({ canvases }), env)).toEqual({
      status: "rejected",
      canvasId: "canvas_ghost_plan_1cebeu5",
      rejection: { code: "quota_unknown" },
    });
  });

  it("rejects a reached quota before checking a duplicate name", () => {
    expect(planCanvasCreation(input({ canvases: ownedCanvases(25), name: " Owned 0 " }), env)).toEqual({
      status: "rejected",
      canvasId: userCreatedCanvasId("Owned 0", "alice"),
      rejection: { code: "quota_reached", limit: MAX_USER_CREATED_CANVASES_PER_PROJECT },
    });
  });

  it.each(["", "   ", "\t\n "])("requires a nonempty trimmed name: %j", (name) => {
    expect(planCanvasCreation(input({ name }), env)).toEqual({
      status: "rejected", canvasId: null, rejection: { code: "name_required" },
    });
  });

  it("rejects the first duplicate before checking whether the computed id is taken", () => {
    const canvasId = userCreatedCanvasId("Ghost   Plan", "alice");
    const canvases = [
      userCanvas("first-match", "  gHoSt\tPlan  ", "bob"),
      userCanvas(canvasId, "Ghost Plan"),
    ];
    expect(planCanvasCreation(input({ name: "  Ghost   Plan  ", canvases }), env)).toEqual({
      status: "rejected", canvasId,
      rejection: { code: "duplicate_name", name: "Ghost   Plan", existingCanvasId: "first-match" },
    });
  });

  it("rejects an occupied id even when its display name does not match", () => {
    const canvasId = "canvas_ghost_plan_1cebeu5";
    expect(planCanvasCreation(input({
      name: "  Ghost Plan  ", canvases: [userCanvas(canvasId, "Different name")],
    }), env)).toEqual({
      status: "rejected", canvasId,
      rejection: { code: "id_taken", name: "Ghost Plan", canvasId },
    });
  });

  it.each([null, "   "])("keeps a computed id when the creator is unavailable: %j", (creatorUsername) => {
    const result = planCanvasCreation(input({ creatorUsername, name: " Ghost Plan " }), env);
    expect(result).toEqual({
      status: "rejected",
      canvasId: userCreatedCanvasId("Ghost Plan", null),
      rejection: { code: "quota_unknown" },
    });
    expect(userCreatedCanvasId("Ghost Plan", null)).toBe(userCreatedCanvasId("Ghost Plan", "user"));
  });

  it("keeps the computed id when a nonempty name has an unavailable list", () => {
    expect(planCanvasCreation(input({ canvases: undefined, name: " Ghost Plan " }), env)).toEqual({
      status: "rejected", canvasId: "canvas_ghost_plan_1cebeu5", rejection: { code: "quota_unknown" },
    });
  });

  it("builds the exact manual save payload without an agent origin key", () => {
    const result = planCanvasCreation(input({ name: " Ghost Plan ", creatorUsername: " alice " }), env);
    expect(result).toEqual({
      status: "ready",
      canvasId: "canvas_ghost_plan_1cebeu5",
      payload: {
        schema_version: 2,
        canvas_id: "canvas_ghost_plan_1cebeu5",
        project_id: "project-a",
        base_revision: null,
        client_save_id: "request-a",
        save_source: "manual_save",
        nodes: [], edges: [], viewport: null,
        metadata: {
          canvas_origin: "user_created",
          display_name: "Ghost Plan",
          creator_username: " alice ",
          create_request_id: "request-a",
        },
      },
    });
    if (result.status !== "ready") throw new Error("Expected a ready plan");
    expect(result.payload.metadata).not.toHaveProperty("agent_origin");
  });

  it("builds the exact agent creation payload with its chat and turn origin", () => {
    expect(planCanvasCreation(input({
      saveSource: "agent_create", origin: { chatCanvasId: "chat-a", turnId: "turn-a" },
    }), env)).toEqual({
      status: "ready",
      canvasId: "canvas_ghost_plan_1cebeu5",
      payload: {
        schema_version: 2,
        canvas_id: "canvas_ghost_plan_1cebeu5",
        project_id: "project-a",
        base_revision: null,
        client_save_id: "request-a",
        save_source: "agent_create",
        nodes: [], edges: [], viewport: null,
        metadata: {
          canvas_origin: "user_created",
          display_name: "Ghost Plan",
          creator_username: "alice",
          create_request_id: "request-a",
          agent_origin: { chat_canvas_id: "chat-a", turn_id: "turn-a" },
        },
      },
    });
  });

  it("uses locale-independent case folding for ids and duplicate names", () => {
    const localeLowerCase = vi.spyOn(String.prototype, "toLocaleLowerCase");
    try {
      const existing = userCanvas("existing", "  ÉTUDE\t故事  ", "bob");
      expect(planCanvasCreation(input({ name: " New ÉTUDE 故事 " }), env).status).toBe("ready");
      expect(planCanvasCreation(input({ name: " étude 故事 ", canvases: [existing] }), env)).toEqual({
        status: "rejected",
        canvasId: userCreatedCanvasId("étude 故事", "alice"),
        rejection: { code: "duplicate_name", name: "étude 故事", existingCanvasId: "existing" },
      });
      expect(userCreatedCanvasId(" Mixed ÉTUDE 故事 ", "alice")).toMatch(/^canvas_mixed_tude_/);
      expect(findDuplicateCanvasName([existing], "éTuDe   故事", translate)).toBe(existing);
      expect(localeLowerCase).not.toHaveBeenCalled();
    } finally {
      localeLowerCase.mockRestore();
    }
  });

  it.each([
    { locale: "en", label: "Default canvas" },
    { locale: "zh", label: "默认画布" },
  ])("detects the translated system label in $locale", async ({ locale, label }) => {
    const t = await createServerTranslate(locale);
    const preset = summary("default", { preset: { scope: "default" } });
    expect(findDuplicateCanvasName([preset], ` ${label} `, t)).toBe(preset);
    expect(planCanvasCreation(input({ name: ` ${label} `, canvases: [preset] }), { translate: t })).toEqual({
      status: "rejected", canvasId: userCreatedCanvasId(label, "alice"),
      rejection: { code: "duplicate_name", name: label, existingCanvasId: "default" },
    });
  });
});

describe("canvasCreationQuota", () => {
  const mixed = [
    userCanvas("alice-a", "A"),
    userCanvas("alice-b", "B", " alice "),
    userCanvas("bob-a", "C", "bob"),
    summary("default", { preset: { scope: "default" }, creator_username: "alice" }),
    summary("copy_a", { canvas_origin: "conflict_copy", creator_username: "alice" }),
    summary("anonymous", { canvas_origin: "user_created" }),
  ];

  it.each([
    { name: "unavailable list", canvases: undefined, username: "alice" },
    { name: "null username", canvases: mixed, username: null },
    { name: "blank username", canvases: mixed, username: "   " },
  ])("reports zero usage for an unknown quota: $name", ({ canvases, username }) => {
    expect(canvasCreationQuota(canvases, username)).toEqual({
      status: "unknown", used: 0, limit: MAX_USER_CREATED_CANVASES_PER_PROJECT,
    });
    expect(canvasCreationQuota(canvases, username).status).toBe(canvasCreationQuotaStatus(canvases, username));
  });

  it("counts only user-created canvases owned by the trimmed username", () => {
    expect(countCanvasesCreatedBy(mixed, " alice ")).toBe(2);
    expect(countCanvasesCreatedBy(mixed, null)).toBe(1);
    expect(canvasCreationQuota(mixed, " alice ")).toEqual({
      status: "available", used: 2, limit: MAX_USER_CREATED_CANVASES_PER_PROJECT,
    });
    expect(canvasCreationQuota(mixed, " alice ").status).toBe(canvasCreationQuotaStatus(mixed, " alice "));
  });

  it.each([0, 24, 25, 26])("reports the quota boundary at %i owned canvases", (used) => {
    const canvases = ownedCanvases(used);
    const result = canvasCreationQuota(canvases, "alice");
    expect(MAX_USER_CREATED_CANVASES_PER_PROJECT).toBe(25);
    expect(result).toEqual({ status: used >= 25 ? "reached" : "available", used, limit: 25 });
    expect(result.status).toBe(canvasCreationQuotaStatus(canvases, "alice"));
  });
});

describe("describeCanvases", () => {
  const canvases = [
    summary("default", { preset: { scope: "default" } }),
    summary("alice-chat-a", {
      canvas_origin: "user_created", display_name: "  Plan A  ", creator_username: " alice ",
      agent_origin: { chat_canvas_id: "chat-a", turn_id: "turn-a" },
    }),
    summary("alice-chat-b", {
      canvas_origin: "user_created", display_name: "Plan B", creator_username: "alice",
      agent_origin: { chat_canvas_id: "chat-b", turn_id: "turn-b" },
    }),
    userCanvas("bob-a", "Bob Plan", "bob"),
    summary("copy_recovery", { canvas_origin: "conflict_copy", creator_username: "alice" }),
    summary("anonymous", { canvas_origin: "user_created", display_name: "Anonymous Plan" }),
  ].map((canvas, index) => ({ ...canvas, modified_at: `2026-11-0${index + 1}T00:00:00Z` }));

  it("keeps input order and describes ownership, origin, labels and modification times", async () => {
    const t = await createServerTranslate("en");
    expect(describeCanvases(canvases, { username: " alice ", chatCanvasId: "chat-a" }, { translate: t })).toEqual([
      { canvasId: "default", displayName: "Default canvas", kind: "default", creatorUsername: null,
        createdByViewer: false, createdFromThisChat: false, modifiedAt: "2026-11-01T00:00:00Z" },
      { canvasId: "alice-chat-a", displayName: "alice · Plan A", kind: "blank", creatorUsername: "alice",
        createdByViewer: true, createdFromThisChat: true, modifiedAt: "2026-11-02T00:00:00Z" },
      { canvasId: "alice-chat-b", displayName: "alice · Plan B", kind: "blank", creatorUsername: "alice",
        createdByViewer: true, createdFromThisChat: false, modifiedAt: "2026-11-03T00:00:00Z" },
      { canvasId: "bob-a", displayName: "bob · Bob Plan", kind: "blank", creatorUsername: "bob",
        createdByViewer: false, createdFromThisChat: false, modifiedAt: "2026-11-04T00:00:00Z" },
      { canvasId: "copy_recovery", displayName: "Conflict copy", kind: "other", creatorUsername: "alice",
        createdByViewer: false, createdFromThisChat: false, modifiedAt: "2026-11-05T00:00:00Z" },
      { canvasId: "anonymous", displayName: "Anonymous Plan", kind: "blank", creatorUsername: null,
        createdByViewer: false, createdFromThisChat: false, modifiedAt: "2026-11-06T00:00:00Z" },
    ]);
  });

  it("reports no chat matches when the viewer has no chat canvas id", () => {
    const rows = describeCanvases(canvases, { username: "alice" }, env);
    expect(rows.map((row) => row.createdFromThisChat)).toEqual(canvases.map(() => false));
  });

  it.each([null, "   "])("reports no viewer-owned canvases for an unavailable username: %j", (username) => {
    const rows = describeCanvases(canvases, { username, chatCanvasId: "chat-a" }, env);
    expect(rows.map((row) => row.createdByViewer)).toEqual(canvases.map(() => false));
    expect(rows.map((row) => row.createdFromThisChat)).toEqual([false, true, false, false, false, false]);
  });

  it("honors display overrides while metadata display names retain priority", () => {
    const override: CanvasSummaryForDisplay = {
      ...summary("default"), displayName: "Custom row", displayKind: "personal",
    };
    expect(displayNameForCanvasSummary(override, translate)).toBe("Custom row");
    expect(canvasKindFromSummary(override)).toBe("personal");
    expect(describeCanvases([override], { username: null }, env)[0]).toEqual({
      canvasId: "default", displayName: "Custom row", kind: "personal", creatorUsername: null,
      createdByViewer: false, createdFromThisChat: false, modifiedAt: override.modified_at,
    });
    expect(displayNameForCanvasSummary({ ...override, metadata: { display_name: " Raw name " } }, translate))
      .toBe("Raw name");
  });
});

describe("moved canvas helpers", () => {
  it.each<{ canvas: FreezoneCanvasSummary; kind: CanvasKind }>([
    { canvas: summary("default"), kind: "default" },
    { canvas: summary("episode", { preset: { scope: "episode" } }), kind: "episode" },
    { canvas: { ...summary("beat"), canvas_scope: "beat" }, kind: "beat" },
    { canvas: summary("asset", { preset: { scope: "asset" } }), kind: "asset" },
    { canvas: summary("workflow", { free_workflow: {} }), kind: "workflow" },
    { canvas: userCanvas("custom", "Plan"), kind: "blank" },
    { canvas: summary("unknown"), kind: "other" },
  ])("classifies $kind canvases", ({ canvas, kind }) => {
    expect(canvasKindFromSummary(canvas)).toBe(kind);
  });

  it("recognizes conflict metadata and both conflict id forms", () => {
    for (const canvas of [summary("recovery", { canvas_origin: "conflict_copy" }), summary("copy_a"), summary("a_copy_b")]) {
      expect(isConflictCopyCanvas(canvas)).toBe(true);
      expect(isUserCreatedCanvas(canvas)).toBe(false);
    }
    expect(isConflictCopyCanvas(userCanvas("normal", "Plan"))).toBe(false);
    expect(isUserCreatedCanvas(userCanvas("normal", "Plan"))).toBe(true);
  });

  it("keeps stable hash values and the existing personal canvas id", () => {
    expect(stableCanvasIdHash("alice")).toBe("11ht1wn");
    expect(stableCanvasIdHash("alice:Ghost Plan")).toBe("1cebeu5");
    expect(stableCanvasIdHash("")).toBe("ztntfp");
    expect(personalCanvasIdForUsername("alice")).toBe("user_alice_11ht1wn");
  });
});
