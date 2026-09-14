// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PrevizProp } from "@/features/previz/domain/scene";
import { PropLoader } from "@/features/previz/engine/propLoader";

/** 只要 PropLoader 读写的那几个字段；真几何体由 primitive-builder.test.ts 管。 */
function fakeModel() {
  return { scale: { x: 1, y: 1, z: 1 }, userData: {} as Record<string, unknown> };
}

function primitive(shape: string): PrevizProp {
  return { assetUrl: shape, assetFormat: "primitive" } as PrevizProp;
}

function setup() {
  const built = fakeModel();
  const deps = {
    loadGltf: vi.fn(async () => ({ scene: fakeModel() as never })),
    loadObj: vi.fn(async () => fakeModel() as never),
    // 每次交出一份新对象，好分辨「两个物件拿到的是不是同一个实例」。
    clone: vi.fn((object: object) => ({ ...object, userData: {} }) as never),
    measure: vi.fn(() => 1),
    prepareMaterials: vi.fn(),
    buildPrimitive: vi.fn((_shape: string) => built as never),
  };
  return { loader: new PropLoader(deps), deps, built };
}

describe("PropLoader with primitive props", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("builds the shape instead of fetching anything", async () => {
    const { loader, deps } = setup();

    const model = await loader.load(primitive("cube"));

    expect(model).not.toBeNull();
    expect(deps.buildPrimitive).toHaveBeenCalledWith("cube");
    expect(deps.loadGltf).not.toHaveBeenCalled();
    expect(deps.loadObj).not.toHaveBeenCalled();
  });

  // 单位换算与材质准备对几何体同样生效：跳过它们的话，几何体在白模 / 阴影上会跟
  // GLB 物件表现不一样。
  it("measures and prepares the built model like a loaded one", async () => {
    const { loader, deps, built } = setup();

    await loader.load(primitive("sphere"));

    expect(deps.measure).toHaveBeenCalledWith(built);
    expect(deps.prepareMaterials).toHaveBeenCalledWith(built);
    expect(built.userData.previzModelSizeM).toBe(1);
  });

  it("builds a shape once and hands each prop its own clone", async () => {
    const { loader, deps } = setup();

    const first = await loader.load(primitive("cube"));
    const second = await loader.load(primitive("cube"));

    expect(deps.buildPrimitive).toHaveBeenCalledTimes(1);
    expect(first).not.toBe(second);
    expect(first?.userData.previzSharedModel).toBe(true);
    expect(second?.userData.previzSharedModel).toBe(true);
  });

  // 未知形状（更新的版本写入的）按加载失败处理：返回 null，占位方块留着。缓存里
  // 不能留下这次失败——第二次 load 还会再报一次错，就说明它重试了而不是吃了缓存。
  it("treats an unknown shape as a failed load and does not cache the failure", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { loader, deps } = setup();

    expect(await loader.load(primitive("dodecahedron"))).toBeNull();
    expect(await loader.load(primitive("dodecahedron"))).toBeNull();

    expect(deps.buildPrimitive).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(2);
  });

  it("does not let a prototype key through as a shape", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { loader, deps } = setup();

    expect(await loader.load(primitive("constructor"))).toBeNull();
    expect(deps.buildPrimitive).not.toHaveBeenCalled();
  });
});
