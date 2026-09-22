import { beforeEach, describe, expect, it, vi } from "vitest";

const canvasRuntime = vi.hoisted(() => ({
  refreshRemoteFreezoneCanvas: vi.fn(),
}));

vi.mock("@/features/freezone/canvasSyncRuntime", () => canvasRuntime);

import {
  interactiveStoryRefreshTarget,
  refreshInteractiveStoryCanvasFromToolFrame,
} from "@/features/freezone/interactiveStoryCanvasRefresh";

const successfulPatchFrame = {
  type: "agent.tool.updated" as const,
  scope: { kind: "project", id: "project-a", canvasId: "canvas-a" },
  name: "dramaclaw_patch_interactive_story",
  status: "completed",
  result_json: {
    ok: true,
    canvas_id: "canvas-a",
    revision: 4,
    refresh_canvas: true,
  },
};

describe("interactive story canvas refresh", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("extracts the current canvas from a nested Codex MCP write receipt", () => {
    expect(interactiveStoryRefreshTarget({
      type: "agent.tool.updated",
      scope: { kind: "project", id: "project-a", surface: "freezone", canvasId: "canvas-a" },
      name: "dramaclaw.dramaclaw_patch_interactive_story",
      status: "completed",
      output: {
        content: [{
          type: "text",
          text: JSON.stringify({
            ok: true,
            canvas_id: "canvas-a",
            revision: 4,
            refresh_canvas: true,
          }),
        }],
      },
    })).toEqual({ project: "project-a", canvasId: "canvas-a" });
  });

  it("refreshes the canvas after an agent outline save", () => {
    expect(interactiveStoryRefreshTarget({
      type: "agent.tool.updated",
      scope: { kind: "project", id: "project-a", canvasId: "canvas-a" },
      name: "dramaclaw_save_interactive_story_outline",
      status: "completed",
      result_json: {
        ok: true,
        canvas_id: "canvas-a",
        outline_id: "outline-round-1",
        status: "pending",
        revision: 5,
        refresh_canvas: true,
      },
    })).toEqual({ project: "project-a", canvasId: "canvas-a" });
  });

  it("refreshes the canvas after an explicit stage confirmation", () => {
    expect(interactiveStoryRefreshTarget({
      type: "agent.tool.updated",
      scope: { kind: "project", id: "project-a", canvasId: "canvas-a" },
      name: "dramaclaw_confirm_interactive_story_stages",
      status: "completed",
      result_json: {
        ok: true,
        canvas_id: "canvas-a",
        story_id: "story-a",
        revision: 6,
        confirmed_stages: ["characters", "scenes"],
        refresh_canvas: true,
      },
    })).toEqual({ project: "project-a", canvasId: "canvas-a" });
  });

  it("ignores outline reads that carry no canvas write", () => {
    expect(interactiveStoryRefreshTarget({
      type: "agent.tool.updated",
      scope: { kind: "project", id: "project-a", canvasId: "canvas-a" },
      name: "dramaclaw_get_interactive_story_outline",
      status: "completed",
      result_json: { ok: true, canvas_id: "canvas-a", revision: 5 },
    })).toBeNull();
  });

  it("ignores validation and failed writes", () => {
    expect(interactiveStoryRefreshTarget({
      type: "agent.tool.updated",
      scope: { kind: "project", id: "project-a", canvasId: "canvas-a" },
      name: "dramaclaw_validate_interactive_story",
      status: "completed",
      result_json: { ok: true, canvas_id: "canvas-a" },
    })).toBeNull();
    expect(interactiveStoryRefreshTarget({
      type: "agent.tool.updated",
      scope: { kind: "project", id: "project-a", canvasId: "canvas-a" },
      name: "dramaclaw_create_interactive_story",
      status: "failed",
      result_json: { ok: false },
    })).toBeNull();
  });

  it("refreshes the agent's committed canvas without saving the stale local revision", async () => {
    canvasRuntime.refreshRemoteFreezoneCanvas.mockResolvedValue(true);

    await expect(
      refreshInteractiveStoryCanvasFromToolFrame(successfulPatchFrame),
    ).resolves.toBe(true);

    expect(canvasRuntime.refreshRemoteFreezoneCanvas).toHaveBeenCalledWith(
      "project-a",
      "canvas-a",
      {
        protectUnsavedLocalEdits: true,
        conflictMessage:
          "Agent 已更新画布，但你还有未保存的本地修改。请保留副本或刷新后继续。",
      },
    );
  });

  it.each([
    undefined,
    { ok: false, code: "revision_conflict" },
    { ok: true, refresh_canvas: false },
    { ok: true },
  ])("does not refresh a completed tool without a successful write receipt: %j", async (result_json) => {
    const frame = { ...successfulPatchFrame, result_json };
    expect(interactiveStoryRefreshTarget(frame)).toBeNull();
    await expect(refreshInteractiveStoryCanvasFromToolFrame(frame)).resolves.toBe(false);
    expect(canvasRuntime.refreshRemoteFreezoneCanvas).not.toHaveBeenCalled();
  });

  it("reports a protected refresh that was blocked by genuine local edits", async () => {
    canvasRuntime.refreshRemoteFreezoneCanvas.mockResolvedValue(false);

    await expect(
      refreshInteractiveStoryCanvasFromToolFrame(successfulPatchFrame),
    ).resolves.toBe(false);

    expect(canvasRuntime.refreshRemoteFreezoneCanvas).toHaveBeenCalledTimes(1);
  });
});
