// SPDX-License-Identifier: Elastic-2.0
import { expect, it } from "vitest";
import occlusion from "../../../../public/piko/world/maps/welcome-courtyard/data/occlusion.json";
import { PikoOcclusionSchema } from "./map-package-schema";
import { courtyardFoliageOccluders } from "./courtyard-foliage-runtime";

it("classifies courtyard foliage once for rendering and actor occlusion", () => {
  const foliage = courtyardFoliageOccluders(PikoOcclusionSchema.parse(occlusion));
  expect(foliage.animatedTree?.id).toBe("east-canopy-tree");
  expect([...foliage.bakedActorOcclusionExclusions].map(item => item.id)).toEqual([
    "east-canopy-tree", "west-grove-rear-pine",
  ]);
  expect([...foliage.occluderRenderExclusions].map(item => item.id)).toEqual([
    "east-willow-canopy", "west-hall-pine",
  ]);
});
