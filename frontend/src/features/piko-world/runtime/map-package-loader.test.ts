// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { afterEach, describe, expect, it, vi } from "vitest";

import manifest from "../../../../public/piko/world/maps/welcome-courtyard/manifest.json";
import navigation from "../../../../public/piko/world/maps/welcome-courtyard/data/navigation.json";
import { loadPikoMapManifest, loadPikoMapNavigation } from "./map-package-loader";

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
});
