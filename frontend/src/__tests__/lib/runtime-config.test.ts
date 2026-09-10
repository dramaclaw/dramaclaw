// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { beforeEach, describe, expect, it, vi } from "vitest";

describe("runtime-config", () => {
  const originalEdition = import.meta.env.VITE_EDITION;

  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    if (originalEdition === undefined) {
      delete (import.meta.env as Record<string, unknown>).VITE_EDITION;
    } else {
      (import.meta.env as Record<string, unknown>).VITE_EDITION = originalEdition;
    }
  });

  it("uses /api/v1/config when the fetch succeeds", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ ok: true, data: { edition: "ce", auth_required: false } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    const { authRequired, isCeRuntime, loadRuntimeConfig, phoneOtpEntryVisible } =
      await import("@/lib/runtime-config");
    await loadRuntimeConfig();

    expect(isCeRuntime()).toBe(true);
    expect(authRequired()).toBe(false);
    expect(phoneOtpEntryVisible()).toBe(false);
  });

  it("falls back to auth-required when the fetch fails without VITE_EDITION", async () => {
    delete (import.meta.env as Record<string, unknown>).VITE_EDITION;
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));

    const { authRequired, isCeRuntime, loadRuntimeConfig, phoneOtpEntryVisible } =
      await import("@/lib/runtime-config");
    await loadRuntimeConfig();

    expect(isCeRuntime()).toBe(false);
    expect(authRequired()).toBe(true);
    expect(phoneOtpEntryVisible()).toBe(false);
  });

  it("falls back to CE when VITE_EDITION=ce and the fetch fails", async () => {
    (import.meta.env as Record<string, unknown>).VITE_EDITION = "ce";
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));

    const { authRequired, isCeRuntime, loadRuntimeConfig, phoneOtpEntryVisible } =
      await import("@/lib/runtime-config");
    await loadRuntimeConfig();

    expect(isCeRuntime()).toBe(true);
    expect(authRequired()).toBe(false);
    expect(phoneOtpEntryVisible()).toBe(false);
  });

  it("ignores VITE_EDITION when /api/v1/config succeeds", async () => {
    (import.meta.env as Record<string, unknown>).VITE_EDITION = "ce";
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ ok: true, data: { edition: "ee", auth_required: true } }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              ok: true,
              data: { phone_otp_entry_visible: true },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        ),
    );

    const { authRequired, isCeRuntime, loadRuntimeConfig, phoneOtpEntryVisible } =
      await import("@/lib/runtime-config");
    await loadRuntimeConfig();

    expect(isCeRuntime()).toBe(false);
    expect(authRequired()).toBe(true);
    expect(phoneOtpEntryVisible()).toBe(true);
  });

  it("keeps OTP hidden when the EE UI config cannot be loaded", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ ok: true, data: { edition: "ee", auth_required: true } }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        )
        .mockRejectedValueOnce(new Error("UI config unavailable")),
    );

    const { authRequired, isCeRuntime, loadRuntimeConfig, phoneOtpEntryVisible } =
      await import("@/lib/runtime-config");
    await loadRuntimeConfig();

    expect(isCeRuntime()).toBe(false);
    expect(authRequired()).toBe(true);
    expect(phoneOtpEntryVisible()).toBe(false);
  });
});
