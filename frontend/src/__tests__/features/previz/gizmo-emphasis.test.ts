// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import * as THREE from 'three';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { describe, expect, it, vi } from 'vitest';

import { PrevizGizmo, type TransformControlsLike } from '@/features/previz/engine/gizmo';
import { emphasizeTranslateHandles } from '@/features/previz/engine/gizmoEmphasis';

/**
 * 这份用例盯的是「改造有没有落到该落的那几颗 mesh 上」，不是 three 的渲染。
 * 主体用一份手搭的假 three + 假 helper 树：假的能把「哪个几何体被换了、哪个材质
 * 还是原来那一个」断言到对象引用这一级，真 three 反而看不清。末尾另有一条钉子
 * 测试打在真 `TransformControls` 上——它才是「three 升级后内部结构还在不在」的那道闸。
 */

interface FakeGeometry {
  radius: number;
  dispose: ReturnType<typeof vi.fn>;
}

interface FakeMaterial {
  options?: Record<string, unknown>;
  color: { getHex(): number };
  dispose: ReturnType<typeof vi.fn>;
}

interface FakeHandle {
  name: string;
  geometry: FakeGeometry;
  material: FakeMaterial;
}

/** 只需要记下入参的假 three。构造出来的东西全靠对象引用被断言，不需要任何几何运算。 */
function fakeThree() {
  class OctahedronGeometry {
    dispose = vi.fn();
    constructor(
      public radius: number,
      public detail: number,
    ) {}
  }
  class MeshBasicMaterial {
    dispose = vi.fn();
    color: { getHex(): number };
    constructor(public options: Record<string, unknown>) {
      const hex = typeof options.color === 'number' ? options.color : 0x000000;
      this.color = { getHex: () => hex };
    }
  }
  return { OctahedronGeometry, MeshBasicMaterial } as never;
}

function fakeHandle(name: string, radius: number, colorHex: number): FakeHandle {
  return {
    name,
    geometry: { radius, dispose: vi.fn() },
    material: { color: { getHex: () => colorHex }, dispose: vi.fn() },
  };
}

/**
 * 照抄 three 0.185 `TransformControls.js` 的 translate 手柄清单：轴向 X/Y/Z 各三段
 * （两个箭头 + 一条线）、中心一颗 XYZ 八面体、三块 XY/YZ/XZ 平面。名字重复是真身
 * 就有的事——改造必须按名字扫全部子节点，不能只挑第一个同名的。
 */
function fakeTree() {
  const gizmoChildren = [
    fakeHandle('X', 1, 0xff0000),
    fakeHandle('X', 1, 0xff0000),
    fakeHandle('X', 1, 0xff0000),
    fakeHandle('Y', 1, 0x00ff00),
    fakeHandle('Z', 1, 0x0000ff),
    fakeHandle('XYZ', 0.1, 0xffffff),
    fakeHandle('XY', 0.15, 0x0000ff),
    fakeHandle('YZ', 0.15, 0xff0000),
    fakeHandle('XZ', 0.15, 0x00ff00),
  ];
  const pickerChildren = [
    fakeHandle('X', 0.2, 0xffffff),
    fakeHandle('XYZ', 0.2, 0xffffff),
    fakeHandle('XY', 0.2, 0xffffff),
  ];
  const gizmoRoot = {
    isTransformControlsGizmo: true,
    gizmo: {
      translate: { children: gizmoChildren },
      rotate: { children: [] },
      scale: { children: [] },
    },
    picker: {
      translate: { children: pickerChildren },
      rotate: { children: [] },
      scale: { children: [] },
    },
  };
  // 真身的 helper 是 `TransformControlsRoot`，手柄那层挂在它下面一级——所以入口
  // 必须 traverse 去找，直接读 helper 自己的属性是找不到的。
  const helper = {
    isTransformControlsRoot: true,
    traverse: (visit: (node: unknown) => void) => {
      visit(helper);
      visit(gizmoRoot);
    },
  };
  const byName = (children: FakeHandle[], name: string) =>
    children.filter((child) => child.name === name);
  return { helper, gizmoRoot, gizmoChildren, pickerChildren, byName };
}

function run(tree: ReturnType<typeof fakeTree>) {
  emphasizeTranslateHandles(tree.helper as never, fakeThree());
}

describe('emphasizeTranslateHandles', () => {
  it('grows and brightens the centre translate handle', () => {
    const tree = fakeTree();
    const before = tree.byName(tree.gizmoChildren, 'XYZ')[0]!;
    const oldGeometry = before.geometry;
    const oldMaterial = before.material;

    run(tree);

    const after = tree.byName(tree.gizmoChildren, 'XYZ')[0]!;
    expect(after.geometry).not.toBe(oldGeometry);
    expect(after.geometry.radius).toBeGreaterThan(oldGeometry.radius);
    expect(after.material).not.toBe(oldMaterial);
    const options = after.material.options ?? {};
    expect(options.opacity as number).toBeGreaterThanOrEqual(0.9);
    expect(options.transparent).toBe(true);
    // depthTest 必须留在 false（官方原材质就是这么设的）：一旦开了深度测试，手柄会
    // 钻进人物身体里被挡住，我们把它改大改亮的这一整件事就白做了。
    expect(options.depthTest).toBe(false);
    expect(options.depthWrite).toBe(false);
  });

  it('grows the centre picker geometry but leaves its material alone', () => {
    const tree = fakeTree();
    const before = tree.byName(tree.pickerChildren, 'XYZ')[0]!;
    const oldGeometry = before.geometry;
    const oldMaterial = before.material;

    run(tree);

    const after = tree.byName(tree.pickerChildren, 'XYZ')[0]!;
    expect(after.geometry).not.toBe(oldGeometry);
    expect(after.geometry.radius).toBeGreaterThan(oldGeometry.radius);
    // 拾取体的可见性归官方那份 0.15 的透明材质管，换掉它等于把不该看见的拾取
    // 八面体画到画面上——那是一坨盖住中心手柄的白雾。
    expect(after.material).toBe(oldMaterial);
  });

  it('makes the centre picker reachable wherever the visible handle is', () => {
    const tree = fakeTree();
    run(tree);

    const gizmoRadius = tree.byName(tree.gizmoChildren, 'XYZ')[0]!.geometry.radius;
    const pickerRadius = tree.byName(tree.pickerChildren, 'XYZ')[0]!.geometry.radius;
    // 拾取体必须包住显示体。反过来的话用户会看着手柄点上去却抓不住，比手柄小
    // 更让人困惑——他会以为是自己没点准，而不是判定区不够大。
    expect(pickerRadius).toBeGreaterThan(gizmoRadius);
  });

  it('only swaps materials on the plane handles, never their geometry', () => {
    const tree = fakeTree();
    const before = ['XY', 'YZ', 'XZ'].map((name) => {
      const handle = tree.byName(tree.gizmoChildren, name)[0]!;
      return { name, geometry: handle.geometry, colorHex: handle.material.color.getHex() };
    });

    run(tree);

    for (const snapshot of before) {
      const after = tree.byName(tree.gizmoChildren, snapshot.name)[0]!;
      // 平面手柄的偏移是烘进几何体里的（`setupGizmo` 里 `tempGeometry.applyMatrix4`），
      // 换几何体就得自己把那个矩阵重新烘一遍；漏了的话三块平面会全叠到原点上。
      // 只提不透明度就够看见了，不值这个风险。
      expect(after.geometry).toBe(snapshot.geometry);
      expect(after.material.options?.opacity as number).toBeGreaterThan(0.5);
      // 三块平面靠颜色区分对应哪两根轴，换材质时颜色必须原样带过来。
      expect(after.material.color.getHex()).toBe(snapshot.colorHex);
      expect(after.material.options?.depthTest).toBe(false);
    }
  });

  it('leaves the axis arrows untouched', () => {
    const tree = fakeTree();
    const before = tree
      .byName(tree.gizmoChildren, 'X')
      .map((handle) => ({ geometry: handle.geometry, material: handle.material }));

    run(tree);

    const after = tree.byName(tree.gizmoChildren, 'X');
    expect(after.map((handle) => handle.geometry)).toEqual(before.map((s) => s.geometry));
    expect(after.map((handle) => handle.material)).toEqual(before.map((s) => s.material));
  });

  it('disposes each replaced geometry exactly once', () => {
    const tree = fakeTree();
    const oldGizmoGeometry = tree.byName(tree.gizmoChildren, 'XYZ')[0]!.geometry;
    const oldPickerGeometry = tree.byName(tree.pickerChildren, 'XYZ')[0]!.geometry;

    run(tree);

    expect(oldGizmoGeometry.dispose).toHaveBeenCalledTimes(1);
    expect(oldPickerGeometry.dispose).toHaveBeenCalledTimes(1);
  });

  it('never disposes the materials it replaces', () => {
    const tree = fakeTree();
    const replaced = ['XYZ', 'XY', 'YZ', 'XZ'].map(
      (name) => tree.byName(tree.gizmoChildren, name)[0]!.material,
    );

    run(tree);

    // 这些材质是 three 内部共享的：translate 的四颗与 scale 手柄的同名四颗是**同一个
    // 实例**，其中三块平面还挂在 `materialLib.{x,y,z}AxisTransparent` 上，`setColors()`
    // 直接往里写。dispose 掉的是别人还在用的东西——现在恰好因为首帧之前没有 GPU
    // 资源而无害，但那是巧合，不是保证。我们只换引用，不销毁不属于自己的材质。
    for (const material of replaced) expect(material.dispose).not.toHaveBeenCalled();
  });

  it('does nothing when the helper tree has no transform gizmo', () => {
    const untouched = fakeHandle('XYZ', 0.1, 0xffffff);
    const helper = {
      traverse: (visit: (node: unknown) => void) => {
        visit(helper);
        visit({ name: 'something-else' });
      },
    };
    const geometry = untouched.geometry;
    const material = untouched.material;

    // 三方库升级换了内部结构时宁可退回官方外观，也不能让整个视口在构造期炸掉——
    // 手柄丑一点用户还能用，抛出来的话预演台连打都打不开。
    expect(() => emphasizeTranslateHandles(helper as never, fakeThree())).not.toThrow();
    expect(untouched.geometry).toBe(geometry);
    expect(untouched.material).toBe(material);
  });
});

/**
 * 钉在真 `TransformControls` 上的一条。上面那些假树全是照着 three 0.185 的源码手抄的，
 * 抄错了或者 three 改了内部结构（`isTransformControlsGizmo` 标记、`gizmo`/`picker` 两张
 * 表、`translate` 组里的 `XYZ` 名字），假树一条都不会红——它们量的是我们自己的抄本。
 *
 * 这条会红。红了就说明改造已经悄悄退化成空操作：中心手柄还是那颗 0.25 不透明度的
 * 白八面体，视口里照样看不见，而这正是整个改造要解决的问题。
 */
describe('emphasizeTranslateHandles on real three', () => {
  it('reaches the handles inside a real TransformControls', () => {
    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
    const controls = new TransformControls(camera, document.createElement('canvas'));
    const helper = controls.getHelper();

    const translateHandles = () => {
      let group: THREE.Object3D | undefined;
      helper.traverse((node) => {
        const gizmo = node as unknown as {
          isTransformControlsGizmo?: boolean;
          gizmo?: Record<string, THREE.Object3D>;
        };
        if (gizmo.isTransformControlsGizmo === true) group = gizmo.gizmo?.translate;
      });
      return (group?.children ?? []) as THREE.Mesh[];
    };
    const pickerHandles = () => {
      let group: THREE.Object3D | undefined;
      helper.traverse((node) => {
        const gizmo = node as unknown as {
          isTransformControlsGizmo?: boolean;
          picker?: Record<string, THREE.Object3D>;
        };
        if (gizmo.isTransformControlsGizmo === true) group = gizmo.picker?.translate;
      });
      return (group?.children ?? []) as THREE.Mesh[];
    };
    /** 半径改到几何体上才算数——`mesh.scale` 每帧被 three 重写，量它等于什么都没量。 */
    const radiusOf = (mesh: THREE.Mesh) => {
      mesh.geometry.computeBoundingSphere();
      return mesh.geometry.boundingSphere?.radius ?? 0;
    };
    const named = (meshes: THREE.Mesh[], name: string) => {
      const hit = meshes.find((mesh) => mesh.name === name);
      expect(hit, `real TransformControls has no translate handle named ${name}`).toBeDefined();
      return hit!;
    };

    const centreBefore = named(translateHandles(), 'XYZ');
    const pickerBefore = named(pickerHandles(), 'XYZ');
    const planeBefore = named(translateHandles(), 'XY');
    const centreRadiusBefore = radiusOf(centreBefore);
    const pickerRadiusBefore = radiusOf(pickerBefore);
    const planeGeometry = planeBefore.geometry;
    const pickerMaterial = pickerBefore.material;
    // 前置条件：官方那颗中心手柄确实是「看不见」的那一颗。这句要是红了，说明
    // three 已经自己把它做亮了，整个改造该重新评估而不是继续套用。
    expect((centreBefore.material as THREE.MeshBasicMaterial).opacity).toBeLessThan(0.5);

    emphasizeTranslateHandles(helper, THREE);

    const centreAfter = named(translateHandles(), 'XYZ');
    expect(radiusOf(centreAfter)).toBeGreaterThan(centreRadiusBefore);
    const centreMaterial = centreAfter.material as THREE.MeshBasicMaterial;
    expect(centreMaterial.opacity).toBeGreaterThanOrEqual(0.9);
    expect(centreMaterial.depthTest).toBe(false);
    expect(centreMaterial.transparent).toBe(true);

    const pickerAfter = named(pickerHandles(), 'XYZ');
    expect(radiusOf(pickerAfter)).toBeGreaterThan(pickerRadiusBefore);
    expect(pickerAfter.material).toBe(pickerMaterial);

    const planeAfter = named(translateHandles(), 'XY');
    expect(planeAfter.geometry).toBe(planeGeometry);
    expect((planeAfter.material as THREE.MeshBasicMaterial).opacity).toBeGreaterThan(0.5);
    // 蓝 = XY，红 = YZ，绿 = XZ。颜色带不过来的话三块平面就分不出谁是谁了。
    expect((planeAfter.material as THREE.MeshBasicMaterial).color.getHex()).toBe(0x0000ff);

    controls.dispose();
  });
});


/**
 * 接线那一头。改造走 `PrevizGizmoDeps` 上一个**可选**的 `three` 字段：jsdom 里那些
 * 塞假控件的既有用例不传它，也就一条都不用改；渲染器是唯一传的地方。
 */
describe('PrevizGizmo wiring', () => {
  function fakeControls(helper: unknown): TransformControlsLike {
    return {
      enabled: true,
      object: null,
      attach: vi.fn(),
      detach: vi.fn(),
      setMode: vi.fn(),
      setSpace: vi.fn(),
      dispose: vi.fn(),
      getHelper: () => helper as never,
      addEventListener: vi.fn(),
    };
  }

  function build(tree: ReturnType<typeof fakeTree>, three: unknown) {
    return new PrevizGizmo({
      controls: fakeControls(tree.helper),
      orbit: { enabled: true },
      root: { add: vi.fn(), remove: vi.fn() } as never,
      onCommit: vi.fn(),
      onChange: vi.fn(),
      ...(three === undefined ? {} : { three: three as never }),
    });
  }

  it('emphasises the handles when three is supplied', () => {
    const tree = fakeTree();
    const before = tree.byName(tree.gizmoChildren, 'XYZ')[0]!.geometry;

    build(tree, fakeThree());

    expect(tree.byName(tree.gizmoChildren, 'XYZ')[0]!.geometry).not.toBe(before);
  });

  it('leaves the handles stock when three is not supplied', () => {
    const tree = fakeTree();
    const before = tree.byName(tree.gizmoChildren, 'XYZ')[0]!.geometry;

    build(tree, undefined);

    expect(tree.byName(tree.gizmoChildren, 'XYZ')[0]!.geometry).toBe(before);
  });
});
