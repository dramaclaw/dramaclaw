// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { z } from "zod";

export const RuntimeConfigResponse = z.object({
  ok: z.literal(true),
  data: z.object({
    edition: z.enum(["ce", "ee"]),
    auth_required: z.boolean(),
    instance_id: z.string().optional(),
  }),
});

const AuthUiConfigResponse = z.object({
  ok: z.literal(true),
  data: z.object({
    phone_otp_entry_visible: z.boolean(),
  }),
});

export interface RuntimeConfig {
  edition: "ce" | "ee";
  authRequired: boolean;
  phoneOtpEntryVisible: boolean;
  instanceId?: string;
}

let runtimeConfig: RuntimeConfig = {
  edition: "ee",
  authRequired: true,
  phoneOtpEntryVisible: false,
};

function fallbackRuntimeConfig(): RuntimeConfig {
  return import.meta.env.VITE_EDITION === "ce"
    ? { edition: "ce", authRequired: false, phoneOtpEntryVisible: false }
    : { edition: "ee", authRequired: true, phoneOtpEntryVisible: false };
}

async function loadPhoneOtpEntryVisibility(): Promise<boolean> {
  try {
    const response = await fetch("/api/v1/auth/ui-config", {
      credentials: "include",
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`GET /api/v1/auth/ui-config -> ${response.status}`);
    const body = await response.json();
    return AuthUiConfigResponse.parse(body).data.phone_otp_entry_visible;
  } catch (error) {
    // Older or temporarily unavailable EE backends must keep the entry dark.
    // eslint-disable-next-line no-console
    console.warn("[runtime-config] auth UI config load failed:", error);
    return false;
  }
}

export async function loadRuntimeConfig(): Promise<void> {
  try {
    const response = await fetch("/api/v1/config", { credentials: "include", cache: "no-store" });
    if (!response.ok) throw new Error(`GET /api/v1/config -> ${response.status}`);
    const body = await response.json();
    const parsed = RuntimeConfigResponse.parse(body);
    const phoneOtpEntryVisible =
      parsed.data.edition === "ee" ? await loadPhoneOtpEntryVisibility() : false;
    runtimeConfig = {
      edition: parsed.data.edition,
      authRequired: parsed.data.auth_required,
      phoneOtpEntryVisible,
      instanceId: parsed.data.instance_id,
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

export function phoneOtpEntryVisible(): boolean {
  return runtimeConfig.phoneOtpEntryVisible;
}
