// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { refreshRemoteFreezoneCanvas } from "@/features/freezone/canvasSyncRuntime";
import type { ServerFrame } from "@/features/superchat/types";

const INTERACTIVE_STORY_WRITE_TOOL_NAMES = new Set([
  "dramaclaw_create_interactive_story",
  "dramaclaw_patch_interactive_story",
]);

function nestedJsonObjects(value: unknown): Array<Record<string, unknown>> {
  if (typeof value === "string") {
    try {
      return nestedJsonObjects(JSON.parse(value));
    } catch {
      return [];
    }
  }
  if (Array.isArray(value)) return value.flatMap(nestedJsonObjects);
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  return [record, ...Object.values(record).flatMap(nestedJsonObjects)];
}

export function interactiveStoryRefreshTarget(
  frame: ServerFrame,
): { project: string; canvasId: string } | null {
  if (frame.type !== "agent.tool.updated") return null;
  const nameParts = String(frame.name ?? "").split(".");
  const name = nameParts[nameParts.length - 1] ?? "";
  if (!INTERACTIVE_STORY_WRITE_TOOL_NAMES.has(name)) return null;
  if (
    frame.error ||
    !["completed", "success", "succeeded"].includes(
      String(frame.status ?? "").toLowerCase(),
    )
  ) {
    return null;
  }
  const payload = [frame.result_json, frame.output]
    .flatMap(nestedJsonObjects)
    .find((item) => item.ok === true && item.refresh_canvas === true);
  const scope = frame.scope as { id?: string | null; canvasId?: string | null } | undefined;
  const project = String(scope?.id ?? "").trim();
  const canvasId = String(payload?.canvas_id ?? scope?.canvasId ?? "").trim();
  return project && canvasId ? { project, canvasId } : null;
}

export async function refreshInteractiveStoryCanvasFromToolFrame(
  frame: ServerFrame,
): Promise<boolean> {
  const target = interactiveStoryRefreshTarget(frame);
  if (!target) return false;
  return await refreshRemoteFreezoneCanvas(target.project, target.canvasId, {
    protectUnsavedLocalEdits: true,
    conflictMessage:
      "Agent 已更新画布，但你还有未保存的本地修改。请保留副本或刷新后继续。",
  });
}
