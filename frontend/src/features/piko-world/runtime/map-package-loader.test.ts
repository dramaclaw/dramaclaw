// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { afterEach, describe, expect, it, vi } from "vitest";

import manifest from "../../../../public/piko/world/maps/welcome-courtyard/manifest.json";
import navigation from "../../../../public/piko/world/maps/welcome-courtyard/data/navigation.json";
import { loadPikoMapManifest, loadPikoMapNavigation, loadPikoMapOcclusion, loadPikoMapInteractions } from "./map-package-loader";
import interactions from "../../../../public/piko/world/maps/welcome-courtyard/data/interactions.json";
import occlusion from "../../../../public/piko/world/maps/welcome-courtyard/data/occlusion.json";

function mockJsonResponse(value: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => value,
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Piko World map package loader", () => {
  it("validates interaction ownership and forwards cancellation", async () => {
    mockJsonResponse(interactions);
    const { signal } = new AbortController();
    expect((await loadPikoMapInteractions("welcome-courtyard", "data/interactions.json", signal)).interactions).toHaveLength(1);
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining("/welcome-courtyard/data/interactions.json"), { cache: "no-cache", signal });
    await expect(loadPikoMapInteractions("artisan-market", "data/interactions.json")).rejects.toThrow("requested artisan-market");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404 }));
    await expect(loadPikoMapInteractions("welcome-courtyard", "data/interactions.json")).rejects.toThrow("404");
  });
  it("rejects a manifest belonging to another requested map", async () => {
    mockJsonResponse(manifest);
    await expect(loadPikoMapManifest("artisan-market")).rejects.toThrow(
      "requested artisan-market, received welcome-courtyard",
    );
  });

  it("rejects navigation belonging to another requested map", async () => {
    mockJsonResponse(navigation);
    await expect(
      loadPikoMapNavigation("artisan-market", "data/navigation.json"),
    ).rejects.toThrow("requested artisan-market, received welcome-courtyard");
  });

  it("loads occlusion with cancellation and rejects another map's silhouettes", async () => {
    mockJsonResponse(occlusion);
    const controller = new AbortController();
    expect((await loadPikoMapOcclusion("welcome-courtyard", "data/occlusion.json", controller.signal)).occluders).toHaveLength(32);
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining("/welcome-courtyard/data/occlusion.json"), {
      cache: "no-cache", signal: controller.signal,
    });
    await expect(loadPikoMapOcclusion("artisan-market", "data/occlusion.json")).rejects.toThrow("requested artisan-market");
  });

  it("reports missing occlusion instead of silently allowing characters through scenery", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404 }));
    await expect(loadPikoMapOcclusion("welcome-courtyard", "data/occlusion.json")).rejects.toThrow("404");
  });
});
