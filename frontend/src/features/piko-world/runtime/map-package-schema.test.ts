// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from "vitest";

import {
  PikoEnvironmentSchema,
  PikoInteractionsSchema,
  PikoMapManifestSchema,
  PikoMapPackageSchema,
  PikoNavigationSchema,
  PikoOcclusionSchema,
} from "./map-package-schema";

import environment from "../../../../public/piko/world/maps/welcome-courtyard/data/environment.json";
import interactions from "../../../../public/piko/world/maps/welcome-courtyard/data/interactions.json";
import manifest from "../../../../public/piko/world/maps/welcome-courtyard/manifest.json";
import navigation from "../../../../public/piko/world/maps/welcome-courtyard/data/navigation.json";
import occlusion from "../../../../public/piko/world/maps/welcome-courtyard/data/occlusion.json";

describe("Piko World map package contract", () => {
  it("accepts the welcome courtyard package with draft navigation", () => {
    expect(PikoMapManifestSchema.parse(manifest).mapId).toBe("welcome-courtyard");
    expect(PikoNavigationSchema.parse(navigation).walkableAreas).toHaveLength(3);
    expect(PikoOcclusionSchema.parse(occlusion).occluders).toEqual([]);
    expect(PikoInteractionsSchema.parse(interactions).interactions).toEqual([]);
    expect(PikoEnvironmentSchema.parse(environment).effects).toEqual([]);
    expect(
      PikoMapPackageSchema.parse({ manifest, navigation, occlusion, interactions, environment })
        .manifest.mapId,
    ).toBe("welcome-courtyard");
  });

  it("rejects assets outside the map package", () => {
    expect(() =>
      PikoMapManifestSchema.parse({
        ...manifest,
        baseTexture: { ...manifest.baseTexture, src: "../reference/master.png" },
      }),
    ).toThrow();
  });

  it("rejects data belonging to another map", () => {
    expect(() =>
      PikoMapPackageSchema.parse({
        manifest,
        navigation: { ...navigation, mapId: "whispering-forest" },
        occlusion,
        interactions,
        environment,
      }),
    ).toThrow();
  });
});
