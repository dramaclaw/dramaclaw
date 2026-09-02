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

  it("reports a protected refresh that was blocked by genuine local edits", async () => {
    canvasRuntime.refreshRemoteFreezoneCanvas.mockResolvedValue(false);

    await expect(
      refreshInteractiveStoryCanvasFromToolFrame(successfulPatchFrame),
    ).resolves.toBe(false);

    expect(canvasRuntime.refreshRemoteFreezoneCanvas).toHaveBeenCalledTimes(1);
  });
});
