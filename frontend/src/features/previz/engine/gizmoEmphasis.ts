// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type * as THREE from 'three';

import type { ThreeModule } from './sceneGraph';

/**
 * 中心那颗「自由移动」手柄的显示半径，单位是手柄自己的归一化尺度（three 每帧按
 * 相机距离缩放整组手柄，见下面 [emphasizeTranslateHandles] 的注释）。官方是 0.1，
 * 配上 0.25 不透明度的纯白，在这个视口的深色背景里几乎等于不存在——用户以为
 * 目标只能靠 XYZ 三根轴一根一根挪，其实一把抓中心就能拖到任意位置。
 *
 * 没往更大改（比如 0.2）是因为它会开始盖住三根轴箭头的根部，把「沿单轴移动」这件
 * 最常用的事变难；0.14 是「一眼看得见」和「不挡住轴」之间的落点。
 */
const CENTRE_GIZMO_RADIUS = 0.14;

/**
 * 中心手柄的拾取半径（官方 0.2）。
 *
 * 下界：必须比 [CENTRE_GIZMO_RADIUS] 大。判定区比看得见的手柄小的话，用户会看着它点
 * 上去却抓不住，而且只会怪自己没点准，永远想不到是判定区的问题。
 *
 * 上界：它会从三块平面拾取体嘴里抢判定区。平面 picker 是烘在 (0.15, 0.15) 的
 * `BoxGeometry(0.2, 0.2, 0.01)`，射线取最近的那个面，重叠处这颗立体八面体通常赢。
 * 0.2 → 0.26 把被抢走的内角从大约 (0.10, 0.10) 推到 (0.13, 0.13)，而平面手柄**看得见**
 * 的方块从 0.075 就开始——被抢的那一角仍在可见方块的内侧，用户瞄的是方块中心，够不
 * 着的只是它贴着原点那个角。这是刻意付的代价：中心手柄是本次改造要救的那一个，
 * 三块平面本来就没人找得到。再往上走就会啃进方块中心，那时得先给平面 picker 也
 * 挪位置，不能光调这个数。
 */
const CENTRE_PICKER_RADIUS = 0.26;

/** 中心手柄的不透明度。官方 0.25 是它看不见的直接原因。 */
const CENTRE_OPACITY = 0.95;

/** 三块双轴平面手柄的不透明度，官方 0.5。 */
const PLANE_OPACITY = 0.8;

/** 中心那颗自由移动手柄在 three 里的名字，gizmo 与 picker 两边同名。 */
const CENTRE_NAME = 'XYZ';

/** 三块双轴平面手柄的名字。 */
const PLANE_NAMES = ['XY', 'YZ', 'XZ'];

/**
 * three 的 `TransformControlsGizmo` 里我们够得着的那部分。写成结构类型，是因为
 * `gizmo` / `picker` 这两张表不在 three 的公开 .d.ts 里——它们是内部实现，我们是在
 * 明知这一点的前提下伸手进去的（见 [emphasizeTranslateHandles] 为什么只能这么做）。
 */
interface GizmoHandle {
  name: string;
  geometry?: { dispose(): void };
  material?: { color?: { getHex(): number }; dispose(): void };
}

interface GizmoGroups {
  translate?: { children?: GizmoHandle[] };
}

interface TransformControlsGizmoLike {
  isTransformControlsGizmo?: boolean;
  gizmo?: GizmoGroups;
  picker?: GizmoGroups;
}

/**
 * 把 translate 手柄里「自由移动」那几颗做大做亮。
 *
 * 背景：自由移动手柄从来就没缺过——中心一颗 XYZ 八面体、三块 XY/YZ/XZ 平面，功能
 * 完全没被限制。问题纯粹是**看不见**，所以这里做的不是加手柄，是把已经在那儿的
 * 手柄改到用户能注意到。
 *
 * 为什么必须伸进 three 的内部结构：`setColors()` 只覆盖 `materialLib` 里那八个材质，
 * 中心那颗白球和它的几何体一个都够不着，公开 API 到此为止。
 *
 * 三条不能绕开的约束，都来自 three 每帧重写手柄状态：
 *   * `updateMatrixWorld` 里 `handle.scale.set(1,1,1).multiplyScalar(...)` ——手柄的
 *     scale 每帧被算回去，所以「做大」只能换几何体，改 `mesh.scale` 下一帧就没了；
 *   * 同一处 `handle.material.color.copy(handle.material._color)` / `opacity = _opacity`
 *     （`_color`/`_opacity` 是首帧从材质惰性缓存的）——所以「做亮」只能整个换掉
 *     material 实例，改 `material.opacity` 同样活不过一帧。换成新实例后 three 会把
 *     我们这份的值缓存成它的还原基准，高亮/取消高亮照旧工作；
 *   * `setupGizmo` 把每个手柄的偏移**烘进了几何体**（`tempGeometry.applyMatrix4`），
 *     随后 position/rotation/scale 全部归零——所以换几何体等于丢掉偏移。中心手柄的
 *     偏移是 [0,0,0]（烘的是单位阵）所以换得起；三块平面手柄的不是，见下面。
 *
 * 找不到目标就静默返回：三方库升级换了内部结构时，宁可退回官方那副难看的外观，
 * 也不能让整个视口在构造期抛出——手柄丑一点用户还能用，抛了预演台连打都打不开。
 */
export function emphasizeTranslateHandles(helper: THREE.Object3D, three: ThreeModule): void {
  const root = findGizmoRoot(helper);
  if (!root) return;

  for (const handle of root.gizmo?.translate?.children ?? []) {
    if (handle.name === CENTRE_NAME) {
      replaceGeometry(handle, new three.OctahedronGeometry(CENTRE_GIZMO_RADIUS, 0));
      handle.material = createHandleMaterial(three, 0xffffff, CENTRE_OPACITY);
    } else if (PLANE_NAMES.includes(handle.name)) {
      // 平面手柄**只换材质，绝不换几何体**：它们的偏移烘在几何体里（上面第三条），
      // 换掉就得自己把那个矩阵重新烘一遍，漏了的话三块平面会全叠到原点上，从
      // 「难发现」直接变成「坏掉」。只提不透明度就够看见了，不值这个风险。
      // 颜色原样带过来——蓝/红/绿是用户分辨这块平面对应哪两根轴的唯一线索。
      const hex = handle.material?.color?.getHex() ?? 0xffffff;
      handle.material = createHandleMaterial(three, hex, PLANE_OPACITY);
    }
  }

  for (const handle of root.picker?.translate?.children ?? []) {
    // 拾取体只放大几何体，**材质一个字都不动**：它的不可见性归官方那份 0.15 的透明
    // 材质管，换掉就等于把这颗本该看不见的八面体画到画面上，变成一坨盖住中心手柄
    // 的白雾——比原来还糟。
    if (handle.name === CENTRE_NAME) {
      replaceGeometry(handle, new three.OctahedronGeometry(CENTRE_PICKER_RADIUS, 0));
    }
  }
}

/**
 * 手柄材质的公共设定，逐项照抄 three 的 `gizmoMaterial`（`TransformControls.js:1200-1206`）。
 *
 * `depthTest: false` 是这里唯一不能改的一项：手柄画在物体中心，开了深度测试就会
 * 被人物身体挡住——改大改亮全白做。`toneMapped: false` 同理，走了色调映射的话
 * 我们定的这几个值到屏幕上就不是这几个值了。
 *
 * **被顶替下来的旧材质刻意不 dispose**，尽管它就此没人引用了。translate 的中心球与
 * 三块平面用的是 three 内部共享的材质实例：中心那颗 `matWhiteTransparent` 同时是
 * scale 手柄中心方块的材质，三块平面的 `mat{Red,Green,Blue}Transparent` 同时是 scale
 * 三块平面的材质、并且挂在 `materialLib.{x,y,z}AxisTransparent` 上被 `setColors()` 直接
 * 写入。dispose 掉的是别人还在用的东西。眼下恰好无害（改造跑在首帧之前，那时材质
 * 还没有任何 GPU 资源，`dispose()` 只是空放一个事件），但那是巧合不是保证——调用点
 * 往后挪一步就变成每次开预演台都白扔一遍 scale 手柄的着色器程序。
 */
function createHandleMaterial(three: ThreeModule, color: number, opacity: number) {
  return new three.MeshBasicMaterial({
    color,
    opacity,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    fog: false,
    toneMapped: false,
  });
}

/**
 * 换几何体并销毁旧的。
 *
 * 几何体和材质在「能不能销毁」上刚好相反，所以这里销毁得起：`setupGizmo` 给每颗手柄
 * clone 了一份专属的几何体（`tempGeometry = object.geometry.clone()`），没有第二个人
 * 引用它。材质那一侧为什么不能照做，见 [createHandleMaterial]。
 */
function replaceGeometry(handle: GizmoHandle, geometry: THREE.BufferGeometry): void {
  const previous = handle.geometry;
  handle.geometry = geometry;
  previous?.dispose();
}

/**
 * 从 helper 树里捞出手柄那一层。helper 是 `TransformControlsRoot`，手柄挂在它下面
 * 一级，所以必须 traverse——直接读 helper 自己的属性什么都拿不到。
 *
 * 用数组接而不是 `let found`：TS 的控制流分析不认闭包里的赋值，写成变量的话
 * `return found` 会被窄化成 `null`，后面全线报错。
 */
function findGizmoRoot(helper: THREE.Object3D): TransformControlsGizmoLike | null {
  const found: TransformControlsGizmoLike[] = [];
  helper.traverse((node) => {
    const candidate = node as unknown as TransformControlsGizmoLike;
    if (candidate.isTransformControlsGizmo === true) found.push(candidate);
  });
  return found[0] ?? null;
}
