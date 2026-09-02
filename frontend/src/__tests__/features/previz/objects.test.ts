// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from "vitest";

import {
  PREVIZ_DEFAULT_HEIGHT_CM,
  PREVIZ_OBJECT_BASE_NAME,
  createPrevizObject,
  nextObjectName,
} from "@/features/previz/domain/objects";
import type { PrevizObject, PrevizObjectKind } from "@/features/previz/domain/scene";

describe("createPrevizObject", () => {
  it("gives every kind a unique id and the kind's default name", () => {
    const first = createPrevizObject("character", []);
    const second = createPrevizObject("character", [first]);

    expect(first.kind).toBe("character");
    expect(first.name).toBe(`${PREVIZ_OBJECT_BASE_NAME.character} 1`);
    expect(second.name).toBe(`${PREVIZ_OBJECT_BASE_NAME.character} 2`);
    expect(second.id).not.toBe(first.id);
  });

  it("defaults a character to an average build at the standard height", () => {
    const character = createPrevizObject("character", []);

    expect(character.bodyType).toBe("average");
    expect(character.heightCm).toBe(PREVIZ_DEFAULT_HEIGHT_CM);
    expect(character.basePoseId).toBe("standing");
    expect(character.poseAdjust).toEqual({ pitch: 0, turn: 0, lean: 0 });
    expect(character.transform.position).toEqual([0, 0, 0]);
  });

  it("puts a new camera at eye height looking down -Z", () => {
    const camera = createPrevizObject("camera", []);

    expect(camera.focalMm).toBe(50);
    expect(camera.sensor).toBe("ff");
    // 与 upstream 的创建对话框同默认：数字电影机 + 定焦镜头。
    expect(camera.cameraBody).toBe("cine");
    expect(camera.lensSeries).toBe("prime");
    expect(camera.transform.position).toEqual([0, 1.6, 4]);
    expect(camera.transform.rotation).toEqual([0, 0, 0]);
  });

  it("puts a new light off to the side above the origin", () => {
    const light = createPrevizObject("light", []);

    expect(light.lightType).toBe("key");
    expect(light.color).toBe("#ffffff");
    expect(light.intensity).toBe(1);
    expect(light.transform.position).toEqual([3, 4, 3]);
  });

  it("applies overrides on top of the defaults", () => {
    const prop = createPrevizObject("prop", [], {
      assetUrl: "/static/u/p/freezone/_uploads/chair.glb",
      name: "椅子",
    });

    expect(prop.assetUrl).toBe("/static/u/p/freezone/_uploads/chair.glb");
    expect(prop.assetFormat).toBe("glb");
    expect(prop.name).toBe("椅子");
  });

  // 调用方常常是「有就带上」的可选值，`{ name: maybeUndefined }` 能过类型检查；
  // 让它覆盖默认值会得到一个 name 是 undefined 的对象，图层面板上就是一行空白。
  it("ignores overrides whose value is undefined", () => {
    const maybeName: string | undefined = undefined;
    const camera = createPrevizObject("camera", [], { name: maybeName, focalMm: 35 });

    expect(camera.name).toBe(`${PREVIZ_OBJECT_BASE_NAME.camera} 1`);
    expect(camera.focalMm).toBe(35);
  });

  // store 的新建入口拿到的 kind 是运行时变量，这里同时守住返回类型仍是 PrevizObject。
  it("still returns a plain object when the kind is only known at runtime", () => {
    const kind: PrevizObjectKind = "prop";
    const created: PrevizObject = createPrevizObject(kind, []);

    expect(created.kind).toBe("prop");
    expect(created.name).toBe(`${PREVIZ_OBJECT_BASE_NAME.prop} 1`);
  });

  // 用户改过名的对象不该影响自动编号，否则把「机位 1」改名成「主机位」之后
  // 下一个新建的还叫「机位 1」，图层面板里出现两个看起来一样的条目。
  it("numbers by the highest matching suffix and ignores renamed objects", () => {
    const objects: PrevizObject[] = [
      createPrevizObject("camera", []),
      { ...createPrevizObject("camera", []), name: "主机位" },
      { ...createPrevizObject("camera", []), name: `${PREVIZ_OBJECT_BASE_NAME.camera} 7` },
    ];

    expect(nextObjectName(objects, "camera")).toBe(`${PREVIZ_OBJECT_BASE_NAME.camera} 8`);
    expect(nextObjectName(objects, "light")).toBe(`${PREVIZ_OBJECT_BASE_NAME.light} 1`);
  });
});
