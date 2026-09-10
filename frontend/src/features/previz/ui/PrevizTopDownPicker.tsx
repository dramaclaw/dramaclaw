// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEffect, useMemo, useRef, type KeyboardEvent, type MouseEvent } from "react";
import { useTranslation } from "react-i18next";

import { PREVIZ_CAMERA_COLOR } from "@/features/previz/engine/cameraModel";
import { PREVIZ_GRID_CELL_COLOR, PREVIZ_GRID_CELL_SIZE } from "@/features/previz/engine/grid";
import { KIND_COLOR } from "@/features/previz/engine/sceneGraph";
import type { PrevizObject, PrevizObjectKind } from "@/features/previz/domain/scene";
import {
  canvasToWorld,
  sceneTopDownBounds,
  topDownView,
  worldToCanvas,
  type PrevizTopDownFootprint,
  type PrevizTopDownView,
} from "@/features/previz/domain/topDownMap";

/**
 * 创建人物对话框左栏那张俯视选位图。
 *
 * 纯受控：自己不记落点，`value` 从上面来、`onPick` 往上面去。对话框还要拿这个落点去喂
 * 中间那个 3D 木偶预览，两处若各记一份，用户会看到左栏的环和中间的人站在不同地方。
 */

/**
 * 画布的 CSS 尺寸。
 *
 * 宽度取 320，与 `PrevizCameraCreateDialog` 左栏同宽——两个创建对话框并排打开时
 * 左栏对得齐。做成正方形是因为 `sceneTopDownBounds` 的默认地块是 12 m 见方，方画布
 * 装方地块正好没有黑边；换成 16:9 的话空场景一上来左右就各空一条。
 */
export const PREVIZ_TOP_DOWN_PICKER_SIZE = { width: 320, height: 320 } as const;

/**
 * 方向键一下走多远，米。
 *
 * 键盘是这张图上唯一不带坐标的输入，步长就是键盘用户能达到的全部精度。取 0.5 m 而不是
 * 跟着网格走 1 m：对手戏的两个人相隔一米上下，1 m 一档的话「面对面」和「贴着」之间
 * 一个可选值都没有。再细则相反——0.1 m 要按二十下才跨过一格网格，键盘用户没法从场地
 * 这头走到那头。
 */
export const PREVIZ_TOP_DOWN_KEY_STEP_M = 0.5;

/** 位图缩放的上限，与 `PrevizAudioTrack` / `PrevizRenderer` 同一个封顶。 */
const MAX_PIXEL_RATIO = 2;

/** three 的 `0xrrggbb` 转 canvas 要的 CSS 字符串。 */
function hex(value: number): string {
  return `#${value.toString(16).padStart(6, "0")}`;
}

/** 底色。比对话框面板（#14161b）再深一档，让这块画布读起来是「一片场地」而不是留白。 */
const BACKGROUND = "#0b0d12";
/** 米格线用主视口网格的本色，两块画面上看到的是同一张网。 */
const GRID_LINE = hex(PREVIZ_GRID_CELL_COLOR);

/**
 * 世界原点那个十字用轴色画：横线是 X 轴、竖线是 Z 轴。
 *
 * 与 `ui/PrevizAxisGizmo.tsx` 的 `AXIS_COLOR` 同值（X 红 Z 蓝，建模软件通行约定）。
 * 那边是模块私有 const，没有导出；重复写在这里的代价是改色要动两处，换来的是这个
 * 组件不必为两个颜色去依赖一个 SVG 小部件。
 */
const AXIS_X_LINE = "#f87171";
const AXIS_Z_LINE = "#60a5fa";

/** 已选站位那个高亮环的颜色。 */
const PICK_RING = "#ffd166";

/**
 * 非人物对象的参照点颜色，取的就是 3D 里同一件东西的本色：灯与物件来自
 * `engine/sceneGraph.ts` 的 `KIND_COLOR`，机位来自 `engine/cameraModel.ts` 的
 * `PREVIZ_CAMERA_COLOR.body`。三种全部从源头 import，只在这里 `hex()` 成 canvas 要的
 * CSS 字符串——本文件不再持有第二份色值，源头改色时俯视图跟着一起变，改名或删项则
 * 当场编译不过。两侧在结构上已经没法分叉，也就不该再写一条「断言两份相等」的用例：
 * 那种用例两边读的是同一个常量，改常量两边一起动，它永远绿。
 *
 * import 这两个模块不会把 three 拖进这张 2D 画布：它们、以及 `sceneGraph` 转手 import
 * 的 `characterRig` / `propLoader`，三处的 three 全是 `import type`，运行时一个字节
 * 都不带；本文件顶部 import 的 `engine/grid` 也是同一形状。
 *
 * 人物不在表里——人物用自己的 `color`，一颗固定的分类色会让四个人物在俯视图上变成
 * 四个一模一样的点，而认人正是这些参照点存在的全部意义。灯也不用它自己的 `color`：
 * 那是灯的色温，常是白或暖白，画成点会跟网格线、跟 `PICK_RING` 的高亮环糊在一起，
 * 四盏不同色温的灯在俯视图上几乎分不开。
 */
const KIND_DOT_COLOR: Record<Exclude<PrevizObjectKind, "character">, string> = {
  camera: hex(PREVIZ_CAMERA_COLOR.body),
  light: hex(KIND_COLOR.light),
  prop: hex(KIND_COLOR.prop),
};

/** 参照点与高亮环的半径，CSS 像素。环大一圈，两者重合时还分得出选中的是哪个。 */
const DOT_RADIUS_PX = 4;
const RING_RADIUS_PX = 9;

/**
 * 没有轮廓时用的那个空数组。
 *
 * 定成模块级常量而不是写在参数默认值里：默认值那种写法每渲染一次新建一个数组，而
 * 取景那张 `useMemo` 把它当依赖，于是每渲染一次都重算取景、整张图重画一遍——一件
 * 不报错、只是白烧 CPU 的事。
 */
const NO_FOOTPRINTS: readonly PrevizTopDownFootprint[] = [];

/** 网格线最密到多少 CSS 像素一格。再密就是一片灰糊，还白白多画几千条线。 */
const MIN_GRID_SPACING_PX = 8;

const TAU = Math.PI * 2;

/**
 * 三处不是样式偏好，都是为了让按钮的盒子恰好就是画布的盒子——不然按钮上存在一圈
 * 「点得着、却不在画布上」的地方，那儿的点击照样触发 onClick，再被 `clampToCanvas`
 * 静默夹到取景框边缘：用户点在场地外面，人却贴着边放下去了，全程无提示。
 *
 * `p-0` —— 按钮默认自带内边距，那就是这样一圈。
 *
 * `w-fit` —— 去掉内边距还不够。按钮是 `block`，宽度 `auto` 会撑满父容器；这块要嵌进
 * 创建对话框的一栏里，面板多宽按钮就多宽，而画布始终 320，右边空出来的那条又是这样
 * 一圈。收缩包裹之后按钮才真的贴着画布。
 *
 * 描边用 `ring`（box-shadow）而不是 `border` —— `index.css` 的 tailwind preflight 把
 * 全局 `box-sizing` 设成了 `border-box`。若像最初那样把尺寸定在按钮上、画布 `w-full`
 * 跟着走，一圈 1px 的 border 会从按钮的内容盒里吃掉 2 px：**被压到 318 的是画布**
 * （按钮仍是整整 320），位图却按 320 铺，浏览器于是把 320 重采样到 318——而按设备
 * 像素铺位图的全部意义就是别让这种重采样发生。现在尺寸挂在画布自己身上、按钮收缩
 * 包裹，box-shadow 又不占布局盒，画布的 CSS 尺寸与位图尺寸因此严格成整倍数。
 */
const PICKER_CLASS = [
  "block w-fit cursor-crosshair rounded-md p-0 ring-1 ring-white/10",
  "focus:outline-none focus-visible:ring-white/40",
].join(" ");

/** 方向键 → 世界 XZ 上的方向。「下」是 +Z：俯视图里 +Z 朝画布下方（见 topDownMap）。 */
const KEY_DELTA: Record<string, readonly [number, number] | undefined> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

export interface PrevizTopDownPickerProps {
  /** 场里已有的对象，只用来画参照点与决定取景范围。 */
  objects: readonly PrevizObject[];
  /**
   * 道具在地面上占的那几块地（见 `PrevizRenderer.propFootprints`），一起算进取景范围。
   *
   * 只管取景，不再画出来：真几何体从上往下渲染的那张底图（[renderTopDown]）里本来就
   * 有它们，而且画的是真形，不是这里能给出的那个轴对齐外接矩形。取景仍然要它——一间
   * 铺开 40 m 的布景只贡献一个原点坐标，不把这块地算进来，示意图会框在原点周围那
   * 12 m 上，用户点不到布景的另一头。
   *
   * 可选：量这份数据要 three，而这个组件在没有渲染器的地方也用得上。**引用要稳**，
   * 理由同 `objects`：它是取景的依赖。
   */
  footprints?: readonly PrevizTopDownFootprint[];
  /**
   * 把真几何体从上往下画进这块画布，并回传它用的取景框；画不了就回 `null`。
   *
   * 不给这个 prop 时回落到那张 2D 示意图——这个组件在没有渲染器的地方也用得上（测试、
   * 以及将来任何不带 three 的选位场合），那条契约不能因为有了底图就断掉。渲染器建好
   * 之前的首帧、以及它 dispose 之后，走的也是这条回落。
   *
   * 回传取景框而不是让两边各算各的：底图是按场景包围**球**开的正交窗口（见
   * `domain/view.ts` 的 `orthoPlacement`），跟这里 `sceneTopDownBounds` 算出来的那块地
   * 不是一回事。用错一个，用户点在画面上某处、人却落在别处——静态图上完全看不出来。
   *
   * **引用要稳**：它进 `useEffect` 的依赖表，每渲染换一个新函数会让整块底图重画一遍
   * （一趟离屏 render target + 读回像素）。
   */
  renderTopDown?: (canvas: HTMLCanvasElement) => PrevizTopDownView | null;
  /** 已选的世界 XZ；还没选时是 null。 */
  value: readonly [number, number] | null;
  onPick: (point: [number, number]) => void;
}

/**
 * 位图按设备像素铺开的倍数。
 *
 * 不铺的话，2× 屏上这张 320 px 的位图是被浏览器放大上去的，一像素宽的网格线和参照点的
 * 边缘都发虚——`PrevizAudioTrack` 给波形铺设备像素就是为了这个。这里代价近乎为零：
 * 点击换算本来就要乘 `位图宽 / rect 宽`，那个比值顺手就把 dpr 一起吃掉了，绘制端因此
 * 一个 transform 都不用设。封顶 2 是同一个取舍——3× 手机上不值那三倍显存。
 *
 * 读的是 effect / 渲染当下的值，把窗口拖到另一块不同 dpr 的屏上不会自己重铺。补这条要
 * 挂 matchMedia 监听，`PrevizAudioTrack` 也没做，留给真有人抱怨的时候。
 */
function pickerPixelRatio(): number {
  const ratio = typeof window === "undefined" ? 1 : window.devicePixelRatio;
  if (!Number.isFinite(ratio) || ratio <= 0) return 1;
  return Math.min(MAX_PIXEL_RATIO, ratio);
}

/**
 * 网格该几米一格。
 *
 * 直接算而不是循环翻倍：跨度是从场景对象的坐标来的，那些数只被 `sceneTopDownBounds`
 * 筛掉了非有限值，1e300 这种量级进得来，`while (step * ppm < 阈值) step *= 2` 在那里
 * 要转上千圈。乘 2 的幂是为了让格子始终是整米数（1、2、4…），格线读起来仍然是尺子；
 * 用 `阈值 / ppm` 直接当步长的话会出现 2.7 m 一格，那张网就没法数了。
 */
export function gridStepM(pixelsPerMeter: number, minSpacingPx: number): number {
  const needed = minSpacingPx / (pixelsPerMeter * PREVIZ_GRID_CELL_SIZE);
  const factor = needed <= 1 ? 1 : 2 ** Math.ceil(Math.log2(needed));
  return PREVIZ_GRID_CELL_SIZE * factor;
}

/**
 * 把落点夹进位图里。
 *
 * 夹的是**画布**不是地块——这两件事别混：地块只是按已有对象自动框出来的取景范围，
 * 边框都没画出来，夹住它会让人落到手指以外；而画布是用户真的点中的那块东西，真实
 * 指针点击本来就落在里面（顶多在边缘差个亚像素），所以这一夹对正常点击是恒等的。
 *
 * 它挡的是另一种：`detail >= 1` 却带着 (0, 0) 坐标的合成点击。那时 `clientX - rect.left`
 * 是个负数，落点被映射到画面外一大截——高亮环压根不在画布上，用户点了一下什么都没
 * 发生，也没有任何报错。夹住之后最坏也只是落在取景框的边角上，看得见、再点一下就改
 * 得掉，损害是有界的。
 */
function clampToCanvas(pixel: number, size: number): number {
  return Math.min(Math.max(pixel, 0), size);
}

function dotColor(object: PrevizObject): string {
  return object.kind === "character" ? object.color : KIND_DOT_COLOR[object.kind];
}

/** 画一条从 (x0, y0) 到 (x1, y1) 的线。 */
function line(context: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number) {
  context.beginPath();
  context.moveTo(x0, y0);
  context.lineTo(x1, y1);
  context.stroke();
}

function drawGrid(context: CanvasRenderingContext2D, view: PrevizTopDownView, ratio: number) {
  // 可见范围对两个角各调一次逆映射就有，而不是拿 bounds 算：窄边等比之后，宽松那个
  // 方向上画布盖住的世界范围比 bounds 更大，按 bounds 画网格会在两侧各缺一截。
  const [leftX, topZ] = canvasToWorld(view, [0, 0]);
  const [rightX, bottomZ] = canvasToWorld(view, [view.width, view.height]);
  const step = gridStepM(view.pixelsPerMeter, MIN_GRID_SPACING_PX * ratio);

  context.strokeStyle = GRID_LINE;
  context.lineWidth = ratio;
  // 用序号乘步长而不是 `x += step` 累加：累加的舍入误差会让最后几条线偏出半个像素。
  for (let i = Math.ceil(leftX / step); i * step <= rightX; i += 1) {
    const px = worldToCanvas(view, [i * step, 0])[0];
    line(context, px, 0, px, view.height);
  }
  for (let i = Math.ceil(topZ / step); i * step <= bottomZ; i += 1) {
    const py = worldToCanvas(view, [0, i * step])[1];
    line(context, 0, py, view.width, py);
  }

  // 原点十字压在网格之上。落在画面外时这两条线自然被位图裁掉，不用另外判断。
  const [originX, originZ] = worldToCanvas(view, [0, 0]);
  context.lineWidth = ratio;
  context.strokeStyle = AXIS_X_LINE;
  line(context, 0, originZ, view.width, originZ);
  context.strokeStyle = AXIS_Z_LINE;
  line(context, originX, 0, originX, view.height);
}

/**
 * 参照点与高亮环画在什么上面。
 *
 * `backdrop` 为真时底图已经由 3D 那一帧铺满了整块位图（`blitCameraToCanvas` 自己会先
 * 刷一次黑再 `putImageData`），这里连清都不清：再刷一遍底色、再画一张网格与原点十字，
 * 就是把刚渲染出来的那张图整个盖掉。为假时反过来，那张 2D 示意图是画面上的全部内容。
 */
function drawTopDown(
  canvas: HTMLCanvasElement | null,
  view: PrevizTopDownView,
  objects: readonly PrevizObject[],
  value: readonly [number, number] | null,
  ratio: number,
  backdrop: boolean,
): void {
  if (!canvas) return;
  const context = canvas.getContext("2d");
  // 拿不到 2D 上下文（jsdom、个别隐私模式）时什么都不画，与 `engine/cameraPreview.ts`
  // 同一个处理。左栏空着还能靠键盘选位；从这里抛出去会把整个创建对话框带走。
  if (!context) return;

  if (!backdrop) {
    context.clearRect(0, 0, view.width, view.height);
    context.fillStyle = BACKGROUND;
    context.fillRect(0, 0, view.width, view.height);
    drawGrid(context, view, ratio);
  }

  for (const object of objects) {
    const [px, py] = worldToCanvas(view, [
      object.transform.position[0],
      object.transform.position[2],
    ]);
    context.fillStyle = dotColor(object);
    context.beginPath();
    context.arc(px, py, DOT_RADIUS_PX * ratio, 0, TAU);
    context.fill();
  }

  if (!value) return;
  const [px, py] = worldToCanvas(view, value);
  context.strokeStyle = PICK_RING;
  context.lineWidth = 2 * ratio;
  context.beginPath();
  context.arc(px, py, RING_RADIUS_PX * ratio, 0, TAU);
  context.stroke();
}

export function PrevizTopDownPicker({
  objects,
  footprints = NO_FOOTPRINTS,
  value,
  onPick,
  renderTopDown,
}: PrevizTopDownPickerProps) {
  const { t } = useTranslation();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const ratio = pickerPixelRatio();

  /** 没有底图时的取景：按已有对象与它们占的地自动框一块出来。 */
  const schematicView = useMemo(
    () =>
      topDownView(
        sceneTopDownBounds(objects, footprints),
        PREVIZ_TOP_DOWN_PICKER_SIZE.width * ratio,
        PREVIZ_TOP_DOWN_PICKER_SIZE.height * ratio,
      ),
    [objects, footprints, ratio],
  );

  /**
   * 这一帧**实际**用的取景框，落点换算读的是它。
   *
   * 存 ref 而不是 state：两条路给出的画布尺寸是同一个数（底图那条是照着 `canvas.width`
   * 算的，而那个数正是这里的 `schematicView.width` 写上去的），JSX 里没有一处读它，
   * setState 只会白白多渲染一趟。事件处理器读得到最新值——React 在把控制权交还给浏览器
   * 之前就把 effect 冲干净了，用户不可能点在一次没画完的帧上。
   */
  const viewRef = useRef(schematicView);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    // 底图先画：它是对整块位图的一次覆写，顺序反了参照点和高亮环会被它盖掉。
    const rendered = renderTopDown?.(canvas) ?? null;
    const view = rendered ?? schematicView;
    viewRef.current = view;
    drawTopDown(canvas, view, objects, value, ratio, rendered !== null);
  }, [schematicView, objects, value, ratio, renderTopDown]);

  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    // `detail` 是这次 click 的连击计数。指针点出来的 click 至少是 1，而键盘回车 / 空格、
    // 读屏软件的「激活」、`element.click()` 合成的那一下全是 0，且 clientX/Y 恒为 0
    // （已在 jsdom + userEvent 上实测）。不分开的话，键盘用户每按一次回车都会把人放到
    // 取景框左上角那一点——不报错的错答案，比报错难查得多。没有坐标时回到取景中心，
    // 已经选过则维持原样。
    const view = viewRef.current;
    if (event.detail === 0) {
      onPick(value ? [value[0], value[1]] : [view.centerX, view.centerZ]);
      return;
    }
    const canvas = canvasRef.current;
    if (!canvas) return;
    // 量画布自己而不是按钮：按钮上有边框，两者的 rect 差着边框那几像素，按按钮算会让
    // 落点整体偏移。
    const rect = canvas.getBoundingClientRect();
    // 量不出尺寸（还没排版，或被折叠成 0 宽）时不认这一下：下面要除以 rect 宽高，0 会
    // 算出 Infinity 或 NaN，而 NaN 的站位在画面上没有任何提示——人放不下去还查不出原因。
    if (rect.width <= 0 || rect.height <= 0) return;
    // 乘 `位图尺寸 / rect 尺寸`：CSS 尺寸和位图尺寸本来就不一定相等（设备像素铺开占一份，
    // 预演台整个被画布节点 CSS 缩放过又占一份）。直接拿 CSS 像素当位图像素，缩放一变
    // 落点就跟着偏。
    onPick(
      canvasToWorld(view, [
        clampToCanvas((event.clientX - rect.left) * (view.width / rect.width), view.width),
        clampToCanvas((event.clientY - rect.top) * (view.height / rect.height), view.height),
      ]),
    );
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const delta = KEY_DELTA[event.key];
    // 只拦方向键。一刀切 preventDefault 会把 Tab 也吃掉，焦点再也出不去这个按钮。
    if (!delta) return;
    // 拦掉浏览器的默认滚动：对话框是可滚的，不拦的话按一下方向键，落点动了的同时
    // 右栏的属性表也跟着滚走。
    event.preventDefault();
    const view = viewRef.current;
    const [fromX, fromZ] = value ?? [view.centerX, view.centerZ];
    onPick([
      fromX + delta[0] * PREVIZ_TOP_DOWN_KEY_STEP_M,
      fromZ + delta[1] * PREVIZ_TOP_DOWN_KEY_STEP_M,
    ]);
  };

  return (
    <button
      type="button"
      // 选过之后换一句话。这是这个按钮唯一的状态提示：读屏用户看不见那个高亮环，
      // 标签不换就分不出「还没选」与「选过了、再点一下改」。
      aria-label={t(
        value ? "previz.characterCreate.pickHintAgain" : "previz.characterCreate.pickHint",
      )}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      className={PICKER_CLASS}
    >
      {/*
        CSS 尺寸挂在画布自己身上，让按钮去包住它，而不是反过来给按钮定尺寸让画布
        `h-full`：按钮上任何一点内边距或边框都会从中间克扣，画布的 CSS 尺寸就不再是
        整整 320。挂在这里，`view.width / rect.width` 恰好等于设备像素倍数。

        位图尺寸取示意图那份取景而不是 `viewRef`：两份的宽高本来就是同一个数（底图那条
        是照着这里写上去的 `canvas.width` 算的），而这里读 ref 会在首帧拿到还没画过的
        初值，尺寸与内容差一帧。

        位图尺寸走 JSX 属性，不在 `drawTopDown` 里赋值：拿不到 2D 上下文时那个函数会
        提前 return，尺寸若跟在它后面就停在 canvas 默认的 300×150，而点击换算除的正是
        这个宽度——画面全空的同时每一次落点都是错的。
      */}
      <canvas
        ref={canvasRef}
        data-testid="top-down-picker"
        width={schematicView.width}
        height={schematicView.height}
        style={PREVIZ_TOP_DOWN_PICKER_SIZE}
        className="block rounded-md"
      />
    </button>
  );
}
