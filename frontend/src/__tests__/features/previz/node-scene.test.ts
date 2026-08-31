// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from "vitest";

import { PREVIZ_SCENE_BYTE_LIMITS } from "@/features/previz/domain/limits";
import { PREVIZ_SCHEMA_VERSION, createDefaultScene, type PrevizProp } from "@/features/previz/domain/scene";
import { buildNodeScenePatch, loadNodeScene } from "@/features/previz/nodeScene";

describe("previz node scene adapter", () => {
  it("loads a default scene when the node has never been opened", () => {
    const result = loadNodeScene(undefined);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.scene).toEqual(createDefaultScene());
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

    const result = buildNodeScenePatch(scene);

    expect(result).toEqual({
      ok: true,
      patch: { scene, summary: { objectCount: 1, durationFrames: 240 } },
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
});
