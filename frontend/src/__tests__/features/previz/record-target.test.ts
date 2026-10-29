// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from "vitest";

import { resolveRecordTarget } from "@/features/previz/capture/recordTarget";
import { createPrevizObject } from "@/features/previz/domain/objects";
import { createDefaultScene, type PrevizScene } from "@/features/previz/domain/scene";

function sceneWith(...kinds: ("camera" | "character")[]): PrevizScene {
  const scene = createDefaultScene();
  for (const kind of kinds) scene.objects.push(createPrevizObject(kind, scene.objects));
  return scene;
}

describe("resolveRecordTarget", () => {
  it("records the director view without needing a camera", () => {
    expect(resolveRecordTarget(createDefaultScene(), "global", null, null)).toEqual({
      mode: "global",
      cameraId: null,
      index: null,
    });
  });

  it("records the selected camera, numbered by its place among the cameras", () => {
    const scene = sceneWith("camera", "camera");
    const second = scene.objects[1]!.id;

    expect(resolveRecordTarget(scene, "track", second, null)).toEqual({
      mode: "track",
      cameraId: second,
      index: 2,
    });
  });

  // 选中的是人物（在调走位）是常态；那时录右下角正在监看的那台，屏幕上唯一一路
  // 已经在放的镜头画面。
  it("falls back to the monitored camera when the selection is not one", () => {
    const scene = sceneWith("camera", "character");
    const camera = scene.objects[0]!.id;
    const character = scene.objects[1]!.id;

    expect(resolveRecordTarget(scene, "track", character, camera)?.cameraId).toBe(camera);
  });

  // 一台机位都没有时交出 null：默默录成导演视角会得到一段用户没要的画面。
  it("refuses a track recording with no camera in sight", () => {
    const scene = sceneWith("character");

    expect(resolveRecordTarget(scene, "track", scene.objects[0]!.id, null)).toBeNull();
  });

  // 机位刚被删掉、id 还留在 store 里的那一拍。
  it("ignores ids that no longer name a camera", () => {
    expect(resolveRecordTarget(sceneWith("camera"), "track", "gone", "also-gone")).toBeNull();
  });
});
