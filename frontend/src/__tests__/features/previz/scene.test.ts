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
  outputAspectFrom,
  parseOutputAspect,
  parseScene,
  snapOutputAspect,
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
      cameraBody: "virtual",
      lensSeries: "anamorphic",
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

  it("keeps a valid custom outputAspect and rejects malformed or out-of-range ones", () => {
    const aspectOf = (value: unknown) => parseScene({ settings: { outputAspect: value } }).settings.outputAspect;
    expect(aspectOf("21:9")).toBe("21:9");
    expect(aspectOf("2.39:1")).toBe("2.39:1");
    // 规整写法但不约分：`21:9` 约成 `7:3` 反而认不出来。
    expect(aspectOf(" 16.0:9.00 ")).toBe("16:9");
    expect(aspectOf("1:4")).toBe("1:4");
    expect(aspectOf("4:1")).toBe("4:1");
    for (const bad of ["1:5", "5:1", "0:9", "16:0", "-16:9", "16x9", "16:", "1e3:1", "20000:10000", "NaN:1"]) {
      expect(aspectOf(bad)).toBe("16:9");
    }
  });

  it("snaps a dragged ratio to common aspects, otherwise writes it against the long side", () => {
    expect(snapOutputAspect(1.77)).toBe("16:9");
    expect(snapOutputAspect(0.57)).toBe("9:16");
    expect(snapOutputAspect(2.4)).toBe("2.39:1");
    expect(snapOutputAspect(1.51)).toBe("3:2");
    // 离常用画幅都远：按长边写成 x:1 / 1:x，不硬凑整数比。
    expect(snapOutputAspect(1.85)).toBe("1.85:1");
    expect(snapOutputAspect(0.54)).toBe("1:1.85");
    // 夹进 1:4 ~ 4:1，坏输入交回默认。
    expect(snapOutputAspect(10)).toBe("4:1");
    expect(snapOutputAspect(0.1)).toBe("1:4");
    expect(snapOutputAspect(Number.NaN)).toBe("16:9");
    expect(snapOutputAspect(0)).toBe("16:9");
  });

  it("builds an aspect from numbers, rounding to two decimals", () => {
    expect(outputAspectFrom(2.391, 1)).toBe("2.39:1");
    expect(outputAspectFrom(21, 9)).toBe("21:9");
    expect(outputAspectFrom(Number.NaN, 9)).toBeNull();
    expect(outputAspectFrom(0.001, 1)).toBeNull();
    expect(parseOutputAspect(169)).toBeNull();
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

  it("starts with an empty imported motion list", () => {
    expect(createDefaultScene().motions).toEqual([]);
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

  // isMember 用的是 `Object.prototype.hasOwnProperty.call(table, value)` 而不是
  // `value in table`：白名单都是对象字面量，`in` 会连着 Object.prototype 一起查，于是
  // 'constructor' / 'toString' / 'valueOf' / '__proto__' 统统算「合法枚举值」被原样存进
  // 场景，而后面每一处按枚举查表的地方（材质、灯型、加载器）拿到的都是 undefined。
  it("rejects Object.prototype keys as string enum values", () => {
    const parsed = parseScene({
      settings: { displayMode: "constructor", outputAspect: "toString" },
      objects: [
        { id: "a", kind: "character", bodyType: "constructor" },
        { id: "b", kind: "prop", assetFormat: "constructor" },
        { id: "c", kind: "light", lightType: "valueOf" },
        { id: "d", kind: "camera", sensor: "__proto__" },
        { id: "e", kind: "camera", cameraBody: "toString", lensSeries: "__proto__" },
      ],
    });

    expect(parsed.settings.displayMode).toBe("solid");
    expect(parsed.settings.outputAspect).toBe("16:9");
    expect(parsed.objects[0]).toMatchObject({ kind: "character", bodyType: "average" });
    expect(parsed.objects[1]).toMatchObject({ kind: "prop", assetFormat: "glb" });
    expect(parsed.objects[2]).toMatchObject({ kind: "light", lightType: "key" });
    expect(parsed.objects[3]).toMatchObject({ kind: "camera", sensor: "ff" });
    expect(parsed.objects[4]).toMatchObject({
      kind: "camera",
      cameraBody: "cine",
      lensSeries: "prime",
    });
  });

  // 几何体的形状名在解析时不校验：更新的版本可能加了新形状，旧版本读到时要原样留着，
  // 不能把它改写掉——认不出来的形状由加载阶段按失败处理，留下占位方块。
  it("keeps primitive props and their shape names as written", () => {
    const parsed = parseScene({
      objects: [
        { id: "a", kind: "prop", assetFormat: "primitive", assetUrl: "cube" },
        { id: "b", kind: "prop", assetFormat: "primitive", assetUrl: "dodecahedron" },
      ],
    });

    expect(parsed.objects[0]).toMatchObject({
      kind: "prop",
      assetFormat: "primitive",
      assetUrl: "cube",
    });
    expect(parsed.objects[1]).toMatchObject({
      kind: "prop",
      assetFormat: "primitive",
      assetUrl: "dodecahedron",
    });
  });

  // 机身与镜头系列在渲染上不起作用（视场角只由焦距与画幅决定），但它们是用户在创建
  // 对话框里挑过的东西。不存的话，重开面板看到的会是别人的选择，而不是自己的。
  it("keeps the camera body and lens series across a round trip", () => {
    const parsed = parseScene({
      schemaVersion: 1,
      objects: [{ id: "a", kind: "camera", cameraBody: "handheld", lensSeries: "anamorphic" }],
    });

    expect(parsed.objects[0]).toMatchObject({ cameraBody: "handheld", lensSeries: "anamorphic" });
  });

  // kind 走的是同一个 isMember，但这一条从 parseScene 的输出上看不出 hasOwnProperty 与
  // `in` 的差别：就算 `in` 放行了 'constructor'，parseObject 的 switch 也一个分支都命不
  // 中，对象照样被丢掉。留着是为了钉住「原型链上的名字不是合法 kind」这个契约本身——
  // switch 将来万一补上 default 分支，它就成了唯一一道防线。
  it("drops objects whose kind is an Object.prototype key", () => {
    const parsed = parseScene({
      objects: [
        { id: "a", kind: "constructor" },
        { id: "b", kind: "toString" },
        { id: "c", kind: "__proto__" },
        { id: "d", kind: "camera" },
      ],
    });

    expect(parsed.objects.map((object) => object.id)).toEqual(["d"]);
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

  // 五个值逐个写死在这里，不从 `BODY_TYPES` 取：跟着实现一起变的列表等于没有列表。
  // 少认一个体型不会报错，只会把用户在创建对话框里选的那一档静默改回「标准」——
  // 存进去是「高挑」，下次打开变成「标准」，中间没有任何提示。
  it("keeps every body type the dialog can produce", () => {
    for (const bodyType of ["capsule", "slim", "average", "heavy", "tall"] as const) {
      const parsed = parseScene({ objects: [{ id: "a", kind: "character", bodyType }] });

      expect(parsed.objects[0]).toMatchObject({ kind: "character", bodyType });
    }
  });

  // 认不出的体型必须落回「标准」而不是原样透出去：`BODY_WIDTH_SCALE` 是按体型查表的，
  // 查不到给的是 undefined，先参与乘法变成 NaN，再喂进 `model.scale.set`——
  // 整棵子树的世界矩阵跟着烂掉，人物凭空消失。
  it("falls back to average for a body type this build does not know", () => {
    const parsed = parseScene({ objects: [{ id: "a", kind: "character", bodyType: "buff" }] });

    expect(parsed.objects[0]).toMatchObject({ kind: "character", bodyType: "average" });
  });

  // 高度策略是后加的字段，老场景里根本没有。回落必须是「跟随轨迹」+ planeY 0：
  // 这两个值合起来正好等于加这个字段之前的行为，老场景打开时一个人都不该动位置。
  it("keeps a character saved before height policies existed on the default policy", () => {
    const parsed = parseScene({ objects: [{ id: "a", kind: "character" }] });

    expect(parsed.objects[0]).toMatchObject({ heightPolicy: "follow", planeY: 0 });
  });

  it("keeps the three height policies and rejects anything else", () => {
    const policyOf = (heightPolicy: unknown) => {
      const parsed = parseScene({ objects: [{ id: "a", kind: "character", heightPolicy }] });
      const character = parsed.objects[0];
      if (character?.kind !== "character") throw new Error("expected a character");
      return character.heightPolicy;
    };

    expect(policyOf("follow")).toBe("follow");
    expect(policyOf("ground")).toBe("ground");
    expect(policyOf("plane")).toBe("plane");
    // 认不出的策略落回「跟随轨迹」，而不是「贴合地面」或「锁定平面」：后两者会去改
    // 人物的 y，一份读不懂的旧数据不该有权把人从二楼挪到地面上。
    expect(policyOf("magnet")).toBe("follow");
    expect(policyOf("valueOf")).toBe("follow");
    expect(policyOf(undefined)).toBe("follow");
  });

  // 移动辅助这两个开关会改变人走出来的轨迹。缺字段的老场景必须读成两个 false：默认打开
  // 等于无声地改掉用户已经调好的走位，而画面上看起来只是「人不知怎么绕了一下」。
  it("keeps a character saved before movement assist existed with both switches off", () => {
    const parsed = parseScene({ objects: [{ id: "a", kind: "character" }] });

    expect(parsed.objects[0]).toMatchObject({ avoidCollision: false, stayInBounds: false });
  });

  it("round-trips both movement-assist switches and reads anything non-boolean as off", () => {
    const assistOf = (avoidCollision: unknown, stayInBounds: unknown) => {
      const parsed = parseScene({
        objects: [{ id: "a", kind: "character", avoidCollision, stayInBounds }],
      });
      const character = parsed.objects[0];
      if (character?.kind !== "character") throw new Error("expected a character");
      return [character.avoidCollision, character.stayInBounds];
    };

    expect(assistOf(true, true)).toEqual([true, true]);
    expect(assistOf(false, false)).toEqual([false, false]);
    // 存进来一个 "false" 字符串是最容易踩的一脚：取真值会把它当成勾上了。数字 1 同理。
    expect(assistOf("false", 1)).toEqual([false, false]);
    expect(assistOf(undefined, null)).toEqual([false, false]);
  });

  // planeY 是「锁定平面」那一档唯一的高度来源，非有限值透过去就是把人物钉在 NaN 上——
  // 世界矩阵烂掉，人凭空消失，而病因离故障点隔着好几个文件。
  it("falls back to the ground plane for a non-finite locked height", () => {
    const planeYOf = (planeY: unknown) => {
      const parsed = parseScene({ objects: [{ id: "a", kind: "character", planeY }] });
      const character = parsed.objects[0];
      if (character?.kind !== "character") throw new Error("expected a character");
      return character.planeY;
    };

    expect(planeYOf(3.5)).toBe(3.5);
    // 负数照收：地下室、地坑的戏就在 y<0。
    expect(planeYOf(-2)).toBe(-2);
    expect(planeYOf(NaN)).toBe(0);
    expect(planeYOf(Infinity)).toBe(0);
    expect(planeYOf(-Infinity)).toBe(0);
    expect(planeYOf("3.5")).toBe(0);
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

describe("parseScene program and audio tables", () => {
  const camera = { id: "cam-1", kind: "camera", name: "机位 1" };
  const cut = (id: string, startFrame: number, endFrame: number, cameraId = "cam-1") => ({
    id,
    kind: "cut",
    startFrame,
    endFrame,
    cameraId,
  });
  const audio = (id: string, startFrame: number, endFrame: number, extra: object = {}) => ({
    id,
    kind: "audio",
    startFrame,
    endFrame,
    audioUrl: "/static/a.mp3",
    sourceName: "a.mp3",
    durationMs: 4000,
    offsetMs: 0,
    sourceNodeId: null,
    ...extra,
  });

  it("defaults both tables to empty for old scenes", () => {
    const parsed = parseScene({ schemaVersion: 1, objects: [], timeline: { tracks: [] } });
    expect(parsed.timeline.program).toEqual([]);
    expect(parsed.timeline.audio).toEqual([]);
  });

  it("drops cuts whose camera is missing or is not a camera", () => {
    const parsed = parseScene({
      schemaVersion: 1,
      objects: [camera, { id: "man", kind: "character", name: "人" }],
      timeline: {
        tracks: [],
        program: [cut("c1", 0, 10), cut("c2", 10, 20, "gone"), cut("c3", 20, 30, "man")],
      },
    });
    expect(parsed.timeline.program.map((entry) => entry.id)).toEqual(["c1"]);
  });

  it("sorts cuts by start and drops the ones overlapping their predecessor", () => {
    const parsed = parseScene({
      schemaVersion: 1,
      objects: [camera],
      timeline: {
        tracks: [],
        program: [cut("late", 40, 60), cut("early", 0, 30), cut("overlap", 20, 50)],
      },
    });
    expect(parsed.timeline.program.map((entry) => entry.id)).toEqual(["early", "late"]);
  });

  it("drops cuts with a non-positive span or non-numeric frames", () => {
    const parsed = parseScene({
      schemaVersion: 1,
      objects: [camera],
      timeline: {
        tracks: [],
        program: [cut("zero", 10, 10), cut("flip", 20, 5), { ...cut("nan", 0, 5), endFrame: "5" }],
      },
    });
    expect(parsed.timeline.program).toEqual([]);
  });

  it("drops audio clips with an empty url or a non-positive duration", () => {
    const parsed = parseScene({
      schemaVersion: 1,
      objects: [],
      timeline: {
        tracks: [],
        audio: [
          audio("ok", 0, 30),
          audio("nourl", 40, 50, { audioUrl: "" }),
          audio("zero", 60, 70, { durationMs: 0 }),
        ],
      },
    });
    expect(parsed.timeline.audio.map((entry) => entry.id)).toEqual(["ok"]);
    expect(parsed.timeline.audio[0]).toEqual({
      id: "ok",
      kind: "audio",
      startFrame: 0,
      endFrame: 30,
      audioUrl: "/static/a.mp3",
      sourceName: "a.mp3",
      durationMs: 4000,
      offsetMs: 0,
      sourceNodeId: null,
    });
  });

  it("repairs a negative offset and a non-string source node id", () => {
    const parsed = parseScene({
      schemaVersion: 1,
      objects: [],
      timeline: {
        tracks: [],
        audio: [audio("a", 0, 30, { offsetMs: -5, sourceNodeId: 7, sourceName: undefined })],
      },
    });
    expect(parsed.timeline.audio[0]).toMatchObject({ offsetMs: 0, sourceNodeId: null, sourceName: "" });
  });

  it("sorts audio clips and drops overlaps", () => {
    const parsed = parseScene({
      schemaVersion: 1,
      objects: [],
      timeline: { tracks: [], audio: [audio("b", 30, 60), audio("a", 0, 40), audio("c", 60, 90)] },
    });
    expect(parsed.timeline.audio.map((entry) => entry.id)).toEqual(["a", "c"]);
  });

  it("creates the default scene with all three tables", () => {
    expect(createDefaultScene().timeline).toEqual({ tracks: [], program: [], audio: [] });
  });

  it("treats a non-array program or audio table as empty", () => {
    const parsed = parseScene({
      schemaVersion: 1,
      objects: [camera],
      timeline: { tracks: [], program: {}, audio: "x" },
    });
    expect(parsed.timeline.program).toEqual([]);
    expect(parsed.timeline.audio).toEqual([]);
  });

  it("skips null and non-object entries inside the program array", () => {
    const parsed = parseScene({
      schemaVersion: 1,
      objects: [camera],
      timeline: { tracks: [], program: [null, "cut", cut("ok", 0, 10)] },
    });
    expect(parsed.timeline.program.map((entry) => entry.id)).toEqual(["ok"]);
  });

  it("rounds fractional frames", () => {
    const parsed = parseScene({
      schemaVersion: 1,
      objects: [camera],
      timeline: { tracks: [], program: [cut("f", 10.6, 20.4)] },
    });
    expect(parsed.timeline.program[0]).toMatchObject({ startFrame: 11, endFrame: 20 });
  });

  it("clamps a negative start to 0 and drops a clip that ends before 0", () => {
    const parsed = parseScene({
      schemaVersion: 1,
      objects: [camera],
      timeline: { tracks: [], program: [cut("n", -10, 5), cut("gone", -10, -5)] },
    });
    expect(parsed.timeline.program.map((entry) => entry.id)).toEqual(["n"]);
    expect(parsed.timeline.program[0]).toMatchObject({ startFrame: 0, endFrame: 5 });
  });

  it("drops an audio clip with an Infinity duration and repairs an Infinity or missing offset to 0", () => {
    const parsed = parseScene({
      schemaVersion: 1,
      objects: [],
      timeline: {
        tracks: [],
        audio: [
          audio("bad", 0, 30, { durationMs: Infinity }),
          audio("inf-offset", 40, 70, { offsetMs: Infinity }),
          audio("undef-offset", 80, 110, { offsetMs: undefined }),
        ],
      },
    });
    expect(parsed.timeline.audio.map((entry) => entry.id)).toEqual(["inf-offset", "undef-offset"]);
    expect(parsed.timeline.audio[0]).toMatchObject({ offsetMs: 0 });
    expect(parsed.timeline.audio[1]).toMatchObject({ offsetMs: 0 });
  });
});

describe("parseScene motions and action clips", () => {
  const motion = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    name: "挥手",
    url: `/u/${id}.glb`,
    sourceFileName: `${id}.glb`,
    format: "glb",
    skeleton: "mixamo",
    clipIndex: 0,
    durationSec: 2,
    loop: false,
    ...extra,
  });
  const hero = { id: "hero", kind: "character", name: "主角" };
  const cam = { id: "cam", kind: "camera", name: "机位" };
  const action = (id: string, startFrame: number, endFrame: number, motionId: string) => ({
    id,
    kind: "action",
    startFrame,
    endFrame,
    motionId,
  });

  it("reads old scenes without motions as an empty list", () => {
    expect(parseScene({ schemaVersion: 1, objects: [] }).motions).toEqual([]);
  });

  it("keeps valid motions, fixes soft fields and drops broken ones", () => {
    const parsed = parseScene({
      schemaVersion: 1,
      motions: [
        motion("a", { durationSec: 90, clipIndex: 1.6, loop: "yes", name: 3 }),
        motion("a"),
        motion("b", { format: "fbx" }),
        motion("c", { skeleton: "bip" }),
        motion("d", { url: "" }),
        motion("e", { durationSec: 0 }),
        { id: "f" },
        null,
      ],
    });
    expect(parsed.motions).toEqual([
      {
        id: "a",
        name: "",
        url: "/u/a.glb",
        sourceFileName: "a.glb",
        format: "glb",
        skeleton: "mixamo",
        clipIndex: 2,
        durationSec: 60,
        loop: false,
      },
    ]);
  });

  it("caps the imported motion list", () => {
    const many = Array.from({ length: 35 }, (_, index) => motion(`m${index}`));
    expect(parseScene({ schemaVersion: 1, motions: many }).motions).toHaveLength(30);
  });

  it("keeps action clips only on character tracks with a known motion", () => {
    const parsed = parseScene({
      schemaVersion: 1,
      objects: [hero, cam],
      motions: [motion("m1")],
      timeline: {
        tracks: [
          {
            id: "t1",
            objectId: "hero",
            clips: [
              action("a1", 0, 30, "builtin:Idle_Loop"),
              action("a2", 30, 60, "import:m1"),
              action("a3", 60, 90, "import:gone"),
              action("a4", 90, 120, "builtin:Nope"),
              action("a5", 100, 100, "builtin:Idle_Loop"),
              { id: "p1", kind: "path", startFrame: 0, endFrame: 60, points: [] },
            ],
          },
          {
            id: "t2",
            objectId: "cam",
            clips: [action("a6", 0, 30, "builtin:Idle_Loop")],
          },
        ],
      },
    });
    const [heroTrack, camTrack] = parsed.timeline.tracks;
    expect(heroTrack!.clips.map((clip) => clip.id)).toEqual(["p1", "a1", "a2"]);
    expect(camTrack!.clips).toEqual([]);
  });

  it("sorts action clips and drops overlaps", () => {
    const parsed = parseScene({
      schemaVersion: 1,
      objects: [hero],
      timeline: {
        tracks: [
          {
            id: "t1",
            objectId: "hero",
            clips: [
              action("late", 40, 80, "builtin:Idle_Loop"),
              action("early", 0, 50, "builtin:Idle_Loop"),
              action("touching", 50, 60, "builtin:Idle_Loop"),
            ],
          },
        ],
      },
    });
    expect(parsed.timeline.tracks[0]!.clips.map((clip) => clip.id)).toEqual(["early", "touching"]);
  });
});
