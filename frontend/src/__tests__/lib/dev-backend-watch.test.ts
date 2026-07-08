// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function configResponse(edition: "ce" | "ee", instanceId?: string) {
  return new Response(
    JSON.stringify({
      ok: true,
      data: {
        edition,
        auth_required: edition === "ee",
        ...(instanceId ? { instance_id: instanceId } : {}),
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("dev-backend-watch", () => {
  const originalDev = import.meta.env.DEV;

  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.stubEnv("DEV", true);
    window.history.replaceState(null, "", "/projects/demo");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.stubEnv("DEV", originalDev);
  });

  it("hard-refreshes to the home page once when the backend instance changes", async () => {
    const assign = vi.fn();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(configResponse("ee", "instance-a"))
      .mockResolvedValueOnce(configResponse("ee", "instance-b"))
      .mockResolvedValueOnce(configResponse("ce", "instance-c"));
    vi.stubGlobal("fetch", fetch);
    vi.stubGlobal("location", { ...window.location, assign });

    const { initDevBackendWatch } = await import("@/lib/dev-backend-watch");
    const teardown = initDevBackendWatch();
    await vi.runOnlyPendingTimersAsync();
    await vi.runOnlyPendingTimersAsync();

    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith("/");
    expect(fetch).toHaveBeenCalledWith("/api/v1/config", {
      credentials: "include",
      cache: "no-store",
    });

    teardown();
  });

  it("falls back to comparing edition when instance_id is absent", async () => {
    const assign = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(configResponse("ee"))
        .mockResolvedValueOnce(configResponse("ce")),
    );
    vi.stubGlobal("location", { ...window.location, assign });

    const { initDevBackendWatch } = await import("@/lib/dev-backend-watch");
    const teardown = initDevBackendWatch();
    await vi.runOnlyPendingTimersAsync();
    await vi.runOnlyPendingTimersAsync();

    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith("/");

    teardown();
  });

  it("does not refresh when the backend identity is unchanged", async () => {
    const assign = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(configResponse("ce", "same-instance"))
        .mockResolvedValueOnce(configResponse("ce", "same-instance")),
    );
    vi.stubGlobal("location", { ...window.location, assign });

    const { initDevBackendWatch } = await import("@/lib/dev-backend-watch");
    const teardown = initDevBackendWatch();
    await vi.runOnlyPendingTimersAsync();
    await vi.runOnlyPendingTimersAsync();

    expect(assign).not.toHaveBeenCalled();

    teardown();
  });

  it("does not hard-refresh preauth pages when the backend instance changes", async () => {
    window.history.replaceState(null, "", "/login");
    const assign = vi.fn();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(configResponse("ee", "instance-a"))
      .mockResolvedValueOnce(configResponse("ee", "instance-b"))
      .mockResolvedValueOnce(configResponse("ee", "instance-b"));
    vi.stubGlobal("fetch", fetch);
    vi.stubGlobal("location", { ...window.location, assign });

    const { initDevBackendWatch } = await import("@/lib/dev-backend-watch");
    const teardown = initDevBackendWatch();
    await vi.runOnlyPendingTimersAsync();
    await vi.runOnlyPendingTimersAsync();
    await vi.runOnlyPendingTimersAsync();

    expect(assign).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(3);

    teardown();
  });

  it("does not start outside dev mode", async () => {
    const fetch = vi.fn();
    vi.stubEnv("DEV", false);
    vi.stubGlobal("fetch", fetch);

    const { initDevBackendWatch } = await import("@/lib/dev-backend-watch");
    const teardown = initDevBackendWatch();
    await vi.runOnlyPendingTimersAsync();

    expect(fetch).not.toHaveBeenCalled();

    teardown();
  });
});
