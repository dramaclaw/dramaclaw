// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from "vitest";

import type { FreezoneCanvasSummary } from "@/api/canvas";
import { canvasCreationQuota, describeCanvases } from "@/features/canvas/core/canvasCreation";
import { serveDescribeCanvases, servePlanCanvasCreation } from "@/features/canvas/server/createCanvas";
import { createServerTranslate } from "@/features/canvas/server/i18n";
import { InvalidRequest } from "@/features/canvas/server/requestPayload";
import fixture from "./__parity__/canvas-creation.json";

describe("server canvas creation plans", () => {
  it("keeps exactly 30 fixture cases", () => {
    expect(fixture.cases).toHaveLength(30);
  });

  it.each(fixture.cases)("preserves the shared core result for $name", async ({ input, locale, expected }) => {
    const wire = {
      project_id: input.projectId,
      name: input.name,
      ...("creatorUsername" in input ? { creator_username: input.creatorUsername } : {}),
      request_id: input.requestId,
      save_source: input.saveSource,
      ...("canvases" in input ? { canvases: input.canvases } : {}),
      ...(input.origin ? { origin: { chat_canvas_id: input.origin.chatCanvasId, turn_id: input.origin.turnId } } : {}),
      env: { locale },
    };
    expect(await servePlanCanvasCreation(wire)).toEqual(expected);
  });

  const valid = {
    project_id: "project-a", name: "Story lab", creator_username: "alice",
    request_id: "req-1", save_source: "manual_save", canvases: [],
  };

  it.each([
    { name: "null payload", payload: null },
    { name: "array payload", payload: [] },
    { name: "string payload", payload: "invalid" },
    { name: "non-string name", payload: { ...valid, name: 1 } },
    { name: "non-array canvases", payload: { ...valid, canvases: {} } },
    { name: "unsupported save source", payload: { ...valid, save_source: "autosave" } },
    { name: "origin without a turn id", payload: { ...valid, origin: { chat_canvas_id: "chat-1" } } },
    { name: "missing request id", payload: { project_id: "project-a", name: "Story lab", save_source: "manual_save" } },
    { name: "non-string project id", payload: { ...valid, project_id: 1 } },
    { name: "non-string creator", payload: { ...valid, creator_username: 1 } },
    { name: "non-object environment", payload: { ...valid, env: [] } },
    { name: "non-string locale", payload: { ...valid, env: { locale: 1 } } },
  ])("rejects $name", async ({ payload }) => {
    await expect(servePlanCanvasCreation(payload)).rejects.toBeInstanceOf(InvalidRequest);
  });
});

describe("server canvas descriptions", () => {
  it("preserves descriptions and quota for the viewer and current chat", async () => {
    const canvases = [
      { id: "default", modified_at: "2026-11-01T00:00:00Z", size: 1 },
      { id: "canvas_alice", modified_at: "2026-11-01T00:00:00Z", size: 1, metadata: {
        canvas_origin: "user_created", display_name: "Alice plan", creator_username: "alice",
        agent_origin: { chat_canvas_id: "chat-1", turn_id: "turn-1" },
      } },
      { id: "canvas_bob", modified_at: "2026-11-01T00:00:00Z", size: 1, metadata: {
        canvas_origin: "user_created", display_name: "Bob plan", creator_username: "bob",
      } },
    ] satisfies FreezoneCanvasSummary[];
    const result = await serveDescribeCanvases({
      canvases, viewer: { username: "alice", chat_canvas_id: "chat-1" }, env: { locale: "en" },
    });
    const translate = await createServerTranslate("en");
    expect(result).toEqual({
      canvases: describeCanvases(canvases, { username: "alice", chatCanvasId: "chat-1" }, { translate }),
      quota: canvasCreationQuota(canvases, "alice"),
    });
    expect(result.canvases[1]).toMatchObject({ createdByViewer: true, createdFromThisChat: true });
    expect(result.canvases[2]).toMatchObject({ createdByViewer: false, createdFromThisChat: false });
    expect(result.quota).toEqual({ status: "available", used: 1, limit: 25 });
  });

  it.each([
    { name: "null payload", payload: null },
    { name: "missing canvases", payload: {} },
    { name: "non-array canvases", payload: { canvases: {} } },
    { name: "null canvases", payload: { canvases: null } },
    { name: "non-object viewer", payload: { canvases: [], viewer: "alice" } },
    { name: "null viewer", payload: { canvases: [], viewer: null } },
    { name: "array viewer", payload: { canvases: [], viewer: [] } },
    { name: "non-string username", payload: { canvases: [], viewer: { username: 1 } } },
    { name: "non-string chat id", payload: { canvases: [], viewer: { chat_canvas_id: 1 } } },
    { name: "non-string locale", payload: { canvases: [], env: { locale: 1 } } },
  ])("rejects $name", async ({ payload }) => {
    await expect(serveDescribeCanvases(payload)).rejects.toBeInstanceOf(InvalidRequest);
  });
});
