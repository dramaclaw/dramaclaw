// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it, vi } from "vitest";
import {
  buildSavePayload,
  checkPayloadLimits,
  classifySaveError,
  decideSaveAction,
  describePayloadViolation,
  MAX_BODY_BYTES,
  MAX_EDGES,
  MAX_NODES,
  sanitizePreviewImageUrls,
  type SaveSnapshot,
} from "@/features/freezone/canvasSyncCore";
import type { CanvasMutationSource } from "@/stores/canvasStore";

// Helper to build a snapshot with sensible defaults; tests override only what
// they care about so the intent of each case is obvious from the diff.
function snapshot(overrides: Partial<SaveSnapshot> = {}): SaveSnapshot {
  return {
    hydrated: true,
    switching: false,
    nodeCount: 1,
    edgeCount: 0,
    lastRemoteNodeCount: 1,
    userEditsSinceHydrate: 0,
    lastMutationSource: null,
    pendingClearIntent: false,
    ...overrides,
  };
}

describe("decideSaveAction", () => {
  it("skips when hydrate has not finished", () => {
    expect(decideSaveAction(snapshot({ hydrated: false }))).toEqual({
      kind: "skip",
      reason: "not_hydrated",
    });
  });

  it("skips while canvas/project is switching", () => {
    expect(decideSaveAction(snapshot({ switching: true }))).toEqual({
      kind: "skip",
      reason: "switching",
    });
  });

  it("sends a normal autosave when local + remote both have nodes", () => {
    expect(
      decideSaveAction(snapshot({ nodeCount: 3, lastRemoteNodeCount: 3 })),
    ).toEqual({
      kind: "send",
      saveSource: "autosave",
      allowEmptyOverwrite: false,
    });
  });

  it("sends a normal autosave when both sides are empty (noop new canvas)", () => {
    expect(
      decideSaveAction(snapshot({ nodeCount: 0, lastRemoteNodeCount: 0 })),
    ).toEqual({
      kind: "send",
      saveSource: "autosave",
      allowEmptyOverwrite: false,
    });
  });

  it("auto-promotes manual_clear when user explicitly cleared the canvas", () => {
    expect(
      decideSaveAction(
        snapshot({
          nodeCount: 0,
          lastRemoteNodeCount: 5,
          lastMutationSource: "manual_clear",
          pendingClearIntent: true,
        }),
      ),
    ).toEqual({
      kind: "send",
      saveSource: "manual_clear",
      allowEmptyOverwrite: true,
    });
  });

  it("auto-promotes manual_clear when pendingClearIntent alone is set", () => {
    // Edge case: the clear store action ran but the dispatched mutation source
    // was already overwritten by a follow-up edit that did not change node count.
    expect(
      decideSaveAction(
        snapshot({
          nodeCount: 0,
          lastRemoteNodeCount: 2,
          lastMutationSource: null,
          pendingClearIntent: true,
        }),
      ),
    ).toMatchObject({
      kind: "send",
      saveSource: "manual_clear",
      allowEmptyOverwrite: true,
    });
  });

  it("auto-promotes manual_clear when user deleted nodes one by one to empty", () => {
    expect(
      decideSaveAction(
        snapshot({
          nodeCount: 0,
          lastRemoteNodeCount: 4,
          lastMutationSource: "delete_to_empty",
          userEditsSinceHydrate: 4,
        }),
      ),
    ).toEqual({
      kind: "send",
      saveSource: "manual_clear",
      allowEmptyOverwrite: true,
    });
  });

  it("blocks dangerous_empty when local emptied without a clear intent (HMR reset)", () => {
    // The user did not touch anything (userEditsSinceHydrate === 0,
    // lastMutationSource === null) but nodes are suddenly empty — Zustand
    // reload accident.
    expect(
      decideSaveAction(
        snapshot({
          nodeCount: 0,
          lastRemoteNodeCount: 7,
          userEditsSinceHydrate: 0,
          lastMutationSource: null,
        }),
      ),
    ).toEqual({
      kind: "block",
      reason: "dangerous_empty",
      lastRemoteNodeCount: 7,
    });
  });

  it("blocks dangerous_empty when user edited but store later reset to empty", () => {
    // User made some edits, then HMR / Zustand reset wiped the store. The
    // last mutation source remembers a real edit, not a clear, so the empty
    // state is NOT trustworthy.
    const decision = decideSaveAction(
      snapshot({
        nodeCount: 0,
        lastRemoteNodeCount: 7,
        userEditsSinceHydrate: 5,
        lastMutationSource: "user_edit",
      }),
    );
    expect(decision).toMatchObject({ kind: "block", reason: "dangerous_empty" });
  });

  it("does not block when the canvas was never non-empty on the server", () => {
    // Brand-new canvas: even if local is empty, there is nothing to lose.
    expect(
      decideSaveAction(
        snapshot({
          nodeCount: 0,
          lastRemoteNodeCount: 0,
          userEditsSinceHydrate: 0,
          lastMutationSource: null,
        }),
      ),
    ).toMatchObject({ kind: "send", saveSource: "autosave" });
  });
});

describe("buildSavePayload", () => {
  const sendAutosave = {
    kind: "send" as const,
    saveSource: "autosave" as const,
    allowEmptyOverwrite: false,
  };

  it("includes the four mandatory fields on every send", () => {
    const payload = buildSavePayload({
      canvasId: "c1",
      nodes: [{ id: "n1" }],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
      metadata: { foo: "bar" },
      baseRevision: 12,
      clientSaveId: "uuid-1",
      decision: sendAutosave,
    });
    expect(payload).toMatchObject({
      canvas_id: "c1",
      base_revision: 12,
      client_save_id: "uuid-1",
      save_source: "autosave",
      allow_empty_overwrite: false,
    });
  });

  it("omits base_revision when no revision is known yet", () => {
    const payload = buildSavePayload({
      canvasId: "c1",
      nodes: [],
      edges: [],
      baseRevision: null,
      clientSaveId: "uuid-2",
      decision: sendAutosave,
    });
    expect(payload.base_revision).toBeUndefined();
  });

  it("passes manual_clear + allow_empty_overwrite through to the envelope", () => {
    const payload = buildSavePayload({
      canvasId: "c1",
      nodes: [],
      edges: [],
      baseRevision: 5,
      clientSaveId: "uuid-3",
      decision: {
        kind: "send",
        saveSource: "manual_clear",
        allowEmptyOverwrite: true,
      },
    });
    expect(payload.save_source).toBe("manual_clear");
    expect(payload.allow_empty_overwrite).toBe(true);
  });

  it("merges the envelope before overwriting it with fresh fields", () => {
    // canvas_id from the envelope should not survive — the explicit arg wins.
    const payload = buildSavePayload({
      canvasId: "c1",
      nodes: [],
      edges: [],
      baseRevision: 1,
      clientSaveId: "uuid-4",
      decision: sendAutosave,
      envelope: {
        canvas_id: "stale",
        schema_version: 2,
        owner_principal_id: "alice",
      },
    });
    expect(payload.canvas_id).toBe("c1");
    expect(payload.schema_version).toBe(2);
    expect(payload.owner_principal_id).toBe("alice");
  });

  it("strips base64 previewImageUrl on the node level, replacing it with imageUrl", () => {
    // Regression: exportImageNode (crop/annotate/etc.) used to ship
    // previewImageUrl as a `data:image/png;base64,...` blob in PUT /default,
    // bloating the canvas to MBs. The sanitizer is the chokepoint that
    // protects historical canvases too — they get cleaned up on first save.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const payload = buildSavePayload({
      canvasId: "c1",
      nodes: [
        {
          id: "export-1",
          type: "exportImageNode",
          data: {
            imageUrl: "/static/admin/333/freezone/_uploads/x.png",
            previewImageUrl:
              "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA...",
            aspectRatio: "1:1",
          },
        },
      ],
      edges: [],
      baseRevision: null,
      clientSaveId: "uuid-strip",
      decision: sendAutosave,
    });
    const node = (payload.nodes as Array<{ data: Record<string, unknown> }>)[0];
    expect(node.data.previewImageUrl).toBe(
      "/static/admin/333/freezone/_uploads/x.png",
    );
    expect(node.data.imageUrl).toBe(
      "/static/admin/333/freezone/_uploads/x.png",
    );
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("falls back to null when both imageUrl and previewImageUrl are data URLs", () => {
    // Worst-case historical canvas: BOTH fields are base64. We can't recover
    // a static URL, so the safest thing is to drop the preview entirely (the
    // node's render code falls back to imageUrl, and the next genuine edit
    // will write a real URL through the upload path).
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const sanitized = sanitizePreviewImageUrls([
      {
        id: "export-bad",
        data: {
          imageUrl: "data:image/png;base64,AAA",
          previewImageUrl: "data:image/png;base64,BBB",
        },
      },
    ]) as Array<{ data: Record<string, unknown> }>;
    expect(sanitized[0].data.previewImageUrl).toBeNull();
    // imageUrl stays as-is — we don't have a better URL to substitute, and
    // the upload-on-edit path will replace it the next time the user edits.
    expect(sanitized[0].data.imageUrl).toBe("data:image/png;base64,AAA");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("walks storyboardSplitNode frames so per-frame previews are sanitized too", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const sanitized = sanitizePreviewImageUrls([
      {
        id: "split-1",
        type: "storyboardSplitNode",
        data: {
          gridRows: 1,
          gridCols: 2,
          frames: [
            {
              id: "f0",
              imageUrl: "/static/admin/333/freezone/_uploads/a.png",
              previewImageUrl:
                "data:image/png;base64,iVBORw0KGgoAAAA...",
            },
            {
              id: "f1",
              imageUrl: "/static/admin/333/freezone/_uploads/b.png",
              previewImageUrl: "/static/admin/333/freezone/_uploads/b.png",
            },
          ],
        },
      },
    ]) as Array<{ data: { frames: Array<{ previewImageUrl: string | null }> } }>;
    const frames = sanitized[0].data.frames;
    expect(frames[0].previewImageUrl).toBe(
      "/static/admin/333/freezone/_uploads/a.png",
    );
    // Untouched frame stays untouched.
    expect(frames[1].previewImageUrl).toBe(
      "/static/admin/333/freezone/_uploads/b.png",
    );
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("is a no-op when no previewImageUrl is a data URL", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const input = [
      {
        id: "n1",
        data: {
          imageUrl: "/static/a.png",
          previewImageUrl: "/static/a.png",
        },
      },
      { id: "n2" }, // no data
      { id: "n3", data: { someOther: 1 } }, // no preview field
    ];
    const sanitized = sanitizePreviewImageUrls(input);
    // Reference equality is preserved when nothing needs rewriting — this
    // keeps Zustand selectors / React Flow internal `===` checks stable.
    expect(sanitized[0]).toBe(input[0]);
    expect(sanitized[1]).toBe(input[1]);
    expect(sanitized[2]).toBe(input[2]);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("emits viewport only when provided", () => {
    const withoutViewport = buildSavePayload({
      canvasId: "c1",
      nodes: [],
      edges: [],
      baseRevision: null,
      clientSaveId: "uuid-5",
      decision: sendAutosave,
    });
    expect(withoutViewport.viewport).toBeUndefined();

    const withViewport = buildSavePayload({
      canvasId: "c1",
      nodes: [],
      edges: [],
      viewport: { x: 1, y: 2, zoom: 3 },
      baseRevision: null,
      clientSaveId: "uuid-5b",
      decision: sendAutosave,
    });
    expect(withViewport.viewport).toEqual({ x: 1, y: 2, zoom: 3 });
  });
});

describe("classifySaveError", () => {
  it("maps 409 to conflict with the canonical message", () => {
    expect(classifySaveError(409, {}, "fallback")).toMatchObject({
      kind: "conflict",
      message: "画布已被其他窗口或用户修改",
    });
  });

  it("gives 409 canvas_idempotency_conflict its own wording", () => {
    // Same client replaying one client_save_id with a different body — no
    // other window is involved, so the canonical message would misdirect.
    const outcome = classifySaveError(
      409,
      { detail: { code: "canvas_idempotency_conflict" } },
      "fallback",
    );
    expect(outcome).toMatchObject({ kind: "conflict" });
    expect((outcome as { message: string }).message).not.toBe(
      "画布已被其他窗口或用户修改",
    );
  });

  it("keeps the canonical message for a real revision conflict", () => {
    expect(
      classifySaveError(
        409,
        { detail: { code: "canvas_revision_conflict" } },
        "fallback",
      ),
    ).toMatchObject({
      kind: "conflict",
      message: "画布已被其他窗口或用户修改",
    });
  });

  it("maps 400 dangerous_empty_canvas_overwrite to its own branch", () => {
    const outcome = classifySaveError(
      400,
      { detail: { code: "dangerous_empty_canvas_overwrite" } },
      "fallback",
    );
    expect(outcome.kind).toBe("dangerous_empty");
  });

  it("maps 503 canvas_lock_busy to a retry with 1s backoff", () => {
    expect(
      classifySaveError(
        503,
        { detail: { code: "canvas_lock_busy" } },
        "fallback",
      ),
    ).toEqual({
      kind: "retry",
      afterMs: 1_000,
      code: "canvas_lock_busy",
    });
  });

  it("maps 503 canvas_backup_pending to an ok_with_warning", () => {
    const outcome = classifySaveError(
      503,
      { detail: { code: "canvas_backup_pending" } },
      "fallback",
    );
    expect(outcome.kind).toBe("ok_with_warning");
    if (outcome.kind === "ok_with_warning") {
      expect(outcome.backupStatus).toBe("pending");
    }
  });

  it("maps 422 canvas_payload_too_large to fatal", () => {
    expect(
      classifySaveError(
        422,
        { detail: { code: "canvas_payload_too_large" } },
        "fallback",
      ).kind,
    ).toBe("fatal");
  });

  it("maps 500 canvas_needs_migration to fatal", () => {
    expect(
      classifySaveError(
        500,
        { detail: { code: "canvas_needs_migration" } },
        "fallback",
      ).kind,
    ).toBe("fatal");
  });

  it("falls back to a generic error for unknown codes", () => {
    expect(classifySaveError(418, {}, "I am a teapot")).toEqual({
      kind: "error",
      message: "I am a teapot",
    });
  });

  it("treats bare 413 as fatal payload_too_large even without detail.code", () => {
    const outcome = classifySaveError(413, undefined, "fallback");
    expect(outcome.kind).toBe("fatal");
    if (outcome.kind === "fatal") {
      expect(outcome.code).toBe("canvas_payload_too_large");
    }
  });

  it("treats 500 canvas_backup_failed as fatal with a specific message", () => {
    const outcome = classifySaveError(
      500,
      { detail: { code: "canvas_backup_failed" } },
      "fallback",
    );
    expect(outcome.kind).toBe("fatal");
    if (outcome.kind === "fatal") {
      expect(outcome.code).toBe("canvas_backup_failed");
      expect(outcome.message).toContain("云端备份");
    }
  });
});

describe("checkPayloadLimits", () => {
  it("returns null when every dimension is within bounds", () => {
    expect(checkPayloadLimits(10, 20, 1024)).toBeNull();
    // Body-size check is opt-in: passing null means "do not check".
    expect(checkPayloadLimits(MAX_NODES, MAX_EDGES, null)).toBeNull();
  });

  it("flags node count as the first violation when over the cap", () => {
    const violation = checkPayloadLimits(MAX_NODES + 1, 0, null);
    expect(violation).toEqual({
      field: "nodes",
      actual: MAX_NODES + 1,
      limit: MAX_NODES,
    });
  });

  it("flags edge count when nodes are within bounds", () => {
    const violation = checkPayloadLimits(10, MAX_EDGES + 1, null);
    expect(violation).toEqual({
      field: "edges",
      actual: MAX_EDGES + 1,
      limit: MAX_EDGES,
    });
  });

  it("flags body size only when counts pass and a size is supplied", () => {
    const violation = checkPayloadLimits(10, 10, MAX_BODY_BYTES + 1);
    expect(violation).toEqual({
      field: "body",
      actual: MAX_BODY_BYTES + 1,
      limit: MAX_BODY_BYTES,
    });
  });

  it("prefers node violation over body violation when both exceed", () => {
    const violation = checkPayloadLimits(
      MAX_NODES + 1,
      0,
      MAX_BODY_BYTES + 1024,
    );
    expect(violation?.field).toBe("nodes");
  });
});

describe("describePayloadViolation", () => {
  it("uses 节点 wording for the nodes field", () => {
    expect(
      describePayloadViolation({
        field: "nodes",
        actual: MAX_NODES + 5,
        limit: MAX_NODES,
      }),
    ).toMatch(/节点数量/);
  });

  it("uses 连线 wording for the edges field", () => {
    expect(
      describePayloadViolation({
        field: "edges",
        actual: MAX_EDGES + 5,
        limit: MAX_EDGES,
      }),
    ).toMatch(/连线数量/);
  });

  it("renders body size in KB for readability", () => {
    const message = describePayloadViolation({
      field: "body",
      actual: 6 * 1024 * 1024,
      limit: MAX_BODY_BYTES,
    });
    expect(message).toMatch(/KB/);
    expect(message).toMatch(/暂停保存/);
  });
});

// Type-only safety: the union must stay narrowable. If a new decision branch is
// added without updating consumers, this assertion will fail at compile time.
function assertExhaustive(_value: never): never {
  throw new Error("non-exhaustive decision branch");
}
function exhaustiveCheck(snap: SaveSnapshot): string {
  const decision = decideSaveAction(snap);
  switch (decision.kind) {
    case "skip":
      return decision.reason;
    case "block":
      return decision.reason;
    case "send":
      return decision.saveSource as CanvasMutationSource | "autosave" | string;
    default:
      return assertExhaustive(decision);
  }
}
// Ensure the helper is referenced so the file is not treated as test-only dead code.
void exhaustiveCheck;
