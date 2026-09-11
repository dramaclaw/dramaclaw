// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it, vi } from "vitest";

import {
  PREVIZ_PROP_MAX_PLAUSIBLE_M,
  PREVIZ_PROP_MIN_PLAUSIBLE_M,
  propUnitScale,
} from "@/features/previz/domain/propUnits";
import { PropLoader } from "@/features/previz/engine/propLoader";
import type { PrevizProp } from "@/features/previz/domain/scene";

describe("propUnitScale", () => {
  // 这一条是整套东西存在的理由：按米建的模型一个字节都不许动。少了它，这里就从
  // 「单位换算」滑成「缩放到看着合适」，一把 0.9 m 的椅子会跟着遭殃。
  it.each([
    PREVIZ_PROP_MIN_PLAUSIBLE_M,
    0.5,
    0.9,
    1.8,
    8,
    120,
    PREVIZ_PROP_MAX_PLAUSIBLE_M,
  ])("leaves a model already in metres alone at %s m", (size) => {
    expect(propUnitScale(size)).toBe(1);
  });

  // 用户截图里那栋 Cottage：按厘米导出，进来是 800，杵在 1.8 m 的人物旁边像堵墙。
  it("reads an 800-unit cottage as centimetres", () => {
    expect(propUnitScale(800)).toBe(0.01);
    expect(800 * propUnitScale(800)).toBe(8);
  });

  it("reads a 1700-unit prop as millimetres once centimetres would still be too big", () => {
    // 按厘米算是 17 m——也说得通，而且厘米更常见，所以先中的是厘米。
    expect(propUnitScale(1700)).toBe(0.01);
    // 按厘米算得 2000 m，超出上界；毫米算得 20 m，落进去。
    expect(propUnitScale(200_000)).toBe(0.001);
  });

  // 反方向也有：按米建的模型被某些导出器当成厘米写出去，进来只有零点零几。
  it("scales a model authored in metres but exported as if it were centimetres", () => {
    expect(propUnitScale(0.018)).toBe(100);
    // ×100 只得 0.015 m，还在下界之下，这才轮得到 ×1000。
    expect(propUnitScale(0.00015)).toBe(1000);
  });

  // 换不明白就别动：猜错的缩放比原样放行更难排查——用户看不出是自己单位错了，
  // 只会觉得导入器有毛病。
  it.each([Number.NaN, Infinity, 0, -5])("gives up on %s instead of guessing", (size) => {
    expect(propUnitScale(size)).toBe(1);
  });

  it("gives up when no power of ten lands in range", () => {
    // 1e9 单位：厘米得 1e7 m，毫米得 1e6 m，都远在上界之上。
    expect(propUnitScale(1e9)).toBe(1);
  });
});

describe("PropLoader unit scaling", () => {
  function fakeModel(): {
    scale: { x: number; y: number; z: number };
    userData: Record<string, unknown>;
  } {
    // 只需要 `PropLoader` 真正碰到的那两样：scale 和 userData。整个 three 不用假。
    return { scale: { x: 1, y: 1, z: 1 }, userData: {} };
  }

  function prop(): PrevizProp {
    return {
      assetUrl: "https://example.test/cottage.glb",
      assetFormat: "glb",
    } as PrevizProp;
  }

  function loaderFor(model: object, largest: number) {
    const measure = vi.fn(() => largest);
    const prepareMaterials = vi.fn();
    const loader = new PropLoader({
      loadGltf: async () => ({ scene: model as never }),
      loadObj: async () => model as never,
      clone: (object) => object,
      measure: measure as never,
      prepareMaterials,
    });
    return { loader, measure, prepareMaterials };
  }

  it("shrinks a centimetre-authored model to metres", async () => {
    const model = fakeModel();
    const { loader } = loaderFor(model, 800);

    await loader.load(prop());

    expect(model.scale).toEqual({ x: 0.01, y: 0.01, z: 0.01 });
  });

  it("keeps a model that is already the right size untouched", async () => {
    const model = fakeModel();
    const { loader } = loaderFor(model, 8);

    await loader.load(prop());

    expect(model.scale).toEqual({ x: 1, y: 1, z: 1 });
  });

  // 换算烙在缓存里那份源模型上，克隆体照抄。量一次包围盒要走遍整棵子树，同一把椅子
  // 摆 20 张量 20 遍是白花钱。
  it("measures once per url no matter how many props share it", async () => {
    const model = fakeModel();
    const { loader, measure } = loaderFor(model, 800);

    await Promise.all([loader.load(prop()), loader.load(prop()), loader.load(prop())]);

    expect(measure).toHaveBeenCalledTimes(1);
    // 也就是说不会连乘三次缩成 1e-6。
    expect(model.scale.x).toBe(0.01);
  });

  // 场景图靠这个数认出「一整间屋子」这类布景外壳，让它只接影不投影（见
  // `sceneGraph.enableShadows`）。记的必须是换算**之后**的米数：按厘米导出的那栋
  // Cottage 原始最长边是 800，不换算的话每一个导入模型都会被当成外壳。
  it("records the model's real size in metres for the scene graph", async () => {
    const model = fakeModel();
    const { loader } = loaderFor(model, 800);

    await loader.load(prop());

    expect(model.userData).toMatchObject({ previzModelSizeM: 8 });
  });

  it("records it even when nothing needed converting", async () => {
    const model = fakeModel();
    const { loader } = loaderFor(model, 8);

    await loader.load(prop());

    expect(model.userData).toMatchObject({ previzModelSizeM: 8 });
  });

  // 换算跟格式无关：OBJ 没有单位声明，比 glTF 更常撞上这个问题。
  it("scales an obj the same way", async () => {
    const model = fakeModel();
    const { loader } = loaderFor(model, 800);

    await loader.load({ ...prop(), assetFormat: "obj" } as PrevizProp);

    expect(model.scale.x).toBe(0.01);
  });
});

// 导进来的模型要先过一遍材质处理（双面 + Phong/Lambert 换 standard，见
// `importedMaterials.ts`）。这一组测的只是「PropLoader 有没有在对的时机、对的对象上
// 调它一次」——处理本身干了什么归 `imported-materials.test.ts`。
describe("PropLoader material preparation", () => {
  function fakeModel() {
    return { scale: { x: 1, y: 1, z: 1 }, userData: {} };
  }

  function prop(): PrevizProp {
    return { assetUrl: "https://example.test/room.obj", assetFormat: "obj" } as PrevizProp;
  }

  function loaderFor(model: object) {
    const prepareMaterials = vi.fn();
    const loader = new PropLoader({
      loadGltf: async () => ({ scene: model as never }),
      loadObj: async () => model as never,
      clone: (object) => object,
      measure: () => 1,
      prepareMaterials,
    });
    return { loader, prepareMaterials };
  }

  it("prepares the loaded model's materials", async () => {
    const model = fakeModel();
    const { loader, prepareMaterials } = loaderFor(model);

    await loader.load(prop());

    // 改的是缓存里那份源模型，不是某个克隆体：`clone` 对材质是浅克隆，所有克隆体
    // 共用这一批材质，改一次就够。
    expect(prepareMaterials).toHaveBeenCalledWith(model);
  });

  it("does it once per url, before anything can clone the model", async () => {
    const model = fakeModel();
    const { loader, prepareMaterials } = loaderFor(model);

    await Promise.all([loader.load(prop()), loader.load(prop())]);

    expect(prepareMaterials).toHaveBeenCalledTimes(1);
  });

  // `side` 与材质类型都参与 three 的着色程序缓存键。进了场景再改会触发一次重编译，
  // 所以这一遍必须和单位换算一样发生在 `loadOnce` 里。
  it("also covers glb, not just obj", async () => {
    const model = fakeModel();
    const { loader, prepareMaterials } = loaderFor(model);

    await loader.load({ ...prop(), assetFormat: "glb" } as PrevizProp);

    expect(prepareMaterials).toHaveBeenCalledWith(model);
  });
});
