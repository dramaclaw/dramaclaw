// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { beforeEach, describe, expect, it } from "vitest";

import {
  PREVIZ_OBJECT_LIMITS,
  PREVIZ_PRIMITIVE_LIMIT,
  canAddObject,
  canAddPrimitive,
  countObjects,
  countPrimitives,
} from "@/features/previz/domain/limits";
import { createDefaultScene, type PrevizProp, type PrevizScene } from "@/features/previz/domain/scene";
import { usePrevizStore } from "@/features/previz/store";

function prop(id: string, assetFormat: PrevizProp["assetFormat"]): PrevizProp {
  return {
    id,
    kind: "prop",
    name: id,
    transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    visible: true,
    locked: false,
    assetUrl: assetFormat === "primitive" ? "cube" : `/static/${id}.glb`,
    assetFormat,
  };
}

function sceneWith(models: number, primitives: number): PrevizScene {
  const scene = createDefaultScene();
  for (let index = 0; index < models; index += 1) scene.objects.push(prop(`model-${index}`, "glb"));
  for (let index = 0; index < primitives; index += 1) {
    scene.objects.push(prop(`primitive-${index}`, "primitive"));
  }
  return scene;
}

describe("previz primitive limit", () => {
  it("is 150 and leaves the imported-model limit alone", () => {
    expect(PREVIZ_PRIMITIVE_LIMIT).toBe(150);
    expect(PREVIZ_OBJECT_LIMITS.prop).toBe(200);
  });

  it("counts primitives and imported models apart", () => {
    const scene = sceneWith(3, 7);

    expect(countObjects(scene, "prop")).toBe(3);
    expect(countPrimitives(scene)).toBe(7);
  });

  it("counts primitives against their own limit only", () => {
    const scene = sceneWith(0, PREVIZ_PRIMITIVE_LIMIT - 1);

    expect(canAddPrimitive(scene)).toBe(true);
    expect(canAddObject(scene, "prop")).toBe(true);
  });

  it("stops primitives at their own limit without blocking models", () => {
    const scene = sceneWith(0, PREVIZ_PRIMITIVE_LIMIT);

    expect(canAddPrimitive(sceneWith(0, PREVIZ_PRIMITIVE_LIMIT - 1))).toBe(true);
    expect(canAddPrimitive(scene)).toBe(false);
    expect(canAddObject(scene, "prop")).toBe(true);
  });

  it("stops models at their limit without blocking primitives", () => {
    const scene = sceneWith(PREVIZ_OBJECT_LIMITS.prop, 0);

    expect(canAddObject(scene, "prop")).toBe(false);
    expect(canAddPrimitive(scene)).toBe(true);
  });
});

describe("previz store addObject with the split limit", () => {
  beforeEach(() => {
    usePrevizStore.getState().loadScene(createDefaultScene());
  });

  it("adds a primitive when imported models are full", () => {
    usePrevizStore.getState().loadScene(sceneWith(PREVIZ_OBJECT_LIMITS.prop, 0));

    const id = usePrevizStore
      .getState()
      .addObject("prop", { assetUrl: "cube", assetFormat: "primitive" });

    expect(id).not.toBeNull();
  });

  it("refuses a model when imported models are full", () => {
    usePrevizStore.getState().loadScene(sceneWith(PREVIZ_OBJECT_LIMITS.prop, 0));

    const id = usePrevizStore
      .getState()
      .addObject("prop", { assetUrl: "/static/a.glb", assetFormat: "glb" });

    expect(id).toBeNull();
    expect(usePrevizStore.getState().past).toHaveLength(0);
  });

  it("refuses a primitive when primitives are full", () => {
    usePrevizStore.getState().loadScene(sceneWith(0, PREVIZ_PRIMITIVE_LIMIT));

    const id = usePrevizStore
      .getState()
      .addObject("prop", { assetUrl: "cube", assetFormat: "primitive" });

    expect(id).toBeNull();
    expect(usePrevizStore.getState().scene.objects).toHaveLength(PREVIZ_PRIMITIVE_LIMIT);
  });
});
