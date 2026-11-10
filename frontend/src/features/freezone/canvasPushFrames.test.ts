// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from "vitest";
import { canvasPushReloadRevision } from "./canvasPushFrames";

describe("canvas push reload revision", () => {
  const context = {
    canvasId: "c",
    currentRevision: 4,
    requestedRevision: null,
    isOwnSave: (id: unknown) => id === "own-save",
  };

  it.each([
    null, undefined, true, "canvas.patch", [], {},
    { bridge_key: "command", revision: 5, canvas_id: "c" },
    { type: "other", revision: 5, canvas_id: "c" },
    { type: "canvas.patch", revision: 5, canvas_id: "other" },
    { type: "canvas.reset", revision: 5, canvas_id: "other" },
    { type: "canvas.patch", revision: 5 },
  ])("ignores unrelated or malformed frames: %j", (frame) => {
    expect(canvasPushReloadRevision(frame, context)).toBeNull();
  });

  it.each(["canvas.patch", "canvas.reset"])("validates %s revisions", (type) => {
    for (const revision of [undefined, null, "5", 5.5, NaN, Infinity, -Infinity]) {
      expect(canvasPushReloadRevision({ type, canvas_id: "c", revision }, context)).toBeNull();
    }
  });

  it.each([
    { type: "canvas.patch", canvas_id: "c", revision: 5 },
    { type: "canvas.patch", canvas_id: "c", revision: 5, client_save_id: null },
    { type: "canvas.patch", canvas_id: "c", revision: 5, client_save_id: "another-tab" },
    { type: "canvas.reset", canvas_id: "c", revision: 5 },
    { type: "canvas.reset", canvas_id: "c", revision: 5, client_save_id: "own-save" },
  ])("reloads a newer remote revision: %j", (frame) => {
    expect(canvasPushReloadRevision(frame, context)).toBe(5);
  });

  it("ignores a patch from this tab's own save", () => {
    expect(canvasPushReloadRevision({
      type: "canvas.patch", canvas_id: "c", revision: 5, client_save_id: "own-save",
    }, context)).toBeNull();
  });

  it.each(["canvas.patch", "canvas.reset"])("deduplicates %s against current and requested revisions", (type) => {
    const frame = { type, canvas_id: "c", revision: 5 };
    expect(canvasPushReloadRevision(frame, { ...context, currentRevision: 5 })).toBeNull();
    expect(canvasPushReloadRevision(frame, { ...context, currentRevision: 6 })).toBeNull();
    expect(canvasPushReloadRevision(frame, { ...context, requestedRevision: 5 })).toBeNull();
    expect(canvasPushReloadRevision(frame, { ...context, requestedRevision: 6 })).toBeNull();
    expect(canvasPushReloadRevision(frame, { ...context, requestedRevision: 3 })).toBe(5);
    expect(canvasPushReloadRevision({ ...frame, revision: 4 }, {
      ...context, requestedRevision: 3,
    })).toBeNull();
    expect(canvasPushReloadRevision({ ...frame, revision: 7 }, {
      ...context, requestedRevision: 6,
    })).toBe(7);
  });

  it.each(["canvas.patch", "canvas.reset"])("reloads %s revision zero before hydration", (type) => {
    const frame = { type, canvas_id: "c", revision: 0 };
    expect(canvasPushReloadRevision(frame, { ...context, currentRevision: null })).toBe(0);
    expect(canvasPushReloadRevision(frame, {
      ...context, currentRevision: null, requestedRevision: 0,
    })).toBeNull();
  });

  it("allows a reset with an unknown current revision even below the default cursor", () => {
    expect(canvasPushReloadRevision({ type: "canvas.reset", canvas_id: "c", revision: -1 }, {
      ...context, currentRevision: null,
    })).toBe(-1);
  });

  it("ignores a patch at the default cursor before hydration", () => {
    expect(canvasPushReloadRevision({ type: "canvas.patch", canvas_id: "c", revision: -1 }, {
      ...context, currentRevision: null,
    })).toBeNull();
  });
});
