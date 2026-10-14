// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { beforeEach, describe, expect, it } from "vitest";

import { hasBlockout, planBlockoutImport } from "@/features/previz/domain/blockout";
import {
  PREVIZ_OBJECT_LIMITS,
  PREVIZ_PRIMITIVE_LIMIT,
  PREVIZ_SCENE_BYTE_LIMITS,
} from "@/features/previz/domain/limits";
import {
  createDefaultScene,
  parseScene,
  type PrevizCamera,
  type PrevizProp,
  type PrevizScene,
} from "@/features/previz/domain/scene";
import { usePrevizStore } from "@/features/previz/store";

const TRANSFORM = { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] };

/** 后端 `compile_scene` 吐出来的一件几何体的样子。 */
function piece(name: string, extra: Record<string, unknown> = {}) {
  return {
    id: `blockout-${name}`,
    kind: "prop",
    name,
    transform: TRANSFORM,
    visible: true,
    locked: false,
    assetUrl: "cube",
    assetFormat: "primitive",
    blockout: { id: name, semanticType: "prop" },
    ...extra,
  };
}

function referenceCamera(extra: Record<string, unknown> = {}) {
  return {
    id: "blockout-cam",
    kind: "camera",
    name: "参考机位",
    transform: TRANSFORM,
    visible: true,
    locked: false,
    focalMm: 28,
    aperture: 2.8,
    sensor: "ff",
    cameraBody: "cine",
    lensSeries: "prime",
    blockout: { id: "cam", semanticType: "reference_camera" },
    ...extra,
  };
}

function payload(count = 3) {
  return {
    objects: [
      ...Array.from({ length: count }, (_, index) => piece(`box_${index}`)),
      referenceCamera(),
    ],
    referenceCameraId: "blockout-cam",
  };
}

function handPlaced(id: string, assetFormat: PrevizProp["assetFormat"] = "primitive"): PrevizProp {
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

function handCamera(id: string): PrevizCamera {
  return {
    id,
    kind: "camera",
    name: id,
    transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    visible: true,
    locked: false,
    focalMm: 50,
    aperture: 2.8,
    sensor: "ff",
    cameraBody: "cine",
    lensSeries: "prime",
  };
}

function sceneWith(objects: PrevizScene["objects"]): PrevizScene {
  const scene = createDefaultScene();
  return { ...scene, objects };
}

function mustPlan(...args: Parameters<typeof planBlockoutImport>) {
  const plan = planBlockoutImport(...args);
  if (!plan.ok) throw new Error(`rejected: ${JSON.stringify(plan.rejection)}`);
  return plan;
}

describe("planBlockoutImport", () => {
  it("adds every piece and the reference camera to an empty scene", () => {
    const plan = mustPlan(createDefaultScene(), payload(3), "replace");

    expect(plan.scene.objects.map((object) => object.id)).toEqual([
      "blockout-box_0",
      "blockout-box_1",
      "blockout-box_2",
      "blockout-cam",
    ]);
    expect(plan.referenceCameraId).toBe("blockout-cam");
    expect(plan.addedIds).toHaveLength(4);
    expect(plan.removedIds).toEqual([]);
    expect(plan.dropped).toBe(0);
  });

  it("does not touch the scene it was given", () => {
    const scene = sceneWith([handPlaced("mine")]);
    const snapshot = JSON.stringify(scene);

    mustPlan(scene, payload(), "replace");

    expect(JSON.stringify(scene)).toBe(snapshot);
  });

  it("produces a scene that reads back unchanged", () => {
    // 写进去的东西要经得起一次存盘再打开：`parseScene` 改掉任何一处都说明这里放进了脏数据。
    const plan = mustPlan(sceneWith([handPlaced("mine")]), payload(), "replace");

    expect(parseScene(JSON.parse(JSON.stringify(plan.scene)))).toEqual(plan.scene);
  });

  describe("replace", () => {
    it("removes only objects carrying the tag", () => {
      const first = mustPlan(
        sceneWith([handPlaced("mine"), handPlaced("model", "glb"), handCamera("my-cam")]),
        payload(2),
        "replace",
      );

      const second = mustPlan(first.scene, { objects: [piece("fresh"), referenceCamera()], referenceCameraId: "blockout-cam" }, "replace");

      expect(second.scene.objects.map((object) => object.id)).toEqual([
        "mine",
        "model",
        "my-cam",
        "blockout-fresh",
        "blockout-cam",
      ]);
      expect(second.removedIds.sort()).toEqual(["blockout-box_0", "blockout-box_1", "blockout-cam"]);
    });

    it("takes the tracks and cuts of removed objects with them", () => {
      const first = mustPlan(sceneWith([handCamera("my-cam")]), payload(1), "replace");
      const scene: PrevizScene = {
        ...first.scene,
        timeline: {
          ...first.scene.timeline,
          tracks: [
            { id: "t-old", objectId: "blockout-cam", clips: [] },
            { id: "t-keep", objectId: "my-cam", clips: [] },
          ] as unknown as PrevizScene["timeline"]["tracks"],
          program: [
            { id: "c-old", cameraId: "blockout-cam", startFrame: 0, endFrame: 10 },
            { id: "c-keep", cameraId: "my-cam", startFrame: 10, endFrame: 20 },
          ] as unknown as PrevizScene["timeline"]["program"],
        },
      };

      const plan = mustPlan(scene, payload(1), "replace");

      expect(plan.scene.timeline.tracks.map((track) => track.id)).toEqual(["t-keep"]);
      expect(plan.scene.timeline.program.map((cut) => cut.id)).toEqual(["c-keep"]);
    });

    it("frees the slots of the blockout it replaces", () => {
      const full = mustPlan(createDefaultScene(), payload(PREVIZ_PRIMITIVE_LIMIT), "replace");

      const plan = planBlockoutImport(full.scene, payload(PREVIZ_PRIMITIVE_LIMIT), "replace");

      expect(plan.ok).toBe(true);
    });
  });

  describe("append", () => {
    it("keeps the earlier blockout and renames colliding ids", () => {
      const first = mustPlan(createDefaultScene(), payload(1), "replace");

      const plan = mustPlan(first.scene, payload(1), "append");

      const ids = plan.scene.objects.map((object) => object.id);
      expect(ids).toEqual(["blockout-box_0", "blockout-cam", "blockout-box_0-2", "blockout-cam-2"]);
      expect(new Set(ids).size).toBe(ids.length);
      expect(plan.removedIds).toEqual([]);
    });

    it("points the reference camera at the renamed camera", () => {
      const first = mustPlan(createDefaultScene(), payload(1), "replace");

      const plan = mustPlan(first.scene, payload(1), "append");

      expect(plan.referenceCameraId).toBe("blockout-cam-2");
    });

    it("keeps counting up on a third import", () => {
      const first = mustPlan(createDefaultScene(), payload(1), "replace");
      const second = mustPlan(first.scene, payload(1), "append");

      const third = mustPlan(second.scene, payload(1), "append");

      expect(third.referenceCameraId).toBe("blockout-cam-3");
    });
  });

  it("renames an id that collides with a hand-placed object", () => {
    const plan = mustPlan(sceneWith([handPlaced("blockout-box_0")]), payload(1), "replace");

    expect(plan.scene.objects.map((object) => object.id)).toEqual([
      "blockout-box_0",
      "blockout-box_0-2",
      "blockout-cam",
    ]);
  });

  it("renames ids repeated inside one payload", () => {
    const plan = mustPlan(
      createDefaultScene(),
      { objects: [piece("a"), piece("a")], referenceCameraId: null },
      "replace",
    );

    expect(plan.scene.objects.map((object) => object.id)).toEqual(["blockout-a", "blockout-a-2"]);
  });

  describe("limits", () => {
    it("accepts exactly 150 primitives", () => {
      const plan = mustPlan(createDefaultScene(), payload(PREVIZ_PRIMITIVE_LIMIT), "replace");

      expect(plan.scene.objects).toHaveLength(PREVIZ_PRIMITIVE_LIMIT + 1);
    });

    it("ignores imported models when counting primitives", () => {
      const models = Array.from({ length: PREVIZ_OBJECT_LIMITS.prop }, (_, index) =>
        handPlaced(`model-${index}`, "glb"),
      );

      const plan = planBlockoutImport(sceneWith(models), payload(PREVIZ_PRIMITIVE_LIMIT), "replace");

      expect(plan.ok).toBe(true);
    });

    it("says how many primitive slots are missing", () => {
      const scene = sceneWith(Array.from({ length: 100 }, (_, index) => handPlaced(`mine-${index}`)));

      const plan = planBlockoutImport(scene, payload(60), "replace");

      expect(plan).toEqual({
        ok: false,
        rejection: { reason: "primitive-limit", missing: 10, limit: PREVIZ_PRIMITIVE_LIMIT },
      });
    });

    it("counts the kept blockout against an append", () => {
      const first = mustPlan(createDefaultScene(), payload(100), "replace");

      const plan = planBlockoutImport(first.scene, payload(60), "append");

      expect(plan).toEqual({
        ok: false,
        rejection: { reason: "primitive-limit", missing: 10, limit: PREVIZ_PRIMITIVE_LIMIT },
      });
    });

    it("says how many camera slots are missing", () => {
      const cameras = Array.from({ length: PREVIZ_OBJECT_LIMITS.camera }, (_, index) =>
        handCamera(`cam-${index}`),
      );

      const plan = planBlockoutImport(sceneWith(cameras), payload(1), "replace");

      expect(plan).toEqual({
        ok: false,
        rejection: { reason: "camera-limit", missing: 1, limit: PREVIZ_OBJECT_LIMITS.camera },
      });
    });

    it("refuses a scene that would cross the offload threshold", () => {
      const scene = sceneWith([
        { ...handPlaced("heavy"), name: "x".repeat(PREVIZ_SCENE_BYTE_LIMITS.offload) },
      ]);

      const plan = planBlockoutImport(scene, payload(1), "replace");

      expect(plan.ok).toBe(false);
      expect(!plan.ok && plan.rejection.reason).toBe("too-large");
    });
  });

  describe("untrusted records", () => {
    it.each([
      ["a model url", piece("m", { assetFormat: "glb", assetUrl: "https://example.com/a.glb" })],
      ["an unknown shape", piece("s", { assetUrl: "teapot" })],
      ["a record without the tag", piece("u", { blockout: undefined })],
      ["a character", { ...piece("c"), kind: "character" }],
      ["a light", { ...piece("l"), kind: "light" }],
      ["a record without an id", piece("n", { id: "" })],
      ["a string", "scene.box()"],
      ["null", null],
    ])("drops %s and keeps the rest", (_label, bad) => {
      const plan = mustPlan(
        createDefaultScene(),
        { objects: [piece("good"), bad], referenceCameraId: null },
        "replace",
      );

      expect(plan.scene.objects.map((object) => object.id)).toEqual(["blockout-good"]);
      expect(plan.dropped).toBe(1);
    });

    it("rejects a payload with nothing usable in it", () => {
      const plan = planBlockoutImport(
        createDefaultScene(),
        { objects: [piece("s", { assetUrl: "teapot" })], referenceCameraId: null },
        "replace",
      );

      expect(plan).toEqual({ ok: false, rejection: { reason: "empty" } });
    });

    it("rejects a payload whose objects are not a list", () => {
      const plan = planBlockoutImport(
        createDefaultScene(),
        { objects: "nope" as unknown as unknown[], referenceCameraId: null },
        "replace",
      );

      expect(plan).toEqual({ ok: false, rejection: { reason: "empty" } });
    });

    it("clamps numbers the same way a stored scene would be", () => {
      const plan = mustPlan(
        createDefaultScene(),
        {
          objects: [
            piece("huge", {
              transform: { position: [0, Number.NaN, 0], rotation: [0, 0, 0], scale: [1e9, 1, -1] },
            }),
            referenceCamera({ focalMm: 9000 }),
          ],
          referenceCameraId: "blockout-cam",
        },
        "replace",
      );

      const [huge, camera] = plan.scene.objects;
      expect(huge.transform.scale[0]).toBe(100);
      expect(huge.transform.position.every(Number.isFinite)).toBe(true);
      expect((camera as PrevizCamera).focalMm).toBe(200);
    });

    it("falls back to the first camera when the named one is missing", () => {
      const plan = mustPlan(
        createDefaultScene(),
        { objects: [piece("a"), referenceCamera()], referenceCameraId: "blockout-nope" },
        "replace",
      );

      expect(plan.referenceCameraId).toBe("blockout-cam");
    });

    it("reports no reference camera when the payload has none", () => {
      const plan = mustPlan(
        createDefaultScene(),
        { objects: [piece("a")], referenceCameraId: "blockout-cam" },
        "replace",
      );

      expect(plan.referenceCameraId).toBeNull();
    });
  });

  it("detects an existing blockout", () => {
    expect(hasBlockout(sceneWith([handPlaced("mine")]))).toBe(false);
    expect(hasBlockout(mustPlan(createDefaultScene(), payload(1), "replace").scene)).toBe(true);
  });
});

describe("previz store importBlockout", () => {
  beforeEach(() => {
    usePrevizStore.getState().loadScene(createDefaultScene());
  });

  it("writes the whole blockout as one undo step", () => {
    const rejection = usePrevizStore.getState().importBlockout(payload(5), "replace");

    expect(rejection).toBeNull();
    expect(usePrevizStore.getState().scene.objects).toHaveLength(6);
    expect(usePrevizStore.getState().past).toHaveLength(1);

    usePrevizStore.getState().undo();

    expect(usePrevizStore.getState().scene.objects).toHaveLength(0);
  });

  it("selects the reference camera and puts it on the monitor", () => {
    usePrevizStore.getState().importBlockout(payload(2), "replace");

    const state = usePrevizStore.getState();
    expect(state.selectedObjectId).toBe("blockout-cam");
    expect(state.activeCameraId).toBe("blockout-cam");
    expect(state.monitorFollowsProgram).toBe(false);
    expect(state.dirty).toBe(true);
  });

  it("leaves the scene and the history alone when it refuses", () => {
    const cameras = Array.from({ length: PREVIZ_OBJECT_LIMITS.camera }, (_, index) =>
      handCamera(`cam-${index}`),
    );
    usePrevizStore.getState().loadScene(sceneWith(cameras));
    usePrevizStore.getState().selectObject("cam-3");
    const before = usePrevizStore.getState().scene;

    const rejection = usePrevizStore.getState().importBlockout(payload(2), "replace");

    expect(rejection).toEqual({
      reason: "camera-limit",
      missing: 1,
      limit: PREVIZ_OBJECT_LIMITS.camera,
    });
    const state = usePrevizStore.getState();
    expect(state.scene).toBe(before);
    expect(state.past).toHaveLength(0);
    expect(state.dirty).toBe(false);
    expect(state.selectedObjectId).toBe("cam-3");
  });

  it("drops references to the objects a replace removed", () => {
    usePrevizStore.getState().importBlockout(payload(2), "replace");
    usePrevizStore.setState({ soloObjectIds: ["blockout-box_1"] });

    usePrevizStore
      .getState()
      .importBlockout({ objects: [piece("only")], referenceCameraId: null }, "replace");

    const state = usePrevizStore.getState();
    expect(state.scene.objects.map((object) => object.id)).toEqual(["blockout-only"]);
    expect(state.selectedObjectId).toBeNull();
    expect(state.activeCameraId).toBeNull();
    expect(state.monitorFollowsProgram).toBe(true);
    expect(state.soloObjectIds).toEqual([]);
  });

  it("keeps the current selection when a replace leaves it in place", () => {
    usePrevizStore.getState().loadScene(sceneWith([handPlaced("mine"), handCamera("my-cam")]));
    usePrevizStore.getState().selectObject("mine");
    usePrevizStore.getState().setActiveCamera("my-cam");

    usePrevizStore
      .getState()
      .importBlockout({ objects: [piece("only")], referenceCameraId: null }, "replace");

    const state = usePrevizStore.getState();
    expect(state.selectedObjectId).toBe("mine");
    expect(state.activeCameraId).toBe("my-cam");
  });
});
