// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from "vitest";

import { PREVIZ_SCENE_BYTE_LIMITS } from "@/features/previz/domain/limits";
import { PREVIZ_SCHEMA_VERSION, createDefaultScene, type PrevizProp } from "@/features/previz/domain/scene";
import { buildNodeScenePatch, loadNodeScene } from "@/features/previz/nodeScene";

describe("previz node scene adapter", () => {
  it("loads a default scene when the node has never been opened", () => {
    const result = loadNodeScene(undefined);

    expect(result).toEqual({ ok: true, scene: createDefaultScene() });
  });

  it("reports a version mismatch instead of throwing", () => {
    const result = loadNodeScene({ schemaVersion: PREVIZ_SCHEMA_VERSION + 1 });

    expect(result).toEqual({ ok: false, reason: "version", schemaVersion: PREVIZ_SCHEMA_VERSION + 1 });
  });

  it("builds a patch carrying the scene and its summary", () => {
    const scene = createDefaultScene();
    scene.settings.durationFrames = 240;
    scene.objects.push({
      id: "prop-1",
      kind: "prop",
      name: "长椅",
      transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      visible: true,
      locked: false,
      assetUrl: "/static/bench.glb",
      assetFormat: "glb",
    });

    // 先快照再调用：期望值若直接复用 scene 引用，就是自己和自己比，
    // 实现哪怕把 displayMode / 时间轴改花了也照样绿。
    const expected = structuredClone(scene);
    const result = buildNodeScenePatch(scene);

    expect(result).toEqual({
      ok: true,
      patch: { scene: expected, summary: { objectCount: 1, durationFrames: 240 } },
    });
  });

  it("refuses to write a scene that would threaten the whole-canvas payload cap", () => {
    const scene = createDefaultScene();
    const filler: PrevizProp = {
      id: "p",
      kind: "prop",
      name: "x".repeat(PREVIZ_SCENE_BYTE_LIMITS.offload),
      transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      visible: true,
      locked: false,
      assetUrl: "/static/x.glb",
      assetFormat: "glb",
    };
    scene.objects.push(filler);

    const result = buildNodeScenePatch(scene);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("too-large");
      expect(result.bytes).toBeGreaterThanOrEqual(PREVIZ_SCENE_BYTE_LIMITS.offload);
    }
  });

  // 钉住「catch 是选择性的」这个契约：只有版本错误该被收成返回值，别的必须继续抛。
  // 若有人把它改成 catch-all 返回 { ok:false, reason:'version' }，真 bug 会被静默
  // 吞成一条「版本过新」的 UI 提示。构造的对象是合成的，但契约是真的，别删。
  it("lets non-version failures escape instead of masking them as a version mismatch", () => {
    const hostile = {};
    Object.defineProperty(hostile, "schemaVersion", {
      get() {
        throw new TypeError("boom");
      },
      enumerable: true,
    });

    expect(() => loadNodeScene(hostile)).toThrow(TypeError);
  });
});
