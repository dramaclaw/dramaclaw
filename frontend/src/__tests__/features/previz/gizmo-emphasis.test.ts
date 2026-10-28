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
 * 照抄 three 0.185 `TransformControls.js` 的 translate 手柄清单，两张表都按真身的
 * 条目数搭全（`gizmoTranslate` 1310-1337、`pickerTranslate` 1339-1364）：
 *
 *   * gizmo：X/Y/Z 各三段（两个箭头 + 一条线）、中心一颗 XYZ 八面体、三块 XY/YZ/XZ 平面；
 *   * picker：X/Y/Z 各两段圆锥、中心一颗 XYZ 八面体、三块 XY/YZ/XZ 平面。
 *
 * 条数和名字重复都得照搬。改造是按名字扫全部子节点的，只搭一个同名代表的话
 * 「漏掉第二个同名手柄」和「把同名的全改了」在这里都看不出来；picker 那一侧少搭
 * 几个，「除中心那颗以外一个都别碰」这条防线更是无从下手——而它守的正是轴向与
 * 平面拖拽还能不能用。
 */
function fakeTree() {
  const gizmoChildren = [
    fakeHandle('X', 1, 0xff0000),
    fakeHandle('X', 1, 0xff0000),
    fakeHandle('X', 1, 0xff0000),
    fakeHandle('Y', 1, 0x00ff00),
    fakeHandle('Y', 1, 0x00ff00),
    fakeHandle('Y', 1, 0x00ff00),
    fakeHandle('Z', 1, 0x0000ff),
    fakeHandle('Z', 1, 0x0000ff),
    fakeHandle('Z', 1, 0x0000ff),
    fakeHandle('XYZ', 0.1, 0xffffff),
    fakeHandle('XY', 0.15, 0x0000ff),
    fakeHandle('YZ', 0.15, 0xff0000),
    fakeHandle('XZ', 0.15, 0x00ff00),
  ];
  // 拾取体全是 three 那份 0.15 不透明度的 matInvisible，所以颜色一律白。
  const pickerChildren = [
    fakeHandle('X', 0.2, 0xffffff),
    fakeHandle('X', 0.2, 0xffffff),
    fakeHandle('Y', 0.2, 0xffffff),
    fakeHandle('Y', 0.2, 0xffffff),
    fakeHandle('Z', 0.2, 0xffffff),
    fakeHandle('Z', 0.2, 0xffffff),
    fakeHandle('XYZ', 0.2, 0xffffff),
    fakeHandle('XY', 0.2, 0xffffff),
    fakeHandle('YZ', 0.2, 0xffffff),
    fakeHandle('XZ', 0.2, 0xffffff),
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

/**
 * 手柄材质里那三项「别让场景插手」的开关，三个手柄共用一套断言。
 *
 * 它们坏掉的表现是同一个：我们把不透明度调到 0.95 / 0.8，屏幕上却不是这个亮度。
 *   * `depthTest` 一开，手柄就钻进人物身体里被挡住——改大改亮全白做；
 *   * `fog` 一开，手柄离相机稍远就被雾冲淡，而预演台的视口是能一路推远的；
 *   * `toneMapped` 一开，亮度先过一遍色调映射再上屏，我们定死的值就不作数了。
 * three 自己的 `gizmoMaterial` 把这三项原样关掉，照抄它。
 */
function expectUnlitByScene(options: Record<string, unknown>) {
  expect(options.depthTest).toBe(false);
  expect(options.fog).toBe(false);
  expect(options.toneMapped).toBe(false);
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
    // 中心手柄是「不限方向」的那一颗，颜色刻意不落在任何一根轴的红/绿/蓝上——
    // 染成轴色的话它看起来就成了第四根轴，用户会去找它对应哪个方向。
    expect(options.color).toBe(0xffffff);
    expect(options.depthTest).toBe(false);
    expect(options.depthWrite).toBe(false);
    expectUnlitByScene(options);
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
    // 不动材质的理由不是「换了会画出来」：picker 三棵子树的 `visible` 被
    // `TransformControls.js:1575-1577` 永久关掉，`WebGLRenderer.js:1832` 见 false 就
    // 不递归，换成什么颜色都上不了屏。真正的理由是那份 `matInvisible` 由 translate /
    // rotate / scale 三组 picker 共用（同一个实例），换掉纯亏——改坏别人还搭不上自己。
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
      expectUnlitByScene(after.material.options ?? {});
    }
  });

  it('leaves the axis arrows untouched', () => {
    const tree = fakeTree();
    // 三根轴一起查：X 那组有三个同名子节点，够覆盖「同名的全都别动」这个形状，
    // 但标题说的是复数的 axis arrows，body 只查一根就配不上它。
    const axes = ['X', 'Y', 'Z'];
    const before = axes.map((name) =>
      tree
        .byName(tree.gizmoChildren, name)
        .map((handle) => ({ geometry: handle.geometry, material: handle.material })),
    );

    run(tree);

    axes.forEach((name, index) => {
      const after = tree.byName(tree.gizmoChildren, name);
      const snapshots = before[index]!;
      expect(after).toHaveLength(snapshots.length);
      // 逐个比引用，和隔壁 picker 那两条统一：`toEqual` 认的是结构，共用同一个 dispose
      // 替身的克隆体它照样放行——量的是「长得一样吗」，这里要的是「还是同一份吗」。
      after.forEach((handle, slot) => {
        expect(handle.geometry).toBe(snapshots[slot]!.geometry);
        expect(handle.material).toBe(snapshots[slot]!.material);
      });
    });
  });

  it('leaves the axis and plane pickers untouched', () => {
    const tree = fakeTree();
    const before = tree.pickerChildren
      .filter((handle) => handle.name !== 'XYZ')
      .map((handle) => ({ handle, geometry: handle.geometry, material: handle.material }));

    run(tree);

    for (const snapshot of before) {
      // 拾取体的偏移和显示体一样是烘进几何体的：六个轴 picker 是烘了 ±0.3 的圆锥，
      // 三个平面 picker 是烘了 (0.15, 0.15) 的方块。把它们的几何体一起换成原点上的
      // 八面体，九个判定区会全部塌到中心——单轴拖动和平面拖动整个失效，画面上却什么
      // 都看不出异样（拾取体本来就是隐形的），只剩自由移动还能用。
      //
      // 这是本模块唯一一处「改坏了看起来还正常、但功能整个没」的地方，所以 picker
      // 这一侧必须有和 gizmo 那一侧对称的一条锁。
      expect(snapshot.handle.geometry).toBe(snapshot.geometry);
      // 材质这一侧原先只锁了中心那颗，这条把另外九个补齐，和上面几何体那条对称。
      // 后果没有几何体那侧严重（picker 常关，换成什么都画不出来），但换掉它们等于把
      // three 三组 picker 共用的那份 `matInvisible` 拆散，代价纯是白付。
      expect(snapshot.handle.material).toBe(snapshot.material);
    }
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

/** 材质上除去身份（uuid）与我们**刻意**要改的那两项之外的全部设定。 */
function materialSwitches(material: THREE.Material) {
  const json = material.toJSON() as unknown as Record<string, unknown>;
  for (const key of ['uuid', 'color', 'opacity']) delete json[key];
  return json;
}

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

    /** 每次重新 traverse 去捞，而不是缓存：改造换的是 children 里那些 mesh 的字段，
     * 缓存下来的引用照样能看见改动，但「捞得到吗」这件事只有真去捞才算数。 */
    const handlesIn = (table: 'gizmo' | 'picker') => {
      let group: THREE.Object3D | undefined;
      helper.traverse((node) => {
        const found = node as unknown as {
          isTransformControlsGizmo?: boolean;
          gizmo?: Record<string, THREE.Object3D>;
          picker?: Record<string, THREE.Object3D>;
        };
        if (found.isTransformControlsGizmo === true) group = found[table]?.translate;
      });
      return (group?.children ?? []) as THREE.Mesh[];
    };
    const translateHandles = () => handlesIn('gizmo');
    const pickerHandles = () => handlesIn('picker');
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
    const stockCentreMaterial = centreBefore.material as THREE.MeshBasicMaterial;
    // 前置条件：官方那颗中心手柄确实是「看不见」的那一颗。这句要是红了，说明
    // three 已经自己把它做亮了，整个改造该重新评估而不是继续套用。
    expect((centreBefore.material as THREE.MeshBasicMaterial).opacity).toBeLessThan(0.5);

    emphasizeTranslateHandles(helper, THREE);

    const centreAfter = named(translateHandles(), 'XYZ');
    expect(radiusOf(centreAfter)).toBeGreaterThan(centreRadiusBefore);
    const centreMaterial = centreAfter.material as THREE.MeshBasicMaterial;
    expect(centreMaterial.opacity).toBeGreaterThanOrEqual(0.9);
    expect(centreMaterial.transparent).toBe(true);
    expect(centreMaterial.color.getHex()).toBe(0xffffff);
    expect(centreMaterial.depthTest).toBe(false);
    expect(centreMaterial.fog).toBe(false);
    expect(centreMaterial.toneMapped).toBe(false);
    // 再和官方那份 `gizmoMaterial` 整体比一遍：我们只该在 color 与 opacity 上与它不同。
    // 上面那几条单项断言守的是今天已知的开关；three 往 gizmoMaterial 上加过好几次新
    // 开关，再加一次的话我们这份就会缺一项，画到屏幕上和官方手柄的差别不止亮度，而
    // 没有任何一条单项断言会红。这条把那一整类一次覆盖掉。
    expect(materialSwitches(centreMaterial)).toEqual(materialSwitches(stockCentreMaterial));

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
      // 本文件不碰拖拽，但接口上它是必填的：真身松手那一刻靠它分辨拖的是哪根手柄。
      axis: null,
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
