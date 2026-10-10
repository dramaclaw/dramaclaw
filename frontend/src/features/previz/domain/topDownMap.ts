// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { PrevizObject } from './scene';

/**
 * 俯视选位那张 2D 画布的坐标映射：世界的 (x, z) ↔ 画布的 (px, py)。
 *
 * 创建人物对话框的左栏是「点哪儿人就站哪儿」，所以两个方向都得用，而且得能往返——
 * 画上去的圆点用的是 `worldToCanvas`，用户点下去读回来的是 `canvasToWorld`，两条路
 * 只要有一处对不上，人就画在一处、落在另一处。
 *
 * 这里刻意不碰 three、也不碰 canvas：整条链路上最容易写反的是 Z 的符号，而符号写反
 * 之后画面看起来「差不多」——人只是落在了关于中心对称的另一边，前后颠倒。这种错在
 * WebGL 里靠肉眼几乎抓不住，抠成纯函数才测得动。
 */

export interface PrevizTopDownBounds {
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
}

/**
 * 一件东西在地面上占的那块地，世界坐标、米。
 *
 * 由渲染器量出来（见 `PrevizRenderer.propFootprints`），因为道具的尺寸只活在 three 里：
 * `PropLoader` 刻意不做归一化缩放（替用户猜「一把椅子该多大」会把按米建模的家具缩成
 * 模型玩具），`domain/scene.ts` 的 `PrevizProp` 因此没有任何一个字段说得出它多大。这个
 * 类型就是那份测量结果穿过 domain 层时的形状——本模块不认识 three，只认这四个数。
 *
 * 四条边取的是世界**轴对齐**包围盒在 XZ 上的投影，不是真实剪影：一张转了 30° 的长桌
 * 会被记成把它整个裹住的那个正矩形，比真形大一圈。这是有意的放大，别把它当精确轮廓。
 */
export interface PrevizTopDownFootprint {
  readonly id: string;
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
}

/** 默认地块的半边长，米。 */
const DEFAULT_HALF_M = 6;

/**
 * 空场景给的那块地：12 m 见方，以世界原点为中心。
 *
 * 这个数没有硬推导，别把它当成算出来的。它的依据只有一条经验尺度：主视口的网格大格是
 * 10 m（`engine/grid.ts` 的 `PREVIZ_GRID_SECTION_SIZE`），一块 12 m 的地正好装得下
 * 一整个大格再留一圈，两处看到的尺度对得上，用户从 3D 视口切到俯视图不会失去比例感。
 * 真用起来之后看第一批人物都点在哪一圈，再回来调。
 */
export const PREVIZ_TOP_DOWN_DEFAULT_BOUNDS: PrevizTopDownBounds = {
  minX: -DEFAULT_HALF_M,
  maxX: DEFAULT_HALF_M,
  minZ: -DEFAULT_HALF_M,
  maxZ: DEFAULT_HALF_M,
};

/**
 * 把已有对象框进去之后，四条边各外扩多少米。
 *
 * 按**米**留而不是按场景尺寸的比例留，为的是留出「把新人物摆在现有这群人旁边」的位置，
 * 而「旁边」对人来说是几步路——一个绝对长度。按比例留的话，两个人挨在一起的场景几乎
 * 留不出边，而一个横跨百米的外景会白白空出二十米的空地。
 *
 * 2 m 是主视口网格的两格（`engine/grid.ts` 的 `PREVIZ_GRID_CELL_SIZE` = 1 m）。
 *
 * **别指望这圈边能让「站在极值上的人物整个画得进画面」**，那件事这里办不到：参照点画
 * 出来是个有**像素**半径的圆点，而这里不知道画布有多大。固定米数折成像素会随场景变大
 * 而变小——320 px 画布上，场景跨 12 m 时这 2 m 是 40 px，跨 100 m 时只剩 6.2 px（比
 * `PrevizTopDownPicker` 的 `RING_RADIUS_PX` 9 还小，选中环被切），跨 200 m 时只剩
 * 3.1 px（比 `DOT_RADIUS_PX` 4 还小，圆点本身被剪掉）。真要恒定的像素边距只能按比例留
 * 边（k 比例下边距恒为 `k * 画布边长`，与场景无关），但那会毁掉上面那条真正的依据。
 * 所以「圆点别被切」归画布层：绘制时按半径把可用区往里缩。
 */
export const PREVIZ_TOP_DOWN_PADDING_M = 2;

/**
 * 地块的最小边长，米。取成与默认地块一样大，两个常量因此不会各自漂。
 *
 * 挡的是一个只靠留边解决不了的坎：场景空着给 12 m，刚建出第一个人物就只剩
 * `2 * PREVIZ_TOP_DOWN_PADDING_M` = 4 m——「加了个人，能点的地方反而变小了」，
 * 而这恰好是用户开局连着做的两步。撑开是两头对称加的，所以现有对象仍然在正中。
 *
 * 顺带也把「所有对象重合在同一点」兜住了：那时留边后的跨度是 `2 * padding`，虽然不为 0
 * 但小得离谱；而如果连 padding 也没有，跨度就是 0，`topDownView` 会算出 Infinity 的比例。
 */
const MIN_SPAN_M = DEFAULT_HALF_M * 2;

/**
 * 单个方向上退化跨度的兜底，米。
 *
 * 正常场景走不到：`sceneTopDownBounds` 出来的地块最少也有 `MIN_SPAN_M` 宽。走得到的有
 * 两种——调用方自己拼的 bounds（将来可能有「按选中对象取景」之类的入口），以及端点各自
 * 有限、相减却溢出成 Infinity 的极端坐标（两个对象分别在 ±1e308，`expandToMinSpan` 见
 * deficit 为 -Infinity 原样放行，跨度就是 Infinity）。取 1 m 与 `domain/view.ts` 的
 * `MIN_FRAMING_DISTANCE` 同源：空场景也得是一块看得见东西的窗口，而不是一个点。
 */
const MIN_VIEW_SPAN_M = 1;

/**
 * 把两头对称撑到至少 `minSpan` 宽。
 *
 * 对称加而不是只加一头：只加一头会让地块的中心跟着偏，而中心就是画布正中，
 * 用户会看到现有的人物莫名其妙贴着一边。
 */
function expandToMinSpan(min: number, max: number, minSpan: number): [number, number] {
  const deficit = minSpan - (max - min);
  if (deficit <= 0) return [min, max];
  return [min - deficit / 2, max + deficit / 2];
}

/**
 * 把场景里已有对象都框进去，四边留一圈，再撑到最小尺度。
 *
 * 只读 x / z：y 是高度，俯视图上看不见。
 *
 * `footprints` 是可选的第二份输入（见 [PrevizTopDownFootprint]），给了就连同那几块地
 * 一起框。默认空数组，只传一个参数的老调用点行为逐字不变。
 *
 * **框哪些对象由调用方决定**：这里收下什么就框什么，四种 `PrevizObject` 一视同仁。
 * 一台退到 z = 60 的摄影机会把整块地撑到六十米开外，人物于是全挤在画面一角——想只按
 * 人物取景，调用方先 filter 再传进来。
 *
 * 坐标非有限的对象整个跳过，而不是让它污染 min/max。`parseScene` 读盘时会把非有限的
 * 坐标回落成 0（`scene.ts` 的 `num` / `vec3`），但 store 的 `loadScene` / `applyScene`
 * 收的是调用方自建的 `PrevizScene`、**不经 `parseScene`**（`store.ts` 那段关于
 * `normalizeObject` 的注释就是这么说的），脏坐标进得来。代价不对称：跳过它只是这一个
 * 对象没被框进取景，而放它进来会让整块地的跨度变成 NaN，于是**每一次**点击都映射成
 * NaN——画面上没有任何报错，人就是放不下去。
 *
 * 一个能用的对象都没有时回到默认地块。这条分支是必需的，不是形式主义：min/max 的初值
 * 是 ±Infinity，留边之后仍然是 ±Infinity，中心 `(Infinity + -Infinity) / 2` 是 NaN。
 */
export function sceneTopDownBounds(
  objects: readonly PrevizObject[],
  footprints: readonly PrevizTopDownFootprint[] = [],
): PrevizTopDownBounds {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;

  for (const object of objects) {
    const x = object.transform.position[0];
    const z = object.transform.position[2];
    if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
  }

  // 轮廓另算一轮，因为它跟位置回答的不是同一件事：位置只贡献一个点，而一间 12 m 的
  // 布景真正占的是它铺开的那一整块。不把这块地累加进来，取景框就框不住它——那正是
  // 「地图上看不出道具在哪」的另一半。
  const ids = new Set(objects.map((object) => object.id));
  for (const footprint of footprints) {
    // 轮廓是渲染器另外量的一份快照，与这里收到的 `objects` 不保证同一时刻：对象可能
    // 已经被删了。让一条对不上号的轮廓撑大取景，画面会缩到看不清，而撑大它的那件
    // 东西一笔都画不出来——用户只看到整张图莫名其妙变小了。
    if (!ids.has(footprint.id)) continue;
    // 空 `Box3` 的初值就是 ±Infinity。渲染器那边已经筛过一道，这里再筛一道：这个函数
    // 是导出的纯函数，调用方不止一个；一条 Infinity 混进来，跨度就是 Infinity，
    // `topDownView` 算出的 pixelsPerMeter 是 0，整张图缩成一个像素点。
    const edges = [footprint.minX, footprint.maxX, footprint.minZ, footprint.maxZ];
    if (!edges.every(Number.isFinite)) continue;
    minX = Math.min(minX, footprint.minX);
    maxX = Math.max(maxX, footprint.maxX);
    minZ = Math.min(minZ, footprint.minZ);
    maxZ = Math.max(maxZ, footprint.maxZ);
  }

  // 一次比较就能认出「什么都没累加进来」：只有初值那一对满足 min > max。
  if (minX > maxX) return PREVIZ_TOP_DOWN_DEFAULT_BOUNDS;

  const pad = PREVIZ_TOP_DOWN_PADDING_M;
  const [spanMinX, spanMaxX] = expandToMinSpan(minX - pad, maxX + pad, MIN_SPAN_M);
  const [spanMinZ, spanMaxZ] = expandToMinSpan(minZ - pad, maxZ + pad, MIN_SPAN_M);
  return { minX: spanMinX, maxX: spanMaxX, minZ: spanMinZ, maxZ: spanMaxZ };
}

/**
 * 一次俯视映射要用到的全部东西。
 *
 * 刻意**不**把入参那个 bounds 原样带出来。取窄边等比之后，画布实际盖住的世界范围在
 * 宽松的那个方向上比 bounds 更大，两者不是一回事；把 bounds 挂在这里，消费方拿它去画
 * 网格或者判断「点在不在地里」就会差一截。真要那个可见范围，对画布的两个角调一次
 * `canvasToWorld` 就有，而且按定义永远与映射自洽。
 */
export interface PrevizTopDownView {
  /** 画布坐标系的宽高，像素；至少 1。调用方应当直接拿它当画布尺寸，免得两边漂。 */
  readonly width: number;
  readonly height: number;
  /** 一米画多少像素。两个方向共用一个值——见 [topDownView]。 */
  readonly pixelsPerMeter: number;
  /** 画在画布正中的那个世界点。 */
  readonly centerX: number;
  readonly centerZ: number;
}

/**
 * 画布尺寸的兜底：向下取整，并且至少 1 像素。
 *
 * 至少 1：画布尚未布局时 `clientWidth` 是 0，而 0 会让比例变成 0（一米画 0 个像素），
 * [worldToCanvas] 于是把所有点压到同一个像素上，[canvasToWorld] 再除以 0，吐出的是
 * Infinity（点在中心以外）或 NaN（点正在中心）。那只是一帧过渡态，不该让整个选位
 * 面板变成死的。
 *
 * 取整是为了跟画布的 backing store 对齐：`canvas.width` 只收整数，小数会被截断，
 * 而这里若留着小数，映射用的原点与画布真实的中心就差半个像素。
 */
function safePixels(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(1, Math.floor(value));
}

/**
 * 跨度非有限或不为正时回到 [MIN_VIEW_SPAN_M]。四种退化坏法各不相同，别记成一种：
 * 跨度 0 → `w / 0` 是 Infinity；跨度**为负** → `300 / -10` 是 -30，一个**有限的负数**，
 * 画面整个镜像过去（这一种最阴，不查也不报错）；跨度 Infinity → 比例是 0，所有点压到
 * 同一像素；跨度 NaN → 比例 NaN。
 */
function safeSpan(min: number, max: number): number {
  const span = max - min;
  return Number.isFinite(span) && span > 0 ? span : MIN_VIEW_SPAN_M;
}

/** 中心非有限时回到 0：`(-Infinity + Infinity) / 2` 就是这么来的。 */
function safeCenter(min: number, max: number): number {
  const center = (min + max) / 2;
  return Number.isFinite(center) ? center : 0;
}

/**
 * 把一块地铺到一张画布上：等比、居中。
 *
 * 比例取两个方向里**窄**的那一个（`min`）。取宽的那一个等于按另一个方向裁，整块地会有
 * 一部分被推到画布外，而被推出去的恰恰是最边上那些位置——用户想把人放在场地角落时点
 * 不到。两个方向各算各的比例（非等比）则更糟：那样整块地是铺满了，但一米在横向和纵向
 * 上不一样长，画出来的圆点是椭圆，用户对距离的判断整个失真。
 *
 * 窄边定完比例，另一个方向必然有富余，这里让它两头均分（letterbox）而不是靠一边：
 * 靠一边的话画布正中不再是地块中心，用户点在画面正中会落到地块的偏侧。均分之后
 * 「画布中心 ↔ 地块中心」这条对应关系成立，[worldToCanvas] 与 [canvasToWorld] 就都
 * 只是围着这一个点做缩放。
 */
export function topDownView(
  bounds: PrevizTopDownBounds,
  width: number,
  height: number,
): PrevizTopDownView {
  const safeWidth = safePixels(width);
  const safeHeight = safePixels(height);
  return {
    width: safeWidth,
    height: safeHeight,
    pixelsPerMeter: Math.min(
      safeWidth / safeSpan(bounds.minX, bounds.maxX),
      safeHeight / safeSpan(bounds.minZ, bounds.maxZ),
    ),
    centerX: safeCenter(bounds.minX, bounds.maxX),
    centerZ: safeCenter(bounds.minZ, bounds.maxZ),
  };
}

/**
 * 世界地面坐标 → 画布像素。
 *
 * **+Z 往画布下方走**，这是跟 3D 视口对齐的，不是随手定的：`domain/view.ts` 的
 * `orthoPlacement` 给顶视图的 up 是 `[0, 0, -1]`，也就是世界 -Z 朝屏幕上方，那段注释
 * 里写的就是「俯视图里 +X 朝右、+Z 朝下」。这里反过来的话，俯视选位与四视图里的俯视
 * 会前后颠倒，同一个场景在两块画面上互为镜像。
 *
 * 注意 y 轴方向上世界与画布是**同向**的（都往下增），所以这里两个分量的公式一模一样，
 * 没有别处 2D 映射常见的那个 `height - …` 翻转。
 */
export function worldToCanvas(
  view: PrevizTopDownView,
  point: readonly [number, number],
): [number, number] {
  return [
    view.width / 2 + (point[0] - view.centerX) * view.pixelsPerMeter,
    view.height / 2 + (point[1] - view.centerZ) * view.pixelsPerMeter,
  ];
}

/**
 * 画布像素 → 世界地面坐标，[worldToCanvas] 的逆。
 *
 * 往返不保证逐位相等：`(a * ppm) / ppm` 在 IEEE754 下会有舍入。失配比例**跟视图走**，
 * 不是一个普适常数——各扫 50 万点，`pixelsPerMeter` 是 30 或 32（二的幂的因子）时一个
 * 都不失配，是 9.6 / 26.67 / 3.08 时则有四到五成。但绝对偏差始终极小：本模块会产生的
 * 视图里最大只有 1.4e-14 m，比一个像素（几厘米）小十二个数量级，对选位没有任何影响。
 * 结论是断言得按容差写，不能按逐位相等写。
 *
 * 不夹回地块范围：画布上确实可能点到地块之外（窄边等比留下的那圈富余就在地块外），
 * 而那里也是合法的站位。要不要拦是对话框的事，不是映射的事。
 */
export function canvasToWorld(
  view: PrevizTopDownView,
  pixel: readonly [number, number],
): [number, number] {
  return [
    view.centerX + (pixel[0] - view.width / 2) / view.pixelsPerMeter,
    view.centerZ + (pixel[1] - view.height / 2) / view.pixelsPerMeter,
  ];
}
