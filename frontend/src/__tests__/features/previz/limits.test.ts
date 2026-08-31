// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from "vitest";

import {
  PREVIZ_OBJECT_LIMITS,
  PREVIZ_SCENE_BYTE_LIMITS,
  canAddObject,
  classifySceneSize,
  countObjects,
  estimateSceneBytes,
} from "@/features/previz/domain/limits";
import { createDefaultScene, type PrevizLight, type PrevizScene } from "@/features/previz/domain/scene";

function light(id: string): PrevizLight {
  return {
    id,
    kind: "light",
    name: id,
    transform: { position: [0, 3, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    visible: true,
    locked: false,
    lightType: "key",
    color: "#ffffff",
    intensity: 1,
  };
}

function sceneWithLights(count: number): PrevizScene {
  const scene = createDefaultScene();
  for (let index = 0; index < count; index += 1) scene.objects.push(light(`light-${index}`));
  return scene;
}

describe("previz limits", () => {
  it("counts objects by kind", () => {
    const scene = sceneWithLights(3);

    expect(countObjects(scene, "light")).toBe(3);
    expect(countObjects(scene, "camera")).toBe(0);
  });

  it("blocks creation once a kind reaches its limit", () => {
    expect(canAddObject(createDefaultScene(), "light")).toBe(true);
    expect(canAddObject(sceneWithLights(PREVIZ_OBJECT_LIMITS.light - 1), "light")).toBe(true);
    expect(canAddObject(sceneWithLights(PREVIZ_OBJECT_LIMITS.light), "light")).toBe(false);
    expect(canAddObject(sceneWithLights(PREVIZ_OBJECT_LIMITS.light), "camera")).toBe(true);
  });

  it("classifies scene size at the warn and offload thresholds", () => {
    expect(classifySceneSize(0)).toBe("ok");
    expect(classifySceneSize(PREVIZ_SCENE_BYTE_LIMITS.warn - 1)).toBe("ok");
    expect(classifySceneSize(PREVIZ_SCENE_BYTE_LIMITS.warn)).toBe("warn");
    expect(classifySceneSize(PREVIZ_SCENE_BYTE_LIMITS.offload - 1)).toBe("warn");
    expect(classifySceneSize(PREVIZ_SCENE_BYTE_LIMITS.offload)).toBe("offload");
  });

  it("treats non-finite input as the strictest tier", () => {
    // 判错的代价是丢掉整张画布的自动保存，所以脏输入必须往严的方向倒。
    expect(classifySceneSize(Number.NaN)).toBe("offload");
    expect(classifySceneSize(Number.POSITIVE_INFINITY)).toBe("offload");
    expect(classifySceneSize(-1)).toBe("ok");
  });

  it("feeds its own byte estimate into the size verdict", () => {
    expect(classifySceneSize(estimateSceneBytes(createDefaultScene()))).toBe("ok");
  });

  it("measures UTF-8 bytes, not JS string length", () => {
    const cjk = createDefaultScene();
    cjk.objects.push({ ...light("l"), name: "主光" });
    const ascii = createDefaultScene();
    ascii.objects.push({ ...light("l"), name: "ab" });

    // 两个场景的 JSON 字符数相同，但「主光」每字符占 3 个 UTF-8 字节而非 1 个。
    // 按 String.length 估算会低估 4 字节 —— 护栏必须按字节算，否则中文场景会漏过阈值。
    expect(JSON.stringify(cjk).length).toBe(JSON.stringify(ascii).length);
    expect(estimateSceneBytes(cjk)).toBe(estimateSceneBytes(ascii) + 4);
  });
});
