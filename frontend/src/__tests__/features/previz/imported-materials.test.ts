// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it, vi } from 'vitest';

import { prepareImportedMaterials } from '@/features/previz/engine/importedMaterials';
import type { ThreeModule } from '@/features/previz/engine/sceneGraph';

/**
 * 导入模型的材质处理：一律双面，Phong / Lambert 换成 standard。
 *
 * three 用替身：这一趟真正要断言的是「换出来的那份材质带着哪些字段」，而真身跑这条路
 * 要一个 WebGL 上下文（材质构造本身不要，但把它拽进来就得连着 three 一整包），
 * jsdom 里建不出来。替身只需要一个记下构造参数的 `MeshStandardMaterial`。
 */

class FakeStandard {
  isMeshStandardMaterial = true;
  side = 0;
  userData: Record<string, unknown> = {};
  dispose = vi.fn();
  constructor(public params: Record<string, unknown> = {}) {}
}

function fakeThree(): ThreeModule {
  return { MeshStandardMaterial: FakeStandard, DoubleSide: 2 } as unknown as ThreeModule;
}

/** 一份 OBJLoader 兜底材质的样子：Phong，带色、带 shininess，没有任何贴图。 */
function fakePhong(overrides: Record<string, unknown> = {}) {
  return {
    isMeshPhongMaterial: true,
    name: 'default',
    color: { hex: 0xffffff },
    shininess: 30,
    transparent: false,
    opacity: 1,
    side: 0,
    userData: {},
    dispose: vi.fn(),
    ...overrides,
  };
}

/** 一棵只有 `traverse` 与 `material` 的树——`prepareImportedMaterials` 只碰这两样。 */
function tree(...materials: unknown[]) {
  const meshes = materials.map((material) => ({ material }));
  return {
    meshes,
    root: { traverse: (visit: (node: unknown) => void) => meshes.forEach(visit) },
  };
}

describe('prepareImportedMaterials', () => {
  it('swaps a phong material out for a standard one', () => {
    const phong = fakePhong();
    const { meshes, root } = tree(phong);

    prepareImportedMaterials(fakeThree(), root as never);

    expect(meshes[0].material).toBeInstanceOf(FakeStandard);
  });

  // physical 也走这一条（`isMeshStandardMaterial` 在它身上是 true，它是 standard 的
  // 子类）。重建一份只会把 clearcoat 这些字段丢掉。
  it('leaves a material that already shades the right way alone', () => {
    const standard = new FakeStandard();
    const { meshes, root } = tree(standard);

    prepareImportedMaterials(fakeThree(), root as never);

    expect(meshes[0].material).toBe(standard);
    expect(standard.dispose).not.toHaveBeenCalled();
  });

  it('turns every material double-sided, converted or not', () => {
    const standard = new FakeStandard();
    const { meshes, root } = tree(fakePhong(), standard);

    prepareImportedMaterials(fakeThree(), root as never);

    expect((meshes[0].material as FakeStandard).side).toBe(2);
    expect(standard.side).toBe(2);
  });

  it('carries the colour, the maps and the transparency across', () => {
    const map = { isTexture: true };
    const color = { hex: 0x8899aa };
    const phong = fakePhong({ color, map, transparent: true, opacity: 0.4 });
    const { meshes, root } = tree(phong);

    prepareImportedMaterials(fakeThree(), root as never);

    const params = (meshes[0].material as FakeStandard).params;
    expect(params).toMatchObject({ color, map, transparent: true, opacity: 0.4, metalness: 0 });
  });

  // 全灰模式把本色记在**材质**的 userData 上（见 `sceneGraph.applyDisplayMode`）。
  // 换材质时丢掉这本账，切回实体还不了原色。
  it('keeps the material userData, which the display modes book-keep on', () => {
    const userData = { previzOriginalColor: 0x123456 };
    const { meshes, root } = tree(fakePhong({ userData }));

    prepareImportedMaterials(fakeThree(), root as never);

    expect((meshes[0].material as FakeStandard).userData).toBe(userData);
  });

  // three 的 `Material.setValues` 碰到 undefined 会打一句 warning 再跳过。Lambert 身上
  // 本来就没有 shininess 这类字段，不筛的话每导一个 Lambert 模型，控制台里就是一串
  // 和用户毫无关系的黄字。
  it('never hands the constructor an undefined field', () => {
    const lambert = {
      isMeshLambertMaterial: true,
      color: { hex: 0xffffff },
      userData: {},
      dispose: vi.fn(),
    };
    const { meshes, root } = tree(lambert);

    prepareImportedMaterials(fakeThree(), root as never);

    const params = (meshes[0].material as FakeStandard).params;
    expect(Object.values(params).every((value) => value !== undefined)).toBe(true);
  });

  describe('roughness', () => {
    function roughnessFor(material: unknown): number {
      const { meshes, root } = tree(material);
      prepareImportedMaterials(fakeThree(), root as never);
      return (meshes[0].material as FakeStandard).params.roughness as number;
    }

    it('reads the phong highlight width', () => {
      // sqrt(2 / (2 + 2)) = 0.707…，两种模型的高光瓣宽度对齐。
      expect(roughnessFor(fakePhong({ shininess: 2 }))).toBeCloseTo(0.7071, 4);
    });

    // shininess 是 .mtl 里最常被随手填的一个数（`Room.mtl` 干脆没写 Ns，OBJLoader 用了
    // 自己的默认值 30，算出来 0.25）。一面 0.25 粗糙度的墙在 IBL 下几乎是镜子。
    it('refuses to turn a wall into a mirror', () => {
      expect(roughnessFor(fakePhong({ shininess: 30 }))).toBe(0.3);
      expect(roughnessFor(fakePhong({ shininess: 900 }))).toBe(0.3);
    });

    it('treats a lambert material as fully diffuse', () => {
      expect(roughnessFor({ isMeshLambertMaterial: true, userData: {}, dispose: vi.fn() })).toBe(1);
    });
  });

  // 一份材质常被整棵子树的几十个 mesh 共用（OBJ 的兜底材质更是全模型独一份）。
  // 不记账就是几十份各带一套 uniform 的 standard 材质、几十次着色器编译，
  // 而画面上完全看不出区别。
  it('converts a shared material once and hands the same one back', () => {
    const phong = fakePhong();
    const { meshes, root } = tree(phong, phong, phong);

    prepareImportedMaterials(fakeThree(), root as never);

    expect(meshes[0].material).toBe(meshes[1].material);
    expect(meshes[0].material).toBe(meshes[2].material);
    expect(phong.dispose).toHaveBeenCalledTimes(1);
  });

  // 换下来的那份再没人引用了。`Material.dispose()` 不碰贴图，而贴图刚被原样转交给了
  // 新材质，所以还掉的只是那份材质自己的 GPU 程序。
  it('disposes what it replaced', () => {
    const phong = fakePhong();
    const { root } = tree(phong);

    prepareImportedMaterials(fakeThree(), root as never);

    expect(phong.dispose).toHaveBeenCalledTimes(1);
  });

  it('handles a mesh with a list of materials', () => {
    const phong = fakePhong();
    const standard = new FakeStandard();
    const meshes = [{ material: [phong, standard] }];
    const root = { traverse: (visit: (node: unknown) => void) => meshes.forEach(visit) };

    prepareImportedMaterials(fakeThree(), root as never);

    const list = meshes[0].material as unknown as FakeStandard[];
    expect(list[0]).toBeInstanceOf(FakeStandard);
    expect(list[1]).toBe(standard);
    expect(list.every((entry) => entry.side === 2)).toBe(true);
  });

  it('walks past a node that has no material at all', () => {
    const meshes = [{ material: undefined }];
    const root = { traverse: (visit: (node: unknown) => void) => meshes.forEach(visit) };

    expect(() => prepareImportedMaterials(fakeThree(), root as never)).not.toThrow();
  });
});
