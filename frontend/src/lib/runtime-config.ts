// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { z } from "zod";

export const RuntimeConfigResponse = z.object({
  ok: z.literal(true),
  data: z.object({
    edition: z.enum(["ce", "ee"]),
    auth_required: z.boolean(),
    instance_id: z.string().optional(),
    mcp_direct_canvas_apply: z.boolean().optional(),
  }),
});

export interface RuntimeConfig {
  edition: "ce" | "ee";
  authRequired: boolean;
  instanceId?: string;
  mcpDirectCanvasApply: boolean;
}

let runtimeConfig: RuntimeConfig = {
  edition: "ee",
  authRequired: true,
  mcpDirectCanvasApply: false,
};

function fallbackRuntimeConfig(): RuntimeConfig {
  return import.meta.env.VITE_EDITION === "ce"
    ? { edition: "ce", authRequired: false, mcpDirectCanvasApply: false }
    : { edition: "ee", authRequired: true, mcpDirectCanvasApply: false };
}

export async function loadRuntimeConfig(): Promise<void> {
  try {
    const response = await fetch("/api/v1/config", { credentials: "include", cache: "no-store" });
    if (!response.ok) throw new Error(`GET /api/v1/config -> ${response.status}`);
    const body = await response.json();
    const parsed = RuntimeConfigResponse.parse(body);
    runtimeConfig = {
      edition: parsed.data.edition,
      authRequired: parsed.data.auth_required,
      instanceId: parsed.data.instance_id,
      mcpDirectCanvasApply: parsed.data.mcp_direct_canvas_apply ?? false,
    };
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn("[runtime-config] load failed:", error);
    runtimeConfig = fallbackRuntimeConfig();
  }
}

export function isCeRuntime(): boolean {
  return runtimeConfig.edition === "ce";
}

export function authRequired(): boolean {
  return runtimeConfig.authRequired;
}

export function mcpDirectCanvasApplyEnabled(): boolean {
  return runtimeConfig.mcpDirectCanvasApply;
}
