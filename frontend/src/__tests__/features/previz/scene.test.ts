// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from "vitest";

import {
  PREVIZ_DEFAULT_DURATION_FRAMES,
  PREVIZ_FPS,
  PREVIZ_INTENSITY_RANGE,
  PREVIZ_MAX_DURATION_FRAMES,
  PREVIZ_POSE_ADJUST_RANGE,
  PREVIZ_SCALE_RANGE,
  PREVIZ_SCHEMA_VERSION,
  PrevizSceneVersionError,
  createDefaultScene,
  parseScene,
} from "@/features/previz/domain/scene";
import { PREVIZ_APERTURE, PREVIZ_FOCAL_MM } from "@/features/previz/domain/camera";
import {
  PREVIZ_DEFAULT_HEIGHT_CM,
  PREVIZ_MAX_HEIGHT_CM,
  PREVIZ_MIN_HEIGHT_CM,
  PREVIZ_OBJECT_BASE_NAME,
} from "@/features/previz/domain/objects";

describe("previz scene schema", () => {
  it("creates an empty scene at the current schema version", () => {
    const scene = createDefaultScene();

    expect(scene.schemaVersion).toBe(PREVIZ_SCHEMA_VERSION);
    expect(scene.settings.fps).toBe(PREVIZ_FPS);
    expect(scene.settings.durationFrames).toBe(120);
    expect(scene.settings.outputAspect).toBe("16:9");
    expect(scene.objects).toEqual([]);
    expect(scene.timeline.tracks).toEqual([]);
  });

  it("falls back to a default scene for absent or non-object input", () => {
    expect(parseScene(undefined)).toEqual(createDefaultScene());
    expect(parseScene(null)).toEqual(createDefaultScene());
    expect(parseScene("not a scene")).toEqual(createDefaultScene());
  });

  it("round-trips a scene through JSON without losing objects or tracks", () => {
    const scene = createDefaultScene();
    scene.objects.push({
      id: "cam-1",
      kind: "camera",
      name: "主机位",
      transform: { position: [1, 2, 3], rotation: [0, 0, 0], scale: [1, 1, 1] },
      visible: true,
      locked: false,
      focalMm: 35,
      aperture: 2.8,
      sensor: "ff",
    });
    scene.timeline.tracks.push({ id: "track-1", objectId: "cam-1", clips: [] });

    const parsed = parseScene(JSON.parse(JSON.stringify(scene)));

    expect(parsed).toEqual(scene);
  });

  it("rejects a scene written by a newer implementation", () => {
    expect(() => parseScene({ schemaVersion: PREVIZ_SCHEMA_VERSION + 1 })).toThrow(
      PrevizSceneVersionError,
    );
  });

  it("clamps duration into the supported frame range", () => {
    expect(parseScene({ settings: { durationFrames: 0 } }).settings.durationFrames).toBe(1);
    expect(parseScene({ settings: { durationFrames: 9999 } }).settings.durationFrames).toBe(
      PREVIZ_MAX_DURATION_FRAMES,
    );
    expect(parseScene({ settings: { durationFrames: 90.6 } }).settings.durationFrames).toBe(91);
  });

  it("falls back to the default duration for non-numeric input", () => {
    expect(parseScene({ settings: { durationFrames: "abc" } }).settings.durationFrames).toBe(
      PREVIZ_DEFAULT_DURATION_FRAMES,
    );
    expect(parseScene({ settings: { durationFrames: NaN } }).settings.durationFrames).toBe(
      PREVIZ_DEFAULT_DURATION_FRAMES,
    );
  });

  it("falls back to the default value for an invalid displayMode or outputAspect", () => {
    expect(parseScene({ settings: { displayMode: "wireframe" } }).settings.displayMode).toBe(
      "solid",
    );
    expect(parseScene({ settings: { outputAspect: 42 } }).settings.outputAspect).toBe("16:9");
  });

  it("does not throw and falls back to empty arrays for malformed objects or timeline", () => {
    expect(() => parseScene({ timeline: "oops" })).not.toThrow();
    expect(parseScene({ timeline: "oops" }).timeline.tracks).toEqual([]);

    expect(() => parseScene({ objects: "oops" })).not.toThrow();
    expect(parseScene({ objects: "oops" }).objects).toEqual([]);
  });

  it("copies objects and tracks instead of sharing the input's array references", () => {
    const rawObjects: unknown[] = [];
    const rawTracks: unknown[] = [];
    const raw = { objects: rawObjects, timeline: { tracks: rawTracks } };

    const parsed = parseScene(raw);

    expect(parsed.objects).not.toBe(rawObjects);
    expect(parsed.timeline.tracks).not.toBe(rawTracks);
  });
});

describe("parseScene object validation", () => {
  it("drops objects with an unknown kind", () => {
    const parsed = parseScene({
      schemaVersion: 1,
      objects: [
        { id: "a", kind: "hologram", name: "x" },
        {
          id: "b",
          kind: "camera",
          name: "机位 1",
          transform: { position: [0, 1, 2], rotation: [0, 0, 0], scale: [1, 1, 1] },
          visible: true,
          locked: false,
          focalMm: 35,
          aperture: 2,
          sensor: "s35",
        },
      ],
    });

    expect(parsed.objects).toHaveLength(1);
    expect(parsed.objects[0]?.id).toBe("b");
  });

  it("repairs malformed transforms instead of dropping the object", () => {
    const parsed = parseScene({
      schemaVersion: 1,
      objects: [
        {
          id: "a",
          kind: "light",
          name: "灯光 1",
          transform: { position: [1, "two", 3], rotation: null, scale: [1, 1] },
          visible: "yes",
          locked: false,
          lightType: "spot",
          color: "#ff0000",
          intensity: 2,
        },
      ],
    });

    const light = parsed.objects[0];
    expect(light).toBeDefined();
    expect(light?.transform.position).toEqual([1, 0, 3]);
    expect(light?.transform.rotation).toEqual([0, 0, 0]);
    expect(light?.transform.scale).toEqual([1, 1, 1]);
    expect(light?.visible).toBe(true);
  });

  it("drops objects that have no usable id", () => {
    const parsed = parseScene({ schemaVersion: 1, objects: [{ kind: "camera" }, { id: "", kind: "camera" }] });

    expect(parsed.objects).toEqual([]);
  });

  // 轨道指向已经不存在的对象时，求值器（P3）会拿到一个悬空引用。P1 还没有求值器，
  // 但让脏数据在这里就地消失比留到那时候再排查便宜得多。
  it("drops tracks whose object is gone", () => {
    const parsed = parseScene({
      schemaVersion: 1,
      objects: [],
      timeline: { tracks: [{ id: "t1", objectId: "missing", clips: [] }] },
    });

    expect(parsed.timeline.tracks).toEqual([]);
  });
});

describe("parseScene field hygiene", () => {
  it("clamps a character's height and falls back to the default for non-numbers", () => {
    const heightOf = (heightCm: unknown) => {
      const parsed = parseScene({ objects: [{ id: "a", kind: "character", heightCm }] });
      const character = parsed.objects[0];
      if (character?.kind !== "character") throw new Error("expected a character");
      return character.heightCm;
    };

    expect(heightOf(5)).toBe(PREVIZ_MIN_HEIGHT_CM);
    expect(heightOf(-5)).toBe(PREVIZ_MIN_HEIGHT_CM);
    expect(heightOf(900)).toBe(PREVIZ_MAX_HEIGHT_CM);
    expect(heightOf(NaN)).toBe(PREVIZ_DEFAULT_HEIGHT_CM);
    expect(heightOf("tall")).toBe(PREVIZ_DEFAULT_HEIGHT_CM);
  });

  // focalMm 为 0 会让水平视场角变成 180°，three 的投影矩阵直接算出 NaN，整个画面消失。
  it("clamps a camera's focal length and aperture", () => {
    const cameraFrom = (focalMm: unknown, aperture: unknown) => {
      const parsed = parseScene({ objects: [{ id: "a", kind: "camera", focalMm, aperture }] });
      const camera = parsed.objects[0];
      if (camera?.kind !== "camera") throw new Error("expected a camera");
      return camera;
    };

    expect(cameraFrom(0, 0)).toMatchObject({
      focalMm: PREVIZ_FOCAL_MM.min,
      aperture: PREVIZ_APERTURE.min,
    });
    expect(cameraFrom(-50, 999)).toMatchObject({
      focalMm: PREVIZ_FOCAL_MM.min,
      aperture: PREVIZ_APERTURE.max,
    });
    expect(cameraFrom(500, NaN)).toMatchObject({
      focalMm: PREVIZ_FOCAL_MM.max,
      aperture: PREVIZ_APERTURE.default,
    });
    expect(cameraFrom(NaN, "f/2")).toMatchObject({
      focalMm: PREVIZ_FOCAL_MM.default,
      aperture: PREVIZ_APERTURE.default,
    });
  });

  it("clamps a light's intensity to a non-negative value", () => {
    const intensityOf = (intensity: unknown) => {
      const parsed = parseScene({ objects: [{ id: "a", kind: "light", intensity }] });
      const light = parsed.objects[0];
      if (light?.kind !== "light") throw new Error("expected a light");
      return light.intensity;
    };

    expect(intensityOf(-3)).toBe(PREVIZ_INTENSITY_RANGE.min);
    expect(intensityOf(1000)).toBe(PREVIZ_INTENSITY_RANGE.max);
    expect(intensityOf(NaN)).toBe(PREVIZ_INTENSITY_RANGE.default);
    expect(intensityOf(2.5)).toBe(2.5);
  });

  const scaleOf = (scale: unknown) => {
    const parsed = parseScene({
      objects: [{ id: "a", kind: "prop", transform: { scale } }],
    });
    return parsed.objects[0]?.transform.scale;
  };

  // 缩放分量为 0 会压出退化几何，手柄也就此抓不住，只能重开场景才能救回来。
  it("keeps every scale component out of the degenerate range", () => {
    const { min, max, default: fallback } = PREVIZ_SCALE_RANGE;
    expect(scaleOf([0, 0, 0])).toEqual([min, min, min]);
    expect(scaleOf([-2, 500, NaN])).toEqual([min, max, fallback]);
    expect(scaleOf([2, 3, 4])).toEqual([2, 3, 4]);
  });

  // 下界必须容得下单位换算，不只是「不退化」：assetFormat 收 'obj'，而 OBJ 不带单位
  // 元数据，一个按毫米建模的道具靠 0.001 才对得上米制场景。夹在 0.01 不会报错，只会
  // 在每次重新读场景时把它悄悄放大十倍——这条断言就是钉住那个十倍。
  it("keeps a millimetre-authored prop's scale instead of inflating it", () => {
    expect(scaleOf([0.001, 0.001, 0.001])).toEqual([0.001, 0.001, 0.001]);
  });

  // 三轴各有各的区间（见 PREVIZ_POSE_ADJUST_RANGE 的注释：抄自参照实现的三条滑杆）。
  // 越界的角度不产生 NaN，所以不夹也不崩；夹是因为 lean: 1e9 渲染出来是个把关节拧穿、
  // 绕自己转了两百万圈的人，而这是三轴里唯一还没做数值卫生的一处。
  it("clamps each poseAdjust axis into its own range", () => {
    const adjustOf = (poseAdjust: unknown) => {
      const parsed = parseScene({ objects: [{ id: "a", kind: "character", poseAdjust }] });
      const character = parsed.objects[0];
      if (character?.kind !== "character") throw new Error("expected a character");
      return character.poseAdjust;
    };

    const { pitch, turn, lean } = PREVIZ_POSE_ADJUST_RANGE;

    expect(adjustOf({ pitch: 1e9, turn: 1e9, lean: 1e9 })).toEqual({
      pitch: pitch.max,
      turn: turn.max,
      lean: lean.max,
    });
    expect(adjustOf({ pitch: -1e9, turn: -1e9, lean: -1e9 })).toEqual({
      pitch: pitch.min,
      turn: turn.min,
      lean: lean.min,
    });
    // 50° 刚好落在 turn 的区间里、落在 pitch 与 lean 的区间外——三轴共用同一段区间的话
    // 这一条就红了。
    expect(adjustOf({ pitch: 50, turn: 50, lean: 50 })).toEqual({
      pitch: pitch.max,
      turn: 50,
      lean: lean.max,
    });
    // 非有限值与非数字回落到 0（区间的 default），与本文件其余字段同一约定。
    expect(adjustOf({ pitch: NaN, turn: "10", lean: undefined })).toEqual({
      pitch: 0,
      turn: 0,
      lean: 0,
    });
    expect(adjustOf(undefined)).toEqual({ pitch: 0, turn: 0, lean: 0 });
    expect(adjustOf({ pitch: 12.5, turn: -20, lean: 3 })).toEqual({
      pitch: 12.5,
      turn: -20,
      lean: 3,
    });
  });

  it("keeps only the first object of a duplicated id", () => {
    const parsed = parseScene({
      objects: [
        { id: "dup", kind: "camera", name: "先来的" },
        { id: "dup", kind: "light", name: "后来的" },
        { id: "other", kind: "prop", name: "另一个" },
      ],
    });

    expect(parsed.objects.map((object) => object.id)).toEqual(["dup", "other"]);
    expect(parsed.objects[0]?.kind).toBe("camera");
    expect(parsed.objects[0]?.name).toBe("先来的");
  });

  it("round-trips explicit visible and locked flags", () => {
    const parsed = parseScene({
      objects: [
        { id: "a", kind: "prop", visible: false, locked: true },
        { id: "b", kind: "prop" },
        { id: "c", kind: "prop", visible: "yes", locked: "yes" },
      ],
    });

    expect(parsed.objects.map((object) => object.visible)).toEqual([false, true, true]);
    expect(parsed.objects.map((object) => object.locked)).toEqual([true, false, false]);
  });

  it("names an object after its kind when the stored name is blank or missing", () => {
    const parsed = parseScene({
      objects: [
        { id: "a", kind: "camera" },
        { id: "b", kind: "light", name: "   " },
        { id: "c", kind: "prop", name: 42 },
      ],
    });

    expect(parsed.objects.map((object) => object.name)).toEqual([
      PREVIZ_OBJECT_BASE_NAME.camera,
      PREVIZ_OBJECT_BASE_NAME.light,
      PREVIZ_OBJECT_BASE_NAME.prop,
    ]);
  });
});
