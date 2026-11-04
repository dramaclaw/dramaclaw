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
    expect(PikoNavigationSchema.parse(navigation).walkableAreas).toHaveLength(1);
    expect(PikoOcclusionSchema.parse(occlusion).occluders.map(item => item.id)).toEqual([
      "welcome-arch-beam", "welcome-arch-west-pillar", "welcome-arch-east-pillar",
      "east-canopy-tree",
      "central-fountain-statue", "central-fountain-basin",
      "west-noticeboard-north-panel", "west-noticeboard-north-stand",
      "west-noticeboard-south-panel", "west-noticeboard-south-stand", "west-noticeboard-south-brace",
      "west-garden-lamp", "west-garden-canopy",
      "west-pavilion-building", "west-noticeboard-lamp", "west-grove-edge-pine",
      "west-grove-rear-pine", "west-grove-front-pine", "west-grove-stone-planter",
      "town-hall-roof", "west-boulder-shrub",
      "east-gate-pine", "east-bridge-south-parapet",
      "southeast-tall-pine", "southeast-path-shrub",
      "southwest-fence-lamp", "south-path-west-lamp", "south-path-east-lamp",
      "south-edge-west-grove", "south-edge-path-pine",
      "east-willow-canopy",
      "west-hall-pine",
    ]);
    expect(PikoInteractionsSchema.parse(interactions).interactions).toMatchObject([{
      id: "east-bench-seat", kind: "seat", actionId: "welcome-east-bench",
      trigger: { id: "east-bench-seat-hitbox" },
    }]);
    expect(PikoEnvironmentSchema.parse(environment).effects.map(effect => effect.kind)).toEqual(Array(35).fill("sprite"));
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
